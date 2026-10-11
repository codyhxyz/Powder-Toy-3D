// HDR post-processing on WebGPU (docs/webgpu.md W16, F1, F4, F7): the scene
// target (linear, premultiplied HDR radiance and its depth) → TAA or TAAU →
// eye adaptation → bloom → sharpen + AgX + sRGB + dither (+ night vision) →
// the canvas, composited there over the page's sky gradient.
//
//   const post = createPost(gpu, { presenter, pixScale });
//   await post.ready;                    // its pipelines (built at once: boot needs post)
//   post.render({ prepare, draw, meshes, overlay }, camera, null, dt);
//   post.reset();                        // after anything that invalidates history
//   post.settings.taa / .upscale / .bloom / .exposure (EV) / .sharpen / .look / .raw / .hotStart / .hotFull
//   post.settings.night / .nightGain / .meter, post.sceneLuma: night-vision goggles (below)
//
// A presented frame, as render() records it (B3's E1 and E2):
//   prepare(post)        the camera is jittered now: write FrameUniforms (they can't be written inside a pass)
//   scene pass           draw(rp, post) into post.sceneTarget: colour cleared to 0, depth to 1 (F1)
//   meshes(post)         three.render into post.sceneTarget.rt (its own submit, loadOp load), if any
//   overlay pass         overlay(rp, post): the rays sprites, colour loaded, depth read-only, if any
//   TAA pass             → history[next]                                  (fragment)
//   prefilter pass       → down[0], half resolution                       (fragment)
//   compute pass 'post'  bloom down 1–5, up 4–1; luminance grid, histogram, adaptation, meter (one workgroup)
//   bloom up0 pass       → up[0]                                          (fragment)
//   canvas pass          sky, composite, viewmodel composite, glow       (fragment, presenter's texture)
// so post is 3 render passes and 1 compute pass besides the scene and canvas
// passes (the WebGL2 build made about 17). The split methods (beginScene,
// endScene, finish) are there for callers that need the parts apart.
//
// The scene is rendered as linear, premultiplied HDR radiance. Tone mapping is
// applied to the premultiplied colour ("over black"), so opaque pixels are
// exact, coverage at silhouettes is resolved in linear light, and emissive media
// and bloom add light over the background. The canvas is opaque (F7): where the
// scene's coverage is below 1 the composite draws the page's sky gradient
// (ui/styles.css body background) behind it, exactly as the compositor blended
// the old transparent canvas over the page, so the compositor no longer blends a
// full-window layer every frame.
//
// TAA (Karis 2014): Halton(2,3) projection jitter, reprojection from depth with the
// previous unjittered view-projection, Blackman-Harris reconstruction of the current
// frame, Catmull-Rom history, YCoCg variance clipping, luminance-weighted blend.
// TAAU (Karis 2014, UE4's temporal upsample): with upscale < 1 the scene renders at
// that share of the canvas size per axis, jittered within its own (larger) pixels,
// and the TAA pass resolves straight to canvas size. Each output pixel takes the
// current frame from the 3×3 input pixels around its nearest jittered sample: a
// filter one output pixel wide where that sample lies close (sharp), one input pixel
// wide otherwise (no blocks), and that frame's blend weight scales with how close
// the sample came. Over the jitter cycle the samples cover every output pixel.
// Bloom (Jimenez 2014): per-pixel soft-knee bright pass at half resolution, 13-tap
// downsample to 1/64, 9-tap tent upsample. It is energy-conserving: the halo only
// redistributes the above-threshold light (out = c + k·(blur(bright) − bright(c))).
// Eyes adjusting to the dark: histogram auto exposure as in Unreal (and Frostbite:
// Lagarde & de Rousiers 2014), only ever upward. The resolved frame's luminance is
// sampled on a coarse grid, scattered into a log-luminance histogram (fixed-point
// atomics in workgroup memory, which sum exactly in any order), and the mean of the
// histogram between two percentiles (Unreal's; it ignores the darkest pixels and
// small bright lights) says how bright the view is. Over ADAPT.LOG_DARK nothing
// changes; under it the exposure rises by what brings it back there, up to
// ADAPT.MAX_EV, with the exponential time course of visual adaptation (Pattanaik et
// al. 2000, as in Krawczyk et al. 2005): slow into the dark, quick back into the light.
// Night vision (the Night Vision perk, pov/nightVision.js): an image intensifier's picture, mixed in
// by settings.night: the scene's luminance × settings.nightGain, tone-mapped as a grey and shown on a
// green P43 phosphor, with the tube's shot-noise grain (σ ∝ √(signal·gain): it counts photons) and
// its round field's vignette. With settings.meter on, the pipeline also measures the scene's
// log-average luminance (Reinhard et al. 2002, the auto-exposure key) every METER_INTERVAL frames
// over a METER_SIZE² grid of tiles, reduced on the GPU and read back asynchronously: post.sceneLuma
// (linear, before exposure; over covered pixels only: the sky behind the scene isn't the scene).
//
// Conventions (F4): clip depth is 0..1 and every projection comes from a camera in
// WebGPU's coordinate system; framebuffer and texture coordinates are top-left
// (y down), so per-pixel noise (dither, grain) is the WebGL build's mirrored
// vertically. The jitter is a pixel offset (jx, jy) measured with y down; it goes
// into camera.projectionMatrix in place (row 0 += 2·jx/w · row 3, row 1 −= 2·jy/h ·
// row 3), so three's meshes jitter with our passes, and comes out after the scene.

import {
  Matrix4, Vector3, Quaternion, RenderTarget, DepthTexture, HalfFloatType, FloatType, NearestFilter,
} from 'three/webgpu';
import { uniformStruct, fullscreenVert, luma as lumaWGSL, STAGE } from '../gpu/index.js';
import { initRenderTarget, gpuTextureOf } from '../gpu/three.js';

export const POST_DEFAULTS = {
  taa: true,
  upscale: 1, // render scale ceiling per axis under TAA (1 = native; see UPSCALE)
  resolutionScale: 1, // automatic scene-only multiplier; output/TAA history stay native
  bloom: 0.3, // fraction of above-threshold light scattered into the halo (0..1)
  // EV stops. +0.7 with look 0.5 reproduces the mean brightness and saturation of the
  // old in-shader ACES (measured on the lab and volcano presets).
  exposure: 0.7,
  sharpen: 0.25, // CAS-style post-TAA sharpen (0..1)
  look: 0.5, // 0 = AgX base, 1 = Blender's AgX "Punchy" look
  raw: false, // true = only encode to sRGB (false-colour data views keep exact legend colours)
  bloomThreshold: 1.6, // max-channel radiance where bloom starts…
  bloomKnee: 0.8, // …with a soft knee this wide
  bloomScatter: 0.7, // energy share passed from each mip to the next wider one
  // Bright saturated colours (lava, flames, glowing metal) roll off per channel, like film,
  // instead of fading to white: the blend starts at this exposed max-channel radiance…
  hotStart: 1.0,
  hotFull: 4.0, // …and is complete here
  adapt: true, // eyes adjusting to the dark (ADAPT); false holds the gain at 1 (A/B checks)
  night: 0, // night-vision goggles' share of the picture (0 = off)
  nightGain: 1, // × light they add
  meter: false, // measure post.sceneLuma
};

// Eye adaptation (see the header). Luminances are log2 of scene radiance, where
// sunlit white is ≈ 1.2 (gfx/incandescence.js): daylit views sit around -2..0,
// the moonlit night a few stops under, a cave lit by crystals ~10 under.
export const ADAPT = {
  GRID: [64, 36],      // luminance samples across the frame…
  TAPS: 4,             // …each the mean of TAPS × TAPS bilinear taps over its patch
  BINS: 64,            // histogram bins…
  LOG_MIN: -16,        // …over this log2 range (darker or brighter pixels land in the end bins)
  LOG_MAX: 4,
  LOW_PCT: 0.8,        // the mean is taken between these shares of the pixels, darkest first
  HIGH_PCT: 0.983,     // (Unreal's defaults: the brightest 1.7% are lights, not the scene)
  LOG_DARK: -5,        // a view this bright or brighter keeps the fixed exposure; darker ones rise to it…
  MAX_EV: 4,           // …by at most this many stops (16×)
  TAU_DARK: 1.5,       // s: time constant of adjusting to the dark (a few seconds to settle)…
  TAU_LIGHT: 0.4,      // s: …and back to the light (Pattanaik et al. 2000's rod time constant)
  SETTLED: 1e-3,       // relative gap to its target under which the gain snaps onto it
  DT: 1 / 60,          // s: the frame time assumed when render() isn't given one
};

// Frame-time trials, not a refresh-rate target alone: a capped 30 Hz page can
// regain detail too. Failed trials back off so CPU-bound scenes don't keep cycling.
export function createAutoResolution() {
  const WINDOW = 1.2, MIN = 0.6, HOLD = 15, MAX_HOLD = 120;
  let time = 0, frames = 0, trial = null, resting = false;
  let downAt = 0, upAt = HOLD, downHold = HOLD, upHold = HOLD;
  const auto = {
    enabled: true, // tools disable adaptation for stable timings (freeze current scale)
    scale: 1,
    // Finish a still at selected quality, without measuring its settling frames
    // and degrading again. Only outside input/state changes release this lock.
    recover(now) {
      if (!auto.enabled || resting) return false;
      resting = true;
      time = frames = 0; trial = null;
      upAt = now + HOLD;
      const changed = auto.scale !== 1;
      auto.scale = 1;
      return changed;
    },
    wake() { resting = false; },
    update(dt, now) {
      if (!auto.enabled || resting) { time = frames = 0; trial = null; return; }
      time += dt; frames++;
      if (time < WINDOW) return;
      const avg = time / frames;
      time = frames = 0;
      if (trial) {
        const { scale, baseline, up } = trial;
        const accepted = up ? avg <= baseline / 0.93 : avg <= baseline * 0.93;
        if (!accepted) auto.scale = scale;
        if (up) {
          upAt = now + (accepted ? WINDOW : upHold);
          upHold = accepted ? HOLD : Math.min(MAX_HOLD, upHold * 2);
          // Don't immediately undo a successful recovery at a refresh-rate cap.
          downAt = Math.max(downAt, now + HOLD);
        } else {
          downAt = now + (accepted ? 0 : downHold);
          downHold = accepted ? HOLD : Math.min(MAX_HOLD, downHold * 2);
          upAt = Math.max(upAt, now + HOLD);
        }
        trial = null;
        return;
      }
      const up = auto.scale < 1 && now >= upAt;
      if (up || (avg > 1 / 50 && auto.scale > MIN && now >= downAt)) {
        trial = { scale: auto.scale, baseline: avg, up };
        auto.scale = up ? Math.min(1, auto.scale * 1.08) : Math.max(MIN, auto.scale * 0.85);
      }
    },
  };
  return auto;
}

