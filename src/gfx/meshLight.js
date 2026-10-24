// The meshes' light (docs/webgpu.md F8): what three.js's materials read of
// ours, so a figure, a vehicle or a tool in hand is lit as the sand next to it
// is. The same sun and its shadow map (with the tint of liquid and glass it
// passed through, the ripples' caustics and the clouds' shadow), the same GI
// probes (sky and bounce light, dark in caves) and the same glow of hot matter
// (the light volume) and wand lights, read from our textures through
// THREE.ExternalTexture (src/gpu/three.js, B10). The float shadow map is read
// with textureLoad only, as lighting.js reads it (B10: three binds float
// textures unfilterable).
//
// One set of nodes serves every material: the textures' nodes are repointed
// when the grid's textures are made again (updateMeshLight), and the per-frame
// values are uniform nodes, so a material is built once per albedo, not per
// grid as the GLSL materials were (they baked the grid size in).
//
// The WGSL is lighting.js's, function for function (sunBasis,
// sunMapShadowAt, underPool, causticGain, cloudDensity, cloudShadow, probeTex,
// giIrradiance, sampleLight, wandLight), with what those read from
// FrameUniforms, the header and the tables passed as parameters instead:
// three.js's node builder declares the bindings, so a function it calls can't
// name ours. Their numbers are taken from those modules' WGSL (SHARED below),
// and tools/mesh-check.mjs's light stage evaluates both on the GPU at random
// points of a lit scene and compares them.
//
// Also here, for every module that adds meshes: the app's device (setMeshGpu,
// from src/wire/mesh.js), and prepareMesh(object), which compiles a new kind of
// mesh before it joins the scene (B5: three otherwise builds its pipeline
// synchronously at the first draw).
import {
  Vector3, Vector4, Matrix4, DataTexture, Data3DTexture, RGBAFormat, FloatType, HalfFloatType, UnsignedByteType,
  NearestFilter, LinearFilter, ClampToEdgeWrapping, RepeatWrapping, NoColorSpace, MeshBasicNodeMaterial, StorageBufferAttribute,
} from 'three/webgpu';
import { uniform, texture, texture3D, sampler, wgslFn, code, vec4, float, positionWorld, normalWorld, smoothstep, max, dot, storage } from 'three/tsl';
import { externalTexture } from '../gpu/three.js';
import { glslMod } from '../gpu/wgsl.js';
import { gfxUniforms, WAND_LIGHTS } from './uniforms.js';
import { createMediaNoise } from './mediaNoise.js';
import { noiseGLSL } from '../shaders/gfx/noise.js';
import { lightingGLSL } from '../shaders/gfx/lighting.js';
import { cloudDeckGLSL } from '../shaders/gfx/clouds.js';
import { BRICK } from '../shaders/common.js';
import { ELEMENTS, R } from '../elements.js';
import { glf as f } from '../glsl.js';
import { lightLookupWGSL, lightLookupFromMatsWGSL, packLightMats } from '../shaders/world/lightLookup.js';
import { lightUniformValues } from './worldLightBook.js';

// Figures sit in the window's light at these offsets (cells): shadow lookups
// move toward the sun (off the body's own cells), GI probes are read out along
// the normal (figure.js's FIG_SHADOW_LIFT, FIG_GI_LIFT)
export const SHADOW_LIFT = 0.6;
export const GI_LIFT = 1.5;

// ---------------------------------------------------------------- the WGSL

// The numbers these functions share with lighting.js and clouds.js (the sun's
// disc, the ripples and their caustics, the probes' SH, the shadow map's
// encoding, the cloud deck), taken from those modules' own WGSL under a FIG_
// prefix, so the two copies can't drift apart on a number.
const SHARED_FROM = lightingGLSL({ shadowMap: true, probes: true }) + cloudDeckGLSL;
const SHARED = [
  ['FIG_PI', 'PI_L'], 'SH_Y0', 'SH_Y1', 'SH_COS1', ['FIG_TINT_ID_SCALE', 'SHADOW_TINT_ID_SCALE'], 'SHADOW_PAD', 'VOLUME_SHADOW_BIAS',
  'SUN_TAN_RADIUS', 'RIPPLE_FREQ', 'RIPPLE_DRIFT', 'RIPPLE_OCT2', 'RIPPLE_OCT2_AMP', 'RIPPLE_OCT2_DRIFT', 'RIPPLE_OCT2_SHIFT',
  'CAUSTIC_BEND', 'CAUSTIC_SLOPE', 'CAUSTIC_EPS', 'CAUSTIC_BED_GAP', 'CAUSTIC_FILL', 'CAUSTIC_MAX', 'CAUSTIC_MIN',
  'CLOUD_BASE', 'CLOUD_THICK', 'CLOUD_COVER', 'CLOUD_SHAPE_A_F', 'CLOUD_SHAPE_B_F', 'CLOUD_SHAPE_B_W', 'CLOUD_SLICE_A', 'CLOUD_SLICE_B',
  'CLOUD_ERODE', 'CLOUD_NOISE_MEAN', 'CLOUD_ROUND_LO', 'CLOUD_ROUND_HI', 'CLOUD_DOME', 'CLOUD_SIGMA', 'CLOUD_SHADOW_N', 'CLOUD_SHADOW_SKIP',
].map((n) => {
  const [ours, theirs] = Array.isArray(n) ? n : [`FIG_${n}`, n];
  const m = SHARED_FROM.match(new RegExp(`const ${theirs}: (\\w+) = ([^;]+);`));
  if (!m) throw new Error(`meshLight: lighting.js and clouds.js declare no const ${theirs}`);
  return `const ${ours}: ${m[1]} = ${m[2]};`;
}).join('\n');

