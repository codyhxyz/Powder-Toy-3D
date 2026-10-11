// Birds (src/birds; docs/webgpu.md G4, U12, U13): a World's ambient flocks
// and the Bird flock spawners', their ground probe (a thread per column) and
// their meshes. Moved here from app.js as it was (WebGL): U12 and U13 port it.
// Until then no birds fly and app.js greys out the Bird flock spawner.
import { createBirdLife } from '../birds/index.js';
import { BODY_HEIGHT } from '../pov/constants.js';
import { dayPhase, sunElevation } from '../gfx/daylight.js';

const birds = {
  name: 'birds',
  ready: false,

  boot(app) {
    app.birds = createBirdLife({
      renderer: app.renderer, scene: app.scene, camera: app.camera, sun: app.sun,
      getSim: () => app.sim, getVolume: () => app.volume, getScale: () => app.scale, getWin: () => app.win, getSpawners: () => app.spawners,
      sunEl: () => sunElevation(dayPhase(app.day.clock), app.day.fixed),
      // the body in first person, at its middle (world cells): it flushes birds near it
      player: () => (app.pov?.active && app.pov.player && !app.pov.player.dead
        ? { x: app.pov.player.pos.x + app.sim.origin.x, y: app.pov.player.pos.y + BODY_HEIGHT / 2, z: app.pov.player.pos.z + app.sim.origin.z } : null),
    });
  },
  afterStep(app, dt) {
    app.prof.phase('other');   // (their probe pass, birdProbe, counts here)
    app.birds.update(app.settings.paused ? 0 : dt);   // they hold still with the world
    if (!app.settings.paused && app.birds.count) app.requestRender();
  },
  // they fly every tick: the default World scene never settles (docs/webgpu.md F7, K3)
  busy(app) { return !app.settings.paused && app.birds.count > 0; },
  invalidate(app) { app.birds.probe.suspend(); },
};

export default birds;
