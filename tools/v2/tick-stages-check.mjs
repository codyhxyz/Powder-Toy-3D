// CPU only: a tick recorded a stage at a time (v2/physics.js beginTick / stepTick, TICK_STAGES) and the
// app's host spreading an expensive tick over frames (v2/host.js nativeHostSteps with the governor).
//   1. The staged tick records exactly the whole tick's commands, in order, with the same params.
//   2. With stage costs from fake GPU timestamps, no frame records more physics than its budget (or one
//      stage that costs more, alone, once the credit for it has built up), every tick ends, and game time
//      slows rather than bursting: the ticks waiting are at most the catch-up's.
//   3. Whatever replaces or moves the whole box (restore, a captured state, explicit steps) ends the tick
//      in flight first, and its clock and after() run once.
// The real PhysicsV2 and NativeDynamics on a fake device that records commands; no WGSL, no browser.
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2, TICK_STAGES } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { nativeHostSteps, createPhysicsGovernor, PHYSICS_BUDGET_MS, CATCH_UP_TICKS } from '../../src/v2/host.js';
import { marksLayout } from '../../src/shaders/common.js';

globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1, VERTEX: 0x20, INDEX: 0x10 };
const turn = () => new Promise(r => setImmediate(r));
const g = gridLayout(32, 32, 32);

// A fake device: every kernel built, its dispatches logged (name, params); its timestamps the test's clock.
function world() {
  const log = [];
  const buffer = ({ size, label }) => ({ label, size, data: new Uint8Array(size), destroy() {} });
  const gpu = {
    testMode: true, L: { EMPTY: [], PARAMS: [] }, emptyGroup: {}, stats: { flushes: 0 }, device: { limits: {} }, limits: {},
    createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
    // timestamp queries: a pass writes the fake GPU clock (clock.ns) as it begins and ends; the test moves the
    // clock by each stage's cost
    clock: { ns: 0n }, stamps: [],
    queue: {
      writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); },
    },
    write(b, at, data) { this.queue.writeBuffer(b, at, data); },
    frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); },
      flush(reason) { log.push({ flush: reason }); },
      // a dispatch begins a pass when none is open (GpuFrame.compute), with the timer's timestampWrites
      passTimer: null, open: null,
      pass() { if (!this.open) { this.open = this.passTimer?.().timestampWrites ?? {}; if (this.open.querySet) gpu.stamps[this.open.beginningOfPassWriteIndex] = gpu.clock.ns; } },
      endPass() { if (this.open?.querySet) gpu.stamps[this.open.endOfPassWriteIndex] = gpu.clock.ns; this.open = null; },
      direct() {
        this.endPass();
        return { resolveQuerySet(_q, first, count, dst) { new BigUint64Array(dst.data.buffer).set(gpu.stamps.slice(first, first + count), first); } };
      } },
    kernel(desc) {
      const k = { name: desc.name, first: desc.first, build: desc.build, state: 'ready',
        dispatch(_f, size, opts) { gpu.frame.pass(); log.push({ name: k.name, size: JSON.stringify(size), params: JSON.stringify(opts?.params ?? {}) }); } };
      k.ready = Promise.resolve(k);
      return k;
    },
    readback: { buffer: (b, at = 0, n = b.size - at) => Promise.resolve(b.data.slice(at, at + n).buffer), ring: (_n, bytes) => ({ next: () => 0, read: async () => new ArrayBuffer(bytes) }) },
    flush() {},
  };
  const bytes = g.slots * 16;
  const sim = Object.assign(Object.create(Simulation.prototype), {
    gpu, g, id: 1, origin: new Vector3(), cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
    L: { TABLES: [], STATE_RO: [], STATE_RW: [], UNDO: [], FLOW_SHIFT: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4, label: 'marks' }),
    state: { A: buffer({ size: bytes }), B: buffer({ size: bytes }), F: buffer({ size: g.slots * 8 }) },
    _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [], flow: buffer({ size: g.slots * 8, label: 'flow' }),
    _shiftListeners: [], shiftKeepsHistory: true, wake() {}, _retire() {}, stillFlow() {}, ready: Promise.resolve(),
    rays: { wake() {}, reset() {}, paint() { return false; }, noteElement() {} }, noMask: buffer({ size: 16, label: 'no mask' }),
    passOf: name => gpu.kernel({ name }), passes: { paint: {}, undoShift: {} }, edit() { throw new Error('legacy edit forbidden'); },
  });
  gpu.device = { limits: {}, features: new Set(['timestamp-query']), createQuerySet: (d) => d,
    createBuffer: ({ size, label }) => buffer({ size, label }) };
  const owner = new PhysicsV2(sim, { contactWGSL, Dynamics: NativeDynamics });
  return { gpu, sim, owner, log };
}
async function ready(w) {
  await w.owner.ready; await w.owner.dynamics?.ready; await turn();
  assert.equal(w.owner.isReady, true, 'the owner builds on the fake device');
  w.owner.activate();
  w.log.length = 0;
}
const commands = log => log.filter(e => e.name).map(e => `${e.name} ${e.size} ${e.params}`);

