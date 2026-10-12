// Decoration layer check (src/deco.js, README "Decoration"; docs/webgpu.md
// Sync log S3, U17), in the harness (tools/harness/deco-check.*: the layer on
// a Simulation of its own device, no app). One browser per stage, each within
// ~3 minutes on SwiftShader:
//   rules       made on the first deco stroke and not before; the brush paints matter, never air;
//               paint falls with its sand; the colour follows the move cell for cell; painted ice
//               melts into painted water; the brush replacing or erasing matter wipes its paint,
//               heat doesn't, undo brings it back; every deco mode against a JS model of TPT's
//               arithmetic; a save's upload and read round trip; a load clears it; no dispatch added
//   store       the World's window: the leaving slab's painted bricks go to the store, the plane moves
//               with the cells, the bricks come back with the slab; a stale readback lands nowhere
//   invariants  with paint on and strokes between steps: sleeping = every brick dispatched (state,
//               flow, copies, maps and the plane), lists shuffled and blocks reversed, out of place,
//               and paint on = paint off for the state (docs/webgpu.md I2.1, I2.2, I2.5)
//   view        the plain and realistic views draw the tint; display off (Ctrl+B) draws exactly the
//               unpainted scene; the view follows the plane to whitewater's buffer
// Every sim but the view's runs the debug prelude: an out-of-grid access fails it (I2.8).
//
// The World's leave and enter are driven through the layer's API here; with
// the app on WebGPU (world/window.js, U10) they run on every window move.
//
// usage: node tools/deco-check.mjs [--stage rules,store,invariants,view] [--size 32] [--port N]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const ALL = ['rules', 'store', 'invariants', 'view'];
const stages = opt('stage')?.split(',') ?? ALL;
const size = opt('size') ? Number(opt('size')) : undefined;
const stageOpts = { ...(size && { size }) };

const vite = await startVite({ harness: true });
let failures = 0, printedGpu = false;
try {
  for (const stage of stages) {
    const browser = await launchBrowser();
    const errors = [];
    const t0 = Date.now();
    try {
      const page = await openHarness(browser, vite, '/tools/harness/deco-check.html', { errors });
      if (!printedGpu) {
        const info = await gpuInfo(page);
        console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
        printedGpu = true;
      }
      const r = await page.evaluate(([s, o]) => window.__harness.run(`stage:${s}`, o), [stage, stageOpts]);
      console.log(`\n${stage} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      for (const c of r.checks) {
        if (!c.ok) failures++;
        console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `\n     ${c.detail}`}`);
      }
      if (r.ms && Object.keys(r.ms).length) console.log(`     ms: ${JSON.stringify(r.ms, (k, v) => (typeof v === 'number' ? Math.round(v) : v))}`);
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
console.log(failures ? `\n${failures} failure(s)` : '\ndeco check OK');
process.exit(failures ? 1 : 0);
