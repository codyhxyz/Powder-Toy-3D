// The engine a shot talks to (docs/v2.md 11, Week 0: the side-by-side sheet),
// and the runner that plays a shot on it. Both tools/side-by-side.mjs (in a
// test page) and ?shot= (src/shot.js, in a player's page) use this file, so a
// shot looks the same from the tool on the Mac as from a link on the iPhone.
//
// A shot (shots.mjs) never touches the app. It names a scene, a camera, a seed
// and a game time, and its setup calls the engine: span/cell (its positions on
// this grid), fill, erase, heat, look and keys. createEngine below is that
// engine for today's build, on window.__app. A build whose engine is another
// (v2, behind ?engine=v2) sets window.__shotEngine to an object with the same
// methods, and the runner uses it instead, so the shot list and the tool
// don't change.
//
// What an engine is, in plain terms:
//   bootQuery(scene, opts)   the URL query that boots the scene (a page per boot)
//   describe()               grid, view, settings and anything else worth printing
//   load(shot)               the scene in its starting state, seeded, built (shot.build)
//   run(seconds, { render }) game time, at the game's own tick (60 a second here)
//   look(camera)             the camera: { pos, target, fov } in cells, or { pov }
//   converge()               the view settled on what it shows (a still)
//   startClip()              the clip's clock starts (its keys are timed from here)
//   present()                the current game time drawn, for a clip's frame
//   live, quality            a player's page or the tool's; 'full' or 'draft'
//   span, cell, len, fill, ball, erase, heat, keys   what setups use
//
// Positions are cells of the shot's scene. A box scene's are given on its
// nominal grid (scene.grid, 128 for the menu's boxes) and scaled to the grid
// the page runs (the container runs boxes at 64³ or 32³), unless it has no
// grid (first person: the body doesn't scale); a world's and an arena's are
// their own cells and never scale. Times are game seconds: today's
// game steps its grid settings.steps (4) times a frame at 60 frames a second,
// so a game second is 240 steps; v2's tick is 60 Hz (docs/v2.md 5.1).
//
// Determinism (both sides of an identical build must give identical frames):
// Math.random is seeded before each load (three.js draws ids from it, and the
// cells their seeds); the sim's step and stroke counters, the GI and the day
// clock start over; the view's clocks reset when the camera is set; nothing
// runs on the wall clock: steps through __app.test.step, the first-person body
// through pov.update with a fixed dt, frames through test.render/renderOnce.
// Wires that run only in the app's own tick (birds, lightning, the world's
// window following the camera) don't run, so birds hold still and no storm
// strikes. What can still differ is listed in describe().nondeterminism.

/** Game ticks a second: today's game steps on every frame, frames at 60 a second (gfx/pacing.js MAX_FPS). */
export const TICK_HZ = 60;
/** A box's cells per edge that the menu's box maps use (maps.js): the shot list's nominal grid for box scenes. */
export const NOMINAL_BOX = 128;
// the cubic boxes today's build boots (app.js SIZES): a link with another size boots the World
const BOXES = ['64', '96', '128'];
// steps a batch of game time runs before the GPU is waited on (keeps a command buffer bounded)
const STEP_BATCH = 64;
// renders a draft still makes: one runs the derived passes over the new state, one shows it
const DRAFT_STILL_FRAMES = 2;
// ticks the first-person body gets to come in at its spot (its swoop is 0 s)
const POV_ENTER_TICKS = 30;

// The element ids of today's build for the elements the shot list uses: the
// fallback when the page can't import /src/elements.js (a production build,
// such as the deployed /v1/). A dev server's own table is used and checked
// against this one.
const V1_IDS = {
  EMPTY: 0, WALL: 1, SAND: 2, STONE: 3, SNOW: 4, GUNPOWDER: 5, WATER: 7, OIL: 8, LAVA: 10, STEAM: 11, SMOKE: 12,
  FIRE: 13, WOOD: 14, PLANT: 15, METAL: 16, GLASS: 17, ICE: 18, CLONE: 19, ROCK: 20, SANDSTONE: 27, COAL: 29,
  BRICK: 41, CLAY: 64, MUD: 65, C4: 67, TNT: 69, MOSS: 77,
};
const V1_TOOLS = { ERASE: -1, PROP: -60 };
const V1_PROP = { CTYPE: 1, TEMP: 2 };   // editing.js PROP indices

