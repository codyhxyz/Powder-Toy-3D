// First person's wiring (src/pov; docs/webgpu.md G2, U11): the POV shell
// (the body, its tools, vehicles, the team games) and its per-frame update.
// The body's and the tools' edits and probes are pov/gpu.js's (sim.edit,
// sim.probe and the result rings: nothing in it waits on the GPU), built for
// each grid as the body enters it. The held tool drawn over the frame
// (pov/viewmodel.js) is the mesh layer's: U13's viewmodel target and glow
// layer go to post's canvas pass (F3, F7) through app.viewmodel and app.glow.
import { createPov } from '../pov/index.js';
import { isGearTool } from '../elements.js';
import { QUARRY_SPAWN } from '../industry/catalog.js';
import { Vector3 } from 'three';

const FACTORY_TOOLS = ['SHOVEL', 'PICKAXE', 'AXE', 'BUCKET', 'HOOK'];
let factoryBelt = null;

const pov = {
  name: 'pov',
  ready: true,

  // The shell, once, on the first grid (it lives on through rebuilds: the body
  // is told when the world under it is replaced)
  attach(app) {
    if (app.pov) return;
    const p = app.pov = createPov({
      renderer: app.renderer, scene: app.scene, camera: app.camera, controls: app.controls, canvas: app.canvas, hud: app.hud,
      settings: app.settings, mp: app.mp, isTyping: app.isTyping, post: app.post,
      getSim: () => app.sim, getVolume: () => app.volume, getScale: () => app.scale,
      hover: app.hover, pointerHover: () => app.pointerInside && !app.uiHover, pickRay: app.pickRay,
      presentationPoint: app.presentationPoint,   // a grid point where a presentation effect shows it (the aim's displayed eye)
      getSpawners: () => app.spawners,
      getPerkOrbs: () => app.perkOrbs,
      loadPreset: (name) => app.loadPreset(name, false),   // a team game's new round (src/game)
      getArena: () => app.arenaLayout,                      // the loaded arena's layout, for the team games (src/game)
      // Willow Cove's Animal Crossing: you start in front of your cottage (pov/village/state.js);
      // a Descent level: you start (and respawn) at its spawn
      dropAt: () => app.settings.preset === 'quarry' && !app.win ? new Vector3(...QUARRY_SPAWN) : app.villageSpawn() ?? app.descentSpawn?.(),
      getMode: () => app.gamemode, getWorld: () => app.win,   // the village switches on in Animal Crossing on Willow Cove
      requestRender: () => app.requestRender(),
      inWorld: () => !!app.win,
      gamemode: () => app.gamemode,   // Noita's rules (wands only) are its gamemode's, not Descent's: Sandbox there has the tools
      industryBuilding: () => !!app.industry?.building,
      toolGun: app.toolGun,   // the tool gun's click at the crosshair
      // Q in first person: the spawn menu where it was left (at first, at what's selected)
      showToolsMenu: () => app.dock.reveal((it) => it.id === (app.menuPick ?? app.settings.tool)) || app.dock.reveal((it) => isGearTool(it.id)),
      hideToolsMenu: () => app.dock.setCollapsed(true),
    });
    p.vehicles.spawnLayout(app.arenaLayout);   // the scene loaded before the POV shell existed
    p.game.useLayout(app.arenaLayout);
    if (app.bootMatch) p.game.prepare();   // a match was picked: the bots' module loads during the first frames
  },
  beforeStep(app, dt) {
    const belt = app.pov?.toolbelt;
    if (app.gamemode === 'factory' && belt && factoryBelt !== belt) { belt.restrict(FACTORY_TOOLS); factoryBelt = belt; }
    else if (app.gamemode !== 'factory' && factoryBelt) { factoryBelt.restrict(null); factoryBelt = null; }
    if (app.pov?.active) app.pov.update(dt);
  },
  busy(app) { return !!app.pov?.active; },
};

export default pov;
