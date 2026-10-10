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

// Frames until a blend stored in 8 bits (the field EMA's RGBA8 targets) stops
// changing: within this many blends toward a fixed target, from any stored
// value, it reaches a value the next blend rounds back to, so skipping the
// blend from then on changes nothing. Rounding can stall it a step short of
// settleFrames' tolerance (w = 0.5 takes 9 frames, not 8). Found by running the
// blend in float32 from both ends (the slowest starts: a blend that rounds is
// still monotone, so a start nearer the target never takes longer) toward
// every target on a half-step grid, with GLSL mix in either of its usual forms
// and float→unorm ties rounded up or to even.
const U8_MAX = 255;
const HALF_STEPS = 2 * U8_MAX;   // target grid: every half step of 8 bits
const BLEND_ITER_MAX = 4096;     // a blend that hasn't stopped by then is a bug (w <= 0)
export function blendFixedFrames(w) {
  const f = Math.fround;
  const wf = f(w), keep = f(1 - wf);
  const toU8 = [
    (x) => Math.floor(f(Math.min(Math.max(x, 0), 1) * U8_MAX) + 0.5),
    (x) => { const v = f(Math.min(Math.max(x, 0), 1) * U8_MAX); return v - Math.floor(v) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v); },
  ];
  const mixes = [(x, y) => f(f(x * keep) + f(y * wf)), (x, y) => f(x + f(wf * f(y - x)))];
  let frames = 0;
  for (let k = 0; k <= HALF_STEPS; k++) {
    const target = f(k / HALF_STEPS);
    for (const q of toU8) for (const mix of mixes) for (const start of [0, U8_MAX]) {
      let v = start;
      for (let n = 1; ; n++) {
        const next = q(mix(f(v / U8_MAX), target));
        if (n > 1 && next === v) { frames = Math.max(frames, n - 1); break; }
        if (n > BLEND_ITER_MAX) throw new Error(`blend weight ${w} never settles`);
        v = next;
      }
    }
  }
  return frames;
}

// viewSettle: a frame count, or a function returning one (it may change at run time).
export function createPacer({ derivedSettle, viewSettle, presentHz = MAX_FPS }) {
  const viewFrames = typeof viewSettle === 'function' ? viewSettle : () => viewSettle;
  let last = -Infinity, lastPresent = -Infinity;
  let derivedKey = null, viewKey = null;
  let derivedLeft = 0, viewLeft = 0;
  return {
    // Is a frame due at rAF time `now` (ms)?
    due(now) {
      if (now - last < FRAME_EARLY * MS_PER_S / MAX_FPS) return false;
      last = now;
      return true;
    },
    // Presentation can run less often without slowing physics or consuming
    // the temporal filters' convergence counts on skipped presentations.
    present(now, force = false) {
      if (!force && now - lastPresent < FRAME_EARLY * MS_PER_S / presentHz) return false;
      lastPresent = now;
      return true;
    },
    get settled() { return derivedLeft <= 0 && viewLeft <= 0; },
    get settleLimit() { return derivedSettle + viewFrames() + 4; },
    // Run the derived passes this frame? key: everything they depend on.
    derived(key) {
      if (key !== derivedKey) { derivedKey = key; derivedLeft = derivedSettle; }
      if (derivedLeft <= 0) return false;
      derivedLeft--;
      return true;
    },
    // Render the view this frame? force: something it reads changed this frame.
    view(key, force) {
      if (key !== viewKey || force) { viewKey = key; viewLeft = viewFrames(); }
      if (viewLeft <= 0) return false;
      viewLeft--;
      return true;
    },
    // Input or an outside change: render until settled again.
    wake() { viewLeft = viewFrames(); },
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

// A browser that holds the page at 30 Hz (Chrome's Energy Saver throttles every
// page to 30 Hz, Safari's Low Power Mode does the same) looks like slow
// rendering. Idle frames draw nothing and cost almost no CPU, so when the rAF
// callbacks after them still come at that rate the cap is the browser's, not
// the app's. feed() takes each rAF time and whether the frame before it was
// idle (drew nothing, ran under CAP_IDLE_MS); it returns true once, when
// CAP_SAMPLES idle gaps in a row average CAPPED_HZ.
const CAPPED_HZ = 30;
const CAP_TOLERANCE_HZ = 2;
const CAP_SAMPLES = 60;          // 2 s at the cap
export const CAP_IDLE_MS = 5;    // a frame slower than this could be holding the rate down itself
export function createCapCheck() {
  let prev = null, sum = 0, n = 0, told = false;
  return {
    feed(now, prevIdle) {
      const gap = prev == null ? null : now - prev;
      prev = now;
      if (told || gap == null) return false;
      if (!prevIdle) { sum = 0; n = 0; return false; }
      sum += gap; n++;
      if (n < CAP_SAMPLES) return false;
      const hz = n * MS_PER_S / sum;
      sum = 0; n = 0;
      told = Math.abs(hz - CAPPED_HZ) <= CAP_TOLERANCE_HZ;
      return told;
    },
  };
}
