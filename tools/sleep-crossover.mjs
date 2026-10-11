// Where the sleeping machinery stops paying (docs/webgpu.md W12, D4): with the
// sim's brick lists, a step dispatches only the DRAWN units, and a map costs
// six small dispatches every ACTIVITY_PERIOD steps. This alternates chunks of
// steps (A B B A ...) at the same states between the two ways, since both give
// the same state (tools/sim-check.mjs sleep):
//   sleeping   the lists (sim.skipSleeping = true)
//   all        every unit DRAWN (sim.skipSleeping = false), through the same kernels
// Each scene is a preset with sand and water rained over the box between chunks
// (untimed: `rain` strokes per chunk) to wake more of it. Per scene: the share of
// units DRAWN, ms per step each way (median chunk), and the median sleeping/all
// ratio of adjacent chunk pairs with its quartiles. The share where the ratio
// crosses 1 is where sleeping stops paying. Runs in the sim harness (no app);
// run it on a quiet GPU (SwiftShader's numbers only show the tool works).
// usage: node tools/sleep-crossover.mjs [--scen lab:0,lab:8,lab:40,volcano:0] [--size 64] [--chunks 8] [--port N]
//   (scen: preset:rain strokes per chunk)
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const scens = opt('scen', 'lab:0,lab:8,lab:40,volcano:0').split(',');
const SIZE = Number(opt('size', '64'));
const CHUNKS = +opt('chunks', '8');
const SEED = 777;                 // Math.random seed (mulberry32, as tools/regress.mjs)
const SETTLE_ROUNDS = 3;          // rain, then SETTLE_STEPS steps, this many times before timing
const SETTLE_STEPS = 12;
const WOKEN_STEPS = 2;            // steps after a chunk's rain before timing it (past the map its writes woke)
const CHUNK_STEPS = 8;            // steps per timed chunk
const RAIN = { RADIUS: 3, BELOW_TOP: 6, MARGIN: 4, STRIDE_X: 37, STRIDE_Z: 61, WATER_EVERY: 3 };   // cells; one stroke in WATER_EVERY is water

const vite = await startVite({ harness: true });
const errors = [];
let failed = false;
try {
  for (const sc of scens) {
    const [preset, rain] = sc.split(':');
    const browser = await launchBrowser();
    try {
      const page = await openHarness(browser, vite, '/tools/harness/sim-check.html', { errors });
      if (sc === scens[0]) {
        const info = await gpuInfo(page);
        console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; ${SIZE}³`);
      }
      const line = await page.evaluate(async (o) => {
        const h = window.__harness, E = h.E;
        const sim = await h.make(o.SIZE, { debug: false });
        const g = sim.g;
        h.scene(sim, o.preset, o.SEED);
        let k = 0;
        const rainNow = (n) => {
          for (let i = 0; i < n; i++, k++) {
            const x = o.RAIN.MARGIN + ((k * o.RAIN.STRIDE_X) % (g.nx - 2 * o.RAIN.MARGIN));
            const z = o.RAIN.MARGIN + ((k * o.RAIN.STRIDE_Z) % (g.nz - 2 * o.RAIN.MARGIN));
            sim.paint({ center: { x, y: g.ny - o.RAIN.BELOW_TOP, z }, radius: o.RAIN.RADIUS, shape: 0,
              tool: k % o.RAIN.WATER_EVERY ? E.SAND : E.WATER, rate: 1, replace: false });
          }
        };
        for (let i = 0; i < o.SETTLE_ROUNDS; i++) { rainNow(o.rain); for (let j = 0; j < o.SETTLE_STEPS; j++) sim.step(); }
        const t = { sleeping: [], all: [] }, drawn = [], ratio = [];
        for (let c = 0; c < o.CHUNKS; c++) {
          rainNow(o.rain);
          for (let j = 0; j < o.WOKEN_STEPS; j++) sim.step();
          for (const m of (c % 2 ? ['all', 'sleeping'] : ['sleeping', 'all'])) {
            sim.skipSleeping = m === 'sleeping';
            await sim.gpuSync();
            const t0 = performance.now();
            for (let i = 0; i < o.CHUNK_STEPS; i++) sim.step();
            await sim.gpuSync();
            t[m].push((performance.now() - t0) / o.CHUNK_STEPS);
            if (m === 'sleeping') { const n = await sim.readCounts(); drawn.push(n.drawn / n.units); }
          }
          ratio.push(t.sleeping.at(-1) / t.all.at(-1));
        }
        sim.dispose();
        const q = (xs, p) => xs.slice().sort((x, y) => x - y)[Math.round((xs.length - 1) * p)];
        const pct = (v) => `${(100 * v).toFixed(1)}%`;
        return `DRAWN ${pct(q(drawn, 0.5))}: sleeping ${q(t.sleeping, 0.5).toFixed(2)} ms, all ${q(t.all, 0.5).toFixed(2)} ms,`
          + ` sleeping/all ${q(ratio, 0.5).toFixed(3)} [${q(ratio, 0.25).toFixed(3)}–${q(ratio, 0.75).toFixed(3)}]`;
      }, { preset, rain: +rain, SIZE, SEED, CHUNKS, SETTLE_ROUNDS, SETTLE_STEPS, WOKEN_STEPS, CHUNK_STEPS, RAIN });
      console.log(`${sc.padEnd(12)} ${line}`);
    } catch (e) {
      failed = true;
      console.log(`${sc.padEnd(12)} ${e.message.split('\n')[0]}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await vite.close();
}
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
process.exit(failed || errors.length ? 1 : 0);
