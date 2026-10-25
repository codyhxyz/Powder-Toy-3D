// Deterministic far-view stills (a World map through a small window, ?win=64,
// on WebGPU: docs/webgpu.md G1), to prove a change to how the far field is
// packed or read changed no pixels: tools/regress.mjs's method in a world.
// Manual mode (the app's loop parked), TAA off, the sun fixed, Math.random
// seeded, the chunks around the window built (the whole far build is minutes
// of SwiftShader: CHUNKS of them, the nearest), then for each view the
// animation clock and frame counter reset (test.resetView) and one frame
// drawn and shot (test.renderOnce). A frame of the far view is about a minute
// of SwiftShader here at this size: one view by default (--views). The far
// grid's own data compares exactly with tools/island-dump.mjs.
// usage: node tools/far-regress.mjs <outDir> [--map island] [--views god,out] [--port N]
// Compare two runs with: compare -metric AE a.png b.png null:
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!out || out.startsWith('--')) { console.error('usage: node tools/far-regress.mjs <outDir> [--map island] [--views god,out]'); process.exit(2); }
const MAP = opt('map', 'island');
mkdirSync(out, { recursive: true });

const SEED = 12345;
const SUN = { az: 215, el: 38 };   // tools/far-check.mjs's
const CHUNKS = 9;                  // far chunks built around the window (the nearest)
const VIEWPORT = { width: 192, height: 120 };
// [name, camera, target] in world cells from the window's centre (x, y, z): a
// god view over the window and the far field around it, and a look away from
// the window, over the far field's hills, coast and sea
const VIEWS = [
  ['god', [-180, 200, 220], [0, 20, -20]],
  ['out', [0, 90, 0], [300, 0, 260]],
];
const want = opt('views', 'god').split(',');

const vite = await startVite();
const b = await launchBrowser();
let code = 0;
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: VIEWPORT });
  await p.addInitScript((SEED) => {
    // mulberry32: same draws every run
    const seeded = (seed) => { let s = seed; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    Math.random = seeded(SEED);
    addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = 'body *{visibility:hidden !important} canvas{visibility:visible !important}';
      document.head.appendChild(st);
    });
  }, SEED);
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
  await p.goto(vite.url(`/?map=${MAP}&win=64`));
  await p.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 300000 });
  await p.evaluate(async (CHUNKS) => {
    const a = window.__app, f = a.win.far;
    await a.test.ready();
    f.queue = f.queue.slice(-CHUNKS);
    while (f.queue.length) { f.chunks(1); await a.gpu.fence(); }
    await f.viewPipe.build();
  }, CHUNKS);
  for (const [name, cam, tgt] of VIEWS.filter(([n]) => want.includes(n))) {
    await p.evaluate(async ([cam, tgt, SUN]) => {
      const a = window.__app, g = a.sim.g;
      a.post.settings.taa = false;   // TAA's history isn't part of a still
      a.day.fixed = SUN;
      // world cells (from the window's centre) to scene units
      const s = a.scale, v = a.volume.position;
      const scene = (q) => [v.x + (g.nx / 2 + q[0]) * s, v.y + q[1] * s, v.z + (g.nz / 2 + q[2]) * s];
      a.camera.position.set(...scene(cam));
      a.controls.target.set(...scene(tgt));
      a.controls.update();
      a.test.resetView();
      await a.test.renderOnce();
    }, [cam, tgt, SUN]);
    await p.screenshot({ path: `${out}/${name}.png` });
    console.log(`${name}: ${out}/${name}.png`);
  }
  if (errs.length) { console.log(errs.join('\n')); code = 1; } else console.log('no console errors');
  await p.close();
} catch (e) {
  console.log(`FAIL ${e.message}`);
  code = 1;
} finally {
  await b.close();
  await vite.close();
}
process.exit(code);
