// One <=10-second slot: real shader-picker clicks, persistence, optical shader
// readiness and a paused frame. Pass --url to check the deployed build.
import assert from 'node:assert/strict';
import { preview } from 'vite';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const argv = process.argv.slice(2), at = argv.indexOf('--url');
let server, browser;
const errors = [];
try {
  if (at < 0) server = await preview({
    root: new URL('../', import.meta.url).pathname,
    preview: { host: '127.0.0.1', port: 54889, strictPort: true },
  });
  const origin = at < 0 ? 'http://127.0.0.1:54889' : argv[at + 1];
  assert(origin);
  browser = await launchBrowser({ lifetimeMs: 10000 });
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 960, height: 640 } });
  page.setDefaultTimeout(3500);
  page.setDefaultNavigationTimeout(3500);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED')) errors.push(m.text());
  });
  // The existing 64³ Lab fixture is only a settings smoke, not a physics test.
  await page.goto(`${origin}/?size=64&preset=lab&paused=1&test=ui`);
  let bootTimer;
  try {
    await Promise.race([ready(page), new Promise((_, reject) => {
      bootTimer = setTimeout(() => reject(new Error('App boot exceeded this short GPU slot; no picker assertions ran')), 3500);
    })]);
  } finally { clearTimeout(bootTimer); }
  const initial = await page.evaluate(() => ({ version: __app.sim.version, view: __app.settings.view }));
  assert.equal(initial.view, 0);
  await page.getByRole('button', { name: 'Change shader', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Shaders', exact: true });
  await panel.getByRole('button', { name: 'Cozy', exact: true }).click();
  await page.waitForFunction(() => __app.settings.view === 6);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('powder-toy-3d:settings'))?.view === 6);
  assert.equal(await page.evaluate(() => 'materialStyle' in JSON.parse(localStorage.getItem('powder-toy-3d:settings'))), false);
  await panel.getByRole('button', { name: 'Realistic', exact: true }).click();
  await page.waitForFunction(() => __app.settings.view === 0);
  await panel.getByRole('button', { name: 'Cozy', exact: true }).click();
  await page.waitForFunction(() => __app.settings.view === 6);
  await panel.getByRole('button', { name: 'Close shaders', exact: true }).click();
  await render(page);
  assert.equal(await page.evaluate(() => __app.sim.version), initial.version, 'view changes do not mutate physics');
  assert.equal(await page.evaluate(() => __app.view.volumeDrawn), true, 'Cozy frame uses the actual voxel renderer');
  assert.equal(await page.evaluate(() => __app.gpu.lost), false);
  assert.deepEqual(errors, []);
  console.log('Cozy app: Shaders picker, saved view, A/B switches, actual paused voxel frame and unchanged physics passed.');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
