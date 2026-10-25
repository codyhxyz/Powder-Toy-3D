// No browser/GPU. The profiler's report path (docs/profiler.md):
//   - the sampling fixes: prof.enable(true) sticks (onChange), and a frame nothing
//     follows (a parked test's renderOnce) is still sampled once its timestamps land;
//   - capture(n) reports on exactly the next n landed frames;
//   - buildReport: ranking, median and spread, phases, waterfall, verdict;
//   - honesty: compiles in flight, missing timestamps, few frames, a shared GPU mark it
//     UNTRUSTED; cost counters are work beside the times, with the work/time flag;
//   - formatReport / reportHtml / compareReports run on it.
// node tools/profile-cpu-check.mjs
import assert from 'node:assert/strict';
import { GpuTiming } from '../src/gpu/timing.js';
import { createProfiler, PHASES } from '../src/gfx/profiler.js';
import { buildReport, formatReport, reportHtml, compareReports, annotate, stats, MIN_FRAMES } from '../src/gfx/profileReport.js';

globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8 };
globalThis.GPUMapMode = { READ: 1 };
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

// A device whose passes take `ms` of a mock clock (as tools/check-profiler-coverage.mjs's).
function fixture() {
  let clock = 1000000n;
  performance.now = () => Number(clock) / 1e6;
  const device = {
    features: new Set(['timestamp-query']),
    createQuerySet({ count }) { return { values: new BigUint64Array(count), destroy() {} }; },
    createBuffer({ size }) {
      const data = new ArrayBuffer(size);
      return { data, destroy() {}, unmap() {}, getMappedRange: (s, n) => data.slice(s, s + n), mapAsync: () => Promise.resolve() };
    },
    createComputePipelineAsync: () => new Promise(() => {}),   // a compile that never ends
    createCommandEncoder() {
      const ops = [];
      const begin = (d) => {
        ops.push(() => {
          const w = d.timestampWrites, start = clock;
          clock += BigInt(Math.round((d.ms ?? 1) * 1e6));
          if (w) { w.querySet.values[w.beginningOfPassWriteIndex] = start; w.querySet.values[w.endOfPassWriteIndex] = clock; }
        });
        return { end() {} };
      };
      return {
        beginRenderPass: begin, beginComputePass: begin,
        resolveQuerySet(q, first, count, dst, off) { if (off % 256) throw new Error('resolveQuerySet: destination offset not a multiple of 256'); ops.push(() => new BigUint64Array(dst.data, off, count).set(q.values.subarray(first, first + count))); },
        copyBufferToBuffer(src, a, dst, b, size) { ops.push(() => new Uint8Array(dst.data, b, size).set(new Uint8Array(src.data, a, size))); },
        finish() { return { ops }; },
      };
    },
  };
  const queue = { submit(buffers) { for (const b of buffers) for (const op of b.ops) op(); } };
  const gpu = { device, queue, frameNo: 0, adapterInfo: { vendor: 'mock' }, memory: () => ({ bytes: 1024, byLabel: { a: 1024 } }) };
  gpu.timing = new GpuTiming(gpu);
  // one app frame: phases with passes, then gpu.endFrame, then prof.endFrame (app.js's order)
  const frame = (prof, now, passes) => {
    prof.beginFrame(now);
    const enc = device.createCommandEncoder();
    for (const [phase, name, ms] of passes) { prof.phase(phase); enc.beginComputePass({ label: name, ms }).end(); }
    queue.submit([enc.finish()]);
    gpu.frameNo++; gpu.timing._endFrame(gpu.frameNo);
    prof.endFrame(4);
  };
  return { gpu, frame, tick: (ms) => { clock += BigInt(Math.round(ms * 1e6)); } };
}
const makeProf = (gpu, extra = {}) => {
  const samples = [];
  let enabled = null;
  const prof = createProfiler(gpu, {
    describe: () => ({ canvas: [800, 600], renderScale: 0.5 }), onSample: (s) => samples.push(s),
    onChange: (on) => { enabled = on; }, context: () => ({ map: 'lab', view: 'realistic', detail: 'full', taa: true, upscale: 1 }),
    buildReport: (input) => { const r = buildReport(input); r.text = formatReport(r); return r; }, ...extra,
  });
  return { prof, samples, enabled: () => enabled };
};
const FRAME = [['sim', 'move', 2], ['view', 'scene', 6], ['post', 'taa', 1]];

