// CPU-only: V2's clocks run at V1's speed. Drives the real PhysicsV2 owner and
// the real host clock (src/v2/host.js) over a fake GPU, as integration-check
// does, and the real gfx/uniforms.js clock writer. No browser, no GPU.
//   1. the media/cloud clock (uSimClock, uCloudShift) advances 240 V1 steps a
//      second under either engine, across a runtime switch too (stepClock);
//   2. a script's sim.step(n) counts V1 steps (legacyStepCarry), and its
//      beforesim/aftersim fire LEGACY_STEPS_PER_TICK times a native tick;
//   3. a resting box keeps its clock and hooks and records nothing, so a busy
//      presentation wire (World's birds) no longer keeps V2 awake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { nativeHostSteps, nativeHostTick, stepClock, legacyStepCarry, HOST_HZ, LEGACY_STEP_HZ, LEGACY_STEPS_PER_TICK } from '../../src/v2/host.js';
import { gfxUniforms, updateGfxUniforms } from '../../src/gfx/uniforms.js';
import { cloudShift } from '../../src/shaders/gfx/clouds.js';
import { marksLayout } from '../../src/shaders/common.js';

assert.equal(LEGACY_STEPS_PER_TICK, 4, 'V1: 4 steps a frame at 60 Hz (app.js DEFAULTS.steps); V2: HOST_HZ ticks');
assert.equal(LEGACY_STEP_HZ, HOST_HZ * LEGACY_STEPS_PER_TICK);

const g = gridLayout(32, 32, 32);
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
let dispatches = 0;
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {}, stats: { flushes: 0 },
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); } },
  kernel: ({ name }) => ({ name, state: 'ready', ready: Promise.resolve(), dispatch() { dispatches++; } }),
  readback: { buffer: (b, at, n) => Promise.resolve(b.data.slice(at, at + n).buffer) },
  flush() {},
};
const bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { ...this }; } }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], STATE_RW: [], UNDO: [], FLOW_SHIFT: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [], flow: buffer({ size: g.slots * 8 }),
  _shiftListeners: [], _scratchGroups: [], shiftKeepsHistory: true, wake() {}, _retire() {}, stillFlow() {},
  rays: { wake() {}, reset() {}, paint() { return false; }, noteElement() {} },
  passOf: name => gpu.kernel({ name }), passes: { paint: {}, undoShift: gpu.kernel({ name: 'undoShift' }) },
});

// ---- 1. the view's clock: V1 steps under either engine
const sun = { x: 0, y: 1, z: 0 }, light = [1, 1, 1];
const clockNow = () => { updateGfxUniforms(sim, sun, light); return gfxUniforms.uSimClock.value; };
const shiftOf = steps => cloudShift(steps, [0, 0]);
// V1: sim.frame counts its steps, one a step (sim.js step()); the clock is exactly it
for (let i = 0; i < 240; i++) sim.frame++;   // one second of V1 at 4 steps a 60 Hz frame
assert.equal(stepClock(sim), 240); assert.equal(clockNow(), 240);
assert.deepEqual([...gfxUniforms.uCloudShift.value], shiftOf(240));

const owner = new PhysicsV2(sim); await owner.ready;
owner.contactReady = true;
owner.dynamics = null;   // (rest needs only the owner's own certificate here)
owner.activate();
// V2: one second of game time on the host clock moves the media and the clouds as far as V1's second
let before = 0, after = 0;
const hooks = { before: () => before++, after: () => after++ };
for (let i = 0; i < HOST_HZ; i++) nativeHostSteps(owner, 1 / HOST_HZ, hooks);
assert.equal(sim.frame, 240 + HOST_HZ, 'sim.frame still counts one a native tick (sources key on it)');
assert.equal(stepClock(sim), 480, 'a native second is LEGACY_STEP_HZ V1 steps of the view clock');
assert.equal(clockNow(), 480, 'uSimClock: the media drift runs at V1 speed under V2');
assert.deepEqual([...gfxUniforms.uCloudShift.value], shiftOf(480), 'the cloud deck drifts as far as under V1');
assert.equal(before, HOST_HZ); assert.equal(after, HOST_HZ);
// and back on V1 (runtime switch): one more step is one more on the same clock, no jump
owner.suspend(); sim.frame++;
assert.equal(stepClock(sim), 481, 'V2 → V1 keeps the clock continuous');
owner.activate();