// lighting.js's, with FrameUniforms' fields as parameters: sun (xyz, w: the
// shadows switch), grid (nx, ny, nz, shadowRes), origin (the window's, cells;
// w: the animation clock, FU.time), cave (the scene's ambient floor; w: the
// caustics switch), cloud (clouds on, cloudSea, cloudShift)
const LIGHT_WGSL = /* wgsl */ `
${glslMod}
${noiseGLSL}
${SHARED}
const FIG_BS: f32 = ${f(BRICK)};

// sigma (rgb) and the liquid flag (a) of element id: the tables' SIGMA and RCLASS == R_LIQUID
fn figSigma(sig: texture_2d<f32>, id: i32) -> vec4f {
  return textureLoad(sig, vec2i(clamp(id, 0, i32(textureDimensions(sig).x) - 1), 0), 0);
}
// lighting.js sunBasis
fn figSunBasis(sun: vec3f, grid: vec4f, origin: vec3f, c: ptr<function, vec3f>, R: ptr<function, f32>,
               u: ptr<function, vec3f>, v: ptr<function, vec3f>) {
  *c = grid.xyz * 0.5;
  *R = 0.5 * length(grid.xyz) + FIG_SHADOW_PAD;
  *u = normalize(cross(vec3f(0.0, 1.0, 0.0), sun));
  *v = cross(sun, *u);
  let T = 2.0 * *R / max(grid.w, 1.0);
  let ot = vec2f(dot(origin, *u), dot(origin, *v)) / T;
  let snap = (round(ot) - ot) * T;
  *c += snap.x * *u + snap.y * *v;
}
// lighting.js rippleH, underPool, causticGain
fn figRippleH(q: vec2f, t: f32) -> f32 {
  return vnoise(vec3f(q, t)) + FIG_RIPPLE_OCT2_AMP * vnoise(vec3f(q * FIG_RIPPLE_OCT2 + FIG_RIPPLE_OCT2_SHIFT, t * FIG_RIPPLE_OCT2_DRIFT));
}
fn figUnderPool(sm: vec4f, d: f32, s: vec4f, tid: i32) -> bool {
  if (s.w < 0.5 || d <= sm.y || d >= sm.z + FIG_CAUSTIC_BED_GAP) { return false; }
  let lenL = (sm.w - f32(tid) * FIG_TINT_ID_SCALE) / max(dot(s.rgb, vec3f(1.0 / 3.0)), 1e-4);
  return lenL >= FIG_CAUSTIC_FILL * (min(d, sm.z) - sm.y);
}
fn figCausticGain(p: vec3f, D: f32, sun: vec3f, origin: vec4f) -> f32 {
  let s = p + sun * D;
  let q = (s + origin.xyz).xz * FIG_RIPPLE_FREQ;
  let t = origin.w * FIG_RIPPLE_DRIFT;
  let h0 = figRippleH(q, t);
  let lapQ = (figRippleH(q + vec2f(FIG_CAUSTIC_EPS, 0.0), t) + figRippleH(q - vec2f(FIG_CAUSTIC_EPS, 0.0), t)
            + figRippleH(q + vec2f(0.0, FIG_CAUSTIC_EPS), t) + figRippleH(q - vec2f(0.0, FIG_CAUSTIC_EPS), t) - 4.0 * h0)
            / (FIG_CAUSTIC_EPS * FIG_CAUSTIC_EPS);
  let lap = FIG_CAUSTIC_SLOPE * FIG_RIPPLE_FREQ * lapQ;
  let I = clamp(1.0 / max(1.0 + D * FIG_CAUSTIC_BEND * lap, 1e-3), FIG_CAUSTIC_MIN, FIG_CAUSTIC_MAX);
  let blur = D * FIG_SUN_TAN_RADIUS * FIG_RIPPLE_FREQ * 2.0 * FIG_PI;
  return mix(1.0, I, exp(-0.5 * blur * blur));
}
// lighting.js sunMapShadowAt: the sun at a point p inside a volume, from the map
fn figSunMapShadowAt(p: vec3f, sm0: texture_2d<f32>, sig: texture_2d<f32>, sun: vec3f, grid: vec4f, origin: vec4f, caustics: bool) -> vec3f {
  var c: vec3f;
  var R: f32;
  var u: vec3f;
  var v: vec3f;
  figSunBasis(sun, grid, origin.xyz, &c, &R, &u, &v);
  let res = i32(grid.w);
  let q = p - c;
  let st = vec2f(dot(q, u), dot(q, v)) / R * 0.5 + 0.5;
  let d = R - dot(q, sun);
  let fp = st * grid.w - 0.5;
  let i0 = vec2i(floor(fp));
  let w = fp - vec2f(i0);
  var acc = vec3f(0.0);
  var cD = 0.0;
  var cW = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1u);
    let sm = textureLoad(sm0, clamp(i0 + o, vec2i(0), vec2i(res - 1)), 0);
    var lit = select(vec3f(0.0), vec3f(1.0), d < sm.x + FIG_VOLUME_SHADOW_BIAS);
    let tid = i32(sm.w / FIG_TINT_ID_SCALE);
    let wk = select(1.0 - w.x, w.x, o.x == 1) * select(1.0 - w.y, w.y, o.y == 1);
    if (tid > 0 && d > sm.y) {
      let s = figSigma(sig, tid);
      let tau = sm.w - f32(tid) * FIG_TINT_ID_SCALE;
      let frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
      let tint = s.rgb / max(dot(s.rgb, vec3f(1.0 / 3.0)), 1e-4);
      lit *= exp(-tint * tau * frac);
      if (figUnderPool(sm, d, s, tid)) { cD += (d - sm.y) * wk; cW += wk; }
    }
    acc += lit * wk;
  }
  if (caustics && cW > 0.0) { acc *= mix(1.0, figCausticGain(p, cD / cW, sun, origin), cW); }
  return acc;
}
// clouds.js cloudDensity (detail 0: the light's) and cloudShadow
fn figCloudDensity(p: vec3f, noise: texture_3d<f32>, rep: sampler, cloud: vec4f) -> f32 {
  let h = (p.y - cloud.y - FIG_CLOUD_BASE) / FIG_CLOUD_THICK;
  if (h <= 0.0 || h >= 1.0) { return 0.0; }
  let xz = p.xz + cloud.zw;
  let w = mix(textureSampleLevel(noise, rep, vec3f(xz * FIG_CLOUD_SHAPE_A_F, FIG_CLOUD_SLICE_A), 0.0).r,
              textureSampleLevel(noise, rep, vec3f(xz.yx * FIG_CLOUD_SHAPE_B_F, FIG_CLOUD_SLICE_B), 0.0).g, FIG_CLOUD_SHAPE_B_W);
  let cov = (w - (1.0 - FIG_CLOUD_COVER)) / FIG_CLOUD_COVER;
  if (cov <= 0.0) { return 0.0; }
  let prof = smoothstep(0.0, FIG_CLOUD_ROUND_LO, h) * (1.0 - smoothstep(FIG_CLOUD_ROUND_HI, 1.0, h));
  let d = cov - FIG_CLOUD_DOME * (1.0 - prof);
  if (d <= 0.0) { return 0.0; }
  return clamp(d - FIG_CLOUD_ERODE * (1.0 - FIG_CLOUD_NOISE_MEAN), 0.0, 1.0);
}
fn figCloudShadow(wp: vec3f, sun: vec3f, noise: texture_3d<f32>, rep: sampler, cloud: vec4f) -> f32 {
  if (cloud.x < 0.5) { return 1.0; }
  var od = 0.0;
  for (var k = 0; k < FIG_CLOUD_SHADOW_N; k++) {
    let y = cloud.y + FIG_CLOUD_BASE + (f32(k) + 0.5) / f32(FIG_CLOUD_SHADOW_N) * FIG_CLOUD_THICK;
    od += figCloudDensity(wp + sun * ((y - wp.y) / sun.y), noise, rep, cloud);
  }
  return exp(-FIG_CLOUD_SIGMA * od * FIG_CLOUD_THICK / (sun.y * f32(FIG_CLOUD_SHADOW_N)));
}
// lighting.js probeTex: one band at p, held to the edge probes' centres
fn figProbeTex(t: texture_3d<f32>, s: sampler, p: vec3f, grid: vec3f) -> vec4f {
  let B = grid / FIG_BS;
  let q = clamp(p / FIG_BS, vec3f(0.5), B - 0.5);
  return textureSampleLevel(t, s, q / B, 0.0);
}
// lighting.js wandLight: row 0 the lights' positions (xyz) and reach (w), row 1 their colours (rgb) and intensity (w)
fn figWandLight(p: vec3f, wand: texture_2d<f32>, count: i32) -> vec3f {
  var light = vec3f(0.0);
  for (var i = 0; i < ${WAND_LIGHTS}; i++) {
    if (i >= count) { break; }
    let pr = textureLoad(wand, vec2i(i, 0), 0);
    let ci = textureLoad(wand, vec2i(i, 1), 0);
    let d = p - pr.xyz;
    let falloff = max(1.0 - dot(d, d) / (pr.w * pr.w), 0.0);
    light += ci.rgb * ci.w * falloff * falloff;
  }
  return light;
}
`;
const lightCode = code(LIGHT_WGSL, [], 'wgsl');
/** The figures' light WGSL as emitted (tools/bake-icons.mjs keys the baked sprites on it). */
export const meshLightWGSL = LIGHT_WGSL;

