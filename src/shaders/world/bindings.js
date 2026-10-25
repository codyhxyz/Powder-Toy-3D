// Group 2 of the world's render kernels (docs/seamless-world.md, "Bind groups"): F's fields
// (0-7), L's lighting (8-15, 20) and M's own four:
//   16 tMediaNoise   the media's 64³ detail noise (gfx/mediaNoise.js)
//   17 linearClamp   the clamping linear sampler
//   18 flow          physics' flow, per slot of the physics window (3 × f16 + 0)
//   19 aeration      physics' V2 cells, read as (core.x, core.y) pairs: the foam's aeration byte.
//                    Physics-window indexed like flow: read only inside sim.origin .. + window
//                    (march.js inPhys), zero elsewhere.
//   22 tMatTex       the scanned material textures (gfx/materialTextures.js: one 2d array) ...
//   23 matTexSampler ... and their repeating trilinear sampler, at L.LIGHTING's own numbers
//                    (shaders/bindings.js MAT_TEX_BINDING), read by shaders/gfx/surface.js matTextured
// Each list entry is [binding, WGSL name, WGSL type, layout entry body] (F's FIELDS_BINDINGS and
// L's LIGHT_BINDINGS have the same shape). A resource that's missing binds a dummy, never a gap.
import { STAGE } from '../common.js';
import { MAT_TEX_BINDING, MAT_TEX_SAMPLER_BINDING } from '../bindings.js';

const READERS = STAGE.FRAGMENT | STAGE.COMPUTE;
export const M_BINDINGS = [
  [16, 'tMediaNoise', 'texture_3d<f32>', { visibility: READERS, texture: { sampleType: 'float', viewDimension: '3d' } }],
  [17, 'linearClamp', 'sampler', { visibility: READERS, sampler: { type: 'filtering' } }],
  [18, 'flow', 'array<vec2u>', { visibility: READERS, buffer: { type: 'read-only-storage' } }],
  [19, 'aeration', 'array<vec2u>', { visibility: READERS, buffer: { type: 'read-only-storage' } }],
  [MAT_TEX_BINDING, 'tMatTex', 'texture_2d_array<f32>', { visibility: READERS, texture: { sampleType: 'float', viewDimension: '2d-array' } }],
  [MAT_TEX_SAMPLER_BINDING, 'matTexSampler', 'sampler', { visibility: READERS, sampler: { type: 'filtering' } }],
];

/** The whole of group 2: F's, L's and M's entries, by binding; throws on a clash. */
export function worldGroup2(fieldsBindings, lightBindings) {
  const all = [...fieldsBindings, ...lightBindings, ...M_BINDINGS].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < all.length; i++) {
    if (all[i][0] === all[i - 1][0]) throw new Error(`world group 2: binding ${all[i][0]} is both ${all[i - 1][1]} and ${all[i][1]}`);
  }
  return all;
}

const declare = ([n, name, type, body]) => (body.sampler
  ? `@group(2) @binding(${n}) var ${name}: sampler;`
  : body.buffer
    ? (body.buffer.type === 'uniform'
      ? `@group(2) @binding(${n}) var<uniform> ${name}: ${type};`
      : `@group(2) @binding(${n}) var<storage, ${body.buffer.type === 'storage' ? 'read_write' : 'read'}> ${name}: ${type};`)
    : `@group(2) @binding(${n}) var ${name}: ${type};`);

/** WGSL declarations of group 2 (the uniforms' structs are their owners' WGSL). */
export const worldGroup2WGSL = (list) => list.map(declare).join('\n');

/** The layout entries (GPUBindGroupLayoutEntry) of group 2. */
export const worldGroup2Layout = (list) => list.map(([binding, , , body]) => ({ binding, ...body }));

/**
 * Group 2's entries: F's and L's bindEntries(), and M's from the frame, a dummy where one is missing.
 * @param {object[]} list worldGroup2(...)
 * @param {{ fields: object[], light: object[], noise: GPUTextureView, clamp: GPUSampler, flow?: GPUBuffer,
 *   cells?: GPUBuffer, matTex: { view: GPUTextureView, sampler: GPUSampler },
 *   dummy: { buffer: GPUBuffer, tex3d: GPUTextureView, tex2d: GPUTextureView } }} r
 */
export function worldGroup2Entries(list, { fields, light, noise, clamp, flow, cells, matTex, dummy }) {
  const by = new Map([...fields, ...light].filter((e) => e.resource).map((e) => [e.binding, e]));
  by.set(16, { binding: 16, resource: noise });
  by.set(17, { binding: 17, resource: clamp });
  by.set(18, { binding: 18, resource: { buffer: flow ?? dummy.buffer } });
  by.set(19, { binding: 19, resource: { buffer: cells ?? dummy.buffer } });
  // (always bound: gfx/materialTextures.js's array exists from the start, a one-layer stand-in until the photos load)
  by.set(MAT_TEX_BINDING, { binding: MAT_TEX_BINDING, resource: matTex.view });
  by.set(MAT_TEX_SAMPLER_BINDING, { binding: MAT_TEX_SAMPLER_BINDING, resource: matTex.sampler });
  return list.map(([binding, , type, body]) => by.get(binding) ?? { binding, resource:
    body.buffer ? { buffer: dummy.buffer } : body.sampler ? clamp : type.startsWith('texture_2d') ? dummy.tex2d : dummy.tex3d });
}
