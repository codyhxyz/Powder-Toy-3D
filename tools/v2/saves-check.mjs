import { NativeBrickStore, encodeNativeBrick } from '../../src/world/nativeStore.js';
import { BrickStore } from '../../src/world/store.js';
import { WorldWindow } from '../../src/world/window.js';
// CPU-only: exact compact codec + the real save-section registration/game container.
// GPU dispatch/upload is covered by compact-check; live continuation by the documented app plan.
import assert from 'node:assert/strict';
import { encodeV2State, decodeV2State, stateLengths, V2_STATE_VERSION } from '../../src/v2/state.js';
import { encodeSave, decodeSave, readSaveHeader } from '../../src/saves/format.js';
import { createSaves } from '../../src/saves/game.js';
import savesWire from '../../src/wire/saves.js';
import { gridLayout } from '../../src/sim.js';
import { E } from '../../src/elements.js';

const dims = [32, 32, 32], lengths = stateLengths(dims, true);
const state = { dims, mode: 'v2', tick: 713, acc: 0.375, frame: 819, paints: 23, certified: false, writtenSinceTick: true };
for (const [key, n] of Object.entries(lengths)) state[key] = new Uint32Array(n);
// Fractional fill, compression above FULL, signed/half flux, age, seed, temperatures,
// NaN-like payloads: these are words, never a floating-point serialization.
state.cells.set([0x04950103, 12345, 0xbc007c00, 0xffff3800,
  0xff015503, 65536 + 6553, 0x800100ff, 0x7fc00001,
  0x3f002a01, 0x00803500, 0x7f800001, 0xfefa0000]);
state.aux.set([0xffffffff, 0x7fc00001, 0x80000000, 0xdeadbeef]);
state.activity[0] = 1;
state.args[12] = state.tick;
const bytes = encodeV2State(state);
assert.deepEqual(decodeV2State(bytes, dims), { ...state, hasAux: true, energyLedger: true, version: V2_STATE_VERSION });
const oversizedFill = new Uint32Array(state.cells);
oversizedFill[0] = E.WATER | (1173 << 8);
oversizedFill[1] = 0xffffff;
assert.throws(() => decodeV2State(encodeV2State({ ...state, cells: oversizedFill })), /fill exceeds compression limit/);
const padded = new Uint8Array(bytes.length + 9); padded.set(bytes, 5);
assert.deepEqual(decodeV2State(padded.subarray(5, 5 + bytes.length), dims).cells, state.cells);
assert.throws(() => encodeV2State({ ...state, cells: state.cells.subarray(4) }), /length/);
assert.throws(() => encodeV2State({ ...state, aux: state.aux.subarray(1) }), /length/);
assert.throws(() => encodeV2State({ ...state, aux: new Float32Array(state.aux.length) }), /type/);
const { aux: omittedAux, ...coreOnly } = state;
assert(decodeV2State(encodeV2State(coreOnly)).aux.every(word => word === 0), 'old core-only state has zero auxiliary words');
assert.throws(() => encodeV2State({ ...state, cells: new Float32Array(state.cells.length) }), /type/);
for (const bad of [-1, NaN, Infinity, 1]) assert.throws(() => encodeV2State({ ...state, acc: bad }), /accumulator/);
for (const bad of [-1, NaN, Infinity, 1.25]) assert.throws(() => encodeV2State({ ...state, tick: bad }), /tick/);
for (const n of [0, 1, 11, 12, 100, bytes.length - 1, bytes.length - 4]) assert.throws(() => decodeV2State(bytes.subarray(0, n), dims), /v2 state/);
assert.throws(() => decodeV2State(new Uint8Array(bytes.length + 1), dims), /magic/);
assert.throws(() => decodeV2State(bytes, [64, 32, 32]), /dimensions/);
assert.throws(() => decodeV2State(new Float32Array(bytes.length), dims), /invalid/);
for (const [offset, value, re] of [[0, 0, /magic/], [4, V2_STATE_VERSION + 1, /version/], [8, 0xffffffff, /length/]]) {
  const bad = bytes.slice(); new DataView(bad.buffer).setUint32(offset, value, true);
  assert.throws(() => decodeV2State(bad, dims), re);
}
const badJSON = bytes.slice(); badJSON[12] = 0xff;
assert.throws(() => decodeV2State(badJSON, dims), /malformed/);
const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
assert.throws(() => decodeV2State(trailing, dims), /length/);