// The world's light (docs/seamless-world.md, "L"; shaders/world/lightLookup.js): on frames the
// world march draws, the meshes read L's sun cascades, probe cascades and glow in world cells (a
// grid point + the window's origin), the lookups the march's own readers make. lcBuf is bound as
// three's storage buffer named LC_BUF_NAME (gfx/worldLight.js's GPUBuffer adopted by three:
// adoptBuffer), LC comes in as five mat4 uniforms (lightLookup.js packLightMats).
const LC_BUF_NAME = 'lcMeshBuf';
const WORLD_WGSL = /* wgsl */ `
fn lmLoad(i: u32) -> vec4u { return ${LC_BUF_NAME}.value[i]; }
${lightLookupWGSL({ caustics: true })}
${lightLookupFromMatsWGSL}
`;
const worldCode = code(WORLD_WGSL, [lightCode], 'wgsl');
/** The world-light lookups the meshes carry, as emitted (tools/mesh-world-light-check.mjs). */
export const meshWorldLightWGSL = WORLD_WGSL;

// The sunlight falling on grid point p: FU.sunCol × sunShadowAt(p) (lighting.js:
// the clouds' shadow, and the map if light gets through them), or the whole of
// it without the map (sun.w: the shadows switch).
// world.x: L's light (the frame's view is the world march's): the cascades at p + origin, world
// cells (lightLookup.js lmSunMap, as light.js sunShadowAt). tag: lcBuf's first word, so three
// declares the buffer the lookups read by name.
const figSunFn = wgslFn(/* wgsl */ `
fn figSun(p: vec3f, sm: texture_2d<f32>, sig: texture_2d<f32>, noise: texture_3d<f32>, rep: sampler,
          sun: vec4f, sunCol: vec4f, grid: vec4f, origin: vec4f, cave: vec4f, cloud: vec4f,
          world: vec4f, mU: mat4x4f, mV: mat4x4f, mS: mat4x4f, mO: mat4x4f, mP: mat4x4f, tag: vec4u) -> vec3f {
  _ = tag;
  if (sun.w < 0.5) { return sunCol.rgb; }
  let c = figCloudShadow(p + origin.xyz, sun.xyz, noise, rep, cloud);
  if (c <= FIG_CLOUD_SHADOW_SKIP) { return vec3f(0.0); }
  if (world.x > 0.5) {
    lmSetMats(mU, mV, mS, mO, mP);
    return sunCol.rgb * c * lmSunMap(p + origin.xyz, vec3f(0.0), cave.w > 0.5, origin.w);
  }
  return sunCol.rgb * c * figSunMapShadowAt(p, sm, sig, sun.xyz, grid, origin, cave.w > 0.5);
}`, [lightCode, worldCode]);

