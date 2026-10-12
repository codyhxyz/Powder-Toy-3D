// The raster bench page's driver (bench/raster.html; docs/v2.md 11 "Week 0",
// 3.1, 3.2, 3.5, 3.8, 7.3; docs/v2/evidence/judge-1.md gate 1). Standalone:
// plain WebGPU, nothing from src/, so it can ship to the live site on its own
// and be opened on a phone over https.
//
// Start loads the baked scene (public/bench/<scene>.bin, made by
// tools/v2/bake-bench-scene.mjs), finds its faces, builds every pipeline
// (timed, one at a time; cold with a fresh nonce), fills the light grid, then
// for each output resolution runs each configuration: a warm-up, then N
// measured frames on a fixed camera orbit (the same views every run):
//
//   msaa-1  msaa-2    4× MSAA at the output size, 1 or 2 frames in flight
//   taau-1  taau-2    TAAU at ⅔, 1 or 2 frames in flight
//   msaaT-1 msaaT-2   MSAA with transient attachments (where the browser has them)
//
// 1 frame in flight: a frame is submitted only after the last one's
// onSubmittedWorkDone; 2: one queued frame is allowed. A requestAnimationFrame
// callback that finds the limit reached draws nothing (counted as skipped).
//
// It shows and records: the adapter, features and key limits, the canvas,
// devicePixelRatio, the preferred format, the measured rAF interval (60 or
// 120 Hz), per-pass GPU time from timestamp queries where the device has
// them, submit-to-onSubmittedWorkDone time per frame (the method when there
// are no timestamps), CPU encode time, each pipeline's compile time, and the
// verdict: MSAA's GPU frame time over TAAU's (1 frame in flight; MSAA with
// transient attachments where there are some); above 1.5, "TAAU".
//
// URL options (the form's, for links and tools/raster-bench.mjs):
//   ?scene=lab|volcano|lab,volcano   ?res=both|device|v2   ?frames=300   ?warmup=60
//   ?shadow=1024|2048   ?cold=1|0   ?dpr=<number> (instead of devicePixelRatio)
//   ?pace=raf|free (a frame per animation frame, or back to back: the GPU at saturated clocks)
//   ?still=msaa|taau ?stillFrame=<i> (the still drawn after the runs)
//   ?only=msaa-1,taau-1 (some configurations)   ?timestamps=0 (time by submit-to-done, as without
//   timestamp-query)   ?auto=1 (start at once)
// window.__bench holds { state: 'idle' | 'running' | 'done' | 'error', result, error } for tools.
import { loadScene, extractFaces, columnHeights } from './raster/scene.js';
import { Renderer, PASSES, TAAU_SCALE, probeTransient } from './raster/renderer.js';

const VERSION = 'tpt3d-raster-bench/1';
const THRESHOLD = 1.5;   // docs/v2.md 11: MSAA costing more than 1.5× TAAU at ⅔ means TAAU
// tools/v2/crisp/faces.txt, the face counts v2's design quotes (docs/v2.md 3.2)
const FACES_TXT = { lab: { opaque: 10972, liquid: 10752, glass: 19424 }, volcano: { opaque: 22200, liquid: 13952, glass: 0 } };
const LIMITS = ['maxTextureDimension2D', 'maxTextureDimension3D', 'maxBufferSize', 'maxStorageBufferBindingSize',
  'maxStorageBuffersPerShaderStage', 'maxSampledTexturesPerShaderStage', 'maxColorAttachmentBytesPerSample',
  'maxInterStageShaderVariables', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupStorageSize'];
const NOTES = [
  'Faces are found on the CPU at load (v2 meshes on the GPU); the counts are checked against the bake and tools/v2/crisp/faces.txt.',
  'Liquids are whole cells with flat tops (no fill levels in a preset); glass and ice are drawn in the translucent pass with the liquids, unsorted, liquids first.',
  'Gas: none; these presets hold no gas cells at load, so the gas march is not drawn.',
  'Linear depth is r16float in both variants: r32float cannot be a resolve target in WebGPU, and r16float can.',
  'The shadow map is redrawn every frame so its cost shows; v2 redraws it at most 30 Hz and only on change.',
  'TAAU reprojects with per-pixel motion and a bilinear history tap, clamps to the 3×3 neighbourhood, and tone maps in the same pass.',
  'Patterns are procedural 16×16 stand-ins for the art pass; the light grid is filled once at load (16 iterations, 26 neighbours).',
];

const params = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s);
const form = $('#options'), startBtn = $('#start'), statusEl = $('#status'), canvas = $('#view'), hud = $('#hud');
const bench = window.__bench = { version: VERSION, state: 'idle', result: null, error: null };
let lastJson = '';
let lastDevice = null;   // kept after a run so its still stays on the canvas; destroyed by the next

