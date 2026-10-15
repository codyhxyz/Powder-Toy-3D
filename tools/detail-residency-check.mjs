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
const buildFarView = new Function('app', 'far', wireSource.match(/  buildFarView\(app, far\) \{([\s\S]*?)\n  \},/)[1]);
// Exercise the constructor's actual capacity expression without constructing GPU pipelines.
const detailSource = readFileSync(new URL('../src/world/detail.js', import.meta.url), 'utf8');
const capacity = new Function('globalThis', `return ${detailSource.match(/const capacity = (.*);/)[1]}`);
for (const [cores, expected] of [[undefined, 4], [1, 1], [2, 1], [3, 1], [4, 2], [5, 3], [6, 4], [64, 4]]) {
  assert.equal(capacity({ navigator: { hardwareConcurrency: cores } }), expected);
}
assert.equal(capacity({}), 4);

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
    simVersion: sim.version, epoch: 0, bytes: 0, pending: new Map(),
    workers: Array.from({ length: 4 }, () => ({ token: null, worker: { terminate() {} } })),
    depthTex: null, depthZ: null,
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
  const token = (key) => {
    const t = { ...candidate(key), epoch: d.epoch, revision: d.revisions[key], version: sim.version };
    d.pending.set(key, t);
    return t;
  };
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
  const pending = token(key);
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
  const pending = token(key); // replacement sampled the edit; old mesh still visible
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
  for (let key = 256; key < 513; key++) d.accept(result(key));
  assert.equal(d.entries.size, 256 + 256, 'spares retain at least one complete previous view');
  assert(!d.entries.has(256), 'oldest spare evicted');
  assert.equal(d.entries.get(0), first, 'late offscreen jobs never evict wanted geometry');
  for (const key of [600, 601]) {
    const large = result(key);
    Object.defineProperty(large.positions, 'byteLength', { value: 50 * 1024 * 1024 });
    d.accept(large);
  }
  assert(!d.entries.has(600) && d.entries.has(601), 'offscreen spare bytes are independently bounded');
  const oversized = result(602), before = writes.length;
  Object.defineProperty(oversized.positions, 'byteLength', { value: 97 * 1024 * 1024 });
  d.accept(oversized);
  assert(!d.entries.has(602));
  assert.equal(writes.length, before, 'oversized late spare is rejected before upload');
  d.wanted = [];
  d.trimSpares();
  assert(d.entries.size <= 256 && d.bytes <= 96 * 1024 * 1024, 'spares remain bounded after turning away');
}

