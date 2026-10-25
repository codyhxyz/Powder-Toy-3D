// Deterministic, no browser/GPU: node tools/dynamic-res-cpu-check.mjs
//
// Automatic resolution steering on GPU time (gfx/autoResolution.js), on simulated traces: a frame's GPU
// time is fixed + per-pixel × scale² (plus noise and spikes), its interval the display's refresh it
// fits (vsync) or a browser cap, and its timestamps land LAND_FRAMES frames later, as gpu/timing.js's do.
// The frame loop calls the controller as app.js tick() does: update(dt) before the frame, drawn(frame)
// at its end, gpu(frame, ms) when its times land. Also gpu/timing.js busyMs and the GpuTiming
// background/profiler switch.
import assert from 'node:assert/strict';
import { createAutoResolution, AUTO_RES, levelScale, levelOf } from '../src/gfx/autoResolution.js';
import { busyMs } from '../src/gpu/timing.js';

const REFRESH_MS = 1000 / 60;
const LAND_FRAMES = 2;
const LEVEL_SCALES = Array.from({ length: AUTO_RES.LEVELS + 1 }, (_, k) => levelScale(k));

// A seeded generator (mulberry32), so every run sees the same noise.
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A frame loop: gpuMs(scale, frame) the frame's GPU time; capMs a browser cap (Energy Saver: 33.3);
// timestamps: false for a device without them; reported(ms) what the timestamps say (broken ones).
// wallLag: the interval the tick measures is the one this many frames before (frames in flight: a view
// turning heavy reaches the frame interval after its timestamps say so).
function loop(auto, { timestamps = true, capMs = 0, reported = (ms) => ms, start = 0, firstFrame = 0, wallLag = 0 } = {}) {
  let now = start, frame = firstFrame, dt = 0;
  const inFlight = [], changes = [], trace = [], intervals = [];
  return {
    changes, trace,
    get now() { return now; },
    run(seconds, gpuMs) {
      const end = now + seconds;
      while (now < end) {
        if (dt > 0) auto.update(intervals.length > wallLag ? intervals.at(-1 - wallLag) : dt, now);   // (the tick measures the frame before)
        const scale = auto.scale;
        const ms = gpuMs(scale, frame, now);
        frame++;
        auto.drawn(frame);
        if (timestamps) inFlight.push({ frame, ms: reported(ms), at: frame + LAND_FRAMES });
        // vsync: the frame shows on the first refresh after its GPU work, or the browser's cap
        const interval = Math.max(capMs, Math.ceil(ms / REFRESH_MS - 1e-9) * REFRESH_MS);
        dt = interval / 1000;
        intervals.push(dt);
        now += dt;
        while (inFlight.length && inFlight[0].at <= frame) { const f = inFlight.shift(); auto.gpu(f.frame, f.ms, now); }
        if (trace.length && trace.at(-1).scale !== auto.scale) changes.push({ now, from: trace.at(-1).scale, to: auto.scale });
        trace.push({ now, scale: auto.scale, ms });
      }
    },
  };
}
const cost = (fixed, perPixel) => (scale) => fixed + perPixel * scale ** 2;
const noisy = (f, amp, seed) => { const r = rng(seed); return (scale, i, t) => f(scale, i, t) * (1 + amp * (2 * r() - 1)); };
const settledMs = (sim, seconds) => { const from = sim.now - seconds; const xs = sim.trace.filter((t) => t.now >= from).map((t) => t.ms); return xs.reduce((a, b) => a + b, 0) / xs.length; };
const isLevel = (s) => LEVEL_SCALES.some((l) => Math.abs(l - s) < 1e-12);
const T = AUTO_RES.TARGET_MS;

// Levels: equal steps in pixels from full to the floor, and back.
assert.equal(levelScale(0), 1);
assert.ok(Math.abs(levelScale(AUTO_RES.LEVELS) - AUTO_RES.MIN) < 1e-12);
LEVEL_SCALES.forEach((s, k) => assert.equal(levelOf(s), k));
assert.ok(AUTO_RES.MIN * 2 / 3 >= 1 / 3 - 1e-12, 'Quality × the floor stays at or above FSR 2 Ultra Performance (1/3 per axis)');
console.log(`PASS: ${AUTO_RES.LEVELS + 1} levels, ${LEVEL_SCALES.map((s) => s.toFixed(3)).join(' ')}`);

