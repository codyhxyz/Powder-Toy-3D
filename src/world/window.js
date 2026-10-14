import { decodeWorldState } from './persistence.js';
import { NativeBrickStore } from './nativeStore.js';
import { BRICK } from '../shaders/common.js';
import { restoreEdit, BRICK_CELLS } from '../shaders/window.js';
import { leaveHeadBytes, LEAVE_BRICK_BYTES } from '../shaders/generate.js';
import { WorldGenerator } from './gpu.js';
import { TREE, WORLD_SEED } from './generator.js';
import { island } from './scenes/island.js';
import { runGenerator, bake } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { BrickStore, encodeBrick, decodeBrick, BRICK_FLOATS } from './store.js';
import { farLayout, farSceneLayout } from '../shaders/far.js';

// The window over a massive world (docs/scaling.md D11, phases W1 and W2;
// docs/webgpu.md G1).
//
// The simulation's grid is a window into a world of `size` cells that the
// generator defines everywhere. sim.origin is the window's world cell: a
// multiple of WIN_STEP on x and z, 0 on y (the window spans the world's
// height). Each frame update(focus) keeps it centred on the focus (the POV
// body, else the orbit target): when the focus is more than WIN_STEP +
// WIN_HYSTERESIS cells from the window's centre along x or z, the window
// moves WIN_STEP that way, at most once per frame.
//
// A move, all of it recorded into the frame's encoder (docs/webgpu.md B3):
//   1. the slab about to leave is compared with the generator brick by brick
//      and its differing bricks gathered, in one kernel (shaders/generate.js
//      sceneDiffFrag); the count, their keys and a prefix of their cells are
//      read back asynchronously (one round trip unless more differ than the
//      last move's estimate): the bricks that match leave the store, the ones
//      that differ go into it (world/store.js);
//   2. Simulation.shift moves the state and the flow, and the derived passes
//      and whitewater move theirs (sim.onShift: the render fields, bricks and
//      GI by whole bricks, only the slab and the edges re-aged);
//   3. the generator fills the slab the move uncovers (an edit over it), then
//      that slab's stored bricks are written back (another: restore);
//   4. the scene's trees (scene.trees: the island's) are stamped into the
//      brick columns the move visits for the first time, clipped to those
//      columns (the planted record): a tree is planted once, piece by piece as
//      its columns are first visited, and comes back from the store as edits
//      after that.
// No syncCopies after it (docs/webgpu.md D6, G1): the shift forces every
// unit, so the next step's react rewrites the other copy before anything
// reads it, and the slab's edits mark the bricks they change.
// No move starts while a leaving slab is still being read back, so the store
// holds everything a move can bring back, and the slab's buffers aren't
// written again before they are read.
//
// The far field (world/far.js), when the app gives the window one (far), is
// built on load, summarizes the slab about to leave in step 1, and sweeps over
// the window's region while it changes (update).
//
// What the world holds is its scene (world/scenes): P = scene.params. The
// generator (world/gpu.js) runs the scene's sceneCell for the fill and the
// diff, its resources (uniforms, data, the island's baked columns) made once
// it has prepared; whenReady builds the window's kernels and the far field's
// meanwhile, and the app loads the world once they are ready, so switching to
// a world never stalls the page on a pipeline: the window fills in, then the
// far field around it. Until load the window doesn't move.

export const WIN_STEP = 16;          // cells: how far the window moves at a time (whole supertiles along x and z)
export const WIN_HYSTERESIS = 4;     // cells past WIN_STEP from the centre the focus goes before a move
const BAKED_KEEP = 256;              // baked trees kept: a tree straddling slabs is stamped once per slab
const CANDIDATES_KEEP = 1 << 16;     // tree candidates kept (one per brick column; a move asks for its neighbours again)
const READ_MIN = 64;                 // bricks of a leaving slab's cells read with its count at least...
const READ_AHEAD = 1.5;              // ...or this many times the last move's (a second read fetches the rest)
const VEC4 = 16;
const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08 };   // (GPUBufferUsage's bits)

