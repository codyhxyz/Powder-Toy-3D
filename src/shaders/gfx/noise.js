// Shared noise for procedural detail. Everything here is evaluated in world
// (grid) space, so detail flows continuously across cell boundaries.
export const noiseGLSL = /* glsl */ `
// Hash without sine (Dave Hoskins): an input scale that scrambles the
// fraction bits and an offset for the self-dot that mixes the components.
#define HASH13_SCALE 0.1031
#define HASH13_MIX 31.32
#define HASH33_SCALE vec3(0.1031, 0.1030, 0.0973)
#define HASH33_MIX 33.33
float hash13(vec3 p) {
  p = fract(p * HASH13_SCALE);
  p += dot(p, p.zyx + HASH13_MIX);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * HASH33_SCALE);
  p += dot(p, p.yxz + HASH33_MIX);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// Value noise in [0, 1], C1-smooth.
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
                 mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
                 mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
// Three octaves of value noise: weights (sum 1), frequency multiples (a little
// off 2 and 4 so the lattices don't line up) and offsets (decorrelate them).
#define FBM3_W0 0.5
#define FBM3_W1 0.3
#define FBM3_W2 0.2
#define FBM3_F1 2.03
#define FBM3_F2 4.01
#define FBM3_OFS1 17.1
#define FBM3_OFS2 31.7
float fbm3(vec3 p) {
  return FBM3_W0 * vnoise(p) + FBM3_W1 * vnoise(p * FBM3_F1 + FBM3_OFS1) + FBM3_W2 * vnoise(p * FBM3_F2 + FBM3_OFS2);
}
// Interleaved gradient noise (Jimenez 2014): a cheap per-pixel jitter that TAA resolves.
#define IGN_X 0.06711056        // pixel-space weights of the inner ramp ...
#define IGN_Y 0.00583715
#define IGN_SCALE 52.9829189    // ... and its outer scale (the paper's magic numbers)
#define IGN_FRAME_SHIFT 5.588238   // pixel offset per frame, decorrelating frames
#define IGN_FRAME_PERIOD 64.0      // frames before the offset sequence repeats
float ign(vec2 px, float frame) {
  px += IGN_FRAME_SHIFT * mod(frame, IGN_FRAME_PERIOD);
  return fract(IGN_SCALE * fract(IGN_X * px.x + IGN_Y * px.y));
}
`;
