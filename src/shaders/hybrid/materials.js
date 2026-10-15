import { STAGE } from '../../gpu/kernels.js';

export const HYBRID_MATERIAL_ROW_BYTES = 80;
function config({ group = 2, binding = 0, detailLod = 0, includeStruct = true } = {}) {
  if (!Number.isInteger(group) || group < 0 || group > 3) throw new RangeError('material group must be 0..3');
  if (!Number.isInteger(binding) || binding < 0 || binding > 996) throw new RangeError('invalid material binding');
  if (!Number.isFinite(detailLod) || detailLod < 0) throw new RangeError('invalid material detail LOD');
  return { group, binding, detailLod, includeStruct };
}
export function hybridMaterialLayoutEntries(options = {}) {
  const { binding } = config(options), visibility = STAGE.FRAGMENT | STAGE.COMPUTE;
  return [
    { binding, visibility, buffer: { type: 'read-only-storage' } },
    ...[1, 2].map(i => ({ binding: binding + i, visibility, texture: { sampleType: 'float', viewDimension: '2d-array' } })),
    { binding: binding + 3, visibility, sampler: { type: 'filtering' } },
  ];
}
export function hybridMaterialEntries(resources, options = {}) {
  const { binding } = config(options);
  if (!resources?.table || !resources.albedo || !resources.normal || !resources.sampler) throw new TypeError('incomplete material resources');
  return [resources.table, resources.albedo, resources.normal, resources.sampler].map((resource, i) => ({
    binding: binding + i, resource: i === 0 ? { buffer: resource } : resource,
  }));
}
export function hybridDetailLod(footprint, repeats, size, levels) {
  if (![footprint, repeats, size, levels].every(Number.isFinite) || footprint < 0 || repeats <= 0 || size <= 0 || levels < 1) {
    throw new RangeError('invalid material footprint');
  }
  return Math.min(levels - 1, Math.max(0, Math.log2(Math.max(footprint * repeats * size, 1))));
}

// Requires the engine prelude and materialsGLSL() for live emission functions.
// Explicit LOD keeps this callable from divergent ray hits and compute shaders.
export function hybridMaterialsWGSL(options = {}) {
  const c = config(options);
  return /* wgsl */ `
${c.includeStruct ? `struct HybridMaterial {
  baseColor: vec3f, roughness: f32, metalness: f32, emission: vec3f,
  opacity: f32, normal: vec3f, f0: vec3f,
}` : ''}
struct HybridMaterialRow {
  colorRough: vec4f, emitMetal: vec4f, detail: vec4f, optical: vec4f, state: vec4f,
}
@group(${c.group}) @binding(${c.binding}) var<storage, read> hmRows: array<HybridMaterialRow>;
@group(${c.group}) @binding(${c.binding + 1}) var hmColor: texture_2d_array<f32>;
@group(${c.group}) @binding(${c.binding + 2}) var hmNormal: texture_2d_array<f32>;
@group(${c.group}) @binding(${c.binding + 3}) var hmSampler: sampler;
fn hybridMaterialRow(id: i32) -> HybridMaterialRow {
  return hmRows[u32(clamp(id, 0, i32(arrayLength(&hmRows)) - 1))];
}
fn hybridMaterialFootprintLod(id: i32, footprint: f32) -> f32 {
  let r = hybridMaterialRow(id);
  return clamp(log2(max(footprint * r.detail.y * f32(textureDimensions(hmColor).x), 1.0)),
    0.0, f32(textureNumLevels(hmColor) - 1u));
}
fn hybridMaterialStateLod(id: i32, seed: f32, p: vec3f, normal: vec3f, temperature: f32, ctype: i32, lod: f32) -> HybridMaterial {
  let r = hybridMaterialRow(id);
  let ng = normal * inverseSqrt(max(dot(normal, normal), 1e-12));
  let weights = abs(ng) / max(dot(abs(ng), vec3f(1.0)), 1e-8);
  let level = clamp(lod, 0.0, f32(textureNumLevels(hmColor) - 1u));
  let uv = p * r.detail.y;
  let layer = i32(r.detail.x);
  let cx = textureSampleLevel(hmColor, hmSampler, uv.yz, layer, level);
  let cy = textureSampleLevel(hmColor, hmSampler, uv.zx, layer, level);
  let cz = textureSampleLevel(hmColor, hmSampler, uv.xy, layer, level);
  let nx = textureSampleLevel(hmNormal, hmSampler, uv.yz, layer, level);
  let ny = textureSampleLevel(hmNormal, hmSampler, uv.zx, layer, level);
  let nz = textureSampleLevel(hmNormal, hmSampler, uv.xy, layer, level);
  let detail = cx * weights.x + cy * weights.y + cz * weights.z;
  let variance = (nx.a * weights.x + ny.a * weights.y + nz.a * weights.z) * 0.25;
  let dx = nx.rgb * 2.0 - 1.0;
  let dy = ny.rgb * 2.0 - 1.0;
  let dz = nz.rgb * 2.0 - 1.0;
  let bump = vec3f(sign(ng.x) * dx.z, dx.x, dx.y) * weights.x
    + vec3f(dy.y, sign(ng.y) * dy.z, dy.x) * weights.y
    + vec3f(dz.x, dz.y, sign(ng.z) * dz.z) * weights.z;
  let mapped = mix(ng, bump, clamp(r.detail.z, 0.0, 1.0));
  let n = mapped * inverseSqrt(max(dot(mapped, mapped), 1e-12));
  let tone = 1.0 + r.optical.w * (clamp(seed, 0.0, 1.0) * 2.0 - 1.0);
  let base = clamp(r.colorRough.rgb * tone * mix(vec3f(1.0), detail.rgb * 2.0, clamp(r.detail.w, 0.0, 1.0)), vec3f(0.0), vec3f(1.0));
  let multiplier = pow(max(detail.a, 0.0), 0.25) / 0.8;
  let rough = clamp(pow(pow(clamp(r.colorRough.a * multiplier, 0.0, 1.0), 4.0) + variance, 0.25), 0.04, 1.0);
  let metal = clamp(r.emitMetal.a, 0.0, 1.0);
  let emission = cellEmission(id, temperature, f32(ctype) + clamp(seed, 0.0, 0.999)) + sparkEmit(id, f32(ctype) + clamp(seed, 0.0, 0.999));
  return HybridMaterial(base, rough, metal, emission, r.optical.x, n, mix(vec3f(r.optical.y), base, metal));
}
fn hybridMaterialLod(id: i32, seed: f32, p: vec3f, n: vec3f, temperature: f32, lod: f32) -> HybridMaterial {
  return hybridMaterialStateLod(id, seed, p, n, temperature, 0, lod);
}
fn hybridMaterialState(id: i32, seed: f32, p: vec3f, n: vec3f, temperature: f32, ctype: i32) -> HybridMaterial {
  return hybridMaterialStateLod(id, seed, p, n, temperature, ctype, ${c.detailLod.toFixed(6)});
}
fn hybridMaterial(id: i32, seed: f32, p: vec3f, n: vec3f, temperature: f32) -> HybridMaterial {
  return hybridMaterialLod(id, seed, p, n, temperature, ${c.detailLod.toFixed(6)});
}
`;
}
