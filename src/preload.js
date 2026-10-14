// The game, fetched and warmed up in the background while the start menu is
// up, so Start only has to run it.
//
// Fetching: the build lists what the game is made of in index.html
// (scripts/app-preload-plugin.mjs): app.js and the chunks it imports are
// module-preloaded (fetched and compiled, but not run: running app.js boots
// the game), and its CSS, its workers and the POV body's model are prefetched
// into the HTTP cache. It starts once the menu itself has loaded and the
// browser is idle, so it never slows the menu down, and not at all when the
// browser asks to save data. The dev server lists nothing: the game loads on Start.
//
// Warming (docs/webgpu.md B5, W18; the user's call: compile while the player
// is busy choosing, the way a catalogue site loads behind its first page):
// once the menu is idle, the WebGPU device is made here (createGpu, on the
// adapter main.js's probe found) and the selected map's pipelines start
// building for its grid, at most PIPELINE_CONCURRENCY at a time and at idle
// time, so nothing blocks the menu. Selecting or hovering a map with another
// grid starts that grid's set too, before the click. The set is what each
// module's WGSL_CHECK list says a session builds (the lists
// tools/check-wgsl.mjs builds): not the tools' kernels (`tool`), not the test
// probes (`warm: false`), a world's kernels only on a world's grid
// (`windowed`), and of the volume only what the saved view and detail
// settings draw (shaders/render.js warmChecks). The device made here is the
// one app.js uses (launch.gpu), and pipelines are cached by their source and
// descriptor (gpu/kernels.js), so new Simulation and the renderer then find
// them built or building: Start waits only for what is still pending, behind
// the loading screen, which shows only if Start comes first. A device lost
// while the menu is up (no game on it yet) is dropped: the next warm-up, or
// Start, makes a new one.
import { BODY_MODEL_URL } from './pov/bodyModel.js';
import { launch } from './launch.js';
import { mapByKey, isWorld, resolveMode } from './maps.js';
import { refreshBootFiles } from './bootRecovery.js';

const PRELOAD_LIST = 'app-preload';   // scripts/app-preload-plugin.mjs PRELOAD_LIST
const IDLE_TIMEOUT_MS = 2000;         // the longest it waits for an idle moment once the page has loaded
const NO_IDLE_DELAY_MS = 200;         // its wait without requestIdleCallback (Safari): after the menu's first frames
const SETTINGS_STORE = 'powder-toy-3d:settings';   // app.js STORE: the view and detail switches the warm-up builds for
// A world's window, x and z (app.js WORLDS; its height is the world's). Until
// the world's port lands (src/wire/world.js) a world map boots the 128³ box,
// which the island-sized worlds' window set covers: a window builds the
// kernels of a box its size, plus the window's own.
const WORLD_WINDOW = [128, 128];
const MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;   // app.js MOBILE

// a link's load (or its failure: the import that needs it reports that)
function link(rel, href) {
  const el = Object.assign(document.createElement('link'), { rel, href });
  const arrived = new Promise((resolve) => { el.onload = el.onerror = resolve; });
  document.head.append(el);
  return arrived;
}

let fetched = null;   // the game's modules are in: once preload has started
function preload() {
  if (fetched) return;
  fetched = Promise.resolve();
  const el = document.getElementById(PRELOAD_LIST);
  if (!el || navigator.connection?.saveData) return;
  const { modules, styles, workers } = JSON.parse(el.textContent);
  fetched = Promise.all(modules.map((href) => link('modulepreload', href)));
  for (const href of [...styles, ...workers, BODY_MODEL_URL]) link('prefetch', href);
}

// Resolves once the game's modules are fetched (started now, if the idle wait
// hasn't yet): the loading screen's "Downloading the game" (ui/menu.js). At once
// on the dev server, which lists nothing, and when the browser asks to save data.
export function gameFetched() {
  preload();
  return fetched;
}

// Development has no hashed bundle manifest.
export async function refreshGameFiles() {
  const el = document.getElementById(PRELOAD_LIST);
  await refreshBootFiles(el ? JSON.parse(el.textContent) : null);
}

const whenIdle = (fn) => (window.requestIdleCallback
  ? requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS })
  : setTimeout(fn, NO_IDLE_DELAY_MS));

