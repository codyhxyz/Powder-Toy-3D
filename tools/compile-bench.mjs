// Pipeline bench: cold creation time of the view modules (shaders/render.js
// volumeFrag, one per view and realistic detail variant) on this machine's
// GPU, through createRenderPipelineAsync as the app builds them (docs/webgpu.md
// W18, B5; Mac checkpoint M2 in I4). Each run builds a module no cache has
// seen (a unique constant in its text), so neither Dawn's pipeline cache nor
// Apple's Metal compiler cache can hit. Times, per run:
//   ms       shader module + pipeline, request to resolve
//   module   createShaderModule alone (Tint's parse and validation)
//   gap      the main thread's longest gap meanwhile (a 4 ms timer): goal 4
//            says nothing over 100 ms while pipelines build
// Variants are interleaved run by run, so load from other processes hits
// them alike. For the MSL sizes (M2), add
// --browser-arg --enable-dawn-features=dump_shaders and read the browser log.
// The harness page (tools/harness/volume.html) builds a 64³ simulation to boot;
// the benched modules are for --grid (128³, the box default and the world window).
//
// usage: node tools/compile-bench.mjs [--variants realistic:off,realistic:balanced,realistic:full,plain,heat]
//        [--runs 3] [--grid 128,128,128] [--port 5606] [--browser-arg --flag]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { REALISTIC_LEVELS } from '../src/shaders/render.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const runs = Number(opt('runs', '3'));
const grid = opt('grid', '128,128,128').split(',').map(Number);
const variants = opt('variants', 'realistic:off,realistic:balanced,realistic:full,plain,heat,pressure,flow,xray').split(',');
const browserArgs = args.flatMap((a, i) => (a === '--browser-arg' ? [args[i + 1]] : []));
// a variant: a view, and for the realistic view a detail level (REALISTIC_LEVELS)
const specOf = (name) => {
  const [view, level = 'balanced'] = name.split(':');
  return { view, detail: view === 'realistic' ? REALISTIC_LEVELS[level]() : {} };
};

const vite = await startVite({ harness: true, port: Number(opt('port', '5606')) });
const browser = await launchBrowser({ args: browserArgs });
try {
  const page = await openHarness(browser, vite, '/tools/harness/volume.html', { timeout: 180000 });
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; modules for ${grid.join('×')}`);
  const totals = {};
  for (let r = 0; r < runs; r++) {
    for (const name of variants) {
      const res = await page.evaluate(([spec, g]) => window.__harness.run('bench', { ...spec, grid: g, runs: 1 }), [specOf(name), grid]);
      if (res.failures.length) throw new Error(`${name}: ${res.failures.join(' | ')}`);
      const o = res.out[0];
      console.log(`${name.padEnd(20)} run ${r + 1}: ${(o.ms / 1000).toFixed(2)} s  module ${o.moduleMs.toFixed(0)} ms  gap ${o.maxGapMs.toFixed(0)} ms  ${o.lines} lines`);
      (totals[name] ??= []).push(o);
    }
  }
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  for (const [k, v] of Object.entries(totals)) {
    console.log(`${k.padEnd(20)} median ${(median(v.map((o) => o.ms)) / 1000).toFixed(2)} s, longest main-thread gap ${Math.max(...v.map((o) => o.maxGapMs)).toFixed(0)} ms`);
  }
} finally {
  await browser.close();
  await vite.close();
}
