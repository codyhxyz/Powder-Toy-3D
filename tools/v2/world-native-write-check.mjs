// CPU-only: World's writers under Physics V2 write V2's cells natively (shaders/v2/worldWrite.js), never
// V1's state for V2 to import. The production methods run on stand-ins that record their dispatches.
//   (1) the generator's fill, while V2 runs the window, is one native fill over its box: no V1 edit
//       (so no export of V1's cache before it, no import after it), noted as an edit;
//   (2) a world's load notes no whole-grid write under V2 (that would reimport V1's cache over the
//       fill), and leaves V1's cache to be rewritten whole by its next export;
//   (3) the stored bricks coming back into a V2 window: the ones its native store keeps come back
//       exact (restoreNative) and V1's copies of them only leave the store; a brick only V1's store
//       holds (a V1-made save) is still written;
//   (4) the kernels validate in Naga.
// No GPU, browser or WebGPU execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldGenerator } from '../../src/world/gpu.js';
import { WorldWindow } from '../../src/world/window.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from '../../src/world/store.js';
import { NativeBrickStore } from '../../src/world/nativeStore.js';
import { gridDims } from '../../src/shaders/common.js';
import { WGSL_CHECK } from '../../src/shaders/v2/worldWrite.js';
import { assertNaga } from './wgsl-grouping.mjs';

globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x04, COPY_DST: 0x08 };
const g = gridDims({ nx: 32, ny: 32, nz: 32 });
function fakeSim({ v2 = true } = {}) {
  const log = [];
  const owner = { isReady: true, cells: { name: 'cores' }, aux: { name: 'banks' }, act: { name: 'act' }, syncs: 0, sync() { this.syncs++; log.push('sync'); }, wake() {} };
  const gpu = { layout: (_n, e) => e, bindGroup: (layout, entries) => ({ layout, entries }), write() {}, createBuffer: ({ size }) => ({ size }), stats: { flushes: 0 } };
  const sim = { g, gpu, version: 0, wholeWrites: 0, tables: {}, L: { TABLES: [] }, compact: v2 ? owner : null, compactOwner: owner, origin: { x: 64, y: 0, z: 32 },
    nativeIntegration: { isReady: true }, changedAll: false, wake() {}, _retire() {},
    _dispatch(k, size, opts) { log.push(['dispatch', k.name, opts]); },
    edit(k, box, values, opts) { log.push(['edit', k.name, box, values, opts]); this.version++; },
    header() { return { origin: [this.origin.x, this.origin.y, this.origin.z], src: 0, dst: 0 }; },
    noteWrite({ replaceState = true } = {}) { this.version++; if (replaceState) this.wholeWrites++; } };
  return { sim, owner, log };
}
function fakeGenerator(sim) {
  const gen = Object.create(WorldGenerator.prototype);
  return Object.assign(gen, { sim, scene: { key: 'island' }, P: { k: 1 }, code: '',
    res: { has: { data: false }, layout: [], data: null, prepassFor() {}, entries: () => [], resources: [] },
    kernels: { fill: { name: 'island fill' }, nativeFill: { name: 'island native fill', state: 'ready' } } });
}

test('(1) under V2 the generator fills V2\'s cells natively: one native fill over its box, no V1 edit', () => {
  const { sim, owner, log } = fakeSim(), gen = fakeGenerator(sim);
  gen.fill(gen.P, [64, 0, 32], [16, 0, 0], [32, 32, 32], { residency: true });
  const d = log.filter((e) => e[0] === 'dispatch'), edits = log.filter((e) => e[0] === 'edit');
  assert.equal(edits.length, 0, 'no V1 edit (and so no export of V1\'s cache, no import)');
  assert.equal(d.length, 1); assert.equal(d[0][1], 'island native fill');
  assert.deepEqual(d[0][2].params, { origin: [64, 0, 32], lo: [16, 0, 0], hi: [32, 32, 32] });
  assert.deepEqual(d[0][2].bind[1].entries.map((e) => e.resource.buffer), [owner.cells, owner.aux, owner.act], 'V2\'s cores, banks and activity');
  assert(log.indexOf('sync') < log.indexOf(d[0]), 'V1 writes before it are imported first');
  assert.equal(sim.version, 1, 'noted as an edit'); assert.equal(sim.wholeWrites, 0, 'not a whole-grid write');
  // Under V1 (or a V2 owner suspended) the fill is V1's edit, as before.
  const v1 = fakeSim({ v2: false }), gen1 = fakeGenerator(v1.sim);
  gen1.fill(gen1.P, [64, 0, 32], [16, 0, 0], [32, 32, 32]);
  assert.deepEqual(v1.log.filter((e) => e[0] === 'edit').map((e) => e[1]), ['island fill']);
  assert.equal(v1.log.filter((e) => e[0] === 'dispatch').length, 0);
});

