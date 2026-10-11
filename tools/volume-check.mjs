// Volume check (docs/webgpu.md U6's acceptance): the volume, the shadow map,
// picks and the scene's overlays on their harness page (tools/harness/volume.html),
// a 64³ grid at 400×250, no app. Stages (--only a,b):
//   views     every view module draws the test scene: its pipeline builds (time
//             printed), it covers part of the screen with a picture that varies,
//             no GPU errors. --detail off|balanced|full picks the realistic
//             view's variant (off by default: the cheapest to build here)
//   inside    the camera inside the box looking down: the box's back faces cover
//             the screen (the cull winding, F2)
//   shadow    the shadow map of a wall slab and a glass slab equals a JS march of
//             the same texel rays (opaque depth, the glass's span and tint, the
//             floor) within 2e-3 cells; its r32float copy equals its .x exactly
//   pick      12 rays in one call (two dispatches of 8): wall, water, sand, lava,
//             glass and stone hits with their face codes, the floor through smoke,
//             a miss
//   overlays  the floor grid, the box's edges and the brush (a bubble, then a line
//             preview of boxes) each change the frame; the brush draws over the volume
//   meshes    Sync log S1: a three.js box standing in a pool, rendered first; with
//             the cut the water in front tints it (its red shows, at the glass's
//             depth), above the water it is untouched (pure red, the box's depth),
//             water beside it is bit-identical with and without the cut; without
//             the cut (control) the water hides it
// --shots DIR saves the frames as PNGs for review.
//
// usage: node tools/volume-check.mjs [--port 5606] [--only views,shadow] [--views plain,heat] [--detail off] [--shots DIR] [--size 64]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ONLY = opt('only')?.split(',') ?? ['views', 'inside', 'shadow', 'pick', 'overlays', 'meshes'];
const SHOTS = opt('shots');
const SIZE = Number(opt('size', '64'));
const DETAIL = opt('detail', 'off');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
};
const shot = (name, b64) => { if (SHOTS && b64) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(b64, 'base64')); };
const f3 = (a) => a.map((x) => x.toFixed(3)).join(', ');

// Stages run in sessions of their own browser, each under ~3 minutes on
// SwiftShader (the realistic view's frames run on the CPU there).
const SESSIONS = [['views', 'inside', 'shadow', 'pick', 'overlays'], ['meshes']]
  .map((list) => list.filter((st) => ONLY.includes(st))).filter((list) => list.length);

const vite = await startVite({ harness: true, port: Number(opt('port', '5606')) });
try {
  for (const stages of SESSIONS) await session(stages);
} finally {
  await vite.close();
}
console.log(failures ? `\nvolume-check: ${failures} failed` : '\nvolume-check: all passed');
process.exit(failures ? 1 : 0);

