// Automatic resolution: dynamic resolution scaling, the console way. The scene renders at a multiple
// (`scale`, 1 = the player's chosen render scale, the ceiling) of the selected upscaling preset, and that
// multiple follows the GPU's measured time per frame toward a budget below the refresh: a steady 60 fps
// needs headroom, not a frame that just fits 16.7 ms. Unreal's dynamic resolution does the same
// (r.DynamicRes.FrameTimeBudget with r.DynamicRes.TargetedGPUHeadRoomPercentage under it, steered on the
// frame's GPU busy time from timestamp queries, r.DynamicRes.MinScreenPercentage as the floor), as do
// Intel's and AMD's DRS write-ups (Intel, "Dynamic Resolution Rendering", 2011; AMD GPUOpen, FidelityFX
// Super Resolution 2 integration: drop the render size while a view is heavy, upscale to the display).
//
// The GPU's time is each drawn frame's busy time (gpu/timing.js busyMs: its passes' timestamps, unioned),
// taken whole-frame only: per-pass times on Apple span neighbouring work (research/apple-metal/KNOWLEDGE.md
// 1.2), the frame's union doesn't. The wall clock can't steer this: vsync rounds every frame to 16.7 or
// 33.3 ms, so 12 ms and 16 ms read the same until frames already drop, and Chrome's Energy Saver holds a
// page at 30 Hz however light it is. Where there are no timestamps (no timestamp-query, or they stop
// landing) the older wall-clock trials steer instead: a step is kept only if the frame time moves, so a
// refresh-rate cap doesn't drive the scale down.
//
// Cost per frame ≈ fixed + per-pixel × scale² (physics, light and shadows don't scale with the pixels, the
// march and shading do: ~half of the Lab's 13 ms on the M5). Steps are sized with that line, fitted
// through the current level's time and the level just left (both of the same view, seconds apart); without
// a fit, all of it is taken to scale. Down: at once to the level the line says fits the aim. Up: after a
// second of headroom, to the highest level predicted to fit with room (UP_FIT), the level's slower frames
// included. A step that misses comes straight back down and refits from fresher points, so it can't
// oscillate: the next step up is predicted from the level it failed at.
// The scale moves in a few fixed levels: each change reallocates the scene's targets (post.js setSize,
// the world march's G-buffer), so a level holds until a frame really needs another.
export const AUTO_RES = {
  // ---- steering on GPU time
  TARGET_MS: 12,      // the GPU budget a frame: 60 fps (16.7 ms) with ~28% headroom for spikes (the user's rule: a steady 60 is ≤ 12 ms)
  AIM: 0.9,           // a step down aims at this × the target: inside the band, not on its edge
  UP_FIT: 0.9,        // a step up only to a level predicted (every pixel scaling) at this × the target or under: hysteresis
  DOWN_FRAMES: 8,     // the median of a level's latest this many frames over the target: step down (5 of 8 slow: a hitch of a
                      // few frames, a compile or a teleport's first frames, doesn't; ~0.13 s at 60 fps, ~0.35 s at 22)
  FIT_FOR: 5,         // s a left level's time stays good for fitting the cost line (older: the view has likely changed)
  UP_SECONDS: 1,      // s at a level with headroom before a step up (Unreal amortises increases, decreases are immediate)
  UP_MIN_FRAMES: 12,  // ...over at least this many frames
  UP_PCT: 0.9,        // the step up reads this percentile of the level's frames (a rare spike doesn't block it, a regular one does)
  UP_LEVELS: 4,       // at most this many levels a step up: the floor back to full in two steps
  KEPT: 120,          // frames kept per level (2 s at 60 fps)
  MIN: 0.5,           // the lowest multiple of the selected scale: Quality's 1/1.5 × 0.5 = 1/3 per axis, FSR 2's Ultra
                      // Performance, the lowest ratio its upscaler is made for (post.js UPSCALE_FLOOR holds every preset there)
  LEVELS: 8,          // levels from 1 down to MIN, equal in pixels: MIN^(1/LEVELS) ≈ 0.917 per axis, 16% fewer pixels a level
  STALE: 1,           // s since the last GPU time landed past which the wall-clock trials steer (no timestamps, a pool missing)
  TRUST: 1.25,        // GPU busy time past this × the frame interval can't be sustained: broken timestamps, not load (as profileReport.js SUM_OVER_INTERVAL)
  SUSPECT_FOR: 1,     // s that GPU times may disagree with the frame interval before they count as broken (a view turning heavy
                      // shows in the interval a few frames after its timestamps: frames in flight); no step is taken meanwhile
  DISTRUST_HOLD: 30,  // s the wall clock steers after timestamps were found broken, before they are tried again
  DRAWN_KEPT: 64,     // drawn frames remembered while their timestamps are in flight (they land 1–3 frames later)
  LOG_KEPT: 16,       // recent changes kept for the profiler's report
  // ---- the wall-clock fallback: frame-time trials (a capped 30 Hz page can regain detail too; failed trials back off)
  WINDOW: 1.2,        // s of frames averaged per measurement
  BUDGET: 1 / 50,     // s: a slower average frame tries a lower scale
  DOWN: 0.85,         // scale × this per step down…
  UP: 1.08,           // …and × this per step back up
  KEEP: 0.93,         // a step is kept only if the frame time moves by this ratio
  WALL_MIN: 0.6,      // lowest multiple the wall clock may take (it can't see what a step buys)
  HOLD: 15,           // s between trials…
  MAX_HOLD: 120,      // …doubling after each failed one, up to this
};

