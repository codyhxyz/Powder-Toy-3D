import {
  fillEdit, sceneFillFrag, FillParams, sceneDiffFrag, leaveLayout, leaveDispatch, LeaveParams, leaveHeadBytes, LEAVE_BRICK_BYTES, LEAVE_BINDING,
} from '../shaders/generate.js';
import { sceneNativeDiffFrag } from '../shaders/v2/leave.js';
import { nativeFillWGSL, nativeFillSize, NATIVE_WRITE_LAYOUT, NativeFillParams } from '../shaders/worldWrite.js';
import { BRICK, LAYOUT } from '../shaders/common.js';
import { fold } from '../gpu/kernels.js';
import { sceneLayout, SCENE_BINDING, PRE_MARGIN, PreParams, preWords } from './scenes/sceneGpu.js';
import { worldParams } from './generator.js';
import { island } from './scenes/island.js';
import { WORLD_SCENES } from './scenes/index.js';

// A world scene's generator on the GPU (world/scenes; docs/webgpu.md G1), for
// one simulation grid: a window of the world at a world-cell origin. It fills
// cells through the scene's sceneCell (an edit over a box: shaders/generate.js
// fillEdit), compares the slab about to leave the window with it
// (sceneDiffFrag: one kernel that diffs and gathers) and stamps the scene's
// trees, if it has any (scene.trees: the island's), through the stamper
// below. The box's Island preset is a world the size of the grid at origin 0
// (loadIsland below); the massive world's window (docs/scaling.md D11) fills
// the slabs a shift uncovers with fill(..., min, max).
//
// Everything records into the open frame (docs/webgpu.md B3) and needs the
// kernels built and the scene's resources made: await `ready` first.

const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08, COPY_SRC: 0x04 };   // (GPUBufferUsage's bits: Node imports this module)
const NATIVE_READ_FORMAT = 2;   // Simulation.readHeader's format while the readers see V2's cells (shaders/common.js prelude)
// a scene bake's and prepass's group 2: the uniforms, and the data they write
const WRITE_LAYOUT = sceneLayout({ data: true, write: true });

// ---------------------------------------------------------------- the scene's resources
/**
 * A scene's resources on the device for world P (scenes/sceneGpu.js): its
 * uniforms and its data (the island's baked columns, made by its bake kernel
 * here, and structures; a Wang tiling; the prepass's region), ready once the
 * scene has prepared (its structures placed, its Wang tiling baked) and the
 * bake is recorded.
 */
export class SceneGpu {
  /**
   * @param {import('../sim.js').Simulation} sim the grid it generates for (its device, tables)
   * @param {object} scene a world scene (world/scenes)
   * @param {object} P its world parameters (scene.params)
   * @param {{ regions?: number[][] }} [opts] regions: the sizes (cells along x, y,
   *   z) of the regions its sceneCell kernels cover besides the grid (the far
   *   field's chunks): the prepass makes room for the largest with its margin
   */
  constructor(sim, scene, P, { regions = [] } = {}) {
    this.sim = sim;
    this.gpu = sim.gpu;
    this.scene = scene;
    this.P = P;
    this.has = { data: !!scene.data };
    this.layout = sceneLayout(this.has);
    this.uniforms = this.gpu.uniforms(scene.uniformStruct, `scene ${scene.key}`);
    const g = sim.g;
    this.preMargin = scene.pre?.margin?.(P) ?? [PRE_MARGIN, PRE_MARGIN, PRE_MARGIN];
    const cells = (r) => r.reduce((n, v, i) => n * (v + 2 * this.preMargin[i]), 1);
    this.preCells = scene.pre ? Math.max(...[[g.nx, g.ny, g.nz], ...regions].map(cells)) : 0;
    this.data = null;
    this.disposed = false;
    // the bake's and the prepass's kernels build while the scene prepares
    const layouts = [sim.L.TABLES, this.gpu.L.EMPTY, this.gpu.layout('scene write', WRITE_LAYOUT)];
    this.bakeKernel = scene.bake ? this.gpu.kernel({
      name: `${scene.key} bake`, code: scene.bake.code(), layouts, workgroupSize: [scene.bake.workgroup, scene.bake.workgroup, 1],
    }) : null;
    this.preKernel = scene.pre ? this.gpu.kernel({ name: `${scene.key} pre`, code: scene.pre.code(g), layouts, params: PreParams }) : null;
    this.ready = this._prepare();
    this.ready.catch(() => {});
  }

