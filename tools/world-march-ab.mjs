// GPU A/B shot of the seamless world's march (gfx/worldView.js) against the box's march, on a small
// map, where physics' window is the whole world (origin 0) and W/F/L's stand-ins serve the window's
// own resources: the two pictures should agree. One browser, one page, TAA off, the same frame.
// usage: node tools/world-march-ab.mjs <outDir> [--query '?size=64&preset=lab&view=realistic']
// Hypothesis, written before the run: both draw, no WebGPU error, and the share of pixels differing
// by more than DIFF (8/255) is under 2 %; a binding or coordinate mistake shows as a large share.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const out = args[0] ?? 'artifacts/world-march-ab';
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const query = opt('query', '?size=64&preset=lab&view=realistic');
const DIFF = 8;
mkdirSync(out, { recursive: true });

const vite = await startVite();
let browser = null;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.stack || e).slice(0, 600)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed|WGSL/i.test(t))) errors.push(`${m.type()}: ${t.slice(0, 1500)}`);
  });
  const t0 = Date.now();
  await page.goto(vite.url(`/${query}`));
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 20000 });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot failed: ${failed.slice(0, 800)}`);
  console.log('gpu', JSON.stringify((await gpuInfo(page))?.adapter ?? {}));
  const r = await page.evaluate(async ({ DIFF }) => {
    const a = window.__app;
    a.post.settings.taa = false;
    await a.test.ready();
    const share = (x, y) => {
      let n = 0, sum = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        const d = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2]));
        if (d > DIFF) n++;
        sum += d;
      }
      return { share: n / (x.width * x.height), mean: sum / (x.width * x.height) };
    };
    const tWorld = performance.now();
    // the world march's pipeline builds on its first frame: frames until it draws (or 12 s)
    for (let i = 0; i < 400 && !(a.view.volumeDrawn); i++) { await a.test.renderOnce(); await new Promise((res) => setTimeout(res, 30)); if (performance.now() - tWorld > 12000) break; }
    const worldBuildMs = performance.now() - tWorld;
    const worldDrawn = a.view.volumeDrawn;
    await a.test.renderOnce();
    a.test.resetView();
    const world = await a.test.renderOnce({ capture: true });
    const tBox = performance.now();
    await a.test.renderOnce({ boxMarch: true });
    const boxBuildMs = performance.now() - tBox;
    a.test.resetView();
    const box = await a.test.renderOnce({ capture: true, boxMarch: true });
    const boxDrawn = a.view.volumeDrawn;
    const none = await a.test.renderOnce({ capture: true, volume: false });
    const toB64 = (s) => { const c = document.createElement('canvas'); c.width = s.width; c.height = s.height; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(s.data), s.width, s.height), 0, 0); return c.toDataURL('image/png'); };
    return {
      worldDrawn, boxDrawn, worldBuildMs, boxBuildMs, ab: share(world, box), worldVsNone: share(world, none), boxVsNone: share(box, none),
      pipelines: a.worldView?.pipelines ?? null, world: toB64(world), box: toB64(box),
    };
  }, { DIFF });
  for (const k of ['world', 'box']) writeFileSync(join(out, `${k}.png`), Buffer.from(r[k].split(',')[1], 'base64'));
  delete r.world; delete r.box;
  console.log(JSON.stringify(r, null, 1));
  console.log(`errors: ${errors.length}`); for (const e of errors.slice(0, 8)) console.log(' ', e);
  console.log(`slot ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} finally {
  await browser?.close();
  await vite.close();
}
