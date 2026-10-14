import {
  fillEdit, sceneFillFrag, FillParams, sceneDiffFrag, leaveLayout, leaveDispatch, LeaveParams, leaveHeadBytes, LEAVE_BRICK_BYTES, LEAVE_BINDING,
} from '../shaders/generate.js';
import { stampEdit, MAX_FOOT } from '../shaders/stamp.js';
import { BRICK, LAYOUT } from '../shaders/common.js';
import { fold } from '../gpu/kernels.js';
import { sceneLayout, SCENE_BINDING, PRE_MARGIN, PreParams, preWords } from './scenes/sceneGpu.js';
import { runGenerator, bake } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { worldParams, TREE } from './generator.js';
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
    this.preKernel.dispatch(this.gpu.frame, fold(Math.ceil(n / 64)), { bind: [this.sim.tables, this.gpu.emptyGroup, this.writeGroup], params: { lo, dims } });
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
    for (const b of [this.uniforms.buffer, this.data]) if (b) this.sim._retire(b);
  }
}

// ---------------------------------------------------------------- stamps
// Baked constructions (runtime.js bake) written into a grid (shaders/stamp.js),
// one edit each (docs/webgpu.md D6), in call order: the window's trees, the
// box's Island preset's, the felled glade by the shrine (wire/world.js) and
// the constructions (src/constructions.js). Shapes go into a pool buffer
// once, keyed (a tree by its trunk's column, as bakeTree caches it), and
// stay while the pool has room; when it is full it starts over.
const POOL_VEC4S = 1 << 18;   // the shape pool's first size: 4 MiB of voxels (about 16 trees), doubled when a batch needs more
const stampers = new WeakMap();
/** The grid's stamper (made on first use). */
export const stamperFor = (sim) => {
  let s = stampers.get(sim);
  if (!s) stampers.set(sim, s = new Stamper(sim));
  return s;
};

export class Stamper {
  constructor(sim) {
    this.sim = sim;
    this.gpu = sim.gpu;
    this.kernel = sim.editKernel('stamp', stampEdit());
    this.ready = this.kernel.ready;
    const g = sim.g;
    this.maskW = g.nx / BRICK;
    this.maskVec4s = Math.ceil((g.nx / BRICK) * (g.nz / BRICK) / 128);
    this.cap = 0;
    this.pool = null;
    this.used = 0;
    this.shapes = new Map();   // key → { s, base }
    this.poolRead = -1;        // gpu.stats.flushes when a stamp last read the pool (still unsubmitted while equal)
  }

  // A write to the pool: unordered unless a stamp recorded in the open
  // encoder still reads it (an ordered write flushes the frame first: a window
  // move's planting would cost a second submit; gpu.write)
  _write(offset, data) {
    this.gpu.write(this.pool, offset, data, { ordered: this.poolRead === this.gpu.stats.flushes });
  }

  // Room for `need` more vec4s of shapes (the batch's not in the pool yet);
  // when the pool is full it starts over, and then the batch uploads every
  // shape it stamps again (`all` vec4s): the pool grows if they don't fit.
  _room(need, all) {
    if (this.pool && this.used + need <= this.cap) return;
    this.shapes.clear();
    this.used = this.maskVec4s;
    if (this.pool && this.used + all <= this.cap) return;
    if (this.pool) this.sim._retire(this.pool);
    this.cap = Math.max(POOL_VEC4S, 2 * (this.maskVec4s + all));
    this.pool = this.gpu.createBuffer({ label: `sim${this.sim.id} stamp pool`, size: this.cap * 16, usage: BUFFER.STORAGE | BUFFER.COPY_DST });
    this.poolRead = -1;   // (nothing reads the new one yet)
  }

  /**
   * Stamps each { s, at, seed, key } (s a baked construction, at its low
   * corner in grid cells, key an optional cache key for s), one edit each in
   * this order. mask: a byte per grid brick column (x fastest; non-zero:
   * write it), or null for every column. scrub: the cells it gives a new
   * element lose their decoration (src/deco.js; constructions do, trees don't).
   * Returns how many it stamped. Needs `ready`.
   * @param {{ s: object, at: number[], seed: number, key?: string }[]} list
   * @param {{ mask?: Uint8Array | null, scrub?: boolean }} [opts]
   */
  stamp(list, { mask = null, scrub = false } = {}) {
    list = list.filter((t) => t.s);
    if (!list.length) return 0;
    // the vec4s the batch uploads: its shapes not in the pool, or after a fresh start at most all of them
    const size = (t) => t.s.w * t.s.h * t.s.d;
    const fresh = (t) => !(t.key != null && this.shapes.get(t.key)?.s === t.s);
    this._room(list.reduce((n, t) => n + (fresh(t) ? size(t) : 0), 0), list.reduce((n, t) => n + size(t), 0));
    // the shapes not in the pool yet, then the mask, then the edits (so at most the first write flushes the frame)
    const bases = new Map();
    for (const t of list) {
      const had = t.key != null ? this.shapes.get(t.key) : null;
      if (had?.s === t.s) { bases.set(t, had.base); continue; }
      const base = this.used;
      this._write(base * 16, t.s.data);
      this.used += t.s.w * t.s.h * t.s.d;
      bases.set(t, base);
      if (t.key != null) this.shapes.set(t.key, { s: t.s, base });
    }
    if (mask) {
      const bits = new Uint32Array(this.maskVec4s * 4);
      for (let i = 0; i < mask.length; i++) if (mask[i]) bits[i >> 5] |= 1 << (i & 31);
      this._write(0, bits);
    }
    const sim = this.sim, bind = [{ buffer: this.pool }];
    for (const t of list) {
      const s = t.s, foot = Math.min(s.foot ?? 0, MAX_FOOT), at = t.at;
      sim.edit(this.kernel, { lo: [at[0], at[1] - foot, at[2]], hi: [at[0] + s.w - 1, at[1] + s.h - 1, at[2] + s.d - 1] }, {
        at, foot, size: [s.w, s.h, s.d], base: bases.get(t), seed: t.seed >>> 0, masked: mask ? 1 : 0, maskW: this.maskW,
      }, { bind, scrub });
    }
    this.poolRead = this.gpu.stats.flushes;
    return list.length;
  }

