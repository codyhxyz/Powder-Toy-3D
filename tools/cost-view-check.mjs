// Real-GPU check of the cost view (docs/profiler.md "Cost view"): one boot of a map in manual mode,
// every pipeline ready, then __app.prof.cost.capture(). Prints the counters' stats and the honesty
// fields, saves the heatmap. Fails if the capture isn't trusted or covers no pixel.
// usage: node tools/cost-view-check.mjs [--map lab|island] [--out dir] [--port N] [--width W --height H]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('map', 'lab'), OUT = opt('out', null);
const viewport = { width: +opt('width', 1280), height: +opt('height', 720) };

const vite = await startVite({ warmupEntries: ['/src/main.js', '/src/app.js'] });
let browser, failed = false;
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.stack || e).slice(0, 600)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 600)); });
  await page.goto(vite.url(`/?map=${MAP}`));
  await page.waitForFunction(() => window.__app?.prof?.cost || document.getElementById('error')?.textContent, null, { polling: 100, timeout: 120000 });
  const bootErr = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (bootErr) throw new Error(`boot: ${bootErr.slice(0, 400)}`);
  await page.evaluate(() => window.__app.test.ready());
  console.log(`booted ${MAP} at ${secs()}`);
  const r = await page.evaluate(async () => {
    const a = window.__app;
    for (let i = 0; i < 4 && !a.vol.lastDraw; i++) await a.test.renderOnce();   // (a first frame that draws the volume)
    return a.prof.cost.capture();
  });
  console.log(`captured at ${secs()}`);
  const { image, counters, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
  console.log('counter            mean      p50   p95   max      sum        saturated');
  for (const [k, c] of Object.entries(counters)) {
    console.log(`${k.padEnd(14)} ${c.mean.toFixed(2).padStart(9)} ${String(c.p50).padStart(6)} ${String(c.p95).padStart(5)} ${String(c.max).padStart(6)} ${String(c.sum).padStart(12)} ${String(c.saturated).padStart(6)}`);
  }
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `cost-${MAP}-${r.kind}.png`), Buffer.from(image.split(',')[1], 'base64'));
    writeFileSync(join(OUT, `cost-${MAP}.json`), JSON.stringify({ ...rest, counters }, null, 1));
  }
  if (errs.length) console.log(`page errors:\n${errs.join('\n')}`);
  if (!r.trusted || !r.covered) { failed = true; console.log(`FAIL trusted=${r.trusted} covered=${r.covered} ${r.reason ?? ''}`); }
} catch (e) {
  failed = true;
  console.error(`FAIL ${e.stack || e}`);
} finally {
  await browser?.close();
  await vite.close();
}
console.log(`done at ${secs()}`);
process.exit(failed ? 1 : 0);
