import decoWire from '../../src/wire/deco.js';
import { coupleNativeBody, bodyEditStepRate, nativeBodyPressureFactor } from '../../src/v2/body.js';
import { LEGACY_PRESSURE_PA, CELL_M } from '../../src/v2/dynamics-reference.js';
import { povGpu } from '../../src/pov/gpu.js';
import { WorldWindow } from '../../src/world/window.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from '../../src/world/store.js';
import { NativeBrickStore, encodeNativeBrick } from '../../src/world/nativeStore.js';
import { heldBase, shockBase, setOffBase } from '../../src/shaders/v2/particles.js';
import { windowMoveReference } from './window-move-reference.mjs';
// CPU-only: actual foundation/contact/dynamics constructors and save/undo
// orchestration. GPU commands copy mock bytes; WGSL execution is NOT emulated.
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Simulation, gridLayout } from '../../src/sim.js';
import { marksLayout, cellSlot, brickIdOf } from '../../src/shaders/common.js';
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
import savesWire, { nativeSaveLoad } from '../../src/wire/saves.js';
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
  kernel: ({ name, code }) => ({ name, code, state: 'ready', ready: Promise.resolve(), dispatch(_f, _n, opts) { dispatches.push({ name, opts });
    if (name === 'v2window_move') windowMoveReference(g, words, opts.bind, opts.params); } }),
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
// a charge a hit set off this tick (particles.js dShockHit: its slot's id until it lands), and a stale
// mark left in slot 1 by an earlier packet
words(d.control)[setOffBase(g)] = 101; words(d.control)[setOffBase(g) + 1] = 999;
owner.tick = 17; owner.acc = 0.375; sim.frame = 23; sim.paints = 11;
const start = reads.length;
const capture = captureNativeSnapshot(owner, 'v2');
assert.equal(reads.length - start, 9, 'core/aux/activity/args, four dynamics copies and the flying matter\'s decoration enqueue before first await');
const oldCore = words(owner.cells).slice(), oldParticles = words(d.particles).slice();
words(owner.cells).fill(0); words(d.particles).fill(0); d.airArchive.clear(); d.pendingOutside.clear(); d.rayRequests.clear();
while (pending.length) pending.shift()();
const snapshot = await capture;
assert.deepEqual(decodeV2State(snapshot.core).cells, oldCore);
assert.deepEqual(snapshot.dynamic.particles, oldParticles);
assert.equal(snapshot.dynamic.held[0], snapshot.dynamic.holdSession.token);
assert.equal(snapshot.dynamic.shocks[0], 73);
assert.equal(snapshot.dynamic.setOff[0], 101, 'a set-off mark is saved with its flying charge');
assert.equal(snapshot.dynamic.setOff[1], 0, 'a stale mark (not its slot\'s id) is dropped');
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
assert.equal(words(d.control)[setOffBase(g)], 101, 'the restored charge is still set off: it goes off where it lands');
assert.equal(words(d.control)[setOffBase(g) + 1], 0);
// a save from before the marks were saved restores with none set off; a mark naming another slot's id is corrupt
const beforeMarks = { ...decoded }; delete beforeMarks.setOff;
restoreNativeSnapshot(owner, { ...snapshot, dynamic: decodeDynamicState(encodeDynamicState(beforeMarks), { dims: [32, 32, 32], origin: [0, 0, 0] }) });
assert.equal(words(d.control)[setOffBase(g)], 0);
const wrongMark = { ...decoded, setOff: decoded.setOff.slice() }; wrongMark.setOff[2] = 7;
assert.throws(() => restoreNativeSnapshot(owner, { ...snapshot, dynamic: wrongMark }), /set-off/);
restoreNativeSnapshot(owner, snapshot);
assert.equal(words(d.control)[setOffBase(g)], 101);

