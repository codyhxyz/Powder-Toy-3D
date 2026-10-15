import { STAGE, prelude, STATE_OPTS, LAYOUT } from '../common.js';
import { frameBindings, RENDER_LAYOUT } from '../bindings.js';
import { materialsGLSL } from '../../gfx/materials.js';
import { ddaGLSL } from '../gfx/core.js';
import { skyGLSL, skyViewGLSL } from '../../gfx/sky.js';

export const REFLECTION_DEFAULTS = Object.freeze({
  maxSteps: 32, maxDistance: 96, bias: 0.05,
  roughnessFull: 0.12, roughnessStop: 0.3,
  coverageStart: 4, coverageFull: 16,
  reflectanceStart: 0.02, reflectanceFull: 0.08,
});

export function reflectionOptions(options = {}) {
  const p = { ...REFLECTION_DEFAULTS };
  for (const key of Object.keys(p)) {
    if (options[key] !== undefined) p[key] = options[key];
    if (!Number.isFinite(p[key])) throw new Error(`reflections: invalid ${key}`);
  }
  if (!Number.isInteger(p.maxSteps) || p.maxSteps < 1 || p.maxSteps > 64
      || p.maxDistance <= 0 || p.maxDistance > 256 || p.bias < 0.001 || p.bias > 0.25
      || p.roughnessFull < 0 || p.roughnessStop > 0.5 || p.roughnessFull >= p.roughnessStop
      || p.coverageStart < 1 || p.coverageFull <= p.coverageStart
      || p.reflectanceStart < 0 || p.reflectanceFull > 1 || p.reflectanceFull <= p.reflectanceStart) {
    throw new Error('reflections: invalid bounded trace policy');
  }
  return Object.freeze(p);
}

function occupancyLocation({ group = 2, binding = 17 } = {}) {
  if (!Number.isInteger(group) || group < 0 || group > 3 || !Number.isInteger(binding) || binding < 0) {
    throw new Error('reflections: invalid occupancy binding');
  }
  return { group, binding };
}

/** Optional occupancy-only layout entry, merge with the containing pipeline's group.
 * Do NOT duplicate it if that pipeline already binds brickDist at this location. */
export function reflectionBindingDescriptors(location) {
  const { group, binding } = occupancyLocation(location);
  return { group, entries: [{ binding, visibility: STAGE.FRAGMENT | STAGE.COMPUTE,
    buffer: { type: 'read-only-storage' } }] };
}

/** Derived.lightingEntries() binding 17 is the existing occupancy+distance buffer. */
export function reflectionBindEntries(sim, location) {
  const { binding } = occupancyLocation(location);
  const source = sim?.derived?.lightingEntries().find((e) => e.binding === 17);
  if (!source) throw new Error('reflections: fresh derived occupancy is required');
  return [{ binding, resource: source.resource }];
}

const number = (x) => Number.isInteger(x) ? `${x}.0` : String(x);
const identifier = (name) => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('reflections: invalid WGSL hook identifier');
  return name;
};

/**
 * Reusable, deterministic, single-bounce specular snippet, NOT a screen-space ray.
 * Prerequisites: prelude(g, STATE_OPTS.STATE_RO), materialsGLSL(), ddaGLSL(g),
 * and the containing pipeline's shared FrameUniforms/sky library. No full render lib
 * or recursive reflection is needed. With occupancy omitted all visits use fetchA.
 * With occupancy={group,binding}, run sim.updateBricks() before recording the draw;
 * only all-empty brick masks are skipped. State A remains authoritative for hits.
 *
 * Hooks: shade(id:i32, seed:f32, temperature:f32, p:vec3f, n:vec3f,
 *              incident:vec3f)->vec3f returns opaque linear outgoing radiance.
 * seed=fract(stateA.w), temperature=stateA.y in Celsius; p/n are grid space.
 * Call hybridMaterial(id,seed,p,n,temperature), then shared compact lighting.
 * Use shared materials/lighting/emission; MUST NOT call
 * hrReflection or any reflection-enabled shader. environment(d:vec3f)->vec3f must
 * be the shared sky/environment (source-aware when applicable).
 *
 * hrReflection(surfaceGrid, incidentGrid, geometricNormalGrid, roughness,
 *              projectedPatchPixels, F0rgb, stepBudget) returns Fresnel-weighted
 * linear specular RGB. Replace the existing environment specular, do not add twice.
 * projectedPatchPixels is a conservative raster patch area in target pixels, NOT
 * viewport area. Compute it outside divergent control flow. Call once per opaque
 * fragment only; alpha/premultiplication remain the containing shader's job.
 *
 * Unsupported hit geometry (smooth fields, glass, decorated/imported source faces,
 * external meshes/far terrain) is not reproduced: non-crisp/glass cells terminate to
 * environment. Caller must disable for source/decorated scenes unless its hit hook
 * preserves that appearance; use the legacy renderer where exact coverage matters.
 */
