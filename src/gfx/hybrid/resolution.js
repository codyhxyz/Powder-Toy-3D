// Pure allocation policy; no GPU resources, timers, simulation or presentation scheduling.
import { AUTO_RES, UPSCALE, UPSCALE_FLOOR } from '../post.js';

const MIN_SAMPLES = 8;
const OVER = 1.1, UNDER = 0.8;
const close = (a, b) => Math.abs(a - b) < 1e-10;
const cost = x => Number.isFinite(x) && x >= 0;

function settings(input) {
  const s = { upscale: UPSCALE.native, floor: UPSCALE_FLOOR, adaptive: null, taa: true, targetHz: 60, ...input };
  s.floor ??= UPSCALE_FLOOR;
  for (const name of ['upscale', 'floor']) {
    if (!(Number.isFinite(s[name]) && s[name] > 0 && s[name] <= 1)) throw new RangeError(`${name} must be in (0, 1]`);
  }
  if (!(Number.isFinite(s.targetHz) && s.targetHz > 0 && Number.isFinite(1000 / s.targetHz))) {
    throw new RangeError('targetHz must yield a finite positive budget');
  }
  return s;
}

/**
 * createHybridResolution({ upscale, floor, adaptive, taa, targetHz = 60 })
 *
 * Pass the EXISTING post settings, not new user quality controls. Scales are
 * per-axis shares of output device pixels (UPSCALE convention). `scales.surface`
 * is the scene scale, `resolutionScale` its multiplier under post.upscale.
 * `scales.media` / `.reflections` are half surface resolution at selected quality;
 * their shared multiplier reduces to AUTO_RES.MIN before opaque surfaces shrink.
 * Native defaults / disabled TAA / disabled adaptation never adapt, matching post.js.
 * The surface floor is max(post.floor, post.upscale * AUTO_RES.MIN), capped at
 * the selected ceiling. targetHz is a budget ONLY, never an FPS/simulation cap.
 *
 * update({ now, dt, sampleId, sampleGeneration, gpuMs?, renderMs?, frameMs?,
 *          capped = false, stable = true, paused = false, idle = false,
 *          rendered = true }) -> allocationChanged
 * now/dt: monotonic seconds / elapsed presentation seconds, NOT sim time.
 * Feed each complete timing once, with an increasing integer sampleId (frame
 * number) and the generation captured when that frame was submitted. Prefer
 * complete GPU render-pass timings (ms, excluding simulation); renderMs is
 * active wall render cost (no pacing, simulation, waits or readback).
 * frameMs remains an accepted argument for compatibility but is NEVER cost:
 * even an uncapped presentation interval may include idle or simulation time.
 * Do NOT submit partial GPU coverage as a complete GPU sample. Missing timings
 * do nothing; an interval alone cannot justify lowering resolution.
 * stable certifies comparable camera/workload across baseline and trial windows;
 * false cancels trials. Paused/idle/nonrendered frames never change allocations.
 * No polling or extra frames are requested by this controller.
 *
 * reset(partialSettings?) -> allocationChanged: invalidate timings/evidence,
 * restore selected detail and unlock adaptation after external activity or a
 * quality/target/workload change, resize, grid replacement or device loss.
 * recover() -> allocationChanged: restore selected detail for ONE final still,
 * then lock until reset(). Call BEFORE parking, not on every idle tick.
 * metrics: snapshot of bounds, samples, trial and measured trial result. A kept
 * reduction means only lower measured cost in comparable windows, NOT a claim
 * of higher presentation FPS. Failed down trials block that stage until reset;
 * this deliberately avoids endless CPU-bound/capped degradation probes.
 *
 * Integration: use instead of (not multiplied by) legacy createAutoResolution
 * for the hybrid path. Apply resolutionScale to post BEFORE sizing its scene;
 * size media/reflection targets from output size * their absolute scales
 * (round and clamp each dimension to >= 1), NOT scene size * absolute scales.
 * Reallocate/invalidate temporal histories only when update/reset/recover returns
 * true; external resize/cut/device resets must invalidate histories regardless
 * of that return value (reset always advances generation). Store generation
 * with each submitted timing. Use actual output texture device dimensions,
 * not CSS size. Measure normal passes without enabling profiler split mode;
 * never sum partial/overlapping coverage or include simulation passes.
 * No GPU resources required.
 */
