import { Matrix4 } from 'three/webgpu';
import { frameUniformsOf } from '../uniforms.js';
import {
  opticsShader, opticsBindings, opticsEntries, OpticsParams, OPTICS_STATE_LAYOUT, OPTICS_FALLBACK,
} from '../../shaders/hybrid/optics.js';
export { OPTICS_FALLBACK } from '../../shaders/hybrid/optics.js';

const TEX = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
export const OPTICS_OUTPUT_FORMATS = Object.freeze({ color: 'rgba16float', metadata: 'rgba32float', fallback: 'r32uint' });
export const OPTICS_IDS = Object.freeze(['WATER', 'OIL', 'ACID', 'ICE', 'GLASS', 'LAVA']);

/** Slab interval in cells, clipped to the forward half ray; null on miss. */
export function rayBoxInterval(origin, direction, size, far = Infinity) {
  let near = 0;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-8) {
      if (origin[axis] < 0 || origin[axis] >= size[axis]) return null;
    } else {
      const a = -origin[axis] / direction[axis];
      const b = (size[axis] - origin[axis]) / direction[axis];
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    }
  }
  return far >= near ? [near, far] : null;
}
/** Schlick plus total internal reflection; reflected + transmitted = 1. */
export function interfaceEnergy(cosine, fromIOR = 1, toIOR = 1.33) {
  if (!(fromIOR > 0 && toIOR > 0)) throw new RangeError('IOR must be positive');
  const c = Math.max(0, Math.min(1, cosine));
  const eta = fromIOR / toIOR;
  const f0 = ((fromIOR - toIOR) / (fromIOR + toIOR)) ** 2;
  const reflected = eta * eta * (1 - c * c) >= 1 ? 1 : f0 + (1 - f0) * (1 - c) ** 5;
  return { reflected, transmitted: 1 - reflected };
}
/** SIGMA in the existing tables is extinction per CELL, not per metre. */
export function opticalTransmission(sigma, thickness) {
  if (!Number.isFinite(thickness) || thickness < 0) throw new RangeError('thickness must be finite and nonnegative');
  return sigma.map((v) => Math.exp(-Math.max(0, v) * thickness));
}

/** CPU reference for the exact-cell-exit DDA (no optical shading/refraction).
 * visit(cell, tNear, tFar) may return false to stop. Reports exhaustion rather
 * than silently dropping the rest. Ties advance every crossed cell axis.
 */
export function walkOpticalCells(origin, direction, size, { maxSteps = 256, far = Infinity, visit = () => {} } = {}) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be positive');
  const interval = rayBoxInterval(origin, direction, size, far);
  if (!interval) return { steps: 0, exhausted: false, end: 0 };
  let t = interval[0];
  for (let step = 0; step < maxSteps; step++) {
    const p = origin.map((v, i) => v + direction[i] * t);
    const cell = p.map((v, i) => Math.floor(v + direction[i] * 0.0001));
    if (cell.some((v, i) => v < 0 || v >= size[i]) || t >= interval[1]) return { steps: step, exhausted: false, end: t };
    let segment = interval[1] - t;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(direction[axis]) > 1e-8) {
        const face = cell[axis] + (direction[axis] > 0 ? 1 : 0);
        segment = Math.min(segment, Math.max(0, (face - p[axis]) / direction[axis]));
      }
    }
    const end = t + segment;
    if (visit(cell, t, end) === false || end >= interval[1]) return { steps: step + 1, exhausted: false, end };
    t = end;
  }
  return { steps: maxSteps, exhausted: true, end: t };
}

/** Pure resource contract check; GPUTexture objects required, not opaque views.
 * Inputs: single-sampled rgba16float and depth32float, immutable for this draw.
 * Outputs: three distinct same-size single-sampled renderable textures. Neither
 * sampled snapshot may alias ANY output attachment. Snapshots are caller-owned.
 */
export function validateOpticsResources({ color, depth }, output) {
  if (!color || !depth) throw new TypeError('optics needs immutable color and depth GPUTextures');
  if (color.format !== 'rgba16float' || depth.format !== 'depth32float') throw new TypeError('optics snapshot formats must be rgba16float/depth32float');
  const textures = [color, depth, ...Object.values(output)];
  if (new Set(textures).size !== textures.length) throw new Error('optics sampled/attachment resources must not alias');
  for (const t of textures) {
    if (!Number.isInteger(t.width) || t.width < 1 || !Number.isInteger(t.height) || t.height < 1
        || t.width !== color.width || t.height !== color.height || (t.sampleCount ?? 1) !== 1
        || (t.dimension ?? '2d') !== '2d' || (t.depthOrArrayLayers ?? 1) !== 1 || (t.mipLevelCount ?? 1) !== 1
        || typeof t.createView !== 'function') throw new Error('optics textures must have matching positive 2d extents, one layer/mip/sample, and createView');
  }
  for (const [key, format] of Object.entries(OPTICS_OUTPUT_FORMATS)) {
    if (output[key]?.format !== format || !(output[key].usage & TEX.RENDER_ATTACHMENT)) throw new Error(`optics output ${key} must be renderable ${format}`);
  }
  if (!(color.usage & TEX.TEXTURE_BINDING) || !(depth.usage & TEX.TEXTURE_BINDING)) throw new Error('optics snapshots need TEXTURE_BINDING');
  return true;
}