export const MIPS = 6;
const JITTER_PERIOD = 16;
// TAA current-frame blend weight where history agrees with the present (stable)
// and where it doesn't (changing); the shader blends between them per pixel.
export const TAA_WEIGHT_STABLE = 0.07;
const TAA_WEIGHT_CHANGING = 0.16;
// Upscaling presets: render scale per axis, AMD FSR 2's quality modes.
export const UPSCALE = { native: 1, quality: 1 / 1.5, balanced: 1 / 1.7, performance: 1 / 2 };
// TAAU's stable blend weight, as an average: each frame's is this × the closeness of
// its nearest sample over that closeness's mean, so a sample landing on the pixel
// centre counts most. Lower than TAA's: one frame covers less of the output grid.
export const TAAU_WEIGHT_STABLE = 0.05;
// Gaussian fit of the Blackman-Harris reconstruction filter: w = exp(-k d²), d in pixels.
const BLACKMAN_HARRIS_K = 2.29;
// Grid (per axis) over which the mean closeness of the nearest sample is integrated.
const CONF_GRID = 64;
// History is dropped when the camera jumps: moves farther than this share of its
// distance from the origin (at least 1 world unit) in one frame…
const JUMP_MOVE_FRAC = 0.25;
const JUMP_TURN = 0.5; // …or turns more than this (radians)
// The luminance meter (night vision's automatic brightness control): a METER_SIZE² grid of tiles,
// METER_TAPS² samples each, every METER_INTERVAL frames.
const METER_SIZE = 16;
const METER_TAPS = 4;
const METER_INTERVAL = 4;
const METER_LOG_FLOOR = 1e-4; // radiance added before the log, so black pixels don't send it to −∞ (Reinhard's δ)
const METER_COVERED = 0.5;    // alpha at which a pixel counts as scene, not the sky behind it
// Night vision's screen: a Gen-3 image intensifier's P43 phosphor (green, peak 545 nm), linear sRGB, max
// channel 1 (also tints the held tool's composite below).
export const NV_PHOSPHOR = [0.30, 1.0, 0.25];
// The histogram's weights in fixed point: each sample's coverage / samples · 2^20, so a
// frame's total is at most 2^20 and integer atomics add them exactly, in any order (W21).
const HIST_FIXED = 2 ** 20;
// The workgroup that reduces the frame (luminance grid, histogram, adaptation, meter).
const REDUCE_THREADS = 256;
// The result ring's slot: gain, target, view, meter Σ log L, meter count, flags (1 adapt, 2 meter).
const RESULT_BYTES = 32;
const RESULT_SLOTS = 8;
const NO_SLOT = 0xffffffff;
const BLOOM_TILE = 8;   // compute workgroups of the bloom mips: 8×8 pixels (W22: 64 threads)

// The page's sky (ui/styles.css, body background): a three-stop linear gradient
// under a faint warm radial glow. Colours are sRGB-encoded, as CSS blends them;
// top and low are read from the page's --sky-top and --sky-low when there is a page.
export const SKY = {
  top: '#232b3a',             // --sky-top, at 0%
  mid: '#161b25',             // at MID_AT
  low: '#0e1117',             // --sky-low, at 100%
  MID_AT: 0.55,
  glow: [255, 196, 120, 0.06],   // radial-gradient(120% 70% at 50% 108%, rgba(255, 196, 120, 0.06), transparent 60%)
  GLOW_CENTRE: [0.5, 1.08],
  GLOW_RADII: [1.2, 0.7],
  GLOW_END: 0.6,
};

// GPUTextureUsage and GPUBufferUsage bits (spec values), usable where WebGPU's globals aren't (Node).
const TEX = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
const BUF = { COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
const HDR = 'rgba16float';
const CLEAR = [0, 0, 0, 0];

// a JS number as a WGSL f32 literal
const f = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const vec2 = ([x, y]) => `vec2f(${f(x)}, ${f(y)})`;

// ---------------------------------------------------------------- params

const TaaParams = uniformStruct('TaaParams', {
  reproj: 'mat4x4f',     // prevViewProj · inverse(curViewProj), both unjittered
  jitter: 'vec2f',       // where this frame sampled, in pixels from the pixel centre (y down)
  size: 'vec2f',         // output (and history) size
  inSize: 'vec2f',       // the scene's size (TAAU)
  weight: 'vec2f',       // current-frame weight (stable, changing)
  historyValid: 'bool',
  meanConf: 'f32',       // TAAU: mean over the jitter cycle of conf
});
const PrefilterParams = uniformStruct('PrefilterParams', { thresh: 'vec2f' });
const MipParams = uniformStruct('MipParams', {
  texel: 'vec2f',   // source texel (down: the finer level; up: the coarser one)
  dst: 'vec2u',     // this level's size
  scatter: 'f32',
});
const ReduceParams = uniformStruct('ReduceParams', { dt: 'f32', adapt: 'bool', meter: 'bool', slot: 'u32' });
const CompositeParams = uniformStruct('CompositeParams', {
  size: 'vec2f', bloomTexel: 'vec2f', thresh: 'vec2f', hot: 'vec2f',
  bloom: 'f32', exposure: 'f32', sharpen: 'f32', look: 'f32',
  raw: 'bool', adapt: 'bool', night: 'f32', nightGain: 'f32',
  nightSeed: 'u32', opaque: 'bool', viewmodel: 'bool', glow: 'bool',
  vmNight: 'f32',
  skyTop: 'vec3f', skyMid: 'vec3f', skyLow: 'vec3f', skyGlow: 'vec4f',
});

// ---------------------------------------------------------------- layouts (group 2: post's own resources, C4)

const F = STAGE.FRAGMENT, C = STAGE.COMPUTE;
const tex = (binding, visibility, sampleType = 'float') => ({ binding, visibility, texture: { sampleType } });
const linear = (binding, visibility) => ({ binding, visibility, sampler: { type: 'filtering' } });
export const POST_LAYOUTS = {
  // the scene's colour (texelFetch), its depth, the history (bilinear)
  TAA: [tex(0, F), tex(1, F, 'depth'), tex(2, F), linear(3, F)],
  // two images and a sampler: the prefilter (one source) and bloom's up[0] (low, high)
  PAIR: [tex(0, F), tex(1, F), linear(2, F)],
  // a bloom level: source (or low), high, sampler, the level written
  MIP: [tex(0, C), tex(1, C), linear(2, C), { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: HDR } }],
  // the resolved frame, sampler, the adaptation state (in place), the result ring
  REDUCE: [tex(0, C), linear(1, C), { binding: 2, visibility: C, buffer: { type: 'storage' } }, { binding: 3, visibility: C, buffer: { type: 'storage' } }],
  // the resolved frame, bloom up[0], sampler, the adaptation state, the viewmodel and glow targets (F3)
  COMPOSITE: [tex(0, F), tex(1, F), linear(2, F), { binding: 3, visibility: F, buffer: { type: 'read-only-storage' } }, tex(4, F), tex(5, F)],
};

// ---------------------------------------------------------------- WGSL

const COMMON = /* wgsl */ `
${lumaWGSL}
// NaN → 0, +Inf → large, negatives → 0, then a hue-preserving cap. The NaN/Inf test is
// done on the bits, so it survives compilers that assume finite maths (H1.26).
const MAX_RADIANCE: f32 = 4096.0;
const F32_INF: u32 = 0x7f800000u;  // IEEE-754 +Inf bits; any larger magnitude is a NaN
const F32_ABS: u32 = 0x7fffffffu;  // mask that clears the sign bit
fn sanitize(c0: vec4f) -> vec4f {
  let b = bitcast<vec4u>(c0);
  var c = select(c0, vec4f(MAX_RADIANCE), b == vec4u(F32_INF));
  c = select(c, vec4f(0.0), (b & vec4u(F32_ABS)) > vec4u(F32_INF));
  c = max(c, vec4f(0.0));
  let m = max(c.r, max(c.g, c.b));
  if (m > MAX_RADIANCE) { c = vec4f(c.rgb * (MAX_RADIANCE / m), c.a); }
  c.a = min(c.a, 1.0);
  return c;
}

// Soft-knee bright pass on the max channel: the share of the light that blooms (th: threshold, knee).
fn bright(c: vec3f, th: vec2f) -> vec3f {
  let br = max(c.r, max(c.g, c.b));
  var rq = clamp(br - th.x + th.y, 0.0, 2.0 * th.y);
  rq = rq * rq / (4.0 * th.y + 1e-4);
  return c * (max(rq, br - th.x) / max(br, 1e-4));
}

// 3×3 tent: binomial weights 1-2-1 ⊗ 1-2-1 (sum 16).
fn tent9(t: texture_2d<f32>, s: sampler, uv: vec2f, texel: vec2f) -> vec3f {
  let d = vec4f(texel, -texel.x, 0.0);
  var acc = textureSampleLevel(t, s, uv - d.xy, 0.0).rgb + textureSampleLevel(t, s, uv - d.zy, 0.0).rgb
          + textureSampleLevel(t, s, uv + d.zy, 0.0).rgb + textureSampleLevel(t, s, uv + d.xy, 0.0).rgb;
  acc += 2.0 * (textureSampleLevel(t, s, uv - d.wy, 0.0).rgb + textureSampleLevel(t, s, uv + d.zw, 0.0).rgb
              + textureSampleLevel(t, s, uv + d.xw, 0.0).rgb + textureSampleLevel(t, s, uv + d.wy, 0.0).rgb);
  acc += 4.0 * textureSampleLevel(t, s, uv, 0.0).rgb;
  return acc * (1.0 / 16.0);
}
`;

/** The TAA pass (entry `taa`) and the TAAU pass (entry `taau`): the scene → history[next]. */
export const taaWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${TaaParams.wgsl}
@group(2) @binding(0) var tColor: texture_2d<f32>;     // the scene: linear premultiplied radiance, alpha = coverage
@group(2) @binding(1) var tDepth: texture_depth_2d;    // its depth, 0..1 (F4)
@group(2) @binding(2) var tHistory: texture_2d<f32>;   // last frame's resolve, at the output size
@group(2) @binding(3) var smp: sampler;
@group(3) @binding(1) var<uniform> P: TaaParams;
const BLACKMAN_HARRIS_K: f32 = ${f(BLACKMAN_HARRIS_K)};
const FLICKER_LUMA_FLOOR: f32 = 0.2;  // anti-flicker: differences are relative to max(luma, this) (tone-mapped luma)
// the cross of neighbours whose nearest depth reprojects a pixel
var<private> CROSS: array<vec2i, 4> = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));

