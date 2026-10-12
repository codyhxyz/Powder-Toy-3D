// The scene's meshes besides the figures (docs/webgpu.md F8, U13): the
// spawners, the perk orbs, an arena's team banners and the constructions
// (their ghost and their stamps), and the frame's part in every mesh three.js
// draws: the figures' light (gfx/meshLight.js: the grid's shadow map, GI and
// light volume as external textures, the sun and sky), the held tool's
// targets for post's canvas pass (pov/viewmodel.js, F3) and the other
// players' brushes (net/cursors.js, our pipeline in the scene pass).
//
// A module that adds a new kind of mesh compiles it before it joins the scene
// (prepareMesh, gpu.three.prepare). One that doesn't, or swaps a material,
// still never costs a synchronous pipeline build at a draw: beforeView parks
// any mesh three hasn't compiled on a layer no camera sees until it has
// (guardMeshes), and wakes the frame loop when it shows.
import { Spawners } from '../spawners.js';
import { PerkOrbs } from '../perkOrbs.js';
import { ArenaMarkers } from '../arenas/markers.js';
import { Constructions } from '../constructions.js';
import { setMeshGpu, getMeshGpu, updateMeshLight, guardMeshes } from '../gfx/meshLight.js';
import { takeViewmodel } from '../pov/viewmodel.js';
import { drawRemoteCursors } from '../net/cursors.js';

// the held tool's subtree has its own targets and camera (pov/viewmodel.js guards it)
const ownPass = (o) => o.name === 'pov-viewmodel';

const mesh = {
  name: 'mesh',
  ready: true,
  order: 0,   // the other players' brushes: after the volume, like your own

  boot(app) {
    setMeshGpu(app.gpu);
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
  beforeView(app) {
    if (getMeshGpu() !== app.gpu) setMeshGpu(app.gpu);   // (a device replaced at Start)
    updateMeshLight(app);
    // what the held tool's pass drew this frame (src/wire/pov.js runs it first) goes to post
    const vm = takeViewmodel();
    app.viewmodel = vm?.viewmodel ?? null;
    app.glow = vm?.glow ?? null;
    guardMeshes(app.scene, app.camera, { skip: ownPass, onReady: () => app.requestRender() });
  },
  scene(app, rp) { drawRemoteCursors(rp); },
};

export default mesh;
