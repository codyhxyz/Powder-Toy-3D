// Pure policy checks: no browser, WebGPU device, timers, or render scheduling.
import assert from 'node:assert/strict';
import { createHybridResolution } from '../src/gfx/hybrid/resolution.js';
import { AUTO_RES, UPSCALE } from '../src/gfx/post.js';

function rig(options = {}) {
  const c = createHybridResolution({ upscale: UPSCALE.quality, ...options });
  let now = 100, id = 0;
  const tick = (ms = 30, extra = {}) => c.update({
    now: now += 0.1, dt: 0.1, sampleId: id++, sampleGeneration: c.generation, gpuMs: ms, ...extra,
  });
  const window = (ms = 30, extra = {}) => { for (let i = 0; i < 12; i++) tick(ms, extra); };
  const down = () => { window(); window(); assert.equal(c.metrics.trial?.direction, 'down'); };
  return { c, tick, window, down };
}

// Selected/fixed/native modes and the existing explicit adaptive-at-1 Fast mode.
for (const options of [{ upscale: 1 }, { adaptive: false }, { taa: false }]) {
  const { c, window } = rig(options);
  const initial = c.scales;
  for (let i = 0; i < 10; i++) window(100);
  assert.deepEqual(c.scales, initial);
  assert.equal(c.metrics.adaptive, false);
  assert.equal(c.resolutionScale, 1);
  if (options.taa === false) assert.equal(c.scales.surface, 1);
}
{
  const r = rig({ upscale: 1, adaptive: true, floor: 2 / 3 });
  r.down();
  assert.equal(r.c.metrics.trial.stage, 'effects');
  assert.equal(r.c.scales.surface, 1);
}
for (const options of [{ upscale: NaN }, { upscale: 0 }, { floor: Infinity }, { floor: -1 },
  { targetHz: 0 }, { targetHz: Infinity }, { targetHz: Number.MIN_VALUE }]) {
  assert.throws(() => createHybridResolution(options), RangeError);
}
assert.equal(rig({ floor: null }).c.metrics.minimum, UPSCALE.quality * AUTO_RES.MIN);
assert.equal(rig({ floor: 0.9 }).c.metrics.minimum, UPSCALE.quality);

