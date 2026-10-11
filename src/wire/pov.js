// First person's wiring (src/pov; docs/webgpu.md G2, U11): the POV shell
// (the body, its tools, vehicles, the team games), its per-frame update, and
// the held tool drawn over the frame (pov/viewmodel.js; U13's viewmodel target
// and glow layer go to post's canvas pass, F3, F7). Moved here from app.js as
// it was (WebGL): U11 and U13 port it. Until then the god view is the only
// camera, and app.js greys out the first- and third-person buttons.
import { createPov } from '../pov/index.js';
import { renderViewmodels } from '../pov/viewmodel.js';
import { isGearTool } from '../elements.js';

const pov = {
  name: 'pov',
  ready: false,

  // The shell, once, on the first grid (it lives on through rebuilds: the body
  // is told when the world under it is replaced)
  attach(app) {
    if (app.pov) return;
    const p = app.pov = createPov({
      renderer: app.renderer, scene: app.scene, camera: app.camera, controls: app.controls, canvas: app.canvas, hud: app.hud,
      settings: app.settings, mp: app.mp, isTyping: app.isTyping, post: app.post,
      getSim: () => app.sim, getVolume: () => app.volume, getScale: () => app.scale,
      hover: app.hover, pointerHover: () => app.pointerInside && !app.uiHover, pickRay: app.pickRay,
      getSpawners: () => app.spawners,
      getPerkOrbs: () => app.perkOrbs,
      loadPreset: (name) => app.loadPreset(name, false),   // a team game's new round (src/game)
      getArena: () => app.arenaLayout,                      // the loaded arena's layout, for the team games (src/game)
      dropAt: () => app.descentSpawn?.(),                   // a Descent level: you start (and respawn) at its spawn
      requestRender: () => app.requestRender(),
      inWorld: () => !!app.win,
      gamemode: () => app.gamemode,   // Noita's rules (wands only) are its gamemode's, not Descent's: Sandbox there has the tools
      toolGun: app.toolGun,   // the tool gun's click at the crosshair
      // Q in first person: the spawn menu where it was left (at first, at what's selected)
      showToolsMenu: () => app.dock.reveal((it) => it.id === (app.menuPick ?? app.settings.tool)) || app.dock.reveal((it) => isGearTool(it.id)),
      hideToolsMenu: () => app.dock.setCollapsed(true),
    });
    p.vehicles.spawnLayout(app.arenaLayout);   // the scene loaded before the POV shell existed
    p.game.useLayout(app.arenaLayout);
    if (app.bootMatch) p.game.prepare();   // a match was picked: the bots' module loads during the first frames
  },
  beforeStep(app, dt) { if (app.pov?.active) app.pov.update(dt); },
  // POV: the held tool, drawn over the finished frame in its own pass (no TAA, its
  // own depth, so it never clips into walls); before the screenshot reads the canvas
  beforeView(app) { renderViewmodels(app.renderer, app.scene, app.camera, app.post); },
  busy(app) { return !!app.pov?.active; },
};

export default pov;
