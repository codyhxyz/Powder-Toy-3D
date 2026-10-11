// The simulation's invariants on the GPU (docs/webgpu.md I2), in the harness
// (tools/harness/sim-check.*: the Simulation on its own device, no app). One
// browser per stage, each within ~3 minutes on SwiftShader:
//   determinism   I2.1  same seed, and the lists and the thread → block map permuted:
//                       identical state, flow, copies, maps (and drawn) at every
//                       checkpoint; I2.10's race probe reported, not asserted
//   sleep         I2.2  every brick dispatched (skipSleeping = false) vs the sleeping
//                       rules: identical state, flow, copies, maps (inert, quiet,
//                       awake), in four scenes and with a write between single steps;
//                       DRAWN bounded with one-step maps and a write every step
//   conservation  I2.3  cells per element exact over 300 steps; Σ cap·T within 1e-5
//   behaviour     I2.4  sand piles, water levels, wood burns, heat diffuses, rest → idle
//   moves         I2.5  the move in place and out of place: identical
//   io            I2.7  readState/load, syncCopies/readCopies, undo
//   shift         I2.9  shift + slab edit + 50 steps: identical without syncCopies
//   timing              GPU ms per step per kernel (timestamps) at 32³ and 64³
// Every stage's sims run the debug prelude: an out-of-grid access fails it (I2.8).
// I2.6 (aeration over its list vs every brick) is U12's: the aeration kernel is its.
//
// Step budgets (SwiftShader, measured by the timing stage, see the U2 hand-back):
// determinism 6 runs × 96 steps at 32³, sleep 4 scenes × 2 × 60 + 2 × 24 + 40,
// conservation 300 + 100, behaviour about 1,000, moves 2 × 60, io 26, shift 2 × 60.
//
// usage: node tools/sim-check.mjs [--stage determinism,sleep,…] [--size 32] [--port N]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const ALL = ['determinism', 'sleep', 'conservation', 'behaviour', 'moves', 'io', 'shift'];
const stages = opt('stage')?.split(',') ?? ALL;
const size = opt('size') ? Number(opt('size')) : undefined;

const vite = await startVite({ harness: true });
let failures = 0, printedGpu = false;
try {
  for (const stage of stages) {
    const browser = await launchBrowser();
    const errors = [];
    const t0 = Date.now();
    try {
      const page = await openHarness(browser, vite, '/tools/harness/sim-check.html', { errors });
      if (!printedGpu) {
        const info = await gpuInfo(page);
        console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
        printedGpu = true;
      }
      const r = await page.evaluate(([s, o]) => window.__harness.run(`stage:${s}`, o), [stage, size ? { size } : {}]);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`\n${stage} (${secs} s)`);
      for (const c of r.checks) {
        if (!c.ok) failures++;
        console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `\n     ${c.detail}`}`);
      }
      if (r.raceProbe) console.log(`note ${r.raceProbe}`);
      if (r.ms && Object.keys(r.ms).length) console.log(`     ms/step (wall, debug prelude): ${JSON.stringify(r.ms, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v))}`);
      for (const t of r.times ?? []) {
        const k = Object.entries(t.gpu).map(([n, ms]) => `${n} ${ms.toFixed(2)}`).join(', ');
        console.log(`     ${t.n}³ ${t.scene.padEnd(6)} DRAWN ${t.counts.drawn}/${t.counts.units}: wall ${t.wall.toFixed(1)} ms/step; GPU ms/step: ${k}`);
      }
      const pageFailures = await page.evaluate(() => window.__harness.failures);
      if (pageFailures.length) { failures++; console.log(`FAIL graphics failures: ${pageFailures.join(' | ')}`); }
    } catch (e) {
      failures++;
      console.log(`\n${stage}\nFAIL ${e.message.split('\n')[0]}`);
    } finally {
      if (errors.length) { failures++; console.log(`FAIL page errors: ${errors.join(' | ')}`); }
      await browser.close();
    }
  }
} finally {
  await vite.close();
}
console.log(failures ? `\nsim-check: ${failures} failure(s)` : '\nsim-check: every invariant holds');
process.exit(failures ? 1 : 0);
