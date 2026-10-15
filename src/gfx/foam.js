// Whitewater's aeration field (shaders/gfx/liquidDetail.js aerationFrag): a
// record per slot, two copies in one buffer (vec2u: f16 pairs; copy c of slot
// s at c·SLOTS + s), that the simulation advances once per step right after
// its move (Simulation.step calls aeration.step), so foam is carried by the
// liquid, bursts and rises on the sim's clock. It is render state only: the
// simulation never reads it (the volume and the field passes do).
//
// It runs only while the Whitewater switch is on (gfx/detail.js liquidFoam):
// off, it is detached and a step costs nothing extra. Its buffers are kept,
// and switching it back on resumes them if the world hasn't changed
// meanwhile (else it starts clear). Anything that replaces the state (loads,
// undo) clears it (Simulation.stillFlow); a window shift moves it with the
// cells (onShift).
//
// It runs over a list of bricks, not every cell (docs/webgpu.md G4): each step
// the list kernel picks the bricks that may hold foaming liquid within a
// brick, or held a record in the last two steps (liquidDetail.js has the
// argument that this is exact), the args kernel sizes the indirect dispatch,
// and the aeration kernel writes the other copy over them. An idle world
// (Simulation.step returns early) keeps stepping it, every cell held in
// place, until no foam is visible (its count, read back every
// FOAM_CHECK_STEPS idle steps) or for AER_IDLE_STEPS at most, then clears
// it: the foam left on still water bursts, then the frame loop may sleep
// (wire/foam.js busy).
import {
  aerationFrag, aerListFrag, aerArgsFrag, AerParams, AerListParams, AER_LAYOUT, AER_LIST_LAYOUT, AER_LIST_STATE, AER_IDLE_STEPS,
} from '../shaders/gfx/liquidDetail.js';
import { stateLayout } from '../shaders/common.js';
import { ARGS } from '../shaders/activity.js';
import { EDGE } from '../simModes.js';
import { fold } from '../gpu/kernels.js';

const RECORD_BYTES = 8;   // vec2u: (aeration, liquid) and (fall, grounded) as f16 pairs
// Steps that list every brick after the field starts over (a reset, a window
// shift, switched on): the foams words and the nz history say nothing then,
// and two steps write both copies everywhere.
const START_STEPS = 2;
// Idle steps between reads of the visible foam's count (the word after the
// nz words): once none is left, the idle steps end there (it clears), so a
// settled world sleeps without waiting out AER_IDLE_STEPS.
const FOAM_CHECK_STEPS = 8;

class Aeration {
  constructor(sim) {
    const gpu = (this.gpu = sim.gpu), g = (this.g = sim.g);
    this.sim = sim;
    this.enabled = true;
    this.cur = 0;              // the copy the last step wrote (the volume reads it: aerCopy)
    this.allSteps = START_STEPS;
    this.idleSteps = AER_IDLE_STEPS + 1;   // idle steps run since the world went idle (nothing to burst yet)
    this.offAt = null;         // sim.version when it was switched off
    this.generation = 0;       // a real step or a reset: a foam count read before it is stale
    // test only (tools/aeration-check.mjs): dropHistory lists a brick by the
    // foams words alone (the negative control: stale copies and wakes left behind)
    this.test = { dropHistory: false };
    this.bytes = g.slots * RECORD_BYTES;   // one copy
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.L = gpu.layout('AERATION', AER_LAYOUT);
    this.listL = gpu.layout('AER_LIST', AER_LIST_LAYOUT);
    this.listStateL = gpu.layout('AER_LIST_STATE', stateLayout(AER_LIST_STATE));
    this.kernels = {
      step: gpu.kernel({ name: 'aeration', code: aerationFrag(g), layouts: [sim.L.TABLES, sim.L.STATE_ACT, this.L], params: AerParams }),
      list: gpu.kernel({ name: 'aerList', code: aerListFrag(g), layouts: [sim.L.TABLES, this.listStateL, this.listL], params: AerListParams }),
      args: gpu.kernel({ name: 'aerArgs', code: aerArgsFrag(g), layouts: [sim.L.TABLES, this.listStateL, this.listL], params: AerListParams }),
    };
    this.ready = Promise.all(Object.values(this.kernels).map((k) => k.ready));
    this.listState = gpu.bindGroup(this.listStateL, [
      { binding: 3, resource: { buffer: sim.marks } }, { binding: 4, resource: { buffer: sim.act } }], 'aer list state');
    // the field (and, for tools/aeration-check.mjs, a reference run over every brick)
    const field = (label) => {
      const f = {
        buffer: gpu.createBuffer({ label, size: 2 * this.bytes, usage: S }),
        // a word per brick, then the visible foam's count
        nz: gpu.createBuffer({ label: `${label} nz`, size: Math.ceil((g.nbricks + 1) / 4) * 16, usage: S }),
        groups: new Map(),   // per moveSrc buffer (sim.moveSrc is remade when a side plane comes or goes)
      };
      f.listGroup = gpu.bindGroup(this.listL, [{ binding: 0, resource: { buffer: sim.args } }, { binding: 1, resource: { buffer: f.nz } }], `${label} list`);
      return f;
    };
    this.field = field('aeration');
    this.reference = null;
    this._field = field;
    this.offShift = sim.onShift((dx, dz, f) => this.shift(dx, dz, f));
  }

