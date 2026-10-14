import { h } from './dom.js';
import { ICON } from './icons.js';
import { PHASES, HISTORY, FRAMES } from '../gfx/profiler.js';
import { MAX_FPS } from '../gfx/pacing.js';
import './profiler.css';

// Profiler overlay (Settings → Developer; the measuring is gfx/profiler.js): live
// frame rate and frame time, a frame-time bar graph for spotting spikes, the last
// sampled frame as a GPU waterfall, and Copy for a plain-text report. The graph
// is one 2D canvas redrawn per frame; the DOM is rewritten once per sample and
// the live numbers a few times a second. Only the buttons and the graph (hover
// one bar to read that frame and hold the graph still) take the pointer; the
// rest lets input through to the canvas.

const MS_PER_S = 1000;
const BUDGET_MS = MS_PER_S / MAX_FPS;   // one frame at the frame cap: the waterfall spans at least this, marked
const COPIED_MS = 1500;                 // how long the Copy button reports the result
const DETAIL_ROWS = 8;                  // an open phase lists its costliest passes (the report lists all)
const MB = 1024 * 1024;
const MILLION = 1e6;
const PCT = 100;
// the frame-time graph; the bar colours follow how many refreshes a frame took
const GRAPH_H = 72;                 // CSS px
const LIVE_MS = 250;                // between rewrites of the live numbers
const SLOW = 1.25;                  // × the budget: a frame this long missed its refresh (amber)
const SPIKE = 1.75;                 // × the budget: a spike, two refreshes or more (red; counted)
const SCALES = [2, 4, 6, 12];       // × the budget: the graph's top, the least that fits the window
const GUIDES = [1, 2];              // × the budget: lines labelled with their frame rate (60, 30 fps)
const WAIT_ALPHA = 0.38;            // a bar's part past its own CPU work (GPU, vsync, the browser)
const LABEL_PAD = 3;                // CSS px, a guide's label from the graph edge
const TOP_PHASES = 3;               // phases a hovered frame lists by CPU time
const PHASE_MIN_MS = 0.05;          // …if they took at least this


const ms = (v) => (v == null ? '–' : v.toFixed(2));
const pct = (v) => `${v * PCT}%`;
const share = (v) => `${Math.round(v * PCT)}%`;
const gridText = (g) => (!g ? 'no grid' : g[0] === g[1] && g[1] === g[2] ? `${g[0]}^3` : g.join('×'));
const sceneSize = (s) => s.canvas.map((n) => Math.max(1, Math.round(n * s.renderScale))).join('×');
const perStep = (s, v) => (s.steps && v != null ? v / s.steps : null);
const simPhase = (s) => s.phases.find((p) => p.id === 'sim');
const drawnText = (s, label) => (s.drawn == null ? '' : `${label}${share(s.drawn)}`);   // bricks the step's kernels run over
const rateText = (s) => `${s.fps == null ? '–' : s.fps.toFixed(0)} fps · ${s.stepsPerSec == null ? '–' : s.stepsPerSec.toFixed(0)} steps/s`
  + ` · ${ms(perStep(s, simPhase(s).gpu))} ms/step`;

// The frames in the ring, oldest first: i-th → slot.
const slotOf = (f, i) => (f.head + i) % FRAMES;

// avg / worst / spikes over the window
function frameStats(f) {
  let sum = 0, worst = 0, spikes = 0;
  const n = f.count;
  for (let i = 0; i < n; i++) {
    const v = f.ms[slotOf(f, i)];
    sum += v;
    if (v > worst) worst = v;
    if (v > SPIKE * BUDGET_MS) spikes++;
  }
  return n ? { avg: sum / n, worst, spikes } : null;
}

// One frame in words: its time, its CPU work and the phases that took most of it.
function frameText(f, i) {
  const k = slotOf(f, i), P = PHASES.length;
  const top = PHASES.map((p, j) => [p.label, f.phases[k * P + j]]).sort((a, b) => b[1] - a[1]).slice(0, TOP_PHASES)
    .filter(([, v]) => v >= PHASE_MIN_MS).map(([l, v]) => `${l} ${v.toFixed(1)}`).join(' · ');
  return `${f.ms[k].toFixed(1)} ms · CPU ${f.work[k].toFixed(1)}${top ? `: ${top}` : ''}`;
}

