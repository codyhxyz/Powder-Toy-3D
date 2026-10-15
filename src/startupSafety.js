import { GraphicsFailure } from './gpu/errors.js';
import { VIEWS, viewForMode } from './views.js';

// This bounds the loading screen, not native driver execution. JavaScript
// cannot interrupt a graphics compiler or recover a browser-wide GPU crash.
export const STARTUP_BUDGET_MS = 45000;
export const GPU_SAFE_PARAM = 'gpuSafe';
export const SOURCE_MANIFEST_BUDGET_MS = 10000;

export const gpuSafeMode = (search = globalThis.location?.search ?? '') =>
  new URLSearchParams(search).get(GPU_SAFE_PARAM) === '1';

export const startupView = (mode, fallback, search, map = null) => gpuSafeMode(search)
  ? VIEWS.find(view => view.key === 'plain').id : viewForMode(mode, fallback, map);

// Optional map metadata must not hold the entry module forever. Abort fetches
// and prevent a late module download from registering maps after menu setup.
export async function loadSourceMapManifests(load, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(load).then(module => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return module.installLocalCrueltyMaps({ signal: controller.signal });
      }),
      new Promise((_, reject) => {
        timer = setTimer(() => {
          const error = new Error('Source map details did not load within 10 seconds.');
          controller.abort(error);
          reject(error);
        }, SOURCE_MANIFEST_BUDGET_MS);
      }),
    ]);
  } finally { clearTimer(timer); }
}

export function startupDeadline(onTimeout, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let active = true;
  const timer = setTimer(() => {
    if (!active) return;
    active = false;
    onTimeout(new GraphicsFailure(
      'Game startup exceeded 45 seconds. No more graphics work will be started.\n'
      + 'Work already inside the browser or graphics driver cannot be cancelled by this page.',
    ));
  }, STARTUP_BUDGET_MS);
  return () => {
    if (!active) return;
    active = false;
    clearTimer(timer);
  };
}

// An explicit user action, never an automatic retry loop. Preserve the map
// and mode, but use ordinary element art and the Plain view on the next page.
export function safeStartupHref(href, { map, mode } = {}) {
  const url = new URL(href);
  if (map) url.searchParams.set('map', map);
  if (mode) url.searchParams.set('mode', mode);
  url.searchParams.set(GPU_SAFE_PARAM, '1');
  url.searchParams.set('view', 'plain');
  url.searchParams.delete('__boot_retry');
  return url.href;
}
