// Where one full-screen quad gets cheaper than a quad per drawn supertile for the
// sim's step passes (docs/scaling.md D8, shaders/activity.js STEP_FULL_SHARE). In
// one page of a build served on --port, chunks of steps alternate between the two
// ways of drawing (A B B A ...) at the same states, since both give the same state:
//   regions  a quad per drawn supertile however many (sim.superU.uFullShare above any share)
//   full     one full-screen quad (sim.skipSleeping = false)
// Each scene is a preset with sand and water rained over the box between chunks
// (untimed: `rain` strokes per chunk) to wake more of it. Per scene: the share of
// supertiles drawn (and with steps), ms per step each way (median chunk), and the
// median regions/full ratio of adjacent chunk pairs with its quartiles. The share
// where the ratio crosses 1 is the threshold. Run it on a quiet GPU.
// usage: node tools/sleep-crossover.mjs --port N [--scen island:0,lab:0,lab:8,lab:16,lab:40,lab:150] [--chunks 16]
//   (scen: preset:rain strokes per chunk)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const scens = opt('scen', 'island:0,lab:0,lab:8,lab:16,lab:40,lab:150').split(',');
const CHUNKS = +opt('chunks', '16');
const SEED = 777;                 // Math.random seed (mulberry32, as tools/regress.mjs)
const SETTLE_ROUNDS = 6;          // rain, then SETTLE_STEPS steps, this many times before timing
const SETTLE_STEPS = 40;
const WOKEN_STEPS = 4;            // steps after a chunk's rain before timing it (past the map its writes woke)
const CHUNK_STEPS = 24;           // steps per timed chunk
const REGIONS_ONLY_SHARE = 2;     // a full-screen threshold above any share (shares are at most 1)
const RAIN = { RADIUS: 3, BELOW_TOP: 6, MARGIN: 4, STRIDE_X: 37, STRIDE_Z: 61, WATER_EVERY: 3 };   // cells; one stroke in WATER_EVERY is water

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.addInitScript((seed) => {
  let s = seed;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.requestAnimationFrame = () => 0;   // hold the app's frame loop: only this script steps the sim
}, SEED);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.goto(`http://localhost:${port}/?size=128&preset=empty`);
await page.waitForFunction(() => window.__app?.sim, null, { timeout: 90000 });
for (const sc of scens) {
  const [preset, rain] = sc.split(':');
  const line = await page.evaluate(async (o) => {
    const a = window.__app, sim = a.sim, g = sim.g, R = a.renderer, V3 = a.THREE.Vector3;
    const { E } = await import('/src/elements.js');
    const { SUPER_MAP } = await import('/src/shaders/activity.js');
    a.settings.paused = true;
    a.loadPreset(o.preset, false);
    let k = 0;
    const rainNow = (n) => {
      for (let i = 0; i < n; i++, k++) {
        const x = o.RAIN.MARGIN + ((k * o.RAIN.STRIDE_X) % (g.nx - 2 * o.RAIN.MARGIN));
        const z = o.RAIN.MARGIN + ((k * o.RAIN.STRIDE_Z) % (g.nz - 2 * o.RAIN.MARGIN));
        sim.paint({ center: new V3(x, g.ny - o.RAIN.BELOW_TOP, z), radius: o.RAIN.RADIUS, shape: 0,
          tool: k % o.RAIN.WATER_EVERY ? E.SAND : E.WATER, rate: 1, replace: false });
      }
    };
    for (let i = 0; i < o.SETTLE_ROUNDS; i++) { rainNow(o.rain); for (let j = 0; j < o.SETTLE_STEPS; j++) sim.step(); }
    const full = sim.superU.uFullShare.value, f = new Float32Array(4);
    const modes = {
      regions: () => { sim.skipSleeping = true; sim.superU.uFullShare.value = o.REGIONS_ONLY_SHARE; },
      full: () => { sim.skipSleeping = false; },
    };
    const t = { regions: [], full: [] }, drawn = [], steps = [], ratio = [];
    for (let c = 0; c < o.CHUNKS; c++) {
      rainNow(o.rain);
      for (let j = 0; j < o.WOKEN_STEPS; j++) sim.step();
      for (const m of (c % 2 ? ['full', 'regions'] : ['regions', 'full'])) {
        modes[m]();
        sim.gpuSync();
        const t0 = performance.now();
        for (let i = 0; i < o.CHUNK_STEPS; i++) sim.step();
        sim.gpuSync();
        t[m].push((performance.now() - t0) / o.CHUNK_STEPS);
        R.readRenderTargetPixels(sim.superShare, 0, 0, 1, 1, f);
        drawn.push(f[SUPER_MAP.DRAWN]); steps.push(f[SUPER_MAP.STEPS]);
      }
      ratio.push(t.regions.at(-1) / t.full.at(-1));
    }
    sim.skipSleeping = true;
    sim.superU.uFullShare.value = full;
    const q = (xs, p) => xs.slice().sort((x, y) => x - y)[Math.round((xs.length - 1) * p)];
    const pct = (v) => `${(100 * v).toFixed(1)}%`;
    return `drawn ${pct(q(drawn, 0.5))} steps ${pct(q(steps, 0.5))}: regions ${q(t.regions, 0.5).toFixed(3)} ms, full ${q(t.full, 0.5).toFixed(3)} ms,`
      + ` regions/full ${q(ratio, 0.5).toFixed(3)} [${q(ratio, 0.25).toFixed(3)}–${q(ratio, 0.75).toFixed(3)}]`;
  }, { preset, rain: +rain, CHUNKS, SETTLE_ROUNDS, SETTLE_STEPS, WOKEN_STEPS, CHUNK_STEPS, REGIONS_ONLY_SHARE, RAIN });
  console.log(`${sc.padEnd(12)} ${line}`);
}
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