/** Settings profiles for today's build (app.js PERSIST keys), set before boot. */
export const PROFILES = {
  default: {},
  // the iPhone's defaults (app.js MOBILE_DEFAULTS): no near GI, glow lights,
  // caustics or close-up detail, and performance upscaling
  phone: {
    nearGI: false, glowLights: false, caustics: false, upscale: 'performance',
    ...Object.fromEntries(['relief', 'grains', 'grainClusters', 'mediaFine', 'mediaStep', 'mediaFlow', 'smoothClose',
      'liquidRipples', 'liquidMeniscus', 'liquidFoam'].map((k) => [`detail_${k}`, false])),
  },
};
/** Where today's build keeps its settings (app.js STORE). */
export const SETTINGS_STORE = 'powder-toy-3d:settings';

/** mulberry32: the seeded Math.random every shot starts from (as tools/regress.mjs). */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The URL query that boots `scene` in today's build. Box scenes boot the
 * empty box at their grid and load their preset per shot (so every box shot
 * shares one boot), arenas boot their own grid, worlds their scene and seed.
 * opts.box: a box size to run box scenes at instead ('64', '32'); opts.win: a
 * world window's width instead of 128 (?win=).
 * @returns {Record<string, string>}
 */
export function bootQuery(scene, { box = null, win = null } = {}) {
  if (scene.world) {
    const q = { size: 'world', scene: scene.world };
    if (scene.seed != null) q.seed = String(scene.seed);
    if (win) q.win = String(win);
    return q;
  }
  if (scene.arena) return { preset: scene.arena };
  const size = String(box ?? scene.size ?? NOMINAL_BOX);
  if (!BOXES.includes(size)) throw new Error(`a box of ${size}: today's build has boxes of ${BOXES.join(', ')} (app.js SIZES)`);
  return { size, preset: 'empty' };
}

/** The link a player opens for a shot (?shot=, src/shot.js): the shot's own scene, not the shared empty box. */
export function linkQuery(scene) {
  if (scene.world || scene.arena) return bootQuery(scene);
  return { size: String(scene.size ?? NOMINAL_BOX), preset: scene.preset };
}

/**
 * Today's build's engine, on window.__app. `live`: a player's page (?shot=),
 * with the game's own loop running: no test API, no parked loop, no scripted
 * keys, and the first-person body left to the player.
 */
