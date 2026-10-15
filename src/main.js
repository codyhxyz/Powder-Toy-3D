// The page's entry: the start menu first (ui/menu.js), and the game (app.js,
// three.js and the simulation) only once a map is picked, so the page is up
// at once. A link with a query (?size=…, ?preset=…, ?map=…, an invite's
// ?join=…, a sign-in's return) skips the menu and boots straight into the app,
// as before: the test tools and shared links depend on that. ?mode=slayer
// (with ?map=, else the mode's Play map) boots straight into a match.
//
// The game draws with WebGPU (docs/webgpu.md W5, G5). The adapter is asked
// for at once, before app.js is imported, and the menu doesn't wait for it.
// A browser that can't start WebGPU gets a page saying so and why: no
// navigator.gpu (on plain http, because WebGPU needs a secure origin), no
// adapter, only a software adapter (?software=1 uses it anyway), or a device
// request app.js was refused. Nothing redirects: there is no WebGL2 build.
// While the menu is up, only game files are prefetched (preload.js).
import './fonts.css';   // Archivo and Silkscreen, self-hosted
import './ui/menu.css';
import { createMenu } from './ui/menu.js';
import { launch, mark } from './launch.js';
import { preloadGame, gameFetched, refreshGameFiles } from './preload.js';
import { GAMEMODES, mapOf, mapByKey, mapsFor, DEFAULT_MAP, MOBILE_MAP } from './maps.js';
import { probeWebGPU } from './gpu/device.js';
import { BOOT_RETRY, bootModuleRecovery } from './bootRecovery.js';
import { startupDeadline, safeStartupHref, loadSourceMapManifests } from './startupSafety.js';

// The converted source levels (public/local-maps): their manifests register the
// maps before the menu lists them, and each map's geometry loads when it is
// opened. A map that fails to register is simply absent, never substituted.
let sourceMapError = null;
try { await loadSourceMapManifests(() => import('./world/import/localMap.js')); }
catch (error) { sourceMapError = error; console.error('Converted source maps failed to register', error); }

// The team gamemodes exist only in builds that have them (src/game: the Big Team Battle modes).
const TEAM_GAMES = Object.keys(import.meta.glob('./game/index.js')).length > 0;
// Don't offer an empty mission category when no valid local source map exists.
const MODES = GAMEMODES.filter(m => (!m.team || TEAM_GAMES) && mapsFor(m.key).length > 0);
const SETTINGS_STORE = 'powder-toy-3d:settings';   // app.js STORE: the map last played
const MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;   // app.js MOBILE
// the most it waits for the loading screen's next step to paint before the
// build holds the main thread (a hidden tab paints nothing: it goes on anyway)
const PAINT_WAIT_MS = 100;
const TEST_PAGE = new URLSearchParams(location.search).has('test') || window.__TPT_TEST_MODE__ !== undefined;   // app.js testMode

// The adapter request answers in milliseconds; the menu doesn't wait for it.
// probeWebGPU resolves { ok, reason, message, adapter } and doesn't reject;
// the catch is for a bug in it.
const probe = probeWebGPU().catch((err) => ({ ok: false, reason: 'adapter-error', message: String(err?.message ?? err), adapter: null }));

