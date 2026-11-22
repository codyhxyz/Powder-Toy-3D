// Mesh-first optics: one depth-bounded view ray, with no secondary voxel rays.
import { glslMod, fullscreenVert } from '../../gpu/wgsl.js';
import { uniformStruct } from '../../gpu/params.js';
import { materialsGLSL } from '../../gfx/materials.js';
import { RIPPLE_SLOPE } from '../gfx/liquid.js';
import { noiseGLSL } from '../gfx/noise.js';
import { prelude, STAGE } from '../common.js';
import { BRICK_INFO, frameBindings, RENDER_LAYOUT } from '../bindings.js';
import { ddaWalkWGSL } from '../dda.js';
import { WC_OWN, WORLD_COPY_LAYOUT, worldCopyWGSL } from './copy.js';
import { LIGHT_BINDINGS } from './light.js';
import { lightLookupWGSL } from './lightLookup.js';
import { worldGroup2Layout, worldGroup2WGSL } from './bindings.js';

export const OpticsParams = uniformStruct('OpticsParams', {
  clipToEye: 'mat4x4f', eyeToClip: 'mat4x4f', eye: 'vec3f', maxDist: 'f32', inSize: 'vec2f',
});

const F = STAGE.FRAGMENT;
const tex = (sampleType) => ({ visibility: F, texture: { sampleType } });
const light = [...LIGHT_BINDINGS.filter(([n]) => n !== 12),
  [17, 'linearClamp', 'sampler', { visibility: F, sampler: { type: 'filtering' } }]];
const depth = [1, 'tOpaqueDepth', 'texture_depth_2d', tex('depth')];
const mediaBindings = [depth, ...light];
const opticsBindings = [
  [0, 'tOpaqueColor', 'texture_2d<f32>', tex('float')], depth,
  [2, 'tMediaHalf', 'texture_2d<f32>', tex('float')], ...light,
];
export const MEDIA_HALF_LAYOUT = worldGroup2Layout(mediaBindings);
export const OPTICS_OVERLAY_LAYOUT = worldGroup2Layout(opticsBindings);

// Pure helpers shared with the CPU interpreter checks. Reciprocal clip w is
// proportional to inverse view depth for the perspective camera, regardless
// of jitter and the world-cell model transform.
export const opticsMathWGSL = /* wgsl */ `
fn overlayAttenuation(sigma: vec3f, cells: f32) -> vec3f {
  return exp(-sigma * max(cells, 0.0));
}
fn overlayBehind(z: f32, front: f32, planeSide: f32) -> bool {
  return z > front && (z == 1.0 || planeSide < 0.0);
}
fn overlayDepthWeight(w: f32, tapW: f32, sky: bool, tapSky: bool) -> f32 {
  if (sky != tapSky) { return 0.0; }
  if (sky) { return 1.0; }
  let d = abs(w - tapW) / max(max(w, tapW), 1e-8);
  let k = max(1.0 - d / 0.08, 0.0);
  return k * k;
}
// A half-res texel represents the first full pixel of its 2x2 tile. The same
// lattice is used for the march and the upsample, including odd-sized edges.
fn overlayMediaRep(half: vec2i) -> vec2i { return 2 * half; }
fn overlayMediaCoord(full: vec2i) -> vec2f { return 0.5 * vec2f(full); }
`;

