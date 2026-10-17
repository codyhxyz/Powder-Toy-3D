import { contactWGSL as productionContactWGSL } from '../shaders/v2/contact.js';
import { nativeModes, modeSignature } from './modes.js';
import { fold } from '../gpu/kernels.js';
import { fallVelocity } from './fall.js';
import { cTq } from './layout.js';
import { encodeV2State, decodeV2State } from './state.js';
import { cellSlot, marksLayout } from '../shaders/common.js';
import {
  v2BlockCompactLayout, v2BlockClassifyWGSL, v2BlockFinalizeWGSL, v2BlockWGSL, V2_BLOCK_FINALIZE_LAYOUT,
  V2_KERNELS, V2Params, nativeDynamicsHead, v2DemandWords, V2_DYNAMICS_LAYOUT, V2_LAYOUT, V2_ARGS_LAYOUT, V2_STATE_LAYOUT, V2_MATERIAL_LAYOUT, V2_LIQUID_LAYOUT, V2_CONTACT_LAYOUT, V2_IMPORT_LAYOUT, V2_INVALIDATE_LAYOUT, v2ActLayout, v2Table, v2Rows, ARGS2, STATS,
  TICK_HZ, FULL, V2, QUIET_TICKS,
} from '../shaders/v2.js';
import { pairOrder } from '../shaders/v2/columns.js';

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
  constructor(sim, { contactWGSL = '', Dynamics = null } = {}) {
    const gpu = (this.gpu = sim.gpu), g = (this.g = sim.g);
    const compactLayout = contactWGSL === productionContactWGSL ? v2BlockCompactLayout(g) : null;
    const scratchLimit = Math.min(gpu.device?.limits?.maxStorageBufferBindingSize ?? Infinity,
      gpu.device?.limits?.maxBufferSize ?? Infinity);
    // This optimization must not reject a grid whose original scratch fits.
    this.blockCompact = compactLayout && compactLayout.bytes <= scratchLimit ? compactLayout : null;
    this.sim = sim;
    this.modeSettings = nativeModes(sim);
    this.settingsSignature = modeSignature(this.modeSettings);
    sim.compact = sim.compactOwner = this;
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
    this.aux = buf('energy banks', g.slots * 4);
    this.liquidScratch = buf('liquid snapshots', this.blockCompact?.bytes ?? g.slots * 16);
    this.events = buf('material requests', g.slots * 4);
    this.jetMask = buf('liquid face demands', v2DemandWords(g) * 4);
    // Explicit injection seams. These modules do not exist in the foundation alone.
    this.contactReady = false;
    this.dynamics = null;
    this.act = buf('activity', this.layout.allocated * 4);
    this.args = buf('args', ARGS2.allocated * 4, S | CS | CD | GPUBufferUsage.INDIRECT);
    // every brick starts asleep (its quiet run full): only what the first import changes wakes, so a
    // settled box certifies idle after one tick instead of a whole offset cycle of every brick awake
    gpu.queue.writeBuffer(this.act, this.layout.quiet * 4, new Uint32Array(g.nbricks).fill(QUIET_TICKS));
    // nothing derived from the cells is cached yet (the air source's faces), no air has settled
    gpu.queue.writeBuffer(this.act, this.layout.state * 4, new Uint32Array(g.nbricks).fill(1));
    gpu.queue.writeBuffer(this.act, this.layout.air * 4, new Uint32Array(g.nbricks).fill(1));
    const L = {
      V2: gpu.layout('V2', V2_LAYOUT), ARGS: gpu.layout('V2_ARGS', V2_ARGS_LAYOUT), STATE: gpu.layout('V2_STATE', V2_STATE_LAYOUT),
      INVALIDATE: gpu.layout('V2_INVALIDATE', V2_INVALIDATE_LAYOUT),
      MATERIAL: gpu.layout('V2_MATERIAL', V2_MATERIAL_LAYOUT), LIQUID: gpu.layout('V2_LIQUID', V2_LIQUID_LAYOUT),
      CONTACT: gpu.layout('V2_CONTACT', V2_CONTACT_LAYOUT), IMPORT: gpu.layout('V2_IMPORT', V2_IMPORT_LAYOUT),
    };
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    const own = [b(0, this.cells), b(1, this.act), b(2, tableOf(gpu))];
    this.groups = {
      invalidate: gpu.bindGroup(L.INVALIDATE, [b(3, sim.marks)], 'compact invalidation'),
      v2: gpu.bindGroup(L.V2, own, 'v2'),
      material: gpu.bindGroup(L.MATERIAL, [...own, b(4, this.aux)], 'v2 material'),
      liquid: gpu.bindGroup(L.LIQUID, [...own, b(4, this.aux), b(5, this.liquidScratch), b(6, this.events), b(7, this.jetMask)], 'v2 liquid'),
      contact: gpu.bindGroup(L.CONTACT, [...own, b(4, this.aux), b(5, this.liquidScratch), b(6, this.events)], 'v2 contact'),
      args: gpu.bindGroup(L.ARGS, [...own, b(3, this.args)], 'v2 args'),
    };
    L.BLOCK_FINALIZE = gpu.layout('V2_BLOCK_FINALIZE', V2_BLOCK_FINALIZE_LAYOUT);
    this.legacyLayouts = { read: sim.L.STATE_RO, import: L.IMPORT, state: L.STATE };
    this.bindLegacy();
    // Only the current legacy copy is ours to use: a box lets V1's other go
    // while it's owned (Simulation.pingPong: it binds the groups above again).
    sim.pingPong?.(false);
    if (this.blockCompact) {
      this.groups.blockFinalize = gpu.bindGroup(L.BLOCK_FINALIZE, [b(0, this.liquidScratch), b(1, this.args)], 'v2 compact block args');
    }
    this.nativeDynamics = { head: nativeDynamicsHead, layout: gpu.layout('V2_DYNAMICS', V2_DYNAMICS_LAYOUT) };
    this.nativeDynamics.group = gpu.bindGroup(this.nativeDynamics.layout, [b(0, this.cells), b(1, this.aux), b(2, this.act)], 'native dynamics state');
    this.familyOf = name => ({ v2args: 'args', v2actArgs: 'args', v2import: 'material', v2column: 'contact', v2boundary: 'contact', v2externalEvents: 'contact', v2support: 'contact', v2blockClassify: 'contact', v2blockFinalize: 'blockFinalize', v2block: 'contact', v2runs: 'liquid', v2pairs: 'liquid' }[name] ?? 'v2');
    const familyLayouts = { v2: L.V2, args: L.ARGS, material: L.MATERIAL, liquid: L.LIQUID, contact: L.CONTACT };
    this.kernels = {};
    const specs = this.blockCompact ? [...V2_KERNELS,
      { name: 'v2blockClassify', code: v2BlockClassifyWGSL },
      { name: 'v2blockFinalize', code: v2BlockFinalizeWGSL, workgroupSize: [1, 1, 1] },
    ] : V2_KERNELS;
    for (const k of specs) {
      const withState = k.name === 'v2import' || k.name === 'v2bridge';
      const finalize = k.name === 'v2blockFinalize';
      // Contact is required and the long compile pole. Enqueue it before
      // graphics, not behind the idle queue; the shared two-build bound remains.
      this.kernels[k.name] = gpu.kernel({
        name: k.name, build: k.name === 'v2block' ? 'now' : 'idle', code: k.name === 'v2block' ? v2BlockWGSL(g, contactWGSL, !!this.blockCompact) : k.code(g), params: V2Params, workgroupSize: k.workgroupSize ?? [64, 1, 1],
        layouts: [finalize ? gpu.L.EMPTY : sim.L.TABLES, k.name === 'v2import' ? L.IMPORT : withState ? L.STATE : (k.name === 'v2invalidate' || k.name === 'v2externalEvents') ? L.INVALIDATE : gpu.L.EMPTY, finalize ? L.BLOCK_FINALIZE : familyLayouts[this.familyOf(k.name)]],
      });
    }
    this.dynamics = Dynamics ? new Dynamics(this) : null;
    // Publish native readiness only after legacy storage has its blank defaults.
    this.ready = Promise.all([sim.ready, ...Object.values(this.kernels).map((k) => k.ready), this.dynamics?.ready]).then(() => this);
    this.isReady = false;
    this.ready.then(() => {
      if (this.disposed) return;
      this.isReady = true;
      this.contactReady = !!contactWGSL;
      sim.version++;
      sim.changedAll = true;
    }, () => {});
  }

  // The groups holding the simulation's legacy state: the import of today's
  // writers, the boundary bridge and the readers' B. Made again whenever the
  // simulation makes those buffers again (Simulation.pingPong).
  bindLegacy() {
    const { gpu, sim, legacyLayouts: L } = this, { A, B, F } = sim.state;
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this.groups.read = gpu.bindGroup(L.read, [b(0, this.cells), b(1, B)], 'compact readers');
    this.groups.import = gpu.bindGroup(L.import, [b(0, A), b(1, B), b(3, sim.marks)], 'v2 import');
    this.groups.state = gpu.bindGroup(L.state, [b(0, A), b(1, B), b(2, F), b(3, sim.marks)], 'v2 state');
  }

  // ---- writes and rest ----

  /**
   * Notes every brick's cells as changed and its air as live (and, with events, as maybe holding
   * a material request), so what is derived from them is read again (the air source's faces,
   * vacuum, census and brick lists). For writes that bypass noteState/noteEvents/noteAir:
   * restores, window scatters, mode changes (the air's masks), dynamics restores.
   */
  noteAllCells({ events = false } = {}) {
    const ones = new Uint32Array(this.g.nbricks).fill(1);
    this.gpu.write(this.act, this.layout.state * 4, ones);
    this.gpu.write(this.act, this.layout.air * 4, ones);
    if (events) this.gpu.write(this.act, this.layout.events * 4, ones);
  }

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
  _noteModes() {
    const settings = nativeModes(this.sim), signature = modeSignature(settings);
    if (signature === this.settingsSignature) return;
    this.modeSettings = settings; this.settingsSignature = signature;
    // Wake only the activity state. No legacy import, fractional core or bank
    // rewrite; general brush wake() deliberately does NOT perform this sweep.
    const busy = new Uint32Array(this.g.nbricks).fill(1);
    this.gpu.write(this.act, this.layout.busy0 * 4, busy);
    this.gpu.write(this.act, this.layout.busy1 * 4, busy);
    this.noteAllCells(); // edge and ambient enter the air source's faces and buoyancy
    this.writtenSinceTick = true;
    this.dynamics?._work();
    this.wake();
  }

  _noteWrites() {
    this._noteModes();
    const sim = this.sim;
    if ((sim.wholeWrites ?? 0) !== this.seenWhole) { this.seenWhole = sim.wholeWrites ?? 0; this.importFull = true; this.writtenSinceTick = true; this.wake(); }
    if (sim.version !== this.seenVersion) { this.seenVersion = sim.version; this.importMarked = true; this.writtenSinceTick = true; this.wake(); }
  }

  /** Nothing has written since the last tick ran (a read of its stats still describes the box). */
  get unwrittenSinceTick() {
    const sim = this.sim;
    return this.settingsSignature === modeSignature(nativeModes(sim)) && !this.writtenSinceTick && sim.version === this.seenVersion && (sim.wholeWrites ?? 0) === this.seenWhole;
  }

  /** Certified idle with nothing written since: ticking would record nothing. */
  get asleep() {
    const sim = this.sim;
    return this.settingsSignature === modeSignature(nativeModes(sim)) && this.certified && (!this.dynamics || this.dynamics.isIdle === true) && !this.importFull && !this.importMarked && sim.version === this.seenVersion && (sim.wholeWrites ?? 0) === this.seenWhole;
  }

  // The counts after the ticks recorded so far: certifies idle when no brick is awake and nothing wrote since.
  _readIdle() {
    if (this.idleRead || this.certified || this.disposed) return;
    const epoch = this.epoch;
    this.idleRead = Promise.all([
      this.gpu.readback.buffer(this.args, ARGS2.STATS * 4, STATS.words * 4),
      this.dynamics?.readActivity(),
    ]).then(([bytes]) => {
      this.stats = new Uint32Array(bytes);
      if (!this.disposed && epoch === this.epoch && this.stats[STATS.AWAKE] === 0 && (!this.dynamics || this.dynamics.isIdle === true)) this.certified = true;
    }).catch(() => {}).finally(() => { this.idleRead = null; });
  }

  // ---- the tick ----

  // The tick's params: its number, which busy words it reads (the last tick's) and writes, its offset.
  _params(t) {
    const A = this.layout;
    return { ...nativeModes(this.sim), tick: t, busyIn: t & 1 ? A.busy0 : A.busy1, busyOut: t & 1 ? A.busy1 : A.busy0, full: 0, offset: offsetOf(t), preserveLegacyMarks: this.sim.compact === this ? 0 : 1 };
  }

  // Records the import of what today's writers changed, if anything is pending (params: the next tick's).
  _import(params) {
    if (!this.importFull && !this.importMarked) return;
    const { gpu, sim } = this;
    this.kernels.v2externalEvents.dispatch(gpu.frame, fold(this.g.nbricks), {
      bind: [sim.tables, this.groups.invalidate, this.groups.contact], header: { ...sim.header(), capture: 0 }, params: { ...params, full: this.importFull ? 1 : 0 },
    });
    sim.onPass?.('v2externalEvents', { kind: 'compute', gpuMs: null });
    this.kernels.v2import.dispatch(gpu.frame, fold(this.g.nbricks), {
      bind: [sim.tables, this.groups.import, this.groups.material], header: { ...sim.header(), capture: this.legacyNative ? 2 : 0 }, params: { ...params, full: this.importFull ? 1 : 0 },
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
  exportLegacy(native = this.sim.compact === this) {
    if (!this.isReady || this.disposed) return;
    this.sync();
    const modeChanged = this.legacyNative !== native;
    if (!this.legacyPending && !modeChanged) return;
    const { sim, gpu } = this;
    this.kernels.v2bridge.dispatch(gpu.frame, fold(this.g.nbricks), {
      bind: [sim.tables, this.groups.state, this.groups.v2], header: { ...sim.header(), capture: 0, format: native ? 3 : 0 }, params: { ...this._params(this.tick + 1), full: modeChanged ? 1 : 0 },
    });
    sim.onPass?.('v2bridge', { kind: 'compute', gpuMs: null });
    this.legacyPending = false;
    this.legacyNative = native;
  }

  activate() {
    if (this.sim.compact === this) return;
    this.sim.compact = this;
    this.sim.pingPong?.(false);
    this.sync();
    this.sim.changedAll = true;
    this.sim.version++;
    this.seenVersion = this.sim.version;
  }

  suspend() {
    if (this.sim.compact !== this) return;
    if (!this.gpu.failure) this.exportLegacy(false);
    this.sim.compact = null;
    // A presentation switch is not a state replacement. The retained owner
    // imports only sticky per-cell legacy writes, even after v1 activity consumes its marks.
    this.sim.noteWrite(false);
    this.seenVersion = this.sim.version;
  }

  // Undo restores every compact word, including fill, face flux and fall state.
  restore(snapshot, aux = null) {
    const { sim, gpu, g } = this;
    if (aux && !this.aux) throw new Error('v2 state: auxiliary owner is unavailable');
    if (this.aux) {
      if (aux) gpu.frame.copy(aux, 0, this.aux, 0, g.slots * 4);
      else gpu.frame.clear(this.aux);
    }
    gpu.frame.copy(snapshot, 0, this.cells, 0, g.slots * 16);
    gpu.frame.clear(this.liquidScratch);
    gpu.frame.clear(this.jetMask);
    gpu.frame.clear(this.events);
    gpu.frame.clear(this.act);
    const m = marksLayout(g);
    gpu.frame.clear(sim.marks, m.owned * 4, Math.ceil(g.slots / 32) * 4);
    gpu.write(this.act, this.layout.busy0 * 4, new Uint32Array(g.nbricks).fill(1));
    gpu.write(this.act, this.layout.busy1 * 4, new Uint32Array(g.nbricks).fill(1));
    gpu.write(this.act, this.layout.legacy * 4, new Uint32Array(g.nbricks).fill(1));
    this.noteAllCells(); // the copy above bypassed noteState; the requests are clear
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
    const run = (kernel, size, bind = [sim.tables, gpu.emptyGroup, groups[this.familyOf(kernel.name)]], p = params) => {
      kernel.dispatch(f, size, { bind, header, params: p });
      sim.onPass?.(kernel.name, { kind: 'compute', gpuMs: null });
    };
    const ind = (at) => ({ indirect: this.args, offset: at * 4 });
    this._import(params);
    // activity over the bricks near a busy one or still counting their quiet run (v2ActScanWGSL)
    run(k.v2actScan, fold(Math.ceil(this.g.nbricks / 64)));
    run(k.v2actArgs, [1, 1, 1], [sim.tables, gpu.emptyGroup, groups.args]);
    run(k.v2activity, ind(ARGS2.ACT));
    run(k.v2cols, fold(Math.ceil((this.g.bx * this.g.bz) / 64)));
    run(k.v2args, [1, 1, 1], [sim.tables, gpu.emptyGroup, groups.args]);
    this.dynamics?.advanceParticles(this.tick);
    run(k.v2column, ind(ARGS2.COLS));
    run(k.v2support, ind(ARGS2.BRICKS));
    if (this.blockCompact) {
      // Support above MUST cover every original target before the identity scan.
      // Clear only the tail header, not the frozen cell-indexed atmosphere.
      f.clear(this.liquidScratch, this.blockCompact.header, 16);
      run(k.v2blockClassify, ind(ARGS2.BLOCKS));
      run(k.v2blockFinalize, [1, 1, 1], [gpu.emptyGroup, gpu.emptyGroup, groups.blockFinalize]);
      run(k.v2block, ind(ARGS2.COMPACT));
    } else run(k.v2block, ind(ARGS2.BLOCKS));
    this.dynamics?.consumeMaterialEvents(this.tick);
    // R13 as column runs (src/shaders/v2/columns.js), a thread an awake column: settle the runs, then
    // every face's flux and the four colours of transfers, one step a tick.
    run(k.v2runs, ind(ARGS2.COLS));
    for (const [pairAxis, pairStage, pairParity] of pairOrder(this.tick)) run(k.v2pairs, ind(ARGS2.COLS), undefined, { ...params, pairAxis, pairStage, pairParity });
    if (params.edge === 1) run(k.v2boundary, ind(ARGS2.BRICKS));
    this.dynamics?.advanceAir(this.tick);
    run(k.v2invalidate, fold(Math.ceil(this.g.nbricks / 64)), invalidation);
    this.legacyPending = true;
    // A test-only same-physics baseline for full-frame direct/compat comparisons.
    if (this.forceCompatibility && gpu.testMode) this.exportLegacy(false);
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

  // Every read is recorded before the first await, alongside saves/game's legacy read.
  // A suspended engine still owns untouched compact cells; sync consumes actual v1 writes.
  async captureState(mode = this.sim.compact === this ? 'v2' : 'v1') {
    if (!this.isReady || this.disposed) throw new Error('v2 state: engine is not ready');
    this.sync();
    const { gpu, sim, g } = this;
    const meta = { dims: [g.nx, g.ny, g.nz], mode, tick: this.tick, acc: this.acc,
      frame: sim.frame, paints: sim.paints, certified: this.certified, writtenSinceTick: this.writtenSinceTick };
    const reads = [this.cells, this.act, this.args, ...(this.aux ? [this.aux] : [])].map(b => gpu.readback.buffer(b, 0, b.size));
    const [cells, activity, args, aux] = (await Promise.all(reads)).map(b => new Uint32Array(b));
    // GPU buffers may have alignment padding; the format owns only the logical words.
    return encodeV2State({ ...meta, cells: cells.subarray(0, g.slots * 4),
      activity: activity.subarray(0, this.layout.words), args: args.subarray(0, ARGS2.words),
      ...(aux ? { aux: aux.subarray(0, g.slots) } : {}) });
  }

  restoreState(bytes, { legacyCurrent = false } = {}) {
    if (!this.isReady || this.disposed) throw new Error('v2 state: engine is not ready');
    const { sim, gpu, g } = this;
    const state = decodeV2State(bytes, [g.nx, g.ny, g.nz]);
    if (!this.aux && state.aux.some(word => word !== 0)) throw new Error('v2 state: auxiliary owner is unavailable');
    if (this.aux) gpu.write(this.aux, 0, state.aux);
    gpu.write(this.cells, 0, state.cells);
    gpu.frame.clear(this.liquidScratch);
    gpu.frame.clear(this.jetMask);
    gpu.frame.clear(this.events);
    gpu.write(this.act, 0, state.activity);
    gpu.write(this.args, 0, state.args);
    // Legacy A/B loaded by saves/game is only a projection of these words.
    // Dirtiness is cache metadata, not physics state; rebuild that projection on demand.
    gpu.write(this.act, this.layout.legacy * 4, new Uint32Array(g.nbricks).fill(legacyCurrent ? 0 : 1));
    // The cells above bypassed noteState; the requests are clear until a dynamics restore.
    this.noteAllCells();
    const m = marksLayout(g);
    gpu.frame.clear(sim.marks, m.owned * 4, Math.ceil(g.slots / 32) * 4);
    this.tick = state.tick;
    this.acc = state.acc;
    sim.frame = state.frame;
    sim.paints = state.paints;
    this.wake(); // invalidates any outstanding idle read from the previous scene
    this.certified = state.certified;
    this.writtenSinceTick = state.writtenSinceTick;
    this.stats = null;
    this.importFull = this.importMarked = false;
    this.seenVersion = sim.version;
    this.seenWhole = sim.wholeWrites;
    this.legacyPending = !legacyCurrent;
    if (legacyCurrent) this.legacyNative = false; // Saves contain the visual/v1 cache, not edit projection.
    sim.changedAll = true;
  }

  // ---- reads (tools) ----

  /** The stats as they are at this call: { tick, awake, busy, quiet, lastBusy, cols, units }. */
  async readStats() {
    const s = new Uint32Array(await this.gpu.readback.buffer(this.args, ARGS2.STATS * 4, STATS.words * 4));
    return { tick: s[STATS.TICK], awake: s[STATS.AWAKE], busy: s[STATS.BUSY], quiet: s[STATS.QUIET], lastBusy: s[STATS.LAST_BUSY], cols: s[STATS.COLS], units: this.g.nbricks };
  }

  /**
   * The cells as they are at this call, per cell at x + nx·(z + nz·y): { id, cls, fill (cells of liquid:
   * fill / 2¹⁶), T (°C), age (gas/foam), fallVelocity (downward m/s) }.
   */
  async readCells() {
    this.sync();
    const g = this.g, words = new Uint32Array(await this.gpu.readback.buffer(this.cells, 0, g.slots * 16));
    const n = g.nx * g.ny * g.nz, rows = v2Rows();
    const out = { id: new Int32Array(n), cls: new Uint8Array(n), fill: new Float32Array(n), T: new Float32Array(n), age: new Uint8Array(n), fallVelocity: new Float32Array(n) };
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const i = x + g.nx * (z + g.nz * y), w = cellSlot(g, x, y, z) * 4;
      const id = words[w] & 255, cls = rows[id]?.cls ?? V2.SOLID;
      out.id[i] = id;
      out.cls[i] = cls;
      out.T[i] = cTq(words.subarray(w, w + 4)) * 0.25 - 273.25;
      out.age[i] = cls === V2.POWDER ? 0 : words[w] >>> 24;
      out.fallVelocity[i] = fallVelocity(words.subarray(w, w + 4));
      if (cls === V2.LIQUID) out.fill[i] = (words[w + 1] & 0xffffff) / FULL;
    }
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
    if (this.sim.compactOwner === this) this.sim.compactOwner = null;
    this.wake();
    if (!this.gpu.failure) this.gpu.flush('v2 dispose');
    this.dynamics?.dispose();
    for (const b of [this.cells, this.aux, this.liquidScratch, this.jetMask, this.events, this.act, this.args]) b.destroy();
  }
}
