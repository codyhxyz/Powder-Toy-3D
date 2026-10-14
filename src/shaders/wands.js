import { prelude, editKernelWGSL, EDIT_FIELDS, LAYOUT, STATE_OPTS, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../pov/constants.js';
import { RING_LAYOUT, ringWGSL } from './povBody.js';
import { ddaWalkWGSL } from './dda.js';

export const WAND_COMMANDS = 64;
export const WAND_RAYS = 128;
export const WAND_EFFECTS = Object.freeze(Object.fromEntries([
  'dig', 'emit', 'heat', 'cool', 'pressure', 'erase', 'ignite', 'attract', 'repel', 'place',
].map((name, i) => [name, i])));
// bytes of a trace's answer (3 rows of WAND_RAYS vec4s) and of a clearance's (one vec4): ring slots
export const WAND_TRACE_BYTES = WAND_RAYS * 3 * 16;
export const WAND_CLEARANCE_BYTES = 16;

// One ordered command batch per edit (docs/webgpu.md D7, W19): the union box
// of the batch's spheres, each cell running every command in order on its own
// state, in place. Row r of command i is commands[r · WAND_COMMANDS + i]:
// (centre xyz, radius), (effect, power, material, temperature), (velocity/step,
// force/step), (direction).
// ponytail: the union box of <=64 tests per cell; spatial bins are the
// upgrade if widely scattered commands make that union expensive.
export const WandParams = uniformStruct('WandParams', {
  ...EDIT_FIELDS,
  lo: 'vec3f',
  count: 'u32',
  hi: 'vec3f',
  commands: `array<vec4f, ${4 * WAND_COMMANDS}>`,
});
export const wandApplyWGSL = /* wgsl */ `
const WAND_COMMANDS: u32 = ${WAND_COMMANDS}u;
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let pc = vec3f(p) + 0.5;
  if (any(pc < P.lo) || any(pc > P.hi)) { return; }
  let n = min(P.count, WAND_COMMANDS);
  for (var i = 0u; i < n; i++) {
    let cr = P.commands[i];
    let delta = pc - cr.xyz;
    let d2 = dot(delta, delta);
    if (d2 > cr.w * cr.w) { continue; }
    let ep = P.commands[WAND_COMMANDS + i];        // effect, power, material, temperature
    let vf = P.commands[2u * WAND_COMMANDS + i];   // velocity/step, force/step
    let dir = P.commands[3u * WAND_COMMANDS + i].xyz;
    let effect = i32(ep.x);
    let id = eid(*oA);
    var radial = dir;
    if (d2 > 1e-8) { radial = delta * inverseSqrt(d2); }
    if (effect == ${WAND_EFFECTS.dig}) {
      if (KIND(id) == K_SOLID && BREAKINTO(id) >= 0 && ep.y >= HARD(id)) {
        let debris = BREAKINTO(id);
        *oA = vec4f(f32(debris), (*oA).y, SPAWNLIFE(debris), fract((*oA).w));
        *oB = vec4f((*oB).xyz + vf.xyz, (*oB).w);
      }
    } else if (effect == ${WAND_EFFECTS.emit} || effect == ${WAND_EFFECTS.place}) {
      if (isGasLike(id)) {
        let mat = i32(ep.z);
        *oA = vec4f(f32(mat), ep.w, SPAWNLIFE(mat), fract((*oA).w));
        *oB = vec4f(vf.xyz, (*oB).w);
      }
    } else if (effect == ${WAND_EFFECTS.heat}) {
      (*oA).y += ep.y;
    } else if (effect == ${WAND_EFFECTS.cool}) {
      (*oA).y -= ep.y;
    } else if (effect == ${WAND_EFFECTS.pressure}) {
      (*oB).w += ep.y;
    } else if (effect == ${WAND_EFFECTS.erase}) {
      if (id != E_WALL && id != E_CLONE) {
        *oA = vec4f(f32(E_EMPTY), airT(), 0.0, fract((*oA).w));
        *oB = vec4f(0.0, 0.0, 0.0, (*oB).w);
      }
    } else if (effect == ${WAND_EFFECTS.ignite}) {
      if (IGNITE(id) > 0.0) { (*oA).y = max((*oA).y, IGNITE(id) + max(ep.y, 1.0)); }
    } else if (movable(id)) {
      var pull = 1.0;
      if (effect == ${WAND_EFFECTS.attract}) { pull = -1.0; }
      *oB = vec4f((*oB).xyz + radial * vf.w * pull, (*oB).w);
    }
    (*oA).y = clamp((*oA).y, CELL_TEMP_MIN, CELL_TEMP_MAX);
    *oB = vec4f(clamp((*oB).xyz, vec3f(-V_MAX), vec3f(V_MAX)), clamp((*oB).w, P_MIN, P_MAX));
  }
}
`;
export const wandApplyFrag = (g) => editKernelWGSL(g, { update: wandApplyWGSL, params: WandParams });

// State-only DDA: querying just-written matter does not depend on a possibly
// stale render brick map. A thread per segment writes its three rows (row r
// of ray i is vec4 r · WAND_RAYS + i of the ring slot); never read back the grid.
// Segments: from rows segments[i] (xyz, w 1: active), to rows segments[WAND_RAYS + i].
export const WandTraceParams = uniformStruct('WandTraceParams', { segments: `array<vec4f, ${2 * WAND_RAYS}>`, count: 'u32', slot: 'u32' });
export const wandTraceFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${ddaWalkWGSL}
${WandTraceParams.wgsl}
@group(3) @binding(1) var<uniform> P: WandTraceParams;
${ringWGSL()}
const GRID: vec3i = vec3i(NX, NY, NZ);
const WAND_RAYS: u32 = ${WAND_RAYS}u;
const MAX_STEPS: i32 = ${g.maxSteps ?? g.nx + g.ny + g.nz + 8};

fn answer(i: u32, r0: vec4f, r1: vec4f, r2: vec4f) {
  let at = P.slot * 3u * WAND_RAYS + i;
  ringOut[at] = r0;
  ringOut[at + WAND_RAYS] = r1;
  ringOut[at + 2u * WAND_RAYS] = r2;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let none = vec4f(0.0, 0.0, 0.0, -1.0);
  let start = P.segments[i];
  if (start.w < 0.5) { answer(i, none, none, none); return; }
  let ro = start.xyz;
  let dv = P.segments[WAND_RAYS + i].xyz - ro;
  if (dot(dv, dv) < 1e-12) { answer(i, none, none, none); return; }
  var enter = 0.0;
  var leave = 1.0;
  let ad = abs(dv);
  var axis = 2;
  if (ad.x >= ad.y && ad.x >= ad.z) { axis = 0; } else if (ad.y >= ad.z) { axis = 1; }
  // Clip in segment fractions, preserving exact zero direction components.
  for (var k = 0; k < 3; k++) {
    if (abs(dv[k]) < 1e-10) {
      if (ro[k] < 0.0 || ro[k] >= f32(GRID[k])) { answer(i, none, none, none); return; }
    } else {
      let t1 = -ro[k] / dv[k];
      let t2 = (f32(GRID[k]) - ro[k]) / dv[k];
      let lo = min(t1, t2);
      if (lo > enter) { enter = lo; axis = k; }
      leave = min(leave, max(t1, t2));
    }
  }
  if (enter > leave) { answer(i, none, none, none); return; }
  let crosses = enter < leave;
  let stepDir = vec3i(sign(dv));
  let first = ro + dv * enter;
  var cell = vec3i(floor(first));
  // At an exact face, a negative ray starts in the cell on its left, not
  // the solid it is departing. Box entries still clamp roundoff to the grid.
  for (var k = 0; k < 3; k++) { if (dv[k] < 0.0 && first[k] == f32(cell[k])) { cell[k] -= 1; } }
  cell = clamp(cell, vec3i(0), GRID - 1);
  var next = vec3f(1e20);
  var stride = vec3f(1e20);
  for (var k = 0; k < 3; k++) {
    if (stepDir[k] != 0) {
      var up = 0.0;
      if (dv[k] > 0.0) { up = 1.0; }
      next[k] = (f32(cell[k]) + up - ro[k]) / dv[k];
      stride[k] = abs(1.0 / dv[k]);
    }
  }
  for (var k = 0; k < MAX_STEPS; k++) {
    if (!crosses || enter > leave || !inGrid(cell)) { break; }
    let id = eid(fetchA(cell));
    if (!isGasLike(id)) {
      var up = 0;
      if (stepDir[axis] > 0) { up = 1; }
      answer(i, vec4f(vec3f(cell), f32(axis * 2 + up)), vec4f(ro + dv * enter, enter), vec4f(0.0, 0.0, 0.0, f32(id)));
      return;
    }
    enter = min(next.x, min(next.y, next.z));
    axis = ddaStep(stepDir, stride, &cell, &next);
  }
  // The simulation's bottom is an indestructible floor; sides/top are open.
  if (dv.y < 0.0) {
    let t = -ro.y / dv.y;
    let p = ro + dv * t;
    if (t >= 0.0 && t <= 1.0 && p.x >= 0.0 && p.x < f32(NX) && p.z >= 0.0 && p.z < f32(NZ)) {
      answer(i, vec4f(floor(p.x), -1.0, floor(p.z), 2.0), vec4f(p.x, 0.0, p.z, t), vec4f(0.0, 0.0, 0.0, f32(E_WALL)));
      return;
    }
  }
  answer(i, none, none, none);
}`;

// Whether a body standing with its feet at feet fits where it stands: every
// cell of its box in the grid and free of anything but air and gas. One thread,
// one vec4 into the ring: 1 where it fits.
export const WandClearanceParams = uniformStruct('WandClearanceParams', { feet: 'vec3f', slot: 'u32' });
export const wandClearanceFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${WandClearanceParams.wgsl}
@group(3) @binding(1) var<uniform> P: WandClearanceParams;
${ringWGSL()}
const GRID: vec3i = vec3i(NX, NY, NZ);

fn fits() -> bool {
  let lo = P.feet - vec3f(${BODY_WIDTH / 2}, 0.0, ${BODY_WIDTH / 2});
  let hi = P.feet + vec3f(${BODY_WIDTH / 2}, ${BODY_HEIGHT}, ${BODY_WIDTH / 2});
  if (any(lo < vec3f(0.0)) || any(hi > vec3f(GRID))) { return false; }
  let first = vec3i(floor(lo));
  let last = vec3i(ceil(hi)) - 1;
  for (var z = 0; z < ${Math.ceil(BODY_WIDTH) + 1}; z++) {
    for (var y = 0; y < ${Math.ceil(BODY_HEIGHT) + 1}; y++) {
      for (var x = 0; x < ${Math.ceil(BODY_WIDTH) + 1}; x++) {
        let c = first + vec3i(x, y, z);
        if (any(c > last)) { continue; }
        let id = eid(fetchA(c));
        if (!isGasLike(id)) { return false; }
      }
    }
  }
  return true;
}

@compute @workgroup_size(1)
fn main() {
  var o = vec4f(0.0);
  if (fits()) { o = vec4f(1.0); }
  ringOut[P.slot] = o;
}`;

// This module's edit family, as sim.editKernel takes it (src/pov/gpu.js).
export const WAND_EDITS = { povWand: { update: wandApplyWGSL, params: WandParams } };

const ro = () => [LAYOUT.TABLES, LAYOUT.STATE_RO, RING_LAYOUT];
/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'povWand', kind: 'compute', code: (g) => wandApplyFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW], dispatch: (g) => fold(gridDims(g).nbricks) },
  { name: 'povWandTrace', kind: 'compute', code: (g) => wandTraceFrag(g), layouts: ro, dispatch: () => [WAND_RAYS / 64, 1, 1] },
  { name: 'povWandClearance', kind: 'compute', code: (g) => wandClearanceFrag(g), layouts: ro, dispatch: () => [1, 1, 1] },
];