// ---- 3. rest: a certified-idle box keeps its clock and hooks, records nothing
owner.certified = true;
assert(owner.asleep, 'the fixture certifies idle');
const restTick = owner.tick, restFrame = sim.frame, restClock = stepClock(sim), restDispatches = dispatches;
before = after = 0;
for (let i = 0; i < HOST_HZ; i++) assert.equal(nativeHostSteps(owner, 1 / HOST_HZ, hooks), 1, 'a resting box still ticks its host clock');
assert.equal(owner.tick, restTick, 'a resting tick records no native tick');
assert.equal(dispatches, restDispatches, 'a resting tick dispatches nothing');
assert.equal(sim.frame, restFrame + HOST_HZ, 'V1 advances sim.frame through idle steps too (sim.js step())');
assert.equal(stepClock(sim), restClock + LEGACY_STEP_HZ, 'the view clock goes on at rest');
assert.equal(before, HOST_HZ, 'weather, scripts and tools hooks run at rest (they may write)');
assert.equal(after, HOST_HZ);
// a hook that writes wakes the very tick it runs in
const woke = owner.tick;
nativeHostSteps(owner, 1 / HOST_HZ, { before: () => { sim.version++; } });
assert.equal(owner.tick, woke + 1, 'a write in before() records that tick');
// explicit steps (scripts' sim.step, tests) always record, as before
owner.certified = true;
const explicit = owner.tick; nativeHostTick(owner); assert.equal(owner.tick, explicit + 1);
// The app no longer keeps V2 awake for wires that only animate (birds, the far field, the session):
// nothing but the rest above gates the host (the busy wires keep the frame loop, not the physics).
const app = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const hostCall = app.slice(app.indexOf('stepped = nativeHostSteps('), app.indexOf('});', app.indexOf('stepped = nativeHostSteps(')));
assert(!/keepAlive|busy/.test(hostCall), 'busy presentation wires do not force native ticks');

// ---- 2. the console: sim.step(n) is n V1 steps; beforesim/aftersim fire per V1 step
const carry = legacyStepCarry();
assert.equal(carry(sim, 240), 60, 'sim.step(240): one second of V1 is HOST_HZ native ticks');
assert.deepEqual([1, 1, 1, 1, 1, 1, 1, 1].map(n => carry(sim, n)), [0, 0, 0, 1, 0, 0, 0, 1], 'four single steps run one tick');
assert.equal(carry(sim, 3), 0); assert.equal(carry(sim, 2), 1, 'the remainder carries');
assert.equal(carry({}, 2), 0, 'a new grid starts its own carry');
const consoleWire = readFileSync(new URL('../../src/wire/console.js', import.meta.url), 'utf8');
assert(/sim\.compact \? scriptTicks\(sim, n\) : n/.test(consoleWire), 'the console steps V2 by V1 steps');
const fnBody = name => app.slice(app.indexOf(`function ${name}()`), app.indexOf('\n}', app.indexOf(`function ${name}()`)));
assert(/for \(let i = 0; i < LEGACY_STEPS_PER_TICK; i\+\+\) scripts\?\.beforeStep\(\)/.test(fnBody('nativeBeforeStep')), 'beforesim fires per V1 step under V2');
assert(/for \(let i = 0; i < LEGACY_STEPS_PER_TICK; i\+\+\) scripts\?\.afterStep\(\)/.test(fnBody('nativeAfterStep')), 'aftersim fires per V1 step under V2');

console.log('V2 clocks: view/cloud clock at V1 speed across engines, rest ticks keep clock and hooks with nothing recorded, console steps in V1 steps: passed');
