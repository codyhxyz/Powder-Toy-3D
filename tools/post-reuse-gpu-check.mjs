// One bounded GPU slot: real TAA/post on the existing 400×250 post fixture.
import assert from 'node:assert/strict';
import { launchBrowser } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { ADAPT } from '../src/gfx/post.js';

const vite = await startVite({ harness: true, port: 53419 });
let browser;
try {
  // CPU-only transforms before taking the GPU slot; no app/world bake.
  await Promise.all(['/tools/harness/post.js', '/src/gfx/post.js', '/src/gpu/index.js',
    '/src/gpu/three.js', '/tools/harness/harness.js'].map((p) => fetch(vite.url(p))));
  browser = await launchBrowser({ lifetimeMs: 10000 });
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/post.html', { timeout: 5000, errors });
  const r = await page.evaluate(() => window.__harness.run('reuse'));
  console.log(JSON.stringify(r));
  assert.deepEqual(errors, []);
  assert.deepEqual(r.failures, []);
  for (const key of ['reusable', 'frozen', 'advanced', 'cameraUnchanged', 'invalidated', 'resumed', 'resetInvalidated']) assert(r[key], key);
  assert.equal(r.colorChangedBytes, 0);
  assert.equal(r.bloomChangedBytes, 0);
  assert.deepEqual(r.sameState, r.before, 'zero-dt reuse retains exposure state');
  assert.equal(r.after[1], r.before[1], 'histogram target retained');
  assert.equal(r.after[2], r.before[2], 'histogram luminance retained');
  const tau = r.before[1] > r.before[0] ? ADAPT.TAU_DARK : ADAPT.TAU_LIGHT;
  let expected = r.before[0] + (r.before[1] - r.before[0]) * (1 - Math.exp(-(1 / 60) / tau));
  if (Math.abs(expected - r.before[1]) <= ADAPT.SETTLED * r.before[1]) expected = r.before[1];
  assert(Math.abs(r.after[0] - expected) < 1e-5);
  assert(r.after[0] > r.before[0], 'dark-scene exposure advances');
  assert.equal(r.stats.renderPasses, 1);
  assert.equal(r.stats.computePasses, 1);
  assert.equal(r.stats.draws, 1);
  assert.equal(r.stats.dispatches, 1);
  console.log('PASS: real GPU exposure-only reuse preserves TAA/bloom bytes, exposure rule and temporal continuation; only adaptation + composite recorded.');
} finally {
  await browser?.close();
  await vite.close();
}
