// The first person's GPU work (src/pov/gpu.js; docs/webgpu.md G2, U11), in
// the harness (tools/harness/pov-check.*: a Simulation of its own device, no
// app). One browser per stage, each well within 3 minutes on SwiftShader:
//   probes    the body's probe, the hook's cells, traces, the burrower's face, the physgun's COM,
//             against readState and the scene as built
//   edits     every edit family: one dispatch (two for the strike), an effect, nothing changed
//             outside its box, no out-of-grid read
//   transfer  exact takes and puts (bit for bit, slot order, ranks), breaking takes, a wanted
//             element; the shovel's and bucket's engine over stepping frames: cells in = cells out
//   laser     reach through the ring = a JS walk; the apply indirect from the reach kernel's args,
//             no read between (the bore is in a readState recorded right after the shot)
//   cells     readCells (the NPCs' world model) = readState: ids and the codec's temperature codes
//             at the atlas texels; its pool's bound
//   wands     the wands' world: effects, the batch bound, traces, clearance (scripts/check-wand-world.mjs)
//   recipes   every preset wand on a small world (scripts/check-wand-recipes.mjs)
//   look      the wands' TSL draws (spells' cores, shells, beams; the gem and halo): compiled through
//             gpu.three.prepare, drawing what the GLSL drew
//
// usage: node tools/pov-gpu-check.mjs [--stage probes,edits,transfer,laser,cells,wands,recipes,look] [--port N]
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

export const ALL = ['probes', 'edits', 'transfer', 'laser', 'cells', 'wands', 'recipes', 'look'];

export const PAGE = '/tools/harness/pov-check.html';
// tools/harness/pov-tools.*: the tools', the body's and the engine's checks (pov-tools-a/b, flask-check,
// pov-player-check, pov-engine-check run its stages)
export const TOOLS_PAGE = '/tools/harness/pov-tools.html';

// A stage that takes a list of cases (pov-tools.js: the body's tests, the
// engine's scenes) runs them from arg.from until it has spent BUDGET_MS on
// them, and says where it stopped (r.next); runStages then goes on from there
// in a browser of its own. So a part stays a few minutes however loaded the
// host is (docs/webgpu.md I1: a run under ~3 minutes; the launcher stops a
// browser at 10): the boot, the cases begun within the budget, the last of
// them finishing past it.
export const BUDGET_MS = 75000;

/**
 * Runs `stages` of a POV harness page, a browser each; prints every check
 * (and a stage's numbers, when it reports some). A stage that answers with
 * `next` (the first of its cases it didn't run) is run again from there, in a
 * browser of its own, until it has run them all.
 * @param {(string | [string, object])[]} stages a stage's name, or [name, the argument its test takes]
 * @param {{ page?: string }} [opts]
 * @returns {Promise<number>} failures
 */
export async function runStages(stages, { page: path = PAGE } = {}) {
  const vite = await startVite({ harness: true });
  let failures = 0, printedGpu = false;
  const queue = [...stages];
  try {
    while (queue.length) {
      const entry = queue.shift();
      const [stage, arg] = Array.isArray(entry) ? entry : [entry, undefined];
      const label = arg ? `${stage} ${JSON.stringify(arg)}` : stage;
      const browser = await launchBrowser();
      const errors = [];
      const t0 = Date.now();
      try {
        const page = await openHarness(browser, vite, path, { errors });
        // a stage's progress lines ('· …', tools/harness/pov-tools.js) as they come
        page.on('console', (m) => { if (m.type() === 'log' && m.text().startsWith('· ')) console.log(`  ${m.text()}`); });
        if (!printedGpu) {
          const info = await gpuInfo(page);
          console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
          printedGpu = true;
        }
        const r = await page.evaluate(([s, a]) => window.__harness.run(`stage:${s}`, a), [stage, arg]);
        console.log(`\n${label} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        for (const c of r.checks) {
          if (!c.ok) failures++;
          console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `\n     ${c.detail}`}`);
        }
        if (r.numbers && Object.keys(r.numbers).length) console.log(JSON.stringify(r.numbers, null, 1));
        if (r.next != null) {   // (its budget spent: the rest of its cases in a browser of their own)
          console.log(`     cases ${arg?.from ?? 0}–${r.next - 1} of ${r.of}; the rest next`);
          queue.unshift([stage, { ...arg, from: r.next }]);
        }
        if (r.ms && Object.keys(r.ms).length) console.log(`     ms: ${JSON.stringify(r.ms, (k, v) => (typeof v === 'number' ? Math.round(v) : v))}`);
        const logs = await page.evaluate(() => window.__harness.log.filter((l) => /pov kernels/.test(l)));
        if (logs.length) console.log(`     ${logs.join('; ')}`);
      } catch (e) {
        failures++;
        console.log(`\n${label}\nFAIL ${e.message.split('\n')[0]}`);
      } finally {
        await browser.close();
      }
      const bad = errors.filter((e) => !/Failed to load resource/.test(e));
      if (bad.length) {
        failures++;
        console.log(`FAIL page errors in ${label}: ${bad.slice(0, 3).join(' | ')}`);
      }
    }
  } finally {
    await vite.close();
  }
  console.log(failures ? `\n${failures} failure(s)` : `\n${stages.map((e) => (Array.isArray(e) ? e[0] : e)).join(', ')}: OK`);
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  process.exit(await runStages(opt('stage')?.split(',') ?? ALL) ? 1 : 0);
}
