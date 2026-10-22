// CPU only: real Simulation + Kernel readiness, controlled pipeline promises.
// Dispatches record commands, not WGSL execution; no device/browser/launcher.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation } from '../../src/sim.js';
import { Kernel } from '../../src/gpu/kernels.js';

const LEGACY = ['move', 'react', 'inertList', 'inert', 'quiet', 'drawn', 'move1', 'args'];
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
    queue: { writeBuffer(b, at, data) {
      writes.push(b.label);
      b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at);
    } },
    write(b, at, data) { this.queue.writeBuffer(b, at, data); },
    frame: { clear(b) { clears.push(b.label); b.data.fill(0); } },
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

// Native startup skips exactly eight builds, not initial edits/import/window passes; V1's edit
// passes a native host never records (Mix, undo across a shift: both native there) build with V1's
// stepping (prepareLegacy) or on first use, so the first frame never waits for them.
const native = fixture({ nativeStartup: true, windowed: true }, 'all');
const initial = ['paint', 'fromAtlas', 'awake', 'shift', 'flowShift', 'copy', 'toAtlas'];
const V1_EDITS = ['paintMix', 'paintMix apply', 'undoShift'];
assert.deepEqual(native.builds, initial);
assert.deepEqual(Object.keys(native.sim.kernels), LEGACY);
for (const name of LEGACY) {
  assert.equal(native.kernels.get(name).when, 'manual');
  assert.equal(native.kernels.get(name).state, 'idle');
}
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
assert.deepEqual(native.builds, initial, 'ready does not start deferred builds');
assert.throws(() => native.sim.step(), /await sim.prepareLegacy/);
assert.equal(native.sim.frame, 0, 'failed early step does not advance time');

// Default/explicit-false v1 callers retain eager construction and sim.ready.
for (const opts of [{}, { nativeStartup: false }]) {
  const old = fixture(opts, ['args']);
  assert.deepEqual(old.builds.slice(0, 8), LEGACY);
  assert.deepEqual(old.builds.slice(8, 14), ['paint', 'paintMix', 'paintMix apply', 'fromAtlas', 'undoShift', 'awake'], 'V1 builds its edit passes now, in its order');
  assert(LEGACY.every(name => old.kernels.get(name).when === 'now'));
  const ready = watch(old.sim.ready);
  await turn();
  assert.equal(ready(), false, 'v1 ready still includes legacy readiness');
  old.gate('args').resolve({});
  await old.sim.ready;
  old.sim.step();
  const count = old.builds.length;
  await old.sim.prepareLegacy();
  assert.equal(old.builds.length, count);
}

const badInit = fixture({ nativeStartup: true }, ['fromAtlas']);
const initError = new Error('initial import compile failed');
badInit.gate('fromAtlas').reject(initError);
await assert.rejects(badInit.sim.ready, error => error === initError);
assert.equal(badInit.sim.version, 0);
assert.equal(badInit.dispatches.length, 0);
await assert.rejects(badInit.sim.prepareLegacy(), error => error === initError);
assert.throws(() => badInit.sim.step(), /await sim.prepareLegacy/);

// Wiring: every grid starts native (Physics V2 is the only engine), a guest's too (its owner holds the
// host's frames and, once the session ends, steps them: net/codec.js, app.js v2Replica); outcomes opt in;
// a save's physicsV2 section restores into the grid's own owner and never switches engines.
const app = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
assert.match(app, /sim = new Simulation\(gpu, nx, ny, nz, \{ windowed: !!worldMode, world: worldMode\?\.size, nativeStartup: true \}\);\n  physicsV2 = new V2mod\.PhysicsV2\(sim, V2mod\.options\);/);
assert(!/setPhysics|params\.get\('physics'\)/.test(app), 'no engine switch and no ?physics= flag');
const outcomes = readFileSync(new URL('../outcomes/engine-v2.js', import.meta.url), 'utf8');
assert.match(outcomes, /new Simulation\(gpu, nx, ny, nz, \{ debug: false, nativeStartup: true \}\)/);
// (a scene throws, blasts and pours: it waits for the dynamics and the jets, which build behind the grid: physics.js dynamicsReady)
assert.match(outcomes, /await Promise\.all\(\[sim\.ready, kernel\.ready, v2\.dynamicsReady\]\)/);
const saves = readFileSync(new URL('../../src/wire/saves.js', import.meta.url), 'utf8');
// (a save made under V1 imports into V2: tools/v2/saves-check.mjs)
assert(!saves.includes('setPhysics'), 'the save loader never switches engines');
assert.match(saves, /if \(state\.mode === 'v1'\) v2\.resync\(\);/);
console.log('native startup CPU: eight manual kernels, retained initialization, unchanged v1 construction, failure propagation and V2-only wiring passed');
