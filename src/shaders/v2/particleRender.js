import { ELEMENTS, K, R } from '../../elements.js';
import { LOOK, MEDIA } from '../../gfx/materials.js';
import { INCAND_KNOTS, incandescenceGLSL } from '../../gfx/incandescence.js';
import { PHASE_ROWS, PHASE_NORMAL_MAX, PHASE_COLD_BASE } from '../../v2/phase.js';
import { frameBindings, RENDER_LAYOUT } from '../bindings.js';
import { STAGE } from '../common.js';
import { uniformStruct } from '../../gpu/params.js';
import { RAY_LOOK } from '../rays.js';
import { RAYS } from '../../rays.js';
import { DECO_SIGMA } from '../gfx/deco.js';
import { SUPER, BRICK } from '../common.js';
import { particleViewsWGSL } from './particleViews.js';
import { cloudDeckGLSL } from '../gfx/clouds.js';
import { VIEWS } from '../../views.js';
import { SH_Y0, SH_Y1, GI_OFFSET_CELLS, SHADOW_TINT_ID_SCALE, SHADOW_PAD } from '../gfx/lighting.js';

export const PARTICLE_BYTES = 48;
export const PARTICLE_WORDS = 12;
// deco: draw each particle's decoration (src/deco.js decoShown: painted, display on)
// grid: the window's cells (xyz) and whether its coarse air is bound (w: group 2, the
// Pressure view's paint and the pick's P); supers: its supertiles along x and z (the
// brick numbering, shaders/common.js brickId), for the particle's brick's air
// lag: how far behind its record a particle is drawn, cells per m/s of its velocity (the seconds
// behind over CELL_M: gfx/nativeParticles.js nativeParticleView, v2/host.js particleLagSeconds)
export const NativeParticleParams = uniformStruct('NativeParticleParams', {
  inverseModel: 'mat4x4f', origin: 'vec3f', scale: 'f32', eye: 'vec3f', sample: 'u32',
  viewport: 'vec2f', capacity: 'u32', deco: 'u32', grid: 'vec4u', supers: 'vec4u', lag: 'f32',
  // light: 1 when the Box volume's sun map, GI probes and noise are bound (NATIVE_PARTICLE_LIGHT_LAYOUT)
  light: 'u32',
});
const ro = (binding, visibility) => ({ binding, visibility, buffer: { type: 'read-only-storage' } });
// 1: each pool slot's decoration, RGBA8 (src/v2/physics.js particleDecoRange)
export const NATIVE_PARTICLE_LAYOUT = [ro(0, STAGE.VERTEX), ro(1, STAGE.VERTEX)];
// group 2: V2's coarse air (two vec4f a brick, v2/dynamics.js air[airIndex]): the brick's
// pressure the Pressure view paints a particle with (render.js marchPressure's Pf)
export const NATIVE_PARTICLE_AIR_LAYOUT = [ro(0, STAGE.FRAGMENT | STAGE.COMPUTE)];
// The matter draw's group 2: the air, and the light V1's flying cells take in the volume (shaders/gfx/lighting.js):
// the sun's map (rgba32float, textureLoad), the GI probes' four bands, the media noise (the clouds' shadow), samplers
const tex = (binding, sampleType, viewDimension) => ({ binding, visibility: STAGE.FRAGMENT, texture: { sampleType, viewDimension } });
const smp = binding => ({ binding, visibility: STAGE.FRAGMENT, sampler: { type: 'filtering' } });
export const NATIVE_PARTICLE_LIGHT_LAYOUT = [ro(0, STAGE.FRAGMENT | STAGE.COMPUTE), tex(1, 'unfilterable-float', '2d'),
  tex(2, 'float', '3d'), tex(3, 'float', '3d'), tex(4, 'float', '3d'), tex(5, 'float', '3d'), tex(6, 'float', '3d'), smp(7), smp(8)];
