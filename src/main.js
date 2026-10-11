// The page's entry: the start menu first (ui/menu.js), and the game (app.js,
// three.js and the simulation) only once a map is picked, so the page is up
// at once. A link with a query (?size=…, ?preset=…, ?map=…, an invite's
// ?join=…, a sign-in's return) skips the menu and boots straight into the app,
// as before: the test tools and shared links depend on that. ?mode=slayer
// (with ?map=, else the mode's Play map) boots straight into a match.
import './fonts.css';   // Archivo and Silkscreen, self-hosted
import './ui/menu.css';
import { createMenu } from './ui/menu.js';
import { launch, mark } from './launch.js';
import { preloadGame } from './preload.js';
import { GAMEMODES, QUICK_PLAY, mapOf, mapByKey, mapsFor, DEFAULT_MAP, MOBILE_MAP } from './maps.js';

// The team gamemodes exist only in builds that have them (src/game: the Big Team Battle modes).
const TEAM_GAMES = Object.keys(import.meta.glob('./game/index.js')).length > 0;
const MODES = GAMEMODES.filter((m) => !m.team || TEAM_GAMES);
const QUICK = TEAM_GAMES ? QUICK_PLAY : [];   // one-click Play needs the team games
const SETTINGS_STORE = 'powder-toy-3d:settings';   // app.js STORE: the map last played
const MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;   // app.js MOBILE

let lastPlayed = null;
try { lastPlayed = mapOf(JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}'))?.key; } catch { /* storage unavailable */ }

let app = null;   // app.js, once booted
const menu = createMenu({
  modes: MODES,
  quick: QUICK,
  map: lastPlayed ?? (MOBILE ? MOBILE_MAP : DEFAULT_MAP),
  onStart: start,
  onResume: () => menu.close(),
  onLoadSave: loadSave,
});

// (opts.saves: on the Saves list)
launch.openMenu = (opts = {}) => {
  if (menu.isOpen) return;
  menu.open({ inGame: true, ...app?.current(), ...opts });
};
launch.menuOpen = () => menu.isOpen;

async function start(map, mode) {
  mark('click');
  if (app) {
    menu.close();
    app.openMap(map, mode);
    return;
  }
  launch.map = map;
  launch.mode = mode;
  // (the main thread is busy compiling until the map is up: a second line paints only once a
  // team mode's match is being set up behind the loading screen, app.js bootReady)
  menu.loading('Loading something cool, please be patient');
  await boot();
}
launch.ready = () => menu.close();
launch.status = (text) => { if (menu.isOpen) menu.loading(text); };

// ?mode=<a team mode>: a match on ?map= when that map is built for it, else on the mode's Play map
// (maps.js QUICK_PLAY) or its first; a mode this build doesn't have, or a map not built for it, is Sandbox
function linkMode(params) {
  const mode = params.get('mode');
  if (!MODES.some((m) => m.key === mode) || mode === 'sandbox') return;
  const map = params.get('map') ?? QUICK.find((q) => q.mode === mode)?.map ?? mapsFor(mode)[0]?.key;
  if (!mapByKey(map)?.modes?.includes(mode)) return;
  mark('click');
  launch.mode = mode;
  if (!params.get('map')) launch.map = map;
  menu.loading('Loading something cool, please be patient', { map, mode });   // (down once the match runs)
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
  launch.ready = () => menu.close();
  await boot();
}

const WEBGL_OFF = `Your browser won't start WebGL 2 right now, so the game can't draw.
This error does not identify the cause. Save your other work, then quit the browser completely and reopen it.
If it keeps happening, chrome://gpu shows graphics availability, detected problems, and driver messages.`;

async function boot() {
  try {
    app = await import('./app.js');
  } catch (err) {
    menu.close();
    if (err.name === 'GraphicsFailure') throw err; // app.js already explained the stopped state
    const el = document.getElementById('error');
    el.style.display = 'flex';
    // three.js says this only when the browser won't make any WebGL 2 context at all
    // (it retries without our attributes first): the browser's state, not the page
    const noWebgl = /Error creating WebGL context\.$/m.test(String(err.message));
    el.textContent = (noWebgl ? WEBGL_OFF + '\n\n' : '') + String(err.stack || err);
    throw err;
  }
}

if (location.search) {
  linkMode(new URLSearchParams(location.search));
  boot();
} else {
  menu.open();
  preloadGame();   // the game downloads while the menu is up
}
