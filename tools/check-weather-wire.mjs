import assert from 'node:assert/strict';
import * as THREE from 'three';
import wire, { weather } from '../src/wire/weather.js';
const calls = { source: 0, ocean: 0, sourceReset: 0, oceanReset: 0, light: 0, lightningReset: 0 };
const sim = { id: 1, frame: 0 };
const world = { sim, loaded: true, epoch: 1, P: { sea: 20, floor: 2, seed: 1 },
  size: [512, 64, 512], scene: { key: 'island', ground: () => 8 }, far: { sceneToWorld: new THREE.Matrix4() } };
const app = {
  sim, win: world, mp: { isGuest: false }, day: { clock: 0 }, settings: { paused: true, view: 0 },
  pacer: { wake() {} }, camera: new THREE.PerspectiveCamera(), volume: new THREE.Object3D(),
  lightning: { lastBolt: null, reset() { calls.lightningReset++; } },
};
wire.boot(app);
app.elementWeather = { reset() { calls.sourceReset++; }, step(state, ctx) {
  assert(ctx.advancing && ctx.host); assert.equal(ctx.sim, sim); calls.source++;
} };
let arm;
app.oceanEvents = {
  active: false, reset() { this.active = false; calls.oceanReset++; },
  step() { calls.ocean++; },
  trigger: () => new Promise(resolve => { arm = resolve; }),
  cancel() { this.active = false; },
};
app.lighthouse = { reset() {}, update() { calls.light++; } };
wire.attach(app); wire.afterStep(app);
assert.equal(weather.tsunami.eligible, true);
weather.setPreset('storm');
for (let i = 0; i < 5; i++) wire.afterStep(app);
assert.equal(calls.source, 0); assert.equal(calls.ocean, 0);
assert.equal(weather.state.time, 0, 'paused/render-only hooks do not advance weather');
wire.step(app); // an explicitly permitted manual step, even though the UI remains paused
assert.equal(calls.source, 1); assert.equal(calls.ocean, 1);
assert.equal(weather.state.time, 1 / 240);
app.mp.isGuest = true; wire.step(app);
assert.equal(calls.source, 1); assert.equal(calls.ocean, 1);
app.mp.isGuest = false;
const pending = weather.triggerTsunami();
assert.equal(weather.tsunami.pending, true);
world.epoch++;
wire.afterStep(app); arm(true);
assert.equal(await pending, false);
assert.equal(weather.tsunami.active, false);
assert.equal(weather.state.preset, 'clear');
assert.equal(weather.state.time, 0);
const resets = calls.lightningReset;
weather.setPreset('storm'); wire.step(app);
weather.setPreset('clear'); weather.reset();
assert.equal(calls.lightningReset, resets, 'Clear/Stop must not reset natural charged-cloud reactions');
const forced = calls.ocean;
wire.step(app);
assert.equal(calls.ocean, forced, 'calm, inactive ocean does no context/mask work');
wire.afterStep(app);
assert.equal(wire.busy(app), false);
app.settings.paused = false;
assert.equal(wire.busy(app), false, 'clear daytime does not keep presentation running');
app.win = null; wire.afterStep(app);
assert.equal(weather.tsunami.eligible, false);
app.win = world;
world.epoch++; wire.attach(app);
weather.setPreset('storm');
const nativeSources = calls.source;
for (let i = 0; i < 60; i++) { wire.step(app, { hz: 60 }); sim.frame++; }
assert(Math.abs(weather.state.time - 1) < 1e-12, '60 native host ticks advance weather by exactly one second');
assert.equal(calls.source - nativeSources, 60, 'native host retains every weather source hook');
app.mp.isGuest = true; wire.step(app, { hz: 60 });
assert.equal(calls.source - nativeSources, 60, 'native guests still never emit weather');
weather.dispose();
console.log('Weather wire CPU: render-only/guest/manual gating, paused reload cancellation, clear semantics and idle passed.');
