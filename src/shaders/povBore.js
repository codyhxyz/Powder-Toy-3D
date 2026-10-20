import { prelude, editKernelWGSL, EDIT_FIELDS, LAYOUT, STATE_OPTS, STAGE, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { STRIKE } from './povTrace.js';
import { RING_LAYOUT, ringWGSL } from './povBody.js';
import { ddaWalkWGSL } from './dda.js';
import { glf as lit, consts } from '../glsl.js';
import { FULL } from '../v2/layout.js';

// GPU work for the two boring weapons: the burrower's drill and the laser
// cannon (src/pov/tools/burrower.tool.js, laser.tool.js), on WebGPU
// (docs/webgpu.md G2, D7). Both add nothing to the world: every cell they
// touch turns into its own debris, its own vapour, or the same matter hotter.
//
// Units: grid cells, cells/step, the sim's kinetic energy units (HARD) for the
// drill, and the engine's heat (CAP · °C per cell, a water cell's CAP = 1) for
// the laser.

// ---------------------------------------------------------------- burrower
// A drill is power-limited, so it advances at its power over the work a cell
// of advance takes (Teale 1965, "The concept of specific energy in rock
// drilling": rate of penetration = P / (SE · A), the specific energy SE times
// the face's area A). The engine's hardness already is that specific energy
// (elements.js: hard ≈ UCS / 5 MPa, after Teale), and a powder or liquid
// costs what it costs a round (povTrace.js strike: DENS · STRIKE.DRAG), so
// the work of one cell of advance is the sum over the bore's face disc:
//   W = Σ HARD (breakable solids) + Σ DENS · DRAG (powder, liquid)
//   v = min(FLIGHT, POWER / W)
// With POWER 9000 and a 3.5-cell bore (≈ 38 cells a slice):
//   sand 16 → 15 cells/s, sandstone 15 → 16, wood 20 → 12, rock 30 → 8,
//   metal 60 → 4 (1.2 m/s): metal is twice as slow as rock, as its hardness says.
// A solid that can't break (WALL, CLONE) on the bore's axis stops it.
export const BURROW = {
  RADIUS: 3.5,        // cells: the bore (a 2.1 m tunnel: the 1.7 m body walks through it)
  POWER: 9000,        // sim KE units a second the drill can spend cutting
  PROBE_AHEAD: 12,    // one-cell slices of the face read back ahead of the drill
  AXIS_CORE: 1,       // cells from the axis where an unbreakable solid stops the drill
  SPOIL_SPEED: 1,     // cells/step the cuttings are thrown back along the bore (V_MAX)
  SPOIL_LIFT: 0.5,    // cells/step up the conveyor throws them at the mouth, so they land well clear of it
  APRON: 7,           // cells past the mouth the conveyor still reaches (two bore radii)
  CONVEY_PAD: 1,      // cells past the bore's radius the conveyor still reaches (grains settled on the tunnel floor)
  PATH_MAX: 64,       // points of the bore's centre line the spoil conveyor follows (PATH_STEP apart)
};
const BURROW_SPAN = Math.ceil(BURROW.RADIUS) + 1;   // cells around a slice's centre its disc can reach

const burrowConsts = `${consts('BURROW', BURROW, ['PATH_MAX', 'PROBE_AHEAD'])}
const BURROW_SPAN: i32 = ${BURROW_SPAN};
const STRIKE_DRAG: f32 = ${lit(STRIKE.DRAG)};`;

// One vec4 per slice k (BURROW.PROBE_AHEAD of them, into a ring slot): the
// face disc a cell deep, k + ½ cells ahead of head along dir.
//   (work W of the slice, unbreakable solids near the axis, the id of the
//    matter nearest the axis or −1, breakable solids in it)
// Below the floor counts as unbreakable (the engine's WALL); out through the
// sides or top is open. A workgroup per slice: each thread sums its share of
// the slice's cube in order, then the workgroup adds the shares up pairwise
// and keeps the nearest cell (ties: the first in z, y, x order, the GLSL's
// loop order), so the answer is the same every time.
export const BurrowProbeParams = uniformStruct('BurrowProbeParams', { head: 'vec3f', slot: 'u32', dir: 'vec3f' });
export const burrowProbeFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${burrowConsts}
${BurrowProbeParams.wgsl}
@group(3) @binding(1) var<uniform> P: BurrowProbeParams;
${ringWGSL()}
const SIDE: i32 = 2 * BURROW_SPAN + 1;
const NO_CELL: u32 = 0xffffffffu;
var<workgroup> sums: array<vec4f, 64>;   // (work, blocked, solids, 0)
var<workgroup> nearR: array<f32, 64>;
var<workgroup> nearAt: array<u32, 64>;   // the nearest cell's place in loop order (NO_CELL: none)
var<workgroup> nearId: array<i32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let k = wg.x;
  let c = P.head + P.dir * (f32(k) + 0.5);
  let ci = vec3i(floor(c));
  var s = vec4f(0.0);
  var best = 1e9;
  var bestAt = NO_CELL;
  var bestId = -1;
  for (var n = i32(li); n < SIDE * SIDE * SIDE; n += 64) {
    let q = ci + vec3i(n % SIDE, (n / SIDE) % SIDE, n / (SIDE * SIDE)) - BURROW_SPAN;
    let d = vec3f(q) + 0.5 - c;
    let along = dot(d, P.dir);
    if (abs(along) > 0.5) { continue; }
    let r = length(d - along * P.dir);
    if (r > BURROW_RADIUS) { continue; }
    if (!inGrid(q)) {
      if (q.y < 0 && r < BURROW_AXIS_CORE) { s.y += 1.0; }
      continue;
    }
    let id = eid(fetchA(q));
    let kind = KIND(id);
    if (kind == K_SOLID) {
      if (BREAKINTO(id) < 0) {
        if (r < BURROW_AXIS_CORE) { s.y += 1.0; }
        continue;
      }
      s.x += HARD(id);
      s.z += 1.0;
    } else if (kind == K_POWDER || kind == K_LIQUID) {
      s.x += DENS(id) * STRIKE_DRAG;
    } else {
      continue;
    }
    if (r < best) { best = r; bestAt = u32(n); bestId = id; }   // (n grows: the first of equals stays)
  }
  sums[li] = s;
  nearR[li] = best;
  nearAt[li] = bestAt;
  nearId[li] = bestId;
  for (var h = 32u; h > 0u; h >>= 1u) {
    workgroupBarrier();
    if (li < h) {
      sums[li] += sums[li + h];
      let r = nearR[li + h];
      if (r < nearR[li] || (r == nearR[li] && nearAt[li + h] < nearAt[li])) {
        nearR[li] = r; nearAt[li] = nearAt[li + h]; nearId[li] = nearId[li + h];
      }
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    let t = sums[0];
    ringOut[P.slot * u32(BURROW_PROBE_AHEAD) + k] = vec4f(t.x, t.y, f32(nearId[0]), t.z);
  }
}
`;
export const BURROW_PROBE_DISPATCH = [BURROW.PROBE_AHEAD, 1, 1];

// The drill this frame, an edit over the box of everything it may change.
// Inside the capsule round the nose's stretch nose0 → nose1 (radius RADIUS), while
// cut is 1:
//   breakable solid: becomes its debris in place (only the element changes:
//     the strike's rule), thrown back along the bore at SPOIL_SPEED
//   powder or liquid: thrown back the same way
//   anything else: left as it is
// Along the bore behind it (the centre line path, mouth first), loose
// cuttings (powders) are carried back toward the mouth at SPOIL_SPEED: a
// tunnel-boring machine's muck conveyor, which runs the tunnel's length. In
// its first stretch and APRON cells past the mouth it throws them up and out
// (SPOIL_LIFT), a stacker's arc, so they heap up well clear of the mouth
// instead of damming it (a heap at the angle of repose right at the mouth
// fills it: tested). The tunnel stays open to walk through; nothing is added
// or taken away.
export const BurrowParams = uniformStruct('BurrowParams', {
  ...EDIT_FIELDS,
  nose0: 'vec3f',     // grid cells: the nose's stretch this frame
  cut: 'u32',         // 1: the nose cuts this frame
  nose1: 'vec3f',
  pathN: 'u32',       // points in path
  dir: 'vec3f',       // unit heading
  lo: 'vec3f',        // the box of everything this edit may change (cell corners)
  hi: 'vec3f',
  path: `array<vec4f, ${BURROW.PATH_MAX}>`,   // the bore's centre line, mouth first (w 1: a point)
});
export const burrowWGSL = /* wgsl */ `
${burrowConsts}
// distance from p to the segment a → b
fn segDist(p: vec3f, a: vec3f, b: vec3f) -> f32 {
  let ab = b - a;
  let l2 = dot(ab, ab);
  var t = 0.0;
  if (l2 > 0.0) { t = clamp(dot(p - a, ab) / l2, 0.0, 1.0); }
  return length(p - a - ab * t);
}

fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let pc0 = vec3f(p);
  if (any(pc0 < P.lo) || any(pc0 > P.hi)) { return; }
  let pc = pc0 + 0.5;
  let id = eid(a);
  if (isGasLike(id)) { return; }
  let kind = KIND(id);
  if (P.cut == 1u && segDist(pc, P.nose0, P.nose1) <= BURROW_RADIUS) {
    if (kind == K_SOLID) {
      let into = BREAKINTO(id);
      if (into < 0) { return; }
      (*oA).x = f32(into);
      (*oA).w = physicalCtype(id, a.w) + fract(a.w);
    }
    *oB = vec4f(-P.dir * BURROW_SPOIL_SPEED, b.w);
    return;
  }
  if (kind != K_POWDER) { return; }
  var best = BURROW_RADIUS + BURROW_CONVEY_PAD;
  var back = vec3f(0.0);
  var mouth = false;
  let n = min(P.pathN, u32(BURROW_PATH_MAX));
  for (var i = 0u; i + 1u < n; i++) {
    var a0 = P.path[i].xyz;
    let a1 = P.path[i + 1u].xyz;
    if (dot(a0 - a1, a0 - a1) <= 0.0) { continue; }
    let dir = normalize(a0 - a1);
    if (i == 0u) { a0 += dir * BURROW_APRON; }   // the first stretch reaches out past the mouth
    let d = segDist(pc, a0, a1);
    if (d < best) { best = d; back = dir; mouth = i == 0u; }
  }
  if (best < BURROW_RADIUS + BURROW_CONVEY_PAD) {
    var lift = 0.0;
    if (mouth) { lift = BURROW_SPOIL_LIFT; }
    *oB = vec4f(back * BURROW_SPOIL_SPEED + vec3f(0.0, lift, 0.0), b.w);
  }
}
`;
export const burrowFrag = (g) => editKernelWGSL(g, { update: burrowWGSL, params: BurrowParams });

// ---------------------------------------------------------------- laser
// The laser cannon: one instant beam along the aim, as Halo's Spartan Laser.
// A laser delivers its energy as heat, so its reach follows the lumped heat
// balance of laser drilling (Steen & Mazumder, "Laser Material Processing",
// the energy balance of cutting and drilling: the energy to remove a volume
// is ρ(c·ΔT + L)): the beam walks its axis from the muzzle, and every cell it
// enters costs the heat that takes the core's slice of that matter to VAPOR_T,
//   cost = CAP · (VAPOR_T − T) · π · CORE_RADIUS²
// in the engine's own heat units (latent heats left out). Air and gas cost
// nothing. ENERGY 2.22 M through a CORE_RADIUS 2 core gives (from 20 °C):
//   rock / glass (CAP 0.5)  ≈ 119 cells (36 m)    metal (0.85) ≈ 70 cells (21 m)
//   wood (0.3) ≈ 198          water (1.0) ≈ 59
// A solid that neither breaks, melts nor burns (WALL, CLONE) stops it, as does
// the floor; the beam is at most LENGTH long.
//
// What it does where it reaches, by distance r from the bore (the axis up to
// where the beam stopped; past that, from the point it stopped, so the heated
// end of the hole is round, as the bottom of a laser-drilled hole is. Cut flat
// there instead, a surface met at a slant took only the near half of the
// ring: a crescent):
//   core (r ≤ CORE_RADIUS): vaporised. Water, ice and snow become STEAM, what
//     burns becomes FIRE, everything else SMOKE (its vapour), all at VAPOR_T,
//     blown back out of the hole at PLUME_SPEED. Gas in the core is heated to VAPOR_T.
//   rim (r ≤ RIM_RADIUS): heated to RIM_T at the core's edge, falling to
//     RIM_EDGE_T at the rim's, and the engine does the rest by its own rules:
//     metal (1500 °C), glass and stone melt into lava, water boils, wood and
//     coal catch fire, ice melts. A solid that can't melt but whose debris can
//     (rock, limestone → stone) spalls into its debris first: thermal
//     spallation, how flame-jet drills break hard rock (Rauenzahn & Tester
//     1989, "Rock failure mechanisms of flame-jet thermal spallation drilling").
//     The stone then melts at 1200 °C: rock round the tunnel turns to lava.
//     The rim's heat isn't charged to ENERGY. It is hot and thick because the
//     engine's conduction is fast: a rim of 2400→1300 °C, 3 cells out, cooled
//     below stone's melt in under a second (tested: 21 lava cells, now ~300).
//     A solid the beam can't touch is heated but not vaporised (the spot it
//     stops on glows), and the heat doesn't pass it: what lies behind it, seen
//     from the bore, stays as it is (WALL insulates: elements.js).
// Every power number is here, so the gun can be made weaker in one place.
export const LASER = {
  ENERGY: 2.22e6,     // heat units (CAP · °C) the beam delivers: see the reaches above
  CORE_RADIUS: 2,     // cells vaporised round the axis (a 1.2 m bore: Halo's beam is fat)
  RIM_RADIUS: 5,      // cells heated round the axis (the tunnel's wall)
  LENGTH: 192,        // cells, the longest beam (58 m)
  VAPOR_T: 3000,      // °C the core's vapour is made at (iron boils at 2862, basalt about 2900)
  RIM_T: 4500,        // °C at the core's edge
  RIM_EDGE_T: 1600,   // °C at the rim's edge (over stone's 1200 °C and metal's 1500 °C melt)
  PLUME_SPEED: 0.3,   // cells/step the vapour leaves back along the beam (the ablation plume)
  DAMAGE: 2,          // health taken from a body in the beam (a full health and a full shield)
  SHADOW_STEP: 0.25,  // cells between the looks along the line from the bore to a rim cell for a solid it can't touch
};
LASER.CORE_AREA = Math.PI * LASER.CORE_RADIUS ** 2;   // cells in the core's slice
LASER.STEPS_MAX = Math.ceil(LASER.LENGTH * Math.sqrt(3)) + 2;   // DDA steps a LENGTH walk can take
LASER.SHADOW_N = Math.ceil(LASER.RIM_RADIUS / LASER.SHADOW_STEP) + 1;   // looks along the longest such line

// The shot's numbers: where it leaves the body and the unit aim (grid
// cells), and the ring slot the reach kernel answers the CPU in.
export const LaserParams = uniformStruct('LaserParams', { muzzle: 'vec3f', slot: 'u32', dir: 'vec3f' });

// (in parts, so V2's native beam, src/v2/interactions.js povLaser, runs the same rule under its own params)
const laserConstsWGSL = consts('LASER', LASER, ['STEPS_MAX', 'SHADOW_N']);
const laserBeamWGSL = /* wgsl */ `// The shot: how far the beam got (cells from the muzzle), what stopped it (-1 if
// it ran out of energy or length), and the box the apply runs over (grid
// cells, inclusive, clipped to the grid; empty: lo > hi). The reach kernel
// writes it, the apply reads it (docs/webgpu.md G2).
struct LaserBeam { lo: vec3i, reach: f32, hi: vec3i, stopId: i32 }