// ---- 1. a staged tick records the whole tick's commands ----
{
  const a = world(), b = world();
  await ready(a); await ready(b);
  for (let t = 0; t < 3; t++) {
    a.owner.ticks(1);
    let ended = false, stages = 0;
    b.owner.beginTick(() => { ended = true; });
    const seen = [];
    while (b.owner.tickInFlight) { seen.push(b.owner.nextStage); b.owner.stepTick(); stages++; }
    assert.deepEqual(seen, TICK_STAGES, 'a tick is its stages, in order');
    assert(ended, 'done() runs when its last stage is recorded');
    assert.equal(b.owner.tick, a.owner.tick, 'the tick counts');
    assert.equal(stages, TICK_STAGES.length);
  }
  const whole = commands(a.log), staged = commands(b.log);
  assert(whole.length > 30, `a tick records its passes (${whole.length})`);
  assert.deepEqual(staged, whole, 'the staged ticks record exactly the whole ticks\' commands');
  assert.equal(b.sim.version, a.sim.version, 'each tick advances the derived key');
}

// ---- 2. the host spreads an expensive tick over frames within the budget ----
{
  const w = world();
  await ready(w);
  {
    // the stages' GPU costs (ms): the block pass over a busy box is more than a frame's budget
    const COST = { grid: 1, particles: 4, blocks: 3 * PHYSICS_BUDGET_MS, blasts: 6, moves: 8, air: 2 };
    const step = w.owner.stepTick.bind(w.owner), ran = [];
    // (the stage's passes run for its cost: the clock moves while they are open)
    w.owner.stepTick = () => { const stage = w.owner.nextStage; ran.push(stage); const ended = step(); w.gpu.clock.ns += BigInt(Math.round(COST[stage] * 1e6)); return ended; };
    const governor = createPhysicsGovernor(w.gpu);
    assert(governor.timed, 'the fake device has timestamp queries');
    const awake = () => { w.sim.version++; };   // (a write before each tick: the box stays awake and records)
    let afters = 0;
    const frames = [];
    for (let f = 0; f < 240; f++) {
      ran.length = 0;
      const n = nativeHostSteps(w.owner, 1 / 60, { governor, before: awake, after: () => { afters++; } });
      frames.push({ n, stages: [...ran], cost: ran.reduce((sum, x) => sum + COST[x], 0) });
      await turn();   // (the marks' readback lands)
      assert((w.owner.owed ?? 0) <= CATCH_UP_TICKS, 'the ticks waiting are at most the catch-up\'s');
    }
    assert.deepEqual(Object.keys(governor.costs).sort(), TICK_STAGES.slice().sort(), 'every stage priced');
    for (const [stage, ms] of Object.entries(governor.costs)) assert(Math.abs(ms - COST[stage]) < 1e-6, `${stage} priced at its GPU time: ${ms}`);
    const late = frames.slice(60);   // (once every stage has been priced)
    const worst = Math.max(...late.map(x => x.cost));
    assert(late.every(x => x.cost <= PHYSICS_BUDGET_MS || x.stages.length === 1),
      `a frame records its budget at most, or one stage alone: ${JSON.stringify(late.find(x => x.cost > PHYSICS_BUDGET_MS && x.stages.length > 1))}`);
    assert.equal(worst, COST.blocks, 'the expensive stage runs, alone');
    const ticks = late.reduce((sum, x) => sum + x.n, 0), perTick = Object.values(COST).reduce((sum, c) => sum + c, 0);
    // physics' share of the frames: its budget a frame, spent on whole ticks of perTick ms (none of it lost
    // while the expensive stage waits: the bank keeps it)
    const ideal = late.length * PHYSICS_BUDGET_MS / perTick;
    assert(ticks >= Math.floor(ideal) - 1, `the ticks still end: ${ticks} in ${late.length} frames (${ideal.toFixed(1)} at the whole budget)`);
    assert(ticks < late.length, 'game time slows (a tick costs more than a frame\'s budget)');
    assert.equal(afters, frames.reduce((sum, x) => sum + x.n, 0), 'after() once a tick, when it ends');
    console.log(`staged host: ${late.length} frames, ${ticks} ticks of ${perTick} ms, worst frame ${worst} ms of physics (budget ${PHYSICS_BUDGET_MS})`);
    // a cheap tick: every due tick, whole, every frame
    for (const k of Object.keys(COST)) COST[k] = 0.1;
    for (let f = 0; f < 60; f++) { nativeHostSteps(w.owner, 1 / 60, { governor, before: awake }); await turn(); }
    ran.length = 0; let cheap = 0;
    for (let f = 0; f < 60; f++) { cheap += nativeHostSteps(w.owner, 1 / 60, { governor, before: awake }); await turn(); }
    assert(cheap >= 59, `a cheap world ticks at 60 Hz: ${cheap} ticks in 60 frames`);
    // ---- 3. whole-box work ends the tick in flight first ----
    for (const k of Object.keys(COST)) COST[k] = 3 * PHYSICS_BUDGET_MS;   // (a tick that spans frames again)
    for (let f = 0; f < 30 && !w.owner.tickInFlight; f++) { nativeHostSteps(w.owner, 1 / 60, { governor, before: awake }); await turn(); }
    assert(w.owner.tickInFlight, 'a tick in flight');
    const tick = w.owner.tick, endedBefore = afters;
    w.owner.inFlight.done = () => { afters++; };
    w.owner.ticks(1);
    assert(!w.owner.tickInFlight && afters === endedBefore + 1, 'explicit steps end the tick in flight, its after() once');
    assert(w.owner.tick >= tick + 1);
    for (let f = 0; f < 30 && !w.owner.tickInFlight; f++) { nativeHostSteps(w.owner, 1 / 60, { governor, before: awake }); await turn(); }
    assert(w.owner.tickInFlight, 'another tick in flight');
    const snap = { size: g.slots * 16, data: new Uint8Array(g.slots * 16) };
    w.owner.restore(snap);
    assert(!w.owner.tickInFlight, 'a restore ends the tick in flight first');
    assert.equal(w.owner.asleep, false);
    // a single step while paused: the tick in flight and one more, whole
    for (let f = 0; f < 30 && !w.owner.tickInFlight; f++) { nativeHostSteps(w.owner, 1 / 60, { governor, before: awake }); await turn(); }
    if (w.owner.tickInFlight) assert.equal(nativeHostSteps(w.owner, 0, { once: true, governor, before: awake }), 2, 'a step ends the tick in flight and runs one');
  }
}
console.log('tick stages: a staged tick is the whole tick\'s commands; the host keeps each frame\'s physics to its budget; whole-box work ends the tick first: passed');
