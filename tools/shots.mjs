// Batched visual check: one browser, both scenes, several angles, data views,
// a smoothing-off comparison and a temporal flicker measurement.
// usage: node tools/shots.mjs <outDir> [--port 5191]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const only = opt('only', '');
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 3000)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));

const ev = (fn, arg) => p.evaluate(fn, arg);
const frames = (n) => ev(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
async function cam(pos, target) {
  await ev(([pos, target]) => {
    const a = window.__app;
    a.camera.position.set(...pos);
    a.controls.target.set(...target);
    a.controls.update();
    a.post.reset();
  }, [pos, target]);
  await frames(24); // let TAA converge
}
async function shot(name) {
  await p.screenshot({ path: `${out}/${name}.png` });
}
async function preset(name, runMs) {
  await ev((name) => { const a = window.__app; a.settings.paused = false; a.loadPreset(name, false); }, name);
  await p.waitForTimeout(runMs);
  await ev(() => { window.__app.settings.paused = true; });
}

await p.goto(`http://localhost:${port}/?preset=lab`);
await p.waitForTimeout(2500);
await ev(() => {
  const a = window.__app;
  a.settings.autoRes = false;
  document.querySelectorAll('.toast').forEach((t) => t.remove());
});
const info = {};
const timing = async (label) => {
  info[label] = await ev(async () => {
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
    return +((performance.now() - t0) / 30).toFixed(1);
  });
};

if (!only || only === 'lab') {
  await preset('lab', 5000);
  await ev(() => window.__app.rig.reset(true));
  await frames(24);
  await timing('lab-home ms');
  await shot('lab-home');
  await cam([0.6, 2.9, 1.6], [-2.2, 1.4, -2.2]); await shot('lab-tank');
  await cam([-1.6, 3.7, -1.4], [-3.2, 2.2, -3.2]); await shot('lab-tank-close');
  await cam([5.2, 2.6, 5.6], [2.5, 0.8, 2.5]); await shot('lab-lava');
  await cam([3.6, 1.5, 3.6], [2.6, 0.9, 2.6]); await shot('lab-lava-close');
  await cam([4.4, 2.2, -0.4], [1.6, 0.3, -2.2]); await shot('lab-sand');
  await cam([3.6, 1.3, -0.5], [2.0, 0.35, -2.0]); await shot('lab-sand-close');
  await cam([-0.4, 3.0, 5.0], [-2.8, 1.8, 1.8]); await shot('lab-wood');
  // smoothing off, same tank view
  await ev(() => { window.__app.gfx.smoothing = 0; });
  await cam([0.6, 2.9, 1.6], [-2.2, 1.4, -2.2]); await shot('lab-tank-nosmooth');
  await ev(() => { window.__app.gfx.smoothing = 1; });
  // flicker: same still view, two frames apart; TAA is converged so differences are flicker
  await cam([3.6, 1.3, -0.5], [2.0, 0.35, -2.0]);
  await frames(30);
  await shot('flicker-a');
  await frames(7);
  await shot('flicker-b');
}

if (!only || only === 'pour') {
  // streams and droplets: pour sand and water from above into an empty box
  await ev(() => { const a = window.__app; a.settings.paused = false; a.loadPreset('empty', false); });
  await ev(async () => {
    const a = window.__app;
    const { E } = await import('/src/elements.js');
    const g = a.sim.g;
    const at = (x, y, z) => a.camera.position.clone().set(x, y, z);
    for (let i = 0; i < 90; i++) {
      a.sim.paint({ center: at(g.nx * 0.35, g.ny * 0.8, g.nz * 0.5), radius: 2, shape: 0, tool: E.SAND, rate: 1, replace: false });
      a.sim.paint({ center: at(g.nx * 0.65, g.ny * 0.8, g.nz * 0.5), radius: 2, shape: 0, tool: E.WATER, rate: 1, replace: false });
      await new Promise((r) => requestAnimationFrame(r));
    }
    a.settings.paused = true;
  });
  await cam([0.2, 4.0, 9.0], [0.0, 3.0, 0.0]); await shot('pour');
  await cam([2.2, 1.6, 3.4], [1.3, 0.6, 0.0]); await shot('pour-splash');
}

if (!only || only === 'volcano') {
  await preset('volcano', 8000);
  await ev(() => window.__app.rig.reset(true));
  await frames(24);
  await timing('volcano-home ms');
  await shot('volcano-home');
  await cam([2.6, 5.6, 3.4], [0, 3.4, 0]); await shot('volcano-summit');
  await cam([1.3, 4.3, 1.6], [0, 3.6, 0]); await shot('volcano-summit-close');
  await cam([-5.4, 2.4, 5.6], [-2.6, 0.9, 2.2]); await shot('volcano-flank');
  await cam([-4.6, 0.95, 4.7], [-3.4, 0.6, 3.4]); await shot('volcano-sea');
  for (const [v, n] of [[1, 'heat'], [2, 'pressure'], [3, 'flow'], [4, 'xray']]) {
    await ev((v) => window.__app.setView(v), v);
    await ev(() => window.__app.rig.reset(true));
    await frames(12);
    await shot(`view-${n}`);
  }
  await ev(() => window.__app.setView(0));
}

info.pixelRatio = await ev(() => window.__app.renderer.getPixelRatio());
console.log(JSON.stringify(info));
if (errs.length) console.log(errs.join('\n'));
await b.close();
