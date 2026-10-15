import { ELEMENTS, R } from '../../elements.js';
import { LOOK, CHANNELS } from '../materials.js';
import { fold } from '../../gpu/kernels.js';
import { Matrix4 } from 'three/webgpu';
import { frameUniformsOf } from '../uniforms.js';
import { retireMediaResources } from './fieldBounds.js';
import {
  opticsBoundsShader, opticsBoundsLayout, opticsShader, opticsBindings, opticsEntries, opticsFieldBindings, OpticsParams, OPTICS_STATE_LAYOUT, OPTICS_FALLBACK, dropDepthWGSL,
} from '../../shaders/hybrid/optics.js';
export { OPTICS_FALLBACK } from '../../shaders/hybrid/optics.js';

const TEX = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
export const OPTICS_OUTPUT_FORMATS = Object.freeze({ color: 'rgba16float', metadata: 'rgba32float', fallback: 'r32uint' });
export function opticsClass(id) {
  const ch = CHANNELS[LOOK[id]?.ch]?.key;
  return ch === 'MOLTEN' ? 2 : ch === 'LIQUID' || ELEMENTS[id]?.render === R.GLASS ? 1 : 0;
}
export const OPTICS_IDS = Object.freeze(ELEMENTS.filter(e => opticsClass(e.id)).map(e => e.key));
/** CPU oracle for support-expanded GPU bounds; live sources only, no EMA pruning. */
export function opticalBounds(cells, size) {
  const lo = [...size], hi = [0, 0, 0]; let count = 0;
  for (const { cell, id } of cells) if (opticsClass(id)) {
    count++; cell.forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v+1); });
  }
  return { count, lo: lo.map(v => Math.max(0,v-2)), hi: hi.map((v,i) => Math.min(size[i],v+2)) };
}
export function opticalBoundsInterval(origin, direction, bounds, far = Infinity) {
  if (!bounds.count) return null;
  return rayBoxInterval(origin.map((v,i) => v-bounds.lo[i]), direction, bounds.hi.map((v,i) => v-bounds.lo[i]), far);
}

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
  if (fromIOR === toIOR) return { reflected: 0, transmitted: 1 };
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
 * 5. lighting = {wgsl, hooks, bindings, entries(frame), textures(frame)} adds group 2
 *    bindings >= 2; hooks.worldHit is required. Other hooks are optional.
 *    Hooks documented in shaders/hybrid/optics.js. Supply shared
 *    material/PBR lighting for hidden opaque hits, reflection/body, and optional
 *    media segments. No recursive reflections/diffuse walks in callbacks.
 *    textures(frame) must list every extension GPUTexture (not its view) to
 *    check attachment aliasing; extension storage resources must be read-only.
 *    Callback distances/extinction use cells; temperature is Celsius.
 *
 * Supported transport: submerged starts, heterogeneous IOR interfaces, exact
 * cell traversal, grid exits, and bounded environment tails. No primary legacy
 * renderer callback. Hidden/offscreen opaque hits (including sand) REQUIRE the
 * dedicated worldHit hook. Optional mediaSegment replaces mean cell gas shading.
 * options.derived (default sim.derived) supplies fieldSurf/fieldThin textures and
 * views; fieldBinding reserves two group-2 slots after lighting by default.
 * All four bulk channels use a 0.5 isosurface with exact tetra-linear roots;
 * ice/glass remain cells; isolated granular/organic cells use real-centred spheres.
 * Optional particles: particles.resources adds GPU-indirect liquid/molten
 * billboards sharing the same transport and outputs. Requires actual particleSplit;
 * fullscreen primary bounds omit these cells, secondary rays retain sphere hits.
 * Optional fallbackGate (GPUBuffer, word 0 != 0 on capacity failure) occupies
 * the next binding after particles, fragment-only. It enables full-grid primary
 * sphere transport and disables snapshot radiance reuse; opaque depth still cuts.
 * No extra fallback draw: compose optical pixels where metadata.x < 1.
 * Thin masks blend liquid normals, not density. This is not
 * legacy tricubic/detail parity. Source/deco and hidden meshes remain flagged.
 * Reflections and untraced bounded tails use environment (not recursive rays).
 * Recreate on sim grid replacement/device loss. No idle
 * dispatches; live-source optical bounds cache follows simulation revisions; window shifts, edits, undo/load read current sim state/header.
 */
