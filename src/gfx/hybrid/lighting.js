import { hybridLightingConfig, hybridLightingLayout, hybridLightingWGSL, HYBRID_LIGHTING_LIMITS } from '../../shaders/hybrid/lighting.js';
import { BRICK } from '../../shaders/common.js';
import { SH_Y0, SH_Y1 } from '../../shaders/gfx/lighting.js';
export { hybridLightingLayout, hybridLightingWGSL, HYBRID_LIGHTING_LIMITS };

/** Binding entries for EXISTING derived.views {gi:GPUTextureView[4],light:GPUTextureView}.
 * No texture ownership transfer. Parent may merge these into its own group.
 */
export function hybridLightingEntries(views, sampler, options = {}) {
  const { binding } = hybridLightingConfig(options);
  if (!views?.gi || views.gi.length !== 4 || views.gi.some((v) => !v) || !views.light || !sampler) {
    throw new TypeError('hybrid lighting needs four GI views, a glow view, and a filtering sampler');
  }
  return [...views.gi, views.light, sampler].map((resource, i) => ({ binding: binding + i, resource }));
}

/** Small resource adapter; no pipelines, allocations of volumes, dispatches,
 * readback or frame submission. Parent must update existing derived light/GI
 * and write existing FrameUniforms before drawing. All five volumes must be
 * rgba16float 3D textures on the same brick lattice (one texel / 4 cells).
 *
 * Integration:
 * 1. Compose materials WGSL + hybridLightingWGSL(options) after FU declaration.
 * 2. Use .layout at options.group in explicit pipeline layouts (or merge
 *    hybridLightingLayout / hybridLightingEntries into a group yourself).
 * 3. .update({derived:sim.derived}) after grid replacement/before draw; bind
 *    .group at .groupIndex. No change in view identity means no new GPU work.
 * 4. Call hybridShade(m,p,ng,n,FU.cam-p,sunRGB,ao). p/ng/n are in physical
 *    grid-cell axes, NOT display/model axes. Premultiplied output blends ONE /
 *    ONE_MINUS_SRC_ALPHA. Draw opaque with opacity 1; optics owns transmission.
 * 5. .dispose drops only adapter references; sim owns volumes and GPU owns
 *    sampler/layout. Recreate adapter for a new/lost device.
 *
 * Optional lampVisibility(i,p,ng)->vec3f and lampActive(i)->bool WGSL hooks
 * permit cached local shadows/current torch liveness without baseline DDA.
 * Default lamps are unshadowed (like engine lampSeen), tube-nearest-point
 * approximation, not stochastic area shadows. Caller supplies sun visibility.
 * Lighthouse/caustic/cloud evaluation is not duplicated here; compose it in
 * visibility/lighting or retain the legacy path where required.
 */