// the form from the URL
for (const k of ['scene', 'res', 'frames', 'shadow']) {
  const v = params.get(k);
  const el = form.elements[k];
  if (v && el) {
    if (![...el.options].some((o) => o.value === v)) el.add(new Option(v, v));
    el.value = v;
  }
}
if (params.has('cold')) form.elements.cold.checked = params.get('cold') !== '0';

const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
function stats(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { median: round(at(0.5)), mean: round(v.reduce((s, x) => s + x, 0) / v.length), p95: round(at(0.95)), min: round(v[0]), n: v.length };
}
const status = (text, error = false) => { statusEl.textContent = text; statusEl.className = error ? 'error' : 'muted'; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/** The median requestAnimationFrame interval over `n` callbacks (60 or 120 Hz, or a throttled 30). */
async function measureRaf(n = 60) {
  const t = [];
  for (let i = 0; i <= n; i++) t.push(await nextFrame());
  const d = stats(t.slice(1).map((x, i) => x - t[i]));
  return { medianMs: d.median, hz: round(1000 / d.median, 1), samples: n };
}

/** An empty command buffer's submit-to-onSubmittedWorkDone: the floor under every frame's. */
async function queueFloor(device, n = 20) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    device.queue.submit([device.createCommandEncoder().finish()]);
    await device.queue.onSubmittedWorkDone();
    t.push(performance.now() - s);
  }
  return stats(t);
}

/** Pixels per CSS pixel for a resolution option: the device's, or v2's base (docs/v2.md 3.8). */
function ratios(option) {
  const device = Number(params.get('dpr')) || devicePixelRatio || 1;
  const phone = matchMedia('(pointer: coarse)').matches;
  const v2 = phone ? 1.5 : 1;
  const all = [{ label: 'device', ratio: device }, { label: 'v2', ratio: v2 }];
  if (option === 'device') return all.slice(0, 1);
  if (option === 'v2') return all.slice(1);
  return device === v2 ? all.slice(0, 1) : all;
}

/**
 * Runs one configuration: warm-up, then `frames` measured frames, one per
 * animation frame (pace 'raf'), or as fast as the frames-in-flight limit
 * lets them go (pace 'free': the GPU never idles, so it runs at the clocks a
 * saturated GPU holds rather than the ones a 60 or 120 Hz cadence settles at).
 */
function runConfig(r, cfg, { warmup, frames, pace }, errors, label) {
  const next = pace === 'free' ? (fn) => setTimeout(() => fn(performance.now()), 0) : requestAnimationFrame;
  return new Promise((resolve, reject) => {
    const recs = [];
    let i = 0, inFlight = 0, pending = 0, skipped = 0;
    const total = warmup + frames;
    const tick = (now) => {
      if (errors.length) { reject(new Error(errors[0])); return; }
      if (i >= total) {
        if (inFlight || pending) next(tick);
        else resolve({ recs, skipped });
        return;
      }
      if (inFlight >= cfg.inflight) {
        if (i >= warmup) skipped++;
        next(tick);
        return;
      }
      const f = r.frame(i, i === 0);
      const rec = { i, raf: now, cpu: f.cpuMs, submitDone: null, gpu: null };
      inFlight++;
      pending++;
      f.done.then((t) => { rec.submitDone = t - f.submitAt; inFlight--; }, (e) => errors.push(String(e)));
      f.gpu.then((g) => { rec.gpu = g; pending--; }, () => { pending--; });
      if (i >= warmup) recs.push(rec);
      i++;
      if (i % 20 === 0 || i === total) hud.textContent = `${label} · ${cfg.key} · ${Math.max(0, i - warmup)}/${frames}`;
      next(tick);
    };
    next(tick);
  });
}