/** Explicit layout counts, including FRAME, state A/B, and the engine params group.
 * Filtering samplers must never be paired with the unfilterable metadata output.
 * The pass itself uses textureLoad only; extension resources stay caller-owned.
 */
export function validateOpticsLimits(limits = {}, bindings = []) {
  limits = { maxSampledTexturesPerShaderStage: 16, maxStorageBuffersPerShaderStage: 8, ...limits };
  limits.maxSampledTexturesPerShaderStage = Math.min(16, limits.maxSampledTexturesPerShaderStage);
  limits.maxStorageBuffersPerShaderStage = Math.min(8, limits.maxStorageBuffersPerShaderStage);
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
  // Additions: options.derived (defaults to sim.derived), fieldBinding (defaults
  // to first free pair after lighting). Views are refreshed for every record.
  const derived = options.derived ?? sim.derived;
  const particles = options.particles;
  const fallbackGate = options.fallbackGate;
  if (fallbackGate && !particles) throw new TypeError('fallbackGate requires optics particles');
  if (particles && (!particles.instances || !particles.opticalArgs)) throw new TypeError('optics particles require instances and opticalArgs');
  const hasFields = !!(derived?.views?.fieldSurf && derived?.views?.fieldThin);
  const fieldBinding = hasFields ? (options.fieldBinding ?? Math.max(2, ...(lighting.bindings ?? []).map(e => e.binding + 1))) : null;
  if (typeof lighting.hooks?.worldHit !== 'string') throw new TypeError('optics requires a dedicated lighting.hooks.worldHit WGSL callback');
  const boundsBinding = Math.max(2, ...(lighting.bindings ?? []).map(e => e.binding+1), hasFields ? fieldBinding+2 : 2);
  const particleBinding = particles ? boundsBinding + 1 : null;
  const fallbackBinding = fallbackGate ? (particleBinding ?? boundsBinding) + 1 : null;
  const extraBindings = [...(lighting.bindings ?? []), ...(hasFields ? opticsFieldBindings(fieldBinding) : []),
    { binding: boundsBinding, visibility: 2, buffer: { type: 'read-only-storage' } },
    ...(particles ? [{ binding: particleBinding, visibility: 3, buffer: { type: 'read-only-storage' } }] : []),
    ...(fallbackGate ? [{ binding: fallbackBinding, visibility: 2, buffer: { type: 'read-only-storage' } }] : [])];
  if (extraBindings.some((e) => !Number.isInteger(e.binding) || e.binding < 2) || new Set(extraBindings.map((e) => e.binding)).size !== extraBindings.length) throw new Error('optics lighting bindings must be unique and >= 2');
  validateOpticsLimits(gpu.limits ?? gpu.device?.limits, extraBindings);
  if ((lighting.bindings ?? []).some((e) => e.texture) && typeof lighting.textures !== 'function') throw new TypeError('optics extension textures need lighting.textures(frame) for attachment alias checks');
  const fu = frameUniformsOf(gpu);
  const sceneLayout = gpu.layout('HYBRID_OPTICS_SCENE', [...opticsBindings(), ...extraBindings]);
  const stateLayout = gpu.layout('STATE_RO', OPTICS_STATE_LAYOUT);
  const code = opticsShader(sim.g, { maxSteps, maxInterfaces, fieldBinding, boundsBinding, particleBinding, fallbackBinding, wgsl: lighting.wgsl, hooks: lighting.hooks });
  const pipe = gpu.renderPipeline({
    name: 'hybrid optics', code,
    layouts: [fu.layout, stateLayout, sceneLayout], params: OpticsParams,
    fragment: { targets: Object.values(OPTICS_OUTPUT_FORMATS).map((format) => ({ format })) },
  });
  const dropPipe = particles && gpu.renderPipeline({
    name: 'hybrid optics droplets', code, layouts: [fu.layout, stateLayout, sceneLayout], params: OpticsParams,
    vertex: { entry: 'dropVS' },
    fragment: { entry: 'dropFS', targets: Object.values(OPTICS_OUTPUT_FORMATS).map(format => ({ format })) },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
  });
  const depthLayout = particles && gpu.layout('HYBRID_DROP_DEPTH', [
    { binding: 0, visibility: 2, texture: { sampleType: 'depth' } },
    { binding: 1, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
  ]);
  const depthPipe = particles && gpu.renderPipeline({
    name: 'hybrid optics droplet depth', code: dropDepthWGSL, layouts: [depthLayout],
    fragment: { targets: [] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  });
  const boundsLayout = gpu.layout('HYBRID_OPTICS_BOUNDS', opticsBoundsLayout);
  const brickBounds = gpu.createBuffer({ label: 'optics brick bounds', size: sim.g.nbricks * 32, usage: 128 });
  const bounds = gpu.createBuffer({ label: 'optics bounds', size: 32, usage: 128 });
  const boundsGroup = gpu.bindGroup(boundsLayout, [brickBounds, bounds].map((buffer,binding) => ({ binding, resource: { buffer } })));
  const boundsDesc = { code: opticsBoundsShader(sim.g, { particles: !!particles, world: !!(options.world ?? derived?.world) }), layouts: [sim.L.TABLES, sim.L.STATE_RO, boundsLayout], workgroupSize: [64,1,1] };
  const reduce = gpu.kernel({ name: 'hybrid.optics.bounds', ...boundsDesc });
  const finish = gpu.kernel({ name: 'hybrid.optics.bounds.finish', ...boundsDesc, entry: 'finish' });
  let boundsKey = null;
  function recordBounds(frame) {
    if (particles && (!derived?.particleSplit || sim.derived !== derived)) throw new Error('droplet optics requires actual derived.particleSplit');
    if (reduce.state !== 'ready' || finish.state !== 'ready') return false;
    const o = sim.origin ?? {};
    const key = `${sim.version}|${sim.cur}|${o.x},${o.y},${o.z}|${frame.revision ?? ''}`;
    if (key === boundsKey) return true;
    const args = { bind: [sim.tables, sim.bindRO, boundsGroup], header: sim.header() };
    reduce.dispatch(gpu.frame, fold(sim.g.nbricks), args);
    finish.dispatch(gpu.frame, [1,1,1], args);
    boundsKey = key; stats.boundsBuilds++; return true;
  }
  const inverse = new Matrix4();
  let output = null, dropDepth = null, current = {}, disposed = false;
  const stats = { boundsBuilds: 0, draws: 0, allocations: 0, maxSteps, maxInterfaces, cellBoundarySurfaces: !hasFields };
  const live = () => { if (disposed) throw new Error('hybrid optics is disposed'); };
  const release = () => {
    // Automatic submission can replace the recording encoder mid-app-frame.
    // Outputs may still be sampled by compose in the CURRENT open encoder.
    if (output) retireMediaResources(gpu, { ...output, ...(dropDepth ? { dropDepth } : {}) }, gpu.frame.encoder);
    output = null; dropDepth = null;
  };
  const pipelines = [pipe, reduce, finish, ...(particles ? [dropPipe, depthPipe] : [])];
  const api = {
    ready: Promise.all(pipelines.map(p => p.ready)),
    get isReady() { return !disposed && pipelines.every(p => p.state === 'ready'); },
    stats,
    get output() { return output; },
    update(frame = {}) { live(); current = { ...frame }; return recordBounds(current); },
    record(frame = current) {
      live();
      if (!api.isReady) return false;
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
      if (hasFields && (sim.derived && sim.derived !== derived)) throw new Error('recreate optics after derived grid replacement');
      const sampled = [color, depth, ...(hasFields ? [derived.fieldSurf, derived.fieldThin] : []), ...(lighting.textures?.(frame) ?? [])];
      if (output && sampled.some((t) => Object.values(output).includes(t))) throw new Error('optics sampled/attachment resources must not alias');
      if (!output || output.color.width !== color.width || output.color.height !== color.height) {
        // Texture destruction is deferred by WebGPU; no submit/flush in hook.
        release();
        output = Object.fromEntries(Object.entries(OPTICS_OUTPUT_FORMATS).map(([key, format]) => [key, gpu.createTexture({
          label: `hybrid optics ${key}`, size: [color.width, color.height], format, usage: TEX.TEXTURE_BINDING | TEX.RENDER_ATTACHMENT,
        })]));
        if (particles) dropDepth = gpu.createTexture({ label: 'hybrid droplet depth',
          size: [color.width, color.height], format: 'depth32float', usage: TEX.RENDER_ATTACHMENT });
        stats.allocations++;
      }
      validateOpticsResources(frame, output);
      if (sampled.some((t) => Object.values(output).includes(t))) throw new Error('optics extension sampled/attachment resources must not alias');
      if (!recordBounds(frame)) return false;
      inverse.multiplyMatrices(fu.last.viewProj, fu.last.model).invert();
      let unsupported = 0;
      if (frame.hasMeshes) unsupported |= OPTICS_FALLBACK.MESH;
      if (frame.sourceAppearance || frame.decoration) unsupported |= OPTICS_FALLBACK.APPEARANCE;
      const entries = [...opticsEntries(color, depth), { binding: boundsBinding, resource: { buffer: bounds } }, ...(lighting.entries?.(frame) ?? []), ...(hasFields ? [
        { binding: fieldBinding, resource: derived.views.fieldSurf },
        { binding: fieldBinding + 1, resource: derived.views.fieldThin },
      ] : []), ...(particles ? [{ binding: particleBinding, resource: { buffer: particles.instances } }] : []),
        ...(fallbackGate ? [{ binding: fallbackBinding, resource: { buffer: fallbackGate } }] : [])];
      const group = gpu.bindGroup(sceneLayout, entries, 'hybrid optics scene');
      const params = { gridInv: inverse, size: [color.width, color.height], unsupported, depthTolerance,
        world: (options.world ?? derived?.world) ? 1 : 0, particleSplit: particles ? 1 : 0 };
      const rp = gpu.frame.render({ colorAttachments: Object.values(output).map((t) => ({
        view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
      })) }, 'hybrid optics');
      try {
        pipe.draw(rp, {
          bind: [fu.group, sim.bindRO, group], header: sim.header(),
          params, count: 3,
        });
      } finally { rp.end(); }
      if (particles) {
        const depthGroup = gpu.bindGroup(depthLayout, [
          { binding: 0, resource: depth.createView() }, { binding: 1, resource: output.metadata.createView() },
        ]);
        const attachment = { view: dropDepth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 };
        const init = gpu.frame.render({ colorAttachments: [], depthStencilAttachment: attachment }, 'hybrid droplet depth');
        try { depthPipe.draw(init, { bind: [depthGroup], indirect: { buffer: particles.opticalArgs, offset: 0 } }); }
        finally { init.end(); }
        const drops = gpu.frame.render({
          colorAttachments: Object.values(output).map(t => ({ view: t.createView(), loadOp: 'load', storeOp: 'store' })),
          depthStencilAttachment: { ...attachment, depthLoadOp: 'load' },
        }, 'hybrid droplets');
        try { dropPipe.draw(drops, { bind: [fu.group, sim.bindRO, group], header: sim.header(), params,
          indirect: { buffer: particles.opticalArgs, offset: 16 } }); }
        finally { drops.end(); }
      }
      stats.draws++;
      return output;
    },
    draw(frame = current) { return api.record(frame); },
    dispose() { if (disposed) return; disposed = true; release(); retireMediaResources(gpu, { brickBounds, bounds }, gpu.frame.encoder); current = {}; },
  };
  return api;
}

/** CPU transport oracle, not a renderer: sample(cell) returns
 * {id, ior, sigma:[r,g,b], body:[r,g,b], opaque?, state?} or null for air.
 * worldHit(cell, material) and environment(position,direction) return radiance.
 * isolated:true uses exact sphere roots; fallbackMode includes primary spheres
 * otherwise reserved for instancing. This oracle does not model GPU snapshots.
 * mediaSegment(position,direction,length) is premultiplied RGBA, post-entry only.
 * Reports bounded termination separately from a geometric escape/hit. */
export function traceOpticalReference(origin, direction, size, {
  sample, worldHit = () => [0, 0, 0], environment = () => [1, 1, 1],
  mediaSegment = () => [0, 0, 0, 0], maxSteps = 256, maxInterfaces = 8,
  fallbackMode = false,
} = {}) {
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const norm = a => { const n = Math.hypot(...a); if (!n) throw new RangeError('zero direction'); return a.map(v => v / n); };
  let rd = norm(direction);
  const interval = rayBoxInterval(origin, rd, size);
  const color = [0, 0, 0], throughput = [1, 1, 1], segments = [];
  if (!interval) return { color: environment(origin, rd), throughput, segments, termination: 'miss', interfaces: 0, thickness: 0 };
  let p = origin.map((v, i) => v + rd[i] * interval[0]);
  const inside = c => c.every((v, i) => v >= 0 && v < size[i]);
  const at = (q, d = [0, 0, 0]) => {
    const cell = q.map((v, i) => Math.floor(v + d[i] * 1e-4));
    let material = inside(cell) ? sample(cell) : null;
    if (material?.isolated) {
      const roots = opticalParticleInterval(q, d, cell);
      if (!roots || roots[0] > 1e-4 || roots[1] <= 1e-4) material = null;
    }
    return { cell, material };
  };
  let medium = interval[0] === 0 ? at(origin, rd).material : null;
  if (medium?.opaque || (medium?.isolated && !fallbackMode)) medium = null;
  let covered = !!medium, interfaces = 0, thickness = 0, termination = 'budget';
  let normal = [0, 0, 0];
  const edge = p.map((v, i) => Math.min(Math.abs(v), Math.abs(size[i] - v)));
  normal[edge.indexOf(Math.min(...edge))] = -Math.sign(rd[edge.indexOf(Math.min(...edge))]);
  const add = light => color.forEach((_, i) => { color[i] += throughput[i] * light[i]; });
  let pathSteps = 0;
  for (let step = 0; step < maxSteps + 8 * size.reduce((a, b) => a + b, 0); step++) {
    if (covered && pathSteps++ >= maxSteps) break;
    let { cell, material } = at(p, rd);
    const raw = inside(cell) ? sample(cell) : null;
    if (raw?.isolated) {
      const delta = p.map((v,i) => v-cell[i]-0.5);
      if (Math.hypot(...delta) > 1e-8) { normal = norm(delta); if (dot(normal,rd) > 0) normal = normal.map(v => -v); }
      if (!covered && !fallbackMode) material = null;
    }
    if (!material?.opaque && (medium?.id ?? 0) !== (material?.id ?? 0)) {
      covered = true;
      if (interfaces >= maxInterfaces) break;
      const from = medium?.ior ?? 1, to = material?.ior ?? 1;
      const c = Math.max(0, -dot(rd, normal)), eta = from / to;
      const energy = interfaceEnergy(c, from, to);
      const reflected = rd.map((v, i) => v + 2 * c * normal[i]);
      interfaces++;
      if (energy.reflected === 1) { rd = norm(reflected); continue; }
      add(environment(p, reflected).map(v => v * energy.reflected));
      throughput.forEach((_, i) => { throughput[i] *= energy.transmitted; });
      const k = Math.sqrt(Math.max(0, 1 - eta * eta * (1 - c * c)));
      rd = norm(rd.map((v, i) => eta * v + (eta * c - k) * normal[i]));
      medium = material;
      continue;
    }
    if (!inside(cell)) { termination = 'escape'; break; }
    if (material?.opaque) { add(worldHit(cell, material)); termination = 'opaque'; break; }
    const exits = rd.map((v, i) => Math.abs(v) < 1e-8 ? Infinity : Math.max(0, (cell[i] + (v > 0 ? 1 : 0) - p[i]) / v));
    const axis = exits.indexOf(Math.min(...exits));
    let length = exits[axis];
    if (raw?.isolated) {
      for (const root of opticalParticleInterval(p, rd, cell) ?? []) if (root > 0.00005) length = Math.min(length, root);
    }
    segments.push({ origin: [...p], direction: [...rd], length, id: medium?.id ?? 0 });
    if (medium) {
      const t = opticalTransmission(medium.sigma ?? [0, 0, 0], length);
      add(t.map((v, i) => (1 - v) * (medium.body?.[i] ?? 0)));
      throughput.forEach((_, i) => { throughput[i] *= t[i]; }); thickness += length;
    } else if (covered) {
      const m = mediaSegment(p, rd, length); add(m);
      throughput.forEach((_, i) => { throughput[i] *= 1 - Math.min(1, Math.max(0, m[3])); });
    }
    p = p.map((v, i) => v + rd[i] * length);
    normal = [0, 0, 0]; normal[axis] = -Math.sign(rd[axis]);
  }
  if (termination !== 'opaque') add(environment(p, rd));
  return { color, throughput, segments, termination, interfaces, thickness };
}

/** Same texel-centred Freudenthal-linear density as the optional WGSL field.
 * fetch(integerCell) must return zero outside the grid. */
export function opticalFieldDensity(position, fetch) {
  const q = position.map(v => Math.floor(v - 0.5));
  const f = position.map((v, i) => v - 0.5 - q[i]);
  const axes = [0, 1, 2].sort((a, b) => f[b] - f[a]);
  const a = [...q]; a[axes[0]]++;
  const b = [...a]; b[axes[1]]++;
  return fetch(q) * (1 - f[axes[0]]) + fetch(a) * (f[axes[0]] - f[axes[1]])
    + fetch(b) * (f[axes[1]] - f[axes[2]]) + fetch(q.map(v => v + 1)) * f[axes[2]];
}
/** Next cell/tetra boundary or exact iso-root, not fixed-step ray marching. */
export function opticalFieldSegment(p, rd, cellExit, fetch) {
  const base = p.map((v, i) => Math.floor(v + rd[i] * 1e-4 - 0.5));
  let end = cellExit;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rd[i]) > 1e-8) {
      const t = (base[i] + 0.5 + (rd[i] > 0 ? 1 : 0) - p[i]) / rd[i];
      if (t > 0.00005) end = Math.min(end, t);
    }
    for (let j = i + 1; j < 3; j++) {
      const slope = rd[i] - rd[j];
      if (Math.abs(slope) > 1e-8) {
        const t = (base[i] - base[j] - p[i] + p[j]) / slope;
        if (t > 0.00005) end = Math.min(end, t);
      }
    }
  }
  const a = opticalFieldDensity(p, fetch) - 0.5;
  const b = opticalFieldDensity(p.map((v, i) => v + rd[i] * end), fetch) - 0.5;
  if (Math.abs(b - a) > 1e-8) {
    const root = -a * end / (b - a);
    if (root > 0.00005 && root < end) end = root;
  }
  return end;
}