// matter the beam can't touch: it neither breaks, melts nor burns
fn laserProof(id: i32) -> bool { return KIND(id) == K_SOLID && BREAKINTO(id) < 0 && MELT(id) <= 0.0 && IGNITE(id) <= 0.0; }`;
const laserWGSL = /* wgsl */ `
${laserConstsWGSL}
${LaserParams.wgsl}
@group(3) @binding(1) var<uniform> P: LaserParams;
${laserBeamWGSL}
`;

// group 2 of the reach kernel: the shot (written), the apply's indirect args
// (written: a separate buffer, as B6 wants of an indirect dispatch's args),
// the ring; of the apply: the shot (read)
export const LASER_REACH_LAYOUT = [
  { binding: 0, buffer: { type: 'storage' } },
  { binding: 1, buffer: { type: 'storage' } },
  { binding: 2, buffer: { type: 'storage' } },
];
export const LASER_APPLY_LAYOUT = [{ binding: 0, buffer: { type: 'read-only-storage' } }];
export const LASER_BEAM_BYTES = 32;   // LaserBeam
export const LASER_REACH_BYTES = 16;  // the ring's answer: (reach, stopId, 0, 1)

// Under V2 (native: the reach over V2's own cells, src/pov/gpu.js laser) a liquid cell holds its
// fill's share of a full cell's matter (src/v2/layout.js FULL: a thin film a fraction, a pressed
// cell up to MAX_FILL), so the heat that takes it to VAPOR_T, the cost above, is that share of
// V1's full cell's: "every cell it enters costs the heat that takes the core's slice of that
// matter to VAPOR_T" (LASER). Anything else is one cell of its matter, as in V1.
const laserFillWGSL = /* wgsl */ `
fn laserFill(c: vec3i, id: i32) -> f32 {
  let core = fetchNativeCore(c);
  if (KIND(id) != K_LIQUID || all(core == vec4u(0u))) { return 1.0; }   // (a legacy read has no native core)
  return f32(core.y & 0xffffffu) / ${lit(FULL)};
}
`;

// The reach kernel: one thread walks the beam's axis from the muzzle, every
// cell it enters costing the heat that takes the core's slice of it to VAPOR_T
// (see LASER), writes how far it got and the apply's box and dispatch size,
// and answers the CPU through the ring: its reach lands there 1–3 frames
// later (the damage, the beam's look, lastShot), so nothing waits for it.
export const laserReachFrag = (g, native = false) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${ddaWalkWGSL}
${laserWGSL}${native ? laserFillWGSL : ''}
@group(2) @binding(0) var<storage, read_write> beam: LaserBeam;
@group(2) @binding(1) var<storage, read_write> beamArgs: array<u32, 3>;
@group(2) @binding(2) var<storage, read_write> ringOut: array<vec4f>;   // the result ring (B7)

// How far along the axis the beam gets (cells from the muzzle), and what stopped it.
fn laserReach(stopId: ptr<function, i32>) -> f32 {
  *stopId = -1;
  let rd = safeDir(P.dir);
  var istp: vec3i;
  var tDelta: vec3f;
  var tMax: vec3f;
  var c = vec3i(floor(P.muzzle));
  ddaInit(P.muzzle, rd, c, &istp, &tDelta, &tMax);
  var E = LASER_ENERGY;
  var tEnter = 0.0;
  var entered = false;
  for (var k = 0; k < LASER_STEPS_MAX; k++) {
    if (tEnter >= LASER_LENGTH) { return LASER_LENGTH; }
    if (!inGrid(c)) {
      if (c.y < 0) { *stopId = E_WALL; return tEnter; }   // the floor
      if (entered) { return LASER_LENGTH; }   // out of the box (a ray never comes back into it): nothing more to touch
    } else {
      entered = true;
      let a = fetchA(c);
      let id = eid(a);
      if (!isGasLike(id)) {
        if (laserProof(id)) { *stopId = id; return tEnter; }
        let cost = CAP(id) * max(LASER_VAPOR_T - a.y, 0.0) * LASER_CORE_AREA${native ? ' * laserFill(c, id)' : ''};
        if (E < cost) { *stopId = id; return tEnter + E / cost; }
        E -= cost;
      }
    }
    tEnter = min(tMax.x, min(tMax.y, tMax.z));
    ddaStep(istp, tDelta, &c, &tMax);
  }
  return min(tEnter, LASER_LENGTH);
}

@compute @workgroup_size(1)
fn main() {
  var stopId: i32;
  let reach = laserReach(&stopId);
  // the cells the beam may change: its axis to where it stopped, padded by the rim (the GLSL's uLo, uHi)
  let end = P.muzzle + P.dir * reach;
  let pad = LASER_RIM_RADIUS + 1.0;
  let lo = max(vec3i(floor(min(P.muzzle, end) - pad)), vec3i(0));
  let hi = min(vec3i(floor(max(P.muzzle, end) + pad)), vec3i(NX, NY, NZ) - 1);
  beam = LaserBeam(lo, reach, hi, stopId);
  // a workgroup per brick of the box, folded (B5)
  var n = 0u;
  if (all(lo <= hi)) {
    let nb = vec3u((hi >> vec3u(2u)) - (lo >> vec3u(2u)) + 1);
    n = nb.x * nb.y * nb.z;
  }
  let y = max(1u, (n + 65534u) / 65535u);
  beamArgs[0] = (n + y - 1u) / y;
  beamArgs[1] = y;
  beamArgs[2] = 1u;
  ringOut[P.slot] = vec4f(reach, f32(stopId), 0.0, 1.0);
}
`;