  async _prepare() {
    const { gpu, scene, P, sim } = this;
    await scene.prepare?.(P);
    await Promise.all([this.bakeKernel?.ready, this.preKernel?.ready]);
    if (this.disposed) return this;
    const d = scene.data?.(P);
    const words = d ? d.at + d.words.length : 0;
    this.preAt = Math.ceil(words / 4);   // (vec4s)
    this.uniforms.write({ ...scene.uniforms(P), ...(scene.pre ? { uPreAt: this.preAt } : {}) });
    if (d) {
      const total = this.preAt * 4 + (scene.pre ? preWords([this.preCells, 1, 1]) : 0);
      this.data = gpu.createBuffer({ label: `scene ${scene.key} data`, size: Math.max(16, Math.ceil(total / 4) * 16), usage: BUFFER.STORAGE | BUFFER.COPY_DST | BUFFER.COPY_SRC });
      if (d.words.length) gpu.write(this.data, d.at * 4, d.words);
      // Imported interactions change only owned packed words, on use rather
      // than per frame. Ordered writes preserve earlier fill/diff commands.
      this.unsubscribeData = scene.subscribeData?.((at, words) => {
        if (!this.disposed) gpu.write(this.data, (d.at + at) * 4, words, { ordered: true });
        this.preKey = null;   // (the prepass reads the scene's data: its region is out of date)
      });
      this.writeGroup = (this.bakeKernel || this.preKernel) && gpu.bindGroup(gpu.L['scene write'], [
        { binding: SCENE_BINDING.uniforms, resource: { buffer: this.uniforms.buffer } },
        { binding: SCENE_BINDING.data, resource: { buffer: this.data } }], `scene ${scene.key} write`);
    }
    if (scene.bake) {
      const [w, h] = scene.bake.size(P), n = scene.bake.workgroup;
      this.columnsSize = [w, h];
      this.bakeKernel.dispatch(gpu.frame, [Math.ceil(w / n), Math.ceil(h / n), 1], { bind: [sim.tables, gpu.emptyGroup, this.writeGroup] });
    }
    return this;
  }

  /**
   * The prepass over world cells [lo, lo + dims) (a sceneCell kernel's region
   * plus its margin on every side), recorded now; nothing for a scene without
   * one. Its region must fit preCells.
   */
  prepass(lo, dims) {
    if (!this.preKernel) return;
    const n = dims[0] * dims[1] * dims[2];
    if (n > this.preCells) throw new Error(`${this.scene.key} prepass: ${n} cells, room for ${this.preCells}`);
    // The region already holds this box (only the prepass writes it, and the scene's data hasn't changed
    // since): the physics region stages a move's leaving box ahead of it (world/window.js stageAhead).
    const key = `${lo.join()}|${dims.join()}`;
    if (key === this.preKey && this.preData === this.data) return;
    this.preKernel.dispatch(this.gpu.frame, fold(Math.ceil(n / 64)), { bind: [this.sim.tables, this.gpu.emptyGroup, this.writeGroup], params: { lo, dims } });
    this.preKey = key; this.preData = this.data;
  }

  /** The prepass for a sceneCell kernel over world cells [lo, hi) (the scene's margin added). */
  prepassFor(lo, hi) {
    const m = this.preMargin;
    this.prepass(lo.map((v, i) => v - m[i]), hi.map((v, i) => v - lo[i] + 2 * m[i]));
  }

  /** The resources in the order of its layout entries (GPUBindingResource[]), for sim.edit and bind groups. */
  get resources() {
    return [{ buffer: this.uniforms.buffer }, ...(this.data ? [{ buffer: this.data }] : [])];
  }

  /** Its bind group entries at their bindings, then a kernel's own (`extra`). */
  entries(extra = []) {
    const r = this.resources;
    return [...this.layout.map((e, i) => ({ binding: e.binding, resource: r[i] })), ...extra];
  }

  dispose() {
    this.disposed = true;
    this.unsubscribeData?.();
    for (const b of [this.uniforms.buffer, this.data]) if (b) this.sim._retire(b);
  }
}

// ---------------------------------------------------------------- stamps
// (V1's tree stamper went with V1: a world's trees are its render source producer's, native on V2's
// cells: world/renderSourceProducer.js)