// Plain text for pasting into a chat.
function report(s) {
  const pad = (t, n) => String(t).padEnd(n);
  const num = (v) => ms(v).padStart(7);
  const lines = [
    `Powder Toy 3D profile, ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `GPU       ${s.gpuName}`,
    `grid      ${s.grid ? `${s.grid.join('×')} (${(s.grid.reduce((a, b) => a * b, 1) / MILLION).toFixed(2)}M cells)` : 'none'}, awake bricks ${s.awake == null ? '–' : share(s.awake)}${drawnText(s, ', bricks drawn ')}`,
    `canvas    ${s.canvas.join('×')} at pixel ratio ${s.pixelRatio.toFixed(2)}; scene ${sceneSize(s)} (render scale ${s.renderScale.toFixed(2)})`,
    `rate      ${s.fps == null ? '–' : s.fps.toFixed(1)} fps, ${s.stepsPerSec == null ? '–' : s.stepsPerSec.toFixed(0)} steps/s; ${s.steps} steps in the sampled frame`,
    `sim step  ${ms(perStep(s, simPhase(s).gpu))} ms GPU, ${ms(perStep(s, simPhase(s).cpu))} ms CPU`,
    `memory    ${(s.memory / MB).toFixed(0)} MB in our buffers and textures, three's targets and the canvas`,
    `frame     ${ms(s.gpu)} ms GPU pass time (Three.js included${s.split ? '; split dispatches' : ''}),`,
    `coverage  ${s.coverage ? `${s.coverage.timed}/${s.coverage.observed} passes timed; ${s.coverage.complete ? 'complete' : 'INCOMPLETE — total unavailable'}` : 'no timestamps'}`,
    ...(s.coverage?.missing ?? []).map(p => `missing   ${p.name}: ${p.error}`),
    ...(s.coverage?.complete && !s.coverage.timelineComplete ? ['timeline  unavailable: inconsistent cross-submission GPU timestamps; pass durations retained'] : []),
    `scope     pass durations can overlap; excludes copies/uploads, browser compositor and other devices; timeline preserves gaps`,
    `          ${ms(s.cpu)} ms CPU (mean of the frames since the last sample); the sampled frame took ${ms(s.wall)} ms of CPU`,
    '',
    `${pad('phase', 9)}${'gpu ms'.padStart(7)}${'cpu ms'.padStart(8)}  passes: gpu ms`,
    ...s.phases.map((p) => `${pad(p.label, 9)}${num(p.gpu)} ${num(p.cpu)}  ${p.detail.map((d) => `${d.name}${d.count > 1 ? `×${d.count}` : ''} ${ms(d.gpu)}`).join(', ')}`),
    `${pad('total', 9)}${num(s.gpu)} ${num(s.cpu)}`,
    '',
    `recent sampled GPU totals, ms: ${s.totals.map((t) => t.toFixed(1)).join(' ')}`,
  ];
  return lines.join('\n');
}

