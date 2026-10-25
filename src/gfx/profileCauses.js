// What to fix and what each fix buys (docs/profiler.md, "Trusted ms" and "ms per cause"),
// on top of gfx/profileReport.js. Pure: tools/profile.mjs and tools/profile-cpu-check.mjs run it.
//
//   metalTimes     per-pass GPU ms from Metal's own per-encoder times (tools/gpu-counters.mjs),
//                  mapped onto the report's passes by label (gpu/timing.js gives Metal encoders
//                  the profiler's pass names, tagged with the pose they were timed in). On Apple's
//                  tilers render-pass timestamps can span whole submissions; Metal's encoder times
//                  don't, so they are the authoritative ms when present.
//   estimateCauses the pass's ms split into counter categories (agent C's cost counters), by a
//                  non-negative least-squares fit of ms on counter totals over every (pose, pass)
//                  observation one run captures. Printed only when the fit is honest: enough
//                  observations, columns that aren't collinear, and a leave-one-out error that is
//                  small; otherwise it says why and what to capture instead.
//   targetVerdict  frame ms vs a target (--target, or the compare file's), and what must drop.
//   compareCauses  category and pass deltas in ms between two runs on the same pixels.

export const POSE_TAG = '@';          // gpu/timing.js labelTag: "<pass>@<pose index>" in Metal, "@-" outside the timed frames
export const UNTIMED_TAG = '@-';
// counter categories (C's keys, gfx/costView.js COST_COUNTERS): what one fix acts on
export const CATEGORIES = {
  march: ['march'],
  cellStepsOwn: ['cellStepsOwn'],
  cellStepsDilated: ['cellStepsDilated'],
  cellStepsInterior: ['cellStepsInterior'],
  skips: ['skipBrick', 'skip16', 'skip64'],
  fieldReads: ['fieldReads'],
  cellReads: ['cellReads'],
  shading: ['shading'],
  shadows: ['shadowSteps', 'sunShadow'],
  near: ['nearSteps'],
  reflections: ['reflSteps', 'refractions', 'rootIters'],
};
// Coarser groupings of those categories, tried in order when the run has too few observations
// (or collinear ones) for the finer: the estimate is as fine as the data honestly allows.
export const CATEGORY_LEVELS = [
  null,   // the categories above
  { traversal: ['march', 'cellStepsOwn', 'cellStepsDilated', 'cellStepsInterior', 'skips'], reads: ['fieldReads', 'cellReads'],
    lighting: ['shading', 'shadows', 'near'], reflections: ['reflections'] },
  { traversal: ['march', 'cellStepsOwn', 'cellStepsDilated', 'cellStepsInterior', 'skips'], memory: ['fieldReads', 'cellReads'],
    shading: ['shading', 'shadows', 'near', 'reflections'] },
  { traversal: ['march', 'cellStepsOwn', 'cellStepsDilated', 'cellStepsInterior', 'skips'], rest: ['fieldReads', 'cellReads', 'shading', 'shadows', 'near', 'reflections'] },
];
/** Observations' category sums regrouped by a CATEGORY_LEVELS entry. */
export function regroup(sums, level) {
  if (!level) return sums;
  const out = {};
  for (const [g, cats] of Object.entries(level)) { const v = cats.reduce((t, c) => t + (sums[c] ?? 0), 0); if (v > 0) out[g] = v; }
  return out;
}
export const FIT_MIN_EXTRA = 2;        // observations beyond the fitted categories (degrees of freedom for the error)
export const FIT_MAX_LOO = 0.25;       // leave-one-out error over the mean ms: above this the fit doesn't predict
export const FIT_MAX_CORR = 0.95;      // two categories this correlated over the observations can't be told apart
export const FRAME_AGREE = 0.1;        // passes' frame-count estimates within this share of their median: one window
const NNLS_ITERS = 2000;

// ---------- Metal times ----------

/** "<name>@<pose>" → [name, pose] (pose null untagged, '-' outside the timed frames). */
export function splitTag(label) {
  const i = label.lastIndexOf(POSE_TAG);
  if (i <= 0) return [label, null];
  return [label.slice(0, i), label.slice(i + 1)];
}

