import decoWire from '../../src/wire/deco.js';
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
import { makeMaterial, MAX_FILL } from '../../src/v2/layout.js';
import { packParticle } from '../../src/v2/dynamics-reference.js';
import { E, ELEMENTS } from '../../src/elements.js';
import { RAYS } from '../../src/rays.js';
import { PHASE_HOT_BASE } from '../../src/v2/phase.js';
import { registerSaveSection, unregisterSaveSection } from '../../src/saves/sections.js';
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
  core: [255, RAYS.NEUT_LIFE, fbits(2), 0], bank: 0 })), 24);
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
const world = Object.assign(Object.create(WorldWindow.prototype), { sim, gpu, scene: {}, size: [128, 32, 128], wb,
  historyIdentity: {}, historyReaders: 0, epoch: 1, pending: null, loaded: true,
  store: new BrickStore(wb), nativeStore: new NativeBrickStore(wb), planted: new Uint8Array(wb[0] * wb[2]),
  far: { build() { notified.push('far rebuilt'); } },
  // main's World render source (src/world/renderSource.js): not under test here
  renderSource: { reset() {}, recordLiveCopy() {}, needsLiveCopy() { return false; }, commitStoreRevision() {} }, storeRevisions: new Map(), storeReads: new Set(),
});
sim.worldWindow = world;
sim.onWorldHistoryRestore = (...delta) => notified.push(delta);
const rawBrick = encodeNativeBrick(Uint32Array.from({ length: 256 }, (_, i) => m.core[i % 4]), new Int32Array(64).fill(-456));
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

// Adversarial production-codec checks. No validators are replaced/injected.
// Start an actual WorldWindow.readBack before capture; it must finish despite
// the read lock. A new production shift during deferred preparation must fail.
app.win = world; sim.worldWindow = world;
sim.deco = { store: new Map([[23, new Uint8Array(256).fill(7)]]), pending: null, active: false };
decoWire.boot(app);
world.leave = { head: buffer({ size: 128, label: 'save leaving head' }), cells: buffer({ size: 2048, label: 'save leaving cells' }) };
world.lastKept = 0;
words(world.leave.head).set([1, 17]);
delayed = true;
world.readBack([17, 0, 0], [1, 1, 1], { revision: 0 }, world.leave, Promise.resolve([rawBrick]));
let prepareDone, prepareEntered, thumbnailDone, thumbnailEntered, prepareCalls = 0;
const entering = new Promise(resolve => { prepareEntered = resolve; });
const thumbnailStarted = new Promise(resolve => { thumbnailEntered = resolve; });
sim.prepare = () => { prepareEntered(); return new Promise(resolve => { prepareDone = resolve; }); };
const worldSaves = createSaves({ settings: app.settings, getSim: () => sim, getWin: () => world,
  header: () => ({ world: { scene: 'test', seed: 9 }, nativeDynamicsVersion: 1 }), prepareCapture: () => owner.ready,
  thumbnail: () => { thumbnailEntered(); return new Promise(resolve => { thumbnailDone = resolve; }); },
  prepare() { prepareCalls++; return false; }, finish() {}, onSettings() {} });
