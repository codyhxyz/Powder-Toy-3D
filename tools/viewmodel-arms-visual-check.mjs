// One <=10s GPU slot, no world simulation or gameplay loop.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const vite = await startVite({ harness: true });
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 1440, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/arms-preview', route => route.fulfill({
    contentType: 'text/html',
    body: '<body style="margin:0"><script type="module">window.previewReady=true</script></body>',
  }));
  await page.goto(vite.url('/arms-preview'));
  await page.waitForFunction(() => window.previewReady);
  const result = await page.evaluate(async () => (await import('/tools/harness/viewmodel-arms.js')).preview());
  assert.deepEqual(result, [{ choice: 'stick', real: false }, { choice: 'real', real: true }, { choice: 'real', real: true }]);
  await page.screenshot({ path: '/tmp/tpt-viewmodel-arms.png' });
  await page.evaluate(() => {
    for (const f of window.armsPreview.fixtures) { f.model.dispose(); f.rig.dispose(); }
    window.armsPreview.renderer.dispose();
  });
  assert.deepEqual(errors, []);
  console.log('Stick jackhammer / muscular jackhammer / muscular pistol: /tmp/tpt-viewmodel-arms.png');
} finally {
  await browser?.close();
  await vite.close();
}
