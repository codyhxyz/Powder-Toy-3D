import { Matrix4 } from 'three/webgpu';
import { frameUniformsOf } from '../uniforms.js';
import { createMediaNoise } from '../mediaNoise.js';
import { HybridMediaParams, MEDIA_FIELD_LAYOUT, MEDIA_DEPTH_LAYOUT, MEDIA_COMPOSITE_LAYOUT,
  hybridMediaIntegrateWGSL, hybridMediaCompositeWGSL, hybridMediaSegmentWGSL } from '../../shaders/hybrid/media.js';
export { HybridMediaParams } from '../../shaders/hybrid/media.js';

export function mediaExtent(width, height, scale = .5) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new RangeError('media scale must be in (0,1]');
  return [Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale))];
}
export function mediaTransmission(sigma, distance) {
  if (![sigma, distance].every((v) => Number.isFinite(v) && v >= 0)) throw new RangeError('nonnegative finite extinction/distance required');
  return Math.exp(-sigma * distance);
}
function validate(frame, limit, owned = []) {
  const { color, depth, opticalDepth } = frame;
  const inputs = [color, depth, ...(opticalDepth ? [opticalDepth] : [])];
  if (!color || !depth || color.format !== 'rgba16float' || depth.format !== 'depth32float'
      || (opticalDepth && opticalDepth.format !== 'r32float')) throw new TypeError('media requires rgba16float/depth32float snapshots and optional r32float optical depth');
  if (new Set(inputs).size !== inputs.length || inputs.some((t) => owned.includes(t))) throw new Error('media resources must not alias');
  for (const t of inputs) {
    if (!Number.isInteger(t.width) || !Number.isInteger(t.height) || t.width < 1 || t.height < 1
        || t.width !== color.width || t.height !== color.height || t.width > limit || t.height > limit
        || t.sampleCount !== 1 || t.dimension !== '2d' || t.depthOrArrayLayers !== 1 || t.mipLevelCount !== 1
        || !(t.usage & 4) || typeof t.createView !== 'function') throw new RangeError('invalid media texture extent/usage/descriptor');
  }
}

/** No submissions; FU is written by the app. output is a separate GPUTexture.
 * Optional sun={wgsl,visibility,layout,entries,textures}: extra group-1 bindings
 * >=6; visibility(p:vec3f)->f32 in grid space. textures() lists sampled textures
 * for alias checking. Use literal @group(1) @binding(N) seam declarations so
 * segment's fieldGroup/fieldBinding remapping also relocates sun resources.
 * segment() exposes exact Header/HybridMediaParams values plus field bindings;
 * pack params in the consumer's own uniform buffer/ring (never share slots).
 */
