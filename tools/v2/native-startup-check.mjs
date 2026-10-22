// CPU only: real Simulation + Kernel readiness, controlled pipeline promises.
// Dispatches record commands, not WGSL execution; no device/browser/launcher.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation } from '../../src/sim.js';
import { Kernel } from '../../src/gpu/kernels.js';

globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fixture(opts = {}, held = []) {
  const builds = [], dispatches = [], writes = [], clears = [], kernels = new Map(), gates = new Map();
  const gate = name => { if (!gates.has(name)) gates.set(name, deferred()); return gates.get(name); };
  const buffer = desc => ({ ...desc, data: new Uint8Array(desc.size), destroy() {} });
  const gpu = {
    testMode: true, L: { PARAMS: {}, EMPTY: {} }, emptyGroup: {},
    fits: () => true, layout: (name, entries) => ({ name, entries }),
    bindGroup: (layout, entries) => ({ layout, entries }), createBuffer: buffer,
    queue: { onSubmittedWorkDone: () => Promise.resolve(), writeBuffer(b, at, data) {
      writes.push(b.label);
      b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at);
    } },
    write(b, at, data) { this.queue.writeBuffer(b, at, data); },
    frame: { clear(b) { clears.push(b.label); b.data.fill(0); }, copy(a, ao, b, bo, n) { b.data.set(a.data.subarray(ao, ao + n), bo); } },
    retire() {},
    _frameOrThrow() {},
    fail(error) { return error; },
    readback: { ring: (_name, bytes) => ({ next: () => 0, read: async () => new ArrayBuffer(bytes) }) },
    pipelines: {
      pipes: new Set(), times: new Map(),
      track(pipe) { this.pipes.add(pipe); },
      check() {},
      module: () => ({}),
      pipeline(_kind, name) {
        builds.push(name);
        return held === 'all' || held.includes(name) ? gate(name).promise : Promise.resolve({});
      },
    },
    kernel(desc) {
      const k = new Kernel(this, desc);
      // Preserve real build/state/check behavior; replace only command encoding.
      k.dispatch = (_frame, size, args) => { k.check(); dispatches.push({ name: k.name, size, args }); };
      kernels.set(desc.name, k);
      return k;
    },
  };
  const sim = new Simulation(gpu, 32, 32, 32, opts);
  return { sim, builds, dispatches, writes, clears, kernels, gate };
}
function watch(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

// A grid builds only the writers and readers a native host goes through: the brush and the load
// now (a write never waits), a window's shift passes, a test page's readback; V1's step kernels (move,
// react, the activity map) and its Mix/undo-shift edits went with V1 (or build on first use). The
// first frame waits for the import pipeline alone: the blank state is a load.
const native = fixture({ windowed: true }, 'all');
const initial = ['paint', 'fromAtlas', 'shift', 'flowShift', 'toAtlas'];
assert.deepEqual(native.builds, initial);
assert.equal(native.sim.kernels, undefined, 'no V1 step kernels');
for (const name of ['move', 'react', 'inertList', 'inert', 'quiet', 'drawn', 'move1', 'args', 'paintMix', 'undoShift', 'awake', 'copy'])
  assert(!native.kernels.has(name), `${name} is not built`);
const nativeReady = watch(native.sim.ready);
for (const name of initial.filter(name => name !== 'fromAtlas')) native.gate(name).resolve({});
await turn();
assert.equal(nativeReady(), false, 'initialization waits for import pipeline');
assert.equal(native.sim.version, 0);
assert.equal(native.dispatches.length, 0);
native.gate('fromAtlas').resolve({});
assert.equal(await native.sim.ready, native.sim);
assert.deepEqual(native.dispatches.map(c => c.name), ['fromAtlas'], 'blank state is still loaded');
assert.equal(native.sim.wholeWrites, 1);
assert.equal(native.sim.version, 1);
assert(native.writes.some(name => name.endsWith('atlas scratch')));
assert(native.clears.some(name => name.endsWith('flow')));
assert.deepEqual(native.builds, initial, 'ready starts no further builds');
assert.throws(() => native.sim.step(), /no ready native owner/, 'no owner: a step is an error, never V1');
assert.equal(native.sim.frame, 0, 'failed early step does not advance time');
// Every grid keeps one legacy copy (the import/export format's): a window too, from its start (V1's step
// kept two in every window); a V1-format shift before its owner is ready grows a second (sim.shift's
// out-of-place move), which the owner's activation drops again (PhysicsV2.activate: pingPong(false)).
assert.equal(native.sim.copies, 1, 'a window boots with one legacy copy');
assert.equal(fixture({}, []).sim.copies, 1, 'a box too');
const slotBytes = 16 + 16 + 4;
assert.equal(native.sim.state.A.size + native.sim.state.B.size + native.sim.state.F.size, native.sim.g.slots * slotBytes);
native.sim.pingPong(true);
assert.equal(native.sim.copies, 2, 'a pre-owner V1-format shift takes a second copy');
native.sim.pingPong(false);
assert.equal(native.sim.copies, 2, 'a window without an owner keeps it (its shift is out of place)');
native.sim.compact = { isReady: true };
native.sim.pingPong(false);
assert.equal(native.sim.copies, 1, 'the owner presenting the window drops it');
native.sim.compact = null;

const badInit = fixture({}, ['fromAtlas']);
const initError = new Error('initial import compile failed');
badInit.gate('fromAtlas').reject(initError);
await assert.rejects(badInit.sim.ready, error => error === initError);
assert.equal(badInit.sim.version, 0);
assert.equal(badInit.dispatches.length, 0);
assert.throws(() => badInit.sim.step(), /no ready native owner/);

// Wiring: every grid starts native (Physics V2 is the only engine), a guest's too (its owner holds the
// host's frames and, once the session ends, steps them: net/codec.js, app.js v2Replica); outcomes opt in;
// a save's physicsV2 section restores into the grid's own owner and never switches engines.
const app = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
assert.match(app, /sim = new Simulation\(gpu, nx, ny, nz, \{ windowed: !!worldMode, world: worldMode\?\.size \}\);\n  physicsV2 = new V2mod\.PhysicsV2\(sim, V2mod\.options\);/);
assert(!/setPhysics|params\.get\('physics'\)/.test(app), 'no engine switch and no ?physics= flag');
const outcomes = readFileSync(new URL('../outcomes/engine-v2.js', import.meta.url), 'utf8');
assert.match(outcomes, /new Simulation\(gpu, nx, ny, nz, \{ debug: false \}\)/);
// (a scene throws, blasts and pours: it waits for the dynamics and the jets, which build behind the grid: physics.js dynamicsReady)
assert.match(outcomes, /await Promise\.all\(\[sim\.ready, kernel\.ready, v2\.dynamicsReady\]\)/);
const saves = readFileSync(new URL('../../src/wire/saves.js', import.meta.url), 'utf8');
// (a save made under V1 imports into V2: tools/v2/saves-check.mjs)
assert(!saves.includes('setPhysics'), 'the save loader never switches engines');
assert.match(saves, /if \(state\.mode === 'v1'\) v2\.resync\(\);/);
console.log('native startup CPU: V2-only builds (no V1 step kernels), retained initialization, one legacy copy a grid (a second only for a window\'s pre-owner shift), failure propagation and V2-only wiring passed');
