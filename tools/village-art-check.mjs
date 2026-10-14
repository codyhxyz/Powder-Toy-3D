// One static model sheet; no simulation, animation loop, or boot compilation.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';
const option = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`); return i < 0 ? fallback : process.argv[i + 1];
};
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${option('url', 'http://localhost:54973')}/tools/harness/village-characters.html`);
  await page.waitForFunction(() => window.sheetReady);
  assert.equal(await page.evaluate(() => modelSheet.length), 6);
  await page.screenshot({ path: option('out', '/tmp/village-characters.png') });
  await page.evaluate(() => window.draw(3, true));
  assert.deepEqual(errors, []);
  console.log('PASS six character models, front / three-quarter views and talking pose');
} finally {
  await browser.close();
}