fn rgb2ycocg(c: vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25)));
}
fn ycocg2rgb(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// Work in a reversibly tone-mapped space (c / (1 + luma)) so HDR edges resolve
// without aliasing and bright outliers can't dominate the blend.
fn toSpace(c: vec4f) -> vec4f { return vec4f(rgb2ycocg(c.rgb / (1.0 + luma(c.rgb))), c.a); }
fn fromSpace(t: vec4f) -> vec4f {
  let c = max(ycocg2rgb(t.xyz), vec3f(0.0));
  return vec4f(c / max(1.0 - luma(c), 1e-3), t.w);
}

// Catmull-Rom in 5 bilinear taps (corners dropped).
fn historyCR(uv: vec2f) -> vec4f {
  let pos = uv * P.size;
  let c1 = floor(pos - 0.5) + 0.5;
  let f = pos - c1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (c1 - 1.0) / P.size;
  let t3 = (c1 + 2.0) / P.size;
  let t12 = (c1 + w2 / w12) / P.size;
  let a = w12.x * w0.y;
  let b = w0.x * w12.y;
  let c = w12.x * w12.y;
  let d = w3.x * w12.y;
  let e = w12.x * w3.y;
  let s = textureSampleLevel(tHistory, smp, vec2f(t12.x, t0.y), 0.0) * a + textureSampleLevel(tHistory, smp, vec2f(t0.x, t12.y), 0.0) * b
        + textureSampleLevel(tHistory, smp, t12, 0.0) * c + textureSampleLevel(tHistory, smp, vec2f(t3.x, t12.y), 0.0) * d
        + textureSampleLevel(tHistory, smp, vec2f(t12.x, t3.y), 0.0) * e;
  return s / (a + b + c + d + e);
}

// Clip the segment p → q against the box (p inside), Playdead-style, in 4D.
fn clipBox(bmin: vec4f, bmax: vec4f, p: vec4f, q: vec4f) -> vec4f {
  let r = q - p;
  let hi = bmax - p;
  let lo = bmin - p;
  var s = 1.0;
  for (var i = 0; i < 4; i++) {
    if (r[i] > hi[i] + 1e-6) { s = min(s, hi[i] / r[i]); }
    else if (r[i] < lo[i] - 1e-6) { s = min(s, lo[i] / r[i]); }
  }
  return p + r * s;
}

// The history at prevUV, clipped to this frame's 3×3 neighbourhood (moments m1, m2,
// bounds mn, mx) and blended with cur: leaning on history while it agrees with the present.
fn blendHistory(cur: vec4f, m1: vec4f, m2: vec4f, mn: vec4f, mx: vec4f, prevUV: vec2f, wStable: f32) -> vec4f {
  var h = toSpace(sanitize(historyCR(prevUV)));
  let mean = m1 / 9.0;
  let sd = sqrt(max(m2 / 9.0 - mean * mean, vec4f(0.0)));
  let bmin = max(mn, mean - sd);
  let bmax = min(mx, mean + sd);
  h = clipBox(bmin, bmax, clamp(cur, bmin, bmax), h);
  // anti-flicker: lean on history while it agrees with the present
  let diff = abs(cur.x - h.x) / max(max(cur.x, h.x), FLICKER_LUMA_FLOOR);
  let k = 1.0 - diff;
  return mix(h, cur, mix(P.weight.y, wStable, k * k));
}

// Last frame's clip position of this frame's uv (y down) at depth z (0..1).
fn reproject(uv: vec2f, z: f32) -> vec4f {
  return P.reproj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
}
// …as a uv, or a value outside 0..1 when it was behind the camera.
fn prevUvOf(pc: vec4f) -> vec2f {
  if (pc.w <= 0.0) { return vec2f(-1.0); }
  let ndc = pc.xy / pc.w;
  return vec2f(0.5 + 0.5 * ndc.x, 0.5 - 0.5 * ndc.y);
}
fn inUnit(uv: vec2f) -> bool { return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)); }

@fragment fn taa(in: FullScreen) -> @location(0) vec4f {
  let p = vec2i(in.position.xy);
  let hi = vec2i(P.size) - 1;
  var m1 = vec4f(0.0);
  var m2 = vec4f(0.0);
  var mn = vec4f(1e9);
  var mx = vec4f(-1e9);
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 9; i++) {
    let o = vec2i(i % 3 - 1, i / 3 - 1);
    let t = toSpace(sanitize(textureLoad(tColor, clamp(p + o, vec2i(0), hi), 0)));
    let d = vec2f(o) - P.jitter;
    let w = exp(-BLACKMAN_HARRIS_K * dot(d, d));
    acc += t * w;
    wsum += w;
    m1 += t;
    m2 += t * t;
    mn = min(mn, t);
    mx = max(mx, t);
  }
  // nothing but background around: stay exactly transparent, never ghost
  if (mx.w <= 0.0) { return vec4f(0.0); }
  let cur = acc / wsum;

  // reproject using the nearest depth of the cross (keeps foreground edges crisp)
  var z = textureLoad(tDepth, p, 0);
  var zo = vec2i(0);
  for (var i = 0; i < 4; i++) {
    let zz = textureLoad(tDepth, clamp(p + CROSS[i], vec2i(0), hi), 0);
    if (zz < z) { z = zz; zo = CROSS[i]; }
  }
  let uvq = (vec2f(p + zo) + 0.5) / P.size;
  let prevUV = prevUvOf(reproject(uvq, z)) - vec2f(zo) / P.size;

  var res = cur;
  if (P.historyValid != 0u && inUnit(prevUV)) {
    res = blendHistory(cur, m1, m2, mn, mx, prevUV, P.weight.x);
  }
  return sanitize(fromSpace(res));
}

// TAAU: tColor and tDepth are P.inSize, the output (and history) P.size.
@fragment fn taau(in: FullScreen) -> @location(0) vec4f {
  let scale = P.inSize / P.size;          // input pixels per output pixel
  let pIn = in.position.xy * scale;       // this pixel's centre, in input pixels
  let hi = vec2i(P.inSize) - 1;
  // input texel m sampled the scene at m + 0.5 - jitter: the nearest one is
  let c = vec2i(floor(pIn + P.jitter));

  var m1 = vec4f(0.0);
  var m2 = vec4f(0.0);
  var mn = vec4f(1e9);
  var mx = vec4f(-1e9);
  var accIn = vec4f(0.0);
  var accOut = vec4f(0.0);
  var wIn = 0.0;
  var wOut = 0.0;
  var conf = 0.0;
  for (var i = 0; i < 9; i++) {
    let o = vec2i(i % 3 - 1, i / 3 - 1);
    let t = toSpace(sanitize(textureLoad(tColor, clamp(c + o, vec2i(0), hi), 0)));
    let dIn = vec2f(c + o) + 0.5 - P.jitter - pIn;   // sample → pixel centre, input pixels
    let dOut = dIn / scale;                           // …in output pixels
    let wi = exp(-BLACKMAN_HARRIS_K * dot(dIn, dIn));
    let wo = exp(-BLACKMAN_HARRIS_K * dot(dOut, dOut));
    accIn += t * wi;
    wIn += wi;
    accOut += t * wo;
    wOut += wo;
    conf = max(conf, wo);
    m1 += t;
    m2 += t * t;
    mn = min(mn, t);
    mx = max(mx, t);
  }
  if (mx.w <= 0.0) { return vec4f(0.0); }
  let curSoft = accIn / wIn;
  let cur = mix(curSoft, accOut / max(wOut, 1e-6), conf);

  var z = textureLoad(tDepth, clamp(c, vec2i(0), hi), 0);
  var zo = vec2i(0);
  for (var i = 0; i < 4; i++) {
    let zz = textureLoad(tDepth, clamp(c + CROSS[i], vec2i(0), hi), 0);
    if (zz < z) { z = zz; zo = CROSS[i]; }
  }
  let uvq = (pIn + vec2f(zo)) / P.inSize;
  let prevUV = prevUvOf(reproject(uvq, z)) - vec2f(zo) / P.inSize;

  var res = curSoft;
  if (P.historyValid != 0u && inUnit(prevUV)) {
    res = blendHistory(cur, m1, m2, mn, mx, prevUV, min(P.weight.x * conf / P.meanConf, 1.0));
  }
  return sanitize(fromSpace(res));
}
`;

/** The bloom prefilter: the resolved frame's bright part, 2×2 → down[0] (half resolution). */
export const prefilterWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${PrefilterParams.wgsl}
@group(2) @binding(0) var tSrc: texture_2d<f32>;
@group(3) @binding(1) var<uniform> P: PrefilterParams;
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let p = vec2i(in.position.xy) * 2;
  let hi = vec2i(textureDimensions(tSrc)) - 1;
  let s = bright(sanitize(textureLoad(tSrc, min(p, hi), 0)).rgb, P.thresh)
        + bright(sanitize(textureLoad(tSrc, min(p + vec2i(1, 0), hi), 0)).rgb, P.thresh)
        + bright(sanitize(textureLoad(tSrc, min(p + vec2i(0, 1), hi), 0)).rgb, P.thresh)
        + bright(sanitize(textureLoad(tSrc, min(p + vec2i(1, 1), hi), 0)).rgb, P.thresh);
  return vec4f(s * 0.25, 1.0);
}
`;

/** Bloom levels 1–5 down (entry `down`) and 4–1 up (entry `up`), in the post compute pass. */
export const bloomWGSL = () => /* wgsl */ `
${COMMON}
${MipParams.wgsl}
@group(2) @binding(0) var tSrc: texture_2d<f32>;    // down: the finer level; up: the coarser one (low)
@group(2) @binding(1) var tHigh: texture_2d<f32>;   // up: this level's down
@group(2) @binding(2) var smp: sampler;
@group(2) @binding(3) var dst: texture_storage_2d<rgba16float, write>;
@group(3) @binding(1) var<uniform> P: MipParams;
// Jimenez 2014 13-tap downsample: five overlapping 2×2-texel boxes (the inner one
// weighted 1/2, the four corner ones 1/8 each), as per-tap weights.
const DOWN_W_CENTRE: f32 = 0.125;   // centre tap (shared by the four corner boxes)
const DOWN_W_CORNER: f32 = 0.03125; // outer corners (one corner box each)
const DOWN_W_EDGE: f32 = 0.0625;    // outer edge midpoints (two corner boxes each)
const DOWN_W_INNER: f32 = 0.125;    // inner box taps (all bilinear, ±1 texel)
fn tap(uv: vec2f, o: vec2f) -> vec3f { return textureSampleLevel(tSrc, smp, uv + P.texel * o, 0.0).rgb; }

@compute @workgroup_size(${BLOOM_TILE}, ${BLOOM_TILE}) fn down(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= P.dst)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(P.dst);
  var c = tap(uv, vec2f(0.0)) * DOWN_W_CENTRE;
  c += (tap(uv, vec2f(-2.0, 2.0)) + tap(uv, vec2f(2.0, 2.0)) + tap(uv, vec2f(-2.0, -2.0)) + tap(uv, vec2f(2.0, -2.0))) * DOWN_W_CORNER;
  c += (tap(uv, vec2f(0.0, 2.0)) + tap(uv, vec2f(-2.0, 0.0)) + tap(uv, vec2f(2.0, 0.0)) + tap(uv, vec2f(0.0, -2.0))) * DOWN_W_EDGE;
  c += (tap(uv, vec2f(-1.0, 1.0)) + tap(uv, vec2f(1.0, 1.0)) + tap(uv, vec2f(-1.0, -1.0)) + tap(uv, vec2f(1.0, -1.0))) * DOWN_W_INNER;
  textureStore(dst, id.xy, vec4f(c, 1.0));
}

@compute @workgroup_size(${BLOOM_TILE}, ${BLOOM_TILE}) fn up(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= P.dst)) { return; }
  let hiC = textureLoad(tHigh, vec2i(id.xy), 0).rgb;
  let loC = tent9(tSrc, smp, (vec2f(id.xy) + 0.5) / vec2f(P.dst), P.texel);
  textureStore(dst, id.xy, vec4f(mix(hiC, loC, P.scatter), 1.0));
}
`;

