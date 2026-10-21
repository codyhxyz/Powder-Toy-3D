// The mesh layer (docs/webgpu.md F8, J1 U13) in the harness
// (tools/harness/mesh.*: a Simulation, its derived passes, the volume and
// post, and three.js's meshes over them on their own device, no app).
//
// Stages: spike (the lit material on a box), light (the meshes' light,
// gfx/meshLight.js, against the volume's own lighting.js functions on the GPU
// at random points), figures (stickmen in the sun and under a roof's shadow,
// the GI lifting the shaded one, the crasher; the GLTF body skinned and lit),
// viewmodel (the held tool's MSAA pass composited by post, its glow layer
// added), particles (a pool's uploads however updates and draws interleave;
// the effects' billboard pools, each read at its spawn point), construction
// (the ghost; a house stamped with its footing), guard (a
// mesh added without prepare waits, then draws; and again when a light comes,
// which changes every program). Every one counts three's synchronous pipeline
// builds at first draws: none. Shots and each test's JSON go to --out
// (default .tmp-mesh).
//
// A run stays under about 3 minutes on the container's SwiftShader (I1), so
// the stages go in five runs, each one boot of the page (about a minute) and
// its tests; the default is the first:
//   node tools/mesh-check.mjs                            # spike, particles
//   node tools/mesh-check.mjs --stage construction,guard
//   node tools/mesh-check.mjs --stage light
//   node tools/mesh-check.mjs --stage viewmodel
//   node tools/mesh-check.mjs --stage figures
//
// usage: node tools/mesh-check.mjs [--stage spike,figures,…] [--size N] [--port N] [--out dir] [--debug-sync]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const STAGES = {
  spike: ['spike'], light: ['light'], figures: ['figures', 'gltf'], viewmodel: ['viewmodel'], particles: ['uploads', 'particles'],
  construction: ['construction'], guard: ['guard'],
};
const DEFAULT_STAGES = ['spike', 'particles'];
// what each test must show: a list of failures (empty: it passed)
const LIGHT_TOL = 2e-3;
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const need = (cond, what) => (cond ? [] : [what]);
const noSync = (r) => need(r.syncAtFirstDraw === 0, `${r.syncAtFirstDraw} pipeline(s) built at a first draw (${(r.syncLabels ?? []).join(', ')})`);
const CHECKS = {
  spike: (r) => noSync(r),
  // the meshes' light against lighting.js's own functions at the same points:
  // within LIGHT_TOL (relative; absolute below 0.01), with the points reaching
  // every term, and the negative control (the GI read half a brick off) seen
  light: (r) => [
    ...noSync(r),
    ...['open', 'clouds'].flatMap((k) => [
      ...need(r[k].sunErr <= LIGHT_TOL, `${k}: the sun differs from lighting.js's by ${r[k].sunErr} (point ${r[k].sunErrAt})`),
      ...need(r[k].ambientErr <= LIGHT_TOL, `${k}: the GI and glow differ from lighting.js's by ${r[k].ambientErr} (point ${r[k].ambientErrAt})`),
    ]),
    ...need(r.open.lit > 0 && r.open.dark > 0 && r.open.part > 0 && r.open.tinted > 0 && r.open.glow > 0,
      `the points miss a term (lit ${r.open.lit}, dark ${r.open.dark}, part ${r.open.part}, tinted ${r.open.tinted}, glow ${r.open.glow})`),
    ...need(r.clouds.clouded > 0, `no cloud shaded the points up to cloudSea ${r.clouds.cloudSea}`),
    ...need(r.controlAmbientErr > 10 * LIGHT_TOL, `the negative control passed (${r.controlAmbientErr}): the comparison can't see a difference`),
  ],
  figures: (r) => [
    ...noSync(r),
    ...need(r.shadowState === 'ready', `shadow map ${r.shadowState}`),
    ...need(r.shade < 0.5 * r.sun, `the roof's shadow doesn't darken the figure under it (${r.shade.toFixed(1)} vs ${r.sun.toFixed(1)} in the sun)`),
    ...need(r.shadeGI > r.shade + 20, `the GI doesn't light the shaded figure (${r.shade.toFixed(1)} → ${r.shadeGI.toFixed(1)})`),
    ...need(r.shadeOpen > 2 * r.shade, `the roof gone, the figure stays dark (${r.shadeOpen.toFixed(1)})`),
    ...need(r.crasher > 20, `the crasher isn't drawn (${r.crasher.toFixed(1)})`),
  ],
  gltf: (r) => [
    ...noSync(r),
    ...need(r.showing === 'real', `showing ${r.showing}`),
    ...need(Math.abs(r.torso - r.behind) > 20 && r.changed > 100, `the body isn't drawn (torso ${r.torso.toFixed(1)}, behind ${r.behind.toFixed(1)}, ${r.changed} px changed)`),
  ],
  viewmodel: (r) => [
    ...noSync(r),
    ...need(r.parkedAtFirst > 0, 'the hands were drawn before they were compiled (none parked)'),
    // the frame without the glow layer: the viewmodel target's composite alone, at the gun
    ...need(r.handsInBox > 300 && r.handsOutside < r.handsInBox / 4,
      `the hands aren't composited (${r.handsInBox} px changed in the gun's box ${r.gunBox}, ${r.handsOutside} outside it)`),
    ...need(r.hasGlow && r.flame[0] > r.flameNoGlow + 50, `the glow layer isn't added (${r.flame[0].toFixed(1)} vs ${r.flameNoGlow.toFixed(1)} without)`),
  ],
  particles: (r) => [
    ...noSync(r),
    ...need(sum(r.counts) > 0, `nothing burst (${sum(r.counts)} effects)`),
    // each effect's own pixels against the frame just before the bursts: the
    // four pools (star, streak, normal and additive dots)
    ...['flash', 'sparks', 'mist', 'tracer', 'jet'].flatMap((k) => need(r.lift[k] > 30, `the ${k} isn't drawn at its spawn point (lift ${r.lift[k]})`)),
    ...need(r.countsAfter3s === 0, `${r.countsAfter3s} particles outlived their lives`),
  ],
  uploads: (r) => [
    ...noSync(r),
    ...['p0', 'p1', 'p2'].flatMap((k) => need(r.twoLift[k] > 60, `${k} isn't drawn after two updates with no draw between (lift ${r.twoLift[k]})`)),
    ...need(r.aliveTwo === 3, `${r.aliveTwo} alive, 3 spawned`),
    ...need(r.rangesBeforeDraw === 1, `${r.rangesBeforeDraw} upload ranges after 20 separate runs (want them merged into 1)`),
    ...['q1', 'q2'].flatMap((k) => need(r.manyLift[k] > 60, `${k} isn't drawn after 22 updates with no draw between (lift ${r.manyLift[k]})`)),
    ...['p0', 'p1', 'p2'].flatMap((k) => need(r.clearedLift[k] < 20, `${k} still drawn after the pool was cleared (lift ${r.clearedLift[k]})`)),
  ],
  construction: (r) => [
    ...noSync(r),
    ...need(r.shown && r.changedByGhost > 200, `the ghost isn't drawn (${r.changedByGhost} px changed)`),
    ...need(r.stampPlaced === r.stampWant, `stamped ${r.stampPlaced} of ${r.stampWant} cells`),
    ...need(r.footingCells === r.footingWant && r.footingWant > 0, `footing ${r.footingCells} of ${r.footingWant} cells`),
  ],
  guard: (r) => [
    ...noSync(r),
    ...need(r.parked, 'the unprepared mesh was not parked'),
    ...need(r.parkedForLight && r.syncAfterLight === 0, `a light coming: parked ${r.parkedForLight}, ${r.syncAfterLight} pipeline(s) built at the draw`),
    ...need(r.syncUnguarded > 0, 'the negative control: an unguarded light change built nothing at the draw (the guard proves nothing)'),
    ...need(r.shown.some((v, i) => Math.abs(v - r.hidden[i]) > 30), 'the mesh never showed'),
  ],
};
const size = Number(opt('size') ?? 32);
const stages = opt('stage')?.split(',') ?? DEFAULT_STAGES;
const OUT = opt('out') ?? join(ROOT, '.tmp-mesh');
mkdirSync(OUT, { recursive: true });