const g = gridLayout(...dims), events = [];
let restored = null, mode = 'v2', stored = bytes;
const engine = {
  ready: Promise.resolve(),
  captureState(m) { events.push('compact capture'); return Promise.resolve(encodeV2State({ ...decodeV2State(stored), mode: m })); },
  restoreState(b) { events.push('restore compact'); restored = decodeV2State(b, dims); stored = b; },
  resync() { events.push('legacy resync'); },
};
const sim = {
  g, rays: {},
  async prepare() {},
  blankState: () => [new Float32Array(g.width * g.height * 4), new Float32Array(g.width * g.height * 4)],
  readState() { events.push('legacy capture'); return Promise.resolve(this.blankState()); },
  load() { events.push('legacy load'); },
};
const app = {
  settings: {}, sim, day: { clock: 0 },
  get physics() { return { mode, v2: engine }; },
  async setPhysics(m) { events.push(`engine ${m}`); mode = m; },
  camState: () => 'pov', setSimModes() {}, resetSimModes() {}, updateSun() {},
};
savesWire.boot(app); // registers the real strict physicsV2 section, not a test copy
const saves = createSaves({
  settings: app.settings, getSim: () => sim, getWin: () => null,
  header: () => ({ name: 'fractional', size: 'test', world: null }),
  prepareCapture: () => engine.ready,
  prepare() { events.push('prepare'); return true; }, finish() { events.push('finish'); }, onSettings() {},
});
const saved = await saves.capture('exact');
assert.deepEqual(events.slice(0, 2), ['legacy capture', 'compact capture'], 'readbacks start in the same task');
const decoded = await decodeSave(saved);
assert.deepEqual(decodeV2State(decoded.sections.get('physicsV2')).cells, state.cells);
mode = 'v1'; events.length = 0;
await saves.apply(saved);
assert.deepEqual(restored.cells, state.cells);
assert.deepEqual(restored.aux, state.aux);
assert.deepEqual(restored.activity, state.activity);
assert.deepEqual(restored.args, state.args);
for (const k of ['tick', 'acc', 'frame', 'paints']) assert.equal(restored[k], state[k]);
assert(events.indexOf('engine v2') < events.indexOf('restore compact'));
assert(events.indexOf('legacy load') < events.indexOf('restore compact'));
assert.equal(mode, 'v2');

// Save while temporarily in v1: the retained compact owner is included and v1 returns on load.
mode = 'v1';
const switched = await saves.capture('suspended');
mode = 'v2'; events.length = 0;
await saves.apply(switched);
assert.equal(mode, 'v1');
assert.deepEqual(restored.cells, state.cells);
assert.deepEqual(restored.aux, state.aux);
assert.deepEqual(events.filter(e => e.startsWith('engine') || e === 'restore compact'), ['engine v2', 'restore compact', 'engine v1']);

// Older files keep their intentional legacy replacement semantics.
const old = await encodeSave(decoded.header, [...decoded.sections].filter(([key]) => key !== 'physicsV2').map(([key, data]) => ({ key, data })));
events.length = 0;
await saves.apply(old);
assert(events.includes('legacy resync'));
assert(!events.includes('restore compact'));

