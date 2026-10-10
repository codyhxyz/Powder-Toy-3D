import * as THREE from 'three';

// HDR post-processing: scene → RGBA16F (+ depth) → TAA → bloom → AgX → sRGB canvas.
//
//   const post = createPost(renderer);
//   post.render(scene, camera);          // instead of renderer.render(scene, camera)
//   post.reset();                        // after anything that invalidates history
//   post.settings.taa / .upscale / .bloom / .exposure (EV) / .sharpen / .look / .raw / .hotStart / .hotFull
//
// The scene is rendered as linear, premultiplied HDR radiance. The canvas stays
// transparent: tone mapping is applied to the premultiplied colour ("over black"),
// so opaque pixels are exact, coverage at silhouettes is resolved in linear light,
// and emissive media / bloom add light over the page background.
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
// sampled on a coarse grid, scattered into a log-luminance histogram (points with
// additive blending: Scheuermann & Hensley 2007), and the mean of the histogram
// between two percentiles (Unreal's; it ignores the darkest pixels and small bright
// lights) says how bright the view is. Over ADAPT.LOG_DARK nothing changes; under it
// the exposure rises by what brings it back there, up to ADAPT.MAX_EV, with the
// exponential time course of visual adaptation (Pattanaik et al. 2000, as in
// Krawczyk et al. 2005): slow into the dark, quick back into the light.

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

const MIPS = 6;
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

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 oColor;

const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722); // Rec.709 luminance weights (linear sRGB)
float luma(vec3 c) { return dot(c, LUMA_709); }

// NaN → 0, +Inf → large, negatives → 0, then a hue-preserving cap. The NaN/Inf test is
// done on the bits, so it survives compilers that assume finite maths.
const float MAX_RADIANCE = 4096.0;
const uint F32_INF = 0x7f800000u;  // IEEE-754 +Inf bits; any larger magnitude is a NaN
const uint F32_ABS = 0x7fffffffu;  // mask that clears the sign bit
vec4 sanitize(vec4 c) {
  uvec4 b = floatBitsToUint(c);
  c = mix(c, vec4(MAX_RADIANCE), equal(b, uvec4(F32_INF)));
  c = mix(c, vec4(0.0), greaterThan(b & F32_ABS, uvec4(F32_INF)));
  c = max(c, vec4(0.0));
  float m = max(c.r, max(c.g, c.b));
  c.rgb *= m > MAX_RADIANCE ? MAX_RADIANCE / m : 1.0;
  c.a = min(c.a, 1.0);
  return c;
}

// Soft-knee bright pass on the max channel: the share of the light that blooms.
uniform vec2 uThresh; // threshold, knee
vec3 bright(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThresh.x + uThresh.y, 0.0, 2.0 * uThresh.y);
  rq = rq * rq / (4.0 * uThresh.y + 1e-4);
  return c * (max(rq, br - uThresh.x) / max(br, 1e-4));
}

// 3×3 tent: binomial weights 1-2-1 ⊗ 1-2-1 (sum 16).
vec3 tent9(sampler2D t, vec2 uv, vec2 texel) {
  vec4 d = vec4(texel, -texel.x, 0.0);
  vec3 s = texture(t, uv - d.xy).rgb + texture(t, uv - d.zy).rgb
         + texture(t, uv + d.zy).rgb + texture(t, uv + d.xy).rgb;
  s += 2.0 * (texture(t, uv - d.wy).rgb + texture(t, uv + d.zw).rgb
            + texture(t, uv + d.xw).rgb + texture(t, uv + d.wy).rgb);
  s += 4.0 * texture(t, uv).rgb;
  return s * (1.0 / 16.0);
}
`;

const TAA_LIB = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tHistory;
uniform mat4 uReproj;      // prevViewProj · inverse(curViewProj), both unjittered
uniform vec2 uJitter;      // where this frame sampled, in pixels from the pixel centre
uniform vec2 uSize;
uniform bool uHistoryValid;
uniform vec2 uWeight;      // current-frame weight (stable, changing)
const float BLACKMAN_HARRIS_K = ${BLACKMAN_HARRIS_K};
const float FLICKER_LUMA_FLOOR = 0.2;  // anti-flicker: differences are relative to max(luma, this) (tone-mapped luma)

vec3 rgb2ycocg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 ycocg2rgb(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// Work in a reversibly tone-mapped space (c / (1 + luma)) so HDR edges resolve
// without aliasing and bright outliers can't dominate the blend.
vec4 toSpace(vec4 c) { return vec4(rgb2ycocg(c.rgb / (1.0 + luma(c.rgb))), c.a); }
vec4 fromSpace(vec4 t) {
  vec3 c = max(ycocg2rgb(t.xyz), 0.0);
  return vec4(c / max(1.0 - luma(c), 1e-3), t.w);
}

// Catmull-Rom in 5 bilinear taps (corners dropped).
vec4 historyCR(vec2 uv) {
  vec2 pos = uv * uSize;
  vec2 c1 = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (c1 - 1.0) / uSize, t3 = (c1 + 2.0) / uSize, t12 = (c1 + w2 / w12) / uSize;
  float a = w12.x * w0.y, b = w0.x * w12.y, c = w12.x * w12.y, d = w3.x * w12.y, e = w12.x * w3.y;
  vec4 s = texture(tHistory, vec2(t12.x, t0.y)) * a + texture(tHistory, vec2(t0.x, t12.y)) * b
         + texture(tHistory, t12) * c + texture(tHistory, vec2(t3.x, t12.y)) * d
         + texture(tHistory, vec2(t12.x, t3.y)) * e;
  return s / (a + b + c + d + e);
}

// Clip the segment p → q against the box (p inside), Playdead-style, in 4D.
vec4 clipBox(vec4 bmin, vec4 bmax, vec4 p, vec4 q) {
  vec4 r = q - p;
  vec4 hi = bmax - p, lo = bmin - p;
  float s = 1.0;
  for (int i = 0; i < 4; i++) {
    if (r[i] > hi[i] + 1e-6) s = min(s, hi[i] / r[i]);
    else if (r[i] < lo[i] - 1e-6) s = min(s, lo[i] / r[i]);
  }
  return p + r * s;
}
`;