// The beam's rule on one cell (V1's apply below; V2's native beam, laserNativeWGSL, runs it too).
const laserRuleWGSL = /* wgsl */ `// Whether a solid the beam can't touch stands between the bore's point q and
// the centre pc of cell p (p itself doesn't count): the heat doesn't get past it.
fn laserShadowed(p: vec3i, q: vec3f, pc: vec3f) -> bool {
  let v = pc - q;
  let n = i32(ceil(length(v) / LASER_SHADOW_STEP));
  for (var i = 1; i < LASER_SHADOW_N; i++) {
    if (i >= n) { break; }
    let c = vec3i(floor(q + v * (f32(i) / f32(n))));
    if (all(c == p) || !inGrid(c)) { continue; }
    if (laserProof(eid(fetchA(c)))) { return true; }
  }
  return false;
}

fn laser(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let pc = vec3f(p);
  let d = pc + 0.5 - P.muzzle;
  let along = dot(d, P.dir);
  if (along < 0.0 || along > LASER_LENGTH + LASER_RIM_RADIUS) { return; }
  var r = length(d - along * P.dir);
  if (r > LASER_RIM_RADIUS) { return; }
  let reach = beam.reach;
  // past where it stopped, r is from that point (the hole's round end); a beam that didn't stop just ends
  let past = along > reach;
  if (past) {
    if (reach >= LASER_LENGTH) { return; }
    r = length(d - reach * P.dir);
    if (r > LASER_RIM_RADIUS) { return; }
  }
  let id = eid(a);
  let proof = laserProof(id);
  if (!past && r <= LASER_CORE_RADIUS && !proof) {
    if (isGasLike(id)) { (*oA).y = max(a.y, LASER_VAPOR_T); return; }
    var into = E_SMOKE;
    if (id == E_WATER || id == E_ICE || id == E_SNOW) { into = E_STEAM; } else if (IGNITE(id) > 0.0) { into = E_FIRE; }
    *oA = vec4f(f32(into), LASER_VAPOR_T, SPAWNLIFE(into), fract(a.w));   // keeps the cell's seed, clears its ctype
    *oB = vec4f(-P.dir * LASER_PLUME_SPEED, b.w);
    return;
  }
  if (!proof && laserShadowed(p, P.muzzle + P.dir * min(along, reach), pc + 0.5)) { return; }
  let T = mix(LASER_RIM_T, LASER_RIM_EDGE_T, clamp((r - LASER_CORE_RADIUS) / (LASER_RIM_RADIUS - LASER_CORE_RADIUS), 0.0, 1.0));
  let into = BREAKINTO(id);
  if (KIND(id) == K_SOLID && MELT(id) <= 0.0 && IGNITE(id) <= 0.0 && into >= 0 && MELT(into) > 0.0) {
    (*oA).x = f32(into);
    *oB = vec4f(0.0, 0.0, 0.0, b.w);
  }
  (*oA).y = max(a.y, T);
}`;

