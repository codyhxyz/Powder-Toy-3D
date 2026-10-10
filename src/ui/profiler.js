import { h } from './dom.js';
import { PHASES, HISTORY } from '../gfx/profiler.js';
import { MAX_FPS } from '../gfx/pacing.js';
import './profiler.css';

// Profiler overlay (Settings → Developer; the measuring is gfx/profiler.js): the
// last measured frame as a GPU waterfall, a few live numbers, and Copy for a
// plain-text report. Redrawn once per sample, never per frame. Only its buttons
// take the pointer; the rest lets input through to the canvas.

const MS_PER_S = 1000;
const BUDGET_MS = MS_PER_S / MAX_FPS;   // one frame at the frame cap: the waterfall spans at least this, marked
const COPIED_MS = 1500;                 // how long the Copy button reports the result
const DETAIL_ROWS = 8;                  // an open phase lists its costliest passes (the report lists all)
const MB = 1024 * 1024;
const MILLION = 1e6;
const PCT = 100;

const ms = (v) => (v == null ? '–' : v.toFixed(2));
const pct = (v) => `${v * PCT}%`;
const share = (v) => `${Math.round(v * PCT)}%`;
const gridText = ([nx, ny, nz]) => (nx === ny && ny === nz ? `${nx}³` : `${nx}×${ny}×${nz}`);
const sceneSize = (s) => s.canvas.map((n) => Math.max(1, Math.round(n * s.renderScale))).join('×');
const perStep = (s, v) => (s.steps && v != null ? v / s.steps : null);
const simPhase = (s) => s.phases.find((p) => p.id === 'sim');
const drawnText = (s, label) => (s.drawn == null ? '' : `${label}${share(s.drawn)}`);   // supertiles the step passes draw
const rateText = (s) => `${s.fps == null ? '–' : s.fps.toFixed(0)} fps · ${s.stepsPerSec == null ? '–' : s.stepsPerSec.toFixed(0)} steps/s`
  + ` · ${ms(perStep(s, simPhase(s).gpu))} ms/step`;