/** Bloom's last upsample, into up[0] (half resolution), a render pass: it stays a compressed attachment (W16). */
export const bloomUp0WGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${MipParams.wgsl}
@group(2) @binding(0) var tLow: texture_2d<f32>;    // up[1]
@group(2) @binding(1) var tHigh: texture_2d<f32>;   // down[0]
@group(2) @binding(2) var smp: sampler;
@group(3) @binding(1) var<uniform> P: MipParams;
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let hiC = textureLoad(tHigh, vec2i(in.position.xy), 0).rgb;
  let loC = tent9(tLow, smp, in.position.xy / vec2f(P.dst), P.texel);
  return vec4f(mix(hiC, loC, P.scatter), 1.0);
}
`;

/**
 * The frame's reductions in one workgroup: the luminance grid, its histogram,
 * the adaptation update (in place, no ping-pong) and the meter's tile sums.
 */
export const reduceWGSL = () => /* wgsl */ `
${COMMON}
${ReduceParams.wgsl}
struct AdaptState { gain: f32, aim: f32, view: f32, pad: f32, }   // (aim: the gain it moves toward)
@group(2) @binding(0) var tSrc: texture_2d<f32>;   // the resolved frame
@group(2) @binding(1) var smp: sampler;
@group(2) @binding(2) var<storage, read_write> state: AdaptState;
@group(2) @binding(3) var<storage, read_write> ring: array<u32>;   // the result ring (B7): ${RESULT_BYTES / 4} words a slot
@group(3) @binding(1) var<uniform> P: ReduceParams;

const THREADS: u32 = ${REDUCE_THREADS}u;
// eye adaptation (ADAPT in gfx/post.js)
const GRID_W: u32 = ${ADAPT.GRID[0]}u;
const GRID: vec2f = ${vec2(ADAPT.GRID)};
const TAPS: u32 = ${ADAPT.TAPS}u;
const BINS: u32 = ${ADAPT.BINS}u;
const SAMPLES: u32 = ${ADAPT.GRID[0] * ADAPT.GRID[1]}u;
const LOG_MIN: f32 = ${f(ADAPT.LOG_MIN)};
const LOG_MAX: f32 = ${f(ADAPT.LOG_MAX)};
const LOG_FLOOR: f32 = ${f(ADAPT.LOG_MIN - 1)};   // log2 luminance of black (below the histogram)
const LOW_PCT: f32 = ${f(ADAPT.LOW_PCT)};
const HIGH_PCT: f32 = ${f(ADAPT.HIGH_PCT)};
const LOG_DARK: f32 = ${f(ADAPT.LOG_DARK)};
const MAX_EV: f32 = ${f(ADAPT.MAX_EV)};
const TAU_DARK: f32 = ${f(ADAPT.TAU_DARK)};
const TAU_LIGHT: f32 = ${f(ADAPT.TAU_LIGHT)};
const SETTLED: f32 = ${f(ADAPT.SETTLED)};
const EMPTY: f32 = 1e-6;    // total weight under which nothing covers the frame
const FIXED: f32 = ${f(HIST_FIXED)};   // the histogram's fixed point
// the meter: one tile a thread
const METER_SIZE: f32 = ${f(METER_SIZE)};
const METER_TAPS: u32 = ${METER_TAPS}u;
const METER_LOG_FLOOR: f32 = ${f(METER_LOG_FLOOR)};
const METER_COVERED: f32 = ${f(METER_COVERED)};
const NO_SLOT: u32 = ${NO_SLOT}u;

var<workgroup> bins: array<atomic<u32>, ${ADAPT.BINS}>;
var<workgroup> meterS: array<f32, ${REDUCE_THREADS}>;
var<workgroup> meterN: array<f32, ${REDUCE_THREADS}>;