const median = (a) => percentile(a, 0.5);
function percentile(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/** The scale of level `k` (0: full, AUTO_RES.LEVELS: AUTO_RES.MIN). */
export const levelScale = (k) => (k <= 0 ? 1 : AUTO_RES.MIN ** (k / AUTO_RES.LEVELS));
/** The level nearest `scale`. */
export const levelOf = (scale) => Math.max(0, Math.min(AUTO_RES.LEVELS,
  Math.round(AUTO_RES.LEVELS * Math.log(Math.min(1, Math.max(AUTO_RES.MIN, scale))) / Math.log(AUTO_RES.MIN))));

/**
 * The app calls drawn(frame) for every frame that drew the view at TAA (the frame number it lands with:
 * gpu.frameNo + 1 before gpu.endFrame), gpu(frame, ms, now) as each frame's GPU busy time lands, and
 * update(dt, now) once a drawn tick (dt: the wall frame interval, s). `scale` is the multiple to render at.
 */
export function createAutoResolution() {
  const A = AUTO_RES;
  // wall-clock trials
  let time = 0, frames = 0, trial = null, resting = false;
  let downAt = 0, upAt = A.HOLD, downHold = A.HOLD, upHold = A.HOLD;
  // GPU steering: the level's generation (every change starts a new one), the drawn frames' generations,
  // the level's frames' GPU ms, and the recent wall intervals (ms) to tell broken timestamps from load
  // left: the level last left, { scale, ms (its recent median), at }, for the cost line; log: recent changes
  let gen = 0, levelSince = 0, lastGpuAt = -Infinity, distrustUntil = -Infinity, suspectSince = null, seen = 1, steering = 'wall';
  let left = null;
  const drawnGen = new Map(), samples = [], walls = [], log = [];
  const startLevel = (now) => { gen++; samples.length = 0; levelSince = now; seen = auto.scale; };
  // a GPU step: remember the level left (when measured) and why
  const step = (k, now, ms, why) => {
    left = samples.length >= A.DOWN_FRAMES ? { scale: auto.scale, ms: median(samples.slice(-A.DOWN_FRAMES)), at: now } : null;
    log.push({ at: +now.toFixed(2), from: +auto.scale.toFixed(3), to: +levelScale(k).toFixed(3), ms: +ms.toFixed(2), why });
    if (log.length > A.LOG_KEPT) log.shift();
    auto.scale = levelScale(k);
    startLevel(now);
  };
  // the cost line through the current level (median `ms`) and the level left: { fixed, perPixel } per scale²
  const line = (ms, now) => {
    const s2 = auto.scale ** 2, all = { fixed: 0, perPixel: ms / s2 };
    if (!left || now - left.at > A.FIT_FOR || Math.abs(left.scale - auto.scale) < 1e-9) return all;
    const perPixel = (ms - left.ms) / (s2 - left.scale ** 2), fixed = ms - perPixel * s2;
    return perPixel > 0 && fixed >= 0 ? { fixed, perPixel } : all;
  };
  const resetTrials = () => { time = frames = 0; trial = null; };
  const auto = {
    enabled: true, // tools disable adaptation for stable timings (freeze current scale)
    scale: 1,
    /** 'gpu' while GPU times steer, else 'wall' (the profiler's and tools' view). */
    get steering() { return steering; },
    /** The current level's GPU ms (median of its kept frames), or null. */
    get gpuMs() { return median(samples); },
    /** Recent GPU-steered changes: { at (s), from, to, ms, why } (the profiler's report). */
    get changes() { return log.slice(); },
    // Finish a still at selected quality, without measuring its settling frames
    // and degrading again. Only outside input/state changes release this lock.
    recover(now) {
      if (!auto.enabled || resting) return false;
      resting = true;
      resetTrials();
      upAt = now + A.HOLD;
      const changed = auto.scale !== 1;
      auto.scale = 1;
      startLevel(now);
      return changed;
    },
    wake() { resting = false; },
    /** Frame `frame` drew the view at the current scale. */
    drawn(frame) {
      drawnGen.set(frame, gen);
      if (drawnGen.size > A.DRAWN_KEPT) drawnGen.delete(drawnGen.keys().next().value);
    },
    /** Frame `frame`'s GPU busy time landed, `ms`; counted when it drew the view at the current level. */
    gpu(frame, ms, now) {
      const g = drawnGen.get(frame);
      drawnGen.delete(frame);
      if (!auto.enabled || resting || !Number.isFinite(ms) || ms < 0) return;
      lastGpuAt = now;
      if (g !== gen || auto.scale !== seen) return;
      samples.push(ms);
      if (samples.length > A.KEPT) samples.shift();
    },
    update(dt, now) {
      if (!auto.enabled || resting) { resetTrials(); return; }
      walls.push(dt * 1000);
      if (walls.length > A.DOWN_FRAMES) walls.shift();
      if (auto.scale !== seen) startLevel(now);   // (a tool set the scale)
      const gpuOn = now - lastGpuAt <= A.STALE && now >= distrustUntil;
      if (gpuOn !== (steering === 'gpu')) {
        steering = gpuOn ? 'gpu' : 'wall';
        resetTrials();
        if (gpuOn) { auto.scale = levelScale(levelOf(auto.scale)); startLevel(now); }
        else downAt = Math.max(downAt, now + A.WINDOW);
      }
      if (gpuOn) steerGpu(now); else wallTrials(dt, now);
    },
  };

  function steerGpu(now) {
    if (samples.length < A.DOWN_FRAMES) return;
    const level = levelOf(auto.scale);
    const recent = median(samples.slice(-A.DOWN_FRAMES));
    // a GPU frame longer than the frame interval can't go on: if that lasts, the timestamps are broken
    // (Metal's origins jumping between submissions), not the view heavy, and the wall clock steers for a while
    if (walls.length >= A.DOWN_FRAMES && recent > A.TRUST * median(walls)) {
      suspectSince ??= now;
      if (now - suspectSince >= A.SUSPECT_FOR) { distrustUntil = now + A.DISTRUST_HOLD; suspectSince = null; }
      return;
    }
    suspectSince = null;
    if (recent > A.TARGET_MS) {
      if (level >= A.LEVELS) return;
      // the scale whose cost on the line meets the aim (none: the floor)
      const { fixed, perPixel } = line(recent, now);
      const room = A.TARGET_MS * A.AIM - fixed;
      const want = room > 0 ? Math.sqrt(room / perPixel) : 0;
      const k = Math.min(A.LEVELS, Math.max(level + 1, Math.ceil(A.LEVELS * Math.log(Math.max(A.MIN, want)) / Math.log(A.MIN) - 1e-9)));
      step(k, now, recent, 'over');
      return;
    }
    if (level === 0 || now - levelSince < A.UP_SECONDS || samples.length < A.UP_MIN_FRAMES) return;
    const mid = median(samples), slow = percentile(samples, A.UP_PCT);
    const { fixed, perPixel } = line(mid, now);
    let k = level;
    for (let j = level - 1; j >= Math.max(0, level - A.UP_LEVELS); j--) {
      // (the level's spread above its median rides along: a view with regular slow frames keeps its room)
      if (fixed + perPixel * levelScale(j) ** 2 + (slow - mid) <= A.TARGET_MS * A.UP_FIT) k = j; else break;
    }
    if (k === level) return;
    step(k, now, slow, 'headroom');
  }

  function wallTrials(dt, now) {
    const { WINDOW, BUDGET, DOWN, UP, KEEP, WALL_MIN, HOLD, MAX_HOLD } = A;
    time += dt; frames++;
    if (time < WINDOW) return;
    const avg = time / frames;
    time = frames = 0;
    if (trial) {
      const { scale, baseline, up } = trial;
      const accepted = up ? avg <= baseline / KEEP : avg <= baseline * KEEP;
      if (!accepted) auto.scale = scale;
      if (up) {
        upAt = now + (accepted ? WINDOW : upHold);
        upHold = accepted ? HOLD : Math.min(MAX_HOLD, upHold * 2);
        // Don't immediately undo a successful recovery at a refresh-rate cap.
        downAt = Math.max(downAt, now + HOLD);
      } else {
        downAt = now + (accepted ? 0 : downHold);
        downHold = accepted ? HOLD : Math.min(MAX_HOLD, downHold * 2);
        upAt = Math.max(upAt, now + HOLD);
      }
      trial = null;
      seen = auto.scale;
      return;
    }
    const up = auto.scale < 1 && now >= upAt;
    if (up || (avg > BUDGET && auto.scale > WALL_MIN && now >= downAt)) {
      trial = { scale: auto.scale, baseline: avg, up };
      auto.scale = up ? Math.min(1, auto.scale * UP) : Math.max(WALL_MIN, auto.scale * DOWN);
      seen = auto.scale;
    }
  }
  return auto;
}
