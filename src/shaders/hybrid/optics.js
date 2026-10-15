import { prelude, STATE_OPTS, LAYOUT, STAGE } from '../common.js';
import { frameBindings } from '../bindings.js';
import { materialsGLSL, THIN_RADIUS } from '../../gfx/materials.js';
import { particleOwnershipWGSL, instanceWGSL, particleChannelWGSL } from './particles.js';
import { uniformStruct } from '../../gpu/params.js';

/** Per-pixel validity bits. Zero means supported, not 'no optical coverage'. */
export const OPTICS_FALLBACK = Object.freeze({
  UNDERWATER: 1, MIXED_MEDIA: 2, BUDGET: 4, MESH: 8,
  APPEARANCE: 16, SMOOTH_BACKGROUND: 32, OUTSIDE_MEDIUM: 64, SURFACE: 128, MEDIA: 256,
});
export const OpticsParams = uniformStruct('OpticsParams', {
  gridInv: 'mat4x4f', size: 'vec2f', unsupported: 'u32', depthTolerance: 'f32', world: 'u32', particleSplit: 'u32',
});
export const opticsBindings = (binding = 0) => [
  { binding, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: binding + 1, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d' } },
];
export const opticsEntries = (color, depth, binding = 0) => [
  { binding, resource: color.createView() }, { binding: binding + 1, resource: depth.createView() },
];
export const OPTICS_STATE_LAYOUT = LAYOUT.STATE_RO;

export const opticsClassWGSL = `fn opticsClass(id: i32) -> i32 {
  if (SURFCH(id) == CH_MOLTEN) { return 2; }
  if (SURFCH(id) == CH_LIQUID || RCLASS(id) == R_GLASS) { return 1; }
  return 0;
}`;
const boundsStruct = `struct OpticalBounds { lo: vec3u, count: u32, hi: vec3u, pad: u32 }`;
export const opticsBoundsLayout = [0, 1].map(binding => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }));
/** Two WG64 reductions. No per-cell global atomics and no CPU count readback. */
export function opticsBoundsShader(g, { particles = false, world = false } = {}) {
  return `${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${opticsClassWGSL}
${particleOwnershipWGSL}
${boundsStruct}
@group(2) @binding(0) var<storage, read_write> bricks: array<OpticalBounds>;
@group(2) @binding(1) var<storage, read_write> bounds: OpticalBounds;
var<workgroup> lows: array<vec3u, 64>;
var<workgroup> highs: array<vec3u, 64>;
var<workgroup> counts: array<u32, 64>;
fn reduceBounds(li: u32) {
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      lows[li] = min(lows[li], lows[li+stride]);
      highs[li] = max(highs[li], highs[li+stride]);
      counts[li] += counts[li+stride];
    }
    workgroupBarrier();
  }
}
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u,
  @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let brick = wg.x + wg.y * nwg.x;
  if (brick >= ${g.nbricks}u) { return; }
  let slot = brick * 64u + li;
  lows[li] = vec3u(vec3i(NX, NY, NZ)); highs[li] = vec3u(0); counts[li] = 0u;
  let c = cellOf(slot);
  if (inGrid(c) && opticsClass(eid(fetchAs(slot))) != 0 ${particles ? `&& !hybridParticleOwns(c, ${world})` : ''}) {
    lows[li] = vec3u(c); highs[li] = vec3u(c) + vec3u(1); counts[li] = 1u;
  }
  reduceBounds(li);
  if (li == 0u) { bricks[brick] = OpticalBounds(lows[0], counts[0], highs[0], 0u); }
}
@compute @workgroup_size(64) fn finish(@builtin(local_invocation_index) li: u32) {
  lows[li] = vec3u(vec3i(NX, NY, NZ)); highs[li] = vec3u(0); counts[li] = 0u;
  for (var i = li; i < ${g.nbricks}u; i += 64u) {
    lows[li] = min(lows[li], bricks[i].lo); highs[li] = max(highs[li], bricks[i].hi);
    counts[li] += bricks[i].count;
  }
  reduceBounds(li);
  if (li == 0u) {
    bounds = OpticalBounds(vec3u(max(vec3i(lows[0])-vec3i(2), vec3i(0))), counts[0],
      min(highs[0]+vec3u(2), vec3u(vec3i(NX, NY, NZ))), 0u);
  }
}`;
}