  /** Whether the move should run out of place for it this step (sim.js): on, its kernels built. */
  get active() { return this.enabled && Object.values(this.kernels).every((k) => k.state === 'ready'); }
  /** Both copies, as the volume (binding 19) and the field passes read them. */
  get buffer() { return this.field.buffer; }
  /** Whether the frame loop should keep stepping it (wire/foam.js busy): foam left on an idle world bursts. */
  get bursting() { return this.active && this.idleSteps <= AER_IDLE_STEPS; }

  // After the move, before react: `pre` the copy before the move, moveSrc's
  // plane at word moveSrcAt of its buffer (sim.js step).
  step(f, { pre, moveSrc, moveSrcAt }) {
    this.idleSteps = 0;
    this.generation++;
    this._run(f, { still: 0, src: pre, moveSrc, srcAt: moveSrcAt });
  }

  // A step the world skipped (idle): nothing moves, both state copies agree.
  idle(f) {
    if (!this.active || this.idleSteps > AER_IDLE_STEPS) return;
    if (this.idleSteps++ === AER_IDLE_STEPS) { this.reset(f); return; }
    const sim = this.sim;
    this._run(f, { still: 1, src: sim.cur, moveSrc: sim.moveSrc, srcAt: sim.moveSrcAt });
    // the foam still visible after this step: none, and the next idle step clears what's left
    if (this.idleSteps % FOAM_CHECK_STEPS === 1) {
      const gen = this.generation;
      this.gpu.readback.buffer(this.field.nz, this.g.nbricks * 4, 4).then((bytes) => {
        if (gen === this.generation && this.idleSteps < AER_IDLE_STEPS && new Uint32Array(bytes)[0] === 0) this.idleSteps = AER_IDLE_STEPS;
      }, () => {});
    }
  }

  _run(f, { still, src, moveSrc, srcAt }) {
    const sim = this.sim, { step, list, args } = this.kernels;
    const all = this.allSteps > 0;
    if (all) this.allSteps--;
    const lp = { still, all: all ? 1 : 0, hist: this.test.dropHistory ? 0 : 3, wrap: sim.edgeMode === EDGE.LOOP ? 1 : 0 };
    const header = sim.header(src, src);
    const fd = this.field;
    this._dispatch(list, fold(Math.ceil(this.g.nbricks / 64)), { bind: [sim.tables, this.listState, fd.listGroup], header, params: lp });
    this._dispatch(args, [1, 1, 1], { bind: [sim.tables, this.listState, fd.listGroup], header, params: lp });
    const params = { gravMode: sim.gravityMode, edge: sim.edgeMode, still, parity: sim.frame & 1, srcAt, cur: this.cur, all: 0 };
    this._dispatch(step, { indirect: sim.args, offset: ARGS.AER }, { bind: [sim.tables, sim.bindAct, this._group(fd, moveSrc)], header, params });
    // the reference: the same kernel over every brick, into its own field (I2.6)
    const ref = this.reference;
    if (ref) {
      this._dispatch(step, fold(this.g.nbricks), { bind: [sim.tables, sim.bindAct, this._group(ref, moveSrc)], header, params: { ...params, all: 1 } });
    }
    this.cur = 1 - this.cur;
  }

  _group(fd, moveSrc) {
    let group = fd.groups.get(moveSrc);
    if (!group) {
      if (fd.groups.size > 4) fd.groups.clear();
      group = this.gpu.bindGroup(this.L, [
        { binding: 0, resource: { buffer: moveSrc } }, { binding: 1, resource: { buffer: fd.buffer } }, { binding: 2, resource: { buffer: fd.nz } },
      ], 'aeration');
      fd.groups.set(moveSrc, group);
    }
    return group;
  }

