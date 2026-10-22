// Headless partial World load: what a big map's first attempts ask for
// (window.__app.win.render.progress: requirements, support, sun tiles, coarse
// tiles, forecast bricks, stage), sampled until the slot's budget runs out.
// A World load's attempt 1 starts ~1 s after the map starts, so even a short
// slot shows the first attempt's demand. Launches Chromium (tools/browser.mjs).
//   node tools/world-load-progress-browser-check.mjs [--map island] [--ms 19000] [--port N]
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('map', 'island'), SAMPLE_MS = 250, WATCH_MS = +opt('ms', 19000);
const vite = await startVite();
let browser, t0 = null;
try {
  t0 = Date.now();
  browser = await launchBrowser();
  const slot = Date.now();
  const page = await newTestPage(browser, { mode: 'preview', viewport: { width: 640, height: 360 } });
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`console error: ${m.text()}`); });
  await page.goto(vite.url(`/?map=${MAP}`), { waitUntil: 'commit' });
  const rows = new Map();
  let last = '';
  while (Date.now() - slot < WATCH_MS) {
    const p = await page.evaluate(() => { const r = window.__app?.win?.render; return r ? { ...r.progress, state: r.state, failure: r.failure ? String(r.failure.message ?? r.failure) : null } : null; }).catch(() => null);
    if (p) {
      rows.set(p.attempts, p);
      const line = `${((Date.now() - slot) / 1000).toFixed(1)} s att ${p.attempts} ${p.stage}: req ${p.requirements} (support ${p.support}) sun ${p.sunTiles} coarse ${p.coarseTiles} forecast ${p.forecastBricks} md ${p.metadataBricks} src ${p.sources} gat ${p.gathers} cellPages ${p.cellPages}${p.failure ? ` FAILURE ${p.failure}` : ''}`;
      const key = `${p.attempts} ${p.stage} ${p.requirements} ${p.sunTiles}`;
      if (key !== last) { console.log(line); last = key; }
    }
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
  console.log(`watched ${WATCH_MS / 1000} s after launch; ${rows.size ? `last attempt ${Math.max(...rows.keys())}` : 'no World load seen'}`);
} finally {
  await browser?.close();
  if (t0 != null) console.log(`GPU slot held ${((Date.now() - t0) / 1000).toFixed(1)} s (launch call to browser closed)`);
  await vite.close();
}
