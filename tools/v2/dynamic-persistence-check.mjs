import { coupleNativeBody, bodyEditStepRate, nativeBodyPressureFactor } from '../../src/v2/body.js';
import { LEGACY_PRESSURE_PA, CELL_M } from '../../src/v2/dynamics-reference.js';
import { povGpu } from '../../src/pov/gpu.js';
import { WorldWindow } from '../../src/world/window.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from '../../src/world/store.js';
import { NativeBrickStore, encodeNativeBrick } from '../../src/world/nativeStore.js';
import { heldBase, shockBase } from '../../src/shaders/v2/particles.js';
// CPU-only: actual foundation/contact/dynamics constructors and save/undo
// orchestration. GPU commands copy mock bytes; WGSL execution is NOT emulated.
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Simulation, gridLayout } from '../../src/sim.js';
import { marksLayout } from '../../src/shaders/common.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { NativeDynamics, validateDynamicState } from '../../src/v2/dynamics.js';
import { makeMaterial } from '../../src/v2/layout.js';
import { packParticle } from '../../src/v2/dynamics-reference.js';
import { E } from '../../src/elements.js';
import { captureNativeSnapshot, restoreNativeSnapshot, encodeDynamicState, decodeDynamicState } from '../../src/v2/dynamicState.js';
import { decodeV2State } from '../../src/v2/state.js';
import savesWire from '../../src/wire/saves.js';
import { createSaves } from '../../src/saves/game.js';
import { encodeSave, decodeSave } from '../../src/saves/format.js';

globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256 };
const reads = [], pending = [], writes = [], dispatches = [], g = gridLayout(32, 32, 32);
const buffer = ({ size, label }) => ({ size, label, bytes: new ArrayBuffer(size), destroy() {} });
const words = b => new Uint32Array(b.bytes);
const write = (b, at, data) => { writes.push(b.label); new Uint8Array(b.bytes).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); };
let delayed = true;
const gpu = {
  L: { EMPTY: [] }, emptyGroup: {}, createBuffer: buffer, layout: (_n, entries) => entries, bindGroup: (_l, entries) => entries,
  queue: { writeBuffer: write }, write, flush() {},
  frame: { clear(b, at = 0, n = b.size - at) { new Uint8Array(b.bytes, at, n).fill(0); },
    copy(a, at, b, to, n) { new Uint8Array(b.bytes).set(new Uint8Array(a.bytes, at, n), to); } },
  kernel: ({ name, code }) => ({ name, code, state: 'ready', ready: Promise.resolve(), dispatch(_f, _n, opts) { dispatches.push({ name, opts }); } }),
  readback: { buffer(b, at, n) {
    reads.push(b.label); const bytes = b.bytes.slice(at, at + n);
    return delayed ? new Promise(resolve => pending.push(() => resolve(bytes))) : Promise.resolve(bytes);
  } },
};
const bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 92, origin: new Vector3(), cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0, history: [],
  L: { TABLES: [], STATE_RO: [], STATE_RW: [], UNDO: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4, label: 'marks' }),
  state: { A: buffer({ size: bytes * 2, label: 'legacy A' }), B: buffer({ size: bytes * 2, label: 'legacy B' }), F: buffer({ size: g.slots * 8, label: 'flags' }) },
  _bindRW: {}, _bindRO: {}, _bindFlagsRO: {}, _bindAct: {}, wake() {}, _retire() {}, stillFlow() {}, rays: { wake() {} },
});
const owner = new PhysicsV2(sim, { contactWGSL, Dynamics: NativeDynamics }); await owner.ready;
assert(owner.contactReady && owner.dynamics instanceof NativeDynamics);
assert(owner.nativeDynamics.head && owner.nativeDynamics.group, 'foundation adapter is separate from actual instance');
const d = owner.dynamics;
const m = makeMaterial(E.WATER, 22, 1); m.bank = -73;
words(owner.cells).set(m.core); words(owner.aux)[0] = m.bank >>> 0;
words(d.particles).set(new Uint32Array(packParticle({ position: [2, 3, 4], velocity: [5, -6, 7], id: 101, core: [...m.core], bank: -73 })));
const fbits = n => new Uint32Array(new Float32Array([n]).buffer)[0];
words(d.particles).set(new Uint32Array(packParticle({ position: [300, 3, 4], velocity: [5, 0, 7], id: 102,
  core: [254, fbits(1), fbits(2), fbits(3)], bank: 0 })), 12);
