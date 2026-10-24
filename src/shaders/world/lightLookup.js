// L's world lighting for the drawers that aren't the march (docs/seamless-world.md, "L — lighting"):
// three's meshes (gfx/meshLight.js, through TSL), V2's flying matter (shaders/v2/particleRender.js)
// and the hands' eye probe (gfx/meshWorldLight.js). The same lookups as shaders/world/light.js's
// readers, function for function (shCascadeFor, shTexel, shadowTexelAtt, sunMapShadow /
// sunMapShadowAt, underPool, causticGain, prInside, prAt, probeAt, giIrradiance, glowClipAt), in
// world cells, over the same resources (LC, lcBuf, the probe bands, the glow), but standalone: no
// world copy, no fields, no FrameUniforms, no element tables, so a TSL material or a small
// pipeline can carry them. What light.js reads from those comes in as parameters or constants:
//   - LC: a private copy, LM, the host fills before a lookup (from its binding, or from CPU
//     mirrors of light.js lightUniformValues: TSL can't bind our uniform buffer);
//   - lcBuf: the host's `fn lmLoad(i: u32) -> vec4u` (TSL names the storage buffer itself);
//   - the elements' sigma and liquid class: a constant table (they are constants);
//   - textures and the sampler: parameters (a TSL wgslFn passes them so).
// The numbers are light.js's (imported, or matched by tools/mesh-world-light-check.mjs).
import { SHADOW, PROBE, GLOW, TAGS, SHADOW_TEXELS, TAG_MASK, LightUniforms, clipTexSize } from './light.js';
import { SH_Y0, SH_Y1, SKYVIS_OPEN_DC, SHADOW_TINT_ID_SCALE, VOLUME_SHADOW_BIAS } from '../gfx/lighting.js';
import { SUN_TAN_RADIUS } from '../../gfx/sky.js';
import { ELEMENTS, R } from '../../elements.js';
import { glf } from '../../glsl.js';

const shadowTilesSide = SHADOW.RES / SHADOW.TILE;
const probeChunksSide = PROBE.N / PROBE.CHUNK;
const glowChunksSide = GLOW.N / GLOW.CHUNK;
const v4 = (a) => `vec4f(${a.map(glf).join(', ')})`;
// sigma (rgb) and 1 for a liquid (a): what light.js reads from the tables (SIGMA, RCLASS == R_LIQUID)
const sigmaTable = () => ELEMENTS.map((e) => {
  const s = e.sigma ?? [0, 0, 0];
  return v4([s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, e.render === R.LIQUID ? 1 : 0]);
}).join(', ');

/** The lookups' struct: LightUniforms (shaders/world/light.js), the host's LM is one. */
export const lightLookupStructWGSL = LightUniforms.wgsl;

/**
 * The lookups' WGSL. The host declares LightUniforms (lightLookupStructWGSL, unless it has it),
 * `fn lmLoad(i: u32) -> vec4u` (lcBuf), and with caustics, noise.js's vnoise.
 * @param {{ caustics?: boolean, struct?: boolean }} [opts] caustics: the ripples' focusing in the
 *   sun lookups (light.js causticGain); struct: declare LightUniforms here
 */