export class WorldWindow {
  // sim: the window's Simulation (its grid spans the world's height); size:
  // the world in cells [x, y, z]; seed: its seed (the generator's default
  // world's without one); scene: what it holds (world/scenes). (The first
  // argument was the WebGL renderer; the window works on the sim's device.)
  constructor(_renderer, sim, { size, seed = WORLD_SEED, scene = island }) {
    const g = sim.g;
    if (g.ny !== size[1]) throw new Error(`window ${g.ny} cells tall in a world ${size[1]} tall: it spans the world's height`);
    if (size.some((n, i) => n % WIN_STEP && i !== 1)) throw new Error(`world ${size}: x and z must be multiples of ${WIN_STEP}`);
    this.sim = sim;
    sim.worldWindow = this;
    this.historyIdentity = {};
    this.historyReaders = 0;
    this.gpu = sim.gpu;
    this.size = size;
    this.scene = scene;
    this.P = scene.params({ size, seed });
    // its own generator, not generatorFor's shared one: tools run two windows
    // (its prepass room covers the far field's chunks too: world/far.js)
    const S = farSceneLayout(farLayout(size));
    this.gen = new WorldGenerator(sim, scene, this.P, { regions: [[S.side, size[1], S.side]] });
    this.wb = size.map((n) => n / BRICK);                          // the world in bricks
    this.store = new BrickStore(this.wb);
    this.nativeStore = new NativeBrickStore(this.wb); // exact core+bank; projection never decides whether to retain
    this.planted = new Uint8Array(this.wb[0] * this.wb[2]);       // brick columns whose trees are in
    this.baked = new Map();
    this.candidates = new Map();                                  // tree candidates by brick column (treesIn)
    this.pending = null;                                          // the leaving slab's readback
    this.epoch = 0;                                               // bumped by load and dispose: older readbacks are dropped
    this.last = null;                                             // what the last move cost (tools)
    this.plantCost = null;                                        // the move's tree placing and baking, ms (tools)
    this.far = null;                                              // the far field (world/far.js), if the app draws one
    this.loaded = false;                                          // load has filled the window (it moves only after)
    this.ready = null;                                            // whenReady's promise
    this.lastKept = 0;                                            // bricks the last leaving slab kept (its readback's estimate)

    // the largest slab a move exchanges: its buffers, made once
    const step = WIN_STEP / BRICK, BX = g.nx / BRICK, BY = g.ny / BRICK, BZ = g.nz / BRICK;
    this.maxBricks = Math.max(step * BY * BZ, BX * BY * step);
    this.leave = this.gen.diffBuffers(this.maxBricks);
    // stored bricks back: an edit over the uncovered slab, from one upload buffer (made on first use)
    this.restoreKernel = sim.editKernel('restore', restoreEdit());
    this.restoreBuf = null;
    this.restoreRead = -1;   // gpu.stats.flushes when a restore edit last read restoreBuf (still unsubmitted while equal)
  }

  // Resolves once the window's kernels and the far field's are built and the
  // scene has prepared (started in the background on the first call; give the
  // window its far field first): load and the moves then record at once.
  whenReady() {
    return (this.ready ??= Promise.all([
      this.gen.ready, this.gen.prepareDiff(), this.restoreKernel.ready, this.far?.whenReady?.(),
    ]).then(() => this));
  }

  // The origin that centres the window in the world.
  centre() {
    const g = this.sim.g, snap = (n) => Math.round(n / WIN_STEP) * WIN_STEP;
    return [snap((this.size[0] - g.nx) / 2), 0, snap((this.size[2] - g.nz) / 2)];
  }

  // (Re)load the world from the generator with the window at `origin`: no
  // edits, nothing planted. A whole-grid write (docs/webgpu.md D6): the next
  // map draws every unit, so no syncCopies follows (G1). Needs whenReady.
  load(origin = this.centre()) {
    if (this.sim.nativeTransitionKind === 'shift') throw new Error('Cannot replace a world during its native shift');
    const sim = this.sim, g = sim.g;
    this.historyIdentity = {};
    this.epoch++;   // a slab of the old world still being read back is dropped
    this.store.clear();
    this.nativeStore.clear();
    this.persistenceError = null;
    sim.deco?.reset();   // the decoration and its store go too (src/deco.js)
    this.planted.fill(0);
    sim.origin.set(origin[0], 0, origin[2]);
    sim.resetNativeDynamics();
    this.gen.fill(this.P, [origin[0], 0, origin[2]]);
    if (this.scene.trees) this.plant([0, 0, 0], [g.nx, g.ny, g.nz]);
    sim.noteWrite();
    this.far?.build();
    sim.dropHistory();   // undo would bring back a window of the old world
    // a new scene: the render fields and GI start over instead of blending in, and nothing is moving
    sim.fieldReset = sim.giReset = true;
    sim.stillFlow();
    this.loaded = true;
  }