/**
 * Bounded, opt-in cell-boundary optical pass. No changes to sim/default view.
 *
 * Parent integration:
 * 1. Opaque geometry must exclude OPTICS_IDS. Render opaque+sky (including
 *    meshes) to immutable HDR color/depth snapshots. No optics in snapshots.
 * 2. Write shared FrameUniforms using the same jittered camera/model, then
 *    await optics.ready. update(frame) and record(frame) only on view frames.
 * 3. record({color:GPUTexture, depth:GPUTexture, hasMeshes, sourceAppearance,
 *    decoration, liquidDetail, smoothSurfaces, overlappingMedia}). Inputs
 *    must be rgba16float/depth32float, TEXTURE_BINDING, same pixel extent.
 *    Their contents must not change until this draw executes. record owns
 *    and ends its render pass; draw is an alias, NOT an open-rp hook.
 * 4. Consume output.color as resolved HDR scene. metadata.x is nearest optical
 *    entry WebGPU depth (1 absent); integrate front media only to that depth.
 *    metadata.y = optical thickness cells, z = max remaining transmission,
 *    w = interface count. Use optical coverage/reactive rejection for TAA.
 *    fallback is r32uint OPTICS_FALLBACK bits. Nonzero color is deliberately
 *    unchanged snapshot, NOT a correct transparent result: composite a valid
 *    fallback on GPU or keep legacy for unsupported scenes. No readback here.
 * 5. Optional lighting = {wgsl, hooks, bindings, entries(frame), textures(frame)} adds group 2
 *    bindings >= 2. hooks documented in shaders/hybrid/optics.js. Supply shared
 *    material/PBR lighting for hidden crisp hits, reflection/body, and optional
 *    media segments. No recursive reflections/diffuse walks in callbacks.
 *    textures(frame) must list every extension GPUTexture (not its view) to
 *    check attachment aliasing; extension storage resources must be read-only.
 *    Callback distances/extinction use cells; temperature is Celsius.
 *
 * Unsupported: underwater; adjacent heterogeneous media; hidden meshes; exit
 * while submerged at grid bounds; crystals; hidden smooth/granular backgrounds;
 * source/deco/detail/smooth optical parity. Scene flags force explicit validity
 * bits. Finite bounded traversal is reported, never silently accepted. Optical
 * reflections use the lighting environment callback, not recursive world rays.
 * The normal hook alters shading/refraction, NOT the cell-boundary geometry.
 * Recreate on sim grid replacement/device loss. No cached sim fields or idle
 * dispatches; window shifts, edits, undo/load read current sim state/header.
 */
/** Explicit layout counts, including FRAME, state A/B, and the engine params group.
 * Filtering samplers must never be paired with the unfilterable metadata output.
 * The pass itself uses textureLoad only; extension resources stay caller-owned.
 */
export function validateOpticsLimits(limits = {}, bindings = []) {
  const counts = { maxSampledTexturesPerShaderStage: 2, maxSamplersPerShaderStage: 0,
    maxStorageBuffersPerShaderStage: 3, maxUniformBuffersPerShaderStage: 3 };
  for (const e of bindings) {
    if (e.storageTexture || e.buffer?.type === 'storage') throw new Error('optics extensions must be read-only');
    if (e.texture) counts.maxSampledTexturesPerShaderStage++;
    if (e.sampler) counts.maxSamplersPerShaderStage++;
    if (e.buffer) counts[e.buffer.type === 'read-only-storage' ? 'maxStorageBuffersPerShaderStage' : 'maxUniformBuffersPerShaderStage']++;
  }
  for (const [key, n] of Object.entries({ ...counts, maxBindGroups: 4, maxBindingsPerBindGroup: Math.max(2, ...bindings.map((e) => e.binding + 1)),
    maxColorAttachments: 3, maxColorAttachmentBytesPerSample: 28 })) {
    if (limits[key] !== undefined && n > limits[key]) throw new RangeError(`optics exceeds ${key}: ${n} > ${limits[key]}`);
  }
  return true;
}

