// One cached raster sun map shared by all hybrid surface producers.
//
// Parent integration (before the scene pass, after producers' GPU rebuilds):
//   const shadow = createHybridShadows(gpu, sim); await shadow.ready;
//   shadow.update({sun, model: FUModel, revision: surfaceRevision,
//     casters: [opaque, smooth]});
// Each caster owns its async depth-only pipeline/geometry and exposes:
//   {isReady: boolean, revision: number|string,
//    drawShadow(rp, {matrix}) { /* pack matrix in params; draw; return true */ }}
// The hook is synchronous, may NOT submit/flush or change FrameUniforms, and
// returns false if it cannot draw. Throwing or returning false invalidates the
// whole map, never caches an incomplete set of casters. Keep caster identity
// stable; increment its revision after geometry edits (including GPU rebuilds).
//
// Receiver pipelines merge shadow.bindingDescriptors({binding}) into their
// explicit group layout, append shadowReceiverWGSL({group,binding}), and bind
// shadow.bindings({binding}) to that group. All receivers sample one result.
// FrameUniforms stays unchanged. Sun, matrix and normals are physical local
// GRID coordinates, matching the current engine sun; FU.model maps only to
// display space. Only positive uniform axis-aligned scale + translation is
// supported; update throws for rotated/sheared/nonuniform/reflected models so
// the parent can fall back rather than rotate lighting incorrectly.
// model/origin changes still invalidate the cache. Bounds are
// [-padding, size+padding]; outside casters need an enlarged size/padding or
// legacy fallback. No cascades, off-window terrain, transparent attenuation,
// alpha masking, or deformation absent from a caster's depth hook is inferred.
import {
  SHADOW_FORMAT, ShadowUniforms, IDENTITY_MODEL,
  shadowBindingDescriptors, shadowProjection, shadowVector, shadowModel,
} from '../../shaders/hybrid/shadows.js';

