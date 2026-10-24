// The physics region's fill from the world copy (docs/seamless-world.md, "P — physics region"): the
// slab a move uncovers, or a whole window at load, decoded from W's world copy into Physics V2's cores
// (shaders/world/physicsFill.js), the generator's own import kept wherever the copy agrees with it.
// world/window.js makes one when a world copy is attached (attachWorldCopy) and lays the exact native
// store over what it writes.
import { copyFillWGSL, CopyFillParams, copyFillSize, COPY_FILL_WRITE_AT } from '../shaders/world/physicsFill.js';
import { STAGE } from '../shaders/common.js';

const writeEntry = (binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } });

export class WorldCopyFill {
  /**
   * @param {import('./window.js').WorldWindow} win the physics window (its generator, its sim)
   * @param {{ layout: object, bindGroup: object }} copy W's WorldCopy (group 1 of the kernel)
   * @param {{ wgsl: string | ((g: object) => string) }} opts W's worldCopyWGSL (declares group 1, wcCell)
   */
  constructor(win, copy, { wgsl }) {
    const sim = win.sim, gpu = sim.gpu, gen = win.gen;
    this.win = win; this.sim = sim; this.copy = copy;
    const code = typeof wgsl === 'function' ? wgsl(sim.g) : wgsl;
    if (typeof code !== 'string' || !/fn\s+wcCell\s*\(/.test(code)) throw new Error('world copy fill: the copy module declares no wcCell');
    this.layout = gpu.layout(`copy fill ${JSON.stringify(gen.res.has)}`, [...gen.res.layout, ...[0, 1, 2].map((i) => writeEntry(COPY_FILL_WRITE_AT + i))]);
    this.kernel = gpu.kernel({
      name: `${win.scene.key} copy fill`, code: copyFillWGSL(sim.g, code, gen.code), params: CopyFillParams,
      layouts: [sim.L.TABLES, copy.layout, this.layout],
    });
    this.ready = this.kernel.ready;
    this._group = null; this._for = null;
  }
  /** Whether a fill can record now (V2 runs the grid and the kernel is built). */
  get isReady() { return this.kernel.state === 'ready' && !!this.sim.compact?.isReady; }

  /**
   * Fill grid cells [lo, hi) of the window at world cell origin from the copy. Notes the bricks it
   * changed (shaders/worldWrite.js nativeWriteCore) and wakes V2; never the derived passes when the
   * move is physics only (picture: false). Returns false when it can't record (the caller falls back).
   */
  fill(origin, lo, hi, { picture = true } = {}) {
    const sim = this.sim, owner = sim.compact, gpu = sim.gpu, g = sim.g, gen = this.win.gen;
    if (!this.isReady) return false;
    if (sim.nativeTransitionKind === 'shift' && !sim.nativeCommitting) return false;
    const box = { lo: lo.map((v) => Math.max(0, v)), hi: hi.map((v, i) => Math.min(v, [g.nx, g.ny, g.nz][i])) };
    if (box.lo.some((v, i) => v >= box.hi[i])) return true;
    owner.sync();   // (V1 writes pending before it are imported first)
    gen.res.prepassFor(box.lo.map((v, i) => v + origin[i]), box.hi.map((v, i) => v + origin[i]));
    const key = [owner.cells, owner.aux, owner.act, gen.res.data];
    if (!this._group || this._for.some((b, i) => b !== key[i])) {
      this._for = key;
      this._group = gpu.bindGroup(this.layout, gen.res.entries([owner.cells, owner.aux, owner.act]
        .map((buffer, i) => ({ binding: COPY_FILL_WRITE_AT + i, resource: { buffer } }))), 'copy fill');
    }
    sim._dispatch(this.kernel, copyFillSize(box.lo, box.hi), {
      bind: [sim.tables, this.copy.bindGroup, this._group], header: sim.header(), params: { origin, lo: box.lo, hi: box.hi },
    });
    // as world/gpu.js nativeWritten notes a native write, the derived passes aside on a physics-only move
    sim.version++;
    if (picture) sim.changedAll = true;
    owner.wake();
    sim.wake();
    return true;
  }
}