  // A saved world back (saves/game.js): the window at `origin`, its cells
  // from fillState() (it loads the saved state into the simulation: a
  // whole-grid write), the stored bricks (BrickStore.toBytes) and the planted
  // brick columns as they were saved. Like load, it drops undo and starts the
  // derived passes over. The far field is rebuilt from the scene and the
  // window: stored edits outside the window show from afar once the window has
  // passed over them.
  loadSaved(origin, fillState, storeBytes, planted, nativeBytes = null) {
    const sim = this.sim;
    const next = decodeWorldState({ size: this.size, origin }, [sim.g.nx, sim.g.ny, sim.g.nz], storeBytes, planted, nativeBytes);
    if (sim.nativeTransitionKind === 'shift') throw new Error('Cannot load during a native world shift');
    this.historyIdentity = {};
    this.epoch++;
    this.persistenceError = null;
    this.store.map = next.store.map; this.store.bytes = next.store.bytes;
    this.nativeStore.map = next.nativeStore.map; this.nativeStore.bytes = next.nativeStore.bytes;
    this.planted.set(next.planted);
    sim.origin.set(origin[0], 0, origin[2]);
    fillState();
    this.far?.build();
    sim.dropHistory();
    sim.fieldReset = sim.giReset = true;
    this.loaded = true;
  }

  // Acquire synchronously before save preparation can yield. Existing shifts
  // may finish their already-recorded transition/readback; only NEW shifts are
  // excluded, so waiting for this.pending while holding the lock cannot deadlock.
  acquireReadLock() {
    this.historyReaders = (this.historyReaders ?? 0) + 1;
    let released = false;
    return () => { if (!released) { released = true; this.historyReaders--; } };
  }

  // COW history: stored byte strings are immutable after put(); snapshots copy
  // only Map indices, never all retained material. Existing sim history limit
  // bounds the retained versions. A previous leaving readback must land first.
  captureHistory() {
    const identity = this.historyIdentity, origin = this.sim.origin.toArray(), planted = this.planted.slice();
    this.historyReaders++;
    const capture = () => {
      if (identity !== this.historyIdentity || this.sim.disposed || this.persistenceError) throw new Error('World changed or failed during history capture');
      return { window: this, identity, origin, planted, store: new Map(this.store.map), storeBytes: this.store.bytes,
        nativeStore: new Map(this.nativeStore.map), nativeBytes: this.nativeStore.bytes,
        decoStore: this.sim.deco ? new Map(this.sim.deco.store) : null };
    };
    const pending = [this.pending, this.sim.deco?.pending].filter(Boolean);
    if (!pending.length) {
      try { return Promise.resolve(capture()); } finally { this.historyReaders--; }
    }
    return Promise.all(pending).then(capture).finally(() => { this.historyReaders--; });
  }
  prepareHistoryRestore(h) {
    if (!h || h.window !== this || h.identity !== this.historyIdentity || this.pending || this.sim.deco?.pending || this.historyReaders)
      throw new Error('Native world history is not ready for this window');
    const g = this.sim.g;
    if (!Array.isArray(h.origin) || h.origin.length !== 3 || h.origin.some((n, i) => !Number.isInteger(n) || n < 0 || (i === 1 ? n !== 0 : n % WIN_STEP !== 0) || n + [g.nx, g.ny, g.nz][i] > this.size[i]) ||
      !(h.planted instanceof Uint8Array) || h.planted.length !== this.planted.length || !(h.store instanceof Map) || !(h.nativeStore instanceof Map))
      throw new Error('Invalid native world history');
    const max = this.wb.reduce((a, b) => a * b, 1), A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
    let legacyBytes = 0, nativeBytes = 0;
    for (const [key, bytes] of h.store) {
      if (!Number.isInteger(key) || key < 0 || key >= max || !(bytes instanceof Uint8Array)) throw new Error('Invalid legacy world history brick');
      decodeBrick(bytes, A, 0, B, 0); legacyBytes += bytes.length;
    }
    const native = new NativeBrickStore(this.wb);
    for (const [key, bytes] of h.nativeStore) { native.put(key, bytes); nativeBytes += bytes.length; }
    if (legacyBytes !== h.storeBytes || nativeBytes !== h.nativeBytes) throw new Error('Invalid world history byte counts');
    if (h.decoStore !== null && (!(h.decoStore instanceof Map) || [...h.decoStore].some(([key, bytes]) => !Number.isInteger(key) || key < 0 || key >= max || !(bytes instanceof Uint8Array) || bytes.length !== 256))) throw new Error('Invalid decoration world history');
    // Allocate all new indices before the commit. Byte payloads remain shared,
    // future store.put/drop changes only the current Map, not this history.
    const legacy = new Map(h.store), deco = h.decoStore && new Map(h.decoStore);
    return () => {
      const o = this.sim.origin, delta = [h.origin[0] - o.x, h.origin[2] - o.z];
      this.epoch++;
      this.store.map = legacy; this.store.bytes = legacyBytes;
      this.nativeStore.map = native.map; this.nativeStore.bytes = nativeBytes;
      this.planted.set(h.planted); o.fromArray(h.origin);
      if (this.sim.deco) { this.sim.deco.epoch++; this.sim.deco.store = deco ?? new Map(); }
      this.sim.fieldReset = this.sim.giReset = this.sim.changedAll = true;
      this.sim.forceAll = this.sim.actFull = true;
      return delta;
    };
  }
  finishHistoryRestore(delta) {
    this.far?.build();
    this.sim.onWorldHistoryRestore?.(...delta);
  }

