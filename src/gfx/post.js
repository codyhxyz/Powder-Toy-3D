import * as THREE from 'three';

// HDR post-processing: scene → RGBA16F (+ depth) → TAA → bloom → AgX → sRGB canvas.
//
//   const post = createPost(renderer);
//   post.render(scene, camera);          // instead of renderer.render(scene, camera)
//   post.reset();                        // after anything that invalidates history
//   post.settings.taa / .bloom / .exposure (EV) / .sharpen / .look / .raw / .hotStart / .hotFull
//
// The scene is rendered as linear, premultiplied HDR radiance. The canvas stays
// transparent: tone mapping is applied to the premultiplied colour ("over black"),
// so opaque pixels are exact, coverage at silhouettes is resolved in linear light,
// and emissive media / bloom add light over the page background.
//
// TAA (Karis 2014): Halton(2,3) projection jitter, reprojection from depth with the
// previous unjittered view-projection, Blackman-Harris reconstruction of the current
// frame, Catmull-Rom history, YCoCg variance clipping, luminance-weighted blend.
// Bloom (Jimenez 2014): per-pixel soft-knee bright pass at half resolution, 13-tap
// downsample to 1/64, 9-tap tent upsample. It is energy-conserving: the halo only
// redistributes the above-threshold light (out = c + k·(blur(bright) − bright(c))).

export const POST_DEFAULTS = {
  taa: true,
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
};

const MIPS = 6;
const JITTER_PERIOD = 16;
// TAA current-frame blend weight where history agrees with the present (stable)
// and where it doesn't (changing); the shader blends between them per pixel.
export const TAA_WEIGHT_STABLE = 0.07;
const TAA_WEIGHT_CHANGING = 0.16;
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

const TAA_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tHistory;
uniform mat4 uReproj;      // prevViewProj · inverse(curViewProj), both unjittered
uniform vec2 uJitter;      // where this frame sampled, in pixels from the pixel centre
uniform vec2 uSize;
uniform bool uHistoryValid;
uniform vec2 uWeight;      // current-frame weight (stable, changing)
const float BLACKMAN_HARRIS_K = 2.29;  // Gaussian fit of the Blackman-Harris reconstruction filter: w = exp(-k d²), d in pixels
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
// for a grey both curves agree exactly.
uniform vec2 uHot;               // blend start, full (exposed max-channel radiance)
const float HOT_SAT_POW = 2.0;   // weight ∝ saturation^this: only clearly coloured light
vec3 tonemap(vec3 c) {
  vec3 a = agx(c);
  float mx = max(c.r, max(c.g, c.b));
  float sat = 1.0 - min(c.r, min(c.g, c.b)) / max(mx, 1e-6);
  float w = smoothstep(uHot.x, uHot.y, mx) * pow(sat, HOT_SAT_POW);
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

  vec3 o = uRaw > 0.5 ? srgbEncode(clamp(rad, 0.0, 1.0)) : srgbEncode(tonemap(max(rad, 0.0) * uExposure));
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
 * @returns post-processing pipeline; see the file header.
 */
export function createPost(renderer) {
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
  const prefilterMat = mat(PREFILTER_FRAG, { tSrc: { value: null }, uThresh: thresh });
  const downMat = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uDst: { value: new THREE.Vector2() }, uThresh: thresh });
  const upMat = mat(UP_FRAG, {
    tLow: { value: null }, tHigh: { value: null }, uLowTexel: { value: new THREE.Vector2() },
    uDst: { value: new THREE.Vector2() }, uScatter: { value: POST_DEFAULTS.bloomScatter }, uThresh: thresh,
  });
  const compMat = mat(COMPOSITE_FRAG, {
    tColor: { value: null }, tBloom: { value: null }, uBloomTexel: { value: new THREE.Vector2() },
    uSize: { value: new THREE.Vector2() }, uBloom: { value: 0 }, uExposure: { value: 1 },
    uSharpen: { value: 0 }, uLook: { value: 0 }, uRaw: { value: 0 }, uThresh: thresh,
    uHot: { value: new THREE.Vector2() },
  });

  // full-screen triangle
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, compMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const size = new THREE.Vector2(0, 0);
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
    /** Optional profiling hook: called as onPass(name, renderTarget) after each pass. */
    onPass: null,
    get size() { return size.clone(); },
    get targets() { return { scene: sceneRT, history: history[cur], bloom: up[0] ?? down[0], down, up }; },

    /** Size in drawing-buffer pixels; defaults to the renderer's current drawing buffer. */
    setSize(w, h) {
      if (w === undefined) ({ x: w, y: h } = renderer.getDrawingBufferSize(tmpSize));
      w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
      if (w === size.x && h === size.y && sceneRT) return;
      size.set(w, h);
      if (!sceneRT) {
        sceneRT = hdr(w, h, THREE.NearestFilter, {
          depthBuffer: true, depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
        });
        history = [hdr(w, h, THREE.LinearFilter), hdr(w, h, THREE.LinearFilter)];
      } else {
        sceneRT.setSize(w, h);
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
    render(scene, camera, target = null) {
      const s = { ...POST_DEFAULTS, ...post.settings };
      if (target) post.setSize(target.width, target.height); else post.setSize();
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

      // 1. scene → HDR target, with sub-pixel jitter when TAA is on
      const jx = s.taa ? halton((frame % JITTER_PERIOD) + 1, 2) - 0.5 : 0;
      const jy = s.taa ? halton((frame % JITTER_PERIOD) + 1, 3) - 0.5 : 0;
      savedProj.copy(camera.projectionMatrix);
      savedProjInv.copy(camera.projectionMatrixInverse);
      if (s.taa) {
        const e = camera.projectionMatrix.elements;
        const ox = (2 * jx) / size.x, oy = (2 * jy) / size.y;
        for (let c = 0; c < 4; c++) { e[c * 4] += ox * e[c * 4 + 3]; e[c * 4 + 1] += oy * e[c * 4 + 3]; }
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
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
        const u = taaMat.uniforms;
        u.tColor.value = sceneRT.texture;
        u.tDepth.value = sceneRT.depthTexture;
        u.tHistory.value = history[cur].texture;
        u.uReproj.value.multiplyMatrices(prevVP, invVP.copy(curVP).invert());
        u.uJitter.value.set(jx, jy);
        u.uSize.value.copy(size);
        u.uHistoryValid.value = historyValid;
        cur = 1 - cur;
        pass(taaMat, history[cur]);
        post.onPass?.('taa', history[cur]);
        color = history[cur].texture;
        historyValid = true;
      }
      prevVP.copy(curVP);
      frame++;

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
      pass(compMat, target);
      if (target) post.onPass?.('composite', target);

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
      pass(compMat, target);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(savedClear, savedAlpha);
    },

    dispose() {
      [sceneRT, still, ...history, ...down, ...up].forEach((t) => t?.dispose());
      sceneRT?.depthTexture?.dispose();
      [taaMat, prefilterMat, downMat, upMat, compMat].forEach((m) => m.dispose());
      tri.dispose();
    },
  };

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