  dispose() {
    if (this.pool) this.sim._retire(this.pool);
    this.pool = null;
    this.shapes.clear();
    stampers.delete(this.sim);
  }
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
    this.stamper = scene.trees ? stamperFor(sim) : null;
    this.ready = Promise.all([this.res.ready, this.kernels.fill.ready, this.stamper?.ready]).then(() => this);
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
   * Generate the scene into the grid's cells [min, max) (window-local; the
   * whole grid by default), the grid sitting at world cell `origin` (P must be
   * the generator's world). An edit over that box.
   */
  fill(P = this.P, origin = [0, 0, 0], min = [0, 0, 0], max = null) {
    if (P !== this.P && JSON.stringify(P) !== JSON.stringify(this.P)) throw new Error('WorldGenerator.fill: another world than its own (make a generator for it)');
    const g = this.sim.g, hi = max ?? [g.nx, g.ny, g.nz];
    this.res.prepassFor(min.map((v, i) => v + origin[i]), hi.map((v, i) => v + origin[i]));
    this.sim.edit(this.kernels.fill, { lo: min, hi: hi.map((v) => v - 1) }, { origin }, { bind: this.res.resources });
  }

  /**
   * Record the leaving slab's kernel over the grid's slab [lo, lo + 4·bricks)
   * (the grid at the simulation's origin), into `out` (diffBuffers: its head's
   * count cleared here). Needs prepareDiff() resolved.
   */
  diff(P, lo, bricks, out) {
    const sim = this.sim, o = sim.origin, f = sim.gpu.frame, O = [o.x, o.y, o.z];
    this.res.prepassFor(lo.map((v, i) => v + O[i]), lo.map((v, i) => v + O[i] + bricks[i] * BRICK));
    f.clear(out.head, 0, 16);
    out.group ??= sim.gpu.bindGroup(this.kernels.diff.groups[2], this.res.entries([
      { binding: LEAVE_BINDING.head, resource: { buffer: out.head } }, { binding: LEAVE_BINDING.cells, resource: { buffer: out.cells } }]),
    `${this.scene.key} leave`);
    this.kernels.diff.dispatch(f, leaveDispatch(bricks), {
      bind: [sim.tables, sim.bindRO, out.group], header: sim.readHeader(),
      params: {
        lo, bricks, wlo: [(o.x + lo[0]) / BRICK, (o.y + lo[1]) / BRICK, (o.z + lo[2]) / BRICK], wb: P.size.map((n) => n / BRICK),
      },
    });
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

  /**
   * Stamp baked constructions (each { s, at, seed, key }, at its low corner in
   * grid cells) one edit each, writing only the grid brick columns set in mask
   * (a byte per column, x fastest; null: all). Returns how many.
   */
  stampMany(list, mask = null) { return (this.stamper ?? stamperFor(this.sim)).stamp(list, { mask }); }

  /** Stamp the trees of world P whose crowns may reach the grid (at world `origin`). Returns them. */
  plantTrees(P = this.P, origin = [0, 0, 0]) {
    const g = this.sim.g, R = TREE.REACH;
    if (!this.scene.trees) return [];
    const trees = this.scene.trees.treesIn(origin[0] - R, origin[2] - R, origin[0] + g.nx + R, origin[2] + g.nz + R, P);
    const list = [];
    for (const t of trees) {
      const s = bake(runGenerator(BUILTINS.TREE, { size: t.size, seed: t.seed, variant: t.variant }), t.quarter);
      // the construction's base point on the ground at the trunk (the stamp grows its footing)
      if (s) list.push({ s, at: [t.x - origin[0] - s.base.x, t.y - origin[1] - s.base.y, t.z - origin[2] - s.base.z], seed: t.seed, key: `${t.x},${t.z}` });
    }
    this.stampMany(list);
    return trees;
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
// The simulation is going away: so do its generator, if it has one, and its stamper's pool.
export function releaseGenerator(sim) {
  stampers.get(sim)?.dispose();
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
