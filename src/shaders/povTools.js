import * as THREE from 'three';
import { prelude, editKernelWGSL, EDIT_FIELDS, LAYOUT, STATE_OPTS, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../pov/constants.js';
import { ELEMENTS, E } from '../elements.js';
import { PHYS as ENGINE } from '../physics.js';
import { consts } from '../glsl.js';

// GPU work for the POV axe, pickaxe, physgun, flamethrower, torch and rocket (src/pov/tools/*.tool.js),
// and the worm's head (src/pov/worm.js), on WebGPU (docs/webgpu.md G2, D6, D7).
//
// Each tool's write is an edit (sim.edit): one dispatch over the box its
// region fits in, in call order, writing the current state in place (every
// update reads only the cell it writes) and marking the bricks it changes, as
// the brush does (passes.js paint). Tools of one kind share one pipeline per
// grid size (a family: the blow, the flame), their tuning travelling in the
// edit's params (src/pov/gpu.js toolPass). The tools only set up inputs the
// engine already understands (which element a cell holds, its velocity); the
// move and react passes do the physics from there.
//
// Units: cells, cells/step, and the sim's kinetic energy ½·DENS·|v|² (the
// unit of ELEMENTS[].hard, HARD() in WGSL).

// Axe: one swing delivers AXE.ENERGY at the centre of a wide, shallow patch
// (an ellipsoid, flat along the swing) and less toward its rim:
//   E(r) = ENERGY · (1 − r²),   r = ellipsoid distance (0 centre, 1 rim).
// A breakable solid breaks where E ≥ its hardness. With ENERGY 24 that is
//   WOOD  (20)  r² ≤ 0.17: the hit cell and its four side neighbours
//   GLASS  (8)  r² ≤ 0.67: about 2.4 cells across, two layers deep
//   ICE    (6)  r² ≤ 0.75, PLANT (2) r² ≤ 0.92: nearly the whole patch
//   ROCK  (30), METAL (60): never.
export const AXE = {
  ENERGY: 24,        // sim KE units at the patch centre (below ROCK's 30, above WOOD's 20)
  RADIUS: 3,         // cells, half-width of the patch across the swing
  DEPTH: 1.5,        // cells, half-depth of the patch along the swing
  CHIP_MAX: 0.3,     // cells/step, fastest a chip leaves the cut (more energy goes into the fracture)
  SHOVE: 0.25,       // cells/step pushed into loose powder at the patch centre
};

// Pickaxe: the same blow (blowWGSL below) from a heavier, pointed head, so
// more energy in a patch that is narrower for its depth: it bites into rock
// where the axe bounces off. With ENERGY 52, RADIUS 2.2, DEPTH 2.5:
//   ROCK  (30)  r² ≤ 0.42: the hit cell's 3×3 face, and the cell behind it and
//                its four side neighbours behind (14 cells a swing)
//   WOOD  (20)  r² ≤ 0.62, GLASS (8) r² ≤ 0.85: a little more than that
//   METAL (60): never.
export const PICK = {
  ENERGY: 52,        // sim KE units at the patch centre (above ROCK's 30, below METAL's 60)
  RADIUS: 2.2,       // cells, half-width of the patch across the swing
  DEPTH: 2.5,        // cells, half-depth of the patch along the swing
  CHIP_MAX: 0.3,     // cells/step, fastest a chip leaves the cut
  SHOVE: 0.25,       // cells/step pushed into loose powder at the patch centre
};

// Knife: the same blow from a blade, which is for bodies (tools/knife.tool.js), not cells. Its
// energy sits just over PLANT's and ICE's hardness (6) and under GLASS's (8), in a patch no
// bigger than the struck cell: it cuts a plant or chips ice where it lands and nothing harder.
export const KNIFE = {
  ENERGY: 7,         // sim KE units at the patch centre (above PLANT and ICE's 6, below GLASS's 8)
  RADIUS: 0.8,       // cells, half-width across the stab: the struck cell
  DEPTH: 1,          // cells, half-depth along it
  CHIP_MAX: 0.3,     // cells/step, fastest a chip leaves the cut
  SHOVE: 0.1,        // cells/step pushed into loose powder: a blade parts it, it doesn't shovel
};

// Worm (pov/worm.js): the same blow from a burrower's round head as it chews
// through, every couple of cells it moves. RADIUS = DEPTH: the patch is a ball
// (Noita's worms eat a disc, CellEaterComponent radius 6 px = 3 cells, a bit
// under their 5 px hit radius; ours is that ball at the head's 2.5 cells plus a
// rim that only chips the weaker solids). With ENERGY 45:
//   ROCK  (30)  r² ≤ 0.33: a ball 2.3 cells in radius, the head's own size
//   WOOD, LIMESTONE (20) r² ≤ 0.56, GLASS (8) r² ≤ 0.82: wider
//   METAL (60), WALL, CLONE: never. The worm can't go through them (worm.js).
// PART: where the axe nudges powder along its swing, the head parts loose matter,
// powder and liquid alike, out from its axis (and its chips fly the same way),
// so it swims through sand and water and leaves its rubble behind it.
export const WORM_BITE = {
  ENERGY: 45,        // sim KE units at the head's centre (above ROCK's 30, below METAL's 60)
  RADIUS: 4,         // cells, the ball's radius
  DEPTH: 4,          // cells, the same along the way it goes
  CHIP_MAX: 0.3,     // cells/step, fastest a chip leaves the cut
  SHOVE: 0.6,        // cells/step outward on loose matter at the centre (the body coupling's push, player.js, at a run)
  PART: 1,           // part loose matter (powder and liquid) out from the axis, not along it
  AXIS_EPS: 0.001,   // cells: a cell this near the axis is parted to one fixed side
};
// The giant worm's (Noita's worm_big.xml: it eats a 9 px disc, 4.5 cells, its hit radius): the same
// bite in a wider ball, so rock breaks within 7.5·√0.33 ≈ 4.3 cells of its head's centre.
export const WORM_GIANT_BITE = { ...WORM_BITE, RADIUS: 7.5, DEPTH: 7.5 };

// Physgun: a spring on the centre of mass of the loose matter near a hold
// point (powders, liquids, gases within RADIUS of it, fading toward RADIUS).
//
// physgunComFrag sums that matter (mass = DENS, times the falloff) into one
// vec4: its centre of mass and how many cells it is. physgunFrag then moves
// it as one ball:
//   v_ball = carry + (hold − com)·SPRING
// carry is the hold point's own velocity, so the ball keeps up as you turn.
// Every cell of the ball (within the radius a sphere of that many cells,
// PACKING full, would have, plus CORE_PAD) gets exactly v_ball. Moving them in
// lockstep matters: the move pass treats a cell pushing slowly into the one
// above it as resting on it and stops it, so a per-cell spring that squeezes
// the ball would let its underside sag out of it every step. Cells outside
// the ball are pulled toward its centre at PULL per cell of distance (up to
// PULL_MAX) and settle onto it; their velocity relaxes toward that at GRIP per
// step (the damping), weighted by the falloff. The field bears the full weight
// of everything within RADIUS, so what it reaches floats while it's drawn in.
//
// Gravity: the edit runs once per frame, before the frame's N steps, and
// each step's react takes g·GRAV from the velocity after its move. The moves
// see on average (N − 1)/2 steps of it, so a held cell is launched at
//   v = v_mean + g·GRAV·(N − 1)/2
// and its velocity left at the frame's end is read back as the mean it had,
// v_end + g·GRAV·(N + 1)/2. In all, N steps of gravity per frame are paid back.
export const PHYS = {
  RADIUS: 5.5,       // cells, reach of the beam around the hold point
  CORE: 0.7,         // share of RADIUS the falloff holds at full strength (a ball of ~130 cells)
  PACKING: 0.6,      // share of a held ball's volume that is matter (moving cells leave gaps)
  CORE_PAD: 0.5,     // cells added to the ball's radius: what moves in lockstep
  SPRING: 0.25,      // 1/step: ball velocity per cell its centre is off the hold point
  PULL: 0.3,         // 1/step: speed toward the ball per cell a stray cell is outside it
  PULL_MAX: 0.6,     // cells/step, fastest strays are drawn in
  GRIP: 0.35,        // per step: share of a stray's velocity gap closed (damping)
  FLING: 0.9,        // cells/step: speed a right-click throws the held matter at
  HOLD_MAX: 32,      // cells from the eye
  GRAB_STANDOFF: 2,  // cells: the hold point starts this far in front of the aimed surface, so the ball forms in the open
  WHEEL_STEP: 1,     // cells of hold distance per wheel notch
};
// cells from the eye: the nearest hold point keeps the beam's reach clear of the body
PHYS.HOLD_MIN = PHYS.RADIUS + BODY_WIDTH;
export const PHYS_MODE = { HOLD: 0, FLING: 1 };

// Physgun blast (right-click with nothing held, the gravity gun's punt): one
// impulse into the loose matter in a cone from the muzzle along the aim. Every
// cell gets the same momentum, so it leaves at
//   Δv = IMPULSE / DENS · falloff
// (water and sand at V_MAX, metal dust 0.2 cells/step, gases capped at V_MAX),
// pointing away from the muzzle. falloff fades toward the cone's end and its
// rim. The cone stops BITE cells past the aimed face, so walls shield what's
// behind them. Solids don't move: there are no rigid bodies.
//
// The shove alone barely dents a pile or a pool: the struck layer runs into
// the still matter behind it, which has nowhere to go. So where the cone meets
// a surface it also leaves a pressure pulse (the air pressure the engine
// already carries, react.js), centred PULSE_DEPTH past the face: just under a
// water surface or inside a pile. The engine's pressure gradient then throws
// what lies above and around it up and out, a splash or a crater. The pulse is
// PULSE_SHARE of the pressure that breaks the weakest breakable solid
// (hard · P_BREAK_PER_HARD), so it never smashes one.
const WEAKEST_HARD = Math.min(...ELEMENTS.filter((e) => e.breakInto).map((e) => e.hard));
export const BLAST = {
  IMPULSE: 16,       // DENS · cells/step given to each cell at full strength
  RANGE: 16,         // cells from the muzzle
  RADIUS0: 1,        // cells, the cone's radius at the muzzle
  SPREAD: 0.35,      // cells of radius gained per cell along it
  BITE: 1.5,         // cells past the aimed face it still pushes
  EDGE: 0.6,         // share of the radius / range held at full strength before fading
  COOLDOWN: 0.4,     // s between blasts
  PULSE_DEPTH: 1,    // cells past the aimed face the pulse is centred
  PULSE_RADIUS: 2.5, // cells, the pulse's reach (full strength inside EDGE of it)
  PULSE_SHARE: 0.8,  // share of the weakest solid's breaking pressure
};
BLAST.PULSE_P = BLAST.PULSE_SHARE * WEAKEST_HARD * ENGINE.P_BREAK_PER_HARD;

// A melee blow (the axe, the pickaxe, the knife, a worm's head; its tuning is
// AXE, PICK, KNIFE or WORM_BITE): break breakable solids in its patch into
// their debris, 1:1 (same cell, temperature, life and ctype: only the element
// changes), and nudge loose powder along the swing (part: part powder and
// liquid out from it). One pipeline for every blow: the tuning is in its params.
export const BlowParams = uniformStruct('BlowParams', {
  ...EDIT_FIELDS,
  center: 'vec3f',    // grid cells: the centre of the struck cell
  energy: 'f32',      // its tuning's ENERGY, RADIUS, DEPTH, CHIP_MAX, SHOVE
  dir: 'vec3f',       // unit swing direction
  radius: 'f32',
  depth: 'f32',
  chipMax: 'f32',
  shove: 'f32',
  part: 'u32',        // PART: part loose matter out from the axis
  axisEps: 'f32',     // AXIS_EPS
});
export const blowWGSL = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let d = vec3f(p) + 0.5 - P.center;
  let reach = max(P.radius, P.depth);
  if (dot(d, d) >= reach * reach) { return; }
  let along = dot(d, P.dir);
  let across = d - along * P.dir;
  let r2 = dot(across, across) / (P.radius * P.radius) + along * along / (P.depth * P.depth);
  if (r2 >= 1.0) { return; }
  let E = P.energy * (1.0 - r2);
  let id = eid(a);
  let into = BREAKINTO(id);
  var push = P.dir;
  var loose = KIND(id) == K_POWDER;
  if (P.part != 0u) {
    // a burrower's head: out from its axis (a cell on the axis goes to one fixed side)
    let off = length(across);
    if (off > P.axisEps) {
      push = across / off;
    } else {
      var side = vec3f(1.0, 0.0, 0.0);
      if (abs(P.dir.y) < 0.9) { side = vec3f(0.0, 1.0, 0.0); }
      push = normalize(cross(P.dir, side));
    }
    loose = KIND(id) == K_POWDER || KIND(id) == K_LIQUID;
  }
  if (KIND(id) == K_SOLID && into >= 0 && E >= HARD(id)) {
    (*oA).x = f32(into);
    // what the cut doesn't use flies off with the chip: ½·DENS·v² = E − hard
    let v = min(sqrt(2.0 * (E - HARD(id)) / DENS(into)), P.chipMax);
    *oB = vec4f(push * v, b.w);
  } else if (loose) {
    *oB = vec4f(clamp(b.xyz + push * P.shove * (1.0 - r2), vec3f(-V_MAX), vec3f(V_MAX)), b.w);
  }
}
`;
// A tool's pass (src/pov/gpu.js toolPass): its family's edit and its tuning as that edit's params.
const blowTool = (P) => ({ edit: 'povBlow', values: {
  energy: P.ENERGY, radius: P.RADIUS, depth: P.DEPTH, chipMax: P.CHIP_MAX, shove: P.SHOVE, part: P.PART ? 1 : 0, axisEps: P.AXIS_EPS ?? 0,
} });
export const axeFrag = blowTool(AXE);
export const pickaxeFrag = blowTool(PICK);
export const knifeFrag = blowTool(KNIFE);
export const wormFrag = blowTool(WORM_BITE);
export const wormGiantFrag = blowTool(WORM_GIANT_BITE);

// A flame: a cone from a nozzle along a direction (P: FLAMER, the
// flamethrower's, or TORCH_FIRE, a thrown torch's). Air in the cone becomes
// engine FIRE at the flame's temperature, blown along it, and matter the flame
// touches is heated toward that temperature; the engine does the rest (wood
// and powder light, gunpowder goes off, ice and metal melt). Heat goes in as
//   T += (FLAME_T − T) · (1 − exp(−HEAT_RATE · dt / CAP)),
// so nothing gets hotter than the flame and a high heat capacity heats slowly.
// HEAT_RATE stands in for the hot spot a 30 cm cell can't resolve (as
// physics.js KE_TO_HEAT does for impacts): wood lights in a third of a second,
// a metal cell starts to melt in about ten.
//
// The flamethrower's is Team Fortress 2's Pyro's reach (≈ 6 m) and fills its
// whole cone with fire every frame, so the stream is one continuous jet; its
// fire is the hotter propane–air flame the blowtorch had.
export const FLAMER = {
  FLAME_T: 1900,     // °C, propane–air adiabatic flame temperature
  LENGTH: 20,        // cells (6 m)
  RADIUS0: 0.5,      // cells, the stream's radius at the nozzle
  SPREAD: 0.12,      // cells of radius gained per cell along it (≈ 2.9 at its end)
  SPAWN: 1,          // chance per frame an air cell in the stream becomes fire
  SPEED: 0.6,        // cells/step the fire leaves along the aim (≈ 43 m/s)
  HEAT_RATE: 0.15,   // 1/s × CAP: share of the gap to FLAME_T closed per second (see above)
  BITE: 1.5,         // cells past the struck face the flame heats into
};
// A burning torch lying where it was thrown, or touched to something (lamp.js):
// its flame's heat, hot enough to light wood and paper that touch it. It puts
// no FIRE in the air: the flame you see is its own (pov/flame.js), and engine
// fire round it drew as a red cloud beside it. Without that fire's heat, its
// own has to win against what the cell conducts away (at the flamer's rate the
// wood under it sat near 90 °C), so its contact heats ten times as fast: wood
// it lies on or is held to catches in about a second. What it lights burns as usual.
export const TORCH_FIRE = {
  FLAME_T: 900,      // °C, a pitch torch's flame
  LENGTH: 1.5,       // cells
  RADIUS0: 0.4,
  SPREAD: 0.3,
  SPAWN: 0,
  SPEED: 0.15,
  HEAT_RATE: 1.5,
  BITE: 1,
};

// A burning body (pov/stains.js, status Burning): a column of flame up one side of it, from the
// feet to the head, at burning clothing's flame temperature. The body turns it round its sides.
export const BODY_FIRE = {
  FLAME_T: 900,      // °C, burning cloth (cotton's flame, like a torch's pitch)
  LENGTH: BODY_HEIGHT,   // cells: feet to head
  RADIUS0: 0.6,
  SPREAD: 0.1,
  SPAWN: 0.2,
  SPEED: 0.15,
  HEAT_RATE: 0.15,
  BITE: 0,
};

export const FlameParams = uniformStruct('FlameParams', {
  ...EDIT_FIELDS,
  nozzle: 'vec3f',    // grid cells
  reach: 'f32',       // cells along it to the struck face (the flame stops there), ≤ its LENGTH
  dir: 'vec3f',       // unit direction
  dt: 'f32',          // s this frame
  frame: 'u32',       // the flame's random stream
  flameT: 'f32',      // its tuning's FLAME_T, RADIUS0, SPREAD, SPAWN, SPEED, HEAT_RATE, BITE
  radius0: 'f32',
  spread: 'f32',
  spawn: 'f32',
  speed: 'f32',
  heatRate: 'f32',
  bite: 'f32',
});
export const flameWGSL = /* wgsl */ `
const FLM_RNG_SALT: u32 = 0x70u;   // keeps the flame's random draws apart from other passes'

fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let d = vec3f(p) + 0.5 - P.nozzle;
  let along = dot(d, P.dir);
  if (along < 0.0 || along > P.reach + P.bite) { return; }
  let r = length(d - along * P.dir);
  let radius = P.radius0 + P.spread * along;
  if (r > radius) { return; }
  let id = eid(a);
  var rs = seed3(p, P.frame, FLM_RNG_SALT);
  if (isGasLike(id)) {
    if (along > P.reach || rnd(&rs) > P.spawn) { return; }
    let seed = rnd(&rs) * SEED_MAX;
    *oA = vec4f(f32(E_FIRE), P.flameT, SPAWNLIFE(E_FIRE), seed);
    *oB = vec4f(P.dir * P.speed, b.w);
  } else {
    let k = 1.0 - exp(-P.heatRate * P.dt / CAP(id));
    (*oA).y = a.y + max(P.flameT - a.y, 0.0) * k;
  }
}
`;
const flameTool = (P) => ({ edit: 'povFlame', values: {
  flameT: P.FLAME_T, radius0: P.RADIUS0, spread: P.SPREAD, spawn: P.SPAWN, speed: P.SPEED, heatRate: P.HEAT_RATE, bite: P.BITE,
} });
export const flamerFrag = flameTool(FLAMER);
export const torchFireFrag = flameTool(TORCH_FIRE);
export const bodyFireFrag = flameTool(BODY_FIRE);

// The box of cell centres a flame edit (tuning P) may change, for
// sim.touchCentres: the cone's axis out to reach + BITE, widened by its
// radius there: the edit's box.
export function flameBox(P, nozzle, dir, reach) {
  const len = reach + P.BITE, r = P.RADIUS0 + P.SPREAD * len;
  const lo = [], hi = [];
  for (const k of ['x', 'y', 'z']) {
    const a = nozzle[k], b = nozzle[k] + dir[k] * len;
    lo.push(Math.min(a, b) - r);
    hi.push(Math.max(a, b) + r);
  }
  return [lo, hi];
}

const physWGSL = /* wgsl */ `
${consts('PHYS', PHYS)}
const PHYS_MODE_HOLD: u32 = ${PHYS_MODE.HOLD}u;
const PHYS_MODE_FLING: u32 = ${PHYS_MODE.FLING}u;
const PHYS_SPAN: i32 = ${Math.ceil(PHYS.RADIUS)};
const FOUR_THIRDS_PI: f32 = 4.18879;
// what the beam can hold: loose matter, never solids or plain air
fn physHeld(id: i32) -> bool { let k = KIND(id); return k == K_POWDER || k == K_LIQUID || k == K_GAS; }
fn physFalloff(r: f32) -> f32 { return 1.0 - smoothstep(PHYS_RADIUS * PHYS_CORE, PHYS_RADIUS, r); }
`;

// The held matter's centre of mass (xyz, grid cells) and its size in cells
// (w), falloff-weighted, into the physgun's own COM buffer (group 2), which
// its edit reads in the same pass (docs/webgpu.md G2: GPU to GPU). One
// workgroup over the cube around the hold point: each thread sums its share
// of the cube in order, then the workgroup adds the 64 sums up pairwise (a
// fixed order, so the result is the same every time).
export const ComParams = uniformStruct('ComParams', { hold: 'vec3f' });
export const COM_LAYOUT = [{ binding: 0, buffer: { type: 'storage' } }];
export const physgunComFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${physWGSL}
${ComParams.wgsl}
@group(3) @binding(1) var<uniform> P: ComParams;
@group(2) @binding(0) var<storage, read_write> com: array<vec4f>;
const SIDE: i32 = 2 * PHYS_SPAN + 1;
var<workgroup> sums: array<vec4f, 64>;   // (Σ at·DENS·w, Σ DENS·w)
var<workgroup> cellSums: array<f32, 64>;   // Σ w

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32) {
  let c = vec3i(floor(P.hold));
  var sum = vec4f(0.0);
  var n = 0.0;
  for (var k = i32(li); k < SIDE * SIDE * SIDE; k += 64) {
    let q = c + vec3i(k % SIDE, (k / SIDE) % SIDE, k / (SIDE * SIDE)) - PHYS_SPAN;
    if (!inGrid(q)) { continue; }
    let at = vec3f(q) + 0.5;
    let r = length(at - P.hold);
    if (r >= PHYS_RADIUS) { continue; }
    let id = eid(fetchA(q));
    if (!physHeld(id)) { continue; }
    let w = physFalloff(r);
    sum += vec4f(at * DENS(id) * w, DENS(id) * w);
    n += w;
  }
  sums[li] = sum;
  cellSums[li] = n;
  for (var s = 32u; s > 0u; s >>= 1u) {
    workgroupBarrier();
    if (li < s) { sums[li] += sums[li + s]; cellSums[li] += cellSums[li + s]; }
  }
  workgroupBarrier();
  if (li == 0u) {
    let t = sums[0];
    var at = P.hold;
    if (t.w > 0.0) { at = t.xyz / t.w; }
    com[0] = vec4f(at, cellSums[0]);
  }
}
`;

