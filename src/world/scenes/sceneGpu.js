import { uniformStruct } from '../../gpu/params.js';
import { STAGE } from '../../gpu/kernels.js';

// A world scene's resources on the GPU (docs/webgpu.md G1; the scene contract
// is scenes/index.js): every pipeline that runs a scene's sceneCell (the
// window's fill and its leaving slab, the far field's cells and trees, the
// detail cells) binds them in its group 2, at these bindings, and puts its own
// at bindings from SCENE_BINDING.next on:
//   0  SU: the scene's uniforms (its uniformStruct, the world seed first)
//   1  SD: its data, if it has any (scene.data), array<vec4u>: the island's
//      baked columns (vec4f bits) and structures, a Wang tiling's tiles and
//      placement, and the scene's prepass region (scene.pre). One buffer,
//      so a writer (8 storage buffers: the tables, the state's five, its own)
//      has room for it; sdWord(i) reads word i of it.
// A scene's module text (glsl(g)) declares what it has, so one without data
// costs its pipelines no storage buffer.
//
// The prepass (scene.pre, the island's): a scene whose sceneCell asks for a
// costly part of itself at several places (the island's cell before nature,
// islandCellBare, which holds the caves: nature asks it of a cell's
// neighbours, a structure's footing of the cells under it) gets that part
// computed first into its data, over the region the sceneCell kernel then
// covers plus a margin, and read back there instead. On the test device every
// call is inlined (SwiftShader), and five inlined copies of the caves miss the
// compile budget (docs/webgpu.md W23) where one is a few seconds.

export const SCENE_GROUP = 2;
export const SCENE_BINDING = { uniforms: 0, data: 1, next: 4 };

/**
 * A scene's uniform struct, SceneU: the world seed (uSceneSeed), then
 * `fields` (WGSL types; 'bool' travels as u32, H1.15). Returns the struct
 * with the field types the WGSL emitter reads them by (toWgsl's uniforms) as
 * sceneTypes.
 * @param {Record<string, string>} fields
 */
export function sceneStruct(fields = {}) {
  const all = { uSceneSeed: 'u32', ...fields };
  const struct = uniformStruct('SceneU', all);
  struct.sceneTypes = Object.fromEntries(Object.entries(all).filter(([, t]) => /^(f32|i32|u32|bool)$/.test(t)));
  return struct;
}

/** The WGSL the scene's sceneCell returns: its state A and B (H1.11: GLSL's out parameters). */
export const SCENE_CELL_WGSL = 'struct SceneCell { A: vec4f, B: vec4f }\n';

/**
 * The scene's bindings (group 2) and its record type, for the head of its glsl(g).
 * @param {{ wgsl: string, name: string }} struct sceneStruct's
 * @param {{ data?: boolean, access?: 'read' | 'read_write' }} [has] access: the data's (a prepass or bake writes it)
 */
export const sceneHeadWGSL = (struct, { data = false, access = 'read' } = {}) => `${struct.wgsl}
@group(${SCENE_GROUP}) @binding(${SCENE_BINDING.uniforms}) var<uniform> SU: ${struct.name};
${data ? `@group(${SCENE_GROUP}) @binding(${SCENE_BINDING.data}) var<storage, ${access}> SD: array<vec4u>;
fn sdWord(i: u32) -> u32 { return SD[i >> 2u][i & 3u]; }` : ''}
${SCENE_CELL_WGSL}`;

/**
 * The group-2 layout entries a scene's bindings take (before a kernel's own).
 * @param {{ data?: boolean, write?: boolean }} has write: the data read_write (a prepass, a bake)
 * @param {number} [visibility]
 */
export function sceneLayout({ data = false, write = false } = {}, visibility = STAGE.COMPUTE) {
  return [
    { binding: SCENE_BINDING.uniforms, visibility, buffer: { type: 'uniform' } },
    ...(data ? [{ binding: SCENE_BINDING.data, visibility, buffer: { type: write ? 'storage' : 'read-only-storage' } }] : []),
  ];
}

// A flat list of numbers as n vec4s (the GLSL's uniform vec4 arrays, packed by uniformStruct).
export const vec4s = (flat, n) => Array.from({ length: n }, (_, i) => [0, 1, 2, 3].map((c) => flat?.[4 * i + c] ?? 0));

// ---------------------------------------------------------------- the prepass
// The prepass region in the scene's data, at vec4 SU.uPreAt: a header (its
// low corner, world cells, and its size), then a word a cell, x fastest, then
// y, then z. The margin a region gets around what the sceneCell kernel
// covers (cells), unless the scene says otherwise (scene.pre.margin(P), per
// axis): the island's nature reads a cell's face and edge neighbours, one
// cell off along each axis.
export const PRE_MARGIN = 1;
/** Words a prepass region of `dims` cells takes in the data (with its header). */
export const preWords = (dims) => 8 + dims[0] * dims[1] * dims[2];
export const PreParams = uniformStruct('PreParams', { lo: 'vec3i', dims: 'vec3i' });
/**
 * WGSL of a prepass kernel: a thread a cell of the region writes
 * `fn(x, y, z)` (an i32) into it; thread 0 writes the header. After the
 * scene's head with its data read_write.
 * @param {string} fn the costly part's name (the scene's WGSL defines it)
 */
export const preMainWGSL = (fn) => /* wgsl */ `
${PreParams.wgsl}
@group(3) @binding(1) var<uniform> P: PreParams;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = (wg.x + wg.y * nwg.x) * 64u + li;
  let d = vec3u(P.dims);
  let base = SU.uPreAt * 4u;
  if (i == 0u) {
    SD[SU.uPreAt] = bitcast<vec4u>(vec4i(P.lo, 0));
    SD[SU.uPreAt + 1u] = bitcast<vec4u>(vec4i(P.dims, 0));
  }
  if (i >= d.x * d.y * d.z) { return; }
  let c = P.lo + vec3i(vec3u(i % d.x, (i / d.x) % d.y, i / (d.x * d.y)));
  let w = base + 8u + i;
  SD[w >> 2u][w & 3u] = bitcast<u32>(${fn}(c.x, c.y, c.z));
}
`;
/**
 * WGSL reading the prepass back: fn `name`(x, y, z) -> i32, the region's
 * word at world cell (x, y, z) (the scene keeps every query inside it: its
 * kernels' regions plus PRE_MARGIN).
 * @param {string} name
 */
export const preReadWGSL = (name) => /* wgsl */ `
fn ${name}(x: i32, y: i32, z: i32) -> i32 {
  let lo = bitcast<vec4i>(SD[SU.uPreAt]).xyz;
  let d = bitcast<vec4i>(SD[SU.uPreAt + 1u]).xyz;
  let r = clamp(vec3i(x, y, z) - lo, vec3i(0), d - 1);
  return bitcast<i32>(sdWord(SU.uPreAt * 4u + 8u + u32(r.x + d.x * (r.y + d.y * r.z))));
}
`;
