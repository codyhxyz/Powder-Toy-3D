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

// Exercise the actual app method without booting DOM/WebGPU. All external app
// state is injected; persisted saves call this same method, verified below.
const app = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const start = app.indexOf('async setPhysics(mode) {');
const end = app.indexOf('\n    get physics()', start);
assert(start >= 0 && end > start);
const method = app.slice(start, end).trim().replace(/,$/, '');
const setter = state => new Function('state', `with (state) { return ({ ${method} }).setPhysics; }`)(state);
function appState(sim) {
  const state = {
    sim, physicsMode: 'v2', physicsChanging: false, V2mod: null, v2Running: true, mp: { isGuest: false },
    pacer: { wake() {} }, wakeLoop() {},
  };
  state.physicsV2 = {
    sim, isReady: true, ready: Promise.resolve(), ticks(n) { this.tick = (this.tick ?? 0) + n; },
    suspend() { state.sim.compact = null; state.suspended = true; },
  };
  sim.compact = state.physicsV2;
  return state;
}
const state = appState(native.sim);
const switchLegacy = setter(state)('v1');
const switched = watch(switchLegacy);
assert.deepEqual(native.builds.slice(initial.length), [...LEGACY, ...V1_EDITS], 'activation starts all eight builds, and V1\'s edit passes');
for (const name of V1_EDITS) native.gate(name).resolve({});
for (const name of LEGACY.slice(0, -1)) {
  native.gate(name).resolve({});
  await turn();
  assert.equal(switched(), false);
  assert.equal(state.physicsMode, 'v2', 'running loop must not see v1 while any build is pending');
  assert.equal(state.suspended, undefined);
  native.sim.step();
}
assert.equal(state.physicsV2.tick, 7, 'native stepping remains available while compiling legacy');
native.gate('args').resolve({});
assert.equal(await switchLegacy, 'v1');
assert.equal(state.physicsMode, 'v1');
assert.equal(state.suspended, true);
assert.equal(state.v2Running, false);
assert.equal(state.physicsChanging, false);
assert(LEGACY.every(name => native.kernels.get(name).state === 'ready'));
native.dispatches.length = 0;
native.sim.step();
assert.deepEqual([...new Set(native.dispatches.map(c => c.name))].sort(), [...LEGACY].sort());
const built = native.builds.length;
await native.sim.prepareLegacy();
assert.equal(native.builds.length, built, 'repeated preparation never rebuilds');

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

// A map rebuilt during preparation must prepare its new sim before publication.
const first = fixture({ nativeStartup: true }, LEGACY), second = fixture({ nativeStartup: true }, LEGACY);
await Promise.all([first.sim.ready, second.sim.ready]);
const replaced = appState(first.sim);
const replaceSwitch = setter(replaced)('v1');
replaced.sim = second.sim;
for (const name of LEGACY) first.gate(name).resolve({});
await turn();
assert.equal(replaced.physicsMode, 'v2');
assert.deepEqual(second.builds.slice(-(LEGACY.length + V1_EDITS.length)), [...LEGACY, ...V1_EDITS]);
for (const name of LEGACY) second.gate(name).resolve({});
await replaceSwitch;
assert.equal(replaced.physicsMode, 'v1');
assert.equal(second.sim._legacyDeferred, false);

// Preparation failure rejects the caller and never publishes v1 or enables steps.
const failed = fixture({ nativeStartup: true }, LEGACY);
await failed.sim.ready;
const failureState = appState(failed.sim);
const failureSwitch = setter(failureState)('v1');
const compileError = new Error('legacy compile failed');
failed.gate('react').reject(compileError);
for (const name of LEGACY.filter(name => name !== 'react')) failed.gate(name).resolve({});
await assert.rejects(failureSwitch, error => error === compileError);
assert.equal(failureState.physicsMode, 'v2');
assert.equal(failureState.suspended, undefined);
assert.equal(failureState.physicsChanging, false, 'failed legacy builds release serialization without publishing V1');
failed.sim.compact = null;
assert.throws(() => failed.sim.step(), /await sim.prepareLegacy/);
await assert.rejects(failed.sim.prepareLegacy(), error => error === compileError);

const badInit = fixture({ nativeStartup: true }, ['fromAtlas']);
const initError = new Error('initial import compile failed');
badInit.gate('fromAtlas').reject(initError);
await assert.rejects(badInit.sim.ready, error => error === initError);
assert.equal(badInit.sim.version, 0);
assert.equal(badInit.dispatches.length, 0);
await assert.rejects(badInit.sim.prepareLegacy(), error => error === initError);
assert.throws(() => badInit.sim.step(), /await sim.prepareLegacy/);

// Wiring: every V2 grid starts native, a guest's too (its owner holds the host's frames and, once the
// session ends, steps them: net/codec.js, app.js v2Replica), outcomes opt in,
// and persisted legacy restore uses the awaitable switch rather than assigning mode.
assert.match(app, /nativeStartup: physicsMode === 'v2' \}\);\n  if \(physicsMode === 'v2'\) \{/);
const outcomes = readFileSync(new URL('../outcomes/engine-v2.js', import.meta.url), 'utf8');
assert.match(outcomes, /new Simulation\(gpu, nx, ny, nz, \{ debug: false, nativeStartup: true \}\)/);
// (a scene throws, blasts and pours: it waits for the dynamics and the jets, which build behind the grid: physics.js dynamicsReady)
assert.match(outcomes, /await Promise\.all\(\[sim\.ready, kernel\.ready, v2\.dynamicsReady\]\)/);
const saves = readFileSync(new URL('../../src/wire/saves.js', import.meta.url), 'utf8');
// (only a V1 session goes back to V1; a V2 session stays on V2: tools/v2/saves-check.mjs)
assert.match(saves, /if \(state\.mode === 'v1'\) \{\s*if \(session === 'v1'\) await app\.setPhysics\('v1'\)/);
console.log('native startup CPU: eight manual kernels, retained initialization, awaited app/saved legacy activation, unchanged v1, map replacement and failure propagation passed');
