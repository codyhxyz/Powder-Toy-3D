// A/B timing of the derived passes while the sim runs (docs/scaling.md D9),
// for builds served on their own ports. tools/bench.mjs's `derived` metric
// times updateBricks() back to back on a still world, which an incremental
// build answers by rebuilding nothing; here every frame steps the sim first.
//
// Per round and build, three chunks of K frames, each synced only at its ends:
//   S  STEPS sim steps per frame
//   D  the same + updateBricks()
//   L  the same + the shadow map and GI (as app.js frame() runs them)
// derived = (D - S) / K and shadow + GI = (L - D) / K per frame. Builds and
// chunk orders alternate (A B B A ..., S D L / L D S) so contention from other
// GPU work hits both alike, and each round starts once the GPU is quiet (or
// QUIET_WAIT_MAX_MS has passed). A round whose steps-only chunk ran over
// CONTENDED × its build's fastest is dropped: the GPU was shared during it.
// Reported: medians and quartiles over the kept rounds.
//
// usage: node tools/derived-bench.mjs --ports 5422,5423[:full] [--scen lab,island,volcano]
//          [--rounds 20] [--k 8] [--light 0] [--quiet-wait ms] [--out report.json]
//   port:full runs that build with sim.incremental = false (a full rebuild every frame).
//   --quiet-wait: how long a round waits for a quiet GPU (default QUIET_WAIT_MAX_MS); on a
//   machine other runs keep busy, shorten it and add rounds.
//   --light 0 leaves out the L chunks (shadow and GI). A build with region draws also
//   reports the share of field-atlas regions its dirty sets flagged (EMA, FIELDS, WORK).
// Serve each build with its own vite (a checkout: git archive <ref> | tar -x -C <dir>,
// node_modules symlinked); serve it without a file watcher, so nothing reloads mid-run.
import { launchBrowser, newTestPage } from './browser.mjs';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const specs = opt('ports', '5422,5423').split(',');
const scens = opt('scen', 'lab,island,volcano').split(',');
const ROUNDS = +opt('rounds', '20');
const K = +opt('k', '8');                    // frames per chunk
const OUT = opt('out', null);
const LIGHT = opt('light', '1') !== '0';
const STEPS = 4;                             // sim steps per frame (the app's default speed)
const WARM = { lab: 300, island: 1500, volcano: 300 };   // steps from load to the measured state
const WARM_YIELD = 50;                       // steps between yields to the page while warming
const SEED = 12345;                          // Math.random seed (mulberry32, as tools/regress.mjs)
const VIEWPORT = { width: 1280, height: 800 };
const LOAD_TIMEOUT_MS = 120000;
const BOOT_MS = 3000;
const CAPTURE_FRAMES = 3;                    // app frames run to capture the shadow pass
const QUIET_UTIL = 15;                       // % GPU utilization counted as quiet (ioreg)
const QUIET_SAMPLES = 3;                     // consecutive quiet samples before a round
const QUIET_POLL_MS = 400;
const QUIET_WAIT_MAX_MS = +opt('quiet-wait', '120000');
const CONTENDED = 1.5;

