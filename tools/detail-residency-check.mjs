// CPU regressions: camera/window movement must not destroy valid render data.
import assert from 'node:assert/strict';
import { Vector3, Matrix4, Frustum, Box3, PerspectiveCamera } from 'three/webgpu';
import { WorldDetail } from '../src/world/detail.js';
import { WorldWindow } from '../src/world/window.js';
import { FarField } from '../src/world/far.js';

function fixture() {
  const retired = [], writes = [];
  const sim = {
    origin: new Vector3(64, 0, 64), g: { nx: 64, ny: 64, nz: 64 }, version: 1,
    _retire: (b) => retired.push(b),
    header: () => ({}),
    shift(dx, dz) { this.origin.x += dx; this.origin.z += dz; this.version++; },
  };
  const d = Object.assign(Object.create(WorldDetail.prototype), {
    sim, nx: 16, nz: 16, mask: new Uint32Array(256), revisions: new Uint32Array(256),
    entries: new Map(), wanted: [], blocked: new Set(), dirty: new Map(),
    simVersion: sim.version, epoch: 0, bytes: 0, pending: null,
    gpu: { write: (...a) => writes.push(a), createBuffer: (desc) => ({ ...desc }) },
    _m: { worldToScene: new Matrix4(), sceneToWorld: new Matrix4(), eye: new Vector3(),
      proj: new Matrix4(), frustum: new Frustum(), box: new Box3() },
  });
  const win = Object.assign(Object.create(WorldWindow.prototype), {
    sim, size: [512, 64, 512], scene: {},
    gen: { diff() {}, fill() { sim.version++; } }, readBack() {},
    restore() { sim.version++; return 0; },
  });
  const far = Object.assign(Object.create(FarField.prototype), {
    sim, win, detail: d, built: true,
    region() {}, boost() {}, k: {}, groupsFixed: {}, L: { bricks: { n: [128, 16, 128] } },
    winMask: new Uint32Array(512),
  });
  d.win = win; d.far = far; win.far = far;
  const camera = new PerspectiveCamera(70, 1, 0.1, 2000);
  camera.position.set(96, 96, 192);
  camera.lookAt(96, 0, 80);
  camera.updateMatrixWorld();
  const view = () => d.view(camera, true, new Matrix4());
  const candidate = (key) => ({ key, x: key % d.nx * 32, z: Math.floor(key / d.nx) * 32, step: 1, distance: 1 });
  const token = (key) => ({ ...candidate(key), epoch: d.epoch, revision: d.revisions[key], version: sim.version });
  const result = (key, empty = false) => ({
    token: token(key), positions: new Float32Array(empty ? 0 : 9),
    normals: new Float32Array(empty ? 0 : 9), ids: new Uint16Array(empty ? 0 : 3),
    indices: new Uint16Array(empty ? 0 : [0, 1, 2]), liquid: false,
  });
  return { d, win, sim, retired, writes, camera, view, candidate, token, result };
}

{
  const { d, win, sim, retired, camera, view, result, token } = fixture();
  view();
  const key = 2 + 2 * d.nx; // fully inside the live window
  assert(d.wanted.some(c => c.key === key), 'prewarm visible live chunks before they leave');
  d.accept(result(key));
  const entry = d.entries.get(key), mask = d.mask[key], revision = d.revisions[key];
  const pending = token(key);
  camera.lookAt(96, 96, 400); camera.updateMatrixWorld(); view();
  assert(!d.wanted.some(c => c.key === key));
  assert.equal(d.entries.get(key), entry, 'turning away keeps even live-window spares');
  assert(d.valid(pending), 'a camera turn does not cancel a valid worker result');
  for (let i = 0; i < 4; i++) {
    win.shift(16, 0); view();
    win.shift(-16, 0); view();
  }
  assert.equal(d.entries.get(key), entry, 'unchanged window round trips reuse identical buffers');
  assert.equal(d.mask[key], mask);
  assert.equal(d.revisions[key], revision, 'movement does not request remeshing');
  assert.equal(retired.length, 0);
  assert(d.valid(pending));
  sim.version++; // paint/physics while live
  win.shift(16, 0);
  assert.equal(d.entries.get(key), entry, 'edited departing slab stays drawn during rebuild');
  assert.equal(entry.step, 0, 'real writes request a replacement');
  assert(!d.valid(pending), 'pre-edit worker result is rejected');
  assert.equal(d.mask[key], mask, 'no coarse flash while replacement is pending');
  d.accept(result(key));
  assert.notEqual(d.entries.get(key), entry);
  assert.equal(retired.length, 4, 'old GPU buffers retire only when replacement is published');
}