export function createHybridMedia(gpu, sim, { scale = .5, maxSteps = 128, step = 1, sun = {} } = {}) {
  mediaExtent(1, 1, scale);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1024 || !Number.isFinite(step) || step <= 0) throw new RangeError('invalid media step budget');
  const limits = gpu.limits ?? gpu.device.limits;
  const extra = sun.layout ?? [];
  const layout = [...MEDIA_FIELD_LAYOUT, ...extra];
  if (extra.some((e) => !Number.isInteger(e.binding) || e.binding < 6 || e.binding >= (limits?.maxBindingsPerBindGroup ?? 1000)) || new Set(layout.map((e) => e.binding)).size !== layout.length) throw new Error('media sun bindings must be unique and >=6');
  if (extra.some((e) => e.texture) && typeof sun.textures !== 'function') throw new TypeError('sun textures() required');
  const required = { maxBindGroups: 4, maxColorAttachments: 2, maxColorAttachmentBytesPerSample: 12,
    maxUniformBuffersPerShaderStage: 3 + extra.filter((e) => e.buffer && (!e.buffer.type || e.buffer.type === 'uniform')).length,
    maxStorageBuffersPerShaderStage: 1 + extra.filter((e) => e.buffer?.type?.includes('storage')).length,
    maxSampledTexturesPerShaderStage: 9 + extra.filter((e) => e.texture).length, maxSamplersPerShaderStage: 2 + extra.filter((e) => e.sampler).length };
  for (const [key, n] of Object.entries(required)) if ((limits?.[key] ?? n) < n) throw new RangeError(`media exceeds ${key}`);
  const fu = frameUniformsOf(gpu), noise = createMediaNoise(gpu);
  const clamp = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const repeat = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
  const fields = gpu.layout('HYBRID_MEDIA_FIELDS', layout);
  const depths = gpu.layout('HYBRID_MEDIA_DEPTH', MEDIA_DEPTH_LAYOUT);
  const composite = gpu.layout('HYBRID_MEDIA_COMPOSITE', MEDIA_COMPOSITE_LAYOUT);
  const shaderOptions = { sunWGSL: sun.wgsl, sunVisibility: sun.visibility };
  const make = (name, code, scene, formats) => gpu.renderPipeline({ name, code, layouts: [fu.layout, fields, scene], params: HybridMediaParams, fragment: { targets: formats.map((format) => ({ format })) } });
  const integrate = make('hybrid media integrate', hybridMediaIntegrateWGSL(shaderOptions), depths, ['rgba16float', 'r32float']);
  const compose = make('hybrid media compose', hybridMediaCompositeWGSL(shaderOptions), composite, ['rgba16float']);
  let disposed = false, ready = false, targets = null, current = {}, lastParams = null, targetEncoder = null;
  const stats = { draws: 0, allocations: 0, maxSteps, step };
  const live = () => { if (disposed) throw new Error('hybrid media disposed'); };
  const destroy = (t) => { if (t) Object.values(t).forEach((v) => v.destroy()); };
  // destroy() before submission invalidates already encoded texture uses.
  // Retire against the encoder that last used this set; never flush it here.
  const retire = (t, encoder) => {
    const collect = () => {
      if (encoder && gpu.frame.encoder === encoder && !gpu.lost && !gpu.failure) {
        const timer = setTimeout(collect, 16); timer.unref?.();
      } else destroy(t);
    };
    if (encoder && gpu.frame.encoder === encoder) queueMicrotask(collect);
    else destroy(t);
  };
  const entries = (binding = 0) => {
    const v = sim.derived.views;
    if (!v.fieldMedia || !v.light || !v.gi?.[0]) throw new Error('media derived field/light/GI views required');
    return [v.fieldMedia, v.light, v.gi[0], noise.view, clamp, repeat].map((resource, i) => ({ binding: binding + i, resource }));
  };
  const paramsFor = (frame) => {
      if (!fu.last.written) throw new Error('writeFrameUniforms before media uniforms');
      const color = frame.color ?? { width: 1, height: 1 };
      const opticalDepth = frame.opticalDepth;
      const [w, h] = mediaExtent(color.width, color.height, frame.scale ?? scale);
      const inverse = new Matrix4().multiplyMatrices(fu.last.viewProj, fu.last.model);
      if (!Number.isFinite(inverse.determinant()) || inverse.determinant() === 0) throw new Error('singular media camera transform');
      return { clipToGrid: inverse.invert(), grid: [sim.g.nx, sim.g.ny, sim.g.nz], step,
        size: [color.width, color.height], lowSize: [w, h], enabled: 1, maxSteps, hasLight: 1, hasGI: 1, depthTolerance: .75, hasOptics: opticalDepth ? 1 : 0 };
  };
  const api = {
    ready: Promise.all([integrate.ready, compose.ready, noise.ready]).then(() => { ready = true; return api; }),
    get isReady() { return ready && !disposed && integrate.state === 'ready' && compose.state === 'ready'; },
    get output() { return targets?.color ?? null; }, stats,
    // Base and sun bindings relocate together. Params are fresh from app FU,
    // available before screen recording so optics can use this segment first.
    segment({ binding = 0 } = {}) {
      live();
      return { layout: layout.map((e) => ({ ...e, binding: e.binding + binding })),
        entries: [...entries(binding), ...(sun.entries?.(current) ?? []).map((e) => ({ ...e, binding: e.binding + binding }))], params: paramsFor(current),
        header: sim.header(), paramsStruct: HybridMediaParams,
        wgsl: (options = {}) => hybridMediaSegmentWGSL({ ...shaderOptions, fieldBinding: binding, ...options }) };
    },
    update(frame = {}) { live(); current = { ...frame }; return api.isReady; },
    record(frame = current) {
      live();
      if (!api.isReady) return false;
      if (!fu.last.written) throw new Error('writeFrameUniforms before media.record');
      const owned = targets ? Object.values(targets) : [];
      validate(frame, limits?.maxTextureDimension2D ?? 8192, owned);
      if ((sun.textures?.(frame) ?? []).some((t) => owned.includes(t))) throw new Error('media sun texture aliases output');
      const { color, depth, opticalDepth } = frame;
      const [w, h] = mediaExtent(color.width, color.height, frame.scale ?? scale);
      const fieldEntries = [...entries(), ...(sun.entries?.(frame) ?? [])];
      const params = paramsFor(frame);
      if (!targets || targets.color.width !== color.width || targets.color.height !== color.height || targets.media.width !== w || targets.media.height !== h) {
        const next = {};
        try {
          for (const [key, format, size] of [['color', 'rgba16float', [color.width, color.height]], ['media', 'rgba16float', [w, h]], ['guide', 'r32float', [w, h]]])
            next[key] = gpu.createTexture({ label: `hybrid media ${key}`, format, size, usage: 20 });
        } catch (error) { destroy(next); throw error; }
        retire(targets, targetEncoder); targets = next; targetEncoder = null; stats.allocations++;
      }
      lastParams = params;
      const fieldGroup = gpu.bindGroup(fields, fieldEntries, 'media fields');
      // The immutable color supplies the unused optional binding; never
      // sample the guide attachment itself, even when hasOptics is false.
      const base = [{ binding: 0, resource: depth.createView() }, { binding: 4, resource: (opticalDepth ?? color).createView() }];
      const draw = (pipe, scene, groupEntries, attachments) => {
        const group = gpu.bindGroup(scene, groupEntries, 'media screen');
        const rp = gpu.frame.render({ colorAttachments: attachments.map((t) => ({ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] })) }, 'hybrid media');
        targetEncoder = gpu.frame.encoder ?? null;
        try { pipe.draw(rp, { bind: [fu.group, fieldGroup, group], header: sim.header(), params: lastParams, count: 3 }); } finally { rp.end(); }
        stats.draws++;
      };
      draw(integrate, depths, base, [targets.media, targets.guide]);
      draw(compose, composite, [...base, ...[color, targets.media, targets.guide].map((t, i) => ({ binding: i + 1, resource: t.createView() }))], [targets.color]);
      current = { ...frame };
      return targets.color;
    },
    dispose() { if (disposed) return; disposed = true; retire(targets, targetEncoder); targets = null; current = {}; lastParams = null; },
  };
  return api;
}