// Plain text for pasting into a chat.
function report(s) {
  const pad = (t, n) => String(t).padEnd(n);
  const num = (v) => ms(v).padStart(7);
  const lines = [
    `Powder Toy 3D profile, ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `GPU       ${s.gpuName}`,
    `grid      ${s.grid.join('×')} (${(s.grid.reduce((a, b) => a * b, 1) / MILLION).toFixed(2)}M cells), awake bricks ${share(s.awake)}${drawnText(s, ', supertiles drawn ')}`,
    `canvas    ${s.canvas.join('×')} at pixel ratio ${s.pixelRatio.toFixed(2)}; scene ${sceneSize(s)} (render scale ${s.renderScale.toFixed(2)})`,
    `rate      ${s.fps == null ? '–' : s.fps.toFixed(1)} fps, ${s.stepsPerSec == null ? '–' : s.stepsPerSec.toFixed(0)} steps/s; ${s.steps} steps in the sampled frame`,
    `sim step  ${ms(perStep(s, simPhase(s).gpu))} ms GPU, ${ms(perStep(s, simPhase(s).cpu))} ms CPU`,
    `memory    ${(s.memory / MB).toFixed(0)} MB in render targets and the canvas (estimate)`,
    `frame     ${ms(s.gpu)} ms GPU (one frame, each pass synced; ${ms(s.overhead)} ms sync cost subtracted per pass),`,
    `          ${ms(s.cpu)} ms CPU (mean of the unsynced frames); the sampled frame took ${ms(s.wall)} ms with its syncs`,
    '',
    `${pad('phase', 9)}${'gpu ms'.padStart(7)}${'cpu ms'.padStart(8)}  passes: gpu ms`,
    ...s.phases.map((p) => `${pad(p.label, 9)}${num(p.gpu)} ${num(p.cpu)}  ${p.detail.map((d) => `${d.name}${d.count > 1 ? `×${d.count}` : ''} ${ms(d.gpu)}`).join(', ')}`),
    `${pad('total', 9)}${num(s.gpu)} ${num(s.cpu)}`,
    '',
    `recent sampled GPU totals, ms: ${s.totals.map((t) => t.toFixed(1)).join(' ')}`,
  ];
  return lines.join('\n');
}

export function createProfilerPanel() {
  const status = h('span.status', { title: 'Once a second one frame is measured: after each pass the CPU waits for the GPU,'
    + ' and the cost of that wait (sync) is subtracted. Timings assume nothing else is using the GPU.' });
  const copy = h('button.copy', { type: 'button', text: 'Copy', title: 'Copy a plain-text report' });
  const rates = h('div.line'), state = h('div.line');
  const rows = PHASES.map((p) => {
    const cpu = h('span.num'), gpu = h('span.num'), track = h('span.track');
    const detail = h('div.detail', { style: { '--c': `var(--prof-${p.id})` } });
    const row = h('button.row', { type: 'button', title: `${p.label}: show its passes`, style: { '--c': `var(--prof-${p.id})` } },
      h('span.name', { text: p.label }), cpu, gpu, track);
    return { cpu, gpu, track, detail, row };
  });
  // one phase's passes open at a time
  rows.forEach((r) => r.row.addEventListener('click', () => {
    const open = !r.row.classList.contains('open');
    rows.forEach((o) => { o.row.classList.toggle('open', open && o === r); o.detail.classList.toggle('open', open && o === r); });
  }));
  const bars = (segs, span) => segs.map(([a, b]) => h('i', { style: { left: pct(a / span), width: pct((b - a) / span) } }));
  const totalCpu = h('span.num'), totalGpu = h('span.num'), totalTrack = h('span.track');
  const spark = [...Array(HISTORY)].map(() => h('i'));
  const el = h('div.prof', { role: 'region', 'aria-label': 'Profiler' },
    h('header', {}, h('b', { text: 'Profiler' }), status, copy),
    rates, state,
    h('div.row.head', {}, h('span.name', { text: 'phase' }), h('span.num', { text: 'cpu' }), h('span.num', { text: 'gpu' }),
      h('span', { text: 'GPU timeline (ms)' })),
    rows.flatMap((r) => [r.row, r.detail]),
    h('div.row.total', {}, h('span.name', { text: 'frame' }), totalCpu, totalGpu, totalTrack),
    h('div.spark', { title: `GPU time of the last ${HISTORY} sampled frames (line: ${BUDGET_MS.toFixed(1)} ms, ${MAX_FPS} fps)` }, spark));
  document.body.append(el);

  let last = null, lastRates = '';
  let copyTimer = 0;
  copy.addEventListener('click', async () => {
    if (!last) return;
    const text = report(last);
    let ok = true;
    try { await navigator.clipboard.writeText(text); } catch { ok = false; console.info(text); }
    copy.textContent = ok ? 'Copied' : 'Copy failed (see console)';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copy.textContent = 'Copy'; }, COPIED_MS);
  });

  function idle() {
    status.textContent = 'idle: nothing is rendering';
    rates.textContent = last ? `idle (last sample: ${lastRates})` : 'idle';
    el.classList.add('idle');
  }

  return {
    show(v) {
      el.classList.toggle('show', v);
      if (v && !last) { status.textContent = 'waiting for a frame'; rates.textContent = state.textContent = ''; }
    },
    // s: a sample from gfx/profiler.js, or null when rendering went idle
    update(s) {
      if (!s) { idle(); return; }
      last = s;
      el.classList.remove('idle');
      status.textContent = `sampled · sync ${ms(s.overhead)} ms`;
      lastRates = rateText(s);
      rates.textContent = lastRates;
      state.textContent = `awake ${share(s.awake)}${drawnText(s, ' · drawn ')} · ${(s.memory / MB).toFixed(0)} MB · ${gridText(s.grid)} · ${s.canvas.join('×')}`
        + (s.renderScale < 1 ? ` → ${sceneSize(s)}` : '');
      const span = Math.max(s.gpu, BUDGET_MS);
      rows.forEach((r, i) => {
        const p = s.phases[i];
        r.cpu.textContent = ms(p.cpu);
        r.gpu.textContent = ms(p.gpu);
        r.track.replaceChildren(...bars(p.segs, span));
        const byCost = [...p.detail].sort((x, y) => y.gpu - x.gpu);
        const rest = byCost.slice(DETAIL_ROWS);
        const subs = byCost.slice(0, DETAIL_ROWS).map((d) => h('div.row.sub', {},
          h('span.name', { text: d.count > 1 ? `${d.name} ×${d.count}` : d.name }), h('span.num', { text: ms(d.gpu) }),
          h('span.track', {}, bars(d.segs, span))));
        if (rest.length) {
          subs.push(h('div.row.sub', {}, h('span.name', { text: `+${rest.length} more` }),
            h('span.num', { text: ms(rest.reduce((t, d) => t + d.gpu, 0)) })));
        }
        r.detail.replaceChildren(...subs);
      });
      totalCpu.textContent = ms(s.cpu);
      totalGpu.textContent = ms(s.gpu);
      totalTrack.replaceChildren(h('i', { style: { width: pct(s.gpu / span) } }));
      // the frame budget, as a tick on every track and a line over the strip
      const top = Math.max(BUDGET_MS, ...s.totals);
      el.style.setProperty('--budget', pct(BUDGET_MS / span));
      el.style.setProperty('--spark-budget', pct(BUDGET_MS / top));
      spark.forEach((bar, i) => {
        const t = s.totals[i - (HISTORY - s.totals.length)];
        bar.style.height = t == null ? '0' : pct(t / top);
        bar.classList.toggle('over', t > BUDGET_MS);
      });
    },
  };
}