// ---------------------------------------------------------------- V2's world writers
// The group V2's world writers bind (shaders/worldWrite.js): the owner's cores, banks and activity.
const writeGroups = new WeakMap();   // owner → { cells, group }
export function nativeWriteGroup(sim) {
  const owner = sim.compact, gpu = sim.gpu;
  let w = writeGroups.get(owner);
  if (!w || w.cells !== owner.cells || w.aux !== owner.aux) {
    const group = gpu.bindGroup(gpu.layout('NATIVE_WORLD_WRITE', NATIVE_WRITE_LAYOUT),
      [owner.cells, owner.aux, owner.act].map((buffer, binding) => ({ binding, resource: { buffer } })), 'native world write');
    writeGroups.set(owner, w = { cells: owner.cells, aux: owner.aux, group });
  }
  return w.group;
}
// After a native write: as an edit notes itself (Simulation.edit): the version (V2 then looks for V1
// writes to import: none; the write noted its own bricks), the derived passes, a wake.
export function nativeWritten(sim) {
  sim.version++;
  sim.changedAll = true;
  sim.compact.wake();
  sim.wake();
}

// ---------------------------------------------------------------- the generator
export class WorldGenerator {
  /**
   * @param {import('../sim.js').Simulation} sim
   * @param {object} scene a world scene (world/scenes)
   * @param {object} P its world parameters
   * @param {{ regions?: number[][] }} [opts] the far field's regions (SceneGpu)
   */
  constructor(sim, scene, P, opts = {}) {
    this.sim = sim;
    this.scene = scene;
    this.P = P;
    this.res = new SceneGpu(sim, scene, P, opts);
    this.code = scene.glsl(sim.g);
    // the fill now; the leaving slab's kernel when the window asks (prepareDiff)
    this.kernels = { fill: sim.editKernel(`${scene.key} fill`, fillEdit(this.code, this.res.has)) };
    // V2's fill (nativeFill) when a V2 owner exists: a window V2 runs fills it natively
    const native = sim.compactOwner ? this.prepareNativeFill() : null;
    this.ready = Promise.all([this.res.ready, this.kernels.fill.ready, native]).then(() => this);
    this.ready.catch(() => {});
  }

  /** The leaving slab's kernel (made on the first call); resolves when it is built. */
  prepareDiff() {
    const { sim, scene } = this;
    this.kernels.diff ??= sim.gpu.kernel({
      name: `${scene.key} leave`, code: sceneDiffFrag(sim.g, this.code),
      layouts: [sim.L.TABLES, sim.L.STATE_RO, sim.gpu.layout(`leave ${JSON.stringify(this.res.has)}`, leaveLayout(this.res.has))],
      params: LeaveParams, workgroupSize: [BRICK, BRICK, BRICK],
    });
    return this.kernels.diff.ready;
  }

  /**
   * Physics V2's leaving slab kernel (shaders/v2/leave.js; made on the first
   * call, only once V2 owns the grid): built in the background and optional,
   * so until it is ready (or if it fails) diff records V1's and the window
   * keeps every native brick, as before. Resolves when it is built.
   */
  prepareNativeDiff() {
    const { sim, scene } = this;
    this.kernels.nativeDiff ??= sim.gpu.kernel({
      name: `${scene.key} native leave`, code: sceneNativeDiffFrag(sim.g, this.code), build: 'idle', optional: true,
      layouts: [sim.L.TABLES, sim.L.STATE_RO, sim.gpu.layout(`leave ${JSON.stringify(this.res.has)}`, leaveLayout(this.res.has))],
      params: LeaveParams, workgroupSize: [BRICK, BRICK, BRICK],
    });
    return this.kernels.nativeDiff.ready;
  }

  /**
   * Generate the scene into the grid's cells [min, max) (window-local; the
   * whole grid by default), the grid sitting at world cell `origin` (P must be
   * the generator's world). An edit over that box.
   */
  fill(P = this.P, origin = [0, 0, 0], min = [0, 0, 0], max = null) {
    if (P !== this.P && JSON.stringify(P) !== JSON.stringify(this.P)) throw new Error('WorldGenerator.fill: another world than its own (make a generator for it)');
    const g = this.sim.g, hi = max ?? [g.nx, g.ny, g.nz];
    this.res.prepassFor(min.map((v, i) => v + origin[i]), hi.map((v, i) => v + origin[i]));
    if (this.sim.compact?.isReady) return this._nativeFill(origin, min, hi);
    this.sim.edit(this.kernels.fill, { lo: min, hi: hi.map((v) => v - 1) }, { origin }, { bind: this.res.resources });
  }

