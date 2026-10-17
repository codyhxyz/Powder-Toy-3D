// One serialized <=25-second native slot; compilation and cleanup included.
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const vite = await startVite({ port: 58473, harness: true });
let browser, started;
try {
  started = Date.now();
  browser = await launchBrowser({ lifetimeMs: 25000 });
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/hybrid.html', { timeout: 15000, errors });
  const result = await page.evaluate(() => window.__harness.run());
  console.log(JSON.stringify({ ...result, adapter: await gpuInfo(page), errors }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await vite.close();
  if (started) console.log(`Total launch/player-check/compilation/assertion/cleanup occupancy: ${Date.now() - started} ms`);
}
