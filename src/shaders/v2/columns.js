import { CELL_M } from '../../scale.js';
import { E } from '../../elements.js';
import { FOAM_ROWS } from '../../v2/foam.js';

// Column-run water (docs/v2/water-cost-first-principles.md; the CPU prototype it ports is
// tools/v2/column-water.mjs). Water is stored exactly as before (16 B core + 4 B bank) and read per (x, z)
// column, bottom up, as DOMAINS: a dry floor [y0, top), or a RUN [y0, r1) of one liquid (and one lava
// subtype) plus the air above it up to `top` (the next run, or a cell that is neither air nor liquid).
//   RUN      a supported run is PACKED (every cell full except its top), so its head is its surface,
//            eta = y0 + M/FULL: the column's hydrostatic prefix sum, exact, with no compression and no hidden
//            mass (tall cells: Irving et al. 2006, Chentanez and Mueller 2011).
//   LID      only a run filled to its domain's top compresses (Chorin's artificial compressibility, 1967):
//            eta = top + excess/(cap * COMP * FULL), the excess in its top cell.
//   FALL     a run with air under it falls as a rigid run on R1's column-fall law (powder's).
//   SEGMENT  where two neighbouring columns' domains overlap they meet in a vertical face segment with one
//            depth-averaged flux: the shallow-water momentum equation without advection, with Audusse et
//            al.'s (2004) hydrostatic reconstruction of the wet depth at the face, so a lake at rest over any
//            floor is exactly at rest. It lives in the f16 face lane of the segment's bottom cell in the -side
//            column (x: low16 of core.z, z: low16 of core.w); a falling run's bottom cell keeps its fall speed
//            in the y lane (high16 of core.z) and its fall fraction in the x lane. Interior lanes are free.
// One step a 60 Hz tick. Mass leaves and arrives at run surfaces only; interior cells are never written.
//
// Two passes, both a thread an (x, z) column of the awake brick columns (ARGS2.COLS):
//   v2runs   after the block pass: packs supported runs, drops falling ones, decays foam (Monahan), and
//            writes the column's domain records (below) into liquidScratch.
//   v2pairs  four dispatches a tick, one per axis and parity: a thread owns a PAIR of neighbouring columns
//            outright (dimensional splitting, LeVeque, Finite Volume Methods for Hyperbolic Problems, 2002,
//            ch. 19), so it computes every segment's flux, the outflow limit and the transfers serially,
//            with no atomics, no snapshots and no second reader. The order alternates each tick (Strang).
// Custody: every unit of fill moves cell to cell through colMove, which carries the exact integer share
// of the source's carried energy and fuel (the cumulative-share telescoping of docs/v2/foundation.md
// "Integer energy and advection", here applied to a serial sequence of moves), its ctype, lava subtype and
// burning flag, and refuses (moving nothing) when either side would leave the format.

// ---------------------------------------------------------------- constants (JS and WGSL)
export const COLUMN = (() => {
  const TICK_HZ = 60, G_MS2 = 19.6;
  const G = G_MS2 / CELL_M / (TICK_HZ * TICK_HZ);   // cells/tick² at reference gravity (2 g, docs/v2.md 5.1)
  const FULL = 1 << 16;
  return {
    TICK_HZ, G_MS2, G, FULL,
    // a face's depth-averaged flux (quanta a tick per cell of wet face) gains this a tick per cell of head
    ACC: G * FULL,
    // Wave speed is sqrt(g h); one explicit step a tick is stable for h < 27.5 cells. Deeper faces accelerate
    // as if this deep: real water is dispersive (deep-water waves of length L travel at sqrt(g L / 2 pi), not
    // sqrt(g h)), so this is the deep-water limit for waves up to ~100 cells long (1.7x margin).
    H_CAP: 16,
    // covered runs only: stable iff COMP >= 2 g dt² (four horizontal faces, one step); 3 g dt² (lean-sim's margin)
    COMP: 3 * G,
    QMIN: 0.5,                 // a segment flux under this snaps to 0 (lean-sim)
    FILM: FULL >> 3,           // the shallow-water dry tolerance (GeoClaw's dry_tolerance, Berger et al. 2011)
    DEADQ: 2,                  // dead band, in fill quanta of the stiffer side (lean-sim)
    // the rows' damping is per substep of the 180 Hz model it calibrated (v2Rows: drag); per tick it is
    // 1 - (1 - damp)^3, the same damping a second
    DAMP_STEPS: 3,
    STALL: 1.5,                // the stall band: a drive whose damped steady flow moves under one quantum a tick
    // a face's flux at most: under f16's 65,504 by more than its spacing there (32), so a lane never rounds
    // past it. 0.99 cells a tick (17.9 m/s): an explicit face moves at most its own cell a step.
    Q_MAX: 65000,
    // R1's bulk run speed for a falling run of liquid, 12 m/s (lean-sim VT_SAND), in cells/tick
    VT: 12 / CELL_M / TICK_HZ,
    // R14's birth gate: an overfall faster than this leaves as particles (lean-sim V_JET), m/s
    JET_SPEED: 1,
    // a deposited cell to launch: its y lane holds this (a falling run's own y lane is never negative)
    JET_MARK: -1,
    // a liquid this thin under a pour still leaves it open below (lean-sim openBelow: FULL/16)
    THIN: FULL >> 4,
    // a face's demand word: what it carries in the low 24 bits, its launch head in the byte above, in
    // these steps a cell
    DEMAND_MAX: (1 << 24) - 1, HEAD_Q: 8,
    CELL_M,
    // foam the arrival of a full cell's fill generates at its receiver, before its row's gain (TPT-style local
    // agitation, docs/v2.md 4.3: the gather's 16 a cell of face divergence)
    FOAM_ARRIVAL: 16, FOAM_MAX_GAIN: 32,
  };
})();

// record flags, in the mass word (a run's mass stays under 2^30: 16 383 cells of FULL, or 1 023 of MAX_FILL)
const REC_FALLING = 0x80000000, REC_LAST = 0x40000000, REC_MASS = 0x3fffffff;
const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

