import {
  WorldCopyUniforms, WORLD_COPY_LAYOUT, WC_WRITE, WC_WRITE_LAYOUT, WC_CTRL, WcWriteParams, WC_CHUNK, WC_DILATE,
  WC_SCENE_CELLS_BINDING, WC_STAMP_LAYOUT, WC_STAMP_WORDS, WC_OVERLAY_LAYOUT, WC_NODE1, WC_NODE2,
  wcLayout, wcSceneFrag, wcStampFrag, wcOverlayFrag, wcCommitChunkFrag, wcDecodeFrag, wcAllocFrag, wcDilateFrag, wcOccFrag,
  jobDispatch, brickDispatch,
} from '../shaders/world/copy.js';
import { WC_BRICK, WC_BRICK_CELLS, wcTempCode } from '../shaders/world/cellWord.js';
import { wcWordOf, wcWordOfCore } from './worldCopyTwin.js';
import { decodeNativeBrick, legacyBrickToNative, NATIVE_BRICK_BYTES } from './nativeStore.js';
import { bakeSourceTree } from './renderSourceProducer.js';
import { TREE } from './generator.js';
import { MAX_FOOT } from '../constructions/runtime.js';
import { STAGE } from '../gpu/kernels.js';
import { sceneLayout } from './scenes/sceneGpu.js';
import { E } from '../elements.js';
import { PHYS } from '../physics.js';

// The world copy (docs/seamless-world.md, "W — world copy"; its WGSL and layout are shaders/world/copy.js):
// the whole map at full cell detail, resident on the GPU from load, the only thing the picture reads for "what
// is in this cell". Sparse: a table word per 4³ brick, a uniform brick's cell word itself, a mixed one's 64
// words in a pool slot. Touchstones: Teardown ray-marches a fully resident voxel level; Minecraft keeps a
// uniform chunk section as one palette entry.
//
//   build(source)   the whole map before the first frame, from the scene generator (its sceneCell, the trees
//                   its treesIn places, baked as the window bakes them), the window's saved bricks over it,
//                   then the window's own cells (a writeback of all of it). A chunk of WC_CHUNK² columns
//                   a submit, a fence every BUILD_FENCE_CHUNKS of them, so no submit is long. A small map is
//                   built from its box's cells. Descent is left on its current path (Intentional: the user,
//                   2026-10-24: "don't worry about descent").
//   recordWriteback(frame, sim, boxes)
//                   physics' changed boxes (window cells) decoded from V2's native cores into the copy. The GPU
//                   allocates and frees pool slots (a free-list pop, else a bump; a brick that turns uniform
//                   gives its slot back); wcInfo and wcOcc follow for the bricks it touched. In proportion to
//                   the changed bricks, never the window.
//   changesSince(rev)
//                   the world-cell boxes changed since revision rev (F's and L's updates).
//
// Capacity: the build starts the pool at an estimate and grows it ahead of every chunk; when it is done the
// pool is reallocated to POOL_HEADROOM × what it holds. A writeback grows it first whenever the bump could
// pass the capacity (the bump's last readback plus every job recorded since), so a brick is never dropped
// (wcCtrl's OVER counts a breach; the tools read it).

const BUFFER = { MAP_READ: 0x01, COPY_SRC: 0x04, COPY_DST: 0x08, UNIFORM: 0x40, STORAGE: 0x80 };   // (GPUBufferUsage's bits)
const RW = BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST;
export const POOL_HEADROOM = 1.5;        // the pool after the build: this many times the mixed bricks it holds
const POOL_START_SHARE = 1 / 8;          // the build's first guess at the share of bricks that are mixed (the census: Island 11 %)
const POOL_GROW = 1.5;                   // a growth multiplies the capacity by at least this
const BUILD_FENCE_CHUNKS = 8;            // chunks recorded between the build's waits on the queue
const JOB_RING = 1 << 18;                // job words a frame's writebacks share before an ordered write flushes
const DILATE_SPAN = 1 << 20;             // bricks a full dilation pass covers per dispatch
const CHANGES_KEPT = 512;                // change boxes kept for changesSince (older revisions get the whole world)
const STAMP_GROW = 1.5;
const MAX_JOB_COORD = 1023;              // a window brick coordinate packs in 10 bits (copy.js unpackJob)
const OUT_OF_SCOPE = /^(descent|noitaTerrain)/;   // Descent's scenes (Intentional: user, out of scope for now)

