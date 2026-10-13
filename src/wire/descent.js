// Descent's level switch (docs/descent-contract.md, "D"; docs/webgpu.md U10,
// U11): each level is its own world scene; the temple's exit loads the next
// one here, in the same session, and drops the body in at its spawn. The POV
// shell, the body (health, perks, statuses), the toolbelt, the run's wands
// (wands/descentRun.js) and gold (pov.descent) all outlive build(), so the
// run comes through: nothing is rebuilt but the world. Moved here from app.js
// as it was: it needs the world (U10) and first person (U11).
import * as THREE from 'three';
import { createDescentRunner, runSnapshot, LOAD_POLL_MS, LOAD_WAIT_MS } from '../pov/descent/switch.js';
import { createDescentOverlay } from '../pov/descent/overlay.js';
import { DESCENT_LEVELS, levelByScene } from '../world/scenes/descent/levels.js';
import { descentWands } from '../pov/wands/descentRun.js';

const descentFeet = new THREE.Vector3();

// a level's spawn as grid feet (the middle of its cell), or null
function descentSpawn(app, level) {
  if (!level?.spawn || !app.sim) return null;
  const [x, y, z] = level.spawn;
  return new THREE.Vector3(x + 0.5, y, z + 0.5).sub(app.sim.origin);
}
// Load world scene `key` (as the map menu does a world map) and resolve once its window has filled.
function descentLoad(app, key) {
  app.settings.scene = key;
  app.setSize('world');
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (app.win?.loaded && app.win.scene.key === key) resolve();
      else if (performance.now() - t0 > LOAD_WAIT_MS) reject(new Error(`Descent: '${key}' took too long to load`));
      else setTimeout(check, LOAD_POLL_MS);
    };
    check();
  });
}

const descent = {
  name: 'descent',
  ready: true,

  // the runner, once the POV shell exists (pov.js attaches first)
  attach(app) {
    if (app.descent || !app.pov) return;
    const pov = app.pov;
    // a Descent level: you start (and respawn) at its spawn
    app.descentSpawn = () => descentSpawn(app, levelByScene(app.win ? app.settings.scene : null));
    app.descent = createDescentRunner({
      levels: DESCENT_LEVELS,
      emit: (name, payload) => pov.events.emit(name, payload),
      loadScene: (key) => descentLoad(app, key),
      enterAt: async (spawn) => {
        await pov.enter({ at: descentSpawn(app, { spawn }) });
        if (!pov.active) throw new Error("the body didn't drop in");
      },
      snapshot: () => runSnapshot({ player: pov.player, gold: pov.descent?.gold ?? null, wands: descentWands }),
      overlay: createDescentOverlay(),
      toast: (text, opts) => app.hud.toast(text, opts),
      finish: () => { pov.exit(); app.actions.openMenu(); },
      wait: (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)),
      loadId: () => app.win,
    });
  },
  beforeStep(app) {
    const { descent: d, pov, win, sim } = app;
    if (!d) return;
    const p = pov?.player;
    const live = !!(win && p && pov.mode === 'on' && !p.dead);
    d.frame({
      key: win ? app.settings.scene : null,
      feet: live ? descentFeet.copy(p.pos).add(sim.origin) : null,
      live, load: win,
    });
  },
};

export default descent;