  // Keep the window centred on the focus (world cells, x and z). Returns the
  // move made, [dx, dz] world cells, or null.
  update(fx, fz) {
    if (!this.loaded || this.persistenceError || this.sim.nativeTransition || this.historyReaders) return null;
    this.far?.tick();
    if (this.pending || this.sim.deco?.pending) return null;
    if (this.sim.compactOwner && !this.sim.nativeCapabilities.world) return null;
    const g = this.sim.g, o = this.sim.origin, lim = WIN_STEP + WIN_HYSTERESIS;
    const off = [fx - (o.x + g.nx / 2), fz - (o.z + g.nz / 2)];
    const at = [o.x, o.z], span = [g.nx, g.nz], world = [this.size[0], this.size[2]];
    let best = null;
    for (const axis of [0, 1]) {
      const excess = Math.abs(off[axis]) - lim, d = Math.sign(off[axis]) * WIN_STEP;
      const fits = at[axis] + d >= 0 && at[axis] + d + span[axis] <= world[axis];
      if (excess > 0 && fits && (!best || excess > best.excess)) best = { axis, d, excess };
    }
    if (!best) return null;
    const move = best.axis ? [0, best.d] : [best.d, 0];
    const result = this.shift(...move);
    return result?.then ? result.then(() => move) : move;
  }

