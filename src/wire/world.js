// World mode's wiring (docs/scaling.md D11; docs/webgpu.md G1, U10): the
// window over a world, its far field, the god view's home over it, the window
// following the focus, the shrine every world gets, and the Island box
// scene's generator.
import * as THREE from 'three';
import { structureClear, shrineAltars as worldShrineAltars } from '../world/structures.js';
import { loadIsland, releaseGenerator } from '../world/gpu.js';
import { WorldWindow, WIN_STEP } from '../world/window.js';
import { bakedAir } from '../constructions/runtime.js';
import { beyondLevel, FarField } from '../world/far.js';
import { worldCopyWGSL } from '../shaders/world/copy.js';
import { createTorchLights } from '../world/torchLights.js';
import { gfxUniforms } from '../gfx/uniforms.js';
import '../world/bakeClient.js';   // the World's build-time bake (world/bake.js), before any world is made

const torchLights = createTorchLights();
// The simulation's passes a world's load records beyond its window's own (WorldWindow.whenReady):
// the blank state it fills (sim.clear: sim.load's). Never a step kernel (sim.kernels).
export const WORLD_LOAD_PASSES = Object.freeze(['fromAtlas']);
const NO_AMBIENT = [0, 0, 0];   // a scene without an ambient floor (world scene `ambient`)

// God view over a world: the orbit target on the ground, the camera this far
// off it along the box view's direction (scene units), so the window fills
// about as much of the view as a box does
const WORLD_VIEW_DIR = [11, 9.5, 13];
const WORLD_VIEW_DIST = 21;

// World: every world gets a shrine (constructions/builtins.js shrine, with its
// perk orbs) near the middle of its first window, where the god view starts:
// on flat dry ground, with as few trees about as it can find, in a clearing
// (the island's trees around it are felled: stamped over with air, exactly as
// they were planted). It's stamped into the window like a placed one, so the
// window keeps it as an edit when it moves away (world/store.js).
const SHRINE_HALF = [9, 6];        // cells: half the shrine's footprint (x, z), a cell to spare
const SHRINE_SEARCH = 40;          // cells from the window's middle it looks within...
const SHRINE_SEARCH_STEP = 4;      // ...on a lattice this fine
const SHRINE_SAMPLE = 2;           // cells between the ground samples under a footprint
const SHRINE_FLAT = 3;             // cells of rise and fall it accepts under its floor
const SHRINE_DRY = 2;              // cells above the sea its lowest ground must be
const SHRINE_HEADROOM = 16;        // cells of window it needs above its floor (the roof, and a hop)
const SHRINE_GLADE = 10;           // cells around its footprint the clearing reaches (trunks within it are felled)
const SHRINE_TREE_COST = 2;        // a spot's score: cells of rise, plus this per tree to fell...
const SHRINE_FAR_COST = 0.05;      // ...plus this per cell from the window's middle (lowest wins)