/**
 * Fetches the game once the page has loaded and the browser is idle, and
 * warms its pipelines up for `map` (a maps.js key) on the adapter main.js's
 * probe found (launch.adapter; none: no warm-up). warmMap(key) adds another
 * map's grid later (the menu's hover and selection).
 * @param {{ map?: string | null }} [opts]
 */
export function preloadGame({ map = null } = {}) {
  const start = () => whenIdle(() => {
    preload();
    if (map) warmMap(map);
  });
  if (document.readyState === 'complete') start();
  else addEventListener('load', start, { once: true });
}

// ---------------------------------------------------------------- warm-up

let device = null;          // the device's promise, once asked for
let spent = null;           // the last device's promise, once that device was lost
let warmer = null;          // the warm-up, once its modules are in
const warmed = new Set();   // grids (keys) whose set was started
const wanted = [];          // grids asked for before the modules came in

/**
 * The device app.js will use (launch.gpu): made once, on the adapter main.js's
 * probe found, and again on a new adapter after it was lost (an adapter makes
 * one device). A refused device rejects here and again in app.js, which shows
 * the WebGPU error page (G5).
 * @returns {Promise<object>}
 */
export function warmDevice() {
  if (!device && launch.gpu && launch.gpu !== spent) device = launch.gpu;   // (app.js asked first)
  if (!device) {
    if (!launch.adapter) return Promise.reject(new Error('preload: no WebGPU adapter (main.js probes first)'));
    const adapter = spent ? undefined : launch.adapter;   // (none: createGpu asks for a new one)
    const p = device = import('./gpu/device.js').then(({ createGpu }) => createGpu({ adapter, label: 'tpt3d' }));
    launch.gpu = p;
    p.then((gpu) => gpu.device.lost.then(() => deviceLost(p)), () => {});   // (a refusal: app.js reports it)
  }
  return device;
}

// The menu's device lost (the GPU process restarted, a phone put the tab
// away) took its pipelines with it: the warm-up starts over on a new device
// at the next warmMap, and Start, finding launch.gpu's device lost, makes
// its own (app.js). Nothing is rebuilt at once: the build in progress may be
// what got the GPU process killed.
function deviceLost(p) {
  if (device !== p) return;
  spent = p;
  device = warmer = launch.warm = null;
  warmed.clear();
  wanted.length = 0;
}

/**
 * Starts building map `key`'s pipeline set for its grid (once per grid), on
 * warmDevice()'s device. Quietly does nothing for an unknown map, without an
 * adapter, or for a grid the device can't hold (the menus refuse it, B2).
 * A gamemode with a presentation effect (maps.js GAMEMODES.effect: Animal
 * Crossing's rolling log) draws the volume's curved variants instead, so its
 * pick warms those too (once per grid; the grid's other kernels aren't redone).
 * @param {string} key a maps.js key
 * @param {string} [mode] the gamemode picked on the menu
 */
export function warmMap(key, mode = 'sandbox') {
  const m = mapByKey(key);
  if (!m || !launch.adapter) return;
  const grid = { ...gridOf(m), curved: !!resolveMode(m, mode).effect };
  const asked = grid.curved ? `${grid.key} curved` : grid.key;
  if (warmed.has(asked)) return;
  grid.volumeOnly = warmed.has(grid.key) || warmed.has(`${grid.key} curved`);
  warmed.add(asked);
  if (warmer) warmer.grid(grid);
  else if (wanted.push(grid) === 1) startWarmer();
}

// The grid a map's session simulates: a box's own, or a world's window over it.
function gridOf(m) {
  const windowed = isWorld(m);
  const dims = windowed ? [WORLD_WINDOW[0], m.dims[1], WORLD_WINDOW[1]] : m.dims;
  return { dims, windowed, world: windowed ? m.dims : null, key: `${dims.join('x')}${windowed ? 'w' : ''}` };
}