  // Move the window by (dx, 0, dz) world cells (one of them 0): steps 1–4 above.
  shift(dx, dz) {
    if (this.persistenceError) throw this.persistenceError;
    if (this.historyReaders) throw new Error('World history capture is pending');
    if (this.pending) throw new Error('World shift while leaving slab is pending');
    if (this.sim.compactOwner && !this.sim.nativeCapabilities.world) throw new Error('Native world shift is not ready');
    if (this.sim.compactOwner) {
      const transition = this.sim.nativeIntegration.beginShift(dx, dz, () => {
        this.pending = null;
        this._shiftCommitted(dx, dz);
      });
      this.pending = transition;
      transition.catch(error => { this.persistenceError = error; });
      return transition;
    }
    return this._shiftCommitted(dx, dz);
  }
  _shiftCommitted(dx, dz) {
    const t0 = performance.now();
    const sim = this.sim, g = sim.g, before = sim.origin.clone();
    // the slab that leaves (grid cells before the move) and the one the move uncovers (after it)
    const size = [dx ? Math.abs(dx) : g.nx, g.ny, dz ? Math.abs(dz) : g.nz];
    const leaveLo = [dx < 0 ? g.nx + dx : 0, 0, dz < 0 ? g.nz + dz : 0];
    const enterLo = [dx > 0 ? g.nx - dx : 0, 0, dz > 0 ? g.nz - dz : 0];
    const enterHi = enterLo.map((v, i) => v + size[i]);
    const bricks = size.map((n) => n / BRICK);
    // 1.
    const nativeRead = sim.nativeIntegration?.captureSlab(leaveLo, bricks);
    this.gen.diff(this.P, leaveLo, bricks, this.leave);
    const leaveB = [before.x / BRICK + leaveLo[0] / BRICK, 0, before.z / BRICK + leaveLo[2] / BRICK];
    this.readBack(leaveB, bricks, nativeRead);
    // the decoration of the slab that leaves goes into its own store (src/deco.js)
    sim.deco?.leave(leaveLo, bricks, (x, y, z) => this.store.key(leaveB[0] + x, leaveB[1] + y, leaveB[2] + z));
    this.far?.summarize(leaveLo, bricks);
    // 2.
    sim.shift(dx, dz);
    // 3.
    const o = sim.origin;
    this.gen.fill(this.P, [o.x, o.y, o.z], enterLo, enterHi);
    const restored = this.restore(enterLo, bricks);
    sim.deco?.enter(enterLo, bricks, (x, y, z) => this.store.key(o.x / BRICK + enterLo[0] / BRICK + x, y, o.z / BRICK + enterLo[2] / BRICK + z));
    // 4.
    this.plantCost = { placeMs: 0, bakeMs: 0 };
    const trees = this.scene.trees ? this.plant(enterLo, enterHi) : 0;
    // Import only generator-owned coordinates, then restore exact retained
    // material after all legacy stamps. Untouched overlap is never imported.
    this.restoreNative(enterLo, bricks);
    // Fill/restore/plant transferred residency, not world contents. summarize
    // already recorded real writes before the move; don't dirty meshes again.
    if (this.far) this.far.detail.simVersion = sim.version;
    this.last = { dx, dz, ms: performance.now() - t0, restored, trees, ...this.plantCost, readbackMs: null, kept: null };
  }

  // Read the leaving slab back (its kernel recorded just before): the count,
  // the kept bricks' keys and a prefix of their cells, one round trip unless
  // more bricks differ than the estimate (then a second for the rest). The
  // bricks that match the generator leave the store, the ones that differ go
  // into it. base is slab brick 0's world brick.
  readBack(base, bricks, nativeRead = null) {
    const n = bricks[0] * bricks[1] * bricks[2], rb = this.gpu.readback, out = this.leave, epoch = this.epoch;
    const est = Math.min(n, Math.max(READ_MIN, Math.ceil(this.lastKept * READ_AHEAD)));
    const t0 = performance.now(), last = () => this.last;
    // (both copies are recorded now, at the request: docs/webgpu.md B7)
    const head = rb.buffer(out.head, 0, Math.ceil(leaveHeadBytes(n) / 4) * 4);
    const cells = rb.buffer(out.cells, 0, est * LEAVE_BRICK_BYTES);
    let t1 = 0, kept = 0;
    this.pending = Promise.all([head, cells, nativeRead]).then(async ([h, c, native]) => {
      if (epoch !== this.epoch) return;
      t1 = performance.now();
      const words = new Uint32Array(h), count = Math.min(words[0], n);
      let floats = new Float32Array(c);
      if (count > est) {
        // more differ than the estimate: the rest of them (the buffer is ours until this read lands)
        const rest = new Float32Array(await rb.buffer(out.cells, est * LEAVE_BRICK_BYTES, (count - est) * LEAVE_BRICK_BYTES));
        if (epoch !== this.epoch) return;
        const all = new Float32Array(count * LEAVE_BRICK_BYTES / 4);
        all.set(floats);
        all.set(rest, floats.length);
        floats = all;
      }
      const keep = new Set();
      for (let s = 0; s < count; s++) {
        const key = words[1 + s];
        keep.add(key);
        this.store.put(key, encodeBrick(floats, s * 2 * BRICK_FLOATS, floats, s * 2 * BRICK_FLOATS + BRICK_FLOATS));
      }
      for (let i = 0; i < n; i++) {
        const key = this.store.key(base[0] + (i % bricks[0]), base[1] + Math.floor(i / bricks[0]) % bricks[1], base[2] + Math.floor(i / (bricks[0] * bricks[1])));
        if (!keep.has(key)) this.store.drop(key);
        if (native) this.nativeStore.put(key, native[i]);
        else this.nativeStore.drop(key);
      }
      kept = count;
      this.lastKept = count;
    }).then(() => {
      const L = last();
      if (L && epoch === this.epoch) Object.assign(L, { flagsMs: t1 - t0, readbackMs: t1 - t0, keepMs: performance.now() - t1, kept, landedAt: performance.now() });
    }).catch((err) => {
      if (epoch === this.epoch) this.persistenceError = err;
      if (!this.gpu.failure) console.error('world window: leaving slab readback failed; native streaming/saving is blocked', err);
    }).finally(() => { this.pending = null; });
  }

