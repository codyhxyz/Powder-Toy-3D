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

export const PARTICLE_BYTES = 48;
export const PARTICLE_WORDS = 12;
// deco: draw each particle's decoration (src/deco.js decoShown: painted, display on)
export const NativeParticleParams = uniformStruct('NativeParticleParams', {
  inverseModel: 'mat4x4f', origin: 'vec3f', scale: 'f32', eye: 'vec3f', sample: 'u32',
  viewport: 'vec2f', capacity: 'u32', deco: 'u32',
});
const ro = (binding, visibility) => ({ binding, visibility, buffer: { type: 'read-only-storage' } });
// 1: each pool slot's decoration, RGBA8 (src/v2/physics.js particleDecoRange)
export const NATIVE_PARTICLE_LAYOUT = [ro(0, STAGE.VERTEX), ro(1, STAGE.VERTEX)];
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
}
struct Out {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) center: vec3f,
  @location(1) @interpolate(flat) radius: f32,
  @location(2) @interpolate(flat) id: u32,
  @location(3) @interpolate(flat) stableId: u32,
  @location(4) @interpolate(flat) glow: vec3f,
  @location(5) @interpolate(flat) paint: vec4f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out; o.position = vec4f(2.0,2.0,2.0,1.0);
  let p = particles[ii]; let id = p.velocityCore.w & 255u;
  if (p.positionId.w == 0u || ${rays ? '(id != 254u && id != 255u)' : `(id == 0u || id >= ${ELEMENTS.length}u)`}) { return o; }
  o.id = id; o.stableId = p.positionId.w;
  if (P.deco != 0u && ii < arrayLength(&particleDeco)) { o.paint = unpack4x8unorm(particleDeco[ii]); }
  o.center = bitcast<vec3f>(p.positionId.xyz) - P.origin;
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
  o.glow = LOOK_EMIT[id].rgb + emissivity * incandescence(temperature(id,p.velocityCore.w));`}
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
struct Surface { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
@fragment fn fs(o: Out) -> Surface {
  let ndc = vec2f(o.position.x / P.viewport.x * 2.0 - 1.0, 1.0 - o.position.y / P.viewport.y * 2.0);
  let farH = FU.invViewProj * vec4f(ndc,1.0,1.0);
  let eye = (P.inverseModel * vec4f(P.eye,1.0)).xyz;
  let farPoint = (P.inverseModel * vec4f(farH.xyz / farH.w,1.0)).xyz;
  let direction = normalize(farPoint - eye);
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
  let id = o.id; let optics = LOOK_OPTICS[id]; let alb = LOOK_ALBEDO[id];
  let normal = normalize((transpose(P.inverseModel) * vec4f((hit-o.center)/o.radius,0.0)).xyz);
  let view = normalize(P.eye-(FU.model*vec4f(hit,1.0)).xyz);
  let sun = normalize((FU.model * vec4f(FU.sun,0.0)).xyz);
  let halfVector = normalize(sun+view);
  let metal = LOOK_EMIT[id].w;
  let f0 = pow((optics.w-1.0)/(optics.w+1.0),2.0);
  var fresnel = mix(vec3f(f0),alb.rgb,metal) + (vec3f(1.0)-mix(vec3f(f0),alb.rgb,metal))*pow(1.0-max(dot(normal,view),0.0),5.0);
  if (LOOK_CLASS[id].x == ${K.GAS}u) { fresnel = vec3f(0.0); }
  let specPower = max(2.0,2.0 / max(alb.w*alb.w,0.002)-2.0);
  var specular = fresnel * pow(max(dot(normal,halfVector),0.0),specPower) * (specPower+2.0)/8.0;
  let light = FU.sunCol * FU.sunExt * max(dot(normal,sun),0.0);
  let ambient = mix(FU.ground,FU.skyUp,normal.y*0.5+0.5) + FU.caveAmbient;
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

export const nativeParticlePipeline = (rays = false) => ({
  vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets: [{ format: 'rgba16float',
    ...(rays ? { blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } } : {}),
  }] }, primitive: { topology: 'triangle-list' },
  depthStencil: { format: 'depth32float', depthWriteEnabled: !rays, depthCompare: 'less-equal' },
});
export const WGSL_CHECK = [
  { name: 'nativeParticleArgs', kind: 'compute', grids: false, warm: false, code: nativeParticleArgsWGSL,
    params: NativeParticleParams, layouts: () => [NATIVE_PARTICLE_ARGS_LAYOUT], dispatch: () => [1,1,1] },
  ...[false,true].map(rays => ({ name: rays ? 'nativeParticleRays' : 'nativeParticleMatter', kind: 'render', grids: false,
    warm: false, code: () => nativeParticleWGSL(rays), params: NativeParticleParams,
    layouts: () => [RENDER_LAYOUT.FRAME,NATIVE_PARTICLE_LAYOUT], layoutNames: ['FRAME'], ...nativeParticlePipeline(rays) })),
];