// 1. A light view (9 ms at full) stays at full: no change in a minute, noise included.
{
  const auto = createAutoResolution(), sim = loop(auto);
  sim.run(60, noisy(cost(3, 6), 0.1, 1));
  assert.equal(auto.scale, 1, 'light view: full scale');
  assert.equal(sim.changes.length, 0, `light view never changes: ${JSON.stringify(sim.changes)}`);
  assert.equal(auto.steering, 'gpu');
}
console.log('PASS: a light view (9 ms) holds full scale');

// 2. A heavy view (17 ms at full, a third of it not per pixel: the Island's start view) converges under the
// target within a second and then holds its level.
{
  const auto = createAutoResolution(), sim = loop(auto);
  sim.run(1, noisy(cost(5, 12), 0.05, 2));
  assert.ok(auto.scale < 1);
  const at1 = auto.scale;
  assert.ok(cost(5, 12)(at1) <= T, `heavy view under ${T} ms within 1 s: ${cost(5, 12)(at1).toFixed(2)} ms at ${at1.toFixed(3)}`);
  const changes = sim.changes.length;
  sim.run(60, noisy(cost(5, 12), 0.05, 3));
  assert.ok(sim.changes.length - changes <= 1, `then steady: ${JSON.stringify(sim.changes.slice(changes))}`);
  assert.ok(settledMs(sim, 30) <= T, `settled ${settledMs(sim, 30).toFixed(2)} ms`);
  assert.ok(auto.scale >= at1, 'it does not keep sinking');
  // not far under either: the next level up would not fit
  const k = levelOf(auto.scale);
  assert.ok(k === 0 || cost(5, 12)(levelScale(k - 1)) > T * AUTO_RES.UP_FIT, 'settles at the highest level that fits');
  assert.ok(sim.trace.every((t) => isLevel(t.scale)), 'GPU steering moves in levels only');
}
console.log('PASS: a 17 ms view converges under 12 ms within 1 s and holds the highest level that fits');

// 3. The sea from straight above (45 ms at full): the floor within a second; at the floor it stays.
{
  const auto = createAutoResolution(), sim = loop(auto);
  sim.run(1, cost(5, 40));
  assert.equal(auto.scale, levelScale(AUTO_RES.LEVELS), `45 ms view: the floor within 1 s (at ${auto.scale})`);
  const n = sim.changes.length;
  assert.ok(n <= 2, `in at most two steps: ${JSON.stringify(sim.changes)}`);
  sim.run(30, noisy(cost(5, 40), 0.05, 4));
  assert.equal(sim.changes.length, n, 'held at the floor');
  // A view that fits at the floor: 30 ms at full → under the target within a second.
  const b = createAutoResolution(), s2 = loop(b);
  s2.run(1, cost(3, 27));
  assert.ok(cost(3, 27)(b.scale) <= T, `30 ms view under ${T} ms within 1 s: ${cost(3, 27)(b.scale).toFixed(2)}`);
}
console.log('PASS: a 45 ms view reaches the floor within 1 s; a 30 ms view gets under 12 ms within 1 s');

// 4. Heavy, then light again: back to full scale within a few seconds, in at most UP_LEVELS a step.
{
  const auto = createAutoResolution(), sim = loop(auto);
  sim.run(3, cost(5, 40));
  assert.equal(auto.scale, AUTO_RES.MIN);
  const n = sim.changes.length;
  sim.run(4, noisy(cost(2, 5), 0.1, 5));
  assert.equal(auto.scale, 1, 'back to full when the view is light');
  const ups = sim.changes.slice(n);
  assert.ok(ups.every((c) => c.to > c.from && levelOf(c.from) - levelOf(c.to) <= AUTO_RES.UP_LEVELS), JSON.stringify(ups));
  assert.ok(ups[0].now - sim.trace[sim.trace.findIndex((t) => t.now > 3)].now >= AUTO_RES.UP_SECONDS - 0.05, 'steps up only after a second of headroom');
}
console.log('PASS: heavy → light returns to full within 4 s, a second of headroom per step up');

// 4b. A teleport's first heavy frames (0.3 s at 40 ms) then a view with a large fixed part (7 ms + 10 ms of
// pixels at full, the Island's start view): from wherever the transient left it, the highest level that
// fits within 3 s, then steady.
{
  const auto = createAutoResolution(), sim = loop(auto);
  const view = cost(7, 10);
  sim.run(0.3, () => 40);
  sim.run(3, noisy(view, 0.05, 13));
  const k = levelOf(auto.scale);
  assert.ok(view(auto.scale) <= T, `under ${T} ms: ${view(auto.scale).toFixed(2)}`);
  assert.ok(k === 0 || view(levelScale(k - 1)) > T * AUTO_RES.UP_FIT, `the highest level that fits within 3 s (at level ${k}, ${auto.scale.toFixed(3)}): ${JSON.stringify(auto.changes)}`);
  const n = sim.changes.length;
  sim.run(30, noisy(view, 0.05, 14));
  assert.ok(sim.changes.length - n <= 1, `steady after: ${JSON.stringify(auto.changes)}`);
}
console.log('PASS: after a 0.3 s heavy transient, a view with a large fixed cost regains its highest fitting level within 3 s');