words(d.particles).set(new Uint32Array(packParticle({ position: [-20, 3, 4], velocity: [0, 8, 0], id: 103,
  core: [255, fbits(1), fbits(2), 0], bank: 0 })), 24);
new Float32Array(d.air[d.airIndex].bytes).set([1, -2, 3, 4, 0.25, 15, 0, 0]);
d.airArchive.set('128,0,0', new Uint32Array(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
d.pendingOutside.set('129,2,3', 5); words(owner.events)[3] = 7;
assert.equal(d.applyToolImpulse({ kind: 'neutron', position: [2, 3, 4], direction: [0, 1, 0], radius: 1, count: 3 }).status, 'queued');
assert.equal(d.applyPhysgun({ mode: 'hold', position: [2, 3, 4], target: [6, 7, 8], radius: 3, strength: 12 }).status, 'queued');
words(d.control)[heldBase(g)] = d.holdSession.token;
words(d.control)[shockBase(g)] = 73;
owner.tick = 17; owner.acc = 0.375; sim.frame = 23; sim.paints = 11;
const start = reads.length;
const capture = captureNativeSnapshot(owner, 'v2');
assert.equal(reads.length - start, 8, 'core/aux/activity/args and four dynamics copies enqueue before first await');
const oldCore = words(owner.cells).slice(), oldParticles = words(d.particles).slice();
words(owner.cells).fill(0); words(d.particles).fill(0); d.airArchive.clear(); d.pendingOutside.clear(); d.rayRequests.clear();
while (pending.length) pending.shift()();
const snapshot = await capture;
assert.deepEqual(decodeV2State(snapshot.core).cells, oldCore);
assert.deepEqual(snapshot.dynamic.particles, oldParticles);
assert.equal(snapshot.dynamic.held[0], snapshot.dynamic.holdSession.token);
assert.equal(snapshot.dynamic.shocks[0], 73);
assert.deepEqual(snapshot.dynamic.holdSession.target, [6, 7, 8]);
assert.equal(snapshot.dynamic.requests.length, 1); assert.equal(snapshot.dynamic.airArchive.length, 1);
assert.equal(snapshot.dynamic.pendingEvents.length, 2);
const encoded = encodeDynamicState(snapshot.dynamic), decoded = decodeDynamicState(encoded, { dims: [32, 32, 32], origin: [0, 0, 0] });
assert.deepEqual(decoded, snapshot.dynamic, 'all mixed-bit payloads, queued obligations and archived air round-trip exactly');
validateDynamicState(decoded, g);
assert.throws(() => decodeDynamicState(encoded.subarray(0, encoded.length - 1)));
assert.throws(() => decodeDynamicState(encoded, { dims: [32, 32, 32], origin: [16, 0, 0] }), /origin/);
let n = writes.length;
assert.throws(() => restoreNativeSnapshot(owner, { ...snapshot, dynamic: { ...decoded, origin: [16, 0, 0] } }), /origin/);
assert.equal(writes.length, n, 'wrong-origin dynamic state cannot partially overwrite core');
const corrupt = { ...decoded, air: decoded.air.slice() }; corrupt.air[0] = 0x7f800000;
assert.throws(() => restoreNativeSnapshot(owner, { ...snapshot, dynamic: corrupt }), /air/);
assert.equal(writes.length, n, 'numeric corruption rejects before any native core or dynamic write');
const unowned = { ...decoded, holdSession: null };
assert.throws(() => restoreNativeSnapshot(owner, { ...snapshot, dynamic: unowned }), /held/);
assert.equal(writes.length, n);
restoreNativeSnapshot(owner, snapshot);
assert.deepEqual(words(owner.cells), oldCore); assert.deepEqual(words(d.particles), oldParticles);
assert.equal(owner.tick, 17); assert.equal(owner.acc, 0.375); assert.equal(d.rayRequests.size, 1);
assert.equal(words(owner.events)[3], 7); assert.equal(d.pendingOutside.get('129,2,3'), 5);
assert(d.airArchive.has('128,0,0'));

// Actual Simulation history waits for the same-batch readback, then restores
// all authoritative sections. A shifted dynamic undo preserves/rejects entry.
sim.snapshot('mixed native');
words(owner.cells).fill(0); words(d.particles).fill(0); d.pendingOutside.clear();
const undo = sim.undo(); assert(undo?.then, 'pending undo is an explicit asynchronous operation');
while (pending.length) pending.shift()();
assert.equal(await undo, true); assert.deepEqual(words(owner.cells), oldCore); assert.deepEqual(words(d.particles), oldParticles);
assert.equal(d.pendingOutside.get('129,2,3'), 5);
sim.snapshot('shift guard'); while (pending.length) pending.shift()(); await sim.history.at(-1).nativePending;
sim.origin.x = 16; assert.throws(() => sim.undo(), /retained-world history/); assert.equal(sim.history.length, 1); sim.origin.x = 0;

// Full shifted world history: rewind the complete old window AND its COW
// retained stores before restoring global particles. Deposits made after the
// snapshot outside the old overlap cannot survive beside the old flight copy.
const wb = [32, 8, 32], notified = [];
const world = Object.assign(Object.create(WorldWindow.prototype), { sim, gpu, size: [128, 32, 128], wb,
  historyIdentity: {}, historyReaders: 0, epoch: 1, pending: null, loaded: true,
  store: new BrickStore(wb), nativeStore: new NativeBrickStore(wb), planted: new Uint8Array(wb[0] * wb[2]),
  far: { build() { notified.push('far rebuilt'); } },
});
sim.worldWindow = world;
sim.onWorldHistoryRestore = (...delta) => notified.push(delta);
const rawBrick = encodeNativeBrick(new Uint32Array(256).fill(123), new Int32Array(64).fill(-456));
const legacyBrick = encodeBrick(new Float32Array(BRICK_FLOATS), 0, new Float32Array(BRICK_FLOATS), 0);
world.nativeStore.put(12, rawBrick); world.store.put(12, legacyBrick); world.planted[4] = 1;
sim.snapshot('whole world'); while (pending.length) pending.shift()(); await sim.history.at(-1).nativePending;
const entry = sim.history.at(-1), h = entry.worldHistory;
assert.equal(h.nativeStore.get(12), rawBrick, 'COW shares immutable byte payloads, not deep copies');
sim.origin.x = 64; d.origin = [64, 0, 0]; words(owner.cells).fill(0); words(d.particles).fill(0);
world.nativeStore.put(0, rawBrick); world.nativeStore.drop(12); world.store.clear(); world.planted.fill(0);
const currentMap = world.nativeStore.map, beforeWrites = writes.length;
h.origin = [16, 0, 0];
assert.throws(() => sim.undo(), /origin/);
assert.equal(sim.origin.x, 64); assert.equal(world.nativeStore.map, currentMap); assert.equal(writes.length, beforeWrites);
assert.equal(sim.history.at(-1), entry, 'failed full-world preflight preserves entry and current world');
h.origin = [0, 0, 0];
assert.equal(await sim.undo(), true);
assert.equal(sim.origin.x, 0); assert.deepEqual(d.origin, [0, 0, 0]);
assert.equal(world.nativeStore.map.get(12), rawBrick); assert(!world.nativeStore.has(0), 'post-snapshot deposit cannot duplicate restored particle');
assert.deepEqual(world.store.map.get(12), legacyBrick); assert.equal(world.planted[4], 1);
assert.deepEqual(words(owner.cells), oldCore); assert.deepEqual(words(d.particles), oldParticles);
assert.deepEqual(notified, ['far rebuilt', [-64, 0]]);
assert(sim.fieldReset && sim.giReset);
// A capture during an earlier leaving readback locks shifts until the store
// epoch has committed. The global dynamics/core capture itself never waits.
let land;
world.pending = new Promise(resolve => { land = resolve; });
const worldCapture = world.captureHistory();
assert.equal(world.historyReaders, 1); assert.throws(() => world.shift(16, 0), /history capture/);
world.nativeStore.put(13, rawBrick); land();
const landed = await worldCapture; world.pending = null;
assert(landed.nativeStore.has(13)); assert.equal(world.historyReaders, 0);
// Existing three-entry undo budget bounds COW versions and dynamic captures.
delayed = false;
for (let i = 0; i < 5; i++) { sim.snapshot(`bounded ${i}`); await sim.history.at(-1).nativePending; assert(sim.history.length <= 3); }
sim.worldWindow = null;

// Real strict save registrations and game preflight: malformed dynamics must
// fail before app.prepare, legacy cells, or core state are touched.
delayed = false;
const events = [], app = { sim, settings: {}, day: { clock: 0 }, physics: { mode: 'v2', v2: owner },
  setPhysics: async mode => { app.physics.mode = mode; }, camState: () => 'pov', setSimModes() {}, resetSimModes() {}, updateSun() {} };
savesWire.boot(app);
sim.prepare = async () => {};
sim.blankState = () => [new Float32Array(g.width * g.height * 4), new Float32Array(g.width * g.height * 4)];
sim.readState = async () => sim.blankState();
sim.load = () => events.push('legacy load');
const saves = createSaves({ settings: app.settings, getSim: () => sim, getWin: () => null,
  header: () => ({ world: null, nativeDynamicsVersion: 1 }), prepareCapture: () => owner.ready,
  prepare: () => { events.push('prepare'); return true; }, finish() {}, onSettings() {} });
const saved = await saves.capture('mixed native');
const file = await decodeSave(saved);
assert(file.sections.has('physicsV2Dynamics'));
const broken = await encodeSave(file.header, [...file.sections].map(([key, data]) => ({ key,
  data: key === 'physicsV2Dynamics' ? data.subarray(0, data.length - 1) : data })));
n = writes.length; await assert.rejects(saves.apply(broken)); assert.equal(events.length, 0); assert.equal(writes.length, n);
const missing = await encodeSave(file.header, [...file.sections].filter(([key]) => key !== 'physicsV2Dynamics').map(([key, data]) => ({ key, data })));
await assert.rejects(saves.apply(missing)); assert.equal(events.length, 0);
await saves.apply(saved);
assert.deepEqual(words(d.particles), oldParticles); assert(d.airArchive.has('128,0,0')); assert.equal(d.rayRequests.size, 1);
// Physical native readers bind actual ping-pong coarse air, not the legacy B
// cache. The shared format3 accessors convert pressure for existing vitals.
const ring = { next: () => 0, read: () => Promise.resolve(new ArrayBuffer(16)) };
const probe = gpu.kernel({ name: 'native body probe routing' });
for (const index of [0, 1]) {
  d.airIndex = index;
  await sim.probe(probe, [1, 1, 1], { ring, bind: [sim.tables, sim.bindRO, {}] });
  const opts = dispatches.at(-1).opts;
  assert.equal(opts.header.format, 3); assert.equal(opts.bind[1][1].resource.buffer, d.air[index]);
}
assert.equal(povGpu(sim).com(buffer({ size: 16, label: 'body com test' }), [1, 2, 3]), true);
assert.equal(dispatches.at(-1).opts.bind[1][1].resource.buffer, d.air[d.airIndex]);
owner.suspend();
await sim.probe(probe, [1, 1, 1], { ring, bind: [sim.tables, sim.bindRO, {}] });
assert.equal(dispatches.at(-1).opts.header.format, 0);
owner.activate();
assert.equal(bodyEditStepRate(sim, 60), 240);
assert(Math.abs(nativeBodyPressureFactor(60, 9.8) + LEGACY_PRESSURE_PA / (980 * CELL_M ** 2)) < 1e-12);
// Actual POV edit entrypoint must never build or execute a destructive legacy
// velocity-only edit. Allocation refusal cannot refill material/reset banks.
const body = { lo: [0, 0, 0], hi: [2, 5, 2], vel: [10 / bodyEditStepRate(sim, 60), 0, 0],
  pushFluid: 0.1, pushPowder: 0.2, lift: 0.5, ahead: [0, 0.2], only: -1 };
const originalCouple = d.applyBodyCoupling;
let request;
d.applyBodyCoupling = value => { request = value; return { status: 'rejected', reason: 'allocator full' }; };
sim.editKernel = () => { throw new Error('Native body attempted lossy legacy edit'); };
const coreBefore = words(owner.cells).slice(), bankBefore = words(owner.aux).slice();
assert.equal(povGpu(sim).edit('povCouple', { lo: body.lo, hi: body.hi }, body), false);
assert(Math.abs(request.velocity[0] - 10 * CELL_M) < 1e-12);
assert.deepEqual(request.lo, body.lo); assert.deepEqual(request.hi, body.hi);
assert.deepEqual(words(owner.cells), coreBefore); assert.deepEqual(words(owner.aux), bankBefore);
d.applyBodyCoupling = undefined;
assert.equal(coupleNativeBody(sim, body), false, 'missing actual coupling capability stays explicitly gated');
d.applyBodyCoupling = originalCouple; delete sim.editKernel;

console.log('dynamic persistence CPU: actual contact+dynamics constructors; synchronous mixed-state capture; exact binary/save/undo restoration; pre-mutation corruption/origin rejection; full shifted COW world history; physgun held/shock/controller fields; actual-air probe/body SI boundaries and lossless refusal passed');
