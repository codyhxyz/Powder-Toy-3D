import { fold } from '../../gpu/kernels.js';
import { MEDIA_FLOOR } from '../materials.js';
import { FIELD_BOUNDS_LAYOUT, fieldBoundsWGSL } from '../../shaders/hybrid/fieldBounds.js';

// Passive retirement: never flush, submit, poll or schedule timers. A single
// microtask handles the usual auto-flush; the temporary flush observer handles
// an encoder deliberately held open across tasks, including after dispose().
const retirements = new WeakMap();
export function retireMediaResources(gpu, resources, encoder) {
  if (!resources) return;
  const destroy = () => Object.values(resources).forEach((r) => r.destroy());
  if (!encoder || gpu.frame.encoder !== encoder || gpu.lost || gpu.failure) { destroy(); return; }
  const frame = gpu.frame;
  let state = retirements.get(frame);
  if (!state) {
    const own = Object.getOwnPropertyDescriptor(frame, 'flush');
    const original = frame.flush;
    state = { pending: [], collect() {
      if (retirements.get(frame) !== state) return;
      state.pending = state.pending.filter((item) => {
        if (frame.encoder === item.encoder && !gpu.lost && !gpu.failure) return true;
        item.destroy(); return false;
      });
      if (!state.pending.length) {
        if (frame.flush === wrapped) {
          if (own) Object.defineProperty(frame, 'flush', own); else delete frame.flush;
        }
        retirements.delete(frame);
      }
    } };
    const wrapped = function (...args) {
      try { return original.apply(this, args); } finally { state.collect(); }
    };
    if (typeof original === 'function') frame.flush = wrapped;
    retirements.set(frame, state);
  }
  state.pending.push({ encoder, destroy });
  queueMicrotask(() => state.collect());
}

export function createFieldBounds(gpu, sim) {
  const layout = gpu.layout('HYBRID_MEDIA_BOUNDS', FIELD_BOUNDS_LAYOUT);
  const make = (entry) => gpu.kernel({ name: `hybrid media bounds ${entry}`, code: fieldBoundsWGSL,
    entry, layouts: [layout], workgroupSize: [64, 1, 1] });
  const scan = make('scan'), finish = make('finish');
  let buffers = null, dims = '', view = null, revision, encoder = null;
  const stats = { scans: 0, allocations: 0 };
  return {
    ready: Promise.all([scan.ready, finish.ready]),
    get isReady() { return scan.state === 'ready' && finish.state === 'ready'; },
    stats,
    ensure() {
      if (scan.state !== 'ready' || finish.state !== 'ready') throw new Error('media bounds not ready');
      const nextView = sim.derived.views.fieldMedia;
      if (!nextView) throw new Error('media derived field required');
      const grid = [sim.g.nx, sim.g.ny, sim.g.nz], key = grid.join(',');
      const n = grid.reduce((a, d) => a * Math.ceil(d / 4), 1);
      if (!buffers || key !== dims) {
        const next = {};
        try {
          next.bricks = gpu.createBuffer({ label: 'media brick bounds', size: n * 32, usage: 0x80 });
          next.bounds = gpu.createBuffer({ label: 'media field bounds', size: 32, usage: 0x80 });
        } catch (error) { Object.values(next).forEach((b) => b.destroy()); throw error; }
        retireMediaResources(gpu, buffers, gpu.frame.encoder ?? encoder);
        buffers = next; dims = key; view = null; stats.allocations++;
      }
      if (view !== nextView || revision !== sim.derived.frameNo) {
        const group = gpu.bindGroup(layout, [{ binding: 0, resource: nextView },
          { binding: 1, resource: { buffer: buffers.bricks } }, { binding: 2, resource: { buffer: buffers.bounds } }], 'media bounds');
        const args = { bind: [group], header: sim.header() };
        scan.dispatch(gpu.frame, fold(n), args);
        finish.dispatch(gpu.frame, [1, 1, 1], args);
        view = nextView; revision = sim.derived.frameNo; stats.scans++;
      }
      // The returned buffer can be referenced by optics before media.record.
      encoder = gpu.frame.encoder ?? null;
      return { buffer: buffers.bounds };
    },
    dispose() { retireMediaResources(gpu, buffers, gpu.frame.encoder ?? encoder); buffers = null; },
  };
}

// CPU reference of the final-field contract (not raw cell occupancy).
export function fieldBoundsReference(grid, sample) {
  const lo = [...grid], hi = [0, 0, 0]; let count = 0;
  for (let z = 0; z < grid[2]; z++) for (let y = 0; y < grid[1]; y++) for (let x = 0; x < grid[0]; x++) {
    if (!sample(x, y, z).slice(0, 3).some((v) => v > MEDIA_FLOOR)) continue;
    count++;
    [x, y, z].forEach((p, a) => { lo[a] = Math.min(lo[a], p); hi[a] = Math.max(hi[a], p + 1); });
  }
  return new Uint32Array([...lo.map((v) => count ? Math.max(0, v - 2) : 0), count,
    ...hi.map((v, a) => count ? Math.min(grid[a], v + 2) : 0), 0]);
}
export function fieldRayBoundsReference(bounds, origin, direction, limit) {
  if (!bounds[3]) return [0, 0];
  let lo = 0, hi = limit;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(direction[a]) < 1e-8) {
      if (origin[a] < bounds[a] || origin[a] > bounds[a + 4]) return [0, 0];
    } else {
      const x = (bounds[a] - origin[a]) / direction[a], y = (bounds[a + 4] - origin[a]) / direction[a];
      lo = Math.max(lo, Math.min(x, y)); hi = Math.min(hi, Math.max(x, y));
    }
  }
  return [lo, Math.max(lo, hi)];
}
