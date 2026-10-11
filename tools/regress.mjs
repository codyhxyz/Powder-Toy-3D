// Deterministic render regression: seeds Math.random, loads a preset, runs a
// fixed number of sim steps by hand (no wall-clock dependence), resets the
// view's clocks, renders from fixed cameras and screenshots them.
//
// The WebGL build's shots aren't a baseline for this one (docs/webgpu.md I4.4:
// cross-API AE isn't 0): a run of this build into a directory makes the
// baseline (review it against the WebGL sheets once, by eye), and later runs
// compare with it (--against): AE 0 at 1% fuzz, per shot.
//
//   node tools/regress.mjs <outDir> [--against <baselineDir>] [--size 128] [--steps 300]
//     [--viewport 1280x800] [--view realistic] [--detail off|on|default] [--adapt off] [--motion] [--port N]
//
//   --against: compare each shot with the one of that name there
//     (ImageMagick's compare -metric AE -fuzz 1%); fails on any AE above 0
//   --size, --steps, --viewport: the grid (a box: SIZES key), the steps before
//     the shots and the page. In the container (SwiftShader), --size 64
//     --steps 8 --viewport 400x250 --view plain is a 3-minute run: a preset's
//     first shot waits out the derived passes' settle (22 frames, the GI's
//     blend), and a realistic frame there takes 5-20 s
//   --view: the view the shots are in (views.js key)
//   --detail: close-up detail features (gfx/detail.js) all off (the default,
//     so a feature switched off can be proven pixel-identical), all on, or as
//     their cost tiers set them
//   --adapt off: eye adaptation (gfx/post.js ADAPT) held at gain 1, to prove
//     it leaves daylight views alone (compare against a run without it)
//   --motion: the views mid-motion instead: the sim runs (4 steps a frame, some
//     views painting every frame) right up to the shot, so the fields, bricks
//     and GI are caught mid-change (docs/scaling.md D9). Frames run one at a
//     time through __app.test (the loop parked), never on the browser's timing.
//
// Pages run in 'visual' mode (full presentation quality), the app loop parked
// (__app.test.park) from the first shot on: steps through test.step, frames
// through test.render / test.renderOnce. TAA is off (its jitter index isn't
// resettable: un-jittered frames compare).
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { DETAIL, settingKey, detailDefaults } from '../src/gfx/detail.js';