const world = {
  name: 'world',
  ready: true,

  // A world's physical window, drawn as a small map's grid is (app.js drawScene), and past
  // it the distance pass. The window's size is the simulation's: build() made it worldMode.win, ?win= applied.
  attach(app) {
    const { sim } = app;
    if (!app.mapKind.streamed) return;
    const scene = app.sceneByKey(app.settings.scene);
    const win = app.win = new WorldWindow(app.renderer, sim, { size: app.worldMode.size, seed: app.worldSeed, scene });
    sim.origin.fromArray(world.worldStart(app));
    sim.resetNativeDynamics(); // initial native air coordinates match the world before any tick
    // The cumulus deck overhead and its optical shadows.
    gfxUniforms.uClouds.value=true;
    gfxUniforms.uCloudSea.value=beyondLevel(win.scene,win.P);
    // Its distance pass (world/far.js, app.js farPass): the far field's brick-resolution grid of the
    // whole world, drawn past physics' window (the world march's full detail: shaders/world/reach.js) in a
    // pass of its own, as live drew it past the window. Joined once its kernels are built, so it never holds
    // up the load (win.whenReady waits on win.far), and built from the world copy then (useWorldCopy: until
    // it has built the far view doesn't draw and the march keeps the whole world). Its lighting group is
    // the window volume's, with the far grid in it (attachVolume).
    const far = new FarField(app.renderer, win, { sun: app.sun });
    far.presentation = app.presentation;   // a gamemode's effect bends its view (gfx/presentation.js: the rolling log)
    far.attachVolume(app.vol);
    far.onChange = () => app.wakeLoop();
    far.whenReady().then(() => {
      if (app.win !== win || win.far) { far.dispose(); return; }
      win.far = far;
      // built from the world copy (world/far.js useWorldCopy): now if it is in, else when it is (buildWorldCopy)
      const copy = app.worldView?.worldCopy;
      if (win.loaded && copy?.bindGroup) far.useWorldCopy?.(copy);
      app.wakeLoop();
    }, error => { console.warn('World far field could not build', error); far.dispose(); });
  },
  detach(app) {
    releaseGenerator(app.sim);   // the Island scene's, made for this grid
    const win = app.win;
    app.win = null;
    win?.dispose();
  },
  // The far field's chunks still to build keep the loop running.
  busy(app) {
    return (app.win?.far?.queue.length ?? 0) > 0;
  },
  follow(app) {
    if (!app.mapKind.streamed) return;
    // Replicas do not move or simulate their window, but render-only streaming
    // must still progress; the host's live cells retain their authority.
    if (app.mp.replica) app.win.far?.tick();
    else world.moveWindow(app);
  },
  // (every map's frame: wire/frameWires.js lighting)
  lighting(app) {
    gfxUniforms.uCaveAmbient.value=app.win?.scene.ambient??NO_AMBIENT;   // a world scene's ambient floor (Descent's caves)
    torchLights.update(app.win?.scene??null,app.camGrid,app.sim.origin);   // the nearest wall torches lit as lamps (world/torchLights.js)
  },
  invalidate(app) {
    const { win } = app;
    if (win) win.epoch++; // reject readbacks without clearing surviving CPU edits
  },

  // The Island box scene (presets: 'island'): world/gpu.js's generator on the
  // box. It fills once the generator's kernels are built (seconds, the first
  // time), so the load carries a token: it lands only if it is still the
  // latest, the box still shows the Islet on the same grid, and its undo
  // snapshot (loadPreset's, the top of the history now) hasn't been undone.
  // Another scene, a Clear or an Undo meanwhile wins; cancelIsland is for the
  // other whole-grid writers (a save's load, a session's frame). Returns the
  // load's promise (loadIsland's: its world P once it landed, else null).
  loadIsland(app) {
    if (app.mp.replica) return null;
    const sim = app.sim, t = world._islandLoad = { sim, mark: sim.history.at(-1) ?? null };
    // A new scene over the box's cells, as sim.load replaces them: V2's flying matter, air and
    // pending requests start over with it (V1's moving state is in the cells the fill replaced).
    // In the same task as the fill, so no tick runs between them.
    t.done = loadIsland(sim, {
      seed: app.worldSeed,
      still: () => world._islandLoad === t && app.sim === sim && app.settings.preset === 'island' && app.mapKind.presets
        && (t.mark === null || sim.history.includes(t.mark)),
    }).then((P) => { if (P) sim.resetNativeDynamics(); return P; });
    t.done.catch(() => {});   // (a pipeline that fails stops graphics: stopGraphics says why)
    return t.done.catch(() => null);
  },
  // A pending Island load (above) is dropped.
  cancelIsland() { world._islandLoad = null; },
  _islandLoad: null,

  // A world has one scene, its own: loading starts it over (and can't be
  // undone). Its passes compile in the background first (the first time):
  // till then the window is empty air, and the world fills in when they're done.
  // What it waits for is the window's passes and the blank state's (WORLD_LOAD_PASSES), never the
  // simulation's step kernels (move, react): the World load starts from this load (app.js loadPreset).
  loadScene(app) {
    if (app.mp.replica) return;
    const w = app.win, epoch = w.epoch, sim = app.sim;
    Promise.all([w.whenReady(), sim.prepare(...WORLD_LOAD_PASSES)]).then(() => {
      if (app.mp.replica || app.win !== w || app.sim !== sim || w.epoch !== epoch) return;   // rebuilt or loaded meanwhile (load bumps the epoch)
      if (!w.loaded) sim.clear();   // (the blank window it fills, as a box's load starts from)
      w.load(world.worldStart(app));
      world.buildWorldCopy(app, w);
      app.placeVolume();
      app.post.reset();
      app.pov?.worldReplaced();
      world.worldShrine(app);
    }, (err) => console.error('world: its passes failed to compile, or its scene to prepare', err));
    app.toolbar.setUndoEnabled(false);
  },

  // world mode: start the world over with the window at `origin` (world cells)
  worldLoad(app, origin) {
    if (app.mp.replica) return;
    app.resetWeather?.();
    app.win.load(origin);
    world.buildWorldCopy(app, app.win);
    app.placeVolume();
    app.post.reset();
    app.pov?.worldReplaced();
  },

  // The whole map into the world copy (docs/seamless-world.md, W), then the window's moves fill from it
  // (P: attachWorldCopy), trees and all; Descent's bands too, over its ring's columns (world/worldCopy.js).
  buildWorldCopy(app, w) {
    const view = app.worldView;
    if (!view) return;
    view.build(w).then((copy) => {
      if (app.win !== w || !copy?.bindGroup) return;
      w.far?.useWorldCopy?.(copy);   // the far field, built from it and kept current from its changes (world/far.js)
      return w.attachWorldCopy(copy, { wgsl: worldCopyWGSL });
    }).then(() => app.wakeLoop(), (err) => console.error('world copy: not attached', err));
  },

  // World: the window's first origin (world cells): centred on the column its
  // scene starts at (where the most is going on: the island's shore, seen from
  // the sea), snapped to WIN_STEP and inside the world.
  worldStart(app) {
    const { win, sim } = app;
    const P = win.P, g = sim.g, n = [g.nx, g.nz];
    const c = win.scene.start(P, n);
    const origin = [0, 1].map((k) => {
      const o = Math.round((c[k] - n[k] / 2) / WIN_STEP) * WIN_STEP;
      return THREE.MathUtils.clamp(o, 0, P.size[2 * k] - n[k]);
    });
    return [origin[0], 0, origin[1]];
  },

  worldShrine(app) {
    if (app.mp.replica) return;
    const { win, sim, builds } = app;
    if (!win || !builds || win.scene.shrine === false) return;   // (Descent's temples have their own altars)
    const P = win.P, g = sim.g, o = sim.origin, [hx, hz] = SHRINE_HALF;
    // a scene with structures places its own (world/structures.js: generated, in a clearing): set its orbs
    const altars = worldShrineAltars(P);
    if (altars) { app.perkOrbs?.shrineAt(altars.map((a) => a.sub(o))); return; }
    const sea = P.sea ?? 0;
    const fits = (x, z) => x - hx >= 0 && z - hz >= 0 && x + hx < g.nx && z + hz < g.nz;
    // the ground's lowest and highest under a footprint centred on grid column (x, z)
    const span = (x, z) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = -hx; i <= hx; i += SHRINE_SAMPLE)
        for (let k = -hz; k <= hz; k += SHRINE_SAMPLE) {
          if (structureClear(P, o.x + x + i, o.z + z + k)) return [0, Infinity];   // not on the world's structures (world/structures.js)
          const h = win.scene.ground(o.x + x + i, o.z + z + k, P);
          lo = Math.min(lo, h); hi = Math.max(hi, h);
        }
      return [lo, hi];
    };
    // the trees whose trunks stand in its glade (the scene's, if it plants any: the island's)
    const glade = (x, z) => (win.scene.trees
      ? win.scene.trees.treesIn(o.x + x - hx - SHRINE_GLADE, o.z + z - hz - SHRINE_GLADE, o.x + x + hx + SHRINE_GLADE + 1, o.z + z + hz + SHRINE_GLADE + 1, P, win.candidates)
      : []);
    const cx = Math.round(g.nx / 2), cz = Math.round(g.nz / 2);
    let best = null;
    for (let dx = -SHRINE_SEARCH; dx <= SHRINE_SEARCH; dx += SHRINE_SEARCH_STEP)
      for (let dz = -SHRINE_SEARCH; dz <= SHRINE_SEARCH; dz += SHRINE_SEARCH_STEP) {
        const x = cx + dx, z = cz + dz;
        if (!fits(x, z)) continue;
        const [lo, hi] = span(x, z);
        if (hi - lo > SHRINE_FLAT || lo < sea + SHRINE_DRY || hi + SHRINE_HEADROOM > g.ny) continue;
        const trees = glade(x, z);
        const score = hi - lo + SHRINE_TREE_COST * trees.length + SHRINE_FAR_COST * Math.hypot(dx, dz);
        if (!best || score < best.score) best = { x, z, y: Math.ceil(hi), trees, score };
      }
    if (!best) return;
    for (const t of best.trees) {
      const baked = win.bakeTree(t);
      if (baked) builds.stampBaked(bakedAir(baked), new THREE.Vector3(t.x - o.x - baked.base.x, t.y - o.y - baked.base.y, t.z - o.z - baked.base.z));
    }
    builds.stampAt('SHRINE', new THREE.Vector3(best.x, best.y, best.z));   // (onPlaced sets its orbs)
  },

  // World: the god view's home over world column (x, z), the orbit target on
  // the ground there (the scene's: on the sea where the sea floor is lower), or
  // as the scene's view has it (world/scenes/index.js)
  homeOver(app, x, z) {
    const { win, anchor, scale } = app;
    const v = win.scene.view;
    const ground = win.scene.ground(x, z, win.P) + (v?.lift ?? 0);
    const target = new THREE.Vector3((x - anchor.x) * scale, ground * scale, (z - anchor.y) * scale);
    app.rig.setHome(new THREE.Vector3(...(v?.dir ?? WORLD_VIEW_DIR)).setLength(v ? v.dist * scale : WORLD_VIEW_DIST).add(target), target);
  },

  // World mode: keep the window on the focus, the POV body or else the orbit
  // target (a tool may pin it: __app.worldFocus = [x, z] in world cells).
  moveWindow(app) {
    if (app.mp.replica) return;
    const { win, sim, pov, controls, scale, anchor, hover } = app;
    let fx, fz;
    const focus = app.villageFocus ?? app.worldFocus;   // (Animal Crossing streams toward your cottage first)
    if (focus) [fx, fz] = focus;
    else if (pov?.active && pov.player) { fx = pov.player.pos.x + sim.origin.x; fz = pov.player.pos.z + sim.origin.z; }
    else { fx = controls.target.x / scale + anchor.x; fz = controls.target.z / scale + anchor.y; }
    const move = win.update(fx, fz);
    if (!move) return;
    const committed = ([dx, dz]) => {
      if (app.sim !== sim || app.win !== win) return;
      app.placeVolume();
      pov?.windowShifted(dx, dz);
      hover.cell.x -= dx;
      hover.cell.z -= dz;
      if (hover.valid && !app.inWindow(hover.cell)) hover.valid = false;
      app.pacer?.wake();
      return [dx, dz];
    };
    // (a move that commits later, if a window ever makes one, is returned as its promise: a streaming
    // loop waits for it instead of taking it for the window having arrived)
    if (move.then) {
      const done = move.then(committed);
      done.catch(error => app.hud?.toast?.(error.message, { kind: 'error' }));
      return done;
    }
    return committed(move);
  },

  // Stream the window onto the focus the caller has set (villageFocus, worldFocus) before a body drops
  // in there: each move commits in the frame, under either engine; the next waits for the last one's
  // leaving slab and, under V2, for the window's pipelines (WorldWindow.blocker), so a move that can't
  // be made yet is never taken for arrival (Animal Crossing's home, Cruelty Squad's spawn). Bounded:
  // a finite world crosses in a known number of moves. Resolves once no move is left (or alive() fails).
  async streamToFocus(app, alive = () => true) {
    const win = app.win;
    if (!win) return;
    const limit = Math.ceil((win.size[0] + win.size[2]) / WIN_STEP) + 4;
    for (let i = 0; i < limit && alive() && app.win === win; i++) {
      for (let n = 0, wait; n < limit && (wait = win.blocker?.()); n++) await wait;
      if (!alive() || app.win !== win) return;
      const moved = world.moveWindow(app);
      if (!moved) return;
      await moved;
    }
  },
};

export default world;
