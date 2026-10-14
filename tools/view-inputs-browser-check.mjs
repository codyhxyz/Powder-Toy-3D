// Real app regression, local or deployed: node tools/view-inputs-browser-check.mjs [--url URL]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const urlArg = process.argv.indexOf('--url');
const vite = urlArg < 0 ? await startVite() : null;
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = vite?.origin ?? process.argv[urlArg + 1];
  await page.goto(`${base}/?size=64&preset=empty&view=plain&test=ui`);
  await ready(page);
  await page.evaluate(async () => {
    const a = window.__app;
    a.post.settings.taa = false;
    await a.test.ready();
    const input = document.createElement('input');
    input.id = 'render-ui-probe';
    input.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;width:200px;height:40px';
    document.body.append(input);
  });
  const settled = () => page.waitForFunction(() => window.__app.loop.asleep, null, { polling: 50, timeout: 60000 });
  const stats = () => page.evaluate(() => ({
    frame: window.__app.view.frame, submits: window.__app.gpu.stats.submits,
    callbacks: window.__app.loop.callbacks,
  }));
  await page.locator('#render-ui-probe').hover();
  await settled();
  const before = await stats();
  await page.locator('#render-ui-probe').fill('UI typing must not redraw the scene');
  await page.evaluate(() => {
    const a = window.__app;
    a.settings.propText = 'UI-only text';
    a.settings.radius++;
    a.settings.steps++;
  });
  await settled();
  const after = await stats();
  assert.ok(after.callbacks > before.callbacks, 'input still wakes the loop to inspect changes');
  assert.equal(after.frame, before.frame, 'UI-only input/settings do not draw');
  assert.equal(after.submits, before.submits, 'UI-only input/settings submit no GPU work');
  console.log('PASS UI typing, hidden brush radius, and simulation steps: zero draws/submits');

  const redraws = async (label, change) => {
    const b = await stats();
    await change();
    await page.waitForFunction(f => window.__app.view.frame > f, b.frame, { polling: 50, timeout: 15000 });
    await settled();
    console.log(`PASS ${label}: redraws and settles`);
  };
  await redraws('post-processing setting', () => page.evaluate(() => { window.__app.post.settings.exposure += 0.1; }));
  await redraws('resize', () => page.setViewportSize({ width: 820, height: 620 }));
  await redraws('canvas pointer pick/brush', () => page.mouse.move(410, 310));
  await page.waitForFunction(() => window.__app.hover.valid, null, { polling: 50, timeout: 10000 });
  await redraws('leaving canvas hides brush', () => page.locator('#render-ui-probe').hover());
  await redraws('explicit asynchronous invalidation', () => page.evaluate(() => window.__app.requestRender()));
  await page.evaluate(() => window.__app.test.park());
  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser?.close();
  await vite?.close();
}
