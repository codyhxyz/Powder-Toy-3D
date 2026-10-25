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
import { metalTimes, applyMetal, estimateCauses, causesFor, targetVerdict, compareCauses, categoryTotals, nnls, passDependants, knockoutPlan, knockoutRows } from '../src/gfx/profileCauses.js';
import { exclusiveShares, unionLength, stateShares } from './gpu-counters.mjs';
import { laneShare, LANE_BLOCKS } from '../src/gfx/costView.js';
import { knockoutText } from './profile.mjs';
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
{
  // Metal's encoder times become the pass ms; timestamp-only distrust becomes a note
  const fr = (i) => ({ frame: i, gpu: 120, coverage: { complete: true, timelineComplete: false, spanMs: null, missing: [] },
    passes: [{ name: 'scene', kind: 'render', phase: 'view', error: null, start: null, gpu: 55 }, { name: 'canvas', kind: 'render', phase: 'post', error: null, start: null, gpu: 55 },
      { name: 'move', kind: 'compute', phase: 'sim', error: null, start: null, gpu: 2 }],
    rec: { wall: 2, interval: 33, cpu: null, steps: 0, compiling: 0, created: 1 } });
  const r = buildReport({ frames: Array.from({ length: 12 }, (_, i) => fr(i)), phases: PHASES });
  assert.ok(!r.trusted);
  // 40 frames in the window for pose 0 (scene and canvas once a frame); pose 1's and untimed rows ignored
  const rows = [{ label: 'scene@0', count: 40, totalMs: 400 }, { label: 'canvas@0', count: 40, totalMs: 40 }, { label: 'move@0', count: 40, totalMs: 80 },
    { label: 'scene@1', count: 40, totalMs: 999 }, { label: 'scene@-', count: 9, totalMs: 99 }, { label: 'GPU Execution@0', count: 3, totalMs: 4 }];
  const m = metalTimes(r, rows, 0);
  assert.equal(m.frames, 40);
  assert.deepEqual(m.perPass, { scene: 10, canvas: 1, move: 2 });
  assert.equal(m.unattributed[0].label, 'GPU Execution@0');
  applyMetal(r, m);
  assert.equal(r.timeSource, 'metal');
  assert.equal(r.passes[0].name, 'scene');
  assert.equal(r.passes[0].ms, 10);
  assert.ok(r.trusted, `timestamp distrust demoted: ${r.untrusted}`);
  assert.ok(r.notes.some((n) => /per-pass ms come from Metal/.test(n)));
  assert.match(formatReport(r), /Metal ms/);
  // frame estimates that disagree: not trusted
  const bad = metalTimes(r, [{ label: 'scene@0', count: 40, totalMs: 1 }, { label: 'canvas@0', count: 10, totalMs: 1 }, { label: 'move@0', count: 25, totalMs: 1 }], 0);
  assert.ok(bad.disagree.length >= 1, 'passes whose encoder counts are off the frames are named');
  // ... but keep their Metal ms: mean per run × runs per frame (a trace that drops intervals undercounts runs, not durations)
  assert.equal(bad.perPass.canvas, 0.1);
  // Metal ms that sum past the frame's GPU span: untrusted
  const over = buildReport({ frames: Array.from({ length: 12 }, (_, i) => fr(i)), phases: PHASES });
  applyMetal(over, metalTimes(over, [{ label: 'scene@0', count: 40, totalMs: 40 * 200 }, { label: 'canvas@0', count: 40, totalMs: 40 }], 0));
  assert.ok(!over.trusted && over.untrusted.some((u) => /exceed the frame's GPU span/.test(u)), over.untrusted.join('; '));
  // a render pass Metal didn't name, with untrusted timestamps: no ms, said why, report untrusted
  const r2 = buildReport({ frames: Array.from({ length: 12 }, (_, i) => fr(i)), phases: PHASES });
  applyMetal(r2, metalTimes(r2, rows.filter((x) => !x.label.startsWith('scene')), 0));
  const sc = r2.passes.find((p) => p.name === 'scene');
  assert.equal(sc.ms, null);
  assert.match(sc.msSource, /no labelled Metal encoder \(render pass\)/);
  assert.ok(!r2.trusted && r2.untrusted.some((u) => /no trusted ms \(scene/.test(u)), r2.untrusted.join('; '));
}
{
  // ms per cause: a planted cost per unit is recovered; collinear or too few observations refuse
  const truth = { march: 2e-6, fieldReads: 5e-7, cellReads: 1e-6 };
  const mk = (s) => ({ pass: 'scene', sums: s, ms: Object.entries(s).reduce((t, [k, v]) => t + truth[k] * v, 0) });
  const obs = [[1e6, 2e6, 3e6], [3e6, 1e6, 1e6], [2e6, 4e6, 1e6], [1e6, 1e6, 4e6], [4e6, 3e6, 2e6], [2e6, 2e6, 2e6]]
    .map(([a, b, c]) => mk({ march: a, fieldReads: b, cellReads: c }));
  const fit = estimateCauses(obs);
  assert.ok(fit.ok, fit.why);
  for (const k of Object.keys(truth)) assert.ok(Math.abs(fit.perUnit[k] / truth[k] - 1) < 1e-3, `${k}: ${fit.perUnit[k]} vs ${truth[k]}`);
  assert.ok(fit.fit.r2 > 0.999 && fit.fit.looErr < 0.01);
  const rows = causesFor(fit, [{ pass: 'scene', sums: { march: 1e6, fieldReads: 2e6, cellReads: 3e6 } }]);
  assert.equal(rows[0].category, 'cellReads');
  assert.ok(Math.abs(rows[0].ms - 3) < 1e-3);
  // too few observations for the three categories: a coarser grouping, saying why, or a refusal
  const few = estimateCauses(obs.slice(0, 4));
  assert.ok(few.ok ? few.level > 0 && /need 5/.test(few.coarser) : /need 5/.test(few.why), JSON.stringify(few));
  const none = estimateCauses(obs.slice(0, 2));
  assert.equal(none.ok, false);
  assert.match(none.why, /need 5/);
  assert.match(none.propose, /--poses/);
  const col = estimateCauses([1, 2, 3, 4, 5, 6].map((x) => mk({ march: x * 1e6, fieldReads: x * 2e6, cellReads: (7 - x) * 1e6 })));
  assert.ok(col.ok ? /rise and fall together/.test(col.coarser) : /rise and fall together/.test(col.why), JSON.stringify(col));
  // noise the categories can't explain: refused by leave-one-out
  const noisy = estimateCauses(obs.map((x, i) => ({ ...x, ms: x.ms * (i % 2 ? 3 : 0.3) })));
  assert.equal(noisy.ok, false);
  assert.match(noisy.why, /leave-one-out/);
  assert.deepEqual(nnls([[1, 0], [0, 1]], [2, -1]), [2, 0], 'non-negative');
  // C's capture shape → category totals (skip* grouped)
  const t = categoryTotals({ pass: 'scene', covered: 10, counters: { march: { sum: 5 }, skipBrick: { sum: 1 }, skip16: { sum: 2 }, fieldReads: { sum: 0 } } });
  assert.deepEqual(t, [{ pass: 'scene', sums: { march: 5, skips: 3 }, covered: 10 }]);
}
{
  // the target verdict: what must drop, by what this build added when the compare knows it
  const v = targetVerdict(70, 21, [{ name: 'scene · march', ms: 40, delta: 30 }, { name: 'scene · fieldReads', ms: 20, delta: 15 }, { name: 'far', ms: 5, delta: 1 }], { source: 'in live.json' });
  assert.equal(v.over, 49);
  assert.deepEqual(v.cuts.map((c) => [c.name, c.by]), [['scene · march', 30], ['scene · fieldReads', 15], ['far', 1]]);
  assert.match(v.line, /still 3\.0 ms short/);
  assert.match(targetVerdict(15, 21, []).line, /within/);
  const a = { causes: { rows: [{ pass: 'scene', category: 'march', ms: 10 }], totals: [{ pass: 'scene', sums: { march: 100 }, covered: 10 }], coverage: { passes: ['scene'] } } };
  const b = { causes: { rows: [{ pass: 'scene', category: 'march', ms: 25 }], totals: [{ pass: 'scene', sums: { march: 300 }, covered: 10 }], coverage: { passes: ['scene'] } } };
  const c = compareCauses(a, b);
  assert.deepEqual([c.rows[0].delta, c.rows[0].workA, c.rows[0].workB], [15, 10, 30]);
}
{
  // Metal bounds: a pass's even share of shared time (lower) and its own time (upper), and what shared it
  const work = new Map([['m', { spans: [[0, 10]] }], ['k', { spans: [[5, 15]] }]]);
  const { share, unionNs, overlap } = exclusiveShares(work);
  assert.deepEqual([share.get('m'), share.get('k'), unionNs], [7.5, 7.5, 15]);
  assert.equal(overlap.get('m').get('k'), 5);
  assert.equal(unionLength([[0, 4], [2, 6], [8, 9]]), 7, 'vertex and fragment overlap counted once');
  // the GPU performance state, time-weighted over a window
  const st = stateShares([[0, 30, 'Medium'], [30, 100, 'Maximum']], [[10, 50]]);
  assert.deepEqual(st.shares, { Medium: 0.5, Maximum: 0.5 });
  assert.deepEqual(stateShares([[0, 30, 'Medium'], [30, 100, 'Maximum']], [[20, 100]]).dominant, 'Maximum');
  const fr = (i) => ({ frame: i, gpu: 12, coverage: { complete: true, timelineComplete: true, spanMs: 12, missing: [] },
    passes: [{ name: 'world march', kind: 'render', phase: 'view', error: null, start: 0, gpu: 8 }, { name: 'v2block', kind: 'compute', phase: 'sim', error: null, start: 8, gpu: 4 }],
    rec: { wall: 2, interval: 16, cpu: null, steps: 0, compiling: 0, created: 1 } });
  const r = buildReport({ frames: Array.from({ length: 12 }, (_, i) => fr(i)), phases: PHASES });
  const rows = [{ label: 'world march@0', count: 12, totalMs: 12 * 4, ownMs: 9, overlapWith: [{ label: 'v2block@0', ms: 5 }] }, { label: 'v2block@0', count: 12, totalMs: 12 * 3, ownMs: 3.5 }];
  const m = metalTimes(r, rows, 0);
  assert.deepEqual([m.perPass['world march'], m.ownPass['world march']], [4, 9]);
  applyMetal(r, m);
  const wm = r.passes.find((p) => p.name === 'world march');
  assert.deepEqual([wm.ms, wm.msOwn, wm.beside[0].name], [4, 9, 'v2block']);
  r.setup.gpuPerfStateText = 'Maximum 80% · Medium 20%';
  const txt = formatReport(r);
  assert.match(txt, /share–own/);
  assert.match(txt, /world march\s+4\.00–9\.00 ms; beside it: v2block 5\.00/);
  assert.match(txt, /GPU performance state Maximum 80%/);
  assert.match(reportHtml(r), /share–own/);
  // runs at different GPU performance states are not comparable; reports from before the key still are
  const a = structuredClone(r), b = structuredClone(r);
  a.setup.gpuPerfState = 'Maximum'; b.setup.gpuPerfState = 'Medium';
  assert.ok(compareReports(a, b).why.some((w) => /gpuPerfState: Maximum vs Medium/.test(w)));
  delete a.setup.gpuPerfState;
  assert.ok(!compareReports(a, b).why.some((w) => /gpuPerfState/.test(w)));
}
{
  // dependants from the resource log: the march renders G (texture 1), reflect reads G and renders O (2),
  // shade reads G and O; post reads shade's colour (3). A later rewrite takes over the edge.
  const log = [
    { name: 'world march', frame: 1, writes: [1], reads: [9] },
    { name: 'world reflect', frame: 1, writes: [2], reads: [1] },
    { name: 'world shade', frame: 1, writes: [3], reads: [1, 2] },
    { name: 'post', frame: 1, writes: [4], reads: [3] },
    { name: 'clear G', frame: 2, writes: [1], reads: [] },
    { name: 'world reflect', frame: 2, writes: [2], reads: [1] },
  ];
  const d = passDependants(log);
  assert.deepEqual(d['world march'], ['world reflect', 'world shade']);
  assert.deepEqual(d['world reflect'], ['world shade']);
  assert.deepEqual(d['clear G'], ['world reflect']);
  const plan = knockoutPlan(['world march', 'v2block'], d);
  assert.deepEqual(plan.sets, [['world march'], ['world reflect', 'world shade'], ['world march', 'world reflect', 'world shade'], ['v2block']]);
  // the march alone "saves" 14 ms, but reflect + shade alone save 6, all three 16: its own cost is 10
  const base = { interval: 40, span: 30 };
  const measured = { 'world march': { interval: 26, span: 17 }, 'world reflect + world shade': { interval: 34, span: 24 },
    'world march + world reflect + world shade': { interval: 24, span: 14 }, v2block: { interval: 37, span: 27 } };
  const rows = knockoutRows(base, measured, plan.targets);
  assert.deepEqual([rows[0].interval.alone, rows[0].interval.deps, rows[0].interval.group, rows[0].interval.own, rows[0].interval.induced], [14, 6, 16, 10, 4]);
  assert.deepEqual([rows[1].interval.own, rows[1].interval.induced], [3, 0]);
  const kt = knockoutText(0, { base, measured, targets: plan.targets });
  assert.match(kt, /its own cost ≈ 10\.00 ms \[10\.00\]/);
  assert.match(kt, /3\.00 ms \[4\.00\] of "out" is its dependants \(world reflect, world shade\) idling without it/);
}
{
  // gpu/timing.js depLog: attachments are writes, bind groups' textures reads, views mapped to their texture
  const texture = () => { const t = { createView: () => ({}) }; return t; };
  const device = { features: new Set(), createTexture: texture, createBindGroup: () => ({}), createCommandEncoder() {
    const pass = () => ({ setBindGroup() {}, draw() {}, end() {} });
    return { beginRenderPass: pass, beginComputePass: pass, finish: () => ({}) };
  } };
  const gpu = { device, queue: { submit() {} }, frameNo: 7 };
  const timing = new GpuTiming(gpu);
  const g = device.createTexture({}), o = device.createTexture({});
  const bindG = device.createBindGroup({ entries: [{ binding: 0, resource: g.createView() }, { binding: 1, resource: { buffer: {} } }] });
  timing.depLog = [];
  const enc = device.createCommandEncoder();
  enc.beginRenderPass({ label: 'world march', colorAttachments: [{ view: g.createView() }] }).end();
  const p2 = enc.beginRenderPass({ label: 'world reflect', colorAttachments: [{ view: o.createView() }] });
  p2.setBindGroup(0, bindG); p2.end();
  // a pass gated by an earlier pass's depth (loaded, not cleared) depends on it too
  const z = device.createTexture({});
  enc.beginRenderPass({ label: 'lean march', colorAttachments: [], depthStencilAttachment: { view: z.createView(), depthLoadOp: 'clear' } }).end();
  enc.beginRenderPass({ label: 'event kernel', colorAttachments: [{ view: o.createView(), loadOp: 'load' }], depthStencilAttachment: { view: z.createView(), depthLoadOp: 'load' } }).end();
  assert.deepEqual(passDependants(timing.depLog), { 'world march': ['world reflect'], 'lean march': ['event kernel'], 'world reflect': ['event kernel'] });
  assert.equal(timing.depLog[0].frame, 7);
}
{
  // busy-lane share over 32-pixel blocks: one slow pixel holds its group; uniform work fills it
  const w = 16, h = 4, n = w * h, cov = new Uint8Array(n).fill(1);
  const one = new Uint16Array(n); one[0] = 32;
  assert.equal(laneShare(one, cov, w, h), 1 / 32);
  assert.equal(laneShare(new Uint16Array(n).fill(5), cov, w, h), 1);
  const half = new Uint16Array(n); for (let p = 0; p < n; p++) half[p] = (p % w) < 8 ? 4 : 2;   // left block 4s, right block 2s
  assert.equal(laneShare(half, cov, w, h, LANE_BLOCKS['8x4']), 1);
  assert.equal(laneShare(half, cov, w, h, LANE_BLOCKS['16x2']), 0.75);
  // the report: the share per counter and a verdict line when the march is divergent
  const fr = (i) => ({ frame: i, gpu: 12, coverage: { complete: true, timelineComplete: true, spanMs: 12, missing: [] },
    passes: [{ name: 'scene', kind: 'render', phase: 'view', error: null, start: 0, gpu: 12 }], rec: { wall: 2, interval: 16, cpu: null, steps: 0, compiling: 0, created: 1 } });
  const r = buildReport({ frames: Array.from({ length: 12 }, (_, i) => fr(i)), phases: PHASES, context: { canvas: [100, 100] } });
  annotate(r, { cost: { pass: 'scene', pixels: 10000, counters: { march: { mean: 10, p50: 8, p95: 30, max: 90, sum: 1e5, busyLanes: 0.31, busyLanesBy: { '8x4': 0.31, '4x8': 0.33, '16x2': 0.29 } } } } });
  assert.ok(r.verdict.some((v) => /march divergence on scene: 31% .*4×8 33%, 16×2 29%/.test(v)), r.verdict.join(' | '));
  assert.match(formatReport(r), /march busy lanes by block shape: 8×4 31% · 4×8 33% · 16×2 29%/);
}
assert.deepEqual([stats([3, 1, 2]).median, stats([]).median], [2, null]);
console.log('profile CPU check OK: enable sticks, renderOnce frames sample, capture(n), ranking/median/spread, untrusted reasons, work vs time, text/html/compare, Metal share/own bounds, GPU performance state, knockout dependants, busy lanes');
