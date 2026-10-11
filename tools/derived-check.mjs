// The derived passes (docs/webgpu.md E), in the harness (tools/harness/derived-check.*:
// a Simulation and its src/derived.js on their own device, no app). One browser per
// stage, each within ~3 minutes on SwiftShader:
//   steps   incremental (sim.incremental) against a full rebuild every frame
//           (sim.incremental = false: the same kernels over lists of every brick), bit
//           for bit, every derived resource (the field EMA, the three final fields,
//           the brick map, brickDist, the glow volume, the GI history and bands), at
//           checkpoints of scripted runs: the lab running, a moving water brush
//   writes  the heat tool, undo, three steps a frame then derived frames without
//           steps (the age pass's steps gate), a still world painted every frame
//           (only the lists' dilation covers the brush's surroundings), a
//           smoothing change
//   shift   the same over window moves along x and z (two in one derived frame), each
//           slab filled by an edit, in a running world and in a still one whose
//           derived passes have settled: the derived history shifts by whole bricks
//           and re-ages only the slab and the moving faces; and the shift's kernels and
//           copies against a CPU model (ages, brick map, brickDist, EMA, final
//           fields, GI history and textures, an edit's change pending at the move)
//   pending moves in a settled, running world, each tick in the app's order (an edit,
//           the steps, an edit after them, the move, the slab's fill, the derived
//           frame), so every move finds changes the age pass hasn't counted (writer
//           marks, the steps' `changed` map): compared at each move's frame and the
//           next, where the lists must skip bricks; and its negative control, the
//           same run without the fold before the shift, must differ
//   units   the fused peak (boost stages 3-5) against the separable stages, bit for
//           bit; the brick map's info words: the WGSL decoders against their JS twins
//           on every combination, and a scene's bricks against what they hold (a lit
//           lamp's light with LAMP_ROOM_GAIN included)
//   jet     falling water from whitewater's aeration field (shaders/fields.js jetWGSL,
//           with a stand-in for gfx/foam.js's buffer): every kind of record through
//           the EMA, the boost, the thin mask and the brick map against a JS twin, the
//           current copy, detaching; and incremental == full while the aeration
//           starts and stops over a still world, with its negative control (no rebuild
//           at the start and stop: derived.test.dropJetToggle) that must differ
// Any difference between incremental and full means a dirty set missed a change, or
// a pass read a value its list didn't cover. Each stage also shows that the
// incremental lists skipped bricks, so a comparison isn't vacuous.
//
// usage: node tools/derived-check.mjs [--stage steps,writes,shift,pending,units,jet] [--case name,…] [--size N] [--port N]
//   --case runs only those cases (the harness's CASES), in one browser
//   --size N runs the cases at N³, the moving ones in an N×… window twice as wide (2N×N×N);
//           else at their own (32³, 64×32×32: the container's). On the Mac (docs/webgpu.md
//           I4.0): --size 64, then --size 128 (one stage at a time: each takes longer)
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
// stage → [cases (harness CASES), unit tests]
const STAGES = {
  steps: [['lab', 'paint'], []],
  writes: [['heat', 'undo', 'pause', 'still', 'smoothing'], []],
  shift: [['shift', 'shiftStill'], ['shiftModel']],
  pending: [['shiftPending'], []],
  units: [[], ['fused', 'bits']],
  jet: [['jetToggle'], ['jet']],
};
const size = opt('size') ? Number(opt('size')) : null;
if (size !== null && !(size >= 16 && size % 16 === 0)) throw new Error(`--size ${opt('size')}: a multiple of 16 (whole supertiles)`);
if (opt('case')) STAGES.cases = [opt('case').split(','), []];
const stages = opt('case') ? ['cases'] : opt('stage')?.split(',') ?? Object.keys(STAGES).filter((k) => k !== 'cases');

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
        const r = await page.evaluate(([n, s]) => window.__harness.run('case', n, { size: s }), [name, size]);
        print(r);
        skipped ||= r.skipped;
        const l = r.lists.map((x) => `${x.ema}/${x.fields}/${x.work}`).join(' ');
        console.log(`     ${r.grid}, ${(r.ms / 1000).toFixed(0)} s; incremental lists EMA/FIELDS/WORK at the checkpoints: ${l} (of ${r.lists[0].bricks} bricks)`);
        if (r.control) console.log(`     the control differs in ${r.control.words} words: ${r.control.first}`);
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