/**
 * Per-pass Metal ms per frame for one pose's report. byEncoder: tools/gpu-counters.mjs's rows
 * ({ label, count, totalMs }). The frames in the window come from the trace itself: each
 * once-a-frame pass's encoder count over its count per frame; they must agree.
 */
export function metalTimes(report, byEncoder, pose) {
  const rows = byEncoder.map((e) => { const [name, tag] = splitTag(e.label); return { ...e, name, tag }; })
    .filter((e) => (pose === null ? e.tag === null : e.tag === String(pose)));
  const ours = new Map(report.passes.map((p) => [p.name, p]));
  // The frames the pose's tag covered, from once-a-frame passes' encoder counts (for unlabelled
  // Metal time per frame, and the disagreement note). Render passes when there are any: the pump
  // draws every frame, while sim passes skip frames (Lab, 2026-10-25: the median over all passes
  // read 18 for 30 timed frames).
  const estimatesOf = (kind) => {
    const out = [];
    for (const e of rows) {
      const p = ours.get(e.name);
      if (p && p.presence === 1 && p.count && (!kind || p.kind === kind)) out.push(e.count / p.count);
    }
    return out.sort((a, b) => a - b);
  };
  const renderEst = estimatesOf('render');
  const estimates = renderEst.length ? renderEst : estimatesOf(null);
  const frames = estimates.length ? estimates[Math.floor((estimates.length - 1) / 2)] : null;
  const agree = frames ? estimates.filter((x) => Math.abs(x - frames) <= FRAME_AGREE * frames).length / estimates.length : 0;
  const perPass = {}, unattributed = [], disagree = [];
  for (const e of rows) {
    const p = ours.get(e.name);
    if (p) {
      // Metal's mean GPU ms per run of the pass, times how often the pass runs per timed frame (the
      // report's count × presence). Not Metal's total over a frame count: under load the trace drops
      // intervals (Lab, 2026-10-25: GI and shadow passes' encoder counts at half the timed frames
      // while the timestamps saw them every frame), so its counts are lower bounds, its durations not.
      const perFrame = (p.count ?? 0) * (p.presence ?? 0);
      if (!(e.count > 0) || !(perFrame > 0)) continue;
      perPass[e.name] = (perPass[e.name] ?? 0) + (e.totalMs / e.count) * perFrame;
      const implied = p.presence === 1 && p.count ? e.count / p.count : null;
      if (implied !== null && frames && Math.abs(implied - frames) > FRAME_AGREE * frames) disagree.push(e.name);   // (said, not dropped)
    } else if (!/^cost view/.test(e.name)) unattributed.push({ label: e.label, ms: frames ? e.totalMs / frames : null, count: e.count });
  }
  const total = Object.values(perPass).reduce((a, b) => a + b, 0) + unattributed.reduce((a, b) => a + (b.ms ?? 0), 0);
  return { frames, agree, perPass, disagree, unattributed: unattributed.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)), total,
    trusted: !!frames && rows.length > 0 };
}

/**
 * Makes Metal's per-pass ms the report's authoritative time (pass.ms, report.timeSource), and
 * demotes timestamp-only distrust to a note (the times no longer come from timestamps).
 */