const shared = (g, bindings) => /* wgsl */ `
${prelude(g, { state: false })}
${frameBindings()}
${worldCopyWGSL()}
${ddaWalkWGSL}
${worldGroup2WGSL(bindings)}
${OpticsParams.wgsl}
@group(3) @binding(1) var<uniform> OP: OpticsParams;
${lightLookupWGSL({ caustics: false })}
fn lmLoad(i: u32) -> vec4u { return lcBuf[i]; }
${fullscreenVert()}
${opticsMathWGSL}

struct OverlayRay { rd: vec3f, near: f32, stop: f32 }
fn overlayNdc(px: vec2i) -> vec2f {
  let uv = (vec2f(px) + 0.5) / OP.inSize;
  return uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
}
fn overlayRayAt(ndc: vec2f, z: f32) -> OverlayRay {
  let base = OP.clipToEye * vec4f(ndc, 0.0, 1.0);
  let dz = OP.clipToEye[2];
  let d = normalize((base + dz).xyz);
  // Keep the sign of nearly parallel axes; DDA boundary division needs a nonzero rd.
  let rd = normalize(select(d, select(vec3f(-1e-6), vec3f(1e-6), d >= vec3f(0.0)), abs(d) < vec3f(1e-6)));
  let near = max(dot(base.xyz, rd) / base.w, 0.0);
  var stop = OP.maxDist;
  if (z < 1.0) {
    let h = base + z * dz;
    stop = min(stop, dot(h.xyz, rd) / h.w);
  }
  return OverlayRay(rd, near, stop);
}
fn overlayRay(px: vec2i, z: f32) -> OverlayRay { return overlayRayAt(overlayNdc(px), z); }

struct OverlayWalk { c: vec3i, next: vec3f, t: f32, end: f32, ax: i32 }
fn overlayStart(ray: OverlayRay) -> OverlayWalk {
  let a = -OP.eye / ray.rd;
  let b = (vec3f(WC.size) - OP.eye) / ray.rd;
  let lo = min(a, b);
  let hi = max(a, b);
  let ax = argmin3(-lo);
  let enter = lo[ax];
  let t = max(ray.near, enter);
  let end = min(ray.stop, min(hi.x, min(hi.y, hi.z)));
  if (t >= end) { return OverlayWalk(vec3i(0), vec3f(0.0), t, end, -1); }
  let p = OP.eye + ray.rd * t;
  // At an exact cell plane a negative ray enters the lower cell.
  let cell = select(vec3i(floor(p)), vec3i(ceil(p)) - 1, ray.rd < vec3f(0.0));
  let c = clamp(cell, vec3i(0), WC.size - 1);
  return OverlayWalk(c, ddaNext(OP.eye, ray.rd, c), t, end, select(-1, ax, enter >= ray.near));
}
fn overlayJump(ray: OverlayRay, stepDir: vec3i, walk: ptr<function, OverlayWalk>, size: i32) {
  let lo = vec3f((*walk).c & vec3i(~(size - 1)));
  let ax = ddaJumpBox(lo, lo + f32(size), OP.eye, ray.rd, stepDir, &(*walk).c, &(*walk).next, &(*walk).t);
  (*walk).ax = ax;
}
fn overlayMin(v: vec3f) -> f32 { return min(v.x, min(v.y, v.z)); }
fn overlayBrickEnd(ray: OverlayRay, walk: OverlayWalk) -> f32 {
  let lo = vec3f(walk.c & vec3i(~(BS - 1)));
  let boundary = lo + select(vec3f(0.0), vec3f(f32(BS)), ray.rd > vec3f(0.0));
  return min(walk.end, overlayMin((boundary - OP.eye) / ray.rd));
}
// Only occupied regions reach the brick metadata. The ABI has no per-type
// occupancy at the top levels; an empty 64³/16³ region takes one jump.
fn overlayNextBrick(ray: OverlayRay, stepDir: vec3i, walk: ptr<function, OverlayWalk>, mask: u32) -> bool {
  while ((*walk).t < (*walk).end && wcInWorld((*walk).c)) {
    let c = (*walk).c;
    if (!wcOccupied(2u, c)) { overlayJump(ray, stepDir, walk, 64); }
    else if (!wcOccupied(1u, c)) { overlayJump(ray, stepDir, walk, 16); }
    else if ((wcInfo(c >> vec3u(2u)) & mask) == 0u) { overlayJump(ray, stepDir, walk, BS); }
    else { return true; }
  }
  return false;
}
fn overlayProbe(p: vec3f) -> LmProbe {
  if (FU.nearGI == 0u) { return lmOpenProbe(FU.skyUp, FU.ground); }
  return lmProbeAt(p, tGI0, tGI1, tGI2, tGI3, linearClamp, FU.skyUp, FU.ground);
}
fn overlaySun(p: vec3f, n: vec3f) -> vec3f {
  if (FU.shadows == 0u) { return vec3f(1.0); }
  return lmSunMap(p, n, false, FU.time);
}
`;

