// Shared sun-map ABI. Positions, normals and sun are physical grid-space,
// not FU.model's display-space. Both opaque and smooth receivers use this
// same visibility; multiply only direct sun radiance, not sky/emission/GI.
import { uniformStruct } from '../../gpu/params.js';

export const SHADOW_FORMAT = 'depth32float';
export const ShadowDrawParams = uniformStruct('HybridShadowDrawParams', { matrix: 'mat4x4f' });
export const ShadowUniforms = uniformStruct('HybridShadowUniforms', {
  matrix: 'mat4x4f',
  sun: 'vec3f', texel: 'f32',
  depthScale: 'f32', enabled: 'u32', resolution: 'f32', normalBias: 'f32',
  depthBias: 'f32',
});

/** Caster pipeline descriptor; use gpu.renderPipeline once, await its ready.
 * drawShadow(rp, {matrix}) packs ShadowDrawParams into the engine's params
 * ring. No FrameUniforms change, geometry ownership, or submission is needed.
 * No culling: thin/two-sided surfaces must cast too. Bias is receiver-side in
 * grid units, avoiding depth32float implementation-dependent raster bias.
 */
export function shadowPipelineState(entry = 'vsShadow') {
  return {
    vertex: { entry }, fragment: null,
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less-equal' },
  };
}

/** Append to a caster's vertex shader; call hybridShadowPosition(grid). */
export function shadowCasterWGSL() {
  return /* wgsl */ `${ShadowDrawParams.wgsl}
@group(3) @binding(1) var<uniform> hybridShadowDraw: HybridShadowDrawParams;
fn hybridShadowPosition(grid: vec3f) -> vec4f {
  return hybridShadowDraw.matrix * vec4f(grid, 1.0);
}
`;
}

function slots(group, binding) {
  if (!Number.isInteger(group) || group < 0 || group > 2 || !Number.isInteger(binding) || binding < 0) {
    throw new RangeError('hybrid shadows: use group 0..2 (3 is the params ring), binding >= 0');
  }
}