export function applyMetal(report, metal) {
  report.metal = { frames: metal.frames, agree: metal.agree, disagree: metal.disagree ?? [], unattributed: metal.unattributed.slice(0, 12), total: metal.total, trusted: metal.trusted };
  if (!metal.trusted) {
    report.untrusted.push(`no Metal encoder carries this pose's tag: per-pass Metal times unavailable`);
    report.trusted = false;
    for (const p of report.passes) p.ms = p.perFrame;
    report.timeSource = 'timestamps';
    return report;
  }
  report.timeSource = 'metal';
  const TS = /timestamps|whole submissions|passes overlap|whole timeline/;
  const ts = report.untrusted.filter((u) => TS.test(u));
  const stampsOk = ts.length === 0;
  for (const p of report.passes) {
    p.timestampMs = p.perFrame;
    const m = metal.perPass[p.name];
    // Metal's when it has the pass; else the timestamp only when timestamps are trusted; else unknown, said why
    if (m !== undefined) { p.ms = m; p.msSource = 'metal'; }
    else if (stampsOk) { p.ms = p.perFrame; p.msSource = 'timestamps'; }
    else { p.ms = null; p.msSource = metal.disagree?.includes(p.name) ? 'none: Metal encoder count off the frames' : `none: no labelled Metal encoder${p.kind === 'render' ? ' (render pass)' : ''}`; }
  }
  const unknown = report.passes.filter((p) => p.ms === null && (p.timestampMs ?? 0) > 0);
  const unknownMs = unknown.reduce((s, p) => s + p.timestampMs, 0), stampSum = report.passes.reduce((s, p) => s + (p.timestampMs ?? 0), 0);
  if (ts.length) {
    report.untrusted = report.untrusted.filter((u) => !TS.test(u));
    report.notes.push(`timestamps untrusted (${ts.join('; ')}); per-pass ms come from Metal's encoder times`);
    // passes Metal didn't name stay unknown: the report is untrusted while they hold real time
    if (unknown.length && unknownMs > 0.05 * stampSum) report.untrusted.push(`${unknown.length} passes have no trusted ms (${unknown.slice(0, 5).map((p) => p.name).join(', ')}: ${unknown[0].msSource}); their timestamps (${unknownMs.toFixed(1)} ms) are not trusted on this GPU`);
    report.trusted = report.untrusted.length === 0;
  }
  report.passes.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1));
  const unat = metal.unattributed.reduce((s, u) => s + (u.ms ?? 0), 0);
  if (unat > 0.05 * metal.total) report.notes.push(`${unat.toFixed(2)} ms/frame of Metal GPU time has no pass label (${metal.unattributed.slice(0, 3).map((u) => u.label).join(', ')})`);
  report.frames.metalMs = metal.total;
  // Metal's per-pass ms are shares of the GPU's busy time (gpu-counters.mjs exclusiveShares), so they
  // can't honestly sum past the frame's GPU span; if they do, the per-run means or the run counts are off
  const span = report.frames.span?.median ?? report.frames.gpu?.median;
  const metalSum = report.passes.reduce((s, p) => s + (p.msSource === 'metal' ? p.ms : 0), 0);
  if (Number.isFinite(span) && span > 0 && metalSum > span * (1 + FRAME_AGREE)) {
    report.untrusted.push(`Metal per-pass ms (${metalSum.toFixed(2)}) exceed the frame's GPU span (${span.toFixed(2)} ms)`);
    report.trusted = false;
  }
  return report;
}

// ---------- ms per cause ----------

/** A cost capture's per-pass category totals: [{ pass, sums: { category: total } }]. */
export function categoryTotals(cost) {
  if (!cost?.counters) return [];
  const sumOf = (counters) => Object.fromEntries(Object.entries(CATEGORIES).map(([cat, keys]) => [cat,
    keys.reduce((s, k) => s + (Number.isFinite(counters[k]?.sum) ? counters[k].sum : 0), 0)]).filter(([, v]) => v > 0));
  if (cost.stages) return Object.values(cost.stages).map((st) => ({ pass: st.pass, sums: sumOf(st.counters), covered: st.covered }));
  return [{ pass: cost.pass ?? 'scene', sums: sumOf(cost.counters), covered: cost.covered }];
}

// non-negative least squares (projected coordinate descent on the normal equations)
export function nnls(X, y) {
  const n = X.length, k = X[0]?.length ?? 0;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const b = Array.from({ length: k }, (_, i) => X.reduce((s, r, t) => s + r[i] * y[t], 0));
  const beta = new Array(k).fill(0);
  for (let it = 0; it < NNLS_ITERS; it++) {
    let moved = 0;
    for (let i = 0; i < k; i++) {
      if (A[i][i] <= 0) continue;
      let r = b[i];
      for (let j = 0; j < k; j++) if (j !== i) r -= A[i][j] * beta[j];
      const v = Math.max(0, r / A[i][i]);
      moved = Math.max(moved, Math.abs(v - beta[i]) * Math.sqrt(A[i][i]));
      beta[i] = v;
    }
    if (moved < 1e-12) break;
  }
  return beta;
}

