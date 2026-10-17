import {
  hybridReflectionsWGSL, reflectionOptions, reflectionBindingDescriptors, reflectionBindEntries,
} from '../../shaders/hybrid/reflections.js';

export { REFLECTION_DEFAULTS, hybridReflectionsWGSL, reflectionBindingDescriptors, reflectionBindEntries,
  reflectionOptions } from '../../shaders/hybrid/reflections.js';

/**
 * Pure shader adapter: owns no allocations, submission, update loop or cache.
 *
 * Parent integration (opt-in, after opaque normal/material data exist):
 * 1. Add prelude(g,STATE_OPTS.STATE_RO), materialsGLSL(), ddaGLSL(g), shared
 *    FrameUniforms and source-aware sky/environment to the containing shader.
 *    Do not add ddaGLSL twice if its core already includes it.
 * 2. Define the nonrecursive hook:
 *      fn hybridReflectionShade(id:i32, seed:f32, temperature:f32,
 *        gridPosition:vec3f, gridNormal:vec3f, incident:vec3f)->vec3f
 *    It calls hybridMaterial(id,seed,gridPosition,gridNormal,temperature), then
 *    shared compact lighting (baseColor/roughness/metalness/emission/opacity).
 *    Return opaque outgoing linear radiance; never call reflections/full legacy
 *    renderer/diffuse tracing. Do not enable on source artwork/decorated cells
 *    until this hook faithfully shades those hits, or use legacy fallback.
 * 3. Append adapter.wgsl; use existing explicit/asynchronous parent pipeline.
 *    Bind existing element tables, FrameUniforms, read-only state A/B and H
 *    through the containing prelude layouts (same ABI as the current renderer).
 *    Optional occupancy:{group:2,binding:17} adds ONE read-only storage binding
 *    of sim.derived's brickDist+mask buffer (19*NBRICKS u32 words). Merge
 *    adapter.bindings.entries into that group, unless already present; create
 *    entries using adapter.bindEntries(sim). Existing LIGHTING binding 17 can
 *    be aliased by hrOccupancy, but must only be declared once per location:
 *    if the shader already declares brickDist use the live-state variant here.
 *    Update derived bricks/occupancy BEFORE the draw, after edits/undo/window
 *    shifts/load. Otherwise omit occupancy entirely: every visit reads fetchA.
 * 4. Per opaque fragment, once: hrReflection(gridPosition, incidentGrid,
 *    geometricNormalGrid, perceptualRoughness, projectedPatchAreaPixels,
 *    F0rgb, stepBudget). incident points FROM eye TO surface. Use conservative
 *    projected patch area (not screen dimensions), computed before divergent
 *    branches; zero/unknown coverage or budget disables tracing. Default budget
 *    is caller-chosen <=32; hard compile-time cap is <=64, distance <=256 cells.
 *    Pass geometric grid normals (inverse-transform world normals as needed).
 * 5. Returned RGB REPLACES the existing environment specular; it already has
 *    Schlick Fresnel. Keep energy-conserving diffuse in the shared material
 *    shader, and premultiply final HDR RGBA by the surface opacity once. This
 *    snippet neither adds a sun specular lobe nor changes target alpha/depth.
 *
 * No screen-space inputs, ray buffers, pipeline, output target or native HWRT.
 * Offscreen objects inside the live grid are visible. Exterior meshes/far
 * terrain/floor are environment-only. Crisp cells use voxel bounds, not bevels;
 * smooth/media/glass encounters fail closed to environment, not a fabricated
 * voxel hit. Smooth fields protruding beyond their occupied cells are NOT
 * covered: parent must keep exact-surface scenes on the legacy path for now.
 * Recreate the containing shader on grid/device replacement; this adapter holds
 * no resources and does not schedule perpetual idle work.
 */
export function createHybridReflectionsSnippet(options = {}) {
  const occupancy = options.occupancy ?? null;
  return Object.freeze({
    wgsl: hybridReflectionsWGSL(options),
    policy: reflectionOptions(options),
    bindings: occupancy ? reflectionBindingDescriptors(occupancy) : null,
    bindEntries: (sim) => occupancy ? reflectionBindEntries(sim, occupancy) : [],
  });
}

// Deterministic CPU reference math, for policy/oracle tests; not a CPU render path.
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const finite3 = (v) => v?.length === 3 && v.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e8);
const normalize = (v) => finite3(v) && dot(v, v) >= 1e-12 ? v.map((x) => x / Math.hypot(...v)) : null;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const color = (v) => [0, 1, 2].map((i) => Number.isFinite(v?.[i]) && Math.abs(v[i]) <= 1e8 ? clamp(v[i], 0, 65504) : 0);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Zero means NO world traversal; the existing environment still contributes. */
export function reflectionGate({ roughness, projectedPixels, reflectance, budget }, options = {}) {
  const p = reflectionOptions(options);
  if (!(roughness >= 0 && roughness < p.roughnessStop)
      || !(projectedPixels > p.coverageStart && projectedPixels <= 1e8)
      || !(reflectance > p.reflectanceStart && reflectance <= 1)
      || !Number.isInteger(budget) || budget <= 0 || budget > 0xffffffff) return 0;
  return (1 - smooth(p.roughnessFull, p.roughnessStop, roughness))
    * smooth(p.coverageStart, p.coverageFull, projectedPixels)
    * smooth(p.reflectanceStart, p.reflectanceFull, reflectance);
}

