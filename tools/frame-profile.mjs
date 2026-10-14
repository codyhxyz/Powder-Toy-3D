// A bounded production capture: first draw, then a short gameplay interval.
// The entire slot (startup, compilation, capture, cleanup) is at most 10 s.
// The launcher refuses a busy player GPU; never bypass its lock.
// node tools/frame-profile.mjs [--url https://tpt3d.codyh.xyz] [--map lab]
//   [--ms 1000] [--out /tmp/tpt-frame-profile.json]
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, gpuInfo } from './browser.mjs';
import { PHASES } from '../src/gfx/profiler.js';

const sceneTime = frame => frame.passes?.find(p => p.name === 'scene')?.gpu;
function captureComplete(data, errors) {
  return !errors.length && !data.failure && data.startup?.coverage?.complete
    && data.startup.volumeDrawn && Number.isFinite(sceneTime(data.startup))
    && data.frames.length > 0 && data.frames.every(f => f.coverage.complete && Number.isFinite(sceneTime(f)))
    && data.cpu.length > 0 && data.cpu.every(f => f.volumeDrawn)
    && data.frames.some(f => f.passes.some(p => p.name.startsWith('three:')));
}
// CPU-only negative controls; run before any browser launch or slot acquisition.
if (process.argv.includes('--self-test')) {
  const frame = { coverage: { complete: true }, passes: [{ name: 'scene', gpu: 1 }, { name: 'three:meshes', gpu: 0.1 }] };
  const good = { startup: { ...structuredClone(frame), volumeDrawn: true }, frames: [structuredClone(frame)], cpu: [{ volumeDrawn: true }] };
  assert.equal(captureComplete(good, []), true);
  for (const breakCapture of [
    d => { d.startup.volumeDrawn = false; },
    d => { d.cpu[0].volumeDrawn = false; },
    d => { d.startup.passes = []; },
    d => { d.startup.passes[0].gpu = null; },
    d => { d.frames[0].passes[0].gpu = NaN; },
    d => { d.frames[0].passes = [{ name: 'three:meshes', gpu: 0.1 }]; },
    d => { d.frames[0].coverage.complete = false; },
    d => { d.frames = []; },
    d => { d.cpu = []; },
    d => { d.failure = 'device lost'; },
    d => { d.frames[0].passes = [{ name: 'scene', gpu: 1 }]; },
  ]) {
    const data = structuredClone(good);
    breakCapture(data);
    assert.ok(!captureComplete(data, []), 'reject incomplete or volume-free capture');
  }
  assert.equal(captureComplete(good, ['page error']), false);
  console.log('PASS: capture validation rejects missing volume, scene timings, coverage, frames, meshes, and GPU/page errors');
  process.exit(0);
}

const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const duration = Number(opt('ms', 1000));
if (!(duration > 0 && duration <= 2000)) throw new Error('--ms must be 1–2000; leave room for startup and cleanup within the 10s slot');
const url = new URL(opt('url', 'https://tpt3d.codyh.xyz'));
url.searchParams.set('map', opt('map', 'lab'));
url.searchParams.set('test', 'manual');
const out = opt('out', '/tmp/tpt-frame-profile.json');
let browser;
try {
  browser = await launchBrowser({ lifetimeMs: 10000 });
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 1280, height: 800 } });
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => requests.push({ url: r.url(), error: r.failure()?.errorText }));
  await page.goto(url.href);
  await ready(page);
  await gpuInfo(page);   // refuse software timings on a real-GPU run
  const data = await page.evaluate(async duration => {
    const a = __app;
    await a.test.ready();
    a.autoRes.enabled = false;
    a.settings.profiler = true;
    await a.test.renderOnce();
    const t = a.gpu.timing;
    if (!t.supported || !t.settled) throw new Error('Full device-boundary timestamp profiler not available');
    await t.settled();
    const startup = { passes: t.lastPasses, coverage: t.lastCoverage, volumeDrawn: a.view.volumeDrawn };
    const frames = [], cpu = [];
    let active = false, started = 0;
    const begin = a.prof.beginFrame.bind(a.prof), end = a.prof.endFrame.bind(a.prof);
    a.prof.beginFrame = (...args) => { started = performance.now(); return begin(...args); };
    a.prof.endFrame = steps => {
      end(steps);
      if (active) cpu.push({ frame: a.gpu.frameNo, ms: performance.now() - started, steps, volumeDrawn: a.view.volumeDrawn });
    };
    const first = a.gpu.frameNo + 1;
    t.onFrame = frame => { if (frame.frame >= first) frames.push(frame); };
    a.settings.paused = false;
    active = true;
    const start = performance.now();
    a.test.resume();
    await new Promise(resolve => setTimeout(resolve, duration));
    a.test.park();
    const elapsed = performance.now() - start;
    active = false;
    await a.gpu.fence();
    await t.settled();
    return {
      elapsed, frames, cpu, startup, split: t.split, paused: a.settings.paused,
      grid: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz],
      canvas: [a.renderer.domElement.width, a.renderer.domElement.height], renderScale: a.post.renderScale,
      detail: a.view.detailShown, camera: a.camera.position.toArray(),
      settings: { ...a.settings },
      gpu: Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(k => [k, a.gpu.adapterInfo[k]])),
      failure: a.gpu.failure?.message ?? null,
    };
  }, duration);
  // Close the GPU before formatting/writing any report.
  await browser.close(); browser = null;
  const n = data.frames.length;
  const complete = n > 0 && data.frames.every(f => f.coverage.complete);
  const costs = {}, phases = {};
  for (const frame of data.frames) for (const pass of frame.passes) {
    costs[pass.name] = (costs[pass.name] ?? 0) + (pass.gpu ?? 0) / n;
    const phase = PHASES[pass.phase]?.label ?? 'Other';
    phases[phase] = (phases[phase] ?? 0) + (pass.gpu ?? 0) / n;
  }
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
  const summary = {
    url: url.href, elapsedMs: data.elapsed, timedFrames: n, complete, fullyDrawn: captureComplete(data, errors),
    observedPasses: data.frames.reduce((s, f) => s + f.coverage.observed, 0),
    fps: data.cpu.length / (data.elapsed / 1000),
    stepsPerSecond: data.cpu.reduce((s, f) => s + f.steps, 0) / (data.elapsed / 1000),
    gpuPassMsMean: complete ? mean(data.frames.map(f => f.gpu)) : null,
    gpuPassMsP95: complete ? quantile(data.frames.map(f => f.gpu), 0.95) : null,
    validTimelines: data.frames.filter(f => f.coverage.timelineComplete).length,
    gpuSpanMsMean: mean(data.frames.filter(f => f.coverage.timelineComplete).map(f => f.coverage.spanMs)),
    cpuMsMean: mean(data.cpu.map(f => f.ms)),
    startupSceneMs: sceneTime(data.startup) ?? null,
    phases,
    passes: Object.fromEntries(Object.entries(costs).sort((a, b) => b[1] - a[1])),
    scope: 'GPU pass sum, not wall time; intervals can overlap. Copies/uploads and compositor excluded. Split profiling adds overhead.',
  };
  await writeFile(out, JSON.stringify({ summary, data, errors, requests }, null, 2));
  console.log(JSON.stringify({ ...summary, grid: data.grid, canvas: data.canvas, renderScale: data.renderScale, gpu: data.gpu, errors, requests, artifact: out }, null, 2));
  if (!summary.fullyDrawn) {
    throw new Error('Capture failed coverage/rendering checks; inspect the artifact');
  }
} finally {
  await browser?.close();
}
