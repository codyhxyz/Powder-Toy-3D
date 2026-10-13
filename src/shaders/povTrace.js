import { prelude, editKernelWGSL, EDIT_FIELDS, EDIT_SCRATCH_BINDING, LAYOUT, STATE_OPTS, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { ddaGLSL } from './gfx/core.js';
import { ddaWalkWGSL } from './dda.js';
import { RING_LAYOUT, ringWGSL } from './povBody.js';

// GPU work for the guns' ballistic rounds (src/pov/ballistics.js), on WebGPU
// (docs/webgpu.md G2).
//
// A round flies outside the sim, on the CPU, with real ballistics. Each frame
// traceFrag marches the stretch of path it will cover next through the grid,
// one thread per round, into a slot of a result ring the CPU reads back a
// frame or two later. Where a round strikes matter, the strike spends its
// energy on what it meets: it breaks and shoves cells, and adds none.
//
// Units: grid cells, cells/step for the sim's velocities.

export const TRACE = {
  ROUNDS: 16,        // rounds traced per dispatch (a thread each)
  ROWS: 3,           // vec4s of answer per round (see traceFrag's output)
};
// A round's strike (strikeWGSL):
export const STRIKE = {
  DEPTH_MAX: 64,     // cells: the longest path a strike walks (the most any gun's round goes through)
  CHIP_MAX: 0.5,     // cells/step: fastest the debris of a cell a round breaks flies on
  DRAG: 1,           // energy a round loses per cell of powder or liquid, per unit of its DENS (water: 10)
};
// Face codes are axis * 2 + (1 if the ray steps +axis), as the pick pass's; the
// face's normal is minus that step. The floor is hit stepping down y.
export const TRACE_FACE_FLOOR = 2;
export const TRACE_MISS = -1;   // face of a segment that hit nothing
// starts[i].w of an active segment (TraceParams): what stops it
export const TRACE_ROUND = 1;   // a round: liquids, powders and solids
export const TRACE_SIGHT = 2;   // a camera's line of sight (pov/cameraArm.js): powders and solids, liquids let it through
// bytes of one trace's answer (a ring slot): ROWS × ROUNDS vec4s, row-major
export const TRACE_BYTES = TRACE.ROUNDS * TRACE.ROWS * 16;

// A JS number as a WGSL f32 literal (H1.7)
const lit = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

// The segments (grid cells; starts[i].w as above, 0 for an idle thread) and the
// ring slot the answer goes to.
export const TraceParams = uniformStruct('TraceParams', {
  starts: `array<vec4f, ${TRACE.ROUNDS}>`,
  ends: `array<vec4f, ${TRACE.ROUNDS}>`,
  slot: 'u32',
});

// One thread per round: it marches the round's segment starts[i].xyz → ends[i]
// cell by cell (the DDA of render.js's pickFrag, without its brick skipping:
// docs/webgpu.md G2, the presentation's brick map can be stale against the
// state this reads) and writes all three rows of its answer: the first cell
// holding a liquid, powder or solid (air and gases let a round through; a
// TRACE_SIGHT segment passes liquids too).
//   row 0: (struck cell xyz, face), face TRACE_MISS if the segment is clear
//   row 1: (last air or gas cell before it xyz, element id); xyz −1 if unknown
//   row 2: (entry point xyz, share of the segment flown to it, 0..1)
// Row k of round i is vec4 k·ROUNDS + i of the slot. A segment that runs out
// through the floor (y = 0 is the floor, below the grid) strikes it: the
// engine treats what lies outside the box as WALL. Through the sides or the
// top it is clear.
export const traceFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${ddaGLSL(g)}
${TraceParams.wgsl}
@group(3) @binding(1) var<uniform> P: TraceParams;
${ringWGSL()}
const TRACE_ROUNDS: u32 = ${TRACE.ROUNDS}u;
const TRACE_ROWS: u32 = ${TRACE.ROWS}u;
const TRACE_FACE_FLOOR: f32 = ${lit(TRACE_FACE_FLOOR)};
const TRACE_MISS: f32 = ${lit(TRACE_MISS)};
const TRACE_SIGHT: f32 = ${lit(TRACE_SIGHT)};
const TRACE_NUDGE: f32 = 1e-3;   // cells: how far back from a start point inside a cell the cell before it is looked for

fn answer(i: u32, r0: vec4f, r1: vec4f, r2: vec4f) {
  let at = P.slot * TRACE_ROUNDS * TRACE_ROWS + i;
  ringOut[at] = r0;
  ringOut[at + TRACE_ROUNDS] = r1;
  ringOut[at + 2u * TRACE_ROUNDS] = r2;
}

@compute @workgroup_size(${TRACE.ROUNDS})
fn main(@builtin(local_invocation_index) i: u32) {
  let unknown = vec4f(-1.0, -1.0, -1.0, 0.0);
  let start = P.starts[i];
  if (start.w < 0.5) { answer(i, vec4f(0.0, 0.0, 0.0, TRACE_MISS), unknown, unknown); return; }
  let sight = start.w > TRACE_SIGHT - 0.5;
  let ro = start.xyz;
  let dv = P.ends[i].xyz - ro;
  let len = length(dv);
  if (len <= 0.0) { answer(i, vec4f(0.0, 0.0, 0.0, TRACE_MISS), unknown, unknown); return; }
  let rd = safeDir(dv / len);

  // the floor, where the segment would run out through it
  var tFloor = -1.0;
  if (rd.y < 0.0) { tFloor = -ro.y / rd.y; }
  let atFloor = ro + rd * tFloor;
  let floorHit = tFloor >= 0.0 && tFloor <= len
    && atFloor.x >= 0.0 && atFloor.x < f32(NX) && atFloor.z >= 0.0 && atFloor.z < f32(NZ);

  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, 0.0);
  let tEnd = min(bh.y, len);
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t0, &istp, &tDelta, &cell, &tMax);
  var tEnter = t0;
  // the axis the first cell was entered across: the box face, or for a start
  // inside the box the one the path left the cell before it through
  let back = floor(ro - rd * TRACE_NUDGE);
  let moved = abs(back - vec3f(cell));
  var ax = -1;
  if (bh.x > 0.0) { ax = i32(bh.z); } else if (moved.x > 0.0) { ax = 0; } else if (moved.y > 0.0) { ax = 1; } else if (moved.z > 0.0) { ax = 2; }

  for (var k = 0; k < MAX_STEPS; k++) {
    if (t0 >= tEnd || tEnter > tEnd || outside(cell)) { break; }
    let a = fetchA(cell);
    let id = eid(a);
    if (!isGasLike(id) && !(sight && KIND(id) == K_LIQUID)) {
      // entered from outside the box, or from an unknown side: no cell before it
      let known = ax >= 0 && !(k == 0 && bh.x > 0.0);
      var axis = argmin3(-abs(rd));
      if (ax >= 0) { axis = ax; }
      var prev = cell;
      if (known) { prev[axis] -= istp[axis]; }
      var up = 0;
      if (istp[axis] > 0) { up = 1; }
      let face = axis * 2 + up;   // normal = -step
      var r1 = vec4f(-1.0, -1.0, -1.0, f32(id));
      if (known) { r1 = vec4f(vec3f(prev), f32(id)); }
      answer(i, vec4f(vec3f(cell), f32(face)), r1, vec4f(ro + rd * tEnter, tEnter / len));
      return;
    }
    tEnter = min(tMax.x, min(tMax.y, tMax.z));
    ax = ddaStep(istp, tDelta, &cell, &tMax);
  }
  if (floorHit) {
    let under = vec3f(floor(atFloor.x), -1.0, floor(atFloor.z));
    answer(i, vec4f(under, TRACE_FACE_FLOOR), vec4f(under + vec3f(0.0, 1.0, 0.0), f32(E_WALL)),
      vec4f(atFloor.x, 0.0, atFloor.z, tFloor / len));
    return;
  }
  answer(i, vec4f(0.0, 0.0, 0.0, TRACE_MISS), unknown, unknown);
}
`;

// A round strikes: from the struck face's entry point it walks on along dir
// (a DDA, as the trace) for up to depth cells, spending its energy (the sim's
// kinetic energy units, as HARD) cell by cell. That is the engine's
// projectile rule (react.js): every breakable solid a projectile breaks costs
// it that solid's hardness.
//   breakable solid, energy ≥ its hardness: breaks into its debris in place
//     (only the element changes), which flies on along dir with the energy
//     left (CHIP_MAX at most); the round pays the hardness
//   any other solid: the round stops there
//   powder or liquid: shoved along dir; the round pays DENS · DRAG
//   air or gas: free
// Nothing is added to the world: each change turns a cell into its own debris
// or gives it a velocity. The walk re-reads the state the edit sees, so it
// meets whatever moved in since the trace. An edit over the walk's box, in two
// phases (docs/webgpu.md D7, W4): every cell near the path (in lo..hi and
// within a cell of the line) runs the same walk over the state before the
// strike and changes only its own cell, so they agree; the second phase
// stores what the first worked out.
export const StrikeParams = uniformStruct('StrikeParams', {
  ...EDIT_FIELDS,
  entry: 'vec3f',     // grid cells
  energy: 'f32',      // the round's energy at the face
  dir: 'vec3f',       // unit heading of the round
  depth: 'f32',       // cells the walk goes at most (≤ STRIKE.DEPTH_MAX)
  lo: 'vec3f',        // the walk's bounding box, in cells
  hi: 'vec3f',
});
export const strikeWGSL = /* wgsl */ `
${ddaWalkWGSL}
const STRIKE_DEPTH_MAX: i32 = ${STRIKE.DEPTH_MAX};
const STRIKE_CHIP_MAX: f32 = ${lit(STRIKE.CHIP_MAX)};
const STRIKE_DRAG: f32 = ${lit(STRIKE.DRAG)};
const STRIKE_NUDGE: f32 = 1e-3;   // cells: the walk starts this far past the entry point, inside the struck cell
const STRIKE_NEAR: f32 = 1.0;     // cells from the path's line a cell must be within to be on it

fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let pc = vec3f(p);
  if (any(pc < P.lo) || any(pc > P.hi)) { return; }
  let d = pc + 0.5 - P.entry;
  if (length(d - dot(d, P.dir) * P.dir) > STRIKE_NEAR) { return; }

  let rd = safeDir(P.dir);
  let ro = P.entry + rd * STRIKE_NUDGE;
  var istp: vec3i;
  var tDelta: vec3f;
  var tMax: vec3f;
  var c = vec3i(floor(ro));
  ddaInit(ro, rd, c, &istp, &tDelta, &tMax);
  var E = P.energy;
  var tEnter = 0.0;
  for (var k = 0; k < STRIKE_DEPTH_MAX; k++) {
    if (tEnter > P.depth || E <= 0.0 || !inGrid(c)) { return; }
    let here = all(c == p);
    var id: i32;
    if (here) { id = eid(a); } else { id = eid(fetchA(c)); }
    let kind = KIND(id);
    if (here) {
      if (kind == K_SOLID) {
        let into = BREAKINTO(id);
        if (into < 0 || E < HARD(id)) { return; }
        (*oA).x = f32(into);
        *oB = vec4f(P.dir * min(sqrt(2.0 * (E - HARD(id)) / DENS(into)), STRIKE_CHIP_MAX), b.w);
      } else if (kind == K_POWDER || kind == K_LIQUID) {
        *oB = vec4f(clamp(b.xyz + P.dir * min(sqrt(2.0 * E / DENS(id)), V_MAX), vec3f(-V_MAX), vec3f(V_MAX)), b.w);
      }
      return;
    }
    if (kind == K_SOLID) {
      if (BREAKINTO(id) < 0 || E < HARD(id)) { return; }
      E -= HARD(id);
    } else if (kind == K_POWDER || kind == K_LIQUID) {
      E -= DENS(id) * STRIKE_DRAG;
    }
    tEnter = min(tMax.x, min(tMax.y, tMax.z));
    ddaStep(istp, tDelta, &c, &tMax);
  }
}
`;
export const strikeFrag = (g) => editKernelWGSL(g, { update: strikeWGSL, params: StrikeParams, reads: 'neighbours' });

// This module's edit family, as sim.editKernel takes it (src/pov/gpu.js).
export const POV_TRACE_EDITS = { povStrike: { update: strikeWGSL, params: StrikeParams, reads: 'neighbours' } };

const SCRATCH = [{ binding: EDIT_SCRATCH_BINDING, buffer: { type: 'storage' } }];   // the two-phase edit's scratch (sim.editKernel adds it)
/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'povTrace', kind: 'compute', code: (g) => traceFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, RING_LAYOUT], dispatch: () => [1, 1, 1] },
  { name: 'povStrike', kind: 'compute', code: (g) => strikeFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, SCRATCH], dispatch: (g) => fold(gridDims(g).nbricks) },
];
