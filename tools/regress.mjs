// Deterministic render regression: seeds Math.random, loads a preset, runs a
// fixed number of sim steps by hand (no wall-clock dependence), pauses, renders
// a fixed number of frames from fixed cameras and screenshots them.
// usage: node tools/regress.mjs <outDir> --port N
// Compare two runs with: compare -metric AE -fuzz 1% a.png b.png null:
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => {
  let s = 12345;   // mulberry32: same scene every run
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
  // the UI (hint toast, sliders) animates on wall-clock timers: hide it
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body > *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';
    document.head.appendChild(st);
  });
  // virtual clock: every animation frame advances exactly 1/60 s
  let vt = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => { vt += 1000 / 60; cb(vt); });
  performance.now = () => vt;
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 500)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.goto(`http://localhost:${port}/?preset=lab`);
await p.waitForTimeout(2500);
const views = {
  lab: { steps: 300, cams: { lab: [[11, 12.5, 13], [0, 2.5, 0]], labLava: [[3.6, 1.5, 3.6], [2.6, 0.9, 2.6]], labTank: [[0.6, 2.9, 1.6], [-2.2, 1.4, -2.2]] } },
  volcano: { steps: 300, cams: { volcano: [[11, 12.5, 13], [0, 2.5, 0]], summit: [[1.3, 4.3, 1.6], [0, 3.6, 0]] } },
};
for (const [preset, v] of Object.entries(views)) {
  await p.evaluate(async ([preset, steps]) => {
    const a = window.__app;
    a.settings.paused = true;
    a.autoRes.enabled = false;
    a.post.settings.taa = false;   // TAA's jitter index isn't resettable: compare un-jittered frames
    a.loadPreset(preset, false);
    a.sim.frame = 0;               // the sim's random streams are seeded by its step counter
    for (let i = 0; i < steps; i++) a.sim.step();
  }, [preset, v.steps]);
  for (const [name, [pos, tgt]] of Object.entries(v.cams)) {
    await p.evaluate(async ([pos, tgt]) => {
      const a = window.__app;
      a.camera.position.set(...pos);
      a.controls.target.set(...tgt);
      a.controls.update();
      a.post.reset();
      const u = a.volume.material.uniforms;
      u.uFrame.value = 0;
      u.uTime.value = 0;
      for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r));
    }, [pos, tgt]);
    await p.screenshot({ path: `${out}/${name}.png` });
  }
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