// The device, the modules that list pipelines, then each grid's set as it is asked for.
async function startWarmer() {
  const made = warmDevice();
  let gpu, mods;
  try {
    gpu = await made;
    mods = await Promise.all([
      import('./sim.js'), import('./shaders/render.js'), import('./gfx/post.js'), import('./gfx/overlays.js'),
      import('./brush.js'), import('./gfx/detail.js'), import('./views.js'),
      // the simulation's and the derived passes' kernels
      import('./shaders/move.js'), import('./shaders/react.js'), import('./shaders/activity.js'),
      import('./shaders/passes.js'), import('./shaders/window.js'), import('./shaders/fields.js'),
    ]);
  } catch {
    return;   // (no device: app.js shows why on Start; a module that won't load fails there too)
  }
  const [sim, render, post, overlays, brush, detail, views, ...lists] = mods;
  const names = await layoutNames();
  if (device !== made) return;   // (lost meanwhile: the next warmMap starts over)
  const settings = savedSettings(detail);
  const view = views.viewKey(settings.view);
  const fallback = gpu.adapterInfo.isFallbackAdapter;
  const pipes = [];
  const state = launch.warm = {
    grids: [],
    get built() { return pipes.filter((p) => p.state === 'ready').length; },
    get pending() { return pipes.filter((p) => p.state === 'idle' || p.state === 'pending').length; },
    /** Resolves when every pipeline queued so far has built or failed. */
    settled: () => Promise.allSettled(pipes.map((p) => p.ready)),
  };

  // A WGSL_CHECK entry's pipeline as the game makes it: its layouts under the
  // names the game gives them (or the cache can't match), queued for idle time.
  const layout = (entries, name) => {
    if (!entries || entries === 'EMPTY') return gpu.L.EMPTY;
    const known = name ?? names.of(entries);
    return gpu.layout(known ?? `warm ${JSON.stringify(entries)}`, (known && names.entries(known)) || entries);
  };
  const build = (e, g) => {
    const groups = (e.layouts?.(g) ?? []).slice(0, 3).map((entries, i) => layout(entries, e.layoutNames?.[i]));
    const desc = { name: e.name, code: e.code(g), layouts: groups, params: e.params, constants: e.constants, build: 'idle' };
    pipes.push(e.kind === 'render'
      ? gpu.renderPipeline({ ...desc, vertex: e.vertex, fragment: e.fragment, primitive: e.primitive, depthStencil: e.depthStencil, multisample: e.multisample })
      : gpu.kernel({ ...desc, entry: e.entry, workgroupSize: e.workgroupSize }));
  };
  const inSession = (e, g) => !e.tool && e.warm !== false && (!e.windowed || g.windowed);
  const listed = (mod) => (typeof mod.WGSL_CHECK === 'function' ? mod.WGSL_CHECK() : mod.WGSL_CHECK);
  // sim.editKernel's two-phase writers (reads 'neighbours': TPT's Mix) have a
  // second entry point, `apply`, that the game builds as '<name> apply'
  const TWO_PHASE = new Set(['paintMix']);

  // the grid's own first (the simulation's kernels take longest), then post
  // (the canvas's composite and the stills'), the overlays and the brush
  warmer = {
    grid({ dims, windowed, world, key, curved = false, volumeOnly = false }) {
      const g = sim.gridLayout(...dims);
      g.windowed = windowed;
      if (!gpu.fits(g)) return;
      state.grids.push(curved ? `${key} curved` : key);
      for (const mod of volumeOnly ? [] : lists) {
        for (const e of listed(mod)) {
          if (!inSession(e, g)) continue;
          build(e, g);
          if (TWO_PHASE.has(e.name)) build({ ...e, name: `${e.name} apply`, entry: 'apply' }, g);
        }
      }
      // the view's module (realistic: the detail gate's base variant, its near one last), the shadow kernel if it reads it, pick
      const volume = render.warmChecks(view, settings, { fallback, curved });
      const own = (e) => (e.name === 'shadow' ? { ...e, code: (gg) => render.shadowFrag(gg, world ? { world } : {}) } : e);
      for (const e of volume.filter((x) => !x.idle)) build(own(e), g);
      for (const e of volume.filter((x) => x.idle)) build(e, g);
    },
  };
  for (const grid of wanted.splice(0)) warmer.grid(grid);
  for (const e of listed(post)) {
    // the canvas's composite (the preferred canvas format is one of these two:
    // src/gpu/present.js asks for it, and only src/gpu/ talks to navigator.gpu)
    // and a still's (rgba8unorm: thumbnails, saves)
    if (e.name.startsWith('composite ') && e.name !== 'composite bgra8unorm' && e.name !== 'composite rgba8unorm') continue;
    build(e, null);
  }
  for (const e of [...listed(overlays), ...listed(brush)]) build(e, null);
}

// The app's view and detail switches (app.js DEFAULTS, then its stored settings).
function savedSettings({ detailDefaults, DETAIL, settingKey }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}'); } catch { /* storage unavailable */ }
  const mobile = MOBILE ? Object.fromEntries(DETAIL.map((f) => [settingKey(f), false])) : {};
  return { view: 0, ...detailDefaults(), ...mobile, ...saved };
}

