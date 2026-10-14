import { prelude, editKernelWGSL, EDIT_FIELDS, LAYOUT, STATE_OPTS, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// GPU side of the first-person body (src/pov/player.js), on WebGPU
// (docs/webgpu.md G2, D6, D7).
//
// 1. Probe: copies a small box of cells around the body into a slot of a
//    result ring the player reads back asynchronously (docs/webgpu.md B7), one
//    vec4 per cell: (element id, temperature °C, air pressure, spark). spark
//    is the cell's electricity (src/electricity.js cellSpark): 0 unless it is
//    live, else the spark's strength as a share of a full one, (0, 1]. Cells
//    outside the grid read as PROBE_OUTSIDE.
// 2. Coupling: an edit over the body's box (sim.edit, in place: it reads only
//    the cell it writes) that gives loose matter inside it the body's velocity
//    plus a push outward and ahead, so wading leaves a wake, a body landing in
//    water throws it up and out, and grains that fall into the body are shoved
//    out of it. It only rewrites velocities: no cell is created, removed or
//    changed, solids are left alone, and air stays still.

// Size of the probed box, in cells. The body is BODY_WIDTH (1.6) wide, so its
// footprint touches at most 3 cells per axis, and up to 7 cells in height.
// Around it the box needs the cells the body touches, collides with, steps onto
// (1 up, 1 down) and travels into before the next readback lands. player.js
// leads the box by velocity × latency, but the body must stay inside it until the
// readback lands, so the box must be larger than the body by the distance
// travelled in one latency. Noita's run (28 cells/s) and flight (47 cells/s) at
// ~10 fps with a few frames' latency is about 10 cells, so 16 × 32 × 16 = 8192
// cells (128 KB a readback). A box too small for the speed skips updates and
// freezes the body.
export const PROBE = { X: 16, Y: 32, Z: 16 };
// cells in the box, and the bytes of one probe's result (a ring slot)
export const PROBE_CELLS = PROBE.X * PROBE.Y * PROBE.Z;
export const PROBE_BYTES = PROBE_CELLS * 16;
// Element id a probe reports for a cell outside the grid (the box walls).
export const PROBE_OUTSIDE = -1;

// The box's low corner (grid cells) and the ring slot the result goes to.
export const ProbeParams = uniformStruct('ProbeParams', { boxLo: 'vec3i', slot: 'u32' });

// The group-2 binding of every POV probe: the result ring, whose slot the
// dispatch's params name (docs/webgpu.md B7; src/pov/gpu.js).
export const RING_LAYOUT = [{ binding: 0, buffer: { type: 'storage' } }];
export const ringWGSL = (type = 'vec4f') => `@group(2) @binding(0) var<storage, read_write> ringOut: array<${type}>;   // the result ring (B7)`;

// One thread per box cell, in the order player.js indexes them: x fastest,
// then z, then y (the WebGL target's texel (x, y·Z + z)).
export const povProbeFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${ProbeParams.wgsl}
@group(3) @binding(1) var<uniform> P: ProbeParams;
${ringWGSL()}
const PROBE_X: u32 = ${PROBE.X}u;
const PROBE_Z: u32 = ${PROBE.Z}u;
const PROBE_CELLS: u32 = ${PROBE_CELLS}u;
const PROBE_OUTSIDE: f32 = ${PROBE_OUTSIDE}.0;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = wg.x * 64u + li;
  if (i >= PROBE_CELLS) { return; }
  let q = P.boxLo + vec3i(i32(i % PROBE_X), i32(i / (PROBE_X * PROBE_Z)), i32((i / PROBE_X) % PROBE_Z));
  var o = vec4f(PROBE_OUTSIDE, AMBIENT, 0.0, 0.0);
  if (inGrid(q)) {
    let a = fetchA(q);
    o = vec4f(f32(eid(a)), a.y, fetchB(q).w, cellSpark(a));
  }
  ringOut[P.slot * PROBE_CELLS + i] = o;
}
`;
export const PROBE_DISPATCH = [Math.ceil(PROBE_CELLS / 64), 1, 1];

// A cell on the body's axis has no outward direction; under this distance
// (cells) it gets a random one.
const AXIS_EPS = 1e-3;

export const CoupleParams = uniformStruct('CoupleParams', {
  ...EDIT_FIELDS,
  vel: 'vec3f',        // body velocity, cells/step
  frame: 'u32',        // the step count (the coupling's random stream)
  lo: 'vec3f',         // body box, grid cells
  pushFluid: 'f32',    // outward push on liquids and gases, cells/step
  hi: 'vec3f',
  pushPowder: 'f32',   // outward push on grains, cells/step
  ahead: 'vec2f',      // forward share of the push, along the body's horizontal heading (xz)
  lift: 'f32',         // upward share of the push (a body moving down throws liquid up)
  only: 'i32',         // the one element it moves (the Rain Cloud's breeze carries only CLOUD), or −1 for all loose matter
});

export const povCouplingWGSL = /* wgsl */ `
const AXIS_EPS: f32 = ${AXIS_EPS};

fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let c = vec3f(p) + 0.5;
  if (any(c < P.lo) || any(c > P.hi)) { return; }
  let id = eid(a);
  if (id == E_EMPTY || KIND(id) == K_SOLID) { return; }
  if (P.only >= 0 && id != P.only) { return; }

  let r = c.xz - 0.5 * (P.lo.xz + P.hi.xz);
  var out2: vec2f;
  if (length(r) > AXIS_EPS) {
    out2 = normalize(r);
  } else {
    var rs = seed3(p, P.frame, SALT_POV);
    out2 = randDir2(&rs);
  }
  var push = P.pushFluid;
  if (KIND(id) == K_POWDER) { push = P.pushPowder; }
  // (as the GLSL's vec3(out2 + uAhead, uLift) was: the xz push lands in x and y, the lift in z)
  let v = P.vel + normalize(vec3f(out2 + P.ahead, P.lift)) * push;
  *oB = vec4f(clamp(v, vec3f(-V_MAX), vec3f(V_MAX)), b.w);
}
`;
export const povCouplingFrag = (g) => editKernelWGSL(g, { update: povCouplingWGSL, params: CoupleParams });

// 3. Perk field (pov/perks.js): one edit over a spherical shell around the
//    body's middle, reaching into the world through the engine's own state.
//    Freeze Field: liquids and fire in it lose cool °C (down to floor), and
//    the engine does the rest: water freezes into ice, lava sets back into what
//    it melted from, fire goes out below its minimum temperature. A column
//    around the body from the feet up (clear) is left alone, so the body
//    stands on the ice it makes rather than in it. Revenge Explosion: air and
//    loose matter in the shell gain pressure, a blast the engine then spreads;
//    solids reflect pressure (react.js), so they get none. The body sits in
//    the shell's eye (inner).
export const FieldParams = uniformStruct('FieldParams', {
  ...EDIT_FIELDS,
  center: 'vec3f',     // the shell's centre, grid cells
  inner: 'f32',        // its radii, cells
  feet: 'vec3f',       // the body's feet, grid cells
  outer: 'f32',
  clear: 'f32',        // cells around the body, from the feet up, left alone
  cool: 'f32',         // °C taken from liquids and fire this edit
  floor: 'f32',        // °C they're cooled no further than
  pressure: 'f32',     // air pressure added this edit
});

export const povFieldWGSL = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let c = vec3f(p) + 0.5;
  let r = length(c - P.center);
  if (r > P.outer || r < P.inner) { return; }
  if (c.y >= P.feet.y && length(c.xz - P.feet.xz) < P.clear) { return; }
  let id = eid(a);
  if (P.cool > 0.0 && (KIND(id) == K_LIQUID || id == E_FIRE) && a.y > P.floor) { (*oA).y = max(a.y - P.cool, P.floor); }
  if (P.pressure > 0.0 && KIND(id) != K_SOLID) { (*oB).w = b.w + P.pressure; }
}
`;
export const povFieldFrag = (g) => editKernelWGSL(g, { update: povFieldWGSL, params: FieldParams });

// This module's edit families, as sim.editKernel takes them (src/pov/gpu.js).
export const POV_BODY_EDITS = {
  povCouple: { update: povCouplingWGSL, params: CoupleParams },
  povField: { update: povFieldWGSL, params: FieldParams },
};

const perBox = (g) => fold(gridDims(g).nbricks);
const rw = () => [LAYOUT.TABLES, LAYOUT.STATE_RW];
/** tools/check-wgsl.mjs (docs/webgpu.md I1); POV builds its pipelines on entering POV (B5, src/pov/gpu.js) */
export const WGSL_CHECK = [
  { name: 'povProbe', kind: 'compute', code: (g) => povProbeFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, RING_LAYOUT], dispatch: () => PROBE_DISPATCH },
  { name: 'povCouple', kind: 'compute', code: (g) => povCouplingFrag(g), layouts: rw, dispatch: perBox },
  { name: 'povField', kind: 'compute', code: (g) => povFieldFrag(g), layouts: rw, dispatch: perBox },
];