const coherentSave = worldSaves.capture('locked actual world');
assert.equal(world.historyReaders, 1, 'lock acquired before the first await');
while (pending.length) pending.shift()();
await entering;
assert(world.nativeStore.has(17), 'already-recorded leaving readback lands without deadlock');
const beforeShiftReads = reads.length;
assert.throws(() => world.shift(16, 0), /history capture/, 'new leaving readback cannot begin during prepare');
assert.equal(reads.length, beforeShiftReads);
delayed = false; prepareDone();
await thumbnailStarted;
assert.equal(world.historyReaders, 1, 'lock covers asynchronous section capture and thumbnail');
assert.throws(() => world.shift(16, 0), /history capture/);
thumbnailDone(null);
const coherentBytes = await coherentSave;
assert.equal(world.historyReaders, 0);
const coherent = await decodeSave(coherentBytes);
const capturedStore = new NativeBrickStore(wb); capturedStore.fromBytes(coherent.sections.get('worldNativeStore'));
assert.deepEqual(capturedStore.map.get(17), rawBrick, 'retained bytes cannot be omitted by preparation interleaving');
assert.equal(await worldSaves.apply(coherentBytes), null); assert.equal(prepareCalls, 1, 'valid baseline reaches prepare');
prepareCalls = 0;
sim.prepare = async () => { throw new Error('prepare failure'); };
await assert.rejects(worldSaves.capture('prepare failed'), /prepare failure/);
assert.equal(world.historyReaders, 0, 'prepare failure releases lock');
sim.prepare = async () => {};
registerSaveSection('strictFailureTest', { strict: true, save: () => { throw new Error('section failure'); }, load() {} });
const failedSectionSave = worldSaves.capture('section failed');
await assert.rejects(failedSectionSave, /section failure/);
unregisterSaveSection('strictFailureTest');
assert.equal(world.historyReaders, 0, 'strict-section failure releases lock');

const stateBefore = { epoch: world.epoch, identity: world.historyIdentity, origin: sim.origin.toArray(),
  legacy: world.store.map, native: world.nativeStore.map, deco: sim.deco.store,
  decoBytes: [...sim.deco.store].map(([key, bytes]) => [key, bytes.slice()]),
  legacyBytes: world.store.toBytes(), nativeBytes: world.nativeStore.toBytes(), planted: world.planted.slice(),
  core: words(owner.cells).slice(), bank: words(owner.aux).slice(), writes: writes.length };