async function session(stages) {
  const browser = await launchBrowser();
  const errors = [];
  const T0 = Date.now();
  const lap = (what) => console.log(`     (${what}: ${((Date.now() - T0) / 1000).toFixed(1)} s in)`);
  const has = (st) => stages.includes(st);
  try {
    const page = await openHarness(browser, vite, `/tools/harness/volume.html?size=${SIZE}`, { errors, timeout: 180000 });
    lap('page booted');
    const info = await gpuInfo(page);
    console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; grid ${SIZE}³; stages ${stages.join(', ')}`);
    const run = (name, ...args) => page.evaluate(([n, a]) => window.__harness.run(n, ...a), [name, args]);
    const detail = await page.evaluate((k) => import('/src/shaders/render.js').then((m) => m.REALISTIC_LEVELS[k]()), DETAIL);

    if (has('views')) {
      lap('views');
      const views = opt('views')?.split(',');
      const r = await run('views', { ...(views ? { views } : {}), detail, shots: !!SHOTS });
      for (const [view, v] of Object.entries(r.out)) {
        shot(`view-${view}`, v.shot);
        check(`${view}: builds (${v.buildMs.toFixed(0)} ms) and draws the test scene`,
          v.covered > 0.05 && v.variance > 1e-6, `covered ${(v.covered * 100).toFixed(1)}%, mean ${v.mean.toFixed(4)}, variance ${v.variance.toExponential(2)}`);
      }
      check('views: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }

    if (has('inside')) {
      lap('inside');
      const r = await run('inside');
      check('inside the box looking down: its back faces cover the screen (cullMode front)', r.covered > 0.95, `covered ${(r.covered * 100).toFixed(1)}%`);
    }

    if (has('shadow')) {
      lap('shadow');
      const r = await run('shadow');
      check(`shadow map ${r.res}²: ${r.checked} texel rays against the JS march, ${r.bad} differ`, r.bad === 0 && r.checked > 1000,
        `${r.wallTexels} on the wall slab, ${r.glassTexels} through the glass, ${r.floorTexels} to the floor, ${r.skipped} grazing an edge left out${r.worst.length ? `; first: ${JSON.stringify(r.worst[0])}` : ''}`);
      check('shadow map: the r32float copy equals .x in every texel', r.xCopyBad === 0, `${r.xCopyBad} differ`);
      check('shadow: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }

    if (has('pick')) {
      lap('pick');
      const r = await run('pick');
      r.results.forEach((x, i) => check(`pick ray ${i}: ${x.want.valid ? `cell ${x.want.cell}, face ${x.want.face}, id ${x.want.id}` : 'a miss'}`, x.ok, JSON.stringify(x.got)));
      check(`pick: ${r.results.length} rays in ${r.dispatches} dispatches`, r.dispatches === Math.ceil(r.results.length / 8));
    }

    if (has('overlays')) {
      lap('overlays');
      const r = await run('overlays', { shots: !!SHOTS });
      for (const [name, o] of Object.entries(r.out)) shot(`overlay-${name}`, o.shot);
      shot('overlay-line', r.lineShot);
      check('floor grid draws', r.out.grid.changed > 200, `${r.out.grid.changed} px`);
      check('box edges draw', r.out.edges.changed > 200, `${r.out.edges.changed} px`);
      check('brush draws, over the volume too (no depth test)', r.out.brush.changed > 200 && r.out.brush.overVolume > 50, `${r.out.brush.changed} px, ${r.out.brush.overVolume} over the volume`);
      check('a line preview (box brush at both ends and between) draws', r.lineChanged > 200, `${r.lineChanged} px`);
      check('overlays: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }

    if (has('meshes')) {
      lap('meshes');
      const r = await run('meshes', { detail, shots: !!SHOTS });
      if (r.shots) { shot('meshes-cut', r.shots.withCut); shot('meshes-control', r.shots.control); }
      const { withCut: w, control: c, alone: a } = r;
      console.log(`     points ${JSON.stringify(r.points)}; box alone: above ${f3(a.above.color)} @${a.above.depth.toFixed(5)}, below @${a.below.depth.toFixed(5)}`);
      console.log(`     cut: above ${f3(w.above.color)} @${w.above.depth.toFixed(5)}, below ${f3(w.below.color)} @${w.below.depth.toFixed(5)}, water ${f3(w.water.color)}`);
      console.log(`     control: above ${f3(c.above.color)}, below ${f3(c.below.color)} @${c.below.depth.toFixed(5)}, water ${f3(c.water.color)}`);
      check('the box above the water: untouched by the volume (red, at its own depth)',
        w.above.color[0] > 0.9 && w.above.color[1] < 0.05 && w.above.color[2] < 0.05 && w.above.depth === a.above.depth);
      const share = (col) => col[0] / Math.max(1e-6, col[0] + col[1] + col[2]);
      check('the submerged box shows through the water in front (its red share well above the control\'s)',
        w.below.color[0] > c.below.color[0] + 0.05 && share(w.below.color) > share(c.below.color) + 0.1,
        `red ${w.below.color[0].toFixed(3)} vs ${c.below.color[0].toFixed(3)}, share ${share(w.below.color).toFixed(3)} vs ${share(c.below.color).toFixed(3)}`);
      check('…tinted by it (not the bare box: the volume drew over it)', Math.abs(w.below.color[0] - 1) > 0.05 || w.below.color[1] > 0.02 || w.below.color[2] > 0.02);
      check('…at the nearer depth (the glass in front), never behind the box', w.below.depth <= a.below.depth && w.below.depth < a.below.depth,
        `${w.below.depth} vs the box's ${a.below.depth}`);
      check('water beside the box: identical with and without the cut', w.water.color.every((x, i) => x === c.water.color[i]) && w.water.depth === c.water.depth);
      check('control (no cut): the water hides the submerged box', share(c.below.color) < 0.6, `red share ${share(c.below.color).toFixed(3)}`);
      check('meshes: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }
    check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    lap('done');
  } finally {
    await browser.close();
  }
}