{
  const { d, camera, view, result, retired } = fixture(64, 64);
  camera.far = 10000; camera.updateProjectionMatrix();
  camera.position.set(1024, 24, 1024);
  const face = z => { camera.lookAt(1024, 24, z); camera.updateMatrixWorld(); view(); };
  const fill = () => {
    for (const c of d.jobs()) {
      const mesh = result(c.key);
      // Large-view accounting without allocating hundreds of MiB.
      Object.defineProperty(mesh.positions, 'byteLength', { value: 512 * 1024 });
      d.accept(mesh);
    }
  };
  face(0); fill();
  const front = new Map(d.entries), frontBytes = d.bytes;
  assert(front.size > 192 && frontBytes > 96 * 1024 * 1024, 'fixture exceeds BOTH old spare limits');
  face(2048);
  for (const [key, e] of front) assert.equal(d.entries.get(key), e, 'turning away retains the entire previous view');
  fill(); face(0);
  assert.equal(d.jobs().length, 0, 'turn back has no readback or remeshing jobs');
  for (const [key, e] of front) assert.equal(d.entries.get(key), e, 'returning reuses identical GPU buffers');
  assert.equal(retired.length, 0, 'opposite views fit without retiring geometry');
  // The viewed entries are newer than offscreen entries, regardless of build order.
  const wanted = new Set(d.wanted.map(c => c.key));
  let sawWanted = false;
  for (const key of d.entries.keys()) {
    if (wanted.has(key)) sawWanted = true;
    else assert(!sawWanted, 'current view refreshes LRU order');
  }
  // Normal mouse movement visits many intermediate frusta; a direct 180° jump
  // alone would miss the cache churn that originally emptied the previous view.
  for (let degrees = 0; degrees <= 360; degrees += 15) {
    const angle = degrees * Math.PI / 180;
    camera.lookAt(1024 + Math.sin(angle) * 1024, 24, 1024 - Math.cos(angle) * 1024);
    camera.updateMatrixWorld(); view(); fill();
  }
  face(0);
  assert.equal(d.jobs().length, 0, 'a continuous full look-around never reloads the first view');
  for (const [key, e] of front) assert.equal(d.entries.get(key), e, 'gradual turns keep original buffers too');
  assert.equal(retired.length, 0);
  const bytes = d.spareBytes;
  assert(bytes >= frontBytes);
  d.wanted = []; d.trimSpares();
  assert(d.entries.size <= d.spareChunks && d.bytes <= bytes, 'history growth still obeys panorama bounds');
  d.reset();
  assert.equal(d.spareChunks, 192);
  assert.equal(d.spareBytes, 96 * 1024 * 1024, 'world reset releases the larger working-set allowance');
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
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function runnable(count = 6) {
  const f = fixture(), { d, win, candidate } = f;
  d.visible = true; d.wanted = Array.from({ length: count }, (_, k) => candidate(k));
  let wakes = 0;
  d.onChange = () => { wakes++; };
  d.gpu.failure = true; // suppress expected failure diagnostics
  const order = [], reads = [], posts = [], transfers = [], terminated = [];
  const pipes = [0, 1, 2].map(() => {
    const wait = deferred();
    return { state: 'idle', groups: [null, null, {}], calls: 0,
      build() { this.calls++; this.state = 'pending'; return wait.promise.then(() => { this.state = 'ready'; }); },
      dispatch(_frame, _size, { params }) { order.push(['dispatch', ...params.chunkLo]); }, wait };
  });
  [d.stage, d.pipe, d.depthPipe] = pipes;
  d.cells = {};
  Object.assign(d.gpu, { frame: {}, bindGroup: () => ({}), readback: { buffer: source => {
    assert.equal(source, d.cells, 'all jobs reuse the same GPU cells buffer');
    const read = deferred(); reads.push(read); order.push(['copy']); return read.promise;
  } } });
  d.layout = { side: 44, cells: 44 * 44 * 64 };
  Object.assign(win, { gen: { res: { prepassFor() {}, entries: () => [] } },
    planted: new Uint8Array(64), wb: [8, 16, 8], store: { map: new Map(), key: () => 0 } });
  d.workers = Array.from({ length: 4 }, (_, i) => ({ token: null, worker: {
    postMessage(m, transfer) { posts.push(m); transfers.push(transfer); },
    terminate() { terminated.push(i); },
  } }));
  const ready = () => pipes.forEach(p => p.state = 'ready');
  const finish = (m, empty = false) => {
    const mesh = { token: m.token, positions: new Float32Array(empty ? 0 : 9),
      normals: new Float32Array(empty ? 0 : 9), ids: new Uint16Array(empty ? 0 : 3),
      indices: new Uint16Array(empty ? 0 : [0, 1, 2]), liquid: false };
    d.accept(mesh);
  };
  return { ...f, pipes, reads, posts, transfers, order, terminated, ready, finish, wakes: () => wakes };
}

{
  const { d, pipes, wakes } = runnable();
  assert(d.busy);
  assert(worldBusy({ win: { far: { queue: [], detail: d } } }), 'detail queue prevents sleep after far queue drains');
  assert(/detail\.onChange = \(\) => app\.pacer\?\.wake\(\)/.test(wireSource), 'async callback reaches app pacer');
  let farBuilds = 0;
  const far = { detail: d, viewPipeline: { state: 'idle' }, buildView() {
    farBuilds++; this.viewPipeline.state = 'pending'; return Promise.resolve();
  } };
  // Boot/view-switch wiring starts detail before far.tick, even if far is already building.
  buildFarView({}, far); buildFarView({}, far);
  const building = d.building;
  assert.equal(d.build(), building, 'build is idempotent');
  d.tick(); d.tick();
  assert(!d.busy && pipes.every(p => p.calls === 1) && farBuilds === 1);
  pipes.forEach(p => p.wait.resolve()); await building;
  assert.equal(wakes(), 1, 'one readiness subscription wakes a paused view');
  assert(d.busy);
}
for (const slots of [1, 2, 4]) {
  const { d, ready, reads } = runnable();
  d.workers.length = slots;
  ready(); d.tick(); d.tick();
  assert.equal(reads.length, slots, 'submission count is bounded by available worker capacity');
  assert.equal(d.pending.size, slots); assert(!d.busy);
}
{
  const { d, ready, reads, posts, transfers, order, finish, wakes } = runnable();
  ready(); d.tick();
  assert.equal(d.pending.size, 4, 'four jobs start in one tick');
  assert(d.workers.every(s => s.token));
  d.tick(); assert.equal(reads.length, 4, 'capacity includes readback waits');
  assert.deepEqual(order.map(e => e[0]), ['dispatch', 'copy', 'dispatch', 'copy', 'dispatch', 'copy', 'dispatch', 'copy']);
  assert(!d.busy, 'full pool sleeps until completion');
  for (const i of [3, 1, 0, 2]) reads[i].resolve(Uint32Array.of(i).buffer);
  await flush();
  assert.deepEqual(posts.map(m => m.token.key), [3, 1, 0, 2], 'readbacks finish out of order');
  assert.deepEqual(posts.map(m => m.raw[0]), [3, 1, 0, 2]);
  assert.equal(new Set(posts.map(m => m.raw.buffer)).size, 4);
  assert.equal(new Set(posts.map(m => m.planted.buffer)).size, 4, 'each job owns a planted snapshot');
  posts.forEach((m, i) => assert.deepEqual(transfers[i], [m.raw.buffer, m.planted.buffer]));
  d.tick(); assert.equal(reads.length, 4, 'meshing also occupies the slots');
  const before = wakes(); finish(posts[0]);
  assert.equal(wakes(), before + 1); assert(d.busy);
  d.tick(); assert.equal(reads.length, 5, 'paused completion refills freed slot');
  for (const m of posts.slice(1)) finish(m);
  assert.equal(d.entries.size, 4, 'out-of-order meshes publish independently');
  d.tick(); assert.equal(reads.length, 6);
  for (const r of reads.slice(4)) r.resolve(new ArrayBuffer(4));
  await flush(); posts.slice(4).forEach(m => finish(m));
  assert.equal(d.entries.size, 6); assert(!d.busy);
}
{
  const { d, sim, candidate, result, ready, reads } = runnable(0);
  const stale = candidate(0), covered = candidate(2 + 2 * d.nx), exposed = candidate(1);
  stale.distance = 1; covered.distance = 2; exposed.distance = 300;
  d.accept(result(0)); d.entries.get(0).step = 0;
  d.wanted = [stale, covered, exposed];
  assert(d.covered(covered));
  assert.deepEqual(d.jobs().map(c => c.key), [exposed.key, covered.key, stale.key], 'exposed missing beats covered prewarming and stale replacements');
  sim.origin.y = 1; assert(!d.covered(covered), 'missing bottom world layer remains exposed');
  sim.origin.y = -1; assert(!d.covered(covered), 'missing top world layer remains exposed');
  sim.origin.y = 0; d.win.size[1] = 128;
  assert(!d.covered(covered), 'coverage uses full world height, not just window height');
  d.win.size[1] = 64;
  sim.origin.x++; assert(!d.covered(covered), 'partial X coverage remains exposed'); sim.origin.x--;
  sim.origin.z++; assert(!d.covered(covered), 'partial Z coverage remains exposed'); sim.origin.z--;
  ready(); d.tick();
  assert.deepEqual([...d.pending.keys()], [exposed.key, covered.key, stale.key]);
  assert.equal(reads.length, 3);
}
{
  const { d, ready, reads, posts, finish, wakes } = runnable(1);
  ready(); d.tick(); const old = d.pending.get(0);
  d.invalidate([0, 0, 0], [1, 64, 1]);
  assert(!d.valid(old)); d.tick();
  assert.equal(reads.length, 1, 'invalidated job still owns its slot and chunk until drained');
  reads[0].resolve(new ArrayBuffer(4)); await flush();
  assert.equal(posts.length, 0); assert.equal(d.pending.size, 0); assert(d.busy);
  d.tick(); const newer = d.pending.get(0);
  assert.notEqual(newer.revision, old.revision);
  d.completed(old);
  assert.equal(d.pending.get(0), newer, 'late older completion cannot release a newer job for the same chunk');
  assert(d.workers.some(s => s.token === newer));
  assert(!d.valid({ ...newer, version: newer.version - 1 }), 'version mismatch cannot publish');
  d.completed({ ...newer, version: newer.version - 1 });
  assert.equal(d.pending.get(0), newer, 'version mismatch cannot release a job');
  reads[1].resolve(new ArrayBuffer(4)); await flush();
  const before = wakes(); finish(posts[0]); assert.equal(wakes(), before + 1);
  assert(d.entries.has(0));
}
{
  const { d, ready, reads, posts, finish } = runnable(4);
  ready(); d.tick();
  reads[0].resolve(new ArrayBuffer(4)); await flush();
  const old = posts[0]; d.reset();
  d.wanted = [old.token];
  assert.equal(d.pending.size, 0); assert(d.workers.every(s => s.token), 'reset does not reuse workers still occupied by old jobs');
  d.tick(); assert.equal(reads.length, 4); assert(!d.busy);
  finish(old); assert(!d.entries.has(0)); assert(d.busy);
  d.tick(); const newer = d.pending.get(0);
  finish(old);
  assert.equal(d.pending.get(0), newer, 'old epoch result does not release the new epoch job');
  assert(d.workers.some(s => s.token === newer));
  for (const r of reads.slice(1)) r.resolve(new ArrayBuffer(4));
  await flush();
  assert.equal(posts.length, 2, 'old epoch readbacks never reach workers');
  finish(posts[1]); assert(d.entries.has(0)); assert(!d.busy);
}
{
  const { d, win, pipes, wakes } = runnable();
  const transfer = deferred(); win.pending = transfer.promise;
  d.tick(); d.tick(); assert(!d.busy && d.waitingWindow);
  win.pending = null; transfer.resolve(); await d.waitingWindow;
  assert(d.busy && wakes() === 1);
  d.tick(); const building = d.building;
  pipes[0].wait.reject(new Error('fixture pipeline failure'));
  pipes.slice(1).forEach(p => p.wait.resolve()); await building;
  assert(d.failed && !d.busy && wakes() === 2);
}
{
  const { d, ready, reads, terminated, wakes, posts } = runnable();
  ready(); d.tick(); reads[0].reject(new Error('fixture readback failure')); await flush();
  assert(d.failed && !d.pending.size && !d.busy && wakes() === 1);
  assert.equal(terminated.length, 4, 'one fatal error terminates all workers');
  assert(d.workers.every(s => !s.token));
  reads.slice(1).forEach(r => r.resolve(new ArrayBuffer(4))); await flush();
  d.fail('worker', new Error('late error')); d.tick();
  assert.equal(posts.length, 0); assert.equal(wakes(), 1); assert.equal(reads.length, 4);
}
{
  const { d, ready, reads, posts, terminated, wakes } = runnable();
  ready(); d.tick();
  reads[0].resolve(new ArrayBuffer(4)); await flush();
  d.accept({ token: posts[0].token, error: 'fixture mesh failure' });
  assert(d.failed && !d.pending.size && !d.busy);
  assert.equal(terminated.length, 4); assert.equal(wakes(), 1);
  reads.slice(1).forEach(r => r.resolve(new ArrayBuffer(4))); await flush();
  assert.equal(posts.length, 1, 'fatal mesh error rejects other in-flight results');
}
{
  const { d, result, candidate, retired } = fixture();
  d.wanted = [candidate(0)]; d.accept(result(0));
  const old = d.entries.get(0), oldMask = d.mask[0];
  let wakes = 0, calls = 0; d.onChange = () => wakes++;
  d.gpu.failure = true;
  d.gpu.createBuffer = () => { if (++calls === 2) throw new Error('fixture allocation failure'); return {}; };
  d.accept(result(0));
  assert(d.failed && !d.busy && !d.pending.size && wakes === 1);
  assert.equal(d.entries.get(0), old, 'failed upload preserves old geometry');
  assert.equal(d.mask[0], oldMask); assert.equal(retired.length, 1);
}
{
  const { d, ready, reads, posts, finish, terminated, retired } = runnable(1);
  ready(); d.tick(); d.dispose();
  reads[0].resolve(new ArrayBuffer(4)); await flush();
  assert(d.disposed && !d.pending.size && d.workers.every(s => !s.token));
  assert.equal(terminated.length, 4); assert.equal(posts.length, 0); assert(retired.includes(d.cells));
}
{
  const { d, ready, reads, posts, finish, candidate } = runnable(0);
  d.wanted = Array.from({ length: 256 }, (_, key) => candidate(key)); ready();
  let readAt = 0, postAt = 0;
  for (let i = 0; i < 64; i++) {
    assert(d.busy); d.tick(); assert.equal(d.pending.size, 4);
    while (readAt < reads.length) reads[readAt++].resolve(new ArrayBuffer(4));
    await flush(); while (postAt < posts.length) finish(posts[postAt++]);
  }
  assert.equal(new Set(posts.map(m => m.token.key)).size, 256);
  assert.equal(d.entries.size, 256);
  assert(!d.busy && !worldBusy({ win: { far: { queue: [], detail: d } } }));
}
{
  let ticks = 0, moves = 0;
  const fail = () => assert.fail('replica physics/window movement is forbidden');
  const app = { mp: { replica: true }, sim: { step: fail },
    win: { update: fail, shift: fail, far: { tick: () => ticks++, queue: [], detail: { busy: true } } } };
  worldFollow(app, { moveWindow: fail }); assert.equal(ticks, 1); assert(worldBusy(app));
  app.win.far.detail.busy = false; app.win.far.queue.push([0, 0]); assert(worldBusy(app));
  app.win.far.queue.length = 0; assert(!worldBusy(app));
  app.mp.replica = false; worldFollow(app, { moveWindow: () => moves++ });
  assert.equal(moves, 1); assert.equal(ticks, 1);
}
console.log('PASS: continuous 360-degree cache reuse, bounded panorama spares/LRU/reset, four-slot streaming, exposed missing priority, ordered dispatch/copy, out-of-order results, reset/invalidation, atomic replacement, paused refill, async build and replica streaming');
