// The physics region's fill from the world copy (docs/seamless-world.md, "P — physics region"): the
// slab a move uncovers, or a whole window at load, decoded from W's world copy into Physics V2's cores
// (shaders/world/physicsFill.js), the generator's own import kept wherever the copy agrees with it.
// world/window.js makes one when a world copy is attached (attachWorldCopy) and lays the exact native
// store over what it writes.
import { copyGatherWGSL, copyStageWGSL, copyCommitWGSL, CopyFillParams, copyFillSize, copyWordsFor, COPY_FILL_WORDS_AT } from '../shaders/world/physicsFill.js';
import { NATIVE_WRITE_LAYOUT } from '../shaders/worldWrite.js';
import { nativeWriteGroup } from './gpu.js';
import { STAGE } from '../shaders/common.js';

export class WorldCopyFill {
  /**
   * @param {import('./window.js').WorldWindow} win the physics window (its generator, its sim)
   * @param {{ layout: object, bindGroup: object }} copy W's WorldCopy (group 1 of the gather)
   * @param {{ wgsl: string | ((g: object) => string), slab?: number }} opts wgsl: W's worldCopyWGSL (declares
   *   group 1, wcCell); slab: cells along x (or z) a fill covers at a time (a move's slab; a load loops)
   */
  constructor(win, copy, { wgsl, slab = 16 }) {
    const sim = win.sim, gpu = sim.gpu, gen = win.gen, g = sim.g;
    this.win = win; this.sim = sim; this.copy = copy; this.slab = slab;
    const code = typeof wgsl === 'function' ? wgsl(g) : wgsl;
    if (typeof code !== 'string' || !/fn\s+wcCell\s*\(/.test(code)) throw new Error('world copy fill: the copy module declares no wcCell');
    // the box's words: a slab across the window either way, x or z
    const words = Math.max(copyWordsFor([0, 0, 0], [slab, g.ny, g.nz]), copyWordsFor([0, 0, 0], [g.nx, g.ny, slab]));
    this.words = gpu.createBuffer({ label: 'copy fill words', size: words * 4, usage: GPUBufferUsage.STORAGE });
    this.wordsCap = words;
    const wordsLayout = gpu.layout('copy fill words', [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }]);
    this.gatherGroup = gpu.bindGroup(wordsLayout, [{ binding: 0, resource: { buffer: this.words } }], 'copy fill words');
    this.sceneLayout = gpu.layout(`copy fill ${JSON.stringify(gen.res.has)}`,
      [...gen.res.layout, { binding: COPY_FILL_WORDS_AT, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }]);
    // The fill in two steps through a slab's buffer of cores, the stage (the scene and the copy's words
    // decoded: copyFillWGSL's cores) and the commit (V2's write of them), so a move's can be staged a frame
    // or more ahead (stage, commitStaged) and a load's run both at once (fill): one slab's cores, kept for
    // the move they were made for.
    const storage = (type) => [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type } }];
    this.stagedLayout = gpu.layout('copy staged', storage('storage'));
    this.stagedReadLayout = gpu.layout('copy staged read', storage('read-only-storage'));
    this.stagedBuf = gpu.createBuffer({ label: 'copy fill staged cores', size: words * 16, usage: GPUBufferUsage.STORAGE });
    this.stageGroups = [gpu.bindGroup(this.stagedLayout, [{ binding: 0, resource: { buffer: this.stagedBuf } }], 'copy staged'),
      gpu.bindGroup(this.stagedReadLayout, [{ binding: 0, resource: { buffer: this.stagedBuf } }], 'copy staged read')];
    this.kernels = {
      gather: gpu.kernel({ name: `${win.scene.key} copy gather`, code: copyGatherWGSL(g, code), params: CopyFillParams,
        layouts: [sim.L.TABLES, copy.layout, wordsLayout] }),
      stage: gpu.kernel({ name: `${win.scene.key} copy stage`, code: copyStageWGSL(g, gen.code), params: CopyFillParams,
        layouts: [sim.L.TABLES, this.stagedLayout, this.sceneLayout] }),
      commit: gpu.kernel({ name: `${win.scene.key} copy commit`, code: copyCommitWGSL(g), params: CopyFillParams,
        layouts: [sim.L.TABLES, gpu.layout('NATIVE_WORLD_WRITE', NATIVE_WRITE_LAYOUT), this.stagedReadLayout] }),
    };
    this.staged = null;   // { key, epoch, data }: the move the staged cores are for
    this.stages = 0;      // (tools)
    this.ready = Promise.all(Object.values(this.kernels).map((k) => k.ready));
    this._sceneGroup = null; this._for = null;
  }
  get stageReady() { return this.isReady; }
  _box(lo, hi) {
    const g = this.sim.g;
    return { lo: lo.map((v) => Math.max(0, v)), hi: hi.map((v, i) => Math.min(v, [g.nx, g.ny, g.nz][i])) };
  }
  _key(origin, box) { return `${origin.join()}|${box.lo.join()}|${box.hi.join()}`; }
  _scene() {
    const gen = this.win.gen, gpu = this.sim.gpu;
    if (this._for !== gen.res.data || !this._sceneGroup) {
      this._for = gen.res.data;
      this._sceneGroup = gpu.bindGroup(this.sceneLayout, gen.res.entries([{ binding: COPY_FILL_WORDS_AT, resource: { buffer: this.words } }]), 'copy fill scene');
    }
    return this._sceneGroup;
  }

  /**
   * Work out ahead the fill of grid cells [lo, hi) for the window at world origin `origin` (after the move
   * that will uncover them): the scene's prepass, the copy's words and their cores, into the staged buffer,
   * recorded now, a frame or more before the move (world/window.js update). Nothing writes to the world
   * copy outside the window, and the generator is fixed, so the move's commitStaged writes the cores the
   * fill would have. One slab at a time; a later stage replaces it. Returns whether it recorded.
   */
  stage(origin, lo, hi) {
    const sim = this.sim, gen = this.win.gen, box = this._box(lo, hi);
    if (!this.stageReady || box.lo.some((v, i) => v >= box.hi[i])) return false;
    const axis = box.hi[0] - box.lo[0] <= box.hi[2] - box.lo[2] ? 0 : 2;
    if (box.hi[axis] - box.lo[axis] > this.slab || copyWordsFor(box.lo, box.hi) > this.wordsCap) return false;
    const key = this._key(origin, box);
    if (this.staged?.key === key && this.staged.epoch === this.win.epoch && this.staged.data === gen.res.data) return true;
    const scene = this._scene(), size = copyFillSize(box.lo, box.hi), params = { origin, lo: box.lo, hi: box.hi };
    gen.res.prepassFor(box.lo.map((v, i) => v + origin[i]), box.hi.map((v, i) => v + origin[i]));
    sim._dispatch(this.kernels.gather, size, { bind: [sim.tables, this.copy.bindGroup, this.gatherGroup], header: sim.header(), params });
    sim._dispatch(this.kernels.stage, size, { bind: [sim.tables, this.stageGroups[0], scene], header: sim.header(), params });
    this.staged = { key, epoch: this.win.epoch, data: gen.res.data };
    this.stages++;
    return true;
  }

  /**
   * The move's fill from the staged cores (stage), when they are for this box at this origin: the fill's own
   * write of them (nativeWriteCore), its notes and wakes as fill's. Returns false otherwise (the caller
   * fills: fill).
   */
  commitStaged(origin, lo, hi, { picture = true } = {}) {
    const sim = this.sim, owner = sim.compact, gen = this.win.gen, box = this._box(lo, hi), st = this.staged;
    if (!st || st.key !== this._key(origin, box) || st.epoch !== this.win.epoch || st.data !== gen.res.data || !this.stageReady) return false;
    if (sim.nativeTransitionKind === 'shift' && !sim.nativeCommitting) return false;
    this.staged = null;
    owner.sync();
    sim._dispatch(this.kernels.commit, copyFillSize(box.lo, box.hi), { bind: [sim.tables, nativeWriteGroup(sim), this.stageGroups[1]], header: sim.header(),
      params: { origin, lo: box.lo, hi: box.hi } });
    sim.version++;
    // V2's own write, noted by the commit itself (nativeWriteCore): the owner has nothing of V1's to import
    // for it, as NativeIntegration.changed tells it after its scatter. (The move's next sync, the exact
    // store's restore, otherwise ran a whole window's import for nothing: 1.6 ms of the move's GPU,
    // P2's slot 3, 2026-10-24.)
    owner.seenVersion = sim.version;
    if (picture) sim.changedAll = true;
    owner.wake();
    sim.wake();
    return true;
  }
  /** Whether a fill can record now (V2 runs the grid and the kernels are built). */
  get isReady() { return Object.values(this.kernels).every((k) => k.state === 'ready') && !!this.sim.compact?.isReady; }

  /**
   * Fill grid cells [lo, hi) of the window at world cell origin from the copy, a slab at a time. Notes
   * the bricks it changed (shaders/worldWrite.js nativeWriteCore) and wakes V2; never the derived passes
   * when the move is physics only (picture: false). Returns false when it can't record (the caller falls
   * back to the generator).
   */
  fill(origin, lo, hi, { picture = true } = {}) {
    const sim = this.sim, owner = sim.compact, gpu = sim.gpu, g = sim.g, gen = this.win.gen;
    if (!this.isReady) return false;
    if (sim.nativeTransitionKind === 'shift' && !sim.nativeCommitting) return false;
    const box = { lo: lo.map((v) => Math.max(0, v)), hi: hi.map((v, i) => Math.min(v, [g.nx, g.ny, g.nz][i])) };
    if (box.lo.some((v, i) => v >= box.hi[i])) return true;
    owner.sync();   // (V1 writes pending before it are imported first)
    this.staged = null;   // (the staged cores are a slab's of this fill now)
    const scene = this._scene(), write = nativeWriteGroup(sim), axis = box.hi[0] - box.lo[0] <= box.hi[2] - box.lo[2] ? 0 : 2;
    gen.res.prepassFor(box.lo.map((v, i) => v + origin[i]), box.hi.map((v, i) => v + origin[i]));
    // (the slabs along the box's short axis, each within the words: one for a move, a window's at load)
    for (let at = box.lo[axis]; at < box.hi[axis]; at += this.slab) {
      const part = { lo: [...box.lo], hi: [...box.hi] };
      part.lo[axis] = at; part.hi[axis] = Math.min(box.hi[axis], at + this.slab);
      if (copyWordsFor(part.lo, part.hi) > this.wordsCap) throw new Error('world copy fill: a slab outgrows its words');
      const size = copyFillSize(part.lo, part.hi), params = { origin, lo: part.lo, hi: part.hi };
      sim._dispatch(this.kernels.gather, size, { bind: [sim.tables, this.copy.bindGroup, this.gatherGroup], header: sim.header(), params });
      sim._dispatch(this.kernels.stage, size, { bind: [sim.tables, this.stageGroups[0], scene], header: sim.header(), params });
      sim._dispatch(this.kernels.commit, size, { bind: [sim.tables, write, this.stageGroups[1]], header: sim.header(), params });
    }
    // as world/gpu.js nativeWritten notes a native write, the derived passes aside on a physics-only move
    sim.version++;
    if (picture) sim.changedAll = true;
    owner.wake();
    sim.wake();
    return true;
  }

  dispose() { this.sim._retire(this.words); this.sim._retire(this.stagedBuf); }
}
