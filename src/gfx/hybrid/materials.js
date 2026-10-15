import { ELEMENTS, E, K, R } from '../../elements.js';
import { LOOK, SURFS } from '../materials.js';
import { CONDUCTS } from '../../electricity.js';
import { CELL_M } from '../../scale.js';
import {
  HYBRID_MATERIAL_ROW_BYTES, hybridMaterialLayoutEntries, hybridMaterialEntries,
  hybridMaterialsWGSL,
} from '../../shaders/hybrid/materials.js';

/** Small, shared, tileable detail families; these are not per-element palettes.
 * Element identity, linear reflectance, metalness and emission come from LOOK.
 * Tile lengths are metres, converted to grid cells using the existing CELL_M.
 */
export const HYBRID_DETAIL_FAMILIES = Object.freeze([
  { name: 'plain', metres: 0.6, height: 0.001 },
  { name: 'grain', metres: 0.18, height: 0.004 },
  { name: 'stone', metres: 1.2, height: 0.006 },
  { name: 'wood', metres: 0.8, height: 0.004 },
  { name: 'brushed', metres: 0.24, height: 0.0015 },
  { name: 'polished', metres: 0.35, height: 0.0005 },
  { name: 'organic', metres: 0.4, height: 0.003 },
]);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const byte = (v) => Math.round(clamp(v) * 255);
function hash(x, y, seed) {
  let v = (Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ seed) >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}
// Periodic smooth value noise, used ONCE on the CPU, never in a hot shader.
function noise(u, v, frequency, seed) {
  const x = u * frequency, y = v * frequency, ix = Math.floor(x), iy = Math.floor(y);
  const sx = x - ix, sy = y - iy, tx = sx * sx * (3 - 2 * sx), ty = sy * sy * (3 - 2 * sy);
  const h = (dx, dy) => hash((ix + dx) % frequency, (iy + dy) % frequency, seed);
  return (h(0, 0) * (1 - tx) + h(1, 0) * tx) * (1 - ty) +
    (h(0, 1) * (1 - tx) + h(1, 1) * tx) * ty;
}
function familyOf(e, look) {
  if (SURFS[look.surf] === 'BRUSHED') return 4;
  if (SURFS[look.surf] === 'POLISHED') return 5;
  if (SURFS[look.surf] === 'CRAG') return 2;
  if (['WOOD', 'SAWDUST', 'FUSE'].includes(e.key)) return 3;
  if (look.ch === 3 || ['PLANT', 'MOSS', 'FUNGUS', 'MEAT', 'COOKED_MEAT'].includes(e.key)) return 6;
  if (e.kind === K.POWDER) return 1;
  return 0;
}

/** Pure table builder. ABI: five vec4f per element, 80-byte storage stride.
 * colorRough = linear RGB, perceptual roughness; emitMetal = radiance, metalness;
 * detail = array layer, repeats/cell, bump strength, albedo variation strength;
 * optical = coverage opacity, dielectric F0, skin temperature drop (C), seed tone;
 * state = melt point (C), conducts, render class, reserved.
 * Opacity is coverage, NOT Beer-Lambert transmission: optical/media lanes must
 * integrate existing sigma/scatter; water and glass still have full coverage.
 */
export function buildHybridMaterialTable() {
  const data = new Float32Array(ELEMENTS.length * HYBRID_MATERIAL_ROW_BYTES / 4);
  for (const e of ELEMENTS) {
    const l = LOOK[e.id], layer = familyOf(e, l), f = HYBRID_DETAIL_FAMILIES[layer];
    const surface = e.render === R.OPAQUE || e.render === R.LIQUID || e.render === R.GLASS;
    const detail = surface && e.id !== E.LAVA && e.id !== E.CRYSTAL && e.id !== E.SINGULARITY;
    const f0 = ((l.ior - 1) / (l.ior + 1)) ** 2;
    data.set([
      ...l.alb, l.rough, ...l.emit, l.metal,
      layer, CELL_M / f.metres, detail ? 1 : 0, detail ? l.macro[0] : 0,
      surface ? 1 : 0, f0, e.id === E.METAL ? 0 : 200, detail ? e.var : 0,
      e.melt, +CONDUCTS[e.id], e.render, 0,
    ], e.id * 20);
  }
  return data;
}

/** Float-domain 2x2 mip filter, before any byte encoding. Color is linear;
 * roughness contains the fourth moment (GGX perceptual roughness^4); normal
 * contains UNNORMALIZED mean unit vectors, retaining all subpixel dispersion.
 * Never renormalize those means between levels: that loses prior variance.
 */