// A V2 undo entry is GPU copies taken with the stroke (C9): no readback, no legacy projection, no
// A/B copy, and an undo right after it waits for nothing. It brings every dynamic word back.
delayed = true;
{
  const readsBefore = reads.length, bridges = dispatches.filter(x => x.name === 'v2bridge').length;
  sim.snapshot('mixed native');
  assert.equal(reads.length, readsBefore, 'a stroke start reads nothing back');
  assert.equal(dispatches.filter(x => x.name === 'v2bridge').length, bridges, 'nor exports the legacy projection');
  assert.equal(sim.history.at(-1).A ?? null, null, 'nor copies the A/B projection');
  const air = words(d.air[d.airIndex]).slice();
  words(owner.cells).fill(0); words(d.particles).fill(0); words(owner.events).fill(0); words(d.air[d.airIndex]).fill(0);
  d.pendingOutside.clear(); d.airArchive.clear(); d.rayRequests.clear();
  assert.equal(sim.undo(), true, 'an undo right after the stroke takes it back at once');
  assert.deepEqual(words(owner.cells), oldCore); assert.deepEqual(words(d.particles), oldParticles);
  assert.deepEqual(words(d.air[0]), air); assert.deepEqual(words(d.air[1]), air);
  assert.equal(words(owner.events)[3], 7); assert.equal(d.pendingOutside.get('129,2,3'), 5);
  assert(d.airArchive.has('128,0,0')); assert.equal(d.rayRequests.size, 1);
  assert.equal(sim.history.length, 0);
}
// An undo across a move is V1's (M4: sim.js undo, undoShift): the cells the entry's window shares with
// this one come back, with the flying matter, air and requests over them; everything else keeps what it
// holds and the window stays where it is. Without a shared cell it does nothing and keeps the entry.
await sim.prepareNative(owner);
delayed = false;
{
  const fbits = n => new Uint32Array(new Float32Array([n]).buffer)[0];
  const grain = (x, id) => new Uint32Array(packParticle({ position: [x, 3, 4], velocity: [0, -1, 0], id, core: [...m.core], bank: -73 }));
  const P = words(d.particles), A = () => new Float32Array(d.air[d.airIndex].bytes), slotAt = (x, y, z) => cellSlot(g, x, y, z);
  P.fill(0); P.set(grain(20.5, 201), 0); P.set(grain(5.5, 202), 12);         // shared (world x 16..31) and old-only
  words(owner.events).fill(0); words(owner.events)[slotAt(20, 3, 4)] = 4; words(owner.events)[slotAt(5, 3, 4)] = 2;
  A().fill(0); A()[brickIdOf(g, 5, 0, 1) * 8] = 11; A()[brickIdOf(g, 1, 0, 1) * 8] = 22;   // world bricks x 20 and x 4
  sim.snapshot('before the walk');
  // the walk: the window moves 16 cells east (its cells and dynamics as a move leaves them)
  sim.origin.x = 16; d.origin = [16, 0, 0];
  P.fill(0); P.set(grain(25.5, 301), 0); P.set(grain(40.5, 302), 24);          // over the shared cells, and past them
  words(owner.events).fill(0); words(owner.events)[slotAt(9, 3, 4)] = 8; words(owner.events)[slotAt(26, 3, 4)] = 1;
  A().fill(0); A()[brickIdOf(g, 2, 0, 1) * 8] = 33; A()[brickIdOf(g, 6, 0, 1) * 8] = 44;  // world bricks x 24 and x 40
  assert.equal(sim.undo(), true);
  assert.equal(sim.origin.x, 16, 'the window stays where it is'); assert.deepEqual(d.origin, [16, 0, 0]);
  const ids = [0, 1, 2].map(i => P[i * 12 + 3]);
  assert.deepEqual(ids, [201, 0, 302], 'the shared cells\' flying matter is the entry\'s; past them it is today\'s');
  assert.equal(words(d.control)[0], 2, 'the live count matches the records');
  assert.equal(words(owner.events)[slotAt(4, 3, 4)], 4, 'a shared cell\'s request comes back where its cell is now');
  assert.equal(words(owner.events)[slotAt(9, 3, 4)], 0, 'and one made there since goes');
  assert.equal(words(owner.events)[slotAt(26, 3, 4)], 1, 'a cell the entry never held keeps its request');
  assert.equal(A()[brickIdOf(g, 1, 0, 1) * 8], 11, 'a shared brick\'s air is the entry\'s'); assert.equal(A()[brickIdOf(g, 2, 0, 1) * 8], 0);
  assert.equal(A()[brickIdOf(g, 6, 0, 1) * 8], 44, 'past the shared cells the air is today\'s');
  sim.snapshot('far away'); sim.origin.x = 64; d.origin = [64, 0, 0];
  assert.equal(sim.undo(), false, 'no shared cell: nothing happens'); assert.equal(sim.history.length, 1, 'and the entry waits');
  sim.origin.x = 0; d.origin = [0, 0, 0]; sim.dropHistory();
  restoreNativeSnapshot(owner, snapshot);   // (the state the save checks below expect)
}

// The World window's state for the save checks below.
const wb = [32, 8, 32];
const world = Object.assign(Object.create(WorldWindow.prototype), { sim, gpu, scene: {}, size: [128, 32, 128], wb,
  historyIdentity: {}, historyReaders: 0, epoch: 1, pending: null, loaded: true,
  store: new BrickStore(wb), nativeStore: new NativeBrickStore(wb), planted: new Uint8Array(wb[0] * wb[2]),
  far: { build() {} },
  // main's World render source (src/world/renderSource.js): not under test here
  renderSource: { reset() {}, recordLiveCopy() {}, needsLiveCopy() { return false; }, commitStoreRevision() {} }, storeRevisions: new Map(), storeReads: new Set(),
});
const rawBrick = encodeNativeBrick(Uint32Array.from({ length: 256 }, (_, i) => m.core[i % 4]), new Int32Array(64).fill(-456));
// A World move under V2 is made in the frame, as V1's (S1): update() returns the move, not a promise to wait on.
{
  let shifted = null;
  const moving = Object.assign(Object.create(world), { _shiftCommitted(dx, dz) { shifted = [dx, dz]; },
    gen: { prepareNativeDiff() {} }, far: { tick() {} } });
  sim.deco = null;
  const move = moving.update(sim.origin.x + 16 + 40, sim.origin.z + 16);
  assert.deepEqual(move, [16, 0], 'the window moves in this frame'); assert.deepEqual(shifted, [16, 0]);
  assert.equal(sim.nativeTransition ?? null, null, 'and nothing waits on it');
}
// Real strict save registrations and game preflight: malformed dynamics must
// fail before app.prepare, legacy cells, or core state are touched.
delayed = false;
const events = [], app = { sim, settings: {}, day: { clock: 0 }, physics: { mode: 'v2', v2: owner },
  camState: () => 'pov', setSimModes() {}, resetSimModes() {}, updateSun() {} };
