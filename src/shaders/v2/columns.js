import { CELL_M } from '../../scale.js';
import { E, ELEMENTS, K } from '../../elements.js';
import { FOAM_ROWS } from '../../v2/foam.js';
import { SHOCK_FALL_CELLS, SHOCK_LANDINGS, V1_FALL_CELLS_MAX, v1LiquidHit, v1LiquidArrival } from '../../v2/dynamics-reference.js';
import { PHYS, SIM_GRAVITY } from '../../physics.js';
import { PACE } from '../move.js';
import { GRAVITY_MS2, STEPS_PER_TICK, V1_STEP_MS, v1PaceRate } from '../../v2/gravity.js';

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
//            in the y lane (high16 of core.z) and its fall fraction in the x lane (past R1's run speed, a run
//            whose landing reads its fall keeps there what the fall carries: colFall). Interior lanes are free.
// The runs pass once a 60 Hz tick, the pair stages SUB times (a pair step a V1 step: COLUMN.SUB). Mass leaves and
// arrives at run surfaces only; interior cells are never written.
//
// Two passes, both a thread an (x, z) column of the awake brick columns (ARGS2.COLS):
//   v2runs   after the block pass: packs supported runs, drops falling ones, decays foam (Monahan), and
//            writes the column's domain records (below) into liquidScratch.
//   v2pairs  a pair step is five dispatches: every face's flux, then one per axis and parity, a thread owning a
//            PAIR of neighbouring columns outright (dimensional splitting, LeVeque, Finite Volume Methods for
//            Hyperbolic Problems, 2002, ch. 19), so it computes every segment's flux, the outflow limit and the
//            transfers serially, with no atomics, no snapshots and no second reader. The order alternates each
//            step (Strang). SUB steps a tick (pairOrder): a face carries at most a cell a step and a front
//            advances a column a step, so V1's flow (a cell at FLOW, 3.3 cells a tick for water) needs V1's own
//            step; between steps the transfers keep the records (a pour's receiver is read again next tick).
// Custody: every unit of fill moves cell to cell through colMove, which carries the exact integer share
// of the source's carried energy and fuel (the cumulative-share telescoping of docs/v2/foundation.md
// "Integer energy and advection", here applied to a serial sequence of moves), its ctype, lava subtype and
// burning flag, and refuses (moving nothing) when either side would leave the format.

