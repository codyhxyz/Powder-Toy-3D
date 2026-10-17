// Persistent marching-tetra cached vertices for granular/organic fields only.
// Existing derived fields opt into isolated-particle subtraction; no physics writes.
import { frameUniformsOf } from '../uniforms.js';
import { fold } from '../../gpu/kernels.js';
import {
  SmoothParams, SMOOTH_FLAGS, SMOOTH_EXTRACT_LAYOUT, SMOOTH_PREFIX_LAYOUT, SMOOTH_DRAW_LAYOUT, SMOOTH_STATE_LAYOUT,
  smoothExtractWGSL, smoothDrawWGSL,
} from '../../shaders/hybrid/smooth.js';
export { smoothAcceptanceWGSL } from '../../shaders/hybrid/smooth.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const STORAGE = 0x80, INDIRECT = 0x100;

/** createHybridSmooth(gpu,sim,{maxVertices=2**21,shader={wgsl,layout,bind,
 * handlesAppearance},onRead}). shader.wgsl defines shadeSmooth(gridPosition,normal,
 * elementId,stateA,footprint)->vec3f (linear HDR); bindings group 2, >=4.
 *
 * update({revision,previousRevision,incremental,sourceStyle,force}) MUST follow
 * sim.updateBricks in the SAME open gpu.frame. revision identifies DERIVED
 * field changes, including EMA-only frames, not just simulation steps.
 * Incremental updates require previousRevision === last supplied revision;
 * otherwise rebuild all chunks. Consume every dirty field update or omit
 * incremental. invalidate() after untracked resets. Recreate on grid/device
 * or derived resource replacement. Shared FrameUniforms must already be written.
 *
 * Extraction/finish and indirect draw record in the SAME frame. Status reads
 * report exceptional fallback asynchronously; GPU args suppress whole overflow
 * generations, never partial meshes. Parent may gate legacy with GPU status.
 * draw(rp): rgba16float/depth32float. drawShadow(rp,{matrix}): depth32float,
 * matrix maps physical GRID -> light clip ([0,1] depth), not FU.model space.
 * resources.vertices holds both 16-byte vertex arenas; status[4] selects one.
 * Status words 0..3: flags, triangles, required vertices, changed bricks.
 * onRead(stats) wakes the owner after diagnostics resolve (including errors).
 * Neither recording method opens/submits a pass or performs a GPU wait.
 */