/** CPU affine-tetra outward gradient, same vertex ordering as the shader. */
export function opticalFieldNormal(p, fetch) {
  const q = p.map(v => Math.floor(v-0.5)), f = p.map((v,i) => v-0.5-q[i]);
  const axes = [0,1,2].sort((a,b) => f[b]-f[a]);
  const a = [...q]; a[axes[0]]++;
  const b = [...a]; b[axes[1]]++;
  const values = [fetch(q),fetch(a),fetch(b),fetch(q.map(v => v+1))];
  const gradient = [0,0,0]; axes.forEach((axis,i) => { gradient[axis] = values[i]-values[i+1]; });
  const length = Math.hypot(...gradient);
  return length ? gradient.map(v => v/length) : gradient;
}
/** Nearest live nonparticle source in two-cell support; EMA alone is not matter. */
export function opticalFieldSource(p, density, sample, particle = () => false) {
  const base = p.map(Math.floor); let best = Infinity, source = null;
  for (let z=-2; z<=2; z++) for (let y=-2; y<=2; y++) for (let x=-2; x<=2; x++) {
    const q = base.map((v,i) => v+[x,y,z][i]); const a = sample(q);
    const ch = LOOK[a?.id]?.ch;
    const d = q.reduce((sum,v,i) => sum+(v+0.5-p[i])**2,0);
    if (ch >= 0 && ch < 4 && density[ch] >= 0.5 && d < best && !particle(q)) { best = d; source = a; }
  }
  return source;
}
/** Unit-direction sphere interval; null on miss, negative entry if submerged. */
export function opticalParticleInterval(p, rd, cell, radius = 0.5) {
  const q = p.map((v,i) => v-cell[i]-0.5);
  const b = q.reduce((sum,v,i) => sum+v*rd[i],0);
  const d = b*b-q.reduce((sum,v) => sum+v*v,0)+radius*radius;
  return d < 0 ? null : [-b-Math.sqrt(d),-b+Math.sqrt(d)];
}