  /** V2's fill kernel (shaders/worldWrite.js; made on the first call); resolves when it is built. */
  prepareNativeFill() {
    const { sim, scene } = this, gpu = sim.gpu;
    this.kernels.nativeFill ??= gpu.kernel({ name: `${scene.key} native fill`, code: nativeFillWGSL(sim.g, this.code), params: NativeFillParams,
      layouts: [sim.L.TABLES, gpu.layout('NATIVE_WORLD_WRITE', NATIVE_WRITE_LAYOUT), gpu.layout(`native scene ${JSON.stringify(this.res.has)}`, this.res.layout)] });
    return this.kernels.nativeFill.ready;
  }
  /** Whether a fill of a window V2 runs can record now (the window's moves wait for it: world/window.js). */
  get nativeReady() { return !this.sim.compact?.isReady || this.kernels.nativeFill?.state === 'ready'; }

  // While V2 runs the grid the scene's cells go straight into V2's cores (shaders/worldWrite.js): the
  // import of the V1 edit's cells, without the edit (the edit, an export of V1's cache before it, and
  // the import after it). The same cores either way: V2's terrain is importA of the scene's cell.
  _nativeFill(origin, lo, hi) {
    const sim = this.sim, owner = sim.compact, gpu = sim.gpu, k = this.kernels.nativeFill;
    if (sim.nativeTransitionKind === 'shift' && !sim.nativeCommitting) return false;
    if (k?.state !== 'ready') { this.prepareNativeFill(); throw new Error('the native world fill is not built yet'); }
    const box = { lo: lo.map((v) => Math.max(0, v)), hi: hi.map((v, i) => Math.min(v, [sim.g.nx, sim.g.ny, sim.g.nz][i])) };
    if (box.lo.some((v, i) => v >= box.hi[i])) return;
    owner.sync();   // (V1 writes pending before it are imported first)
    const write = nativeWriteGroup(sim);
    if (this._sceneGroupFor !== this.res.data || !this._sceneGroup) {
      this._sceneGroupFor = this.res.data;
      this._sceneGroup = gpu.bindGroup(gpu.layout(`native scene ${JSON.stringify(this.res.has)}`, this.res.layout), this.res.entries(), 'native fill scene');
    }
    sim._dispatch(k, nativeFillSize(box.lo, box.hi), { bind: [sim.tables, write, this._sceneGroup], header: sim.header(), params: { origin, lo: box.lo, hi: box.hi } });
    nativeWritten(sim);
  }

  /**
   * Record the leaving slab's kernel over the grid's slab [lo, lo + 4·bricks)
   * (the grid at the simulation's origin), into `out` (diffBuffers: its head's
   * count cleared here). Needs prepareDiff() resolved. native: the grid is
   * Physics V2's (the window reads its native cells too): V2's kernel compares
   * native cores with the generator's import (prepareNativeDiff) once it is
   * built and V2 is what the readers see. Returns whether it did.
   */
  diff(P, lo, bricks, out, { native = false } = {}) {
    const sim = this.sim, o = sim.origin, f = sim.gpu.frame, O = [o.x, o.y, o.z];
    const nativeDiff = this.kernels.nativeDiff;
    this.res.prepassFor(lo.map((v, i) => v + O[i]), lo.map((v, i) => v + O[i] + bricks[i] * BRICK));
    f.clear(out.head, 0, 16);
    out.group ??= sim.gpu.bindGroup(this.kernels.diff.groups[2], this.res.entries([
      { binding: LEAVE_BINDING.head, resource: { buffer: out.head } }, { binding: LEAVE_BINDING.cells, resource: { buffer: out.cells } }]),
    `${this.scene.key} leave`);
    const header = sim.readHeader();
    // (format 2: the readers bind V2's cells, Simulation.bindRO; format 0 before the owner presents)
    const exact = native && !!nativeDiff?.pipeline && header.format === NATIVE_READ_FORMAT;
    (exact ? nativeDiff : this.kernels.diff).dispatch(f, leaveDispatch(bricks), {
      bind: [sim.tables, sim.bindRO, out.group], header,
      params: {
        lo, bricks, wlo: [(o.x + lo[0]) / BRICK, (o.y + lo[1]) / BRICK, (o.z + lo[2]) / BRICK], wb: P.size.map((n) => n / BRICK),
      },
    });
    return exact;
  }

  /** The leaving slab's buffers for slabs of up to n bricks (diff's `out`). */
  diffBuffers(n) {
    const gpu = this.sim.gpu, U = BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST;
    return {
      n,
      head: gpu.createBuffer({ label: `${this.scene.key} leave head`, size: Math.ceil(leaveHeadBytes(n) / 16) * 16, usage: U }),
      cells: gpu.createBuffer({ label: `${this.scene.key} leave cells`, size: n * LEAVE_BRICK_BYTES, usage: U }),
      group: null,
    };
  }

