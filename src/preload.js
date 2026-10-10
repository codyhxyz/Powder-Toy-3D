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

function link(rel, href) {
  document.head.append(Object.assign(document.createElement('link'), { rel, href }));
}

let done = false;
function preload() {
  if (done) return;
  done = true;
  const el = document.getElementById(PRELOAD_LIST);
  if (!el || navigator.connection?.saveData) return;
  const { modules, styles, workers } = JSON.parse(el.textContent);
  for (const href of modules) link('modulepreload', href);
  for (const href of [...styles, ...workers, BODY_MODEL_URL]) link('prefetch', href);
}

// Fetch the game once the page has loaded and the browser is idle.
export function preloadGame() {
  const idle = () => (window.requestIdleCallback
    ? requestIdleCallback(preload, { timeout: IDLE_TIMEOUT_MS })
    : setTimeout(preload, NO_IDLE_DELAY_MS));
  if (document.readyState === 'complete') idle();
  else addEventListener('load', idle, { once: true });
}
