// A pour as a player sees it, before/after: tools/whitewater-shots.mjs's tank
// (Lab 128³, a one-cell hole 30 cells up in its +x wall, kept full by a
// clone lid) from the god view, first person and third person (the realistic
// body, F5) beside the pour; and a dropped slab of water, mid-fall and as it
// splashes on the floor (blobs and spray must look as they always did).
// Same seed, steps and cameras every run, so two builds compare.
// usage: node tools/pour-shots.mjs <outDir> [--port 5287]
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { mkdirSync } from 'fs';

const args = process.argv.slice(2);
const out = args[0];
if (!out || out.startsWith('--')) throw new Error('usage: node tools/pour-shots.mjs <outDir> [--port 5287]');
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5287');
mkdirSync(out, { recursive: true });

const W = 1280, H = 800;
const POUR_STEPS = 420;          // the tank's pour reaches the floor and runs steadily (whitewater-shots STEPS)
const SLAB_FALL_STEPS = 30;      // the slab, mid-fall
const SLAB_SPLASH_STEPS = 45;    // ... and as it lands
const ENTER_MS = 2500;           // first person: the body loads and the camera settles
// player [x, y, z] in cells, look [yaw, pitch]: south of the pour (+z), looking at it side-on
const BY_POUR = { at: [62, 1, 86], look: [0, 0.32] };
const BY_SLAB = { at: [64, 1, 96], look: [0, 0.12] };

const b = await launchBrowser();
const errs = [];
try {
  const p = await newTestPage(b, { mode: 'visual', viewport: { width: W, height: H } });
  await p.routeWebSocket(/.*/, () => {});
  await p.addInitScript(() => {
    let s = 12345;
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await p.goto(`http://localhost:${port}/?size=128&preset=empty&paused=1`);
  await ready(p);
  await p.evaluate(() => { const a = window.__app; a.autoRes.enabled = false; });
  const shot = async (name) => { await render(p); await p.screenshot({ path: `${out}/${name}.png` }); };
  const build = (scene) => p.evaluate(async (scene) => {
    const a = window.__app, sim = a.sim;
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { SEED_MAX } = await import('/src/shaders/common.js');
    a.test.park();
    const [A, B] = sim.blankState();
    const box = (x0, y0, z0, x1, y1, z1, id, ctype = 0) => {
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const i = sim.cellTexel(x, y, z) * 4;
        A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = ctype + Math.random() * SEED_MAX;
        B[i] = B[i + 1] = B[i + 2] = 0;
      }
    };
    if (scene === 'tank') {
      box(24, 0, 56, 40, 46, 72, E.WALL);
      box(25, 1, 57, 39, 44, 71, E.WATER);
      box(25, 44, 57, 39, 45, 71, E.CLONE, E.WATER);
      box(39, 30, 64, 40, 31, 65, E.EMPTY);
    } else box(56, 22, 56, 72, 28, 72, E.WATER);   // a 16×6×16 slab, 22 cells up
    sim.load(A, B);
  }, scene);
  const step = (n) => p.evaluate((n) => window.__app.test.step(n), n);
  // first person: on, standing at `at`, looking `look`; third: the F5 view
  let isThird = false;   // (POV comes on in first person)
  const pov = async ({ at, look }, third) => {
    const on = await p.evaluate(() => window.__app.pov.mode === 'on');
    if (!on) {
      await p.evaluate(() => window.__app.test.resume());
      await p.mouse.move(W / 2, H / 2);
      await p.keyboard.press('v');
      await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
      await p.waitForFunction(() => window.__app.pov.figure?.loaded, null, { timeout: 30000 }).catch(() => {});
    }
    await p.evaluate(([at, look]) => {
      const a = window.__app;
      a.pov.test.assumeLocked = true; a.pov.player.spawn(new a.THREE.Vector3(...at)); a.pov.setLook(...look);
    }, [at, look]);
    if (isThird !== third) { await p.evaluate(() => window.__app.test.resume()); await p.keyboard.press('F5'); isThird = third; }
    await p.evaluate(() => window.__app.test.resume());
    await p.waitForTimeout(ENTER_MS);
    await p.evaluate(([at, look]) => { const a = window.__app; a.pov.player.spawn(new a.THREE.Vector3(...at)); a.pov.setLook(...look); }, [at, look]);
  };

  // the pour: god view first, then the player beside it (the world stays paused: settings.paused)
  await build('tank');
  await step(POUR_STEPS);
  await p.evaluate(() => window.__app.rig.reset(true));
  await shot('pour-god');
  await pov(BY_POUR, false);
  await shot('pour-first');
  await pov(BY_POUR, true);
  await shot('pour-third');
  // the slab, from the same third-person body
  await build('slab');
  await step(SLAB_FALL_STEPS);
  await pov(BY_SLAB, true);
  await shot('slab-fall');
  await step(SLAB_SPLASH_STEPS - SLAB_FALL_STEPS);
  await shot('slab-splash');
} finally {
  await b.close();
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