// a stored brick's cells are in slot order (shaders/common.js slotOf's in-brick order); the copy's x + 4 (y + 4 z)
const SLOT_TO_LOCAL = Array.from({ length: 64 }, (_, t) => {
  const u = t & 7, v = t >> 3, x = u & 3, y = (u >> 2) | ((v >> 2) << 1), z = v & 3;
  return x + 4 * (y + 4 * z);
});
/** A stored brick's 64 cell words (x + 4 (y + 4 z)), from the window's store bytes (native, or V1's). */
export function storedBrickWords(bytes, airT = PHYS.AMBIENT) {
  const native = bytes.length === NATIVE_BRICK_BYTES ? bytes : legacyBrickToNative(bytes);
  const { core } = decodeNativeBrick(native);
  const out = new Uint32Array(64);
  for (let t = 0; t < 64; t++) out[SLOT_TO_LOCAL[t]] = wcWordOfCore(core.subarray(t * 4, t * 4 + 4), airT);
  return out;
}
/** A baked shape's voxels as the stamp kernel's words (copy.js wcStampFrag). */
export function stampVoxels(data) {
  const n = data.length / 4, out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const id1 = Math.round(data[i * 4]);
    if (id1 <= 0) continue;
    out[i] = ((id1 & 255) | ((Math.round(data[i * 4 + 2]) & 255) << 8) | (wcTempCode(data[i * 4 + 1]) << 16) | ((data[i * 4 + 3] >= 0.5 ? 1 : 0) << 24)) >>> 0;
  }
  return out;
}

