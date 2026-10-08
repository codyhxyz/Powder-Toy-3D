// Cost of each close-up detail feature (src/gfx/detail.js), for its cost tier.
// Loads the lab deterministically (as tools/regress.mjs), then for each camera
// (the god view and eye-level close-ups, the POV-mode worst case) times the
// view raymarch with the feature off and on, alternating A/B rounds, and
// prints the median extra GPU ms per frame and the tier that gives.
// usage: node tools/detail-bench.mjs [--port 5191] [--preset lab|volcano] [--cams eyeSand,god]
//        [--features relief,grains] [--shots outDir]
// Noise: identical shaders differ by up to ~0.4 ms per camera; rerun a tier
// that sits near a COST_*_MS boundary.
//        --all  also times every feature on at once against all off
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { BENCH_W, BENCH_H, DETAIL, settingKey, costTier } from '../src/gfx/detail.js';
import { ELEMENTS, K } from '../src/elements.js';

const GAS_IDS = ELEMENTS.map((e, i) => (e.kind === K.GAS ? i : -1)).filter((i) => i >= 0);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const shots = opt('shots', '');
const only = opt('features', '');
const features = DETAIL.filter((f) => !only || only.split(',').includes(f.key));
if (shots) mkdirSync(shots, { recursive: true });

const SIM_STEPS = 900;     // the lab sand has landed and piled
const ROUNDS = 7;          // A/B rounds per feature and camera (median taken)
const FRAMES = 20;         // renders per timing sample
const WARM_FRAMES = 4;     // renders after a switch before timing (program compile, caches)
const GATE_WAIT_FRAMES = 60;  // × WARM_FRAMES, at most, for background shader compiles
const SETTLE_FRAMES = 30;  // frame-loop frames after moving the camera (uniforms, TAA)
// Cameras (128³ layout, grid cells). null = the home (god) view. Eye
// cameras stand a POV-height body on whatever is under `feet` = [x, z]
// (the top non-gas cell) and look at the ground under `look` = [x, z],
// LOOK_DROP cells below eye height there.
const EYE_H = 5;       // cells from the ground to the eye (POV body ≈ 5.5 cells tall)
const LOOK_DROP = 3;   // cells
const CAMS = {
  lab: {
    god: null,
    eyeSand: { feet: [80, 66], look: [86, 38] },    // the sand pile that falls in the lab
    eyeSandClose: { feet: [86, 52], look: [86, 40] }, // standing on the pile, looking down its slope
    eyeTank: { feet: [70, 82], look: [60, 64] },    // glass tank of water, oil on top
    eyeWood: { feet: [45, 105], look: [27, 87] },   // the wooden tower
  },
  volcano: {
    god: null,
    eyeFlank: { feet: [104, 64], look: [84, 64] },  // on the rock flank looking up: trees, snow
    eyeSummit: { feet: [72, 72], look: [64, 64] },  // at the vent: lava, stone
  },
};
const preset = opt('preset', 'lab');
const camSel = opt('cams', '');
const cams = Object.fromEntries(Object.entries(CAMS[preset]).filter(([k]) => !camSel || camSel.split(',').includes(k)));

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: BENCH_W, height: BENCH_H } });
await p.addInitScript(() => {
  let s = 12345;   // mulberry32: same scene every run
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body > *:not(canvas):not(:has(canvas)), .dock, .card, .topbar, .hud { visibility: hidden !important; }';
    document.head.appendChild(st);
  });
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 500)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.goto(`http://localhost:${port}/?preset=${preset}`);
await p.waitForTimeout(2500);
await p.evaluate(async ([steps, keys, preset]) => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;   // a fixed resolution: auto resolution would change it mid-run
  a.post.settings.taa = false;
  for (const k of keys) a.settings[k] = false;
  a.applyDetail();
  a.loadPreset(preset, false);
  // screenshots show only the scene
  const cv = a.renderer.domElement;
  document.querySelectorAll('body *').forEach((el) => { if (!el.contains(cv)) el.style.visibility = 'hidden'; });
  a.sim.frame = 0;
  for (let i = 0; i < steps; i++) a.sim.step();
}, [SIM_STEPS, DETAIL.map(settingKey), preset]);

const frames = (n) => p.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);

