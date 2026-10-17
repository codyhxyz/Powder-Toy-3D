import { BRICK, STAGE } from '../common.js';
import { LAMP_MAX, WAND_LIGHTS } from '../bindings.js';
import { LAMP_UNIT } from '../../gfx/lamps.js';
import { SH_Y0, SH_Y1 } from '../gfx/lighting.js';

export const HYBRID_LIGHTING_LIMITS = Object.freeze({ lamps: LAMP_MAX, wands: WAND_LIGHTS });

/** Dedicated group, mergeable entries: GI0..3 rgba16float 3D, glow rgba16float
 * 3D, filtering sampler. FU remains the existing FrameUniforms binding.
 * Optional hooks are WGSL function names: lampVisibility(i,p,ng)->vec3f,
 * lampActive(i)->bool (use the engine's lampLive for immediate torch deletion).
 * No ray walks are injected. Without hooks lamps are explicitly unshadowed.
 */
export function hybridLightingConfig({ group = 2, binding = 0, visibility = STAGE.FRAGMENT | STAGE.COMPUTE,
  lampVisibility = null, lampActive = null } = {}) {
  if (!Number.isInteger(group) || group < 0 || group > 3) throw new RangeError('lighting group must be 0..3');
  if (!Number.isInteger(binding) || binding < 0 || binding > 994) throw new RangeError('lighting binding must be 0..994');
  if (!Number.isInteger(visibility) || visibility < 1 || (visibility & ~7)) throw new RangeError('invalid lighting visibility');
  for (const hook of [lampVisibility, lampActive]) {
    if (hook !== null && !/^[A-Za-z][A-Za-z0-9_]*$/.test(hook)) throw new TypeError('lighting hook must be a WGSL function name');
  }
  return { group, binding, visibility, lampVisibility, lampActive };
}

export function hybridLightingLayout(options = {}) {
  const { binding, visibility } = hybridLightingConfig(options);
  return Array.from({ length: 6 }, (_, i) => ({ binding: binding + i, visibility,
    ...(i === 5 ? { sampler: { type: 'filtering' } }
      : { texture: { sampleType: 'float', viewDimension: '3d', multisampled: false } }),
  }));
}

/** Compose after FrameUniforms/FU and materials' HybridMaterial declaration.
 * Inputs are physical grid-cell axes, NOT FU.model display coordinates.
 * hybridShade returns linear HDR premultiplied rgba; no tone mapping.
 * sunVisibility is RGB cached shadow/cloud transmission supplied by caller.
 * ao applies only to indirect diffuse. Emission uses the material's engine
 * radiance units, never lightGain (which scales only the glow/wand volume).
 * World-cell positions convert by subtracting the current window origin.
 */
