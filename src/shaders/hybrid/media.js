// Deterministic reduced-resolution participating media; no temporal history.
import { uniformStruct, Header } from '../../gpu/params.js';
import { FIELD_BOUNDS_STRUCT } from './fieldBounds.js';
import { fullscreenVert } from '../../gpu/wgsl.js';
import { frameBindings } from '../bindings.js';
import { MEDIA, MEDIA_FLOOR, HEAT_RANGE, MEDIA_NOISE_CELLS } from '../../gfx/materials.js';
import { INCAND, INCAND_KNOTS } from '../../gfx/incandescence.js';
import { skyGLSL, skyViewGLSL } from '../../gfx/sky.js';
import { farAirWGSL } from '../farShared.js';
import { SH_Y0, SKYVIS_OPEN_DC, GI_OFFSET_CELLS } from '../gfx/lighting.js';

export const HybridMediaParams = uniformStruct('HybridMediaParams', {
  clipToGrid: 'mat4x4f', grid: 'vec3f', step: 'f32', size: 'vec2f', lowSize: 'vec2f',
  enabled: 'u32', maxSteps: 'u32', hasLight: 'u32', hasGI: 'u32', depthTolerance: 'f32', hasOptics: 'u32',
});

// Group 0 is the existing FRAME ABI, group 3 the engine's params ABI.
export const MEDIA_FIELD_LAYOUT = [
  ...[0, 1, 2, 3].map((binding) => ({ binding, texture: { sampleType: 'float', viewDimension: '3d' } })),
  { binding: 4, sampler: { type: 'filtering' } },
  { binding: 5, sampler: { type: 'filtering' } },
  { binding: 6, buffer: { type: 'read-only-storage' } },
];
export const MEDIA_DEPTH_LAYOUT = [
  { binding: 0, texture: { sampleType: 'depth', viewDimension: '2d' } },
  { binding: 4, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
];
export const MEDIA_COMPOSITE_LAYOUT = [
  ...MEDIA_DEPTH_LAYOUT,
  ...[1, 2].map((binding) => ({ binding, texture: { sampleType: 'float', viewDimension: '2d' } })),
  { binding: 3, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
];
const vec = (a) => `vec3f(${a.map((x) => Number(x).toFixed(8)).join(', ')})`;

const segmentLibrary = ({ sunVisibility = 'hybridMediaOpaqueVisibility', sunWGSL = 'fn hybridMediaOpaqueVisibility(p: vec3f) -> f32 { return 1.0; }' } = {}) => /* wgsl */ `
${sunWGSL}
${frameBindings()}
${Header.wgsl}
@group(3) @binding(0) var<uniform> H: Header;
${HybridMediaParams.wgsl}
@group(3) @binding(1) var<uniform> P: HybridMediaParams;
@group(1) @binding(0) var fieldMedia: texture_3d<f32>;
@group(1) @binding(1) var glow: texture_3d<f32>;
@group(1) @binding(2) var giDC: texture_3d<f32>;
@group(1) @binding(3) var noise: texture_3d<f32>;
@group(1) @binding(4) var linearClamp: sampler;
@group(1) @binding(5) var linearRepeat: sampler;
${FIELD_BOUNDS_STRUCT}
@group(1) @binding(6) var<storage, read> mediaBounds: FieldBounds;
const EXT: vec3f = ${vec(MEDIA.slice(0, 3).map((m) => m.ext))};
const ALBEDO: vec3f = ${vec(MEDIA.slice(0, 3).map((m) => m.albedo))};
const ANISO: vec3f = ${vec(MEDIA.slice(0, 3).map((m) => m.g))};
const FLOOR: f32 = ${MEDIA_FLOOR};
const SKY: f32 = 1e20;
const BB: array<vec3f, ${INCAND.N}> = array<vec3f, ${INCAND.N}>(${INCAND_KNOTS().map((c) => vec(c.slice(0, 3))).join(',')});
fn blackbody(tC: f32) -> vec3f {
  let x = clamp((tC - ${INCAND.T0.toFixed(1)}) / ${INCAND.STEP.toFixed(1)}, 0.0, ${Number(INCAND.N - 1).toFixed(1)});
  let i = min(u32(x), ${INCAND.N - 2}u);
  return mix(BB[i], BB[i + 1u], x - f32(i));
}
struct Ray { origin: vec3f, dir: vec3f, limit: f32 }
// Explicit parallel-axis handling: neither 0 * infinity nor NaNs on box faces.
fn rayBounds(ray: Ray) -> vec2f {
  if (mediaBounds.count == 0u) { return vec2f(0.0); }
  let boxLo = vec3f(mediaBounds.lo);
  let boxHi = min(P.grid, vec3f(mediaBounds.hi));
  var lo = 0.0;
  var hi = ray.limit;
  for (var a = 0u; a < 3u; a++) {
    if (abs(ray.dir[a]) < 1e-8) {
      if (ray.origin[a] < boxLo[a] || ray.origin[a] > boxHi[a]) { return vec2f(0.0); }
    } else {
      let x = (boxLo[a] - ray.origin[a]) / ray.dir[a];
      let y = (boxHi[a] - ray.origin[a]) / ray.dir[a];
      lo = max(lo, min(x, y)); hi = min(hi, max(x, y));
    }
  }
  return vec2f(lo, max(lo, hi));
}
fn field(p: vec3f) -> vec4f {
  return textureSampleLevel(fieldMedia, linearClamp, clamp(p, vec3f(0.5), P.grid - 0.5) / P.grid, 0.0);
}
fn base(m: vec4f) -> vec3f { return max(m.xyz - FLOOR, vec3f(0.0)) / (1.0 - FLOOR); }
fn detailNoise(p: vec3f, rise: f32, stretch: f32, scale: f32) -> vec4f {
  var q = p + vec3f(H.origin);
  let clock = FU.simClock * rise;
  q.y = (q.y - (clock - floor(clock / (${MEDIA_NOISE_CELLS.toFixed(1)} * stretch)) * (${MEDIA_NOISE_CELLS.toFixed(1)} * stretch))) / stretch;
  return textureSampleLevel(noise, linearRepeat, q * (scale / ${MEDIA_NOISE_CELLS.toFixed(1)}), 0.0);
}
struct Gas { sigma: vec3f, m: vec4f, flicker: f32 }
fn density(p: vec3f) -> Gas {
  var m = field(p);
  if (max(m.x, max(m.y, m.z)) <= FLOOR) { return Gas(vec3f(0.0), m, 0.5); }
  let n = detailNoise(p, 0.0625, 1.0, 1.0);
  // Clamp warp to the volume: media never extends beyond its physical bounds.
  m = field(clamp(p + 0.8 * (2.0 * n.gba - 1.0), vec3f(0.0), P.grid));
  var d = base(m);
  let dense = smoothstep(vec2f(0.0), vec2f(0.15), d.xy);
  let wisp = 2.0 * n.g - 1.0;
  let billow = mix(vec2f(wisp), vec2f(2.0 * n.r - 1.0 + 0.45 * wisp), dense);
  d = vec3f(d.xy * smoothstep(vec2f(0.0), vec2f(0.1), d.xy) * max(1.0 + mix(vec2f(0.9), vec2f(0.3), dense) * billow, vec2f(0.0)), d.z);
  let flame = detailNoise(p, 0.25, 2.0, 2.0);
  let v = d.z * (1.0 + 0.7 * (2.0 * flame.b - 1.0)) + 0.2 * (flame.b - 0.5);
  d.z = smoothstep(0.06, 0.14, v) * (1.0 + 0.6 * (3.0 * pow(1.0 - abs(2.0 * flame.g - 1.0), 2.0) - 1.0));
  return Gas(EXT * d, m, flame.a);
}
fn hg(mu: f32, g: f32) -> f32 {
  return (1.0 - g * g) / (12.5663706 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
}
fn phase(mu: f32, g: f32) -> f32 { return mix(hg(mu, -0.3 * g), hg(mu, g), 0.8); }
fn source(p: vec3f, ray: Ray, gas: Gas) -> vec3f {
  let sigS = gas.sigma.xy * ALBEDO.xy;
  let scatter = sigS.x + sigS.y;
  var S = vec3f(0.0);
  if (scatter > 1e-6) {
    let g = dot(sigS, ANISO.xy) / scatter;
    // L0 of existing SH is the spherical average: appropriate for isotropic ambient scattering.
    var ambient = 0.5 * (FU.skyUp + FU.ground) + FU.caveAmbient;
    if (P.hasGI != 0u && FU.nearGI != 0u) {
      ambient = max(textureSampleLevel(giDC, linearClamp, p / P.grid, 0.0).rgb * 0.282095, vec3f(0.0)) + FU.caveAmbient;
    }
    if (P.hasLight != 0u && FU.glowLights != 0u) {
      ambient += textureSampleLevel(glow, linearClamp, p / P.grid, 0.0).rgb * FU.lightGain;
    }
    // Short deterministic self-shadow multiplied by the optional opaque receiver.
    let ahead = clamp(p + FU.sun * 2.0, vec3f(0.0), P.grid);
    let sunT = exp(-dot(EXT, base(field(ahead))) * 4.0);
    S = scatter * (ambient + 3.14159265 * FU.sunCol * phase(dot(ray.dir, FU.sun), g) * sunT * clamp(${sunVisibility}(p), 0.0, 1.0));
    for (var i = 0; i < FU.lampCount; i++) {
      let axis = FU.lampPos[i].xyz;
      let v = p - axis;
      let end = axis + FU.lampShape[i].y * vec3f(0.0, 1.0, 0.0);
      // Conservative point fallback for lamps: finite, reach-windowed, no geometry shadow.
      let d2 = min(dot(v, v), dot(p - end, p - end));
      let reach = FU.lampPos[i].w;
      if (reach > 0.0 && d2 < reach * reach) {
        let fall = pow(1.0 - d2 / (reach * reach), 2.0) / max(d2, 1.0);
        S += scatter * FU.lampCol[i].rgb * fall * 3.14159265 * phase(dot(ray.dir, normalize(axis - p + vec3f(1e-6))), g);
      }
    }
  }
  if (gas.sigma.z > 0.0 && gas.m.z > 0.02) {
    // Same field packing/prior and soot heating as the current volume renderer (degrees C).
    let core = smoothstep(0.1, 0.25, gas.m.z);
    let tGas = (gas.m.w * ${HEAT_RANGE.toFixed(1)} + 0.15 * (800.0 - 22.0)) / (gas.m.z + 0.15);
    let tC = 22.0 + (tGas + 1000.0 * core) * (1.0 + 0.08 * (2.0 * gas.flicker - 1.0));
    S += gas.sigma.z * 3.0 * blackbody(tC) * pow((tC + 273.15) / 1273.15, 4.0);
  }
  return S;
}
fn integrate(ray: Ray) -> vec4f {
  if (P.enabled == 0u) { return vec4f(0.0); }
  let bounds = rayBounds(ray);
  let span = bounds.y - bounds.x;
  if (span <= 0.0) { return vec4f(0.0); }
  // Cap work, not the ray: coarsen the entire interval instead of dropping its tail.
  let count = min(P.maxSteps, max(1u, u32(ceil(span / P.step))));
  let dt = span / f32(count);
  var T = 1.0;
  var L = vec3f(0.0);
  for (var i = 0u; i < count; i++) {
    let p = ray.origin + ray.dir * (bounds.x + (f32(i) + 0.5) * dt);
    let gas = density(p);
    let sigma = dot(gas.sigma, vec3f(1.0));
    if (sigma <= 1e-7) { continue; }
    let attenuation = exp(-sigma * dt);
    L += T * source(p, ray, gas) * ((1.0 - attenuation) / sigma);
    T *= attenuation;
  }
  return vec4f(L, 1.0 - T);
}
// Public segment API: rd must be unit length; t values are grid-cell distances.
fn hybridMediaSegment(ro: vec3f, rd: vec3f, tNear: f32, tFar: f32) -> vec4f {
  let start = max(0.0, tNear);
  return integrate(Ray(ro + rd * start, rd, max(0.0, tFar - start)));
}
`;

const screenLibrary = () => /* wgsl */ `
@group(2) @binding(0) var sceneDepth: texture_depth_2d;
@group(2) @binding(4) var opticalDepth: texture_2d<f32>;
fn gridPoint(uv: vec2f, z: f32) -> vec3f {
  let h = P.clipToGrid * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return h.xyz / h.w;
}
fn rayAt(pixel: vec2i) -> Ray {
  let uv = (vec2f(pixel) + 0.5) / P.size;
  let near = gridPoint(uv, 0.0);
  let dir = normalize(gridPoint(uv, 0.999999) - near);
  var z = textureLoad(sceneDepth, pixel, 0);
  if (P.hasOptics != 0u) { z = min(z, textureLoad(opticalDepth, pixel, 0).x); }
  var limit = SKY;
  if (z < 1.0) { limit = max(0.0, dot(gridPoint(uv, z) - near, dir)); }
  return Ray(near, dir, limit);
}
fn edgeWeight(a: f32, b: f32) -> f32 {
  if (a > SKY * 0.5 || b > SKY * 0.5) { return select(0.0, 1.0, a > SKY * 0.5 && b > SKY * 0.5); }
  let tolerance = max(P.depthTolerance, 0.01 * min(a, b));
  let delta = abs(a - b) / tolerance;
  if (delta > 1.0) { return 0.0; }
  return exp(-4.0 * delta * delta);
}
${fullscreenVert()}
`;

// Keep all private symbols isolated when optics includes the same segment model.
const privateNames = ['Header', 'H', 'P', 'EXT', 'ALBEDO', 'ANISO', 'FLOOR', 'SKY', 'BB', 'Ray', 'Gas',
  'blackbody', 'rayBounds', 'field', 'base', 'detailNoise', 'density', 'hg', 'phase', 'source', 'integrate',
  'FieldBounds', 'mediaBounds', 'fieldMedia', 'glow', 'giDC', 'noise', 'linearClamp', 'linearRepeat'];
const isolate = (code) => code.replace(new RegExp(`\\b(${privateNames.join('|')})\\b`, 'g'), (name) => `hm${name}`);

/**
 * Reusable fragment/compute segment integrator (same implementation as the screen pass).
 * Bindings: FRAME's FU; fields group bindings 0 media, 1 glow, 2 GI DC,
 * 3 shared media noise, 4 clamp sampler, 5 repeat sampler, 6 read-only bounds storage; params/header use
 * HybridMediaParams/Header. Set declareFrame:false if FU is already declared.
 * fieldBinding offsets all seven field/sampler/bounds bindings. declareHeader:false uses
 * the containing shader's headerName (default H), avoiding duplicate Header/H
 * declarations when composed with the optical prelude. Params stay explicit.
 * No scene textures, depth attachment, or stochastic history required. Optional sunWGSL/sunVisibility supplies opaque visibility; no beam lights; segment callers must bound at surfaces/interfaces.
 */
export function hybridMediaSegmentWGSL({ frameGroup = 0, frameBinding = 1, fieldGroup = 1, fieldBinding = 0,
  paramsGroup = 3, paramsBinding = 1, headerBinding = 0, declareFrame = true, declareHeader = true, headerName = 'H', sunVisibility, sunWGSL } = {}) {
  let code = segmentLibrary({ sunVisibility, sunWGSL });
  const frame = frameBindings();
  code = code.replace(frame, declareFrame ? frame.replace('@group(0) @binding(1)', `@group(${frameGroup}) @binding(${frameBinding})`) : '');
  if (!declareHeader) code = code.replace(Header.wgsl, '').replace('@group(3) @binding(0) var<uniform> H: Header;', '');
  code = code.replace(/@group\(1\) @binding\((\d+)\)/g, (_, b) => `@group(${fieldGroup}) @binding(${fieldBinding + Number(b)})`)
    .replace('@group(3) @binding(0)', `@group(${paramsGroup}) @binding(${headerBinding})`)
    .replace('@group(3) @binding(1)', `@group(${paramsGroup}) @binding(${paramsBinding})`);
  code = isolate(code);
  return declareHeader ? code : code.replace(/\bhmH\b/g, headerName);
}

export const hybridMediaIntegrateWGSL = (options) => isolate(/* wgsl */ `
${segmentLibrary(options)}
${screenLibrary()}
struct MediaOutput { @location(0) media: vec4f, @location(1) guide: f32 }
@fragment fn fs(in: FullScreen) -> MediaOutput {
  let pixel = clamp(vec2i(in.uv * P.size), vec2i(0), vec2i(P.size) - 1);
  let ray = rayAt(pixel);
  return MediaOutput(integrate(ray), ray.limit);
}`);

export const hybridMediaCompositeWGSL = (options) => isolate(/* wgsl */ `
${segmentLibrary(options)}
${screenLibrary()}
@group(2) @binding(1) var sceneColor: texture_2d<f32>;
@group(2) @binding(2) var lowMedia: texture_2d<f32>;
@group(2) @binding(3) var lowGuide: texture_2d<f32>;
// The air between the eye and the scene behind the media, as the volume's
// haze on every map (shaders/farShared.js volumeHaze): FAR_HAZE's extinction
// and the sky's light on the air, by the air's sky share at the ray's two ends
// (the far one GI_OFFSET back out of what it hit), from the GI's band 0 as
// lighting.js giAirSkyVis reads it; without GI, or past the grid, open.
const PI_L: f32 = 3.14159265;
${skyGLSL()}
${skyViewGLSL()}
${farAirWGSL}
const HAZE_SH_Y0: f32 = ${SH_Y0.toFixed(6)};
const HAZE_OPEN_DC: f32 = ${SKYVIS_OPEN_DC.toFixed(6)};
const HAZE_GI_OFFSET: f32 = ${GI_OFFSET_CELLS.toFixed(1)};
fn hazeAirSky(p: vec3f) -> f32 {
  var s = 1.0;
  if (P.hasGI != 0u && all(p >= vec3f(0.0)) && all(p <= P.grid)) {
    s = clamp(HAZE_SH_Y0 * textureSampleLevel(giDC, linearClamp, p / P.grid, 0.0).a / HAZE_OPEN_DC, 0.0, 1.0);
  }
  return s;
}
fn hazeScene(col: vec3f, ray: Ray) -> vec3f {
  let lit = 0.5 * (hazeAirSky(ray.origin) + hazeAirSky(ray.origin + ray.dir * max(ray.limit - HAZE_GI_OFFSET, 0.0)));
  return farHazeAir(col, ray.dir, ray.limit, lit);
}
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let ray = rayAt(pixel);
  let q = in.uv * P.lowSize - 0.5;
  let basePixel = vec2i(floor(q));
  let f = fract(q);
  var sum = vec4f(0.0);
  var weights = 0.0;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let tap = clamp(basePixel + vec2i(x, y), vec2i(0), vec2i(P.lowSize) - 1);
    let w = select(1.0 - f.x, f.x, x == 1) * select(1.0 - f.y, f.y, y == 1)
      * edgeWeight(ray.limit, textureLoad(lowGuide, tap, 0).x);
    sum += textureLoad(lowMedia, tap, 0) * w; weights += w;
  }}
  var media = vec4f(0.0);
  if (weights > 1e-5) { media = sum / weights; }
  else { media = integrate(ray); } // Thin foreground/background edges never turn into depth holes.
  var behind = textureLoad(sceneColor, pixel, 0);
  if (ray.limit < SKY * 0.5) { behind = vec4f(hazeScene(behind.rgb, ray), behind.a); }   // the sky itself is the air's light already
  return media + behind * (1.0 - media.a); // premultiplied linear HDR, including coverage alpha
}`);