// ---------------------------------------------------------------- WGSL
// The column helpers. Functions named col* are written in a small scalar subset (no bit operations, no
// integer division) so tools/v2/column-wgsl-check.mjs executes their emitted bodies on the CPU; the codec
// helpers above them (records, lanes, the moved cores) are the only ones it replaces with JS twins.
export const columnWaterWGSL = /* wgsl */ `
const COL_ACC: f32 = ${COLUMN.ACC};
const COL_G: f32 = ${COLUMN.G};
const COL_G_MS2: f32 = ${f(COLUMN.G_MS2)};
const COL_H_CAP: f32 = ${f(COLUMN.H_CAP)};
const COL_COMP: f32 = ${COLUMN.COMP};
const COL_QMIN: f32 = ${f(COLUMN.QMIN)};
const COL_FILM: f32 = ${f(COLUMN.FILM)};
const COL_DEADQ: f32 = ${f(COLUMN.DEADQ)};
const COL_STALL: f32 = ${f(COLUMN.STALL)};
const COL_Q_MAX: f32 = ${f(COLUMN.Q_MAX)};
const COL_VT: f32 = ${COLUMN.VT};
const COL_FULL: f32 = ${f(COLUMN.FULL)};
const COL_FOAM_ARRIVAL: f32 = ${f(COLUMN.FOAM_ARRIVAL)};
const COL_TICK_HZ: f32 = ${f(COLUMN.TICK_HZ)};
const COL_CELL_M: f32 = ${COLUMN.CELL_M};
const COL_JET_SPEED: f32 = ${f(COLUMN.JET_SPEED)};
const COL_JET_MARK: f32 = ${f(COLUMN.JET_MARK)};
const COL_THIN: u32 = ${COLUMN.THIN}u;
const COL_DEMAND_MAX: u32 = ${COLUMN.DEMAND_MAX}u;
const COL_PROBE_CLOSED: u32 = 0u;
const COL_PROBE_AIR: u32 = 1u;
const COL_PROBE_LIQUID: u32 = 2u;
const COL_PROBE_READ: u32 = 4u;
const COL_HEAD_Q: f32 = ${f(COLUMN.HEAD_Q)};
const COL_FOAM_MAX_GAIN: f32 = ${f(COLUMN.FOAM_MAX_GAIN)};
const REC_FALLING: u32 = ${REC_FALLING >>> 0}u;
const REC_LAST: u32 = ${REC_LAST}u;
const REC_MASS: u32 = ${REC_MASS}u;
const COL_FOAM_GAIN = array<f32, ${FOAM_ROWS.length}>(${FOAM_ROWS.map(r => `${r.gain}.0`).join(',')});

// ---- records: a column's domains bottom up, record k in the liquidScratch slot of the column's cell at
// height k (k < the domains' count <= NY). x = y0 | top << 16, y = r1 | liquid << 16 | lava subtype << 24,
// z = mass | falling | last, w = the pair pass's scratch (an f32: a sender's demand, then its limit).
fn colRec(x: i32, k: i32, z: i32) -> vec4u { return liquidScratch[slotOf(vec3i(x, k, z))]; }
fn colPut(x: i32, k: i32, z: i32, r: vec4u) { liquidScratch[slotOf(vec3i(x, k, z))] = r; }
fn recMake(y0: i32, top: i32, r1: i32, liq: u32, sub: u32, mass: u32, falling: bool, last: bool) -> vec4u {
  return vec4u(u32(y0) | (u32(top) << 16u), u32(r1) | (liq << 16u) | (sub << 24u),
    mass | select(0u, REC_FALLING, falling) | select(0u, REC_LAST, last), 0u);
}
fn recY0(r: vec4u) -> i32 { return i32(r.x & 65535u); }
fn recTop(r: vec4u) -> i32 { return i32(r.x >> 16u); }
fn recR1(r: vec4u) -> i32 { return i32(r.y & 65535u); }
fn recLiq(r: vec4u) -> u32 { return (r.y >> 16u) & 255u; }
fn recSub(r: vec4u) -> u32 { return r.y >> 24u; }
fn recMass(r: vec4u) -> u32 { return r.z & REC_MASS; }
fn recFalling(r: vec4u) -> bool { return (r.z & REC_FALLING) != 0u; }
fn recLast(r: vec4u) -> bool { return (r.z & REC_LAST) != 0u; }
fn recScratch(r: vec4u) -> f32 { return bitcast<f32>(r.w); }
fn withRecScratch(r: vec4u, v: f32) -> vec4u { return vec4u(r.xyz, bitcast<u32>(v)); }
fn withRecTop(r: vec4u, top: i32) -> vec4u { return vec4u((r.x & 65535u) | (u32(top) << 16u), r.yzw); }
fn withRecLast(r: vec4u, last: bool) -> vec4u { return vec4u(r.xy, (r.z & ~REC_LAST) | select(0u, REC_LAST, last), r.w); }
// a run's new end, liquid and mass (falling and last are kept); a run that drained is a dry floor again
fn withRecRun(r: vec4u, r1: i32, liq: u32, sub: u32, mass: u32) -> vec4u {
  return vec4u(r.x, u32(r1) | (liq << 16u) | (sub << 24u), (r.z & ~REC_MASS) | mass, r.w);
}

// ---- lanes: x 0, y 1, z 2 (qOf's order); the f16 rounds to nearest
fn laneOf(c: vec4u, axis: i32) -> f32 { return qOf(c)[axis]; }
fn withLane(c: vec4u, axis: i32, v: f32) -> vec4u {
  var q = qOf(c); q[axis] = v;
  return vec4u(c.x, c.y, pack2x16float(q.xy), (c.w & 0xffff0000u) | (pack2x16float(vec2f(q.z, 0.0)) & 0xffffu));
}
// a liquid's lava subtype (runs are single-subtype: different formation energies never merge)
fn liquidSub(c: vec4u) -> u32 { return select(0u, ctypeOf(c), cid(c) == ${E.LAVA}u); }
fn colBurning(c: vec4u) -> u32 { return select(0u, c.y & 0x80000000u, MATERIAL_BURNS[cid(c)]); }
// the source after sending all but \`left\`: drained to air at its own temperature, or the rest
fn drainedCore(c: vec4u, left: u32) -> vec4u {
  if (left == 0u) { return vec4u(c.x & 0x00ffff00u, 0u, c.z, c.w & 65535u); }
  return vec4u(c.x, (c.y & 0xff000000u) | left, c.z, c.w);
}
// the receiver holding \`fill\`: its own liquid (it may start burning), or the source's when it was air
fn receivedCore(dst: vec4u, src: vec4u, fill: u32) -> vec4u {
  if (cid(dst) == 0u) {
    return vec4u((dst.x & 0x00ffff00u) | cid(src), fill | (ctypeOf(src) << 24u) | colBurning(src), dst.z, dst.w & 65535u);
  }
  return vec4u(dst.x, (dst.y & 0xff000000u) | fill | colBurning(src), dst.z, dst.w);
}
// foam: the mass-weighted mean of what was there and what arrived, plus what an arrival agitates
fn foamAgeOf(dst: vec4u, src: vec4u, n: u32, fill: u32, agitate: bool) -> u32 {
  let mass = energyAdd(energyMul(cAge(dst), materialAmount(dst)), energyMul(cAge(src), n));
  var generated = 0u;
  if (agitate) { generated = u32(clamp(f32(n) / COL_FULL * COL_FOAM_ARRIVAL * COL_FOAM_GAIN[cid(src)], 0.0, COL_FOAM_MAX_GAIN)); }
  return min(255u, energyDiv(mass, fill).x + generated);
}
// floor(total*(prefix+n)/fill) - floor(total*prefix/fill): cumulative shares telescope (foundation.md)
fn shareUnsigned(total: u32, prefix: u32, n: u32, fill: u32) -> u32 {
  if (fill == 0u || total == 0u || n == 0u) { return 0u; }
  return energyDiv(energyMul(total, prefix + n), fill).x - energyDiv(energyMul(total, prefix), fill).x;
}
fn colFill(x: i32, y: i32, z: i32) -> u32 { return cFill(loadCore(slotOf(vec3i(x, y, z)))); }
fn colClass(x: i32, y: i32, z: i32) -> u32 { return clsOf(loadCore(slotOf(vec3i(x, y, z)))); }
fn colCell(x: i32, y: i32, z: i32) -> vec4u { return loadCore(slotOf(vec3i(x, y, z))); }
fn colPending(x: i32, y: i32, z: i32) -> bool { return (events[slotOf(vec3i(x, y, z))] & 1u) != 0u; }
fn colBusy(x: i32, y: i32, z: i32) { markBusy(vec3i(x, y, z)); }
// any brick of the brick column holding (x, z) is awake: its column was in this tick's runs pass (v2cols's
// per-column word, one read)
fn colAwake(x: i32, z: i32) -> bool { return atomicLoad(&act2[V2_COL_AWAKE + u32(x >> 2u) + u32(z >> 2u) * u32(BX)]) != 0u; }
// a falling run trades places with the air under it, cell by cell; moved lanes belong to where they were
fn colSwap(x: i32, a: i32, b: i32, z: i32) {
  let sa = slotOf(vec3i(x, a, z)); let sb = slotOf(vec3i(x, b, z));
  let ma = loadMaterial(sa); let mb = loadMaterial(sb);
  let request = events[sa]; events[sa] = events[sb]; events[sb] = request;
  noteEvents(sa, events[sa]); noteEvents(sb, request);
  storeMaterial(sb, mb, Material(zeroQ(ma.core), ma.bank));
  storeMaterial(sa, ma, Material(zeroQ(mb.core), mb.bank));
}
fn colSetLanes(x: i32, y: i32, z: i32, fall: f32, fraction: f32) {
  let s = slotOf(vec3i(x, y, z)); let before = loadMaterial(s);
  let after = Material(withLane(withLane(before.core, 1, fall), 0, fraction), before.bank);
  storeMaterial(s, before, after);
}
fn colSetLane(x: i32, y: i32, z: i32, axis: i32, v: f32) {
  let s = slotOf(vec3i(x, y, z)); let before = loadMaterial(s);
  storeMaterial(s, before, Material(withLane(before.core, axis, v), before.bank));
}
// the lane of the face upwind of a pair's segment at height y (the -side's -face for flow a to b, the
// +side's +face for flow b to a), when it feeds the same way: Stelling and Duinmeijer's upwind velocity.
// No thread writes it while it is read: the flux stage writes no lane, and in a transfer stage the face
// upwind is the other colour's.
fn colUpwind(xa: i32, za: i32, xb: i32, zb: i32, y: i32, axis: i32, v: f32) -> f32 {
  var p = vec3i(xb, y, zb);
  if (v > 0.0) { p = mEdge(vec3i(xa, y, za) - axisV(axis)); }
  if (!inGrid(p) || !isOpenC(loadCell(p))) { return 0.0; }
  let up = laneOf(loadCell(p), axis);
  return select(0.0, up, up * v > 0.0);
}
// R14's launch head of a sender at row y (lean-sim / the prototype: the source and its same-liquid
// neighbours, the target excepted): the highest exact head among the sending run and the neighbours' runs
// that hold row y. Called in the flux stage only, while every record is frozen; a neighbour's records are
// read only when they are this tick's (it or the sender is awake: the runs pass built them).
fn colLaunchHead(xs: i32, zs: i32, xt: i32, zt: i32, rs: vec4u, y: i32) -> f32 {
  var eta = colEta(rs);
  let here = vec3i(xs, 0, zs);
  let fresh = colAwake(xs, zs);
  for (var side = 0; side < 4; side++) {
    let n = mEdge(here + face6(select(side, side + 2, side >= 2)));
    if (!inGrid(n) || (n.x == xt && n.z == zt) || !(fresh || colAwake(n.x, n.z))) { continue; }
    var k = 0;
    loop {
      let r = colRec(n.x, k, n.z);
      if (y >= recY0(r) && y < recTop(r)) {
        if (recLiq(r) == recLiq(rs) && recSub(r) == recSub(rs) && !recFalling(r) && y < recR1(r)) { eta = max(eta, colEta(r)); }
        break;
      }
      if (recLast(r)) { break; }
      k = k + 1;
    }
  }
  return eta;
}
// a deposited cell to launch at v (m/s along the axis): its lanes, and its brick on the jets' list
fn colMarkJet(x: i32, y: i32, z: i32, axis: i32, v: f32) {
  let p = vec3i(x, y, z); let s = slotOf(p); let before = loadMaterial(s);
  storeMaterial(s, before, Material(withLane(withLane(zeroQ(before.core), axis, v), 1, COL_JET_MARK), before.bank));
  atomicStore(&act2[V2_JETS + brickOfCell(p)], 1u);
}
fn colGravity() -> f32 { if (P.gravMode != 0u) { return 0.0; } return COL_G * P.gravity / COL_G_MS2; }
fn colDampTick(liq: u32) -> f32 { let keep = 1.0 - dampOf(liq); return 1.0 - keep * keep * keep; }

// ---- custody: n of the fill at a moves to b (both air or the same liquid), with its exact share
// of the carried energy (all but the stationary air carrier) and of the fuel; refused, nothing moves
fn colMove(xa: i32, ya: i32, za: i32, xb: i32, yb: i32, zb: i32, n: u32, agitate: bool) -> bool {
  if (n == 0u) { return true; }
  if (colPending(xa, ya, za) || colPending(xb, yb, zb)) { colBusy(xa, ya, za); colBusy(xb, yb, zb); return false; }
  let fs = slotOf(vec3i(xa, ya, za)); let ts = slotOf(vec3i(xb, yb, zb));
  let src = loadMaterial(fs); let dst = loadMaterial(ts);
  if (!isLiq(src.core)) { return false; }
  let have = cFill(src.core);
  let fill = materialAmount(dst.core) + n;
  // a cell never holds two liquids or two lava subtypes
  if (cid(dst.core) != 0u && (cid(dst.core) != cid(src.core) || liquidSub(dst.core) != liquidSub(src.core))) { return false; }
  if (n > have || fill > MAX_FILL) { return false; }
  let carried = energySub(energyOf(src), energyMul(FULLU, cTq(src.core)));
  let heat = energyShare(carried, 0u, n, have);
  let conducts = conductsNative(cid(src.core));
  var fuel = 0u;
  if (!conducts) { fuel = shareUnsigned(payloadOf(src.core), 0u, n, have); }
  var sent = drainedCore(src.core, have - n);
  if (have > n && !conducts) { sent = withPayload(sent, payloadOf(src.core) - fuel); }
  var got = receivedCore(dst.core, src.core, fill);
  var payload = payloadOf(dst.core) + fuel;
  if (conducts) { payload = max(payloadOf(dst.core), payloadOf(src.core)); }
  if (payload > 65535u) { colBusy(xa, ya, za); return false; }
  got = withAge(withPayload(got, payload), foamAgeOf(dst.core, src.core, n, fill, agitate));
  let sentEnergy = energySub(energyOf(src), heat);
  let gotEnergy = energyAdd(energyOf(dst), heat);
  if (!energyFits(Material(sent, src.bank), sentEnergy) || !energyFits(Material(got, dst.bank), gotEnergy)) { colBusy(xa, ya, za); return false; }
  storeMaterial(fs, src, withEnergy(Material(sent, src.bank), sentEnergy));
  storeMaterial(ts, dst, withEnergy(Material(got, dst.bank), gotEnergy));
  colBusy(xa, ya, za); colBusy(xb, yb, zb);
  return true;
}

// ---- the head of a record's domain (cells), and its stiffness (cells of head a quantum)
fn colEta(r: vec4u) -> f32 {
  let y0 = f32(recY0(r));
  if (recLiq(r) == 0u) { return y0; }
  let cap = f32(recTop(r) - recY0(r)); let mass = f32(recMass(r));
  if (mass <= cap * COL_FULL) { return y0 + mass / COL_FULL; }
  return f32(recTop(r)) + (mass - cap * COL_FULL) / (cap * COL_COMP * COL_FULL);
}
fn colStiff(r: vec4u) -> f32 {
  let cap = f32(recTop(r) - recY0(r));
  if (recLiq(r) == 0u || f32(recMass(r)) <= cap * COL_FULL) { return 1.0 / COL_FULL; }
  return 1.0 / (cap * COL_COMP * COL_FULL);
}
// wet depth of a domain at the segment [s0, s1): Audusse et al.'s hydrostatic reconstruction
fn colDepth(r: vec4u, s0: i32, s1: i32) -> f32 {
  if (recLiq(r) == 0u) { return 0.0; }
  return min(max(colEta(r) - f32(s0), 0.0), f32(s1 - s0));
}

// ---- the segment rule (prototype segment()): the new flux of [s0, s1) between a (-side) and b, from u.
// Positive flows a to b. Falling runs, two dry floors and two different liquids exchange nothing.
fn colFlux(ra: vec4u, rb: vec4u, s0: i32, s1: i32, u: f32, up: f32) -> f32 {
  let dryA = recLiq(ra) == 0u; let dryB = recLiq(rb) == 0u;
  if (recFalling(ra) || recFalling(rb) || (dryA && dryB)) { return 0.0; }
  if (!dryA && !dryB && (recLiq(ra) != recLiq(rb) || recSub(ra) != recSub(rb))) { return 0.0; }
  let acc = COL_ACC * colGravity() / COL_G;
  if (acc <= 0.0) { return 0.0; }
  var liq = recLiq(ra);
  if (dryA) { liq = recLiq(rb); }
  let ha = colDepth(ra, s0, s1); let hb = colDepth(rb, s0, s1);
  let damp = colDampTick(liq);
  var drive = colEta(ra) - colEta(rb);
  // lean-sim's dead band (DEADQ quanta of the stiffer side, the yield), and never below the drive whose
  // damped steady flow v·h moves under one quantum a tick: 1.5·damp/(ACC·h), lean-sim's 1.5·damp/ACC at h = 1
  let hFace = max(max(ha, hb), 1.0 / COL_FULL);
  let band = max(max(COL_DEADQ * max(colStiff(ra), colStiff(rb)), COL_STALL * damp / (acc * min(hFace, 1.0))), yieldOf(liq));
  if (abs(drive) < band) { drive = 0.0; }
  var v = u;
  if (ha == 0.0) { v = min(v, 0.0); }   // a dry side's stale outflow is dropped
  if (hb == 0.0) { v = max(v, 0.0); }
  var hUp = hb;
  if (drive > 0.0 || (drive == 0.0 && v > 0.0)) { hUp = ha; }
  v = v + acc * drive * min(1.0, COL_H_CAP / max(hUp, 1.0)) - colAdvect(u, up);
  if (drive == 0.0) { v = v * 0.5; }
  if ((v > 0.0 && ha == 0.0) || (v < 0.0 && hb == 0.0)) { v = 0.0; }
  // the film rule as the dry tolerance: a face whose upwind wet depth is under FILM carries no flux
  if (v > 0.0 && ha * COL_FULL < COL_FILM) { v = 0.0; }
  if (v < 0.0 && hb * COL_FULL < COL_FILM) { v = 0.0; }
  v = v * (1.0 - damp);
  if (abs(v) < COL_QMIN) { v = 0.0; }
  return clamp(v, -COL_Q_MAX, COL_Q_MAX);
}
// what the flux v carries a tick (quanta): v times the upwind wet depth
fn colDemand(ra: vec4u, rb: vec4u, s0: i32, s1: i32, v: f32) -> u32 {
  if (v > 0.0) { return u32(floor(v * colDepth(ra, s0, s1))); }
  if (v < 0.0) { return u32(floor(-v * colDepth(rb, s0, s1))); }
  return 0u;
}

// ---- the advective term on contractions (Stelling and Duinmeijer 2003, energy-head form; agent 7's
// docs/v2/water-momentum.md): a face faster than the one upwind of it loses the velocity-head difference,
// q -= (q² - q_up²)/(2 FULL), from last tick's q, before the damping, so an outlet's steady flow is
// Bernoulli's. It only retards: expansions keep the momentum form. A face at rest gains nothing, so rest
// stays an exact fixed point.
fn colAdvect(u: f32, up: f32) -> f32 {
  let head = (u * u - up * up) / (2.0 * COL_FULL);
  if (head <= 0.0) { return 0.0; }
  if (u < 0.0) { return -head; }
  return head;
}

// ---- pack: a supported run of the domain [r0, top) holding \`mass\`: full cells from the bottom, the rest in
// the next, a covered run's excess in its top cell. Every move is colMove's; a refusal leaves the run
// unpacked (heads read the mass, not the layout) and busy, to retry. Returns the run's end.
fn colPack(x: i32, z: i32, r0: i32, top: i32, mass: u32) -> i32 {
  var left = mass;
  var giver = r0 + 1;
  var end = r0;
  for (var k = r0; k < top; k++) {
    if (left == 0u) { break; }
    var want = min(left, FULLU);
    if (k == top - 1) { want = left; }
    var here = colFill(x, k, z);
    // a surplus goes up a cell (k < top - 1: the top cell's want is all that is left)
    if (here > want) {
      if (!colMove(x, k, z, x, k + 1, z, here - want, false)) { return colExtent(x, z, r0, top); }
      here = want;
    }
    // a deficit is pulled from the lowest cell above that holds any
    if (giver <= k) { giver = k + 1; }
    loop {
      if (here >= want || giver >= top) { break; }
      let there = colFill(x, giver, z);
      if (there == 0u) { giver = giver + 1; continue; }
      let n = min(want - here, there);
      if (!colMove(x, giver, z, x, k, z, n, false)) { return colExtent(x, z, r0, top); }
      here = here + n;
    }
    left = left - here;
    end = k + 1;
  }
  return end;
}

// ---- fall: the run [r0, r1) with air under it, down to the lowest air cell above o0, on R1's law
// (v += g to the run speed, whole cells, a landing ends the fall). Returns its new bottom.
fn colFall(x: i32, z: i32, o0: i32, r0: i32, r1: i32) -> i32 {
  let b = colCell(x, r0, z);
  // a deposit whose launch was refused (or never ran) falls from rest
  var v0 = laneOf(b, 1); var a0 = laneOf(b, 0);
  if (v0 < 0.0) { v0 = 0.0; a0 = 0.0; }
  let v = min(v0 + colGravity(), COL_VT);
  var a = a0 + v;
  var d = i32(floor(a));
  a = a - f32(d);
  var fl = r0;
  loop {
    if (fl - 1 < o0 || colClass(x, fl - 1, z) != C_AIR) { break; }
    fl = fl - 1;
  }
  var speed = v;
  if (d >= r0 - fl) { d = r0 - fl; speed = 0.0; a = 0.0; }
  colBusy(x, r0, z);
  if (d > 0) {
    for (var k = r0; k < r1; k++) { colSwap(x, k, k - d, z); }
    colBusy(x, r0 - d, z); colBusy(x, r1 - 1, z);
  }
  colSetLanes(x, r0 - d, z, speed, a);
  return r0 - d;
}

// ---- the column: its domains bottom up into records (settle: pack and fall, as the runs pass does; a pair's
// sleeping partner only reads). Returns the number of records.
fn colFinish(x: i32, z: i32, k: i32, y0: i32, top: i32, r1: i32, liq: u32, sub: u32, mass: u32, o0: i32, settle: bool, loose: bool) -> i32 {
  if (liq == 0u) { colPut(x, k, z, recMake(y0, top, y0, 0u, 0u, 0u, false, false)); return k + 1; }
  var bottom = y0;
  var end = r1;
  var falling = y0 > o0 && colClass(x, y0 - 1, z) == C_AIR;
  if (settle && falling) {
    bottom = colFall(x, z, o0, y0, r1);
    end = r1 - (y0 - bottom);
    falling = bottom > o0 && colClass(x, bottom - 1, z) == C_AIR;
    // the domain under it ends where it now starts (a dry floor it reached is gone)
    if (bottom != y0) {
      let below = colRec(x, k - 1, z);
      if (recLiq(below) == 0u && recY0(below) == bottom) {
        colPut(x, k - 1, z, recMake(bottom, top, end, liq, sub, mass, falling, false));
        return k;
      }
      colPut(x, k - 1, z, withRecTop(below, bottom));
    }
  } else if (settle) {
    // a supported bottom keeps no fall state; then a loose run packs
    if (laneOf(colCell(x, y0, z), 1) != 0.0) { colSetLanes(x, y0, z, 0.0, 0.0); }
    if (loose) { end = colPack(x, z, y0, top, mass); }
  }
  colPut(x, k, z, recMake(bottom, top, end, liq, sub, mass, falling, false));
  return k + 1;
}
// the run's end after a refused move: one past its highest cell holding any fill
fn colExtent(x: i32, z: i32, r0: i32, top: i32) -> i32 {
  var y = top - 1;
  loop {
    if (y < r0 || colFill(x, y, z) != 0u) { break; }
    y = y - 1;
  }
  return y + 1;
}
fn colScan(x: i32, z: i32, settle: bool) -> i32 {
  var k = 0;
  var y = 0;
  loop {
    if (y >= NY) { break; }
    var probe = colProbe(x, y, z);
    if (!probeOpen(probe)) { y = y + 1; continue; }
    // an open stretch [o0, o1): a dry floor, then runs each with the air above them. A run is loose (it
    // packs) when a cell under another is not full, or a compressed cell is not its domain's top.
    let o0 = y;
    var y0 = y; var r1 = y; var liq = 0u; var sub = 0u; var mass = 0u;
    var loose = false; var over = -1; var below = 0u;
    loop {
      if (y >= NY) { break; }
      probe = colProbe(x, y, z);
      if (!probeOpen(probe)) { break; }
      if (settle && probeRead(probe)) { foamDecay(x, y, z); }
      let id = probeLiquid(probe);
      if (id != 0u) {
        let fill = probeFill(probe);
        if (liq == id && sub == probeSub(probe) && r1 == y) {
          if (below < FULLU || over >= 0) { loose = true; }
          r1 = y + 1; mass = mass + fill;
        } else {
          if (liq != 0u || y > o0) { k = colFinish(x, z, k, y0, y, r1, liq, sub, mass, o0, settle, loose || (over >= 0 && over != y - 1)); }
          y0 = y; r1 = y + 1; liq = id; sub = probeSub(probe); mass = fill; loose = false; over = -1;
        }
        if (fill > FULLU) { over = y; }
        below = fill;
      }
      y = y + 1;
    }
    k = colFinish(x, z, k, y0, y, r1, liq, sub, mass, o0, settle, loose || (over >= 0 && over != y - 1));
  }
  if (k == 0) { colPut(x, 0, z, recMake(0, 0, 0, 0u, 0u, 0u, false, true)); return 1; }
  colPut(x, k - 1, z, withRecLast(colRec(x, k - 1, z), true));
  return k;
}
// What (x, y, z) is, for the scan: its brick's summary when one is known (support wrote it from the cells
// and nothing changed them since: noteState clears it), else the cell itself. x: its kind, read flag, liquid
// id and lava subtype; y: its fill.
fn colProbe(x: i32, y: i32, z: i32) -> vec2u {
  let p = vec3i(x, y, z);
  let code = atomicLoad(&act2[V2_SUMMARY + brickOfCell(p)]);
  if (code == SUM_CLOSED) { return vec2u(COL_PROBE_CLOSED, 0u); }
  if (code == SUM_AIR) { return vec2u(COL_PROBE_AIR, 0u); }
  if ((code & 255u) == SUM_LIQUID) { return vec2u(COL_PROBE_LIQUID | (code & 0xffff00u), FULLU); }
  let c = loadCell(p); let kind = clsOf(c);
  if (kind == C_AIR) { return vec2u(COL_PROBE_AIR | COL_PROBE_READ, 0u); }
  if (kind == C_LIQUID) { return vec2u(COL_PROBE_LIQUID | COL_PROBE_READ | (cid(c) << 8u) | (liquidSub(c) << 16u), cFill(c)); }
  return vec2u(COL_PROBE_CLOSED | COL_PROBE_READ, 0u);
}
fn probeOpen(p: vec2u) -> bool { return (p.x & 3u) != COL_PROBE_CLOSED; }
fn probeLiquid(p: vec2u) -> u32 { if ((p.x & 3u) != COL_PROBE_LIQUID) { return 0u; } return (p.x >> 8u) & 255u; }
fn probeSub(p: vec2u) -> u32 { return (p.x >> 16u) & 255u; }
fn probeFill(p: vec2u) -> u32 { return p.y; }
fn probeRead(p: vec2u) -> bool { return (p.x & COL_PROBE_READ) != 0u; }
fn colOpen(x: i32, y: i32, z: i32) -> bool { return isOpenC(colCell(x, y, z)); }
// Monahan lifetime, byte-quantized deterministic decay at native 60 Hz (the foam pass this replaces)
fn foamDecay(x: i32, y: i32, z: i32) {
  let p = vec3i(x, y, z); let before = loadCell(p);
  if (!isLiq(before)) { return; }
  let foam = cAge(before); if (foam == 0u) { return; }
  let period = select(152u, 231u, cid(before) == ${E.SALTWATER}u);
  let phase = (P.tick + slotOf(p)) % period;
  let loss = ((phase + 1u) * foam) / period - (phase * foam) / period;
  let after = withAge(before, foam - loss);
  storeCell(p, after);
  if (cAge(after) != 0u) { markBusy(p); }
}

// ---- a segment's n quanta: to the receiver's surface, or, over an edge (the face's bottom above the
// receiver's surface or its dry floor), poured into the receiver's cells at the face's wet rows
fn colSend(xs: i32, zs: i32, is: i32, xd: i32, zd: i32, id: i32, s0: i32, s1: i32, axis: i32, toward: f32, v: f32, head: f32, n: u32) {
  if (!colOver(colRec(xd, id, zd), s0)) { colTransfer(xs, zs, is, xd, zd, id, n); return; }
  colPour(xs, zs, is, xd, zd, s0, s1, axis, toward, abs(v), head, n);
}
// a face at s0 pours into this receiving domain: over its surface, or over its dry floor
fn colOver(rd: vec4u, s0: i32) -> bool { return (recLiq(rd) == 0u && s0 > recY0(rd)) || (recLiq(rd) != 0u && s0 >= recR1(rd)); }
// The prototype's deposit rule: the source's wet rows at the face [s0, s0 + rows) each take a share, cut
// from its surface down, into the receiver's cell at that row. A cell that was air and is left faster
// than R14's gate over open space is marked to launch (the jets pass makes it a particle at that speed);
// any other falls as a run. The launch speed is R14's sqrt(2 g H), H the exact launch head (colLaunchHead,
// cells over s0) over the row's centre: an orifice's jet leaves at sqrt(2 g h) of its reservoir.
fn colPour(xs: i32, zs: i32, is: i32, xd: i32, zd: i32, s0: i32, s1: i32, axis: i32, toward: f32, v: f32, head: f32, n: u32) {
  let rs = colRec(xs, is, zs);
  let h = max(colDepth(rs, s0, s1), 1.0 / COL_FULL);
  let rows = max(1, i32(ceil(h)));
  let g = COL_G_MS2 * colGravity() / COL_G;
  var open = false;
  if (s0 > 0) {
    let below = colCell(xd, s0 - 1, zd);
    open = colClass(xd, s0 - 1, zd) == C_AIR || (isLiq(below) && cid(below) == recLiq(rs) && cFill(below) < COL_THIN);
  }
  let fast = v / COL_FULL * COL_TICK_HZ * COL_CELL_M > COL_JET_SPEED;
  var left = n;
  var giver = recR1(rs) - 1;
  var mass = recMass(rs);
  for (var r = 0; r < rows; r++) {
    if (left == 0u) { break; }
    let y = s0 + r;
    var share = left;
    if (r < rows - 1) { share = min(left, u32(floor(f32(n) * min(1.0, h - f32(r)) / h))); }
    let wasAir = colClass(xd, y, zd) == C_AIR;
    var put = 0u;
    loop {
      if (put >= share || giver < recY0(rs)) { break; }
      let have = colFill(xs, giver, zs);
      if (have == 0u) { giver = giver - 1; continue; }
      let m = min(share - put, have);
      if (!colMove(xs, giver, zs, xd, y, zd, m, true)) { break; }
      put = put + m;
      if (m == have) { giver = giver - 1; }
    }
    if (put == 0u) { break; }
    left = left - put; mass = mass - put;
    if (wasAir && open && fast) {
      let speed = sqrt(2.0 * g * COL_CELL_M * max(head - (f32(r) + 0.5), 0.0));
      colMarkJet(xd, y, zd, axis, toward * speed);
    }
  }
  var sEnd = giver + 1;
  var sLiq = recLiq(rs);
  if (mass == 0u) { sEnd = recY0(rs); sLiq = 0u; }
  colPut(xs, is, zs, withRecRun(rs, sEnd, sLiq, select(0u, recSub(rs), mass != 0u), mass));
}

// ---- transfer: n from the run of record \`is\` in column (xs, zs) to the domain of record \`id\` in (xd, zd),
// surface to surface: the source's top cells give, top down; the receiver's surface takes, filling its top
// cell, then the air above, a covered domain's top cell compressing, a dry floor's bottom cell first. A face
// over the receiver's surface goes to colPour instead.
fn colTransfer(xs: i32, zs: i32, is: i32, xd: i32, zd: i32, id: i32, n: u32) {
  let rs = colRec(xs, is, zs); let rd = colRec(xd, id, zd);
  var left = n;
  var giver = recR1(rs) - 1;
  var mass = recMass(rs);
  var dMass = recMass(rd);
  var dEnd = recR1(rd);
  let dTop = recTop(rd);
  var to = recY0(rd);
  if (recLiq(rd) != 0u) { to = dEnd - 1; }
  loop {
    if (left == 0u || giver < recY0(rs) || to >= dTop) { break; }
    let have = colFill(xs, giver, zs);
    if (have == 0u) { giver = giver - 1; continue; }
    let filled = colFill(xd, to, zd);
    var room = FULLU - min(filled, FULLU);
    if (to == dTop - 1) { room = MAX_FILL - filled; }
    if (room == 0u) { to = to + 1; continue; }
    let m = min(left, min(have, room));
    if (!colMove(xs, giver, zs, xd, to, zd, m, true)) { break; }
    left = left - m; mass = mass - m; dMass = dMass + m;
    if (to + 1 > dEnd) { dEnd = to + 1; }
    if (m == have) { giver = giver - 1; }
  }
  var sEnd = giver + 1;
  var sLiq = recLiq(rs);
  if (mass == 0u) { sEnd = recY0(rs); sLiq = 0u; }
  colPut(xs, is, zs, withRecRun(rs, sEnd, sLiq, select(0u, recSub(rs), mass != 0u), mass));
  if (dMass != 0u) { colPut(xd, id, zd, withRecRun(colRec(xd, id, zd), dEnd, recLiq(rs), recSub(rs), dMass)); }
}

// ---- the faces of a column pair along one axis (Jacobi: every face of both axes from the same frozen
// records and lanes, as the prototype's flux pass; splitting the axes instead grows a point drop's
// ripples): each overlapping domain pair's new segment flux, advected, into jetMask at its lane's slot.
// Reads records and lanes; writes only that word.
fn colFluxes(xa: i32, za: i32, xb: i32, zb: i32, axis: i32) {
  var i = 0; var j = 0;
  loop {
    let ra = colRec(xa, i, za); let rb = colRec(xb, j, zb);
    let s0 = max(recY0(ra), recY0(rb)); let s1 = min(recTop(ra), recTop(rb));
    // a falling run's bottom lanes are its fall (it meets no segment)
    if (s0 < s1 && !recFalling(ra) && !recFalling(rb)) {
      // lanes hold last tick's fluxes all stage long (only the transfers write them), so the face
      // upwind is read race-free
      let u = laneOf(colCell(xa, s0, za), axis);
      let v = colFlux(ra, rb, s0, s1, u, colUpwind(xa, za, xb, zb, s0, axis, u));
      // and R14's launch head, while every record is frozen: the sender's exact head, or a same-liquid
      // neighbour's that feeds it (an orifice's reservoir), over the segment's bottom
      // (only a face that pours needs one: its bottom over the receiver's surface or dry floor)
      var head = 0.0;
      if (v > 0.0 && colOver(rb, s0)) { head = colLaunchHead(xa, za, xb, zb, ra, s0) - f32(s0); }
      if (v < 0.0 && colOver(ra, s0)) { head = colLaunchHead(xb, zb, xa, za, rb, s0) - f32(s0); }
      colSetVelocity(xa, s0, za, axis, v, head);
      if (v != 0.0) {
        let mark = clamp(i32(ceil(max(colEta(ra), colEta(rb)))) - 1, s0, s1 - 1);
        colBusy(xa, mark, za); colBusy(xb, mark, zb);
      }
    }
    if (recTop(ra) < recTop(rb)) { if (recLast(ra)) { break; } i = i + 1; }
    else { if (recLast(rb)) { break; } j = j + 1; }
  }
}
// ---- the transfers of a column pair (the thread owns both columns and their records): one limit a
// sending run over the pair's faces (never more than it now holds), then surface to surface, bottom up
fn colTransfers(xa: i32, za: i32, xb: i32, zb: i32, axis: i32) {
  colClearScratch(xa, za); colClearScratch(xb, zb);
  var i = 0; var j = 0;
  loop {
    let ra = colRec(xa, i, za); let rb = colRec(xb, j, zb);
    let s0 = max(recY0(ra), recY0(rb)); let s1 = min(recTop(ra), recTop(rb));
    if (s0 < s1 && !recFalling(ra) && !recFalling(rb)) {
      // the flux stage's face becomes the lane; its word now holds what it carries (and the launch head)
      let v = colVelocityAt(xa, s0, za, axis);
      if (v != laneOf(colCell(xa, s0, za), axis)) { colSetLane(xa, s0, za, axis, v); }
      let t = colDemand(ra, rb, s0, s1, v);
      colSetDemand(xa, s0, za, axis, t, colFaceHeadAt(xa, s0, za, axis));
      if (v > 0.0) { colPut(xa, i, za, withRecScratch(ra, recScratch(ra) + f32(t))); }
      if (v < 0.0) { colPut(xb, j, zb, withRecScratch(rb, recScratch(rb) + f32(t))); }
    }
    if (recTop(ra) < recTop(rb)) { if (recLast(ra)) { break; } i = i + 1; }
    else { if (recLast(rb)) { break; } j = j + 1; }
  }
  colLimit(xa, za); colLimit(xb, zb);
  i = 0; j = 0;
  loop {
    let ra = colRec(xa, i, za); let rb = colRec(xb, j, zb);
    let s0 = max(recY0(ra), recY0(rb)); let s1 = min(recTop(ra), recTop(rb));
    if (s0 < s1 && !recFalling(ra) && !recFalling(rb)) {
      let t = colDemandAt(xa, s0, za, axis);
      let v = laneOf(colCell(xa, s0, za), axis);
      let head = colSentHeadAt(xa, s0, za, axis);
      if (t != 0u && v > 0.0) { colSend(xa, za, i, xb, zb, j, s0, s1, axis, 1.0, v, head, u32(floor(f32(t) * recScratch(ra)))); }
      if (t != 0u && v < 0.0) { colSend(xb, zb, j, xa, za, i, s0, s1, axis, -1.0, v, head, u32(floor(f32(t) * recScratch(rb)))); }
    }
    // (transfers change a record's mass and end, never its y0, top or last flag)
    if (recTop(ra) < recTop(rb)) { if (recLast(ra)) { break; } i = i + 1; }
    else { if (recLast(rb)) { break; } j = j + 1; }
  }
}
fn colClearScratch(x: i32, z: i32) {
  var k = 0;
  loop {
    let r = colRec(x, k, z);
    colPut(x, k, z, withRecScratch(r, 0.0));
    if (recLast(r)) { break; }
    k = k + 1;
  }
}
fn colLimit(x: i32, z: i32) {
  var k = 0;
  loop {
    let r = colRec(x, k, z);
    let demand = recScratch(r); let mass = f32(recMass(r));
    var keep = 1.0;
    if (demand > mass) { keep = mass / demand; }
    colPut(x, k, z, withRecScratch(r, keep));
    if (recLast(r)) { break; }
    k = k + 1;
  }
}
// a face's demand this tick, two words a cell (x, z) in jetMask: the flux stage writes, the transfers read
// A face's word in jetMask, two a cell (x, z): from the flux stage its new flux and launch head (two f16:
// the lane's own precision); from its transfer stage what it carries (the low 24 bits; more waits for the
// limiter) and the launch head again (the high byte, in COL_HEAD_Q steps a cell: to 31.9 cells, past the
// lane's 17.9 m/s).
fn colWord(x: i32, y: i32, z: i32, axis: i32) -> u32 { return 2u * slotOf(vec3i(x, y, z)) + u32(axis >> 1u); }
fn colSetVelocity(x: i32, y: i32, z: i32, axis: i32, v: f32, head: f32) { atomicStore(&jetMask[colWord(x, y, z, axis)], pack2x16float(vec2f(v, head))); }
fn colVelocityAt(x: i32, y: i32, z: i32, axis: i32) -> f32 { return unpack2x16float(atomicLoad(&jetMask[colWord(x, y, z, axis)])).x; }
fn colFaceHeadAt(x: i32, y: i32, z: i32, axis: i32) -> f32 { return unpack2x16float(atomicLoad(&jetMask[colWord(x, y, z, axis)])).y; }
fn colSetDemand(x: i32, y: i32, z: i32, axis: i32, t: u32, head: f32) {
  atomicStore(&jetMask[colWord(x, y, z, axis)], min(t, COL_DEMAND_MAX) | (u32(clamp(round(head * COL_HEAD_Q), 0.0, 255.0)) << 24u));
}
fn colDemandAt(x: i32, y: i32, z: i32, axis: i32) -> u32 { return atomicLoad(&jetMask[colWord(x, y, z, axis)]) & COL_DEMAND_MAX; }
fn colSentHeadAt(x: i32, y: i32, z: i32, axis: i32) -> f32 { return f32(atomicLoad(&jetMask[colWord(x, y, z, axis)]) >> 24u) / COL_HEAD_Q; }
`;

