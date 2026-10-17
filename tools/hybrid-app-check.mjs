// Actual app lifecycle, legacy residual volume and data-view fallback.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const vite = await startVite({ port: 58474, harness: true });
let browser, started;
try {
  started = Date.now();
  browser = await launchBrowser({ lifetimeMs: 25000 });
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 800, height: 600 } });
  const errors = [], offlineRelay = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    const location = m.location().url ?? '';
    // The dev account/AI relay is not started by this rendering test.
    if (m.type() === 'error' && /net::ERR_CONNECTION_REFUSED/.test(m.text()) && /^http:\/\/127\.0\.0\.1:8787\//.test(location)) {
      offlineRelay.push(location);
    } else if (m.type() === 'error' || m.type() === 'warning' && /WebGPU|GPU (validation|internal)/.test(m.text())) errors.push(`${m.text()} (${location})`);
  });
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(vite.url('/?renderer=hybrid&test=manual&view=realistic&size=128&preset=lab'));
  await ready(page);
  await render(page);
  const first = await page.evaluate(() => {
    const a = window.__app;
    return { enabled: a.hybrid.enabled, stats: a.hybrid.stats, volume: a.view.volumeDrawn, failure: String(a.gpu.failure ?? ''),
      parked: a.test.parked, dims: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz], steps: a.sim.frame };
  });
  assert(first.enabled && first.volume && first.parked && !first.failure, JSON.stringify(first));
  const snapshot = `/tmp/tpt-hybrid-app-${process.pid}.png`;
  await page.screenshot({ path: snapshot });
  await page.evaluate(() => window.__app.setView(1));
  await render(page);
  const fallback = await page.evaluate(() => ({ enabled: window.__app.hybrid.enabled,
    reason: window.__app.hybrid.stats.reason, failure: String(window.__app.gpu.failure ?? ''), steps: window.__app.sim.frame }));
  assert(!fallback.enabled && fallback.reason === 'non-realistic view' && !fallback.failure, JSON.stringify(fallback));
  assert.equal(fallback.steps, first.steps, 'rendering/data-view switch must not step physics');
  const legacy = await newTestPage(browser, { mode: 'manual', viewport: { width: 800, height: 600 } });
  legacy.on('pageerror', e => errors.push(e.message));
  await legacy.routeWebSocket(/.*/, () => {});
  await legacy.goto(vite.url('/?test=manual&view=realistic&size=128&preset=lab'));
  await ready(legacy);
  await render(legacy);
  const baseline = await legacy.evaluate(() => {
    const a = window.__app;
    return { hybrid: a.hybrid !== null, volume: a.view.volumeDrawn, failure: String(a.gpu.failure ?? '') };
  });
  assert(!baseline.hybrid && baseline.volume && !baseline.failure, JSON.stringify(baseline));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ passed: true, first, fallback, baseline, offlineRelay, snapshot, adapter: await gpuInfo(page) }, null, 2));
} finally {
  await browser?.close();
  await vite.close();
  if (started) console.log(`Total launch/player-check/boot/render/fallback/cleanup occupancy: ${Date.now() - started} ms`);
}