  // Write the stored bricks of the slab of grid cells [lo, lo + 4·bricks) back
  // into the grid, taking them out of the store: an edit over the slab from
  // one upload (the index, then the bricks' cells; shaders/window.js
  // editFrag). Returns how many.
  restore(lo, bricks) {
    const sim = this.sim, o = sim.origin;
    const lb = lo.map((v) => v / BRICK), ob = [o.x / BRICK, o.y / BRICK, o.z / BRICK];
    const n = bricks[0] * bricks[1] * bricks[2], index = new Uint32Array(Math.ceil(n / 4) * 4), keys = [];
    for (let bz = 0; bz < bricks[2]; bz++)
      for (let by = 0; by < bricks[1]; by++)
        for (let bx = 0; bx < bricks[0]; bx++) {
          const key = this.store.key(ob[0] + lb[0] + bx, ob[1] + lb[1] + by, ob[2] + lb[2] + bz);
          if (!this.store.has(key)) continue;
          keys.push(key);
          index[bx + bricks[0] * (by + bricks[1] * bz)] = keys.length;
        }
    if (!keys.length) return 0;
    const cellsAt = index.length / 4, bytes = (cellsAt + keys.length * 2 * BRICK_CELLS) * VEC4;
    if (!this.restoreBuf || this.restoreBuf.size < bytes) {
      if (this.restoreBuf) sim._retire(this.restoreBuf);
      this.restoreBuf = this.gpu.createBuffer({ label: `sim${sim.id} restore`, size: Math.max(bytes, 2 * VEC4 * (cellsAt + 64 * 2 * BRICK_CELLS)), usage: BUFFER.STORAGE | BUFFER.COPY_DST });
      this.restoreRead = -1;   // (nothing reads the new one yet)
    }
    const cells = new Float32Array(keys.length * 2 * BRICK_FLOATS);
    keys.forEach((key, s) => decodeBrick(this.store.map.get(key), cells, s * 2 * BRICK_FLOATS, cells, s * 2 * BRICK_FLOATS + BRICK_FLOATS));
    // Unordered unless a restore recorded in the open encoder still reads the
    // buffer (two moves in one frame: a tool's): an ordered write would flush
    // the move's work so far, a second submit for every move that restores.
    const ordered = this.restoreRead === this.gpu.stats.flushes;
    this.gpu.write(this.restoreBuf, 0, index, { ordered });
    this.gpu.write(this.restoreBuf, cellsAt * VEC4, cells, { ordered: false });   // (the first flushed, if it had to)
    sim.edit(this.restoreKernel, { lo, hi: lo.map((v, i) => v + bricks[i] * BRICK - 1) }, { lo, bricks, cellsAt }, { bind: [{ buffer: this.restoreBuf }] });
    this.restoreRead = this.gpu.stats.flushes;
    for (const key of keys) this.store.drop(key);
    return keys.length;
  }

