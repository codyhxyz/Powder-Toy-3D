// CPU-only lifecycle checks: stale/failing reads must never republish data.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gridLayout } from '../src/sim.js';
import { WorldWindow } from '../src/world/window.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { E } from '../src/elements.js';
const sim = { g: gridLayout(16, 16, 16), origin: new THREE.Vector3() };

// Restore must not remove compressed edits before WebGPU accepts both its
// upload and edit dispatch. These mocks exercise the current window API.
{
  const store = new BrickStore([4, 4, 4]);
  const a = new Float32Array(64 * 4), b = new Float32Array(a.length);
  for (let i = 0; i < 64; i++) { a[i * 4] = E.GOLD; a[i * 4 + 1] = 20; }
  const key = store.key(0, 0, 0), encoded = encodeBrick(a, 0, b, 0);
  store.put(key, encoded);
  const restoreGpu = {
    stats: { flushes: 0 }, createBuffer: ({size}) => ({size}),
    write() { throw new Error('upload failed'); },
  };
  const win = { sim: { ...sim, edit() {} }, gpu: restoreGpu, store, restoreRead: -1 };
  assert.throws(() => WorldWindow.prototype.restore.call(win,[0,0,0],[1,1,1]),/upload failed/);
  assert.equal(store.map.get(key),encoded);
  restoreGpu.write = () => {};
  win.sim.edit = () => { throw new Error('device lost'); };
  assert.throws(() => WorldWindow.prototype.restore.call(win,[0,0,0],[1,1,1]),/device lost/);
  assert.equal(store.map.get(key),encoded,'failed dispatch retains stored edit');
  win.sim.edit = () => {};
  WorldWindow.prototype.restore.call(win,[0,0,0],[1,1,1]);
  assert(!store.has(key));
  console.log('PASS: CPU edit preservation on failed uploads and dispatches');
}