let lastPlayed = null;
try { lastPlayed = mapOf(JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}'))?.key; } catch { /* storage unavailable */ }
const firstMap = lastPlayed ?? (MOBILE ? MOBILE_MAP : DEFAULT_MAP);

let app = null;   // app.js, once booted
const menu = createMenu({
  modes: MODES,
  map: firstMap,
  onStart: start,
  onResume: () => menu.close(),
  onLoadSave: loadSave,
});

// No usable adapter: the error page, the menu closed.
probe.then((p) => { if (!p.ok && !launch.startupError) showWebgpuError(p.message || p.reason, p.reason); });

// (opts.saves: on the Saves list)
launch.openMenu = (opts = {}) => {
  if (menu.isOpen) return;
  menu.open({ inGame: true, ...app?.current(), ...opts });
};
launch.menuOpen = () => menu.isOpen;

// Menu browsing only fetches files. Hovering maps must not create devices or
// queue shader compilations for worlds the player has not chosen to start.
let finishStartup = null, startupComplete = false;
function watchStartup() {
  if (finishStartup || app) return;
  finishStartup = startupDeadline((error) => {
    launch.startupError = error;
    showStartupError(error);
    // Best effort only: a device request can itself still be pending.
    // If it resolves late, stop that device rather than restarting the boot.
    Promise.resolve(launch.gpu).then((gpu) => {
      gpu?.fail(error);
      showStartupError(error);
    }, () => {});
  });
}
function showStartupError(error) {
  menu.close();
  showError(`${error.message}\n\nYou can restart with source textures disabled and the Plain view.`
    + (launch.save != null ? '\nSelect your save again after restarting.' : ''));
  const el = document.getElementById('error');
  el.style.flexDirection = 'column';
  el.style.gap = '20px';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Restart with safe graphics';
  button.onclick = () => location.assign(safeStartupHref(location.href, launch));
  el.append(button);
}

async function start(map, mode) {
  mark('click');
  if (app) {
    menu.close();
    app.openMap(map, mode);
    return;
  }
  launch.map = map;
  launch.mode = mode;
  menu.loading('Loading something cool, please be patient', { map, mode });
  await bootInSteps();
}
launch.ready = () => {
  if (launch.startupError) return;
  startupComplete = true;
  finishStartup?.();
  menu.close();
  const url = new URL(location.href);
  if (url.searchParams.has(BOOT_RETRY)) {
    url.searchParams.delete(BOOT_RETRY);
    history.replaceState(history.state, '', url.href);
  }
};
launch.failed = (error) => {
  finishStartup?.();
  if (!startupComplete) {
    launch.startupError ??= error;
    showStartupError(launch.startupError);
  }
};
// The loading screen's steps as the boot reaches them (ui/menu.js STEPS): the
// download and the build's start here, then app.js's pipeline builds, world,
// and a team mode's match being set up behind the screen (its status line).
launch.progress = (step) => { if (!launch.startupError) menu.progress(step); };
launch.status = (text) => { if (!launch.startupError && menu.isOpen) menu.progress('match', text); };

// The boot from the menu, its first two steps shown: the game's modules
// arriving (fetched in the background while the menu was up), then the build,
// on screen before app.js holds the main thread building the map in one go.
async function bootInSteps() {
  watchStartup();
  menu.progress('fetch');
  await gameFetched();
  if (launch.startupError) return;
  menu.progress('build');
  await painted();
  if (launch.startupError) return;
  await boot();
}

// after the next frame has painted, or PAINT_WAIT_MS
const painted = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
  setTimeout(resolve, PAINT_WAIT_MS);
});

// ?mode=<a team mode>: a match on ?map= when that map is built for it, else on the mode's first; a mode this build doesn't have, or a map not built for it, is Sandbox
function linkMode(params) {
  const mode = params.get('mode');
  if (!MODES.some((m) => m.key === mode) || mode === 'sandbox') return;
  const map = params.get('map') ?? mapsFor(mode)[0]?.key;
  if (!mapByKey(map)?.modes?.includes(mode)) return;
  mark('click');
  launch.mode = mode;
  if (!params.get('map')) launch.map = map;
  menu.loading('Loading something cool, please be patient', { map, mode });   // (down once the match runs)
  menu.progress('fetch');
}

// A save picked on the menu's Saves (what: a local save's id or a file's bytes;
// meta: its name and map). Before the game has loaded, it boots on the save's
// map and loads the save before the menu comes down (app.js bootReady).
async function loadSave(what, meta) {
  if (app) {
    menu.close();
    app.openSave(what);
    return;
  }
  launch.save = what;
  // (a box the Empty map's size boots on Empty: the save brings the cells, so no scene is built first)
  const emptyDims = mapByKey('empty').dims;
  launch.map = !meta?.world && emptyDims.every((n, i) => n === meta?.dims?.[i]) ? 'empty' : meta?.map ?? null;
  launch.mode = 'sandbox';
  menu.loading('Loading your save', { name: meta?.name ?? 'Save' });
  await bootInSteps();
}

