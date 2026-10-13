// The start menu's map previews (public/maps/<key>.webp): every map in
// src/maps.js, rendered by the app itself from its home view, square, the way
// Garry's Mod shows a map before you load it. Rerun after changing a map, on
// a real GPU: the previews are the game's own view at its own window.
// usage: node tools/map-thumbs.mjs [--port 5733] [--only key,key] [--out dir] [--quick]
// Runs its own Vite (tools/vite-server.mjs; --port: on that port).
// --quick (the container's SwiftShader, docs/webgpu.md I1): a world's window
// 64 wide (?win=64) in the plain view (?view=plain), and the far field not
// waited out (its whole build is minutes there; the plain view doesn't draw
// it anyway), and the shot is one frame (test.renderOnce), not a converged
// one: a check that the tool runs, not previews to commit, so they go to
// /tmp/map-thumbs unless --out says where.
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { MAPS, isWorld } from '../src/maps.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', '5733'));
const only = (opt('only', '') ?? '').split(',').filter(Boolean);
const QUICK = args.includes('--quick');
const OUT = opt('out', QUICK ? '/tmp/map-thumbs' : join(new URL('..', import.meta.url).pathname, 'public/maps'));

const RENDER = 900;          // px: the square the app renders
const SIZE = 400;            // px: the preview (a menu card is ~150 px, twice that on a retina screen)
const QUALITY = 80;          // webp quality
const SUN = { az: 35, el: 32 };   // degrees: a warm afternoon light on every map
const STEPS = 90;            // simulation steps before the shot: lava glows, sand starts to fall
const LOAD_TIMEOUT = 180000; // ms: a cold shader compile plus a world's far field
// per map: the home view pulled in or out (× its distance to the target)
const ZOOM = { damValley: 0.72, willowCove: 1.8 };

// ImageMagick 7's `magick`, else 6's `convert` (the same arguments)
function toWebp(png, file) {
  const argv = ['png:-', '-resize', `${SIZE}x${SIZE}`, '-quality', String(QUALITY), file];
  try {
    execFileSync('magick', argv, { input: png });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    execFileSync('convert', argv, { input: png });
  }
}

mkdirSync(OUT, { recursive: true });
const vite = await startVite({ port });
const browser = await launchBrowser();
const errs = [];
try {
  for (const m of MAPS.filter((x) => !only.length || only.includes(x.key))) {
    const p = await newTestPage(browser, { mode: 'ui', viewport: { width: RENDER, height: RENDER } });
    try {
      p.on('pageerror', (e) => errs.push(`${m.key}: ${String(e).slice(0, 300)}`));
      // (the relay the UI asks for quota isn't running here)
      p.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('ERR_CONNECTION_REFUSED')) errs.push(`${m.key}: ${msg.text().slice(0, 300)}`); });
      await p.addInitScript(() => addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style');
        st.textContent = 'body * { visibility: hidden !important; } #app > canvas { visibility: visible !important; }';
        document.head.appendChild(st);
      }));
      const t0 = Date.now();
      await p.goto(vite.url(`/?map=${m.key}${QUICK ? '&win=64&view=plain' : ''}`), { timeout: LOAD_TIMEOUT });
      await ready(p);
      // Keep callbacks live until the world's far field has finished filling in.
      if (isWorld(m)) {
        await p.waitForFunction((quick) => window.__app.win?.loaded && window.__app.win.far.ready && (quick || !window.__app.win.far.queue.length),
          QUICK, { timeout: LOAD_TIMEOUT, polling: 500 });
      }
      await p.evaluate(async ([sun, steps, zoom]) => {
        const a = window.__app;
        a.test.park();
        await a.test.ready();   // (the grid's pipelines: test.step needs them built)
        a.autoRes.enabled = false;
        a.renderer.setPixelRatio(1);
        a.renderer.setSize(innerWidth, innerHeight);
        dispatchEvent(new Event('resize'));
        a.day.fixed = sun;
        a.settings.paused = true;
        a.test.step(steps);
        a.rig.reset(true);
        a.camera.position.sub(a.controls.target).multiplyScalar(zoom).add(a.controls.target);
        a.controls.update();
        a.post.reset();
      }, [SUN, STEPS, ZOOM[m.key] ?? 1]);
      if (QUICK) await p.evaluate(() => window.__app.test.renderOnce());
      else await render(p);
      const png = await p.screenshot({ type: 'png' });
      toWebp(png, join(OUT, `${m.key}.webp`));
      console.log(`${m.key}: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${join(OUT, `${m.key}.webp`)}`);
    } finally {
      await p.close();
    }
  }
  console.log(errs.length ? errs.join('\n') : 'no errors');
} finally {
  await browser.close();
  await vite.close();
}