function summarize(cfg, { recs, skipped }, targets) {
  const gaps = recs.slice(1).map((r, k) => r.raf - recs[k].raf);
  const gpu = recs.map((r) => r.gpu).filter(Boolean);
  const frame = stats(gaps);
  return {
    config: cfg.key, aa: cfg.aa, framesInFlight: cfg.inflight, transient: cfg.transient,
    frames: recs.length, skippedRaf: skipped,
    frameMs: frame, fps: frame ? round(1000 / frame.mean, 1) : null,
    gpuMs: gpu.length ? {
      frame: stats(gpu.map((g) => g.span)),
      passes: Object.fromEntries(PASSES[cfg.aa].map((p, k) => [p, stats(gpu.map((g) => g.passes[k]))])),
    } : null,
    submitToDoneMs: stats(recs.map((r) => r.submitDone)),
    cpuEncodeMs: stats(recs.map((r) => r.cpu)),
    // Chrome rounds timestamps to 100 µs unless WebGPU developer features are on
    timestampsOn100us: gpu.length ? gpu.every((g) => g.raw.every((x) => x % 100000 === 0)) : null,
    targets: { internal: targets.internal, bytes: targets.bytes, msaaBytes: targets.msaaBytes, transientBytes: targets.transientBytes },
  };
}

function verdict(runs, floor, transient) {
  const pick = (aa, tr) => runs.find((r) => r.aa === aa && r.framesInFlight === 1 && r.transient === tr && !r.error);
  const msaa = (transient && pick('msaa', true)) || pick('msaa', false), taau = pick('taau', false);
  if (!msaa || !taau) return null;
  let method, m, t;
  if (msaa.gpuMs?.frame && taau.gpuMs?.frame) {
    method = 'timestamp-query: the median GPU frame, first pass begin to last pass end';
    m = msaa.gpuMs.frame.median; t = taau.gpuMs.frame.median;
  } else {
    method = 'submit to onSubmittedWorkDone at 1 frame in flight (median), less the empty-submit floor';
    m = msaa.submitToDoneMs.median - (floor?.median ?? 0); t = taau.submitToDoneMs.median - (floor?.median ?? 0);
  }
  const ratio = m / t;
  return {
    choice: ratio > THRESHOLD ? 'TAAU' : 'MSAA', ratio: round(ratio), threshold: THRESHOLD,
    msaaMs: round(m), taauMs: round(t), msaaConfig: msaa.config, taauConfig: taau.config, method,
  };
}

