import { createHybridGeometry } from './geometry.js';
import { createHybridMaterials } from './materials.js';
import { hybridLightingEntries, hybridLightingLayout, hybridLightingWGSL } from './lighting.js';
import { createHybridShadows } from './shadows.js';
import { shadowReceiverWGSL } from '../../shaders/hybrid/shadows.js';
import { createHybridTemporal } from './temporal.js';

// First end-to-end producer: opaque crisp terrain only. The existing volume
// consumes its depth and still owns smooth matter, optics, media and reflection.
// Never suppress the legacy renderer based on a CPU guess about GPU ownership.
export function hybridEligibility({ world = false, sourceAppearance = false, decoration = false, view = 'realistic', warp = null, disabled = false } = {}) {
  if (disabled) return 'disabled';
  if (world) return 'world integration pending';
  if (sourceAppearance) return 'source artwork integration pending';
  if (decoration) return 'decoration integration pending';
  if (view !== 'realistic') return 'non-realistic view';
  if (warp?.k) return 'curved presentation';
  return null;
}
export function createHybridRenderer(gpu, sim, { post, invalidateCaches, onRead, world = false, sourceAppearance = false } = {}) {
  const initialReason = hybridEligibility({ world, sourceAppearance });
  if (initialReason) return {
    ready: Promise.resolve(), get enabled() { return false; }, stats: { reason: initialReason },
    update() { return false; }, drawOpaque() { return false; }, dispose() {},
  };
  const materials = createHybridMaterials(gpu, sim);
  const shadows = createHybridShadows(gpu, sim);
  const lightSampler = gpu.device.createSampler({ label: 'hybrid probe filter', minFilter: 'linear', magFilter: 'linear' });
  const entries = [
    ...materials.entries({ binding: 1 }),
    ...hybridLightingEntries(sim.derived.views, lightSampler, { binding: 5 }),
    ...shadows.bindings({ binding: 11 }),
  ];
  const shadingWGSL = [
    materials.shader({ binding: 1 }),
    hybridLightingWGSL({ binding: 5 }),
    shadowReceiverWGSL({ binding: 11 }),
    /* wgsl */ `
fn hybridOpaqueShade(id: i32, a: vec4f, p: vec3f, ng: vec3f, footprint: f32) -> vec4f {
  let lod = hybridMaterialFootprintLod(id, footprint);
  let m = hybridMaterialStateLod(id, fract(a.w), p, ng, a.y, i32(floor(a.w)), lod);
  let sun = vec3f(hybridSunVisibility(p, ng));
  return hybridShade(m, p, ng, m.normal, FU.cam - p, sun, 1.0);
}`,
  ].join('\n');
  const geometry = createHybridGeometry(gpu, sim, { onRead, shader: {
    shadingWGSL, shade: 'hybridOpaqueShade', entries,
    layout: [...materials.layoutEntries({ binding: 1 }), ...hybridLightingLayout({ binding: 5 }),
      ...shadows.bindingDescriptors({ binding: 11 })],
  } });
  const temporal = post ? createHybridTemporal(post, { invalidateCaches }) : null;
  let enabled = false, disposed = false;
  const stats = { reason: 'not updated', producer: 'opaque crisp terrain', geometry: geometry.stats, shadows: shadows.stats };
  const api = {
    ready: Promise.all([geometry.ready, materials.ready, shadows.ready]).then(() => api),
    get isReady() { return !disposed && geometry.isReady && materials.isReady; },
    get enabled() { return enabled && !disposed; },
    stats, geometry, materials, shadows,
    update(frame = {}) {
      const reason = hybridEligibility({ ...frame, world, sourceAppearance });
      const wasEnabled = enabled;
      enabled = !reason && api.isReady;
      stats.reason = reason ?? (enabled ? null : 'pipelines pending');
      if (!enabled) { if (wasEnabled) temporal?.reset(); return false; }
      geometry.update(frame);
      try {
        shadows.update({ sun: frame.sun, revision: geometry.revision, casters: [geometry], model: frame.model });
      } catch (e) {
        // Unknown presentation transforms retain the complete old renderer.
        if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
        enabled = false; stats.reason = e.message;
      }
      temporal?.update({ revision: `${geometry.revision}|${frame.sun?.x},${frame.sun?.y},${frame.sun?.z}|${frame.model?.elements?.join(',')}`,
        changed: !!frame.animated });
      return enabled;
    },
    drawOpaque(p, { load = false } = {}) {
      if (!api.enabled || geometry.stats.fallbackRequired) return false;
      const rp = gpu.frame.render(p.sceneDescriptor({ load }), 'hybrid opaque terrain');
      try { return geometry.drawOpaque(rp); } finally { rp.end(); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false;
      temporal?.dispose(); geometry.dispose(); shadows.dispose(); materials.dispose();
    },
  };
  return api;
}