// Hold the matter around hold as a ball (see PHYS), or fling it along fling.
export const PhysgunParams = uniformStruct('PhysgunParams', {
  ...EDIT_FIELDS,
  hold: 'vec3f',      // grid cells
  steps: 'f32',       // sim steps per frame
  carry: 'vec3f',     // cells/step, the hold point's own velocity
  gravity: 'f32',     // cells/step² (sim.gravity)
  fling: 'vec3f',     // cells/step
  mode: 'u32',        // PHYS_MODE
});
export const PHYSGUN_LAYOUT = [{ binding: 0, buffer: { type: 'read-only-storage' } }];
export const physgunDeclsWGSL = `${physWGSL}
@group(2) @binding(0) var<storage, read> physCom: array<vec4f>;   // physgunComFrag's (centre of mass, cells)
`;
export const physgunWGSL = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let at = vec3f(p) + 0.5;
  let r = length(at - P.hold);
  if (r >= PHYS_RADIUS) { return; }
  let id = eid(a);
  if (!physHeld(id)) { return; }
  if (P.mode == PHYS_MODE_FLING) { *oB = vec4f(clamp(P.fling, vec3f(-V_MAX), vec3f(V_MAX)), b.w); return; }

  let com = physCom[0];
  let vBall = P.carry + (P.hold - com.xyz) * PHYS_SPRING;
  let rBall = pow(com.w / (PHYS_PACKING * FOUR_THIRDS_PI), 1.0 / 3.0) + PHYS_CORE_PAD;
  let toCom = com.xyz - at;
  let rc = length(toCom);
  let inBall = rc < rBall;
  var w = physFalloff(r);
  if (inBall) { w = 1.0; }
  let g = P.gravity * GRAV(id);   // the field carries the weight of all it reaches
  var goal = vBall;
  if (!inBall) { goal += toCom / max(rc, 1.0) * min((rc - rBall) * PHYS_PULL, PHYS_PULL_MAX); }
  var grip = 1.0;
  if (!inBall) { grip = w * (1.0 - pow(1.0 - PHYS_GRIP, P.steps)); }
  let vMean = b.xyz + vec3f(0.0, g * (P.steps + 1.0) * 0.5, 0.0);   // what it moved at last frame
  let v = mix(vMean, goal, grip) + vec3f(0.0, g * (P.steps - 1.0) * 0.5, 0.0);
  *oB = vec4f(clamp(v, vec3f(-V_MAX), vec3f(V_MAX)), b.w);
}
`;
export const physgunFrag = (g) => editKernelWGSL(g, { update: physgunWGSL, params: PhysgunParams, decls: physgunDeclsWGSL });

// Blast the loose matter in the cone (see BLAST).
export const BlastParams = uniformStruct('BlastParams', {
  ...EDIT_FIELDS,
  muzzle: 'vec3f',    // grid cells
  reach: 'f32',       // cells along the aim it pushes, ≤ BLAST.RANGE
  dir: 'vec3f',       // unit aim
  pulseP: 'f32',      // the pressure pulse's pressure (0: the cone met no surface)...
  pulse: 'vec3f',     // ...and its centre, grid cells
});
export const blastWGSL = /* wgsl */ `
${consts('BLAST', BLAST)}
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let id = eid(a);
  let k = KIND(id);
  let rp = length(vec3f(p) + 0.5 - P.pulse);
  if (k != K_SOLID && rp < BLAST_PULSE_RADIUS) {
    (*oB).w = max(b.w, P.pulseP * (1.0 - smoothstep(BLAST_EDGE, 1.0, rp / BLAST_PULSE_RADIUS)));
  }
  let d = vec3f(p) + 0.5 - P.muzzle;
  let along = dot(d, P.dir);
  if (along < 0.0 || along > P.reach) { return; }
  let radius = BLAST_RADIUS0 + BLAST_SPREAD * along;
  let r = length(d - along * P.dir);
  if (r > radius) { return; }
  if (k != K_POWDER && k != K_LIQUID && k != K_GAS) { return; }
  let w = (1.0 - smoothstep(BLAST_EDGE, 1.0, along / BLAST_RANGE)) * (1.0 - smoothstep(BLAST_EDGE, 1.0, r / radius));
  let away = d / max(length(d), 1.0);
  let v = clamp(b.xyz + away * min(BLAST_IMPULSE / DENS(id), V_MAX) * w, vec3f(-V_MAX), vec3f(V_MAX));
  *oB = vec4f(v, (*oB).w);
}
`;
export const blastFrag = (g) => editKernelWGSL(g, { update: blastWGSL, params: BlastParams });

// Rocket (rocket.tool.js): one blast where it strikes, adding no matter to the
// world. Its reach is Team Fortress 2's rocket's (146 HU ≈ 2.8 m ≈ 9 cells).
// Around the centre, r cells out:
//   - a solid within BREAK_RADIUS takes a blow of E(r) = ENERGY·(1 − (r/R)²)
//     and breaks into its debris where E beats its hardness (as the axe's
//     blow): ROCK (30) out to 0.82 R, METAL (60) out to 0.58 R. The
//     debris flies outward with what the break didn't use (CHIP_MAX at most).
//   - air and gas within FIRE_RADIUS turn to engine FIRE at the gunpowder
//     blast's temperature, blown outward (it burns out, as the blowtorch's).
//   - loose matter within PULSE_RADIUS is shoved outward, IMPULSE / DENS
//     (as the physgun's blast), and every non-solid cell there gets air
//     pressure PULSE_P, a blast the engine spreads (react.js): it throws
//     loose matter and bodies (player.js, which it can hurt) and breaks the
//     solids it beats. Both fade from full strength at EDGE of the radius.
// Each change turns a cell into its own debris, air into fire, or sets a
// velocity or a pressure: nothing is added that could plug what it opened.
export const ROCKET = {
  ENERGY: 90,        // sim KE units at the centre
  BREAK_RADIUS: 4,   // cells
  CHIP_MAX: 0.8,     // cells/step, fastest debris flies out
  FIRE_RADIUS: 2.5,  // cells
  FIRE_SPAWN: 0.6,   // chance an air cell in reach becomes fire
  FIRE_SPEED: 0.6,   // cells/step outward
  PULSE_RADIUS: 9,   // cells (TF2's 146 HU)
  PULSE_P: 140,      // air pressure at full strength: breaks wood (20 × 5 = 100), not rock (150)
  IMPULSE: 20,       // DENS · cells/step given to loose matter at full strength
  EDGE: 0.4,         // share of a radius held at full strength before fading
};
ROCKET.FIRE_T = ELEMENTS[E.GUNPOWDER].blast.T;   // °C, the gunpowder blast's (elements.js)

export const RocketParams = uniformStruct('RocketParams', {
  ...EDIT_FIELDS,
  center: 'vec3f',    // grid cells
  frame: 'u32',       // the blast's random stream
});
export const rocketWGSL = /* wgsl */ `
${consts('ROCKET', ROCKET)}
const ROCKET_RNG_SALT: u32 = 0x72u;   // keeps the rocket's random draws apart from other passes'