test('(2) a world\'s load under V2 notes no whole-grid write; V1\'s cache is rewritten whole by its next export', () => {
  const { sim, owner } = fakeSim(), order = [];
  const win = Object.assign(Object.create(WorldWindow.prototype), { sim, gpu: { frame: {} }, epoch: 0, P: {}, scene: { reset() {} }, planted: new Uint8Array(4),
    store: { clear() {} }, nativeStore: { clear() {} }, storeRevisions: new Map(), renderSource: { reset() {}, recordLiveCopy() { order.push('live'); } },
    gen: { fill() { order.push('fill'); } } });
  sim.origin.set = function (x, y, z) { Object.assign(this, { x, y, z }); };
  Object.assign(sim, { resetNativeDynamics() {}, dropHistory() {}, stillFlow() {} });
  owner.legacyNative = false;
  win.load([0, 0, 0]);
  assert.deepEqual(order, ['fill', 'live']);
  assert.equal(sim.wholeWrites, 0, 'no whole-grid write: V2 would reimport V1\'s cache over its cells');
  assert.equal(owner.legacyNative, undefined, 'V1\'s cache (the old origin\'s projection) is stale everywhere');
});

test('(3) stored bricks back into a V2 window: the native store\'s come back exact; V1\'s copies only leave the store', () => {
  const { sim, log } = fakeSim(), wb = [32, 8, 32];
  const store = new BrickStore(wb), nativeStore = new NativeBrickStore(wb), a = new Float32Array(BRICK_FLOATS), b = new Float32Array(BRICK_FLOATS);
  const k1 = store.key(16, 0, 8), k2 = store.key(17, 0, 8);   // world bricks of window bricks (0, 0, 0) and (1, 0, 0)
  store.put(k1, encodeBrick(a, 0, b, 0)); store.put(k2, encodeBrick(a, 0, b, 0));
  nativeStore.put(nativeStore.key(16, 0, 8), new Uint8Array(1280));   // k1 kept exact; k2 only by V1 (a V1-made save)
  const writes = [];
  const win = Object.assign(Object.create(WorldWindow.prototype), { sim, store, nativeStore, restoreKernel: { name: 'restore' }, restoreBuf: null, restoreRead: -1,
    gpu: { createBuffer: ({ size }) => ({ size }), write(buf, at, data) { writes.push(data); }, stats: { flushes: 0 } } });
  assert.equal(win.restore([0, 0, 0], [2, 1, 1]), 2, 'both bricks come back');
  const edits = log.filter((e) => e[0] === 'edit');
  assert.equal(edits.length, 1, 'V1\'s restore writes only the brick no native store kept');
  assert.deepEqual([...writes[0].subarray(0, 2)], [0, 1], 'its index names window brick 1 alone');
  assert(!store.has(k1) && !store.has(k2), 'both leave V1\'s store');
  assert(nativeStore.map.has(nativeStore.key(16, 0, 8)), 'the exact brick waits for restoreNative');
  // V1 running: every stored brick is V1's to write, as before.
  const v1 = fakeSim({ v2: false }), store1 = new BrickStore(wb);
  store1.put(k1, encodeBrick(a, 0, b, 0)); store1.put(k2, encodeBrick(a, 0, b, 0));
  const w1 = Object.assign(Object.create(WorldWindow.prototype), { sim: v1.sim, store: store1, nativeStore, restoreKernel: { name: 'restore' }, restoreBuf: null, restoreRead: -1,
    gpu: { createBuffer: ({ size }) => ({ size }), write() {}, stats: { flushes: 0 } } });
  w1.restore([0, 0, 0], [2, 1, 1]);
  assert.equal(v1.log.filter((e) => e[0] === 'edit').length, 1);
});

test('(4) the native world writers validate in Naga', () => {
  const big = gridDims({ nx: 128, ny: 128, nz: 128 });
  for (const e of WGSL_CHECK()) if (!e.name.endsWith('native fill') || e.name.startsWith('island')) assertNaga(e.code(big), e.name);
});
