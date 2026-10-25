// The profiler's report (docs/profiler.md): one capture of N landed frames
// (gfx/profiler.js capture / report) turned into what an agent needs to know
// what is wrong with performance, from one run. Pure: no DOM, no GPU, so the
// browser (__app.prof.report()), tools/profile.mjs and tools/profile-cpu-check.mjs
// all build and print the very same thing.
//
// Honesty rules (docs/profiler.md, "Why it can't lie"):
//   - times come only from the frames the player's pipeline ran (timestamp
//     queries at the device boundary), never from a test or cost variant;
//   - a capture with compiles in flight, missing timestamps, a shared GPU or
//     too few frames says UNTRUSTED at the top, with the reasons;
//   - every pass reports its median and spread over the frames, not one frame;
//   - the report carries what was measured (map, pose, canvas, scale, TAA,
//     upscale, view, detail) so two reports can be compared, or say why not.

export const REPORT_VERSION = 1;
export const MIN_FRAMES = 10;          // fewer frames than this: the spread means little (untrusted)
export const NOISY_SPREAD = 0.5;       // (p90 − p10) / median above this: a noisy pass, flagged
export const BOUND_SHARE = 0.9;        // GPU span or CPU work within this share of the frame interval: that side bounds it
export const CAP_FPS = 60;             // the app's frame cap (gfx/pacing.js MAX_FPS)
export const CAP_SLACK = 0.1;          // an interval within this share of the cap's is "at the cap"
export const TOP_PASSES = 8;           // passes the text report ranks (the JSON keeps all)
export const TEXT_PASSES = 24;         // …and lists in its table
export const SUM_OVER_INTERVAL = 1.25; // GPU pass sum past this × the frame interval: passes can't all be that long (untrusted)
export const SUM_OVER_SPAN = 1.5;      // …or past this × the frame's GPU span: the "passes" overlap, timing whole submissions
// Agent C's cost view (variant passes, not the player's pipeline): never timed (docs/profiler.md)
export const EXCLUDED_PASS = /^cost view (live|counted)/;
export const VIEW_SHARE = 0.5;         // the traced pass alone over this share of a capped frame is "time high"
// the march's busy-lane share (gfx/costView.js laneShare: Σ steps ÷ Σ 32 × the 32-pixel block's max) under this:
// most lane-steps wait on a slow pixel in their group, so the time is divergence more than work per pixel
export const DIVERGENT_SHARE = 0.5;
const MS_PER_S = 1000;
const NS_PER_MS = 1e6;
const MB = 1024 * 1024;
const PCT = 100;
const P10 = 0.1, P50 = 0.5, P90 = 0.9;

/** Nearest-rank statistics; null fields when there is nothing. */
export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p10: null, p90: null, min: null, max: null, mean: null, spread: null };
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
  const median = at(P50), p10 = at(P10), p90 = at(P90);
  return { n: v.length, median, p10, p90, min: v[0], max: v.at(-1), mean: v.reduce((a, b) => a + b, 0) / v.length,
    spread: median > 0 ? (p90 - p10) / median : null };
}

const phaseIndex = (phases, p) => (typeof p === 'number' ? p : Math.max(0, phases.findIndex((x) => x.id === p)));

/**
 * @param {{ frames: Array<{ frame: number, passes: Array<{ name: string, kind: string, phase: number|string, error: string|null, start: number|null, gpu: number|null }>,
 *   coverage: object, gpu: number|null, rec?: { wall?: number|null, interval?: number|null, cpu?: number[]|null, steps?: number, compiling?: number|null, created?: number|null, ended?: boolean } | null }>,
 *   phases: Array<{ id: string, label: string }>, context?: object }} input
 */
