import { fold } from '../gpu/kernels.js';
import { cellSlot } from '../shaders/common.js';
import {
  V2_KERNELS, V2Params, V2_LAYOUT, V2_ARGS_LAYOUT, V2_STATE_LAYOUT, V2_INVALIDATE_LAYOUT, v2ActLayout, v2Table, v2Rows, ARGS2, STATS,
  TICK_HZ, FULL, SUB, V2, QUIET_TICKS,
} from '../shaders/v2.js';

// Opt-in box physics. Compact cells are authoritative; read-only presentation
// consumes them directly. Legacy A/B are a lazy, lossy compatibility cache for
// existing editing/readback APIs, not a per-tick renderer intermediate.

// Rest (docs/v2.md 5.6): every pass marks the bricks where a rule was
// possible; a brick sleeps once nothing was busy in its 3³ neighbourhood for
// one 8-tick offset cycle; when a read of the counts says no brick is awake
// and nothing has written since, the box is certified idle and frame()
// records nothing at all (asleep), until a write.

// Ticks a frame may run at Speed 1×, at most: past them time dilates rather than the frame stretching
// (docs/v2.md 5.1: Minecraft's lag).
const CATCH_UP = 2;

// The 8 partition offsets of the block pass, in a fresh order for each cycle of 8 ticks (lean-sim's
// shuffle), from the cycle's number: every lower neighbour is reachable within a cycle (5.3).
function hash(a, b) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function offsetOf(tick) {
  const cyc = Math.floor(tick / 8), perm = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let a = 7; a > 0; a--) { const b = Math.floor(hash(cyc, a) * (a + 1)); [perm[a], perm[b]] = [perm[b], perm[a]]; }
  const o = perm[tick % 8];
  return [o & 1, (o >> 1) & 1, (o >> 2) & 1];
}