// Validation happens before prepare(), so corrupt input cannot replace the running scene.
const sections = [...decoded.sections].map(([key, data]) => ({ key, data }));
for (const bad of [bytes.subarray(0, bytes.length - 1), badJSON, trailing]) {
  const corrupt = await encodeSave(decoded.header, sections.map(s => s.key === 'physicsV2' ? { ...s, data: bad } : s));
  events.length = 0;
  await assert.rejects(saves.apply(corrupt), /v2 state/);
  assert(!events.includes('prepare'));
}
await assert.rejects(decodeSave(saved.subarray(0, saved.length - 1)));
// Malformed container descriptors, duplicate keys and unsupported payload types are rejected.
function editHeader(file, edit) {
  const h = readSaveHeader(file); delete h.bodyAt;
  edit(h);
  const json = new TextEncoder().encode(JSON.stringify(h));
  const body = file.subarray(readSaveHeader(file).bodyAt);
  const out = new Uint8Array(16 + json.length + body.length);
  out.set(file.subarray(0, 16)); new DataView(out.buffer).setUint32(12, json.length, true);
  out.set(json, 16); out.set(body, 16 + json.length);
  return out;
}
for (const edit of [h => { h.sections[0].size = -1; }, h => { h.sections[0].raw = 0.5; }, h => { h.sections[1].key = h.sections[0].key; }, h => { h.sections = {}; }]) {
  await assert.rejects(decodeSave(editHeader(saved, edit)), /invalid/);
}
events.length = 0;
await assert.rejects(saves.apply(editHeader(saved, h => { h.sections.find(s => s.key === 'physicsV2').type = 'future'; })), /v2 state/);
assert(!events.includes('prepare'));
const wrapper = new Uint8Array(saved.length + 8); wrapper.set(saved, 4);
assert.deepEqual((await decodeSave(new DataView(wrapper.buffer, 4, saved.length))).sections.get('physicsV2'), decoded.sections.get('physicsV2'));
// Native world stores are a separate strict section, captured with the
// window and restored through the actual WorldWindow.loadSaved path.
sim.origin = { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } };
sim.dropHistory = () => {};
const world = Object.assign(Object.create(WorldWindow.prototype), {
  sim, loaded: true, pending: null, size: [64, 32, 64], epoch: 0,
  store: new BrickStore([16, 8, 16]), nativeStore: new NativeBrickStore([16, 8, 16]), planted: new Uint8Array(16 * 16),
});
const nativeBrick = encodeNativeBrick(Uint32Array.from({ length: 256 }, (_, i) => [E.WATER | (1173 << 8), 0x12345, 0xbc003c00, 0xffff3800][i % 4]), new Int32Array(64).fill(-321));
world.nativeStore.put(7, nativeBrick); world.planted[4] = 1;
const worlds = createSaves({
  settings: app.settings, getSim: () => sim, getWin: () => world,
  header: () => ({ name: 'native world', size: 'test', world: { scene: 'island', seed: 9 } }),
  prepareCapture: () => engine.ready,
  prepare() { events.push('prepare'); return true; }, finish() {}, onSettings() {},
});
const worldSave = await worlds.capture('retained material');
world.nativeStore.clear(); world.planted.fill(0);
await worlds.apply(worldSave);
assert.deepEqual(world.nativeStore.map.get(7), nativeBrick);
assert.equal(world.planted[4], 1);
assert.deepEqual(restored.cells, state.cells);
for (const change of [h => { h.sections.find(s => s.key === 'worldNativeStore').type = 'future'; },
  h => { h.world.size[0] = 63; }]) {
  events.length = 0;
  await assert.rejects(worlds.apply(editHeader(worldSave, change)), /[Nn]ative/);
  assert(!events.includes('prepare'), 'native world corruption rejects before any scene mutation');
}
world.persistenceError = new Error('readback failed');
await assert.rejects(worlds.capture('must not lose data'), /readback failed/);
console.log('v2 saves CPU checks passed: raw words/clock/activity, real section + container round trips, suspended mode, old saves, native world retained state, pre-mutation corruption rejection');
