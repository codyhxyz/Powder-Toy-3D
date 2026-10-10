// Profiler check (src/gfx/profiler.js, Settings → Developer). Runs the lab and
// compares the profiler's phase times with references taken right after each
// sample (the same work with a single forced sync at the end), then the frame
// rate with the profiler off and on. Run it on an otherwise idle GPU: other GPU
// work inflates every number, and unevenly.
// usage: node tools/profile-check.mjs [--port N] [--pairs N]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const PAIRS = +opt('pairs', '8');   // samples, each with its references
const LOAD_MS = 3000;               // page load and first frames
const SETTLE_MS = 1500;             // after switching the profiler, before a window
const WINDOW_MS = 4000;             // frame-rate window per mode
const SYNC_REPS = 5;                // timed syncs per reference (median: the sync's own cost)

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`http://localhost:${port}/?preset=lab`);
await p.waitForTimeout(LOAD_MS);

const r = await p.evaluate(async ({ PAIRS, SETTLE_MS, WINDOW_MS, SYNC_REPS }) => {
  const a = window.__app, R = a.renderer;
  const MS_PER_S = 1000;
  a.autoRes.enabled = false;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[s.length >> 1]; };
  // the frame rate and sim rate with the profiler off and on
  let renders = 0;
  const render = a.post.render.bind(a.post);
  a.post.render = (...rest) => { renders++; return render(...rest); };
  const rates = [];
  for (const on of [false, true, false, true]) {
    a.settings.profiler = on;
    await sleep(SETTLE_MS);
    const f0 = a.sim.frame, r0 = renders, t0 = performance.now();
    await sleep(WINDOW_MS);
    const s = (performance.now() - t0) / MS_PER_S;
    rates.push({ on, fps: (renders - r0) / s, stepsPerSec: (a.sim.frame - f0) / s, sampleWall: on ? a.prof.last?.wall : null });
  }
  a.post.render = render;
  // pairs: a sample, then the references right away (synchronous: no frame runs in between)
  const cal = new a.sim.actQuiet.constructor(1, 1, { depthBuffer: false });
  const u8 = new Uint8Array(4), f32 = new Float32Array(4);
  const syncCal = () => { const prev = R.getRenderTarget(); R.setRenderTarget(cal); R.clear(); R.readRenderTargetPixels(cal, 0, 0, 1, 1, u8); R.setRenderTarget(prev); };
  const time = (fn) => { syncCal(); const t = performance.now(); fn(); return performance.now() - t; };
  const pairs = [];
  let seen = a.prof.last;
  while (pairs.length < PAIRS) {
    await sleep(20);
    const s = a.prof.last;
    if (!s || s === seen) continue;
    seen = s;
    const sim = a.sim, gpu = (id) => s.phases.find((ph) => ph.id === id).gpu;
    const sync = med([...Array(SYNC_REPS)].map(() => time(syncCal)));
    pairs.push({
      sim: [gpu('sim'), time(() => { for (let i = 0; i < s.steps; i++) sim.step(); sim.gpuSync(); }) - sync],
      derived: [gpu('derived'), time(() => { sim.updateBricks(); R.readRenderTargetPixels(sim.light[1], 0, 0, 1, 1, f32); }) - sync],
      viewPost: [gpu('view') + gpu('post'), time(() => { a.post.render(a.scene, a.camera); syncCal(); }) - sync],
      sync: [s.overhead, sync], wall: s.wall, passes: s.passes.length,
    });
  }
  cal.dispose();
  a.settings.profiler = false;
  return { rates, pairs };
}, { PAIRS, SETTLE_MS, WINDOW_MS, SYNC_REPS });

const f = (v) => (v == null ? '–' : v.toFixed(2)).padStart(7);
console.log('profiler   fps   steps/s   sampled frame ms');
for (const x of r.rates) console.log(`${x.on ? 'on ' : 'off'}    ${f(x.fps)} ${f(x.stepsPerSec)}   ${f(x.sampleWall)}`);
console.log('\nGPU ms, profiler vs reference:');
console.log('    sim (prof  ref)   derived (prof  ref)   view+post (prof  ref)   sync (prof  ref)   sampled frame');
for (const x of r.pairs) {
  console.log(`${f(x.sim[0])}${f(x.sim[1])}   ${f(x.derived[0])}${f(x.derived[1])}       ${f(x.viewPost[0])}${f(x.viewPost[1])}     ${f(x.sync[0])}${f(x.sync[1])}   ${f(x.wall)} ms, ${x.passes} passes`);
}
const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[s.length >> 1]; };
const ratio = (k) => med(r.pairs.map((x) => x[k][0] / x[k][1])).toFixed(2);
console.log(`\nmedian profiler/reference: sim ${ratio('sim')}, derived ${ratio('derived')}, view+post ${ratio('viewPost')}`);
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close();