export function filterHybridDetailMip({ width, height, color, normal }) {
  if (width < 2 || height < 2 || width % 2 || height % 2) throw new RangeError('Mip source must have even dimensions >= 2');
  const w = width / 2, h = height / 2;
  const c = new Float32Array(w * h * 4), n = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dest = x + y * w;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const src = x * 2 + dx + (y * 2 + dy) * width;
      for (let k = 0; k < 4; k++) c[dest * 4 + k] += color[src * 4 + k] * 0.25;
      for (let k = 0; k < 3; k++) n[dest * 3 + k] += normal[src * 3 + k] * 0.25;
    }
  }
  return { width: w, height: h, color: c, normal: n };
}
function encodeMip(mip) {
  const albedoRoughness = new Uint8Array(mip.width * mip.height * 4);
  const normalVariance = new Uint8Array(albedoRoughness.length);
  for (let p = 0; p < mip.width * mip.height; p++) {
    for (let k = 0; k < 3; k++) albedoRoughness[p * 4 + k] = byte(mip.color[p * 4 + k] / 2);
    albedoRoughness[p * 4 + 3] = byte(mip.color[p * 4 + 3]);
    const x = mip.normal[p * 3], y = mip.normal[p * 3 + 1], z = mip.normal[p * 3 + 2];
    const length = Math.hypot(x, y, z);
    for (let k = 0; k < 3; k++) normalVariance[p * 4 + k] = byte((mip.normal[p * 3 + k] / (length || 1) + 1) / 2);
    // 0..0.25 variance; small slopes need more precision than 1/255.
    normalVariance[p * 4 + 3] = byte((1 - length) * 4);
  }
  return { width: mip.width, height: mip.height, albedoRoughness, normalVariance };
}

/** Deterministic, real texture bytes with a complete explicitly filtered mip
 * chain, default 64^2 x 7 layers x two rgba8unorm arrays (~299 KiB total).
 * No sRGB texture decoding: RGB stores LINEAR detail multipliers / 2.
 * Alpha stores (roughness multiplier * 0.8)^4, not encoded color/alpha.
 */
export function buildHybridDetailAtlas({ size = 64, seed = 0x68bc21eb } = {}) {
  if (!Number.isInteger(size) || size < 8 || size > 256 || (size & (size - 1))) throw new RangeError('Detail size must be a power of two in [8, 256]');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Detail seed must be a u32');
  const layers = HYBRID_DETAIL_FAMILIES.map((f, layer) => {
    const heights = new Float32Array(size * size), color = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, p = x + y * size, salt = (seed ^ Math.imul(layer + 1, 7919)) >>> 0;
      const a = noise(u, v, 4, salt), b = noise(u, v, 8, salt ^ 213), c = noise(u, v, 16, salt ^ 917);
      let h = a * 0.55 + b * 0.3 + c * 0.15;
      if (layer === 1) h = b * 0.35 + c * 0.65;
      if (layer === 3) h = 0.5 + 0.3 * Math.sin(2 * Math.PI * (u * 8 + a * 0.4)) + (b - 0.5) * 0.15;
      if (layer === 4) h = noise(u, v, 16, salt) * 0.2 + noise(u, v / 8, 8, salt ^ 1) * 0.1 + 0.35;
      // The brushed term must also wrap in y; its long streak is constant y.
      if (layer === 4) h = 0.5 + 0.3 * Math.sin(2 * Math.PI * (u * 16 + noise(u, v, 2, salt) * 0.2));
      heights[p] = h;
      const tone = (h - 0.5) * 2, tint = (b - 0.5) * 0.1;
      color.set([1 + tone + tint, 1 + tone, 1 + tone - tint, (0.8 + (c - 0.5) * 0.24) ** 4], p * 4);
    }
    const normal = new Float32Array(size * size * 3);
    const at = (x, y) => heights[((y + size) % size) * size + (x + size) % size];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * size * f.height / f.metres * 0.5;
      const dy = (at(x, y + 1) - at(x, y - 1)) * size * f.height / f.metres * 0.5;
      const length = Math.hypot(dx, dy, 1);
      normal.set([-dx / length, -dy / length, 1 / length], (x + y * size) * 3);
    }
    let mip = { width: size, height: size, color, normal };
    const levels = [];
    for (;;) {
      levels.push(encodeMip(mip));
      if (mip.width === 1) break;
      mip = filterHybridDetailMip(mip);
    }
    return levels;
  });
  const mipLevelCount = layers[0].length;
  return { size, seed, layers, mipLevelCount, byteLength: layers.flat().reduce((n, m) => n + m.albedoRoughness.byteLength + m.normalVariance.byteLength, 0) };
}