/**
 * Extension ABI (group 2 bindings >= 2; return entries/layout from your owner).
 * OpticalHit: position/normal in grid cells; id, state A (temperature .y,
 * ctype+seed .w), view is unit grid direction TOWARD viewer.
 * opticsWorldHit(h) -> vec3f: hidden/offscreen opaque hits including sand;
 * required by createHybridOptics. No primary-renderer invocation or recursion.
 * opticsEnvironment(p, direction, roughness) -> vec3f: reflected/escaped light.
 * opticsBody(p, id) -> vec3f: incident light for SCATALB, not emission.
 * opticsSurface(h) -> vec3f: normal facing incident ray; hemisphere enforced.
 * opticsMediaSegment(ro, rd, near, far) -> vec4f: premultiplied in-air media
 * segment, alpha=1-transmission. Invoked only AFTER optical entry, outside
 * liquids; parent integrates front media only to metadata.x. Without a hook,
 * the default integrates cell gas extinction with mean body illumination.
 * Shared material adapter: hybridMaterial(h.id, fract(h.state.w), h.position,
 * h.normal, h.state.y); floor(h.state.w) preserves molten ctype.
 * Supply any/all function bodies via `hooks` (same keys), declarations via wgsl.
 * These defaults are deterministic sun/sky means, not the shared PBR/GI model.
 */
export const OPTICS_DEFAULT_HOOKS = Object.freeze({
  worldHit: `fn opticsWorldHit(h: OpticalHit) -> vec3f {
    return ALBEDO(h.id) * (max(FU.skyUp, FU.caveAmbient) + FU.sunCol * max(dot(h.normal, FU.sun), 0.0))
      + EMIT(h.id) + incandescence(h.state.y);
  }`,
  environment: `fn opticsEnvironment(p: vec3f, direction: vec3f, roughness: f32) -> vec3f {
    return mix(FU.ground, FU.skyUp, clamp(direction.y * 0.5 + 0.5, 0.0, 1.0)) + FU.caveAmbient;
  }`,
  body: `fn opticsBody(p: vec3f, id: i32) -> vec3f { return max(FU.skyUp, FU.caveAmbient) + FU.sunCol * 0.25; }`,
  surface: `fn opticsSurface(h: OpticalHit) -> vec3f { return h.normal; }`,
  mediaSegment: `fn opticsMediaSegment(ro: vec3f, rd: vec3f, near: f32, far: f32) -> vec4f {
    let q = vec3i(floor(ro + rd * ((near + far) * 0.5)));
    if (!inGrid(q)) { return vec4f(0.0); }
    let a = fetchA(q); let id = eid(a);
    if (id == E_EMPTY || KIND(id) != K_GAS) { return vec4f(0.0); }
    let sigma = max(SIGMA(id), vec3f(0.0));
    let alpha = 1.0 - exp(-max(sigma.x, max(sigma.y, sigma.z)) * max(0.0, far-near));
    return vec4f(alpha * (SCATALB(id) * opticsBody(ro, id) + EMIT(id) + incandescence(a.y)), alpha);
  }`,
});

/** Optional derived field ABI: two unfilterable 3D sampled textures, no sampler
 * or storage additions. Freudenthal-linear interpolation of all fieldSurf channels at
 * texel centres (same tetrahedra as hybrid smooth extraction), iso=0.5.
 * fieldThin.x blends toward the cell normal for boosted thin features; it is
 * a mask, NOT an extra density. Cell and tetra exits are always visited. */
