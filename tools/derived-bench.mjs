// GPU time of the derived passes (docs/webgpu.md E), incremental against a full
// rebuild every frame (sim.incremental = false), in the harness
// (tools/harness/derived-check.html: no app). Each frame steps the simulation
// first, as the app does, so the incremental passes have something to rebuild.
// Per grid and scene, chunks of K frames alternate the two modes (A B B A);
// each chunk's GPU ms per kernel come from timestamp queries in split mode (a
// pass per dispatch), and the medians are reported per derived frame, with the
// lists' lengths. Without timestamp-query only the wall ms (steps included)
// are meaningful.
//
// usage: node tools/derived-bench.mjs [--size 32,64] [--scen lab,volcano] [--frames 6] [--steps 2]
//          [--chunks 2] [--out report.json] [--port N]
//   On the Mac (docs/webgpu.md I4.5): --size 64,128 --chunks 4.
import { writeFileSync } from 'node:fs';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const opts = {
  sizes: opt('size', '32,64').split(',').map(Number),
  scenes: opt('scen', 'lab,volcano').split(','),
  frames: Number(opt('frames', '6')),
  steps: Number(opt('steps', '2')),
  chunks: Number(opt('chunks', '2')),
};
const OUT = opt('out', null);

const vite = await startVite({ harness: true });
const browser = await launchBrowser();
let failed = false;
try {
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/derived-check.html', { errors, timeout: 180000 });
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
  const r = await page.evaluate((o) => window.__harness.run('bench', o), opts);
  if (!r.timestamps) console.log('(no timestamp-query: GPU columns empty; wall ms include the steps)');
  const fmt = (x) => (x === undefined ? '-' : x.toFixed(x < 1 ? 3 : 2));
  for (const g of r.grids) {
    for (const s of g.scenes) {
      console.log(`\n${g.n}³ ${s.scene}: lists EMA ${s.lists.ema}, FIELDS ${s.lists.fields}, WORK ${s.lists.work} of ${s.bricks} bricks`);
      const kernels = [...new Set(Object.values(s.modes).flatMap((m) => Object.keys(m.kernels)))];
      console.log(`  ${'kernel'.padEnd(12)} ${'incremental'.padStart(12)} ${'full'.padStart(10)}   (GPU ms per derived frame)`);
      for (const k of kernels) console.log(`  ${k.padEnd(12)} ${fmt(s.modes.incremental.kernels[k]).padStart(12)} ${fmt(s.modes.full.kernels[k]).padStart(10)}`);
      console.log(`  ${'derived'.padEnd(12)} ${fmt(s.modes.incremental.gpuMsPerFrame).padStart(12)} ${fmt(s.modes.full.gpuMsPerFrame).padStart(10)}`);
      console.log(`  ${'wall/frame'.padEnd(12)} ${fmt(s.modes.incremental.wallMsPerFrame).padStart(12)} ${fmt(s.modes.full.wallMsPerFrame).padStart(10)}   (ms, steps included)`);
    }
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ gpu: info, ...r }, null, 2));
  const pageFailures = await page.evaluate(() => window.__harness.failures);
  if (pageFailures.length || errors.length) { failed = true; console.log(`FAIL ${[...pageFailures, ...errors].join(' | ')}`); }
} finally {
  await browser.close();
  await vite.close();
}
process.exit(failed ? 1 : 0);