export const mediaHalfWGSL = (g) => /* wgsl */ `
${shared(g, mediaBindings)}
${glslMod}
${noiseGLSL}
${materialsGLSL()}
// A single HG lobe; the source light is in irradiance/pi, so pi times HG.
fn overlayPhase(mu: f32, g: f32) -> f32 {
  let k = 1.0 + g * g - 2.0 * g * mu;
  return 0.25 * (1.0 - g * g) * inverseSqrt(k) / k;
}
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let half = vec2i(in.position.xy);
  let px = overlayMediaRep(half);
  let ray = overlayRay(px, textureLoad(tOpaqueDepth, px, 0));
  var walk = overlayStart(ray);
  let stepDir = vec3i(sign(ray.rd));
  var radiance = vec3f(0.0);
  var tr = 1.0;
  // W's low MEDIA bit is dilated for the smoothed field. This pass samples raw
  // cells, so also require the brick's own media bit before sampling it.
  while (overlayNextBrick(ray, stepDir, &walk, ${WC_OWN.MEDIA}u)) {
    let end = overlayBrickEnd(ray, walk);
    let dt = end - walk.t;
    if (dt > 0.0) {
      let brickJitter = dot(vec3f(walk.c >> vec3u(2u)), vec3f(1.0, 3.0, 5.0));
      let j = ign(in.position.xy + vec2f(0.0, brickJitter), f32(FU.frame));
      let p = OP.eye + ray.rd * mix(walk.t, end, clamp(j, 0.001, 0.999));
      let lo = walk.c & vec3i(~(BS - 1));
      let c = clamp(vec3i(floor(p)), lo, lo + BS - 1);
      let w = wcCell(c);
      let id = wcId(w);
      let md = MEDIACH(id);
      if (md >= MD_SMOKE && md <= MD_FIRE) {
        let density = select(select(wcAux(w), HAZE(id), md == MD_STEAM), mix(FIRE_BASE, 1.0, wcAux(w)), md == MD_FIRE);
        let t = exp(-MD_EXT[md] * density * dt);
        LM = LC;
        var source: vec3f;
        if (md == MD_FIRE) {
          // Same blackbody normalization as gfx/media.js, radiance ∝ Kelvin^4.
          let temp = wcTemp(w);
          let k = (temp + C_TO_K) / 1273.15;
          source = 3.0 * blackbody(temp) * (k * k) * (k * k);
        } else {
          let ambient = LM_SH_Y0 * max(overlayProbe(p).c0.rgb, vec3f(0.0)) + FU.caveAmbient;
          let sun = FU.sunCol * overlaySun(p, vec3f(0.0)) * overlayPhase(dot(ray.rd, FU.sun), MD_G[md]);
          source = MD_ALBEDO[md] * (ambient + sun);
        }
        radiance += tr * (1.0 - t) * source;
        tr *= t;
      }
    }
    overlayJump(ray, stepDir, &walk, BS);
  }
  return vec4f(radiance, tr);
}
`;

// The copy writes no exact general LIQUID/GLASS mask. Own SURF and CRISP
// conservatively cover every R_LIQUID/R_GLASS cell (even mixed opaque bricks).
// Reject uniform non-optics in one table read; mixed bricks need a cell walk.
const opticsCandidates = WC_OWN.SURF | WC_OWN.CRISP | BRICK_INFO.LIQUID_INTERIOR | BRICK_INFO.GLASS_CELLS;