export const opticsFieldBindings = (binding = 2) => [0, 1].map(i => ({
  binding: binding + i, visibility: STAGE.FRAGMENT,
  texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
}));
export function opticalFieldsWGSL(binding = 2) {
  return /* wgsl */ `
@group(2) @binding(${binding}) var opticsSurf: texture_3d<f32>;
@group(2) @binding(${binding + 1}) var opticsThin: texture_3d<f32>;
fn opticsPhi(q: vec3i, ch: i32) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  return textureLoad(opticsSurf, q, 0)[ch];
}
// Descending fractional-coordinate order identifies the Freudenthal tetra.
fn opticsDensity(p: vec3f, ch: i32) -> f32 {
  let q = vec3i(floor(p - vec3f(0.5)));
  let f = fract(p - vec3f(0.5));
  var axes = array<i32, 3>(0, 1, 2);
  for (var i = 0; i < 2; i++) { for (var j = i + 1; j < 3; j++) {
    if (f[axes[j]] > f[axes[i]]) { let tmp = axes[i]; axes[i] = axes[j]; axes[j] = tmp; }
  } }
  var a = q; a[axes[0]] += 1;
  var b = a; b[axes[1]] += 1;
  return opticsPhi(q, ch) * (1.0 - f[axes[0]]) + opticsPhi(a, ch) * (f[axes[0]] - f[axes[1]])
    + opticsPhi(b, ch) * (f[axes[1]] - f[axes[2]]) + opticsPhi(q + vec3i(1), ch) * f[axes[2]];
}
// Exact gradient of the same affine tetra used for density, not a voxel normal.
fn opticsFieldNormal(p: vec3f, cellNormal: vec3f, ch: i32) -> vec3f {
  let q = vec3i(floor(p - vec3f(0.5))); let f = fract(p - vec3f(0.5));
  var axes = array<i32, 3>(0, 1, 2);
  for (var i = 0; i < 2; i++) { for (var j = i+1; j < 3; j++) {
    if (f[axes[j]] > f[axes[i]]) { let t = axes[i]; axes[i] = axes[j]; axes[j] = t; }
  } }
  var a = q; a[axes[0]] += 1; var b = a; b[axes[1]] += 1;
  var gradient = vec3f(0);
  gradient[axes[0]] = opticsPhi(q,ch)-opticsPhi(a,ch);
  gradient[axes[1]] = opticsPhi(a,ch)-opticsPhi(b,ch);
  gradient[axes[2]] = opticsPhi(b,ch)-opticsPhi(q+vec3i(1),ch);
  if (dot(gradient,gradient) < 1e-12) { return cellNormal; }
  let n = normalize(gradient);
  let qthin = clamp(vec3i(floor(p)), vec3i(0), vec3i(NX-1,NY-1,NZ-1));
  let thin = clamp(textureLoad(opticsThin, qthin, 0)[ch], 0.0, 1.0);
  if (ch == CH_LIQUID && dot(n,cellNormal) > 0.0) { return normalize(mix(n,cellNormal,thin*0.5)); }
  return n;
}
fn opticsFieldState(p: vec3f, cellState: vec4f) -> vec4f {
  let id = eid(cellState); let cell = vec3i(floor(p));
  // Crisp solids and exact isolated spheres are not bulk density.
  if (id != E_EMPTY && KIND(id) != K_GAS && SURFCH(id) < 0) { return cellState; }
  if (opticsParticleOwns(cell, P.world != 0u)) {
    if (distance(p, vec3f(cell)+vec3f(0.5)) <= ${THIN_RADIUS}) { return cellState; }
  }
  var best = 1e20; var source = vec4f(0.0);
  let base = vec3i(floor(p));
  var density = vec4f(0);
  for (var ch = 0; ch < 4; ch++) { density[ch] = opticsDensity(p, ch); }
  // Live sources within field support; stale EMA alone is never matter.
  for (var z = -2; z <= 2; z++) { for (var y = -2; y <= 2; y++) { for (var x = -2; x <= 2; x++) {
    let q = base + vec3i(x,y,z);
    if (inGrid(q)) {
      let a = fetchA(q); let ch = SURFCH(eid(a));
      if (ch >= 0 && ch < 4) {
        let delta = vec3f(q)+vec3f(0.5)-p; let d = dot(delta,delta);
        if (density[ch] >= 0.5 && d < best && !opticsParticleOwns(q, P.world != 0u)) { best = d; source = a; }
      }
    }
  } } }
  return source;
}
fn opticsFieldSegment(p: vec3f, rd: vec3f, cellExit: f32) -> f32 {
  // Split at every interpolation-cube face and tetra diagonal. Within that
  // interval density is affine: its single possible root is solved exactly.
  let probe = p + rd * OPTICS_EPS;
  let base = floor(probe - vec3f(0.5));
  var end = cellExit;
  for (var i = 0; i < 3; i++) {
    if (abs(rd[i]) > 1e-8) {
      let face = base[i] + 0.5 + select(0.0, 1.0, rd[i] > 0.0);
      let t = (face - p[i]) / rd[i];
      if (t > OPTICS_EPS * 0.5) { end = min(end, t); }
    }
    for (var j = i + 1; j < 3; j++) {
      let slope = rd[i] - rd[j];
      if (abs(slope) > 1e-8) {
        let t = (base[i] - base[j] - p[i] + p[j]) / slope;
        if (t > OPTICS_EPS * 0.5) { end = min(end, t); }
      }
    }
  }
  let tetraEnd = end;
  for (var ch = 0; ch < 4; ch++) {
    let startPhi = opticsDensity(p, ch) - 0.5;
    let endPhi = opticsDensity(p + rd * tetraEnd, ch) - 0.5;
    if (abs(endPhi - startPhi) > 1e-8) {
      let root = -startPhi * tetraEnd / (endPhi - startPhi);
      if (root > OPTICS_EPS * 0.5 && root < end) { end = root; }
    }
  }
  return end;
}
`;
}

