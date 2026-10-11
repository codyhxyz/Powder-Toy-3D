// The simulation's invariants on the GPU (docs/webgpu.md I2), in the harness
// (tools/harness/sim-check.*: the Simulation on its own device, no app). One
// browser per stage, each within ~3 minutes on SwiftShader:
//   determinism   I2.1  same seed, and the lists and the thread → block map permuted:
//                       identical state, flow, copies, maps (and drawn) at every
//                       checkpoint; I2.10's race probe reported, not asserted
//   sleep         I2.2  every brick dispatched (skipSleeping = false) vs the sleeping
//                       rules: identical state, flow, copies, maps (inert, quiet,
//                       awake), in four scenes and with a write between single steps,
//                       each sleeping run having skipped units; DRAWN bounded with
//                       one-step maps and a write every step
//   conservation  I2.3  cells per element exact over 300 steps; Σ cap·T within 1e-5
//   behaviour     I2.4  sand piles, water levels, wood burns, heat diffuses, a world
//                       at rest certifies idle
//   moves         I2.5  the move in place and out of place: identical; and its two
//                       code forms (D2: unrolled ships, loop is the sim bench's A/B)
//   io            I2.7  readState/load, syncCopies/readCopies, undo; two-phase
//                       edits (one outgrowing the scratch of the other, still in
//                       the open encoder), edits bound to two ranges of one
//                       buffer, a probe (D6)
//   shift         I2.9  shift + slab edit + 50 steps: identical without syncCopies
//   modes               TPT's gravity modes (vertical, off, radial), judged as
//                       main's tools/sim-modes-check.mjs judges them
//   edgemodes           its edge modes (void, loop)
//   air                 its air modes and ambient heat
//   edges               one owner per Margolus block (the move's owner check:
//                       with loop edges every cell exactly once a step, and the
//                       low margin run anyway caught); void edges lose matter
//                       only from the boundary, a sealed tank none; the
//                       decoration plane rides the move (U17's attach point),
//                       in and out of place
//   radial              cells per element exact with radial gravity, loop edges
//                       and both; permuted lists and blocks identical (I2.1) there
//   tools               TPT's brush tools (Mix, Vacuum, Wind, Cyclone, gravity
//                       wells, ambient heat) and editing tools (line, box, replace
//                       target, PROP, specific delete, flood fill) on the brush's
//                       kernel, and the console's readStateRect
//   timing              GPU ms per step per kernel (timestamps) at 32³ and 64³
// Every stage's sims run the debug prelude: an out-of-grid access fails it (I2.8).
// I2.6 (aeration over its list vs every brick) is U12's: the aeration kernel is its.
//
// Step budgets, set from the timing stage on SwiftShader with the unrolled move
// (GPU ms per step: 32³ lab 192 wall = inert 21 + move 97 + react 72; 64³ lab
// 640 = 88 + 321 + 225), so a stage stays within ~3 minutes: at 32³ determinism
// 7 runs × 72 steps, sleep 4 scenes × 2 × 48 + 2 × 20 + 32, conservation 300 +
// 100, behaviour about 1,000, moves 3 × 60, io 28, shift 2 × 60 (156, 129, 93,
// 165, 64, 33 and 49 s); at --size 64 a third to a half of that, over fewer
// scenes, and determinism without I2.10's reported-only race probe (behaviour
// stays a 32³ stage: its scenes are sized for it). The sync 2 stages run where
// every brick is drawn (radial gravity and void or loop edges switch quiet
// skipping off: 300-520 ms per 32³ step with the debug prelude, sharing the
// CPUs): modes 120 + 50 + 220 steps, edgemodes 80 + 60 + 60 + 36, air 85 +
// 120, edges about 150, radial 3 × 60 + 3 × 24, tools none (150, 133, 92,
// 102, 152 and 35 s at 32³); they are 32³ stages, their scenes sized for it.
//
// --unit super runs every stage's sims with supertile sleeping units (SLEEP_UNIT =
// SUPER, docs/scaling.md D8's granularity, the A/B docs/webgpu.md W12 keeps),
// at 64³ unless --size says otherwise.
//
// --steps N runs the stages that script steps (determinism, sleep, conservation,
// moves, shift) for N steps instead of the budget above: on the Mac (I4.0),
// --steps 300 gives I2's counts.
//
// usage: node tools/sim-check.mjs [--stage determinism,sleep,…] [--size 32|64|128] [--unit brick|super] [--steps N] [--port N]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const ALL = ['determinism', 'sleep', 'conservation', 'behaviour', 'moves', 'io', 'shift', 'modes', 'edgemodes', 'air', 'edges', 'radial', 'tools'];
const stages = opt('stage')?.split(',') ?? ALL;
const SUPER = { x: 4, y: 2, z: 2 };   // shaders/common.js SUPER
const unit = opt('unit') === 'super' ? SUPER : null;
// (the 32³ grid has 32 supertiles and the lab draws them all, so the sleep
// stage would compare nothing there: supertile units default to 64³)
const size = opt('size') ? Number(opt('size')) : unit ? 64 : undefined;
const steps = opt('steps') ? Number(opt('steps')) : undefined;
const stageOpts = { ...(size && { size }), ...(steps && { steps }) };

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
      const r = await page.evaluate(([s, o, u]) => { window.__harness.sleepUnit = u; return window.__harness.run(`stage:${s}`, o); }, [stage, stageOpts, unit]);
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