// 5. Spikes don't move it: a light view with a 40 ms frame every half second, and a pair every two.
{
  const auto = createAutoResolution(), sim = loop(auto);
  const base = noisy(cost(3, 6), 0.1, 6);
  sim.run(60, (s, i) => (i % 30 === 0 || i % 120 === 1 ? 40 : base(s, i)));
  assert.equal(sim.changes.length, 0, `spikes: ${JSON.stringify(sim.changes)}`);
  assert.equal(auto.scale, 1);
}
console.log('PASS: single and paired 40 ms spikes cause no change');

// 6. No oscillation on the edge: a view whose levels straddle the target, noisy.
{
  for (const [fixed, per, seed] of [[4, 8.6, 7], [3, 10.5, 8], [6, 9, 9], [2, 14, 10]]) {
    const auto = createAutoResolution(), sim = loop(auto);
    sim.run(60, noisy(cost(fixed, per), 0.12, seed));
    assert.ok(sim.changes.length <= 3, `${fixed}+${per}: ${sim.changes.length} changes: ${JSON.stringify(sim.changes.map((c) => [c.now.toFixed(1), c.to.toFixed(3)]))}`);
    assert.ok(settledMs(sim, 30) <= T, `${fixed}+${per}: settled ${settledMs(sim, 30).toFixed(2)} ms`);
  }
}
console.log('PASS: noisy views on the edge of the budget change level at most 3 times a minute and settle under it');

// 7. Chrome's Energy Saver (a 30 Hz cap) with timestamps: the wall clock reads 33 ms, the GPU 9 ms: full scale.
{
  const auto = createAutoResolution(), sim = loop(auto, { capMs: 1000 / 30 });
  sim.run(120, noisy(cost(3, 6), 0.1, 11));
  assert.equal(sim.changes.length, 0);
  assert.equal(auto.scale, 1, 'a 30 Hz cap is not GPU load');
  // and a heavy view under the cap still steers on its GPU time
  sim.run(2, cost(5, 12));
  assert.ok(cost(5, 12)(auto.scale) <= T);
}
console.log('PASS: at a 30 Hz cap the GPU time steers: light stays full, heavy still drops');

// 8. No timestamps: the wall-clock trials, as before: a refresh-capped page keeps (or regains) full scale,
// a GPU-limited one degrades to the wall clock's floor.
{
  const capped = createAutoResolution(), sim = loop(capped, { timestamps: false, capMs: 1000 / 30 });
  sim.run(240, () => 9);
  assert.equal(capped.steering, 'wall');
  assert.equal(capped.scale, 1, 'a 30 Hz cap without timestamps: drops are tried and reverted');
  const drops = sim.changes.filter((c) => c.to < c.from);
  assert.ok(drops.length >= 3 && drops.length <= 6, `trials back off: ${drops.length}`);
  const slow = createAutoResolution(), s2 = loop(slow, { timestamps: false });
  s2.run(20, (s) => 80 * s ** 2);
  assert.ok(slow.scale <= AUTO_RES.WALL_MIN + 0.05, `GPU-limited without timestamps degrades: ${slow.scale}`);
  assert.ok(s2.trace.every((t) => t.scale >= AUTO_RES.WALL_MIN - 1e-12));
}
console.log('PASS: without timestamps the wall-clock trials steer (30 Hz cap reverted, GPU-limited degrades)');

// 2b. The interval catching up a few frames after the timestamps (frames in flight) is not broken timing:
// a light view turning heavy still gets under the target within a second.
{
  const auto = createAutoResolution(), sim = loop(auto, { wallLag: 4 });
  sim.run(5, noisy(cost(3, 6), 0.1, 12));
  const t0 = sim.now;
  sim.run(1, cost(3, 27));
  assert.equal(auto.steering, 'gpu', 'not distrusted');
  assert.ok(cost(3, 27)(auto.scale) <= T, `light → 30 ms view under ${T} ms within 1 s: ${cost(3, 27)(auto.scale).toFixed(2)} at ${auto.scale.toFixed(3)} (${(sim.now - t0).toFixed(2)} s)`);
}
console.log('PASS: a view turning heavy with the interval 4 frames behind its timestamps still converges within 1 s');