{
  const { d, win, sim, result, token } = fixture();
  const key = 2 + 2 * d.nx;
  sim.version++; // startup writes after the far field's initial summary
  d.accept(result(key)); // mesh already includes those writes
  const entry = d.entries.get(key);
  d.pending = token(key);
  const pending = d.pending;
  win.shift(16, 0);
  assert.equal(d.entries.get(key), entry);
  assert.equal(entry.step, 1, 'late summary must not rebuild a newer mesh');
  assert(d.valid(pending), 'late summary must not cancel a newer readback');
}

{
  const { d, sim, token, result } = fixture();
  const key = 2 + 2 * d.nx;
  d.accept(result(key));
  sim.version++;
  d.pending = token(key); // replacement sampled the edit; old mesh still visible
  const pending = d.pending;
  d.stale([64, 0, 64], [16, 64, 64]);
  assert.equal(d.entries.get(key).step, 0);
  assert(d.valid(pending), 'an old displayed mesh must not invalidate a fresh replacement job');
}

{
  const { d } = fixture(), far = d.far, order = [];
  Object.assign(far, { queue: [], sweep: -1, age: 120, version: 0 });
  far.summarize = () => order.push('summary');
  d.tick = () => order.push('detail');
  far.tick();
  assert.deepEqual(order, ['summary', 'detail'], 'invalidate before submitting GPU detail work');
}

{
  const { d, result } = fixture();
  const key = 0;
  d.accept(result(key)); // no longer wanted, but space remains
  assert(d.entries.has(key), 'completed off-screen job remains a reusable spare');
  d.reset();
  const empty = result(key, true);
  d.accept(empty);
  assert.equal(d.entries.get(key).step, 1, 'empty chunks are cached rather than rebuilt forever');
  assert.equal(d.entries.get(key).count, 0);
  assert.equal(d.mask[key], 0, 'empty geometry never masks the coarse liquid field');
  const oldToken = empty.token;
  d.reset();
  assert(!d.valid(oldToken), 'world resets still reject old jobs');
}

{
  const { d, candidate, result, retired } = fixture();
  const key = 0;
  d.wanted = [candidate(key)];
  d.accept(result(key));
  const entry = d.entries.get(key), mask = d.mask[key];
  const oversized = result(key);
  // No allocation needed to exercise the over-budget guard.
  oversized.positions = { byteLength: 97 * 1024 * 1024 };
  d.accept(oversized);
  assert.equal(d.entries.get(key), entry, 'over-budget replacement preserves the existing mesh');
  assert.equal(d.mask[key], mask);
  assert.equal(retired.length, 0);
  assert(d.blocked.has(key), 'rejected replacement does not spin');
}

{
  const { d, candidate, result } = fixture();
  for (let key = 0; key < 192; key++) {
    d.wanted.push(candidate(key));
    d.accept(result(key));
  }
  assert.equal(d.entries.size, 192);
  const first = d.entries.get(0);
  d.wanted.shift(); // spare: evict this one, not another wanted chunk
  d.wanted.unshift({ ...candidate(192), distance: 0 });
  d.accept(result(192));
  assert.equal(d.entries.size, 192, 'cache remains bounded');
  assert(!d.entries.has(0));
  assert(![...d.entries.values()].includes(first));
  assert(d.entries.has(192));
}
console.log('PASS: live prewarming, camera/window reuse, edit refresh, stale jobs, empty chunks, atomic replacement and bounded eviction');
