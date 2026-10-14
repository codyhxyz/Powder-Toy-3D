// CPU regressions: camera/window movement must not destroy valid render data.
import assert from 'node:assert/strict';
import { Vector3, Matrix4, Frustum, Box3, PerspectiveCamera } from 'three/webgpu';
import { WorldDetail } from '../src/world/detail.js';
import { WorldWindow } from '../src/world/window.js';
import { FarField } from '../src/world/far.js';
import { readFileSync } from 'node:fs';
const wireSource = readFileSync(new URL('../src/wire/world.js', import.meta.url), 'utf8');
// The browser wire imports a Vite virtual bake; evaluate only its actual busy hook.
const worldBusy = new Function('app', wireSource.match(/  busy\(app\) \{([\s\S]*?)\n  \},/)[1]);
const worldFollow = new Function('app', 'world', wireSource.match(/  follow\(app\) \{([\s\S]*?)\n  \},/)[1]);

function fixture(nx = 16, nz = 16) {
  const retired = [], writes = [];
  const sim = {
    origin: new Vector3(64, 0, 64), g: { nx: 64, ny: 64, nz: 64 }, version: 1,
    _retire: (b) => retired.push(b),
    header: () => ({}),
    shift(dx, dz) { this.origin.x += dx; this.origin.z += dz; this.version++; },
  };
  const d = Object.assign(Object.create(WorldDetail.prototype), {
    sim, nx, nz, mask: new Uint32Array(nx * nz), revisions: new Uint32Array(nx * nz),
    entries: new Map(), wanted: [], dirty: new Map(),
    simVersion: sim.version, epoch: 0, bytes: 0, pending: null,
    gpu: { write: (...a) => writes.push(a), createBuffer: (desc) => ({ ...desc }) },
    _m: { worldToScene: new Matrix4(), sceneToWorld: new Matrix4(), eye: new Vector3(),
      proj: new Matrix4(), frustum: new Frustum(), box: new Box3() },
  });
  const win = Object.assign(Object.create(WorldWindow.prototype), {
    sim, size: [nx * 32, 64, nz * 32], scene: {},
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
  // Mock accounting only; no large CPU or GPU allocation.
  Object.defineProperty(oversized.positions, 'byteLength', { value: 97 * 1024 * 1024 });
  d.accept(oversized);
  assert.notEqual(d.entries.get(key), entry, 'wanted replacement is never rejected by the spare byte budget');
  assert.equal(d.mask[key], mask);
  assert(d.bytes > 96 * 1024 * 1024);
  assert.equal(retired.length, 4);
}

{
  const { d, candidate, result, writes } = fixture(32, 32);
  for (let key = 0; key < 256; key++) {
    d.wanted.push(candidate(key));
    d.accept(result(key));
  }
  assert.equal(d.entries.size, 256, 'all >192 wanted meshes remain resident');
  const first = d.entries.get(0);
  for (let key = 256; key < 449; key++) d.accept(result(key));
  assert.equal(d.entries.size, 256 + 192, 'only offscreen spare count is bounded');
  assert(!d.entries.has(256), 'oldest spare evicted');
  assert.equal(d.entries.get(0), first, 'late offscreen jobs never evict wanted geometry');
  for (const key of [450, 451]) {
    const large = result(key);
    Object.defineProperty(large.positions, 'byteLength', { value: 50 * 1024 * 1024 });
    d.accept(large);
  }
  assert(!d.entries.has(450) && d.entries.has(451), 'offscreen spare bytes are independently bounded');
  const oversized = result(452), before = writes.length;
  Object.defineProperty(oversized.positions, 'byteLength', { value: 97 * 1024 * 1024 });
  d.accept(oversized);
  assert(!d.entries.has(452));
  assert.equal(writes.length, before, 'oversized late spare is rejected before upload');
  d.wanted = [];
  d.trimSpares();
  assert(d.entries.size <= 192 && d.bytes <= 96 * 1024 * 1024, 'turning away trims newly offscreen geometry');
}

{
  const { d, win, camera, view } = fixture(128, 128);
  camera.far = 10000; camera.updateProjectionMatrix();
  camera.position.set(2048, 96, 4050); camera.lookAt(2048, 0, 0); camera.updateMatrixWorld();
  view();
  assert(d.wanted.some(c => c.distance > 3000), 'distant visible columns survive the former projected-size cutoff');
  assert(d.wanted.every(c => c.step === 1));
  assert(d.wanted.length < d.nx * d.nz, 'flat frustum culling is retained');
  d.far.presentation = { active: true, key: 'bent', parameters: { k: 1 / 2048, anchor: [2048, 4050], dir: [0, 1] } };
  view();
  assert(d.wanted.length > 0 && d.wanted.length < d.nx * d.nz, 'bent views select conservative visible bounds, not the entire world');
  assert(d.wanted.every(c => c.step === 1), 'curved culling cannot lower geometry detail');
  assert.equal(win.size[0], 4096);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function runnable() {
  const f = fixture(), { d, win, candidate } = f;
  d.visible = true; d.wanted = [candidate(0), candidate(1)];
  let wakes = 0;
  d.onChange = () => { wakes++; };
  const pipes = [0, 1, 2].map(() => {
    const wait = deferred();
    const pipe = { state: 'idle', groups: [null, null, {}], calls: 0,
      build() { this.calls++; this.state = 'pending'; return wait.promise.then(() => { this.state = 'ready'; }); },
      dispatch() {}, wait };
    return pipe;
  });
  [d.stage, d.pipe, d.depthPipe] = pipes;
  const readback = deferred(), posts = [];
  Object.assign(d.gpu, { frame: {}, bindGroup: () => ({}), readback: { buffer: () => readback.promise } });
  d.layout = { side: 44, cells: 44 * 44 * 64 };
  Object.assign(win, { gen: { res: { prepassFor() {}, entries: () => [] } },
    planted: new Uint8Array(64), wb: [8, 16, 8], store: { map: new Map(), key: () => 0 } });
  d.worker = { postMessage: m => posts.push(m) };
  return { ...f, pipes, readback, posts, wakes: () => wakes };
}

{
  const { d, pipes, readback, posts, result, wakes } = runnable();
  assert(d.busy);
  assert(worldBusy({ win: { far: { queue: [], detail: d } }, mp: {} }), 'detail queue prevents sleep after far queue drains');
  assert(/detail\.onChange = \(\) => app\.pacer\?\.wake\(\)/.test(wireSource), 'async callback reaches app pacer');
  d.tick(); d.tick();
  assert(!d.busy, 'compiling waits without a busy loop');
  assert(pipes.every(p => p.calls === 1), 'readiness subscription is attached only once');
  const building = d.building;
  pipes.forEach(p => p.wait.resolve());
  await building;
  assert.equal(wakes(), 1, 'pipeline completion wakes a paused view');
  assert(d.busy);
  d.tick();
  assert(d.pending && !d.busy, 'worker/readback waits without polling');
  readback.resolve(new ArrayBuffer(4));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(posts.length, 1, 'readback reaches worker');
  assert(posts[0].raw instanceof Uint32Array);
  const mesh = result(0); mesh.token = posts[0].token;
  const before = wakes(); d.accept(mesh);
  assert.equal(wakes(), before + 1, 'accepted mesh wakes render');
  assert.equal(d.mask[0], 1);
  assert(d.busy, 'another wanted chunk is still runnable after completion');
  const stale = result(1); d.pending = stale.token; d.revisions[1]++;
  const preStale = wakes(); d.accept(stale);
  assert.equal(wakes(), preStale + 1, 'stale completion also wakes remaining work');
  assert(!d.entries.has(1) && !d.pending && d.busy);
  const preDrop = wakes(); d.drop(0);
  assert.equal(wakes(), preDrop + 1, 'drop redraws');
  const preReset = wakes(); d.reset();
  assert.equal(wakes(), preReset + 1, 'reset redraws even without entries');
}

{
  const { d, pipes, readback, posts, wakes } = runnable();
  pipes.forEach(p => p.state = 'ready');
  d.tick(); const token = d.pending;
  d.reset();
  readback.resolve(new ArrayBuffer(4));
  await Promise.resolve(); await Promise.resolve();
  assert(!d.valid(token) && !d.pending);
  assert.equal(posts.length, 0, 'reset readback never reaches worker');
  assert(wakes() >= 2, 'reset and stale readback wake');
}

{
  const { d, win, pipes, wakes } = runnable();
  const transfer = deferred(); win.pending = transfer.promise;
  d.tick(); d.tick();
  assert(!d.busy && d.waitingWindow);
  win.pending = null; transfer.resolve(); await d.waitingWindow;
  assert(d.busy && wakes() === 1, 'window-transfer completion resumes streaming');
  d.tick();
  const building = d.building;
  pipes[0].wait.reject(new Error('fixture pipeline failure'));
  pipes.slice(1).forEach(p => p.wait.resolve());
  await building;
  assert(d.failed && !d.busy && wakes() === 2, 'pipeline failure wakes once and cannot busy-loop');
}

{
  const { d, pipes, readback, wakes } = runnable();
  pipes.forEach(p => p.state = 'ready');
  d.gpu.failure = true; // suppress expected error diagnostic
  d.tick(); readback.reject(new Error('fixture readback failure'));
  await Promise.resolve(); await Promise.resolve();
  assert(d.failed && !d.pending && !d.busy && wakes() === 1, 'readback failure wakes and stops submissions');
}

{
  const { d, result, candidate, retired } = fixture();
  d.wanted = [candidate(0)]; d.accept(result(0));
  const old = d.entries.get(0), oldMask = d.mask[0];
  let wakes = 0, calls = 0; d.onChange = () => wakes++;
  d.gpu.failure = true;
  d.gpu.createBuffer = () => { if (++calls === 2) throw new Error('fixture allocation failure'); return {}; };
  const mesh = result(0); d.pending = mesh.token; d.accept(mesh);
  assert(d.failed && !d.busy && !d.pending && wakes === 1);
  assert.equal(d.entries.get(0), old, 'failed upload preserves old geometry');
  assert.equal(d.mask[0], oldMask, 'failed upload never publishes a partial mask');
  assert.equal(retired.length, 1, 'partial upload is retired');
}
{
  const { d, pipes, candidate, result } = runnable();
  d.wanted = Array.from({ length: 256 }, (_, key) => candidate(key));
  pipes.forEach(p => p.state = 'ready');
  const submitted = [];
  d.gpu.readback.buffer = () => Promise.resolve(new ArrayBuffer(4));
  d.worker.postMessage = ({ token }) => {
    submitted.push(token.key);
    d.accept({ ...result(token.key), token });
  };
  // Fixed paused view, far lighting queue already empty, no simulation writes.
  for (let i = 0; i < 256; i++) {
    assert(d.busy);
    d.tick();
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(new Set(submitted).size, 256, 'every visible chunk eventually receives full detail while paused');
  assert.equal(d.entries.size, 256);
  assert(!d.busy && !worldBusy({ win: { far: { queue: [], detail: d } }, mp: {} }), 'fully completed streaming can sleep');
}
{
  let ticks = 0, moves = 0;
  const fail = () => assert.fail('replica physics/window movement is forbidden');
  const app = { mp: { replica: true }, sim: { step: fail },
    win: { update: fail, shift: fail, far: { tick: () => ticks++, queue: [], detail: { busy: true } } } };
  worldFollow(app, { moveWindow: fail });
  assert.equal(ticks, 1, 'replica follow submits render-only far/detail work');
  assert(worldBusy(app), 'replica detail work cannot sleep permanently');
  app.win.far.detail.busy = false; app.win.far.queue.push([0, 0]);
  assert(worldBusy(app), 'replica lighting queue also progresses');
  app.win.far.queue.length = 0;
  assert(!worldBusy(app));
  app.mp.replica = false;
  worldFollow(app, { moveWindow: () => moves++ });
  assert.equal(moves, 1, 'host retains the existing window-follow path');
  assert.equal(ticks, 1, 'host update remains the single far.tick caller');
}
console.log('PASS: full-detail visibility, unlimited wanted residency, bounded offscreen spares, stale jobs, atomic replacement, async readiness and render-only replica streaming');
