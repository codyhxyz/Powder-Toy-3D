// Volume check (docs/webgpu.md U6's acceptance): the volume, the shadow map,
// picks and the scene's overlays on their harness page (tools/harness/volume.html),
// a 64³ grid at 400×250, no app. Stages (--only a,b):
//   views     every volume entry of shaders/render.js WGSL_CHECK draws the test
//             scene (the realistic view's variants at 160×100): its pipeline builds
//             (time printed), it covers part of the screen with a picture that
//             varies, no GPU errors. Entries on WGSL_MAC_ONLY are listed with
//             their reason, not drawn (a software adapter loses the device on them).
//             The realistic variants also draw the pool from a close camera (CLOSE:
//             from the home camera every close-up feature has faded out and they
//             draw the same frame), where each differs from the one before it in
//             more than CLOSE_MIN_SHARE of its pixels: the features it adds reach the
//             image. The first, drawn twice, doesn't differ from itself
//   inside    the camera inside the box looking down: the box's back faces cover
//             the screen (the cull winding, F2), every pixel, from an eye off the
//             brick planes; an eye on them is reported (core.js skipBrick, below)
//   shadow    the shadow map of a wall slab and a glass slab equals a JS march of
//             the same texel rays (opaque depth, the glass's span and tint, the
//             floor) within 2e-3 cells; its r32float copy equals its .x exactly;
//             through a water slab: its tint, its span within the fields' reach,
//             its optical depth; through smoke and steam puffs: their tints, some depth
//   pick      12 rays in one call (two dispatches of 8): wall, water, sand, lava,
//             glass and stone hits with their face codes, the floor through smoke,
//             a miss
//   lazy      a volume for a view without shadows: ready without the shadow kernel,
//             which the first recordShadow() starts (recording nothing) and which then
//             records; a pick whose recording throws rejects with the reason, the next
//             one works; the shadow kernel's far casters take the world's layout
//   overlays  the floor grid, the box's edges and the brush (a bubble, then a line
//             preview of boxes) each change the frame; the brush draws over the volume
//   meshes    Sync log S1: a three.js box standing in a pool, rendered first; with
//             the cut the water in front tints it (its red shows, at the glass's
//             depth), above the water it is untouched (pure red, the box's depth),
//             water beside it is bit-identical with and without the cut; without
//             the cut (control) the water hides it. The same from above the pool,
//             through the water's free surface, where the ray bends (the cut is
//             counted on along its path). A box outside the volume, in
//             front of sand (then water) the box wall cuts open, is left exactly
//             as three drew it
//   gate      the detail gate (gfx/detailGate.js) with the default settings: the base
//             variant far away; up close the base one until near's pipeline is ready
//             (onCompile), then near (onReady); nothing built for a view without
//             detail; the cold pipeline toast fires for a pipeline still building,
//             never for a ready one, and nothing holds a frame
// --detail off|base|balanced (default off) is the realistic variant the meshes stage draws.
// --shots DIR saves the frames as PNGs for review.
//
// usage: node tools/volume-check.mjs [--port 5606] [--only views,shadow] [--views plain,realistic.off] [--detail off] [--shots DIR] [--size 64]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { WGSL_CHECK, WGSL_MAC_ONLY, REALISTIC_LEVELS, shadowFrag } from '../src/shaders/render.js';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ONLY = opt('only')?.split(',') ?? ['views', 'inside', 'shadow', 'pick', 'lazy', 'overlays', 'meshes', 'gate'];
const SHOTS = opt('shots');
const SIZE = Number(opt('size', '64'));
const DETAIL = opt('detail', 'off');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
};
// the views stage's close camera [eye, at] (grid cells): over the test scene's
// pool, near enough for ripples, the meniscus and smooth-up-close to draw at 160×100
const CLOSE = [[44, 13, 30], [44, 9, 46]];
const CLOSE_MIN_SHARE = 0.01;
const shot = (name, b64) => { if (SHOTS && b64) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(b64, 'base64')); };
const f3 = (a) => a.map((x) => x.toFixed(3)).join(', ');

