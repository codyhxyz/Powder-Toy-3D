import { definesGLSL, jsConstants } from '../scenes/themedShared.js';

// Noise for the island's landforms and strata (landforms.js, strata.js), in
// the shared GLSL subset (scenes/themedShared.js): gradient noise on the world
// seed's hash lattice (thLattice), one octave per call, in lattice units (the
// caller divides by the wavelength it wants). Perlin's gradient noise with
// his quintic fade 6t⁵ - 15t⁴ + 10t³ (the published coefficients, as
// shaders/generate.js genNoised).

const N = {
  floats: {
    NORM2: 1.4142,          // 2D gradient noise peaks near ±1/√2: this scales it to about ±1
    NORM1: 2.0,             // 1D gradient noise (slopes in ±1 at the lattice points) peaks near ±1/2
    TAU: 6.28318530718,
  },
};
export const NOISE_PREFIX = 'LFN';
export const noiseDefinesGLSL = () => definesGLSL(NOISE_PREFIX, N);
export const noiseConstants = () => jsConstants(NOISE_PREFIX, N);

export const NOISE_SRC = /* glsl */ `
float lfFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
// GLSL's smoothstep (the subset's JS twin has no built-in of that name)
float lfSmooth(float a, float b, float x) {
  float t = clamp(thFdiv(x - a, b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
// 2D gradient noise at (px, pz) in lattice units, stream salt: about ±1
float lfNoise2(float px, float pz, uint salt) {
  float fx0 = floor(px), fz0 = floor(pz);
  int ix = int(fx0), iz = int(fz0);
  float fx = px - fx0, fz = pz - fz0;
  float ux = lfFade(fx), uz = lfFade(fz);
  float a = thLattice(ix, iz, salt) * LFN_TAU, b = thLattice(ix + 1, iz, salt) * LFN_TAU;
  float c = thLattice(ix, iz + 1, salt) * LFN_TAU, d = thLattice(ix + 1, iz + 1, salt) * LFN_TAU;
  float va = cos(a) * fx + sin(a) * fz;
  float vb = cos(b) * (fx - 1.0) + sin(b) * fz;
  float vc = cos(c) * fx + sin(c) * (fz - 1.0);
  float vd = cos(d) * (fx - 1.0) + sin(d) * (fz - 1.0);
  return clamp(mix(mix(va, vb, ux), mix(vc, vd, ux), uz) * LFN_NORM2, -1.0, 1.0);
}
// 1D gradient noise at t in lattice units, stream salt: about ±1
float lfNoise1(float t, uint salt) {
  float f0 = floor(t);
  int i = int(f0);
  float f = t - f0;
  float g0 = thLattice(i, 0, salt) * 2.0 - 1.0, g1 = thLattice(i + 1, 0, salt) * 2.0 - 1.0;
  return clamp(mix(g0 * f, g1 * (f - 1.0), lfFade(f)) * LFN_NORM1, -1.0, 1.0);
}
`;