async function run() {
  startBtn.disabled = true;
  canvas.hidden = false;
  $('#results').textContent = '';
  $('#actions').hidden = true;
  $('#json').hidden = true;
  bench.state = 'running';
  bench.error = null;
  const errors = [];
  let wake = null, device = null;
  lastDevice?.destroy();
  lastDevice = null;
  const opts = {
    scenes: form.elements.scene.value.split(','),
    res: form.elements.res.value,
    frames: Number(form.elements.frames.value) || 300,
    warmup: Number(params.get('warmup') ?? 60),
    shadow: Number(form.elements.shadow.value) || 1024,
    cold: form.elements.cold.checked,
    only: params.get('only')?.split(',') ?? null,
    pace: params.get('pace') === 'free' ? 'free' : 'raf',
  };
  const result = {
    version: VERSION, date: new Date().toISOString(), url: location.href, userAgent: navigator.userAgent,
    options: opts, notes: NOTES, errors,
  };
  try {
    if (!navigator.gpu) throw new Error(`No WebGPU here (navigator.gpu is missing${isSecureContext ? '' : ': the page needs https or localhost'}).`);
    status('Asking for the GPU…');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter.');
    const info = adapter.info ?? {};
    const timestamps = adapter.features.has('timestamp-query') && params.get('timestamps') !== '0';
    // transient MSAA attachments (docs/v2.md 3.8): the usage flag where the browser defines it, if a device
    // takes it; Dawn also wants its device feature (it names it TransientAttachments) where it has one
    const transientFeatures = [...adapter.features].filter((f) => /transient/i.test(f));
    device = await adapter.requestDevice({ requiredFeatures: [...(timestamps ? ['timestamp-query'] : []), ...transientFeatures] });
    const transientFlag = typeof GPUTextureUsage.TRANSIENT_ATTACHMENT === 'number' ? GPUTextureUsage.TRANSIENT_ATTACHMENT : 0;
    const transient = await probeTransient(device, transientFlag);
    const transientUsage = transient.ok ? transientFlag : 0;
    device.addEventListener('uncapturederror', (e) => errors.push(`GPU error: ${e.error?.message ?? e.error}`));
    device.lost.then((l) => { if (l.reason !== 'destroyed') errors.push(`device lost: ${l.reason} ${l.message}`); });
    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu');
    context.configure({ device, format, alphaMode: 'opaque' });
    result.device = {
      adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '',
        isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null },
      features: [...adapter.features].sort(),
      limits: Object.fromEntries(LIMITS.map((k) => [k, adapter.limits[k]])),
      timestampQuery: timestamps,
      transientAttachments: Boolean(transientUsage),
      transientProbe: { ...transient, features: transientFeatures },
      preferredFormat: format,
      devicePixelRatio,
      screen: [screen.width, screen.height],
      viewport: [innerWidth, innerHeight],
    };
    status('Measuring the display…');
    result.device.raf = await measureRaf();
    result.device.queueFloorMs = await queueFloor(device);

    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not granted: the run goes on */ }
    const nonce = opts.cold ? 0.1 + 0.8 * Math.random() : 0.5;
    result.scenes = [];
    let renderer = null;
    for (const name of opts.scenes) {
      status(`Loading ${name}…`);
      const scene = await loadScene(new URL(`${name}.bin`, location.href));
      const faces = extractFaces(scene);
      const expected = scene.header.faces;
      const sc = {
        name, dims: scene.dims, bytes: scene.bytes, fetchMs: round(scene.fetchMs, 1), decodeMs: round(scene.decodeMs, 1),
        cells: scene.header.cells, faces: { ...faces.counts, extractMs: round(faces.ms, 1), bake: expected, facesTxt: FACES_TXT[name] ?? null },
      };
      sc.faces.match = ['opaque', 'liquid', 'glass'].every((k) => faces.counts[k] === expected[k]);
      if (!sc.faces.match) errors.push(`${name}: found ${JSON.stringify(faces.counts)} faces, the bake says ${JSON.stringify(expected)}`);
      result.scenes.push(sc);
      const shared = renderer ? { layouts: renderer.layouts, pipelines: renderer.pipelines } : null;
      renderer?.destroy();
      renderer = new Renderer({ device, context, format, scene, faces, heights: columnHeights(scene), shadowSize: opts.shadow, timestamps, transientUsage, shared });
      if (!shared) {
        status(`Building pipelines${opts.cold ? ' (cold)' : ''}…`);
        const times = await renderer.compile(nonce);
        result.compile = {
          cold: opts.cold, nonce, pipelines: times.map((t) => ({ ...t, ms: round(t.ms, 1) })),
          totalMs: round(times.filter((t) => t.kind !== 'module').reduce((s, t) => s + t.ms, 0), 1),
        };
      }
      status(`Filling the light grid (${name})…`);
      const light = await renderer.fillLight();
      sc.lightFill = { wallMs: round(light.wallMs, 1), gpuMs: round(light.gpuMs, 2), dispatches: light.dispatches };
      if (errors.length) throw new Error(errors[0]);

      sc.resolutions = [];
      const configs = [
        { key: 'msaa-1', aa: 'msaa', inflight: 1, transient: false },
        { key: 'taau-1', aa: 'taau', inflight: 1, transient: false },
        ...(transientUsage ? [{ key: 'msaaT-1', aa: 'msaa', inflight: 1, transient: true }] : []),
        { key: 'msaa-2', aa: 'msaa', inflight: 2, transient: false },
        { key: 'taau-2', aa: 'taau', inflight: 2, transient: false },
        ...(transientUsage ? [{ key: 'msaaT-2', aa: 'msaa', inflight: 2, transient: true }] : []),
      ].filter((c) => !opts.only || opts.only.includes(c.key));
      for (const { label, ratio } of ratios(opts.res)) {
        document.body.classList.add('running');
        const cssW = innerWidth, cssH = innerHeight;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        canvas.width = Math.max(1, Math.round(cssW * ratio));
        canvas.height = Math.max(1, Math.round(cssH * ratio));
        await nextFrame();
        const res = { label, pixelRatio: ratio, css: [cssW, cssH], pixels: [canvas.width, canvas.height], megapixels: round(canvas.width * canvas.height / 1e6, 2), runs: [] };
        for (const cfg of configs) {
          status(`${name}, ${label} pixels (${canvas.width}×${canvas.height}): ${cfg.key}`);
          // a phone may refuse a big MSAA target set: that run is recorded as refused, the others go on
          device.pushErrorScope('out-of-memory');
          const targets = renderer.setup(cfg.aa, canvas.width, canvas.height, cfg.transient);
          const oom = await device.popErrorScope();
          if (oom) {
            renderer.release();
            res.runs.push({ config: cfg.key, aa: cfg.aa, framesInFlight: cfg.inflight, transient: cfg.transient, error: `out of memory: ${oom.message}`, targets });
            continue;
          }
          const out = await runConfig(renderer, cfg, opts, errors, `${name} ${label}`);
          res.runs.push(summarize(cfg, out, targets));
        }
        renderer.release();
        res.verdict = verdict(res.runs, result.device.queueFloorMs, Boolean(transientUsage));
        sc.resolutions.push(res);
      }
      document.body.classList.remove('running');
      canvas.style.width = canvas.style.height = '';
    }
    // a still of the last scene in the preview, so the page shows what it drew
    if (renderer) {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
      renderer.setup(params.get('still') === 'taau' ? 'taau' : 'msaa', canvas.width, canvas.height, false);
      await renderer.frame(Number(params.get('stillFrame') ?? 0), true).done;
      renderer.destroy();
    }
    if (errors.length) throw new Error(errors[0]);
    bench.state = 'done';
    status('Done.');
  } catch (e) {
    bench.state = 'error';
    bench.error = String(e?.stack ?? e);
    if (!errors.includes(String(e?.message ?? e))) errors.push(String(e?.message ?? e));
    status(`Failed: ${e?.message ?? e}`, true);
  } finally {
    document.body.classList.remove('running');
    canvas.style.width = canvas.style.height = '';
    try { await wake?.release(); } catch { /* already released */ }
    if (bench.state === 'done') lastDevice = device;
    else device?.destroy();
    bench.result = result;
    lastJson = JSON.stringify(result, null, 1);
    show(result);
    startBtn.disabled = false;
  }
}

