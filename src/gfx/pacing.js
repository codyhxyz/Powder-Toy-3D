// Frame pacing, for performance per watt.
//
// Frames are spaced at least 1/MAX_FPS apart: on a 120 Hz display every frame
// would otherwise cost twice (and the simulation, which steps per frame, would
// run at double speed).
//
// Rendering is on demand. The per-frame work is split by what it depends on:
//   derived  the passes rebuilt from the simulation state: render fields,
//            bricks, glow volume, sun shadow map, GI probes. They rerun when
//            their key changes (state version, sun, the settings they read),
//            then for derivedSettle more frames while their temporal filters
//            (field EMA, GI blend) converge.
//   view     the raymarch and post. It reruns when its key changes (camera,
//            canvas, scene objects, settings), when the derived passes ran, or
//            on input, then for viewSettle more frames while TAA converges.
// With nothing changing a frame costs a few comparisons and no GPU work; the
// canvas keeps showing its last image.

export const MAX_FPS = 60;
// rAF timestamps jitter around the display interval: a frame this fraction of
// the interval early still counts as due.
const FRAME_EARLY = 0.9;
const MS_PER_S = 1000;
// One 8-bit step: as fine as the screen and the 8-bit field textures resolve.
const SETTLE_TOLERANCE = 1 / 255;

// Frames until an exponential blend toward a fixed target (new-sample weight
// w, applied every `every` frames) is within SETTLE_TOLERANCE of it.
export const settleFrames = (w, every = 1) => every * Math.ceil(Math.log(SETTLE_TOLERANCE) / Math.log(1 - w));

export function createPacer({ derivedSettle, viewSettle }) {
  let last = -Infinity;
  let derivedKey = null, viewKey = null;
  let derivedLeft = 0, viewLeft = 0;
  return {
    // Is a frame due at rAF time `now` (ms)?
    due(now) {
      if (now - last < FRAME_EARLY * MS_PER_S / MAX_FPS) return false;
      last = now;
      return true;
    },
    // Run the derived passes this frame? key: everything they depend on.
    derived(key) {
      if (key !== derivedKey) { derivedKey = key; derivedLeft = derivedSettle; }
      if (derivedLeft <= 0) return false;
      derivedLeft--;
      return true;
    },
    // Render the view this frame? force: something it reads changed this frame.
    view(key, force) {
      if (key !== viewKey || force) { viewKey = key; viewLeft = viewSettle; }
      if (viewLeft <= 0) return false;
      viewLeft--;
      return true;
    },
    // Input or an outside change: render until settled again.
    wake() { viewLeft = viewSettle; },
  };
}

// Identity of what the scene's objects currently look like (visible ones and
// their world transforms), for the view key.
export function sceneKey(scene) {
  scene.updateMatrixWorld();
  const parts = [];
  scene.traverseVisible((o) => { parts.push(o.id, ...o.matrixWorld.elements); });
  return parts.join(',');
}
