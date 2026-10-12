// World mode's wiring (docs/scaling.md D11; docs/webgpu.md G1, U10): the
// window over a world, its far field, the god view's home over it, the window
// following the focus, the shrine every world gets, and the Island box
// scene's generator.
import * as THREE from 'three';
import { structureClear, shrineAltars as worldShrineAltars } from '../world/structures.js';
import { loadIsland, releaseGenerator } from '../world/gpu.js';
import { WorldWindow, WIN_STEP } from '../world/window.js';
import { bakedAir } from '../constructions/runtime.js';
import { FarField } from '../world/far.js';
import { createTorchLights } from '../world/torchLights.js';
import { gfxUniforms } from '../gfx/uniforms.js';
import '../world/bakeClient.js';   // the World's build-time bake (world/bake.js), before any world is made

const torchLights = createTorchLights();
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
  order: -1,   // the far field draws before the volume (docs/webgpu.md F1)

  // A world's grid: the window over it (app.worldMode set by build()), its far field.
  // The window's size is the simulation's: build() made it worldMode.win, ?win= applied.
  attach(app) {
    const { sim } = app;
    if (!app.worldMode) return;
    const win = app.win = new WorldWindow(app.renderer, sim, { size: app.worldMode.size, seed: app.worldSeed, scene: app.sceneByKey(app.settings.scene) });
    sim.origin.fromArray(world.worldStart(app));
    win.far = new FarField(app.renderer, win, { sun: app.sun });
    win.far.attach(app.vol, app.derived);   // its haze, shadows and GI on the window
  },
  detach(app) {
    releaseGenerator(app.sim);   // the Island scene's, made for this grid
    app.win?.dispose();
    app.win = null;
  },
  follow(app) { if (app.win) world.moveWindow(app); },
  beforeView(app) {
    const { win } = app;
    gfxUniforms.uCaveAmbient.value = win?.scene.ambient ?? NO_AMBIENT;   // a world scene's ambient floor (Descent's caves)
    torchLights.update(win?.scene ?? null, app.camGrid, app.sim.origin);   // the nearest wall torches lit as lamps (world/torchLights.js)
    win?.far?.view(app.volume, app.settings.view === 0, app.camera);
  },
  scene(app, rp) { app.win?.far?.draw?.(rp); },
  invalidate(app) {
    const { win } = app;
    if (win) {
      win.epoch++; // reject readbacks without clearing surviving CPU edits
      if (win.far?.detail) win.far.detail.epoch++;
    }
  },

  // The Island box scene (presets: 'island'): world/gpu.js's generator on the box.
  loadIsland(app) { loadIsland(app.sim, { seed: app.worldSeed }); },

  // A world has one scene, its own: loading starts it over (and can't be
  // undone). Its passes compile in the background first (the first time):
  // till then the window is empty air, and the world fills in when they're done.
  loadScene(app) {
    const w = app.win, epoch = w.epoch;
    if (!w.loaded) app.sim.clear();
    w.whenReady().then(() => {
      if (app.win !== w || w.epoch !== epoch) return;   // rebuilt or loaded meanwhile (load bumps the epoch)
      w.load(world.worldStart(app));
      app.placeVolume();
      app.post.reset();
      app.pov?.worldReplaced();
      app.birds?.worldReplaced();
      world.worldShrine(app);
    }, (err) => console.error('world: its passes failed to compile, or its scene to prepare', err));
    app.toolbar.setUndoEnabled(false);
  },

  // world mode: start the world over with the window at `origin` (world cells)
  worldLoad(app, origin) {
    app.win.load(origin);
    app.placeVolume();
    app.post.reset();
    app.pov?.worldReplaced();
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
    const { win, sim, pov, controls, scale, anchor, hover } = app;
    let fx, fz;
    if (app.worldFocus) [fx, fz] = app.worldFocus;
    else if (pov?.active && pov.player) { fx = pov.player.pos.x + sim.origin.x; fz = pov.player.pos.z + sim.origin.z; }
    else { fx = controls.target.x / scale + anchor.x; fz = controls.target.z / scale + anchor.y; }
    const move = win.update(fx, fz);
    if (!move) return;
    const [dx, dz] = move;
    app.placeVolume();
    pov?.windowShifted(dx, dz);
    hover.cell.x -= dx;   // the last pick, in the moved grid (signs follow sim.origin themselves)
    hover.cell.z -= dz;
    if (hover.valid && !app.inWindow(hover.cell)) hover.valid = false;
  },
};

export default world;
