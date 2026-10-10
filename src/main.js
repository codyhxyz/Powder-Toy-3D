// The page's entry: the start menu first (ui/menu.js), and the game (app.js,
// three.js and the simulation) only once a map is picked, so the page is up
// at once. A link with a query (?size=…, ?preset=…, ?map=…, an invite's
// ?join=…, a sign-in's return) skips the menu and boots straight into the app,
// as before: the test tools and shared links depend on that.
import './ui/menu.css';
import { createMenu } from './ui/menu.js';
import { launch } from './launch.js';
import { GAMEMODES, mapOf, DEFAULT_MAP, MOBILE_MAP } from './maps.js';

// The team gamemodes exist only in builds that have them (src/game: the Big Team Battle modes).
const TEAM_GAMES = Object.keys(import.meta.glob('./game/index.js')).length > 0;
const MODES = GAMEMODES.filter((m) => !m.team || TEAM_GAMES);
const SETTINGS_STORE = 'powder-toy-3d:settings';   // app.js STORE: the map last played
const MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;   // app.js MOBILE

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
  // (one message: the main thread is busy compiling until the map is up, so a second would never paint)
  menu.loading('Loading… the first time after an update this can take a few seconds');
  launch.ready = () => menu.close();
  await boot();
}

const WEBGL_OFF = `Your browser won't start WebGL 2 right now, so the game can't draw.
This usually means its graphics process crashed or was reset (low memory, or a GPU hang),
and it has switched 3D off until it restarts. Quit the browser completely and reopen it.
If it keeps happening, chrome://gpu shows whether WebGL 2 is available.`;

async function boot() {
  try {
    app = await import('./app.js');
  } catch (err) {
    menu.close();
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
else menu.open();
