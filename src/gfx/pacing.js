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
//            on input, then for viewSettle more frames while TAA converges
//            (at most TAA_SETTLE_FRAMES).
//            While only three's meshes move (wakeMeshes, or the key's scene
//            objects alone), app.js draws mesh-only frames (gfx/meshFrames.js):
//            the volume's scene kept, the meshes and post drawn again.
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

// The view's settle is TAA's, and it ends here: at most this many frames after
// the view's last change. Three's TAAU (gfx/post.js) blends 0.025 of each frame
// into its history, so coming within one 8-bit step of a still view's converged
// picture would take settleFrames(0.025) = 219 frames, 3.6 s of full-rate GPU
// work after every touch of the camera. Its picture in motion is already
// anti-aliased, if a little softer than a long-still one; these frames add
// eight of the jitter's sub-pixel offsets to a view that has just stopped,
// then the GPU rests. (A view whose history was just dropped, a jump or a
// reset, stays rougher until it changes again.)
export const TAA_SETTLE_FRAMES = 8;

// derivedSettle/viewSettle: a frame count, or a function returning one.
// The view count may change at run time and is
// at most TAA_SETTLE_FRAMES.
// onWake: called by wake(), so a loop that stopped (createFrameLoop) starts again.
export function createPacer({ derivedSettle, viewSettle, presentHz = MAX_FPS, onWake = null }) {
  const derivedFrames = typeof derivedSettle === 'function' ? derivedSettle : () => derivedSettle;
  const viewFramesOf = typeof viewSettle === 'function' ? viewSettle : () => viewSettle;
  const viewFrames = () => Math.min(TAA_SETTLE_FRAMES, viewFramesOf());
  let last = -Infinity, lastPresent = -Infinity;
  let derivedKey = null, viewKey = null;
  let derivedLeft = 0, viewLeft = 0;
  let wakes = 0, meshWake = false;
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
    get settleLimit() { return derivedFrames() + viewFrames() + 4; },
    /** Frames the view renders after a change until it has settled (TAA converged). */
    get viewSettle() { return viewFrames(); },
    // Run the derived passes this frame? key: everything they depend on.
    derived(key) {
      if (key !== derivedKey) { derivedKey = key; derivedLeft = derivedFrames(); }
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
    wake() { viewLeft = viewFrames(); wakes++; onWake?.(); },
    // Only three's meshes moved: render until settled
    // again, and what the volume and our other passes draw still holds
    // (app.js's mesh-only frames, gfx/meshFrames.js).
    wakeMeshes() { viewLeft = viewFrames(); meshWake = true; onWake?.(); },
    /** wake() calls so far: anything outside the view key may have changed what the volume draws. */
    get wakes() { return wakes; },
    /** Whether wakeMeshes() was called since the last call; clears it. */
    takeMeshWake() { const w = meshWake; meshWake = false; return w; },
  };
}

// Deep idle (docs/webgpu.md F7): the requestAnimationFrame loop that stops
// itself. frame(now) returns false when there is nothing left to do (the view
// settled, the simulation idle or paused, nothing pending or animating); then
// no callback is scheduled after it, and a settled page costs no CPU at all.
// wake() schedules one again (pacer.wake through onWake, input listeners,
// resize, a resolving readback or pipeline); it is idempotent, and a wake
// during frame() keeps the loop running. A frame that throws keeps it running
// too, as the old loop re-requested before anything else.
export function createFrameLoop(frame, { raf = (fn) => requestAnimationFrame(fn) } = {}) {
  let scheduled = false;
  const run = (now) => {
    scheduled = false;
    let keep = true;
    try { keep = frame(now) !== false; } finally { if (keep) request(); }
  };
  function request() {
    if (scheduled) return;
    scheduled = true;
    raf(run);
  }
  return {
    /** No callback is scheduled: the loop sleeps until wake(). */
    get asleep() { return !scheduled; },
    start: request,
    wake: request,
  };
}

// The view's key, without building it. It used to be one string of the camera,
// the canvas, JSON of the settings objects, every visible object's id and
// matrixWorld (sceneKey below), and the far field's progress, built every
// presentable tick; this compares each input with what the last call saw and
// returns a number that changes exactly when that string would have
// (tools/pacing-check.mjs checks it against the string over recorded inputs).
//
//   const viewKey = createViewKey({ still: [volume, floorGrid] });
//   pacer.view(viewKey(camera, scene, pixelRatio, innerWidth, innerHeight,
//     win?.far?.chunksDrawn, settings, gfx, post.settings), force);
//   viewKey.still   // a second counter: changes with all of it but three's meshes
//
// still: the scene objects whose world transforms our own passes draw with
// (the volume's place, the floor grid's). viewKey.still changes when the
// camera, the canvas, `extra`, the settings objects or one of those changes
// (or one shows or hides), and not when only the other scene objects (three's
// meshes) move: app.js's mesh-only frames keep the scene the volume drew while
// it holds (gfx/meshFrames.js).
const MAT4 = 16;
const OBJECT_SLOT = 1 + MAT4;   // id, matrixWorld
const STILL_SLOT = 1 + MAT4;    // visible, matrixWorld
export function createViewKey({ still = [] } = {}) {
  let version = 0, stillVersion = 0, primed = false;
  const stillSeen = new Float64Array(still.length * STILL_SLOT).fill(NaN);
  const cameraSeen = new Float64Array(2 * MAT4);
  const scalars = [], objects = [];
  const sceneChanged = createSceneWatch();
  const scalar = (i, v) => { const same = sameText(v, scalars[i]); scalars[i] = v; return !same; };
  const object = (i, o) => {
    const v = jsonValue(o, '');
    if (sameJSONEntry(v, objects[i])) return false;
    objects[i] = jsonCopy(v);
    return true;
  };
  const key = (camera, scene, pixelRatio, width, height, extra, a, b, c) => {
    let changed = !primed;
    primed = true;
    // (in the old string's order: the camera is read before the scene's world
    // matrices are brought up to date, which moves it when it's in the scene)
    if (storeNumbers(camera.matrixWorld.elements, cameraSeen, 0) | storeNumbers(camera.projectionMatrix.elements, cameraSeen, MAT4)) changed = true;
    if (scalar(0, pixelRatio) | scalar(1, width) | scalar(2, height) | scalar(3, extra)) changed = true;
    if (object(0, a) | object(1, b) | object(2, c)) changed = true;
    let stillChanged = changed;   // (all of that is what our passes draw with)
    if (sceneChanged(scene)) changed = true;
    // (after the scene watch: it brought the world matrices up to date)
    for (let i = 0; i < still.length; i++) {
      const o = still[i], at = i * STILL_SLOT, shown = o.visible ? 1 : 0;
      if (stillSeen[at] !== shown) { stillSeen[at] = shown; stillChanged = true; }
      if (storeNumbers(o.matrixWorld.elements, stillSeen, at + 1)) stillChanged = true;
    }
    if (changed) version++;
    if (stillChanged) stillVersion++;
    return version;
  };
  Object.defineProperty(key, 'still', { get: () => stillVersion });
  return key;
}