// The light from everything else at grid point p of a surface facing n: the GI
// probes' irradiance read at q (lighting.js giIrradiance(probeAt(q), n), with the
// scene's ambient floor), and the glow volume and wand lights at p (sampleLight)
// × the glow's gain (sunCol.w).
// world.x: L's light (the bands and the glow are L's then: updateMeshLight points the nodes at
// them): its probe cascades at q + origin (light.js probeAt; the open sky past them: sky, ground)
// and its glow at p + origin (glowClipAt), world cells. The wand lights stay in window cells.
const figAmbientFn = wgslFn(/* wgsl */ `
fn figAmbient(p: vec3f, q: vec3f, n: vec3f, gi0: texture_3d<f32>, gi1: texture_3d<f32>, gi2: texture_3d<f32>, gi3: texture_3d<f32>,
              light: texture_3d<f32>, s: sampler, wand: texture_2d<f32>, wandCount: f32, sunCol: vec4f, grid: vec4f, cave: vec4f,
              origin: vec4f, world: vec4f, sky: vec4f, ground: vec4f,
              mU: mat4x4f, mV: mat4x4f, mS: mat4x4f, mO: mat4x4f, mP: mat4x4f, tag: vec4u) -> vec3f {
  _ = tag;
  if (world.x > 0.5) {
    lmSetMats(mU, mV, mS, mO, mP);
    let g = lmProbeAt(q + origin.xyz, gi0, gi1, gi2, gi3, s, sky.rgb, ground.rgb);
    let wl = lmGlowAt(p + origin.xyz, light, s) + figWandLight(p, wand, i32(wandCount));
    return lmIrradiance(g, n) + cave.rgb + wl * sunCol.w;
  }
  let c0 = figProbeTex(gi0, s, q, grid.xyz);
  let cx = figProbeTex(gi1, s, q, grid.xyz);
  let cy = figProbeTex(gi2, s, q, grid.xyz);
  let cz = figProbeTex(gi3, s, q, grid.xyz);
  let irr = max(FIG_SH_Y0 * c0.rgb + FIG_SH_COS1 * FIG_SH_Y1 * (cx.rgb * n.x + cy.rgb * n.y + cz.rgb * n.z), vec3f(0.0)) + cave.rgb;
  let local = figProbeTex(light, s, p, grid.xyz).rgb + figWandLight(p, wand, i32(wandCount));
  return irr + local * sunCol.w;
}`, [lightCode, worldCode]);

// three.js's getTangentFrame (normalmap_pars_fragment), as figure.js's GLSL
// figNormalMapped had it: the tangent frame from screen-space derivatives of
// the position and UV, for meshes with no tangents (Mikkelsen, "Bump Mapping
// Unparametrized Surfaces on the GPU", 2010). m: the map's texel (0..1).
export const figNormalMappedFn = wgslFn(/* wgsl */ `
fn figNormalMapped(n: vec3f, face: f32, wp: vec3f, uv: vec2f, m0: vec3f, scale: vec2f) -> vec3f {
  let q0 = dpdx(wp);
  let q1 = dpdy(wp);
  let st0 = dpdx(uv);
  let st1 = dpdy(uv);
  let q1perp = cross(q1, n);
  let q0perp = cross(n, q0);
  let T = q1perp * st0.x + q0perp * st1.x;
  let B = q1perp * st0.y + q0perp * st1.y;
  let det = max(dot(T, T), dot(B, B));
  var s = 0.0;
  if (det != 0.0) { s = face * inverseSqrt(det); }
  var m = m0 * 2.0 - 1.0;
  m = vec3f(m.xy * scale, m.z);
  return normalize(T * (m.x * s) + B * (m.y * s) + n * m.z);
}`);