export function lightLookupWGSL({ caustics = true, struct = true } = {}) {
  const tileLog = Math.log2(SHADOW.TILE), prLog = Math.log2(PROBE.CHUNK), glLog = Math.log2(GLOW.CHUNK);
  return /* wgsl */ `
${struct ? LightUniforms.wgsl : ''}
var<private> LM: LightUniforms;
const LM_CASCADES: u32 = ${SHADOW.CASCADES}u;
const LM_RES: i32 = ${SHADOW.RES};
const LM_TILES: i32 = ${shadowTilesSide};
const LM_MARGIN: i32 = ${SHADOW.MARGIN};
const LM_TAGS_AT: u32 = ${SHADOW_TEXELS}u;
const LM_TAG_SHADOW: u32 = ${TAGS.SHADOW}u;
const LM_TAG_PROBE: u32 = ${TAGS.PROBE}u;
const LM_TAG_GLOW: u32 = ${TAGS.GLOW}u;
const LM_TINT_ID_SCALE: f32 = ${glf(SHADOW_TINT_ID_SCALE)};
const LM_VOLUME_BIAS: f32 = ${glf(VOLUME_SHADOW_BIAS)};
const LM_NORMAL_OFFSET: f32 = 0.002;   // light.js SHADOW_NORMAL_OFFSET
const LM_BIAS_MIN: f32 = 0.8;          // SHADOW_BIAS_MIN
const LM_BIAS_NS_MIN: f32 = 0.25;      // SHADOW_BIAS_NS_MIN
const LM_BIAS_PAD: f32 = 0.1;          // SHADOW_BIAS_PAD
const LM_SH_Y0: f32 = ${SH_Y0.toFixed(6)};
const LM_SH_Y1: f32 = ${SH_Y1.toFixed(6)};
const LM_SH_COS1: f32 = 2.0 / 3.0;
const LM_SKYVIS_OPEN_DC: f32 = ${SKYVIS_OPEN_DC.toFixed(6)};
const LM_PR_LEVELS: u32 = ${PROBE.LEVELS}u;
const LM_PR_N: i32 = ${PROBE.N};
const LM_PR_CHUNKS: i32 = ${probeChunksSide};
const LM_PR_EDGE: f32 = ${glf(PROBE.EDGE_BLEND)};
const LM_PR_TEX: vec3f = vec3f(${clipTexSize(PROBE.LEVELS, PROBE.N).map(glf).join(', ')});
const LM_GL_LEVELS: u32 = ${GLOW.LEVELS}u;
const LM_GL_N: i32 = ${GLOW.N};
const LM_GL_CHUNKS: i32 = ${glowChunksSide};
const LM_GL_TEX: vec3f = vec3f(${clipTexSize(GLOW.LEVELS, GLOW.N).map(glf).join(', ')});
const LM_ELEMENTS: i32 = ${ELEMENTS.length};
const LM_SIGMA = array<vec4f, ${ELEMENTS.length}>(${sigmaTable()});
fn lmSigma(id: i32) -> vec4f { return LM_SIGMA[clamp(id, 0, LM_ELEMENTS - 1)]; }
fn lmMeanSigma(id: i32) -> f32 { return dot(lmSigma(id).rgb, vec3f(1.0 / 3.0)); }

// ---- tags (light.js lcTag, lcTagAt, lcWrap) ----
fn lmTagAt(w: u32) -> u32 { return lmLoad(LM_TAGS_AT + (w >> 2u))[w & 3u]; }
fn lmTag(c: vec3i) -> u32 {
  let m = vec3u(c) & vec3u(${TAG_MASK}u);
  return 0x80000000u | m.x | (m.y << 10u) | (m.z << 20u);
}
fn lmWrap(a: vec3i, n: i32) -> vec3i { return ((a % n) + n) % n; }
fn lmWrap2(a: vec2i, n: i32) -> vec2i { return ((a % n) + n) % n; }

// ---- the sun's cascades (light.js shPlace, shIndex, shTagIndex, shCascadeFor, shTexel) ----
fn lmPlace(k: u32, p: vec3f, d: ptr<function, f32>) -> vec2f {
  let q = p - LM.centre.xyz;
  *d = LM.centre.w - dot(q, LM.shS[k].xyz);
  return vec2f(dot(q, LM.shU[k].xyz), dot(q, LM.shV[k].xyz)) / LM.shU[k].w;
}
fn lmIndex(k: u32, ij: vec2i) -> u32 {
  let w = lmWrap2(ij, LM_RES);
  return u32(LM.shV[k].w) * u32(LM_RES * LM_RES) + u32(w.x + LM_RES * w.y);
}
fn lmTileTag(slot: u32, tile: vec2i) -> u32 {
  let w = lmWrap2(tile, LM_TILES);
  return lmTagAt(LM_TAG_SHADOW + slot * u32(LM_TILES * LM_TILES) + u32(w.x + LM_TILES * w.y));
}
fn lmCascadeFor(p: vec3f) -> u32 {
  for (var k = 0u; k < LM_CASCADES; k++) {
    if (LM.shO[k].z == 0) { continue; }
    var d: f32;
    let f = lmPlace(k, p, &d) - 0.5;
    let i0 = vec2i(floor(f));
    let o = LM.shO[k].xy;
    let m = select(LM_MARGIN, 0, k + 1u == LM_CASCADES);
    if (any(i0 < o + m) || any(i0 + 1 > o + LM_RES - 1 - m)) { continue; }
    let slot = u32(LM.shV[k].w);
    let t0 = i0 >> vec2u(${tileLog}u);
    let t1 = (i0 + 1) >> vec2u(${tileLog}u);
    let ep = i32(LM.shS[k].w);
    if (lmTileTag(slot, t0) != lmTag(vec3i(t0, ep)) || lmTileTag(slot, t1) != lmTag(vec3i(t1, ep))) { continue; }
    return k;
  }
  return LM_CASCADES;
}
fn lmTexel(k: u32, ij: vec2i) -> vec4f {
  let o = LM.shO[k].xy;
  return bitcast<vec4f>(lmLoad(lmIndex(k, clamp(ij, o, o + LM_RES - 1))));
}
// light.js shadowTexelAtt: the colour through liquid, glass and smoke at depth d behind texel sm
fn lmTexelAtt(sm: vec4f, d: f32) -> vec3f {
  let tid = i32(sm.w / LM_TINT_ID_SCALE);
  if (tid <= 0 || d <= sm.y) { return vec3f(1.0); }
  let tau = sm.w - f32(tid) * LM_TINT_ID_SCALE;
  let frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
  let tint = lmSigma(tid).rgb / max(lmMeanSigma(tid), 1e-4);
  return exp(-tint * tau * frac);
}
// light.js underPool: p lies under open liquid deep enough for the ripples' caustics
fn lmUnderPool(sm: vec4f, d: f32, tid: i32) -> bool {
  if (lmSigma(tid).a < 0.5 || d <= sm.y || d >= sm.z + LM_CAUSTIC_BED_GAP) { return false; }
  let lenL = (sm.w - f32(tid) * LM_TINT_ID_SCALE) / max(lmMeanSigma(tid), 1e-4);
  return lenL >= LM_CAUSTIC_FILL * (min(d, sm.z) - sm.y);
}
const LM_CAUSTIC_BED_GAP: f32 = 2.0;   // light.js CAUSTIC_BED_GAP
const LM_CAUSTIC_FILL: f32 = 0.7;      // CAUSTIC_FILL
${caustics ? /* wgsl */ `
// light.js rippleH and causticGain (world cells: the ripples are anchored in the world)
const LM_RIPPLE_FREQ: f32 = 0.3;
const LM_RIPPLE_DRIFT: f32 = 0.6;
const LM_RIPPLE_OCT2: f32 = 2.1;
const LM_RIPPLE_OCT2_AMP: f32 = 0.5;
const LM_RIPPLE_OCT2_DRIFT: f32 = 1.3;
const LM_RIPPLE_OCT2_SHIFT: f32 = 7.3;
const LM_CAUSTIC_BEND: f32 = 0.25;
const LM_CAUSTIC_SLOPE: f32 = 0.18;
const LM_CAUSTIC_EPS: f32 = 0.35;
const LM_CAUSTIC_MAX: f32 = 4.0;
const LM_CAUSTIC_MIN: f32 = 0.3;
const LM_SUN_TAN_RADIUS: f32 = ${SUN_TAN_RADIUS};
fn lmRippleH(q: vec2f, t: f32) -> f32 {
  return vnoise(vec3f(q, t)) + LM_RIPPLE_OCT2_AMP * vnoise(vec3f(q * LM_RIPPLE_OCT2 + LM_RIPPLE_OCT2_SHIFT, t * LM_RIPPLE_OCT2_DRIFT));
}
fn lmCausticGain(p: vec3f, D: f32, sun: vec3f, time: f32) -> f32 {
  let q = (p + sun * D).xz * LM_RIPPLE_FREQ;
  let t = time * LM_RIPPLE_DRIFT;
  let h0 = lmRippleH(q, t);
  let lapQ = (lmRippleH(q + vec2f(LM_CAUSTIC_EPS, 0.0), t) + lmRippleH(q - vec2f(LM_CAUSTIC_EPS, 0.0), t)
            + lmRippleH(q + vec2f(0.0, LM_CAUSTIC_EPS), t) + lmRippleH(q - vec2f(0.0, LM_CAUSTIC_EPS), t) - 4.0 * h0)
            / (LM_CAUSTIC_EPS * LM_CAUSTIC_EPS);
  let lap = LM_CAUSTIC_SLOPE * LM_RIPPLE_FREQ * lapQ;
  let I = clamp(1.0 / max(1.0 + D * LM_CAUSTIC_BEND * lap, 1e-3), LM_CAUSTIC_MIN, LM_CAUSTIC_MAX);
  let blur = D * LM_SUN_TAN_RADIUS * LM_RIPPLE_FREQ * 2.0 * 3.14159265;
  return mix(1.0, I, exp(-0.5 * blur * blur));
}` : ''}
// The sun's cascades at world point p (light.js sunMapShadowAt, its 2×2 taps). n zero: a point in
// the open (VOLUME_SHADOW_BIAS); else a surface facing n (sunMapShadow's normal offset and slope
// bias, without its PCSS: the lookups have no pixel to rotate the taps by). Nothing traced
// there yet: lit, as light.js. caustics: the ripples' focusing (time: FU.time's clock, s).
fn lmSunMap(p0: vec3f, n: vec3f, caustics: bool, time: f32) -> vec3f {
  let surface = dot(n, n) > 0.0;
  let p = p0 + n * LM_NORMAL_OFFSET;
  let k = lmCascadeFor(p);
  if (k >= LM_CASCADES) { return vec3f(1.0); }
  var d: f32;
  let f = lmPlace(k, p, &d) - 0.5;
  let i0 = vec2i(floor(f));
  let w = f - vec2f(i0);
  let u = LM.shU[k].xyz;
  let v = LM.shV[k].xyz;
  let sun = LM.shS[k].xyz;
  var bias = LM_VOLUME_BIAS;
  if (surface) { bias = max(LM_BIAS_MIN, LM.shU[k].w * (abs(dot(n, u)) + abs(dot(n, v))) / max(dot(n, sun), LM_BIAS_NS_MIN) + LM_BIAS_PAD); }
  var acc = vec3f(0.0);
  var cD = 0.0;
  var cW = 0.0;
  for (var j = 0; j < 4; j++) {
    let o = vec2i(j & 1, j >> 1u);
    let sm = lmTexel(k, i0 + o);
    let wk = select(1.0 - w.x, w.x, o.x == 1) * select(1.0 - w.y, w.y, o.y == 1);
    let tid = i32(sm.w / LM_TINT_ID_SCALE);
    if (tid > 0 && lmUnderPool(sm, d, tid)) { cD += (d - sm.y) * wk; cW += wk; }
    acc += select(vec3f(0.0), vec3f(1.0), d < sm.x + bias) * lmTexelAtt(sm, d) * wk;
  }
  ${caustics ? 'if (caustics && cW > 0.0) { acc *= mix(1.0, lmCausticGain(p, cD / cW, sun, time), cW); }' : ''}
  return acc;
}

// ---- the probes (light.js prChunkTag, prTex, prInside, prAt, prMix, probeAt, giIrradiance) ----
struct LmProbe { c0: vec4f, cx: vec4f, cy: vec4f, cz: vec4f }
// level k's texel at lattice point q of a clip texture (levels side by side along x, a guard texel each)
fn lmClip(t: texture_3d<f32>, s: sampler, level: u32, q: vec3f, N: i32, size: vec3f) -> vec4f {
  let lo = floor(q);
  let w = vec3f(lmWrap(vec3i(lo), N)) + (q - lo) + 0.5;
  let x = vec3f(f32(level) * f32(N + 1), 0.0, 0.0) + w;
  return textureSampleLevel(t, s, x / size, 0.0);
}
fn lmPrChunkTag(level: u32, chunk: vec3i) -> u32 {
  let w = lmWrap(chunk, LM_PR_CHUNKS);
  return lmTagAt(LM_TAG_PROBE + level * u32(LM_PR_CHUNKS * LM_PR_CHUNKS * LM_PR_CHUNKS) + u32(w.x + LM_PR_CHUNKS * (w.y + LM_PR_CHUNKS * w.z)));
}
fn lmPrInside(k: u32, p: vec3f, q: ptr<function, vec3f>) -> f32 {
  let S = f32(LM.prO[k].w);
  *q = p / S - 0.5;
  let o = vec3f(LM.prO[k].xyz);
  let lo = floor(*q);
  let ci0 = vec3i(lo) >> vec3u(${prLog}u);
  let ci1 = (vec3i(lo) + 1) >> vec3u(${prLog}u);
  if (lmPrChunkTag(k, ci0) != lmTag(ci0) || lmPrChunkTag(k, ci1) != lmTag(ci1)) { return 0.0; }
  let e = min(*q - o, o + f32(LM_PR_N - 1) - *q);
  return min(e.x, min(e.y, e.z));
}
fn lmPrAt(k: u32, q: vec3f, g0: texture_3d<f32>, g1: texture_3d<f32>, g2: texture_3d<f32>, g3: texture_3d<f32>, s: sampler) -> LmProbe {
  return LmProbe(lmClip(g0, s, k, q, LM_PR_N, LM_PR_TEX), lmClip(g1, s, k, q, LM_PR_N, LM_PR_TEX),
                 lmClip(g2, s, k, q, LM_PR_N, LM_PR_TEX), lmClip(g3, s, k, q, LM_PR_N, LM_PR_TEX));
}
// light.js lcOpenProbe: the open environment (sky above, ground below) as a probe
fn lmOpenProbe(skyUp: vec3f, ground: vec3f) -> LmProbe {
  let k1 = 0.5 / (LM_SH_COS1 * LM_SH_Y1);
  return LmProbe(vec4f(0.5 * (skyUp + ground) / LM_SH_Y0, LM_SKYVIS_OPEN_DC / LM_SH_Y0), vec4f(0.0),
                 vec4f(0.5 * (skyUp - ground) * k1, k1), vec4f(0.0));
}
fn lmMix(a: LmProbe, b: LmProbe, t: f32) -> LmProbe {
  return LmProbe(mix(a.c0, b.c0, t), mix(a.cx, b.cx, t), mix(a.cy, b.cy, t), mix(a.cz, b.cz, t));
}
// The probe at world point p: the finest level holding it, handed to the next over its last
// PR_EDGE probes, the open environment past the coarsest (light.js probeAt).
fn lmProbeAt(p: vec3f, g0: texture_3d<f32>, g1: texture_3d<f32>, g2: texture_3d<f32>, g3: texture_3d<f32>, s: sampler,
             skyUp: vec3f, ground: vec3f) -> LmProbe {
  for (var k = 0u; k < LM_PR_LEVELS; k++) {
    var q: vec3f;
    let e = lmPrInside(k, p, &q);
    if (e <= 0.0) { continue; }
    let g = lmPrAt(k, q, g0, g1, g2, g3, s);
    if (e >= LM_PR_EDGE) { return g; }
    var next = lmOpenProbe(skyUp, ground);
    for (var j = k + 1u; j < LM_PR_LEVELS; j++) {
      var q2: vec3f;
      if (lmPrInside(j, p, &q2) > 0.0) { next = lmPrAt(j, q2, g0, g1, g2, g3, s); break; }
    }
    return lmMix(next, g, e / LM_PR_EDGE);
  }
  return lmOpenProbe(skyUp, ground);
}
// light.js giIrradiance, without the scene's cave ambient (the host adds its own)
fn lmIrradiance(g: LmProbe, n: vec3f) -> vec3f {
  return max(LM_SH_Y0 * g.c0.rgb + LM_SH_COS1 * LM_SH_Y1 * (g.cx.rgb * n.x + g.cy.rgb * n.y + g.cz.rgb * n.z), vec3f(0.0));
}

// ---- the glow (light.js glChunkTag, glTex, glowClipAt) ----
fn lmGlChunkTag(level: u32, chunk: vec3i) -> u32 {
  let w = lmWrap(chunk, LM_GL_CHUNKS);
  return lmTagAt(LM_TAG_GLOW + level * u32(LM_GL_CHUNKS * LM_GL_CHUNKS * LM_GL_CHUNKS) + u32(w.x + LM_GL_CHUNKS * (w.y + LM_GL_CHUNKS * w.z)));
}
fn lmGlowAt(p: vec3f, t: texture_3d<f32>, s: sampler) -> vec3f {
  for (var k = 0u; k < LM_GL_LEVELS; k++) {
    let q = p / f32(LM.glO[k].w) - 0.5;
    let o = vec3f(LM.glO[k].xyz);
    if (any(q < o) || any(q > o + f32(LM_GL_N - 1))) { continue; }
    let lo = vec3i(floor(q));
    let c0 = lo >> vec3u(${glLog}u);
    let c1 = (lo + 1) >> vec3u(${glLog}u);
    if (lmGlChunkTag(k, c0) != lmTag(c0) || lmGlChunkTag(k, c1) != lmTag(c1)) { continue; }
    return lmClip(t, s, k, q, LM_GL_N, LM_GL_TEX).rgb;
  }
  return vec3f(0.0);
}
`;
}

