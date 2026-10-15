// Leaf adapters only. The full surface/root/material/optical bodies stay shared.
import { brickInfoWGSL } from '../bindings.js';
export function renderBackend(backend = 'box') {
  if (backend !== 'box' && backend !== 'world') throw new Error(`render backend: ${backend}`);
  return backend;
}
export const worldCoreBindingsWGSL = /* wgsl */ `
${brickInfoWGSL}
@group(3) @binding(2) var linearClamp: sampler;
@group(3) @binding(3) var linearRepeat: sampler;
fn fetchA(c: vec3i) -> vec4f { return worldFetchA(c); }
fn fetchB(c: vec3i) -> vec4f { return worldFetchB(c); }
fn brickAt(b: vec3i) -> BrickInfo { let w = worldBrickInfo(b); return BrickInfo(w.emit, w.info); }
fn brickDistAt(b: vec3i) -> i32 { return worldBrickDistance(b); }
`;
export const worldOccupancyWGSL = /* wgsl */ `
// Conservative candidates, EXACT raw ids. Occupancy k is xyz-linear, NOT
// the source's raw slot and never a physical atlas page id.
fn occMaskOf(id: u32) -> vec2u { return vec2u(0xffffffffu); }
fn occBitOf(c: vec3i) -> u32 { let l = vec3u(c & vec3i(3)); return l.x | (l.y << 2u) | (l.z << 4u); }
fn occHas(m: vec2u, k: u32) -> bool { return ((select(m.x, m.y, k >= 32u) >> (k & 31u)) & 1u) != 0u; }
fn occIdOf(id: u32, k: u32) -> i32 {
  let c = brickCoord(id) * 4 + vec3i(i32(k & 3u), i32((k >> 2u) & 3u), i32(k >> 4u));
  return eid(fetchA(c));
}
fn occCellId(m: vec2u, id: u32, c: vec3i) -> i32 { return eid(fetchA(c)); }
`;
export const worldFieldWGSL = /* wgsl */ `
fn fieldTex(t: texture_2d_array<f32>, p: vec3f) -> vec4f { return worldFieldLinear(t, p); }
fn fieldCubic(t: texture_2d_array<f32>, p: vec3f) -> vec4f { return worldFieldCubic(t, p); }
fn surfField(p: vec3f) -> vec4f { return fieldTex(tFS, p); }
fn mediaField(p: vec3f) -> vec4f { return fieldTex(tFM, p); }
`;