const TAA_FRAG = /* glsl */ `
${TAA_LIB}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = ivec2(uSize) - 1;

  vec4 m1 = vec4(0.0), m2 = vec4(0.0), mn = vec4(1e9), mx = vec4(-1e9), acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 9; i++) {
    ivec2 o = ivec2(i % 3 - 1, i / 3 - 1);
    vec4 t = toSpace(sanitize(texelFetch(tColor, clamp(p + o, ivec2(0), hi), 0)));
    vec2 d = vec2(o) - uJitter;
    float w = exp(-BLACKMAN_HARRIS_K * dot(d, d));
    acc += t * w; wsum += w;
    m1 += t; m2 += t * t;
    mn = min(mn, t); mx = max(mx, t);
  }
  // nothing but background around: stay exactly transparent, never ghost
  if (mx.w <= 0.0) { oColor = vec4(0.0); return; }
  vec4 cur = acc / wsum;

  // reproject using the nearest depth of the cross (keeps foreground edges crisp)
  float z = texelFetch(tDepth, p, 0).r;
  ivec2 zo = ivec2(0);
  for (int i = 0; i < 4; i++) {
    ivec2 o = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
    float zz = texelFetch(tDepth, clamp(p + o, ivec2(0), hi), 0).r;
    if (zz < z) { z = zz; zo = o; }
  }
  vec2 uvq = (vec2(p + zo) + 0.5) / uSize;
  vec4 pc = uReproj * vec4(uvq * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec2 prevUV = pc.xy / pc.w * 0.5 + 0.5 - vec2(zo) / uSize;

  vec4 res = cur;
  if (uHistoryValid && pc.w > 0.0 && all(greaterThanEqual(prevUV, vec2(0.0))) && all(lessThanEqual(prevUV, vec2(1.0)))) {
    vec4 h = toSpace(sanitize(historyCR(prevUV)));
    vec4 mean = m1 / 9.0;
    vec4 sd = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
    vec4 bmin = max(mn, mean - sd), bmax = min(mx, mean + sd);
    h = clipBox(bmin, bmax, clamp(cur, bmin, bmax), h);
    // anti-flicker: lean on history while it agrees with the present
    float diff = abs(cur.x - h.x) / max(max(cur.x, h.x), FLICKER_LUMA_FLOOR);
    float k = 1.0 - diff;
    res = mix(h, cur, mix(uWeight.y, uWeight.x, k * k));
  }
  oColor = sanitize(fromSpace(res));
}
`;

// TAAU: tColor/tDepth are uInSize, the output (and history) uSize.
const TAAU_FRAG = /* glsl */ `
${TAA_LIB}
uniform vec2 uInSize;
uniform float uMeanConf;   // mean over the jitter cycle of conf (below)
void main() {
  vec2 scale = uInSize / uSize;            // input pixels per output pixel
  vec2 pIn = gl_FragCoord.xy * scale;      // this pixel's centre, in input pixels
  ivec2 hi = ivec2(uInSize) - 1;
  // input texel m sampled the scene at m + 0.5 - uJitter: the nearest one is
  ivec2 c = ivec2(floor(pIn + uJitter));

  vec4 m1 = vec4(0.0), m2 = vec4(0.0), mn = vec4(1e9), mx = vec4(-1e9);
  vec4 accIn = vec4(0.0), accOut = vec4(0.0);
  float wIn = 0.0, wOut = 0.0, conf = 0.0;
  for (int i = 0; i < 9; i++) {
    ivec2 o = ivec2(i % 3 - 1, i / 3 - 1);
    vec4 t = toSpace(sanitize(texelFetch(tColor, clamp(c + o, ivec2(0), hi), 0)));
    vec2 dIn = vec2(c + o) + 0.5 - uJitter - pIn;   // sample → pixel centre, input pixels
    vec2 dOut = dIn / scale;                         // …in output pixels
    float wi = exp(-BLACKMAN_HARRIS_K * dot(dIn, dIn));
    float wo = exp(-BLACKMAN_HARRIS_K * dot(dOut, dOut));
    accIn += t * wi; wIn += wi;
    accOut += t * wo; wOut += wo;
    conf = max(conf, wo);
    m1 += t; m2 += t * t;
    mn = min(mn, t); mx = max(mx, t);
  }
  if (mx.w <= 0.0) { oColor = vec4(0.0); return; }
  vec4 curSoft = accIn / wIn;
  vec4 cur = mix(curSoft, accOut / max(wOut, 1e-6), conf);

  float z = texelFetch(tDepth, clamp(c, ivec2(0), hi), 0).r;
  ivec2 zo = ivec2(0);
  for (int i = 0; i < 4; i++) {
    ivec2 o = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
    float zz = texelFetch(tDepth, clamp(c + o, ivec2(0), hi), 0).r;
    if (zz < z) { z = zz; zo = o; }
  }
  vec2 uvq = (pIn + vec2(zo)) / uInSize;
  vec4 pc = uReproj * vec4(uvq * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec2 prevUV = pc.xy / pc.w * 0.5 + 0.5 - vec2(zo) / uInSize;

  vec4 res = curSoft;
  if (uHistoryValid && pc.w > 0.0 && all(greaterThanEqual(prevUV, vec2(0.0))) && all(lessThanEqual(prevUV, vec2(1.0)))) {
    vec4 h = toSpace(sanitize(historyCR(prevUV)));
    vec4 mean = m1 / 9.0;
    vec4 sd = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
    vec4 bmin = max(mn, mean - sd), bmax = min(mx, mean + sd);
    h = clipBox(bmin, bmax, clamp(cur, bmin, bmax), h);
    float diff = abs(cur.x - h.x) / max(max(cur.x, h.x), FLICKER_LUMA_FLOOR);
    float k = 1.0 - diff;
    res = mix(h, cur, mix(uWeight.y, min(uWeight.x * conf / uMeanConf, 1.0), k * k));
  }
  oColor = sanitize(fromSpace(res));
}
`;

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

