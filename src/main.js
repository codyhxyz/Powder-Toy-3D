// The page's entry: the start menu first (ui/menu.js), and the game (app.js,
// three.js and the simulation) only once a map is picked, so the page is up
// at once. A link with a query (?size=…, ?preset=…, ?map=…, an invite's
// ?join=…, a sign-in's return) skips the menu and boots straight into the app,
// as before: the test tools and shared links depend on that.
import './fonts.css';   // Archivo and Silkscreen, self-hosted
import './ui/menu.css';
import { createMenu } from './ui/menu.js';
import { launch } from './launch.js';
import { preloadGame, gameFetched } from './preload.js';
import { GAMEMODES, mapOf, DEFAULT_MAP, MOBILE_MAP } from './maps.js';

// The team gamemodes exist only in builds that have them (src/game: the Big Team Battle modes).
const TEAM_GAMES = Object.keys(import.meta.glob('./game/index.js')).length > 0;
const MODES = GAMEMODES.filter((m) => !m.team || TEAM_GAMES);
const SETTINGS_STORE = 'powder-toy-3d:settings';   // app.js STORE: the map last played
const MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;   // app.js MOBILE
// the most it waits for the loading screen's next step to paint before the
// build holds the main thread (a hidden tab paints nothing: it goes on anyway)
const PAINT_WAIT_MS = 100;

let lastPlayed = null;
try { lastPlayed = mapOf(JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}'))?.key; } catch { /* storage unavailable */ }

let app = null;   // app.js, once booted
const menu = createMenu({
  modes: MODES,
  map: lastPlayed ?? (MOBILE ? MOBILE_MAP : DEFAULT_MAP),
  onStart: start,
  onResume: () => menu.close(),
});

launch.openMenu = () => {
  if (menu.isOpen) return;
  menu.open({ inGame: true, ...app?.current() });
};

async function start(map, mode) {
  if (app) {
    menu.close();
    app.openMap(map, mode);
    return;
  }
  launch.map = map;
  launch.mode = mode;
  // The loading screen, and its steps as the boot reaches them (ui/menu.js STEPS):
  // the download here, then app.js's build, shader compile and world.
  menu.loading('Loading something cool, please be patient');
  launch.progress = (step) => menu.progress(step);
  launch.ready = () => menu.close();
  menu.progress('fetch');
  await gameFetched();
  menu.progress('build');
  await painted();   // (app.js builds the map in one go: the line must be on screen first)
  await boot();
}

// after the next frame has painted, or PAINT_WAIT_MS
const painted = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
  setTimeout(resolve, PAINT_WAIT_MS);
});

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

if (location.search) boot();
else {
  menu.open();
  preloadGame();   // the game downloads while the menu is up
}