const TEX = { TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

/** Owns depth texture + comparison sampler + receiver uniform buffer only.
 * options: resolution (default 1024..2048 by grid size), padding in grid cells
 * (default 1), normalBias in texels (0.5), depthBias in cells (0.03).
 * No GPU readback or pipelines: .ready is immediate; casters await their own
 * asynchronous pipelines. .update returns true only for a complete new pass.
 */
export function createHybridShadows(gpu, sim, options = {}) {
  const initialSize = [sim.g.nx, sim.g.ny, sim.g.nz];
  const resolution = options.resolution ?? Math.min(2048, Math.max(1024, 16 * Math.max(...initialSize)));
  const padding = options.padding ?? 1, normalBias = options.normalBias ?? 0.5, depthBias = options.depthBias ?? 0.03;
  if (!Number.isInteger(resolution) || resolution < 4 || resolution > gpu.device.limits.maxTextureDimension2D) {
    throw new RangeError('hybrid shadows: resolution exceeds device limits or is below 4');
  }
  if (![padding, normalBias, depthBias].every((x) => Number.isFinite(x) && x >= 0)) {
    throw new RangeError('hybrid shadows: padding/bias must be finite and nonnegative');
  }
  let projection = shadowProjection([0, 1, 0], initialSize, resolution, padding);
  const label = `sim${sim.id} hybrid shadows`;
  const texture = gpu.createTexture({ label, size: [resolution, resolution], format: SHADOW_FORMAT, usage: TEX.TEXTURE_BINDING | TEX.RENDER_ATTACHMENT });
  const view = texture.createView({ label });
  const sampler = gpu.device.createSampler({
    label, compare: 'less-equal', minFilter: 'linear', magFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });
  const uniforms = gpu.uniforms(ShadowUniforms, label);
  uniforms.write({ ...projection, enabled: 0, resolution, normalBias, depthBias });
  let disposed = false, lastKey = null, serial = 0;
  const identities = new WeakMap();
  const identity = (x) => {
    if (x == null) return null;
    if (!identities.has(x)) identities.set(x, ++serial);
    return identities.get(x);
  };
  const stats = { passes: 0, draws: 0, reuses: 0, blocked: 0, invalidations: 0, valid: false, lastKey: null };
  const resource = {
    texture, view, sampler, buffer: uniforms.buffer, resolution, format: SHADOW_FORMAT,
    get matrix() { return projection.matrix; },
    get valid() { return !disposed && !gpu.lost && stats.valid; },
  };
  function disable() {
    lastKey = null;
    stats.lastKey = null;
    if (stats.valid && !disposed && !gpu.lost) uniforms.write({ enabled: 0 });
    stats.valid = false;
  }
  const api = {
    stats, resource,
    ready: null,
    get isReady() { return !disposed && !gpu.lost; },
    bindingDescriptors: shadowBindingDescriptors,
    /** GPUBindGroupEntry[]; buffers/textures are owned until dispose(). */
    bindings(options = {}) {
      const descriptors = shadowBindingDescriptors(options);
      return [
        { binding: descriptors[0].binding, resource: view },
        { binding: descriptors[1].binding, resource: sampler },
        { binding: descriptors[2].binding, resource: { buffer: uniforms.buffer } },
      ];
    },
    /** frame.sun required. size defaults sim.g, origin defaults sim.origin,
     * revision defaults sim.version (plus state copy); explicit revision can
     * be a producer aggregate to avoid rerasterizing temperature-only changes.
     * casters defaults [], optional enabled:false removes a caster. model is
     * a column-major array or Matrix4 (identity if omitted). Caller must pass
     * the current FU.model, not mutate it without another update().
     */
    update({ sun, revision, casters = [], model = IDENTITY_MODEL, origin = sim.origin ?? [0, 0, 0], size = [sim.g.nx, sim.g.ny, sim.g.nz], force = false } = {}) {
      if (!api.isReady) { disable(); return false; }
      const next = shadowProjection(sun, size, resolution, padding);
      const dimensions = shadowVector(size, 'size'), worldOrigin = shadowVector(origin, 'origin');
      const matrix = shadowModel(model);
      const rev = revision ?? sim.version;
      revisionValue(rev);
      if (!Array.isArray(casters)) throw new TypeError('hybrid shadows: casters must be an array');
      const active = casters.filter((c) => c?.enabled !== false);
      const casterKeys = active.map((c) => {
        if (!c || typeof c.drawShadow !== 'function') throw new TypeError('hybrid shadows: caster needs drawShadow(rp, {matrix})');
        revisionValue(c.revision ?? rev);
        return [identity(c), identity(c.drawShadow), c.revision ?? rev];
      });
      const key = JSON.stringify([
        identity(sim.g), identity(sim.bindRO), next.sun, rev, revision == null ? sim.cur ?? 0 : null,
        worldOrigin, dimensions, matrix, casterKeys,
      ]);
      if (active.some((c) => c.isReady === false)) {
        stats.blocked++; disable(); return false;
      }
      if (!force && key === lastKey && stats.valid) { stats.reuses++; return false; }
      // Disable first so an exception never leaves receivers using a stale or
      // partly overwritten map. SharedUniforms preserves engine write ordering.
      disable();
      const rp = gpu.frame.render({
        colorAttachments: [],
        depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      }, 'hybrid sun shadows');
      stats.passes++;
      let complete = true;
      try {
        for (const caster of active) {
          const result = caster.drawShadow(rp, { matrix: next.matrix });
          if (result?.then) throw new TypeError('hybrid shadows: drawShadow must be synchronous');
          if (result === false) { complete = false; break; }
          stats.draws++;
        }
      } finally {
        rp.end();
      }
      if (!complete) { stats.blocked++; return false; }
      projection = next;
      uniforms.write({ ...projection, enabled: 1 });
      lastKey = key;
      stats.lastKey = key;
      stats.valid = true;
      return true;
    },
    /** Call on edits not represented in revision, or explicit resource resets. */
    invalidate() { stats.invalidations++; disable(); },
    dispose() {
      if (disposed) return;
      disable();
      // As other engine owners do: submit recorded references before destroy.
      if (!gpu.lost) gpu.flush('hybrid shadows dispose');
      disposed = true;
      texture.destroy();
      uniforms.buffer.destroy();
    },
  };
  api.ready = Promise.resolve(api);
  return api;
}

function revisionValue(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    throw new TypeError('hybrid shadows: revisions must be finite numbers or strings');
  }
}
