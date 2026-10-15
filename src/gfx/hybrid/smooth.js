// Persistent marching-tetra descriptors for granular/organic fields only.
// No simulation changes, no isolated-particle subtraction, no optics ownership.
import { frameUniformsOf } from '../uniforms.js';
import { fold } from '../../gpu/kernels.js';
import {
  SmoothParams, SMOOTH_FLAGS, SMOOTH_EXTRACT_LAYOUT, SMOOTH_DRAW_LAYOUT,
  smoothExtractWGSL, smoothDrawWGSL,
} from '../../shaders/hybrid/smooth.js';
export { smoothAcceptanceWGSL } from '../../shaders/hybrid/smooth.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const STORAGE = 0x80, INDIRECT = 0x100;

/** createHybridSmooth(gpu,sim,{capacityPerBrick=256,shader={wgsl,layout,bind,
 * handlesAppearance}}). shader.wgsl defines shadeSmooth(gridPosition,normal,
 * elementId,stateA)->vec3f (linear HDR); bindings group 2, >=4.
 *
 * update({revision,previousRevision,incremental,sourceStyle,force}) MUST follow
 * sim.updateBricks in the SAME open gpu.frame. revision identifies DERIVED
 * field changes, including EMA-only frames, not just simulation steps.
 * Incremental updates require previousRevision === last supplied revision;
 * otherwise rebuild all chunks. Consume every dirty field update or omit
 * incremental. invalidate() after untracked resets. Recreate on grid/device
 * or derived resource replacement. Shared FrameUniforms must already be written.
 *
 * Until the small async status validates a generation, fallbackRequired is true.
 * Parent must retain the ENTIRE legacy granular/organic producer when true,
 * never combine a truncated mesh with legacy. Geometry remains approximate
 * piecewise-linear tetrahedra; granular cubic thin boost explicitly falls back.
 * draw(rp): rgba16float/depth32float. drawShadow(rp,{matrix}): depth32float,
 * matrix maps physical GRID -> light clip ([0,1] depth), not FU.model space.
 * Neither recording method opens/submits a pass or performs a GPU wait.
 */
