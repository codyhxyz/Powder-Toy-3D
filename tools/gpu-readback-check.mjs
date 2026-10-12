// CPU-only lifecycle checks: stale/failing reads must never republish data.
// The birds' probe (src/birds/probe.js) on a stand-in gpu: its readback
// (gpu.readback.buffer) resolves or rejects when the test says so, and a lost
// device (gpu.lost) takes no work.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gridLayout } from '../src/sim.js';
import { createBirdWorld } from '../src/birds/probe.js';
import { WorldWindow } from '../src/world/window.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { E } from '../src/elements.js';
const flush = () => new Promise(resolve => setImmediate(resolve));
globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x4, COPY_DST: 0x8 };
let lost = false, passes = 0, pending;
const gpu = {
  get lost() { return lost; },
  failure: null,
  frame: {},
  layout: (name) => ({ name }),
  bindGroup: () => ({}),
  createBuffer: ({ size }) => ({ size, destroy() {} }),
  kernel: () => ({ state: 'ready', ready: Promise.resolve(), dispatch: () => passes++ }),
  readback: {
    // the probe's columns: (top, id, rise, hot) per column; column 0 is ground 8 of wood
    buffer(_src, _off, size, { into } = {}) {
      const out = into ?? new ArrayBuffer(size);
      new Float32Array(out).set([8, E.WOOD, 6, 0]);
      return new Promise((resolve, reject) => { pending = { resolve: () => resolve(out), reject }; });
    },
  },
};
const sim = {
  g: gridLayout(16, 16, 16), gpu, origin: new THREE.Vector3(), L: {}, tables: {}, bindRO: {}, header: () => ({}),
};
const probe = createBirdWorld({ getSim: () => sim, getWin: () => null });
probe.update(1);
probe.reset();
pending.resolve();
await flush();
assert(!probe.ready, 'reset rejects stale completion');
probe.update(1);
pending.resolve();
await flush();
assert(probe.ready);
assert.equal(probe.world.ground(0, 0), 8);
probe.update(1);
const savedError = console.error, warnings = [];
console.error = (...args) => warnings.push(args);
try {
  pending.reject(undefined);
  await flush();
  const before = passes;
  for (let i = 0; i < 10; i++) probe.update(1);
  assert.equal(passes, before, 'a failed readback is not retried indefinitely');
  assert.equal(warnings.length, 1);
  assert.equal(probe.world.ground(0, 0), 8, 'last valid CPU data survives failure');
} finally { console.error = savedError; }
probe.reset();
probe.update(1);
probe.suspend();
pending.resolve();
await flush();
assert(!probe.ready, 'suspension rejects pending data');
probe.reset();
lost = true;
const before = passes;
probe.update(1);
assert.equal(passes, before, 'no work submitted to a lost device');
lost = false;
probe.update(1);
probe.dispose();
pending.resolve();
await flush();
assert(!probe.ready, 'disposal rejects pending data');

// The window's restore below is still the WebGL build's (src/world/window.js,
// U10's): its stand-in renderer says whether the context is lost.
const renderer = { getContext: () => ({ isContextLost: () => lost }), setRenderTarget() {} };
Object.assign(sim, { run: () => passes++ });
try {
  // Restore must not remove a stored edit before the GPU accepts its upload.
  const store = new BrickStore([4, 4, 4]);
  const a = new Float32Array(64 * 4), b = new Float32Array(a.length);
  for (let i = 0; i < 64; i++) { a[i * 4] = E.GOLD; a[i * 4 + 1] = 20; }
  const key = store.key(0, 0, 0), encoded = encodeBrick(a, 0, b, 0);
  store.put(key, encoded);
  const win = {
    sim: { ...sim, pass() { throw new Error('upload failed'); } }, renderer, store,
    editIdx: new Float32Array(64), editIdxTex: {}, mats: { edit: { uniforms: { tEditA: {}, tEditB: {} } } },
  };
  assert.throws(() => WorldWindow.prototype.restore.call(win, [0, 0, 0], [1, 1, 1]), /upload failed/);
  assert.equal(store.map.get(key), encoded);
  win.sim.pass = () => {};
  lost = true;
  WorldWindow.prototype.restore.call(win, [0, 0, 0], [1, 1, 1]);
  assert.equal(store.map.get(key), encoded, 'a lost-context no-op is not a successful upload');
  lost = false;
  WorldWindow.prototype.restore.call(win, [0, 0, 0], [1, 1, 1]);
  assert(!store.has(key));
  console.log('PASS: CPU edit preservation on failed uploads');
} catch (e) {
  // (the WebGL window's restore leans on helpers the port removed until U10 lands its own: J3 stubs)
  if (!/removed in the WebGPU port/.test(e?.message ?? '')) throw e;
  console.log(`skipped: the window's restore (src/world/window.js, U10's port): ${e.message}`);
}
console.log('PASS: probe failure/suspend/reset/dispose');