function unchanged() {
  assert.equal(prepareCalls, 0, 'all rejection must precede app.prepare');
  assert.equal(world.epoch, stateBefore.epoch); assert.equal(world.historyIdentity, stateBefore.identity);
  assert.deepEqual(sim.origin.toArray(), stateBefore.origin);
  assert.equal(world.store.map, stateBefore.legacy); assert.equal(world.nativeStore.map, stateBefore.native);
  assert.equal(sim.deco.store, stateBefore.deco); assert.deepEqual([...sim.deco.store], stateBefore.decoBytes);
  assert.deepEqual(world.store.toBytes(), stateBefore.legacyBytes); assert.deepEqual(world.nativeStore.toBytes(), stateBefore.nativeBytes);
  assert.deepEqual(world.planted, stateBefore.planted); assert.deepEqual(words(owner.cells), stateBefore.core);
  assert.deepEqual(words(owner.aux), stateBefore.bank); assert.equal(writes.length, stateBefore.writes);
}
async function corruptSection(key, bytes) {
  const sections = new Map(coherent.sections); sections.set(key, bytes);
  await assert.rejects(worldSaves.apply(await encodeSave(coherent.header, [...sections].map(([key, data]) => ({ key, data })))));
  unchanged();
}
const malformedLegacy = new Uint8Array(4); new DataView(malformedLegacy.buffer).setUint32(0, 1, true);
await corruptSection('worldStore', malformedLegacy);
const malformedRun = new Uint8Array(15), runView = new DataView(malformedRun.buffer);
runView.setUint32(0, 1, true); runView.setUint32(4, 17, true); runView.setUint32(8, 3, true); malformedRun.set([127, 0, 0], 12);
await corruptSection('worldStore', malformedRun);
const trailingLegacy = new Uint8Array(stateBefore.legacyBytes.length + 1); trailingLegacy.set(stateBefore.legacyBytes);
await corruptSection('worldStore', trailingLegacy);
await corruptSection('worldPlanted', new Uint8Array(1));
await corruptSection('deco', new Uint8Array(1));
await corruptSection('decoStore', new Uint8Array(261));
await corruptSection('decoStore', new Uint8Array(520)); // duplicate key0
const badOrigin = { ...coherent.header, world: { ...coherent.header.world, origin: [1, 0, 0] } };
await assert.rejects(worldSaves.apply(await encodeSave(badOrigin, [...coherent.sections].map(([key, data]) => ({ key, data }))))); unchanged();
// Direct loadSaved must also preflight, not just the outer save controller.
for (const bad of [malformedLegacy, malformedRun, trailingLegacy]) {
  assert.throws(() => world.store.fromBytes(bad)); unchanged();
  assert.throws(() => world.loadSaved([16, 0, 0], () => { throw new Error('fill must not run'); }, bad, world.planted, null, stateBefore.nativeBytes));
  unchanged();
}
const mutations = [[0, ELEMENTS.length | (1173 << 8)], [0, E.WOOD | (PHASE_HOT_BASE << 8)], [1, MAX_FILL + 1], [2, 0x7c003c00]];
for (const [word, value] of mutations) {
  const bad = coherent.sections.get('worldNativeStore').slice();
  new DataView(bad.buffer).setUint32(12 + word * 4, value, true);
  await corruptSection('worldNativeStore', bad);
  assert.throws(() => world.nativeStore.fromBytes(bad)); unchanged();
  assert.throws(() => world.loadSaved([16, 0, 0], () => { throw new Error('fill must not run'); }, stateBefore.legacyBytes, world.planted, null, bad));
  unchanged();
}
// Forge raw dynamic payload bytes after valid encoding, so the real decoder
// (not just the encoder or a mocked validation callback) sees the corruption.
const dynamicBytes = coherent.sections.get('physicsV2Dynamics');
const dynamicView = new DataView(dynamicBytes.buffer, dynamicBytes.byteOffset, dynamicBytes.byteLength);
const metaLength = dynamicView.getUint32(8, true);
const metadata = JSON.parse(new TextDecoder().decode(dynamicBytes.subarray(16, 16 + metaLength)));
const arrayIndex = metadata.state.particles.$nativeWords;
const particleAt = Math.ceil((16 + metaLength) / 4) * 4 + metadata.lengths.slice(0, arrayIndex).reduce((a, n) => a + n * 4, 0);
for (const [word, value] of [...mutations.map(([word, value]) => [word + 7, value]), [4, 0x7fc00000],
  [19, 254 | ((RAYS.PHOTON_LIFE + 1) << 8)], [19, 254 | (ELEMENTS.length << 24)], [32, RAYS.NEUT_LIFE + 1]]) {
  const bad = dynamicBytes.slice(); new DataView(bad.buffer).setUint32(particleAt + word * 4, value, true);
  assert.throws(() => decodeDynamicState(bad));
  await corruptSection('physicsV2Dynamics', bad);
}
const badCore = coherent.sections.get('physicsV2').slice();
const coreView = new DataView(badCore.buffer), coreAt = 12 + coreView.getUint32(8, true);
coreView.setUint32(coreAt, E.WOOD | (PHASE_HOT_BASE << 8), true);
await corruptSection('physicsV2', badCore);
// Valid ABI boundaries stay exact, including maximum16-bit fuel and banks
// whose integer bits would be NaN if somebody treated them as float data.
const boundary = makeMaterial(E.WATER, 22, MAX_FILL);
boundary.core[3] = 0xffff3800;
const exact = Uint32Array.from({ length: 256 }, (_, i) => boundary.core[i % 4]);
const boundaryBytes = encodeNativeBrick(exact, new Int32Array(64).fill(0x7fc00001));
const boundaryStore = new NativeBrickStore(wb); boundaryStore.put(0, boundaryBytes);
const boundaryRestored = new NativeBrickStore(wb); boundaryRestored.fromBytes(boundaryStore.toBytes());
assert.deepEqual(boundaryRestored.map.get(0), boundaryBytes);
console.log('adversarial persistence: coherent lock before await through sections; prior real readBack completes; new shifts blocked; transactional legacy/native/deco/core/dynamic/origin rejection before prepare, epoch, stores or GPU writes');
console.log('dynamic persistence CPU: actual contact+dynamics constructors; synchronous mixed-state capture; exact binary/save/undo restoration; pre-mutation corruption/origin rejection; full shifted COW world history; physgun held/shock/controller fields; actual-air probe/body SI boundaries and lossless refusal passed');
