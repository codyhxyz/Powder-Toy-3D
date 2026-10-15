import { gridDims, stateLayout, cellSlot } from '../shaders/common.js';
import { MAX_FOOT } from '../shaders/stamp.js';
import { fold } from '../gpu/kernels.js';
import { rawGenerateWGSL, rawStampWGSL, rawApplyWGSL, RAW_LAYOUT, RAW_READ_LAYOUT, APPLY_STATE, RawParams, RawApplyParams } from '../shaders/renderSource.js';
import { TREE } from './generator.js';
import { runGenerator, bake } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { planSourceCopies, recordSourceCopies, intersectBounds, snapshotSource, sourceBounds, SOURCE_RANK } from './renderSource.js';

// Complete vertical columns avoid recursive footing support at a scratch y
// edge. A 16-cell x/z halo is NOT a field support assertion: stamp footing
// reads only its own x/z (stampLib). Shapes may have roots outside this box;
// candidate selection uses TREE.REACH and actual baked bounds, not root residency.
export function rawSourceGrid(height) { return gridDims({ nx: 64, ny: height, nz: 64 }); }
export function treeColumnMask(win, origin, g) {
  const mask = new Uint32Array(g.bx * g.bz);
  for (let z = 0; z < g.bz; z++) for (let x = 0; x < g.bx; x++) {
    const wx = origin[0] / 4 + x, wz = origin[2] / 4 + z;
    if (wx >= 0 && wz >= 0 && wx < win.wb[0] && wz < win.wb[2] && !win.planted[wz * win.wb[0] + wx]) mask[x + g.bx * z] = 1;
  }
  return mask;
}
export const bakeSourceTree = (t, generator = BUILTINS.TREE) => bake(runGenerator(generator, { size: t.size, seed: t.seed, variant: t.variant }), t.quarter);
export function sourceTrees(win, origin, g) {
  if (!win.scene.trees) return [];
  const R = TREE.REACH;
  if (win.candidates.size > 1 << 16) win.candidates.clear(); // immutable placement memo only, never source residency
  const candidates = win.scene.trees.treesIn(origin[0] - R, origin[2] - R, origin[0] + g.nx + R, origin[2] + g.nz + R, win.P, win.candidates);
  // Stable WORLD order, independent of chunk partition/query/cache order.
  return [...candidates].sort((a, b) => Math.floor(a.z / 4) - Math.floor(b.z / 4) || Math.floor(a.x / 4) - Math.floor(b.x / 4) || a.z - b.z || a.x - b.x).flatMap((t) => {
    const s = win.bakeTree ? win.bakeTree(t) : bakeSourceTree(t, win.treeGenerator);
    if (!s) return [];
    const at = [t.x - s.base.x, t.y - s.base.y, t.z - s.base.z];
    if (at[0] + s.w <= origin[0] || at[0] >= origin[0] + g.nx || at[2] + s.d <= origin[2] || at[2] >= origin[2] + g.nz) return [];
    return [{ s, at: at.map((v, i) => v - origin[i]), seed: t.seed >>> 0 }];
  });
}