export function createHybridOptics(gpu, sim, options = {}) {
  const { lighting = {}, maxSteps = 256, maxInterfaces = 8, depthTolerance = 0.15 } = options;
  if (!(depthTolerance >= 0 && Number.isFinite(depthTolerance))) throw new RangeError('depthTolerance must be finite and nonnegative');
  const extraBindings = lighting.bindings ?? [];
  if (extraBindings.some((e) => !Number.isInteger(e.binding) || e.binding < 2) || new Set(extraBindings.map((e) => e.binding)).size !== extraBindings.length) throw new Error('optics lighting bindings must be unique and >= 2');
  validateOpticsLimits(gpu.limits ?? gpu.device?.limits, extraBindings);
  if (extraBindings.some((e) => e.texture) && typeof lighting.textures !== 'function') throw new TypeError('optics extension textures need lighting.textures(frame) for attachment alias checks');
  const fu = frameUniformsOf(gpu);
  const sceneLayout = gpu.layout('HYBRID_OPTICS_SCENE', [...opticsBindings(), ...extraBindings]);
  const stateLayout = gpu.layout('STATE_RO', OPTICS_STATE_LAYOUT);
  const pipe = gpu.renderPipeline({
    name: 'hybrid optics', code: opticsShader(sim.g, { maxSteps, maxInterfaces, wgsl: lighting.wgsl, hooks: lighting.hooks }),
    layouts: [fu.layout, stateLayout, sceneLayout], params: OpticsParams,
    fragment: { targets: Object.values(OPTICS_OUTPUT_FORMATS).map((format) => ({ format })) },
  });
  const inverse = new Matrix4();
  let output = null, current = {}, disposed = false;
  const stats = { draws: 0, allocations: 0, maxSteps, maxInterfaces, cellBoundarySurfaces: true };
  const live = () => { if (disposed) throw new Error('hybrid optics is disposed'); };
  const release = () => { if (output) for (const t of Object.values(output)) t.destroy(); output = null; };
  const api = {
    ready: pipe.ready,
    get isReady() { return !disposed && pipe.state === 'ready'; },
    stats,
    get output() { return output; },
    update(frame = {}) { live(); current = { ...frame }; },
    record(frame = current) {
      live();
      if (pipe.state !== 'ready') return false;
      if (!fu.last.written) throw new Error('writeFrameUniforms before optics.record');
      const { color, depth } = frame;
      // Validate inputs before allocating or replacing any outputs.
      if (!color || !depth || color.format !== 'rgba16float' || depth.format !== 'depth32float') throw new TypeError('optics needs rgba16float/depth32float immutable snapshots');
      // Validate complete input descriptors before a resize can destroy old outputs.
      for (const t of [color, depth]) {
        if (!(t.usage & TEX.TEXTURE_BINDING) || !Number.isInteger(t.width) || t.width < 1 || !Number.isInteger(t.height) || t.height < 1
            || t.width !== color.width || t.height !== color.height || (t.sampleCount ?? 1) !== 1
            || (t.dimension ?? '2d') !== '2d' || (t.depthOrArrayLayers ?? 1) !== 1 || (t.mipLevelCount ?? 1) !== 1
            || typeof t.createView !== 'function') throw new Error('invalid optics snapshot descriptor');
      }
      const limit = gpu.limits?.maxTextureDimension2D ?? gpu.device?.limits?.maxTextureDimension2D ?? 8192;
      if (color.width > limit || color.height > limit) throw new RangeError('optics extent exceeds maxTextureDimension2D');
      const sampled = [color, depth, ...(lighting.textures?.(frame) ?? [])];
      if (output && sampled.some((t) => Object.values(output).includes(t))) throw new Error('optics sampled/attachment resources must not alias');
      if (!output || output.color.width !== color.width || output.color.height !== color.height) {
        // Texture destruction is deferred by WebGPU; no submit/flush in hook.
        release();
        output = Object.fromEntries(Object.entries(OPTICS_OUTPUT_FORMATS).map(([key, format]) => [key, gpu.createTexture({
          label: `hybrid optics ${key}`, size: [color.width, color.height], format, usage: TEX.TEXTURE_BINDING | TEX.RENDER_ATTACHMENT,
        })]));
        stats.allocations++;
      }
      validateOpticsResources(frame, output);
      if (sampled.some((t) => Object.values(output).includes(t))) throw new Error('optics extension sampled/attachment resources must not alias');
      inverse.multiplyMatrices(fu.last.viewProj, fu.last.model).invert();
      let unsupported = 0;
      if (frame.hasMeshes) unsupported |= OPTICS_FALLBACK.MESH;
      if (frame.sourceAppearance || frame.decoration) unsupported |= OPTICS_FALLBACK.APPEARANCE;
      if (frame.liquidDetail || frame.smoothSurfaces) unsupported |= OPTICS_FALLBACK.SURFACE;
      if (frame.overlappingMedia && !lighting.hooks?.mediaSegment) unsupported |= OPTICS_FALLBACK.MEDIA;
      const entries = [...opticsEntries(color, depth), ...(lighting.entries?.(frame) ?? [])];
      const group = gpu.bindGroup(sceneLayout, entries, 'hybrid optics scene');
      const rp = gpu.frame.render({ colorAttachments: Object.values(output).map((t) => ({
        view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
      })) }, 'hybrid optics');
      try {
        pipe.draw(rp, {
          bind: [fu.group, sim.bindRO, group], header: sim.header(),
          params: { gridInv: inverse, size: [color.width, color.height], unsupported, depthTolerance }, count: 3,
        });
      } finally { rp.end(); }
      stats.draws++;
      return output;
    },
    draw(frame = current) { return api.record(frame); },
    dispose() { if (disposed) return; disposed = true; release(); current = {}; },
  };
  return api;
}
