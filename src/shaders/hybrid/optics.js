import { prelude, STATE_OPTS, LAYOUT, STAGE } from '../common.js';
import { frameBindings } from '../bindings.js';
import { uniformStruct } from '../../gpu/params.js';

/** Per-pixel validity bits. Zero means supported, not 'no optical coverage'. */
export const OPTICS_FALLBACK = Object.freeze({
  UNDERWATER: 1, MIXED_MEDIA: 2, BUDGET: 4, MESH: 8,
  APPEARANCE: 16, SMOOTH_BACKGROUND: 32, OUTSIDE_MEDIUM: 64, SURFACE: 128, MEDIA: 256,
});
export const OpticsParams = uniformStruct('OpticsParams', {
  gridInv: 'mat4x4f', size: 'vec2f', unsupported: 'u32', depthTolerance: 'f32',
});
export const opticsBindings = (binding = 0) => [
  { binding, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: binding + 1, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d' } },
];
export const opticsEntries = (color, depth, binding = 0) => [
  { binding, resource: color.createView() }, { binding: binding + 1, resource: depth.createView() },
];
export const OPTICS_STATE_LAYOUT = LAYOUT.STATE_RO;

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
 * or storage additions. Freudenthal-linear interpolation of fieldSurf.x at
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
fn opticsPhi(q: vec3i) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  return textureLoad(opticsSurf, q, 0).x;
}
// Descending fractional-coordinate order identifies the Freudenthal tetra.
fn opticsDensity(p: vec3f) -> f32 {
  let q = vec3i(floor(p - vec3f(0.5)));
  let f = fract(p - vec3f(0.5));
  var axes = array<i32, 3>(0, 1, 2);
  for (var i = 0; i < 2; i++) { for (var j = i + 1; j < 3; j++) {
    if (f[axes[j]] > f[axes[i]]) { let tmp = axes[i]; axes[i] = axes[j]; axes[j] = tmp; }
  } }
  var a = q; a[axes[0]] += 1;
  var b = a; b[axes[1]] += 1;
  return opticsPhi(q) * (1.0 - f[axes[0]]) + opticsPhi(a) * (f[axes[0]] - f[axes[1]])
    + opticsPhi(b) * (f[axes[1]] - f[axes[2]]) + opticsPhi(q + vec3i(1)) * f[axes[2]];
}
fn opticsFieldNormal(p: vec3f, cellNormal: vec3f) -> vec3f {
  let e = 0.001;
  let q = clamp(vec3i(floor(p)), vec3i(0), vec3i(NX-1, NY-1, NZ-1));
  let thin = clamp(textureLoad(opticsThin, q, 0).x, 0.0, 1.0);
  let gradient = vec3f(
    opticsDensity(p-vec3f(e,0,0))-opticsDensity(p+vec3f(e,0,0)),
    opticsDensity(p-vec3f(0,e,0))-opticsDensity(p+vec3f(0,e,0)),
    opticsDensity(p-vec3f(0,0,e))-opticsDensity(p+vec3f(0,0,e)));
  if (dot(gradient, gradient) < 1e-12) { return cellNormal; }
  var n = normalize(gradient);
  if (dot(n, cellNormal) < 0.0) { n = -n; }
  return mix(n, cellNormal, thin * 0.5);
}
fn opticsFieldState(p: vec3f, cellState: vec4f) -> vec4f {
  let id = eid(cellState);
  // Never erase opaque cells, ice/glass, or molten matter.
  if (id != E_EMPTY && KIND(id) != K_GAS && SURFCH(id) != 0) { return cellState; }
  if (opticsDensity(p) < 0.5) {
    if (SURFCH(id) == 0) { return vec4f(0.0); }
    return cellState;
  }
  if (SURFCH(id) == 0) { return cellState; }
  var best = 1e20; var source = vec4f(0.0);
  let base = vec3i(floor(p));
  // Field kernel support is two cells. Preserve the actual state/seed/Celsius.
  for (var z = -2; z <= 2; z++) { for (var y = -2; y <= 2; y++) { for (var x = -2; x <= 2; x++) {
    let q = base + vec3i(x,y,z);
    if (inGrid(q)) {
      let a = fetchA(q); let delta = vec3f(q) + vec3f(0.5) - p;
      let d = dot(delta, delta);
      if (SURFCH(eid(a)) == 0 && d < best) { best = d; source = a; }
    }
  } } }
  // Stale EMA density with no live source has no material and is not matter.
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
  let startPhi = opticsDensity(p) - 0.5;
  let endPhi = opticsDensity(p + rd * end) - 0.5;
  if (abs(endPhi - startPhi) > 1e-8) {
    let root = -startPhi * end / (endPhi - startPhi);
    if (root > OPTICS_EPS * 0.5 && root < end) { end = root; }
  }
  return end;
}
`;
}

export function opticsShader(g, { maxSteps = 256, maxInterfaces = 8, fieldBinding = null, wgsl = '', hooks = {}, binding = 0 } = {}) {
  for (const [name, n, limit] of [['maxSteps', maxSteps, 2048], ['maxInterfaces', maxInterfaces, 32]]) {
    if (!Number.isInteger(n) || n < 1 || n > limit) throw new RangeError(`${name} must be in 1..${limit}`);
  }
  return /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${frameBindings()}
${OpticsParams.wgsl}
@group(3) @binding(1) var<uniform> P: OpticsParams;
@group(2) @binding(${binding}) var opticsColor: texture_2d<f32>;
@group(2) @binding(${binding + 1}) var opticsDepth: texture_depth_2d;
const OPTICS_EPS: f32 = 0.0001;
const OPTICS_FAR: f32 = 1e20;
struct OpticalHit { position: vec3f, normal: vec3f, id: i32, state: vec4f, view: vec3f }
${fieldBinding === null ? '' : opticalFieldsWGSL(fieldBinding)}
${wgsl}
${Object.entries(OPTICS_DEFAULT_HOOKS).map(([key, value]) => hooks[key] ?? value).join('\n')}
fn opticsClass(id: i32) -> i32 {
  if (id == E_LAVA) { return 2; }
  if (id == E_WATER || id == E_OIL || id == E_ACID || id == E_GLASS || id == E_ICE) { return 1; }
  return 0;
}
fn opticsFresnel(cosine: f32, from: f32, to: f32) -> f32 {
  if (from == to) { return 0.0; }
  let eta = from / to;
  if (eta * eta * (1.0 - cosine * cosine) >= 1.0) { return 1.0; }
  let f0 = ((from - to) / (from + to)) * ((from - to) / (from + to));
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
}
// Slab intersection handles parallel rays without 0*infinity or sign(0).
fn opticsBox(ro: vec3f, rd: vec3f) -> vec2f {
  var lo = 0.0; var hi = OPTICS_FAR;
  for (var axis = 0; axis < 3; axis++) {
    if (abs(rd[axis]) < 1e-8) {
      if (ro[axis] < 0.0 || ro[axis] >= f32(vec3i(NX, NY, NZ)[axis])) { return vec2f(1.0, -1.0); }
    } else {
      let a = -ro[axis] / rd[axis];
      let b = (f32(vec3i(NX, NY, NZ)[axis]) - ro[axis]) / rd[axis];
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
@fragment fn fs(v: OpticsVertex) -> OpticsOutput {
  let px = vec2i(v.position.xy);
  let original = textureLoad(opticsColor, px, 0);
  var out: OpticsOutput;
  out.color = original; out.metadata = vec4f(1.0, 0.0, 1.0, 0.0); out.fallback = 0u;
  let uv = v.position.xy / P.size;
  var rd = normalize(opticsGridAt(uv, 0.5) - FU.cam);
  let interval = opticsBox(FU.cam, rd);
  if (interval.y < interval.x) { return out; }
  let sceneDepth = textureLoad(opticsDepth, px, 0);
  var cut = OPTICS_FAR;
  if (sceneDepth < 1.0) { cut = max(0.0, dot(opticsGridAt(uv, sceneDepth) - FU.cam, rd)); }
  if (interval.x >= cut) { return out; }
  var p = FU.cam + rd * interval.x;
  var traveled = interval.x;
  var normal = vec3f(0.0);
  // Grid entry face; ties are deterministic, as are cell edge crossings.
  let edge = min(abs(p), abs(vec3f(NX, NY, NZ) - p));
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
  // Pre-entry traversal must not silently omit distant optical cells. A straight
  // ray crosses at most this many cell/cube/tetra planes across the grid. The
  // user path budget starts at first entry, not at the camera/grid boundary.
  var pathSteps = 0;
  for (var step = 0; step < ${maxSteps} + 8 * (NX + NY + NZ); step++) {
    if (covered) { if (pathSteps >= ${maxSteps}) { break; } pathSteps++; }
    let cell = vec3i(floor(p + rd * OPTICS_EPS));
    var a = vec4f(0.0); var id = E_EMPTY;
    if (inGrid(cell)) { a = fetchA(cell); id = eid(a); }
    ${fieldBinding === null ? '' : `if (inGrid(cell)) { a = opticsFieldState(p + rd * OPTICS_EPS, a); id = eid(a); }
    if (medium != id && abs(opticsDensity(p) - 0.5) < 0.001 && (SURFCH(medium) == 0 || SURFCH(id) == 0)) {
      let fnormal = opticsFieldNormal(p, normal);
      if (dot(fnormal, fnormal) > 1e-8) { normal = normalize(fnormal); if (dot(normal, rd) > 0.0) { normal = -normal; } }
    }`}
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
      let from = select(IOR(medium), 1.0, medium == E_EMPTY);
      let to = select(IOR(id), 1.0, id == E_EMPTY);
      var n = opticsSurface(OpticalHit(p, normal, lid, state, -rd));
      if (dot(n, n) < 1e-8) { n = normal; } else { n = normalize(n); }
      let candidate = refract(rd, n, from / to);
      if (dot(n, normal) <= 0.0 || dot(rd, n) >= 0.0 || dot(reflect(rd, n), normal) <= 0.0
          || (dot(candidate, candidate) > 1e-8 && dot(candidate, normal) >= 0.0)) { n = normal; }
      let f = opticsFresnel(clamp(-dot(rd, n), 0.0, 1.0), from, to);
      interfaces++;
      if (f >= 1.0) {
        // TIR follows its actual reflected path within this medium; no energy
        // goes into an outside environment and no recursion is introduced.
        rd = reflect(rd, n); bent = true; continue;
      }
      sum += transmission * f * opticsEnvironment(p, reflect(rd, n), ROUGH(lid));
      transmission *= 1.0 - f;
      rd = normalize(refract(rd, n, from / to)); bent = true;
      medium = id; previous = a;
      // Restart at the exact face; EPS chooses the cell only, not thickness.
      continue;
    }
    if (!inGrid(cell)) {
      if (covered) { sum += transmission * opticsEnvironment(p, rd, 0.0); }
      complete = true; break;
    }
    if (RCLASS(id) == R_GLASS && optical == 0) { out.fallback |= ${OPTICS_FALLBACK.SURFACE}u; break; }
    if (id != E_EMPTY && optical == 0) {
      if (!covered) { return out; }
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
}`;
}