export class RawWorldSourceProducer {
  constructor(win, source, { context = null, kernels = null } = {}) {
    this.win = win; this.context = context ?? win; this.source = source; this.sim = win.sim; this.gpu = win.gpu;
    this.resources = context?.resources ?? win.gen.res;
    this.g = rawSourceGrid(this.context.size[1]); this.disposed = false; this.buffers = null;
    const gpu = this.gpu, sim = this.sim;
    if (kernels) {
      if (!context || !kernels.sceneGroup) throw new Error('Await original producer readiness before capturing a cut');
      for (const key of ['rawL', 'readL', 'generate', 'stamp', 'sceneLayout']) this[key] = kernels[key];
      this.sceneGroup = gpu.bindGroup(this.sceneLayout, this.resources.entries(), 'owned cut scene');
      this.ready = Promise.resolve(this);
      return;
    }
    this.rawL = gpu.layout('world raw source writer', RAW_LAYOUT);
    this.readL = gpu.layout('world raw source reader', RAW_READ_LAYOUT);
    this.applyStateL = gpu.layout('world raw source physics apply', stateLayout(APPLY_STATE));
    const layouts = [sim.L.TABLES, this.rawL, win.gen.res.layout && gpu.layout(`scene raw ${win.scene.key}`, win.gen.res.layout)];
    this.sceneLayout = layouts[2];
    this.generate = gpu.kernel({ name: `${win.scene.key} raw source`, code: rawGenerateWGSL(this.g, win.scene), layouts, params: RawParams });
    this.stamp = gpu.kernel({ name: 'raw source stamp', code: rawStampWGSL(this.g), layouts: [sim.L.TABLES, this.rawL], params: RawParams });
    this.apply = gpu.kernel({ name: 'raw source apply', code: rawApplyWGSL(sim.g, this.g), layouts: [sim.L.TABLES, this.applyStateL, this.readL], params: RawApplyParams });
    this.ready = Promise.all([win.gen.ready, this.generate.ready, this.stamp.ready, this.apply.ready]).then(() => {
      if (this.disposed) return this;
      this.sceneGroup = gpu.bindGroup(layouts[2], win.gen.res.entries(), 'raw source scene');
      this.applyState = gpu.bindGroup(this.applyStateL, [sim.state.A, sim.state.B, sim.state.F, sim.marks].map((buffer, binding) => ({ binding, resource: { buffer } })), 'raw source physics');
      return this;
    });
    this.ready.catch(() => {});
  }
  _init(shapeBytes) {
    const g = this.g, source = this.source;
    if (!this.buffers) {
      this.buffers = { g, origin: [0, 0, 0], copy: 0,
        A: source._buffer('scratch A', g.slots * 16 * 2), B: source._buffer('scratch B', g.slots * 16 * 2),
        touched: source._buffer('scratch touched', g.slots * 4), columns: source._buffer('scratch columns', g.bx * g.bz * 4) };
    }
    if (!this.shapes || this.shapes.size < shapeBytes) {
      if (this.shapes) this.source._retire(this.shapes);
      this.shapes = source._buffer('scratch baked shapes', Math.max(16, shapeBytes));
      this.group = null;
    }
    if (!this.group) {
      const b = this.buffers;
      this.group = this.gpu.bindGroup(this.rawL, [b.A, b.B, b.touched, b.columns, this.shapes].map((buffer, binding) => ({ binding, resource: { buffer } })), 'raw source writer');
      this.readGroup = this.gpu.bindGroup(this.readL, [b.A, b.B, b.touched].map((buffer, binding) => ({ binding, resource: { buffer } })), 'raw source read');
    }
  }
  // Synchronous RECORDING after ready, version checked before publication.
  // Callers awaiting readiness must retain their token from BEFORE the await.
  record(frame, coreXZ, token = this.source.token(), { physicsBounds = null } = {}) {
    if (this.disposed || (this.source.ownedContext && !this.source.ownedContext.isValid()) || token.epoch !== this.source.epoch || token.revision !== this.source.revision) return null;
    if (this.source.ownedContext && physicsBounds) throw new Error('An owned cut never applies generated data to current physics');
    const win = this.context, g = this.g, origin = [coreXZ[0] - 16, 0, coreXZ[1] - 16];
    const trees = sourceTrees(win, origin, g), mask = treeColumnMask(win, origin, g);
    const words = trees.reduce((n, t) => n + t.s.data.length, 0), shapes = new Float32Array(words);
    let base = 0;
    for (const t of trees) { t.base = base / 4; shapes.set(t.s.data, base); base += t.s.data.length; }
    this._init(shapes.byteLength);
    const raw = this.buffers; raw.origin = origin; raw.copy = 0;
    // Ordered uploads cannot alter an earlier record that still reads scratch.
    this.source.recordUpload(frame, raw.columns, 0, mask);
    if (shapes.length) this.source.recordUpload(frame, this.shapes, 0, shapes);
    this.resources.prepassFor(origin, origin.map((v, i) => v + [g.nx, g.ny, g.nz][i]));
    const size = fold(Math.ceil(g.slots / 64)), header = (src = 0, dst = src) => ({ origin: [...origin], src, dst });
    const params = { at: [0, 0, 0], foot: 0, size: [0, 0, 0], seed: 0, base: 0 };
    this.generate.dispatch(frame, size, { bind: [this.sim.tables, this.group, this.sceneGroup], header: header(), params });
    const box = { lo: origin, hi: origin.map((v, i) => v + [g.nx, g.ny, g.nz][i]) };
    this.source.recordStore(box, token);
    // Store, then captured, then CURRENT live. All overlays are GPU copies;
    // store bytes were already losslessly decoded by the source cache.
    for (const c of this.source.chunks.values()) {
      const runs = planSourceCopies(c, raw, box, (_d, p) => c.rank[cellSlot(c.g, ...p.map((v, i) => v - c.origin[i]))] >= SOURCE_RANK.saved);
      recordSourceCopies(frame, c, raw, runs, { aux: false });
      // Exact saved/edited/captured cells may support a new tree but are not
      // tree-owned writes. A/B store commit never relinquishes that authority.
      for (const r of runs) this.source.recordUpload(frame, raw.touched, r.dst * 4, new Uint32Array(r.cells).fill(0x80000000));
    }
    if (!this.source.ownedContext && (win.loaded || physicsBounds)) {
      const live = snapshotSource(this.sim), liveBox = intersectBounds(box, sourceBounds(this.sim));
      if (liveBox) recordSourceCopies(frame, live, raw, planSourceCopies(live, raw, liveBox), { aux: false });
    }
    for (const t of trees) {
      const s = t.s, next = 1 - raw.copy;
      this.stamp.dispatch(frame, size, { bind: [this.sim.tables, this.group], header: header(raw.copy, next),
        params: { at: t.at, foot: Math.min(s.foot ?? 0, MAX_FOOT), size: [s.w, s.h, s.d], seed: t.seed, base: t.base } });
      raw.copy = next;
    }
    const core = { lo: [coreXZ[0], 0, coreXZ[1]], hi: [coreXZ[0] + 32, win.size[1], coreXZ[1] + 32] };
    // A synchronous scene/edit callback may also overtake recording. Encoded
    // scratch work is orphaned, never advertised as current source authority.
    if (this.disposed || (this.source.ownedContext && !this.source.ownedContext.isValid()) || token.epoch !== this.source.epoch || token.revision !== this.source.revision) return null;
    // Cached generated output is never allowed over a newer live/capture/save.
    this.source.recordPopulate(frame, { ...raw, origin: [...origin], bounds: core }, token);
    if (physicsBounds) {
      const world = intersectBounds(core, physicsBounds);
      if (world) {
        const o = snapshotSource(this.sim).origin;
        this.apply.dispatch(frame, fold(Math.ceil(this.sim.g.slots / 64)), { bind: [this.sim.tables, this.applyState, this.readGroup], header: this.sim.header(),
          params: { sourceOrigin: [...origin], copy: raw.copy, lo: world.lo.map((v, i) => v - o[i]), hi: world.hi.map((v, i) => v - o[i]) } });
      }
    }
    return { epoch: token.epoch, revision: token.revision, core, trees: trees.length };
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const b of [this.buffers?.A, this.buffers?.B, this.buffers?.touched, this.buffers?.columns, this.shapes]) if (b) this.source._retire(b);
    this.buffers = null; this.shapes = null;
  }
}
