// A bounded, reproducible production capture. Park at boot, warm one view,
// then run normal simulation/presentation for at most ten seconds. The shared
// launcher waits for other tests/player GPU work; never bypass its lock.
// node tools/frame-profile.mjs [--url https://tpt3d.codyh.xyz] [--map lab]
//   [--ms 10000] [--out /tmp/tpt-frame-profile.json]
import { writeFile } from 'node:fs/promises';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { PHASES } from '../src/gfx/profiler.js';

const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const duration = Number(opt('ms', 10000));
if (!(duration > 0 && duration <= 10000)) throw new Error('--ms must be 1–10000');
const url = new URL(opt('url', 'https://tpt3d.codyh.xyz'));
url.searchParams.set('map', opt('map', 'lab'));
url.searchParams.set('test', 'manual');
const out = opt('out', '/tmp/tpt-frame-profile.json');
let browser;
try {
  browser = await launchBrowser({ lifetimeMs: 120000 });
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 1280, height: 800 } });
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => requests.push({ url: r.url(), error: r.failure()?.errorText }));
  await page.goto(url.href);
  await ready(page);
  const data = await page.evaluate(async duration => {
    const a = __app;
    await a.test.ready();
    a.autoRes.enabled = false;
    await a.test.renderOnce();
    a.settings.profiler = true;
    await a.test.renderOnce();
    const t = a.gpu.timing;
    if (!t.supported || !t.settled) throw new Error('Full device-boundary timestamp profiler not available');
    await t.settled();
    const frames = [], cpu = [];
    let active = false, started = 0;
    const begin = a.prof.beginFrame.bind(a.prof), end = a.prof.endFrame.bind(a.prof);
    a.prof.beginFrame = (...args) => { started = performance.now(); return begin(...args); };
    a.prof.endFrame = steps => {
      end(steps);
      if (active) cpu.push({ frame: a.gpu.frameNo, ms: performance.now() - started, steps });
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
    const s = a.prof.last;
    return {
      elapsed, frames, cpu, split: t.split, paused: a.settings.paused,
      grid: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz],
      canvas: s?.canvas, renderScale: a.post.renderScale,
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
    url: url.href, elapsedMs: data.elapsed, timedFrames: n, complete,
    observedPasses: data.frames.reduce((s, f) => s + f.coverage.observed, 0),
    fps: data.cpu.length / (data.elapsed / 1000),
    stepsPerSecond: data.cpu.reduce((s, f) => s + f.steps, 0) / (data.elapsed / 1000),
    gpuPassMsMean: complete ? mean(data.frames.map(f => f.gpu)) : null,
    gpuPassMsP95: complete ? quantile(data.frames.map(f => f.gpu), 0.95) : null,
    gpuSpanMsMean: mean(data.frames.map(f => f.coverage.spanMs)),
    cpuMsMean: mean(data.cpu.map(f => f.ms)),
    phases,
    passes: Object.fromEntries(Object.entries(costs).sort((a, b) => b[1] - a[1])),
    scope: 'GPU pass sum, not wall time; intervals can overlap. Copies/uploads and compositor excluded. Split profiling adds overhead.',
  };
  await writeFile(out, JSON.stringify({ summary, data, errors, requests }, null, 2));
  console.log(JSON.stringify({ ...summary, grid: data.grid, canvas: data.canvas, renderScale: data.renderScale, gpu: data.gpu, errors, requests, artifact: out }, null, 2));
  if (!complete || errors.length || data.failure || !Object.keys(costs).some(name => name.startsWith('three:'))) {
    throw new Error('Capture failed coverage/rendering checks; inspect the artifact');
  }
} finally {
  await browser?.close();
}