export function createHybridSmooth(gpu, sim, { capacityPerBrick = 256, shader = {} } = {}) {
  if (!Number.isSafeInteger(capacityPerBrick) || capacityPerBrick <= 0 || capacityPerBrick > 3000) throw new RangeError('Invalid smooth capacityPerBrick (1..3000)');
  if (shader.wgsl !== undefined && typeof shader.wgsl !== 'string') throw new TypeError('shader.wgsl must be WGSL');
  if (shader.handlesAppearance && !shader.wgsl) throw new TypeError('Appearance support requires a shader adapter');
  if (Boolean(shader.layout) !== Boolean(shader.bind)) throw new TypeError('shader.layout and shader.bind must be supplied together');
  if ((shader.layout ?? []).some((e) => e.binding < 4)) throw new RangeError('Smooth shader bindings must start at 4');
  const g = sim.g, derived = sim.derived, fu = frameUniformsOf(gpu);
  if (!derived?.dlist || !derived.views?.fieldSurf || !derived.views?.fieldThin) throw new Error('Hybrid smooth requires attached derived fields');
  const limit = Math.min(gpu.device.limits.maxStorageBufferBindingSize, gpu.device.limits.maxBufferSize ?? Infinity);
  const capacity = Math.min(capacityPerBrick, Math.floor(limit / (g.nbricks * 4)));
  if (capacity < 1 || g.nbricks * 12 > limit) throw new RangeError('Smooth descriptors exceed device storage limits');
  const label = (s) => `sim${sim.id} hybrid smooth ${s}`;
  const extractLayout = gpu.layout('HYBRID_SMOOTH_EXTRACT', SMOOTH_EXTRACT_LAYOUT);
  // Optional shared material/lighting bindings extend the existing group 2 ABI.
  const drawLayout = gpu.layout(label('draw layout'), [...SMOOTH_DRAW_LAYOUT, ...(shader.layout ?? [])]);
  const buffer = (s, size, usage = STORAGE) => gpu.createBuffer({ label: label(s), size, usage });
  const triangles = buffer('triangles', g.nbricks * capacity * 4);
  const meta = buffer('meta', g.nbricks * 12), status = buffer('status', 16);
  const args = buffer('indirect', 16, STORAGE | INDIRECT);
  const ring = gpu.readback.ring(label('status results'), 16, 16);
  const b = (binding, buffer) => ({ binding, resource: { buffer } });
  const extractBind = gpu.bindGroup(extractLayout, [
    { binding: 0, resource: derived.views.fieldSurf }, { binding: 1, resource: derived.views.fieldThin },
    ...[derived.dlist, triangles, meta, status, args, ring.buffer].map((v, i) => b(i + 2, v)),
  ], label('extract'));
  const baseEntries = [{ binding: 0, resource: derived.views.fieldSurf }, b(1, triangles), b(2, meta), b(3, status)];
  // bind is an array of GPUBindGroupEntry, or frame -> array; no allocation in
  // the draw loop. Refresh the composed bind only in update when necessary.
  let drawBind = null, extraEntries = null;
  const code = smoothExtractWGSL(g);
  const meshDesc = { code, layouts: [sim.L.TABLES, sim.L.STATE_RO, extractLayout], params: SmoothParams };
  const extract = gpu.kernel({ name: 'hybrid.smooth.extract', ...meshDesc, entry: 'extract', workgroupSize: [128, 1, 1] });
  const finish = gpu.kernel({ name: 'hybrid.smooth.finish', ...meshDesc, entry: 'finish', workgroupSize: [1, 1, 1] });
  const drawCode = smoothDrawWGSL(g, { shadingWGSL: shader.wgsl });
  const drawDesc = { code: drawCode, layouts: [fu.layout, sim.L.STATE_RO, drawLayout], params: SmoothParams,
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' } };
  const drawPipe = gpu.renderPipeline({ name: 'hybrid.smooth.draw', ...drawDesc, fragment: { targets: [{ format: 'rgba16float' }] } });
  const shadowPipe = gpu.renderPipeline({ name: 'hybrid.smooth.shadow', ...drawDesc, vertex: { entry: 'shadowVS' }, fragment: null });
  const pipes = [extract, finish, drawPipe, shadowPipe];
  let disposed = false, key = null, lastRevision, lastOrigin, generation = 0, frameState = {};
  const stats = { builds: 0, capacityPerBrick: capacity, count: 0, flags: 0, requiredPerBrick: 0,
    rebuiltBricks: 0, pending: false, fallbackRequired: true, fallbackReason: 'not-built', readbackError: null };
  const fallback = (reason) => { stats.fallbackRequired = !!reason; stats.fallbackReason = reason; };
  function blocked(frame) {
    if (gpu.failure || sim.disposed || sim.g !== g || sim.derived !== derived || sim.fieldSurf !== derived.fieldSurf || sim.fieldThin !== derived.fieldThin) return 'grid-or-device-unavailable';
    if (typeof frame.revision !== 'string' && !(typeof frame.revision === 'number' && Number.isFinite(frame.revision))) return 'derived-revision-required';
    if (!shader.handlesAppearance && (frame.sourceStyle || fu.last?.sourceStyle || sim.deco?.active)) return 'source-or-decoration-unsupported';
    return '';
  }
  const params = (matrix = IDENTITY) => ({ capacity, full: 0, unsupported: 0, slot: 0, matrix });
  const api = {
    ready: Promise.all(pipes.map((p) => p.ready)).then(() => api),
    get isReady() { return !disposed && !gpu.failure && pipes.every((p) => p.state === 'ready'); },
    get revision() { return `${generation}|${key}|${stats.fallbackReason}`; },
    capabilities: Object.freeze({ particleSplit: false, channels: [2, 3], thinGranular: false }),
    stats,
    resources: { triangles, meta, status, args, capacityPerBrick: capacity, layout: drawLayout, get bind() { return drawBind; } },
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
      const nextKey = `${context}|${frame.revision}`;
      if (key === nextKey && !frame.force) {
        fallback(stats.readbackError ? 'status-readback-failed' : stats.pending ? 'status-pending' : stats.flags ? 'unsupported-surface' : '');
        return false;
      }
      const full = !key || frame.force || !frame.incremental || frame.previousRevision !== lastRevision || lastOrigin !== `${o.x},${o.y},${o.z}`;
      lastOrigin = `${o.x},${o.y},${o.z}`;
      key = nextKey;
      lastRevision = frame.revision;
      const token = ++generation;
      stats.pending = true; stats.readbackError = null;
      fallback('status-pending');
      const bind = [sim.tables, sim.bindRO, extractBind], header = sim.header();
      const p = { ...params(), full: full ? 1 : 0, unsupported: 0 };
      extract.dispatch(gpu.frame, fold(g.nbricks), { bind, header, params: p });
      const slot = ring.next();
      finish.dispatch(gpu.frame, [1, 1, 1], { bind, header, params: { ...p, slot } });
      stats.builds++;
      ring.read(slot).then((bytes) => {
        if (disposed || token !== generation) return;
        const [flags, count, required, rebuilt] = new Uint32Array(bytes);
        Object.assign(stats, { flags, count, requiredPerBrick: required, rebuiltBricks: rebuilt, pending: false });
        fallback(blocked(frameState) || (flags & SMOOTH_FLAGS.OVERFLOW ? 'capacity-overflow' : flags ? 'unsupported-surface' : ''));
      }, (error) => {
        if (disposed || token !== generation) return;
        stats.pending = false; stats.readbackError = String(error); fallback('status-readback-failed');
      });
      return true;
    },
    draw(rp) {
      if (!canDraw()) return false;
      drawPipe.draw(rp, { bind: [fu.group, sim.bindRO, drawBind], header: sim.header(), params: params(), indirect: { buffer: args } });
      return true;
    },
    drawShadow(rp, { matrix } = {}) {
      if (!matrix || !canDraw()) return false;
      shadowPipe.draw(rp, { bind: [fu.group, sim.bindRO, drawBind], header: sim.header(), params: params(matrix), indirect: { buffer: args } });
      return true;
    },
    invalidate() { key = null; generation++; stats.pending = false; fallback('invalidated'); },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; stats.pending = false; fallback('disposed');
      gpu.flush('hybrid smooth dispose'); ring.close();
      for (const v of [triangles, meta, status, args]) v.destroy();
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