// The beam (see LASER): an edit over the reach kernel's box, dispatched
// indirectly from its args, in place. Each cell reads its own state and the
// shot; the shadow test also reads the cells between the bore and it, but
// only for whether they are proof against the beam, and this edit never
// makes or unmakes such a cell (the core turns matter into gases, the rim
// only heats it or spalls a solid into debris that melts), so every thread
// sees the same answer whatever the others have written: exact in place.
export const laserFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RW)}
${laserWGSL}
@group(2) @binding(0) var<storage, read> beam: LaserBeam;

${laserRuleWGSL}

// editMain (shaders/common.js) over the shot's box instead of the params':
// a 64-thread workgroup per brick, threads outside the box or the grid skip,
// each changed brick marked once.
var<workgroup> editChanged: atomic<u32>;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let lo = beam.lo;
  let hi = beam.hi;
  let b0 = lo >> vec3u(2u);
  let nb = vec3u((hi >> vec3u(2u)) - b0 + 1);
  let k = foldId(wg, nwg);
  let b = b0 + vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / (nb.x * nb.y)));
  let p = b * BS + vec3i(lid);
  let inBox = k < nb.x * nb.y * nb.z && inGrid(p) && all(p >= lo) && all(p <= hi);
  if (inBox) {
    let a = fetchA(p);
    let bb = fetchB(p);
    var oA = a;
    var oB = bb;
    laser(p, a, bb, &oA, &oB);
    if (writeCell(p, a, bb, fetchF(p), oA, oB)) { atomicOr(&editChanged, 1u); }
  }
  workgroupBarrier();
  if (li == 0u && atomicLoad(&editChanged) != 0u) { markBrick(brickId(b)); }
}
`;

// V2's beam (src/v2/interactions.js povLaser): the rule above, unchanged, as native forcing on V2's
// own cells, after the same reach kernel (laserReachFrag native). The force adapter takes CPU boxes
// and the reach is only known on the GPU, and one box round the whole of a slanting beam would be
// ~134 MB of force scratch on a 128³ grid, so the beam's possible length (LENGTH + RIM_RADIUS) is
// cut into LASER_SEGMENT-long stretches of its axis, each with the box round its own stretch. A cell is
// the segment's whose stretch [segFrom, segTo) its centre projects onto, so every cell is evaluated,
// heated and renamed once however the boxes overlap; the segments share one launch allocation.
export const LASER_SEGMENT = 16;   // cells of axis a segment spans (4 bricks): ~11k cells a box on the long diagonal
export const LaserNativeParams = uniformStruct('LaserNativeParams', { muzzle: 'vec3f', segFrom: 'f32', dir: 'vec3f', segTo: 'f32' });
export const LASER_NATIVE_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
export const laserNativeWGSL = /* wgsl */ `
${laserConstsWGSL}
${laserBeamWGSL}
@group(2) @binding(0) var<storage, read> beam: LaserBeam;   // the reach kernel's shot
${laserRuleWGSL}
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let along = dot(vec3f(p) + 0.5 - P.muzzle, P.dir);
  if (along < P.segFrom || along >= P.segTo) { return; }   // another segment's cell
  laser(p, a, b, oA, oB);
}
`;

// This module's edit families, as sim.editKernel takes them (src/pov/gpu.js).
export const POV_BORE_EDITS = { povBurrow: { update: burrowWGSL, params: BurrowParams } };

/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'povBurrowProbe', kind: 'compute', code: (g) => burrowProbeFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, RING_LAYOUT], dispatch: () => BURROW_PROBE_DISPATCH },
  { name: 'povBurrow', kind: 'compute', code: (g) => burrowFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW], dispatch: (g) => fold(gridDims(g).nbricks) },
  { name: 'povLaserReach', kind: 'compute', code: (g) => laserReachFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, LASER_REACH_LAYOUT], dispatch: () => [1, 1, 1] },
  { name: 'povLaser', kind: 'compute', code: (g) => laserFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, LASER_APPLY_LAYOUT], dispatch: (g) => fold(gridDims(g).nbricks) },
];
