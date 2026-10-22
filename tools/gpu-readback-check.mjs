// CPU-only lifecycle checks: stale/failing reads must never republish data.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gridLayout } from '../src/sim.js';
import { WorldWindow } from '../src/world/window.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { NativeBrickStore } from '../src/world/nativeStore.js';
import { E } from '../src/elements.js';
const sim = { g: gridLayout(16, 16, 16), origin: new THREE.Vector3() };

// Restore must not remove stored edits before the native owner accepts them: without an owner the V1
// store keeps its brick (an error, never V1's restore edit, which went with V1); with one the brick moves
// to the native store (legacyBrickToNative), which keeps it until the native scatter is recorded.
{
  const store = new BrickStore([4, 4, 4]), nativeStore = new NativeBrickStore([4, 4, 4]);
  const a = new Float32Array(64 * 4), b = new Float32Array(a.length);
  for (let i = 0; i < 64; i++) { a[i * 4] = E.GOLD; a[i * 4 + 1] = 20; }
  const key = store.key(0, 0, 0), encoded = encodeBrick(a, 0, b, 0);
  store.put(key, encoded);
  const win = { sim: { ...sim, compactOwner: null, nativeIntegration: null }, store, nativeStore };
  assert.throws(() => WorldWindow.prototype.restore.call(win, [0, 0, 0], [1, 1, 1]), /native owner/);
  assert.equal(store.map.get(key), encoded, 'no owner: the stored edit stays');
  let fail = true;
  win.sim.compactOwner = { isReady: true, sync() {} };
  win.sim.nativeIntegration = { isReady: true, restoreBricks() { if (fail) throw new Error('device lost'); } };
  assert.equal(WorldWindow.prototype.restore.call(win, [0, 0, 0], [1, 1, 1]), 1);
  assert(!store.has(key) && nativeStore.has(key), 'the brick moves to the native store');
  assert.throws(() => WorldWindow.prototype.restoreNative.call(win, [0, 0, 0], [1, 1, 1]), /device lost/);
  assert(nativeStore.has(key), 'failed dispatch retains the stored edit');
  fail = false;
  assert.equal(WorldWindow.prototype.restoreNative.call(win, [0, 0, 0], [1, 1, 1]), 1);
  assert(!nativeStore.has(key));
  console.log('PASS: CPU edit preservation without an owner and on failed native dispatches');
}