// The names the game makes its bind group layouts under (sim.js simLayouts,
// sim.editKernel's group 2 for the brush, derived.js derivedLayouts), found
// for a WGSL_CHECK entry's layout: gpu.layout keys a layout by its name, and
// the pipeline cache a pipeline by its layout objects, so a layout made under
// another name builds a pipeline the game never finds. Several names hold
// equal entries (REF and CONVERT, REACT and the brush's, MOVE and
// DERIVED_BOOK, FLOW_SHIFT and DERIVED_PAIR), so entries alone can't say
// which: a WGSL_CHECK list names its layouts by the very arrays the game
// makes them from (shaders/passes.js DERIVED_LAYOUT.BOOK, move.js
// MOVE_LAYOUT…), and that identity decides first. An array made on the spot
// (stateLayout's, the Mix's scratch) matches by its entries as gpu.layout
// makes them, or failing that, equal but for visibilities (a check entry may
// name one the game leaves to the default); the game's own entries are then
// used, so the layout is the game's. tools/smoke.mjs's warm stage checks that
// Start then builds nothing the menu built (a miss here builds it twice).
async function layoutNames() {
  const [{ LAYOUT, stateLayout, EDIT_SCRATCH_BINDING }, { MOVE_LAYOUT }, { REACT_LAYOUT }, { BUILD_LAYOUT, REF_LAYOUT },
    { PAINT_LAYOUT, CONVERT_LAYOUT, DERIVED_LAYOUT }, { UNDO_LAYOUT, FLOW_SHIFT_LAYOUT }, { FIELD_LAYOUT }, { withVisibility }] = await Promise.all([
    import('./shaders/common.js'), import('./shaders/move.js'), import('./shaders/react.js'), import('./shaders/activity.js'),
    import('./shaders/passes.js'), import('./shaders/window.js'), import('./shaders/fields.js'), import('./gpu/kernels.js'),
  ]);
  const mix = [...PAINT_LAYOUT, { binding: EDIT_SCRATCH_BINDING, buffer: { type: 'storage' } }];
  const table = {
    TABLES: LAYOUT.TABLES, STATE_RW: LAYOUT.STATE_RW, STATE_RO: LAYOUT.STATE_RO, STATE_ACT: LAYOUT.STATE_ACT,
    STATE_BUILD: LAYOUT.STATE_BUILD, STATE_FLAGS_RO: stateLayout({ state: 'read', flags: true }),
    MOVE: MOVE_LAYOUT, REACT: REACT_LAYOUT, BUILD: BUILD_LAYOUT, REF: REF_LAYOUT, CONVERT: CONVERT_LAYOUT,
    UNDO: UNDO_LAYOUT, FLOW_SHIFT: FLOW_SHIFT_LAYOUT,
    [`edit paint ${JSON.stringify(PAINT_LAYOUT)}`]: PAINT_LAYOUT, [`edit paintMix ${JSON.stringify(mix)}`]: mix,
    DERIVED_BOOK: DERIVED_LAYOUT.BOOK, DERIVED_FIELD: FIELD_LAYOUT.FIELD, DERIVED_JET: FIELD_LAYOUT.JET, DERIVED_PEAK: FIELD_LAYOUT.PEAK,
    DERIVED_BRICK: DERIVED_LAYOUT.BRICK, DERIVED_PAIR: DERIVED_LAYOUT.PAIR, DERIVED_LIGHT: DERIVED_LAYOUT.LIGHT,
    DERIVED_GI_SHIFT: DERIVED_LAYOUT.GI_SHIFT,
  };
  const exact = (entries) => JSON.stringify(entries.map(withVisibility));
  const loose = (entries) => JSON.stringify(entries.map(({ visibility, ...e }) => e));
  const byArray = new Map(), byExact = new Map(), byLoose = new Map();
  for (const [name, entries] of Object.entries(table)) {
    if (!byArray.has(entries)) byArray.set(entries, name);
    if (!byExact.has(exact(entries))) byExact.set(exact(entries), name);
    if (!byLoose.has(loose(entries))) byLoose.set(loose(entries), name);
  }
  return {
    of: (entries) => byArray.get(entries) ?? byExact.get(exact(entries)) ?? byLoose.get(loose(entries)) ?? null,
    entries: (name) => table[name] ?? null,
  };
}