/** Explicit receiver layout entries, starting at binding (depth, compare, uniform). */
export function shadowBindingDescriptors({ group = 2, binding = 0 } = {}) {
  slots(group, binding);
  return [
    { binding, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
    { binding: binding + 1, visibility: 2, sampler: { type: 'comparison' } },
    { binding: binding + 2, visibility: 2, buffer: { type: 'uniform', minBindingSize: ShadowUniforms.size } },
  ];
}

/** Append once to receiver WGSL. hybridSunVisibility(grid, gridNormal) returns
 * deterministic four-tap bilinear PCF [0,1], or 1 outside the bounded map.
 * WebGPU clip depth is [0,1]; texture y is opposite clip y. Normal offset is
 * capped at half a cell so coarse maps do not detach thin voxel contacts.
 */
export function shadowReceiverWGSL({ group = 2, binding = 0 } = {}) {
  slots(group, binding);
  return /* wgsl */ `${ShadowUniforms.wgsl}
@group(${group}) @binding(${binding}) var hybridShadowMap: texture_depth_2d;
@group(${group}) @binding(${binding + 1}) var hybridShadowSampler: sampler_comparison;
@group(${group}) @binding(${binding + 2}) var<uniform> hybridShadow: HybridShadowUniforms;
fn hybridSunVisibility(grid: vec3f, gridNormal: vec3f) -> f32 {
  if (hybridShadow.enabled == 0u) { return 1.0; }
  let n = gridNormal / max(length(gridNormal), 0.00001);
  let slope = 1.0 - clamp(dot(n, hybridShadow.sun), 0.0, 1.0);
  let offset = min(0.5, hybridShadow.normalBias * hybridShadow.texel) * slope;
  let p = hybridShadow.matrix * vec4f(grid + n * offset, 1.0);
  if (any(abs(p.xy) > vec2f(1.0)) || p.z < 0.0 || p.z > 1.0) { return 1.0; }
  let uv = p.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  let z = p.z - hybridShadow.depthBias * (1.0 + slope) * hybridShadow.depthScale;
  let d = 0.5 / hybridShadow.resolution;
  return 0.25 * (
    textureSampleCompareLevel(hybridShadowMap, hybridShadowSampler, uv + vec2f(-d, -d), z) +
    textureSampleCompareLevel(hybridShadowMap, hybridShadowSampler, uv + vec2f( d, -d), z) +
    textureSampleCompareLevel(hybridShadowMap, hybridShadowSampler, uv + vec2f(-d,  d), z) +
    textureSampleCompareLevel(hybridShadowMap, hybridShadowSampler, uv + vec2f( d,  d), z));
}
`;
}

export const IDENTITY_MODEL = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Validate display model. The current FU.sun is physical grid-space; this
 * map supports positive uniform axis-aligned grid -> display transforms only.
 * Rotations/shear/nonuniform or reflected scales need explicit lighting-space
 * direction conversion throughout the renderer, so parent must use fallback.
 * Accepts column-major arrays/typed arrays or a three Matrix4.
 */
export function shadowModel(model = IDENTITY_MODEL) {
  const m = Array.from(model?.elements ?? model ?? []);
  if (m.length !== 16 || !m.every(Number.isFinite)) throw new TypeError('hybrid shadows: model needs 16 finite column-major components');
  const s = m[0], epsilon = Math.abs(s) * 1e-7;
  if (!(s > 0) || Math.abs(m[5] - s) > epsilon || Math.abs(m[10] - s) > epsilon ||
      [1, 2, 4, 6, 8, 9].some((i) => Math.abs(m[i]) > epsilon) ||
      m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) {
    throw new RangeError('hybrid shadows: unsupported model rotation/shear/nonuniform/reflected scale; use legacy fallback');
  }
  return m;
}

/** Array/typed-array/three Vector3 -> finite components. */
export function shadowVector(v, name) {
  const a = Array.from({ length: 3 }, (_, i) => v?.[i] ?? v?.[['x', 'y', 'z'][i]]);
  if (!a.every(Number.isFinite)) throw new TypeError(`hybrid shadows: ${name} needs three finite components`);
  return a;
}

/** Camera-independent, texel-snapped orthographic grid -> sun clip matrix.
 * Padding encloses bevel/smooth displacement and the receiver's normal bias.
 * Mirrors blocks.sunMatrix's light basis and [0,1] depth, adding snapped
 * centers and a texel guard so snapping cannot clip a grid corner.
 */
export function shadowProjection(sun, size, resolution, padding = 1) {
  const light = shadowVector(sun, 'sun');
  const n = shadowVector(size, 'size');
  const len = Math.hypot(...light);
  if (!(len > 0) || !Number.isFinite(len) || !n.every((x) => x > 0) || !Number.isInteger(resolution) || resolution < 4 || !Number.isFinite(padding) || padding < 0) {
    throw new RangeError('hybrid shadows: nonzero sun, positive size, resolution >= 4, padding >= 0 required');
  }
  const unit = light.map((x) => x / len), f = unit.map((x) => -x);
  const up = Math.abs(f[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const r0 = cross(f, up), rl = Math.hypot(...r0), r = r0.map((x) => x / rl), u = cross(r, f);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const p = n.map((x, i) => (k & (1 << i)) ? x + padding : -padding);
    [r, u, f].forEach((a, i) => { const d = dot(a, p); lo[i] = Math.min(lo[i], d); hi[i] = Math.max(hi[i], d); });
  }
  // Reserve a texel on each side, then snap without changing the extent.
  const spans = [0, 1].map((i) => (hi[i] - lo[i]) * resolution / (resolution - 2));
  const texels = spans.map((x) => x / resolution);
  const center = [0, 1].map((i) => Math.round((hi[i] + lo[i]) * 0.5 / texels[i]) * texels[i]);
  const dz = hi[2] - lo[2];
  const rows = [
    [...r.map((x) => 2 * x / spans[0]), -2 * center[0] / spans[0]],
    [...u.map((x) => 2 * x / spans[1]), -2 * center[1] / spans[1]],
    [...f.map((x) => x / dz), -lo[2] / dz],
    [0, 0, 0, 1],
  ];
  const matrix = Array.from({ length: 16 }, (_, i) => rows[i % 4][Math.floor(i / 4)]);
  return { matrix, sun: unit, texel: Math.max(...texels), depthScale: 1 / dz };
}
