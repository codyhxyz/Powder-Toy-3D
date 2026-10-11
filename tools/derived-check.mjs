// The derived passes (docs/webgpu.md E), in the harness (tools/harness/derived-check.*:
// a Simulation and its src/derived.js on their own device, no app). One browser per
// stage, each within ~3 minutes on SwiftShader:
//   steps   incremental (sim.incremental) against a full rebuild every frame
//           (sim.incremental = false: the same kernels over lists of every brick), bit
//           for bit, every derived resource (the field EMA, the three final fields,
//           the brick map, brickDist, the glow volume, the GI history and bands), at
//           checkpoints of scripted runs: the lab running, a moving water brush
//   writes  the heat tool, undo, three steps a frame then derived frames without
//           steps (the age pass's steps gate), a smoothing change
//   shift   the same over window moves along x and z (two in one derived frame), each
//           slab filled by an edit, in a running world and in a still one whose
//           derived passes have settled: the derived history shifts by whole bricks
//           and re-ages only the slab and the moving faces; and the shift's kernels and
//           copies against a CPU model (ages, brick map, brickDist, EMA, final
//           fields, GI history and textures)
//   units   the fused peak (boost stages 3-5) against the separable stages, bit for
//           bit; the brick map's info words: the WGSL decoders against their JS twins
//           on every combination, and a scene's bricks against what they hold
// Any difference between incremental and full means a dirty set missed a change, or
// a pass read a value its list didn't cover. Each stage also shows that the
// incremental lists skipped bricks, so a comparison isn't vacuous.
//
// usage: node tools/derived-check.mjs [--stage steps,writes,shift,units] [--port N]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
// stage → [cases (harness CASES), unit tests]
const STAGES = {
  steps: [['lab', 'paint'], []],
  writes: [['heat', 'undo', 'pause', 'smoothing'], []],
  shift: [['shift', 'shiftStill'], ['shiftModel']],
  units: [[], ['fused', 'bits']],
};
const stages = opt('stage')?.split(',') ?? Object.keys(STAGES);

const vite = await startVite({ harness: true });
let failures = 0, printedGpu = false;
try {
  for (const stage of stages) {
    if (!STAGES[stage]) { failures++; console.log(`FAIL no stage ${stage} (have: ${Object.keys(STAGES).join(', ')})`); continue; }
    const [cases, units] = STAGES[stage];
    const browser = await launchBrowser();
    const errors = [];
    const t0 = Date.now();
    try {
      const page = await openHarness(browser, vite, '/tools/harness/derived-check.html', { errors });
      if (!printedGpu) {
        const info = await gpuInfo(page);
        console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
        printedGpu = true;
      }
      console.log(`\n${stage}`);
      let skipped = false;
      const print = (r) => {
        for (const c of r.checks) {
          if (!c.ok) failures++;
          console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `\n     ${c.detail}`}`);
        }
      };
      for (const name of cases) {
        const r = await page.evaluate((n) => window.__harness.run('case', n), name);
        print(r);
        skipped ||= r.skipped;
        const l = r.lists.map((x) => `${x.ema}/${x.fields}/${x.work}`).join(' ');
        console.log(`     ${(r.ms / 1000).toFixed(0)} s; incremental lists EMA/FIELDS/WORK at the checkpoints: ${l} (of ${r.lists[0].bricks} bricks)`);
      }
      if (cases.length) {
        const ok = skipped;
        if (!ok) failures++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} the incremental passes skipped bricks at some checkpoint (the comparisons aren't vacuous)`);
      }
      for (const name of units) print(await page.evaluate((n) => window.__harness.run(n), name));
      const pageFailures = await page.evaluate(() => window.__harness.failures);
      if (pageFailures.length) { failures++; console.log(`FAIL graphics failures: ${pageFailures.join(' | ')}`); }
      console.log(`     (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
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
console.log(failures ? `\nderived-check: ${failures} failure(s)` : '\nderived-check: incremental == full, bit for bit');
process.exit(failures ? 1 : 0);