fn rocketFade(x: f32) -> f32 { return 1.0 - smoothstep(ROCKET_EDGE, 1.0, x); }

fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let d = vec3f(p) + 0.5 - P.center;
  let r = length(d);
  if (r >= ROCKET_PULSE_RADIUS) { return; }
  var rs = seed3(p, P.frame, ROCKET_RNG_SALT);
  var away: vec3f;
  if (r > 0.5) {
    away = d / r;
  } else {
    let x = rnd(&rs) - 0.5;
    let y = rnd(&rs);
    let z = rnd(&rs) - 0.5;
    away = normalize(vec3f(x, y, z) + vec3f(0.0, 0.1, 0.0));
  }
  let id = eid(a);
  if (KIND(id) == K_SOLID) {
    let x = r / ROCKET_BREAK_RADIUS;
    let E = ROCKET_ENERGY * (1.0 - x * x);
    let into = BREAKINTO(id);
    if (x >= 1.0 || into < 0 || E < HARD(id)) { return; }
    (*oA).x = f32(into);
    *oB = vec4f(away * min(sqrt(2.0 * (E - HARD(id)) / DENS(into)), ROCKET_CHIP_MAX), b.w);
  } else if (isGasLike(id) && r < ROCKET_FIRE_RADIUS && rnd(&rs) < ROCKET_FIRE_SPAWN) {
    let seed = rnd(&rs) * SEED_MAX;
    *oA = vec4f(f32(E_FIRE), ROCKET_FIRE_T, SPAWNLIFE(E_FIRE), seed);
    *oB = vec4f(away * ROCKET_FIRE_SPEED, b.w);
  } else if (!isGasLike(id)) {
    let w = rocketFade(r / ROCKET_PULSE_RADIUS);
    *oB = vec4f(clamp(b.xyz + away * min(ROCKET_IMPULSE / DENS(id), V_MAX) * w, vec3f(-V_MAX), vec3f(V_MAX)), b.w);
  }
  (*oB).w = max((*oB).w, ROCKET_PULSE_P * rocketFade(r / ROCKET_PULSE_RADIUS));
}
`;
export const rocketFrag = (g) => editKernelWGSL(g, { update: rocketWGSL, params: RocketParams });

// This module's edit families, as sim.editKernel takes them (src/pov/gpu.js).
export const POV_TOOL_EDITS = {
  povBlow: { update: blowWGSL, params: BlowParams },
  povFlame: { update: flameWGSL, params: FlameParams },
  povPhysgun: { update: physgunWGSL, params: PhysgunParams, decls: physgunDeclsWGSL, layout: PHYSGUN_LAYOUT },
  povBlast: { update: blastWGSL, params: BlastParams },
  povRocket: { update: rocketWGSL, params: RocketParams },
};
// WEBGPU-STUB (docs/webgpu.md J3): a tool's pass is pov/gpu.js toolPass(tool)
// now, an edit of its family; this module can't re-export it (pov/gpu.js
// imports this one, and the cycle would leave POV_TOOL_EDITS unset there).
export function toolPass() { throw new Error('toolPass removed in the WebGPU port: docs/webgpu.md G2'); }

const perBox = (g) => fold(gridDims(g).nbricks);
const editCheck = ([name, e]) => ({
  name, kind: 'compute', dispatch: perBox, layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, ...(e.layout ? [e.layout] : [])],
  code: (g) => editKernelWGSL(g, { update: e.update, params: e.params, decls: e.decls ?? '' }),
});
/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  ...Object.entries(POV_TOOL_EDITS).map(editCheck),
  { name: 'povCom', kind: 'compute', code: (g) => physgunComFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, COM_LAYOUT], dispatch: () => [1, 1, 1] },
];

// ---- viewmodel helpers (the held tools are drawn in cells, scaled to world) ----

// Shade of each box face for flat-lit stylised meshes (no scene lights):
// +x, −x, +y (top), −y, +z, −z.
const FACE_SHADE = [0.82, 0.62, 1.0, 0.45, 0.9, 0.7];

// A box with baked per-face shading.
export function shadedBox(w, h, d, color) {
  const geo = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const base = new THREE.Color(color);
  const cols = [];
  const perFace = geo.attributes.position.count / FACE_SHADE.length;
  FACE_SHADE.forEach((s) => {
    for (let i = 0; i < perFace; i++) cols.push(base.r * s, base.g * s, base.b * s);
  });
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
}

// Soft round glow (muzzle flash, beam tip), white at the centre.
const GLOW_TEX_SIZE = 64;   // px
export function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = GLOW_TEX_SIZE;
  const x = c.getContext('2d');
  const r = GLOW_TEX_SIZE / 2;
  const grad = x.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = grad;
  x.fillRect(0, 0, GLOW_TEX_SIZE, GLOW_TEX_SIZE);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Free a viewmodel subtree's geometry, materials and textures. A sprite's
// geometry is three's one quad, every Sprite's: it stays (perkOrbs.js remove).
export function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isSprite) o.geometry?.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    ms.forEach((m) => { m.map?.dispose(); m.dispose(); });
  });
  root.removeFromParent();
}