// The error page when WebGPU won't start: `why` is the probe's sentence (no
// navigator.gpu, with the secure-origin hint on plain http; no adapter; a
// software adapter, which ?software=1 uses anyway) or the refused device
// request's (app.js). The game can't draw without it, so the menu goes.
let webgpuFailed = false;
function showWebgpuError(why, reason) {
  finishStartup?.();
  webgpuFailed = true;
  const lines = [`The game cannot start WebGPU right now. ${why}`];
  if (reason === 'no-adapter') {
    lines.push('No shader compilation or map generation started. This error does not identify why GPU access is unavailable.',
      'If this followed a browser hang, save your other work, then quit and reopen the browser.',
      'Chrome: chrome://gpu. Edge: edge://gpu. Check WebGPU status and reported problems.');
  } else {
    lines.push('WebGPU is available in Chrome, Edge and Safari 26 on supported systems. Graphics acceleration must be available.');
  }
  if (TEST_PAGE) lines.push('Under test, run Chromium with --enable-unsafe-webgpu (tools/browser.mjs does).');
  menu.close();
  showError(lines.join('\n'));
}

// (inline: ui/styles.css, which styles .error, comes with app.js)
function showError(text) {
  const el = document.getElementById('error');
  el.style.cssText = 'display: flex; position: fixed; inset: 0; align-items: center; justify-content: center; padding: 40px; color: #ff9a9a; font: 12px/1.5 system-ui, sans-serif; white-space: pre-wrap;';
  el.textContent = text;
}

// What the GPU said after the probe, when the browser won't draw at all
// (app.js's own failures, after the device, have their messages: B9).
const WEBGPU_OFF = `Your browser won't start WebGPU right now, so the game can't draw.
This error does not identify the cause. Save your other work, then quit the browser completely and reopen it.
If it keeps happening, chrome://gpu shows graphics availability, detected problems, and driver messages.`;

async function boot() {
  watchStartup();
  const p = await probe;
  if (launch.startupError) return;
  if (!p.ok) return;           // (the probe's handler explained)
  launch.adapter = p.adapter;  // app.js: createGpu on it, unless preload.js made the device already (launch.gpu)
  try {
    if (new URL(location.href).searchParams.has(BOOT_RETRY)) await refreshGameFiles();
    app = await import('./app.js');
  } catch (err) {
    finishStartup?.();
    if (launch.startupError) {
      showStartupError(launch.startupError);
      return;
    }
    // app.js's createGpu was refused a device: as good as no adapter (B2)
    if (err === launch.deviceError) {
      showWebgpuError(`The browser refused a WebGPU device: ${err.message || err.name || err}`, 'device-error');
      return;
    }
    menu.close();
    if (err.name === 'GraphicsFailure') throw err; // app.js already explained the stopped state
    const recovery = bootModuleRecovery(err, { ...launch, href: location.href, running: !!window.__app });
    if (recovery) {
      console.error('Game module download failed', err);
      if (recovery.automatic) {
        location.replace(recovery.href);
        return;
      }
      showError('The game files could not be downloaded. The site may have updated, or the connection was interrupted.\n'
        + (launch.save != null ? 'Reload the page, then select your save again.' : 'Check your connection, then reload the page.'));
      const el = document.getElementById('error');
      el.style.flexDirection = 'column';
      el.style.gap = '20px';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Reload page';
      button.onclick = () => location.replace(recovery.href);
      el.append(button);
      return;
    }
    // three.js says this only when the browser won't give it a WebGPU context at all
    const off = /WebGPU is not available|Unable to create WebGPU context/i.test(String(err.message));
    showError((off ? WEBGPU_OFF + '\n\n' : '') + String(err.stack || err));
    throw err;
  }
}

if (location.search) {
  const params = new URLSearchParams(location.search);
  if (params.get('map') && !mapByKey(params.get('map'))) {
    menu.close();
    showError(`${sourceMapError ? `${sourceMapError.message}\n` : ''}`
      + `The requested map "${params.get('map')}" is unavailable. Select another map from the home page.`);
  } else {
    linkMode(params);
    boot();
  }
} else {
  menu.open();
  // Network prefetch only. GPU compilation starts after an explicit Start.
  probe.then((p) => {
    if (!p.ok || webgpuFailed) return;
    launch.adapter = p.adapter;
    preloadGame();
  });
}