// ---------------------------------------------------------------- the shared nodes

// stand-ins until a grid's textures are in (the formats theirs have, so the
// materials' bindings don't change when they are swapped in)
function data2D(w, h, data) {
  const t = new DataTexture(data, w, h, RGBAFormat, FloatType);
  t.minFilter = t.magFilter = NearestFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = NoColorSpace;
  t.needsUpdate = true;
  return t;
}
function data3D(type, data, wrap = ClampToEdgeWrapping) {
  const t = new Data3DTexture(data, 1, 1, 1);
  t.format = RGBAFormat;
  t.type = type;
  t.minFilter = t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = wrap;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.colorSpace = NoColorSpace;
  t.needsUpdate = true;
  return t;
}
// sigma and the liquid flag per element (the tables' SIGMA, RCLASS == R_LIQUID)
function sigmaTable() {
  const n = ELEMENTS.length, a = new Float32Array(4 * n);
  ELEMENTS.forEach((e, i) => {
    const s = e.sigma ?? [0, 0, 0];
    a.set([s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, e.render === R.LIQUID ? 1 : 0], 4 * i);
  });
  return data2D(n, 1, a);
}

const stand = {
  // a shadow map that shadows nothing: depth 1e9 in every texel, no tint
  shadow: data2D(1, 1, new Float32Array([1e9, 0, 0, 0])),
  band: data3D(HalfFloatType, new Uint16Array(4)),
  noise: data3D(UnsignedByteType, new Uint8Array([128, 128, 128, 128]), RepeatWrapping),
};
const wandData = new Float32Array(4 * WAND_LIGHTS * 2);
// a storage buffer for lcBuf while no world light is bound (window frames: never read)
const standLc = new StorageBufferAttribute(new Uint32Array(4), 4);

/**
 * The light's nodes, shared by every lit material: texture nodes (their
 * `.value` repointed by updateMeshLight) and uniform nodes (set every frame).
 */
export const meshLight = {
  shadow: texture(stand.shadow),
  sigma: texture(sigmaTable()),
  wand: texture(data2D(WAND_LIGHTS, 2, wandData)),
  gi: [0, 1, 2, 3].map(() => texture3D(stand.band)),
  light: texture3D(stand.band),
  noise: texture3D(stand.noise),
  sun: uniform(new Vector4(0, 1, 0, 0)),        // toward the key light; w: the shadow map is read
  sunCol: uniform(new Vector4(1, 1, 1, 1)),    // FU.sunCol; w: the glow's gain, FU.lightGain
  grid: uniform(new Vector4(64, 64, 64, 1)),    // the grid (cells); w: the shadow map's texels per side
  origin: uniform(new Vector4(0, 0, 0, 0)),     // the window's origin (cells); w: the animation clock (s)
  cave: uniform(new Vector4(0, 0, 0, 0)),       // the scene's ambient floor; w: caustics on
  cloud: uniform(new Vector4(0, 0, 0, 0)),      // clouds on, their sea level, their drift (x, z)
  wandCount: uniform(0),
  worldToGrid: uniform(new Matrix4()),          // scene → grid cells (the volume's matrixWorld, inverted)
  // the world's light (L), on frames the world march draws: world.x 1; LC as five mat4s
  // (lightLookup.js packLightMats); lcBuf (gfx/worldLight.js buf.lc, adopted); the open sky's
  // colours above and below (FU.skyUp, FU.ground) past the probe cascades
  world: uniform(new Vector4(0, 0, 0, 0)),
  lc: [0, 1, 2, 3, 4].map(() => uniform(new Matrix4())),
  lcBuf: storage(standLc, 'uvec4', 1).toReadOnly().setName(LC_BUF_NAME),
  sky: uniform(new Vector4(0, 0, 0, 0)),
  ground: uniform(new Vector4(0, 0, 0, 0)),
};


/**
 * The radiance of a lit surface (linear HDR, as the volume's), TSL:
 * albedo × (sun × n·l × shadow + GI + glow) + emit, as figure.js's GLSL had it.
 *   albedo  vec3 node (linear)
 *   n       the shading normal, world (= grid axes), facing the eye
 *   grid    the point in grid cells (default: positionWorld through worldToGrid)
 *   emit    vec3 node added unlit (heat glow, embers), or null
 *   toon    cel shading: n·l through a thin smoothstep (TOON_EDGE)
 * @param {{ albedo: object, n?: object, grid?: object, emit?: object | null, toon?: boolean, toonEdge?: number }} o
 */
export function litColor({ albedo, n = normalWorld, grid = null, emit = null, toon = false, toonEdge = 0.08 }) {
  const p = grid ?? gridPosition();
  const sunDir = meshLight.sun.xyz;
  const { sun, ambient } = meshLightTerms({ p: p.add(sunDir.mul(SHADOW_LIFT)), q: p.add(n.mul(GI_LIFT)), n, glowAt: p });
  let ndl = max(dot(n, sunDir), float(0));
  if (toon) ndl = smoothstep(float(0), float(toonEdge), ndl);
  const lit = albedo.mul(sun.mul(ndl).add(ambient));
  return emit ? lit.add(emit) : lit;
}