// Equal as `${x}` would print them: 0 and -0 alike, NaN equal to NaN.
const sameNumber = (x, y) => x === y || (x !== x && y !== y);
const sameText = (x, y) => x === y
  || (typeof x === 'number' && typeof y === 'number' ? x !== x && y !== y : String(x) === String(y));

// Stores `values` at cache[at...]: did any differ (as text)? (It checks them
// all: the cache always ends up holding the new values.)
function storeNumbers(values, cache, at) {
  let changed = false;
  for (let i = 0; i < values.length; i++) {
    if (!sameNumber(values[i], cache[at + i])) { changed = true; cache[at + i] = values[i]; }
  }
  return changed;
}

// Did the visible objects (in traversal order) or their world transforms change?
function createSceneWatch() {
  let cache = new Float64Array(OBJECT_SLOT * 256), count = 0, n = 0, changed = false;
  const visit = (o) => {
    const at = n++ * OBJECT_SLOT;
    if (at + OBJECT_SLOT > cache.length) {
      const grown = new Float64Array(cache.length * 2);
      grown.set(cache);
      cache = grown;
    }
    // (past the last call's count the cache holds older calls' objects: the
    // count differs then, which marks the change)
    if (cache[at] !== o.id) { changed = true; cache[at] = o.id; }
    if (storeNumbers(o.matrixWorld.elements, cache, at + 1)) changed = true;
  };
  return (scene) => {
    // matrixWorld is only current after this (the renderer would do it when it
    // draws, which a frame that isn't drawn never does)
    scene.updateMatrixWorld();
    n = 0;
    changed = false;
    scene.traverseVisible(visit);
    if (n !== count) changed = true;
    count = n;
    return changed;
  };
}

// JSON.stringify's view of a value (ECMA-262 SerializeJSONProperty): a
// primitive, OMIT (left out of an object, null in an array), or an object to
// serialise field by field.
const OMIT = Symbol('omit');
function jsonValue(v, key) {
  const type = typeof v;
  if ((type === 'object' && v !== null || type === 'function' || type === 'bigint') && typeof v.toJSON === 'function') v = v.toJSON(String(key));
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? v : null;
    case 'string': case 'boolean': return v;
    case 'bigint': throw new TypeError('BigInt value can\'t be serialized in JSON');
    case 'object':
      if (v instanceof Number) return jsonValue(Number(v), key);
      if (v instanceof String) return String(v);
      if (v instanceof Boolean) return v.valueOf();
      return v;   // (or null)
    default: return OMIT;   // undefined, a function, a symbol
  }
}
// A snapshot of an object as JSON sees it: { keys (null for an array), vals }.
function jsonCopy(v) {
  if (typeof v !== 'object' || v === null) return v;
  const vals = [];
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const x = jsonValue(v[i], i); vals.push(x === OMIT ? null : jsonCopy(x)); }
    return { keys: null, vals };
  }
  const keys = [];
  for (const k in v) {
    if (!Object.hasOwn(v, k)) continue;
    const x = jsonValue(v[k], k);
    if (x !== OMIT) { keys.push(k); vals.push(jsonCopy(x)); }
  }
  return { keys, vals };
}
function sameJSONEntry(x, copy) {
  if (typeof x !== 'object' || x === null) return x === copy;
  if (typeof copy !== 'object' || copy === null) return false;
  const { keys, vals } = copy;
  if (Array.isArray(x)) {
    if (keys !== null || x.length !== vals.length) return false;
    for (let i = 0; i < x.length; i++) {
      const y = jsonValue(x[i], i);
      if (!sameJSONEntry(y === OMIT ? null : y, vals[i])) return false;
    }
    return true;
  }
  if (keys === null) return false;
  let n = 0;
  for (const k in x) {   // own enumerable keys in JSON.stringify's (Object.keys') order
    if (!Object.hasOwn(x, k)) continue;
    const y = jsonValue(x[k], k);
    if (y === OMIT) continue;
    if (n === keys.length || keys[n] !== k || !sameJSONEntry(y, vals[n])) return false;
    n++;
  }
  return n === keys.length;
}

// Identity of what the scene's objects currently look like (visible ones and
// their world transforms) as a string: the old view key's part, kept for
// app.js until it moves to createViewKey, and the reference
// tools/pacing-check.mjs compares createViewKey with.
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