export const opticsOverlayWGSL = (g) => /* wgsl */ `
${shared(g, opticsBindings)}
struct OpticsHit { c: vec3i, ax: i32, id: i32, t: f32, exit: f32 }
fn overlayOptical(id: i32) -> bool {
  let r = RCLASS(id);
  return r == R_LIQUID || r == R_GLASS;
}
// Continue from the first hit, stopping at the first nonzero segment of
// another class (including empty space), at the world edge or at opaque depth.
// Full homogeneous bricks can be crossed in one step; mixed/partial bricks
// need the same shown-cell test as the front hit.
fn overlayRun(ray: OverlayRay, start: OverlayWalk, rclass: i32) -> f32 {
  var walk = start;
  let stepDir = vec3i(sign(ray.rd));
  let delta = abs(1.0 / ray.rd);
  while (walk.t < walk.end && wcInWorld(walk.c)) {
    let b = walk.c >> vec3u(2u);
    let entry = wcEntry(b);
    if ((entry & WC_MIXED) == 0u && (RCLASS(wcId(entry)) != R_LIQUID || (entry >> 24u) == WC_AUX_WHOLE)) {
      let end = overlayBrickEnd(ray, walk);
      if (end > walk.t && RCLASS(wcId(entry)) != rclass) { return walk.t; }
      if (end >= walk.end) { return walk.end; }
      overlayJump(ray, stepDir, &walk, BS);
      continue;
    }
    while (walk.t < walk.end && all((walk.c >> vec3u(2u)) == b) && wcInWorld(walk.c)) {
      let next = overlayMin(walk.next);
      if (min(next, walk.end) > walk.t && RCLASS(wcShownId(wcCellIn(entry, walk.c), walk.c)) != rclass) { return walk.t; }
      walk.t = next;
      walk.ax = ddaStep(stepDir, delta, &walk.c, &walk.next);
    }
  }
  return min(walk.t, walk.end);
}
fn overlayTrace(ray: OverlayRay) -> OpticsHit {
  var walk = overlayStart(ray);
  let stepDir = vec3i(sign(ray.rd));
  let delta = abs(1.0 / ray.rd);
  while (overlayNextBrick(ray, stepDir, &walk, ${opticsCandidates}u)) {
    let b = walk.c >> vec3u(2u);
    let entry = wcEntry(b);
    if ((entry & WC_MIXED) == 0u) {
      let id = wcId(entry);
      if (!overlayOptical(id)) { overlayJump(ray, stepDir, &walk, BS); continue; }
      // Uniform full liquid or glass: no cell-by-cell march to find its front.
      let end = overlayBrickEnd(ray, walk);
      if (end > walk.t && (RCLASS(id) == R_GLASS || (entry >> 24u) == WC_AUX_WHOLE)) {
        return OpticsHit(walk.c, walk.ax, id, walk.t, overlayRun(ray, walk, RCLASS(id)));
      }
    }
    // At most ten nonzero cell segments per brick. Use the same DDA as the
    // wider voxel renderers so edge/corner ties cannot advance backwards.
    while (walk.t < walk.end && all((walk.c >> vec3u(2u)) == b) && wcInWorld(walk.c)) {
      let tNext = overlayMin(walk.next);
      let end = min(tNext, walk.end);
      if (end > walk.t) {
        let w = wcCellIn(entry, walk.c);
        let id = wcShownId(w, walk.c);
        if (overlayOptical(id)) { return OpticsHit(walk.c, walk.ax, id, walk.t, overlayRun(ray, walk, RCLASS(id))); }
      }
      walk.t = tNext;
      walk.ax = ddaStep(stepDir, delta, &walk.c, &walk.next);
    }
  }
  return OpticsHit(vec3i(0), -1, E_EMPTY, 0.0, 0.0);
}
fn overlayLiquidDensity(c: vec3i) -> f32 {
  let w = wcCell(c);
  return select(0.0, wcAux(w), RCLASS(wcId(w)) == R_LIQUID);
}
fn overlayLiquidNormal(c: vec3i, p: vec3f, face: vec3f, rd: vec3f, water: bool) -> vec3f {
  let x = vec3i(1, 0, 0);
  let y = vec3i(0, 1, 0);
  let z = vec3i(0, 0, 1);
  var n = vec3f(overlayLiquidDensity(c - x) - overlayLiquidDensity(c + x),
                overlayLiquidDensity(c - y) - overlayLiquidDensity(c + y),
                overlayLiquidDensity(c - z) - overlayLiquidDensity(c + z));
  if (dot(n, face) < 0.01 || dot(n, rd) >= 0.0) { n = face; }
  else { n = normalize(n); }
  if (water && face.y > 0.0) {
    let q = p.xz * vec2f(0.53, 0.79) + FU.time * vec2f(1.2, -1.5);
    n = normalize(n + ${RIPPLE_SLOPE} * vec3f(sin(q.x + q.y), 0.0, cos(q.y - q.x)));
  }
  if (dot(n, rd) >= 0.0) { return face; }
  return n;
}
fn overlayBend(px: vec2i, eyeToHit: vec3f, rd: vec3f, n: vec3f, face: vec3f, eta: f32, cells: f32, z: f32) -> vec2i {
  if (FU.bending == 0u) { return px; }
  let bend = refract(rd, n, eta);
  if (dot(bend, face) >= 0.0) { return px; }
  let clip = OP.eyeToClip * vec4f(eyeToHit + bend * min(cells, 12.0), 1.0);
  if (clip.w <= 0.0) { return px; }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return px; }
  let dst = vec2i(uv * OP.inSize);
  let dstZ = textureLoad(tOpaqueDepth, dst, 0);
  if (dstZ <= z) { return px; }
  // Also test the geometric face plane: at grazing angles an offset pixel's
  // ray can meet that interface farther away than the original ray did.
  var side = 0.0;
  if (dstZ < 1.0) {
    let h = OP.clipToEye * vec4f(overlayNdc(dst), dstZ, 1.0);
    side = dot(face, h.xyz - eyeToHit * h.w);
  }
  return select(px, dst, overlayBehind(dstZ, z, side));
}
fn overlayFresnel(cosine: f32, f0: f32) -> f32 {
  let a = 1.0 - clamp(cosine, 0.0, 1.0);
  return f0 + (1.0 - f0) * a * a * a * a * a;
}
// Isotropic GGX with correlated Smith visibility (gfx/lighting.js), times n·l.
fn overlayGlint(n: vec3f, v: vec3f, rough: f32, f0: f32) -> f32 {
  let l = FU.sun;
  let nl = dot(n, l);
  if (nl <= 0.0) { return 0.0; }
  let h = normalize(v + l);
  let nv = max(dot(n, v), 1e-4);
  let nh = clamp(dot(n, h), 0.0, 1.0);
  let a2 = pow(max(rough, 0.075), 4.0);
  let d = nh * nh * (a2 - 1.0) + 1.0;
  let vis = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2));
  return a2 / (d * d) * vis * overlayFresnel(dot(v, h), f0) * nl;  // PI cancels sunCol's /PI
}

// Joint bilateral upsample (Bavoil/Cantlay): spatial 2x2 tent, with depth
// rejection across silhouettes. No compatible depth means no borrowed fog.
fn overlayMedia(px: vec2i, z: f32) -> vec4f {
  let q = overlayMediaCoord(px);
  let base = vec2i(q);
  let f = fract(q);
  let hi = vec2i(ceil(OP.inSize * 0.5)) - 1;
  let w = OP.clipToEye[3].w + OP.clipToEye[2].w * z;
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var i = 0; i < 4; i++) {
    let o = vec2i(i & 1, i >> 1u);
    let tent = select(1.0 - f, f, o != vec2i(0));
    if (tent.x * tent.y == 0.0) { continue; }
    let h = min(base + o, hi);
    let tapZ = textureLoad(tOpaqueDepth, overlayMediaRep(h), 0);
    let tapW = OP.clipToEye[3].w + OP.clipToEye[2].w * tapZ;
    let k = tent.x * tent.y * overlayDepthWeight(w, tapW, z == 1.0, tapZ == 1.0);
    if (k > 0.0) { sum += k * textureLoad(tMediaHalf, h, 0); total += k; }
  }
  if (total > 0.0) { return sum / total; }
  return vec4f(0.0, 0.0, 0.0, 1.0);
}

struct OverlayOutput { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
@fragment fn fs(in: FullScreen) -> OverlayOutput {
  let px = vec2i(in.position.xy);
  let opaque = textureLoad(tOpaqueColor, px, 0);
  let z = textureLoad(tOpaqueDepth, px, 0);
  let ray = overlayRay(px, z);
  let hit = overlayTrace(ray);
  let media = overlayMedia(px, z);
  if (hit.id == E_EMPTY) { return OverlayOutput(vec4f(opaque.rgb * media.a + media.rgb, opaque.a), z); }

  let eyeToHit = ray.rd * hit.t;
  let p = OP.eye + eyeToHit;
  let glass = RCLASS(hit.id) == R_GLASS;
  let water = hit.id == E_WATER || hit.id == E_SALTWATER;
  let startedInside = hit.ax < 0;
  let face = select(-ray.rd, -sign(ray.rd) * vec3f(axisMask(hit.ax)), !startedInside);
  let zFront = clipDepth(OP.eyeToClip * vec4f(eyeToHit, 1.0));
  let cells = max(hit.exit - hit.t, 0.0);
  let ior = IOR(hit.id);
  var n = face;
  if (!glass && !startedInside) { n = overlayLiquidNormal(hit.c, p, face, ray.rd, water); }
  let up = vec3f(0.0, 1.0, 0.0);
  LM = LC;
  let probe = overlayProbe(p + n * 0.5);
  let sunVis = overlaySun(p, n);
  let ambient = lmIrradiance(probe, up) + FU.caveAmbient;
  let light = ambient + FU.sunCol * sunVis * max(FU.sun.y, 0.0);
  let att = overlayAttenuation(SIGMA(hit.id), cells);
  var background = opaque.rgb;
  if (!startedInside) {
    let dst = overlayBend(px, eyeToHit, ray.rd, n, face, 1.0 / ior, cells, zFront);
    if (any(dst != px)) { background = textureLoad(tOpaqueColor, dst, 0).rgb; }
  }
  var color = background * att;
  if (!glass) { color += (1.0 - att) * SCATALB(hit.id) * light; }
  if (!startedInside) {
    let r = reflect(ray.rd, n);
    let sky = mix(FU.ground, FU.skyUp, clamp(0.5 + 0.5 * r.y, 0.0, 1.0));
    let skySH = LM_SH_Y0 * probe.c0.a + LM_SH_COS1 * LM_SH_Y1 * dot(vec3f(probe.cx.a, probe.cy.a, probe.cz.a), r);
    let skyVis = clamp(skySH / max(0.5 + 0.5 * r.y, 0.2), 0.0, 1.0);
    let gi = max(LM_SH_Y0 * probe.c0.rgb + LM_SH_Y1 * (probe.cx.rgb * r.x + probe.cy.rgb * r.y + probe.cz.rgb * r.z), vec3f(0.0));
    let env = mix(gi + FU.caveAmbient, sky, skyVis);
    let f = (1.0 - ior) / (1.0 + ior);
    let f0 = f * f;
    color = mix(color, env, overlayFresnel(dot(n, -ray.rd), f0));
    color += FU.sunCol * sunVis * overlayGlint(n, -ray.rd, ROUGH(hit.id), f0);
    if (water && face.y > 0.0 && z < 1.0) {
      let shallow = 1.0 - smoothstep(0.1, 1.4, cells * abs(ray.rd.y));
      color = mix(color, 0.85 * light, 0.24 * shallow);
    }
  }
  return OverlayOutput(vec4f(color * media.a + media.rgb, opaque.a), select(min(z, zFront), z, startedInside));
}
`;

export const WGSL_CHECK = [
  { name: 'mediaHalf', code: mediaHalfWGSL, group2: MEDIA_HALF_LAYOUT, fragment: { targets: [{ format: 'rgba16float' }] } },
  { name: 'opticsOverlay', code: opticsOverlayWGSL, group2: OPTICS_OVERLAY_LAYOUT, fragment: { targets: [{ format: 'rgba16float' }] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } },
].map(({ group2, ...spec }) => ({ ...spec, kind: 'render', layouts: () => [RENDER_LAYOUT.FRAME, WORLD_COPY_LAYOUT, group2] }));