// The column the thread of an awake brick column's column list handles (v2column's indexing).
const COLUMN_THREAD = /* wgsl */ `
  let k = foldThread(wg, nwg, li);
  if (k >= atomicLoad(&act2[V2_COUNT + CNT_USE_COLS]) * 16u) { return; }
  let col = atomicLoad(&act2[V2_COLS + k / 16u]);
  let t = k % 16u;
  let x = i32(col % u32(BX)) * BS + i32(t & 3u);
  let z = i32(col / u32(BX)) * BS + i32(t >> 2u);`;

/** v2runs: settle every awake column's runs and write its domain records, and the records of its
 * sleeping neighbours (read only: the pair stages' halo; identical concurrent builds write equal words). */
export const v2RunsKernel = (head, MAIN) => /* wgsl */ `
${head}
${columnWaterWGSL}
${MAIN} {
  // radial gravity has no columns: liquids hold still under it (the pipe model it replaced is not kept)
  if (P.gravMode == 2u) { return; }
${COLUMN_THREAD}
  colScan(x, z, true);
  for (var side = 0; side < 4; side++) {
    let n = mEdge(vec3i(x, 0, z) + face6(select(side, side + 2, side >= 2)));
    if (inGrid(n) && !colAwake(n.x, n.z)) { colScan(n.x, n.z, false); }
  }
}
`;

