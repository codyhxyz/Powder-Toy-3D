// The mesh layer (docs/webgpu.md F8, J1 U13) in the harness
// (tools/harness/mesh.*: a Simulation, its derived passes, the volume and
// post, and three.js's meshes over them on their own device, no app).
//
// usage: node tools/mesh-check.mjs [--stage spike] [--size N] [--port N] [--out dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const STAGES = { spike: ['spike'] };
const size = Number(opt('size') ?? 32);
const stages = opt('stage')?.split(',') ?? Object.keys(STAGES);
const OUT = opt('out') ?? join(ROOT, '.tmp-mesh');
mkdirSync(OUT, { recursive: true });

const vite = await startVite({ harness: true });
const browser = await launchBrowser();
let failures = 0;
const t00 = Date.now();
try {
  const errors = [];
  const page = await openHarness(browser, vite, `/tools/harness/mesh.html?size=${size}`, { errors });
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
  for (const stage of stages) {
    if (!STAGES[stage]) { failures++; console.log(`FAIL no stage ${stage} (have: ${Object.keys(STAGES).join(', ')})`); continue; }
    console.log(`\n${stage}`);
    for (const name of STAGES[stage]) {
      const t0 = Date.now();
      try {
        const r = await page.evaluate((n) => window.__harness.run(n), name);
        console.log(JSON.stringify(r).slice(0, 2000));
      } catch (e) {
        failures++;
        console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
      }
      console.log(`     (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }
  const pageFailures = await page.evaluate(() => window.__harness.failures);
  if (pageFailures.length) { failures++; console.log(`FAIL graphics failures: ${pageFailures.join(' | ')}`); }
  if (errors.length) { failures++; console.log(`FAIL page errors: ${errors.join(' | ').slice(0, 3000)}`); }
} finally {
  await browser.close();
  await vite.close();
}
console.log(`\n(${((Date.now() - t00) / 1000).toFixed(0)} s in all)`);
if (failures) { console.log(`${failures} failed`); process.exitCode = 1; }
