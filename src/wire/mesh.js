// The scene's meshes besides the figures (docs/webgpu.md F8, U13): the
// spawners, the perk orbs, an arena's team banners and the constructions
// (their ghost and their stamps). three.js draws them; U13 ports their
// materials to TSL and compiles each new kind before it joins the scene
// (gpu.three.prepare). Moved here from app.js as it was: U13 ports it. Until
// then no mesh is in the scene (a box frame needs nothing from three.js) and
// app.js greys out the spawner and construction tools.
import { Spawners } from '../spawners.js';
import { PerkOrbs } from '../perkOrbs.js';
import { ArenaMarkers } from '../arenas/markers.js';
import { Constructions } from '../constructions.js';

const mesh = {
  name: 'mesh',
  ready: false,

  boot(app) {
    const env = { scene: app.scene, getSim: () => app.sim, getVolume: () => app.volume, getScale: () => app.scale };
    app.spawners = new Spawners(env);   // seeded by build()'s loadPreset, once there is a grid
    app.perkOrbs = new PerkOrbs(env);
    app.arenaMarkers = new ArenaMarkers(env);
    app.builds = new Constructions({
      ...env, camera: app.camera, settings: app.settings, onClose: app.leaveBuild,
      requestRender: () => app.requestRender(),
      // a shrine: a random perk orb over each plinth
      onPlaced: ({ key, anchors }) => { if (key === 'SHRINE') app.lastShrine = app.perkOrbs?.shrineAt(anchors)?.[0]?.shrine ?? 0; },
    });
  },
  afterStep(app) {
    const { spawners, pov } = app;
    spawners.setGhosts(!pov?.active);   // the crosshair cell stays fresh for the tools
    spawners.update();
    // they hold still with the world, like the birds: on wall-clock time they moved every
    // frame, so the view key never settled and a paused scene redrew at full rate
    app.perkOrbs.update(app.animTime);
    app.arenaMarkers.update(app.animTime);
  },
};

export default mesh;