const corr = (a, b) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? sab / Math.sqrt(sa * sb) : 1;
};

/**
 * observations: [{ pose, pass, ms, sums: { category: total } }] (ms: the pass's trusted ms per
 * frame in that pose; sums: C's counter totals in the same pass and pose). Returns the fit, or
 * { ok: false, why, propose } when it can't be estimated honestly.
 */
export function estimateCauses(observations) {
  // the finest grouping the observations support
  let first = null;
  for (let i = 0; i < CATEGORY_LEVELS.length; i++) {
    const level = CATEGORY_LEVELS[i];
    const fit = fitLevel(observations.map((o) => ({ ...o, sums: o.sums && regroup(o.sums, level) })));
    fit.level = i;
    fit.groups = level;
    if (fit.ok) {
      if (first && i > 0) fit.coarser = `the finer categories didn't fit (${first.why}): grouped as ${Object.keys(level).join(', ')}`;
      return fit;
    }
    first ??= fit;
  }
  return first;
}

function fitLevel(observations) {
  const obs = observations.filter((o) => Number.isFinite(o.ms) && o.ms > 0 && o.sums && Object.keys(o.sums).length);
  const cats = [...new Set(observations.filter((o) => o.sums).flatMap((o) => Object.keys(o.sums)))].filter((c) => observations.some((o) => (o.sums?.[c] ?? 0) > 0));
  const need = cats.length + FIT_MIN_EXTRA;
  const propose = `capture ≥ ${need} (pose, pass) observations whose counter mixes differ: node tools/profile.mjs --poses default,landDown,sky,horizon[,x,y,z,tx,ty,tz…]`
    + ` on the map, or knock a category out (its detail switch off) and compare the two reports`;
  if (obs.length < need) return { ok: false, categories: cats, n: obs.length, why: `${obs.length} observations with a trusted ms for ${cats.length} categories (need ${need})`, propose };
  // scale columns (counts are ~1e6–1e9) so the fit is well conditioned
  const scale = cats.map((c) => Math.max(...obs.map((o) => o.sums[c] ?? 0)) || 1);
  const X = obs.map((o) => cats.map((c, j) => (o.sums[c] ?? 0) / scale[j]));
  const y = obs.map((o) => o.ms);
  let worst = null;
  for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) {
    const r = corr(X.map((x) => x[i]), X.map((x) => x[j]));
    if (Math.abs(r) > FIT_MAX_CORR && (!worst || Math.abs(r) > Math.abs(worst.r))) worst = { a: cats[i], b: cats[j], r };
  }
  if (worst) return { ok: false, categories: cats, n: obs.length, why: `${worst.a} and ${worst.b} rise and fall together over these observations (r = ${worst.r.toFixed(3)}): their costs can't be told apart`, propose };
  const beta = nnls(X, y);
  const predict = (b, x) => x.reduce((s, v, j) => s + v * b[j], 0);
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssRes = y.reduce((s, v, i) => s + (v - predict(beta, X[i])) ** 2, 0);
  // leave-one-out: refit without each observation, predict it
  const loo = y.map((v, i) => {
    const b = nnls(X.filter((_, t) => t !== i), y.filter((_, t) => t !== i));
    return Math.abs(v - predict(b, X[i]));
  });
  const looErr = loo.reduce((a, b) => a + b, 0) / loo.length / meanY;
  const perUnit = Object.fromEntries(cats.map((c, j) => [c, beta[j] / scale[j]]));   // ms per counted unit
  const fit = { r2: ssTot ? 1 - ssRes / ssTot : null, looErr, n: obs.length, k: cats.length };
  if (looErr > FIT_MAX_LOO) return { ok: false, categories: cats, n: obs.length, fit, perUnit, why: `leave-one-out error ${(looErr * 100).toFixed(0)}% of the mean ms (over ${FIT_MAX_LOO * 100}%): the categories don't predict the time`, propose };
  return { ok: true, categories: cats, perUnit, fit,
    method: `non-negative least squares of each pass's trusted ms on its counter totals over ${obs.length} (pose, pass) observations; ± is the leave-one-out error` };
}

