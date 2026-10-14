import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage } from './browser.mjs';
const option = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`); return i < 0 ? fallback : process.argv[i + 1];
};
const base = `http://localhost:${option('port', '54973')}`, out = option('out', '/tmp/village-turnaround');
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1440, height: 1160 } });
  page.setDefaultTimeout(2000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/tools/harness/village-turnaround.html`);
  await page.waitForFunction(() => window.sheetReady);
  await page.screenshot({ path: join(out, 'all-angles.png') });
  await page.setViewportSize({ width: 600, height: 850 });
  await page.goto(`${base}/tools/harness/character.html?character=girl&view=rear`);
  await page.locator('canvas[data-ready=true]').waitFor();
  for (const persona of ['girl', 'boy']) {
    await page.locator(`[data-character=${persona}]`).click();
    await page.waitForFunction(persona => document.querySelector(`[data-character=${persona}]`).getAttribute('aria-pressed') === 'true', persona);
    for (const view of ['rear', 'side', 'front']) {
      await page.locator(`[data-view=${view}]`).click();
      assert.equal(await page.locator('#spin').getAttribute('aria-pressed'), 'false');
      await page.screenshot({ path: join(out, `${persona}-${view}.png`) });
    }
  }
  assert.equal(await page.locator('#err').textContent(), '');
  assert.deepEqual(errors, []);
  console.log(`PASS all six turnarounds and both playable characters in the actual viewer; captures ${out}`);
} finally {
  await browser.close();
}