/** Incident points into the surface; normals are face-forwarded, including inside views. */
export function reflectionVector(incident, normal) {
  const d = normalize(incident); let n = normalize(normal);
  if (!d || !n) return null;
  if (dot(d, n) > 0) n = n.map((x) => -x);
  return normalize(d.map((x, i) => x - 2 * dot(d, n) * n[i]));
}

/** Energy/fallback oracle: environment and optional hit are linear RGB radiance. */
export function reflectionEnergy({ incident, normal, f0, roughness, projectedPixels,
  budget, environment, hit = null }, options = {}) {
  const d = normalize(incident); const n = normalize(normal);
  const base = color(f0).map((x) => Math.min(x, 1));
  const F = !d || !n ? base : base.map((x) => x + (1 - x) * (1 - clamp(Math.abs(dot(d, n)), 0, 1)) ** 5);
  const weight = !d || !n ? 0 : reflectionGate({ roughness, projectedPixels, budget, reflectance: Math.max(...F) }, options);
  const env = color(environment);
  const radiance = hit && finite3(hit) ? color(hit) : env;
  return color(env.map((x, i) => (x * (1 - weight) + radiance[i] * weight) * F[i]));
}

/**
 * CPU oracle of hrTrace, no simulation readback. cellAt(c) returns 'empty',
 * 'opaque' or 'unsupported'. emptyBrick(bc) is optional authoritative occupancy.
 * Each cell visit OR brick jump consumes one step. Rays beginning inside matter
 * return 'inside' (environment), never a guessed hit normal. maxDistance is cells.
 */
export function traceReflectionReference({ origin, direction, grid, budget = 32,
  cellAt, emptyBrick = null }, options = {}) {
  const p = reflectionOptions(options);
  const d = normalize(direction);
  if (!finite3(origin) || !d || !grid?.every((x) => Number.isInteger(x) && x > 0 && x % 4 === 0)
      || grid.length !== 3 || !Number.isInteger(budget) || budget < 0 || typeof cellAt !== 'function') {
    throw new Error('reflections: invalid CPU reference ray/grid');
  }
  let near = -1e30; let far = 1e30; let axis = 0;
  const result = (reason, steps = 0, extra = {}) => ({ reason, steps, ...extra });
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-6) {
      if (origin[a] < 0 || origin[a] >= grid[a]) return result('miss');
    } else {
      const ts = [-origin[a] / d[a], (grid[a] - origin[a]) / d[a]];
      if (Math.min(...ts) > near) { near = Math.min(...ts); axis = a; }
      far = Math.min(far, Math.max(...ts));
    }
  }
  let t = Math.max(near, 0);
  const end = Math.min(far, p.maxDistance);
  if (end <= t) return result('miss');
  // Match shared safeDir and DDA_START_NUDGE, including its deterministic ties.
  const rd = d.map((x) => Math.abs(x) < 1e-6 ? 1e-6 : x);
  const step = rd.map(Math.sign);
  const delta = rd.map((x) => Math.abs(1 / x));
  let cell = origin.map((x, a) => clamp(Math.floor(x + rd[a] * (t + 1e-4)), 0, grid[a] - 1));
  const nextOf = () => cell.map((x, a) => (x + (rd[a] >= 0 ? 1 : 0) - origin[a]) / rd[a]);
  let next = nextOf(); let entered = near >= 0;
  const argmin = (v) => v[0] <= v[1] && v[0] <= v[2] ? 0 : v[1] <= v[2] ? 1 : 2;
  let steps = 0;
  while (steps < Math.min(budget, p.maxSteps)) {
    if (t >= end || cell.some((x, a) => x < 0 || x >= grid[a])) return result('miss', steps);
    steps++;
    const bc = cell.map((x) => Math.floor(x / 4));
    if (emptyBrick?.(bc)) {
      const tb = bc.map((x, a) => ((x + (step[a] > 0 ? 1 : 0)) * 4 - origin[a]) / rd[a]);
      axis = argmin(tb); t = tb[axis];
      cell = origin.map((x, a) => Math.floor(x + rd[a] * t));
      cell[axis] = step[axis] > 0 ? (bc[axis] + 1) * 4 : bc[axis] * 4 - 1;
      next = nextOf(); entered = true;
      continue;
    }
    const kind = cellAt([...cell]);
    if (kind !== 'empty') {
      if (!entered) return result('inside', steps);
      if (kind !== 'opaque') return result('unsupported', steps);
      const normal = [0, 0, 0]; normal[axis] = -step[axis];
      return result('hit', steps, { cell: [...cell], t, normal });
    }
    axis = argmin(next); t = next[axis];
    cell[axis] += step[axis]; next[axis] += delta[axis]; entered = true;
  }
  return result('budget', steps);
}