// Budget is Hz-dependent, with two overloaded windows before a trial.
for (const hz of [30, 60, 120]) {
  const { c, window } = rig({ targetHz: hz });
  assert.equal(c.metrics.budgetMs, 1000 / hz);
  window(12); assert.equal(c.metrics.trial, null);
  window(12); assert.equal(c.metrics.trial?.stage ?? null, hz === 120 ? 'effects' : null);
}
{
  const { c, window } = rig();
  window(30); window(16); window(30);
  assert.equal(c.metrics.trial, null, 'neutral window clears overload hysteresis');
  window(30); assert.equal(c.metrics.trial.stage, 'effects');
  window(20); assert.equal(c.metrics.lastTrial.accepted, true);
  assert.equal(c.metrics.lastTrial.costReductionMs, 10);
  assert.equal(c.scales.surface, UPSCALE.quality);
}
// Exhaust effect quality before touching opaque, then enforce both floors.
{
  const { c, window } = rig({ floor: 0.45 });
  for (let i = 0; i < 180; i++) {
    const trial = c.metrics.trial;
    if (trial?.stage === 'surface') assert.equal(c.metrics.effectMultiplier, AUTO_RES.MIN);
    window(trial ? trial.baselineMs * 0.9 : 40);
    for (const v of Object.values(c.scales)) assert(Number.isFinite(v) && v > 0 && v <= 1);
    assert(c.scales.surface >= 0.45 && c.scales.surface <= UPSCALE.quality);
    assert(c.metrics.effectMultiplier >= AUTO_RES.MIN);
  }
  assert.equal(c.scales.surface, 0.45);
  assert.equal(c.metrics.effectMultiplier, AUTO_RES.MIN);
  assert.equal(c.scales.media, c.scales.reflections);
  assert.equal(c.scales.media, 0.45 * 0.5 * AUTO_RES.MIN);
  for (let i = 0; i < 400; i++) window(1);
  assert.equal(c.scales.surface, UPSCALE.quality);
  assert.equal(c.metrics.effectMultiplier, 1, 'headroom recovers selected detail');
}
// Failed reductions revert and block that stage, not endlessly lower CPU-bound quality.
{
  const r = rig(); r.down(); r.window(30);
  assert.equal(r.c.metrics.lastTrial.accepted, false);
  assert.equal(r.c.metrics.blocked.effects, true);
  assert.equal(r.c.metrics.effectMultiplier, 1);
  for (let i = 0; i < 100; i++) r.window(30);
  assert.deepEqual(r.c.metrics.blocked, { effects: true, surface: true });
  assert.equal(r.c.resolutionScale, 1);
}
// Reset invalidates even unchanged allocations (resize/cut), including late GPU reads.
{
  const r = rig(); const old = r.c.generation;
  assert.equal(r.c.reset(), false);
  assert(r.c.generation > old);
  r.window(80, { sampleGeneration: old });
  assert.equal(r.c.metrics.acceptedSamples, 0);
  assert.equal(r.c.metrics.lastRejection, 'stale-generation');
  r.down(); const trialGen = r.c.generation;
  r.c.reset({ targetHz: 120 });
  r.window(80, { sampleGeneration: trialGen });
  assert.equal(r.c.metrics.trial, null);
  assert.equal(r.c.metrics.acceptedSamples, 0);
  assert.equal(r.c.metrics.targetHz, 120);
}
// Malformed/stale inputs cannot become evidence; timestamps and IDs are monotonic.
{
  const r = rig();
  for (const extra of [{ gpuMs: NaN, renderMs: 10 }, { gpuMs: -1 }, { gpuMs: Infinity },
    { gpuMs: null }, { dt: 0 }, { dt: NaN }, { now: Infinity }, { sampleId: 0.5 }, { sampleId: -1 }]) {
    assert.equal(r.tick(30, extra), false);
    assert.equal(r.c.metrics.acceptedSamples, 0);
  }
  assert.equal(r.c.update(null), false);
  r.tick(10, { sampleId: 1000, now: 1000 });
  r.tick(90, { sampleId: 1000, now: 1001 });
  r.tick(90, { sampleId: 1001, now: 999 });
  assert.equal(r.c.metrics.acceptedSamples, 1);
  const snapshot = r.c.metrics; snapshot.blocked.effects = true;
  assert.equal(r.c.metrics.blocked.effects, false, 'metrics are snapshots');
}
// Idle/pacing intervals are not render cost, even when marked uncapped.
for (const extra of [{ paused: true }, { idle: true }, { rendered: false },
  { gpuMs: undefined, frameMs: 1000 }, { gpuMs: undefined, frameMs: 1000, capped: true }]) {
  const r = rig();
  for (let i = 0; i < 10; i++) r.window(1000, extra);
  assert.equal(r.c.metrics.acceptedSamples, 0);
  assert.equal(r.c.metrics.trial, null);
}
{
  const r = rig(); r.window(undefined, { gpuMs: undefined, renderMs: 30 });
  r.window(undefined, { gpuMs: undefined, renderMs: 30 });
  assert.equal(r.c.metrics.trial.source, 'render');
  r.tick(10); // Switching sources cannot prove trial benefit.
  assert.equal(r.c.metrics.trial, null);
  assert.equal(r.c.metrics.effectMultiplier, 1);
}
for (const interruption of [{ stable: false }, { idle: true }]) {
  const r = rig(); r.down(); r.tick(10, interruption); r.tick(10);
  assert.equal(r.c.metrics.trial, null);
  assert.equal(r.c.metrics.effectMultiplier, 1);
}
{
  const r = rig(); r.down();
  assert.equal(r.c.recover(), true);
  assert.equal(r.c.metrics.resting, true);
  for (let i = 0; i < 20; i++) r.window(100);
  assert.equal(r.c.metrics.effectMultiplier, 1);
  assert.equal(r.c.recover(), false);
  r.c.reset(); r.down();
}
// Finite extreme costs do not overflow the observed mean.
{
  const r = rig(); r.window(Number.MAX_VALUE);
  assert.equal(r.c.metrics.observedMs, Number.MAX_VALUE);
}
// Delayed pre-trial reads cannot cancel a current trial, even on an old cut.
{
  const r = rig(); const old = r.c.generation; r.down();
  r.tick(10, { sampleGeneration: old, stable: false });
  assert.equal(r.c.metrics.trial.stage, 'effects');
  r.window(20);
  assert.equal(r.c.metrics.lastTrial.accepted, true);
}
// Long idle dt cannot fill a measurement window in one sample; GPU wins over CPU.
{
  const r = rig(); r.tick(30, { dt: 1000, renderMs: 1 });
  assert.equal(r.c.metrics.observedMs, null);
  assert.equal(r.c.metrics.samples, 1);
  assert.equal(r.c.metrics.source, 'gpu');
}
// Recovery probes also roll back and back off when the restored detail costs too much.
{
  const r = rig(); r.down(); r.window(20);
  const reduced = r.c.scales;
  for (let i = 0; i < 100 && !r.c.metrics.trial; i++) r.window(1);
  assert.equal(r.c.metrics.trial.direction, 'up');
  r.window(30);
  assert.equal(r.c.metrics.lastTrial.accepted, false);
  assert.deepEqual(r.c.scales, reduced);
  assert.equal(r.c.metrics.trial, null);
}
console.log('hybrid-resolution-check: passed (CPU policy only; no GPU correctness claim)');
