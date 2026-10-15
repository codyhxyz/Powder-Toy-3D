export const SOURCE_MANIFEST_BUDGET_MS = 10000;

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