// 9. Broken timestamps (Metal origins jumping: 100 ms a frame at 60 fps) are not load: the wall clock steers.
{
  const auto = createAutoResolution(), sim = loop(auto, { reported: () => 100 });
  sim.run(10, () => 9);
  assert.equal(auto.steering, 'wall');
  assert.equal(auto.scale, 1, 'impossible GPU times do not drive the scale down');
  assert.ok(sim.changes.length <= 2 && sim.trace.every((t) => t.scale >= levelScale(1) - 1e-12), JSON.stringify(sim.changes));
}
console.log('PASS: GPU times longer than the frame interval are distrusted; the wall clock steers');

// 10. Timestamps that stop landing hand over to the wall clock; when they come back, GPU time steers again.
{
  const auto = createAutoResolution();
  const view = cost(5, 12);
  // timestamps on, then off (a device losing its pools), then on again
  let at = 0, frames = 0;
  const run = (s, ts) => { const l = loop(auto, { timestamps: ts, start: at, firstFrame: frames }); l.run(s, view); at = l.now; frames += l.trace.length; return l; };
  run(2, true);
  assert.equal(auto.steering, 'gpu');
  const level = auto.scale;
  run(3, false);
  assert.equal(auto.steering, 'wall');
  assert.ok(auto.scale >= AUTO_RES.MIN - 1e-12);
  run(3, true);
  assert.equal(auto.steering, 'gpu');
  assert.ok(isLevel(auto.scale) && view(auto.scale) <= T, `back on GPU time: ${auto.scale} vs ${level}`);
}
console.log('PASS: stale timestamps fall back to the wall clock; GPU time takes over again when they land');

// 11. Disabled (tools), the still's recovery, and frames that didn't draw the view.
{
  const auto = createAutoResolution(), sim = loop(auto);
  sim.run(2, cost(5, 40));
  auto.enabled = false;
  const frozen = auto.scale, n = sim.changes.length;
  sim.run(10, () => 3);
  assert.equal(auto.scale, frozen, 'disabled: frozen');
  assert.equal(sim.changes.length, n);
  auto.enabled = true;
  assert.equal(auto.recover(sim.now), true, 'a still finishes at full scale');
  assert.equal(auto.scale, 1);
  // a landed frame that never drew the view (a physics-only tick) is not counted
  const b = createAutoResolution();
  for (let i = 1; i <= 200; i++) { b.update(1 / 60, i / 60); b.gpu(i, 50, i / 60); }
  assert.equal(b.scale, 1, 'undrawn frames do not steer');
}
console.log('PASS: disabled freezes, recover restores full scale, undrawn frames are ignored');

// gpu/timing.js busyMs: the union of a frame's pass intervals (overlaps once, gaps out).
assert.equal(busyMs([{ start: 0, gpu: 4 }, { start: 2, gpu: 4 }, { start: 10, gpu: 1 }, { start: 10.5, gpu: 0.2 }]), 7);
assert.equal(busyMs([{ start: null, gpu: 3 }, { start: 1, gpu: null }]), 0);
assert.equal(busyMs([{ start: 5, gpu: 1 }, { start: 0, gpu: 10 }]), 10);
console.log('PASS: busyMs: overlapping passes once, idle gaps left out');

// GpuTiming: the app's background timing and the profiler's switch don't turn each other off.
{
  const { GpuTiming } = await import('../src/gpu/timing.js');
  const device = { features: new Set(['timestamp-query']), createCommandEncoder: () => ({}), createQuerySet: () => ({ destroy() {} }), createBuffer: () => ({ destroy() {} }) };
  globalThis.GPUBufferUsage ??= { QUERY_RESOLVE: 0x200, COPY_SRC: 4, MAP_READ: 1, COPY_DST: 8 };
  const t = new GpuTiming({ device, queue: { submit() {} }, frameNo: 0 });
  t.background = true;
  assert.equal(t.enabled, true);
  t.enabled = true; t.enabled = false;
  assert.equal(t.enabled, true, 'the profiler turning off leaves the background timing on');
  t.background = false;
  assert.equal(t.enabled, false);
  t.enabled = true; t.background = true; t.background = false;
  assert.equal(t.enabled, true, 'and the other way round');
  t.enabled = false;
  const none = new GpuTiming({ device: { ...device, features: new Set() }, queue: { submit() {} }, frameNo: 0 });
  none.background = true;
  assert.equal(none.enabled, false, 'no timestamp-query: nothing to turn on');
}
console.log('PASS: GpuTiming background and profiler switches are independent');