export function createHybridLighting(gpu, sim, options = {}) {
  const config = hybridLightingConfig(options);
  const layout = gpu.layout(`HYBRID_LIGHTING_${config.binding}_${config.visibility}`, hybridLightingLayout(config));
  let sampler = options.sampler ?? gpu.device.createSampler({ label: 'hybrid lighting linear clamp',
    minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
  let group = null, resources = [], disposed = false;
  const stats = { bindGroupBuilds: 0 };
  const api = {
    layout, groupIndex: config.group, wgsl: hybridLightingWGSL(config), stats,
    ready: Promise.resolve(),
    get isReady() { return !disposed && !gpu.lost && group !== null; },
    get group() { return group; },
    update({ derived = sim?.derived } = {}) {
      if (disposed) throw new Error('hybrid lighting disposed');
      if (gpu.lost || !derived?.views) { group = null; resources = []; return false; }
      let entries;
      try { entries = hybridLightingEntries(derived.views, sampler, config); }
      catch (error) { group = null; resources = []; throw error; }
      if (entries.some((e, i) => e.resource !== resources[i])) {
        group = gpu.bindGroup(layout, entries, 'hybrid lighting probes + glow');
        resources = entries.map((e) => e.resource);
        stats.bindGroupBuilds++;
      }
      return true;
    },
    dispose() { disposed = true; group = null; resources = []; sampler = null; sim = null; },
  };
  api.update();
  return api;
}

// CPU mirrors for coordinate/energy checks, NOT a CPU shading/rendering path.
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const unit = (v, fallback = [0, 1, 0]) => {
  const d2 = dot(v, v);
  return d2 > 1e-20 ? v.map((x) => x / Math.sqrt(d2)) : fallback;
};
export function hybridLightCounts(lamps, wands) {
  for (const [name, count] of [['lamps', lamps], ['wands', wands]]) {
    if (!Number.isInteger(count) || count < 0 || count > HYBRID_LIGHTING_LIMITS[name]) {
      throw new RangeError(`hybrid ${name} count must be 0..${HYBRID_LIGHTING_LIMITS[name]}`);
    }
  }
  return { lamps, wands };
}
export function hybridProbeCoordinates(p, dimensions) {
  if (p.length !== 3 || dimensions.length !== 3 || !p.every(Number.isFinite) ||
    !dimensions.every((n) => Number.isInteger(n) && n > 0)) throw new RangeError('invalid probe coordinates/dimensions');
  return p.map((x, i) => clamp(x / BRICK, 0.5, dimensions[i] - 0.5) / dimensions[i]);
}
export function hybridProbeWeights(p, normal, dimensions) {
  const ng = unit(normal);
  const shifted = p.map((x, i) => x + ng[i] * 3);
  const q = hybridProbeCoordinates(shifted, dimensions).map((x, i) => x * dimensions[i] - 0.5);
  const lo = q.map(Math.floor), f = q.map((x) => x - Math.floor(x));
  const taps = Array.from({ length: 8 }, (_, k) => {
    const o = [k & 1, (k >> 1) & 1, (k >> 2) & 1];
    const cell = o.map((x, i) => clamp(lo[i] + x, 0, dimensions[i] - 1));
    const delta = cell.map((x, i) => (x + 0.5) * BRICK - p[i]);
    const weight = o.reduce((w, x, i) => w * (x ? f[i] : 1 - f[i]), 1) * Math.max(dot(ng, unit(delta, ng)), 0);
    return { cell, weight };
  });
  const total = taps.reduce((s, t) => s + t.weight, 0);
  return taps.map((t) => ({ ...t, weight: t.weight / Math.max(total, 1e-8) }));
}
export function hybridEvaluateSH(bands, n, cave = [0, 0, 0]) {
  return cave.map((c, i) => Math.max(SH_Y0 * bands[0][i] + (2 / 3) * SH_Y1 *
    (bands[1][i] * n[0] + bands[2][i] * n[1] + bands[3][i] * n[2]), 0) + Math.max(c, 0));
}
export function hybridDirectReference(m, normal, view, light) {
  const n = unit(normal), v = unit(view, n), l = unit(light, n);
  const nl = Math.max(dot(n, l), 0), nv = Math.max(dot(n, v), 1e-4);
  const h = unit(v.map((x, i) => x + l[i]), n);
  const nh = Math.max(dot(n, h), 0), vh = Math.max(dot(v, h), 0);
  const metal = clamp(m.metalness, 0, 1), rough = clamp(m.roughness, 0, 1);
  const a2 = Math.max(rough * rough, 0.002) ** 2;
  const d = Math.max(1 - nh * nh + nh * nh * a2, 1e-8);
  const distribution = a2 / (Math.PI * d * d);
  const gv = nl * Math.sqrt(nv * nv * (1 - a2) + a2);
  const gl = nv * Math.sqrt(nl * nl * (1 - a2) + a2);
  return m.baseColor.map((x) => {
    const base = clamp(x, 0, 1), f0 = 0.04 * (1 - metal) + base * metal;
    const fresnel = f0 + (1 - f0) * (1 - clamp(vh, 0, 1)) ** 5;
    return ((1 - fresnel) * base * (1 - metal) + Math.PI * distribution *
      (0.5 / Math.max(gv + gl, 1e-5)) * fresnel) * nl;
  });
}