export function createHybridResolution(options = {}) {
  let config = settings(options);
  let surface, effects, ceiling, minimum, adaptive;
  let generation = 0, resting = false, lastNow = -Infinity, lastId = -1;
  let elapsed = 0, samples = 0, sum = 0, source = null;
  let over = 0, under = 0, trial = null, lastTrial = null;
  let downAt = 0, upAt = 0, upHold = AUTO_RES.HOLD;
  let blocked = { effects: false, surface: false };
  let observedMs = null;
  let acceptedSamples = 0, rejectedSamples = 0, lastRejection = null;
  const reject = reason => { rejectedSamples++; lastRejection = reason; return false; };

  const clearWindow = () => { elapsed = samples = sum = 0; };
  const clearEvidence = () => { clearWindow(); over = under = 0; source = null; };
  const assign = (s, e) => {
    if (close(surface, s) && close(effects, e)) return false;
    surface = s; effects = e; generation++;
    return true;
  };
  const cancelTrial = () => {
    const before = trial?.before;
    trial = null;
    clearEvidence();
    return before ? assign(before.surface, before.effects) : false;
  };
  function reset(partial = {}) {
    config = settings({ ...config, ...partial });
    ceiling = config.taa ? config.upscale : 1;
    adaptive = Boolean(config.taa && (config.adaptive ?? config.upscale < 1));
    minimum = adaptive ? Math.min(ceiling, Math.max(config.floor, ceiling * AUTO_RES.MIN)) : ceiling;
    const changed = assign(ceiling, 1);
    // Even unchanged allocations invalidate samples across workload/device resets.
    if (!changed) generation++;
    resting = false; lastId = -1; lastNow = -Infinity;
    trial = lastTrial = null; observedMs = null;
    acceptedSamples = rejectedSamples = 0; lastRejection = null;
    blocked = { effects: false, surface: false };
    downAt = 0; upAt = AUTO_RES.HOLD; upHold = AUTO_RES.HOLD;
    clearEvidence();
    return changed;
  }
  reset();

  return {
    get generation() { return generation; },
    get resolutionScale() { return surface / ceiling; },
    get scales() { return { surface, media: surface * 0.5 * effects, reflections: surface * 0.5 * effects }; },
    get metrics() {
      return {
        generation, adaptive, resting, source, observedMs,
        budgetMs: 1000 / config.targetHz, ceiling, minimum,
        effectMultiplier: effects, blocked: { ...blocked }, samples,
        surfaceScale: surface, resolutionScale: surface / ceiling,
        targetHz: config.targetHz, acceptedSamples, rejectedSamples, lastRejection,
        overWindows: over, underWindows: under, downAt, upAt,
        trial: trial ? { direction: trial.direction, stage: trial.stage, baselineMs: trial.baseline, source: trial.source } : null,
        lastTrial: lastTrial ? { ...lastTrial } : null,
      };
    },
    reset,
    recover() {
      resting = true; trial = null;
      clearEvidence();
      return assign(ceiling, 1);
    },
    update(frame = {}) {
      if (!frame || typeof frame !== 'object') return reject('malformed-frame');
      const { now, dt, sampleId, sampleGeneration, gpuMs, renderMs,
        stable = true, paused = false, idle = false, rendered = true } = frame;
      if (resting || !adaptive) return false;
      if (paused || idle || !rendered) {
        // Freeze allocations, but don't compare a trial with a post-idle scene.
        if (trial) trial.invalid = true;
        clearEvidence();
        return false;
      }
      if (!(Number.isFinite(now) && now > lastNow && Number.isFinite(dt) && dt > 0)) return reject('invalid-time');
      if (sampleGeneration !== generation) return reject('stale-generation');
      if (!Number.isSafeInteger(sampleId) || sampleId < 0 || sampleId <= lastId) return reject('invalid-sample-id');
      // Late samples from retired allocations cannot invalidate a current trial.
      if (!stable || trial?.invalid) return cancelTrial();
      // Explicit malformed costs must not silently fall back to another source.
      if ((gpuMs !== undefined && !cost(gpuMs)) || (renderMs !== undefined && !cost(renderMs))) {
        return reject('invalid-cost');
      }
      const nextSource = cost(gpuMs) ? 'gpu' : cost(renderMs) ? 'render' : null;
      if (!nextSource) { clearWindow(); over = under = 0; return reject('missing-render-cost'); }
      // A measurement source change is not evidence of an improvement.
      if (source && source !== nextSource) {
        if (trial) return cancelTrial();
        clearEvidence();
      }
      source = nextSource; lastNow = now; lastId = sampleId;
      const ms = source === 'gpu' ? gpuMs : renderMs;
      // Online mean avoids overflow for finite (but very large) supplied costs.
      samples++; sum += (ms - sum) / samples;
      acceptedSamples++; lastRejection = null; elapsed += Math.min(dt, 0.1);
      if (elapsed + 1e-9 < AUTO_RES.WINDOW || samples < MIN_SAMPLES) return false;
      const avg = sum;
      observedMs = avg;
      clearWindow();
      const budget = 1000 / config.targetHz;
      if (trial) {
        const { direction, stage, baseline, before } = trial;
        const accepted = direction === 'down' ? avg <= baseline * AUTO_RES.KEEP : avg <= budget * (1 / OVER);
        lastTrial = {
          direction, stage, source, baselineMs: baseline, measuredMs: avg, accepted,
          costReductionMs: accepted && direction === 'down' ? baseline - avg : null,
        };
        trial = null; over = under = 0;
        if (direction === 'down') {
          blocked[stage] = !accepted;
          downAt = now + (accepted ? AUTO_RES.WINDOW : AUTO_RES.HOLD);
          upAt = now + AUTO_RES.HOLD;
        } else {
          upAt = now + (accepted ? AUTO_RES.WINDOW : upHold);
          upHold = accepted ? AUTO_RES.HOLD : Math.min(AUTO_RES.MAX_HOLD, upHold * 2);
          downAt = now + AUTO_RES.HOLD;
        }
        return accepted ? false : assign(before.surface, before.effects);
      }
      over = avg > budget * OVER ? over + 1 : 0;
      under = avg < budget * UNDER ? under + 1 : 0;
      let direction, stage, s = surface, e = effects;
      if (under >= 3 && now >= upAt) {
        direction = 'up';
        if (!close(surface, ceiling)) { stage = 'surface'; s = Math.min(ceiling, surface * AUTO_RES.UP); }
        else if (!close(effects, 1)) { stage = 'effects'; e = Math.min(1, effects * AUTO_RES.UP); }
      } else if (over >= 2 && now >= downAt) {
        direction = 'down';
        if (!blocked.effects && !close(effects, AUTO_RES.MIN)) {
          stage = 'effects'; e = Math.max(AUTO_RES.MIN, effects * AUTO_RES.DOWN);
        } else if (!blocked.surface && !close(surface, minimum)) {
          stage = 'surface'; s = Math.max(minimum, surface * AUTO_RES.DOWN);
        }
      }
      if (!stage) return false;
      trial = { direction, stage, baseline: avg, source, before: { surface, effects }, invalid: false };
      over = under = 0;
      return assign(s, e);
    },
  };
}
