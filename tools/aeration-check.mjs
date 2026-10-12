// Whitewater's aeration field over its brick list vs over every brick
// (docs/webgpu.md G4, I2.6): the field and its reference (the same kernel
// over every brick) step side by side on the harness page
// (tools/harness/aeration-check.*), and every step's current copies must be
// identical, word for word, through a pour and the idle steps after it; and
// the same scene run twice gives the same field (determinism). A negative
// control that lists bricks by the foams words alone (no nz history) must
// differ: stale copies and wakes left behind.
// usage: node tools/aeration-check.mjs [--size 32] [--port N]
import { launchBrowser } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const size = Number(arg('--size', 32));

const vite = await startVite({ harness: true });
let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };
try {
  const browser = await launchBrowser();
  try {
    const errors = [];
    const page = await openHarness(browser, vite, '/tools/harness/aeration-check.html', { errors });
    const run = (opts) => page.evaluate((o) => window.__harness.run('compare', o), { size, ...opts });
    const t0 = Date.now();
    const pool = await run({ scene: 'pool', steps: 60, idle: 12 });
    console.log(`pool ${size}³: ${pool.steps} steps + ${pool.idleSteps} idle, list ${pool.listMin}-${pool.listMax} of ${pool.nbricks} bricks (mean ${pool.listMean.toFixed(1)}), up to ${pool.nonzeroMax} nonzero words, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    ok(pool.mismatchSteps === 0, `list == every brick at every step of the pour and its idle steps (${pool.mismatchSteps} steps differ${pool.firstMismatch ? `, first ${pool.firstMismatch}` : ''})`);
    ok(pool.nonzeroMax > 0, 'the scene makes a field (nonzero records)');
    // (the first two steps list every brick: the field starts over, gfx/foam.js START_STEPS)
    ok(pool.listMin < pool.nbricks && pool.listMean < pool.nbricks, `the list leaves bricks out (${pool.listMin} at least, mean ${pool.listMean.toFixed(1)} of ${pool.nbricks})`);
    ok(pool.dbg === 0, `no out-of-grid access (debug counter ${pool.dbg})`);
    const DET = 30;   // steps of the second run: its field at each against the first run's
    const again = await run({ scene: 'pool', steps: DET, idle: 0 });
    const same = again.hashes.every((x, i) => x === pool.hashes[i]);
    ok(same && again.hashes.length === DET, `determinism: the same run gives the same field at each of ${DET} steps (step ${DET}: ${pool.hashes[DET - 1]} / ${again.hashes[DET - 1]})`);
    const loop = await run({ scene: 'loop', steps: 30, idle: 6 });
    ok(loop.mismatchSteps === 0 && loop.nonzeroMax > 0, `loop edges: list == every brick (${loop.mismatchSteps} steps differ${loop.firstMismatch ? `, first ${loop.firstMismatch}` : ''}; list up to ${loop.listMax}, ${loop.nonzeroMax} nonzero words)`);
    const control = await run({ scene: 'pool', steps: 60, idle: 12, dropHistory: true, stopOnMismatch: true });
    ok(control.mismatchSteps > 0, `negative control (no nz history) differs: ${control.mismatchSteps} steps, first ${control.firstMismatch}`);
    const pageFailures = await page.evaluate(() => window.__harness.failures);
    ok(!pageFailures.length && !errors.length, `no GPU failures or page errors (${[...pageFailures, ...errors].join('; ') || 'none'})`);
    console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } finally { await browser.close(); }
} finally { await vite.close(); }
console.log(failures ? `aeration-check: ${failures} failure(s)` : 'aeration-check: clean');
process.exit(failures ? 1 : 0);