export async function createEngine(app, { live = false, quality = 'full', tables = null } = {}) {
  const THREE = app.THREE;
  let E = null, PROP_TOOL = V1_TOOLS.PROP, PROP_TEMP = V1_PROP.TEMP, PROP_CTYPE = V1_PROP.CTYPE, ids = 'the dev server';
  if (tables) {   // the build's own (src/shot.js)
    ({ E, PROP_TOOL } = tables);
    PROP_TEMP = tables.PROP.TEMP; PROP_CTYPE = tables.PROP.CTYPE;
    ids = 'the build';
  } else {
    // a dev server's modules (the same instances the app runs); a production build has none
    try {
      const els = await import(/* @vite-ignore */ '/src/elements.js');
      const ed = await import(/* @vite-ignore */ '/src/editing.js');
      E = els.E; PROP_TOOL = els.PROP_TOOL; PROP_TEMP = ed.PROP.TEMP; PROP_CTYPE = ed.PROP.CTYPE;
      const wrong = Object.entries(V1_IDS).filter(([key, id]) => E[key] !== id).map(([key]) => key);
      if (wrong.length) ids = `the dev server (differs from the built-in table for ${wrong.join(', ')})`;
    } catch {
      E = V1_IDS;
      ids = 'the built-in table (no /src on this server)';
    }
  }
  const idOf = (key) => {
    const id = E[key];
    if (id === undefined) throw new Error(`no element ${key} in this build`);
    return id;
  };

  let shot = null, k = 1, t = 0, ticks = 0, clipT0 = null, held = new Set(), rendered = false;
  const notes = [];
  // progress for the tool's log (it forwards console lines that start [sbs])
  const say = (msg) => { if (!live) console.log(`[sbs] ${shot?.name ?? ''}: ${msg}`); };
  const since = (t0) => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
  const sim = () => app.sim;
  const test = live ? null : app.test;

  // ---- positions: the shot's cells on this grid (k: this grid's cells per the shot's; 1 but for scaled box scenes)
  const cell = (p) => p.map((v) => v * k);
  // a box [lo, hi) of the shot's cells on this grid, whole cells, at least one thick
  const span = (lo, hi) => {
    const a = lo.map((v) => Math.round(v * k)), b = hi.map((v, i) => Math.max(Math.round(v * k), a[i] + 1));
    return [a, b];
  };
  // world cells → grid cells of the window (a box's origin is 0)
  const toGrid = (p) => { const o = sim().origin; return [p[0] - o.x, p[1] - o.y, p[2] - o.z]; };

  // ---- writes: the brush's edit (sim.paint), as a player's strokes are
  // A box of cells [lo, hi) (grid cells): a cube brush of radius ½ grown to
  // the box (shaders/passes.js strokeDist), so it covers exactly those cells.
  const brushBox = (lo, hi) => {
    const lg = toGrid(lo), hg = toGrid(hi);
    const half = [0, 1, 2].map((i) => (hg[i] - lg[i]) / 2);
    return { center: { x: lg[0] + half[0], y: lg[1] + half[1], z: lg[2] + half[2] }, radius: 0.5, shape: 1, grow: half.map((h) => h - 1) };
  };
  const paint = (lo, hi, tool, extra = {}) => sim().paint({ ...brushBox(lo, hi), tool, rate: 1, replace: false, ...extra });
  // fill [lo, hi) with element `key`; opts: replace (default true: over anything there),
  // sparse (the element's own spawn density, as a player's brush paints: fire, smoke),
  // temp (°C), ctype (an element key: what a clone copies)
  function fill(lo, hi, key, { replace = true, sparse = false, temp = null, ctype = null } = {}) {
    paint(lo, hi, idOf(key), { replace, rate: sparse ? 1 : 1e6 });
    if (temp != null) heat(lo, hi, temp);
    if (ctype != null) paint(lo, hi, PROP_TOOL, { prop: { field: PROP_CTYPE, value: idOf(ctype) } });
  }
  const erase = (lo, hi) => paint(lo, hi, V1_TOOLS.ERASE);
  // a ball of element `key`, radius r (cells) about c (grid cells); opts as fill's
  function ball(c, r, key, { replace = true, sparse = false } = {}) {
    const g = toGrid(c);
    sim().paint({ center: { x: g[0], y: g[1], z: g[2] }, radius: r, shape: 0, tool: idOf(key), rate: sparse ? 1 : 1e6, replace });
  }
  // a length of the shot's cells on this grid (at least one cell)
  const len = (r) => Math.max(1, r * k);
  // every non-empty cell of [lo, hi) to temp °C (TPT's Property tool)
  function heat(lo, hi, temp) { paint(lo, hi, PROP_TOOL, { prop: { field: PROP_TEMP, value: temp } }); }

  // ---- keys: the first-person body reads the keyboard (pov/index.js)
  function keys(want) {
    if (live) return;
    const next = new Set(want);
    for (const code of held) if (!next.has(code)) dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    for (const code of next) if (!held.has(code)) dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    held = next;
  }
  const keysAt = (clipTime) => (shot?.clip?.keys ?? []).filter((h) => clipTime >= h.from && clipTime < h.to).map((h) => h.key);

  // The scene's own animations on game time, as the app's tick runs them
  // (wire/mesh.js afterStep: perk orbs bob on the simulation's clock); they
  // were last placed on the wall clock (perkOrbs.add), which differs per page.
  const animate = () => app.perkOrbs?.update(ticks / TICK_HZ);

  // ---- game time
  async function steps(n) {
    for (let left = n; left > 0; left -= STEP_BATCH) {
      const m = Math.min(STEP_BATCH, left);
      if (test) test.step(m);
      else for (let i = 0; i < m; i++) sim().step();
      await app.gpu.fence();
    }
  }
  // render: draw every tick (a clip at full quality: the view's history as a
  // player's screen builds it); a draft clip draws only the frames it keeps
  async function run(seconds, { render = false } = {}) {
    render = render && quality === 'full' && !live;
    t += seconds;
    const target = Math.round(t * TICK_HZ);
    const n = target - ticks;
    if (n <= 0) return;
    const t0 = performance.now();
    const per = app.settings.steps;
    const pov = !live && app.pov?.active;
    const scripted = !live && clipT0 !== null && shot?.clip?.keys?.length;
    if (!pov && !render && !scripted) {   // nothing per tick: the steps in batches
      await steps(n * per);
      ticks = target;
      rendered = false;
      if (n > 1) say(`${n} ticks (${n * per} steps) in ${since(t0)}`);
      return;
    }
    for (let i = 0; i < n; i++) {
      ticks++;
      if (scripted) keys(keysAt(ticks / TICK_HZ - clipT0));
      if (pov) {
        app.pov.update(1 / TICK_HZ);
        await new Promise((r) => setTimeout(r, 0));   // (the body's probes land)
      }
      await steps(per);
      if (render) { animate(); await test.renderOnce(); }
    }
    rendered = render;
    if (n > 1) say(`${n} ticks (${n * per} steps${render ? ', a frame each' : ''}${pov ? ', the body' : ''}) in ${since(t0)}`);
  }

  // ---- the camera
  const toScene = (p) => {
    app.volume.updateMatrixWorld();
    return new THREE.Vector3(...toGrid(cell(p))).applyMatrix4(app.volume.matrixWorld);
  };
  async function look(cam) {
    if (cam.pov) return enterPov(cam.pov);
    app.camera.position.copy(toScene(cam.pos));
    app.controls.target.copy(toScene(cam.target));
    if (cam.fov) { app.camera.fov = cam.fov; app.camera.updateProjectionMatrix(); }
    app.controls.update();
    test?.resetView();
    rendered = false;
  }
  // First person: in at feet (cells), looking along yaw (0 faces -z, -π/2 +x)
  // and pitch (up +), the body's own model loaded.
  async function enterPov({ feet, yaw, pitch }) {
    const pov = app.pov;
    if (!pov) throw new Error('first person is not in this build');
    if (!live) pov.test.assumeLocked = true;   // (headless has no pointer lock)
    const at = () => new THREE.Vector3(...toGrid(cell(feet)));
    await pov.enter({ swoop: 0, hint: false, at: at() });
    for (let i = 0; i < POV_ENTER_TICKS && pov.mode !== 'on' && !live; i++) {
      pov.update(1 / TICK_HZ);
      await new Promise((r) => setTimeout(r, 0));
    }
    const until = performance.now() + 30000;
    while (!pov.figure?.loaded && performance.now() < until) await new Promise((r) => setTimeout(r, 100));
    pov.player.spawn(at());
    pov.setLook(yaw, pitch);
    if (!live) pov.update(0);   // the camera onto the body and the look, with no time passing
    test?.resetView();
    rendered = false;
  }

  // ---- loading
  async function whenWorldLoaded() {
    const until = performance.now() + 300000;
    while (app.win && !app.win.loaded && performance.now() < until) await new Promise((r) => setTimeout(r, 100));
    if (app.win && !app.win.loaded) throw new Error('the world window did not load');
  }
  async function load(s) {
    shot = s;
    t = 0; ticks = 0; clipT0 = null; rendered = false;
    keys([]);
    if (test) { test.park(); await test.ready(); }
    app.settings.paused = true;
    if (app.pov?.active) app.pov.exit(true);
    app.autoRes.enabled = false;
    if (quality === 'draft' && !live) app.post.settings.taa = false;
    app.day.clock = 0;
    Math.random = seeded(s.seed ?? 1);
    const scene = s.scene;
    if (scene.world) {
      await whenWorldLoaded();
      if (scene.focus) {
        const n = [sim().g.nx, sim().g.nz], step = 16;   // (world/window.js WIN_STEP)
        const size = app.win.size;
        const o = [0, 2].map((i, j) => Math.min(Math.max(Math.round((scene.focus[j] - n[j] / 2) / step) * step, 0), size[i] - n[j]));
        app.worldLoad([o[0], 0, o[1]]);
      }
    } else {
      app.loadPreset(scene.arena ?? scene.preset, false);
    }
    if (test) await test.ready();
    k = scene.grid && !scene.world && !scene.arena ? sim().g.nx / scene.grid : 1;
    sim().frame = 0;     // the sim's random streams are keyed on its step counter...
    sim().paints = 0;    // ...and the brush's on its stroke counter
    sim().resetGI();
    if (s.build) await s.build(api);
    await app.gpu.fence();
    say(`loaded (grid ${sim().g.nx}×${sim().g.ny}×${sim().g.nz}, ×${k})`);
  }

  // ---- frames
  async function converge() {
    if (live) return;
    const t0 = performance.now();
    animate();
    let n = DRAFT_STILL_FRAMES;
    if (quality === 'draft') { for (let i = 0; i < n; i++) await test.renderOnce(); }
    else n = await test.render();
    rendered = true;
    say(`view converged: ${n} frames in ${since(t0)}`);
  }
  async function present() {
    if (live || rendered) return;
    animate();
    await test.renderOnce();
    rendered = true;
  }
  // the clip's clock starts: keys from now on are the clip's
  function startClip() { clipT0 = ticks / TICK_HZ; rendered = false; }

  function describe() {
    const g = sim().g;
    const view = app.settings.view;
    return {
      engine: 'today (WebGPU port)',
      grid: [g.nx, g.ny, g.nz],
      window: app.win ? { origin: sim().origin.toArray(), world: app.win.size } : null,
      scale: k,
      quality,
      view,
      taa: app.post.settings.taa,
      upscale: app.settings.upscale,
      renderScale: +app.post.renderScale?.toFixed?.(3),
      settings: Object.fromEntries(['nearGI', 'glowLights', 'caustics', 'steps'].map((key) => [key, app.settings[key]])),
      detailShown: app.view?.detailShown ?? null,
      elementIds: ids,
      gameSecond: `${TICK_HZ} ticks × ${app.settings.steps} steps`,
      nondeterminism: [
        'TAA history: the post pass\'s jitter index counts every frame the page drew (not resettable); manual mode draws none before the shot, so both sides start at the same index',
        ...(app.pov?.active ? ['first person: the body\'s probes are read back asynchronously; each tick waits one task for them'] : []),
        ...(app.arena ? ['the arena\'s team banners sway from the wall clock of the moment they were placed (arenas/markers.js; not reachable from __app)'] : []),
        ...notes,
      ],
    };
  }

  const api = {
    TICK_HZ, describe, load, run, look, converge, present, startClip, keys, notes,
    span, cell, len, fill, ball, erase, heat,
    get time() { return t; },
    get live() { return live; },
    get quality() { return quality; },
  };
  return api;
}

/**
 * A shot played up to its capture (the tool) or up to where the player takes
 * over (?shot=): the scene loaded and built, its game time run, the camera
 * set; a clip's setup made and run to the clip's start. timeScale shortens
 * the shot's times (the container's smoke runs, where a game second of steps
 * is minutes): both sides get the same, and the sheet says so.
 */
export async function prepareShot(engine, shot, { timeScale = 1 } = {}) {
  await engine.load(shot);
  await engine.run((shot.time ?? 0) * timeScale);
  await engine.look(shot.camera);
  if (!shot.clip) return;
  // the screen as a player's has it when the action starts (TAA's history; a draft has none)
  if (!engine.live && engine.quality === 'full') await engine.converge();
  await shot.setup?.(engine);
  engine.startClip();
  await engine.run((shot.clip.start ?? 0) * timeScale, { render: true });
}

/** The engine a page uses: its own (window.__shotEngine), else today's on __app. */
export async function pageEngine(opts) {
  if (window.__shotEngine) return typeof window.__shotEngine === 'function' ? window.__shotEngine(opts) : window.__shotEngine;
  return createEngine(window.__app, opts);
}