export function hybridReflectionsWGSL({ occupancy = null, shade = 'hybridReflectionShade',
  environment = 'skyColor', ...options } = {}) {
  const p = reflectionOptions(options);
  identifier(shade); identifier(environment);
  const loc = occupancy ? occupancyLocation(occupancy) : null;
  return /* wgsl */ `
${loc ? `@group(${loc.group}) @binding(${loc.binding}) var<storage, read> hrOccupancy: array<u32>;` : ''}
const HR_STEPS: u32 = ${p.maxSteps}u;
const HR_DISTANCE: f32 = ${number(p.maxDistance)};
const HR_BIAS: f32 = ${number(p.bias)};
fn hrFinite3(v: vec3f) -> bool { return all(abs(v) <= vec3f(1e8)); }
fn hrColor(v: vec3f) -> vec3f {
  // Comparisons also reject NaN/Inf, without relying on optional shader features.
  return select(vec3f(0.0), clamp(v, vec3f(0.0), vec3f(65504.0)), abs(v) <= vec3f(1e8));
}
fn hrGate(rough: f32, pixels: f32, reflectance: f32, budget: u32) -> f32 {
  if (!(rough >= 0.0 && rough < ${number(p.roughnessStop)})
      || !(pixels > ${number(p.coverageStart)} && pixels <= 1e8)
      || !(reflectance > ${number(p.reflectanceStart)} && reflectance <= 1.0) || budget == 0u) { return 0.0; }
  return (1.0 - smoothstep(${number(p.roughnessFull)}, ${number(p.roughnessStop)}, rough))
    * smoothstep(${number(p.coverageStart)}, ${number(p.coverageFull)}, pixels)
    * smoothstep(${number(p.reflectanceStart)}, ${number(p.reflectanceFull)}, reflectance);
}
// Robust slab entry, including axis-parallel rays and origins inside the box.
fn hrBox(ro: vec3f, rd: vec3f) -> vec3f {
  var near = -1e30; var far = 1e30; var axis = 0;
  for (var a = 0; a < 3; a++) {
    if (abs(rd[a]) < DDA_DIR_MIN) {
      if (ro[a] < 0.0 || ro[a] >= vec3f(GRID)[a]) { return vec3f(0.0, -1.0, 0.0); }
    } else {
      let ts = vec2f(-ro[a], vec3f(GRID)[a] - ro[a]) / rd[a];
      let tn = min(ts.x, ts.y);
      if (tn > near) { near = tn; axis = a; }
      far = min(far, max(ts.x, ts.y));
    }
  }
  return vec3f(near, far, f32(axis));
}
fn hrTrace(ro: vec3f, direction: vec3f, env: vec3f, budget: u32) -> vec3f {
  let bounds = hrBox(ro, direction);
  var t = max(bounds.x, 0.0);
  let end = min(bounds.y, HR_DISTANCE);
  if (end <= t || budget == 0u) { return env; }
  let rd = safeDir(direction);
  var cell: vec3i; var step: vec3i; var delta: vec3f; var next: vec3f;
  ddaStart(ro, rd, t, &step, &delta, &cell, &next);
  var axis = i32(bounds.z);
  // A start inside matter has no known entry surface/normal: fail closed to sky,
  // rather than reflecting the back of the originating voxel or skipping a wall.
  var entered = bounds.x >= 0.0;
  for (var i = 0u; i < HR_STEPS; i++) {
    if (i >= min(budget, HR_STEPS) || t >= end || outside(cell)) { break; }
    ${loc ? `let bc = cell / BS;
    let bid = brickId(bc);
    let maskAt = NBRICKS + 2u * bid;
    if ((hrOccupancy[maskAt] | hrOccupancy[maskAt + 1u]) == 0u) {
      axis = skipBrick(bc, ro, rd, step, &cell, &next, &t);
      entered = true;
      continue;
    }` : ''}
    let a = fetchA(cell);
    let id = eid(a);
    if (id != E_EMPTY) {
      if (!entered || !isCrisp(id) || RCLASS(id) == R_GLASS) { return env; }
      var n = vec3f(0.0); n[axis] = -f32(step[axis]);
      let radiance = ${shade}(id, fract(a.w), a.y, ro + direction * t, n, direction);
      if (!hrFinite3(radiance)) { return env; }
      return hrColor(radiance);
    }
    let ax = argmin3(next);
    t = next[ax];
    axis = ddaStep(step, delta, &cell, &next);
    entered = true;
  }
  return env;
}
fn hrReflection(p: vec3f, incident: vec3f, normal: vec3f, rough: f32,
                pixels: f32, f0: vec3f, budget: u32) -> vec3f {
  if (!hrFinite3(incident) || dot(incident, incident) < 1e-12
      || !hrFinite3(normal) || dot(normal, normal) < 1e-12 || !hrFinite3(p)) {
    return hrColor(${environment}(vec3f(0.0, 1.0, 0.0))) * clamp(hrColor(f0), vec3f(0.0), vec3f(1.0));
  }
  let d = normalize(incident);
  var n = normalize(normal);
  if (dot(d, n) > 0.0) { n = -n; }
  let r = normalize(reflect(d, n));
  let base = clamp(hrColor(f0), vec3f(0.0), vec3f(1.0));
  let F = base + (vec3f(1.0) - base) * pow(1.0 - clamp(-dot(d, n), 0.0, 1.0), 5.0);
  let env = hrColor(${environment}(r));
  let w = hrGate(rough, pixels, max(F.x, max(F.y, F.z)), budget);
  if (w <= 0.0) { return hrColor(env * F); }
  let hit = hrTrace(p + n * HR_BIAS, r, env, budget);
  return hrColor(mix(env, hit, w) * F);
}
`;
}