// Stages run in sessions of their own browser, each under ~3 minutes on
// SwiftShader (the realistic view's frames run on the CPU there, and each
// realistic module's first draw compiles for ~15 s).
const SESSIONS = [['views'], ['inside', 'shadow', 'pick', 'lazy', 'overlays'], ['meshes', 'gate']]
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
    if (!REALISTIC_LEVELS[DETAIL]) throw new Error(`--detail ${DETAIL}: one of ${Object.keys(REALISTIC_LEVELS).join(', ')}`);
    if (WGSL_MAC_ONLY[`volume.realistic.${DETAIL}`] && info.isFallbackAdapter) console.log(`     (--detail ${DETAIL} is on WGSL_MAC_ONLY: this adapter draws it without the features it can't draw)`);
    const detail = REALISTIC_LEVELS[DETAIL]();

    if (has('views')) {
      lap('views');
      const want = opt('views')?.split(',');
      const all = WGSL_CHECK().filter((e) => e.kind === 'render' && e.view).map((e) => ({ name: e.name.replace(/^volume\./, ''), check: e.name, view: e.view, detail: e.detail }))
        .filter((e) => !want || want.includes(e.name));
      for (const e of all.filter((x) => WGSL_MAC_ONLY[x.check])) console.log(`SKIP: ${e.name}: WGSL_MAC_ONLY: ${WGSL_MAC_ONLY[e.check]}`);
      const entries = all.filter((x) => !WGSL_MAC_ONLY[x.check]).map(({ name, view, detail: d }) => ({ name, view, detail: d }));
      const r = await run('views', { entries, shots: !!SHOTS, close: CLOSE });
      for (const [name, v] of Object.entries(r.out)) {
        shot(`view-${name}`, v.shot);
        check(`${name}: builds (${v.buildMs.toFixed(0)} ms) and draws the test scene (first frame ${v.drawMs.toFixed(0)} ms)`,
          v.covered > 0.05 && v.variance > 1e-6, `covered ${(v.covered * 100).toFixed(1)}%, mean ${v.mean.toFixed(4)}, variance ${v.variance.toExponential(2)}`);
        const c = v.close;
        if (!c) continue;
        shot(`view-${name}-close`, c.shot);
        const what = `covered ${(c.covered * 100).toFixed(1)}%, mean ${c.mean.toFixed(5)}`;
        if (!c.vs) check(`${name} from the close camera, drawn twice: the same frame (the comparisons see no noise)`, c.repeatPx === 0, `${what}; ${c.repeatPx} px differ`);
        else {
          check(`${name} from the close camera differs from ${c.vs} (the close-up detail it adds reaches the image)`, c.diffPx > CLOSE_MIN_SHARE * c.pixels,
            `${what}; ${c.diffPx} of ${c.pixels} px differ, mean difference ${c.meanDiff.toExponential(2)}`);
        }
      }
      check(`views: every volume entry not on WGSL_MAC_ONLY drew (${Object.keys(r.out).length} of ${entries.length})`, Object.keys(r.out).length === entries.length && entries.length > 0);
      check('views: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }

    if (has('inside')) {
      lap('inside');
      // off the brick planes (asserted), and on two of them (x = z = 32: reported)
      const OFF = [SIZE / 2 + 0.3, SIZE * 0.6, SIZE / 2 + 0.7], ON = [SIZE / 2, SIZE * 0.6, SIZE / 2];
      const r = await run('inside', { views: ['plain', 'heat'], eyes: [OFF, ON] });
      for (const o of r.out) {
        const what = `${o.view}, ${o.missing} of ${o.pixels} px empty${o.box ? ` in [${o.box}]` : ''}`;
        if (o.eye.every((c, i) => c === OFF[i])) {
          check(`inside the box looking down (${o.view}): its back faces cover the screen (cullMode front) and every pixel draws`, o.covered >= 0.999, what);
        } else {
          console.log(`KNOWN: the eye on the brick planes x = z = ${SIZE / 2}: ${what}. shaders/gfx/core.js skipBrick: the start nudge doesn't cross a plane at 32 in f32 for a small rd component, and floor(ro + rd·tx) at tx = 0 puts the other axis back on the far side, so the ray ping-pongs between two bricks at t = 0 until MAX_STEPS (U3/U16: clamp the non-exit axes of c into the brick)`);
        }
      }
      check('inside: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }

    if (has('shadow')) {
      lap('shadow');
      const r = await run('shadow');
      const hard = r.worst.find((w) => !w.key);
      check(`shadow map ${r.res}²: ${r.checked} texel rays against the JS march, ${r.bad} differ`, r.bad === 0 && r.checked > 1000,
        `${r.wallTexels} on the wall slab, ${r.glassTexels} through the glass, ${r.floorTexels} to the floor, ${r.skipped} grazing an edge left out${hard ? `; first: ${JSON.stringify(hard)}` : ''}`);
      check('shadow map: the r32float copy equals .x in every texel', r.xCopyBad === 0, `${r.xCopyBad} differ`);
      const soft = (key) => r.soft[key];
      const firstOf = (key) => r.worst.find((w) => w.key === key);
      check(`shadow map through the water slab: water's tint, its top and bottom, its optical depth (σ ${r.sigmaW.toFixed(4)}/cell), the floor: ${soft('WATER').checked} texels, ${soft('WATER').bad} differ`,
        soft('WATER').bad === 0 && soft('WATER').checked > 100, firstOf('WATER') ? JSON.stringify(firstOf('WATER')) : '');
      for (const key of ['SMOKE', 'STEAM']) {
        check(`shadow map through the ${key.toLowerCase()} puff: its tint, its span (to the media field's reach), some optical depth, the floor: ${soft(key).checked} texels, ${soft(key).bad} differ`,
          soft(key).bad === 0 && soft(key).checked > 20, firstOf(key) ? JSON.stringify(firstOf(key)) : '');
      }
      check('shadow: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }

    if (has('pick')) {
      lap('pick');
      const r = await run('pick');
      r.results.forEach((x, i) => check(`pick ray ${i}: ${x.want.valid ? `cell ${x.want.cell}, face ${x.want.face}, id ${x.want.id}` : 'a miss'}`, x.ok, JSON.stringify(x.got)));
      check(`pick: ${r.results.length} rays in ${r.dispatches} dispatches`, r.dispatches === Math.ceil(r.results.length / 8));
    }

    if (has('lazy')) {
      lap('lazy');
      const r = await run('lazy');
      check('shadows: false: the volume is ready without its shadow kernel', r.before === 'idle', r.before);
      check('…the first recordShadow() records nothing and starts it', r.first === false && r.started !== 'idle', `${r.first}, ${r.started}`);
      check('…once shadowReady() resolves, recordShadow() records', r.second === true);
      check('a pick whose recording throws rejects with the reason', r.failed === 'rejected: test: no frame', r.failed);
      check('…and the next pick works', r.after.valid && r.after.id === 1 && r.after.cell.join() === '10,42,10', JSON.stringify(r.after));
      check('lazy: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
      // (in Node) a world's own far layout reaches the shadow kernel's casters (sim.world)
      const g = { nx: SIZE, ny: SIZE, nz: SIZE };
      check('the shadow kernel\'s far casters take the world\'s layout (a box: WORLD_SIZE\'s)',
        /WORLD_Y: i32 = 384;/.test(shadowFrag(g, { world: [1024, 384, 1024] })) && /WORLD_Y: i32 = 128;/.test(shadowFrag(g)));
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
      if (r.shots) for (const [k, v] of Object.entries({ cut: r.shots.withCut, control: r.shots.control, 'surface-cut': r.shots.surfaceCut, 'surface-control': r.shots.surfaceControl })) shot(`meshes-${k}`, v);
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
      // from above, through the water's free surface
      const s = r.surface;
      console.log(`     from above: points ${JSON.stringify(s.points)}; box alone: above ${f3(s.alone.above.color)} @${s.alone.above.depth.toFixed(5)}, below @${s.alone.below.depth.toFixed(5)}`);
      console.log(`     cut: above ${f3(s.withCut.above.color)} @${s.withCut.above.depth.toFixed(5)}, below ${f3(s.withCut.below.color)} @${s.withCut.below.depth.toFixed(5)}; control: below ${f3(s.control.below.color)} @${s.control.below.depth.toFixed(5)}`);
      const inFrame = ([x, y]) => x > 0 && y > 0 && x < 159 && y < 99;   // (project() clamps to the frame's edge)
      check('the points lie inside the frames', [r.points.above, r.points.below, r.points.water, s.points.above, s.points.below].every(inFrame));
      check('from above: the box over the water, untouched (red, at its own depth)',
        s.withCut.above.color[0] > 0.9 && s.withCut.above.color[1] < 0.05 && s.withCut.above.color[2] < 0.05 && s.withCut.above.depth === s.alone.above.depth);
      check('from above: the submerged box shows through the water\'s surface (its red share well above the control\'s)',
        s.withCut.below.color[0] > s.control.below.color[0] + 0.05 && share(s.withCut.below.color) > share(s.control.below.color) + 0.1,
        `red ${s.withCut.below.color[0].toFixed(3)} vs ${s.control.below.color[0].toFixed(3)}, share ${share(s.withCut.below.color).toFixed(3)} vs ${share(s.control.below.color).toFixed(3)}`);
      check('…tinted by the water (not the bare box)', Math.abs(s.withCut.below.color[0] - 1) > 0.05 || s.withCut.below.color[1] > 0.02 || s.withCut.below.color[2] > 0.02);
      check('…at the water surface\'s depth, nearer than the box', s.withCut.below.depth < s.alone.below.depth, `${s.withCut.below.depth} vs the box's ${s.alone.below.depth}`);
      check('control (no cut): the pool hides the submerged box from above', share(s.control.below.color) < 0.6, `red share ${share(s.control.below.color).toFixed(3)}`);
      check('meshes: no GPU errors', r.failures.length === 0, r.failures.join(' | '));

      const fr = await run('meshFront', { detail, shots: !!SHOTS });
      shot('meshes-front-sand', fr.shot);
      for (const [scene, what] of [['frontSand', 'sand'], ['frontWater', 'water']]) {
        const { withCut: wf, alone: af } = fr[scene];
        console.log(`     ${what} at the wall, a mesh in front of it: mesh ${f3(wf.mesh.color)} @${wf.mesh.depth.toFixed(5)} (alone ${f3(af.mesh.color)} @${af.mesh.depth.toFixed(5)}), beside ${f3(wf.beside.color)} @${wf.beside.depth.toFixed(5)}`);
        check(`a mesh in front of the ${what} the box wall cuts open: exactly as three left it (colour and depth)`,
          wf.mesh.color.every((x, i) => x === af.mesh.color[i]) && wf.mesh.depth === af.mesh.depth && af.mesh.color[0] > 0.9);
        check(`…and beside it the cut-open ${what} draws`, wf.beside.color[3] > 0.05 && wf.beside.depth < 1 && af.beside.depth === 1,
          `alpha ${wf.beside.color[3].toFixed(3)}`);
      }
      check('meshes (in front of the box): no GPU errors', fr.failures.length === 0, fr.failures.join(' | '));
    }
    if (has('gate')) {
      lap('gate');
      const r = await run('gate');
      console.log(`     base ${r.base || '(none)'}; near ${r.near}`);
      check('detail gate: far from the box, the base variant', r.farShown === r.base);
      check('detail gate: up close, the base variant while near builds (pending, the toast asked for)', r.firstNear === r.base && r.pendingThen >= 1 && r.compileCalls >= 1,
        `shown ${r.firstNear}, pending ${r.pendingThen}, onCompile ${r.compileCalls}`);
      check('detail gate: near once its pipeline is ready (onReady), base again far away', r.secondNear === r.near && r.backFar === r.base && r.readyCalls >= 1, `onReady ${r.readyCalls}`);
      check('detail gate in another view (plain): no realistic variant asked for, not even after the prefetch delay', r.builtInPlain.length === 0, r.builtInPlain.join(' | '));
      check('detail gate: switching to the realistic view asks for its base variant at once', r.builtOnSwitch.length === 1 && r.builtOnSwitch[0] === `realistic|${r.base}`, r.builtOnSwitch.join(' | '));
      check('cold pipeline toast: once for the variant still building, none for a ready one; no frame held', r.warnedWhileBuilding === 1 && r.held === false, `warned ${r.warnedWhileBuilding}`);
      check('gate: no GPU errors', r.failures.length === 0, r.failures.join(' | '));
    }
    check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    lap('done');
  } finally {
    await browser.close();
  }
}