/** v2pairs. P.pairStage 0: every face's flux, both axes (a face is its -side column's, or its +side's
 * when the -side sleeps); 1: the transfers of the pairs along P.pairAxis (0 or 2) whose -side column has
 * parity P.pairParity (owned the same way). */
export const v2PairsKernel = (head, MAIN) => /* wgsl */ `
${head}
${columnWaterWGSL}
${MAIN} {
  if (P.gravMode == 2u) { return; }
${COLUMN_THREAD}
  let here = vec3i(x, 0, z);
  if (P.pairStage == 0u) {
    for (var axis = 0; axis <= 2; axis += 2) {
      let next = mEdge(here + axisV(axis)); let prev = mEdge(here - axisV(axis));
      if (inGrid(next)) { colFluxes(x, z, next.x, next.z, axis); }
      if (inGrid(prev) && !colAwake(prev.x, prev.z)) { colFluxes(prev.x, prev.z, x, z, axis); }
    }
    return;
  }
  let axis = i32(P.pairAxis);
  let next = mEdge(here + axisV(axis)); let prev = mEdge(here - axisV(axis));
  if (u32(select(z, x, axis == 0) & 1) == P.pairParity) {
    if (inGrid(next)) { colTransfers(x, z, next.x, next.z, axis); }
  } else if (inGrid(prev) && !colAwake(prev.x, prev.z)) { colTransfers(prev.x, prev.z, x, z, axis); }
}
`;

/** A tick's pair stages, [axis, stage, parity]: the fluxes, then the transfers, the axes alternating each
 * tick. The parities keep one order: alternating them too leaves the U-tube's covered channel trading
 * single quanta past 10 s. */
export function pairOrder(tick) {
  const axes = tick & 1 ? [2, 0] : [0, 2];
  return [[0, 0, 0], ...axes.flatMap(axis => [[axis, 1, 0], [axis, 1, 1]])];
}