export function createProfilerPanel({ onClose } = {}) {
  const status = h('span.status', { title: 'Once a second the latest frame whose GPU timestamps have come back is shown:'
    + ' Every pass on the shared GPU device is observed, including Three.js. Missing timings invalidate the total.'
    + ' Timings assume nothing else is using the GPU.' });
  const close = h('button.close', { type: 'button', title: 'Close the profiler', 'aria-label': 'Close the profiler', html: ICON.close, on: { click: () => onClose?.() } });
  const copy = h('button.copy', { type: 'button', text: 'Copy', title: 'Copy a plain-text report' });
  const tile = (key, title) => {
    const v = h('b', { text: '–' });
    return { v, el: h('div.prof-tile', { title }, v, h('span', { text: key })) };
  };
  const tFps = tile('fps', 'Frames per second over the graph\'s window');
  const tFrame = tile('ms / frame', `Mean frame time over the graph's window (${BUDGET_MS.toFixed(1)} ms at ${MAX_FPS} fps)`);
  const tCpu = tile('cpu ms', 'CPU time of a frame (mean of the frames since the last sample)');
  const tGpu = tile('gpu ms', 'Sum of GPU pass durations, including Three.js. Passes can overlap; copies/uploads and the browser compositor are excluded.');
  const canvas = h('canvas', { style: { height: `${GRAPH_H}px` } });
  const ctx = canvas.getContext('2d');
  const gline = h('div.gline');
  const rates = h('div.line'), state = h('div.line.faint'), size = h('div.line.faint');
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
    h('header', {}, h('b', { text: 'Profiler' }), status, copy, close),
    h('div.prof-tiles', {}, tFps.el, tFrame.el, tCpu.el, tGpu.el),
    h('div.section', {}, h('span', { text: 'Frame time' }), h('span.prof-hint', { text: 'hover a bar to hold' })),
    h('div.graph', {}, canvas),
    gline,
    rates, state, size,
    h('div.section', {}, h('span', { text: 'GPU passes' }), h('span.prof-hint', { text: 'one sampled frame · click a phase' })),
    h('div.row.head', {}, h('span.name', { text: 'phase' }), h('span.num', { text: 'cpu' }), h('span.num', { text: 'gpu' }),
      h('span', { text: 'timeline (ms)' })),
    rows.flatMap((r) => [r.row, r.detail]),
    h('div.row.total', {}, h('span.name', { text: 'pass sum' }), totalCpu, totalGpu, totalTrack),
    h('div.spark', { title: `GPU time of the last ${HISTORY} sampled frames (line: ${BUDGET_MS.toFixed(1)} ms, ${MAX_FPS} fps)` }, spark));
  document.body.append(el);

  let last = null, lastRates = '', shown = false;
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

  // ---- the frame-time graph: newest frame on the right, one bar per frame
  let ring = null;     // the profiler's frame ring
  let held = null;     // a copy of it while the pointer is on the graph
  let hover = -1;      // the hovered frame (index, oldest first) in `held`
  let colors = null;   // read from the CSS once shown
  let lastLive = -Infinity;
  const readColors = () => {
    const cs = getComputedStyle(el), v = (n) => cs.getPropertyValue(n).trim();
    colors = { ok: v('--prof-ok'), slow: v('--prof-slow'), over: v('--prof-over'),
      guide: v('--prof-tick'), label: v('--faint'), hover: v('--text') };
  };
  const barColor = (v) => (v > SPIKE * BUDGET_MS ? colors.over : v > SLOW * BUDGET_MS ? colors.slow : colors.ok);

  function draw() {
    const f = held ?? ring;
    const w = canvas.clientWidth, H = GRAPH_H, dpr = devicePixelRatio || 1;
    if (!w || !f) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(H * dpr);
    }
    if (!colors) readColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    let max = 0;
    for (let i = 0; i < f.count; i++) max = Math.max(max, f.ms[slotOf(f, i)]);
    const top = BUDGET_MS * (SCALES.find((m) => m * BUDGET_MS >= max) ?? SCALES[SCALES.length - 1]);
    const y = (v) => H - (Math.min(v, top) / top) * H;
    const bw = w / FRAMES, gap = bw > 2 ? 0.5 : 0;
    for (let i = 0; i < f.count; i++) {
      const k = slotOf(f, i), x = w - (f.count - i) * bw, v = f.ms[k];
      ctx.fillStyle = barColor(v);
      ctx.globalAlpha = WAIT_ALPHA;
      ctx.fillRect(x, y(v), bw - gap, H - y(v));
      ctx.globalAlpha = 1;
      const work = Math.min(f.work[k], v);
      ctx.fillRect(x, y(work), bw - gap, H - y(work));
      if (v > top) ctx.fillRect(x, 0, bw - gap, 2);   // off the scale: a cap
    }
    if (hover >= 0 && held) {
      const x = w - (f.count - hover) * bw;
      ctx.fillStyle = colors.hover;
      ctx.fillRect(x - 0.5, 0, Math.max(1, bw) + 1, H);
    }
    // guides at the frame budget and twice it, labelled with their frame rate
    ctx.font = `9px ui-monospace, 'SF Mono', Menlo, monospace`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    for (const m of GUIDES) {
      const gy = Math.round(y(m * BUDGET_MS)) + 0.5;
      ctx.fillStyle = colors.guide;
      ctx.fillRect(0, gy, w, 1);
      ctx.fillStyle = colors.label;
      ctx.fillText(`${(MAX_FPS / m).toFixed(0)} fps`, w - LABEL_PAD, gy - 1);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${top.toFixed(0)} ms`, LABEL_PAD, LABEL_PAD);
  }

  function live() {
    const st = ring && frameStats(ring);
    tFps.v.textContent = st ? (MS_PER_S / st.avg).toFixed(0) : '–';
    tFrame.v.textContent = st ? st.avg.toFixed(1) : '–';
    tFrame.el.classList.toggle('warn', !!st && st.avg > SLOW * BUDGET_MS);
    if (held) return;
    gline.classList.remove('hold');
    gline.replaceChildren(...(st ? [
      h('span', { text: `avg ${st.avg.toFixed(1)} ms` }),
      h(st.worst > SPIKE * BUDGET_MS ? 'span.bad' : 'span', { text: `worst ${st.worst.toFixed(1)} ms` }),
      h(st.spikes ? 'span.bad' : 'span', { text: `${st.spikes} spike${st.spikes === 1 ? '' : 's'}`,
        title: `frames over ${(SPIKE * BUDGET_MS).toFixed(1)} ms in the last ${FRAMES}` }),
    ] : [h('span', { text: 'waiting for frames' })]));
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!ring?.count) return;
    if (!held) held = { ms: ring.ms.slice(), work: ring.work.slice(), phases: ring.phases.slice(), head: ring.head, count: ring.count };
    const r = canvas.getBoundingClientRect(), bw = r.width / FRAMES;
    const i = held.count - 1 - Math.floor((r.right - e.clientX) / bw);
    hover = i >= 0 && i < held.count ? i : -1;
    gline.classList.add('hold');
    gline.textContent = hover < 0 ? 'no frame here' : `${held.count - 1 - hover} back · ${frameText(held, hover)}`;
    draw();
  });
  canvas.addEventListener('pointerleave', () => { held = null; hover = -1; lastLive = -Infinity; live(); draw(); });

  function idle() {
    status.textContent = 'idle: nothing is rendering';
    rates.textContent = last ? `idle (last sample: ${lastRates})` : 'idle';
    el.classList.add('idle');
  }

  return {
    show(v) {
      shown = v;
      el.classList.toggle('show', v);
      if (v && !last) {
        status.textContent = 'waiting for a frame';
        rates.textContent = state.textContent = size.textContent = '';
        tCpu.v.textContent = tGpu.v.textContent = '–';
      }
      if (v) { colors = null; draw(); }
    },
    // f: the profiler's frame ring, as each frame's time is known
    frame(f) {
      ring = f;
      if (!shown) return;
      if (!held) draw();
      const now = performance.now();
      if (now - lastLive >= LIVE_MS) { lastLive = now; live(); }
    },
    // s: a sample from gfx/profiler.js, or null when rendering went idle
    update(s) {
      if (!s) { idle(); return; }
      last = s;
      el.classList.remove('idle');
      status.textContent = s.coverage && !s.coverage.complete ? `INCOMPLETE · ${s.coverage.timed}/${s.coverage.observed} passes`
        : s.gpu == null ? 'sampled · no GPU timestamps'
          : `sampled · ${s.coverage.timed}/${s.coverage.observed} passes${!s.coverage.timelineComplete ? ' · timeline unavailable' : ''}${s.coverage.unlabelled ? ` · ${s.coverage.unlabelled} unlabelled` : ''}`;
      tCpu.v.textContent = ms(s.cpu);
      tGpu.v.textContent = ms(s.gpu);
      tCpu.el.classList.toggle('warn', s.cpu != null && s.cpu > BUDGET_MS);
      tGpu.el.classList.toggle('warn', s.gpu != null && s.gpu > BUDGET_MS);
      lastRates = rateText(s);
      rates.textContent = lastRates;
      state.textContent = `awake ${s.awake == null ? '–' : share(s.awake)}${drawnText(s, ' · drawn ')} · ${(s.memory / MB).toFixed(0)} MB · ${gridText(s.grid)}`;
      // (its own line: a Retina canvas and its scene size no longer fit beside the rest)
      size.textContent = `canvas ${s.canvas.join('×')}${s.renderScale < 1 ? ` → scene ${sceneSize(s)}` : ''}`;
      const span = Math.max(s.coverage?.spanMs ?? 0, BUDGET_MS);
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
      // A sum of overlapping pass durations is not a wall-time interval.
      totalTrack.replaceChildren();
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
