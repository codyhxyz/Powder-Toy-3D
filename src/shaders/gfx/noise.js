import { libChecks } from './lib.js';

// Shared noise for procedural detail. Everything here is evaluated in world
// (grid) space, so detail flows continuously across cell boundaries. Pure
// functions with no bindings (WGSL; the name is the GLSL version's,
// docs/webgpu.md W2). ign needs glslMod (src/gpu/wgsl.js), which lib() pastes.
//   hash13(p) -> f32       a hash of p, in [0, 1)
//   hash33(p) -> vec3f     three of them
//   vnoise(p) -> f32       value noise in [0, 1], C1-smooth, its lattice at whole numbers
//   fbm3(p) -> f32         three octaves of it, in [0, 1]
//   ign(px, frame) -> f32  interleaved gradient noise in [0, 1) for pixel centre px
//                          (a fragment's @builtin(position).xy: gFragCoord) and frame
//   stbn1 / stbn2 / stbn3  spatiotemporal low-discrepancy samples for TAAU (below)
export const noiseGLSL = /* wgsl */ `
// Hash without sine (Dave Hoskins): an input scale that scrambles the
// fraction bits and an offset for the self-dot that mixes the components.
const HASH13_SCALE: f32 = 0.1031;
const HASH13_MIX: f32 = 31.32;
const HASH33_SCALE: vec3f = vec3f(0.1031, 0.1030, 0.0973);
const HASH33_MIX: f32 = 33.33;
fn hash13(p0: vec3f) -> f32 {
  var p = fract(p0 * HASH13_SCALE);
  p += dot(p, p.zyx + HASH13_MIX);
  return fract((p.x + p.y) * p.z);
}
fn hash33(p0: vec3f) -> vec3f {
  var p = fract(p0 * HASH33_SCALE);
  p += dot(p, p.yxz + HASH33_MIX);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// Value noise in [0, 1], C1-smooth.
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3f(1.0, 0.0, 0.0)), u.x),
                 mix(hash13(i + vec3f(0.0, 1.0, 0.0)), hash13(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
             mix(mix(hash13(i + vec3f(0.0, 0.0, 1.0)), hash13(i + vec3f(1.0, 0.0, 1.0)), u.x),
                 mix(hash13(i + vec3f(0.0, 1.0, 1.0)), hash13(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
// Three octaves of value noise: weights (sum 1), frequency multiples (a little
// off 2 and 4 so the lattices don't line up) and offsets (decorrelate them).
const FBM3_W0: f32 = 0.5;
const FBM3_W1: f32 = 0.3;
const FBM3_W2: f32 = 0.2;
const FBM3_F1: f32 = 2.03;
const FBM3_F2: f32 = 4.01;
const FBM3_OFS1: f32 = 17.1;
const FBM3_OFS2: f32 = 31.7;
fn fbm3(p: vec3f) -> f32 {
  return FBM3_W0 * vnoise(p) + FBM3_W1 * vnoise(p * FBM3_F1 + FBM3_OFS1) + FBM3_W2 * vnoise(p * FBM3_F2 + FBM3_OFS2);
}
// Interleaved gradient noise (Jimenez 2014): a cheap per-pixel jitter that TAA
// resolves. WebGPU's pixel rows run top down, so the pattern is WebGL's
// flipped vertically (docs/webgpu.md F4: accepted, not emulated).
const IGN_X: f32 = 0.06711056;          // pixel-space weights of the inner ramp ...
const IGN_Y: f32 = 0.00583715;
const IGN_SCALE: f32 = 52.9829189;      // ... and its outer scale (the paper's magic numbers)
const IGN_FRAME_SHIFT: f32 = 5.588238;  // pixel offset per frame, decorrelating frames
const IGN_FRAME_PERIOD: f32 = 64.0;     // frames before the offset sequence repeats
fn ign(px0: vec2f, frame: f32) -> f32 {
  let px = px0 + IGN_FRAME_SHIFT * glslMod(frame, IGN_FRAME_PERIOD);
  return fract(IGN_SCALE * fract(IGN_X * px.x + IGN_Y * px.y));
}

// Spatiotemporal samples for the stochastic lighting estimators (near field,
// glow lights, lamp shadows, liquid dither): what NVIDIA's spatiotemporal
// blue noise is for (Wolfe et al. 2022, "Spatiotemporal Blue Noise Masks"),
// built procedurally so no texture binding is needed. Spatially each dimension
// is IGN, whose every 3x3 pixel window holds nearly all of [0, 1) (Jimenez
// 2014): that is exactly the window TAAU reconstructs and variance-clips the
// history against (three's TAAUNode: 9 taps, mean ± σ), so the window's mean,
// and with it the clip box, barely moves from frame to frame. White noise
// moves it by σ/3 every frame, which is the shimmer. Temporally each pixel
// walks a Roberts (2018) R-sequence ("The Unreasonable Effectiveness of
// Quasirandom Sequences"), the golden-ratio animation Wolfe recommends for
// blue noise over time, so a pixel's samples are low-discrepancy across
// frames too. Independent dimensions take IGN on differently oriented pixel
// lattices (as is, transposed, rotated a quarter turn): shifting IGN's pixel
// only offsets its value, so offsets alone would correlate the dimensions.
//   stbn1(px, frame, k) -> f32     one dimension; k: a stream index (rays of one pixel)
//   stbn2(px, frame, k) -> vec2f   two, stratified over STBN_STRATA² cells across a 3x3 window
//   stbn3(px, frame) -> vec3f      three independent dimensions
const R1_G: f32 = 0.6180339887;                             // 1/φ: R1
const R2_G: vec2f = vec2f(0.7548776662, 0.5698402910);      // 1/g, 1/g², g = 1.3247179572 (plastic number): R2
const R3_G: vec3f = vec3f(0.8191725134, 0.6710436067, 0.5497004779);   // 1/h, 1/h², 1/h³, h = 1.2207440846: R3
const STBN_PERIOD: f32 = 4096.0;   // frames before the temporal offsets wrap (keeps frame · g exact in f32)
const STBN_STRATA: f32 = 3.0;      // 2D strata per axis: a 3x3 pixel window holds about one sample in each
fn ignT(px: vec2f) -> f32 { return ign(px.yx, 0.0); }                // IGN on the transposed lattice
fn ignR(px: vec2f) -> f32 { return ign(vec2f(-px.y, px.x), 0.0); }   // ... and a quarter turn
fn ignF(px: vec2f) -> f32 { return ign(vec2f(px.x, -px.y), 0.0); }    // ... and mirrored
fn stbnT(frame: f32, k: f32) -> f32 { return glslMod(frame, STBN_PERIOD) + k; }
fn stbn1(px: vec2f, frame: f32, k: f32) -> f32 { return fract(ign(px, 0.0) + R1_G * stbnT(frame, k)); }
// The 1D sample picks one of the STBN_STRATA² cells (a window's nine pixels
// land in nearly all of them) and, scaled up, places the point across it; the
// transposed lattice places it down the cell. Uniform over the square.
fn stbn2(px: vec2f, frame: f32, k: f32) -> vec2f {
  let t = stbnT(frame, k);
  let v = fract(ign(px, 0.0) + R1_G * t) * STBN_STRATA * STBN_STRATA;
  let s = floor(v);
  let w = fract(ignT(px) + R2_G.y * t);
  return vec2f(glslMod(s, STBN_STRATA) + fract(v), floor(s / STBN_STRATA) + w) / STBN_STRATA;
}
fn stbn3(px: vec2f, frame: f32) -> vec3f {
  let t = stbnT(frame, 0.0);
  return fract(vec3f(ign(px, 0.0), ignT(px), ignR(px)) + R3_G * t);
}
`;

/** tools/check-wgsl.mjs: a probe kernel calling every function above (shaders/gfx/lib.js libChecks) */
export const WGSL_CHECK = () => libChecks('noise');