@compute @workgroup_size(${REDUCE_THREADS}) fn main(@builtin(local_invocation_index) li: u32) {
  if (li < BINS) { atomicStore(&bins[li], 0u); }
  workgroupBarrier();

  // 1. the luminance grid: per sample, a patch mean (premultiplied: the covered part's own
  // luminance), its log2 and coverage; each sample is dropped into its bin, weighted by its coverage
  if (P.adapt != 0u) {
    for (var s = li; s < SAMPLES; s += THREADS) {
      let cell = vec2f(f32(s % GRID_W), f32(s / GRID_W));
      var sum = vec4f(0.0);
      for (var y = 0u; y < TAPS; y++) {
        for (var x = 0u; x < TAPS; x++) {
          let uv = (cell + (vec2f(f32(x), f32(y)) + 0.5) / f32(TAPS)) / GRID;
          sum += sanitize(textureSampleLevel(tSrc, smp, uv, 0.0));
        }
      }
      sum /= f32(TAPS * TAPS);
      let L = luma(sum.rgb) / max(sum.a, 1e-4);
      var lg = LOG_FLOOR;
      if (L > 0.0) { lg = max(log2(L), LOG_FLOOR); }
      let bin = u32(clamp(floor((lg - LOG_MIN) / (LOG_MAX - LOG_MIN) * f32(BINS)), 0.0, f32(BINS) - 1.0));
      atomicAdd(&bins[bin], u32(sum.a / f32(SAMPLES) * FIXED + 0.5));
    }
  }

  // 2. the meter: Σ log luminance over covered taps, and their count, per tile, then summed
  var ms = 0.0;
  var mc = 0.0;
  if (P.meter != 0u) {
    let tile = vec2f(f32(li % u32(METER_SIZE)), f32(li / u32(METER_SIZE)));
    for (var j = 0u; j < METER_TAPS; j++) {
      for (var i = 0u; i < METER_TAPS; i++) {
        let c = sanitize(textureSampleLevel(tSrc, smp, (tile + (vec2f(f32(i), f32(j)) + 0.5) / f32(METER_TAPS)) / METER_SIZE, 0.0));
        let w = step(METER_COVERED, c.a);
        ms += w * log(METER_LOG_FLOOR + luma(c.rgb) / max(c.a, 1e-3));
        mc += w;
      }
    }
  }
  meterS[li] = ms;
  meterN[li] = mc;
  workgroupBarrier();
  for (var stride = THREADS / 2u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      meterS[li] += meterS[li + stride];
      meterN[li] += meterN[li + stride];
    }
    workgroupBarrier();
  }
  if (li != 0u) { return; }

  // 3. the histogram's mean between the percentiles, the gain that brings it up to
  // LOG_DARK, and last frame's gain moved toward it
  var flags = 0u;
  if (P.adapt != 0u) {
    var total = 0.0;
    for (var i = 0u; i < BINS; i++) { total += f32(atomicLoad(&bins[i])) / FIXED; }
    let lo = LOW_PCT * total;
    let hi = HIGH_PCT * total;
    var cum = 0.0;
    var wSum = 0.0;
    var lSum = 0.0;
    for (var i = 0u; i < BINS; i++) {
      let w = f32(atomicLoad(&bins[i])) / FIXED;
      let part = max(min(cum + w, hi) - max(cum, lo), 0.0);   // this bin's share inside the band
      lSum += part * (LOG_MIN + (f32(i) + 0.5) / f32(BINS) * (LOG_MAX - LOG_MIN));
      wSum += part;
      cum += w;
    }
    var view = LOG_DARK;
    if (wSum > 0.0) { view = lSum / wSum; }
    var aim = 1.0;
    if (total > EMPTY) { aim = exp2(clamp(LOG_DARK - view, 0.0, MAX_EV)); }
    var g = state.gain;
    if (!(g > 0.0)) { g = 1.0; }   // the first frame starts adapted to daylight
    var tau = TAU_LIGHT;
    if (aim > g) { tau = TAU_DARK; }
    g += (aim - g) * (1.0 - exp(-P.dt / tau));
    if (abs(g - aim) <= SETTLED * aim) { g = aim; }
    state = AdaptState(g, aim, view, 0.0);
    flags |= 1u;
  }
  if (P.meter != 0u) { flags |= 2u; }
  if (P.slot != NO_SLOT) {
    let o = P.slot * ${RESULT_BYTES / 4}u;
    ring[o] = bitcast<u32>(state.gain);
    ring[o + 1u] = bitcast<u32>(state.aim);
    ring[o + 2u] = bitcast<u32>(state.view);
    ring[o + 3u] = bitcast<u32>(meterS[0]);
    ring[o + 4u] = bitcast<u32>(meterN[0]);
    ring[o + 5u] = flags;
  }
}
`;

/**
 * The composite: sharpen, bloom, exposure × adaptation, AgX (+ Punchy look, hot
 * roll-off), sRGB, night vision, dither; on the canvas (opaque) also the sky
 * behind the scene, the viewmodels over it and the glow added on top. Stills
 * (thumbnails) keep the scene's alpha instead.
 */
export const compositeWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${CompositeParams.wgsl}
struct AdaptState { gain: f32, aim: f32, view: f32, pad: f32, }
@group(2) @binding(0) var tColor: texture_2d<f32>;
@group(2) @binding(1) var tBloom: texture_2d<f32>;
@group(2) @binding(2) var smp: sampler;
@group(2) @binding(3) var<storage, read> adaptation: AdaptState;   // eye adaptation: gain (1 in daylight)
@group(2) @binding(4) var tViewmodel: texture_2d<f32>;   // the held tool: linear premultiplied, output size (F3)
@group(2) @binding(5) var tGlow: texture_2d<f32>;        // its glow layer, display values, added
@group(3) @binding(1) var<uniform> P: CompositeParams;

const SRGB_TO_REC2020: mat3x3f = mat3x3f(
  vec3f(0.6274, 0.0691, 0.0164), vec3f(0.3293, 0.9195, 0.0880), vec3f(0.0433, 0.0113, 0.8956));
const REC2020_TO_SRGB: mat3x3f = mat3x3f(
  vec3f(1.6605, -0.1246, -0.0182), vec3f(-0.5876, 1.1329, -0.1006), vec3f(-0.0728, -0.0083, 1.1187));
const AGX_INSET: mat3x3f = mat3x3f(
  vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const AGX_OUTSET: mat3x3f = mat3x3f(
  vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const AGX_MIN_EV: f32 = -12.47393; // log2(2^-10 · 0.18)
const AGX_MAX_EV: f32 = 4.026069;  // log2(2^6.5 · 0.18)
const AGX_GAMMA: f32 = 2.2;        // display gamma AgX's curve encodes for (decoded after the outset)
const PUNCHY_POWER: f32 = 1.35;    // Blender's AgX "Punchy" look: power on the encoded values…
const PUNCHY_SAT: f32 = 1.4;       // …and saturation around their luma

// AgX base contrast sigmoid: 6th-order polynomial fit (Wrensch 2023, as in three.js).
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// AgX log encoding, sigmoid and look, per channel (encoded display values out).
fn agxCurve(c0: vec3f) -> vec3f {
  var c = clamp((log2(max(c0, vec3f(1e-10))) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), vec3f(0.0), vec3f(1.0));
  c = agxContrast(c);
  c = pow(max(c, vec3f(0.0)), vec3f(mix(1.0, PUNCHY_POWER, P.look)));
  let l = dot(c, LUMA_709);
  return l + mix(1.0, PUNCHY_SAT, P.look) * (c - l);
}

// AgX (Blender / Filament / three.js) with an optional blend toward the "Punchy" look.
fn agx(c0: vec3f) -> vec3f {
  let c = agxCurve(AGX_INSET * (SRGB_TO_REC2020 * c0));
  return clamp(REC2020_TO_SRGB * pow(max(AGX_OUTSET * c, vec3f(0.0)), vec3f(AGX_GAMMA)), vec3f(0.0), vec3f(1.0));
}

// AgX desaturates bright colours on their way to white, so molten lava and
// flames come out pale peach. Film and camera sensors clip the dominant channel
// first instead: bright orange runs through amber and gold to white, the look of
// every photo of lava or fire (and of the eye's own Bezold–Brücke shift). So
// bright, clearly saturated pixels blend toward the same curve applied to each
// Rec.2020 channel alone (AgX's working space; in sRGB primaries the roll-off
// turns lemon yellow). Greys and everything in the sunlit range stay plain AgX:
// for a grey both curves agree exactly. The eye's shift moves bright hues toward
// its invariant ones (yellow, and blue at ~475 nm): warm light toward yellow, as
// the per-channel curve does, but violet toward blue, where that curve would turn
// it magenta. So only warm light (red over blue) takes it; the rest stays plain
// AgX, whose path to white keeps violet violet. (P.hot: blend start, full.)
const HOT_SAT_POW: f32 = 2.0;   // weight ∝ saturation^this: only clearly coloured light
const HOT_WARM_EDGE: f32 = 0.2; // (red - blue) / max channel over which the weight fades in
fn tonemap(c: vec3f) -> vec3f {
  let a = agx(c);
  let mx = max(c.r, max(c.g, c.b));
  let sat = 1.0 - min(c.r, min(c.g, c.b)) / max(mx, 1e-6);
  let warm = smoothstep(-HOT_WARM_EDGE, HOT_WARM_EDGE, (c.r - c.b) / max(mx, 1e-6));
  let w = smoothstep(P.hot.x, P.hot.y, mx) * pow(sat, HOT_SAT_POW) * warm;
  if (w <= 0.0) { return a; }
  let pc = pow(max(agxCurve(SRGB_TO_REC2020 * c), vec3f(0.0)), vec3f(AGX_GAMMA));
  return mix(a, clamp(REC2020_TO_SRGB * pc, vec3f(0.0), vec3f(1.0)), w);
}

// sRGB transfer function (IEC 61966-2-1).
fn srgbEncode(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

fn tm(c: vec3f) -> vec3f { return c / (1.0 + luma(c)); }
fn itm(c: vec3f) -> vec3f { return c / max(1.0 - luma(c), 1e-3); }

// AMD CAS: the cross taps get the negative lobe -amp / mix(SOFT, HARD, sharpen).
const CAS_LOBE_SOFT: f32 = 8.0;
const CAS_LOBE_HARD: f32 = 5.0;
// Output dither: interleaved gradient noise (Jimenez 2014), ±½ of one 8-bit step.
const IGN: vec3f = vec3f(0.06711056, 0.00583715, 52.9829189);
const DITHER_LEVELS: f32 = 255.0;  // output code values above 0
const DITHER_BLACK: f32 = 1e-5;    // max channel at or below which a pixel counts as exact black (no dither)
const NV_PHOSPHOR: vec3f = vec3f(${NV_PHOSPHOR.map(f).join(', ')});   // night vision's screen (NV_PHOSPHOR in JS)
const NV_GRAIN: f32 = 0.08;        // grain σ (display units) on a mid-grey picture at NV_GRAIN_GAIN...
const NV_GRAIN_GAIN: f32 = 16.0;   // ...this gain (one stack); σ ∝ √(picture·gain), shot noise
const NV_VIGNETTE: f32 = 0.6;      // darkening at the corners: the tube's round field of view...
const NV_VIGNETTE_START: f32 = 0.45; // ...starting this far out (share of the half-diagonal)
const UNIFORM_SIGMA: f32 = 3.4641016; // √12: a uniform variable in [−½, ½] scaled to σ 1
// PCG hash (Jarzynski & Olano 2020, "Hash Functions for GPU Rendering"): white noise for the grain.
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// u32 → f32 rounded to nearest on every device (H1.28)
fn u32ToF32(s: u32) -> f32 { return f32(s >> 8u) * 256.0 + f32(s & 255u); }
const U32_TO_UNIT: f32 = 1.0 / 4294967296.0;
fn nightVision(rad: vec3f, p: vec2i) -> vec3f {
  var t = tonemap(vec3f(luma(rad) * P.exposure * P.nightGain)).g;   // AgX on a grey: the screen's brightness
  let u = u32ToF32(pcg(u32(p.x) + pcg(u32(p.y) + pcg(P.nightSeed)))) * U32_TO_UNIT - 0.5;
  t += u * UNIFORM_SIGMA * NV_GRAIN * sqrt(max(t, 0.0) * P.nightGain / NV_GRAIN_GAIN);
  let q = (vec2f(p) + 0.5) / P.size - 0.5;
  let r = length(q * vec2f(P.size.x / P.size.y, 1.0)) / length(vec2f(0.5 * P.size.x / P.size.y, 0.5));
  t *= 1.0 - NV_VIGNETTE * smoothstep(NV_VIGNETTE_START, 1.0, r);
  return NV_PHOSPHOR * clamp(t, 0.0, 1.0);
}

// The page's sky (SKY in gfx/post.js, ui/styles.css), sRGB-encoded as CSS blends it:
// the linear gradient, then the warm radial glow over it.
const SKY_MID_AT: f32 = ${f(SKY.MID_AT)};
const SKY_GLOW_CENTRE: vec2f = ${vec2(SKY.GLOW_CENTRE)};
const SKY_GLOW_RADII: vec2f = ${vec2(SKY.GLOW_RADII)};
const SKY_GLOW_END: f32 = ${f(SKY.GLOW_END)};
fn sky(uv: vec2f) -> vec3f {
  var c = mix(P.skyTop, P.skyMid, saturate(uv.y / SKY_MID_AT));
  if (uv.y > SKY_MID_AT) { c = mix(P.skyMid, P.skyLow, saturate((uv.y - SKY_MID_AT) / (1.0 - SKY_MID_AT))); }
  let t = length((uv - SKY_GLOW_CENTRE) / SKY_GLOW_RADII) / SKY_GLOW_END;
  return mix(c, P.skyGlow.rgb, P.skyGlow.a * saturate(1.0 - t));
}

@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let p = vec2i(in.position.xy);
  let hi = vec2i(P.size) - 1;
  let uv = (vec2f(p) + 0.5) / P.size;
  let c = sanitize(textureLoad(tColor, p, 0));
  var rad = c.rgb;

  if (P.sharpen > 0.0) {
    // contrast-adaptive sharpening (AMD CAS, cross taps, luma-driven) in tone-mapped space
    let e = tm(c.rgb);
    let n = tm(sanitize(textureLoad(tColor, clamp(p + vec2i(0, 1), vec2i(0), hi), 0)).rgb);
    let s = tm(sanitize(textureLoad(tColor, clamp(p - vec2i(0, 1), vec2i(0), hi), 0)).rgb);
    let w = tm(sanitize(textureLoad(tColor, clamp(p - vec2i(1, 0), vec2i(0), hi), 0)).rgb);
    let r = tm(sanitize(textureLoad(tColor, clamp(p + vec2i(1, 0), vec2i(0), hi), 0)).rgb);
    let le = luma(e);
    let ln = luma(n);
    let ls = luma(s);
    let lw = luma(w);
    let lr = luma(r);
    let mnL = min(le, min(min(ln, ls), min(lw, lr)));
    let mxL = max(le, max(max(ln, ls), max(lw, lr)));
    let amp = sqrt(clamp(min(mnL, 1.0 - mxL) / max(mxL, 1e-4), 0.0, 1.0));
    let k = -amp / mix(CAS_LOBE_SOFT, CAS_LOBE_HARD, P.sharpen);
    rad = itm(max((e + k * (n + s + w + r)) / (1.0 + 4.0 * k), vec3f(0.0)));
  }

  if (P.bloom > 0.0) {
    let b = tent9(tBloom, smp, uv, P.bloomTexel);
    rad += P.bloom * (b - bright(c.rgb, P.thresh));
  }

  var gain = 1.0;
  if (P.adapt != 0u && adaptation.gain > 0.0) { gain = adaptation.gain; }
  var o: vec3f;
  if (P.raw != 0u) { o = srgbEncode(clamp(rad, vec3f(0.0), vec3f(1.0))); }
  else { o = srgbEncode(tonemap(max(rad, vec3f(0.0)) * (P.exposure * gain))); }
  if (P.night > 0.0 && P.raw == 0u) { o = mix(o, srgbEncode(nightVision(max(rad, vec3f(0.0)), p)), P.night); }
  // the canvas is opaque: the sky shows through where the scene's coverage is below 1,
  // premultiplied over, as the compositor blended the old transparent canvas over the page
  var a = c.a;
  if (P.opaque != 0u) {
    o += (1.0 - a) * sky(uv);
    a = 1.0;
  }
  // ±½ LSB dither against 8-bit banding; keep exact zeros exact
  let ign = fract(IGN.z * fract(dot(vec2f(p), IGN.xy)));
  o += (ign - 0.5) / DITHER_LEVELS * step(DITHER_BLACK, max(o.r, max(o.g, o.b)));
  o = clamp(o, vec3f(0.0), vec3f(1.0));

  // The held tool (pov/viewmodel.js): straight colour → the same tone map at the
  // exposure, without the adaptation gain → sRGB, premultiplied over. Tone mapping is
  // nonlinear, so it runs on straight colour: on premultiplied colour every partly
  // covered edge pixel would brighten into a pale outline. Transparent texels add 0.
  if (P.viewmodel != 0u) {
    let v = textureSampleLevel(tViewmodel, smp, uv, 0.0);
    if (v.a > 0.0) {
      let va = min(v.a, 1.0);
      var sc = v.rgb / v.a;
      sc = mix(sc, NV_PHOSPHOR * luma(sc), P.vmNight);   // the tool seen through the goggles too
      var e2: vec3f;
      if (P.raw != 0u) { e2 = srgbEncode(clamp(sc, vec3f(0.0), vec3f(1.0))); }
      else { e2 = srgbEncode(tonemap(max(sc, vec3f(0.0)) * P.exposure)); }
      o = e2 * va + o * (1.0 - va);
    }
  }
  // the hands' light, added over it all (its materials tone map themselves)
  if (P.glow != 0u) { o = clamp(o + textureSampleLevel(tGlow, smp, uv, 0.0).rgb, vec3f(0.0), vec3f(1.0)); }
  return vec4f(o, a);
}
`;