// ---------------------------------------------------------------- constants (JS and WGSL)
export const COLUMN = (() => {
  // the reference pull: V1's (v2/gravity.js GRAVITY_MS2, user decision 2026-10-21: V2 falls as V1 does)
  const TICK_HZ = 60, G_MS2 = GRAVITY_MS2;
  const G = G_MS2 / CELL_M / (TICK_HZ * TICK_HZ);   // cells/tick² at reference gravity
  const FULL = 1 << 16;
  // the pair stages' steps a tick: V1's own step (STEPS_PER_TICK), so a face's flux is V1's cells a step and a
  // front advances as V1's cells do; lanes hold quanta a step (LANE_HZ)
  const SUB = STEPS_PER_TICK, LANE_HZ = TICK_HZ * SUB;
  const G_SUB = G / (SUB * SUB);                     // cells/step² (V1's SIM_GRAVITY at the reference pull)
  // Wave speed is sqrt(g h) cells a step; one explicit step is stable while g·h stays under 0.5 cells²/step².
  // A face accelerates as if at most H_CAP deep (below): WAVE_GH, the g·h it reaches there, is the explicit step's
  // bound with lean-sim's 1.7x margin (its 16 cells at 2 g a 60 Hz step: real water is dispersive, deep-water waves
  // of length L travel at sqrt(g L / 2 pi), not sqrt(g h)). At V1's pull and step that is 11.6 cells: every face
  // deeper than that relaxes at the scheme's fastest stable rate, a shallower one at V1's pull.
  const LEAN_DEEP_CELLS = 16, LEAN_G_MS2 = 19.6, LEAN_HZ = 60;   // lean-sim's calibrated deep face: 16 cells at its pull
  const WAVE_GH = LEAN_DEEP_CELLS * LEAN_G_MS2 / CELL_M / (LEAN_HZ * LEAN_HZ);
  return {
    TICK_HZ, G_MS2, G, FULL, WAVE_GH, SUB, LANE_HZ, G_SUB,
    // a face's depth-averaged flux (quanta a step per cell of wet face) gains this a step per cell of head
    ACC: G_SUB * FULL,
    H_CAP: WAVE_GH / G_SUB,
    // covered runs only: stable iff COMP >= 2 g dt² (four horizontal faces, one step); 3 g dt² (lean-sim's margin)
    COMP: 3 * G_SUB,
    QMIN: 0.5,                 // a segment flux under this (quanta a step) snaps to 0 (lean-sim)
    FILM: FULL >> 3,           // the shallow-water dry tolerance (GeoClaw's dry_tolerance, Berger et al. 2011)
    // V1's liquid is whole cells: on dry ground a cell with no liquid over it is a film whose flow is spent (react.js:
    // FILM_KEEP of its speed a step), so a spill spreads until it is a cell deep and beads there (MV-13; measured on V1
    // 2026-10-22, tools/v2/runs-browser-check.mjs: a 4³ block of water or of mud is one cell deep over 64 columns).
    // A face onto dry ground at its own level carries nothing from under this; over an edge it pours, into liquid
    // (or a layer on another liquid: V1's pool surface keeps flowing) the dry tolerance holds.
    // Intentional (decided under the user's delegation, 2026-10-22): V1's lone droplets wander for ever (react.js
    // DROPLET_WANDER, FILM_COHESION) and its spill beads into whole cells; V2's films stop here and its fills level
    // (a 4³ spill rests 0.4 deep over 170 columns, V1's a cell deep over 64), so a spill rests and certifies idle
    // (wandering would cost the rest certification and frame time)
    FILM_DRY: FULL,
    DEADQ: 2,                  // dead band, in fill quanta of the stiffer side (lean-sim)
    // the rows' damping is per substep of the 180 Hz model it calibrated (v2Rows: drag); per pair step (240 Hz)
    // it is 1 - (1 - damp)^(3/4), the same damping a second (colDampStep)
    DAMP_STEPS: 3,
    STALL: 1.5,                // the stall band: a drive whose damped steady flow moves under one quantum a step
    // a face's flux at most: under f16's 65,504 by more than its spacing there (32), so a lane never rounds
    // past it. 0.99 cells a step (71 m/s, V1's V_MAX): an explicit face moves at most its own cell a step.
    Q_MAX: 65000,
    // a face under a lid (a closed cell over the segment on either side: a hole, a bore, a pipe) carries at most
    // this, quanta a step: a cell a tick. V1's liquid through a one-cell opening moves a whole cell at a time and
    // waits for the next to refill it (react.js pipe flow, move.js Margolus pairs), so its hole drains at about a
    // fifth of a cell a step whatever its speed (measured on V1, 2026-10-22: tools/outcomes/thresholds.js V1_HOLE;
    // runs-browser-check drain), where a face at V1's speed would carry four times that
    BORE_Q: 65000 / STEPS_PER_TICK,
    // a falling run's law: V1's (colFall), STEPS V1 steps a tick at V1's gravity (cells/step², SIM_GRAVITY at the
    // reference pull) to V1's terminal speed V_MAX (cells/step)
    STEPS: STEPS_PER_TICK, G_STEP: SIM_GRAVITY, V_MAX: PHYS.V_MAX,
    // R14's birth gate: an overfall faster than this leaves as particles (lean-sim V_JET), m/s
    JET_SPEED: 1,
    // V1's orifice (react.js: a liquid under a head leaves an opening at ORIFICE_CV·√(2gh), to its FLOW)
    ORIFICE_CV: PHYS.ORIFICE_CV,
    // a deposited cell to launch: its y lane holds this, less its upward launch speed (a falling run's own
    // y lane is never negative)
    JET_MARK: -1,
    // V1's landing splash (move.js land, MV-5): a liquid that lands faster than LAND_SPLASH_V (cells/step), on
    // anything, turns sideways at its FLOW plus LAND_SPLASH_GAIN of its impact speed, in a random direction, each
    // component to V_MAX: every cell of it that lands. A run throws the cells it lands this tick (the rows it
    // vacated) from its top, each at a hashed azimuth. Slower landings (a pour's one-cell drop) merge.
    SPLASH_V: PHYS.LAND_SPLASH_V, SPLASH_GAIN: PHYS.LAND_SPLASH_GAIN, STEP_MS: V1_STEP_MS, CROWN_SALT: 0x63726f77,
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
// colDampStep's keep^(3/4) is DAMP_STEPS rows' substeps over SUB pair steps
if (COLUMN.DAMP_STEPS / COLUMN.SUB !== 0.75) throw new Error('columns.js: colDampStep takes keep^(DAMP_STEPS / SUB) as keep^(3/4)');

// Radial gravity (P.gravMode 2) has no runs: "down" is a different axis in each of the six pyramids around
// the centre, and a run is a column along y. There a liquid moves cell face to cell face instead, The Powder
// Toy's way (SimulationImpl::MovementPhase: a liquid that cannot move along the gravity vector steps
// perpendicular to it, then along it from where it got to; GetGravityField's radial case: full strength
// toward the centre). Each cell's pull is the dominant axis of its vector (modes.js mDown, as radialDrip and
// V1's rotated blocks read it, shaders/move.js gravFrame). A face along that axis PACKS (the upper cell's
// fill into the lower's room); a face across it FLOWS, from the higher head to the lower, the head being the
// radial potential (constant pull: the distance to the centre, in cells) at the surface of the liquid
// stacked over the cell along its pull, so a lake at rest is an exact sphere about the centre. Liquid over
// air is radialDrip's (blasts.js): it flies toward the centre as particles. Momentum-free (no lanes): the
// head relaxes, it does not slosh.
export const RADIAL = {
  // the share of a face's head difference (cells) that crosses it a tick at reference gravity. The demands
  // are frozen (Jacobi), and explicit diffusion over a cell's four sideways faces keeps every Fourier mode's
  // sign, so it never overshoots or rings, only up to 1/8 (amplification 1 - 8 r ≥ 0).
  RATE: 1 / 8,
  // a covered giver keeps this many quanta, so the liquid over it never stands on air (radialDrip would
  // throw it as particles)
  KEEP: 1,
  // a face's demand word: its quanta, the direction, and each side's cover (frozen with the demand)
  DEMAND_MAX: 0x1fffffff, BACK: 0x80000000, COVERED_MINUS: 0x40000000, COVERED_PLUS: 0x20000000,
};

// V1's shock on landing (react.js: an explosive landing with ½·μ·u² of at least its blast.shock goes off,
// common.js hitKE), by its fall, on V1's own fall law (dynamics-reference.js v1LiquidArrival: V1's Margolus move
// and its paced draws make a liquid's fall a function of its height and its phase, its start row's parity). A run
// falls on that law itself (colFall steps V1's partition and draws), so a lone cell lands at V1's own speed, phase
// and all: its hit is V1's at that speed (colV1Hit: dynamics-reference.js v1LandingHit), against its speed for the
// shock (speed2: ½·dens·u² = blast.shock, (cells/step)²): on a solid, nitroglycerin's from 9 cells at phase 0
// (2.7 m), 10 at phase 1. A run landing ON a charge sets it off from V1's fall for the pair (SHOCK_LANDINGS:
// colShockOnFall; a lone cell's phased law at the speed that fall lands at, colShockOnSpeed). A stack (a run of
// more than one cell) counts its top's fall at any phase (colV1Fall), V1's hit after it (colV1FallSpeed: v1LiquidHit,
// a table to V1_FALL_CELLS_MAX, past which it is at V_MAX): measured on V1 (2026-10-22, tools/outcomes/engine-v1.js,
// nitroglycerin 4×4 blocks 3 and 5 tall in fresh boxes, both phases: rest when the top falls 8, go off when it falls
// 9 or 10; the bottom layer lands and splashes aside, move.js land, and the cells above it fall on to the floor). So
// a run's landing reads how far it has fallen (colFall's fallen, whole cells) and how tall it is. V1's hit is at its
// own speed, which PHYS.V_MAX caps (react.js forces): a longer fall hits no harder, so a liquid it outweighs too much
// never sets it off (nitroglycerin onto water or oil).
export const COLUMN_SHOCK = Object.freeze(Object.entries(SHOCK_FALL_CELLS).map(([id, cells]) => {
  const e = ELEMENTS[+id];
  if (e.kind !== K.LIQUID) throw new Error(`columns.js: ${e.key}'s own landing is no liquid's`);
  return { id: +id, cells, speed2: 2 * e.blast.shock / e.dens, hits: Array.from({ length: V1_FALL_CELLS_MAX + 1 }, (_, h) => v1LiquidHit(e, h)) };
}));
export const COLUMN_SHOCK_ON = Object.freeze(SHOCK_LANDINGS.filter(r => ELEMENTS[r.faller].kind === K.LIQUID));

// V1's flow cap (react.js forces: a liquid's head-driven flow is at most its FLOW, cells/step; move.js moves a cell at
// u cells/step u/(2-u) cells a step on average, v2/gravity.js v1PaceRate): a face carries at most FLOW's paced
// cells a pair step (a V1 step: water's 0.82, mud's 0.11, under the lane's Q_MAX), and an orifice's jet leaves at
// most at FLOW (m/s). Non-liquids 0.
export const COLUMN_FLOW = Object.freeze(ELEMENTS.map(e => {
  const flow = e.kind === K.LIQUID ? e.flow ?? 0 : 0;
  // (keep: V1's drag a step on it once it has landed, react.js forces: 1 - DRAG)
  return { q: Math.min(COLUMN.Q_MAX, Math.floor(v1PaceRate(flow) * COLUMN.STEPS / COLUMN.SUB * COLUMN.FULL)), ms: Number((flow * V1_STEP_MS).toPrecision(7)),
    keep: e.kind === K.LIQUID ? Math.fround(1 - (e.drag ?? 0)) : 1 };
}));

// V1's landing break (react.js: a projectile breaks a breakable solid it hits with ½·ρ·u² of at least its hard, a
// landing included: move.js vertical leaves it unlanded for the react pass to see, common.js impactActs; BL-8): the
// solids a landing can break, their debris and hardness (V1's units: density, cells/step)
export const COLUMN_BREAKS = Object.freeze(ELEMENTS.filter(e => e.breakInto && E[e.breakInto] !== undefined).map(e => ({ id: e.id, into: E[e.breakInto], hard: e.hard })));

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
const COL_FILM_DRY: f32 = ${f(COLUMN.FILM_DRY)};
const COL_DEADQ: f32 = ${f(COLUMN.DEADQ)};
const COL_STALL: f32 = ${f(COLUMN.STALL)};
const COL_Q_MAX: f32 = ${f(COLUMN.Q_MAX)};
const COL_BORE_Q: f32 = ${f(COLUMN.BORE_Q)};
const COL_STEPS: f32 = ${f(COLUMN.STEPS)};
const COL_G_STEP: f32 = ${COLUMN.G_STEP};
const COL_V_MAX: f32 = ${f(COLUMN.V_MAX)};
const COL_PACE_Y: u32 = ${PACE.Y}u;
const COL_FULL: f32 = ${f(COLUMN.FULL)};
const COL_FOAM_ARRIVAL: f32 = ${f(COLUMN.FOAM_ARRIVAL)};
const COL_TICK_HZ: f32 = ${f(COLUMN.TICK_HZ)};
const COL_LANE_HZ: f32 = ${f(COLUMN.LANE_HZ)};
const COL_CELL_M: f32 = ${COLUMN.CELL_M};
const COL_JET_SPEED: f32 = ${f(COLUMN.JET_SPEED)};
const COL_ORIFICE_CV: f32 = ${COLUMN.ORIFICE_CV};
const COL_JET_MARK: f32 = ${f(COLUMN.JET_MARK)};
const COL_SPLASH_V: f32 = ${COLUMN.SPLASH_V};
const COL_SPLASH_GAIN: f32 = ${COLUMN.SPLASH_GAIN};
const COL_STEP_MS: f32 = ${f(COLUMN.STEP_MS)};
const COL_TAU: f32 = ${2 * Math.PI};
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
const RAD_RATE: f32 = ${RADIAL.RATE};
const RAD_KEEP: u32 = ${RADIAL.KEEP}u;
const RAD_DEMAND_MAX: u32 = ${RADIAL.DEMAND_MAX}u;
const RAD_BACK: u32 = ${RADIAL.BACK >>> 0}u;
const RAD_COVERED_MINUS: u32 = ${RADIAL.COVERED_MINUS}u;
const RAD_COVERED_PLUS: u32 = ${RADIAL.COVERED_PLUS}u;
const COL_FOAM_GAIN = array<f32, ${FOAM_ROWS.length}>(${FOAM_ROWS.map(r => `${r.gain}.0`).join(',')});
// V1's flow cap a liquid (COLUMN_FLOW): a face's flux at most (quanta a tick per cell of wet face), its jet at most (m/s)
const COL_FLOW_Q = array<f32, ${COLUMN_FLOW.length}>(${COLUMN_FLOW.map(r => f(r.q)).join(',')});
const COL_FLOW_MS = array<f32, ${COLUMN_FLOW.length}>(${COLUMN_FLOW.map(r => f(r.ms)).join(',')});
const COL_FLOW_KEEP = array<f32, ${COLUMN_FLOW.length}>(${COLUMN_FLOW.map(r => f(r.keep)).join(',')});

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
// a detonation request on the cell (native-contract.md requests: 1), for this tick's blasts
fn colDetonate(x: i32, y: i32, z: i32) { let s = slotOf(vec3i(x, y, z)); events[s] = events[s] | 1u; noteEvents(s, events[s]); markBusy(vec3i(x, y, z)); }
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
  // the decoration rides with the run, as the bank does; the air it leaves holds none (shaders/move.js)
  if (P.deco != 0u) { let paint = decoOf(sa); setDeco(sa, select(decoOf(sb), 0u, cid(mb.core) == 0u)); setDeco(sb, select(paint, 0u, cid(ma.core) == 0u)); }
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
// a splash droplet to launch at (vx, vy, vz) m/s, vy upward: the jets' mark with the rise in its y lane
fn colMarkCrown(x: i32, y: i32, z: i32, vx: f32, vy: f32, vz: f32) {
  let p = vec3i(x, y, z); let s = slotOf(p); let before = loadMaterial(s);
  storeMaterial(s, before, Material(withLane(withLane(withLane(zeroQ(before.core), 0, vx), 2, vz), 1, COL_JET_MARK - vy), before.bank));
  noteJet(brickOfCell(p));
}
// a hashed azimuth in [0, 1) turns (deterministic: position and tick only)
fn colCrownAzimuth(x: i32, y: i32, z: i32) -> f32 { var rs = seed3(vec3i(x, y, z), P.tick, ${COLUMN.CROWN_SALT}u); return rnd(&rs); }
// a deposited cell to launch at v (m/s along the axis): its lanes, and its brick on the jets' list
fn colMarkJet(x: i32, y: i32, z: i32, axis: i32, v: f32) {
  let p = vec3i(x, y, z); let s = slotOf(p); let before = loadMaterial(s);
  storeMaterial(s, before, Material(withLane(withLane(zeroQ(before.core), axis, v), 1, COL_JET_MARK), before.bank));
  noteJet(brickOfCell(p));
}
fn colGravity() -> f32 { if (P.gravMode != 0u) { return 0.0; } return COL_G * P.gravity / COL_G_MS2; }
// V1's gravity a step (cells/step²: SIM_GRAVITY at the reference pull, P.gravity's share of it)
fn colStepGravity() -> f32 { if (P.gravMode != 0u) { return 0.0; } return COL_G_STEP * (P.gravity / COL_G_MS2); }
// the index of V1's paced draw for a liquid falling at u (move.js fallAge: its fall age, speed over g, rounded;
// without a pull, V1's frame: the tick's step k)
fn colV1Age(u: f32, g: f32, k: i32) -> f32 {
  if (g > 0.0) { return floor(u / g + 0.5); }
  return f32(P.tick) * COL_STEPS + f32(k);
}
// V1's paced draw n (move.js draw: n·PACE.Y as a fixed-point fraction, common.js u32ToF32 · UINT_TO_UNIT)
fn colV1Draw(n: f32) -> f32 {
  let s = u32(n) * COL_PACE_Y;
  return (f32(s >> 8u) * 256.0 + f32(s & 255u)) * ${2 ** -32};
}
// a liquid charge's shock as V1's speed for it, (cells/step)² (COLUMN_SHOCK speed2); 0 for every other liquid
fn colShockSpeed2(id: u32) -> f32 {
${COLUMN_SHOCK.map(r => `  if (id == ${r.id}u) { return ${f(r.speed2)}; }`).join('\n')}
  return 0.0;
}
// V1's hit (cells/step) of a cell of the charge id landing after a fall of h cells at phase 0 (COLUMN_SHOCK hits)
fn colV1FallSpeed(id: u32, h: i32) -> f32 {
  if (h <= 0) { return 0.0; }
${COLUMN_SHOCK.map(r => r.hits.slice(1, -1).map((u, k) => `  if (id == ${r.id}u && h == ${k + 1}) { return ${f(u)}; }`).join('\n') + `\n  if (id == ${r.id}u) { return ${f(r.hits.at(-1))}; }`).join('\n')}
  return 0.0;
}
// the fall (cells) from which a run of liquid faller sets off the charge it lands on (COLUMN_SHOCK_ON fall): 0 any
// landing at all (and any touch from above: colScan), -1 never
fn colShockOnFall(faller: u32, charge: u32) -> i32 {
${COLUMN_SHOCK_ON.map(r => `  if (faller == ${r.faller}u && charge == ${r.charge}u) { return ${r.fall}; }`).join('\n')}
  return -1;
}
// whether that fall is a liquid's law, by phase (COLUMN_SHOCK_ON phased), not a measured fall at any phase
fn colShockOnPhased(faller: u32, charge: u32) -> bool {
  return ${COLUMN_SHOCK_ON.filter(r => r.phased).map(r => `(faller == ${r.faller}u && charge == ${r.charge}u)`).join(' || ') || 'false'};
}
// The fall V1's law counts for a run of n cells landing with its bottom at row b after h cells (colFall's fallen,
// whole cells, as V1's are): a lone cell's own, a stack's (a run of more than one cell) its top's, at any phase
// (COLUMN_SHOCK, above). A lone cell's phase needs no count: colFall steps V1's own partition, so it lands at V1's speed.
fn colV1Fall(h: f32, n: i32) -> i32 { return i32(floor(h + 0.5)) + n - 1; }
// V1's hit (cells/step) of a lone cell of the charge id landing at u1 cells/step (dynamics-reference.js v1LandingHit:
// react.js sees it at u1, then once more after a step of gravity and drag, to V_MAX)
fn colV1Hit(id: u32, u1: f32) -> f32 {
${COLUMN_SHOCK.map(r => `  if (id == ${r.id}u) { return max(u1, min(COL_V_MAX, (u1 + colStepGravity()) * ${f(1 - (ELEMENTS[r.id].drag ?? 0))})); }`).join('\n')}
  return u1;
}
// the landing speed (cells/step) from which a lone cell of liquid faller sets off the charge it lands on, where its
// law is phased (a liquid's own: V1's speed after its fall at phase 0, v1LiquidArrival's steps of g, to V_MAX)
fn colShockOnSpeed(faller: u32, charge: u32) -> f32 {
${COLUMN_SHOCK_ON.filter(r => r.phased).map(r => `  if (faller == ${r.faller}u && charge == ${r.charge}u) { return ${f(Math.min(PHYS.V_MAX, v1LiquidArrival(r.fall, 0, ELEMENTS[r.faller].grav) * SIM_GRAVITY))}; }`).join('\n')}
  return 0.0;
}
// A run of n cells that landed with its bottom cell at b, having fallen h (colFall's fallen) and arriving at u1
// cells/step: V1 react.js sets a charge off on a hit of ½·μ·u² past its shock, μ the mover's own mass on a solid and
// the reduced mass on loose matter (common.js hitKE: masses as V1's densities, a cell each), never on its own element
// or a gas (isGasLike). u is V1's hit: a lone cell's at its own landing (colV1Hit), a stack's its top's after its fall
// (colV1FallSpeed at colV1Fall's); its shock the speed colShockSpeed2, so it goes off when (μ/m)·u² reaches
// colShockSpeed2. Under the box's floor is a WALL only with solid edges (V1 react.js: past a solid edge a face is
// WALL; past a void one, still air).
fn colShockLand(x: i32, z: i32, b: i32, h: f32, n: i32, u1: f32) {
  let id = cid(colCell(x, b, z));
  // landing on a charge: V1 sets it off from its fall (COLUMN_SHOCK_ON, colShockOnFall), a lone cell's phased law
  // at the speed that fall lands at (colShockOnSpeed)
  if (b > 0) {
    let charge = cid(colCell(x, b - 1, z));
    let on = colShockOnFall(id, charge);
    var off = on >= 0 && colV1Fall(h, n) >= on;
    if (on > 0 && n == 1 && colShockOnPhased(id, charge)) { off = u1 >= colShockOnSpeed(id, charge); }
    if (off) { colDetonate(x, b - 1, z); }
  }
  // V1's hit at its landing (dynamics-reference.js v1LandingHit: the larger of its arrival speed and the next step's)
  let hit = max(u1, min(COL_V_MAX, (u1 + colStepGravity()) * colV1Keep(id)));
  // a breakable solid under it breaks, unless it is a charge it set off (V1: a charge goes off rather than break)
  if (b > 0 && !colPending(x, b - 1, z)) { colBreak(x, b - 1, z, densOfE(id), hit); }
  let shock = colShockSpeed2(id);
  if (shock <= 0.0) { return; }
  var share = 0.0;
  if (b == 0) {
    if (P.edge == 0u) { share = 1.0; }
  } else {
    let below = colCell(x, b - 1, z);
    let j = cid(below);
    let kind = clsOf(below);
    if (kind == C_SOLID) { share = 1.0; }
    if ((kind == C_POWDER || kind == C_LIQUID) && j != id) { share = densOfE(j) / (densOfE(id) + densOfE(j)); }
  }
  var u = colV1FallSpeed(id, colV1Fall(h, n));
  if (n == 1) { u = colV1Hit(id, u1); }
  if (share * u * u >= shock) { colDetonate(x, b, z); }
}
// the damping of a pair step (COLUMN.DAMP_STEPS of the rows' substeps a tick, SUB steps a tick: keep^(3/4))
fn colDampStep(liq: u32) -> f32 { let keep = 1.0 - dampOf(liq); return 1.0 - sqrt(sqrt(keep * keep * keep)); }
// A breakable solid (COLUMN_BREAKS) at (x, y, z) hit by a liquid of density dens at u cells/step breaks into its
// debris when ½·dens·u² reaches its hard (V1's), the fracture work KE_TO_HEAT·hard its heat, a declared source (as
// a packet's fracture: particles.js impact)
fn colBreak(x: i32, y: i32, z: i32, dens: f32, u: f32) {
  let p = vec3i(x, y, z); let s = slotOf(p); let before = loadMaterial(s); let j = cid(before.core);
  var into = -1; var hard = 0.0;
${COLUMN_BREAKS.map(r => `  if (j == ${r.id}u) { into = ${r.into}; hard = ${f(r.hard)}; }`).join('\n')}
  if (into < 0 || 0.5 * dens * u * u < hard || (events[s] & 1u) != 0u) { return; }
  var after = before;
  after.core.x = (before.core.x & 0xffffff00u) | u32(into);
  if (clsOf(after.core) == C_POWDER) { after.core = setFall(after.core, 0.0, 0.0); }
  let warm = energyAdd(energyOf(before), energyMul(u32(round(hard * ${f(PHYS.KE_TO_HEAT)} * 256.0)), 65536u));
  if (!energyFits(after, warm)) { return; }
  after = withEnergy(after, warm);
  noteEnergySource(p, energySub(warm, energyOf(before)));
  storeMaterial(s, before, after);
  markBusy(p);
}
// V1's flow caps of a liquid (COLUMN_FLOW): a face's flux (quanta a tick per cell of wet face), a jet's speed (m/s)
fn colFlowCap(liq: u32) -> f32 { return COL_FLOW_Q[liq]; }
fn colFlowSpeed(liq: u32) -> f32 { return COL_FLOW_MS[liq]; }
fn colV1Keep(liq: u32) -> f32 { return COL_FLOW_KEEP[liq]; }

// The paint of a receiver holding fd quanta under paint d that takes n quanta under paint s (RGBA8, unpainted 0):
// the mixture's, alpha-weighted (premultiplied colour, mean alpha by fill), so a painted liquid's colour carries
// into the liquid it joins, diluted by what was there
fn colPaintMix(d: u32, s: u32, fd: u32, n: u32) -> u32 {
  if (fd == 0u || d == s) { return s; }
  let a = unpack4x8unorm(d); let b = unpack4x8unorm(s);
  let wa = f32(fd) * a.w; let wb = f32(n) * b.w;
  let alpha = (wa + wb) / f32(fd + n);
  if (wa + wb <= 0.0) { return 0u; }
  return pack4x8unorm(vec4f((a.xyz * wa + b.xyz * wb) / (wa + wb), alpha));
}

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
  // a conductor's spark is the cell's (shaders/move.js swaps whole cells): it goes with the fill only when the
  // whole cell's goes (the source drains to air), never copied into the receiver of a part (EL-10)
  if (conducts && have == n) { payload = max(payloadOf(dst.core), payloadOf(src.core)); }
  if (conducts && have > n) { payload = payloadOf(dst.core); }
  if (payload > 65535u) { colBusy(xa, ya, za); return false; }
  got = withAge(withPayload(got, payload), foamAgeOf(dst.core, src.core, n, fill, agitate));
  let sentEnergy = energySub(energyOf(src), heat);
  let gotEnergy = energyAdd(energyOf(dst), heat);
  if (!energyFits(Material(sent, src.bank), sentEnergy) || !energyFits(Material(got, dst.bank), gotEnergy)) { colBusy(xa, ya, za); return false; }
  // the decoration goes with the fill (shaders/move.js moves a painted cell's paint with it): a receiver that was
  // air takes the source's paint, one that holds liquid the fill-weighted mix of both (colPaintMix: painted water
  // poured into a pool keeps its colour there, RX-3), and a source drained to air holds none
  if (P.deco != 0u) {
    setDeco(ts, colPaintMix(decoOf(ts), decoOf(fs), materialAmount(dst.core), n));
    if (have == n) { setDeco(fs, 0u); }
  }
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
// ---- stacked liquids (oil on water): the hydrostatic pressure is the column's prefix sum over every layer
// (the multilayer Saint-Venant system: Audusse, Bristeau, Perthame and Sainte-Marie, M2AN 45, 2011). For a
// run k: x, its base's offset below its own bottom cell when it floats on a run whose top cell is partial
// (the interface sits inside that cell, at the lower run's surface); y, the weight of the runs stacked on it,
// each one's height times its density over the run's. Records are frozen while it is read (the flux stage).
fn colLayer(x: i32, z: i32, k: i32) -> vec2f {
  let r = colRec(x, k, z);
  let base = recLiq(r);
  if (base == 0u || recFalling(r)) { return vec2f(0.0, 0.0); }
  var shift = 0.0;
  if (k > 0) {
    let below = colRec(x, k - 1, z);
    if (recLiq(below) != 0u && !recFalling(below) && recTop(below) == recY0(r)) { shift = min(colEta(below) - f32(recY0(r)), 0.0); }
  }
  var load = 0.0;
  var n = k;
  var at = r;
  loop {
    if (recLast(at)) { break; }
    let above = colRec(x, n + 1, z);
    if (recY0(above) != recTop(at) || recLiq(above) == 0u || recFalling(above)) { break; }
    load = load + f32(recMass(above)) / COL_FULL * densOfE(recLiq(above)) / densOfE(base);
    at = above;
    n = n + 1;
  }
  return vec2f(shift, load);
}
// A lighter liquid meets a denser one's domain above that one's surface: there the denser run is a dry
// floor (oil spreads on water; the water below exchanges only with water). 1: the -side's run floats on
// the +side's; 2: the other way; 0: an ordinary face (the same liquid, or a dry side).
fn colFloats(ra: vec4u, rb: vec4u) -> i32 {
  let la = recLiq(ra); let lb = recLiq(rb);
  if (la == 0u || lb == 0u || recFalling(ra) || recFalling(rb) || (la == lb && recSub(ra) == recSub(rb))) { return 0; }
  if (densOfE(la) < densOfE(lb)) { return 1; }
  if (densOfE(lb) < densOfE(la)) { return 2; }
  return 0;
}
// the dry floor over a run: the air of its domain above its top cell
fn colFloor(r: vec4u) -> vec4u { return recMake(recR1(r), recTop(r), recR1(r), 0u, 0u, 0u, false, false); }
fn colDepthAt(r: vec4u, s0: i32, s1: i32, shift: f32) -> f32 {
  if (recLiq(r) == 0u) { return 0.0; }
  return min(max(colEta(r) + shift - f32(s0), 0.0), f32(s1 - s0));
}

// wet depth of a domain at the segment [s0, s1): Audusse et al.'s hydrostatic reconstruction
fn colDepth(r: vec4u, s0: i32, s1: i32) -> f32 {
  if (recLiq(r) == 0u) { return 0.0; }
  return min(max(colEta(r) - f32(s0), 0.0), f32(s1 - s0));
}

// ---- the segment rule (prototype segment()): the new flux of [s0, s1) between a (-side) and b, from u.
// Positive flows a to b. Falling runs, two dry floors and two different liquids exchange nothing.
fn colFlux(ra: vec4u, rb: vec4u, s0: i32, s1: i32, u: f32, up: f32, la: vec2f, lb: vec2f, bed: f32, film: f32, lid: bool) -> f32 {
  let dryA = recLiq(ra) == 0u; let dryB = recLiq(rb) == 0u;
  if (recFalling(ra) || recFalling(rb) || (dryA && dryB)) { return 0.0; }
  if (!dryA && !dryB && (recLiq(ra) != recLiq(rb) || recSub(ra) != recSub(rb))) { return 0.0; }
  let acc = COL_ACC * colGravity() / COL_G;
  if (acc <= 0.0) { return 0.0; }
  var liq = recLiq(ra);
  if (dryA) { liq = recLiq(rb); }
  // (bed: the segment's bottom below s0, a floating face's denser surface inside its top cell)
  let ha = colDepthAt(ra, s0, s1, la.x - bed); let hb = colDepthAt(rb, s0, s1, lb.x - bed);
  let damp = colDampStep(liq);
  // the layers' heads: each run's own surface (its base an interface inside the cell below when it floats on
  // another liquid) plus the weight of the layers it carries
  var drive = (colEta(ra) + la.x + la.y) - (colEta(rb) + lb.x + lb.y);
  // lean-sim's dead band (DEADQ quanta of the stiffer side), and never below the drive whose damped steady
  // flow v·h moves under one quantum a tick: 1.5·damp/(ACC·h), lean-sim's 1.5·damp/ACC at h = 1. No yield
  // stress: V1 has none (react.js liquids flow until the level evens out; measured on V1 2026-10-22,
  // tools/v2/runs-browser-check.mjs: a 4³ block of mud is a cell deep over 64 columns within 1 s; MV-8)
  let hFace = max(max(ha, hb), 1.0 / COL_FULL);
  let band = max(COL_DEADQ * max(colStiff(ra), colStiff(rb)), COL_STALL * damp / (acc * min(hFace, 1.0)));
  if (abs(drive) < band) { drive = 0.0; }
  var v = u;
  if (ha == 0.0) { v = min(v, 0.0); }   // a dry side's stale outflow is dropped
  if (hb == 0.0) { v = max(v, 0.0); }
  // a front onto dry ground takes the flow arriving behind it (momentum carried into the new face: V1's moving
  // cell keeps its speed into the cell it moves on to, react.js forces), so a front runs at the flow's speed
  if (hb == 0.0 && !colOver(rb, s0) && up > v) { v = up; }
  if (ha == 0.0 && !colOver(ra, s0) && up < v) { v = up; }
  var hUp = hb;
  if (drive > 0.0 || (drive == 0.0 && v > 0.0)) { hUp = ha; }
  v = v + acc * drive * min(1.0, COL_H_CAP / max(hUp, 1.0)) - colAdvect(u, up);
  if (drive == 0.0) { v = v * 0.5; }
  if ((v > 0.0 && ha == 0.0) || (v < 0.0 && hb == 0.0)) { v = 0.0; }
  // the film rule as the dry tolerance: a face whose upwind wet depth is under FILM carries no flux, and onto dry
  // ground at its level none from under \`film\` (FILM_DRY: V1's films; a floating layer's FILM)
  if (v > 0.0 && ha * COL_FULL < COL_FILM) { v = 0.0; }
  if (v < 0.0 && hb * COL_FULL < COL_FILM) { v = 0.0; }
  if (v > 0.0 && hb == 0.0 && !colOver(rb, s0) && ha * COL_FULL < film) { v = 0.0; }
  if (v < 0.0 && ha == 0.0 && !colOver(ra, s0) && hb * COL_FULL < film) { v = 0.0; }
  v = v * (1.0 - damp);
  if (abs(v) < COL_QMIN) { v = 0.0; }
  var cap = colFlowCap(liq);
  if (lid) { cap = min(cap, COL_BORE_Q); }
  return clamp(v, -cap, cap);
}
// what the flux v carries a tick (quanta): v times the upwind wet depth
fn colDemand(ra: vec4u, rb: vec4u, s0: i32, s1: i32, v: f32) -> u32 {
  if (v > 0.0) { return u32(floor(v * colDepth(ra, s0, s1))); }
  if (v < 0.0) { return u32(floor(-v * colDepth(rb, s0, s1))); }
  return 0u;
}

// ---- open edges (P.edge 1). Past a side of the grid is a dry, bottomless domain: a run's face against it
// flows as a dam break onto dry ground (the drive is its head over the face's bottom, the dead band, the
// film and the yield as at any face), memoryless (the void owns no lane), and what crosses leaves the box
// through the boundary ledger with its exact carried energy. Past an open floor a run falls out at R1's
// bulk run speed, from its bottom up.
fn colEdgeFlux(r: vec4u) -> f32 {
  if (recLiq(r) == 0u || recFalling(r)) { return 0.0; }
  let acc = COL_ACC * colGravity() / COL_G;
  if (acc <= 0.0) { return 0.0; }
  let s0 = recY0(r);
  let h = colDepth(r, s0, recTop(r));
  if (h * COL_FULL < COL_FILM) { return 0.0; }
  let damp = colDampStep(recLiq(r));
  let drive = colEta(r) - f32(s0);
  let band = max(COL_DEADQ * colStiff(r), COL_STALL * damp / (acc * min(h, 1.0)));
  if (drive < band) { return 0.0; }
  let v = acc * drive * min(1.0, COL_H_CAP / max(h, 1.0)) * (1.0 - damp);
  if (v < COL_QMIN) { return 0.0; }
  return min(v, colFlowCap(recLiq(r)));
}
// every run of a column against the void on one side
fn colEdges(x: i32, z: i32) {
  var k = 0;
  loop {
    let r = colRec(x, k, z);
    let v = colEdgeFlux(r);
    if (v > 0.0) {
      colBusy(x, recR1(r) - 1, z);
      colDrain(x, z, k, min(recMass(r), u32(floor(v * colDepth(r, recY0(r), recTop(r))))), false);
    }
    if (recLast(r)) { break; }
    k = k + 1;
  }
}
// n out of the box from the run of record k: from its surface down, or from its bottom up (an open floor)
fn colDrain(x: i32, z: i32, k: i32, n: u32, fromBottom: bool) {
  let r = colRec(x, k, z);
  var left = n;
  var giver = recR1(r) - 1;
  if (fromBottom) { giver = recY0(r); }
  var mass = recMass(r);
  loop {
    if (left == 0u || giver < recY0(r) || giver >= recR1(r)) { break; }
    let have = colFill(x, giver, z);
    if (have == 0u) { if (fromBottom) { giver = giver + 1; } else { giver = giver - 1; } continue; }
    let m = min(left, have);
    if (!colRemove(x, giver, z, m)) { break; }
    left = left - m; mass = mass - m;
    if (m == have) { if (fromBottom) { giver = giver + 1; } else { giver = giver - 1; } }
  }
  var end = recR1(r);
  if (!fromBottom) { end = giver + 1; }
  var liq = recLiq(r);
  if (mass == 0u) { end = recY0(r); liq = 0u; }
  colPut(x, k, z, withRecRun(r, end, liq, select(0u, recSub(r), mass != 0u), mass));
}
// n of (x, y, z)'s fill leaves the box: colMove's source half, the receiver the boundary ledger
fn colRemove(x: i32, y: i32, z: i32, n: u32) -> bool {
  if (n == 0u) { return true; }
  if (colPending(x, y, z)) { colBusy(x, y, z); return false; }
  let s = slotOf(vec3i(x, y, z)); let src = loadMaterial(s);
  if (!isLiq(src.core)) { return false; }
  let have = cFill(src.core);
  if (n > have) { return false; }
  let carried = energySub(energyOf(src), energyMul(FULLU, cTq(src.core)));
  let heat = energyShare(carried, 0u, n, have);
  let conducts = conductsNative(cid(src.core));
  var sent = drainedCore(src.core, have - n);
  if (have > n && !conducts) { sent = withPayload(sent, payloadOf(src.core) - shareUnsigned(payloadOf(src.core), 0u, n, have)); }
  let sentEnergy = energySub(energyOf(src), heat);
  if (!energyFits(Material(sent, src.bank), sentEnergy)) { colBusy(x, y, z); return false; }
  if (P.deco != 0u && have == n) { setDeco(s, 0u); }
  storeMaterial(s, src, withEnergy(Material(sent, src.bank), sentEnergy));
  colSink(x, y, z, n, heat);
  colBusy(x, y, z);
  return true;
}
// the boundary ledger's mass and energy (v2BoundaryWGSL's for gases)
fn colSink(x: i32, y: i32, z: i32, n: u32, heat: vec2u) {
  let s = slotOf(vec3i(x, y, z));
  noteBoundaryMass(n); noteEnergySink(vec3i(x, y, z), heat);
  if (cid(loadCore(s)) == 0u) { events[s] = 0u; }
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

// ---- fall: the run [r0, r1) with air under it, down to the lowest air cell above o0, on V1's law for a falling
// liquid (dynamics-reference.js v1LiquidArrival, which V1's measured landings follow to the digit: react.js forces,
// move.js vertical, draw, fallAge). A tick is COL_STEPS V1 steps. A step moves the run's bottom down a cell when that
// cell is on a Margolus block's top half (its row against the step's parity: V1's partition, the tick's first step
// even, as V1's frames run four to a tick) and its paced draw at its fall age (its speed over g, PACE.Y) falls under
// its speed (at V_MAX always); then gravity adds g to its speed (no drag on a liquid in free fall), to V_MAX.
// Arriving over what it lands on ends the fall, at the speed it had. Whole cells: the bottom cell's y lane holds its
// speed (cells/tick: COL_STEPS of V1's cells/step), its x lane the cells it has fallen. Returns its new bottom: under
// 0 past an open floor, its cells under row 0 gone.
fn colFall(x: i32, z: i32, o0: i32, r0: i32, r1: i32) -> i32 {
  let b = colCell(x, r0, z);
  let g = colStepGravity();
  // a run that was not falling last tick (its bottom's x lane is then a segment's flux), or a deposit
  // whose launch was refused, falls from rest
  var u = laneOf(b, 1) / COL_STEPS;
  var fallen = laneOf(b, 0);
  if (u <= 0.0) { u = 0.0; fallen = 0.0; }
  // V1's speed is whole steps of g below V_MAX (the lane's f16 rounds it): its fall age, exact
  if (u < COL_V_MAX && g > 0.0) { u = min(floor(u / g + 0.5) * g, COL_V_MAX); }
  var fl = r0;
  loop {
    if (fl - 1 < o0 || colClass(x, fl - 1, z) != C_AIR) { break; }
    fl = fl - 1;
  }
  // past an open floor (P.edge 1) is still air (V1 react.js: a void edge's face): with air all the way down the run
  // falls on through it on the same law, accelerating from rest, and what passes row 0 leaves the box
  let bottomless = P.edge == 1u && fl == 0;
  var d = 0;
  var landed = false;
  var hit = u;
  // a layer floating on another liquid follows its surface: a gap of one cell (a lower layer's drained top
  // cell) closes at once, not from rest, or the layer and the surface it rests on trade the cell forever
  if (r0 - fl == 1 && fl > o0 && colClass(x, fl - 1, z) == C_LIQUID && u == 0.0) { d = 1; landed = true; }
  for (var k = 0; f32(k) < COL_STEPS; k++) {
    if (landed) { break; }
    // its row against the step's parity (f32 floors: the executed subset has no bit operations)
    let row = f32(r0 - d + k);
    let top = row - 2.0 * floor(row * 0.5) == 0.0;
    if (u > 0.0 && top && (u >= COL_V_MAX || colV1Draw(colV1Age(u, g, k)) < u)) {
      d = d + 1;
      if (r0 - d == fl && !bottomless) { landed = true; hit = u; }
    }
    u = min(u + g, COL_V_MAX);
  }
  fallen = fallen + f32(d);
  colBusy(x, r0, z);
  if (d > 0) {
    // (a cell whose row would be under 0 is past an open floor: it leaves the box, the boundary ledger takes it)
    for (var k = r0; k < r1; k++) {
      if (k - d < 0) { colRemove(x, k, z, colFill(x, k, z)); } else { colSwap(x, k, k - d, z); }
    }
    colBusy(x, max(r0 - d, 0), z); colBusy(x, r1 - 1, z);
  }
  if (landed) { colSetLanes(x, r0 - d, z, 0.0, 0.0); } else if (r1 - d > 0) { colSetLanes(x, max(r0 - d, 0), z, u * COL_STEPS, fallen); }
  if (landed) { colShockLand(x, z, r0 - d, fallen, r1 - r0, hit); }
  // V1's landing (move.js land) sees the speed it has the step after it arrives: a step more of gravity, and its
  // drag now it is no longer in free fall (react.js forces), to V_MAX
  let impact = min(COL_V_MAX, (hit + g) * colV1Keep(cid(colCell(x, r0 - d, z))));
  if (landed && d > 0 && impact > COL_SPLASH_V) { colSplash(x, z, r0 - d, r1 - d, d, impact); }
  return r0 - d;
}
// V1's splash (move.js land) of a run [b0, b1) that just landed at impact cells/step: the cells it landed this tick
// (rows of them, the rows it vacated above it), cut from its top down into those rows, each marked to launch
// sideways at its liquid's FLOW plus LAND_SPLASH_GAIN of the impact, at a hashed azimuth, each component to V_MAX
fn colSplash(x: i32, z: i32, b0: i32, b1: i32, rows: i32, impact: f32) {
  let speed = colFlowSpeed(cid(colCell(x, b0, z))) + COL_SPLASH_GAIN * impact * COL_STEP_MS;
  let most = COL_V_MAX * COL_STEP_MS;
  var giver = b1 - 1;
  for (var r = 0; r < rows; r++) {
    let y = b1 + r;
    var put = 0u;
    loop {
      if (put >= FULLU || giver < b0) { break; }
      let have = colFill(x, giver, z);
      if (have == 0u) { giver = giver - 1; continue; }
      let m = min(FULLU - put, have);
      if (!colMove(x, giver, z, x, y, z, m, false)) { break; }
      put = put + m;
      if (m == have) { giver = giver - 1; }
    }
    if (put == 0u) { break; }
    let azimuth = colCrownAzimuth(x, y, z) * COL_TAU;
    colMarkCrown(x, y, z, clamp(speed * cos(azimuth), -most, most), 0.0, clamp(speed * sin(azimuth), -most, most));
  }
}

// ---- the column: its domains bottom up into records (settle: pack and fall, as the runs pass does; a pair's
// sleeping partner only reads). Returns the number of records.
fn colFinish(x: i32, z: i32, k: i32, y0: i32, top: i32, r1: i32, liq: u32, sub: u32, mass: u32, o0: i32, settle: bool, loose: bool) -> i32 {
  if (liq == 0u) { colPut(x, k, z, recMake(y0, top, y0, 0u, 0u, 0u, false, false)); return k + 1; }
  var bottom = y0;
  var end = r1;
  var falling = y0 > o0 && colClass(x, y0 - 1, z) == C_AIR;
  // an open floor under the run: it falls on through it (colFall), from rest on V1's law
  let out = P.edge == 1u && y0 == 0;
  var run = liq;
  var held = mass;
  if (settle && (falling || out)) {
    let fell = colFall(x, z, o0, y0, r1);
    bottom = max(fell, 0);
    end = max(r1 - (y0 - fell), 0);
    falling = (bottom > o0 && colClass(x, bottom - 1, z) == C_AIR) || (P.edge == 1u && bottom == 0);
    // what passed row 0 left the box: the run holds what is left
    if (fell < 0) {
      held = 0u;
      for (var j = 0; j < end; j++) { held = held + colFill(x, j, z); }
      if (held == 0u) { run = 0u; end = 0; falling = false; }
    }
    // the domain under it ends where it now starts (a dry floor it reached is gone)
    if (bottom != y0) {
      let below = colRec(x, k - 1, z);
      if (recLiq(below) == 0u && recY0(below) == bottom) {
        colPut(x, k - 1, z, recMake(bottom, top, end, run, select(0u, sub, run != 0u), held, falling, false));
        return k;
      }
      colPut(x, k - 1, z, withRecTop(below, bottom));
    }
  } else if (settle) {
    // a supported bottom keeps no fall state; then a loose run packs
    if (laneOf(colCell(x, y0, z), 1) != 0.0) { colSetLanes(x, y0, z, 0.0, 0.0); }
    if (loose) { end = colPack(x, z, y0, top, mass); }
  }
  colPut(x, k, z, recMake(bottom, top, end, run, select(0u, sub, run != 0u), held, falling, false));
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
  if (settle) { colStratify(x, z); }
  // Open stretches [o0, o1) bottom up: a dry floor, then runs each with the air above them. A run is loose (it
  // packs) when a cell under another is not full, or a compressed cell is not its domain's top. A domain ends at a
  // new liquid, a closed cell or the column's top; one colFinish call site (Metal inlines each call: compile time).
  var k = 0;
  var y = 0;
  var open = false;
  var o0 = 0; var y0 = 0; var r1 = 0; var liq = 0u; var sub = 0u; var mass = 0u;
  var loose = false; var over = -1; var below = 0u;
  loop {
    let inside = y < NY;
    let probe = colProbe(x, min(y, NY - 1), z);
    let here = inside && probeOpen(probe);
    if (!open) {
      if (!inside) { break; }
      if (!here) { y = y + 1; continue; }
      open = true; o0 = y; y0 = y; r1 = y; liq = 0u; sub = 0u; mass = 0u; loose = false; over = -1; below = 0u;
    }
    var id = 0u;
    if (here) {
      if (settle && probeRead(probe)) { foamDecay(x, y, z); }
      id = probeLiquid(probe);
    }
    let grows = id != 0u && liq == id && sub == probeSub(probe) && r1 == y;
    let starts = id != 0u && !grows;
    // a liquid that sets a charge off from any fall does so the moment it rests on it: V1 measured mercury laid on
    // nitroglycerin, or dropped 1 or 2 cells, goes off (2026-10-22, tools/v2/runs-browser-check.mjs: it sinks into
    // it and gains speed while it presses on it, dynamics-reference.js V1_SINKING_FALLS; BL-10)
    if (settle && starts && liq != 0u && r1 == y && colShockOnFall(id, liq) == 0) { colDetonate(x, y - 1, z); }
    if (!here || (starts && (liq != 0u || y > o0))) {
      k = colFinish(x, z, k, y0, y, r1, liq, sub, mass, o0, settle, loose || (over >= 0 && over != y - 1));
    }
    if (!here) {
      open = false;
      if (!inside) { break; }
      y = y + 1;
      continue;
    }
    if (id != 0u) {
      let fill = probeFill(probe);
      if (grows) {
        if (below < FULLU || over >= 0) { loose = true; }
        r1 = y + 1; mass = mass + fill;
      } else {
        y0 = y; r1 = y + 1; liq = id; sub = probeSub(probe); mass = fill; loose = false; over = -1;
      }
      if (fill > FULLU) { over = y; }
      below = fill;
    }
    y = y + 1;
  }
  if (k == 0) { colPut(x, 0, z, recMake(0, 0, 0, 0u, 0u, 0u, false, true)); return 1; }
  colPut(x, k - 1, z, withRecLast(colRec(x, k - 1, z), true));
  return k;
}
// A layer of a denser liquid that holds more than its cells under a lighter one floats that one up, not
// compresses under it (a liquid is no lid): the air above the lighter run bubbles down to just over the
// denser top cell, which spills its surplus into it. Cell swaps and colMove only: exact. (The way down, a
// drained top cell under a floating layer, is colFall's one-cell gap.)
fn colStratify(x: i32, z: i32) {
  var y = 0;
  loop {
    if (y + 1 >= NY) { break; }
    let here = colProbe(x, y, z); let up = colProbe(x, y + 1, z);
    let a = probeLiquid(here); let b = probeLiquid(up);
    if (a != 0u && b != 0u && a != b && probeFill(here) > FULLU && densOfE(b) < densOfE(a)) {
      // the lighter run [y + 1, e) and the cell over it
      var e = y + 2;
      loop { if (e >= NY || probeLiquid(colProbe(x, e, z)) != b) { break; } e = e + 1; }
      if (e < NY && probeOpen(colProbe(x, e, z)) && probeLiquid(colProbe(x, e, z)) == 0u) {
        for (var k = e; k > y + 1; k--) { colSwap(x, k, k - 1, z); }
        colMove(x, y, z, x, y + 1, z, probeFill(here) - FULLU, false);
        y = e;
        continue;
      }
    }
    y = y + 1;
  }
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
// a closed cell (neither air nor liquid): a segment's lid
fn colLidAt(x: i32, y: i32, z: i32) -> bool { let k = colClass(x, y, z); return k != C_AIR && k != C_LIQUID; }
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
// any other falls as a run. The launch speed is V1's orifice law (react.js: ORIFICE_CV·√(2gh), to the liquid's
// FLOW), H the exact launch head (colLaunchHead, cells over s0) over the row's centre.
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
  let fast = v / COL_FULL * COL_LANE_HZ * COL_CELL_M > COL_JET_SPEED;
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
      let speed = min(COL_ORIFICE_CV * sqrt(2.0 * g * COL_CELL_M * max(head - (f32(r) + 0.5), 0.0)), colFlowSpeed(recLiq(rs)));
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
    let qa = colRec(xa, i, za); let qb = colRec(xb, j, zb);
    let floats = colFloats(qa, qb);
    var ra = qa; var rb = qb; var la = colLayer(xa, za, i); var lb = colLayer(xb, zb, j);
    // a floating face's floor is the denser run's surface, inside the cell under its dry floor
    if (floats == 1) { rb = colFloor(qb); lb = vec2f(min(colEta(qb) - f32(recR1(qb)), 0.0), 0.0); }
    if (floats == 2) { ra = colFloor(qa); la = vec2f(min(colEta(qa) - f32(recR1(qa)), 0.0), 0.0); }
    let s0 = max(recY0(ra), recY0(rb)); let s1 = min(recTop(ra), recTop(rb));
    // the segment's true bed: the higher of the two sides' bases, each its bottom cell less its shift
    let bed = min(max(f32(recY0(ra)) + la.x, f32(recY0(rb)) + lb.x) - f32(s0), 0.0);
    // a falling run's bottom lanes are its fall (it meets no segment)
    if (s0 < s1 && !recFalling(ra) && !recFalling(rb)) {
      // lanes hold last tick's fluxes all stage long (only the transfers write them), so the face
      // upwind is read race-free
      let u = laneOf(colCell(xa, s0, za), axis);
      // (the face upwind of the flow, or of the head where the face is at rest: a new front's)
      // (a lid over the segment on either side: a bore, COLUMN.BORE_Q)
      let lid = s1 < NY && (colLidAt(xa, s1, za) || colLidAt(xb, s1, zb));
      let v = colFlux(ra, rb, s0, s1, u, colUpwind(xa, za, xb, zb, s0, axis, select(u, colEta(ra) - colEta(rb), u == 0.0)), la, lb, bed, select(COL_FILM_DRY, COL_FILM, floats != 0), lid);
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
    if (recTop(qa) < recTop(qb)) { if (recLast(qa)) { break; } i = i + 1; }
    else { if (recLast(qb)) { break; } j = j + 1; }
  }
}
// ---- the transfers of a column pair (the thread owns both columns and their records): one limit a
// sending run over the pair's faces (never more than it now holds), then surface to surface, bottom up
fn colTransfers(xa: i32, za: i32, xb: i32, zb: i32, axis: i32) {
  colClearScratch(xa, za); colClearScratch(xb, zb);
  var i = 0; var j = 0;
  loop {
    let qa = colRec(xa, i, za); let qb = colRec(xb, j, zb);
    let floats = colFloats(qa, qb);
    var ra = qa; var rb = qb;
    if (floats == 1) { rb = colFloor(qb); }
    if (floats == 2) { ra = colFloor(qa); }
    let s0 = max(recY0(ra), recY0(rb)); let s1 = min(recTop(ra), recTop(rb));
    if (s0 < s1 && !recFalling(ra) && !recFalling(rb)) {
      // the flux stage's face becomes the lane; its word now holds what it carries (and the launch head)
      let v = colVelocityAt(xa, s0, za, axis);
      if (v != laneOf(colCell(xa, s0, za), axis)) { colSetLane(xa, s0, za, axis, v); }
      let t = colDemand(ra, rb, s0, s1, v);
      colSetDemand(xa, s0, za, axis, t, colFaceHeadAt(xa, s0, za, axis));
      if (v > 0.0) { colPut(xa, i, za, withRecScratch(qa, recScratch(qa) + f32(t))); }
      if (v < 0.0) { colPut(xb, j, zb, withRecScratch(qb, recScratch(qb) + f32(t))); }
    }
    if (recTop(qa) < recTop(qb)) { if (recLast(qa)) { break; } i = i + 1; }
    else { if (recLast(qb)) { break; } j = j + 1; }
  }
  colLimit(xa, za); colLimit(xb, zb);
  // the floating faces first, while every floor is where the flux stage saw it; then the rest bottom up (one
  // colSends call site: Metal inlines each call)
  for (var round = 0; round < 2; round++) { colSends(xa, za, xb, zb, axis, round == 0); }
}
fn colSends(xa: i32, za: i32, xb: i32, zb: i32, axis: i32, floating: bool) {
  var i = 0; var j = 0;
  loop {
    let qa = colRec(xa, i, za); let qb = colRec(xb, j, zb);
    let floats = colFloats(qa, qb);
    var ra = qa; var rb = qb;
    if (floats == 1) { rb = colFloor(qb); }
    if (floats == 2) { ra = colFloor(qa); }
    let s0 = max(recY0(ra), recY0(rb)); let s1 = min(recTop(ra), recTop(rb));
    if (s0 < s1 && !recFalling(ra) && !recFalling(rb) && (floats != 0) == floating) {
      let t = colDemandAt(xa, s0, za, axis);
      let v = laneOf(colCell(xa, s0, za), axis);
      let head = colSentHeadAt(xa, s0, za, axis);
      // the lane's sender and receiver; a floating layer pours onto the denser surface (into the receiver's
      // cells at the face rows), the rest as colSend sends it. One colPour and one colTransfer for both
      // directions: Metal inlines each call, and a copy a direction made this pass slow to compile cold.
      if (t != 0u && (v > 0.0 || v < 0.0)) {
        let plus = v > 0.0;
        let xs = select(xb, xa, plus); let zs = select(zb, za, plus); let is = select(j, i, plus);
        let xd = select(xa, xb, plus); let zd = select(za, zb, plus); let id = select(i, j, plus);
        let n = u32(floor(f32(t) * recScratch(select(qb, qa, plus))));
        if (floating || colOver(colRec(xd, id, zd), s0)) { colPour(xs, zs, is, xd, zd, s0, s1, axis, select(-1.0, 1.0, plus), abs(v), head, n); }
        else { colTransfer(xs, zs, is, xd, zd, id, n); }
      }
    }
    // (transfers change a record's mass and end, never its y0, top or last flag)
    if (recTop(qa) < recTop(qb)) { if (recLast(qa)) { break; } i = i + 1; }
    else { if (recLast(qb)) { break; } j = j + 1; }
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

// ---- radial gravity (RADIAL above). Three stages a tick on the column passes' threads and ownership:
//   v2runs         every face's demand from the frozen cells (reads only; writes its words): colRadRuns
//   v2pairs 0      each column's y faces, its own cells only: colRadPairs
//   v2pairs 1      the x and z faces of the pairs a thread owns, as the transfers: colRadPairs
// A face's demand word lives in the liquidScratch slot of its -side cell, where the runs keep their records
// under vertical gravity (none exist under radial; support's air byte in .x is untouched): .y its +x face,
// .z its +y face, .w its +z face. The quanta in the low 29 bits, RAD_BACK when the +side gives, and each
// side's cover when it gives this tick (sideways, or packing down).
fn radSetDemand(x: i32, y: i32, z: i32, axis: i32, n: f32, coveredMinus: bool, coveredPlus: bool) {
  let s = slotOf(vec3i(x, y, z));
  let w = min(u32(abs(n)), RAD_DEMAND_MAX) | select(0u, RAD_BACK, n < 0.0) | select(0u, RAD_COVERED_MINUS, coveredMinus) | select(0u, RAD_COVERED_PLUS, coveredPlus);
  if (axis == 0) { liquidScratch[s].y = w; } else if (axis == 1) { liquidScratch[s].z = w; } else { liquidScratch[s].w = w; }
}
fn radWord(x: i32, y: i32, z: i32, axis: i32) -> u32 {
  let r = liquidScratch[slotOf(vec3i(x, y, z))];
  if (axis == 0) { return r.y; }
  if (axis == 1) { return r.z; }
  return r.w;
}
fn radDemandAt(x: i32, y: i32, z: i32, axis: i32) -> f32 { let w = radWord(x, y, z, axis); let n = f32(w & RAD_DEMAND_MAX); return select(n, -n, (w & RAD_BACK) != 0u); }
fn radCoveredAt(x: i32, y: i32, z: i32, axis: i32, plus: bool) -> bool { return (radWord(x, y, z, axis) & select(RAD_COVERED_MINUS, RAD_COVERED_PLUS, plus)) != 0u; }
fn colRadInside(x: i32, y: i32, z: i32) -> bool { return x >= 0 && y >= 0 && z >= 0 && x < NX && y < NY && z < NZ; }
// at most reference gravity's rate: past it the relaxation would overshoot
fn colRadPull() -> f32 { return min(P.gravity / COL_G_MS2, 1.0); }
// the dominant axis of the pull at a cell's centre (mDown's rule: its ties go to y, then x), and its sign
// along it (+1 toward +axis; 0 with no gravity, as mDown's zero vector)
fn colRadAxis(x: i32, y: i32, z: i32) -> i32 {
  let ax = abs(0.5 * f32(NX) - (f32(x) + 0.5)); let ay = abs(0.5 * f32(NY) - (f32(y) + 0.5)); let az = abs(0.5 * f32(NZ) - (f32(z) + 0.5));
  var axis = 1;
  if (ax > ay && ax >= az) { axis = 0; }
  if (az > ay && az > ax) { axis = 2; }
  return axis;
}
fn colRadSign(x: i32, y: i32, z: i32, axis: i32) -> i32 {
  if (P.gravity <= 0.0) { return 0; }
  var d = 0.5 * f32(NY) - (f32(y) + 0.5);
  if (axis == 0) { d = 0.5 * f32(NX) - (f32(x) + 0.5); }
  if (axis == 2) { d = 0.5 * f32(NZ) - (f32(z) + 0.5); }
  if (d > 0.0) { return 1; }
  if (d < 0.0) { return -1; }
  return 0;
}
// the fill (quanta) of the same liquid from this cell up against its pull: the column's prefix sum (colEta's),
// whatever its packing. The path need not stay in one pyramid: a head is the same along any path.
fn colRadMass(x: i32, y: i32, z: i32, axis: i32, sg: i32) -> f32 {
  let c = colCell(x, y, z);
  if (!isLiq(c)) { return 0.0; }
  if (sg == 0) { return f32(cFill(c)); }
  let id = cid(c); let sub = liquidSub(c);
  var m = 0.0;
  var px = x; var py = y; var pz = z;
  loop {
    if (!colRadInside(px, py, pz)) { break; }
    let q = colCell(px, py, pz);
    if (!isLiq(q) || cid(q) != id || liquidSub(q) != sub) { break; }
    m = m + f32(cFill(q));
    if (axis == 0) { px = px - sg; }
    if (axis == 1) { py = py - sg; }
    if (axis == 2) { pz = pz - sg; }
  }
  return m;
}
// the head (cells) of a cell holding m over its bottom face: the potential where that much liquid stands, its
// distance to the centre. A dry cell's (m = 0) is its bottom face's.
fn colRadHead(x: i32, y: i32, z: i32, axis: i32, sg: i32, m: f32) -> f32 {
  let up = f32(-sg) * (m / COL_FULL - 0.5);
  var px = f32(x) + 0.5; var py = f32(y) + 0.5; var pz = f32(z) + 0.5;
  if (axis == 0) { px = px + up; }
  if (axis == 1) { py = py + up; }
  if (axis == 2) { pz = pz + up; }
  let dx = px - 0.5 * f32(NX); let dy = py - 0.5 * f32(NY); let dz = pz - 0.5 * f32(NZ);
  return sqrt(dx * dx + dy * dy + dz * dz);
}
// the cell one step along (below) or against (above) a cell's pull is liquid, or the same liquid as it
fn colRadWetBelow(x: i32, y: i32, z: i32, axis: i32, sg: i32) -> bool {
  var px = x; var py = y; var pz = z;
  if (axis == 0) { px = x + sg; }
  if (axis == 1) { py = y + sg; }
  if (axis == 2) { pz = z + sg; }
  if (sg == 0 || !colRadInside(px, py, pz)) { return false; }
  return isLiq(colCell(px, py, pz));
}
fn colRadCovered(x: i32, y: i32, z: i32) -> bool {
  let axis = colRadAxis(x, y, z); let sg = colRadSign(x, y, z, axis);
  var px = x; var py = y; var pz = z;
  if (axis == 0) { px = x - sg; }
  if (axis == 1) { py = y - sg; }
  if (axis == 2) { pz = z - sg; }
  if (sg == 0 || !colRadInside(px, py, pz)) { return false; }
  let c = colCell(x, y, z);
  if (!isLiq(c)) { return false; }
  let q = colCell(px, py, pz);
  return isLiq(q) && cid(q) == cid(c) && liquidSub(q) == liquidSub(c);
}
// The demand (quanta, + from the cell to its +axis neighbour) of a face across both sides' pulls. Only a wet
// side gives, into air or the same liquid with room (an interior face carries nothing and reads no column);
// a face along either side's pull packs instead. As colFlux: lean-sim's dead band (DEADQ quanta), and the dry
// tolerance (a liquid thinner than FILM spreads onto no dry ground).
fn colRadDemand(x: i32, y: i32, z: i32, axis: i32) -> f32 {
  var bx = x; var by = y; var bz = z;
  if (axis == 0) { bx = x + 1; }
  if (axis == 1) { by = y + 1; }
  if (axis == 2) { bz = z + 1; }
  if (!colRadInside(bx, by, bz)) { return 0.0; }
  let ca = colCell(x, y, z); let cb = colCell(bx, by, bz);
  let wa = isLiq(ca); let wb = isLiq(cb);
  if (!wa && !wb) { return 0.0; }
  if ((!wa && clsOf(ca) != C_AIR) || (!wb && clsOf(cb) != C_AIR)) { return 0.0; }
  if (wa && wb && (cid(ca) != cid(cb) || liquidSub(ca) != liquidSub(cb))) { return 0.0; }
  if (wa && wb && cFill(ca) >= FULLU && cFill(cb) >= FULLU) { return 0.0; }
  let aa = colRadAxis(x, y, z); let ab = colRadAxis(bx, by, bz);
  if (aa == axis || ab == axis) { return 0.0; }
  let sa = colRadSign(x, y, z, aa); let sb = colRadSign(bx, by, bz, ab);
  // each side's mass over it and head, in one loop (one inlined copy of each: Metal's compile time)
  var ma = 0.0; var mb = 0.0; var drive = 0.0;
  for (var side = 0; side < 2; side++) {
    var px = x; var py = y; var pz = z; var pa = aa; var ps = sa;
    if (side == 1) { px = bx; py = by; pz = bz; pa = ab; ps = sb; }
    let m = colRadMass(px, py, pz, pa, ps);
    let h = colRadHead(px, py, pz, pa, ps, m);
    if (side == 0) { ma = m; drive = drive + h; } else { mb = m; drive = drive - h; }
  }
  var liq = cid(ca);
  if (!wa) { liq = cid(cb); }
  if (abs(drive) < COL_DEADQ / COL_FULL) { return 0.0; }
  if (drive > 0.0 && (!wa || cFill(cb) >= FULLU)) { return 0.0; }
  if (drive < 0.0 && (!wb || cFill(ca) >= FULLU)) { return 0.0; }
  if (drive > 0.0 && !wb && ma < COL_FILM && !colRadWetBelow(bx, by, bz, ab, sb)) { return 0.0; }
  if (drive < 0.0 && !wa && mb < COL_FILM && !colRadWetBelow(x, y, z, aa, sa)) { return 0.0; }
  let n = floor(RAD_RATE * colRadPull() * abs(drive) * COL_FULL);
  if (drive < 0.0) { return -n; }
  return n;
}
// a face's demand into its word, with the cover of each side that gives across it (sideways, or as the upper
// cell of a face along its pull): read here, while every cell is frozen, since a transfer stage owns only the
// face's two cells. A face that will move keeps both awake.
fn colRadNote(x: i32, y: i32, z: i32, axis: i32) {
  var bx = x; var by = y; var bz = z;
  if (axis == 0) { bx = x + 1; }
  if (axis == 1) { by = y + 1; }
  if (axis == 2) { bz = z + 1; }
  var n = 0.0; var coveredA = false; var coveredB = false;
  if (colRadInside(bx, by, bz)) {
    n = colRadDemand(x, y, z, axis);
    let aa = colRadAxis(x, y, z); let ab = colRadAxis(bx, by, bz);
    if (n > 0.0 || (aa == axis && colRadSign(x, y, z, aa) > 0)) { coveredA = colRadCovered(x, y, z); }
    if (n < 0.0 || (ab == axis && colRadSign(bx, by, bz, ab) < 0)) { coveredB = colRadCovered(bx, by, bz); }
    if (n != 0.0) { colBusy(x, y, z); colBusy(bx, by, bz); }
  }
  radSetDemand(x, y, z, axis, n, coveredA, coveredB);
}
// v2runs: the demands of the column's +faces, and of a sleeping -side neighbour's face into it (the pair
// stages own that face the same way)
fn colRadRuns(x: i32, z: i32) {
  for (var y = 0; y < NY; y++) {
    // its own three +faces, then the faces into it from a sleeping -side neighbour along x and along z (one
    // call site: one inlined copy)
    for (var k = 0; k < 5; k++) {
      var fx = x; var fz = z; var axis = k;
      if (k == 3) { fx = x - 1; axis = 0; }
      if (k == 4) { fz = z - 1; axis = 2; }
      if (k < 3 || (fx >= 0 && fz >= 0 && !colAwake(fx, fz))) { colRadNote(fx, y, fz, axis); }
    }
  }
}
fn colRadTowardPlus(x: i32, y: i32, z: i32) -> bool { let a = colRadAxis(x, y, z); return a == 1 && colRadSign(x, y, z, a) > 0; }
// v2pairs' radial stages, one colRadFace call site (each inlined copy is Metal compile time). Stage 0: the
// column's foam (colScan's, which does not run), then its y faces: those that pack toward -y bottom up, so a
// hole rises through a stack in one sweep, then those toward +y top down (2 (NY - 1) steps). Stage 1: the x or z
// faces of the pair this thread owns along P.pairAxis (v2PairsKernel's ownership, without loop edges), bottom up.
fn colRadPairs(x: i32, z: i32) {
  var fx = x; var fz = z; var axis = 1; var faces = 0;
  if (P.pairStage == 0u) {
    for (var y = 0; y < NY; y++) { foamDecay(x, y, z); }
    faces = 2 * (NY - 1);
  } else {
    axis = i32(P.pairAxis);
    var own = z; var xn = x; var zn = z + 1; var xp = x; var zp = z - 1;
    if (axis == 0) { own = x; xn = x + 1; zn = z; xp = x - 1; zp = z; }
    let odd = floor(f32(own) * 0.5) * 2.0 != f32(own);
    if (select(0u, 1u, odd) == P.pairParity) {
      if (xn < NX && zn < NZ) { faces = NY; }
    } else if (xp >= 0 && zp >= 0 && !colAwake(xp, zp)) { fx = xp; fz = zp; faces = NY; }
  }
  for (var k = 0; k < faces; k++) {
    var y = k; var go = true;
    if (P.pairStage == 0u) {
      var plus = false;
      if (k >= NY - 1) { y = 2 * (NY - 1) - 1 - k; plus = true; }
      go = colRadTowardPlus(x, y, z) == plus;
    }
    if (go) { colRadFace(fx, y, fz, axis); }
  }
}
// a face at its stage: along a side's pull it packs, across both it carries its demand (never more than the
// giver holds, less RAD_KEEP when covered, nor more than the receiver has room for). One move a face, from
// one colMove call site (each inlined copy is Metal compile time).
fn colRadFace(x: i32, y: i32, z: i32, axis: i32) {
  var bx = x; var by = y; var bz = z;
  if (axis == 0) { bx = x + 1; }
  if (axis == 1) { by = y + 1; }
  if (axis == 2) { bz = z + 1; }
  if (!colRadInside(bx, by, bz)) { return; }
  let aa = colRadAxis(x, y, z); let ab = colRadAxis(bx, by, bz);
  let ca = colCell(x, y, z); let cb = colCell(bx, by, bz);
  // n quanta from the -side to the +side (n > 0) or back (n < 0)
  var n = 0; var agitate = false;
  if (aa == axis || ab == axis) {
    if (aa == axis && colRadSign(x, y, z, aa) > 0) { n = colRadPackAmount(ca, cb, radCoveredAt(x, y, z, axis, false)); }
    else if (ab == axis && colRadSign(bx, by, bz, ab) < 0) { n = 0 - colRadPackAmount(cb, ca, radCoveredAt(x, y, z, axis, true)); }
  } else {
    let t = radDemandAt(x, y, z, axis);
    agitate = true;
    if (t > 0.0) { n = colRadSendAmount(ca, cb, t, radCoveredAt(x, y, z, axis, false)); }
    if (t < 0.0) { n = 0 - colRadSendAmount(cb, ca, 0.0 - t, radCoveredAt(x, y, z, axis, true)); }
  }
  if (n == 0) { return; }
  var gx = x; var gy = y; var gz = z; var rx = bx; var ry = by; var rz = bz;
  if (n < 0) { gx = bx; gy = by; gz = bz; rx = x; ry = y; rz = z; }
  colMove(gx, gy, gz, rx, ry, rz, u32(abs(n)), agitate);
}
// Packing between an upper cell and the lower one along its pull: + the upper's fill down into the lower's
// room, air or the same liquid (less RAD_KEEP when covered, so a hole climbs a stack and never opens under it;
// one the face's other stages opened this tick closes from above); - a lower cell's surplus over FULL (left
// compressed by vertical gravity's covered runs) up. (Liquid over open air is radialDrip's first: it flies.)
fn colRadPackAmount(cu: vec4u, cl: vec4u, covered: bool) -> i32 {
  if (isLiq(cu) && (clsOf(cl) == C_AIR || (isLiq(cl) && cFill(cl) < FULLU))) {
    var have = cFill(cu);
    if (covered) { have = have - min(have, RAD_KEEP); }
    var room = FULLU;
    if (isLiq(cl)) { room = FULLU - cFill(cl); }
    return i32(min(have, room));
  }
  if (isLiq(cl) && cFill(cl) > FULLU && (clsOf(cu) == C_AIR || (isLiq(cu) && cFill(cu) < FULLU))) {
    var space = FULLU;
    if (isLiq(cu)) { space = FULLU - cFill(cu); }
    return 0 - i32(min(cFill(cl) - FULLU, space));
  }
  return 0;
}
// a sideways giver's share of its demand: what it holds (less RAD_KEEP when covered), within the room it pours into
fn colRadSendAmount(cs: vec4u, cd: vec4u, t: f32, covered: bool) -> i32 {
  if (!isLiq(cs)) { return 0; }
  var have = cFill(cs);
  if (covered) { have = have - min(have, RAD_KEEP); }
  var room = FULLU;
  if (isLiq(cd)) { room = FULLU - min(cFill(cd), FULLU); }
  return i32(min(u32(t), min(have, room)));
}
// the column one step along side (0 +x, 1 -x, 2 +z, 3 -z: face6's order) from (x, z), past a loop edge
// wrapped (mEdge), as (x, z); and whether it is in the grid
fn colNeighbour(x: i32, z: i32, side: i32) -> vec2i { return mEdge(vec3i(x, 0, z) + face6(select(side, side + 2, side >= 2))).xz; }
fn colInside(n: vec2i) -> bool { return n.x >= 0 && n.y >= 0 && n.x < NX && n.y < NZ; }
// v2runs: settle the column's runs and write its domain records, then the records of each sleeping neighbour
// (read only: the pair stages' halo; identical concurrent builds write equal words). One colScan call site.
fn colRunsColumn(x: i32, z: i32) {
  // radial gravity has no runs: the column's face demands instead (RADIAL)
  if (P.gravMode == 2u) { colRadRuns(x, z); return; }
  for (var side = -1; side < 4; side++) {
    var cx = x; var cz = z;
    if (side >= 0) {
      let n = colNeighbour(x, z, side);
      if (!colInside(n) || colAwake(n.x, n.y)) { continue; }
      cx = n.x; cz = n.y;
    }
    colScan(cx, cz, side < 0);
  }
}
// v2pairs. P.pairStage even (2 s at step s): every face's flux, both axes (a face is its -side column's, or its +side's
// when the -side sleeps: one colFluxes call site); odd: the transfers of the pairs along P.pairAxis (0 or 2) whose
// -side column has parity P.pairParity (owned the same way), and this column's faces to the void past an open side.
fn colPairsColumn(x: i32, z: i32) {
  // (radial gravity relaxes once a tick: its RAD_RATE is a tick's; the later steps' stages are 2 and 3)
  if (P.gravMode == 2u) { if (P.pairStage < 2u) { colRadPairs(x, z); } return; }
  if (floor(f32(P.pairStage) * 0.5) * 2.0 == f32(P.pairStage)) {
    for (var axis = 0; axis <= 2; axis += 2) {
      let next = colNeighbour(x, z, axis); let prev = colNeighbour(x, z, axis + 1);
      if (colInside(next)) { colFluxes(x, z, next.x, next.y, axis); }
      if (colInside(prev) && !colAwake(prev.x, prev.y)) { colFluxes(prev.x, prev.y, x, z, axis); }
    }
    return;
  }
  let axis = i32(P.pairAxis);
  let side = select(2, 0, axis == 0);
  let next = colNeighbour(x, z, side); let prev = colNeighbour(x, z, side + 1);
  // the pair this thread owns: with the next column, or with a sleeping previous one; one colTransfers
  // call for both (Metal inlines it whole at each call: cold compile, docs/webgpu.md B5)
  let own = select(z, x, axis == 0);
  let mine = select(0u, 1u, floor(f32(own) * 0.5) * 2.0 != f32(own)) == P.pairParity;
  var pair = false; var xa = x; var za = z; var xb = x; var zb = z;
  if (mine && colInside(next)) { pair = true; xb = next.x; zb = next.y; }
  if (!mine && colInside(prev) && !colAwake(prev.x, prev.y)) { pair = true; xa = prev.x; za = prev.y; }
  if (pair) { colTransfers(xa, za, xb, zb, axis); }
  // a side of the grid on this axis is open: this thread owns the column, so its face to the void too (one
  // colEdges call site; both sides open, both faces)
  var edges = 0;
  if (mine && P.edge == 1u && !colInside(next)) { edges = edges + 1; }
  if (mine && P.edge == 1u && !colInside(prev)) { edges = edges + 1; }
  for (var e = 0; e < edges; e++) { colEdges(x, z); }
}
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
 * sleeping neighbours (columns.js colRunsColumn). */
export const v2RunsKernel = (head, MAIN) => /* wgsl */ `
${head}
${columnWaterWGSL}
${MAIN} {
${COLUMN_THREAD}
  colRunsColumn(x, z);
}
`;

/** v2pairs: the flux stage, or a parity of an axis's transfers (columns.js colPairsColumn). */
export const v2PairsKernel = (head, MAIN) => /* wgsl */ `
${head}
${columnWaterWGSL}
${MAIN} {
${COLUMN_THREAD}
  colPairsColumn(x, z);
}
`;

/** A tick's pair stages, [axis, stage, parity]: COLUMN.SUB steps of the fluxes (stage 2 s) and the transfers
 * (2 s + 1), the axes alternating each step. The parities keep one order: alternating them too leaves the U-tube's
 * covered channel trading single quanta past 10 s. */
export function pairOrder(tick) {
  const out = [];
  for (let s = 0; s < COLUMN.SUB; s++) {
    const axes = (tick * COLUMN.SUB + s) & 1 ? [2, 0] : [0, 2];
    out.push([0, 2 * s, 0], ...axes.flatMap(axis => [[axis, 2 * s + 1, 0], [axis, 2 * s + 1, 1]]));
  }
  return out;
}
