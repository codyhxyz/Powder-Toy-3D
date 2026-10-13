// Say what the page was doing when its GPU work stopped (docs/webgpu.md B9).
//
// WebGPU tells the page itself: the device's `lost` promise resolves with a
// reason ('destroyed', or 'unknown' when the GPU process died: Chrome's
// watchdog kills a GPU main thread stuck on one task for too long, exit code
// 512 in chrome://gpu, the raw wait status of exit(2), RESULT_CODE_HUNG), and
// an uncaptured error or a pipeline that didn't build arrives with its own
// text (src/gpu/errors.js). So a dead GPU process can no longer pass for a
// broken shader, as it did under WebGL, where the first program linked after
// the death read LINK_STATUS false with empty logs. What stays from that
// tracker is the report: the failure's kind and text, how long the page had
// waited since its last finished frame, and the pipelines still building
// then (a cold build is what most often holds a GPU process long enough to be
// killed), kept across a reload for the bug report (__app.lastGpuFailure;
// tools/gpu-process-loss-check.mjs kills a real GPU process to check it). A
// settled page stops its frame loop (deep idle, docs/webgpu.md F7), so a long
// wait can also be a page with nothing to draw: the report says which.

const STORE = 'powder-toy-3d:lastGpuFailure';

/**
 * The kind of a GraphicsFailure's message (gpu/errors.js formats):
 * 'deviceLost', 'shaderFailed' or 'gpuError'.
 * @param {string} message
 */
export function failureKind(message) {
  if (/lost the WebGPU device/.test(message)) return 'deviceLost';
  if (/^GPU shader failed/.test(message)) return 'shaderFailed';
  return 'gpuError';
}

/**
 * Watches `gpu`'s pipeline builds (their names, while they build) and the
 * app's finished frames.
 * @param {object} gpu
 */
export function createGpuLossTracker(gpu) {
  let settledAt = performance.now();
  let asleep = false;            // the frame loop stopped with nothing to do since the last frame
  const building = new Map();   // pipeline name → builds of it in flight
  const cache = gpu.pipelines;
  const pipeline = cache.pipeline.bind(cache);
  cache.pipeline = (kind, name, ...rest) => {
    const p = pipeline(kind, name, ...rest);
    if (!building.has(p)) {
      building.set(p, name);
      p.then(() => building.delete(p), () => building.delete(p));
    }
    return p;
  };
  return {
    // after each frame (and boot) completes
    settle() { settledAt = performance.now(); asleep = false; },
    // after the frame that stopped the loop because the page had settled
    // (deep idle): the wait from here on is sleep, not a hang
    sleep() { asleep = true; },
    // what the page was doing when it failed: the ms since the last finished
    // frame (a GPU hang shows as a long wait, unless the loop was asleep) and
    // the pipelines building then
    snapshot() {
      return { msSinceLastFrame: Math.round(performance.now() - settledAt), asleep, pendingPipelines: [...new Set(building.values())] };
    },
    // kept across a reload, for the bug report (__app.lastGpuFailure)
    record(report) {
      try { localStorage.setItem(STORE, JSON.stringify({ at: new Date().toISOString(), ua: navigator.userAgent, ...report })); } catch { /* storage unavailable */ }
    },
    get last() {
      try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
    },
  };
}

// What the page had been waiting on (a snapshot()), as lines for a message.
export function lossDetails({ msSinceLastFrame, asleep = false, pendingPipelines }) {
  const s = (msSinceLastFrame / 1000).toFixed(1);
  if (asleep && !pendingPipelines.length) return `The scene had settled: nothing was drawn for ${s} s before it, and nothing was building.`;
  return `The page had waited ${s} s since the last finished frame${asleep ? ' (the scene had settled: nothing to draw)' : ''}.\n`
    + `Pipelines still building then: ${pendingPipelines.join(', ') || 'none'}.\n`
    + 'A long wait points to a GPU hang (e.g. a cold pipeline build) that the browser stopped.';
}
