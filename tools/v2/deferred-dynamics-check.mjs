// CPU only: the real PhysicsV2, NativeDynamics, NativeJets, integration and native brush on a fake
// device whose dynamics kernels (particles, blasts, air, lists, jets) stay compiling until released.
// Proves the first frame no longer waits for them, the world steps meanwhile, and every request
// made before they are built (frame 1) waits, in order, and runs once they are: none refused,
// dropped or reordered across that boundary. Records commands; no WGSL execution, no browser.
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { nativeCapabilities } from '../../src/v2/integration.js';
import { nativeHostSteps, nativeReadiness } from '../../src/v2/host.js';
import { routeNativePaint } from '../../src/v2/interactions.js';
import { nativeImpulse, emitNativeRay } from '../../src/v2/tools.js';
import { resetNativeDynamics } from '../../src/v2/dynamicState.js';
import { marksLayout } from '../../src/shaders/common.js';
import { TOOLS } from '../../src/elements.js';

globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1, VERTEX: 0x20, INDEX: 0x10 };
const DYNAMICS = /^v2(particles|blasts|air|lists|jets)_/;
const turn = () => new Promise(r => setImmediate(r));
const g = gridLayout(32, 32, 32);
const log = [], clears = [];
let release; const held = new Promise(r => { release = r; });
const buffer = ({ size, label }) => ({ label, size, data: new Uint8Array(size), destroy() {} });
const gpu = {
  testMode: true, L: { EMPTY: [], PARAMS: [] }, emptyGroup: {}, stats: { flushes: 0 }, device: { limits: {} }, limits: {},
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { clears.push(b.label); b.data.fill(0, at, at + n); } },
  // a dynamics kernel builds until `release`; every other one is built at once
  kernel(desc) {
    const late = DYNAMICS.test(desc.name);
    const k = { name: desc.name, first: desc.first, build: desc.build, state: late ? 'pending' : 'ready',
      dispatch(_f, _size, opts) {
        if (k.state !== 'ready') throw new Error(`${k.name} used before its pipeline was ready`);
        log.push({ name: k.name, params: opts?.params ?? {} });
      } };
    k.ready = late ? held.then(() => { k.state = 'ready'; return k; }) : Promise.resolve(k);
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
sim.wake = () => {};

// ---- the first frame: the grid's kernels alone ----
const owner = new PhysicsV2(sim, { contactWGSL, Dynamics: NativeDynamics });
let gridReady = false; owner.ready.then(() => { gridReady = true; });
const integration = sim.prepareNative(owner);
let integrated = false; integration.then(() => { integrated = true; });
for (let i = 0; i < 10 && !(gridReady && integrated); i++) await turn();
assert(gridReady, 'PhysicsV2.ready (the first frame) does not wait for the dynamics kernels');
assert(integrated, 'the integration window and the native brush do not wait for them either');
assert.equal(owner.dynamics.isReady, false); assert.equal(owner.dynamicsBuilt, false);
assert(owner.dynamics.building, 'the dynamics report building, not unavailable');
const cap = nativeCapabilities(sim);
assert.equal(cap.state, true, 'the native state is integrated');
assert.equal(cap.impulse, false, 'tools wait for the dynamics');
for (const opts of [{}, { world: true }, { pov: true }, { world: true, pov: true }])
  assert.equal(nativeReadiness(sim, opts).ready, true, `the world steps while the dynamics build (${JSON.stringify(opts)})`);
assert.equal(sim.bindPhysicalRO?.entries?.length, 2, 'the physical readers bind the dynamics air buffers, not their kernels');

// Every grid kernel is built now, the long poles first; the dynamics idle, v2particles_react first.
for (const k of Object.values(owner.kernels)) assert.equal(k.build, 'now', k.name);
assert.deepEqual(Object.values(owner.kernels).filter(k => k.first).map(k => k.name).sort(), ['v2block', 'v2pairs', 'v2runs']);
const dynamicsKernels = [...Object.values(owner.dynamics.kernels), ...Object.values(owner.jets.kernels)];
assert(dynamicsKernels.every(k => k.build === 'idle'));
assert.deepEqual(dynamicsKernels.filter(k => k.first).map(k => k.name), ['v2particles_react']);
assert.equal(dynamicsKernels[0].name, 'v2particles_react', 'made first: its idle build is the first to start');

// A load at boot resets the dynamics at once (their buffers alone): no transition holds the world.
resetNativeDynamics(owner);
assert.equal(sim.nativeTransition ?? null, null, 'a load while the dynamics build holds no native transition');

// ---- frame 1: requests of every kind, before the dynamics are built ----
const events = new Uint32Array(owner.events.data.buffer), EVENT_SLOT = 777, CHARGE = 1;
events[EVENT_SLOT] = CHARGE;   // a material request the block pass wrote (shaders/v2.js noteEvents)
const ids = Object.fromEntries(TOOLS.map(t => [t.key, t.id])), centre = new Vector3(12, 12, 12);
const fired = [];
assert.equal(nativeImpulse(sim, { position: centre, direction: [0, 1, 0], radius: 3, deltaV: 2 }), true, 'an impulse is held, not refused'); fired.push('impulse');
// (the Pressure tool is V1's paint rule, a force kernel: v2/interactions.js pendingPaint)
assert.equal(routeNativePaint(sim, { tool: ids.BLAST, center: centre, end: centre, radius: 2, shape: 0, rate: 1 }), true, 'a Pressure stroke (a force kernel) is held, not refused'); fired.push('force');
assert.equal(emitNativeRay(sim, { tool: ids.PHOTON, center: centre, radius: 2, shape: 0, rate: 1 }), true, 'a photon stroke is held, not refused'); fired.push('photon');
assert.equal(routeNativePaint(sim, { tool: ids.VACUUM, center: centre, end: centre, radius: 2, shape: 0, rate: 1 }), true, 'a Vacuum stroke (a force kernel) is held, not refused'); fired.push('force');
assert.equal(nativeImpulse(sim, { position: centre, direction: [1, 0, 0], radius: 3, deltaV: 5 }), true); fired.push('impulse');
assert.deepEqual(sim.nativePending.map(r => r.kind), fired, 'held in the order they came');
assert.equal(owner.dynamics.sequence, 0, 'nothing ran yet');

// ---- the world steps meanwhile: the grid's passes only, every request kept ----
log.length = 0; clears.length = 0;
const before = () => sim.flushNativeTools();
let ticks = 0;
for (let frame = 0; frame < 5; frame++) ticks += nativeHostSteps(owner, 1 / 60, { before });
assert(ticks >= 5, `the world ticks while the dynamics build (${ticks})`);
const ran = new Set(log.map(c => c.name));
for (const name of ['v2block', 'v2runs', 'v2pairs', 'v2column', 'v2invalidate', 'v2elecGather']) assert(ran.has(name), `${name} steps meanwhile`);
assert(![...ran].some(n => DYNAMICS.test(n)), 'no dynamics kernel is recorded before it is built');
assert.equal(events[EVENT_SLOT], CHARGE, 'the material request stays in events');
assert(!clears.some(l => /material requests/.test(l ?? '')), 'nothing clears the material requests meanwhile');
assert.deepEqual(sim.nativePending.map(r => r.kind), fired, 'nothing held is dropped or reordered meanwhile');
assert.equal(owner.asleep, false, 'a box holding requests never certifies idle meanwhile');

// ---- the dynamics built: the first tick runs everything held, in order ----
release(); await owner.dynamicsReady; await turn();
assert.equal(owner.dynamics.isReady, true); assert.equal(owner.dynamicsBuilt, true); assert.equal(owner.jetsBuilt, true);
assert.equal(nativeCapabilities(sim).impulse, true);
log.length = 0;
ticks = owner.ticks(1);   // (a driver without the app's nativeBeforeStep: the tick runs what was held)
assert.equal(ticks, 1);
assert.equal(sim.nativePending.length, 0, 'every held request ran');
// each request's first recording, in the order recorded: the numbered ones by their sequence (the
// dynamics number them as they run them), a force stroke by its plan (one a tool)
const KIND = { v2blasts_toolPlan: 'impulse', v2blasts_externalBegin: 'externalBlast', v2blasts_rayEmit: 'photon' };
const seen = new Set(), order = [];
for (const c of log) {
  const kind = c.name === 'nativePaintForceForcePlan' ? 'force' : KIND[c.name];
  const id = kind === 'force' ? `force${c.params.tool}` : c.params.sequence;
  if (kind && id && !seen.has(id)) { seen.add(id); order.push(kind); }
}
assert.deepEqual(order, fired, 'every held request ran, in the order it was made');
const names = log.map(c => c.name);
assert.deepEqual(log.filter(c => c.name === 'v2blasts_toolPlan').map(c => c.params.sequence), [1, 3], 'numbered as they ran: the impulses first and last (a force kernel takes no number)');
// the material request is served by the first tick's batch (consumeMaterialEvents), still in events
for (const stage of ['v2blasts_reset', 'v2blasts_eventList', 'v2blasts_select', 'v2blasts_pick', 'v2blasts_planCharges'])
  assert(ran.has(stage) === false && names.includes(stage), `${stage}: the held material request is served on the first tick`);
assert.equal(events[EVENT_SLOT], CHARGE, 'the request reached that tick intact');
for (const stage of ['v2particles_integrate', 'v2particles_react', 'v2air_step', 'v2jets_spawn']) assert(names.includes(stage), `${stage} runs from the first tick`);
console.log(`deferred dynamics CPU: first frame and brush without the ${dynamicsKernels.length} dynamics kernels; ${5} ticks stepped meanwhile with the grid's passes; ${fired.length} frame-1 requests (impulse, pressure, photon, vacuum) and a material request held, then run in order on the first tick`);
process.exit(0);