// Independent compact native compilation probes; the hook below is TEST shading,
// not the product material/lighting implementation supplied by the parent.
export function WGSL_CHECK() {
  return [false, true].map((occupancy) => ({
    name: `hybrid-reflections-${occupancy ? 'occupancy' : 'live'}`,
    warm: false, kind: 'compute',
    layouts: () => [RENDER_LAYOUT.FRAME, LAYOUT.STATE_RO,
      occupancy ? reflectionBindingDescriptors().entries : [],
      [...LAYOUT.PARAMS, { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }]],
    code: (g) => [
      prelude(g, STATE_OPTS.STATE_RO), frameBindings(), materialsGLSL(), ddaGLSL(g),
      'const PI_L: f32 = 3.141592653589793;', skyGLSL(), skyViewGLSL(),
      `fn hybridReflectionShade(id: i32, seed: f32, temperature: f32, p: vec3f, n: vec3f, incident: vec3f) -> vec3f {
        return ALBEDO(id) * (FU.skyUp + FU.sunCol * max(dot(n, FU.sun), 0.0));
      }`,
      hybridReflectionsWGSL({ occupancy: occupancy ? {} : null }),
      `@group(3) @binding(2) var<storage, read_write> hrIO: array<vec4f>;
      @compute @workgroup_size(1) fn main() {
        hrIO[4] = vec4f(hrReflection(hrIO[0].xyz, hrIO[1].xyz, hrIO[2].xyz,
          hrIO[0].w, hrIO[1].w, hrIO[3].xyz, u32(max(hrIO[2].w, 0.0))), 1.0);
      }`,
    ].join('\n'),
  }));
}
