// Activity-map check (docs/webgpu.md D4, I1; docs/scaling.md D8): the build
// makes the inert map incrementally from the activity flags the state writers
// leave (shaders/activity.js inertList, inert); after every map this runs the
// reference kernel that computes it from the state alone (inertRefFrag, a full
// rebuild) on the same state, derives the quiet map from it, and counts the
// bricks where they differ. They must never differ (tools/harness/sim-activity.js).
//
// Each scene loads from a seeded Math.random (the seed also offsets sim.frame,
// so each seed's random streams differ), then steps; between stretches of
// steps it runs the state writers (every brush tool, an undo, a readState/load,
// an in-place edit), so their flags are checked too.
//   --harness  without the app: the sim harness page (tools/harness/sim-check.html),
//              scenes built on the CPU by presets.js buildPreset, 64³ by default,
//              --runs seeds a scene, one browser each: 100 steps (50 maps) a run
//              keeps each within ~3 minutes on SwiftShader with the unrolled move
//              (lab and volcano × 3 runs: the 300 maps of docs/webgpu.md D4)
//   (default)  in the app on a dev server at --port, ?size= and its presets
// usage: node tools/activity-check.mjs [--harness] [--scenes lab,volcano] [--size 64]
//          [--steps 100] [--runs 3] [--noskip] [--port N]
import { launchBrowser, newTestContext, ready, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const HARNESS = args.includes('--harness');
const scenes = opt('scenes', HARNESS ? 'lab,volcano' : 'lab,volcano,island').split(',');
const size = Number(opt('size', HARNESS ? '64' : '128'));
const STEPS = +opt('steps', HARNESS ? '100' : '600');   // steps per run, in stretches between the writers
const RUNS = +opt('runs', HARNESS ? '3' : '1');         // runs per scene, seeds SEED, SEED + 1, …
const STRETCHES = 6;                         // stretches of steps per scene
const SEED = 12345;                          // Math.random seed (mulberry32, as tools/regress.mjs)
const noskip = args.includes('--noskip');

const report = (scene, r) => {
  console.log(`${scene} ${size}³: ${r.builds} maps, inert share ${(r.inertShare * 100).toFixed(1)}%, quiet ${(r.quietShare * 100).toFixed(1)}%;`
    + ` bricks differing: inert ${r.inertDiff} (${r.permissive} flag-inert only, ${r.strict} reference-inert only), quiet ${r.quietDiff}`
    + (r.firstDiff ? `; first at frame ${r.firstDiff.frame}` : '') + (r.dbg ? `; ${r.dbg} out-of-grid accesses` : ''));
  return r.inertDiff || r.quietDiff || r.dbg;
};

let bad = 0;
const errors = [];
if (HARNESS) {
  const vite = await startVite({ harness: true });
  const runs = scenes.flatMap((scene) => Array.from({ length: RUNS }, (_, k) => [scene, SEED + k]));
  try {
    for (const [scene, seed] of runs) {
      const browser = await launchBrowser();
      try {
        const page = await openHarness(browser, vite, '/tools/harness/sim-check.html', { errors });
        if (scene === scenes[0] && seed === SEED) {
          const info = await gpuInfo(page);
          console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
        }
        const t0 = Date.now();
        const r = await page.evaluate(async ({ scene, size, steps, stretches, noskip, seed }) => {
          const h = window.__harness;
          const { activityCheck } = await import('/tools/harness/sim-activity.js');
          const sim = await h.make(size);
          try {
            // (the seed also moves the step count every random stream hashes: the
            // presets' dynamics don't read the cells' seeds, so runs would repeat)
            const load = (s) => { h.scene(s, scene, seed); s.frame += 1000 * (seed - 12345); };
            return await activityCheck(sim, { load, steps, stretches, noskip, E: h.E });
          } finally { sim.dispose(); }
        }, { scene, size, steps: STEPS, stretches: STRETCHES, noskip, seed });
        if (report(`${scene} (seed ${seed})`, r)) bad++;
        console.log(`     (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        const f = await page.evaluate(() => window.__harness.failures);
        if (f.length) { bad++; console.log(`graphics failures: ${f.join(' | ')}`); }
      } catch (e) {
        bad++;
        console.log(`${scene}: ${e.message.split('\n')[0]}`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await vite.close();
  }
} else {
  const port = opt('port', '5191');
  const browser = await launchBrowser();
  try {
    const ctx = await newTestContext(browser, { mode: 'manual', viewport: { width: 1280, height: 800 } });
    await ctx.routeWebSocket(/.*/, () => {});   // no multiplayer relay
    await ctx.addInitScript((seed) => {
      let s = seed;
      Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      window.__reseed = () => { s = seed; };
    }, SEED);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${port}/?size=${size}&preset=empty`);
    await ready(page);
    for (const scene of scenes) {
      const r = await page.evaluate(async ({ scene, steps, stretches, noskip }) => {
        const a = window.__app;
        a.settings.paused = true;
        const { activityCheck } = await import('/tools/harness/sim-activity.js');
        const { E } = await import('/src/elements.js');
        return activityCheck(a.sim, { load: () => { window.__reseed(); a.loadPreset(scene, false); a.sim.frame = 0; }, steps, stretches, noskip, E });
      }, { scene, steps: STEPS, stretches: STRETCHES, noskip });
      if (report(scene, r)) bad++;
    }
  } finally {
    await browser.close();
  }
}
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
process.exit(bad || errors.length ? 1 : 0);