export class WorldCopy {
  /**
   * @param {object} gpu the device (gpu/device.js)
   * @param {{ size: number[] }} opts the world in cells [x, y, z] (a small map: its box)
   */
  constructor(gpu, { size }) {
    this.gpu = gpu;
    this.size = [...size];
    this.L = wcLayout(size);
    this.layout = gpu.layout('WORLD_COPY', WORLD_COPY_LAYOUT);
    this.writeLayout = gpu.layout('WORLD_COPY_WRITE', WC_WRITE_LAYOUT);
    this.uniforms = gpu.uniforms(WorldCopyUniforms, 'world copy');
    const L = this.L, buf = (label, size, usage = RW) => gpu.createBuffer({ label, size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    this.buf = {
      table: buf('world copy table', L.nBricks * 4),
      info: buf('world copy info', L.nBricks * 4),
      occ: buf('world copy occupancy', L.occWords * 4),
      ctrl: buf('world copy allocator', WC_CTRL.WORDS * 4),
      pool: null, free: null, jobs: null, scratch: null,
    };
    this.capacity = 0;
    this.bumpRead = 0;          // the bump as last read back
    this.jobsSince = 0;         // jobs recorded since that read was issued (each may bump a slot)
    this.reading = false;
    this.overflow = 0;          // wcCtrl's OVER as last read (must stay 0)
    this.used = 0;              // mixed bricks, as last read (bump less the free list)
    this.revision = 0;
    this.log = [];              // { rev, lo, hi } world-cell boxes
    this.changes = [];          // the last update's boxes
    this.jobCursor = 0;
    this.jobFlushes = -1;
    this.kernels = new Map();   // by grid (the prelude's constants) and scene
    this.built = false;
    this.skipped = false;       // a scene left on its current path (Descent)
    this.allDirty = false;      // a writeback came before its kernels were ready: the next one does the window
    this.last = null;           // what the build cost (tools)
    this.disposed = false;
    this._groups = null;
    this._allocPool(0);
    this._ensureJobs(JOB_RING);
    this._ensureScratch(0);
  }

  // ---------------------------------------------------------------- resources
  get airT() { return this.gpu._simTables?.airT ?? PHYS.AMBIENT; }
  get airWord() { return wcWordOf(E.EMPTY, this.airT, 0, 0, 0, this.airT); }

  _retire(b) {
    if (!b) return;
    const gpu = this.gpu;
    if (gpu.failure) { b.destroy(); return; }
    gpu.flush('world copy retire');
    gpu.queue.onSubmittedWorkDone().then(() => b.destroy(), () => b.destroy());
  }

  _limit() {
    const l = this.gpu.device.limits;
    return Math.min(l.maxStorageBufferBindingSize, l.maxBufferSize);
  }

  // The pool and free list at `capacity` slots, the old contents copied over (never dropped).
  _allocPool(capacity) {
    const gpu = this.gpu, bytes = Math.max(16, capacity * WC_BRICK_CELLS * 4);
    if (bytes > this._limit()) throw new Error(`world copy: ${capacity} mixed bricks (${(bytes / 2 ** 20).toFixed(0)} MiB) pass the device's storage buffer limit`);
    const pool = gpu.createBuffer({ label: 'world copy pool', size: bytes, usage: RW });
    const free = gpu.createBuffer({ label: 'world copy free list', size: Math.max(16, capacity * 4), usage: RW });
    const old = this.buf;
    if (old.pool && this.capacity) {
      const keep = Math.min(this.capacity, capacity);
      gpu.frame.copy(old.pool, 0, pool, 0, keep * WC_BRICK_CELLS * 4);
      gpu.frame.copy(old.free, 0, free, 0, keep * 4);
      this._retire(old.pool);
      this._retire(old.free);
    }
    old.pool = pool;
    old.free = free;
    this.capacity = capacity;
    this._groups = null;
    this._writeUniforms();
  }

  // Grow so that `need` slots fit (POOL_GROW at least, within the device's limit).
  _grow(need) {
    if (need <= this.capacity) return;
    const most = Math.floor(this._limit() / (WC_BRICK_CELLS * 4));
    this._allocPool(Math.max(need, Math.min(most, Math.max(Math.ceil(this.capacity * POOL_GROW), 64))));
    this.grows = (this.grows ?? 0) + 1;
  }

  // Room for `jobs` more slot allocations, by the bump's upper bound.
  _reserve(jobs) {
    this.jobsSince += jobs;
    const upper = this.bumpRead + this.jobsSince;
    if (upper > this.capacity) this._grow(upper);
  }

  // Read the allocator's counters back (one read in flight), tightening the bump's bound.
  _readCtrl() {
    if (this.reading || this.disposed) return null;
    this.reading = true;
    const since = this.jobsSince;
    const p = this.gpu.readback.buffer(this.buf.ctrl, 0, WC_CTRL.WORDS * 4).then((ab) => {
      const w = new Uint32Array(ab);
      this.bumpRead = w[WC_CTRL.BUMP];
      this.jobsSince -= since;
      this.used = w[WC_CTRL.BUMP] - w[WC_CTRL.FREE];
      this.overflow = w[WC_CTRL.OVER];
      if (this.overflow) console.error(`world copy: ${this.overflow} bricks found no pool slot (a capacity bug)`);
      return w;
    }).finally(() => { this.reading = false; });
    p.catch(() => {});
    return p;
  }

  _ensureJobs(words) {
    if (this.buf.jobs && this.buf.jobs.size >= words * 4) return;
    this._retire(this.buf.jobs);
    this.buf.jobs = this.gpu.createBuffer({ label: 'world copy jobs', size: Math.max(words, JOB_RING) * 4, usage: RW });
    this.jobCursor = 0;
    this._groups = null;
  }

  // The scratch: the build's chunk cells, or a writeback's words (64 a job) and flags (1 a job).
  _ensureScratch(words) {
    if (this.buf.scratch && this.buf.scratch.size >= words * 4) return;
    this._retire(this.buf.scratch);
    this.buf.scratch = this.gpu.createBuffer({ label: 'world copy scratch', size: Math.max(words, WC_CHUNK * this.size[1] * WC_CHUNK) * 4, usage: RW });
    this._groups = null;
  }

  // Job words into the ring (no flush while the frame's earlier writebacks still read theirs); their first word.
  _putJobs(words) {
    const gpu = this.gpu;
    this._ensureJobs(words.length);
    if (this.jobFlushes !== gpu.stats.flushes) { this.jobFlushes = gpu.stats.flushes; this.jobCursor = 0; }
    let at = this.jobCursor;
    if (at + words.length > this.buf.jobs.size / 4) { at = 0; gpu.write(this.buf.jobs, 0, words); this.jobFlushes = gpu.stats.flushes; }
    else gpu.write(this.buf.jobs, at * 4, words, { ordered: false });
    this.jobCursor = at + words.length;
    return at;
  }

  _writeUniforms() {
    const L = this.L;
    this.uniforms.write({
      size: L.size, air: this.airWord, bricks: L.bricks, capacity: this.capacity, n1: L.n1, occ2At: L.occ2At, n2: L.n2, revision: this.revision,
    });
  }

  get groups() {
    if (this._groups) return this._groups;
    const gpu = this.gpu, b = this.buf, res = (buffer) => ({ buffer });
    this._groups = {
      read: gpu.bindGroup(this.layout, [
        { binding: 0, resource: res(this.uniforms.buffer) }, { binding: 1, resource: res(b.table) }, { binding: 2, resource: res(b.pool) },
        { binding: 3, resource: res(b.info) }, { binding: 4, resource: res(b.occ) }], 'world copy'),
      write: gpu.bindGroup(this.writeLayout, Object.entries(WC_WRITE).map(([k, binding]) => ({ binding, resource: res(b[k]) })), 'world copy write'),
    };
    return this._groups;
  }
  /** Group 1 of render kernels (WORLD_COPY_LAYOUT). Made again when the pool grows: read it each frame. */
  get bindGroup() { return this.groups.read; }

  // ---------------------------------------------------------------- kernels
  _kernelsFor(sim, scene = null) {
    const g = sim.g, key = `${g.nx},${g.ny},${g.nz}|${scene?.key ?? ''}`;
    let k = this.kernels.get(key);
    if (k) return k;
    const gpu = this.gpu, L = this.L, T = sim.L.TABLES, W = this.writeLayout;
    const kernel = (name, code, layouts) => gpu.kernel({ name: `world copy ${name}`, code, layouts, params: WcWriteParams });
    k = {
      decode: kernel('decode', wcDecodeFrag(g, L), [T, sim.L.STATE_RO, W]),
      alloc: kernel('alloc', wcAllocFrag(g, L), [T, gpu.L.EMPTY, W]),
      dilate: kernel('dilate', wcDilateFrag(g, L), [T, gpu.L.EMPTY, W]),
      occ: kernel('occupancy', wcOccFrag(g, L), [T, gpu.L.EMPTY, W]),
    };
    if (scene) {
      const has = { data: !!scene.data };
      const sceneL = gpu.layout(`world copy scene ${JSON.stringify(has)}`, [
        ...sceneLayout(has), { binding: WC_SCENE_CELLS_BINDING, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }]);
      k.sceneLayout = sceneL;
      k.scene = kernel(`${scene.key} scene`, wcSceneFrag(g, L, scene.glsl(g)), [T, gpu.L.EMPTY, sceneL]);
      k.stampLayout = gpu.layout('world copy stamps', WC_STAMP_LAYOUT);
      k.stamp = kernel('stamps', wcStampFrag(g), [T, gpu.L.EMPTY, k.stampLayout]);
      k.overlayLayout = gpu.layout('world copy saved', WC_OVERLAY_LAYOUT);
      k.overlay = kernel('saved', wcOverlayFrag(g), [T, gpu.L.EMPTY, k.overlayLayout]);
      k.commit = kernel('commit', wcCommitChunkFrag(g, L), [T, gpu.L.EMPTY, W]);
    }
    k.ready = Promise.all(Object.values(k).filter((x) => x?.ready).map((x) => x.ready));
    k.isReady = false;
    k.ready.then(() => { k.isReady = true; }, () => {});
    this.kernels.set(key, k);
    return k;
  }

  _params(extra = {}) {
    return { origin: [0, 0, 0], count: 0, chunk: [0, 0, 0], first: 0, airT: this.airT, capacity: this.capacity, dilate: WC_DILATE, level: 0, ...extra };
  }

  // ---------------------------------------------------------------- the build
  /**
   * Build the whole map. source: the WorldWindow of a big map (its scene, world P, generator resources,
   * stores and simulation), or { sim } for a small map (its box, from its current cells).
   * Resolves when it is recorded and submitted (the first frame may draw it).
   * @param {object} source
   */
  async build(source) {
    const t0 = performance.now(), gpu = this.gpu, sim = source.sim;
    this._sim = sim;
    const scene = source.scene ?? null;
    if (scene && OUT_OF_SCOPE.test(scene.key)) { this.skipped = true; return this; }
    gpu.frame.clear(this.buf.ctrl);
    gpu.frame.clear(this.buf.occ);
    gpu.frame.clear(this.buf.info);
    this.bumpRead = 0; this.jobsSince = 0;
    let chunks = 0;
    if (scene) {
      const k = this._kernelsFor(sim, scene);
      await Promise.all([k.ready, source.gen?.ready]);
      if (this.disposed) return this;
      const est = Math.ceil(this.L.nBricks * POOL_START_SHARE);
      if (this.capacity < est) this._allocPool(est);
      chunks = await this._buildScene(source, k);
      if (this.disposed) return this;
      // the info's dilation and the occupancy, everywhere
      this._dilateAll(k);
      this._occAll(k);
      // the pool at its headroom over what it holds
      const w = await this._readCtrl() ?? await this._waitCtrl();
      const target = Math.max(64, Math.ceil(this.used * POOL_HEADROOM));
      if (target !== this.capacity && target >= w[WC_CTRL.BUMP]) this._allocPool(target);
    } else {
      if (this.capacity < 64) this._allocPool(Math.max(64, Math.ceil(this.L.nBricks * POOL_START_SHARE)));
      const k = this._kernelsFor(sim);
      await k.ready;
      if (this.disposed) return this;
      gpu.frame.clear(this.buf.table);
    }
    this.built = true;
    // the window's (or the box's) own cells over it: physics' current state
    const k = this._kernelsFor(sim);
    await k.ready;
    if (this.disposed) return this;
    const g = sim.g;
    if (sim.compact?.isReady) this.recordWriteback(gpu.frame, sim, [{ lo: [0, 0, 0], hi: [g.nx, g.ny, g.nz] }]);
    if (!scene) {
      // a small map: nothing outside the box; its whole-box writeback did the info and occupancy where it is
      this._dilateAll(k);
      this._occAll(k);
      await this._readCtrl();
      const target = Math.max(64, Math.ceil(this.used * POOL_HEADROOM));
      if (target > this.capacity) this._allocPool(target);
    }
    this._note([{ lo: [0, 0, 0], hi: [...this.size] }]);
    await gpu.fence();
    this.last = { buildMs: performance.now() - t0, chunks, capacity: this.capacity, used: this.used, bytes: this.bytes };
    return this;
  }

  async _waitCtrl() {
    while (this.reading) await this.gpu.fence();
    return this._readCtrl();
  }

  // The scene's chunks, nearest the window's centre first (the first frame's view has its ground soonest).
  async _buildScene(win, k) {
    const gpu = this.gpu, sim = win.sim, scene = win.scene, P = win.P, res = win.gen.res, L = this.L, [X, H, Z] = this.size;
    const sceneGroup = gpu.bindGroup(k.sceneLayout, res.entries([{ binding: WC_SCENE_CELLS_BINDING, resource: { buffer: this.buf.scratch } }]), 'world copy scene');
    const saved = this._savedByChunk(win);
    const order = [];
    for (let z = 0; z < Z; z += WC_CHUNK) for (let x = 0; x < X; x += WC_CHUNK) order.push([x, z]);
    const o = sim.origin, mid = [o.x + sim.g.nx / 2, o.z + sim.g.nz / 2];
    order.sort((a, b) => Math.hypot(a[0] + WC_CHUNK / 2 - mid[0], a[1] + WC_CHUNK / 2 - mid[1]) - Math.hypot(b[0] + WC_CHUNK / 2 - mid[0], b[1] + WC_CHUNK / 2 - mid[1]));
    const baked = new Map();
    let n = 0;
    for (const [x, z] of order) {
      if (this.disposed) return n;
      const cw = Math.min(WC_CHUNK, X - x), cd = Math.min(WC_CHUNK, Z - z), chunk = [cw, H, cd];
      const bricks = (cw / WC_BRICK) * (H / WC_BRICK) * (cd / WC_BRICK);
      // the scene's cells (its prepass over the chunk first)
      res.prepassFor([x, 0, z], [x + cw, H, z + cd]);
      k.scene.dispatch(gpu.frame, jobDispatch(cw * H * cd), { bind: [sim.tables, null, sceneGroup], params: this._params({ origin: [x, 0, z], chunk }) });
      // its trees
      if (scene.trees) this._stampTrees(win, k, [x, z], chunk, baked);
      // the saved bricks over them
      const list = saved.get(`${x},${z}`);
      if (list) this._overlay(k, list, chunk);
      // committed: room for every brick of it first
      this._reserve(bricks);
      k.commit.dispatch(gpu.frame, brickDispatch(bricks), { bind: [sim.tables, null, this.groups.write], params: this._params({ origin: [x, 0, z], chunk, count: bricks }) });
      n++;
      gpu.flush('world copy chunk');
      if (n % BUILD_FENCE_CHUNKS === 0) { await gpu.fence(); this._readCtrl(); }
    }
    return n;
  }

  _stampTrees(win, k, [x, z], chunk, baked) {
    const gpu = this.gpu, R = TREE.REACH, [cw, , cd] = chunk;
    win.candidates ??= new Map();
    if (win.candidates.size > 1 << 16) win.candidates.clear();
    const found = win.scene.trees.treesIn(x - R, z - R, x + cw + R, z + cd + R, win.P, win.candidates);
    // the window's order (renderSourceProducer.js sourceTrees): later stamps win
    const list = [...found].sort((a, b) => Math.floor(a.z / 4) - Math.floor(b.z / 4) || Math.floor(a.x / 4) - Math.floor(b.x / 4) || a.z - b.z || a.x - b.x);
    const stamps = [], parts = [];
    let base = 0;
    for (const t of list) {
      const key = `${t.size},${t.seed},${t.variant},${t.quarter}`;
      let s = baked.get(key);
      if (s === undefined) {
        s = bakeSourceTree(t) ?? null;
        baked.set(key, s ? { s, voxels: stampVoxels(s.data) } : null);
        s = baked.get(key);
      }
      if (!s) continue;
      const sh = s.s, at = [t.x - sh.base.x - x, t.y - sh.base.y, t.z - sh.base.z - z];
      if (at[0] + sh.w <= 0 || at[0] >= cw || at[2] + sh.d <= 0 || at[2] >= cd) continue;
      stamps.push(at[0], at[1], at[2], Math.min(sh.foot ?? 0, MAX_FOOT), sh.w, sh.h, sh.d, base);
      parts.push(s.voxels);
      base += s.voxels.length;
    }
    if (baked.size > 4096) baked.clear();
    if (!stamps.length) return;
    const st = this._stampBuf('stamps', stamps.length * 4), vx = this._stampBuf('voxels', base * 4);
    gpu.write(st, 0, new Int32Array(stamps));
    const all = new Uint32Array(base);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    gpu.write(vx, 0, all);
    const group = gpu.bindGroup(k.stampLayout, [this.buf.scratch, st, vx].map((buffer, binding) => ({ binding, resource: { buffer } })), 'world copy stamps');
    k.stamp.dispatch(gpu.frame, jobDispatch(cw * cd), { bind: [win.sim.tables, null, group], params: this._params({ chunk, count: stamps.length / WC_STAMP_WORDS }) });
  }

  // a build buffer that grows (the stamps', the voxels', the saved bricks')
  _stampBuf(name, bytes) {
    this._build ??= {};
    const b = this._build[name];
    if (b && b.size >= bytes) return b;
    this._retire(b);
    return (this._build[name] = this.gpu.createBuffer({ label: `world copy ${name}`, size: Math.max(256, Math.ceil(bytes * STAMP_GROW / 16) * 16), usage: BUFFER.STORAGE | BUFFER.COPY_DST }));
  }

  // The window's stored bricks (left behind, or from a save), by chunk: [chunk brick, 64 words] each.
  _savedByChunk(win) {
    const out = new Map(), seen = new Set(), [BX, BY] = win.wb ?? this.L.bricks, airT = this.airT;
    const add = (key, bytes) => {
      if (seen.has(key)) return;
      seen.add(key);
      const bx = key % BX, by = Math.floor(key / BX) % BY, bz = Math.floor(key / (BX * BY));
      const cx = Math.floor(bx * WC_BRICK / WC_CHUNK) * WC_CHUNK, cz = Math.floor(bz * WC_BRICK / WC_CHUNK) * WC_CHUNK;
      const cb = [(bx * WC_BRICK - cx) / WC_BRICK, by, (bz * WC_BRICK - cz) / WC_BRICK];
      const cw = Math.min(WC_CHUNK, this.size[0] - cx) / WC_BRICK;
      const words = storedBrickWords(bytes, airT);
      const k = `${cx},${cz}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(cb[0] + cw * (cb[1] + BY * cb[2]), words);
    };
    // exact native bricks first (they win), then V1's
    for (const [key, bytes] of win.nativeStore?.map ?? []) add(key, bytes);
    for (const [key, bytes] of win.store?.map ?? []) add(key, bytes);
    return out;
  }

  _overlay(k, list, chunk) {
    const gpu = this.gpu, n = list.length / 2, words = new Uint32Array(n * 65);
    for (let i = 0; i < n; i++) { words[i * 65] = list[i * 2]; words.set(list[i * 2 + 1], i * 65 + 1); }
    const b = this._stampBuf('saved', words.byteLength);
    gpu.write(b, 0, words);
    const group = gpu.bindGroup(k.overlayLayout, [this.buf.scratch, b].map((buffer, binding) => ({ binding, resource: { buffer } })), 'world copy saved');
    k.overlay.dispatch(gpu.frame, brickDispatch(n), { bind: [this._tables, null, group], params: this._params({ chunk, count: n }) });
  }

  _dilateAll(k) {
    const n = this.L.nBricks;
    for (let first = 0; first < n; first += DILATE_SPAN) {
      k.dilate.dispatch(this.gpu.frame, jobDispatch(Math.min(DILATE_SPAN, n - first)), {
        bind: [this._tables, null, this.groups.write], params: this._params({ first, count: Math.min(DILATE_SPAN, n - first), level: 1 }) });
    }
  }

  _occAll(k) {
    const L = this.L, n1 = L.n1[0] * L.n1[1] * L.n1[2], n2 = L.n2[0] * L.n2[1] * L.n2[2];
    k.occ.dispatch(this.gpu.frame, jobDispatch(n1), { bind: [this._tables, null, this.groups.write], params: this._params({ count: n1, level: 1, dilate: -1 }) });
    k.occ.dispatch(this.gpu.frame, jobDispatch(n2), { bind: [this._tables, null, this.groups.write], params: this._params({ count: n2, level: 2, dilate: -1 }) });
  }

  get _tables() { return this._sim?.tables ?? this.gpu._simTables?.group; }

  // ---------------------------------------------------------------- physics' writeback
  /**
   * Physics' changed boxes, in window cells ({ lo, hi }, hi exclusive; null: the whole window), decoded from
   * V2's native cores into the copy, recorded into `frame`. Costs in proportion to the changed bricks.
   * @param {object} frame gpu.frame
   * @param {import('../sim.js').Simulation} sim
   * @param {{ lo: number[], hi: number[] }[] | null} boxes
   */
  recordWriteback(frame, sim, boxes) {
    if (!this.built || this.skipped || this.disposed || !sim.compact?.isReady) return false;
    this._sim = sim;
    const k = this._kernelsFor(sim), g = sim.g;
    if (!k.isReady) { this.allDirty = true; return false; }
    const whole = [{ lo: [0, 0, 0], hi: [g.nx, g.ny, g.nz] }];
    if (this.allDirty) { boxes = whole; this.allDirty = false; }
    boxes ??= whole;
    const o = sim.origin, O = [o.x, o.y, o.z], WB = this.L.bricks, GB = [g.nx, g.ny, g.nz].map((n) => n / WC_BRICK);
    if (O.some((v) => v % WC_BRICK) || GB.some((n) => n - 1 > MAX_JOB_COORD)) throw new Error('world copy: the window must sit on bricks and pack in 10 bits a coordinate');
    const ob = O.map((v) => v / WC_BRICK);
    const jobs = new Set(), worldBoxes = [];
    for (const box of boxes) {
      const lo = box.lo.map((v, i) => Math.max(0, Math.floor(v / WC_BRICK), -ob[i]));
      const hi = box.hi.map((v, i) => Math.min(GB[i], Math.ceil(v / WC_BRICK), WB[i] - ob[i]));
      if (lo.some((v, i) => v >= hi[i])) continue;
      worldBoxes.push({ lo: lo.map((v, i) => (v + ob[i]) * WC_BRICK), hi: hi.map((v, i) => (v + ob[i]) * WC_BRICK) });
      for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) jobs.add(x | (y << 10) | (z << 20));
    }
    if (!jobs.size) return false;
    // the bricks whose info the dilation redoes (within WC_DILATE of a changed one), and their occupancy nodes
    const D = WC_DILATE, dil = new Set(), n1 = new Set(), n2 = new Set(), [BX, BY, BZ] = WB, L = this.L;
    for (const j of jobs) {
      const b = [(j & 1023) + ob[0], ((j >> 10) & 1023) + ob[1], (j >>> 20) + ob[2]];
      for (let dz = -D; dz <= D; dz++) for (let dy = -D; dy <= D; dy++) for (let dx = -D; dx <= D; dx++) {
        const x = b[0] + dx, y = b[1] + dy, z = b[2] + dz;
        if (x < 0 || y < 0 || z < 0 || x >= BX || y >= BY || z >= BZ) continue;
        dil.add(x + BX * (y + BY * z));
        const a = [Math.floor(x / WC_NODE1), Math.floor(y / WC_NODE1), Math.floor(z / WC_NODE1)];
        n1.add(a[0] + L.n1[0] * (a[1] + L.n1[1] * a[2]));
        n2.add(Math.floor(a[0] / WC_NODE2) + L.n2[0] * (Math.floor(a[1] / WC_NODE2) + L.n2[1] * Math.floor(a[2] / WC_NODE2)));
      }
    }
    const nj = jobs.size, words = new Uint32Array(nj + dil.size + n1.size + n2.size);
    let i = 0;
    for (const v of jobs) words[i++] = v;
    for (const v of dil) words[i++] = v;
    for (const v of n1) words[i++] = v;
    for (const v of n2) words[i++] = v;
    this._ensureScratch(nj * 65);
    this._reserve(nj);
    const at = this._putJobs(words);
    const W = this.groups.write, t = sim.tables, origin = O;
    k.decode.dispatch(frame, brickDispatch(nj), { bind: [t, sim.bindRO, W], header: sim.readHeader(), params: this._params({ origin, first: at, count: nj }) });
    k.alloc.dispatch(frame, brickDispatch(nj), { bind: [t, null, W], params: this._params({ origin, first: at, count: nj }) });
    k.dilate.dispatch(frame, jobDispatch(dil.size), { bind: [t, null, W], params: this._params({ first: at + nj, count: dil.size }) });
    k.occ.dispatch(frame, jobDispatch(n1.size), { bind: [t, null, W], params: this._params({ first: at + nj + dil.size, count: n1.size, level: 1 }) });
    k.occ.dispatch(frame, jobDispatch(n2.size), { bind: [t, null, W], params: this._params({ first: at + nj + dil.size + n1.size, count: n2.size, level: 2 }) });
    this._readCtrl();
    this._note(worldBoxes);
    return true;
  }

  // ---------------------------------------------------------------- changes
  _note(boxes) {
    this.revision++;
    this.changes = boxes;
    for (const b of boxes) this.log.push({ rev: this.revision, lo: b.lo, hi: b.hi });
    if (this.log.length > CHANGES_KEPT) this.log.splice(0, this.log.length - CHANGES_KEPT);
    this.uniforms.write({ revision: this.revision, capacity: this.capacity, air: this.airWord });
  }

  /**
   * The world-cell boxes ({ lo, hi }, hi exclusive, brick-aligned) changed after revision `rev` (F's and L's
   * updates: keep `revision` and ask with it next time). A revision older than the log: the whole world.
   * @param {number} rev
   * @returns {{ lo: number[], hi: number[] }[]}
   */
  changesSince(rev) {
    if (rev >= this.revision) return [];
    if (!this.log.length || this.log[0].rev > rev + 1) return [{ lo: [0, 0, 0], hi: [...this.size] }];
    return this.log.filter((e) => e.rev > rev).map(({ lo, hi }) => ({ lo, hi }));
  }

  /** GPU bytes it holds (table, info, occupancy, pool and free list at capacity, jobs and scratch). */
  get bytes() { return Object.values(this.buf).reduce((n, b) => n + (b?.size ?? 0), 0) + Object.values(this._build ?? {}).reduce((n, b) => n + b.size, 0); }

  /** For tools: the allocator's counters now ({ bump, free, over, capacity, used }). */
  async stats() {
    await this._waitCtrl();
    return { bump: this.bumpRead, used: this.used, over: this.overflow, capacity: this.capacity, bytes: this.bytes, revision: this.revision };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of [...Object.values(this.buf), ...Object.values(this._build ?? {}), this.uniforms.buffer]) this._retire(b);
  }
}
