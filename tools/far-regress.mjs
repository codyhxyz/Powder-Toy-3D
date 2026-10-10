// Deterministic far-view stills (world mode, ?size=world), to prove a change
// to how the far field is packed or read changed no pixels: tools/regress.mjs's
// method in a world. Math.random is seeded, every frame advances a virtual
// clock by exactly 1/60 s, TAA is off, the sun is fixed, and before each still
// the GI probes are cleared and the animation clock and frame counter reset,
// then exactly FRAMES frames run. (tools/far-check.mjs's stills keep the
// browser's clock: their water and clouds move between runs.) The window's
// own trees still shade a little differently run to run (~1% of the god
// view's pixels, ~2% of the look out past 1% fuzz): run each build twice to
// see that noise. The far grid's own data compares exactly with
// tools/island-dump.mjs.
// usage: node tools/far-regress.mjs <outDir> [--port 5392]
// Compare two runs with: compare -metric AE a.png b.png null:
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5392');
mkdirSync(out, { recursive: true });

const SEED = 12345;
const SUN = { az: 215, el: 38 };   // tools/far-check.mjs's
const FRAMES = 40;                 // frames per still after the resets
const BUILD_TIMEOUT = 180000;      // ms for the world and its far field to build
// [name, camera, target] in world cells from the world's centre (x, y, z): the
// god view of tools/far-check.mjs, and a look away from the window, over the
// far field's hills, coast and sea
const VIEWS = [
  ['god', [-380, 520, 620], [0, 20, -40]],
  ['out', [160, 110, 160], [520, 0, 480]],
];

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript((SEED) => {
  // mulberry32: same world every run
  const seeded = (seed) => { let s = seed; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  Math.random = seeded(SEED);
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body *{visibility:hidden !important} #app > canvas{visibility:visible !important}';
    document.head.appendChild(st);
  });
  // virtual clock: every animation frame advances exactly 1/60 s; __hold parks
  // the loop so a screenshot captures a fixed frame
  let vt = 0, held = null;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { if (held) { held.push(cb); return 0; } return raf(() => { vt += 1000 / 60; cb(vt); }); };
  window.__hold = () => { held ??= []; };
  window.__release = () => { const h = held ?? []; held = null; h.forEach((cb) => window.requestAnimationFrame(cb)); };
  window.__rawFrame = () => new Promise((r) => raf(() => r()));
  performance.now = () => vt;
}, SEED);
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
await p.goto(`http://localhost:${port}/?size=world`);
await p.waitForFunction(() => { const w = window.__app?.win, f = w?.far; return !!(w?.loaded && f?.built && f.ready && !f.queue.length); }, null, { timeout: BUILD_TIMEOUT });

for (const [name, cam, tgt] of VIEWS) {
  await p.evaluate(async ([cam, tgt, SUN, FRAMES]) => {
    const a = window.__app, w = a.win, R = a.renderer, gl = R.getContext();
    a.settings.paused = true;
    a.autoRes.enabled = false;
    a.post.settings.taa = false;   // TAA's jitter index isn't resettable
    a.day.fixed = SUN;
    // world cells (from the world's centre) to scene units
    const c = [w.size[0] / 2, 0, w.size[2] / 2], s = a.scale, o = a.sim.origin, v = a.volume.position;
    const scene = (q) => [v.x + (c[0] + q[0] - o.x) * s, v.y + q[1] * s, v.z + (c[2] + q[2] - o.z) * s];
    a.camera.position.set(...scene(cam));
    a.controls.target.set(...scene(tgt));
    a.controls.update();
    a.post.reset();
    // the GI's probes and parity (tools/regress.mjs __load), the animation clock and frame counter
    const prev = R.getRenderTarget(), clear = gl.getParameter(gl.COLOR_CLEAR_VALUE);
    R.setRenderTarget(a.sim.giProbes);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(...clear);
    R.setRenderTarget(prev);
    a.sim.giFrame = 0;
    const u = a.volume.material.uniforms;
    u.uFrame.value = 0;
    u.uTime.value = 0;
    for (let i = 0; i < FRAMES; i++) await new Promise((r) => requestAnimationFrame(r));
    window.__hold();
    for (let i = 0; i < 2; i++) await window.__rawFrame();
  }, [cam, tgt, SUN, FRAMES]);
  await p.screenshot({ path: `${out}/${name}.png` });
  await p.evaluate(() => window.__release());
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