const PREFILTER_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec2 hi = textureSize(tSrc, 0) - 1;
  vec3 s = bright(sanitize(texelFetch(tSrc, min(p, hi), 0)).rgb)
         + bright(sanitize(texelFetch(tSrc, min(p + ivec2(1, 0), hi), 0)).rgb)
         + bright(sanitize(texelFetch(tSrc, min(p + ivec2(0, 1), hi), 0)).rgb)
         + bright(sanitize(texelFetch(tSrc, min(p + ivec2(1, 1), hi), 0)).rgb);
  oColor = vec4(s * 0.25, 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel; // source texel
uniform vec2 uDst;
// Jimenez 2014 13-tap downsample: five overlapping 2×2-texel boxes (the inner one
// weighted 1/2, the four corner ones 1/8 each), as per-tap weights.
const float DOWN_W_CENTRE = 0.125;   // centre tap (shared by the four corner boxes)
const float DOWN_W_CORNER = 0.03125; // outer corners (one corner box each)
const float DOWN_W_EDGE = 0.0625;    // outer edge midpoints (two corner boxes each)
const float DOWN_W_INNER = 0.125;    // inner box taps (all bilinear, ±1 texel)
vec3 tap(vec2 uv, vec2 o) { return texture(tSrc, uv + uTexel * o).rgb; }
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec3 c = tap(uv, vec2(0.0)) * DOWN_W_CENTRE;
  c += (tap(uv, vec2(-2.0, 2.0)) + tap(uv, vec2(2.0, 2.0)) + tap(uv, vec2(-2.0, -2.0)) + tap(uv, vec2(2.0, -2.0))) * DOWN_W_CORNER;
  c += (tap(uv, vec2(0.0, 2.0)) + tap(uv, vec2(-2.0, 0.0)) + tap(uv, vec2(2.0, 0.0)) + tap(uv, vec2(0.0, -2.0))) * DOWN_W_EDGE;
  c += (tap(uv, vec2(-1.0, 1.0)) + tap(uv, vec2(1.0, 1.0)) + tap(uv, vec2(-1.0, -1.0)) + tap(uv, vec2(1.0, -1.0))) * DOWN_W_INNER;
  oColor = vec4(c, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uLowTexel;
uniform vec2 uDst;
uniform float uScatter;
void main() {
  vec3 hiC = texelFetch(tHigh, ivec2(gl_FragCoord.xy), 0).rgb;
  vec3 loC = tent9(tLow, gl_FragCoord.xy / uDst, uLowTexel);
  oColor = vec4(mix(hiC, loC, uScatter), 1.0);
}
`;

// Eye adaptation, 1: the frame's luminance on the ADAPT.GRID, a patch mean per
// sample (r: log2 luminance, g: coverage; the page shows through where it's 0).
const ADAPT_LUM_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
#define TAPS ${ADAPT.TAPS}
const vec2 GRID = vec2(${ADAPT.GRID[0]}.0, ${ADAPT.GRID[1]}.0);
const float LOG_FLOOR = ${ADAPT.LOG_MIN - 1}.0;   // log2 luminance of black (below the histogram)
void main() {
  vec4 sum = vec4(0.0);
  for (int y = 0; y < TAPS; y++)
  for (int x = 0; x < TAPS; x++) {
    vec2 uv = (gl_FragCoord.xy - 0.5 + (vec2(x, y) + 0.5) / float(TAPS)) / GRID;
    sum += sanitize(texture(tSrc, uv));
  }
  sum /= float(TAPS * TAPS);
  float L = luma(sum.rgb) / max(sum.a, 1e-4);   // premultiplied: the covered part's own luminance
  oColor = vec4(L > 0.0 ? max(log2(L), LOG_FLOOR) : LOG_FLOOR, sum.a, 0.0, 1.0);
}
`;
// 2: each sample is a point dropped into its bin, weighted by its coverage
// (additive blending sums them).
const ADAPT_HIST_VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tLum;
out float vW;
const int GRID_W = ${ADAPT.GRID[0]};
const float BINS = ${ADAPT.BINS}.0;
const float LOG_MIN = ${ADAPT.LOG_MIN}.0, LOG_MAX = ${ADAPT.LOG_MAX}.0;
const float SAMPLES = ${ADAPT.GRID[0] * ADAPT.GRID[1]}.0;
void main() {
  vec2 s = texelFetch(tLum, ivec2(gl_VertexID % GRID_W, gl_VertexID / GRID_W), 0).rg;
  float bin = clamp(floor((s.r - LOG_MIN) / (LOG_MAX - LOG_MIN) * BINS), 0.0, BINS - 1.0);
  vW = s.g / SAMPLES;
  gl_Position = vec4((bin + 0.5) / BINS * 2.0 - 1.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;
const ADAPT_HIST_FRAG = /* glsl */ `
precision highp float;
in float vW;
out vec4 oColor;
void main() { oColor = vec4(vW, 0.0, 0.0, 0.0); }
`;
// 3: the histogram's mean between the percentiles, the gain that brings it up to
// LOG_DARK, and last frame's gain moved toward it. r = gain, g = its target,
// b = the view's log2 luminance (for tools).
const ADAPT_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tHist;
uniform sampler2D tPrev;
uniform float uDt;
#define BINS ${ADAPT.BINS}
const float LOG_MIN = ${ADAPT.LOG_MIN}.0, LOG_MAX = ${ADAPT.LOG_MAX}.0;
const float LOW_PCT = ${ADAPT.LOW_PCT}, HIGH_PCT = ${ADAPT.HIGH_PCT};
const float LOG_DARK = ${ADAPT.LOG_DARK}.0, MAX_EV = ${ADAPT.MAX_EV}.0;
const float TAU_DARK = ${ADAPT.TAU_DARK}, TAU_LIGHT = ${ADAPT.TAU_LIGHT}, SETTLED = ${ADAPT.SETTLED};
const float EMPTY = 1e-6;   // total weight under which nothing covers the frame
void main() {
  float total = 0.0;
  for (int i = 0; i < BINS; i++) total += texelFetch(tHist, ivec2(i, 0), 0).r;
  float lo = LOW_PCT * total, hi = HIGH_PCT * total, cum = 0.0, wSum = 0.0, lSum = 0.0;
  for (int i = 0; i < BINS; i++) {
    float w = texelFetch(tHist, ivec2(i, 0), 0).r;
    float part = max(min(cum + w, hi) - max(cum, lo), 0.0);   // this bin's share inside the band
    lSum += part * (LOG_MIN + (float(i) + 0.5) / float(BINS) * (LOG_MAX - LOG_MIN));
    wSum += part;
    cum += w;
  }
  float view = wSum > 0.0 ? lSum / wSum : LOG_DARK;
  float target = total > EMPTY ? exp2(clamp(LOG_DARK - view, 0.0, MAX_EV)) : 1.0;
  float g = texelFetch(tPrev, ivec2(0), 0).r;
  g = g > 0.0 ? g : 1.0;   // the first frame starts adapted to daylight
  g += (target - g) * (1.0 - exp(-uDt / (target > g ? TAU_DARK : TAU_LIGHT)));
  if (abs(g - target) <= SETTLED * target) g = target;
  oColor = vec4(g, target, view, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform vec2 uBloomTexel;
uniform vec2 uSize;
uniform float uBloom;
uniform float uExposure; // linear multiplier
uniform float uSharpen;
uniform float uLook;
uniform float uRaw;      // 1 = no tone curve/exposure (false-colour data views)
uniform sampler2D tAdapt; // eye adaptation: r = exposure gain (1 in daylight)

const mat3 SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUTSET = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const float AGX_MIN_EV = -12.47393; // log2(2^-10 · 0.18)
const float AGX_MAX_EV = 4.026069;  // log2(2^6.5 · 0.18)
const float AGX_GAMMA = 2.2;        // display gamma AgX's curve encodes for (decoded after the outset)
const float PUNCHY_POWER = 1.35;    // Blender's AgX "Punchy" look: power on the encoded values…
const float PUNCHY_SAT = 1.4;       // …and saturation around their luma

// AgX base contrast sigmoid: 6th-order polynomial fit (Wrensch 2023, as in three.js).
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// AgX log encoding, sigmoid and look, per channel (encoded display values out).
vec3 agxCurve(vec3 c) {
  c = clamp((log2(max(c, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
  c = agxContrast(c);
  c = pow(max(c, 0.0), vec3(mix(1.0, PUNCHY_POWER, uLook)));
  float l = dot(c, LUMA_709);
  return l + mix(1.0, PUNCHY_SAT, uLook) * (c - l);
}

// AgX (Blender / Filament / three.js) with an optional blend toward the "Punchy" look.
vec3 agx(vec3 c) {
  c = agxCurve(AGX_INSET * (SRGB_TO_REC2020 * c));
  c = pow(max(AGX_OUTSET * c, 0.0), vec3(AGX_GAMMA));
  return clamp(REC2020_TO_SRGB * c, 0.0, 1.0);
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
// AgX, whose path to white keeps violet violet.
uniform vec2 uHot;               // blend start, full (exposed max-channel radiance)
const float HOT_SAT_POW = 2.0;   // weight ∝ saturation^this: only clearly coloured light
const float HOT_WARM_EDGE = 0.2; // (red - blue) / max channel over which the weight fades in
vec3 tonemap(vec3 c) {
  vec3 a = agx(c);
  float mx = max(c.r, max(c.g, c.b));
  float sat = 1.0 - min(c.r, min(c.g, c.b)) / max(mx, 1e-6);
  float warm = smoothstep(-HOT_WARM_EDGE, HOT_WARM_EDGE, (c.r - c.b) / max(mx, 1e-6));
  float w = smoothstep(uHot.x, uHot.y, mx) * pow(sat, HOT_SAT_POW) * warm;
  if (w <= 0.0) return a;
  vec3 pc = pow(max(agxCurve(SRGB_TO_REC2020 * c), 0.0), vec3(AGX_GAMMA));
  return mix(a, clamp(REC2020_TO_SRGB * pc, 0.0, 1.0), w);
}

// sRGB transfer function (IEC 61966-2-1).
vec3 srgbEncode(vec3 c) {
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, lessThanEqual(c, vec3(0.0031308)));
}

vec3 tm(vec3 c) { return c / (1.0 + luma(c)); }
vec3 itm(vec3 c) { return c / max(1.0 - luma(c), 1e-3); }

// AMD CAS: the cross taps get the negative lobe -amp / mix(SOFT, HARD, sharpen).
const float CAS_LOBE_SOFT = 8.0;
const float CAS_LOBE_HARD = 5.0;
// Output dither: interleaved gradient noise (Jimenez 2014), ±½ of one 8-bit step.
const vec3 IGN = vec3(0.06711056, 0.00583715, 52.9829189);
const float DITHER_LEVELS = 255.0;  // output code values above 0
const float DITHER_BLACK = 1e-5;    // max channel at or below which a pixel counts as exact black (no dither)

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = ivec2(uSize) - 1;
  vec4 c = sanitize(texelFetch(tColor, p, 0));
  vec3 rad = c.rgb;

  if (uSharpen > 0.0) {
    // contrast-adaptive sharpening (AMD CAS, cross taps, luma-driven) in tone-mapped space
    vec3 e = tm(c.rgb);
    vec3 n = tm(sanitize(texelFetch(tColor, clamp(p + ivec2(0, 1), ivec2(0), hi), 0)).rgb);
    vec3 s = tm(sanitize(texelFetch(tColor, clamp(p - ivec2(0, 1), ivec2(0), hi), 0)).rgb);
    vec3 w = tm(sanitize(texelFetch(tColor, clamp(p - ivec2(1, 0), ivec2(0), hi), 0)).rgb);
    vec3 r = tm(sanitize(texelFetch(tColor, clamp(p + ivec2(1, 0), ivec2(0), hi), 0)).rgb);
    float le = luma(e), ln = luma(n), ls = luma(s), lw = luma(w), lr = luma(r);
    float mnL = min(le, min(min(ln, ls), min(lw, lr)));
    float mxL = max(le, max(max(ln, ls), max(lw, lr)));
    float amp = sqrt(clamp(min(mnL, 1.0 - mxL) / max(mxL, 1e-4), 0.0, 1.0));
    float k = -amp / mix(CAS_LOBE_SOFT, CAS_LOBE_HARD, uSharpen);
    rad = itm(max((e + k * (n + s + w + r)) / (1.0 + 4.0 * k), 0.0));
  }

  if (uBloom > 0.0) {
    vec3 b = tent9(tBloom, (vec2(p) + 0.5) / uSize, uBloomTexel);
    rad += uBloom * (b - bright(c.rgb));
  }

  float gain = texelFetch(tAdapt, ivec2(0), 0).r;
  vec3 o = uRaw > 0.5 ? srgbEncode(clamp(rad, 0.0, 1.0)) : srgbEncode(tonemap(max(rad, 0.0) * (uExposure * gain)));
  // ±½ LSB dither against 8-bit banding; keep exact zeros exact
  float ign = fract(IGN.z * fract(dot(vec2(p), IGN.xy)));
  o += (ign - 0.5) / DITHER_LEVELS * step(DITHER_BLACK, max(o.r, max(o.g, o.b)));
  oColor = vec4(clamp(o, 0.0, 1.0), c.a);
}
`;

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ pixScale?: { value: number } }} [opts] pixScale: uniform set to an output
 *   pixel's size in rendered pixels before each scene render (the shaders' LOD bias)
 * @returns post-processing pipeline; see the file header.
 */
export function createPost(renderer, { pixScale } = {}) {
  const hdr = (w, h, filter, extra = {}) => new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...extra,
  });
  const mat = (frag, uniforms) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const thresh = { value: new THREE.Vector2() };

  const taaMat = mat(TAA_FRAG, {
    tColor: { value: null }, tDepth: { value: null }, tHistory: { value: null },
    uReproj: { value: new THREE.Matrix4() }, uJitter: { value: new THREE.Vector2() },
    uSize: { value: new THREE.Vector2() }, uHistoryValid: { value: false },
    uWeight: { value: new THREE.Vector2(TAA_WEIGHT_STABLE, TAA_WEIGHT_CHANGING) }, uThresh: thresh,
  });
  const taauMat = mat(TAAU_FRAG, {
    ...taaMat.uniforms,
    uWeight: { value: new THREE.Vector2(TAAU_WEIGHT_STABLE, TAA_WEIGHT_CHANGING) },
    uInSize: { value: new THREE.Vector2() }, uMeanConf: { value: 1 },
  });
  const prefilterMat = mat(PREFILTER_FRAG, { tSrc: { value: null }, uThresh: thresh });
  const downMat = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uDst: { value: new THREE.Vector2() }, uThresh: thresh });
  const upMat = mat(UP_FRAG, {
    tLow: { value: null }, tHigh: { value: null }, uLowTexel: { value: new THREE.Vector2() },
    uDst: { value: new THREE.Vector2() }, uScatter: { value: POST_DEFAULTS.bloomScatter }, uThresh: thresh,
  });
  // eye adaptation (ADAPT): luminance grid, histogram, gain (ping-pong)
  const lumRT = hdr(ADAPT.GRID[0], ADAPT.GRID[1], THREE.LinearFilter);
  const histRT = hdr(ADAPT.BINS, 1, THREE.NearestFilter);
  const adaptRT = [0, 1].map(() => hdr(1, 1, THREE.NearestFilter, { type: THREE.FloatType }));
  let adaptCur = 0;
  const unitGain = new THREE.DataTexture(new Float32Array([1, 1, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  unitGain.needsUpdate = true;
  const lumMat = mat(ADAPT_LUM_FRAG, { tSrc: { value: null } });
  const adaptMat = mat(ADAPT_FRAG, { tHist: { value: null }, tPrev: { value: null }, uDt: { value: ADAPT.DT } });
  const histMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: ADAPT_HIST_VERT, fragmentShader: ADAPT_HIST_FRAG,
    uniforms: { tLum: { value: lumRT.texture } }, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const histGeo = new THREE.BufferGeometry();
  histGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(ADAPT.GRID[0] * ADAPT.GRID[1] * 3), 3));
  const histPoints = new THREE.Points(histGeo, histMat);
  histPoints.frustumCulled = false;
  const histScene = new THREE.Scene();
  histScene.add(histPoints);
  // the gain read back (a frame or so late) for the frame pacing: [gain, target, view log2 luminance]
  const adaptRead = new Float32Array(4);
  let adaptReading = false, adaptSeen = null, adaptOn = false;

  const compMat = mat(COMPOSITE_FRAG, {
    tColor: { value: null }, tBloom: { value: null }, uBloomTexel: { value: new THREE.Vector2() },
    uSize: { value: new THREE.Vector2() }, uBloom: { value: 0 }, uExposure: { value: 1 },
    uSharpen: { value: 0 }, uLook: { value: 0 }, uRaw: { value: 0 }, uThresh: thresh,
    uHot: { value: new THREE.Vector2() }, tAdapt: { value: unitGain },
  });

  // full-screen triangle
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, compMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const size = new THREE.Vector2(0, 0);     // output (canvas or target)
  const inSize = new THREE.Vector2(0, 0);   // the scene's render size: size × render scale
  let confScale = 0;                        // render scale uMeanConf was computed for
  let sceneRT = null, history = [], down = [], up = [], cur = 0;
  let still = null;
  let historyValid = false, frame = 0, lastTaa = null;
  const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4(), invVP = new THREE.Matrix4();
  const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
  const savedProj = new THREE.Matrix4(), savedProjInv = new THREE.Matrix4();
  const savedClear = new THREE.Color();
  const tmpSize = new THREE.Vector2();
  let prevCamera = null;

  const post = {
    settings: { ...POST_DEFAULTS },
    /** Optional profiling hook: called as onPass(name, renderTarget) after each pass (null: the canvas). */
    onPass: null,
    get size() { return size.clone(); },
    /** Every render target the pipeline holds (for memory estimates). */
    get allTargets() { return [sceneRT, still, ...history, ...down, ...up, lumRT, histRT, ...adaptRT].filter(Boolean); },
    /** Eyes still adjusting (the view should keep rendering until they settle). */
    get adapting() { return adaptOn && !!adaptSeen && adaptSeen.gain !== adaptSeen.target; },
    /** Last gain read back: { gain, target, view (log2 luminance) }, or null. */
    get adaptation() { return adaptSeen; },
    /** Current-frame weight TAA settles with (for how long the view needs to converge). */
    get settleWeight() { return upscaling() ? TAAU_WEIGHT_STABLE : TAA_WEIGHT_STABLE; },
    /** Render scale per axis the next render uses (upscaling is TAA's job). */
    get renderScale() {
      const s = { ...POST_DEFAULTS, ...post.settings };
      return s.taa ? s.upscale * Math.min(1, Math.max(0.6, s.resolutionScale)) : 1;
    },
    get targets() { return { scene: sceneRT, history: history[cur], bloom: up[0] ?? down[0], down, up }; },

    /**
     * Output size in drawing-buffer pixels (defaults to the renderer's current drawing
     * buffer); the scene renders at `scale` of it per axis.
     */
    setSize(w, h, scale = 1) {
      if (w === undefined) ({ x: w, y: h } = renderer.getDrawingBufferSize(tmpSize));
      w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
      const iw = Math.max(1, Math.round(w * scale)), ih = Math.max(1, Math.round(h * scale));
      if (w === size.x && h === size.y && iw === inSize.x && ih === inSize.y && sceneRT) return;
      size.set(w, h);
      inSize.set(iw, ih);
      if (!sceneRT) {
        sceneRT = hdr(iw, ih, THREE.NearestFilter, {
          depthBuffer: true, depthTexture: new THREE.DepthTexture(iw, ih, THREE.FloatType),
        });
        history = [hdr(w, h, THREE.LinearFilter), hdr(w, h, THREE.LinearFilter)];
      } else {
        sceneRT.setSize(iw, ih);
        history.forEach((t) => t.setSize(w, h));
      }
      for (let i = 0; i < MIPS; i++) {
        const mw = Math.max(1, w >> (i + 1)), mh = Math.max(1, h >> (i + 1));
        if (down[i]) down[i].setSize(mw, mh); else down[i] = hdr(mw, mh, THREE.LinearFilter);
        if (i < MIPS - 1) { if (up[i]) up[i].setSize(mw, mh); else up[i] = hdr(mw, mh, THREE.LinearFilter); }
      }
      post.reset();
    },

    /** Drop the TAA history (call after scene swaps, teleports, etc.). */
    reset() { historyValid = false; },

    /**
     * Render `scene` through the pipeline into `target` (null = canvas).
     * A non-null target must match the drawing-buffer size.
     */
    render(scene, camera, target = null, dt = ADAPT.DT) {
      const s = { ...POST_DEFAULTS, ...post.settings };
      const scale = post.renderScale;
      if (target) post.setSize(target.width, target.height, scale); else post.setSize(undefined, undefined, scale);
      const prevTarget = renderer.getRenderTarget();
      renderer.getClearColor(savedClear);
      const savedAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);

      camera.updateMatrixWorld();
      curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (s.taa !== lastTaa || camera !== prevCamera || cameraJumped(camera)) post.reset();
      lastTaa = s.taa;
      prevCamera = camera;
      prevPos.setFromMatrixPosition(camera.matrixWorld);
      prevQuat.setFromRotationMatrix(camera.matrixWorld);

      // 1. scene → HDR target, with sub-pixel jitter when TAA is on. Upscaled, one
      // input pixel spans 1/scale² output pixels: the cycle is that much longer.
      const period = upscaling() ? JITTER_PERIOD * Math.ceil(1 / (scale * scale)) : JITTER_PERIOD;
      const jx = s.taa ? halton((frame % period) + 1, 2) - 0.5 : 0;
      const jy = s.taa ? halton((frame % period) + 1, 3) - 0.5 : 0;
      savedProj.copy(camera.projectionMatrix);
      savedProjInv.copy(camera.projectionMatrixInverse);
      if (s.taa) {
        const e = camera.projectionMatrix.elements;
        const ox = (2 * jx) / inSize.x, oy = (2 * jy) / inSize.y;
        for (let c = 0; c < 4; c++) { e[c * 4] += ox * e[c * 4 + 3]; e[c * 4 + 1] += oy * e[c * 4 + 3]; }
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      if (pixScale) pixScale.value = inSize.x / size.x;
      try {
        renderer.setRenderTarget(sceneRT);
        renderer.clear();
        renderer.render(scene, camera);
      } finally {
        camera.projectionMatrix.copy(savedProj);
        camera.projectionMatrixInverse.copy(savedProjInv);
      }
      post.onPass?.('scene', sceneRT);

      // 2. TAA resolve
      let color = sceneRT.texture;
      if (s.taa) {
        const up = upscaling();
        const m = up ? taauMat : taaMat;
        const u = m.uniforms;
        if (up) {
          if (confScale !== scale) { u.uMeanConf.value = meanConfidence(scale); confScale = scale; }
          u.uInSize.value.copy(inSize);
        }
        u.tColor.value = sceneRT.texture;
        u.tDepth.value = sceneRT.depthTexture;
        u.tHistory.value = history[cur].texture;
        u.uReproj.value.multiplyMatrices(prevVP, invVP.copy(curVP).invert());
        u.uJitter.value.set(jx, jy);
        u.uSize.value.copy(size);
        u.uHistoryValid.value = historyValid;
        cur = 1 - cur;
        pass(m, history[cur]);
        post.onPass?.('taa', history[cur]);
        color = history[cur].texture;
        historyValid = true;
      }
      prevVP.copy(curVP);
      frame++;

      // 2b. eye adaptation
      adaptOn = s.adapt && !s.raw;   // (the data views and the plain view keep their exact colours)
      const adaptTex = adaptOn ? adapt(color, dt) : unitGain;

      // 3. bloom chain
      thresh.value.set(s.bloomThreshold, Math.max(s.bloomKnee, 1e-3));
      const bloomOn = s.bloom > 0 && !s.raw;
      if (bloomOn) {
        prefilterMat.uniforms.tSrc.value = color;
        pass(prefilterMat, down[0]);
        for (let i = 1; i < MIPS; i++) {
          const u = downMat.uniforms;
          u.tSrc.value = down[i - 1].texture;
          u.uTexel.value.set(1 / down[i - 1].width, 1 / down[i - 1].height);
          u.uDst.value.set(down[i].width, down[i].height);
          pass(downMat, down[i]);
        }
        for (let i = MIPS - 2; i >= 0; i--) {
          const low = i === MIPS - 2 ? down[MIPS - 1] : up[i + 1];
          const u = upMat.uniforms;
          u.tLow.value = low.texture;
          u.tHigh.value = down[i].texture;
          u.uLowTexel.value.set(1 / low.width, 1 / low.height);
          u.uDst.value.set(up[i].width, up[i].height);
          u.uScatter.value = s.bloomScatter;
          pass(upMat, up[i]);
        }
        post.onPass?.('bloom', up[0]);
      }

      // 4. sharpen + bloom composite + AgX + sRGB
      const u = compMat.uniforms;
      u.tColor.value = color;
      u.tBloom.value = up[0].texture;
      u.uBloomTexel.value.set(1 / up[0].width, 1 / up[0].height);
      u.uSize.value.copy(size);
      u.uBloom.value = bloomOn ? s.bloom : 0;
      u.uExposure.value = 2 ** s.exposure;
      u.uSharpen.value = s.taa && !s.raw ? s.sharpen : 0;
      u.uLook.value = s.look;
      u.uRaw.value = s.raw ? 1 : 0;
      u.uHot.value.set(s.hotStart, s.hotFull);
      u.tAdapt.value = adaptTex;
      pass(compMat, target);
      post.onPass?.('composite', target);

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(savedClear, savedAlpha);
    },

    /**
     * One-off render (thumbnails, captures) into `target` at its own size: HDR scene
     * + tone mapping, no TAA, no bloom, history untouched.
     */
    renderStill(scene, camera, target) {
      const w = target.width, h = target.height;
      if (!still) still = hdr(w, h, THREE.NearestFilter, { depthBuffer: true });
      else if (still.width !== w || still.height !== h) still.setSize(w, h);
      const prevTarget = renderer.getRenderTarget();
      renderer.getClearColor(savedClear);
      const savedAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(still);
      renderer.clear();
      if (pixScale) pixScale.value = 1;
      renderer.render(scene, camera);
      const s = { ...POST_DEFAULTS, ...post.settings };
      const u = compMat.uniforms;
      u.tColor.value = still.texture;
      u.uSize.value.set(w, h);
      u.uBloom.value = 0;
      u.uSharpen.value = 0;
      u.uExposure.value = 2 ** s.exposure;
      u.uLook.value = s.look;
      u.uRaw.value = s.raw ? 1 : 0;
      u.uHot.value.set(s.hotStart, s.hotFull);
      u.tAdapt.value = s.adapt && !s.raw ? adaptRT[adaptCur].texture : unitGain;
      pass(compMat, target);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(savedClear, savedAlpha);
    },

    dispose() {
      [sceneRT, still, ...history, ...down, ...up].forEach((t) => t?.dispose());
      sceneRT?.depthTexture?.dispose();
      [taaMat, taauMat, prefilterMat, downMat, upMat, compMat, lumMat, adaptMat, histMat].forEach((m) => m.dispose());
      [lumRT, histRT, ...adaptRT].forEach((t) => t.dispose());
      unitGain.dispose();
      histGeo.dispose();
      tri.dispose();
    },
  };

  // Eye adaptation for the resolved frame `color`, dt s after the last: returns the gain texture.
  function adapt(color, dt) {
    lumMat.uniforms.tSrc.value = color;
    pass(lumMat, lumRT);
    renderer.setRenderTarget(histRT);
    renderer.clear();
    renderer.render(histScene, quadCam);
    const u = adaptMat.uniforms;
    u.tHist.value = histRT.texture;
    u.tPrev.value = adaptRT[adaptCur].texture;
    u.uDt.value = dt;
    adaptCur = 1 - adaptCur;
    pass(adaptMat, adaptRT[adaptCur]);
    post.onPass?.('adapt', adaptRT[adaptCur]);
    if (!adaptReading) {
      adaptReading = true;
      renderer.readRenderTargetPixelsAsync(adaptRT[adaptCur], 0, 0, 1, 1, adaptRead)
        .then(() => { adaptSeen = { gain: adaptRead[0], target: adaptRead[1], view: adaptRead[2] }; })
        .catch(() => {})
        .finally(() => { adaptReading = false; });
    }
    return adaptRT[adaptCur].texture;
  }

  // Is the scene rendering below output size (TAAU)?
  function upscaling() { return inSize.x !== size.x || inSize.y !== size.y; }

  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  // Teleports and very fast moves: history would be mostly disoccluded anyway.
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion();
  function cameraJumped(camera) {
    if (!historyValid) return false;
    _p.setFromMatrixPosition(camera.matrixWorld);
    _q.setFromRotationMatrix(camera.matrixWorld);
    const move = _p.distanceTo(prevPos);
    return move > JUMP_MOVE_FRAC * Math.max(prevPos.length(), 1) || _q.angleTo(prevQuat) > JUMP_TURN;
  }

  return post;
}
