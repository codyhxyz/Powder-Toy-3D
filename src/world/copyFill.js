// The physics region's fill from the world copy (docs/seamless-world.md, "P — physics region"): the
// slab a move uncovers, or a whole window at load, decoded from W's world copy into Physics V2's cores
// (shaders/world/physicsFill.js), the generator's own import kept wherever the copy agrees with it.
// world/window.js makes one when a world copy is attached (attachWorldCopy) and lays the exact native
// store over what it writes.
import { copyGatherWGSL, copyFillWGSL, CopyFillParams, copyFillSize, copyWordsFor, COPY_FILL_WORDS_AT } from '../shaders/world/physicsFill.js';
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
    this.kernels = {
      gather: gpu.kernel({ name: `${win.scene.key} copy gather`, code: copyGatherWGSL(g, code), params: CopyFillParams,
        layouts: [sim.L.TABLES, copy.layout, wordsLayout] }),
      fill: gpu.kernel({ name: `${win.scene.key} copy fill`, code: copyFillWGSL(g, gen.code), params: CopyFillParams,
        layouts: [sim.L.TABLES, gpu.layout('NATIVE_WORLD_WRITE', NATIVE_WRITE_LAYOUT), this.sceneLayout] }),
    };
    this.ready = Promise.all(Object.values(this.kernels).map((k) => k.ready));
    this._sceneGroup = null; this._for = null;
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
    if (this._for !== gen.res.data || !this._sceneGroup) {
      this._for = gen.res.data;
      this._sceneGroup = gpu.bindGroup(this.sceneLayout, gen.res.entries([{ binding: COPY_FILL_WORDS_AT, resource: { buffer: this.words } }]), 'copy fill scene');
    }
    const write = nativeWriteGroup(sim), axis = box.hi[0] - box.lo[0] <= box.hi[2] - box.lo[2] ? 0 : 2;
    gen.res.prepassFor(box.lo.map((v, i) => v + origin[i]), box.hi.map((v, i) => v + origin[i]));
    // (the slabs along the box's short axis, each within the words: one for a move, a window's at load)
    for (let at = box.lo[axis]; at < box.hi[axis]; at += this.slab) {
      const part = { lo: [...box.lo], hi: [...box.hi] };
      part.lo[axis] = at; part.hi[axis] = Math.min(box.hi[axis], at + this.slab);
      if (copyWordsFor(part.lo, part.hi) > this.wordsCap) throw new Error('world copy fill: a slab outgrows its words');
      const size = copyFillSize(part.lo, part.hi), params = { origin, lo: part.lo, hi: part.hi };
      sim._dispatch(this.kernels.gather, size, { bind: [sim.tables, this.copy.bindGroup, this.gatherGroup], header: sim.header(), params });
      sim._dispatch(this.kernels.fill, size, { bind: [sim.tables, write, this._sceneGroup], header: sim.header(), params });
    }
    // as world/gpu.js nativeWritten notes a native write, the derived passes aside on a physics-only move
    sim.version++;
    if (picture) sim.changedAll = true;
    owner.wake();
    sim.wake();
    return true;
  }

  dispose() { this.sim._retire(this.words); }
}