export function createHybridSmooth(gpu, sim, { maxVertices = 2 ** 21, shader = {}, onRead } = {}) {
  if (!Number.isSafeInteger(maxVertices) || maxVertices <= 0) throw new RangeError('Invalid smooth maxVertices');
  if (onRead !== undefined && typeof onRead !== 'function') throw new TypeError('onRead must be a function');
  if (shader.wgsl !== undefined && typeof shader.wgsl !== 'string') throw new TypeError('shader.wgsl must be WGSL');
  if (shader.handlesAppearance && !shader.wgsl) throw new TypeError('Appearance support requires a shader adapter');
  if (Boolean(shader.layout) !== Boolean(shader.bind)) throw new TypeError('shader.layout and shader.bind must be supplied together');
  if ((shader.layout ?? []).some((e) => e.binding < 4)) throw new RangeError('Smooth shader bindings must start at 4');
  const g = sim.g, derived = sim.derived, fu = frameUniformsOf(gpu);
  if (!derived?.dlist || !derived.views?.fieldSurf || !derived.views?.fieldThin) throw new Error('Hybrid smooth requires attached derived fields');
  const limit = Math.min(gpu.device.limits.maxStorageBufferBindingSize, gpu.device.limits.maxBufferSize ?? Infinity);
  const capacity = Math.min(maxVertices, Math.floor(limit / 16));
  if (capacity < 1 || g.nbricks * 16 > limit) throw new RangeError('Smooth vertices exceed device storage limits');
  const label = (s) => `sim${sim.id} hybrid smooth ${s}`;
  const extractLayout = gpu.layout('HYBRID_SMOOTH_EXTRACT', SMOOTH_EXTRACT_LAYOUT);
  // Optional shared material/lighting bindings extend the existing group 2 ABI.
  const drawLayout = gpu.layout(label('draw layout'), [...SMOOTH_DRAW_LAYOUT, ...(shader.layout ?? [])]);
  const buffer = (s, size, usage = STORAGE) => gpu.createBuffer({ label: label(s), size, usage });
  const vertices = [buffer('vertices 0', capacity * 16), buffer('vertices 1', capacity * 16)];
  const meta = buffer('meta', g.nbricks * 16), status = buffer('status', 32);
  const args = buffer('indirect', 16, STORAGE | INDIRECT);
  const ring = gpu.readback.ring(label('status results'), 16, 16);
  const b = (binding, buffer) => ({ binding, resource: { buffer } });
  const vertexStateLayout = gpu.layout('HYBRID_SMOOTH_STATE_RO', SMOOTH_STATE_LAYOUT);
  const vertexStateBind = gpu.bindGroup(vertexStateLayout, [b(0, sim.state.A), b(1, sim.state.B)], label('vertex state'));
  const prefixLayout = gpu.layout(label('prefix layout'), SMOOTH_PREFIX_LAYOUT);
  const shadowLayout = gpu.layout(label('shadow layout'), SMOOTH_DRAW_LAYOUT);
  const extractBind = gpu.bindGroup(extractLayout, [
    { binding: 0, resource: derived.views.fieldSurf }, b(2, derived.dlist),
    b(3, vertices[0]), b(4, meta), b(5, status), b(8, vertices[1]),
  ], label('extract'));
  const prefixBind = gpu.bindGroup(prefixLayout, [b(4, meta), b(5, status), b(6, args), b(7, ring.buffer)], label('prefix'));
  const baseEntries = [b(1, vertices[0]), b(2, vertices[1]), b(3, status)];
  const shadowBind = gpu.bindGroup(shadowLayout, baseEntries, label('shadow'));
  // bind is an array of GPUBindGroupEntry, or frame -> array; no allocation in
  // the draw loop. Refresh the composed bind only in update when necessary.
  let drawBind = null, extraEntries = null;
  const code = smoothExtractWGSL(g);
  const meshDesc = { code, layouts: [sim.L.TABLES, sim.L.STATE_RO, extractLayout], params: SmoothParams };
  const extract = gpu.kernel({ name: 'hybrid.smooth.extract', ...meshDesc, entry: 'extract', workgroupSize: [128, 1, 1] });
  const finish = gpu.kernel({ name: 'hybrid.smooth.finish', ...meshDesc, layouts: [sim.L.TABLES, sim.L.STATE_RO, prefixLayout], entry: 'finish', workgroupSize: [1, 1, 1] });
  const build = gpu.kernel({ name: 'hybrid.smooth.build', ...meshDesc, entry: 'build', workgroupSize: [128, 1, 1] });
  const drawCode = smoothDrawWGSL(g, { shadingWGSL: shader.wgsl });
  const drawDesc = { code: drawCode, layouts: [fu.layout, vertexStateLayout, drawLayout], params: SmoothParams,
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' } };
  const drawPipe = gpu.renderPipeline({ name: 'hybrid.smooth.draw', ...drawDesc, fragment: { targets: [{ format: 'rgba16float' }] } });
  const shadowPipe = gpu.renderPipeline({ name: 'hybrid.smooth.shadow', ...drawDesc, code: smoothDrawWGSL(g), layouts: [fu.layout, vertexStateLayout, shadowLayout], vertex: { entry: 'shadowVS' }, fragment: null });
  const pipes = [extract, finish, build, drawPipe, shadowPipe];
  let disposed = false, key = null, lastRevision, lastOrigin, lastSplit, generation = 0, frameState = {};
  const stats = { builds: 0, maxVertices: capacity, count: 0, flags: 0, requiredVertices: 0,
    rebuiltBricks: 0, pending: false, fallbackRequired: true, fallbackReason: 'not-built', readbackError: null };
  const fallback = (reason) => { stats.fallbackRequired = !!reason; stats.fallbackReason = reason; };
  function blocked(frame) {
    if (gpu.failure || sim.disposed || sim.g !== g || sim.derived !== derived || sim.fieldSurf !== derived.fieldSurf || sim.fieldThin !== derived.fieldThin) return 'grid-or-device-unavailable';
    if (frame.particleSplit && !derived.particleSplit) return 'ownership-not-split';
    if (typeof frame.revision !== 'string' && !(typeof frame.revision === 'number' && Number.isFinite(frame.revision))) return 'derived-revision-required';
    if (!shader.handlesAppearance && (frame.sourceStyle || fu.last?.sourceStyle || sim.deco?.active)) return 'source-or-decoration-unsupported';
    return '';
  }
  const params = (matrix = IDENTITY) => ({ capacity, full: 0, unsupported: 0, slot: 0, matrix, particleSplit: derived.particleSplit ? 1 : 0, world: derived.world ? 1 : 0 });
  const api = {
    ready: Promise.all(pipes.map((p) => p.ready)).then(() => api),
    get isReady() { return !disposed && !gpu.failure && pipes.every((p) => p.state === 'ready'); },
    get revision() { return `${generation}|${key}|${stats.fallbackReason}`; },
    capabilities: Object.freeze({ particleSplit: true, channels: [2, 3], thinGranular: true }),
    stats,
    resources: { vertices, meta, status, args, shadowLayout, shadowBind, maxVertices: capacity, layout: drawLayout, get bind() { return drawBind; } },
    update(frame = {}) {
      if (!api.isReady) return false;
      frameState = frame;
      const reason = blocked(frame);
      if (reason) { fallback(reason); return false; }
      const entries = typeof shader.bind === 'function' ? shader.bind(frame) : shader.bind;
      if (!drawBind || entries !== extraEntries) {
        extraEntries = entries;
        drawBind = gpu.bindGroup(drawLayout, [...baseEntries, ...(entries ?? [])], label('draw'));
      }
      const o = sim.origin;
      const context = `${sim.version}|${sim.cur}|${o.x},${o.y},${o.z}`;
      const nextKey = `${context}|${derived.particleSplit}|${frame.revision}`;
      if (key === nextKey && !frame.force) {
        fallback(stats.readbackError ? 'status-readback-failed' : stats.flags & SMOOTH_FLAGS.OVERFLOW ? 'capacity-overflow' : stats.flags ? 'unsupported-surface' : '');
        return false;
      }
      const full = !key || frame.force || !frame.incremental || frame.previousRevision !== lastRevision || lastOrigin !== `${o.x},${o.y},${o.z}` || lastSplit !== derived.particleSplit;
      lastOrigin = `${o.x},${o.y},${o.z}`;
      lastSplit = derived.particleSplit;
      key = nextKey;
      lastRevision = frame.revision;
      const token = ++generation;
      stats.pending = true; stats.readbackError = null;
      stats.flags = 0;
      fallback('');
      const bind = [sim.tables, sim.bindRO, extractBind], header = sim.header();
      const p = { ...params(), full: full ? 1 : 0, unsupported: 0 };
      extract.dispatch(gpu.frame, fold(g.nbricks), { bind, header, params: p });
      const slot = ring.next();
      finish.dispatch(gpu.frame, [1, 1, 1], { bind: [sim.tables, sim.bindRO, prefixBind], header, params: { ...p, slot } });
      build.dispatch(gpu.frame, fold(g.nbricks), { bind, header, params: p });
      stats.builds++;
      ring.read(slot).then((bytes) => {
        if (disposed || token !== generation) return;
        const [flags, count, required, rebuilt] = new Uint32Array(bytes);
        Object.assign(stats, { flags, count, requiredVertices: required, rebuiltBricks: rebuilt, pending: false });
        fallback(blocked(frameState) || (flags & SMOOTH_FLAGS.OVERFLOW ? 'capacity-overflow' : flags ? 'unsupported-surface' : ''));
        onRead?.(stats);
      }, (error) => {
        if (disposed || token !== generation) return;
        stats.pending = false; stats.readbackError = String(error); fallback('status-readback-failed');
        onRead?.(stats);
      });
      return true;
    },
    draw(rp) {
      if (!canDraw()) return false;
      drawPipe.draw(rp, { bind: [fu.group, vertexStateBind, drawBind], header: sim.header(), params: params(), indirect: { buffer: args } });
      return true;
    },
    drawShadow(rp, { matrix } = {}) {
      if (!matrix || !canDraw()) return false;
      shadowPipe.draw(rp, { bind: [fu.group, vertexStateBind, shadowBind], header: sim.header(), params: params(matrix), indirect: { buffer: args } });
      return true;
    },
    invalidate() { key = null; generation++; stats.pending = false; fallback('invalidated'); },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; stats.pending = false; fallback('disposed');
      gpu.flush('hybrid smooth dispose'); ring.close();
      for (const v of [...vertices, meta, status, args]) v.destroy();
    },
  };
  function canDraw() {
    if (!api.isReady || !key || !drawBind) return false;
    const reason = blocked(frameState);
    if (reason) fallback(reason);
    return !stats.fallbackRequired;
  }
  return api;
}