export const NATIVE_PARTICLE_ARGS_LAYOUT = [ro(0, STAGE.COMPUTE),
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
export const nativeParticleArgsWGSL = () => `
${NativeParticleParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativeParticleParams;
@group(0) @binding(0) var<storage, read> control: array<u32>;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1) fn main() {
  args[0] = 6u; args[1] = select(0u, P.capacity, control[0] > 0u); args[2] = 0u; args[3] = 0u;
}`;
const f = n => Number.isInteger(n) ? `${n}.0` : String(n);
const v = a => `vec${a.length}f(${a.map(f).join(',')})`;
const table = (name, type, rows) => `const ${name} = array<${type}, ${rows.length}>(${rows.join(',')});`;
const tables = [
  table('LOOK_ALBEDO', 'vec4f', LOOK.map(l => v([...l.alb, l.rough]))),
  table('LOOK_EMIT', 'vec4f', LOOK.map(l => v([...l.emit, l.metal]))),
  table('LOOK_OPTICS', 'vec4f', ELEMENTS.map(e => {
    const l = LOOK[e.id], medium = MEDIA[l.media];
    return v(medium ? [...Array(3).fill(medium.ext*l.haze),1] : [...e.sigma,l.ior]);
  })),
  table('LOOK_SCATTER', 'vec3f', LOOK.map(l => v(MEDIA[l.media] ? l.alb.map(c => c*MEDIA[l.media].albedo) : l.scatAlb))),
  table('LOOK_CLASS', 'vec2u', ELEMENTS.map(e => `vec2u(${e.kind}u,${e.render}u)`)),
  table('PHASE_TQ', 'vec2u', PHASE_ROWS.map(r => `vec2u(${r.hotQ}u,${r.coldQ}u)`)),
  table('PARTICLE_INCAND', 'vec4f', INCAND_KNOTS().map(v)),
].join('\n');

// The particle's brick's coarse air (shaders/common.js brickId and fetchBs: two vec4f a
// brick, velocity m/s and pressure Pa), in V1's units: cells per V1 step, V1 pressure.
// Shared by the draw (the Pressure view) and the pick (its P).
export const particleAirWGSL = /* wgsl */ `
@group(2) @binding(0) var<storage, read> particleAir: array<vec4f>;
const PARTICLE_SUPER: vec3i = vec3i(${SUPER.x}, ${SUPER.y}, ${SUPER.z});
fn particleAirAt(p: vec3f) -> vec4f {
  if (P.grid.w == 0u) { return vec4f(0.0); }
  let c = clamp(vec3i(floor(p)), vec3i(0), vec3i(P.grid.xyz) - 1);
  let b = c / ${BRICK};
  let s = b / PARTICLE_SUPER;
  let k = b - s * PARTICLE_SUPER;
  let st = s.x + i32(P.supers.x) * (s.z + i32(P.supers.y) * s.y);
  let air = particleAir[u32(st * ${SUPER.x * SUPER.y * SUPER.z} + k.x + ${SUPER.x} * (k.z + ${SUPER.z} * k.y)) * 2u];
  return vec4f(air.xyz / V1_CELLS_PER_STEP_MS, air.w / LEGACY_PRESSURE_PA);
}
// Where the ray (grid cells) enters the box, 0 from inside (the data views' t0).
fn gridEntry(ro: vec3f, rd: vec3f) -> f32 {
  let inv = 1.0 / select(rd, vec3f(1e-20), abs(rd) < vec3f(1e-20));
  let a = (vec3f(0.0) - ro) * inv;
  let b = (vec3f(P.grid.xyz) - ro) * inv;
  let lo = min(a, b);
  return max(max(lo.x, max(lo.y, lo.z)), 0.0);
}
// compact.js compactA's life and seed for a particle's core (a liquid's life is its
// payload's unless it conducts; liquids keep no seed: the particle's id stands in)
fn particleLife(id: u32, core: vec4u) -> f32 {
  if (LOOK_CLASS[id].x == ${K.LIQUID}u) { return select(f32(core.w >> 16u) / VIEW_LIFE_SCALE[id], 0.0, VIEW_CONDUCTS[id]); }
  return f32(core.y & 65535u) / VIEW_LIFE_SCALE[id];
}
fn particleSeed(id: u32, core: vec4u, stableId: u32) -> f32 {
  if (LOOK_CLASS[id].x == ${K.LIQUID}u) { return f32(coverageHash(stableId) >> 16u) / 65536.0; }
  return f32(core.w >> 16u) / 65536.0;
}`;

// The light V1's flying cell takes in the volume, on a packet's sphere (Box): lighting.js hitLight, the one model
// for a surface seen second-hand (sunShadowAt's map with the clouds' shadow, giIrradiance of the probe GI_OFFSET out
// along the normal), with sunMapShadow's surface bias on the map. Not a deviation: the volume's light, read by
// another drawer (gfx/meshLight.js reads it the same way for the figures). P.light 0 (World, a box without its map
// bound yet): the sky's open light, as before.
const particleLightWGSL = /* wgsl */ `
@group(2) @binding(1) var particleShadow: texture_2d<f32>;
@group(2) @binding(2) var particleGI0: texture_3d<f32>;
@group(2) @binding(3) var particleGI1: texture_3d<f32>;
@group(2) @binding(4) var particleGI2: texture_3d<f32>;
@group(2) @binding(5) var particleGI3: texture_3d<f32>;
@group(2) @binding(6) var tMediaNoise: texture_3d<f32>;
@group(2) @binding(7) var linearClamp: sampler;
@group(2) @binding(8) var linearRepeat: sampler;
const PARTICLE_SIGMA = array<vec3f, ${ELEMENTS.length}>(${ELEMENTS.map(e => v(e.sigma ?? [0, 0, 0])).join(',')});
const SHADOW_TINT_ID_SCALE: f32 = ${f(SHADOW_TINT_ID_SCALE)};
const SHADOW_PAD: f32 = ${f(SHADOW_PAD)};
const SHADOW_NORMAL_OFFSET: f32 = 0.002;   // lighting.js sunMapShadow's
const SHADOW_BIAS_MIN: f32 = 0.8;
const SHADOW_BIAS_NS_MIN: f32 = 0.25;
const SHADOW_BIAS_PAD: f32 = 0.1;
const SH_Y0: f32 = ${SH_Y0};
const SH_Y1: f32 = ${SH_Y1};
const SH_COS1: f32 = 2.0 / 3.0;
const GI_OFFSET: f32 = ${f(GI_OFFSET_CELLS)};
// the views that trace and read the map (src/views.js shadows; shaders/render.js viewShadows), by FU.view
const PARTICLE_VIEW_SHADOWS = array<u32, ${Math.max(...VIEWS.map(v => v.id)) + 1}>(${Array.from({ length: Math.max(...VIEWS.map(v => v.id)) + 1 }, (_, i) => VIEWS.find(v => v.id === i)?.shadows ? '1u' : '0u').join(',')});
const PARTICLE_BRICK: f32 = ${f(BRICK)};
${cloudDeckGLSL}
// lighting.js shadowTexelAtt: the map texel's tint at depth d
fn particleTexelAtt(sm: vec4f, d: f32) -> vec3f {
  let tid = i32(sm.w / SHADOW_TINT_ID_SCALE);
  if (tid <= 0 || tid >= ${ELEMENTS.length} || d <= sm.y) { return vec3f(1.0); }
  let tau = sm.w - f32(tid) * SHADOW_TINT_ID_SCALE;
  let frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
  let sigma = PARTICLE_SIGMA[tid];
  return exp(-sigma / max(dot(sigma, vec3f(1.0 / 3.0)), 1e-4) * tau * frac);
}
// lighting.js sunShadow at grid point hp of a surface with normal n (grid space): the clouds' shadow, then the
// map's four taps (sunBasis with the window's origin, shadowProject, sunMapShadow's bias)
fn particleSun(hp: vec3f, n: vec3f) -> vec3f {
  if (P.light == 0u || FU.shadows == 0u || u32(FU.view) >= ${Math.max(...VIEWS.map(v => v.id)) + 1}u || PARTICLE_VIEW_SHADOWS[u32(FU.view)] == 0u) { return vec3f(1.0); }
  let cloud = cloudShadow(hp + P.origin);
  if (cloud <= CLOUD_SHADOW_SKIP) { return vec3f(0.0); }
  let grid = vec3f(P.grid.xyz);
  var c = grid * 0.5;
  let R = 0.5 * length(grid) + SHADOW_PAD;
  let u = normalize(cross(vec3f(0.0, 1.0, 0.0), FU.sun));
  let v = cross(FU.sun, u);
  let res = max(FU.shadowRes, 1);
  let T = 2.0 * R / f32(res);
  let ot = vec2f(dot(P.origin, u), dot(P.origin, v)) / T;
  let snap = (round(ot) - ot) * T;
  c += snap.x * u + snap.y * v;
  let q = hp + n * SHADOW_NORMAL_OFFSET - c;
  let st = vec2f(dot(q, u), dot(q, v)) / R * 0.5 + 0.5;
  let d = R - dot(q, FU.sun);
  let fx = st * f32(res) - 0.5;
  let i0 = vec2i(floor(fx)); let w = fx - vec2f(i0);
  let bias = max(SHADOW_BIAS_MIN, T * (abs(dot(n, u)) + abs(dot(n, v))) / max(dot(n, FU.sun), SHADOW_BIAS_NS_MIN) + SHADOW_BIAS_PAD);
  var acc = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1u);
    let sm = textureLoad(particleShadow, clamp(i0 + o, vec2i(0), vec2i(res - 1)), 0);
    let wk = select(1.0 - w.x, w.x, o.x == 1) * select(1.0 - w.y, w.y, o.y == 1);
    acc += select(0.0, 1.0, d < sm.x + bias) * particleTexelAtt(sm, d) * wk;
  }
  return cloud * acc;
}
// lighting.js probeTex, probeAt and giIrradiance (with the scene's cave ambient): the irradiance / pi on a surface
// at p facing n, from the probe GI_OFFSET out along it
fn particleProbe(t: texture_3d<f32>, p: vec3f) -> vec4f {
  let B = ceil(vec3f(P.grid.xyz) / PARTICLE_BRICK);
  let q = clamp(p / PARTICLE_BRICK, vec3f(0.5), B - 0.5);
  return textureSampleLevel(t, linearClamp, q / B, 0.0);
}
fn particleGI(p: vec3f, n: vec3f) -> vec3f {
  let at = p + n * GI_OFFSET;
  let c0 = particleProbe(particleGI0, at).rgb; let cx = particleProbe(particleGI1, at).rgb;
  let cy = particleProbe(particleGI2, at).rgb; let cz = particleProbe(particleGI3, at).rgb;
  return max(SH_Y0 * c0 + SH_COS1 * SH_Y1 * (cx * n.x + cy * n.y + cz * n.z), vec3f(0.0)) + FU.caveAmbient;
}`;

// A data view's or Plain's particle (particleViews.js): the cube of its volume, as those
// views draw a cell, coloured as they colour a lone cell of its element.
const blockyFragmentWGSL = /* wgsl */ `
fn blockyFragment(o: Out, eye: vec3f, direction: vec3f) -> Surface {
  let inv = 1.0 / select(direction, vec3f(1e-20), abs(direction) < vec3f(1e-20));
  let ta = (o.center - vec3f(o.half) - eye) * inv;
  let tb = (o.center + vec3f(o.half) - eye) * inv;
  let lo = min(ta, tb);
  let hi = max(ta, tb);
  let tn = max(lo.x, max(lo.y, lo.z));
  let tf = min(hi.x, min(hi.y, hi.z));
  if (tf <= max(tn, 0.0)) { discard; }
  var axis = 0;
  if (lo.y >= lo.x && lo.y >= lo.z) { axis = 1; } else if (lo.z >= lo.x && lo.z >= lo.y) { axis = 2; }
  var t = tn;
  var sgn = -sign(direction[axis]);
  var hit = eye + direction * t;
  var hitClip = FU.viewProj * FU.model * vec4f(hit,1.0);
  // entry behind the eye or clipped: expose the exit face (also covers eye inside), as the sphere does
  if (t < 0.0 || hitClip.z < 0.0) {
    axis = 0;
    if (hi.y <= hi.x && hi.y <= hi.z) { axis = 1; } else if (hi.z <= hi.x && hi.z <= hi.y) { axis = 2; }
    t = tf; sgn = sign(direction[axis]);
    hit = eye + direction * t;
    hitClip = FU.viewProj * FU.model * vec4f(hit,1.0);
  }
  let depth = hitClip.z / hitClip.w;
  if (depth < 0.0 || depth > 1.0 || hitClip.w <= 0.0) { discard; }
  var n = vec3f(0.0);
  n[axis] = sgn;
  let id = o.id;
  let T = temperature(id, o.core.x);
  let seg = tf - max(tn, 0.0);
  var look: ViewLook;
  if (FU.view == VIEW_PLAIN) {
    let side = u32(axis) * 2u + select(0u, 1u, sgn > 0.0);
    let rel = (hit - o.center) / (2.0 * o.half) + 0.5;
    var uv = rel.xz;
    if (axis == 0) { uv = rel.zy; } else if (axis == 2) { uv = rel.xy; }
    look = plainLook(id, side, n, T, particleLife(id, o.core), particleSeed(id, o.core, o.stableId), o.glow, PlainFace(uv, hit));
  } else {
    let cue = 1.0 / (1.0 + XRAY_DEPTH_CUE * max(t - gridEntry(eye, direction), 0.0));
    let blob = viewBlob(eye, direction, o.center, max(tn, 0.0), tf);
    look = dataLook(FU.view, id, o.core, n, seg, blob, T, particleAirAt(o.center).w, o.vel, cue);
  }
  if (look.alpha < 1.0) {
    let pixel = vec2u(o.position.xy);
    let hash = coverageHash(o.stableId ^ coverageHash(pixel.x) ^ coverageHash(pixel.y+0x9e3779b9u) ^ coverageHash(P.sample));
    if (f32(hash >> 8u) / 16777216.0 >= look.alpha) { discard; }
  }
  var out: Surface; out.depth = depth;
  out.color = vec4f(max(vec3f(0.0), look.color), 1.0);
  return out;
}`;

// The particle's tables, temperature and coverage hash (the draw's and the pick's).
const particleCommonWGSL = () => `
${tables}
${incandescenceGLSL().replace('TB.incand[i]', 'PARTICLE_INCAND[i]')}
fn temperature(id: u32, word: u32) -> f32 {
  let raw = (word >> 8u) & 65535u;
  var tq = raw;
  if (raw > ${PHASE_NORMAL_MAX}u) { tq = select(PHASE_TQ[id].x, PHASE_TQ[id].y, raw >= ${PHASE_COLD_BASE}u); }
  return f32(tq) * 0.25 - 273.25;
}
fn coverageHash(input: u32) -> u32 {
  var x = input; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; return x ^ (x >> 16u);
}`;

// Pure presentation: never write or reorder the native physics records.
export const nativeParticleWGSL = (rays = false) => /* wgsl */ `
${frameBindings()}
${NativeParticleParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativeParticleParams;
// Three vec4u preserve the exact 48B mixed float/integer ABI (no padding).
struct Particle { positionId: vec4u, velocityCore: vec4u, payloadBank: vec4u }
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<storage, read> particleDeco: array<u32>;
// TPT's decoration over the element's colour by its alpha (src/graphics/Renderer.cpp; the volume's
// shaders/gfx/deco.js decoTint and absorbDeco, for a sphere of one albedo: no texture detail to keep)
fn decoLinear(c: vec3f) -> vec3f { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c >= vec3f(0.04045)); }
${particleCommonWGSL()}${rays ? '' : `
${particleViewsWGSL()}
${particleAirWGSL}
${particleLightWGSL}`}
struct Out {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) center: vec3f,
  @location(1) @interpolate(flat) radius: f32,
  @location(2) @interpolate(flat) id: u32,
  @location(3) @interpolate(flat) stableId: u32,
  @location(4) @interpolate(flat) glow: vec3f,
  @location(5) @interpolate(flat) paint: vec4f,${rays ? '' : `
  @location(6) @interpolate(flat) core: vec4u,     // the particle's core (v2 cell words x..w)
  @location(7) @interpolate(flat) vel: vec3f,      // velocity, cells per V1 step (the data views' B)
  @location(8) @interpolate(flat) half: f32,       // half the side of its equal-volume cube (blocky views)`}
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out; o.position = vec4f(2.0,2.0,2.0,1.0);
  let p = particles[ii]; let id = p.velocityCore.w & 255u;
  if (p.positionId.w == 0u || ${rays ? '(id != 254u && id != 255u)' : `(id == 0u || id >= ${ELEMENTS.length}u)`}) { return o; }
  o.id = id; o.stableId = p.positionId.w;
  if (P.deco != 0u && ii < arrayLength(&particleDeco)) { o.paint = unpack4x8unorm(particleDeco[ii]); }
  // Between ticks: where the record was the share of a tick before its position (Minecraft's
  // lerp(prev, pos, partialTicks), prev = pos - velocity × a tick: the tick's own step), so flying
  // matter and rays move every frame when a frame runs no tick (Speed under 1×), as V1's do a step a frame.
  o.center = bitcast<vec3f>(p.positionId.xyz) - P.origin - bitcast<vec3f>(p.velocityCore.xyz) * P.lag;
  ${rays ? `
  // Existing TPT ray-layer colours/diameter, not matter volume.
  o.radius = ${f(RAY_LOOK.POINT_CELLS / 2)};
  if (id == 254u) { o.glow = max(vec3f(0.0), bitcast<vec3f>(p.payloadBank.xyz)) * ${f(RAY_LOOK.PHOTON_GLOW)}; }
  else {
    let energy = max(bitcast<f32>(p.payloadBank.y), ${f(RAYS.NEUT_E_THERMAL)});
    let fast = clamp(log(energy / ${f(RAYS.NEUT_E_THERMAL)}) / log(${f(RAYS.NEUT_E_FAST / RAYS.NEUT_E_THERMAL)}), 0.0, 1.0);
    o.glow = ${v(RAY_LOOK.NEUT_COLOR)} * ${f(RAY_LOOK.NEUT_GLOW)} * mix(${f(RAY_LOOK.NEUT_THERMAL_GLOW)},1.0,fast);
  }` : `
  var amount = 1.0;
  if (LOOK_CLASS[id].x == ${K.LIQUID}u) { amount = f32(p.payloadBank.x & 0xffffffu) / 65536.0; }
  if (amount <= 0.0) { return o; }
  // Equal-volume sphere: 4*pi*r^3/3 = amount, not a photon-sized marker.
  o.radius = pow(amount * (3.0 / (4.0 * 3.141592653589793)), 1.0 / 3.0);
  let alb = LOOK_ALBEDO[id].rgb;
  let emissivity = 1.0 - clamp(dot(alb * LOOK_EMIT[id].w, vec3f(0.2126,0.7152,0.0722)),0.0,1.0);
  o.glow = LOOK_EMIT[id].rgb + emissivity * incandescence(temperature(id,p.velocityCore.w));
  o.core = vec4u(p.velocityCore.w, p.payloadBank.xyz);
  o.vel = bitcast<vec3f>(p.velocityCore.xyz) / V1_CELLS_PER_STEP_MS;
  // The data views and Plain draw a cell as a cube (a voxel, a block): a flying one too,
  // of equal volume; its bounding sphere sizes the quad.
  o.half = 0.5 * pow(amount, 1.0 / 3.0);
  if (blockyView(FU.view)) { o.radius = o.half * sqrt(3.0); }`}
  var k = vi; if (vi == 3u) { k = 2u; } else if (vi == 4u) { k = 1u; } else if (vi == 5u) { k = 3u; }
  let uv = vec2f(f32(k & 1u),f32(k >> 1u)) * 2.0 - 1.0;
  let centerWorld = (FU.model * vec4f(o.center,1.0)).xyz;
  let clip = FU.viewProj * vec4f(centerWorld,1.0);
  let towardEye = P.eye - centerWorld; let distance = length(towardEye);
  let bound = o.radius * P.scale;
  // Conservative screen rectangle when touching the eye/near plane. Fragment
  // ray/sphere intersection handles the inside and clips actual surface depth.
  if (clip.w <= 2.0 * bound || distance <= bound) {
    o.position = vec4f(uv,0.0,1.0); return o;
  }
  let forward = towardEye / distance;
  let axis = select(vec3f(0.0,1.0,0.0),vec3f(1.0,0.0,0.0),abs(forward.y)>0.95);
  let right = normalize(cross(axis,forward)); let up = cross(forward,right);
  let extent = bound * distance / sqrt(distance * distance - bound * bound);
  o.position = FU.viewProj * vec4f(centerWorld + (right * uv.x + up * uv.y) * extent,1.0);
  return o;
}
struct Surface { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }${rays ? '' : blockyFragmentWGSL}
@fragment fn fs(o: Out) -> Surface {
  let ndc = vec2f(o.position.x / P.viewport.x * 2.0 - 1.0, 1.0 - o.position.y / P.viewport.y * 2.0);
  let farH = FU.invViewProj * vec4f(ndc,1.0,1.0);
  let eye = (P.inverseModel * vec4f(P.eye,1.0)).xyz;
  let farPoint = (P.inverseModel * vec4f(farH.xyz / farH.w,1.0)).xyz;
  let direction = normalize(farPoint - eye);${rays ? '' : `
  if (blockyView(FU.view)) { return blockyFragment(o, eye, direction); }`}
  let oc = eye - o.center; let b = dot(oc,direction);
  let d = b*b - dot(oc,oc) + o.radius*o.radius;
  if (d <= 0.0) { discard; }
  let root = sqrt(d); var t = -b-root; if (t < 0.0) { t = -b+root; }
  if (t < 0.0) { discard; }
  var hit = eye + direction*t;
  var hitClip = FU.viewProj * FU.model * vec4f(hit,1.0);
  // If the entry surface is clipped, expose the exit (also covers eye inside).
  if (hitClip.z < 0.0) {
    t = -b+root; hit = eye + direction*t;
    hitClip = FU.viewProj * FU.model * vec4f(hit,1.0);
  }
  let depth = hitClip.z / hitClip.w;
  if (depth < 0.0 || depth > 1.0 || hitClip.w <= 0.0) { discard; }
  var out: Surface; out.depth = depth;
  ${rays ? `
  let falloff = d / (o.radius*o.radius);
  // Already weighted (premultiplied) radiance; additive ONE,ONE, preserve alpha.
  out.color = vec4f(o.glow * falloff * falloff,0.0);` : `
  let id = o.id; let optics = LOOK_OPTICS[id]; var alb = LOOK_ALBEDO[id];
  let normal = normalize((transpose(P.inverseModel) * vec4f((hit-o.center)/o.radius,0.0)).xyz);
  let view = normalize(P.eye-(FU.model*vec4f(hit,1.0)).xyz);
  let sun = normalize((FU.model * vec4f(FU.sun,0.0)).xyz);
  let halfVector = normalize(sun+view);
  var metal = LOOK_EMIT[id].w;
  var f0 = pow((optics.w-1.0)/(optics.w+1.0),2.0);
  // Noita's artwork (shaders/gfx/noita.js noitaMat, an opaque element with a look): its
  // look's colour (noitaMean: a flying cell is one Noita pixel a face, at most a few pixels
  // on screen), matte, its lit top and darker underside. Cozy's patterns are the realistic
  // albedo times metre-scale strokes (gfx/cozy.js): on a one-cell particle they average to
  // the realistic look, which is what it keeps (same look, not a deviation).
  if (FU.materialStyle == NOITA_STYLE && LOOK_CLASS[id].y == ${R.OPAQUE}u && VIEW_NOITA[id].w > 0.0) {
    let ny = (hit.y - o.center.y) / o.radius;
    alb = vec4f(VIEW_NOITA[id].rgb * select(select(1.0, NOITA_UNDER, ny < -NOITA_RIM_N), NOITA_RIM, ny > NOITA_RIM_N), NOITA_ROUGH);
    metal = 0.0; f0 = NOITA_F0;
  }
  var fresnel = mix(vec3f(f0),alb.rgb,metal) + (vec3f(1.0)-mix(vec3f(f0),alb.rgb,metal))*pow(1.0-max(dot(normal,view),0.0),5.0);
  if (LOOK_CLASS[id].x == ${K.GAS}u) { fresnel = vec3f(0.0); }
  let specPower = max(2.0,2.0 / max(alb.w*alb.w,0.002)-2.0);
  var specular = fresnel * pow(max(dot(normal,halfVector),0.0),specPower) * (specPower+2.0)/8.0;
  // the volume's light where it is bound (particleLightWGSL: the sun's map and the clouds, the GI probes), in grid space
  let gridNormal = (hit-o.center)/o.radius;
  let light = FU.sunCol * FU.sunExt * max(dot(normal,sun),0.0) * particleSun(hit, gridNormal);
  var ambient = mix(FU.ground,FU.skyUp,normal.y*0.5+0.5) + FU.caveAmbient;
  if (P.light != 0u) { ambient = particleGI(hit, gridNormal); }
  var diffuse = alb.rgb * (1.0-metal);
  let paint = o.paint;
  // a painted metal is a painted (dielectric) coat, as the volume's decoSurf
  if (paint.a > 0.0) { diffuse = mix(diffuse, decoLinear(paint.rgb), paint.a); specular *= 1.0 - paint.a * metal; }
  if (LOOK_CLASS[id].y != ${R.OPAQUE}u) {
    let chord = 2.0*root;
    // painted liquid or glass reads as paint, not dye (shaders/gfx/deco.js DECO_SIGMA)
    let transmission = exp(-mix(optics.rgb, vec3f(${f(DECO_SIGMA)}), paint.a) * chord);
    let alpha = clamp(1.0-dot(transmission*(vec3f(1.0)-fresnel),vec3f(0.2126,0.7152,0.0722)),0.0,1.0);
    // ID + pixel + explicit TAA sample: independent stacked layers; default
    // sample=0 stays stable when TAA is disabled and never wakes an idle scene.
    let pixel = vec2u(o.position.xy);
    let hash = coverageHash(o.stableId ^ coverageHash(pixel.x) ^ coverageHash(pixel.y+0x9e3779b9u) ^ coverageHash(P.sample));
    if (f32(hash >> 8u) / 16777216.0 >= alpha) { discard; }
    diffuse = mix(LOOK_SCATTER[id], decoLinear(paint.rgb), paint.a) * (vec3f(1.0)-transmission) / max(alpha,0.00001);
    specular /= max(alpha,0.00001);
  }
  // Binary coverage is premultiplied alpha 0 or 1, NOT additive matter.
  out.color = vec4f(max(vec3f(0.0),(diffuse*(ambient+light)+specular*light)*FU.lightGain+o.glow),1.0);`}
  return out;
}`;

// The pick (gfx/volume.js recordPicks, render.js pickFrag's rays and ring): a V1 flying cell
// is a cell, so the box pick finds it; a V2 one flies in the pool. After the grid's pick has
// written each ray's slot, this kernel finds the nearest matter particle along the ray (the
// shape its view draws: particleViews.js blockyView's cube, else the equal-volume sphere)
// and, where it is nearer than the grid's hit, writes its cell, face and (id, T, P, life) as
// pickFrag does. A workgroup per ray, its threads striding the pool. Curved rays (the
// rolling log) skip it: particles are not bent by the presentation (wire/rays.js).
export const PICK_RAYS = 8;   // render.js PICK_BATCH (particle-views-check pins it)
const PICK_THREADS = 64;
const PICK_FACE_FLOOR = 2;    // render.js pickFrag PICK_FACE_FLOOR
export const ParticlePickParams = uniformStruct('ParticlePickParams', {
  ro: `array<vec4f, ${PICK_RAYS}>`, rd: `array<vec4f, ${PICK_RAYS}>`, slot: `array<vec4u, ${PICK_RAYS / 4}>`,
  origin: 'vec3f', n: 'u32', grid: 'vec4u', supers: 'vec4u', capacity: 'u32', lag: 'f32',
  // the rays' frame less the window's cells: 0 for the Box pick (window cells), the window's origin
  // for World's (wire/worldPick.js: world cells, as its grid pick reports them)
  shift: 'vec3f',
});
export const PARTICLE_PICK_LAYOUT = [ro(0, STAGE.COMPUTE), { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
export const particlePickWGSL = () => /* wgsl */ `
${frameBindings()}
${ParticlePickParams.wgsl}
@group(3) @binding(1) var<uniform> P: ParticlePickParams;
struct Particle { positionId: vec4u, velocityCore: vec4u, payloadBank: vec4u }
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<storage, read_write> picks: array<vec4f>;   // render.js pickFrag's ring: two per slot
${particleCommonWGSL()}
${particleViewsWGSL()}
${particleAirWGSL}
// Where the draw puts the particle this frame (nativeParticleWGSL's centre, P.lag): the pick picks what is seen.
fn particleDrawn(p: Particle) -> vec3f { return bitcast<vec3f>(p.positionId.xyz) - P.origin - bitcast<vec3f>(p.velocityCore.xyz) * P.lag; }
// Entry t of ray (ro, rd) into the box [lo, hi], or -1 for a miss; *nrm: the entered face's normal.
fn pickBox(ro: vec3f, rd: vec3f, lo: vec3f, hi: vec3f, nrm: ptr<function, vec3f>) -> f32 {
  let inv = 1.0 / select(rd, vec3f(1e-20), abs(rd) < vec3f(1e-20));
  let a = (lo - ro) * inv;
  let b = (hi - ro) * inv;
  let mn = min(a, b);
  let mx = max(a, b);
  let tn = max(mn.x, max(mn.y, mn.z));
  let tf = min(mx.x, min(mx.y, mx.z));
  if (tf < max(tn, 0.0)) { return -1.0; }
  var axis = 0;
  if (mn.y >= mn.x && mn.y >= mn.z) { axis = 1; } else if (mn.z >= mn.x && mn.z >= mn.y) { axis = 2; }
  var n = vec3f(0.0);
  n[axis] = -sign(rd[axis]);
  *nrm = n;
  return max(tn, 0.0);
}
fn pickSphere(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> f32 {
  let oc = ro - c; let b = dot(oc, rd);
  let d = b * b - dot(oc, oc) + r * r;
  if (d <= 0.0) { return -1.0; }
  let root = sqrt(d);
  var t = -b - root;
  if (t < 0.0) { t = -b + root; }
  return t;
}
// The particle's hit t along the ray (-1: none), *nrm its outward normal there.
fn pickParticle(i: u32, ro: vec3f, rd: vec3f, skipLiquids: bool, nrm: ptr<function, vec3f>) -> f32 {
  let p = particles[i];
  let id = p.velocityCore.w & 255u;
  if (p.positionId.w == 0u || id == 0u || id >= ${ELEMENTS.length}u) { return -1.0; }
  let kind = LOOK_CLASS[id].x;
  // render.js pickStops: not gas-like; liquids too unless the tool aims through them
  if (kind == ${K.GAS}u || (skipLiquids && kind == ${K.LIQUID}u)) { return -1.0; }
  var amount = 1.0;
  if (kind == ${K.LIQUID}u) { amount = f32(p.payloadBank.x & 0xffffffu) / 65536.0; }
  if (amount <= 0.0) { return -1.0; }
  let c = particleDrawn(p) + P.shift;
  if (blockyView(FU.view)) {
    let h = vec3f(0.5 * pow(amount, 1.0 / 3.0));
    return pickBox(ro, rd, c - h, c + h, nrm);
  }
  let r = pow(amount * (3.0 / (4.0 * 3.141592653589793)), 1.0 / 3.0);
  let t = pickSphere(ro, rd, c, r);
  *nrm = (ro + rd * t - c) / r;
  return t;
}
var<workgroup> wgT: array<f32, ${PICK_THREADS}>;
var<workgroup> wgI: array<u32, ${PICK_THREADS}>;
@compute @workgroup_size(${PICK_THREADS}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let r = wg.x;
  if (r >= P.n) { return; }
  let ro = P.ro[r].xyz;
  let rd = normalize(P.rd[r].xyz);
  var best = 1e30;
  var bestI = 0xffffffffu;
  if (P.ro[r].w == 0.0) {
    for (var i = li; i < P.capacity; i += ${PICK_THREADS}u) {
      var nrm: vec3f;
      let t = pickParticle(i, ro, rd, P.rd[r].w != 0.0, &nrm);
      if (t >= 0.0 && t < best) { best = t; bestI = i; }
    }
  }
  wgT[li] = best;
  wgI[li] = bestI;
  workgroupBarrier();
  for (var w = ${PICK_THREADS / 2}u; w > 0u; w >>= 1u) {
    if (li < w && wgT[li + w] < wgT[li]) { wgT[li] = wgT[li + w]; wgI[li] = wgI[li + w]; }
    workgroupBarrier();
  }
  if (li != 0u || wgI[0] == 0xffffffffu) { return; }
  let s = P.slot[r / 4u][r % 4u] * 2u;
  // the grid's hit: its cell's entry, the floor (cell y -1), or a miss (face -1)
  let at = picks[s];
  // (World's grid pick still loading the ray's pages, face -2: the pick waits for them, particles too)
  if (at.w < -1.5) { return; }
  var tGrid = 1e30;
  if (at.w >= 0.0 && at.y < 0.0 && rd.y < 0.0) { tGrid = -ro.y / rd.y; }
  else if (at.w >= 0.0) { var n0: vec3f; tGrid = max(pickBox(ro, rd, at.xyz, at.xyz + 1.0, &n0), 0.0); }
  var nrm: vec3f;
  let t = pickParticle(wgI[0], ro, rd, P.rd[r].w != 0.0, &nrm);
  if (t < 0.0 || t >= tGrid) { return; }
  let p = particles[wgI[0]];
  let id = p.velocityCore.w & 255u;
  let core = vec4u(p.velocityCore.w, p.payloadBank.xyz);
  // its own cell, as the grid pick reports a V1 flying cell's (its surface can reach past it)
  let c = particleDrawn(p);
  let cell = clamp(vec3i(floor(c)), vec3i(0), vec3i(P.grid.xyz) - 1) + vec3i(P.shift);
  let an = abs(nrm);
  var axis = 0;
  if (an.y >= an.x && an.y >= an.z) { axis = 1; } else if (an.z >= an.x && an.z >= an.y) { axis = 2; }
  // face codes as pickFrag's: axis * 2 + (1 if the ray steps +axis); the normal is minus the step
  let face = axis * 2 + select(0, 1, nrm[axis] < 0.0);
  picks[s] = vec4f(vec3f(cell), f32(face));
  picks[s + 1u] = vec4f(f32(id), temperature(id, core.x), particleAirAt(c).w, particleLife(id, core));
}`;

export const nativeParticlePipeline = (rays = false) => ({
  vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets: [{ format: 'rgba16float',
    ...(rays ? { blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } } : {}),
  }] }, primitive: { topology: 'triangle-list' },
  depthStencil: { format: 'depth32float', depthWriteEnabled: !rays, depthCompare: 'less-equal' },
});
export const WGSL_CHECK = [
  { name: 'nativeParticleArgs', kind: 'compute', grids: false, warm: false, code: nativeParticleArgsWGSL,
    params: NativeParticleParams, layouts: () => [NATIVE_PARTICLE_ARGS_LAYOUT], dispatch: () => [1,1,1] },
  { name: 'nativeParticlePick', kind: 'compute', grids: false, warm: false, code: particlePickWGSL,
    params: ParticlePickParams, layouts: () => [RENDER_LAYOUT.FRAME,PARTICLE_PICK_LAYOUT,NATIVE_PARTICLE_AIR_LAYOUT], layoutNames: ['FRAME'], dispatch: () => [PICK_RAYS,1,1] },
  ...[false,true].map(rays => ({ name: rays ? 'nativeParticleRays' : 'nativeParticleMatter', kind: 'render', grids: false,
    warm: false, code: () => nativeParticleWGSL(rays), params: NativeParticleParams,
    layouts: () => [RENDER_LAYOUT.FRAME,NATIVE_PARTICLE_LAYOUT,rays ? NATIVE_PARTICLE_AIR_LAYOUT : NATIVE_PARTICLE_LIGHT_LAYOUT], layoutNames: ['FRAME'], ...nativeParticlePipeline(rays) })),
];