// 1. enable() reports the change (app.js makes it the setting: the loop no longer switches it back off)
{
  const { gpu } = fixture();
  const { prof, enabled } = makeProf(gpu);
  prof.enable(true);
  assert.equal(enabled(), true, 'enable(true) tells the app (settings.profiler follows)');
  prof.enable(false);
  assert.equal(enabled(), false);
}
// 2. one frame nothing follows (renderOnce in a parked test) is sampled when its timestamps land
{
  const { gpu, frame } = fixture();
  const { prof, samples } = makeProf(gpu);
  prof.enable(true);
  await drain();   // (the query pools' error scopes: none on this device)
  frame(prof, 1000, FRAME);
  assert.equal(prof.last, null, 'nothing before the timestamps land');
  await drain();
  assert.ok(prof.last, 'the frame is sampled as its timestamps land, without a next frame');
  assert.equal(samples.length, 1);
  assert.equal(prof.last.measuredGpu, 9);
  assert.equal(prof.landed.length, 1);
}
// 3. capture(n): exactly the next n frames; report() over the kept ones
{
  const { gpu, frame, tick } = fixture();
  const { prof } = makeProf(gpu);
  prof.enable(true);
  await drain();
  frame(prof, 0, FRAME); await drain();   // before the capture: not in it
  const p = prof.capture({ frames: 12 });
  for (let i = 1; i <= 14; i++) {
    tick(1);
    frame(prof, i * 16.7, i === 5 ? [['sim', 'move', 2], ['view', 'scene', 30], ['post', 'taa', 1]] : FRAME);
    await drain();
  }
  const r = await p;
  assert.equal(r.frames.n, 12);
  assert.equal(r.passes[0].name, 'scene', 'ranked by ms per frame');
  assert.equal(r.passes[0].median, 6, 'the median ignores one slow frame');
  assert.equal(r.passes[0].max, 30);
  assert.ok(r.frames.interval.median > 16 && r.frames.interval.median < 17.5, 'frame interval from rAF times');
  assert.equal(r.phases.find((x) => x.id === 'view').gpu.median, 6);
  assert.ok(r.phases.find((x) => x.id === 'sim').cpu.n > 0, 'CPU per phase');
  assert.ok(r.waterfall && r.waterfall.passes.length === 3, 'a waterfall frame');
  assert.equal(r.setup.map, 'lab');
  assert.ok(r.trusted, `trusted: ${r.untrusted}`);
  assert.match(r.text, /PROFILE \(trusted\)/);
  assert.match(r.text, /scene/);
  assert.equal(prof.report({ frames: 5 }).frames.n, 5);
}
// 4. compiles in flight mark the capture untrusted (counted at the device boundary)
{
  const { gpu, frame } = fixture();
  const { prof } = makeProf(gpu);
  prof.enable(true);
  await drain();
  gpu.device.createComputePipelineAsync({});
  assert.equal(gpu.timing.pipelines.compiling, 1);
  const p = prof.capture({ frames: MIN_FRAMES });
  for (let i = 0; i < MIN_FRAMES; i++) { frame(prof, i * 16.7, FRAME); await drain(); }
  const r = await p;
  assert.equal(r.trusted, false);
  assert.ok(r.untrusted.some((u) => /compiling/.test(u)), r.untrusted.join('; '));
  assert.match(formatReport(r), /UNTRUSTED/);
}
// 5. buildReport alone: missing timestamps, too few frames, the shared GPU, cost work vs time
{
  const mk = (i, sceneMs, complete = true) => ({
    frame: i, gpu: complete ? sceneMs + 1 : null,
    coverage: { complete, timelineComplete: complete, spanMs: complete ? sceneMs + 1 : null, missing: complete ? [] : [{ name: 'scene', error: 'no query pool free' }] },
    passes: [{ name: 'scene', kind: 'render', phase: 'view', error: complete ? null : 'no query pool free', start: complete ? 0 : null, gpu: complete ? sceneMs : null },
      { name: '(unlabelled compute)', kind: 'compute', phase: 'other', error: null, start: complete ? sceneMs : null, gpu: 1 }],
    rec: { wall: 3, interval: 16.7, cpu: PHASES.map(() => 0.3), steps: 4, compiling: 0, created: 7, ended: true },
  });
  const r = buildReport({ frames: [mk(1, 10), mk(2, 12, false), mk(3, 11)], phases: PHASES, context: { canvas: [1000, 1000], renderScale: 1, split: true } });
  assert.equal(r.trusted, false);
  assert.ok(r.untrusted.some((u) => /missing timestamps \(no query pool free\)/.test(u)));
  assert.ok(r.untrusted.some((u) => /only 3 frames/.test(u)));
  assert.ok(r.notes.some((n) => /unlabelled/.test(n)));
  assert.ok(r.notes.some((n) => /split mode/.test(n)));
  // C's counters, all within their normal ranges, while the pass is slow per pixel: the flag
  annotate(r, { cost: { pass: 'scene', counters: { steps: { mean: 40, p50: 38, p95: 90, max: 200 } }, normal: { steps: [10, 80] }, image: 'data:image/png;base64,AA==' }, gpuShared: 'GPU 60% busy' });
  assert.match(r.cost.flag, /work normal, time high/);
  assert.ok(r.verdict.some((v) => /run --counters/.test(v)));
  assert.equal(r.cost.image, undefined, 'the heatmap is saved by the tool, not kept in the report');
  assert.ok(r.untrusted.some((u) => /shared/.test(u)));
  annotate(r, { cost: { pass: 'scene', counters: { steps: { mean: 140, p50: 138, p95: 190, max: 300 } }, normal: { steps: [10, 80] } } });
  assert.match(r.cost.flag, /work high on scene: steps/);
  const text = formatReport(r);
  assert.match(text, /work \(agent C's cost counters, not time\)/);
  const html = reportHtml(r, { title: 'check' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /UNTRUSTED/);
  const c = compareReports(r, { ...r, setup: { ...r.setup, renderScale: 0.5 } });
  assert.equal(c.comparable, false);
  assert.ok(c.why.some((w) => /renderScale/.test(w)));
  // the verdict reads the bound side
  const gpuBound = buildReport({ frames: Array.from({ length: 12 }, (_, i) => ({ ...mk(i, 30), rec: { ...mk(i, 30).rec, interval: 33 } })), phases: PHASES });
  assert.equal(gpuBound.bound, 'gpu');
}
{
  // pass times past the frame interval: whole submissions, not passes; cost view passes are not timed
  const fr = (i) => ({ frame: i, gpu: 120, coverage: { complete: true, timelineComplete: false, spanMs: null, missing: [] },
    passes: [55, 55, 10].map((ms, k) => ({ name: `march${k}`, kind: 'compute', phase: 'view', error: null, start: null, gpu: ms }))
      .concat([{ name: 'cost view live', kind: 'compute', phase: 'view', error: null, start: null, gpu: 99 }]),
    rec: { wall: 2, interval: 60, cpu: null, steps: 0, compiling: 0, created: 1 } });
  const r = buildReport({ frames: Array.from({ length: 12 }, (_, i) => fr(i)), phases: PHASES });
  assert.ok(r.untrusted.some((u) => /whole submissions/.test(u)), r.untrusted.join('; '));
  assert.ok(!r.passes.some((p) => /cost view/.test(p.name)), 'cost view passes are excluded');
  assert.ok(r.notes.some((n) => /excluded from timings/.test(n)));
}
assert.deepEqual([stats([3, 1, 2]).median, stats([]).median], [2, null]);
console.log('profile CPU check OK: enable sticks, renderOnce frames sample, capture(n), ranking/median/spread, untrusted reasons, work vs time, text/html/compare');