/**
 * The two terms of the light at grid points (TSL vec3 nodes): `sun`, the
 * sunlight reaching p (lighting.js FU.sunCol × sunShadowAt(p), or the whole
 * of it with the map off), and `ambient`, the GI probes' irradiance on a
 * surface facing n read at q (giIrradiance(probeAt(q), n)) plus the glow
 * volume and wand lights at glowAt (sampleLight × FU.lightGain).
 * tools/mesh-check.mjs's light stage compares both with lighting.js's own
 * functions on the GPU.
 * @param {{ p: object, q: object, n: object, glowAt?: object }} o
 */
export function meshLightTerms({ p, q, n, glowAt = p }) {
  const L = meshLight;
  const lc = { world: L.world, mU: L.lc[0], mV: L.lc[1], mS: L.lc[2], mO: L.lc[3], mP: L.lc[4], tag: L.lcBuf.element(0) };
  const sun = figSunFn({
    p, sm: L.shadow, sig: L.sigma, noise: L.noise, rep: sampler(L.noise),
    sun: L.sun, sunCol: L.sunCol, grid: L.grid, origin: L.origin, cave: L.cave, cloud: L.cloud, ...lc,
  });
  const ambient = figAmbientFn({
    p: glowAt, q, n, gi0: L.gi[0], gi1: L.gi[1], gi2: L.gi[2], gi3: L.gi[3], light: L.light, s: sampler(L.light),
    wand: L.wand, wandCount: L.wandCount, sunCol: L.sunCol, grid: L.grid, cave: L.cave,
    origin: L.origin, sky: L.sky, ground: L.ground, ...lc,
  });
  return { sun, ambient };
}

/**
 * The fragment's point in grid cells: worldToGrid (default the shared one) × positionWorld.
 * @param {object} [worldToGrid] a mat4 uniform node
 */
export const gridPosition = (worldToGrid = meshLight.worldToGrid) => worldToGrid.mul(vec4(positionWorld, 1)).xyz;

// ---------------------------------------------------------------- per frame

const ext = new Map();      // a node's key → { source: GPUTexture, tex: ExternalTexture }
const standOf = new Map();  // a node → its stand-in (the value it was made with)
// the ExternalTexture wrapping source under key (made again when the source is: a new grid or light)
function wrap(key, source, opts) {
  const had = ext.get(key);
  if (had?.source === source) return had.tex;
  had?.tex.dispose();
  ext.delete(key);
  if (!source) return null;
  const tex = externalTexture(source, opts);
  if (opts?.wrap) tex.wrapS = tex.wrapT = tex.wrapR = opts.wrap;
  ext.set(key, { source, tex });
  return tex;
}
// points node at source's texture (its stand-in without one). A node read from two sources (the
// window's GI bands or L's) keeps a key for each, so switching between them makes nothing again.
function point(key, node, source, opts) {
  if (!standOf.has(node)) standOf.set(node, node.value);
  const v = wrap(key, source, opts) ?? standOf.get(node);
  if (node.value !== v) node.value = v;
}
// three's storage attribute bound to L's lcBuf (its GPUBuffer adopted: three makes a buffer only
// for an attribute it has none for, WebGPUAttributeUtils.createAttribute, and never destroys one
// outside a geometry's), made again for a new world light
let lcAdopted = { source: null, attr: null };
function lcAttribute(three, buffer) {
  if (lcAdopted.source === buffer) return lcAdopted.attr;
  const attr = new StorageBufferAttribute(new Uint32Array(4), 4);
  three.renderer.backend.get(attr).buffer = buffer;
  lcAdopted = { source: buffer, attr };
  return attr;
}
const lcMats = new Float32Array(80);

const sunV = new Vector3(), inv = new Matrix4();
/**
 * Brings the light's nodes up to this frame (src/wire/mesh.js beforeView):
 * the grid's textures (repointed when its shadow map, light or GI bands are
 * made again: a new grid), the sun and sky, the window, the wand lights. On
 * a frame the world march draws (app.worldLight: gfx/worldLight.js's
 * WorldLight, else null), the bands and the glow are L's and the lookups
 * L's cascades (docs/seamless-world.md: one lighting system).
 * @param {{ gpu: object, sim: object, derived?: object, vol?: object, volume?: object, sun: object,
 *   viewTimeUniform?: { value: number }, worldLight?: object | null }} app
 */