/**
 * LM from five mat4 columns (TSL can't bind our uniform buffer: gfx/meshLight.js mirrors LC's values
 * into mat4 uniforms, packMeshLC): u = shU[0..2], centre; v = shV[0..2], size; s = shS[0..2], glO[1];
 * o = shO[0..2], glO[0]; p = prO[0..2], unused.
 */
export const lightLookupFromMatsWGSL = /* wgsl */ `
fn lmSetMats(u: mat4x4f, v: mat4x4f, s: mat4x4f, o: mat4x4f, p: mat4x4f) {
  LM.shU = array<vec4f, 3>(u[0], u[1], u[2]);
  LM.centre = u[3];
  LM.shV = array<vec4f, 3>(v[0], v[1], v[2]);
  LM.size = v[3];
  LM.shS = array<vec4f, 3>(s[0], s[1], s[2]);
  LM.shO = array<vec4i, 3>(vec4i(round(o[0])), vec4i(round(o[1])), vec4i(round(o[2])));
  LM.prO = array<vec4i, 3>(vec4i(round(p[0])), vec4i(round(p[1])), vec4i(round(p[2])));
  LM.glO = array<vec4i, 2>(vec4i(round(o[3])), vec4i(round(s[3])));
}`;

/**
 * LC's values (gfx/worldLightBook.js lightUniformValues) as the five mat4s' column-major floats
 * lightLookupFromMatsWGSL reads, into out (5 × 16 floats).
 * @param {{ shU: number[][], shV: number[][], shS: number[][], shO: number[][], centre: number[], prO: number[][], glO: number[][], size: number[] }} lc
 * @param {Float32Array} [out]
 */
export function packLightMats(lc, out = new Float32Array(80)) {
  const cols = [
    [...lc.shU, lc.centre], [...lc.shV, lc.size], [...lc.shS, lc.glO[1]], [...lc.shO, lc.glO[0]], [...lc.prO, [0, 0, 0, 0]],
  ];
  cols.forEach((m, i) => m.forEach((c, j) => { for (let k = 0; k < 4; k++) out[16 * i + 4 * j + k] = c[k] ?? 0; }));
  return out;
}