export function buildReport({ frames: input, phases, context = {} }) {
  const excluded = new Set();
  const frames = input.map((f) => {
    if (!f.passes.some((p) => EXCLUDED_PASS.test(p.name))) return f;
    const passes = f.passes.filter((p) => { const x = EXCLUDED_PASS.test(p.name); if (x) excluded.add(p.name); return !x; });
    const missing = (f.coverage?.missing ?? []).filter((m) => !EXCLUDED_PASS.test(m.name));
    return { ...f, passes, coverage: { ...f.coverage, missing, complete: missing.length === 0 && passes.every((p) => p.gpu !== null) } };
  });
  const n = frames.length;
  const P = phases.length;
  const perFrame = frames.map((f) => {
    const timed = f.passes.filter((p) => p.gpu !== null);
    const views = f.passes.some((p) => phases[phaseIndex(phases, p.phase)]?.id === 'view');
    return {
      frame: f.frame,
      complete: !!f.coverage?.complete,
      gpu: f.coverage?.complete ? timed.reduce((s, p) => s + p.gpu, 0) : null,
      span: f.coverage?.timelineComplete ? f.coverage.spanMs : null,
      passes: f.passes.length,
      missing: f.passes.length - timed.length,
      wall: f.rec?.wall ?? null,
      interval: f.rec?.interval ?? null,
      steps: f.rec?.steps ?? 0,
      compiling: f.rec?.compiling ?? null,
      created: f.rec?.created ?? null,
      view: views,
    };
  });

  // passes by name: per frame, the summed time and the count; then over frames
  const byName = new Map();
  frames.forEach((f, i) => {
    const seen = new Map();
    for (const p of f.passes) {
      let s = seen.get(p.name);
      if (!s) seen.set(p.name, s = { gpu: 0, count: 0, failed: 0, phase: phaseIndex(phases, p.phase), kind: p.kind, error: null });
      s.count++;
      if (p.gpu === null) { s.failed++; s.error ??= p.error; } else s.gpu += p.gpu;
    }
    for (const [name, s] of seen) {
      let r = byName.get(name);
      if (!r) byName.set(name, r = { name, phase: s.phase, kind: s.kind, perFrame: [], counts: [], failed: 0, error: null, frames: 0, first: i });
      r.frames++;
      r.counts.push(s.count);
      r.failed += s.failed;
      r.error ??= s.error;
      if (!s.failed) r.perFrame.push(s.gpu);
    }
  });
  const gpuMedian = stats(perFrame.map((f) => f.gpu)).median;
  const passes = [...byName.values()].map((r) => {
    const st = stats(r.perFrame);
    // the mean cost per captured frame (a pass every other frame costs half)
    const cost = r.perFrame.length ? r.perFrame.reduce((a, b) => a + b, 0) / r.perFrame.length * (r.frames / Math.max(1, n)) : null;
    return {
      name: r.name, phase: phases[r.phase]?.id ?? 'other', kind: r.kind,
      perFrame: cost, median: st.median, p10: st.p10, p90: st.p90, max: st.max, spread: st.spread,
      count: stats(r.counts).median, presence: r.frames / Math.max(1, n),
      share: cost !== null && gpuMedian ? cost / gpuMedian : null,
      noisy: st.spread !== null && st.spread > NOISY_SPREAD,
      unlabelled: r.name.startsWith('(unlabelled'),
      failed: r.failed, error: r.error,
    };
  }).sort((a, b) => (b.perFrame ?? -1) - (a.perFrame ?? -1));

  // phases: GPU per frame (complete frames), CPU per frame (frames that ended in a tick)
  const phaseRows = phases.map((ph, j) => {
    const gpu = frames.filter((f) => f.coverage?.complete).map((f) => f.passes
      .filter((p) => phaseIndex(phases, p.phase) === j).reduce((s, p) => s + p.gpu, 0));
    const cpu = frames.filter((f) => Array.isArray(f.rec?.cpu) && f.rec.cpu.length === P).map((f) => f.rec.cpu[j]);
    return { id: ph.id, label: ph.label, gpu: stats(gpu), cpu: stats(cpu) };
  });

  const frame = {
    gpu: stats(perFrame.map((f) => f.gpu)),
    span: stats(perFrame.map((f) => f.span)),
    wall: stats(perFrame.map((f) => f.wall)),
    interval: stats(perFrame.map((f) => f.interval)),
    steps: stats(perFrame.map((f) => f.steps)),
    passes: stats(perFrame.map((f) => f.passes)),
  };
  frame.fps = frame.interval.median ? MS_PER_S / frame.interval.median : null;

  // the waterfall: the complete frame with a timeline whose GPU total is the median's
  const candidates = frames.map((f, i) => ({ f, pf: perFrame[i] })).filter(({ pf }) => pf.gpu !== null && pf.span !== null)
    .sort((a, b) => a.pf.gpu - b.pf.gpu);
  const pick = candidates.length ? candidates[Math.floor((candidates.length - 1) / 2)] : null;
  const waterfall = pick ? {
    frame: pick.f.frame, gpu: pick.pf.gpu, span: pick.pf.span, wall: pick.pf.wall, interval: pick.pf.interval,
    passes: pick.f.passes.map((p) => ({ name: p.name, kind: p.kind, phase: phases[phaseIndex(phases, p.phase)]?.id ?? 'other', start: p.start, gpu: p.gpu })),
  } : null;

  // trust
  const untrusted = [], notes = [];
  const compilingFrames = perFrame.filter((f) => f.compiling > 0).length;
  const created = perFrame.map((f) => f.created).filter((x) => x !== null);
  const createdDuring = created.length > 1 ? created.at(-1) - created[0] : 0;
  const pipes = context.pipelines ?? {};
  if (compilingFrames) untrusted.push(`${compilingFrames}/${n} frames ended with pipelines still compiling`);
  if (createdDuring > 0) untrusted.push(`${createdDuring} pipelines were created during the capture`);
  if ((pipes.cachePending ?? 0) + (pipes.deviceCompiling ?? 0) > 0) untrusted.push(`${(pipes.cachePending ?? 0) + (pipes.deviceCompiling ?? 0)} pipelines still compiling at the end`);
  const incomplete = perFrame.filter((f) => !f.complete).length;
  if (incomplete) {
    const why = [...new Set(frames.flatMap((f) => f.coverage?.missing ?? []).map((m) => m.error))].join(', ');
    untrusted.push(`${incomplete}/${n} frames missing timestamps (${why || 'unknown'})`);
  }
  {
    const sum = stats(perFrame.map((f) => f.gpu)).median, iv = stats(perFrame.map((f) => f.interval)).median, sp = stats(perFrame.map((f) => f.span)).median;
    if (sum !== null && iv && sum > SUM_OVER_INTERVAL * iv) untrusted.push(`GPU pass times sum to ${sum.toFixed(1)} ms, past the ${iv.toFixed(1)} ms frame interval: timestamps likely measure whole submissions, not passes`);
    else if (sum !== null && sp && sum > SUM_OVER_SPAN * sp) untrusted.push(`GPU pass times sum to ${sum.toFixed(1)} ms over a ${sp.toFixed(1)} ms GPU span: the passes overlap, so they likely time whole submissions`);
  }
  if (excluded.size) notes.push(`excluded from timings (cost view variants, not the player's pipeline): ${[...excluded].join(', ')}`);
  if (n < MIN_FRAMES) untrusted.push(`only ${n} frames (at least ${MIN_FRAMES} for a median and spread)`);
  if (/software|fallback|swiftshader/i.test(context.gpuName ?? '')) untrusted.push(`software adapter: ${context.gpuName}`);
  if (!candidates.length && n) untrusted.push('no frame with a whole timeline (no waterfall)');
  if (context.split) notes.push('split mode: every dispatch is its own timed pass; pass sums are upper bounds on the unsplit frame');
  const noView = perFrame.filter((f) => !f.view).length;
  if (noView) notes.push(`${noView}/${n} frames drew no view pass (a still scene, or sim-only frames)`);
  const unlabelled = passes.filter((p) => p.unlabelled);
  if (unlabelled.length) notes.push(`${unlabelled.length} unlabelled pass names: label them at their encoder (docs/profiler.md)`);
  const noisy = passes.filter((p) => p.noisy && (p.share ?? 0) > 0.02).map((p) => p.name);
  if (noisy.length) notes.push(`noisy (spread > ${NOISY_SPREAD * PCT}% of median): ${noisy.slice(0, 6).join(', ')}`);

  // verdict
  const capMs = MS_PER_S / CAP_FPS;
  const iv = frame.interval.median, span = frame.span.median ?? frame.gpu.median, wall = frame.wall.median;
  let bound = 'unknown';
  if (iv && span !== null && span >= BOUND_SHARE * iv) bound = 'gpu';
  else if (iv && wall !== null && wall >= BOUND_SHARE * iv) bound = 'cpu';
  else if (iv && Math.abs(iv - capMs) <= CAP_SLACK * capMs) bound = 'cap';
  else if (iv) bound = 'waiting';
  const verdict = [];
  const f2 = (x) => (x == null ? '–' : x.toFixed(2));
  if (bound === 'gpu') verdict.push(`GPU-bound: GPU busy ${f2(span)} ms of a ${f2(iv)} ms frame (${f2(frame.fps)} fps)`);
  else if (bound === 'cpu') verdict.push(`CPU-bound: main-thread frame work ${f2(wall)} ms of a ${f2(iv)} ms frame (${f2(frame.fps)} fps)`);
  else if (bound === 'cap') verdict.push(`At the ${CAP_FPS} fps cap: GPU ${f2(span)} ms, CPU ${f2(wall)} ms of ${f2(capMs)} ms`);
  else if (bound === 'waiting') verdict.push(`Neither side fills the ${f2(iv)} ms frame (GPU ${f2(span)} ms, CPU ${f2(wall)} ms): frames in flight, vsync or the compositor`);
  else verdict.push('No frame interval measured (frames driven one at a time): read GPU and CPU totals');
  const top = passes.filter((p) => p.perFrame !== null).slice(0, 3);
  if (top.length) verdict.push(`Top GPU: ${top.map((p) => `${p.name} ${f2(p.perFrame)} ms (${p.share !== null ? Math.round(p.share * PCT) : '–'}%)`).join(', ')}`);
  const cpuTop = phaseRows.filter((r) => r.cpu.median !== null).sort((a, b) => b.cpu.median - a.cpu.median)[0];
  if (cpuTop) verdict.push(`Top CPU phase: ${cpuTop.label} ${f2(cpuTop.cpu.median)} ms`);

  const { cost, gpuCounters, ...setup } = context;
  const report = {
    version: REPORT_VERSION,
    trusted: untrusted.length === 0,
    untrusted, notes, verdict, bound,
    setup,
    frames: { n, ...frame, perFrame },
    phases: phaseRows,
    passes,
    waterfall,
    cost: null,
    gpuCounters: null,
  };
  return annotate(report, { cost, gpuCounters });
}