async function setCam(cam) {
  await p.evaluate(([cam, EYE_H, LOOK_DROP, gasIds]) => {
    const a = window.__app;
    if (!cam) { a.rig.reset(true); return; }
    const { width, height, nx, ny, nz, tx } = a.sim.g;
    const st = new Float32Array(width * height * 4);
    a.renderer.readRenderTargetPixels(a.sim.targets[a.sim.cur], 0, 0, width, height, st, undefined, 0);
    const ground = ([x, z]) => {
      for (let y = ny - 1; y >= 0; y--) {
        const id = Math.round(st[((Math.floor(y / tx) * nz + z) * width + (y % tx) * nx + x) * 4]);
        if (id && !gasIds.includes(id)) return y + 1;
      }
      return 0;
    };
    const w = (x, y, z) => a.volume.position.clone().addScaledVector({ x, y, z }, a.scale);
    const eyeY = ground(cam.feet) + EYE_H;
    a.camera.position.copy(w(cam.feet[0], eyeY, cam.feet[1]));
    a.controls.target.copy(w(cam.look[0], Math.max(ground(cam.look), eyeY - LOOK_DROP), cam.look[1]));
    a.controls.update();
  }, [cam, EYE_H, LOOK_DROP, GAS_IDS]);
  await frames(SETTLE_FRAMES);
  await settleGate();
}

// switch features on/off (keys → bool), let the frame loop pick it up and
// wait for the distance gate (gfx/detailGate.js) to finish compiling the
// variant this camera wants
async function setDetail(state) {
  await p.evaluate((state) => {
    const a = window.__app;
    Object.assign(a.settings, state);
    a.applyDetail();
  }, state);
  await settleGate();
}
async function settleGate() {
  for (let i = 0; i < GATE_WAIT_FRAMES; i++) {
    await frames(WARM_FRAMES);
    if (await p.evaluate(() => window.__app.detailGate.pending === 0)) break;
  }
  await frames(WARM_FRAMES);
}

// GPU ms per view render: FRAMES renders of the scene into an offscreen HDR
// target, synced by reading one texel back (reading the canvas wouldn't wait).
const timeView = () => p.evaluate(async ([n, warm]) => {
  const a = window.__app, r = a.renderer;
  const w = r.domElement.width, h = r.domElement.height;
  if (window.__benchRT?.width !== w || window.__benchRT?.height !== h) {
    window.__benchRT?.dispose();
    window.__benchRT = new a.THREE.WebGLRenderTarget(w, h, { type: a.THREE.HalfFloatType });
  }
  const rt = window.__benchRT, px = new Uint16Array(4);
  const draw = () => { r.setRenderTarget(rt); r.clear(); r.render(a.scene, a.camera); r.setRenderTarget(null); };
  for (let i = 0; i < warm; i++) draw();
  r.readRenderTargetPixels(rt, 0, 0, 1, 1, px);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) draw();
  r.readRenderTargetPixels(rt, 0, 0, 1, 1, px);
  return (performance.now() - t0) / n;
}, [FRAMES, WARM_FRAMES]);

const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
const off = Object.fromEntries(DETAIL.map((f) => [settingKey(f), false]));

async function abCost(on, cam, name) {
  await setCam(cam);
  const base = [], with_ = [];
  for (let r = 0; r < ROUNDS; r++) {
    await setDetail(off); base.push(await timeView());
    await setDetail({ ...off, ...on }); with_.push(await timeView());
  }
  if (shots) {
    await setDetail(off); await frames(SETTLE_FRAMES); await p.screenshot({ path: `${shots}/${name}-off.png` });
    await setDetail({ ...off, ...on }); await frames(SETTLE_FRAMES); await p.screenshot({ path: `${shots}/${name}-on.png` });
  }
  return { base: median(base), on: median(with_), extra: median(with_.map((v, i) => v - base[i])) };
}

const rows = [];
const sets = features.map((f) => [f.key, { [settingKey(f)]: true }, f]);
if (args.includes('--all')) sets.push(['ALL', Object.fromEntries(DETAIL.map((f) => [settingKey(f), true])), null]);
for (const [key, on, f] of sets) {
  let worst = 0;
  for (const [camName, cam] of Object.entries(cams)) {
    const r = await abCost(on, cam, `${key}-${camName}`);
    worst = Math.max(worst, r.extra);
    rows.push({ feature: key, cam: camName, 'base ms': r.base.toFixed(2), 'on ms': r.on.toFixed(2), 'extra ms': r.extra.toFixed(2) });
  }
  rows.push({ feature: key, cam: 'WORST', 'extra ms': worst.toFixed(2), tier: costTier(worst), declared: f?.cost ?? '' });
}
console.table(rows);
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
