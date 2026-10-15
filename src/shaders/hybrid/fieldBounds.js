import { MEDIA_FLOOR } from '../../gfx/materials.js';

// Exactly eight u32s; max is exclusive, expanded by two cells at reduction.
export const FIELD_BOUNDS_STRUCT = `struct FieldBounds { lo: vec3u, count: u32, hi: vec3u, reserved: u32 }`;
export const FIELD_BOUNDS_LAYOUT = [
  { binding: 0, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
  { binding: 1, buffer: { type: 'storage' } },
  { binding: 2, buffer: { type: 'storage' } },
];
export const fieldBoundsWGSL = /* wgsl */ `
${FIELD_BOUNDS_STRUCT}
@group(0) @binding(0) var field: texture_3d<f32>;
@group(0) @binding(1) var<storage, read_write> bricks: array<FieldBounds>;
@group(0) @binding(2) var<storage, read_write> bounds: FieldBounds;
var<workgroup> scratch: array<FieldBounds, 64>;
fn emptyBounds() -> FieldBounds { return FieldBounds(vec3u(0xffffffffu), 0u, vec3u(0u), 0u); }
fn mergeBounds(a: FieldBounds, b: FieldBounds) -> FieldBounds {
  return FieldBounds(min(a.lo, b.lo), a.count + b.count, max(a.hi, b.hi), 0u);
}
fn reduceBounds(lane: u32) {
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (lane < stride) { scratch[lane] = mergeBounds(scratch[lane], scratch[lane + stride]); }
    workgroupBarrier();
  }
}
// One WG64 per spatial 4³ brick: no per-texel global atomics.
@compute @workgroup_size(64) fn scan(@builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let dim = textureDimensions(field);
  let bd = (dim + 3u) / 4u;
  let id = wg.x + wg.y * nw.x;
  if (id >= bd.x * bd.y * bd.z) { return; }
  let brick = vec3u(id % bd.x, (id / bd.x) % bd.y, id / (bd.x * bd.y));
  let p = brick * 4u + vec3u(lane % 4u, (lane / 4u) % 4u, lane / 16u);
  var b = emptyBounds();
  if (all(p < dim)) {
    let m = textureLoad(field, vec3i(p), 0).xyz;
    if (any(m > vec3f(${MEDIA_FLOOR}))) { b = FieldBounds(p, 1u, p + 1u, 0u); }
  }
  scratch[lane] = b;
  reduceBounds(lane);
  if (lane == 0u) { bricks[id] = scratch[0]; }
}
// Bounded strided reduction of brick results, not another full field scan.
@compute @workgroup_size(64) fn finish(@builtin(local_invocation_index) lane: u32) {
  let dim = textureDimensions(field);
  let bd = (dim + 3u) / 4u;
  let n = bd.x * bd.y * bd.z;
  var b = emptyBounds();
  for (var i = lane; i < n; i += 64u) { b = mergeBounds(b, bricks[i]); }
  scratch[lane] = b;
  reduceBounds(lane);
  if (lane == 0u) {
    b = scratch[0];
    if (b.count == 0u) { b.lo = vec3u(0u); }
    else { b.lo = max(b.lo, vec3u(2u)) - 2u; b.hi = min(dim, b.hi + 2u); }
    bounds = b;
  }
}
`;