  _dispatch(kernel, size, opts) {
    kernel.dispatch(this.gpu.frame, size, opts);
    this.sim.onPass?.(kernel.name, { kind: 'compute', gpuMs: null });
  }

  // The window moved by (dx, 0, dz) (Simulation.shift): the current copy moves
  // with the cells (into a scratch, then back); the other is rewritten by the
  // next START_STEPS steps, which list every brick.
  shift(dx, dz, f) {
    const sim = this.sim, gpu = this.gpu;
    this.scratch ??= gpu.createBuffer({ label: 'aeration shift', size: this.bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    for (const fd of [this.field, this.reference]) {
      if (!fd) continue;
      fd.shiftGroups ??= [0, 1].map((c) => gpu.bindGroup(sim.L.FLOW_SHIFT, [
        { binding: 0, resource: { buffer: fd.buffer, offset: c * this.bytes, size: this.bytes } },
        { binding: 1, resource: { buffer: this.scratch } }], 'aeration shift'));
      sim.shiftField(fd.shiftGroups[this.cur], dx, dz);
      f.copy(this.scratch, 0, fd.buffer, this.cur * this.bytes, this.bytes);
    }
    this.allSteps = START_STEPS;
  }

  // The state was replaced (Simulation.stillFlow): start clear.
  reset(f = this.gpu.frame) {
    for (const fd of [this.field, this.reference]) {
      if (!fd) continue;
      f.clear(fd.buffer);
      f.clear(fd.nz);
    }
    this.allSteps = START_STEPS;
    this.idleSteps = AER_IDLE_STEPS + 1;   // nothing left to burst
    this.generation++;
  }

  /**
   * Test only (tools/aeration-check.mjs, docs/webgpu.md I2.6): run the same
   * kernel over every brick too, into a field of its own, from now on (both
   * start clear).
   */
  enableReference() {
    if (this.reference) return;
    this.reference = this._field('aeration reference');
    this.reset();
  }

  /**
   * Test only: the current copy of the field and of the reference, as they
   * are at this call (Uint32Array, two words a slot).
   * @returns {Promise<{ field: Uint32Array, reference: Uint32Array | null, cur: number }>}
   */
  async read() {
    const rb = this.gpu.readback, at = this.cur * this.bytes, cur = this.cur;
    const [a, b] = await Promise.all([
      rb.buffer(this.field.buffer, at, this.bytes),
      this.reference ? rb.buffer(this.reference.buffer, at, this.bytes) : null,
    ]);
    return { field: new Uint32Array(a), reference: b && new Uint32Array(b), cur };
  }

  dispose() {
    this.offShift?.();
    const sim = this.sim;
    // once the queue is done with them (the open frame may still bind them)
    const retire = (b) => (sim.disposed || !sim._retire ? b.destroy() : sim._retire(b));
    for (const fd of [this.field, this.reference]) if (fd) { retire(fd.buffer); retire(fd.nz); }
    if (this.scratch) retire(this.scratch);
    this.field = this.reference = this.scratch = null;
  }
}

const kept = new WeakMap();   // sim → its field, kept while switched off

// Raw world source snapshots preserve allocated history even while the detail
// switch detaches it from physics. This is read-only ownership discovery, not
// permission to advance or dispose the field.
export const aerationForSource = (sim) => sim.aeration ?? kept.get(sim) ?? null;

/**
 * Switch sim's aeration field on or off (made the first time it is on, kept
 * while off). Returns the field while it is on, else null.
 */
export function setAeration(sim, on) {
  let aer = kept.get(sim);
  if (!on) {
    if (aer && sim.aeration === aer) {
      sim.attachAeration(null);
      aer.enabled = false;
      aer.offAt = sim.version;
    }
    return null;
  }
  if (!aer) kept.set(sim, (aer = new Aeration(sim)));
  if (sim.aeration !== aer) {
    if (aer.offAt !== null && aer.offAt !== sim.version) aer.reset();   // the world changed while it was off
    aer.enabled = true;
    sim.attachAeration(aer);
  }
  return aer;
}

/** Drop sim's field (its grid is going): detached, buffers freed. */
export function dropAeration(sim) {
  const aer = kept.get(sim);
  if (!aer) return;
  if (sim.aeration === aer && !sim.disposed) sim.attachAeration(null);
  aer.dispose();
  kept.delete(sim);
}