export function opticsShader(g, { maxSteps = 256, maxInterfaces = 8, fieldBinding = null, boundsBinding = null, particleBinding = null, wgsl = '', hooks = {}, binding = 0 } = {}) {
  for (const [name, n, limit] of [['maxSteps', maxSteps, 2048], ['maxInterfaces', maxInterfaces, 32]]) {
    if (!Number.isInteger(n) || n < 1 || n > limit) throw new RangeError(`${name} must be in 1..${limit}`);
  }
  return /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${frameBindings()}
${OpticsParams.wgsl}
@group(3) @binding(1) var<uniform> P: OpticsParams;
@group(2) @binding(${binding}) var opticsColor: texture_2d<f32>;
@group(2) @binding(${binding + 1}) var opticsDepth: texture_depth_2d;
const OPTICS_EPS: f32 = 0.0001;
const OPTICS_FAR: f32 = 1e20;
struct OpticalHit { position: vec3f, normal: vec3f, id: i32, state: vec4f, view: vec3f }
${boundsBinding === null ? '' : `${boundsStruct}
@group(2) @binding(${boundsBinding}) var<storage, read> opticalBounds: OpticalBounds;`}
${particleOwnershipWGSL}
fn opticsParticleOwns(c: vec3i, world: bool) -> bool {
  return hybridParticleOwns(c, world) && (P.particleSplit != 0u || SURFCH(eid(fetchA(c))) >= 2);
}
${particleBinding === null ? '' : `${instanceWGSL}
${particleChannelWGSL}
@group(2) @binding(${particleBinding}) var<storage, read> drops: array<HybridParticle>;`}
${fieldBinding === null ? '' : opticalFieldsWGSL(fieldBinding)}
${wgsl}
${Object.entries(OPTICS_DEFAULT_HOOKS).map(([key, value]) => hooks[key] ?? value).join('\n')}
${opticsClassWGSL}
// Bounded interval of the real cell-centred isolated sphere.
fn opticsSphere(p: vec3f, rd: vec3f, center: vec3f) -> vec2f {
  let q = p-center; let b = dot(q, rd); let d = b*b-dot(q,q)+${THIN_RADIUS * THIN_RADIUS};
  if (d < 0.0) { return vec2f(OPTICS_FAR, -OPTICS_FAR); }
  let root = sqrt(d); return vec2f(-b-root, -b+root);
}
fn opticsFresnel(cosine: f32, fromIOR: f32, toIOR: f32) -> f32 {
  if (fromIOR == toIOR) { return 0.0; }
  let eta = fromIOR / toIOR;
  if (eta * eta * (1.0 - cosine * cosine) >= 1.0) { return 1.0; }
  let f0 = ((fromIOR - toIOR) / (fromIOR + toIOR)) * ((fromIOR - toIOR) / (fromIOR + toIOR));
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
}
// Slab intersection handles parallel rays without 0*infinity or sign(0).
fn opticsBox(ro: vec3f, rd: vec3f, lower: vec3f, upper: vec3f) -> vec2f {
  var lo = 0.0; var hi = OPTICS_FAR;
  for (var axis = 0; axis < 3; axis++) {
    if (abs(rd[axis]) < 1e-8) {
      if (ro[axis] < lower[axis] || ro[axis] >= upper[axis]) { return vec2f(1.0, -1.0); }
    } else {
      let a = (lower[axis] - ro[axis]) / rd[axis];
      let b = (upper[axis] - ro[axis]) / rd[axis];
      lo = max(lo, min(a, b)); hi = min(hi, max(a, b));
    }
  }
  return vec2f(lo, hi);
}
fn opticsGridAt(uv: vec2f, depth: f32) -> vec3f {
  let q = P.gridInv * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return q.xyz / q.w;
}
fn opticsClip(p: vec3f) -> vec4f { return FU.viewProj * FU.model * vec4f(p, 1.0); }
fn opticsPixel(clip: vec4f) -> vec2i {
  return vec2i(floor((clip.xy / clip.w * vec2f(0.5, -0.5) + 0.5) * P.size));
}
// Returns -1 when no depth-validated camera sample exists: never substitute
// the original camera background for a hidden or offscreen refracted hit.
fn opticsSnapshot(h: OpticalHit) -> vec4f {
  let clip = opticsClip(h.position);
  if (clip.w <= 0.0 || clip.z < 0.0 || clip.z >= clip.w) { return vec4f(-1.0); }
  let px = opticsPixel(clip);
  if (any(px < vec2i(0)) || any(px >= vec2i(P.size))) { return vec4f(-1.0); }
  let d = textureLoad(opticsDepth, px, 0);
  if (d >= 1.0) { return vec4f(-1.0); }
  let q = opticsGridAt((vec2f(px) + 0.5) / P.size, d);
  if (distance(q, h.position) > P.depthTolerance) { return vec4f(-1.0); }
  return textureLoad(opticsColor, px, 0);
}
// Molten is an optical-owned opaque surface, not transparent lava. Preserve
// the existing mean crust/skin temperature and Kirchhoff emissivity model.
fn opticsMoltenEmission(a: vec4f) -> vec3f {
  var ct = i32(floor(a.w));
  if (ct <= 0 || ct >= NE || MELT(ct) <= 0.0) { ct = E_STONE; }
  let solidus = MELT(ct) - LAVA_FREEZE_BELOW;
  let crust = 1.0 - smoothstep(0.2, 0.8, (a.y - solidus) / 450.0);
  let crack = min(1.6 * mix(0.04, 1.0, (1.0 - crust) * (1.0 - crust)), 1.0);
  let top = mix(a.y, min(a.y, 450.0 + 0.8 * (a.y - solidus)), crust);
  let f0 = pow((IOR(E_LAVA) - 1.0) / (IOR(E_LAVA) + 1.0), 2.0);
  let emissivity = 1.0 - clamp(dot(mix(vec3f(f0) + (1.0 - f0) * ALBEDO(E_LAVA), ALBEDO(E_LAVA), METAL(E_LAVA)), LUMA_709), 0.0, 1.0);
  return emissivity * mix(incandescence(top), incandescence(a.y), crack) + EMIT(E_LAVA);
}
struct OpticsVertex { @builtin(position) position: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> OpticsVertex {
  var v: OpticsVertex;
  v.position = vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
  return v;
}
struct OpticsOutput {
  @location(0) color: vec4f,
  // first interface device depth (1 if absent), true optical path thickness
  // in cells, remaining max RGB transmission, interface count (reactive).
  @location(1) metadata: vec4f,
  @location(2) fallback: u32,
}
fn opticsTrace(v: OpticsVertex, forced: bool, source: vec4f, entry: f32) -> OpticsOutput {
  let px = vec2i(v.position.xy);
  let original = textureLoad(opticsColor, px, 0);
  var out: OpticsOutput;
  out.color = original; out.metadata = vec4f(1.0, 0.0, 1.0, 0.0); out.fallback = 0u;
  let uv = v.position.xy / P.size;
  var rd = normalize(opticsGridAt(uv, 0.5) - FU.cam);
  ${boundsBinding === null ? '' : 'if (!forced && opticalBounds.count == 0u) { return out; }'}
  var interval = opticsBox(FU.cam, rd, ${boundsBinding === null ? 'vec3f(0), vec3f(vec3i(NX, NY, NZ))' : 'vec3f(opticalBounds.lo), vec3f(opticalBounds.hi)'});
  if (forced) { interval = vec2f(entry, OPTICS_FAR); }
  if (interval.y < interval.x) { return out; }
  let sceneDepth = textureLoad(opticsDepth, px, 0);
  var cut = OPTICS_FAR;
  if (sceneDepth < 1.0) { cut = max(0.0, dot(opticsGridAt(uv, sceneDepth) - FU.cam, rd)); }
  if (interval.x >= cut) { return out; }
  var p = FU.cam + rd * interval.x;
  var traveled = interval.x;
  var normal = vec3f(0.0);
  // Grid entry face; ties are deterministic, as are cell edge crossings.
  let edge = min(abs(p), abs(vec3f(vec3i(NX, NY, NZ)) - p));
  var entryAxis = 0;
  if (edge.y < edge[entryAxis]) { entryAxis = 1; }
  if (edge.z < edge[entryAxis]) { entryAxis = 2; }
  normal[entryAxis] = -sign(rd[entryAxis]);
  var medium = E_EMPTY;
  var previous = vec4f(0.0);
  var sum = vec3f(0.0); var transmission = vec3f(1.0);
  var covered = false; var bent = false;
  var interfaces = 0; var thickness = 0.0;
  var complete = false;
  // Eye starts own their full submerged path; front screen media has zero extent.
  let eyeCell = vec3i(floor(FU.cam));
  if (inGrid(eyeCell) && opticsClass(eid(fetchA(eyeCell))) != 0) {
    previous = fetchA(eyeCell);
    medium = eid(previous);
    if (opticsClass(medium) == 1) { covered = true; bent = true; out.metadata.x = 0.0; }
    else { medium = E_EMPTY; }
  }
  ${fieldBinding === null ? '' : `if (inGrid(eyeCell)) {
    previous = opticsFieldState(FU.cam, fetchA(eyeCell)); medium = eid(previous);
    if (opticsClass(medium) == 1) { covered = true; bent = true; out.metadata.x = 0.0; }
    else { medium = E_EMPTY; covered = false; bent = false; out.metadata.x = 1.0; }
  }`}
  if (P.particleSplit != 0u && opticsParticleOwns(eyeCell, P.world != 0u) && !forced) {
    medium = E_EMPTY; covered = false; bent = false; out.metadata.x = 1.0;
  }
  if (forced) {
    medium = E_EMPTY; previous = vec4f(0); covered = false; bent = false; out.metadata.x = 1.0;
    if (entry == 0.0 && opticsClass(eid(source)) == 1) {
      previous = source; medium = eid(source); covered = true; bent = true; out.metadata.x = 0.0;
    }
  }
  // Pre-entry traversal must not silently omit distant optical cells. A straight
  // ray crosses a bounded number of cell/cube/tetra planes and four-channel
  // iso roots across the grid (64 per summed axis extent is conservative). The
  // user path budget starts at first entry, not at the camera/grid boundary.
  var pathSteps = 0;
  for (var step = 0; step < ${maxSteps} + 64 * (NX + NY + NZ); step++) {
    if (!covered && traveled >= interval.y) { return out; }
    if (covered) { if (pathSteps >= ${maxSteps}) { break; } pathSteps++; }
    let cell = vec3i(floor(p + rd * OPTICS_EPS));
    var a = vec4f(0.0); var id = E_EMPTY;
    if (inGrid(cell)) { a = fetchA(cell); id = eid(a); }
    let particle = opticsParticleOwns(cell, P.world != 0u);
    let sphere = opticsSphere(p, rd, vec3f(cell)+vec3f(0.5));
    let particleHit = particle && sphere.x <= OPTICS_EPS && sphere.y > OPTICS_EPS;
    if (particle) {
      let delta = p - (vec3f(cell)+vec3f(0.5));
      if (dot(delta,delta) > 1e-12) {
        normal = normalize(delta);
        if (dot(normal,rd) > 0.0) { normal = -normal; }
      }
      if (particleHit) {
        if (dot(delta,delta) <= 1e-12) { normal = -rd; }
      } else { a = vec4f(0); id = E_EMPTY; }
    }
    ${fieldBinding === null ? '' : `if (inGrid(cell)) { a = opticsFieldState(p + rd * OPTICS_EPS, a); id = eid(a); }
    let ch = select(SURFCH(medium), SURFCH(id), SURFCH(id) >= 0);
    if (!particleHit && ch >= 0 && ch < 4 && abs(opticsDensity(p, ch) - 0.5) < 0.001) {
      let fnormal = opticsFieldNormal(p + rd * OPTICS_EPS, normal, ch);
      if (dot(fnormal, fnormal) > 1e-8) { normal = normalize(fnormal); if (dot(normal, rd) > 0.0) { normal = -normal; } }
    }`}
    if (forced && step == 0) { a = source; id = eid(source); }
    if (particle && P.particleSplit != 0u && !forced && !bent && SURFCH(eid(fetchA(cell))) < 2) {
      a = vec4f(0); id = E_EMPTY;
    }
    let gas = id != E_EMPTY && KIND(id) == K_GAS;
    if (gas) { id = E_EMPTY; }
    let optical = opticsClass(id);
    if (medium != id && (medium != E_EMPTY || optical == 1) && (id == E_EMPTY || optical == 1)) {
      covered = true;
      if (out.metadata.x == 1.0) { let clip = opticsClip(p); out.metadata.x = clamp(clip.z / clip.w, 0.0, 1.0); }
      if (interfaces >= ${maxInterfaces}) { break; }
      let entering = medium == E_EMPTY;
      let lid = select(medium, id, entering);
      let state = select(previous, a, entering);
      let fromIOR = select(IOR(medium), 1.0, medium == E_EMPTY);
      let toIOR = select(IOR(id), 1.0, id == E_EMPTY);
      var n = opticsSurface(OpticalHit(p, normal, lid, state, -rd));
      if (dot(n, n) < 1e-8) { n = normal; } else { n = normalize(n); }
      let candidate = refract(rd, n, fromIOR / toIOR);
      if (dot(n, normal) <= 0.0 || dot(rd, n) >= 0.0 || dot(reflect(rd, n), normal) <= 0.0
          || (dot(candidate, candidate) > 1e-8 && dot(candidate, normal) >= 0.0)) { n = normal; }
      let f = opticsFresnel(clamp(-dot(rd, n), 0.0, 1.0), fromIOR, toIOR);
      interfaces++;
      if (f >= 1.0) {
        // TIR follows its actual reflected path within this medium; no energy
        // goes into an outside environment and no recursion is introduced.
        rd = reflect(rd, n); bent = true; continue;
      }
      sum += transmission * f * opticsEnvironment(p, reflect(rd, n), ROUGH(lid));
      transmission *= 1.0 - f;
      rd = normalize(refract(rd, n, fromIOR / toIOR)); bent = true;
      medium = id; previous = a;
      // Restart at the exact face; EPS chooses the cell only, not thickness.
      continue;
    }
    if (!inGrid(cell)) {
      if (covered) { sum += transmission * opticsEnvironment(p, rd, 0.0); }
      complete = true; break;
    }
    if (RCLASS(id) == R_GLASS && optical == 0) { out.fallback |= ${OPTICS_FALLBACK.SURFACE}u; break; }
    if (id != E_EMPTY && optical == 0 && bent) {
      // Snapshot if visible, otherwise the dedicated world-hit shading hook.
      let h = OpticalHit(p, normal, id, a, -rd);
      let snapshot = opticsSnapshot(h);
      if (snapshot.x >= 0.0) { sum += transmission * snapshot.rgb; }
      else { sum += transmission * opticsWorldHit(h); }
      complete = true; break;
    }
    if (optical == 2) {
      covered = true;
      let clip = opticsClip(p); out.metadata.x = min(out.metadata.x, clamp(clip.z / clip.w, 0.0, 1.0));
      let h = OpticalHit(p, normal, id, a, -rd);
      sum += transmission * (ALBEDO(id) * opticsBody(p, id) + opticsMoltenEmission(a));
      transmission = vec3f(0.0); complete = true; break;
    }
    // Exact cell-exit DDA; all tied axes advance through floor(p+rd*EPS).
    var exits = vec3f(OPTICS_FAR);
    for (var axis = 0; axis < 3; axis++) {
      if (abs(rd[axis]) > 1e-8) {
        let face = f32(cell[axis]) + select(0.0, 1.0, rd[axis] > 0.0);
        exits[axis] = max(0.0, (face - p[axis]) / rd[axis]);
      }
    }
    var axis = 0;
    if (exits.y < exits[axis]) { axis = 1; }
    if (exits.z < exits[axis]) { axis = 2; }
    var segment = exits[axis];
    if (particle && sphere.x > OPTICS_EPS * 0.5) { segment = min(segment, sphere.x); }
    if (particle && sphere.y > OPTICS_EPS * 0.5) { segment = min(segment, sphere.y); }
    ${fieldBinding === null ? '' : 'segment = opticsFieldSegment(p, rd, segment);'}
    // Immutable opaque depth bounds the original eye path only. Reusing its
    // scalar distance AFTER refraction would clip unrelated world geometry.
    if (!bent) { segment = min(segment, max(0.0, cut - traveled)); }
    if (medium != E_EMPTY) {
      let t = exp(-max(SIGMA(medium), vec3f(0.0)) * segment);
      let body = SCATALB(medium) * opticsBody(p + rd * (segment * 0.5), medium)
        + EMIT(medium) + incandescence(a.y);
      sum += transmission * (1.0 - t) * body;
      transmission *= t; thickness += segment;
    }
    if (bent && medium == E_EMPTY) {
      let media = opticsMediaSegment(p, rd, 0.0, segment);
      sum += transmission * media.rgb;
      transmission *= 1.0 - clamp(media.a, 0.0, 1.0);
    }
    previous = a;
    p += rd * segment; traveled += segment;
    normal = vec3f(0.0); normal[axis] = -sign(rd[axis]);
    if (!bent && traveled >= cut) {
      if (covered) { sum += transmission * original.rgb; }
      complete = true; break;
    }
  }
  // Explicit bounded tail: remaining throughput sees only the environment.
  // No unvisited cells are claimed to be traced and no legacy color is required.
  if (!complete && covered && out.fallback == 0u) { sum += transmission * opticsEnvironment(p, rd, 1.0); }

  if (covered) {
    out.fallback |= P.unsupported;
    out.metadata.y = thickness;
    out.metadata.z = max(transmission.x, max(transmission.y, transmission.z));
    out.metadata.w = f32(interfaces);
    if (out.fallback == 0u) { out.color = vec4f(max(sum, vec3f(0.0)), 1.0); }
  }
  return out;
}
@fragment fn fs(v: OpticsVertex) -> OpticsOutput { return opticsTrace(v, false, vec4f(0), 0.0); }
${particleBinding === null ? '' : dropEntriesWGSL}
`;
}

// Project the enclosing cube, not a guessed screen radius. If any corner
// crosses the eye/near plane, fullscreen is the conservative candidate.
const dropEntriesWGSL = `
struct DropVertex { @builtin(position) position: vec4f, @location(0) @interpolate(flat) index: u32 }
@vertex fn dropVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> DropVertex {
  let d = drops[ii];
  var lo = vec2f(1); var hi = vec2f(-1); var full = false;
  for (var k = 0u; k < 8u; k++) {
    let offset = vec3f(f32(k&1u), f32((k>>1u)&1u), f32((k>>2u)&1u))*2.0-1.0;
    let c = opticsClip(d.center + offset * ${THIN_RADIUS});
    if (c.w <= 0.0001 || c.z <= 0.0) { full = true; }
    else { lo = min(lo,c.xy/c.w); hi = max(hi,c.xy/c.w); }
  }
  if (full) { lo = vec2f(-1); hi = vec2f(1); }
  let corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  var o: DropVertex;
  o.position = vec4f(mix(lo,hi,corners[vi]),0,1); o.index = ii;
  if (hpChannel(d.id) >= 2) { o.position = vec4f(2,2,2,1); }
  return o;
}
struct DropOutput {
  @location(0) color: vec4f, @location(1) metadata: vec4f,
  @location(2) fallback: u32, @builtin(frag_depth) depth: f32,
}
@fragment fn dropFS(v: DropVertex) -> DropOutput {
  let d = drops[v.index];
  let rd = normalize(opticsGridAt(v.position.xy / P.size,0.5)-FU.cam);
  let roots = opticsSphere(FU.cam,rd,d.center);
  if (roots.y <= 0.0 || roots.x > roots.y) { discard; }
  let entry = max(0.0,roots.x);
  let clip = opticsClip(FU.cam+rd*entry);
  let depth = select(clamp(clip.z/clip.w,0.0,1.0),0.0,entry == 0.0);
  let result = opticsTrace(OpticsVertex(v.position),true,d.a,entry);
  return DropOutput(result.color,result.metadata,result.fallback,depth);
}`;

export const dropDepthWGSL = `
@group(0) @binding(0) var opaque: texture_depth_2d;
@group(0) @binding(1) var metadata: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i<<1u)&2u)*2.0-1.0,f32(i&2u)*2.0-1.0,0,1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  return min(textureLoad(opaque,vec2i(p.xy),0),textureLoad(metadata,vec2i(p.xy),0).x);
}`;