export function updateMeshLight(app) {
  const L = meshLight, u = gfxUniforms;
  const { sim, vol, volume } = app;
  const derived = app.derived ?? sim?.derived;
  const wl = app.gpu?.three ? app.worldLight ?? null : null;
  const shadows = wl ? true : vol?.shadowState === 'ready';
  point('shadow', L.shadow, !wl && shadows ? vol.shadowTextures.map : null, { dimension: '2d' });
  if (wl) {
    wl.bands.forEach((t, k) => point(`world gi${k}`, L.gi[k], t, { dimension: '3d' }));
    point('world glow', L.light, wl.glowTex, { dimension: '3d' });
    const attr = lcAttribute(app.gpu.three, wl.buf.lc);
    if (L.lcBuf.value !== attr) L.lcBuf.value = attr;
    packLightMats(lightUniformValues(wl.size, wl.shadow, wl.probes, wl.glow), lcMats);
    L.lc.forEach((m, i) => m.value.fromArray(lcMats, 16 * i));
  } else {
    [0, 1, 2, 3].forEach((k) => point(`gi${k}`, L.gi[k], derived?.giTextures?.[k] ?? null, { dimension: '3d' }));
    point('light', L.light, derived?.light ?? null, { dimension: '3d' });
    if (L.lcBuf.value !== standLc) L.lcBuf.value = standLc;
  }
  L.world.value.set(wl ? 1 : 0, 0, 0, 0);
  const sky = u.uSkyUp.value, ground = u.uGround.value;
  L.sky.value.set(sky[0], sky[1], sky[2], 0);
  L.ground.value.set(ground[0], ground[1], ground[2], 0);
  const noise = app.gpu ? createMediaNoise(app.gpu).texture : null;
  point('noise', L.noise, noise, { dimension: '3d', wrap: RepeatWrapping });

  sunV.copy(app.sun ?? sunV.set(0, 1, 0)).normalize();
  L.sun.value.set(sunV.x, sunV.y, sunV.z, shadows ? 1 : 0);
  const sc = u.uSunCol.value;
  // the glow's gain as the app last wrote it into FrameUniforms (app.js GLOW_GAIN; 1 before the first write, writeFrameUniforms's default)
  L.sunCol.value.set(sc[0], sc[1], sc[2], app.gpu?.frameUniforms?.values.lightGain ?? 1);
  const g = sim?.g;
  if (g) L.grid.value.set(g.nx, g.ny, g.nz, vol?.shadowRes ?? 1);
  const o = sim?.origin;
  L.origin.value.set(o?.x ?? 0, o?.y ?? 0, o?.z ?? 0, app.viewTimeUniform?.value ?? 0);
  const cave = u.uCaveAmbient.value;
  L.cave.value.set(cave[0], cave[1], cave[2], u.uCaustics.value ? 1 : 0);
  const shift = u.uCloudShift.value;
  L.cloud.value.set(u.uClouds.value ? 1 : 0, u.uCloudSea.value, shift[0], shift[1]);
  // the wand lights (lighting.js wandLight), when they change
  const n = Math.min(u.uWandLightCount.value | 0, WAND_LIGHTS);
  let changed = n !== L.wandCount.value;
  for (let i = 0; i < n; i++) {
    const p = u.uWandLightPosition.value[i], c = u.uWandLightColor.value[i];
    const a = 4 * i, b = 4 * (WAND_LIGHTS + i);
    for (const [k, x] of [[a, p.x], [a + 1, p.y], [a + 2, p.z], [a + 3, p.w], [b, c.x], [b + 1, c.y], [b + 2, c.z], [b + 3, c.w]]) {
      if (wandData[k] !== x) { wandData[k] = x; changed = true; }
    }
  }
  L.wandCount.value = n;
  if (changed) L.wand.value.needsUpdate = true;
  if (volume) L.worldToGrid.value.copy(inv.copy(volume.matrixWorld).invert());
}

/**
 * A material that takes no light (a glow, an outline, a shadow decal): three's
 * basic node material with its lights off (a basic material is lit by
 * default, for light maps), so its program has no lights in it.
 * @param {object} [params] MeshBasicNodeMaterial's
 */
export function unlitMaterial(params) {
  const m = new MeshBasicNodeMaterial(params);
  m.lights = false;
  return m;
}

// ---------------------------------------------------------------- the device, and compiling new meshes

let meshGpu = null;
/** The app's device (src/wire/mesh.js boot): the modules that add meshes compile them through it. */
export function setMeshGpu(gpu) { meshGpu = gpu ?? null; }
/** The device set by setMeshGpu, or null (no app: Node, the icon bake's own page). */
export const getMeshGpu = () => meshGpu;

/**
 * Compiles a new kind of mesh (`object` and everything under it) before it
 * joins the scene (docs/webgpu.md B5, F8), for the scene target's formats
 * (gpu.three.defaults) unless opts says otherwise. Hidden parts are compiled
 * too (they are shown later: a hand's model, a jet's flames), and frustum
 * culling is off for the compile. Resolves when three's pipelines are built;
 * at once when there is no device yet.
 * @param {object} object
 * @param {{ camera?: object, scene?: object, target?: object, alone?: boolean, rejectOnFailure?: boolean }} [opts]
 *   alone: the object only, not what is under it
 * @returns {Promise<void>}
 */
