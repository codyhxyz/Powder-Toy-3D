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
const calls = { source: 0, ocean: 0, lightningReset: 0 };
wire.boot(app);
let stepped = null, triggered = null, arm = null;
app.elementWeather = { step(state, ctx) {
  assert(ctx.advancing && ctx.host);
  assert.equal(ctx.sim, app.sim);
  calls.source++;
}, reset() {} };
app.oceanEvents = {
  active: false, reset() { this.active = false; }, cancel() { this.active = false; },
  step(state, context) { calls.ocean++; stepped = { ocean: state.ocean, context }; },
  async trigger(context) {
    triggered = context;
    return arm ? new Promise(resolve => { arm = resolve; }) : true;
  },
};
wire.attach(app); wire.afterStep(app);
assert.equal(weather.tsunami.eligible, true);
function checkContext(context) {
  const expected = localEye.clone().add(app.sim.origin);
  assert.ok(Math.abs(context.target[0] - expected.x) < 1e-9);
  assert.ok(Math.abs(context.target[1] - expected.z) < 1e-9);
  assert.equal(context.sim, app.sim);
  assert.equal(context.groundHeight(124, 240), 8);
}
try {
  weather.setPreset('storm');
  for (let i = 0; i < 5; i++) wire.afterStep(app);
  assert.equal(calls.source, 0); assert.equal(calls.ocean, 0);
  assert.equal(weather.state.time, 0, 'paused/render-only hooks do not advance weather');
  wire.step(app); // Explicit manual step is allowed while the UI is paused.
  assert.equal(calls.source, 1); assert.equal(calls.ocean, 1);
  assert.equal(weather.state.time, 1 / 240);
  app.mp.isGuest = true; wire.step(app);
  assert.equal(calls.source, 1); assert.equal(calls.ocean, 1);
  app.mp.isGuest = false;
  for (const mode of ['choppy', 'rough']) {
    weather.setOcean(mode);
    stepped = null;
    wire.step(app);
    assert.ok(stepped?.ocean > 0, `${mode} reaches ocean forcing without stopping the loop`);
    checkContext(stepped.context);
  }
  assert.equal(await weather.triggerTsunami(), true);
  assert.equal(weather.tsunami.error, '');
  checkContext(triggered);
  weather.cancelTsunami();
  // Streaming moves the grid origin, not the camera's local cell coordinates.
  app.sim.origin.set(300, 0, 400);
  wire.step(app);
  checkContext(stepped.context);
  weather.setOcean('calm');
  stepped = null;
  wire.step(app);
  assert.equal(stepped, null);

  arm = true;
  const pending = weather.triggerTsunami();
  assert.equal(weather.tsunami.pending, true);
  app.win.epoch++;
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
} finally {
  weather.dispose();
  app.lighthouse.dispose();
}
console.log('Weather wire CPU checks passed: ocean controls/transforms, render-only/guest/manual gating, reload cancellation, clear semantics and idle.');
