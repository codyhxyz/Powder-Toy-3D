// The start menu's map previews (public/maps/<key>.webp): every map in
// src/maps.js, rendered by the app itself from its home view, square, the way
// Garry's Mod shows a map before you load it. Rerun after changing a map.
// Needs a dev server: `npx vite --port 5733 --strictPort`, then
// usage: node tools/map-thumbs.mjs [--port 5733] [--only key,key]
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { MAPS, isWorld } from '../src/maps.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5733');
const only = (opt('only', '') ?? '').split(',').filter(Boolean);
const OUT = join(new URL('..', import.meta.url).pathname, 'public/maps');

const RENDER = 900;          // px: the square the app renders
const SIZE = 400;            // px: the preview (a menu card is ~150 px, twice that on a retina screen)
const QUALITY = 80;          // webp quality
const SUN = { az: 35, el: 32 };   // degrees: a warm afternoon light on every map
const STEPS = 90;            // simulation steps before the shot: lava glows, sand starts to fall
const LOAD_TIMEOUT = 180000; // ms: a cold shader compile plus a world's far field
// per map: the home view pulled in or out (× its distance to the target)
const ZOOM = { damValley: 0.72, willowCove: 1.8 };

mkdirSync(OUT, { recursive: true });
const browser = await launchBrowser();
const errs = [];
try {
  for (const m of MAPS.filter((x) => !only.length || only.includes(x.key))) {
    const p = await newTestPage(browser, { mode: 'ui', viewport: { width: RENDER, height: RENDER } });
    try {
      p.on('pageerror', (e) => errs.push(`${m.key}: ${String(e).slice(0, 300)}`));
      p.on('console', (msg) => { if (msg.type() === 'error') errs.push(`${m.key}: ${msg.text().slice(0, 300)}`); });
      await p.addInitScript(() => addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style');
        st.textContent = 'body * { visibility: hidden !important; } #app > canvas { visibility: visible !important; }';
        document.head.appendChild(st);
      }));
      const t0 = Date.now();
      await p.goto(`http://localhost:${port}/?map=${m.key}`, { timeout: LOAD_TIMEOUT });
      await ready(p);
      // Keep callbacks live until the world's far field has finished filling in.
      if (isWorld(m)) await p.waitForFunction(() => window.__app.win?.loaded && window.__app.win.far.ready && !window.__app.win.far.queue.length, null, { timeout: LOAD_TIMEOUT, polling: 500 });
      await p.evaluate(([sun, steps, zoom]) => {
        const a = window.__app;
        a.test.park();
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
      await render(p);
      const png = await p.screenshot({ type: 'png' });
      execFileSync('magick', ['png:-', '-resize', `${SIZE}x${SIZE}`, '-quality', String(QUALITY), join(OUT, `${m.key}.webp`)], { input: png });
      console.log(`${m.key}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } finally {
      await p.close();
    }
  }
  console.log(errs.length ? errs.join('\n') : 'no errors');
} finally {
  await browser.close();
}
