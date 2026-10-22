// Real-GPU check of Factory transport, V1 against V2 (tools/harness/industry-belt.*): belts and a lift
// under the real machine driver (src/industry/physics.js) on bare engines, stepped as the app steps them.
// One page, no app, one GPU slot (≤25 s). Prints each run's measurement as JSON.
//   node tools/v2/industry-belt-browser-check.mjs --runs v1:belt:4,v1:belt:12,v1:lift [--port N]
//   a run is engine:case[:steps[:fps[:frames]]]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const runs = (arg('--runs') ?? 'v1:belt:4,v1:lift').split(',').map(r => {
  const [engine, kind, steps = '4', fps = '60', frames = '30'] = r.split(':');
  return { engine, kind, opts: { steps: +steps, fps: +fps, frames: +frames } };
});
const t0 = Date.now();
const vite = await startVite({ harness: true, warmupEntries: ['/tools/harness/industry-belt.js'] });
let browser, failures = 0;
const results = [];
try {
  browser = await launchBrowser();
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/industry-belt.html', { errors });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const { engine, kind, opts } of runs) {
    const t = Date.now();
    const r = await page.evaluate(([e, k, o]) => window.__harness.run(k, e, o), [engine, kind, opts]);
    results.push(r);
    console.log(JSON.stringify({ ...r, track: r.track?.filter((_, i) => i % 2 === 0) }), `(${((Date.now() - t) / 1000).toFixed(1)} s)`);
    if (r.errors?.length) failures++;
  }
  if (errors.length) { console.log('page errors:', errors.slice(0, 5).join(' | ')); failures++; }
} finally {
  await browser?.close();
  await vite.close();
  console.log(`occupancy ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
process.exitCode = failures ? 1 : 0;
