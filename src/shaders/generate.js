import { prelude, STATE_OPTS, EDIT_FIELDS, editKernelWGSL, BRICK } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE, fold } from '../gpu/kernels.js';
import { slabGLSL, BRICK_CELLS } from './window.js';
import { sceneLayout, SCENE_BINDING } from '../world/scenes/sceneGpu.js';

// World generation kernels (docs/scaling.md D11, "Generator", "Scenes";
// docs/webgpu.md G1): every world scene (world/scenes; the island's generator
// is one, world/generator.js and scenes/island.js) generates through its
// sceneCell(world cell), a pure function of the world cell and its uniforms,
// so any region (a window slab) generates seamlessly next to any other. These
// are the window's fill and its leaving slab for it (world/gpu.js);
// sceneGLSL is the scene's glsl(g): WGSL after the prelude, its resources in
// group 2 (scenes/sceneGpu.js), which these kernels share with their own.

// Persistence is bit-exact, including air seeds, signed zero, and pressure.
// Source authority must survive a residency move without changing appearance.
// The legacy tolerance exports remain for existing tools, not store selection.
export const STORE_MATTER_T = 0.5;   // °C: drift a regenerated brick may lose (it is still quiet: well under AIR_REST_T)
export const STORE_LIFE_TOL = 1e-4;  // life/latent/fuel units: float slop only (life changes by reactions)
// WEBGPU-STUB (docs/webgpu.md J3): texels per row of the WebGL diff target; the leaving slab is one kernel now (G1)
export const DIFF_W = null;
export const cellDiffersWGSL = /* wgsl */ `
fn cellDiffers(a: vec4f, b: vec4f, genA: vec4f, genB: vec4f) -> bool {
  return any(bitcast<vec4u>(a) != bitcast<vec4u>(genA)) || any(bitcast<vec4u>(b) != bitcast<vec4u>(genB));
}`;
// CPU persistence fixtures use the same complete word comparison.
export function cellWordsDiffer(a, b, genA, genB) {
  return a.some((v, i) => v !== genA[i]) || b.some((v, i) => v !== genB[i]);
}

// ---------------------------------------------------------------- the fill
// An edit (docs/webgpu.md D6) writing the scene's state into the cells of its
// box (window-local), the grid sitting at world cell `origin` (the window's
// own, sim.origin, but for tools that generate it elsewhere): the whole grid
// on load, the slab a shift uncovers on a move. Cells it doesn't change keep
// their flags; it marks the bricks it changes.
export const FillParams = uniformStruct('FillParams', { ...EDIT_FIELDS, origin: 'vec3i' });
const FILL_UPDATE = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let c = sceneCell(P.origin + p);
  *oA = c.A;
  *oB = c.B;
}`;
/**
 * The fill's edit kernel (sim.editKernel takes this), for a scene.
 * @param {string} sceneGLSL the scene's glsl(g)
 * @param {{ data?: boolean }} has the scene's resources (scenes/sceneGpu.js)
 */
export const fillEdit = (sceneGLSL, has) => ({ update: FILL_UPDATE, decls: sceneGLSL, params: FillParams, reads: 'own', layout: sceneLayout(has) });
/** The fill's whole module (tools/check-wgsl.mjs; sim.editKernel builds the same). */
export const sceneFillFrag = (g, sceneGLSL, has = { data: true }) => editKernelWGSL(g, fillEdit(sceneGLSL, has));

// ---------------------------------------------------------------- the leaving slab
// One kernel (docs/webgpu.md G1) for the WebGL stage, diff and gather passes:
// a workgroup per brick of the slab [lo, lo + 4·bricks) (grid cells, brick
// aligned, x fastest, then y, then z), a thread per cell, each evaluating
// sceneCell at its world cell and comparing (cellDiffers). A brick with any
// differing cell appends itself (one atomicAdd for the workgroup) to the
// slab's head with its world key, and its 64 cells' A and B to the slab's
// cells (128 vec4f: A then B, in the store's slab order, slabCell), which
// world/window.js reads back as one prefix of count bricks.
export const LeaveParams = uniformStruct('LeaveParams', {
  lo: 'vec3i',       // the slab's low corner, grid cells
  bricks: 'vec3i',   // its size in bricks
  wlo: 'vec3i',      // its first brick in world bricks
  wb: 'vec3i',       // the world in bricks (the store's key: (bz · WBY + by) · WBX + bx)
});
/** Bytes of the leaving slab's head for n bricks: the count, then a key a brick. */
export const leaveHeadBytes = (n) => 4 + 4 * n;
/** Bytes of one brick's cells in the leaving slab: 64 A, then 64 B. */
export const LEAVE_BRICK_BYTES = 2 * BRICK_CELLS * 16;
const LEAVE_BINDING = { head: SCENE_BINDING.next, cells: SCENE_BINDING.next + 1 };
/** The leaving slab's group 2: the scene's resources, then its head and cells (both read_write). */
export const leaveLayout = (has) => [
  ...sceneLayout(has),
  { binding: LEAVE_BINDING.head, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: LEAVE_BINDING.cells, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
export { LEAVE_BINDING };
/** Its dispatch for a slab of `bricks`: a workgroup a brick (folded). */
export const leaveDispatch = (bricks) => fold(bricks[0] * bricks[1] * bricks[2]);
// (the name is the WebGL diff pass's, docs/webgpu.md W2: it diffs and gathers)
export const sceneDiffFrag = (g, sceneGLSL) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${sceneGLSL}
${slabGLSL}
${cellDiffersWGSL}
${LeaveParams.wgsl}
@group(3) @binding(1) var<uniform> P: LeaveParams;
struct LeaveHead { count: atomic<u32>, keys: array<u32> }
@group(2) @binding(${LEAVE_BINDING.head}) var<storage, read_write> head: LeaveHead;
@group(2) @binding(${LEAVE_BINDING.cells}) var<storage, read_write> slab: array<vec4f>;
var<workgroup> wgDiffers: atomic<u32>;
var<workgroup> wgFlag: u32;
var<workgroup> wgSlot: u32;
@compute @workgroup_size(${BRICK}, ${BRICK}, ${BRICK})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let k = foldId(wg, nwg);
  let nb = vec3u(P.bricks);
  let live = k < nb.x * nb.y * nb.z;   // (the same for the whole workgroup: a brick each)
  let b = vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / max(nb.x * nb.y, 1u)));
  let p = P.lo + b * BS + vec3i(lid);
  var a = vec4f(0.0);
  var bb = vec4f(0.0);
  if (live && inGrid(p)) {
    a = fetchA(p);
    bb = fetchB(p);
    let generated = sceneCell(H.origin + p);
    if (cellDiffers(a, bb, generated.A, generated.B)) { atomicOr(&wgDiffers, 1u); }
  }
  workgroupBarrier();
  if (li == 0u) { wgFlag = atomicLoad(&wgDiffers); }
  if (workgroupUniformLoad(&wgFlag) == 0u) { return; }
  if (li == 0u) {
    let slot = atomicAdd(&head.count, 1u);
    let w = P.wlo + b;
    head.keys[slot] = u32((w.z * P.wb.y + w.y) * P.wb.x + w.x);
    wgSlot = slot;
  }
  let slot = workgroupUniformLoad(&wgSlot);
  let l = u32(slabIndex(vec3i(lid)));
  slab[slot * ${2 * BRICK_CELLS}u + l] = a;
  slab[slot * ${2 * BRICK_CELLS}u + ${BRICK_CELLS}u + l] = bb;
}
`;