  dispose() {
    this.res.dispose();
  }
}

// The box's Island preset: the island scene (scenes/island.js) over a world
// the size of the grid, at origin 0, with snow (worldParams' default).
export class IslandGenerator extends WorldGenerator {
  constructor(sim, P = worldParams({ size: [sim.g.nx, sim.g.ny, sim.g.nz] })) {
    super(sim, island, P);
  }
}

// One generator, for the app's current simulation (a new grid replaces it), per world.
let current = null;
export function generatorFor(sim, P = worldParams({ size: [sim.g.nx, sim.g.ny, sim.g.nz] })) {
  if (current?.sim !== sim || JSON.stringify(current.P) !== JSON.stringify(P)) {
    current?.dispose();
    current = new IslandGenerator(sim, P);
  }
  return current;
}
// The simulation is going away: so does its generator, if it has one. (Its V1 stamper's pool went
// with the stamper, 80852699, but this call to it stayed: every big map threw leaving, 2026-10-22 to 24.)
export function releaseGenerator(sim) {
  if (current?.sim !== sim) return;
  current.dispose();
  current = null;
}

/**
 * The Island scene: a world the size of the grid, at origin 0, with its
 * trees. Resolves with its world P once it is recorded (the kernels and the
 * columns' bake first: the first time, they build), or with null when it
 * didn't: the generator was replaced, the grid went, or `still()` said the
 * load was overtaken while it waited (another scene loaded, an undo: the
 * caller's, src/wire/world.js). The old WebGL load was synchronous; this one
 * waits at least a microtask, so whatever is loaded meanwhile must win.
 * @param {import('../sim.js').Simulation} sim
 * @param {{ seed?: number, still?: () => boolean }} [opts]
 */
export async function loadIsland(sim, { seed, still = null } = {}) {
  const { nx, ny, nz } = sim.g;
  const P = worldParams({ size: [nx, ny, nz], seed });
  const gen = generatorFor(sim, P);
  await gen.ready;
  if (current !== gen || sim.disposed || (still && !still())) return null;   // (replaced or overtaken meanwhile)
  gen.fill(P);
  gen.plantTrees(P);
  // a new scene: the render fields and GI start over instead of blending in, and nothing is moving
  sim.fieldReset = true;
  sim.giReset = true;
  sim.stillFlow();
  return P;
}

// ---------------------------------------------------------------- check-wgsl
// Every scene's fill and leaving slab, the island's bake (tools/check-wgsl.mjs).
// A world builds them on entering it (B5: the world's kernels on first use),
// so the menu's warm-up leaves them out (warm: false). The grids: the world's
// window (128 wide; the giant volcano's 384 tall; Descent's 256 tall window
// isn't a check grid, its text differs only in the grid's constants) and, for
// the island, the boxes its preset fills.
const GRIDS_OF = { island: ['32', '64', '128', 'wide'], giantVolcano: ['giant'] };
const hasOf = (s) => ({ data: !!s.data });
export const WGSL_CHECK = () => WORLD_SCENES.flatMap((s) => {
  const grids = GRIDS_OF[s.key] ?? ['128'], has = hasOf(s);
  return [
    {
      name: `${s.key} fill`, kind: 'compute', grids, warm: false, code: (g) => sceneFillFrag(g, s.glsl(g), has),
      layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, sceneLayout(has)], params: FillParams, dispatch: (g) => fold(g.nbricks),
    },
    {
      name: `${s.key} leave`, kind: 'compute', grids, warm: false, code: (g) => sceneDiffFrag(g, s.glsl(g)),
      layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, leaveLayout(has)], params: LeaveParams,
      dispatch: (g) => leaveDispatch([4, g.ny / BRICK, g.nz / BRICK]),
    },
    ...(s.bake ? [{
      name: `${s.key} bake`, kind: 'compute', grids: false, warm: false, code: () => s.bake.code(),
      layouts: () => [LAYOUT.TABLES, 'EMPTY', WRITE_LAYOUT], dispatch: () => [Math.ceil(1028 / s.bake.workgroup), Math.ceil(1028 / s.bake.workgroup), 1],
    }] : []),
    ...(s.pre ? [{
      name: `${s.key} pre`, kind: 'compute', grids, warm: false, code: (g) => s.pre.code(g),
      layouts: () => [LAYOUT.TABLES, 'EMPTY', WRITE_LAYOUT], params: PreParams, dispatch: (g) => fold(Math.ceil((g.nx + 2) * (g.ny + 2) * (g.nz + 2) / 64)),
    }] : []),
  ];
});
