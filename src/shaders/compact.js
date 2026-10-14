// Shared presentation/legacy projection of the authoritative v2 payload.
// Whole-cell liquid dithering intentionally matches the old bridge. This is
// NOT a lossless save representation: fill, flux and fall state stay in v2.
export const compactDecodeWGSL = /* wgsl */ `
fn compactA(p: vec3i, c: vec4u) -> vec4f {
  let id = i32(c.x & 255u);
  let k = KIND(id);
  let T = f32((c.x >> 8u) & 65535u) * 0.25 - 273.25;
  let seed = f32(seed3(p, 0u, 991u) >> 16u) * (SEED_MAX / 65536.0);
  if (k == K_LIQUID) {
    if ((c.y & 0xffffffu) > (seed3(p, 0u, 4243u) >> 16u)) {
      return vec4f(f32(id), T, 0.0, f32(c.y >> 24u) + seed);
    }
    return vec4f(0.0, T, 0.0, seed);
  }
  if (k == K_EMPTY) { return vec4f(0.0, T, 0.0, seed); }
  return vec4f(f32(id), T, unpack2x16float(c.y).x,
    f32((c.y >> 16u) & 255u) + f32(c.w >> 16u) * (SEED_MAX / 65536.0));
}
`;
