// Terrain band/native portal loading (docs/noita-terrain-fold-contract.md).
// The initial world window centers on the actual source-space arrival. The POV
// shell, the body (health, perks, statuses), the toolbelt, the run's wands
// (wands/descentRun.js) and gold (pov.descent) all outlive build(), so the
// run comes through: nothing is rebuilt but the world. Moved here from app.js
// as it was: it needs the world (U10) and first person (U11).
import * as THREE from 'three';
import { createDescentRunner, runSnapshot, LOAD_POLL_MS, LOAD_WAIT_MS } from '../pov/descent/switch.js';
import { createDescentOverlay } from '../pov/descent/overlay.js';
import { DESCENT_LEVELS, levelByScene } from '../world/scenes/descent/levels.js';
import { descentWands } from '../pov/wands/descentRun.js';
import { captureMotion, restoreMotion } from '../pov/descent/terrainHandoff.js';
import { TerrainEditCache } from '../world/terrainEditCache.js';

const descentFeet = new THREE.Vector3();

// a level's spawn as grid feet (the middle of its cell), or null
function descentSpawn(app, level) {
  if (!level?.spawn || !app.sim) return null;
  const [x, y, z] = level.spawn;
  return new THREE.Vector3(x, y, z).sub(app.sim.origin);
}
// Load world scene `key` (as the map menu does a world map) and resolve once its window has filled.
function descentLoad(app, key, arrival) {
  const scene = app.sceneByKey(key);
  // Set BEFORE setSize: WorldWindow's initial origin must be at the arrival,
  // not the export's debug spawn followed by slow horizontal streaming.
  scene.setArrival?.(arrival);
  app.settings.scene = key;
  try {
    if (app.setSize('world') === false) throw new Error('Descent grid refused');
  } catch (err) { scene.setArrival?.(null); throw err; }
  const expected = app.win;
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (app.win !== expected) { scene.setArrival?.(null); reject(new Error('Descent load was replaced')); return; }
      if (app.win?.loaded && app.win.scene.key === key) { scene.setArrival?.(null); resolve(); }
      else if (performance.now() - t0 > LOAD_WAIT_MS) { scene.setArrival?.(null); reject(new Error(`Descent: '${key}' took too long to load`)); }
      else setTimeout(check, LOAD_POLL_MS);
    };
    check();
  });
}

// Run-owned state, independent of band index (including upward returns to 00).
// Exposed factory keeps lifecycle ordering CPU-testable without a browser.
export function createTerrainPersistence() {
  const cache = new TerrainEditCache();
  let observed=null, epoch=null, scope=null, pending=false, incomplete=null;
  const identity = (win) => JSON.stringify([win.scene.fold?.config, win.P.seed,
    DESCENT_LEVELS.map(l=>l.sourceRegion.sha256)]);
  const observe = (win) => { observed=win; epoch=win?.epoch; };
  return {
    cache,
    get pending() { return pending; },
    sync(win) {
      if (pending) return;
      const nextScope=win?.scene.sourceRegion ? identity(win) : null;
      if (win !== observed || win?.epoch !== epoch || nextScope!==scope) {
        // A fresh map/reload, not one of our explicit band/portal loads.
        cache.reset(); incomplete=null;
        scope=nextScope;
        observe(win);
      }
    },
    async load(app,key,arrival,load=descentLoad) {
      this.sync(app.win);
      const old=app.win;
      if (pending || !old?.scene.sourceRegion || old===incomplete) throw new Error('Terrain window is not available for capture');
      pending=true; // Same tick: app's remaining writers must stop before awaiting.
      let captured=false;
      try {
        const store=await old.captureEdits();
        if (app.win!==old) throw new Error('Terrain capture was replaced');
        cache.capture(old.scene.sourceRegion,store,old.scene.fold.config.cellScale); captured=true;
        await load(app,key,arrival);
        const target=app.win;
        if (identity(target)!==scope) throw new Error('Terrain source/fold changed during handoff');
        await target.restoreEdits(cache.seed(target.scene.sourceRegion,target.wb,target.scene.fold.config.cellScale));
        if (app.win!==target) throw new Error('Terrain restore was replaced');
        observe(target);
      } catch (error) {
        // Never resume POV into an incomplete restore or overwrite the retained
        // snapshot with that window later. A deliberate new map starts afresh.
        if (captured && app.win!==old) { incomplete=app.win; observe(app.win); }
        pending=false;
        throw error;
      }
    },
    async enter(fn) { try { return await fn(); } finally { pending=false; } },
  };
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
    let motion = null;
    const persistence = createTerrainPersistence();
    app.descent = createDescentRunner({
      levels: DESCENT_LEVELS,
      emit: (name, payload) => pov.events.emit(name, payload),
      loadScene: (key, arrival, transition) => {
        motion = transition?.source ? captureMotion(pov.player, pov.networkLook) : null;
        return persistence.load(app, key, arrival);
      },
      enterAt: (spawn, transition) => persistence.enter(async () => {
        await pov.enter({ at: descentSpawn(app, { spawn }), swoop: 0, hint: false });
        if (motion) restoreMotion(pov.player, (yaw, pitch) => pov.setLook(yaw, pitch), motion, transition.preserveMomentum);
        else pov.setLook(levelByScene(app.settings.scene)?.spawnYaw ?? 0, 0);
        this.lookLoad = app.win;
        if (!pov.active) throw new Error("the body didn't drop in");
      }),
      snapshot: () => runSnapshot({ player: pov.player, gold: pov.descent?.gold ?? null, wands: descentWands }),
      overlay: createDescentOverlay(),
      toast: (text, opts) => app.hud.toast(text, opts),
      finish: () => { pov.exit(); app.actions.openMenu(); },
      wait: (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)),
      loadId: () => app.win,
    });
    Object.defineProperty(app.descent,'terrainPending',{ get: () => persistence.pending });
    app.descent.syncTerrain = (win) => persistence.sync(win);
  },
  beforeStep(app) {
    const { descent: d, pov, win, sim } = app;
    if (!d || d.busy) return;
    d.syncTerrain(win);
    const p = pov?.player;
    const live = !!(win && p && pov.mode === 'on' && !p.dead);
    // Only first entry sets a default look; seam arrivals restore their look.
    if (live && this.lookLoad !== win) {
      this.lookLoad = win;
      const lv = levelByScene(app.settings.scene);
      if (lv) pov.setLook(lv.spawnYaw ?? 0, 0);
    }
    const feet = live ? descentFeet.copy(p.pos).add(sim.origin) : null;
    const query = feet && win.scene.querySource?.([feet.x, feet.y, feet.z]);
    d.frame({
      key: win ? app.settings.scene : null,
      feet,
      source: query?.kind === 'source' ? query.source : null,
      live, load: win,
    });
  },
};

export default descent;