/**
 * What comes from outside the timed frames, added to a report: agent C's cost
 * counters (work, shown beside the real pass times, never as times), agent D's
 * GPU counters, and whether the GPU was shared (the tool measures it around the
 * capture). The image is not kept in the report (the tool saves it).
 */
export function annotate(report, { cost = null, gpuCounters = null, gpuShared = null } = {}) {
  if (cost) {
    const { image: _image, ...counters } = cost;
    report.cost = costFindings(counters, report.passes, report.setup);
    if (report.cost.flag) report.verdict.push(report.cost.flag);
  }
  if (gpuCounters) report.gpuCounters = gpuCounters;
  if (gpuShared) {
    report.setup.gpuShared = gpuShared;
    report.untrusted.push(`the GPU was shared during the capture (${gpuShared})`);
    report.trusted = false;
  }
  return report;
}

// C's counters ({ counters: { name: { mean, p50, p95, max } }, pass?, pixels?, normal?: { name: [lo, hi] } })
// against the real time of the pass they describe. Work is shown as work; only
// the waterfall's pass gives the time.
function costFindings(c, passes, context) {
  // the passes the counted work ran in (the split world march: its three stages, their times summed)
  const names = c.passes ?? [c.pass ?? 'scene'];
  const passName = names.join(' + ');
  const found = names.map((n) => passes.find((p) => p.name === n)).filter(Boolean);
  const [w, h] = context.canvas ?? [0, 0];
  const pixels = c.pixels ?? Math.round(w * (context.renderScale ?? 1)) * Math.round(h * (context.renderScale ?? 1));
  const ms = found.length === names.length ? found.reduce((a, p) => a + ((p.ms ?? p.median) ?? 0), 0) : null;
  const nsPerPixel = ms !== null && pixels ? (ms * NS_PER_MS) / pixels : null;
  // "time high": the traced pass alone over VIEW_SHARE of a capped frame, per pixel
  const highNs = pixels ? (VIEW_SHARE * (MS_PER_S / CAP_FPS) * NS_PER_MS) / pixels : null;
  const timeHigh = nsPerPixel !== null && highNs !== null && nsPerPixel > highNs;
  const outside = Object.entries(c.normal ?? {}).filter(([k, [lo, hi]]) => {
    const v = c.counters?.[k]?.mean;
    return Number.isFinite(v) && (v < lo || v > hi);
  }).map(([k]) => k);
  const judged = Object.keys(c.normal ?? {}).length > 0;
  let flag = null;
  if (timeHigh && judged && !outside.length) flag = `work normal, time high on ${passName} (${nsPerPixel.toFixed(2)} ns/px): shader occupancy/register pressure suspected; run --counters`;
  else if (timeHigh && outside.length) flag = `work high on ${passName}: ${outside.join(', ')} outside normal; the scene asks more of the shader per pixel`;
  // divergence (gfx/costView.js laneShare): the march's loop trips per 32-lane group vs per pixel
  const m = c.counters?.march;
  const divergence = Number.isFinite(m?.busyLanes) ? { counter: 'march', share: m.busyLanes, by: m.busyLanesBy ?? null, divergent: m.busyLanes < DIVERGENT_SHARE } : null;
  if (divergence?.divergent) {
    const line = `march divergence on ${passName}: ${Math.round(divergence.share * 100)}% of 32-lane groups' march steps do work (8×4 blocks${divergence.by ? `; ${Object.entries(divergence.by).filter(([k]) => k !== '8x4').map(([k, v]) => `${k.replace('x', '×')} ${Math.round(v * 100)}%`).join(', ')}` : ''}): groups wait on their slowest pixels, so cutting the slow pixels' steps (or grouping them) buys more than cutting average work`;
    flag = flag ? `${flag}; ${line}` : line;
  }
  if (c.trusted === false) flag = `cost counters UNTRUSTED: ${c.reason}`;
  return { pass: passName, passMs: ms, pixels, nsPerPixel, highNsPerPixel: highNs, timeHigh, outside, counters: c.counters ?? {}, normal: c.normal ?? null, flag, divergence,
    trusted: c.trusted ?? null, reason: c.reason ?? null, covered: c.covered ?? null, path: c.path ?? null, samePicture: c.samePicture ?? null, exactShare: c.exactShare ?? null,
    stages: c.stages ? Object.fromEntries(Object.entries(c.stages).map(([k, v]) => [k, { pass: v.pass, covered: v.covered, counters: v.counters }])) : null };
}