/** Explicit scene-level capability gate. Parent MUST keep source/painted
 * scenes on the legacy renderer unless it independently adapts those layers.
 * Data views likewise belong to their existing renderer, not these PBR rows.
 */
export function hybridMaterialCapabilities({ sourceAppearance = false, decoration = false, dataView = false } = {}) {
  const reasons = [];
  if (sourceAppearance) reasons.push('source appearance requires the legacy source-material adapter');
  if (decoration) reasons.push('visible decoration requires the legacy decoration adapter');
  if (dataView) reasons.push('data views are not PBR materials');
  return { supported: reasons.length === 0, reasons };
}

/** Resource-only subsystem: no pipelines, dispatch, simulation bindings or
 * per-frame work. createHybridMaterials(gpu, sim, {size?, seed?}); sim unused.
 * await .ready, concatenate .shader({group,binding,includeStruct?}), merge
 * .layoutEntries({binding}) into an explicit fragment layout and .entries(...)
 * into its bind group. Four bindings: table/storage, two 2d-array float
 * textures, filtering sampler. Call hybridMaterialState(..., floor(A.w)) for
 * lava/electric lamps/conductors; simple wrapper assumes ctype=0. The f32 seed
 * is fract(A.w), positions/normals are grid-space; shade returned straight
 * linear baseColor and emission, then premultiply lit output by opacity once.
 * .update() returns false: immutable rows/atlas survive shifts, edits and grid
 * replacement; recreate after device loss. Dispose only after last use.
 */
export function createHybridMaterials(gpu, _sim, options = {}) {
  const atlas = buildHybridDetailAtlas(options), rows = buildHybridMaterialTable();
  let table, albedo, normal, disposed = false;
  try {
    table = gpu.createBuffer({ label: 'hybrid material rows', size: rows.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    gpu.queue.writeBuffer(table, 0, rows);
    const desc = { size: [atlas.size, atlas.size, atlas.layers.length], dimension: '2d', format: 'rgba8unorm', mipLevelCount: atlas.mipLevelCount, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST };
    albedo = gpu.createTexture({ ...desc, label: 'hybrid linear albedo roughness' });
    normal = gpu.createTexture({ ...desc, label: 'hybrid normal variance' });
    for (let layer = 0; layer < atlas.layers.length; layer++) for (let mipLevel = 0; mipLevel < atlas.mipLevelCount; mipLevel++) {
      const m = atlas.layers[layer][mipLevel], layout = { bytesPerRow: m.width * 4, rowsPerImage: m.height };
      // queue.writeTexture permits tight rows (unlike buffer-to-texture copies).
      gpu.queue.writeTexture({ texture: albedo, origin: [0, 0, layer], mipLevel }, m.albedoRoughness, layout, [m.width, m.height, 1]);
      gpu.queue.writeTexture({ texture: normal, origin: [0, 0, layer], mipLevel }, m.normalVariance, layout, [m.width, m.height, 1]);
    }
    const resources = {
      table, albedo: albedo.createView({ dimension: '2d-array' }), normal: normal.createView({ dimension: '2d-array' }),
      sampler: gpu.device.createSampler({ label: 'hybrid detail trilinear', addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }),
    };
    const assertLive = () => { if (disposed) throw new Error('Hybrid materials disposed'); };
    const api = {
      ready: Promise.resolve(),
      get isReady() { return !disposed; },
      get stats() { return { rows: ELEMENTS.length, layers: atlas.layers.length, mipLevels: atlas.mipLevelCount, bytes: disposed ? 0 : rows.byteLength + atlas.byteLength }; },
      shader: hybridMaterialsWGSL,
      layoutEntries: hybridMaterialLayoutEntries,
      entries(bindingOptions) { assertLive(); return hybridMaterialEntries(resources, bindingOptions); },
      update() { assertLive(); return false; },
      dispose() { if (disposed) return; disposed = true; table.destroy(); albedo.destroy(); normal.destroy(); },
    };
    return api;
  } catch (error) {
    table?.destroy(); albedo?.destroy(); normal?.destroy();
    throw error;
  }
}
