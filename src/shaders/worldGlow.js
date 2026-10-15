import { glowBlurWeightsWGSL, glowBlurWGSL } from './passes.js';

export const WORLD_GLOW_AXES = Object.freeze([0, 1, 2, 0, 1, 2]);
export const WORLD_GLOW_SUPPORT = Object.freeze({ emissionBricks: 4, rawCells: 17, shadingCells: 26 });
export function worldGlowLayouts({ last = false } = {}) {
  const buffer = (binding, type, minBindingSize) => ({ binding, visibility: 4, buffer: { type, minBindingSize } });
  return [[buffer(0, 'uniform', 96), buffer(1, 'read-only-storage', 16), buffer(2, 'storage', 16), buffer(3, 'storage', 4),
    ...(last ? [{ binding: 4, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } }] : [])]];
}
export function worldGlow({ last = false } = {}) { return /* wgsl */ `
struct GlowParams {
  inputMin: vec4i, inputSize: vec4u, outputMin: vec4i,
  outputSize: vec4u, world: vec3i, axis: u32, status: vec4u,
}
@group(0) @binding(0) var<uniform> P: GlowParams;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> feedback: array<atomic<u32>>;
${last ? '@group(0) @binding(4) var outGlow: texture_storage_2d_array<rgba16float, write>;' : ''}
${glowBlurWeightsWGSL}
fn glowLoad(q: vec3i) -> vec3f {
  let c = q - P.inputMin.xyz;
  if (any(c < vec3i(0)) || any(c >= vec3i(P.inputSize.xyz))) {
    // An in-world missing halo is NEVER zero. Whole candidate is withheld.
    atomicOr(&feedback[P.status.x], 3u); return vec3f(0.0);
  }
  return src[u32(c.x) + P.inputSize.x * (u32(c.y) + P.inputSize.y * u32(c.z))].rgb;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.outputSize.w) { return; }
  let c = vec3u(i % P.outputSize.x, (i / P.outputSize.x) % P.outputSize.y, i / (P.outputSize.x * P.outputSize.y));
  let bc = P.outputMin.xyz + vec3i(c);
${glowBlurWGSL({ lookup: 'glowLoad(q)', hi: 'P.world - 1', store: `dst[i] = vec4f(s * LIGHT_BLUR_GAIN, 1.0);${last ? '\n  textureStore(outGlow, vec2i(i32(i % 256u), i32(i / 256u)), 0, dst[i]);' : ''}` })}
  atomicOr(&feedback[P.status.x], 1u);
}`; }
export const WGSL_CHECK = () => [false, true].map(last => ({ name: `worldGlow.${last ? 'final' : 'float'}`,
  kind: 'compute', grids: false, warm: false, code: () => worldGlow({ last }), layouts: () => worldGlowLayouts({ last }),
  workgroupSize: [64, 1, 1], dispatch: () => [1, 1, 1] }));
