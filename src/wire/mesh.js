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
// (guardMeshes), and wakes the frame loop when it shows. A presentation
// effect (gfx/presentation.js) changes the programs of the meshes it bends,
// and back when it is dropped: those compile the same way, parked, before the
// guard runs (compileChanged).
import { Spawners } from '../spawners.js';
import { PerkOrbs } from '../perkOrbs.js';
import { ArenaMarkers } from '../arenas/markers.js';
import { Constructions } from '../constructions.js';
import { setMeshGpu, getMeshGpu, updateMeshLight, guardMeshes, prepareMesh, PENDING_LAYER, PENDING_MASK } from '../gfx/meshLight.js';
import { renderViewmodels } from '../pov/viewmodel.js';
import { drawRemoteCursors } from '../net/cursors.js';
import { muzzleLight } from '../pov/vfx.js';

// the held tool's subtree has its own targets and camera (pov/viewmodel.js guards it)
const ownPass = (o) => o.name === 'pov-viewmodel';

// The meshes the bend just changed (installed, or restored): each compiles its
// new program with its layers parked on the guard's, as guardMeshes does (three
// reads the layers before its first await), and comes back when it's built.
// One parked here whose program changes again (the bend dropped before its
// compile ended) compiles again, and comes back after the last one. One the
// guard has parked is the guard's, with the program it was asked for: it is
// looked at again once the guard lets it go.
const parked = new WeakMap();   // mesh → { mask: the layers it goes back to, serial: its latest compile }
const guards = new Set();       // changed meshes the guard had parked, waiting for it
function compileChanged(app) {
  app.presentation.install(app.scene, app.camera);
  const changed = new Set([...guards, ...app.presentation.takeChanged()]);
  guards.clear();
  for (const o of changed) {
    if (!o.parent) continue;
    let rec = parked.get(o);
    if (!rec && o.layers.mask === PENDING_MASK) { guards.add(o); continue; }
    if (!rec) parked.set(o, rec = { mask: o.layers.mask, serial: 0 });
    else if (o.layers.mask === PENDING_MASK) o.layers.mask = rec.mask;   // (back on its layers while three reads them)
    else rec.mask = o.layers.mask;   // (a module moved it meanwhile: its layers now)
    const serial = ++rec.serial;
    prepareMesh(o, { camera: app.camera, alone: true }).then(() => {
      if (parked.get(o) !== rec || rec.serial !== serial) return;   // (a later compile brings it back)
      if (o.layers.mask === PENDING_MASK) o.layers.mask = rec.mask;
      parked.delete(o);
      app.requestRender();
    });
    o.layers.set(PENDING_LAYER);
  }
}

const mesh = {
  name: 'mesh',
  ready: true,
  order: 0,   // the other players' brushes: after the volume, like your own

  boot(app) {
    setMeshGpu(app.gpu);
    app.scene.add(muzzleLight());   // the scene's one light, from the start (pov/vfx.js muzzleLight)
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
  // a world stamps its shrine and the trees in its glade once its passes are
  // built (src/wire/world.js worldShrine): the stamp's kernel builds beside them
  attach(app) { if (app.win) app.builds?.prepareStamp(); },
  afterStep(app) {
    const { spawners, pov } = app;
    spawners.setGhosts(!pov?.active);   // the crosshair cell stays fresh for the tools
    spawners.update();
    // they hold still with the world, like the NPCs: on wall-clock time they moved every
    // frame, so the view key never settled and a paused scene redrew at full rate
    app.perkOrbs.update(app.animTime);
    app.arenaMarkers.update(app.animTime);
  },
  beforeView(app) {
    if (getMeshGpu() !== app.gpu) setMeshGpu(app.gpu);   // (a device replaced at Start)
    // WORLD preflight binds the actual native graph before any guard/VM pass.
    if(app.win?.render)return;
    updateMeshLight(app);
    // the held tool's pass (once a frame: src/wire/pov.js may have run it already), to post: an
    // overlay drawn over the frame, which a presentation effect doesn't bend (gfx/presentation.js neutral)
    const vm = app.presentation.neutral(() => renderViewmodels(app.renderer, app.scene, app.camera, app.post));
    app.viewmodel = vm?.viewmodel ?? null;
    app.glow = vm?.glow ?? null;
    compileChanged(app);
    guardMeshes(app.scene, app.camera, { skip: ownPass, onReady: () => app.requestRender() });
  },
  // (Not bent by a presentation effect yet, as main's were: net/cursors.js
  // would place each brush at app.presentationPoint(its grid point) instead of
  // through the volume's matrix: U13's, with net/multiplayer.js passing it.)
  scene(app, rp) { drawRemoteCursors(rp); },
};

export default mesh;