const vite = await startVite({ harness: true });
const browser = await launchBrowser();
let failures = 0;
const t00 = Date.now();
try {
  const errors = [];
  const page = await openHarness(browser, vite, `/tools/harness/mesh.html?size=${size}${argv.includes('--debug-sync') ? '&debugSync=1' : ''}`, { errors });
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
  for (const stage of stages) {
    if (!STAGES[stage]) { failures++; console.log(`FAIL no stage ${stage} (have: ${Object.keys(STAGES).join(', ')})`); continue; }
    console.log(`\n${stage}`);
    for (const name of STAGES[stage]) {
      const t0 = Date.now();
      try {
        const r = await page.evaluate((n) => window.__harness.run(n), name);
        // the test's shots (PNG, base64) to files
        for (const [k, b64] of Object.entries(r?.shots ?? {})) writeFileSync(join(OUT, `${name}-${k}.png`), Buffer.from(b64, 'base64'));
        if (r?.shots) r.shots = Object.keys(r.shots);
        writeFileSync(join(OUT, `${name}.json`), JSON.stringify(r, null, 1));
        console.log(JSON.stringify(r).slice(0, 2000));
        const bad = [...(CHECKS[name]?.(r) ?? []), ...(r?.failures?.length ? [`graphics failures: ${r.failures.join(' | ')}`] : [])];
        for (const b of bad) console.log(`FAIL ${name}: ${b}`);
        if (bad.length) failures++;
        else console.log(`ok   ${name}`);
      } catch (e) {
        failures++;
        console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
      }
      console.log(`     (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }
  if (argv.includes('--debug-sync')) writeFileSync(join(OUT, 'sync-diffs.json'), JSON.stringify(await page.evaluate(() => window.__harness.syncDiffs), null, 1));
  const pageFailures = await page.evaluate(() => window.__harness.failures);
  if (pageFailures.length) { failures++; console.log(`FAIL graphics failures: ${pageFailures.join(' | ')}`); }
  if (errors.length) { failures++; console.log(`FAIL page errors: ${errors.join(' | ').slice(0, 3000)}`); }
} finally {
  await browser.close();
  await vite.close();
}
console.log(`\n(${((Date.now() - t00) / 1000).toFixed(0)} s in all)`);
if (failures) { console.log(`${failures} failed`); process.exitCode = 1; }
