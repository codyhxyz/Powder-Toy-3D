// CPU-only regression: exercise the real weather wire with Three transforms.
import assert from 'node:assert/strict';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import wire, { weather } from '../src/wire/weather.js';

const volume = new Object3D();
volume.position.set(-12, 4, 8);
volume.rotation.set(0.2, 0.4, -0.1);
volume.scale.setScalar(0.125);
volume.updateMatrixWorld();
const camera = new PerspectiveCamera();
const rig = new Object3D();
rig.position.set(3, 2, -5);
rig.add(camera);
const localEye = new Vector3(24, 30, 40);
camera.position.copy(localEye).applyMatrix4(volume.matrixWorld).sub(rig.position);
const app = {
  volume, camera, sim: { id: 1, frame: 0, origin: new Vector3(100, 0, 200) },
  win: {
    loaded: true, epoch: 1, far: {}, // FarField has no sceneToWorld property.
    size: [1024, 128, 1024], P: { sea: 20, floor: 2, seed: 7 },
    scene: { key: 'coast', ground: () => 8 },
  },
  mp: { isGuest: false }, pacer: { wake() {} },
  day: { clock: 0 }, settings: { paused: true, view: 0 },
  lightning: { lastBolt: null, reset() { calls.lightningReset++; } },
};
const calls = { source: 0, lightningReset: 0 };
wire.boot(app);
assert.equal('oceanEvents' in app, false, 'sea fog, chop and tsunamis were removed (user request, 2026-10-20)');
let seen = null;
app.elementWeather = { step(state, ctx) {
  assert(ctx.advancing && ctx.host);
  assert.equal(ctx.sim, app.sim);
  assert.equal('fogEnabled' in ctx, false, 'no sea fog band');
  seen = ctx;
  calls.source++;
}, reset() {} };
wire.attach(app); wire.afterStep(app);
try {
  weather.setPreset('storm');
  for (let i = 0; i < 5; i++) wire.afterStep(app);
  assert.equal(calls.source, 0);
  assert.equal(weather.state.time, 0, 'paused/render-only hooks do not advance weather');
  wire.step(app); // Explicit manual step is allowed while the UI is paused.
  assert.equal(calls.source, 1);
  assert.equal(weather.state.time, 1 / 240);
  assert.equal(seen.world, app.win);
  assert.equal(seen.seaLevel, app.win.P.sea, 'a world\'s clouds count their height from its sea');
  app.mp.isGuest = true; wire.step(app);
  assert.equal(calls.source, 1);
  app.mp.isGuest = false;

  // A reload resets the sky.
  app.win.epoch++;
  wire.afterStep(app);
  assert.equal(weather.state.preset, 'clear');
  assert.equal(weather.state.time, 0);
  const resets = calls.lightningReset;
  weather.setPreset('storm'); wire.step(app);
  weather.setPreset('clear'); weather.reset();
  assert.equal(calls.lightningReset, resets, 'Clear/Stop must not reset natural charged-cloud reactions');
  wire.afterStep(app);
  assert.equal(wire.busy(app), false);
  app.settings.paused = false;
  assert.equal(wire.busy(app), false, 'clear daytime does not keep presentation running');
  weather.setPreset('rain'); wire.step(app);
  assert.equal(wire.busy(app), true, 'clouds keep presentation running');
  weather.setPreset('clear'); weather.reset();
  app.win.epoch++; wire.attach(app);
  weather.setPreset('storm');
  const nativeSources = calls.source;
  for (let i = 0; i < 60; i++) { wire.step(app, { hz: 60 }); app.sim.frame++; }
  assert(Math.abs(weather.state.time - 1) < 1e-12, '60 native host ticks advance weather by exactly one second');
  assert.equal(calls.source - nativeSources, 60, 'native host retains every weather source hook');
  app.mp.isGuest = true; wire.step(app, { hz: 60 });
  assert.equal(calls.source - nativeSources, 60, 'native guests still never emit weather');
  app.mp.isGuest = false;
  app.win = null; wire.afterStep(app);
  // A box runs the same sky and rain (CLAUDE.md "Same features in every world").
  weather.setPreset('rain');
  const boxSources = calls.source;
  wire.step(app);
  assert.equal(calls.source, boxSources + 1, 'a box emits weather sources');
  assert.equal(seen.world, null);
  assert.equal(seen.enabled, true, 'a box opts in to the element weather policy');
  assert.ok(Number.isFinite(seen.seaLevel), 'a box gives the policy a finite sea level');
  app.mp.isGuest = true; wire.step(app);
  assert.equal(calls.source, boxSources + 1, 'box guests never emit weather');
  app.mp.isGuest = false;
} finally {
  weather.dispose();
  app.lighthouse.dispose();
}
console.log('Weather wire CPU checks passed: box and world sky and rain, no sea fog/chop/tsunami, native 60Hz clock, render-only/guest/manual gating, reload reset, clear semantics and idle.');