/** One pose's ms by category: perUnit × that pose's totals, ± the fit's leave-one-out error share. */
export function causesFor(fit, totals) {
  if (!fit?.ok) return null;
  const rows = [];
  for (const t of totals) for (const [cat, sum] of Object.entries(regroup(t.sums, fit.groups ?? null))) {
    if (!(cat in fit.perUnit)) continue;
    const ms = fit.perUnit[cat] * sum;
    rows.push({ pass: t.pass, category: cat, ms, pm: ms * fit.fit.looErr });
  }
  return rows.sort((a, b) => b.ms - a.ms);
}

// ---------- verdict against a target ----------

/** frameMs: this run's GPU ms per frame; items: [{ name, ms, delta? }] costliest first. */
export function targetVerdict(frameMs, targetMs, items, { source = 'target' } = {}) {
  if (!Number.isFinite(frameMs) || !Number.isFinite(targetMs)) return null;
  const over = frameMs - targetMs;
  if (over <= 0) return { over, line: `frame ${frameMs.toFixed(1)} ms is within the ${targetMs.toFixed(1)} ms ${source} (${(-over).toFixed(1)} ms spare)`, cuts: [] };
  // by delta vs the target build when known (what this build added), else by size
  const ranked = [...items].filter((x) => (x.delta ?? x.ms) > 0).sort((a, b) => (b.delta ?? b.ms) - (a.delta ?? a.ms));
  const cuts = [];
  let left = over;
  for (const x of ranked) {
    if (left <= 0) break;
    const can = x.delta ?? x.ms;
    const cut = Math.min(can, left);
    cuts.push({ name: x.name, by: cut, of: x.ms, delta: x.delta ?? null });
    left -= cut;
  }
  const what = cuts.map((c) => `${c.name} −${c.by.toFixed(1)} ms (of ${c.of.toFixed(1)}${c.delta !== null ? `, +${c.delta.toFixed(1)} vs ${source}` : ''})`).join(', ');
  return { over, line: `frame ${frameMs.toFixed(1)} ms vs ${targetMs.toFixed(1)} ms ${source}: to reach it, cut ${over.toFixed(1)} ms: ${what}${left > 0.05 ? ` (still ${left.toFixed(1)} ms short: nothing listed covers it)` : ''}`, cuts };
}

// ---------- compare two runs by category ----------

/** a, b: reports (b the newer). Category ms (when both have a fit) and work per covered pixel. */
export function compareCauses(a, b) {
  const rows = new Map();
  const add = (r, side) => {
    for (const c of r.causes?.rows ?? []) {
      const k = `${c.pass}:${c.category}`;
      const x = rows.get(k) ?? { pass: c.pass, category: c.category, a: null, b: null, workA: null, workB: null };
      x[side] = (x[side] ?? 0) + c.ms;
      rows.set(k, x);
    }
    for (const t of r.causes?.totals ?? []) for (const [cat, sum] of Object.entries(t.sums)) {
      const k = `${t.pass}:${cat}`;
      const x = rows.get(k) ?? { pass: t.pass, category: cat, a: null, b: null, workA: null, workB: null };
      x[side === 'a' ? 'workA' : 'workB'] = t.covered ? sum / t.covered : null;
      rows.set(k, x);
    }
  };
  add(a, 'a'); add(b, 'b');
  const coverage = (r) => r.causes?.coverage ?? null;
  return {
    rows: [...rows.values()].map((x) => ({ ...x, delta: x.a !== null && x.b !== null ? x.b - x.a : null }))
      .sort((p, q) => Math.abs(q.delta ?? 0) - Math.abs(p.delta ?? 0)),
    coverage: { a: coverage(a), b: coverage(b) },
  };
}
