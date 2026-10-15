// One real-GPU smoke check, capped at 25 seconds including launch and cleanup.
// Run npm run build first. The private preview server avoids dev-module overhead.
// --section coal --out /tmp/noita-coal.png [--base https://tpt3d.codyh.xyz]
// Without --section/--scene, checks the actual first native arrival.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preview } from 'vite';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTestPage, ready, gpuInfo } from './browser.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const route = JSON.parse(readFileSync(new URL('../public/local-maps/noita-terrain/route.json', import.meta.url)));
let key = arg('--scene', null);
const sectionKey = arg('--section', null);
if (sectionKey) {
  assert.equal(key, null, 'choose a section or an exact scene');
  const section = route.sections.find(s => s.key === sectionKey);
  assert.ok(section, `unknown native section: ${sectionKey}`);
  const middle = (section.sourceRange[0] + section.sourceRange[1]) / 2;
  key = route.regions.find(r => r.core[0] <= middle && middle < r.core[1]).key;
}
key ??= route.startScene;
assert.ok(route.regions.some(r => r.key === key), `unknown source band: ${key}`);
const out = arg('--out', `/tmp/${key}.png`);
const base = arg('--base', null);
const server = base ? null : await preview({ root: fileURLToPath(new URL('..', import.meta.url)),
  logLevel: 'warn', preview: { host: '127.0.0.1', port: 54937, strictPort: true } });
let browser;
const errors = [];
try {
  browser = await launchBrowser({ lifetimeMs: 25000 });
  const page = await newTestPage(browser, { mode: 'preview', viewport: { width: 720, height: 480 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (/GPU (validation|internal)|Error while parsing WGSL|POV failed|failed to load/i.test(m.text())) errors.push(m.text());
  });
  await page.routeWebSocket(/.*/, () => {});
  // ?mode=noita deliberately opens the map's first scene. Select the test
  // scene in Sandbox, then use the real mode seam without reloading the map.
  await page.goto(`${base ?? 'http://127.0.0.1:54937'}/?size=world&scene=${key}&view=plain`);
  await ready(page);
  await page.waitForFunction(() => window.__app.win?.loaded && window.__app.pov, null, { polling: 100, timeout: 18000 });
  await page.evaluate(() => window.__app.setMode('noita'));
  await page.waitForFunction(() => window.__app.win?.loaded && window.__app.pov?.mode === 'on', null,
    { polling: 100, timeout: 18000 });
  const state = await page.evaluate(() => {
    const a = window.__app, p = a.pov.player;
    a.test.park();
    const feet = p.pos.clone().add(a.sim.origin).toArray();
    return { scene: a.win.scene.key, feet, source: a.win.scene.querySource(feet),
      worldSize: a.win.scene.size, health: p.health, mode: a.pov.mode, geometryWords: a.win.scene.data().words.length };
  });
  assert.equal(state.scene, key);
  assert.ok(state.health > 0);
  assert.ok(state.geometryWords > 1000);
  assert.equal(state.source.kind, 'source', 'body is in recorded native terrain, not a conversion cap');
  // This is a single-frame gameplay smoke shot, not a converged image
  // regression: animated Noita pickups can keep the presentation dirty.
  await page.evaluate(async () => {
    await window.__app.test.ready();
    await window.__app.test.renderOnce();
  });
  await page.screenshot({ path: out });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ state, gpu: await gpuInfo(page), screenshot: out, capture: 'single-frame smoke' }));
} catch (error) {
  console.error('Noita smoke check failed:', error.message, errors);
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
