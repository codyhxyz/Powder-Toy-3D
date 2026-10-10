// Deterministic render regression: seeds Math.random, loads a preset, runs a
// fixed number of sim steps by hand (no wall-clock dependence), pauses, renders
// a fixed number of frames from fixed cameras and screenshots them.
// usage: node tools/regress.mjs <outDir> --port N [--detail off|on|default] [--motion]
//   --detail: close-up detail features (gfx/detail.js) all off (the default,
//   so a feature switched off can be proven pixel-identical), all on, or as
//   their cost tiers set them.
//   --adapt off: eye adaptation (gfx/post.js ADAPT) held at gain 1, to prove
//   it leaves daylight views alone (compare against a run without it).
//   --motion: the views mid-motion instead: the frame loop keeps the sim
//   running (and some views keep painting) right up to the screenshot, so the
//   fields, bricks and GI are caught mid-change (docs/scaling.md D9). Frames
//   then run one at a time through __tick(), never on the browser's timing.
// Compare two runs with: compare -metric AE -fuzz 1% a.png b.png null:
import { launchBrowser, newTestPage } from './browser.mjs';
import { mkdirSync } from 'fs';
import { DETAIL, settingKey, detailDefaults } from '../src/gfx/detail.js';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const motion = args.includes('--motion');
const adapt = opt('adapt', 'on') !== 'off';
mkdirSync(out, { recursive: true });
const detailMode = opt('detail', 'off');
const detail = detailMode === 'default' ? detailDefaults()
  : Object.fromEntries(DETAIL.map((f) => [settingKey(f), detailMode === 'on']));
const b = await launchBrowser();
const p = await newTestPage(b, { mode: 'visual', viewport: { width: 1280, height: 800 } });
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
  // virtual clock: every animation frame advances exactly 1/60 s
  let vt = 0;
  const raf = window.requestAnimationFrame.bind(window);
  // __hold() parks the frame loop (callbacks wait instead of running) so a
  // screenshot captures a fixed frame, not whichever one the timing lands on;
  // __release() lets it run again
  let held = null;
  window.requestAnimationFrame = (cb) => {
    if (held) { held.push(cb); return 0; }
    return raf(() => { vt += 1000 / 60; cb(vt); });
  };
  window.__hold = () => { held ??= []; };
  window.__release = () => { const h = held ?? []; held = null; h.forEach((cb) => window.requestAnimationFrame(cb)); };
  // with the loop parked, run exactly one frame of it (the callback it queued)
  window.__tick = () => { const h = held; held = []; vt += 1000 / 60; h.forEach((cb) => cb(vt)); };
  window.__parked = () => held?.length ?? 0;   // callbacks waiting
  // Load a preset into a known state. Math.random starts over first: three.js
  // draws a UUID from it for every material, geometry and target it makes, so
  // a build that makes a different number of them before this would give the
  // cells other seeds. Besides the sim's step counters, the GI: after a load
  // its first trace still reads the old probes for bounce light, and the boot
  // frames (as many as the page managed) left those, so clear them, and the
  // parity that picks which half of the probes a frame traces.
  window.__load = (preset) => {
    const a = window.__app, R = a.renderer, gl = R.getContext();
    Math.random = seeded(SEED);
    a.loadPreset(preset, false);
    a.sim.frame = 0;               // the sim's random streams are seeded by its step counter
    a.sim.paints = 0;              // …and the brush's by its stroke counter
    a.sim.giFrame = 0;
    const prev = R.getRenderTarget(), clear = gl.getParameter(gl.COLOR_CLEAR_VALUE);
    R.setRenderTarget(a.sim.giProbes);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(...clear);
    R.setRenderTarget(prev);
  };
  window.__rawFrame = () => new Promise((r) => raf(() => r()));
  performance.now = () => vt;
}, detail);
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 500)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.goto(`http://localhost:${port}/?preset=lab&paused=1`);
await p.waitForTimeout(2500);
const views = {
  lab: { steps: 300, cams: { lab: [[11, 12.5, 13], [0, 2.5, 0]], labLava: [[3.6, 1.5, 3.6], [2.6, 0.9, 2.6]], labTank: [[0.6, 2.9, 1.6], [-2.2, 1.4, -2.2]] } },
  volcano: { steps: 300, cams: { volcano: [[11, 12.5, 13], [0, 2.5, 0]], summit: [[1.3, 4.3, 1.6], [0, 3.6, 0]] } },
};
// --motion: [preset, steps before, camera, target, brush stroke repeated every frame or null]
const MOTION_FRAMES = 24;   // frames the sim runs (4 steps each) between the camera and the screenshot
const ELEMENT = { WATER: 7, SAND: 2 };   // brush tools (elements.js ids)
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
if (motion) {
  // From here on frames run only through __tick(). The frame the loop queued
  // before the hold still runs once on the browser's timing: wait for it to
  // queue its successor, so it can't land after a view's frames.
  await p.evaluate(() => window.__hold());
  while (!(await p.evaluate(() => window.__parked()))) await p.evaluate(() => window.__rawFrame());
  for (const [name, [preset, steps, pos, tgt, stroke]] of Object.entries(motionViews)) {
    await p.evaluate(([preset, steps, pos, tgt, frames, stroke, adapt]) => {
      const a = window.__app;
      a.settings.paused = true;
      a.autoRes.enabled = false;
      a.post.settings.taa = false;
      a.post.settings.adapt = adapt;
      a.day.clock = 0;
      window.__load(preset);
      for (let i = 0; i < steps; i++) a.sim.step();
      for (let i = 0; i < 2; i++) window.__tick();
      a.camera.position.set(...pos);
      a.controls.target.set(...tgt);
      a.controls.update();
      a.post.reset();
      const u = a.volume.material.uniforms;
      u.uFrame.value = 0;
      u.uTime.value = 0;
      a.settings.paused = false;
      const V = a.camera.position.constructor;
      for (let i = 0; i < frames; i++) {
        if (stroke) a.sim.paint({ center: new V(...stroke.center), radius: stroke.radius, shape: 0, tool: stroke.tool, rate: 1, replace: false });
        window.__tick();
      }
      a.settings.paused = true;
    }, [preset, steps, pos, tgt, MOTION_FRAMES, stroke, adapt]);
    for (let i = 0; i < 2; i++) await p.evaluate(() => window.__rawFrame());
    await p.screenshot({ path: `${out}/${name}.png` });
  }
}
for (const [preset, v] of Object.entries(motion ? {} : views)) {
  await p.evaluate(async ([preset, steps, adapt]) => {
    const a = window.__app;
    a.settings.paused = true;
    a.autoRes.enabled = false;
    a.post.settings.taa = false;   // TAA's jitter index isn't resettable: compare un-jittered frames
    a.post.settings.adapt = adapt;
    // The app boots running, so the day clock (the sun) has advanced by however
    // many frames the page managed before this: put it back to the start of the day.
    a.day.clock = 0;
    window.__load(preset);
    for (let i = 0; i < steps; i++) a.sim.step();
    // let the frame loop see the world change now, not after the cameras reset uTime
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  }, [preset, v.steps, adapt]);
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
      // park the loop; the frame already queued runs once more, then nothing moves
      window.__hold();
      for (let i = 0; i < 2; i++) await window.__rawFrame();
    }, [pos, tgt]);
    await p.screenshot({ path: `${out}/${name}.png` });
    await p.evaluate(() => window.__release());
  }
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
