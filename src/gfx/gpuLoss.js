// Tell a dead GPU process from a broken shader, and say what it was doing.
//
// When Chrome's GPU process dies (its watchdog kills a GPU main thread stuck
// on one task for too long: exit code 512 in chrome://gpu, the raw wait status
// of exit(2), RESULT_CODE_HUNG), the page isn't told at once. Until the
// webglcontextlost event a task later, isContextLost() is still false, and the
// first program whose link status is asked for reads LINK_STATUS false with
// empty logs (tools/gpu-process-loss-check.mjs kills a real GPU process to
// show it). three.js calls that a shader error, so whichever program happened
// to be linked next (the bird probe, on the first frame after boot) took the
// blame. A real link failure always has text: ANGLE's translator and the
// Metal compiler both say what broke.
//
// The program that hung the GPU is one whose first draw was issued since the
// last frame that finished (on ANGLE/Metal the first draw builds the pipeline
// and blocks the GPU main thread for the whole build: tools/program-bench.mjs).
// So the tracker remembers the programs that existed when the last frame
// finished, and a failure report names the ones made since and how long the
// page waited.

const STORE = 'powder-toy-3d:lastGpuFailure';

// true: the link "failure" carries no text at all, the signature of a lost GPU process
export function silentLinkFailure(gl, program, vertex, fragment) {
  return ![gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].some(Boolean);
}

export function createGpuLossTracker(renderer) {
  let settled = new Set(), settledAt = performance.now();
  return {
    // after each frame (and boot) completes: its programs are built
    settle() {
      settled = new Set(renderer.info.programs);
      settledAt = performance.now();
    },
    // what the page was doing when it failed: programs first used since the
    // last settled frame (their pipelines may still have been building) and
    // the ms since then (a GPU hang shows as a long wait)
    snapshot() {
      return {
        msSinceLastFrame: Math.round(performance.now() - settledAt),
        newPrograms: renderer.info.programs.filter((p) => !settled.has(p)).map((p) => p.name || 'unnamed'),
      };
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
export function lossDetails({ msSinceLastFrame, newPrograms }) {
  return `The page had waited ${(msSinceLastFrame / 1000).toFixed(1)} s since the last finished frame.\n`
    + `Programs first used in that time: ${newPrograms.join(', ') || 'none'}.\n`
    + 'A long wait points to a GPU hang (e.g. a cold shader pipeline build) that Chrome stopped.';
}

// The message for a link failure with no text: not that shader's fault.
export const processLossMessage = (name, seen) =>
  `The GPU process stopped responding (seen while linking ${name}; that shader is not the cause).\n${lossDetails(seen)}`;