export function prepareMesh(object, { alone = false, rejectOnFailure = false, ...opts } = {}) {
  const three = meshGpu?.three;
  if (!three) return Promise.resolve();
  if (meshGpu.failure || meshGpu.lost) return rejectOnFailure
    ? Promise.reject(meshGpu.failure ?? new Error('prepareMesh: GPU device lost')) : Promise.resolve();
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];   // (left out: the defaults')
  const saved = [], done = [];
  const tSig = targetSig(opts.target ?? three.defaults.target);
  const lSig = lightsSig(opts.scene ?? three.defaults.scene, opts.camera ?? three.defaults.camera);
  object.traverse((o) => {
    saved.push([o, o.visible, o.frustumCulled]);
    o.visible = !alone || o === object;
    o.frustumCulled = false;
    if (o.material && o.visible) done.push([o, o.material]);
  });
  // three keys a render object's lights and environment by the renderer's
  // render-call count (NodeManager.getCacheKey caches it per info.calls): a
  // compile after a light came or went, with no render since, would take the
  // last render's key, and the next render would throw the compiled pipeline
  // away and build it again synchronously. A count no render has had keeps
  // the compile's key fresh. (Belongs in gpu.three.prepare: hand-back.)
  const info = three.renderer.info, calls = info.calls;
  info.calls = -(++prepares);
  let p;
  try {
    p = three.prepare(object, opts);   // (three reads visibility, and the key, before its first await)
  } catch (error) {
    p = Promise.reject(error);
  } finally {
    info.calls = calls;
    for (const [o, v, fc] of saved) { o.visible = v; o.frustumCulled = fc; }
  }
  return Promise.resolve(p).then(() => {
    for (const [o, m] of done) preparedWith.set(o, { material: m, key: keyOf(tSig, lSig) });
  }, (e) => { if (!meshGpu?.failure) console.warn('prepareMesh:', e?.message ?? e); if(rejectOnFailure)throw e; });
}

let prepares = 0;
// what a pipeline depends on in the target it draws into
const targetSig = (t) => (t ? `${t.texture?.type}|${t.texture?.format}|${t.samples}|${t.depthBuffer}|${t.stencilBuffer}` : 'none');
// and the lights the camera sees: a light that comes or goes changes the key
// three files every render object's program under (NodeManager.getCacheKey),
// a lit material's or not, so the next draw builds them all again
function lightsSig(scene, camera) {
  if (!scene || !camera) return '';
  const out = [];
  scene.traverseVisible((o) => { if (o.isLight && o.layers.test(camera.layers)) out.push(`${o.type}${o.castShadow ? '*' : ''}`); });
  return out.sort().join(',');
}
const keyOf = (tSig, lSig) => `${tSig}#${lSig}`;

// ---------------------------------------------------------------- meshes three hasn't compiled yet

/** The layer no camera draws: a mesh waits on it while its pipelines build (guardMeshes). */
export const PENDING_LAYER = 31;
/** An object's layers.mask while it waits there (three keeps masks unsigned). */
export const PENDING_MASK = (1 << PENDING_LAYER) >>> 0;
const preparedWith = new WeakMap();   // mesh → { material, key }: what it was compiled with, for which target and lights
const waiting = new WeakMap();        // mesh → the layers it goes back to
/**
 * Catches the meshes under `root` that `camera` would draw and three hasn't
 * compiled (a module that added a mesh without prepareMesh, or swapped its
 * material, or a lit one after a light came or went): each waits on
 * PENDING_LAYER while prepareMesh builds its
 * pipelines, then goes back to its layers, so three never builds a pipeline
 * synchronously at a first draw (F8). A frame or two without the mesh is the
 * cost, against a hitch of up to a second for a cold pipeline. Objects for
 * which skip(o) is true are left alone with everything under them.
 * @param {object} root
 * @param {object} camera
 * @param {{ target?: object, scene?: object, skip?: (o: object) => boolean, onReady?: () => void, onPending?: (work: Promise<void>) => void }} [opts]
 *   target and scene: what the meshes are drawn into and lit by (prepareMesh's)
 * @returns {number} how many meshes wait
 */
const guardCompilations = new WeakMap();
export function guardMeshes(root, camera, { target, scene, skip, onReady, onPending } = {}) {
  if (!meshGpu?.three) return 0;
  let n = 0;
  const tSig = targetSig(target ?? meshGpu.three.defaults.target);
  const lSig = lightsSig(scene ?? meshGpu.three.defaults.scene, camera);
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o.visible || skip?.(o)) continue;
    for (const c of o.children) stack.push(c);
    if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) continue;
    if (waiting.has(o)) {
      n++;
      const record = guardCompilations.get(o);
      if (record && onPending) { record.strict = true; onPending(record.work); }
      continue;
    }
    if (!o.layers.test(camera.layers)) continue;
    const was = preparedWith.get(o);
    if (was && was.material === o.material && was.key === keyOf(tSig, lSig)) continue;
    waiting.set(o, o.layers.mask);
    n++;
    // Policy belongs to the pending record, not the initiating closure: a
    // later WORLD subscriber must upgrade a default-started compilation.
    const record = { strict: Boolean(onPending), work: null };
    const work=prepareMesh(o, { camera, target, scene, alone: true, rejectOnFailure:true }).then(() => {
      // (a module that moved it to another layer meanwhile keeps its own)
      if (o.layers.mask === PENDING_MASK) o.layers.mask = waiting.get(o);
      waiting.delete(o);
      guardCompilations.delete(o);
      onReady?.();
    },error=>{
      if(!record.strict){
        if(o.layers.mask===PENDING_MASK)o.layers.mask=waiting.get(o);
        waiting.delete(o);guardCompilations.delete(o);onReady?.();
      }
      throw error;
    });
    record.work = work;
    guardCompilations.set(o,record);
    work.catch(() => {}); // failure remains parked and fail-closed
    onPending?.(work);
    o.layers.set(PENDING_LAYER);
  }
  return n;
}