const args = process.argv.slice(2);
const out = args[0];
if (!out || out.startsWith('--')) { console.error('usage: node tools/regress.mjs <outDir> [--against <dir>] [options]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const motion = args.includes('--motion');
const adapt = opt('adapt', 'on') !== 'off';
const against = opt('against', null);
const size = opt('size', '128');
const STEPS = opt('steps', null);
const [vw, vh] = opt('viewport', '1280x800').split('x').map(Number);
const viewKey = opt('view', 'realistic');
mkdirSync(out, { recursive: true });
const detailMode = opt('detail', 'off');
const detail = detailMode === 'default' ? detailDefaults()
  : Object.fromEntries(DETAIL.map((f) => [settingKey(f), detailMode === 'on']));

const views = {
  lab: { steps: 300, cams: { lab: [[11, 12.5, 13], [0, 2.5, 0]], labLava: [[3.6, 1.5, 3.6], [2.6, 0.9, 2.6]], labTank: [[0.6, 2.9, 1.6], [-2.2, 1.4, -2.2]] } },
  volcano: { steps: 300, cams: { volcano: [[11, 12.5, 13], [0, 2.5, 0]], summit: [[1.3, 4.3, 1.6], [0, 3.6, 0]] } },
};
// --motion: [preset, steps before, camera, target, brush stroke repeated every frame or null]
const MOTION_FRAMES = 24;   // frames the sim runs (4 steps each) between the camera and the shot
const ELEMENT = { WATER: 7, SAND: 2 };   // brush tools (elements.js ids)
// (stroke centres are in 128³ cells; scaled to --size)
const motionViews = {
  mLab: ['lab', 300, [11, 12.5, 13], [0, 2.5, 0], null],
  mLava: ['lab', 300, [3.6, 1.5, 3.6], [2.6, 0.9, 2.6], null],
  mTank: ['lab', 300, [0.6, 2.9, 1.6], [-2.2, 1.4, -2.2], null],
  mPaint: ['lab', 300, [11, 12.5, 13], [0, 2.5, 0], { center: [96, 40, 30], radius: 5, tool: ELEMENT.WATER }],
  mPaintSand: ['lab', 300, [6, 6, 8], [0, 1.5, 0], { center: [64, 20, 100], radius: 4, tool: ELEMENT.SAND }],
  mVolcano: ['volcano', 300, [11, 12.5, 13], [0, 2.5, 0], null],
  mSummit: ['volcano', 300, [1.3, 4.3, 1.6], [0, 3.6, 0], null],
  mIsland: ['island', 200, [11, 12.5, 13], [0, 2.5, 0], null],
};

const vite = await startVite();
const b = await launchBrowser();
const shots = [];
const errs = [];
try {
  const p = await newTestPage(b, { mode: 'visual', viewport: { width: vw, height: vh } });
  await p.addInitScript((detail) => {
    // mulberry32: same scene every run
    const seeded = (seed) => { let s = seed; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const SEED = 12345;
    Math.random = seeded(SEED);
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify(detail));
    // the UI (hint toast, sliders) animates on wall-clock timers: hide it
    addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = 'body > *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';
      document.head.appendChild(st);
    });
    // Load a preset into a known state. Math.random starts over first: three.js
    // draws a UUID from it for every material, geometry and target it makes, so
    // a build that makes a different number of them before this would give the
    // cells other seeds. Besides the sim's step counters, the GI: the boot
    // frames (as many as the page managed) left its probes, so start them over.
    window.__load = (preset) => {
      const a = window.__app;
      Math.random = seeded(SEED);
      a.loadPreset(preset, false);
      a.sim.frame = 0;    // the sim's random streams are seeded by its step counter
      a.sim.paints = 0;   // …and the brush's by its stroke counter
      a.sim.resetGI();
    };
  }, detail);
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 500)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
  await p.goto(vite.url(`/?size=${size}&preset=lab&paused=1&view=${viewKey}`));
  await p.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 180000 });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 400)}`);
  await p.evaluate(async (adapt) => {
    const a = window.__app;
    a.test.park();
    a.settings.paused = true;
    a.autoRes.enabled = false;
    a.post.settings.taa = false;
    a.post.settings.adapt = adapt;
    await a.test.ready();
  }, adapt);
  const t0 = Date.now(), secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const cellScale = Number(size) / 128;

  // One preset into its known state, `steps` steps, the scene's frame (the
  // derived passes over the new state) with the clocks then reset.
  const prepare = (preset, steps) => p.evaluate(async ([preset, steps]) => {
    const a = window.__app;
    // The app may have run frames before the park, so the day clock (the sun)
    // has advanced by however many: put it back to the start of the day.
    a.day.clock = 0;
    window.__load(preset);
    await a.test.ready();
    for (let left = steps; left > 0; left -= 50) { a.test.step(Math.min(50, left)); await a.gpu.fence(); }
    await a.test.renderOnce();
  }, [preset, steps]);
  const aim = (pos, tgt) => p.evaluate(([pos, tgt]) => {
    const a = window.__app;
    a.camera.position.set(...pos);
    a.controls.target.set(...tgt);
    a.controls.update();
    a.test.resetView();
  }, [pos, tgt]);

  if (motion) {
    for (const [name, [preset, steps, pos, tgt, stroke]] of Object.entries(motionViews)) {
      await prepare(preset, STEPS === null ? steps : Number(STEPS));
      await aim(pos, tgt);
      await p.evaluate(async ([frames, stroke, k]) => {
        const a = window.__app, V = a.camera.position.constructor;
        for (let i = 0; i < frames; i++) {
          if (stroke) a.sim.paint({ center: new V(...stroke.center.map((x) => Math.round(x * k))), radius: stroke.radius, shape: 0, tool: stroke.tool, rate: 1, replace: false });
          a.test.step(4);
          await a.test.renderOnce();
        }
      }, [MOTION_FRAMES, stroke, cellScale]);
      await p.screenshot({ path: join(out, `${name}.png`) });
      shots.push(name);
      console.log(`${name} (${secs()})`);
    }
  } else {
    for (const [preset, v] of Object.entries(views)) {
      await prepare(preset, STEPS === null ? v.steps : Number(STEPS));
      for (const [name, [pos, tgt]] of Object.entries(v.cams)) {
        await aim(pos, tgt);
        await p.evaluate(() => window.__app.test.render());
        await p.screenshot({ path: join(out, `${name}.png`) });
        shots.push(name);
        console.log(`${name} (${secs()})`);
      }
    }
  }
  await p.close();
} finally {
  await b.close();
  await vite.close();
}
console.log(errs.length ? errs.join('\n') : 'no console errors');

let differ = 0;
if (against) {
  for (const name of shots) {
    const base = join(against, `${name}.png`), now = join(out, `${name}.png`);
    if (!existsSync(base)) { differ++; console.log(`${name}: no baseline (${base})`); continue; }
    // compare prints the AE count on stderr; exit 0 same, 1 different, 2 an error
    const r = spawnSync('compare', ['-metric', 'AE', '-fuzz', '1%', base, now, 'null:'], { encoding: 'utf8' });
    const ae = Number.parseFloat(r.stderr);
    if (r.status === 2 || Number.isNaN(ae)) { differ++; console.log(`${name}: compare failed: ${(r.stderr || r.error?.message || '').trim()}`); continue; }
    if (ae > 0) differ++;
    console.log(`${name}: AE ${ae} at 1% fuzz${ae > 0 ? '  DIFFERS' : ''}`);
  }
  console.log(differ ? `\nregress: ${differ} of ${shots.length} shots differ from ${against}` : `\nregress: ${shots.length} shots match ${against}`);
}
process.exit(errs.length || differ ? 1 : 0);
