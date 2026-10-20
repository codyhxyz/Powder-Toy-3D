import * as THREE from 'three';
import { createWeather, WEATHER_STEPS_PER_SECOND } from '../weather.js';
import { createElementWeather } from '../elementWeather.js';
import { createOceanEvents } from '../oceanEvents.js';
import { createLighthouse } from '../gfx/lighthouse.js';
import { gfxUniforms } from '../gfx/uniforms.js';
import { dayPhase } from '../gfx/daylight.js';
import { CELL_M } from '../scale.js';
import { isMaterialView } from '../views.js';

export const weather = createWeather();
const eye = new THREE.Vector3();
const inverseVolume = new THREE.Matrix4();
let lastBolt = null;
const thunderTimes = [];
let clock = 0, world = null, epoch = -1, simulation = null;
let terrainWorld = null, groundHeight = () => NaN;
// Weather runs on every map, a box's as a world's (CLAUDE.md "Same features in
// every world"): its clouds and rain are real elements in the top of whatever
// grid is simulated. Only the sea's own effects (sea fog, chop, tsunamis) need
// a world's sea level and the open ocean past its window (oceanEvents.js).
const BOX_SEA_LEVEL = 0;   // cells: a box has no sea of its own here, so the cloud band sits under its lid (elementWeather.js)
const enabled = app => (!app.win || app.win.loaded) && !app.mp.isGuest && !app.mp.replica;
const hasSea = app => !!app.win && app.win.P.sea > 0;
function oceanContext(app) {
  const { win, sim } = app;
  if (terrainWorld !== win) {
    terrainWorld = win;
    // Stable identity lets the ocean cache its generator-derived edge mask.
    groundHeight = (x, z) => {
      if (!win || !Number.isFinite(x) || !Number.isFinite(z)) return NaN;
      if (x < 0 || z < 0 || x >= win.size[0] || z >= win.size[2]) return win.P.floor;
      return win.scene.ground(Math.floor(x), Math.floor(z), win.P);
    };
  }
  // Ocean candidates use world cells: scene -> local grid -> streamed origin.
  app.volume.worldToLocal(app.camera.getWorldPosition(eye)).add(sim.origin);
  return {
    sim, stepHz: sim.compact ? 60 : WEATHER_STEPS_PER_SECOND, world: win, mapId: win ? `${win.scene.key}:${win.P.seed}` : null,
    seaLevel: win?.P.sea, target: [eye.x, eye.z],
    oceanEligible: enabled(app) && hasSea(app), isGuest: app.mp.isGuest || app.mp.replica,
    groundHeight,
  };
}
function reset(app) {
  // Map lifecycle only. Clear/Stop sources calls weather.reset directly and
  // must not discharge surviving storm clouds.
  app.lightning?.reset();
  weather.reset(0);
  app.elementWeather?.reset(); app.oceanEvents?.reset(); app.lighthouse?.reset();
  lastBolt = null; thunderTimes.length = 0;
  app.pov?.audio?.setWeather({ paused: true });
  clock = 0; world = app.win; epoch = world?.epoch; simulation = app.sim;
  weather.setOceanEligible(false);
}
function observeWorld(app) {
  if (world !== app.win || epoch !== app.win?.epoch || simulation !== app.sim) reset(app);
}
const wire = {
  name: 'weather', ready: true,
  boot(app) {
    app.weather = weather;
    app.elementWeather = createElementWeather();
    app.oceanEvents = createOceanEvents();
    app.lighthouse = createLighthouse({ onChange: () => app.pacer.wake() });
    app.resetWeather = () => reset(app);
    let fog = weather.selection.fog;
    weather.subscribe(() => {
      const next = weather.selection.fog;
      if (fog !== 'off' && next === 'off' && enabled(app) &&
          world === app.win && epoch === app.win?.epoch && simulation === app.sim) {
        app.elementWeather.clearFog({ sim: app.sim, world: app.win, host: true });
      }
      fog = next;
      app.pacer.wake();
    });
    weather.setTsunamiHooks({
      trigger: () => enabled(app) ? app.oceanEvents.trigger(oceanContext(app)) : false,
      cancel: () => app.oceanEvents.cancel(),
    });
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
      enabled: true, seaLevel: app.win ? app.win.P.sea : BOX_SEA_LEVEL,
      fogEnabled: weather.selection.fog !== 'off' && hasSea(app),
    });
    const active = app.oceanEvents.active;
    if (active || (weather.state.ocean > 0 && hasSea(app)))   // (a box's Rain keeps its ocean share idle: no sea)
      app.oceanEvents.step(weather.state, { ...oceanContext(app), paused: false, stepHz: hz });
    if (active && !app.oceanEvents.active) weather.finishTsunami();
  },
  afterStep(app) {
    observeWorld(app); // also catches reloads while paused
    weather.setOceanEligible(enabled(app) && hasSea(app));
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
      (weather.state.cloud + weather.state.fog + weather.state.ocean > 0 ||
        weather.tsunami.active || gfxUniforms.uBeaconDir.value[3] > 0);
  },
  invalidate(app) { reset(app); },
};
export default wire;