// ---- the results on the page
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k ?? '')));
  return e;
}
const ms = (s) => (s?.median == null ? '–' : s.median.toFixed(s.median < 10 ? 2 : 1));
const mb = (b) => `${(b / 2 ** 20).toFixed(1)} MB`;
function table(head, rows) {
  return el('div', { class: 'scroll' }, el('table', {}, el('tr', {}, head.map((h) => el('th', {}, h))), rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))));
}

function show(r) {
  const out = $('#results');
  out.textContent = '';
  if (r.errors?.length) out.append(el('div', { class: 'card' }, el('b', {}, 'Errors'), el('ul', {}, r.errors.map((e) => el('li', {}, e)))));
  if (r.device?.adapter?.isFallbackAdapter) out.append(el('div', { class: 'card' }, el('b', {}, 'A software adapter (no GPU): '), 'these numbers say the page works, not what a frame costs on a real GPU.'));
  for (const sc of r.scenes ?? []) {
    out.append(el('h2', {}, `${sc.name[0].toUpperCase()}${sc.name.slice(1)}`));
    const verdicts = el('div', { class: 'verdicts' });
    for (const res of sc.resolutions ?? []) {
      const v = res.verdict;
      verdicts.append(el('div', { class: 'card verdict' },
        el('div', { class: 'muted' }, `${res.label} pixels, ${res.pixels.join('×')} (${res.megapixels} MP)`),
        el('div', { class: `choice ${v ? v.choice.toLowerCase() : ''}` }, v ? v.choice : '–'),
        v ? el('div', {}, `MSAA ${v.msaaMs} ms ÷ TAAU ${v.taauMs} ms = ${v.ratio} (TAAU above ${v.threshold})`) : el('div', {}, 'needs msaa-1 and taau-1'),
        v ? el('div', { class: 'muted' }, v.method) : ''));
    }
    out.append(verdicts);
    for (const res of sc.resolutions ?? []) {
      out.append(el('h3', {}, `Runs at ${res.label} pixels (${res.pixels.join('×')})`));
      const passes = [...new Set(res.runs.flatMap((x) => Object.keys(x.gpuMs?.passes ?? {})))];
      out.append(table(
        ['config', 'frame ms', 'fps', 'GPU ms', ...passes.map((p) => `${p} ms`), 'submit→done ms', 'CPU ms', 'skipped', 'targets'],
        res.runs.map((x) => (x.error ? [x.config, x.error] : [x.config, ms(x.frameMs), x.fps ?? '–', ms(x.gpuMs?.frame), ...passes.map((p) => ms(x.gpuMs?.passes[p])),
          ms(x.submitToDoneMs), ms(x.cpuEncodeMs), x.skippedRaf, `${mb(x.targets.bytes)}${x.targets.transientBytes ? ` (${mb(x.targets.transientBytes)} transient)` : ''}`])),
      ));
    }
    out.append(el('div', { class: 'card' }, el('dl', {},
      el('dt', {}, 'cells'), el('dd', {}, `${sc.dims.join('×')}: ${sc.cells.opaque} opaque, ${sc.cells.liquid} liquid, ${sc.cells.translucent} translucent, ${sc.cells.gas} gas`),
      el('dt', {}, 'faces'), el('dd', {}, `${sc.faces.opaque} opaque, ${sc.faces.liquid} liquid, ${sc.faces.glass} glass in ${sc.faces.extractMs} ms (${sc.faces.match ? 'as baked' : 'NOT as baked'}; faces.txt ${sc.faces.facesTxt ? Object.values(sc.faces.facesTxt).join(' / ') : '–'})`),
      el('dt', {}, 'file'), el('dd', {}, `${sc.bytes} bytes, fetched in ${sc.fetchMs} ms, inflated in ${sc.decodeMs} ms`),
      el('dt', {}, 'light grid'), el('dd', {}, sc.lightFill ? `${sc.lightFill.dispatches} dispatches: ${sc.lightFill.gpuMs ?? '–'} ms GPU, ${sc.lightFill.wallMs} ms wall` : '–'))));
  }
  if (r.compile) {
    out.append(el('h2', {}, `Compile${r.compile.cold ? ' (cold)' : ''}: ${r.compile.totalMs} ms of pipelines`));
    out.append(table(['pipeline', 'kind', 'ms'], r.compile.pipelines.map((p) => [p.name, p.kind, p.ms])));
  }
  if (r.device) {
    const d = r.device;
    out.append(el('h2', {}, 'Device'));
    out.append(el('div', { class: 'card' }, el('dl', {},
      el('dt', {}, 'adapter'), el('dd', {}, [d.adapter.vendor, d.adapter.architecture, d.adapter.device, d.adapter.description].filter(Boolean).join(' · ') || '(not exposed)'),
      el('dt', {}, 'fallback adapter'), el('dd', {}, String(d.adapter.isFallbackAdapter)),
      el('dt', {}, 'display'), el('dd', {}, `rAF every ${d.raf.medianMs} ms (${d.raf.hz} Hz); devicePixelRatio ${d.devicePixelRatio}; viewport ${d.viewport.join('×')}; screen ${d.screen.join('×')}`),
      el('dt', {}, 'canvas format'), el('dd', {}, d.preferredFormat),
      el('dt', {}, 'timestamps'), el('dd', {}, d.timestampQuery ? 'timestamp-query' : 'none: submit-to-done timing'),
      el('dt', {}, 'transient attachments'), el('dd', {}, d.transientAttachments ? 'yes (MSAA run with and without)' : 'no'),
      el('dt', {}, 'empty submit'), el('dd', {}, `${ms(d.queueFloorMs)} ms to onSubmittedWorkDone`),
      el('dt', {}, 'features'), el('dd', {}, d.features.join(', ')),
      el('dt', {}, 'limits'), el('dd', {}, Object.entries(d.limits).map(([k, v]) => `${k} ${v}`).join(', ')),
      el('dt', {}, 'browser'), el('dd', {}, r.userAgent))));
  }
  out.append(el('p', { class: 'muted' }, `${r.version}, ${r.date}. TAAU renders at ${round(TAAU_SCALE, 3)} of the output size.`));
  $('#actions').hidden = false;
}

$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastJson);
    status('Copied the JSON.');
  } catch {
    const t = $('#json');
    t.hidden = false;
    t.value = lastJson;
    t.focus();
    t.select();
    status('Select-all and copy the JSON below.');
  }
});
$('#download').addEventListener('click', () => {
  const a = el('a', { href: URL.createObjectURL(new Blob([lastJson], { type: 'application/json' })), download: `raster-bench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
});
startBtn.addEventListener('click', () => { run(); });
if (params.get('auto') === '1') run();
