import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launchBrowser, newTestPage, ready, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

function stats(values) {
  assert(values.length && values.every(v => Number.isFinite(v) && v >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
function summarize(trials) {
  return [...new Set(trials.map(t => t.workload))].map(workload => {
    const sample = mode => {
      const rows = trials.filter(t => t.workload === workload && t.mode === mode);
      return Object.fromEntries(['gpu', 'scene', 'raster', 'sun', 'cpu'].map(k => [k, stats(rows.flatMap(t => t[k]))]));
    };
    const legacy = sample('legacy'), hybrid = sample('hybrid');
    return { workload, legacy, hybrid, gpuChangePercent: (hybrid.gpu.median / legacy.gpu.median - 1) * 100 };
  });
}
if (process.argv.includes('--self-test')) {
  assert.deepEqual(stats([4, 1, 2, 3]), { n: 4, median: 2.5, p95: 4 });
  assert.deepEqual(stats([1]), { n: 1, median: 1, p95: 1 });
  assert.throws(() => stats([NaN]));
  const fixture = ['legacy', 'hybrid'].map(mode => ({ workload: 'test', mode,
    gpu: [mode === 'legacy' ? 10 : 8], scene: [2], raster: [0], sun: [0], cpu: [1] }));
  assert(Math.abs(summarize(fixture)[0].gpuChangePercent + 20) < 1e-10);
  console.log('PASS hybrid benchmark statistics; CPU only.');
} else {
  const vite = await startVite({ port: 58475, harness: true });
  let browser, started;
  try {
    started = Date.now();
    browser = await launchBrowser({ lifetimeMs: 25000 });
    const page = await newTestPage(browser, { mode: 'visual', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const errors = [], offlineRelay = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      const location = m.location().url ?? '';
      if (m.type() === 'error' && /net::ERR_CONNECTION_REFUSED/.test(m.text()) && /^http:\/\/127\.0\.0\.1:8787\//.test(location)) offlineRelay.push(location);
      else if (m.type() === 'error' || m.type() === 'warning' && /WebGPU|GPU (validation|internal)/.test(m.text())) errors.push(`${m.text()} (${location})`);
    });
    await page.routeWebSocket(/.*/, () => {});
    await page.goto(vite.url('/?renderer=hybrid&test=visual&view=realistic&size=128&preset=empty&paused=1'));
    await ready(page);
    const adapter = await gpuInfo(page);
    const result = await page.evaluate(async () => {
      const { run } = await import('/tools/harness/hybrid-bench.js');
      return run(window.__app);
    });
    assert.equal(errors.length, 0, errors.join('\n'));
    const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      adapter, ...result, summary: summarize(result.trials), offlineRelay };
    const path = `/tmp/tpt-hybrid-bench-${process.pid}.json`;
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ path, adapter: adapter.description, method: result.method, summary: report.summary,
      trials: result.trials.map(({ gpu, scene, raster, sun, cpu, ...rest }) => rest) }, null, 2));
  } finally {
    await browser?.close();
    await vite.close();
    if (started) console.log(`Total player-check/startup/compilation/measurement/cleanup occupancy: ${Date.now() - started} ms`);
  }
}
