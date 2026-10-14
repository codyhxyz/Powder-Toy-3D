// three's TAAU in the booted app on a real GPU (gfx/post.js, gpu/three.js
// createTemporalUpscaler): node tools/taau-check.mjs [--views plain,realistic]
//
// For each view and Upscaling preset the app boots (manual mode), converges a
// still view (test.render), then presents more frames of it: no page or GPU
// error, the scene renders at the preset's share of the canvas's pixels (Off:
// all of them), TAA's output is the canvas's size, and a still view holds
// still: consecutive frames differ by more than DIFF levels in under
// MAX_STILL_NOISE of the pixels (the "TV static" the hand-rolled TAAU left,
// which never converged). Then in motion: the camera orbits, and its last
// moving frame stays close to the same pose converged (no trails or smear: the
// motion pass's velocity reprojects the history). Shots are saved to --out.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const VIEWS = arg('--views', 'plain,realistic').split(',');
const OUT = arg('--out', 'test-results/taau');
const VIEWPORT = { width: 960, height: 600 };
const PRESETS = ['native', 'quality', 'balanced', 'performance'];
const DIFF = 2;                 // levels (of 255) a pixel must move by to count as changed
const MAX_STILL_NOISE = 0.01;   // share of the canvas a still, converged view may change between frames
const FRAMES = 4;               // frames compared after convergence
const ORBIT_STEP = 0.01;        // radians the camera orbits a frame in the motion test (~14 pixels a frame here)
const ORBIT_FRAMES = 12;
const MOTION_DIFF = 32;         // levels a moving frame's pixel must differ from the still's to count
const MAX_MOTION_CHANGE = 0.05; // share of the canvas that may (disocclusion, the newest frame's weight)
// what the page may log without it being an error of ours: the relay the UI asks for quota (not running here; tools/smoke.mjs)
const IGNORE = [/Failed to load resource: net::ERR_CONNECTION_REFUSED/];

mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

const vite = await startVite();
const browser = await launchBrowser();
try {
  for (const view of VIEWS) {
    const page = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.stack || e).slice(0, 400)}`));
    page.on('console', (m) => {
      const t = m.text();
      if (IGNORE.some((r) => r.test(t))) return;
      if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed/i.test(t))) errors.push(`${m.type()}: ${t.slice(0, 400)}`);
    });
    await page.goto(vite.url(`/?size=64&preset=lab&view=${view}`));
    await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 180000 });
    const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
    ok(!failed, `boot ${view}${failed ? `: ${failed.slice(0, 300)}` : ''}`);
    if (failed) { await page.close(); continue; }
    await page.evaluate(() => __app.test.ready());
    for (const preset of PRESETS) {
      const r = await page.evaluate(async ({ preset, frames, diff }) => {
        const a = window.__app;
        a.settings.upscale = preset;
        a.post.settings.taa = true;
        a.test.resetView();
        const converged = await a.test.render();
        const shots = [];
        for (let i = 0; i < frames; i++) shots.push(await a.test.renderOnce({ capture: true }));
        let worst = 0, mean = 0;
        for (let i = 1; i < shots.length; i++) {
          const x = shots[i - 1].data, y = shots[i].data;
          let n = 0, sum = 0;
          for (let k = 0; k < x.length; k += 4) {
            const d = Math.max(Math.abs(x[k] - y[k]), Math.abs(x[k + 1] - y[k + 1]), Math.abs(x[k + 2] - y[k + 2]));
            if (d > diff) n++;
            sum += d;
          }
          worst = Math.max(worst, n / (x.length / 4));
          mean = Math.max(mean, sum / (x.length / 4));
        }
        let lit = 0;
        const last = shots.at(-1).data;
        for (let k = 0; k < last.length; k += 4) lit = Math.max(lit, last[k], last[k + 1], last[k + 2]);
        const t = a.post.targets;
        return {
          converged, worst, mean, lit, size: a.post.size, inSize: a.post.inSize, scale: a.post.renderScale,
          resolved: [t.resolved.width, t.resolved.height], taau: t.resolved !== t.scene, settle: a.post.settleWeight,
        };
      }, { preset, frames: FRAMES, diff: DIFF });
      await page.screenshot({ path: join(OUT, `${view}-${preset}.png`) });
      const share = (r.inSize[0] / r.size[0]).toFixed(3);
      ok(r.taau && r.resolved[0] === r.size[0] && r.resolved[1] === r.size[1],
        `${view} ${preset}: TAAU resolves ${r.inSize.join('×')} (×${share}) to ${r.resolved.join('×')}, canvas ${r.size.join('×')}`);
      ok(preset !== 'native' || (r.inSize[0] === r.size[0] && r.inSize[1] === r.size[1]), `${view} ${preset}: Off renders every canvas pixel`);
      ok(r.lit > 16, `${view} ${preset}: the frame isn't black (brightest channel ${r.lit})`);
      ok(r.worst < MAX_STILL_NOISE,
        `${view} ${preset}: still view after ${r.converged} frames (settle weight ${r.settle}): ${(100 * r.worst).toFixed(2)}% of pixels change by > ${DIFF} levels between frames (mean |Δ| ${r.mean.toFixed(3)})`);
    }
    // In motion: the camera orbits ORBIT_STEP radians a frame for ORBIT_FRAMES frames; the last moving
    // frame, against the same pose converged still, differs by more than MOTION_DIFF levels in under
    // MAX_MOTION_CHANGE of the pixels (reprojection by the motion pass's velocity: no trails, no smear)
    for (const preset of ['native', 'performance']) {
      const m = await page.evaluate(async ({ preset, step, frames, diff }) => {
        const a = window.__app;
        a.settings.upscale = preset;
        a.test.resetView();
        await a.test.render();
        const { camera, controls } = a;
        const axis = new a.THREE.Vector3(0, 1, 0);
        let moving = null;
        for (let i = 0; i < frames; i++) {
          camera.position.sub(controls.target).applyAxisAngle(axis, step).add(controls.target);
          camera.lookAt(controls.target);
          moving = await a.test.renderOnce({ capture: true });
        }
        await a.test.render();
        const still = await a.test.renderOnce({ capture: true });
        let n = 0;
        for (let k = 0; k < still.data.length; k += 4) {
          const d = Math.max(...[0, 1, 2].map((c) => Math.abs(still.data[k + c] - moving.data[k + c])));
          if (d > diff) n++;
        }
        return n / (still.data.length / 4);
      }, { preset, step: ORBIT_STEP, frames: ORBIT_FRAMES, diff: MOTION_DIFF });
      await page.screenshot({ path: join(OUT, `${view}-${preset}-moved.png`) });
      ok(m < MAX_MOTION_CHANGE, `${view} ${preset}: orbiting ${ORBIT_FRAMES} frames, the last differs from the same pose still by > ${MOTION_DIFF} levels in ${(100 * m).toFixed(2)}% of pixels`);
    }
    ok(!errors.length, `${view}: no page or GPU errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log(failures ? `taau-check: ${failures} failure(s)` : 'taau-check: ok');
process.exit(failures ? 1 : 0);