savesWire.boot(app);
sim.prepare = async () => {};
sim.blankState = () => [new Float32Array(g.width * g.height * 4), new Float32Array(g.width * g.height * 4)];
sim.readState = async () => sim.blankState();
sim.readSaveState = async () => sim.blankState();   // (a save's cells under V2: sim.readSaveState reads V2's own)
sim.load = () => events.push('legacy load');
const saves = createSaves({ settings: app.settings, getSim: () => sim, getWin: () => null,
  header: () => ({ world: null, nativeDynamicsVersion: 1 }), prepareCapture: () => owner.ready,
  prepare: () => { events.push('prepare'); return true; }, finish() {}, onSettings() {}, nativeLoad: nativeSaveLoad(app) });
const saved = await saves.capture('mixed native');
const file = await decodeSave(saved);
assert(file.sections.has('physicsV2Dynamics'));
const broken = await encodeSave(file.header, [...file.sections].map(([key, data]) => ({ key,
  data: key === 'physicsV2Dynamics' ? data.subarray(0, data.length - 1) : data })));
n = writes.length; await assert.rejects(saves.apply(broken)); assert.equal(events.length, 0); assert.equal(writes.length, n);
const missing = await encodeSave(file.header, [...file.sections].filter(([key]) => key !== 'physicsV2Dynamics').map(([key, data]) => ({ key, data })));
await assert.rejects(saves.apply(missing)); assert.equal(events.length, 0);
await saves.apply(saved);
assert(!events.includes('legacy load'), 'a V2 save in a V2 session restores V2\'s words without writing V1\'s cells first (sim.loadNative)');
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
sim.compact = null;   // (before the owner presents the grid: the V1-format cache)
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
// A World move under V2 (the integration's shift: cores, then the dynamics and the legacy words with
// them): a brick's legacy word moves with it, only the uncovered slab is stale, and nothing marks the
// whole window again after (shifted). Before, each move marked every brick stale two or three times, so
// the next exports converted the whole window. Its requests and air move with the cells too.
{
  const act = words(owner.act), A = owner.layout, I = sim.nativeIntegration;
  sim.worldWindow = null; sim.origin.set(0, 0, 0); d.origin = [0, 0, 0]; d.airArchive.clear(); d.pendingOutside.clear();
  act.fill(0, A.legacy, A.legacy + g.nbricks);
  const moved = brickIdOf(g, 5, 2, 3), lands = brickIdOf(g, 1, 2, 3);   // world brick x 20 lands at window brick x 4
  act[A.legacy + moved] = 2;   // (LEGACY_WORD.DIFFERS: its projection is current; a switch converts it)
  words(owner.events).fill(0); words(owner.events)[cellSlot(g, 21, 9, 13)] = 4;
  new Float32Array(d.air[d.airIndex].bytes).fill(0); new Float32Array(d.air[d.airIndex].bytes)[moved * 8] = 7;
  const landing = I.shift(16, 0); I.shifted(); sim.origin.x = 16;
  const legacy = [...act.subarray(A.legacy, A.legacy + g.nbricks)];
  assert.equal(legacy[lands], 2, 'a brick\'s legacy word moves with it');
  const stale = legacy.filter(w => w === 1).length;
  assert.equal(stale, (16 / 4) * (g.ny / 4) * (g.nz / 4), 'only the uncovered slab is stale');
  assert.equal(words(owner.events)[cellSlot(g, 5, 9, 13)], 4, 'a request moves with its cell');
  assert.equal(new Float32Array(d.air[0].bytes)[lands * 8], 7, 'a brick\'s air moves with it');
  assert.deepEqual(d.origin, [16, 0, 0]);
  await landing;
  sim.origin.x = 0;
}
console.log('adversarial persistence: coherent lock before await through sections; prior real readBack completes; new shifts blocked; transactional legacy/native/deco/core/dynamic/origin rejection before prepare, epoch, stores or GPU writes');
console.log('dynamic persistence CPU: actual contact+dynamics constructors; synchronous mixed-state capture; exact binary/save restoration; readback-free undo entries; V1 undo across a move (shared cells, their flying matter, air and requests); in-frame World moves (legacy words, requests and air move with their cells, only the uncovered slab stale); pre-mutation corruption/origin rejection; physgun held/shock/controller fields; actual-air probe/body SI boundaries and lossless refusal passed');
