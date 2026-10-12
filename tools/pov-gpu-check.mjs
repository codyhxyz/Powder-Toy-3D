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

/**
 * Runs `stages` of the POV harness page, a browser each; prints every check.
 * @param {string[]} stages
 * @returns {Promise<number>} failures
 */
export async function runStages(stages) {
  const vite = await startVite({ harness: true });
  let failures = 0, printedGpu = false;
  try {
    for (const stage of stages) {
      const browser = await launchBrowser();
      const errors = [];
      const t0 = Date.now();
      try {
        const page = await openHarness(browser, vite, '/tools/harness/pov-check.html', { errors });
        if (!printedGpu) {
          const info = await gpuInfo(page);
          console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
          printedGpu = true;
        }
        const r = await page.evaluate((s) => window.__harness.run(`stage:${s}`), stage);
        console.log(`\n${stage} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        for (const c of r.checks) {
          if (!c.ok) failures++;
          console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `\n     ${c.detail}`}`);
        }
        if (r.ms && Object.keys(r.ms).length) console.log(`     ms: ${JSON.stringify(r.ms, (k, v) => (typeof v === 'number' ? Math.round(v) : v))}`);
        const logs = await page.evaluate(() => window.__harness.log.filter((l) => /pov kernels/.test(l)));
        if (logs.length) console.log(`     ${logs.join('; ')}`);
      } catch (e) {
        failures++;
        console.log(`\n${stage}\nFAIL ${e.message.split('\n')[0]}`);
      } finally {
        await browser.close();
      }
      const bad = errors.filter((e) => !/Failed to load resource/.test(e));
      if (bad.length) {
        failures++;
        console.log(`FAIL page errors in ${stage}: ${bad.slice(0, 3).join(' | ')}`);
      }
    }
  } finally {
    await vite.close();
  }
  console.log(failures ? `\n${failures} failure(s)` : `\n${stages.join(', ')}: OK`);
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  process.exit(await runStages(opt('stage')?.split(',') ?? ALL) ? 1 : 0);
}