// ---------------------------------------------------------------- JS helpers

function halton(i, b) {
  let h = 1, r = 0;
  while (i > 0) { h /= b; r += h * (i % b); i = Math.floor(i / b); }
  return r;
}

// Mean, over where the nearest jittered sample can land (uniformly in one input
// pixel), of TAAU's closeness weight exp(-k·d²), d in output pixels.
function meanConfidence(scale) {
  let sum = 0;
  for (let i = 0; i < CONF_GRID; i++) {
    for (let j = 0; j < CONF_GRID; j++) {
      const x = ((i + 0.5) / CONF_GRID - 0.5) / scale, y = ((j + 0.5) / CONF_GRID - 0.5) / scale;
      sum += Math.exp(-BLACKMAN_HARRIS_K * (x * x + y * y));
    }
  }
  return sum / (CONF_GRID * CONF_GRID);
}

/**
 * The sizes post works at: output `size` (canvas or target), the scene's
 * `inSize` (× the render scale, TAAU below 1) and the bloom levels (down[i],
 * and up[i] for i < MIPS - 1), each max(1, size >> (i + 1)).
 * @param {number} w
 * @param {number} h
 * @param {number} [scale]
 */
export function postSizes(w, h, scale = 1) {
  w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
  const iw = Math.max(1, Math.round(w * scale)), ih = Math.max(1, Math.round(h * scale));
  const mips = Array.from({ length: MIPS }, (_, i) => [Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))]);
  return { size: [w, h], inSize: [iw, ih], mips };
}

