// The game, fetched in the background while the start menu is up, so Start
// only has to run it. The build lists what the game is made of in index.html
// (scripts/app-preload-plugin.mjs): app.js and the chunks it imports are
// module-preloaded (fetched and compiled, but not run: running app.js boots
// the game), and its CSS, its workers and the POV body's model are prefetched
// into the HTTP cache. It starts once the menu itself has loaded and the
// browser is idle, so it never slows the menu down, and not at all when the
// browser asks to save data. The dev server lists nothing: the game loads on Start.
import { BODY_MODEL_URL } from './pov/bodyModel.js';

const PRELOAD_LIST = 'app-preload';   // scripts/app-preload-plugin.mjs PRELOAD_LIST
const IDLE_TIMEOUT_MS = 2000;         // the longest it waits for an idle moment once the page has loaded
const NO_IDLE_DELAY_MS = 200;         // its wait without requestIdleCallback (Safari): after the menu's first frames

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

// Fetch the game once the page has loaded and the browser is idle.
export function preloadGame() {
  const idle = () => (window.requestIdleCallback
    ? requestIdleCallback(preload, { timeout: IDLE_TIMEOUT_MS })
    : setTimeout(preload, NO_IDLE_DELAY_MS));
  if (document.readyState === 'complete') idle();
  else addEventListener('load', idle, { once: true });
}