export function hybridLightingWGSL(options = {}) {
  const c = hybridLightingConfig(options);
  return /* wgsl */ `
${Array.from({ length: 5 }, (_, i) => `@group(${c.group}) @binding(${c.binding + i}) var hl${i < 4 ? `GI${i}` : 'Glow'}: texture_3d<f32>;`).join('\n')}
@group(${c.group}) @binding(${c.binding + 5}) var hlSampler: sampler;
const HL_PI: f32 = 3.141592653589793;
const HL_Y0: f32 = ${SH_Y0};
const HL_Y1: f32 = ${SH_Y1};
const HL_BS: f32 = ${BRICK}.0;
struct HybridProbe { c0: vec4f, cx: vec4f, cy: vec4f, cz: vec4f }
fn hybridUnit(v: vec3f, fallback: vec3f) -> vec3f {
  return select(fallback, v * inverseSqrt(max(dot(v,v), 1e-20)), dot(v,v) > 1e-20);
}
// Display-space meshes: inverseModel transforms positions to grid. Normals
// transform back with transpose(model), NOT inverseModel's vector transform.
fn hybridGridPosition(displayP: vec3f, inverseModel: mat4x4f) -> vec3f {
  return (inverseModel * vec4f(displayP, 1.0)).xyz;
}
fn hybridGridNormal(displayN: vec3f) -> vec3f {
  let m = mat3x3f(FU.model[0].xyz, FU.model[1].xyz, FU.model[2].xyz);
  return hybridUnit(transpose(m) * displayN, vec3f(0.0, 1.0, 0.0));
}
fn hybridProbeUV(p: vec3f) -> vec3f {
  let b = vec3f(textureDimensions(hlGI0));
  return clamp(p / HL_BS, vec3f(0.5), b - 0.5) / b;
}
// Same brick-centre lattice as gi.js. Normal-aware trilinear interpolation
// rejects centres behind the geometric surface. The alpha SH bands describe
// sky visibility, NOT distance-to-wall; never use them as visibility moments.
// This reduces back-side mixing but cannot guarantee leak-free thin walls.
fn hybridSurfaceProbe(p: vec3f, ng: vec3f) -> HybridProbe {
  let b = vec3i(textureDimensions(hlGI0));
  let q = clamp((p + ng * 3.0) / HL_BS, vec3f(0.5), vec3f(b) - 0.5) - 0.5;
  let lo = vec3i(floor(q));
  let f = fract(q);
  var result = HybridProbe(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  var total = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let cell = clamp(lo + o, vec3i(0), b - 1);
    let wf = mix(1.0 - f, f, vec3f(o));
    let delta = (vec3f(cell) + 0.5) * HL_BS - p;
    let facing = dot(ng, hybridUnit(delta, ng));
    let w = wf.x * wf.y * wf.z * max(facing, 0.0);
    result.c0 += textureLoad(hlGI0, cell, 0) * w;
    result.cx += textureLoad(hlGI1, cell, 0) * w;
    result.cy += textureLoad(hlGI2, cell, 0) * w;
    result.cz += textureLoad(hlGI3, cell, 0) * w;
    total += w;
  }
  let scale = 1.0 / max(total, 1e-8);
  return HybridProbe(result.c0 * scale, result.cx * scale, result.cy * scale, result.cz * scale);
}
fn hybridProbeIrradiance(g: HybridProbe, n: vec3f) -> vec3f {
  return max(HL_Y0 * g.c0.rgb + (2.0 / 3.0) * HL_Y1 *
    (g.cx.rgb * n.x + g.cy.rgb * n.y + g.cz.rgb * n.z), vec3f(0.0)) + max(FU.caveAmbient, vec3f(0.0));
}
fn hybridProbeRadiance(g: HybridProbe, d: vec3f, roughness: f32) -> vec3f {
  return max(HL_Y0 * g.c0.rgb + mix(1.0, 2.0 / 3.0, roughness) * HL_Y1 *
    (g.cx.rgb * d.x + g.cy.rgb * d.y + g.cz.rgb * d.z), vec3f(0.0)) + max(FU.caveAmbient, vec3f(0.0));
}
fn hybridProbeSkyVisibility(g: HybridProbe, n: vec3f) -> f32 {
  let v = HL_Y0 * g.c0.a + (2.0 / 3.0) * HL_Y1 * (g.cx.a * n.x + g.cy.a * n.y + g.cz.a * n.z);
  return clamp(v / max(0.5 + 0.5 * n.y, 0.05), 0.0, 1.0);
}
fn hybridSkyAmbient(n: vec3f) -> vec3f {
  return max(mix(FU.ground, FU.skyUp, 0.5 + 0.5 * n.y), vec3f(0.0)) + max(FU.caveAmbient, vec3f(0.0));
}
fn hybridFresnel(f0: vec3f, vh: f32) -> vec3f {
  return f0 + (1.0 - f0) * pow(1.0 - clamp(vh, 0.0, 1.0), 5.0);
}
// GGX + height-correlated Smith; engine light colours are irradiance/pi.
// Consequently specular is multiplied by pi, while Lambert diffuse is not.
fn hybridDirect(m: HybridMaterial, n: vec3f, v: vec3f, l: vec3f) -> vec3f {
  let nl = max(dot(n,l), 0.0);
  let nv = max(dot(n,v), 1e-4);
  let h = hybridUnit(v + l, n);
  let nh = max(dot(n,h), 0.0);
  let base = clamp(m.baseColor, vec3f(0.0), vec3f(1.0));
  let metal = clamp(m.metalness, 0.0, 1.0);
  let f0 = clamp(m.f0,vec3f(0.0),vec3f(1.0));
  let fresnel = hybridFresnel(f0, max(dot(v,h), 0.0));
  let a = max(clamp(m.roughness, 0.0, 1.0) * clamp(m.roughness, 0.0, 1.0), 0.002);
  let a2 = a * a;
  // Algebraically equivalent to nh²*(a²-1)+1, without cancellation at nh=1.
  let d = max((1.0 - nh * nh) + nh * nh * a2, 1e-8);
  let distribution = a2 / (HL_PI * d * d);
  let gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  let gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  let specular = HL_PI * distribution * (0.5 / max(gv + gl, 1e-5)) * fresnel;
  return ((1.0 - fresnel) * base * (1.0 - metal) + specular) * nl;
}
fn hybridLampFall(d2: f32, reach: f32, radius: f32) -> f32 {
  let r2 = max(radius * radius, 1e-8);
  let x2 = d2 / max(reach * reach, 1e-8);
  let fade = max(1.0 - x2 * x2, 0.0);
  return (${LAMP_UNIT}.0 * ${LAMP_UNIT}.0 + r2) / (d2 + r2) * fade * fade;
}
fn hybridGlow(p: vec3f) -> vec3f {
  let b = vec3f(textureDimensions(hlGlow));
  let uv = clamp(p / HL_BS, vec3f(0.5), b - 0.5) / b;
  var light = max(textureSampleLevel(hlGlow, hlSampler, uv, 0.0).rgb, vec3f(0.0));
  for (var i = 0; i < ${WAND_LIGHTS}; i++) {
    if (i >= clamp(FU.wandLightCount, 0, ${WAND_LIGHTS})) { break; }
    let pr = FU.wandLightPosition[i];
    let ci = FU.wandLightColor[i];
    let dv = p - pr.xyz;
    let fade = max(1.0 - dot(dv,dv) / max(pr.w * pr.w, 1e-8), 0.0);
    if (pr.w > 0.0) { light += max(ci.rgb * ci.w, vec3f(0.0)) * fade * fade; }
  }
  return light * max(FU.lightGain, 0.0);
}
fn hybridShadeSpecular(m: HybridMaterial, p: vec3f, geometricNormal: vec3f, shadingNormal: vec3f,
  viewDirection: vec3f, sunVisibility: vec3f, ao: f32, reflected: vec4f) -> vec4f {
  let ng = hybridUnit(geometricNormal, vec3f(0.0, 1.0, 0.0));
  let n = hybridUnit(shadingNormal, ng);
  let v = hybridUnit(viewDirection, n);
  let sun = hybridUnit(FU.sun, vec3f(0.0, 1.0, 0.0));
  let g = hybridSurfaceProbe(p, ng);
  let inside = all(p >= vec3f(0.0)) && all(p <= vec3f(textureDimensions(hlGI0)) * HL_BS);
  var indirect = hybridProbeIrradiance(g, n);
  var environment = hybridProbeRadiance(g, reflect(-v,n), clamp(m.roughness, 0.0, 1.0));
  if (!inside) { indirect = hybridSkyAmbient(n); environment = hybridSkyAmbient(reflect(-v,n)); }
  let base = clamp(m.baseColor, vec3f(0.0), vec3f(1.0));
  let metal = clamp(m.metalness, 0.0, 1.0);
  let f0 = clamp(m.f0,vec3f(0.0),vec3f(1.0));
  let f = hybridFresnel(f0, max(dot(n,v), 0.0));
  var color = (1.0 - f) * base * (1.0 - metal) * (indirect * clamp(ao,0.0,1.0) + hybridGlow(p));
  // Low-frequency SH specular fallback, not a sharp reflection or split-sum LUT.
  color += mix(environment * f, reflected.rgb, clamp(reflected.a,0.0,1.0))
    * (1.0 - 0.5 * clamp(m.roughness, 0.0, 1.0));
  color += max(FU.sunCol,vec3f(0.0)) * clamp(sunVisibility,vec3f(0.0),vec3f(1.0)) * hybridDirect(m,n,v,sun);
  for (var i = 0; i < ${LAMP_MAX}; i++) {
    if (i >= clamp(FU.lampCount, 0, ${LAMP_MAX})) { break; }
    ${c.lampActive ? `if (!${c.lampActive}(i)) { continue; }` : ''}
    let lp = FU.lampPos[i];
    let shape = FU.lampShape[i];
    let halfLength = 0.5 * max(shape.y, 0.0);
    let near = vec3f(lp.x, clamp(p.y, lp.y - halfLength, lp.y + halfLength), lp.z);
    let dv = near - p;
    let d2 = dot(dv,dv);
    if (lp.w <= 0.0 || d2 >= lp.w * lp.w) { continue; }
    if (FU.lampCol[i].w > 0.5 && all(abs(p-lp.xyz) < vec3f(0.6))) { continue; }
    let transmission = ${c.lampVisibility ? `clamp(${c.lampVisibility}(i,p,ng),vec3f(0.0),vec3f(1.0))` : 'vec3f(1.0)'};
    color += max(FU.lampCol[i].rgb,vec3f(0.0)) * hybridLampFall(d2,lp.w,max(shape.x,0.0)) *
      transmission * hybridDirect(m,n,v,hybridUnit(dv,n));
  }
  color += max(m.emission,vec3f(0.0));
  let opacity = clamp(m.opacity,0.0,1.0);
  // Keep finite highlights representable in the rgba16float HDR target.
  return vec4f(clamp(color,vec3f(0.0),vec3f(65504.0)) * opacity, opacity);
}
fn hybridShade(m: HybridMaterial, p: vec3f, geometricNormal: vec3f, shadingNormal: vec3f,
  viewDirection: vec3f, sunVisibility: vec3f, ao: f32) -> vec4f {
  return hybridShadeSpecular(m,p,geometricNormal,shadingNormal,viewDirection,sunVisibility,ao,vec4f(0.0));
}
fn hybridShadeWorld(m: HybridMaterial, worldCellP: vec3f, windowOrigin: vec3f, ng: vec3f, n: vec3f,
  viewDirection: vec3f, sunVisibility: vec3f, ao: f32) -> vec4f {
  return hybridShade(m,worldCellP-windowOrigin,ng,n,viewDirection,sunVisibility,ao);
}
`;
}