const setupKeys = ['map', 'mode', 'view', 'detail', 'canvas', 'renderScale', 'pixelRatio', 'taa', 'upscale', 'adaptive', 'autoRes',
  'pose', 'grid', 'world', 'gpuName', 'shaderFeatures', 'chromeArgs', 'split', 'testMode', 'paused', 'pov', 'fixture', 'gpuPerfState'];
// setup keys added after reports were already kept: compared only when both reports have them
// (gpuPerfState: the GPU performance state the pose ran in, from the Metal trace; Apple: state changes
// "can affect profiling results", WWDC 10157; two runs at different states are not an A/B)
const LATER_KEYS = ['shaderFeatures', 'gpuPerfState'];
export const BESIDE_SHOWN = 4;         // passes whose share and own time differ most, explained under the table
export const BESIDE_GAP = 1.25;        // own over share past this: the pass ran beside other work for a real part of its time

/** Can reports `a` and `b` be compared? { comparable, differences: [{ key, a, b }], passes: [{ name, a, b, delta }] } */
export function compareReports(a, b) {
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  // (a key a report predates, such as shaderFeatures before 2026-10-25, is unknown there, not a difference)
  const known = (k) => !LATER_KEYS.includes(k) || (a.setup?.[k] != null && b.setup?.[k] != null);
  // (missing and null are the same setup: chromeArgs is null without --chrome-arg, and absent in older reports)
  const differences = setupKeys.filter((k) => known(k) && !same(a.setup?.[k] ?? null, b.setup?.[k] ?? null)).map((k) => ({ key: k, a: a.setup?.[k] ?? null, b: b.setup?.[k] ?? null }));
  const names = new Set([...a.passes.map((p) => p.name), ...b.passes.map((p) => p.name)]);
  const get = (r, n) => { const p = r.passes.find((x) => x.name === n); return p ? (p.ms ?? p.perFrame ?? null) : null; };
  const passes = [...names].map((name) => {
    const x = get(a, name), y = get(b, name);
    return { name, a: x, b: y, delta: x !== null && y !== null ? y - x : null };
  }).sort((p, q) => Math.abs(q.delta ?? q.b ?? q.a ?? 0) - Math.abs(p.delta ?? p.b ?? p.a ?? 0));
  const why = [...differences.map((d) => `${d.key}: ${fmtVal(d.a)} vs ${fmtVal(d.b)}`),
    ...(!a.trusted ? ['first report untrusted'] : []), ...(!b.trusted ? ['second report untrusted'] : [])];
  return { comparable: why.length === 0, why, differences, passes,
    gpu: { a: a.frames.gpu.median, b: b.frames.gpu.median }, interval: { a: a.frames.interval.median, b: b.frames.interval.median } };
}
const fmtVal = (v) => (v === null || v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const setupLine = (s) => [
  `map ${s.map ?? '?'}${s.mode ? `/${s.mode}` : ''}`, `view ${s.view ?? '?'}`, `detail ${s.detail ?? '?'}`,
  `canvas ${(s.canvas ?? []).join('×')} @${f(s.pixelRatio, 2)}x`, `scene ×${f(s.renderScale, 3)}`,
  `TAA ${s.taa ? 'on' : 'off'}`, `upscale ${f(s.upscale, 3)}${s.adaptive ? ' adaptive' : ''}`, `autoRes ${s.autoRes ? 'on' : 'off'}`,
  ...(s.chromeArgs?.length ? [`chrome ${s.chromeArgs.join(' ')}`] : []),
  ...(s.shaderFeatures ? [`shaders ${Object.entries(s.shaderFeatures).filter(([, on]) => on).map(([k]) => k).join('+') || 'core'}`] : []),
].join(' · ');

/** The compact text report (what tools/profile.mjs prints, and report().text). */
export function formatReport(r) {
  const s = r.setup ?? {}, out = [];
  out.push(r.trusted ? 'PROFILE (trusted)' : `PROFILE — UNTRUSTED: ${r.untrusted.join('; ')}`);
  out.push(setupLine(s));
  const pose = s.pose ? `pose ${s.pose.name ?? 'custom'} eye ${s.pose.eye?.map((x) => f(x, 1)).join(',')} → ${s.pose.target?.map((x) => f(x, 1)).join(',')}` : 'pose ?';
  out.push(`${pose} · grid ${(s.grid ?? []).join('×') || '–'}${s.world ? ` · world ${s.world.join('×')}` : ''} · ${s.gpuName ?? '?'}`);
  if (s.gpuPerfStateText) out.push(`GPU performance state ${s.gpuPerfStateText}${s.gpuThermalText ? ` · thermal ${s.gpuThermalText}` : ''} (Metal trace; --compare refuses runs at different states)`);
  out.push(`frames ${r.frames.n} (since boot ${s.framesSinceBoot ?? '?'}) · compiles: cache ${s.pipelines?.cachePending ?? '?'}, device ${s.pipelines?.deviceCompiling ?? '?'} · GPU slot ${s.gpuShared ? `SHARED (${s.gpuShared})` : 'not shared'} · memory ${f((s.memory?.bytes ?? 0) / MB, 0)} MB`);
  // the physics governor (v2/host.js): game speed, each tick stage's GPU cost, a frame's budget
  const ph = s.physics;
  if (ph) out.push(`physics ${f(ph.ticksPerSec, 0)} ticks/s (game speed ${f(100 * ph.ticksPerSec / ph.hz, 0)}%) · stage ms ${Object.entries(ph.stages ?? {}).map(([k, v]) => `${k} ${f(v, 2)}`).join(', ') || 'unpriced'} · budget ${ph.budgetMs} ms a frame${ph.inFlight ? ' · a tick in flight' : ''}`);
  out.push('');
  for (const v of r.verdict) out.push(`» ${v}`);
  out.push('');
  const fr = r.frames;
  out.push(`frame   interval ${f(fr.interval.median)} ms [${f(fr.interval.p10)}–${f(fr.interval.p90)}] (${f(fr.fps, 1)} fps) · CPU work ${f(fr.wall.median)} [${f(fr.wall.p10)}–${f(fr.wall.p90)}] · GPU sum ${f(fr.gpu.median)} [${f(fr.gpu.p10)}–${f(fr.gpu.p90)}] · GPU span ${f(fr.span.median)} · passes ${f(fr.passes.median, 0)}`);
  out.push('phase      GPU ms  [p10–p90]        CPU ms');
  for (const p of r.phases) {
    if (!p.gpu.median && !p.cpu.median) continue;
    out.push(`${pad(p.label, 9)} ${lpad(f(p.gpu.median), 7)}  [${f(p.gpu.p10)}–${f(p.gpu.p90)}]${' '.repeat(Math.max(1, 12 - `${f(p.gpu.p10)}–${f(p.gpu.p90)}`.length))}${lpad(f(p.cpu.median), 6)}`);
  }
  out.push('');
  // the authoritative ms: Metal's encoder times when the run has them (gfx/profileCauses.js applyMetal)
  const metal = r.timeSource === 'metal';
  out.push(metal
    ? `pass (ranked by Metal ms/frame)            phase    Metal share–own ms  share [p10–p90]   timestamp ms/frame [p10–p90]   ×/frame`
    : `pass (ranked by ms/frame)                 phase    ms/frame  median [p10–p90]       ×/frame  share`);
  for (const p of r.passes.slice(0, TEXT_PASSES)) {
    const flags = [p.noisy ? 'noisy' : '', p.failed ? `untimed:${p.error}` : '', p.presence < 1 ? `in ${Math.round(p.presence * PCT)}%` : ''].filter(Boolean).join(' ');
    if (metal) { const ms = p.msP10 != null ? `[${f(p.msP10, 3)}–${f(p.msP90, 3)}]` : ''; out.push(`${pad(p.name.slice(0, 41), 41)} ${pad(p.phase, 8)} ${lpad(f(p.ms, 3), 8)}–${pad(p.msOwn != null ? f(p.msOwn, 3) : '', 8)} ${pad(ms, 15)}  ${lpad(f(p.timestampMs, 3), 8) } [${f(p.p10, 3)}–${f(p.p90, 3)}]${' '.repeat(Math.max(1, 16 - `${f(p.p10, 3)}–${f(p.p90, 3)}`.length))}${lpad(f(p.count, 0), 4)}  ${flags}${p.ms === null && p.msSource ? ` ${p.msSource}` : p.msSource === 'timestamps' ? ' (timestamp)' : ''}`); continue; }
    out.push(`${pad(p.name.slice(0, 41), 41)} ${pad(p.phase, 8)} ${lpad(f(p.perFrame, 3), 8)}  ${lpad(f(p.median, 3), 6)} [${f(p.p10, 3)}–${f(p.p90, 3)}]${' '.repeat(Math.max(1, 14 - `${f(p.p10, 3)}–${f(p.p90, 3)}`.length))}${lpad(f(p.count, 0), 4)}  ${lpad(p.share === null ? '–' : `${Math.round(p.share * PCT)}%`, 4)} ${flags}`);
  }
  if (metal) {
    // share = its even split of the time it ran beside other encoders (a lower bound), own = its whole time
    // on the GPU (an upper bound): its real cost to the frame is between them; what shared its time
    const gaps = r.passes.filter((p) => p.msOwn > 0 && p.ms > 0 && p.msOwn > BESIDE_GAP * p.ms).sort((a, b) => (b.msOwn - b.ms) - (a.msOwn - a.ms)).slice(0, BESIDE_SHOWN);
    if (gaps.length) out.push('Metal share is a lower bound (time shared with other encoders split evenly), own an upper bound (its whole time on the GPU). Widest:');
    for (const p of gaps) out.push(`  ${pad(p.name.slice(0, 40), 40)} ${f(p.ms, 2)}–${f(p.msOwn, 2)} ms; beside it: ${(p.beside ?? []).map((b) => `${b.name} ${f(b.ms, 2)}`).join(', ') || '?'}`);
  }
  if (metal && r.metal) out.push(`Metal: ${f(r.metal.total)} ms/frame of GPU time over ${f(r.metal.frames, 1)} frames in the window${r.metal.unattributed.length ? `; unlabelled: ${r.metal.unattributed.slice(0, 4).map((u) => `${u.label} ${f(u.ms, 2)}`).join(', ')}` : ''}`);
  if (r.causes) {
    out.push('');
    const c = r.causes;
    if (c.fit?.ok) {
      out.push(`ms per cause (ESTIMATE: ${c.fit.method}; R² ${f(c.fit.fit.r2, 3)}, leave-one-out error ${f(c.fit.fit.looErr * PCT, 0)}%):`);
      if (c.fit.coarser) out.push(`  (${c.fit.coarser})`);
      for (const x of c.rows.slice(0, 12)) out.push(`  ${pad(`${x.pass} · ${x.category}`, 44)} ${lpad(f(x.ms, 2), 7)} ms ± ${f(x.pm, 2)}`);
    } else if (c.fit) {
      out.push(`ms per cause: not estimated: ${c.fit.why}. To measure it: ${c.fit.propose}`);
    }
    if (c.coverage) out.push(`  counters cover ${c.coverage.passes.join(', ') || 'no pass'} (${f(c.coverage.countedMs, 2)} of ${f(c.coverage.frameMs, 2)} ms/frame, ${c.coverage.pixelShare === null ? '?' : Math.round(c.coverage.pixelShare * PCT) + '%'} of the scene's pixels); uncounted: ${c.coverage.uncounted.slice(0, 5).map((u) => `${u.name} ${f(u.ms, 2)}`).join(', ')}`);
  }
  if (r.target) { out.push(''); out.push(`» ${r.target.line}`); }
  if (r.passes.length > TEXT_PASSES) out.push(`… ${r.passes.length - TEXT_PASSES} more passes in the JSON`);
  if (r.cost) {
    out.push('');
    out.push(`work (agent C's cost counters, not time) on ${r.cost.pass}: ${f(r.cost.passMs, 3)} ms over ${r.cost.pixels} px = ${f(r.cost.nsPerPixel, 3)} ns/px (high above ${f(r.cost.highNsPerPixel, 3)})`);
    if (r.cost.trusted !== null) {
      out.push(`  ${r.cost.trusted ? `trusted: same picture as the live pipeline (${f(PCT * (r.cost.exactShare ?? 0), 2)} % bit-exact)` : `UNTRUSTED: ${r.cost.reason}`} · ${r.cost.path ?? '?'} · per pixel over ${r.cost.covered ?? '?'} covered px`);
    }
    const stages = r.cost.stages ? Object.entries(r.cost.stages) : [];
    // lanes: the busy-lane share over 8×4 blocks (gfx/costView.js laneShare): 100% = every lane of a 32-wide group
    // did the block's slowest pixel's work, low = most lanes waited on a few slow pixels
    if (stages.length) out.push(`  ${pad('', 24)} ${'total (mean p50 p95 max)'.padEnd(52)}${lpad('lanes', 6)}${stages.map(([k]) => lpad(`${k} mean`, 13) + lpad('lanes', 6)).join('')}`);
    else out.push(`  ${pad('', 24)} ${'(mean p50 p95 max)'.padEnd(52)}${lpad('lanes', 6)}`);
    const pctOf = (x) => (Number.isFinite(x) ? `${Math.round(x * PCT)}%` : '–');
    for (const [k, v] of Object.entries(r.cost.counters)) {
      const nrm = r.cost.normal?.[k];
      out.push(`  ${pad(k, 24)} mean ${lpad(f(v.mean), 8)}  p50 ${lpad(f(v.p50), 8)}  p95 ${lpad(f(v.p95), 8)}  max ${lpad(f(v.max), 8)}${lpad(pctOf(v.busyLanes), 6)}${stages.map(([, st]) => lpad(f(st.counters[k]?.mean), 13) + lpad(pctOf(st.counters[k]?.busyLanes), 6)).join('')}${nrm ? `  normal ${nrm[0]}–${nrm[1]}${r.cost.outside.includes(k) ? ' OUTSIDE' : ''}` : ''}`);
    }
    if (r.cost.divergence?.by) out.push(`  march busy lanes by block shape: ${Object.entries(r.cost.divergence.by).map(([k, x]) => `${k.replace('x', '×')} ${pctOf(x)}`).join(' · ')} (32 lanes; Apple's pixel packing isn't published)`);
    if (r.cost.flag) out.push(`  ⚑ ${r.cost.flag}`);
  }
  if (r.gpuCounters) {
    out.push('');
    out.push('GPU counters (agent D, tools/gpu-counters.mjs):');
    const g = r.gpuCounters;
    if (typeof g.text === 'string') out.push(...g.text.split('\n').map((l) => `  ${l}`));
    else out.push(`  ${JSON.stringify(g.summary ?? g).slice(0, 2000)}`);
  }
  if (r.notes.length) { out.push(''); for (const n of r.notes) out.push(`note: ${n}`); }
  return out.join('\n');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PHASE_HUE = { paint: 30, sim: 200, derived: 150, worldCopy: 165, worldFields: 135, worldLight: 180, blocks: 120, shadow: 260, gi: 300, view: 10, post: 45, other: 0 };

/** A self-contained HTML page: verdict, setup, the median frame's waterfall, the ranked passes, the heatmap. */
export function reportHtml(r, { heatmap = null, title = 'Profile' } = {}) {
  // with Metal's encoder times and no whole timestamp timeline: the passes' trusted ms laid end to end, in frame order
  let w = r.waterfall;
  if (r.timeSource === 'metal') {
    let at = 0;
    const seen = new Set(), passes = [];
    for (const p of (w?.passes ?? r.passes)) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      const ms = r.passes.find((x) => x.name === p.name)?.ms;
      if (!(ms > 0)) continue;
      passes.push({ name: p.name, kind: p.kind, phase: p.phase, start: at, gpu: ms });
      at += ms;
    }
    w = { frame: w?.frame ?? 'Metal', gpu: at, span: at, wall: w?.wall ?? null, interval: w?.interval ?? r.frames.interval.median, passes };
  }
  const scale = w ? Math.max(w.span ?? 0, w.interval ?? 0, MS_PER_S / CAP_FPS) : 1;
  const bars = w ? w.passes.map((p) => {
    const hue = PHASE_HUE[p.phase] ?? 0, sat = p.phase === 'other' ? 0 : 65;
    const left = p.start === null ? 0 : (p.start / scale) * PCT, width = p.gpu === null ? 0 : Math.max(0.15, (p.gpu / scale) * PCT);
    return `<div class="row"><span class="nm" title="${esc(p.name)}">${esc(p.name)}</span><span class="tr"><span class="bar" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:hsl(${hue} ${sat}% 52%)" title="${esc(p.name)} ${f(p.gpu, 3)} ms @ ${f(p.start, 3)}"></span></span><span class="ms">${f(p.gpu, 3)}</span></div>`;
  }).join('') : '<p>No frame with a whole timeline.</p>';
  const passRows = r.passes.map((p) => `<tr><td>${esc(p.name)}</td><td><i style="background:hsl(${PHASE_HUE[p.phase] ?? 0} ${p.phase === 'other' ? 0 : 65}% 52%)"></i>${esc(p.phase)}</td><td>${f(p.ms, 3)}–${f(p.msOwn, 3)}</td><td>${f(p.perFrame, 3)}</td><td>${f(p.median, 3)}</td><td>${f(p.p10, 3)}–${f(p.p90, 3)}</td><td>${f(p.count, 0)}</td><td>${p.share === null ? '–' : Math.round(p.share * PCT) + '%'}</td><td>${[p.noisy ? 'noisy' : '', p.failed ? 'untimed: ' + esc(p.error) : '', p.unlabelled ? 'unlabelled' : ''].filter(Boolean).join(' ')}</td></tr>`).join('');
  const phaseRows = r.phases.filter((p) => p.gpu.median || p.cpu.median).map((p) => `<tr><td>${esc(p.label)}</td><td>${f(p.gpu.median)}</td><td>${f(p.gpu.p10)}–${f(p.gpu.p90)}</td><td>${f(p.cpu.median)}</td></tr>`).join('');
  const marker = (ms, label) => `<span class="mk" style="left:${((ms / scale) * PCT).toFixed(3)}%"><b>${label}</b></span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#1b1d21;--mute:#667;--line:#e3e5ea;--bad:#b3261e;--ok:#1d7a3a;--track:#f3f4f7}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15171b;--fg:#e8eaee;--mute:#99a;--line:#2b2f36;--bad:#ff8a80;--ok:#7bd88f;--track:#1e2127}}
:root[data-theme="dark"]{--bg:#15171b;--fg:#e8eaee;--mute:#99a;--line:#2b2f36;--bad:#ff8a80;--ok:#7bd88f;--track:#1e2127}
body{background:var(--bg);color:var(--fg);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:16px;max-width:1200px}
h1{font-size:16px;margin:0 0 6px}h2{font-size:13px;margin:18px 0 6px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
.bad{color:var(--bad);font-weight:600}.ok{color:var(--ok);font-weight:600}.mute{color:var(--mute)}
ul{margin:4px 0;padding-left:18px}
.wf{border:1px solid var(--line);border-radius:6px;padding:6px;overflow:hidden}
.row{display:grid;grid-template-columns:minmax(120px,260px) 1fr 64px;gap:8px;align-items:center;height:16px}
.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ms{text-align:right}
.tr{position:relative;height:10px;background:var(--track);border-radius:2px}.bar{position:absolute;top:0;height:10px;border-radius:2px}
.axis{position:relative;height:16px;margin-left:calc(min(260px,40%) + 8px);margin-right:72px}.mk{position:absolute;top:0;border-left:1px dashed var(--mute);height:16px}.mk b{font-weight:400;font-size:11px;color:var(--mute);padding-left:3px}
table{border-collapse:collapse;width:100%}td,th{padding:2px 8px;border-bottom:1px solid var(--line);text-align:right}td:first-child,th:first-child{text-align:left;word-break:break-all}
td i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.scroll{overflow-x:auto}img{max-width:100%;border:1px solid var(--line);border-radius:6px}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="${r.trusted ? 'ok' : 'bad'}">${r.trusted ? 'Trusted capture' : 'UNTRUSTED: ' + esc(r.untrusted.join('; '))}</div>
<div class="mute">${esc(setupLine(r.setup ?? {}))}</div>
<ul>${r.verdict.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
<h2>Waterfall: median frame${w ? ` #${w.frame}, GPU sum ${f(w.gpu)} ms, span ${f(w.span)} ms` : ''}</h2>
<div class="wf"><div class="axis">${marker(0, '0')}${marker(MS_PER_S / CAP_FPS, `${f(MS_PER_S / CAP_FPS, 1)} ms (${CAP_FPS} fps)`)}${w?.interval ? marker(w.interval, `interval ${f(w.interval, 1)}`) : ''}</div>${bars}</div>
<h2>Phases</h2><div class="scroll"><table><tr><th>phase</th><th>GPU ms</th><th>p10–p90</th><th>CPU ms</th></tr>${phaseRows}</table></div>
<h2>Passes over ${r.frames.n} frames</h2><div class="scroll"><table><tr><th>pass</th><th>phase</th><th>Metal share–own</th><th>timestamp ms/frame</th><th>median</th><th>p10–p90</th><th>×/frame</th><th>share</th><th></th></tr>${passRows}</table></div>
${r.cost ? `<h2>Work (cost counters) on ${esc(r.cost.pass)}</h2><pre>${esc(JSON.stringify(r.cost, null, 1))}</pre>` : ''}
${heatmap ? `<h2>Cost heatmap</h2><img alt="per-pixel cost heatmap" src="${esc(heatmap)}">` : ''}
${r.gpuCounters ? `<h2>GPU counters</h2><pre>${esc(typeof r.gpuCounters.text === 'string' ? r.gpuCounters.text : JSON.stringify(r.gpuCounters, null, 1))}</pre>` : ''}
${r.notes.length ? `<h2>Notes</h2><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<h2>Setup</h2><pre>${esc(JSON.stringify(r.setup, null, 1))}</pre>
</body></html>`;
}
