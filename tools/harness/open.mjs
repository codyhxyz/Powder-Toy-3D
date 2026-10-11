// Node side of the GPU harness: opens a harness page in a test page and waits
// until it has booted (window.__harness.ready). Launch the browser with
// tools/browser.mjs and the server with tools/vite-server.mjs ({ harness: true }).
//
//   const vite = await startVite({ harness: true });
//   const browser = await launchBrowser();
//   try {
//     const page = await openHarness(browser, vite, '/tools/harness/foundation.html');
//     const result = await page.evaluate(() => window.__harness.run('params'));
//   } finally { await browser.close(); await vite.close(); }
import { newTestPage } from '../browser.mjs';

/**
 * @param {import('playwright').Browser} browser
 * @param {{ url: (path: string) => string }} vite
 * @param {string} path the page, e.g. '/tools/harness/foundation.html'
 * @param {{ mode?: string, viewport?: { width: number, height: number }, timeout?: number, errors?: string[] }} [opts]
 *   errors: page errors and console errors are pushed here as they happen
 * @returns {Promise<import('playwright').Page>}
 */
export async function openHarness(browser, vite, path, { mode = 'manual', viewport = { width: 400, height: 250 }, timeout = 120000, errors = [] } = {}) {
  const page = await newTestPage(browser, { mode, viewport });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(vite.url(path));
  await page.waitForFunction(() => window.__harness?.ready, null, { polling: 100, timeout });
  const error = await page.evaluate(() => window.__harness.error);
  if (error) throw new Error(`${path}: ${error}`);
  return page;
}