// A CSS colour ('#rgb', '#rrggbb', 'rgb(r, g, b)') as sRGB-encoded 0..1, or null.
function cssColour(text) {
  const t = String(text ?? '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t);
  if (m) return [m[1], m[2], m[3]].map((x) => Number(x) / 255);
  return null;
}

/**
 * The sky's colours (SKY), sRGB-encoded 0..1: --sky-top and --sky-low from the
 * page's computed style when there is a page, read once at createPost.
 * @returns {{ top: number[], mid: number[], low: number[], glow: number[] }}
 */
export function skyColours() {
  let style = null;
  try { style = globalThis.document ? getComputedStyle(document.documentElement) : null; } catch { style = null; }
  const css = (name) => (style ? cssColour(style.getPropertyValue(name)) : null);
  return {
    top: css('--sky-top') ?? cssColour(SKY.top),
    mid: cssColour(SKY.mid),
    low: css('--sky-low') ?? cssColour(SKY.low),
    glow: [SKY.glow[0] / 255, SKY.glow[1] / 255, SKY.glow[2] / 255, SKY.glow[3]],
  };
}

// The scene target: three's RenderTarget when three draws meshes on this gpu (it
// can render only into its own targets; F3), else two textures of ours. Its
// colour is rgba16float, its depth depth32float (F1).
function createSceneTarget(gpu, label) {
  let three;   // (decided at the first resize: make post after three's renderer)
  let rt = null, color = null, depth = null, width = 0, height = 0, version = 0;
  const target = {
    label,
    /** three's RenderTarget (meshes render into it with loadOp load), or null */
    get rt() { return rt; },
    /** @returns {GPUTexture} */
    get color() { return color; },
    /** @returns {GPUTexture} */
    get depth() { return depth; },
    get width() { return width; },
    get height() { return height; },
    /** changes whenever the GPUTextures do */
    get version() { return version; },
    resize(w, h) {
      if (w === width && h === height && color) return;
      if (three === undefined) three = gpu.three?.renderer ?? null;
      if (three) {
        if (!rt) {
          rt = new RenderTarget(w, h, {
            type: HalfFloatType, depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
            minFilter: NearestFilter, magFilter: NearestFilter, depthTexture: new DepthTexture(w, h, FloatType),
          });
          rt.texture.name = `${label} colour`;
          rt.depthTexture.name = `${label} depth`;
        } else rt.setSize(w, h);
        initRenderTarget(three, rt);
        color = gpuTextureOf(three, rt.texture);
        depth = gpuTextureOf(three, rt.depthTexture);
      } else {
        color?.destroy();
        depth?.destroy();
        const usage = TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | TEX.COPY_SRC;
        color = gpu.createTexture({ label: `${label} colour`, size: [w, h], format: HDR, usage });
        depth = gpu.createTexture({ label: `${label} depth`, size: [w, h], format: 'depth32float', usage });
      }
      width = w; height = h; version++;
    },
    // three recreates its GPUTextures on a samples change and after dispose
    // (B10): fetch them again, true when they changed
    refresh() {
      if (!three || !rt) return false;
      const c = gpuTextureOf(three, rt.texture), d = gpuTextureOf(three, rt.depthTexture);
      if (c === color && d === depth) return false;
      color = c; depth = d; version++;
      return true;
    },
    // bytes three holds for it (gpu.memory() counts ours)
    get threeBytes() { return rt ? width * height * (8 + 4) : 0; },
    destroy() {
      if (rt) { rt.depthTexture?.dispose(); rt.dispose(); } else { color?.destroy(); depth?.destroy(); }
      rt = color = depth = null; width = height = 0;
    },
  };
  return target;
}

/**
 * @param {object} gpu the gpu from createGpu (src/gpu/device.js)
 * @param {{ presenter?: object, pixScale?: { value: number }, sky?: object, readable?: boolean }} [opts]
 *   presenter: the canvas's (src/gpu/present.js), for render(…, null) and screenshots;
 *   pixScale: set to an output pixel's size in rendered pixels before each scene
 *   (the shaders' LOD bias, FrameUniforms.pixScale); sky: skyColours() to use;
 *   readable: tests only, the history and bloom levels get COPY_SRC so a tool can read them
 * @returns post-processing pipeline; see the file header.
 */
export function createPost(gpu, { presenter = null, pixScale = null, sky = skyColours(), readable = false } = {}) {
  const L = Object.fromEntries(Object.entries(POST_LAYOUTS).map(([k, entries]) => [k, gpu.layout(`POST_${k}`, entries)]));
  const fsTarget = (entry = 'fs', format = HDR) => ({ entry, targets: [{ format }] });
  const pipes = {
    taa: gpu.renderPipeline({ name: 'taa', code: taaWGSL(), layouts: [, , L.TAA], params: TaaParams, fragment: fsTarget('taa') }),
    taau: gpu.renderPipeline({ name: 'taau', code: taaWGSL(), layouts: [, , L.TAA], params: TaaParams, fragment: fsTarget('taau') }),
    prefilter: gpu.renderPipeline({ name: 'prefilter', code: prefilterWGSL(), layouts: [, , L.PAIR], params: PrefilterParams, fragment: fsTarget() }),
    up0: gpu.renderPipeline({ name: 'bloomUp0', code: bloomUp0WGSL(), layouts: [, , L.PAIR], params: MipParams, fragment: fsTarget() }),
    down: gpu.kernel({ name: 'bloomDown', code: bloomWGSL(), entry: 'down', layouts: [, , L.MIP], params: MipParams, workgroupSize: [BLOOM_TILE, BLOOM_TILE, 1] }),
    up: gpu.kernel({ name: 'bloomUp', code: bloomWGSL(), entry: 'up', layouts: [, , L.MIP], params: MipParams, workgroupSize: [BLOOM_TILE, BLOOM_TILE, 1] }),
    reduce: gpu.kernel({ name: 'postReduce', code: reduceWGSL(), layouts: [, , L.REDUCE], params: ReduceParams, workgroupSize: [REDUCE_THREADS, 1, 1] }),
  };
  const composites = new Map();
  const compositeFor = (format) => {
    let p = composites.get(format);
    if (!p) {
      p = gpu.renderPipeline({ name: `composite ${format}`, code: compositeWGSL(), layouts: [, , L.COMPOSITE], params: CompositeParams, fragment: fsTarget('fs', format) });
      composites.set(format, p);
    }
    return p;
  };
  if (presenter) compositeFor(presenter.format);
  compositeFor('rgba8unorm');   // stills and thumbnails (F5)
  const allPipes = () => [...Object.values(pipes), ...composites.values()];

  const sampler = gpu.device.createSampler({ label: 'post linear', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  // eye adaptation's state (gain, target, view), updated in place by the reduce kernel
  const adaptState = gpu.createBuffer({ label: 'post adaptation', size: 16, usage: BUF.STORAGE | BUF.COPY_SRC | BUF.COPY_DST });
  const results = gpu.readback.ring('post', RESULT_BYTES, RESULT_SLOTS);
  // bound where a viewmodel, glow or bloom texture is absent
  const blank = gpu.createTexture({ label: 'post blank', size: [1, 1], format: HDR, usage: TEX.TEXTURE_BINDING });

  const main = createSceneTarget(gpu, 'scene');
  const still = createSceneTarget(gpu, 'still');
  let active = main;
  let size = [0, 0], inSize = [0, 0];
  let history = [], down = [], up = [], cur = 0;
  let confScale = 0, meanConf = 1;
  let historyValid = false, frame = 0, lastTaa = null, prevCamera = null;
  let jitter = [0, 0];
  const prevVP = new Matrix4(), curVP = new Matrix4(), invVP = new Matrix4(), reproj = new Matrix4();
  const prevPos = new Vector3(), prevQuat = new Quaternion();
  const savedProj = new Matrix4(), savedProjInv = new Matrix4();
  let jittered = null;
  // adaptation and the meter, read back 1–3 frames late, one read at a time
  let reading = false, adaptSeen = null, adaptOn = false, meterAt = 0;

  // views and bind groups, made once per texture (per resize: B6) and reused
  const views = new WeakMap();
  const viewOf = (t) => { let v = views.get(t); if (!v) views.set(t, v = t.createView({ label: t.label })); return v; };
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { let id = ids.get(o); if (!id) ids.set(o, id = nextId++); return id; };
  let groups = new Map();
  const group = (layout, textures, entries) => {
    const key = `${layout.label}|${textures.map(idOf).join(',')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = gpu.bindGroup(layout, entries(), key));
    return g;
  };
  const texEntry = (binding, t) => ({ binding, resource: viewOf(t) });
  const samplerEntry = (binding) => ({ binding, resource: sampler });

  const make = (label, [w, h], usage) => gpu.createTexture({ label, size: [w, h], format: HDR, usage });
  // (F7: attachments are RENDER_ATTACHMENT | TEXTURE_BINDING only, so they stay compressible)
  const COPY = readable ? TEX.COPY_SRC : 0;
  const ATTACH = TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | COPY;
  const STORE = TEX.STORAGE_BINDING | TEX.TEXTURE_BINDING | COPY;

  const settingsOf = () => ({ ...POST_DEFAULTS, ...post.settings });
  const ready = Promise.all(allPipes().map((p) => p.ready)).then(() => post);
  ready.catch(() => {});

  // a render pass of ours that overwrites every pixel of `view` with one draw
  const drawPass = (pipe, view, name, bind, params) => {
    const rp = gpu.frame.render({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: CLEAR }] }, name);
    pipe.draw(rp, { bind: [, , bind], params });
    rp.end();
  };
  const sizeOf = (t) => [t.width, t.height];
  const texel = (t) => [1 / t.width, 1 / t.height];

  const post = {
    settings: { ...POST_DEFAULTS },
    /** Log-average scene luminance (linear, before exposure) while settings.meter is on; null before the first reading or with no scene in view. */
    sceneLuma: null,
    /** Optional profiling hook: onPass(name, { kind }) after the scene, 'taa', 'bloom' and 'composite'. */
    onPass: null,
    /** Optional: called when an adaptation or meter reading lands (a sleeping frame loop may want to wake). */
    onRead: null,
    /** Resolves when every pipeline post draws with is built (B5: boot awaits it). */
    ready,
    /** Every pipeline is built. */
    get isReady() { return allPipes().every((p) => p.state === 'ready'); },
    /** Output size [w, h] (canvas or target). */
    get size() { return [...size]; },
    /** The scene's size [w, h]: the output size × the render scale (the still's size during renderStill). */
    get inSize() { return active === still ? [still.width, still.height] : [...inSize]; },
    /** This frame's jitter, pixels from the pixel centre, y down (FrameUniforms.jitter, F4); none during renderStill. */
    get jitter() { return active === still ? [0, 0] : [...jitter]; },
    /** The target the scene is drawn into now ({ rt, color, depth, width, height }): the main one, or the still's during renderStill. */
    get sceneTarget() { return active; },
    /** Every texture post holds, for memory estimates (gpu.memory() counts ours; threeBytes is three's share). */
    get allTargets() { return [main.color, main.depth, still.color, still.depth, ...history, ...down, ...up].filter(Boolean); },
    /** Bytes of the scene targets three holds (not in gpu.memory()). */
    get threeBytes() { return main.threeBytes + still.threeBytes; },
    /** Eyes still adjusting (the view should keep rendering until they settle). */
    get adapting() { return adaptOn && !!adaptSeen && adaptSeen.gain !== adaptSeen.target; },
    /** Last gain read back: { gain, target, view (log2 luminance) }, or null. */
    get adaptation() { return adaptSeen; },
    /** A reading is in flight (deep idle waits for it, F7). */
    get reading() { return reading; },
    /** Current-frame weight TAA settles with (for how long the view needs to converge). */
    get settleWeight() { return upscaling() ? TAAU_WEIGHT_STABLE : TAA_WEIGHT_STABLE; },
    /** Render scale per axis the next render uses (upscaling is TAA's job). */
    get renderScale() {
      const s = settingsOf();
      return s.taa ? s.upscale * Math.min(1, Math.max(0.6, s.resolutionScale)) : 1;
    },
    /** GPUTextures: { scene, depth, history, bloom, down, up } (width and height on each). */
    get targets() { return { scene: main.color, depth: main.depth, history: history[cur], bloom: up[0] ?? down[0], down, up }; },

    /**
     * Output size in pixels (defaults to the presenter's canvas); the scene
     * renders at `scale` of it per axis. Allocates on a change only.
     */
    setSize(w, h, scale = 1) {
      if (w === undefined) {
        const canvas = presenter?.canvas;
        if (!canvas) throw new Error('post.setSize: no size and no presenter canvas');
        w = canvas.width; h = canvas.height;
      }
      const z = postSizes(w, h, scale);
      if (z.size[0] === size[0] && z.size[1] === size[1] && z.inSize[0] === inSize[0] && z.inSize[1] === inSize[1] && main.color) return;
      const outChanged = z.size[0] !== size[0] || z.size[1] !== size[1] || !history.length;
      size = z.size; inSize = z.inSize;
      main.resize(inSize[0], inSize[1]);
      if (outChanged) {
        [...history, ...down, ...up].forEach((t) => t.destroy());
        history = [0, 1].map((i) => make(`post history ${i}`, size, ATTACH));
        down = z.mips.map((m, i) => make(`post down ${i}`, m, i === 0 ? ATTACH : STORE));
        up = z.mips.slice(0, MIPS - 1).map((m, i) => make(`post up ${i}`, m, i === 0 ? ATTACH : STORE));
      }
      groups = new Map();
      post.reset();
    },

    /** Drop the TAA history (call after scene swaps, teleports, etc.). */
    reset() { historyValid = false; },

    /**
     * E1's start: sizes the targets for the output (`target` or the canvas),
     * jitters `camera.projectionMatrix` in place (F4), sets pixScale. Then
     * write FrameUniforms from the camera and record the scene pass into
     * post.sceneTarget (sceneDescriptor()), three's meshes after it.
     * @param {object} camera a three camera in WebGPU's coordinate system
     * @param {{ target?: { width: number, height: number } | null }} [opts]
     */
    beginScene(camera, { target = null } = {}) {
      const s = settingsOf();
      const scale = post.renderScale;
      if (target) post.setSize(target.width, target.height, scale); else post.setSize(undefined, undefined, scale);
      if (main.refresh()) groups = new Map();
      active = main;

      camera.updateMatrixWorld();
      curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (s.taa !== lastTaa || camera !== prevCamera || cameraJumped(camera)) post.reset();
      lastTaa = s.taa;
      prevCamera = camera;
      prevPos.setFromMatrixPosition(camera.matrixWorld);
      prevQuat.setFromRotationMatrix(camera.matrixWorld);

      // sub-pixel jitter when TAA is on. Upscaled, one input pixel spans 1/scale²
      // output pixels: the cycle is that much longer.
      const period = upscaling() ? JITTER_PERIOD * Math.ceil(1 / (scale * scale)) : JITTER_PERIOD;
      jitter = s.taa ? [halton((frame % period) + 1, 2) - 0.5, halton((frame % period) + 1, 3) - 0.5] : [0, 0];
      savedProj.copy(camera.projectionMatrix);
      savedProjInv.copy(camera.projectionMatrixInverse);
      jittered = camera;
      if (s.taa) {
        // (jx, jy) pixels with y down: NDC x moves by 2·jx/w, NDC y (up) by −2·jy/h
        const e = camera.projectionMatrix.elements;
        const ox = (2 * jitter[0]) / inSize[0], oy = (-2 * jitter[1]) / inSize[1];
        for (let c = 0; c < 4; c++) { e[c * 4] += ox * e[c * 4 + 3]; e[c * 4 + 1] += oy * e[c * 4 + 3]; }
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      if (pixScale) pixScale.value = inSize[0] / size[0];
    },

    /**
     * The scene pass's descriptor: post.sceneTarget's colour cleared to 0 and
     * depth to 1, both stored (TAA reads the depth).
     * @returns {GPURenderPassDescriptor}
     */
    sceneDescriptor() {
      return {
        colorAttachments: [{ view: viewOf(active.color), loadOp: 'clear', storeOp: 'store', clearValue: CLEAR }],
        depthStencilAttachment: { view: viewOf(active.depth), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      };
    },

    /**
     * E2's overlay pass's descriptor (the rays sprites): colour loaded, depth read-only.
     * @returns {GPURenderPassDescriptor}
     */
    overlayDescriptor() {
      return {
        colorAttachments: [{ view: viewOf(active.color), loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: viewOf(active.depth), depthReadOnly: true },
      };
    },

    /** E1's end: the camera's projection without the jitter again. */
    endScene(camera = jittered) {
      if (!camera || camera !== jittered) return;
      camera.projectionMatrix.copy(savedProj);
      camera.projectionMatrixInverse.copy(savedProjInv);
      jittered = null;
    },

    /**
     * E2: TAA, bloom, adaptation and the composite into `target` (null: the
     * canvas, through the presenter). Call after beginScene, the scene pass
     * and endScene.
     * @param {{ target?: object | null, dt?: number, viewmodel?: GPUTexture | null, glow?: GPUTexture | null }} [opts]
     *   target: a GPUTexture or { view, width, height, format }; viewmodel, glow:
     *   the held tool's resolved target and its glow layer (F3), canvas only
     */
    finish({ target = null, dt = ADAPT.DT, viewmodel = null, glow = null } = {}) {
      const s = settingsOf();
      const f = gpu.frame;
      const scene = main.color, depth = main.depth;

      // TAA resolve
      let color = scene;
      if (s.taa) {
        const upscale = upscaling();
        const scale = inSize[0] / size[0];
        if (upscale && confScale !== scale) { meanConf = meanConfidence(scale); confScale = scale; }
        invVP.copy(curVP).invert();
        reproj.multiplyMatrices(prevVP, invVP);
        const src = history[cur];
        cur = 1 - cur;
        const bind = group(L.TAA, [scene, depth, src], () => [texEntry(0, scene), texEntry(1, depth), texEntry(2, src), samplerEntry(3)]);
        drawPass(upscale ? pipes.taau : pipes.taa, viewOf(history[cur]), 'taa', bind, {
          reproj, jitter, size, inSize, historyValid,
          weight: [upscale ? TAAU_WEIGHT_STABLE : TAA_WEIGHT_STABLE, TAA_WEIGHT_CHANGING], meanConf,
        });
        post.onPass?.('taa', { kind: 'render' });
        color = history[cur];
        historyValid = true;
      }
      prevVP.copy(curVP);
      frame++;

      adaptOn = s.adapt && !s.raw;   // (the data views and the plain view keep their exact colours)
      const bloomOn = s.bloom > 0 && !s.raw;
      const meterNow = s.meter && !s.raw && !reading && frame >= meterAt;
      const thresh = [s.bloomThreshold, Math.max(s.bloomKnee, 1e-3)];

      // bloom's prefilter, at half resolution
      if (bloomOn) drawPass(pipes.prefilter, viewOf(down[0]), 'prefilter', group(L.PAIR, [color, color], () => [texEntry(0, color), texEntry(1, color), samplerEntry(2)]), { thresh });

      // one compute pass: bloom down 1–5, up 4–1, then the reductions
      if (bloomOn || adaptOn || meterNow) {
        // (named for the profiler; in its split mode every dispatch is a pass of its own)
        if (!(gpu.timing?.split && gpu.timing?.enabled)) f.compute('post');
        if (bloomOn) {
          const mip = (k, src, high, dst, extra) => k.dispatch(f, [Math.ceil(dst.width / BLOOM_TILE), Math.ceil(dst.height / BLOOM_TILE), 1], {
            bind: [, , group(L.MIP, [src, high, dst], () => [texEntry(0, src), texEntry(1, high), samplerEntry(2), texEntry(3, dst)])],
            params: { texel: texel(src), dst: sizeOf(dst), ...extra },
          });
          for (let i = 1; i < MIPS; i++) mip(pipes.down, down[i - 1], down[i - 1], down[i]);
          for (let i = MIPS - 2; i >= 1; i--) mip(pipes.up, i === MIPS - 2 ? down[MIPS - 1] : up[i + 1], down[i], up[i], { scatter: s.bloomScatter });
        }
        if (adaptOn || meterNow) {
          const want = !reading;
          if (meterNow) meterAt = frame + METER_INTERVAL;
          const slot = want ? results.next() : NO_SLOT;   // (right before the dispatch that writes it, B7)
          pipes.reduce.dispatch(f, [1, 1, 1], {
            bind: [, , group(L.REDUCE, [color], () => [texEntry(0, color), samplerEntry(1), { binding: 2, resource: { buffer: adaptState } }, { binding: 3, resource: { buffer: results.buffer } }])],
            params: { dt, adapt: adaptOn, meter: meterNow, slot },
          });
          if (want) read(slot);
        }
      }

      // bloom's last upsample, at half resolution
      if (bloomOn) {
        drawPass(pipes.up0, viewOf(up[0]), 'bloomUp0', group(L.PAIR, [up[1], down[0]], () => [texEntry(0, up[1]), texEntry(1, down[0]), samplerEntry(2)]),
          { texel: texel(up[1]), dst: sizeOf(up[0]), scatter: s.bloomScatter });
        post.onPass?.('bloom', { kind: 'render' });
      }

      // the composite: into the canvas (opaque, over the sky, viewmodel and glow) or a target
      const out = outputOf(target);
      const pipe = compositeFor(out.format);
      if (pipe.state !== 'ready') throw new Error(`post: the composite for ${out.format} isn't built yet (await post.ready, or render to it once and wait)`);
      const bloomTex = bloomOn ? up[0] : blank;
      const vm = out.canvas && viewmodel ? viewmodel : blank, gl = out.canvas && glow ? glow : blank;
      const bind = group(L.COMPOSITE, [color, bloomTex, vm, gl], () => [
        texEntry(0, color), texEntry(1, bloomTex), samplerEntry(2), { binding: 3, resource: { buffer: adaptState } }, texEntry(4, vm), texEntry(5, gl),
      ]);
      const rp = f.render({ colorAttachments: [out.attachment] }, out.canvas ? 'canvas' : 'composite');
      pipe.draw(rp, {
        bind: [, , bind],
        params: compositeParams(s, size, {
          bloomTexel: texel(bloomTex), bloom: bloomOn ? s.bloom : 0, sharpen: s.taa && !s.raw ? s.sharpen : 0,
          adapt: adaptOn, night: s.raw ? 0 : s.night, nightSeed: frame, opaque: out.canvas,
          viewmodel: vm !== blank, glow: gl !== blank, vmNight: s.raw ? 0 : s.night,
        }),
      });
      rp.end();
      post.onPass?.('composite', { kind: 'render' });
    },

    /**
     * Render a frame through the pipeline into `target` (null = the canvas):
     * beginScene, the scene pass, meshes, the overlay, endScene, finish. Tools
     * wrap this to count view frames.
     * @param {{ prepare?: Function, draw?: Function, meshes?: Function, overlay?: Function } | Function | null} scene
     *   the frame's parts (see the file header); a function is draw alone
     * @param {object} camera
     * @param {object | null} [target] a GPUTexture or { view, width, height, format }
     * @param {number} [dt] s since the last frame (eye adaptation's time course)
     * @param {{ viewmodel?: GPUTexture | null, glow?: GPUTexture | null }} [extra]
     * @returns {boolean} false while post's pipelines are still building (nothing recorded)
     */
    render(scene, camera, target = null, dt = ADAPT.DT, { viewmodel = null, glow = null } = {}) {
      if (!post.isReady) return false;
      const hooks = hooksOf(scene);
      const out = target ? outputOf(target) : null;
      post.beginScene(camera, { target: out });
      try {
        drawScene(hooks);
      } finally {
        post.endScene(camera);
      }
      post.finish({ target, dt, viewmodel, glow });
      return true;
    },

    /**
     * One-off render (thumbnails, captures) into `target` at its own size: HDR scene
     * + tone mapping, no TAA, no bloom, no night vision, the last adaptation gain;
     * history untouched. The output keeps the scene's alpha (premultiplied).
     * @param {object} scene the frame's parts, as render() takes them
     * @param {object} camera
     * @param {object} target a GPUTexture (rgba8unorm with RENDER_ATTACHMENT) or { view, width, height, format }
     * @returns {boolean} false while post's pipelines are still building
     */
    renderStill(scene, camera, target) {
      if (!post.isReady) return false;
      const out = outputOf(target);
      const pipe = compositeFor(out.format);
      if (pipe.state !== 'ready') return false;
      const s = settingsOf();
      still.resize(out.width, out.height);
      still.refresh();
      const was = active;
      active = still;
      try {
        if (pixScale) pixScale.value = 1;
        camera.updateMatrixWorld();
        drawScene(hooksOf(scene));
      } finally {
        active = was;
      }
      const adapt = s.adapt && !s.raw;
      const bind = group(L.COMPOSITE, [still.color, blank, blank, blank], () => [
        texEntry(0, still.color), texEntry(1, blank), samplerEntry(2), { binding: 3, resource: { buffer: adaptState } }, texEntry(4, blank), texEntry(5, blank),
      ]);
      const rp = gpu.frame.render({ colorAttachments: [out.attachment] }, 'still');
      pipe.draw(rp, {
        bind: [, , bind],
        params: compositeParams(s, [out.width, out.height], { bloomTexel: [1, 1], bloom: 0, sharpen: 0, adapt, night: 0, nightSeed: 0, opaque: false, viewmodel: false, glow: false, vmNight: 0 }),
      });
      rp.end();
      return true;
    },

    /**
     * The canvas as this frame presented it (F5's screenshot fallback: call it
     * in the task that drew the frame), R, G, B, A whatever the canvas format.
     * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
     */
    capture() {
      if (!presenter) return Promise.reject(new Error('post.capture: no presenter'));
      return presenter.capture();
    },

    /** The adaptation state's GPU buffer (gain, target, view as f32): tools read it. */
    get adaptationBuffer() { return adaptState; },

    dispose() {
      [...history, ...down, ...up, blank].forEach((t) => t.destroy());
      history = []; down = []; up = [];
      main.destroy();
      still.destroy();
      adaptState.destroy();
      groups = new Map();
    },
  };

  // The scene pass and what follows it in E1: the meshes (three's own submit)
  // and E2's overlay. Everything here draws into `active`.
  function drawScene(hooks) {
    hooks.prepare?.(post);
    const rp = gpu.frame.render(post.sceneDescriptor(), 'scene');
    try { hooks.draw?.(rp, post); } finally { rp.end(); }
    hooks.meshes?.(post);
    if (hooks.overlay) {
      const op = gpu.frame.render(post.overlayDescriptor(), 'overlay');
      try { hooks.overlay(op, post); } finally { op.end(); }
    }
    post.onPass?.('scene', { kind: 'render' });
  }

  function hooksOf(scene) {
    if (!scene) return {};
    if (typeof scene === 'function') return { draw: scene };
    if (scene.isObject3D) throw new Error('post.render takes the frame\'s parts ({ prepare, draw, meshes, overlay }), not a three scene (docs/webgpu.md F1)');
    return scene;
  }

  // the composite's output: the presenter's current texture (null), a GPUTexture, or { view, width, height, format }
  function outputOf(target) {
    if (!target) {
      if (!presenter) throw new Error('post: no target and no presenter');
      const t = presenter.texture();
      return { canvas: true, width: t.width, height: t.height, format: presenter.format, attachment: presenter.attachment() };
    }
    const view = target.view ?? viewOf(target);
    return {
      canvas: false, width: target.width, height: target.height, format: target.format,
      attachment: { view, loadOp: 'clear', storeOp: 'store', clearValue: CLEAR },
    };
  }

  function compositeParams(s, outSize, o) {
    return {
      size: outSize, bloomTexel: o.bloomTexel, thresh: [s.bloomThreshold, Math.max(s.bloomKnee, 1e-3)], hot: [s.hotStart, s.hotFull],
      bloom: o.bloom, exposure: 2 ** s.exposure, sharpen: o.sharpen, look: s.look,
      raw: s.raw, adapt: o.adapt, night: o.night, nightGain: s.nightGain,
      nightSeed: o.nightSeed >>> 0, opaque: o.opaque, viewmodel: o.viewmodel, glow: o.glow, vmNight: o.vmNight,
      skyTop: sky.top, skyMid: sky.mid, skyLow: sky.low, skyGlow: sky.glow,
    };
  }

  // the slot's adaptation and meter values, when the flush that copies it has mapped
  function read(slot) {
    reading = true;
    results.read(slot).then((bytes) => {
      const v = new Float32Array(bytes), flags = new Uint32Array(bytes)[5];
      if (flags & 1) adaptSeen = { gain: v[0], target: v[1], view: v[2] };
      if (flags & 2) post.sceneLuma = v[4] > 0 ? Math.max(0, Math.exp(v[3] / v[4]) - METER_LOG_FLOOR) : null;
    }).catch(() => {}).finally(() => {
      reading = false;
      post.onRead?.();
    });
  }

  // Is the scene rendering below output size (TAAU)?
  function upscaling() { return inSize[0] !== size[0] || inSize[1] !== size[1]; }

  // Teleports and very fast moves: history would be mostly disoccluded anyway.
  const _p = new Vector3(), _q = new Quaternion();
  function cameraJumped(camera) {
    if (!historyValid) return false;
    _p.setFromMatrixPosition(camera.matrixWorld);
    _q.setFromRotationMatrix(camera.matrixWorld);
    const move = _p.distanceTo(prevPos);
    return move > JUMP_MOVE_FRAC * Math.max(prevPos.length(), 1) || _q.angleTo(prevQuat) > JUMP_TURN;
  }

  return post;
}

// ---------------------------------------------------------------- tools/check-wgsl.mjs

const ENTRIES = (layout) => () => [undefined, undefined, layout];
const render = (name, code, layout, entry = 'fs', format = HDR) => ({
  name, kind: 'render', grids: false, code, layouts: ENTRIES(layout), vertex: { entry: 'vs' }, fragment: { entry, targets: [{ format }] },
});
/** The pipelines post builds (docs/webgpu.md I1, B5: the start menu warms the same list). */
export const WGSL_CHECK = [
  render('taa', taaWGSL, POST_LAYOUTS.TAA, 'taa'),
  render('taau', taaWGSL, POST_LAYOUTS.TAA, 'taau'),
  render('prefilter', prefilterWGSL, POST_LAYOUTS.PAIR),
  render('bloomUp0', bloomUp0WGSL, POST_LAYOUTS.PAIR),
  { name: 'bloomDown', kind: 'compute', grids: false, code: bloomWGSL, entry: 'down', layouts: ENTRIES(POST_LAYOUTS.MIP) },
  { name: 'bloomUp', kind: 'compute', grids: false, code: bloomWGSL, entry: 'up', layouts: ENTRIES(POST_LAYOUTS.MIP) },
  { name: 'postReduce', kind: 'compute', grids: false, code: reduceWGSL, layouts: ENTRIES(POST_LAYOUTS.REDUCE), dispatch: () => [1, 1, 1] },
  render('composite bgra8unorm', compositeWGSL, POST_LAYOUTS.COMPOSITE, 'fs', 'bgra8unorm'),
  render('composite rgba8unorm', compositeWGSL, POST_LAYOUTS.COMPOSITE, 'fs', 'rgba8unorm'),
];