  restoreNative(lo, bricks) {
    const sim = this.sim, native = sim.nativeIntegration;
    if (!native?.isReady) return 0;
    sim.compactOwner.sync();
    const o = sim.origin, base = [o.x, o.y, o.z].map((v, i) => (v + lo[i]) / BRICK);
    const entries = [], keys = [];
    for (let z = 0; z < bricks[2]; z++) for (let y = 0; y < bricks[1]; y++) for (let x = 0; x < bricks[0]; x++) {
      const key = this.nativeStore.key(base[0] + x, base[1] + y, base[2] + z);
      const bytes = this.nativeStore.map.get(key);
      if (!bytes) continue;
      entries.push({ index: x + bricks[0] * (y + bricks[1] * z), bytes });
      keys.push(key);
    }
    native.restoreBricks(lo, bricks, entries);
    for (const key of keys) this.nativeStore.drop(key);
    if (!sim.compact) sim.compactOwner.exportLegacy();
    return keys.length;
  }

  // Stamp the scene's trees in the brick columns of grid cells [lo, hi) (x and z,
  // brick-aligned) that are visited for the first time, clipped to those
  // columns, and mark them planted. Returns how many trees were stamped.
  plant(lo, hi) {
    const sim = this.sim, g = sim.g, o = sim.origin, BX = g.nx / BRICK;
    const mask = new Uint8Array(BX * (g.nz / BRICK));
    let fresh = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;   // their bounds, world cells
    for (let bz = lo[2] / BRICK; bz < hi[2] / BRICK; bz++)
      for (let bx = lo[0] / BRICK; bx < hi[0] / BRICK; bx++) {
        const wx = o.x / BRICK + bx, wz = o.z / BRICK + bz, k = wz * this.wb[0] + wx;
        if (this.planted[k]) continue;
        this.planted[k] = 1;
        mask[bz * BX + bx] = 1;
        fresh++;
        x0 = Math.min(x0, wx * BRICK); x1 = Math.max(x1, (wx + 1) * BRICK);
        z0 = Math.min(z0, wz * BRICK); z1 = Math.max(z1, (wz + 1) * BRICK);
      }
    if (!fresh) return 0;
    const R = TREE.REACH, list = [];
    if (this.candidates.size > CANDIDATES_KEEP) this.candidates.clear();
    const t0 = performance.now(), trees = this.scene.trees.treesIn(x0 - R, z0 - R, x1 + R, z1 + R, this.P, this.candidates);
    const t1 = performance.now();
    if (this.plantCost) this.plantCost.placeMs += t1 - t0;
    for (const t of trees) {
      const s = this.bakeTree(t);
      if (!s) continue;
      // the construction's base point on the ground at the trunk (WorldGenerator.plantTrees)
      const at = [t.x - o.x - s.base.x, t.y - o.y - s.base.y, t.z - o.z - s.base.z];
      if (at[0] + s.w <= x0 - o.x || at[0] >= x1 - o.x || at[2] + s.d <= z0 - o.z || at[2] >= z1 - o.z) continue;
      list.push({ s, at, seed: t.seed, key: `${t.x},${t.z}` });
    }
    if (this.plantCost) this.plantCost.bakeMs += performance.now() - t1;
    if (!list.length) return 0;
    return this.gen.stampMany(list, mask, { lo, hi: hi.map(v => v - 1) });
  }

  bakeTree(t) {
    const k = `${t.x},${t.z}`;
    if (!this.baked.has(k)) {
      this.baked.set(k, bake(runGenerator(BUILTINS.TREE, { size: t.size, seed: t.seed, variant: t.variant }), t.quarter));
      if (this.baked.size > BAKED_KEEP) this.baked.delete(this.baked.keys().next().value);
    }
    return this.baked.get(k);
  }

  // The store's size: bricks kept, bytes, and the brick columns planted.
  stats() {
    return { bricks: this.store.size, bytes: this.store.bytes + this.nativeStore.bytes, nativeBricks: this.nativeStore.size, planted: this.planted.reduce((n, v) => n + v, 0) };
  }

  dispose() {
    if (this.sim.worldWindow === this) this.sim.worldWindow = null;
    this.epoch++;
    this.far?.dispose();
    this.gen.dispose();
    // (destroyed once the frames that use them are submitted and done)
    for (const b of [this.leave.head, this.leave.cells, this.restoreBuf]) if (b) this.sim._retire(b);
    this.scene.dispose?.();
  }
}
