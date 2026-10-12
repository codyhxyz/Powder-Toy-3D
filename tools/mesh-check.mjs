// The mesh layer (docs/webgpu.md F8, J1 U13) in the harness
// (tools/harness/mesh.*: a Simulation, its derived passes, the volume and
// post, and three.js's meshes over them on their own device, no app).
//
// Stages: spike (the lit material on a box), figures (stickmen in the sun and
// under a roof's shadow, the GI lifting the shaded one, the crasher; the GLTF
// body skinned and lit), viewmodel (the held tool's MSAA pass composited by
// post, its glow layer added), particles (the effects' billboard pools and
// the birds' motes), construction (the ghost; a house stamped with its
// footing), guard (a mesh added without prepare waits, then draws; and
// again when a light comes, which changes every program). Every
// one counts three's synchronous pipeline builds at first draws: none.
// Shots and each test's JSON go to --out (default .tmp-mesh).
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
const STAGES = { spike: ['spike'], figures: ['figures', 'gltf'], viewmodel: ['viewmodel'], particles: ['particles'], construction: ['construction'], guard: ['guard'] };
// what each test must show: a list of failures (empty: it passed)
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const need = (cond, what) => (cond ? [] : [what]);
const noSync = (r) => need(r.syncAtFirstDraw === 0, `${r.syncAtFirstDraw} pipeline(s) built at a first draw (${(r.syncLabels ?? []).join(', ')})`);
const CHECKS = {
  spike: (r) => noSync(r),
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
    ...need(r.changedByHands > 500, `the hands aren't composited (${r.changedByHands} px changed)`),
    ...need(r.hasGlow && r.flame[0] > r.flameNoGlow + 50, `the glow layer isn't added (${r.flame[0].toFixed(1)} vs ${r.flameNoGlow.toFixed(1)} without)`),
  ],
  particles: (r) => [
    ...noSync(r),
    ...need(sum(r.counts) > 0 && r.motes > 0, `nothing burst (${sum(r.counts)} effects, ${r.motes} motes)`),
    ...need(r.changed > 50, `the bursts aren't drawn (${r.changed} px changed)`),
    ...need(r.countsAfter3s === 0, `${r.countsAfter3s} particles outlived their lives`),
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
const stages = opt('stage')?.split(',') ?? Object.keys(STAGES);
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
