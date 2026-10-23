import * as THREE from 'three';
import { createWeather, WEATHER_STEPS_PER_SECOND } from '../weather.js';
import { createElementWeather } from '../elementWeather.js';
import { createLighthouse } from '../gfx/lighthouse.js';
import { gfxUniforms } from '../gfx/uniforms.js';
import { dayPhase } from '../gfx/daylight.js';
import { CELL_M } from '../scale.js';
import { isMaterialView } from '../views.js';
import { BOX_SEA_LEVEL } from '../mapKind.js';

export const weather = createWeather();
const eye = new THREE.Vector3();
const inverseVolume = new THREE.Matrix4();
let lastBolt = null;
const thunderTimes = [];
let clock = 0, world = null, epoch = -1, simulation = null;
// Weather runs on every map, a box's as a world's (CLAUDE.md "Same features in
// every world"): its clouds and rain are real elements in the top of whatever
// grid is simulated.
const enabled = app => (!app.mapKind.streamed || app.win.loaded) && !app.mp.isGuest && !app.mp.replica;
function reset(app) {
  // Map lifecycle only. Clear/Stop sources calls weather.reset directly and
  // must not discharge surviving storm clouds.
  app.lightning?.reset();
  weather.reset(0);
  app.elementWeather?.reset(); app.lighthouse?.reset();
  lastBolt = null; thunderTimes.length = 0;
  app.pov?.audio?.setWeather({ paused: true });
  clock = 0; world = app.win; epoch = world?.epoch; simulation = app.sim;
}
function observeWorld(app) {
  if (world !== app.win || epoch !== app.win?.epoch || simulation !== app.sim) reset(app);
}
const wire = {
  name: 'weather', ready: true,
  boot(app) {
    app.weather = weather;
    app.elementWeather = createElementWeather();
    app.lighthouse = createLighthouse({ onChange: () => app.pacer.wake() });
    app.resetWeather = () => reset(app);
    weather.subscribe(() => app.pacer.wake());
  },
  attach: reset,
  detach: reset,
  // Called once BEFORE each host sim.step, including explicit manual test steps.
  // Neither render-only ticks nor async compilation callbacks call this.
  step(app, { hz = WEATHER_STEPS_PER_SECOND } = {}) {
    observeWorld(app);
    if (!enabled(app)) return;
    weather.update(clock += 1 / hz);
    app.elementWeather.step(weather.state, {
      sim: app.sim, world: app.win, advancing: true, host: true, stepHz: hz,
      enabled: true, seaLevel: app.mapKind.seaLevel ?? app.win.P.sea,   // (a box's: BOX_SEA_LEVEL, under its lid)
    });
  },
  afterStep(app) {
    observeWorld(app); // also catches reloads while paused
    app.lighthouse.update({ time: clock }, {
      world: app.win, sim: app.sim, dayPhase: dayPhase(app.day.clock),
      enabled: enabled(app) && isMaterialView(app.renderView),
    });
    // Sound follows actual committed bolts, never an independent flash timer.
    const bolt = app.lightning?.lastBolt;
    if (enabled(app) && bolt && bolt !== lastBolt) {
      app.volume.updateMatrixWorld();
      app.camera.getWorldPosition(eye).applyMatrix4(inverseVolume.copy(app.volume.matrixWorld).invert());
      const distance = Math.hypot(...bolt.to.map((v, i) => v - eye.getComponent(i))) * CELL_M;
      thunderTimes.push(clock + distance / 343);
      thunderTimes.sort((a, b) => a - b);
      if (thunderTimes.length > 8) thunderTimes.pop();
    }
    lastBolt = bolt;
    let thunder = false;
    if (!app.settings.paused) while (thunderTimes[0] <= clock) { thunder = true; thunderTimes.shift(); }
    app.pov?.audio?.setWeather({
      rain: weather.state.rain, thunder, paused: !enabled(app) || app.settings.paused,
    });
  },
  busy(app) {
    return enabled(app) && !app.settings.paused &&
      (weather.state.cloud > 0 || gfxUniforms.uBeaconDir.value[3] > 0);
  },
  invalidate(app) { reset(app); },
};
export default wire;