// The element rows' buffer: one per device.
function tableOf(gpu) {
  if (!gpu._v2Table) {
    const t = v2Table();
    gpu._v2Table = gpu.createBuffer({ label: 'v2 elements', size: Math.ceil(t.byteLength / 16) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    gpu.queue.writeBuffer(gpu._v2Table, 0, t);
  }
  return gpu._v2Table;
}

export class PhysicsV2 {
  /** @param {import('../sim.js').Simulation} sim */
  constructor(sim) {
    const gpu = (this.gpu = sim.gpu), g = (this.g = sim.g);
    this.sim = sim;
    sim.compact = this;
    this.legacyPending = true;
    this.layout = v2ActLayout(g);
    this.tick = 0;          // ticks run (they're numbered from 1)
    this.acc = 0;           // the accumulator's fraction of a tick
    this.epoch = 0;         // bumped by every write: an idle read from before one can't certify
    this.certified = false; // no brick awake and nothing written since: frame() records nothing
    this.idleRead = null;
    this.stats = null;      // the last read of the stats (STATS)
    this.importFull = true; // the next tick imports every brick (a new state: a load, an undo, the flag turned on)
    this.importMarked = false;   // ...the bricks today's writers marked
    this.writtenSinceTick = true;
    this.seenVersion = sim.version;
    this.seenWhole = sim.wholeWrites ?? 0;
    this.disposed = false;
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
    const buf = (label, size, usage = S | CS | CD) => gpu.createBuffer({ label: `sim${sim.id} v2 ${label}`, size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    this.cells = buf('cells', g.slots * 16);
    this.act = buf('activity', this.layout.words * 4);
    this.args = buf('args', ARGS2.words * 4, S | CS | CD | GPUBufferUsage.INDIRECT);
    // every brick starts asleep (its quiet run full): only what the first import changes wakes, so a
    // settled box certifies idle after one tick instead of a whole offset cycle of every brick awake
    gpu.queue.writeBuffer(this.act, this.layout.quiet * 4, new Uint32Array(g.nbricks).fill(QUIET_TICKS));
    const L = {
      V2: gpu.layout('V2', V2_LAYOUT), ARGS: gpu.layout('V2_ARGS', V2_ARGS_LAYOUT), STATE: gpu.layout('V2_STATE', V2_STATE_LAYOUT),
      INVALIDATE: gpu.layout('V2_INVALIDATE', V2_INVALIDATE_LAYOUT),
    };
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    const own = [b(0, this.cells), b(1, this.act), b(2, tableOf(gpu))];
    this.groups = {
      read: gpu.bindGroup(sim.L.STATE_RO, [b(0, this.cells), b(1, sim.state.B)], 'compact readers'),
      invalidate: gpu.bindGroup(L.INVALIDATE, [b(3, sim.marks)], 'compact invalidation'),
      v2: gpu.bindGroup(L.V2, own, 'v2'),
      args: gpu.bindGroup(L.ARGS, [...own, b(3, this.args)], 'v2 args'),
      state: gpu.bindGroup(L.STATE, [b(0, sim.state.A), b(1, sim.state.B), b(2, sim.state.F), b(3, sim.marks)], 'v2 state'),
    };
    this.kernels = {};
    for (const k of V2_KERNELS) {
      const withState = k.name === 'v2import' || k.name === 'v2bridge';
      this.kernels[k.name] = gpu.kernel({
        name: k.name, code: k.code(g), params: V2Params, workgroupSize: k.workgroupSize ?? [64, 1, 1],
        layouts: [sim.L.TABLES, withState ? L.STATE : k.name === 'v2invalidate' ? L.INVALIDATE : gpu.L.EMPTY, k.name === 'v2args' ? L.ARGS : L.V2],
      });
    }
    this.ready = Promise.all(Object.values(this.kernels).map((k) => k.ready)).then(() => this);
    this.isReady = false;
    this.ready.then(() => {
      if (this.disposed) return;
      this.isReady = true;
      sim.version++;
      sim.changedAll = true;
    }, () => {});
  }

  // ---- writes and rest ----

  /** Something wrote: the box may move again. */
  wake() {
    this.epoch++;
    this.certified = false;
  }

  /** Re-import everything from today's state on the next tick (today's physics ran meanwhile). */
  resync() {
    this.importFull = true;
    this.seenVersion = this.sim.version;
    this.seenWhole = this.sim.wholeWrites ?? 0;
    this.wake();
  }

  // Writes to today's state since the last look: an edit (the brush, a stamp, a tool) marks its bricks
  // and bumps the version; a whole-grid write (a load, an undo) bumps wholeWrites too.
  _noteWrites() {
    const sim = this.sim;
    if ((sim.wholeWrites ?? 0) !== this.seenWhole) { this.seenWhole = sim.wholeWrites ?? 0; this.importFull = true; this.writtenSinceTick = true; this.wake(); }
    if (sim.version !== this.seenVersion) { this.seenVersion = sim.version; this.importMarked = true; this.writtenSinceTick = true; this.wake(); }
  }

  /** Nothing has written since the last tick ran (a read of its stats still describes the box). */
  get unwrittenSinceTick() {
    const sim = this.sim;
    return !this.writtenSinceTick && sim.version === this.seenVersion && (sim.wholeWrites ?? 0) === this.seenWhole;
  }

  /** Certified idle with nothing written since: ticking would record nothing. */
  get asleep() {
    const sim = this.sim;
    return this.certified && !this.importFull && !this.importMarked && sim.version === this.seenVersion && (sim.wholeWrites ?? 0) === this.seenWhole;
  }

  // The counts after the ticks recorded so far: certifies idle when no brick is awake and nothing wrote since.
  _readIdle() {
    if (this.idleRead || this.certified || this.disposed) return;
    const epoch = this.epoch;
    this.idleRead = this.gpu.readback.buffer(this.args, ARGS2.STATS * 4, STATS.words * 4).then((bytes) => {
      this.stats = new Uint32Array(bytes);
      if (!this.disposed && epoch === this.epoch && this.stats[STATS.AWAKE] === 0) this.certified = true;
    }).catch(() => {}).finally(() => { this.idleRead = null; });
  }

  // ---- the tick ----

  // The tick's params: its number, which busy words it reads (the last tick's) and writes, its offset.
  _params(t) {
    const A = this.layout;
    return { tick: t, busyIn: t & 1 ? A.busy0 : A.busy1, busyOut: t & 1 ? A.busy1 : A.busy0, full: 0, offset: offsetOf(t) };
  }

  // Records the import of what today's writers changed, if anything is pending (params: the next tick's).
  _import(params) {
    if (!this.importFull && !this.importMarked) return;
    const { gpu, sim } = this;
    this.kernels.v2import.dispatch(gpu.frame, fold(this.g.nbricks), {
      bind: [sim.tables, this.groups.state, this.groups.v2], header: sim.header(), params: { ...params, full: this.importFull ? 1 : 0 },
    });
    sim.onPass?.('v2import', { kind: 'compute', gpuMs: null });
    this.legacyPending = true;
    this.importFull = this.importMarked = false;
  }

  /** Imports what today's writers changed now, without a tick (tools read v2's cells right after a write). */
  sync() {
    if (!this.isReady || this.disposed) return;
    this._noteWrites();
    this._import(this._params(this.tick + 1));
  }

  /** Export only at a legacy boundary, before recording its commands. Use only
   * the legacy header and private groups: readHeader/bindRW would recurse. */
  exportLegacy() {
    if (!this.isReady || this.disposed) return;
    this.sync();
    if (!this.legacyPending) return;
    const { sim, gpu } = this;
    this.kernels.v2bridge.dispatch(gpu.frame, fold(this.g.nbricks), {
      bind: [sim.tables, this.groups.state, this.groups.v2], header: sim.header(), params: this._params(this.tick + 1),
    });
    sim.onPass?.('v2bridge', { kind: 'compute', gpuMs: null });
    this.legacyPending = false;
  }

  activate() {
    if (this.sim.compact === this) return;
    this.sim.compact = this;
    this.resync();
    this.sim.changedAll = true;
    this.sim.version++;
  }

  suspend() {
    if (this.sim.compact !== this) return;
    if (!this.gpu.failure) this.exportLegacy();
    this.sim.compact = null;
    this.sim.noteWrite();
  }

  // Undo restores every compact word, including fill, face flux and fall state.
  restore(snapshot) {
    const { sim, gpu, g } = this;
    gpu.frame.copy(snapshot, 0, this.cells, 0, g.slots * 16);
    gpu.frame.clear(this.act);
    gpu.write(this.act, this.layout.busy0 * 4, new Uint32Array(g.nbricks).fill(1));
    gpu.write(this.act, this.layout.busy1 * 4, new Uint32Array(g.nbricks).fill(1));
    gpu.write(this.act, this.layout.legacy * 4, new Uint32Array(g.nbricks).fill(1));
    this.importFull = this.importMarked = false;
    this.seenVersion = sim.version;
    this.seenWhole = sim.wholeWrites;
    this.legacyPending = this.writtenSinceTick = true;
    this.wake();
  }

  /** Records one tick (docs/v2.md 5.4) into the open frame. */
  _tick() {
    this._noteWrites();
    const { gpu, sim, kernels: k, groups } = this;
    const f = gpu.frame;
    const params = this._params(++this.tick);
    this.writtenSinceTick = false;
    const header = sim.header();
    const own = [sim.tables, gpu.emptyGroup, groups.v2];
    const invalidation = [sim.tables, groups.invalidate, groups.v2];
    const run = (kernel, size, bind = own, p = params) => {
      kernel.dispatch(f, size, { bind, header, params: p });
      sim.onPass?.(kernel.name, { kind: 'compute', gpuMs: null });
    };
    const ind = (at) => ({ indirect: this.args, offset: at * 4 });
    this._import(params);
    run(k.v2activity, fold(Math.ceil(this.g.nbricks / 64)));
    run(k.v2cols, fold(Math.ceil((this.g.bx * this.g.bz) / 64)));
    run(k.v2args, [1, 1, 1], [sim.tables, gpu.emptyGroup, groups.args]);
    run(k.v2column, ind(ARGS2.COLS));
    run(k.v2support, ind(ARGS2.BRICKS));
    run(k.v2block, ind(ARGS2.BLOCKS));
    for (let s = 0; s < SUB; s++) {
      run(k.v2flux, ind(ARGS2.BRICKS));
      run(k.v2limit, ind(ARGS2.BRICKS));
      run(k.v2gather, ind(ARGS2.BRICKS));
    }
    run(k.v2invalidate, fold(Math.ceil(this.g.nbricks / 64)), invalidation);
    this.legacyPending = true;
    // A test-only same-physics baseline for full-frame direct/compat comparisons.
    if (this.forceCompatibility && gpu.testMode) this.exportLegacy();
  }

  /**
   * Runs n ticks now (tools, the frame-step key, __app.test.step), whatever the accumulator says.
   * @returns {number} the ticks recorded
   */
  ticks(n) {
    if (!this.isReady || this.disposed) return 0;
    this.activate();
    this._noteWrites();
    for (let i = 0; i < n; i++) this._tick();
    if (n > 0) this._ran();
    return n;
  }

  // After ticks the authoritative state changed: advance the derived key, then read idle.
  _ran() {
    this.sim.version++;
    this.seenVersion = this.sim.version;
    this._readIdle();
  }

  /**
   * The app's frame: the fixed 60 Hz tick on an accumulator of game time (docs/v2.md 5.1), at most
   * CATCH_UP ticks a frame at 1× (past them the world slows down), none while certified idle.
   * @param {number} dt seconds since the last frame
   * @param {{ speed?: number, once?: boolean, each?: () => void }} [opts] speed: ticks a second over 60
   *   (the Speed setting); once: at least one tick (a single step); each: called before each tick
   * @returns {number} the ticks recorded
   */
  frame(dt, { speed = 1, once = false, each = null } = {}) {
    if (!this.isReady || this.disposed) return 0;
    this.activate();
    this._noteWrites();
    if (this.asleep) { this.acc = 0; return 0; }
    this.acc += Math.max(0, dt) * TICK_HZ * speed;
    let n = Math.floor(this.acc);
    const max = Math.max(1, Math.ceil(CATCH_UP * speed));
    if (n > max) { n = max; this.acc = 0; } else this.acc -= n;
    if (once) n = Math.max(n, 1);
    for (let i = 0; i < n; i++) { each?.(); this._tick(); }
    if (n > 0) this._ran();
    return n;
  }

  // ---- reads (tools) ----

  /** The stats as they are at this call: { tick, awake, busy, quiet, lastBusy, cols, units }. */
  async readStats() {
    const s = new Uint32Array(await this.gpu.readback.buffer(this.args, ARGS2.STATS * 4, STATS.words * 4));
    return { tick: s[STATS.TICK], awake: s[STATS.AWAKE], busy: s[STATS.BUSY], quiet: s[STATS.QUIET], lastBusy: s[STATS.LAST_BUSY], cols: s[STATS.COLS], units: this.g.nbricks };
  }

  /**
   * The cells as they are at this call, per cell at x + nx·(z + nz·y): { id, cls, fill (cells of liquid:
   * fill / 2¹⁶), T (°C), age }.
   */
  async readCells() {
    this.sync();
    const g = this.g, words = new Uint32Array(await this.gpu.readback.buffer(this.cells, 0, g.slots * 16));
    const n = g.nx * g.ny * g.nz, rows = v2Rows();
    const out = { id: new Int32Array(n), cls: new Uint8Array(n), fill: new Float32Array(n), T: new Float32Array(n), age: new Uint8Array(n) };
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const i = x + g.nx * (z + g.nz * y), w = cellSlot(g, x, y, z) * 4;
      const id = words[w] & 255, cls = rows[id]?.cls ?? V2.SOLID;
      out.id[i] = id;
      out.cls[i] = cls;
      out.T[i] = ((words[w] >>> 8) & 0xffff) * 0.25 - 273.25;
      out.age[i] = words[w] >>> 24;
      if (cls === V2.LIQUID) out.fill[i] = (words[w + 1] & 0xffffff) / FULL;
    }
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
    this.wake();
    if (!this.gpu.failure) this.gpu.flush('v2 dispose');
    for (const b of [this.cells, this.act, this.args]) b.destroy();
  }
}