const gpuUtil = () => {
  try { return +execSync('ioreg -r -d 1 -c IOAccelerator').toString().match(/"Device Utilization %"=(\d+)/)[1]; } catch { return 0; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitQuiet() {
  const t0 = Date.now();
  let n = 0;
  while (n < QUIET_SAMPLES && Date.now() - t0 < QUIET_WAIT_MAX_MS) {
    n = gpuUtil() <= QUIET_UTIL ? n + 1 : 0;
    await sleep(QUIET_POLL_MS);
  }
  return n >= QUIET_SAMPLES;
}

const b = await launchBrowser();
const pages = [];
for (const spec of specs) {
  const [port, mode] = spec.split(':');
  const p = await newTestPage(b, { mode: 'visual', viewport: VIEWPORT });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await p.goto(`http://localhost:${port}/?preset=lab&paused=1`, { timeout: LOAD_TIMEOUT_MS });
  pages.push({ spec, full: mode === 'full', p, errs });
}
await sleep(BOOT_MS);

// Load the scenario from the seed, warm it up, capture the shadow pass, park the app's frame loop.
async function setup(pg, scen) {
  return pg.p.evaluate(async ([scen, warm, full, k]) => {
    const a = window.__app;
    if (window.__raf) {   // unpark what a previous scenario parked
      window.requestAnimationFrame = window.__raf;
      window.__parked.forEach((cb) => window.__raf(cb));
      window.__raf = null;
    }
    a.settings.paused = true;
    a.autoRes.enabled = false;
    let s = k.SEED;
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    a.day.clock = 0;
    a.loadPreset(scen, false);
    const sim = a.sim;
    sim.frame = 0;
    if ('incremental' in sim) sim.incremental = !full;
    for (let i = 0; i < warm; i++) {
      sim.step();
      if (i % k.WARM_YIELD === k.WARM_YIELD - 1) { sim.gpuSync(); await new Promise((r) => setTimeout(r, 0)); }
    }
    const prev = sim.onPass;
    window.__shadow = null;
    sim.onPass = (name, target) => { if (name === 'shadow') window.__shadow = { mat: sim.quad.material, target }; prev?.(name, target); };
    sim.step();
    for (let i = 0; i < k.CAPTURE_FRAMES; i++) await new Promise((r) => requestAnimationFrame(r));
    sim.onPass = prev;
    window.__raf = window.requestAnimationFrame;
    window.__parked = [];
    window.requestAnimationFrame = (cb) => { window.__parked.push(cb); return 0; };
    return !!window.__shadow;
  }, [scen, WARM[scen], pg.full, { SEED, WARM_YIELD, CAPTURE_FRAMES }]);
}

// ms for one chunk of K frames
async function chunk(pg, kind) {
  return pg.p.evaluate(([kind, K, STEPS]) => {
    const a = window.__app, sim = a.sim, R = a.renderer, sh = window.__shadow, T = a.THREE;
    const f32 = new Float32Array(4), u16 = new Uint16Array(4), u8 = new Uint8Array(4);
    const read = (t) => R.readRenderTargetPixels(t, 0, 0, 1, 1, t.texture.type === T.FloatType ? f32 : t.texture.type === T.HalfFloatType ? u16 : u8);
    // a read waits for pending work on what it reads only (gfx/profiler.js): read every target a chunk ends on
    const sync = () => { sim.gpuSync(); read(sim.light[1]); read(sim.giProbes); if (sh) read(sh.target); };
    sync();
    const t0 = performance.now();
    for (let f = 0; f < K; f++) {
      for (let s = 0; s < STEPS; s++) sim.step();
      if (kind !== 'S') sim.updateBricks();
      if (kind === 'L' && sh) {
        sh.mat.uniforms.tA.value = sim.stateA;
        sh.mat.uniforms.tBrick.value = sim.brick.texture;
        sim.run(sh.mat, sh.target);
        sim.updateGI(a.SUN, sh.target.texture, sh.mat.uniforms.uShadowRes.value, true);
      }
      R.getContext().flush();
    }
    sync();
    const ms = performance.now() - t0;
    // the share of regions each dirty set flagged on the last frame (builds with region draws)
    let share = null;
    if (kind === 'D' && sim.regionShare) {
      const v = new Float32Array(4);
      R.readRenderTargetPixels(sim.regionShare, 0, 0, 1, 1, v);
      share = [...v].slice(0, 3);
    }
    return { ms, share };
  }, [kind, K, STEPS]);
}

const q = (xs, f) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor(f * (s.length - 1))] : NaN; };
const fmt = (x) => x.toFixed(2).padStart(6);
const report = {};
for (const scen of scens) {
  for (const pg of pages) await setup(pg, scen);
  const acc = pages.map(() => ({ S: [], D: [], L: [], share: [] }));
  const kinds = LIGHT ? ['S', 'D', 'L'] : ['S', 'D'];
  let quiet = 0;
  for (let r = 0; r < ROUNDS; r++) {
    quiet += (await waitQuiet()) ? 1 : 0;
    for (let k = 0; k < pages.length; k++) {
      const i = r % 2 ? pages.length - 1 - k : k;
      for (const kind of (r + k) % 2 ? kinds : [...kinds].reverse()) {
        const c = await chunk(pages[i], kind);
        acc[i][kind].push(c.ms);
        if (c.share) acc[i].share.push(c.share);
      }
    }
  }
  const fastest = acc.map((A) => Math.min(...A.S));
  const keep = [...Array(ROUNDS).keys()].filter((j) => acc.every((A, i) => A.S[j] <= CONTENDED * fastest[i]));
  console.log(`\n== ${scen}: ${ROUNDS} rounds × ${K} frames of ${STEPS} steps; ${quiet} started quiet, ${keep.length} kept`);
  report[scen] = {};
  pages.forEach((pg, i) => {
    const A = acc[i];
    const derived = keep.map((j) => (A.D[j] - A.S[j]) / K), light = LIGHT ? keep.map((j) => (A.L[j] - A.D[j]) / K) : [];
    const steps = keep.map((j) => A.S[j] / K);
    const share = A.share.length ? [0, 1, 2].map((c) => q(A.share.map((x) => x[c]), 0.5)) : null;
    report[scen][pg.spec] = { derived, light, steps, share, raw: A };
    console.log(`${pg.spec.padEnd(10)} ms/frame: steps ${fmt(q(steps, 0.5))}  derived ${fmt(q(derived, 0.5))} (${fmt(q(derived, 0.25))}–${fmt(q(derived, 0.75))})`
      + (LIGHT ? `  shadow+GI ${fmt(q(light, 0.5))} (${fmt(q(light, 0.25))}–${fmt(q(light, 0.75))})` : '')
      + (share ? `  regions E/D/W ${share.map((x) => (x * 100).toFixed(0) + '%').join(' ')}` : ''));
  });
  if (OUT) writeFileSync(OUT, JSON.stringify(report));
}
for (const pg of pages) if (pg.errs.length) console.log(`${pg.spec} errors:\n${pg.errs.join('\n')}`);
await b.close();
