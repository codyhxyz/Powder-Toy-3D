// Smoke test of the app on WebGPU (docs/webgpu.md I1): it boots, draws each
// box scene, and the subsystems that aren't ported yet are cleanly greyed out
// rather than crashing. Pages run in a 400×250 viewport with ?view=plain (the
// cheapest view to build: realistic and the data views are --views'), and a
// shot of every scene is saved for review.
//
//   node tools/smoke.mjs [--stage boxes,meshes,worlds,arenas,views,pov,warm] [--views heat,realistic] [--out dir]
//
// Stages (default: boxes,worlds, one to two minutes here; each well under 3 minutes; meshes
// goes in a run of its own, node tools/smoke.mjs --stage meshes, about 2.5 minutes with the boot):
//   boxes   one boot at 64³; each box scene (Empty, the lab, the volcano,
//           the Islet) loaded and drawn with test.renderOnce: no GPU error,
//           and the scene drawn. The canvas is opaque (F7): the sky, the floor
//           grid and the box's edges alone vary plenty, so frames are
//           compared, counting the pixels that differ by more than DIFF
//           levels: Empty's against the same frame drawn without the volume
//           (renderOnce({ volume: false }): the volume draws the box's floor),
//           every other scene's against Empty's, each at least MIN_CHANGED of
//           the canvas, and the volume drawn (__app.view.volumeDrawn). The
//           negative control: Empty drawn again differs from its first frame
//           by less than that
//   meshes  three's meshes in the booted app (U13), each compiled before it
//           shows: a stickman lit by the volume's light, an impact's
//           particles and a tracer, a construction's ghost and the held gun
//           in its own pass, composited by post (a hand under the camera, as
//           first person's wiring puts it). The shot differs from the empty
//           box's by MIN_CHANGED at least, and three built no pipeline
//           synchronously at a first draw
//   worlds  every World map: with the world's wiring ready (src/wire/world.js,
//           U10) each boots at ?win=64, simulates a 64-wide window and draws;
//           until then a World map falls back to a box with a toast (a boot
//           from ?map=), and the menu's openMap refuses it, and nothing
//           throws. The giant volcano's window is 384 tall: only check-wgsl
//           (a) covers it
//   arenas  every box map on a grid of its own (maps.js: Dam Valley, an
//           arena on 256×96×128), booted from its ?map= link: its grid, its
//           arena layout, the scene drawn, no GPU error. About a minute here
//           (its own grid's pipelines), so not in the default run
//   views   the booted lab in each view of --views (default: every view),
//           each one's pipeline built on first use as the app builds it, and
//           drawn: the volume drew, and changed MIN_CHANGED of the canvas
//   pov     first person (src/wire/pov.js, U11): in the empty box at 64³
//           the body drops in and stands, walks forward on W, and fires the
//           pistol at the floor: its round's trace lands (a probe) and
//           strikes (an edit), all with no page or GPU error. The test runs
//           the body's frames itself (the crosshair's pick, pov.update and
//           the frame's steps), so it holds on a slow GPU. A minute or two here, so not in the
//           default run
//   warm    the start menu's warm-up (src/preload.js, B5): the page opens on
//           the menu (the Lab last played, in the plain view), the warm-up
//           builds the Lab's grid's pipelines, then Start boots it: the game
//           finds every one of them built, so the only pipelines Start makes
//           are the test mode's own (WARM_TEST_ONLY)
//
// three.js's warnings are errors here: every mesh material is a node
// material (U13), so ALLOW is empty. Runs its own Vite
// (tools/vite-server.mjs) and launches through tools/browser.mjs.
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const STAGES = arg('stage', 'boxes,worlds').split(',');
const OUT = arg('out', join(ROOT, '.tmp-smoke'));   // (ignored by git: .tmp-*)
const VIEWPORT = { width: 400, height: 250 };
const BOXES = ['empty', 'lab', 'volcano', 'island'];   // (Empty first: the others are measured against it)
const WORLD_MAPS = ['island', 'volcanoWorld', 'labWorld', 'descent'];
const BOX_DIMS = '128,128,128';   // the menu's box maps' grid; a box map on another is an arena (app.js ARENA_GRID)
// A scene drawn: the share of the canvas's pixels that differ by more than
// DIFF levels (0-255) in some channel from a reference frame (the same frame
// without the volume, or the empty box's). At 64³ in this viewport the empty
// box's floor is about a sixth of the canvas.
const DIFF = 12;
const MIN_CHANGED = 0.02;
// the pipelines Start makes in test mode that a player's session doesn't (sim.js: the tools' read-backs)
const WARM_TEST_ONLY = new Set(['toAtlas', 'copy']);
// what the page may log that would otherwise be an error: nothing since U13
// (three's 'Material "ShaderMaterial" is not compatible' warnings were here until
// every mesh material was a node material)
const ALLOW = [];
// what the page may log without it being an error of ours: the relay the UI asks for quota (not running here)
const IGNORE = [/Failed to load resource: net::ERR_CONNECTION_REFUSED/];

mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

// A page's errors: page errors, GPU and console errors (less the allowed and ignored ones).
function watch(page) {
  const errors = [], allowed = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.stack || e).slice(0, 400)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (ALLOW.some((r) => r.test(t))) { allowed.push(t); return; }
    if (IGNORE.some((r) => r.test(t))) return;
    // (Chrome reports a WebGPU error as a warning; its info lines, such as "WebGPU is experimental on this platform", aren't)
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed/i.test(t))) errors.push(`${m.type()}: ${t.slice(0, 400)}`);
  });
  return { errors, allowed };
}

// The app at `query`, parked (manual mode) and with every pipeline its settings need built.
async function boot(browser, vite, query) {
  const page = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
  const w = watch(page);
  await page.goto(vite.url(`/${query}`));
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  if (!failed) await page.evaluate(() => { __app.post.settings.taa = false; return __app.test.ready(); });
  return { page, ...w, failed };
}

// Frames of the current scene: one to start (the first after a load runs the
// derived passes over every brick), one without the volume, then the scene's
// own, as presented (and shot). Whether the volume drew; the share of pixels
// that the volume changed (`added`: against the frame without it) and that
// differ from the empty box's frame (`content`, once `baseline` has kept one).
async function draw(page, name, { baseline = false } = {}) {
  const s = await page.evaluate(async ({ diff, baseline }) => {
    const share = (a, b) => {
      let n = 0;
      const x = a.data, y = b.data;
      for (let i = 0; i < x.length; i += 4) {
        if (Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])) > diff) n++;
      }
      return n / (a.width * a.height);
    };
    await __app.test.renderOnce();
    const ref = await __app.test.renderOnce({ capture: true, volume: false });
    const shot = await __app.test.renderOnce({ capture: true });
    const out = { drawn: __app.view.volumeDrawn, added: share(shot, ref), content: window.__smokeEmpty ? share(shot, window.__smokeEmpty) : null, size: [shot.width, shot.height] };
    if (baseline) window.__smokeEmpty = shot;
    return out;
  }, { diff: DIFF, baseline });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  return s;
}
const pct = (x) => `${(100 * x).toFixed(1)}%`;
// the volume drew, and `what` (added or content) changed at least MIN_CHANGED of the canvas
const drewScene = (s, what = 'added') => s.drawn && s[what] >= MIN_CHANGED;
const drewText = (s) => `volume ${s.drawn ? 'drawn' : 'NOT drawn'}, ${pct(s.added)} of the canvas changed by it`
  + `${s.content == null ? '' : `, ${pct(s.content)} differing from the empty box`} (floor ${pct(MIN_CHANGED)})`;

// First person: drop in, stand, walk, use a tool (U11). Manual mode: the
// test drives the body's frames itself (the crosshair's pick, pov.update,
// then the frame's steps, then the GPU done with them), so the check holds
// however slow the frames are; the body's probes and the tools' edits and
// traces are the game's own.
const POV_STEPS = 4;          // sim steps a body frame (the app's default)
const POV_DT = 1 / 30;        // s a body frame
const LIVE_TICKS = 3;         // the app's own ticks the stage waits for, POV active...
const LIVE_WAIT_MS = 90000;   // ...at most this long (a tick of the live app on a loaded SwiftShader)
async function povStage(browser, vite, secs) {
  // (the empty box: its bricks sleep, so a frame's steps cost next to nothing and the frames are the body's)
  const { page, errors, allowed, failed } = await boot(browser, vite, '?size=64&preset=empty&view=plain');
  ok(!failed && await page.evaluate(() => __app.wires.pov), `pov: the empty box boots with first person wired${failed ? `: ${failed.slice(0, 300)}` : ''} (${secs()})`);
  if (failed) { await page.close(); return; }
  // (headless has no pointer lock, so the hotbar's tool stack, which opens over the crosshair on a switch, would take the click meant for the tool)
  await page.addStyleTag({ content: '.hb-stack { pointer-events: none !important; }' });
  await page.evaluate(async ({ steps, dt }) => {
    const { inventory } = await import('/src/pov/tools/inventory.js');
    inventory.give('GUN');
    __app.pov.test.assumeLocked = true;   // (headless has no pointer lock)
    // (a manual page starts paused; the frames below step the sim themselves, and the tools fly their rounds by its steps)
    __app.settings.paused = false;
    const { povEvents } = await import('/src/pov/events.js');
    window.__smokePov = { fires: 0, impacts: [] };
    povEvents.on('gun:fire', () => { window.__smokePov.fires++; });
    povEvents.on('impact', (e) => { if (e.source === 'gun') window.__smokePov.impacts.push({ id: e.id, point: e.point.toArray() }); });
    // n body frames, until done() says so; resolves to the frames run. Each
    // holds the look (yaw, pitch: headless Chromium can lock the pointer and
    // turn the view on a click) and picks the crosshair's cell first, as the
    // app's tick does (requestPick: the tools aim at it), then runs the body
    // and its steps.
    const ro = new __app.THREE.Vector3(), rd = new __app.THREE.Vector3(), hv = __app.hover;
    window.__povFrames = async (n, done = () => false, look = null) => {
      for (let i = 0; i < n; i++) {
        if (look) __app.pov.setLook(...look);
        if (__app.pov.aimRay(ro, rd)) {
          const hit = await __app.vol.pick(ro, rd);
          hv.valid = hit.valid;
          if (hit.valid) { hv.cell.fromArray(hit.cell); hv.face = hit.face; hv.id = hit.id; hv.T = hit.T; hv.P = hit.P; }
        }
        __app.pov.update(dt);
        __app.test.step(steps);
        await __app.gpu.fence();
        await new Promise((r) => setTimeout(r, 0));   // (the frame's probes land)
        if (done()) return i + 1;
      }
      return n;
    };
  }, { steps: POV_STEPS, dt: POV_DT });
  // the pointer over the canvas's middle now: once in the body, moving it turns the view
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  // drop in: the drop point, the figure and the POV kernels (pov/gpu.js prepare), then the body stands on its probes
  const t = Date.now();
  await page.evaluate(() => __app.pov.enter({ swoop: 0, hint: false }));
  const standFrames = await page.evaluate(() => window.__povFrames(60, () => __app.pov.mode === 'on' && __app.pov.player?.onGround));
  const stood = await page.evaluate(() => ({ mode: __app.pov.mode, onGround: !!__app.pov.player?.onGround, pos: __app.pov.player?.pos.toArray() }));
  ok(stood.mode === 'on' && stood.onGround,
    `pov: drops in and stands (${stood.mode}, feet ${stood.pos?.map((v) => v.toFixed(1)).join(', ')}) after ${standFrames} frames, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  // walk: W held
  await page.keyboard.down('w');
  const walkFrames = await page.evaluate((a) => window.__povFrames(90, () => { const q = __app.pov.player.pos; return Math.hypot(q.x - a[0], q.z - a[2]) > 2; }), stood.pos ?? [0, 0, 0]);
  await page.keyboard.up('w');
  const p1 = await page.evaluate(() => __app.pov.player.pos.toArray());
  const walked = Math.hypot(p1[0] - stood.pos[0], p1[2] - stood.pos[2]);
  ok(walked > 2, `pov: walks on W (${walked.toFixed(1)} cells in ${walkFrames} frames)`);
  // use a tool: the pistol at the floor ahead; its round traces (a probe) and strikes (an edit)
  const look = await page.evaluate(() => { __app.pov.toolbelt.select('GUN'); return [__app.pov.camera.look.yaw, -0.6]; });
  const held = await page.evaluate((l) => window.__povFrames(10, () => false, l).then(() => __app.pov.toolbelt.selectedKey), look);
  // the slot selector the switch brought up goes on the wall's clock (hotbar.js SHOW_MS): while it's up
  // under a locked pointer a click only closes it (HL2's weapon selection swallows the click)
  await page.waitForFunction(() => !document.pointerLockElement || !document.querySelector('.hotbar.open'), null, { timeout: 10000 });
  await page.mouse.down();
  await page.evaluate((l) => window.__povFrames(3, () => false, l), look);
  await page.mouse.up();
  const shotFrames = await page.evaluate((l) => window.__povFrames(60, () => window.__smokePov.impacts.length > 0, l), look);
  const used = await page.evaluate(() => {
    const shot = __app.pov.toolbelt.tool('GUN')?.lastShot;
    return { ...window.__smokePov, dir: shot?.dir.toArray().map((v) => +v.toFixed(2)), origin: shot?.origin.toArray().map((v) => +v.toFixed(1)),
      flying: __app.pov.toolbelt.ballistics.count, look: [__app.pov.camera.look.yaw, __app.pov.camera.look.pitch].map((v) => +v.toFixed(2)) };
  });
  ok(held === 'GUN' && used.fires > 0 && used.impacts.length > 0,
    `pov: the pistol fires (${used.fires}) and its round strikes (${used.impacts.map((i) => `id ${i.id} at ${i.point.map((v) => v.toFixed(1)).join(', ')}`).join('; ') || 'nothing'}) within ${shotFrames} frames`
    + (used.impacts.length ? '' : ` (shot from ${used.origin} along ${used.dir}, ${used.flying} flying, look ${used.look})`));
  // the app's own ticks, not the test's frames: the body runs from src/wire/pov.js's beforeStep at
  // the loop's pace, the crosshair's pick requested by the tick; a few of them, then parked again
  const live = await page.evaluate(async ({ ticks, waitMs }) => {
    const pov = __app.pov, update = pov.update;
    let calls = 0;
    pov.update = (dt) => { calls++; return update(dt); };
    __app.test.resume();
    const t0 = performance.now();
    while (calls < ticks && performance.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 100));
    __app.test.park();
    pov.update = update;
    return { calls, ms: Math.round(performance.now() - t0), mode: pov.mode };
  }, { ticks: LIVE_TICKS, waitMs: LIVE_WAIT_MS });
  ok(live.calls >= LIVE_TICKS && live.mode === 'on', `pov: the app's own ticks run the body (src/wire/pov.js beforeStep): ${live.calls} updates in ${live.ms} ms`);
  await page.evaluate(() => __app.test.renderOnce());
  await page.screenshot({ path: join(OUT, 'pov.png') });
  ok(!errors.length, `pov: no page or GPU errors (${secs()})${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  if (allowed.length) console.log(`(${allowed.length} allowed warnings)`);
  await page.close();
}

// The start menu's warm-up, then Start: what Start builds that the menu didn't.
async function warmStage(browser, vite, secs) {
  const { VIEWS } = await import('../src/views.js');
  const plain = VIEWS.find((v) => v.key === 'plain').id;
  const page = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
  const w = watch(page);
  // the Lab last played, in the plain view (app.js STORE; rev: its defaults' changes all applied)
  await page.addInitScript((v) => {
    try { localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ size: '128', preset: 'lab', view: v, rev: 2 })); } catch { /* storage unavailable */ }
  }, plain);
  await page.goto(vite.url('/'));
  // (the warm-up starts once the menu is idle; waitForFunction can't await the module import)
  for (let t = Date.now(); !await page.evaluate(async () => !!(await import('/src/launch.js')).launch.warm);) {
    if (Date.now() - t > 60000) throw new Error('warm: no warm-up 60 s after the menu opened');
    await page.waitForTimeout(250);
  }
  const warm = await page.evaluate(async () => {
    const { launch } = await import('/src/launch.js');
    await launch.warm.settled();
    const gpu = await launch.gpu, cache = gpu.pipelines, pipeline = cache.pipeline.bind(cache);
    // every pipeline asked for from here on that the cache doesn't hold
    window.__startBuilt = [];
    cache.pipeline = (kind, name, ...rest) => {
      const n = cache.pipelines.size, p = pipeline(kind, name, ...rest);
      if (cache.pipelines.size > n) window.__startBuilt.push(name);
      return p;
    };
    return { grids: launch.warm.grids, built: launch.warm.built, pending: launch.warm.pending, picked: document.querySelector('.mm-card[aria-selected="true"]')?.dataset.map };
  });
  ok(warm.pending === 0 && warm.built > 0 && warm.picked === 'lab',
    `the menu warmed ${warm.picked}'s grid (${warm.grids.join(', ')}): ${warm.built} pipelines built, ${warm.pending} pending (${secs()})`);
  await page.click('.mm-start');
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
  ok(!failed, `Start boots the Lab${failed ? `: ${failed.slice(0, 300)}` : ''}`);
  if (!failed) {
    const r = await page.evaluate(async () => {
      const a = window.__app;
      await a.test.ready();
      return { built: window.__startBuilt, dims: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz], view: a.settings.view, preset: a.settings.preset };
    });
    const extra = r.built.filter((n) => !WARM_TEST_ONLY.has(n));
    ok(r.preset === 'lab' && r.view === plain && !extra.length,
      `Start built ${r.built.length} pipelines (${r.built.join(', ') || 'none'}): ${extra.length ? `${extra.join(', ')} not warm` : 'only the test mode\'s own'} (${r.dims.join('×')} ${r.preset}, ${secs()})`);
  }
  ok(!w.errors.length, `warm: no page or GPU errors${w.errors.length ? `:\n  ${w.errors.join('\n  ')}` : ''}`);
  await page.close();
}

const vite = await startVite();
const browser = await launchBrowser();
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
try {
  if (STAGES.includes('boxes') || STAGES.includes('meshes') || STAGES.includes('views') || STAGES.includes('worlds')) {
    const { page, errors, allowed, failed } = await boot(browser, vite, '?size=64&preset=lab&view=plain');
    ok(!failed, `boot ?size=64&preset=lab&view=plain (${secs()})${failed ? `: ${failed.slice(0, 300)}` : ''}`);
    if (!failed) {
      const info = await gpuInfo(page);
      console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
      if (STAGES.includes('boxes')) {
        for (const preset of BOXES) {
          const loaded = await page.evaluate((p) => { __app.loadPreset(p, false); return __app.settings.preset; }, preset);
          const s = await draw(page, `box-${preset}`, { baseline: preset === 'empty' });
          // (the Islet is the world's generator on a box: until U10 the lab stands in, with a toast)
          const wired = await page.evaluate(() => __app.wires.world);
          const expect = preset === 'island' && !wired ? 'lab' : preset;
          ok(loaded === expect, `${preset}: loads${loaded !== preset ? ` (as ${loaded}: its port isn't in yet)` : ''}`);
          ok(drewScene(s, preset === 'empty' ? 'added' : 'content'), `${preset}: canvas ${s.size.join('×')}, ${drewText(s)} (${secs()})`);
        }
        // the negative control: the empty box again, against its first frame
        await page.evaluate(() => __app.loadPreset('empty', false));
        const s = await draw(page, 'box-empty-again');
        ok(s.drawn && s.content < MIN_CHANGED, `empty again: ${drewText(s)}: below the floor, as a scene with nothing in it must be (${secs()})`);
        await page.evaluate(() => { delete window.__smokeEmpty; });
      }
      if (STAGES.includes('meshes')) {
        // the empty box seen from close by (the god view's controls), without the meshes: the reference
        await page.evaluate(() => {
          const a = __app, T = a.THREE, look = new T.Vector3(31, 3, 31).multiplyScalar(a.scale).add(a.volume.position);
          a.loadPreset('empty', false);
          a.controls.target.copy(look);
          a.camera.position.copy(look).add(new T.Vector3(4.5, 3.5, 6));
          a.camera.lookAt(look);
          a.controls.update();
        });
        const ui = await page.addStyleTag({ content: 'body *{visibility:hidden !important} #app, #app canvas{visibility:visible !important}' });
        await draw(page, 'meshes-none', { baseline: true });
        const r = await page.evaluate(async () => {
          const a = __app, T = a.THREE, s = a.scale;
          // three's synchronous pipeline builds from here on, through the shot (ours are all asynchronous)
          const create = a.gpu.device.createRenderPipeline;
          const count = window.__smokeSync = { n: 0, labels: [], create };
          a.gpu.device.createRenderPipeline = (d) => { count.n++; count.labels.push(d.label); return create.call(a.gpu.device, d); };
          // (pipelines build in the background: waited out without frames, which only slow them here)
          const until = async (cond, what) => {
            for (const t = performance.now(); !cond();) {
              if (performance.now() - t > 60000) throw new Error(`smoke meshes: no ${what} after 60 s`);
              await new Promise((res) => setTimeout(res, 100));
            }
          };
          const at = (x, y, z) => new T.Vector3(x, y, z).multiplyScalar(s).add(a.volume.position);
          const [{ createFigure }, { createVfx }, { povEvents }, { viewmodelRig }, { attachModel }, { bake, runGenerator }, { BUILTINS }] = await Promise.all([
            import('/src/pov/figure.js'), import('/src/pov/vfx.js'), import('/src/pov/events.js'), import('/src/pov/viewmodel.js'),
            import('/src/pov/models.js'), import('/src/constructions/runtime.js'), import('/src/constructions/builtins.js'),
          ]);
          // a stickman on the floor
          const fig = createFigure();
          fig.update(1 / 60, {
            feet: at(26, 1, 30), scale: s, yaw: 0.6, worldToGrid: new T.Matrix4().copy(a.volume.matrixWorld).invert(),
            speedH: 0, velY: 0, onGround: true, inLiquid: false, dead: false, heat: 0, crouch: 0, look: { pitch: 0, spine: 0 },
          });
          fig.setVisible(true);
          await fig.compile();
          a.scene.add(fig.root);
          // an impact on stone and a tracer (the effects' pools join the scene once compiled)
          const vfx = createVfx({ scene: a.scene, camera: a.camera, getVolume: () => a.volume, getScale: () => s, isActive: () => true });
          await until(() => vfx.batch.parent === a.scene, 'effects');
          const V = (x, y, z) => new T.Vector3(x, y, z);
          povEvents.emit('impact', { point: V(38, 1, 34), id: 3, source: 'gun', normal: V(0, 1, 0), broke: true });
          povEvents.emit('round:move', { kind: 'round', from: V(6, 12, 6), to: V(38, 1, 34) });
          vfx.update(1 / 60);
          // a house's ghost where the pointer would put it
          const house = bake(runGenerator(BUILTINS.HOUSE, { size: 2, seed: 7 }), 0);
          a.builds.baked = house;
          a.builds._setGhost(house);
          await until(() => a.builds.ghostReady === true, 'ghost');
          a.builds._placeGhost({ cell: V(36, 0, 22), face: 2 });
          // the held gun: a hand under the camera, drawn by the viewmodel's pass (its meshes compile first)
          const addedCamera = !a.camera.parent;
          if (addedCamera) a.scene.add(a.camera);
          const vm = new T.Group();
          vm.name = 'pov-viewmodel';
          a.camera.add(vm);
          const rig = viewmodelRig({ viewmodel: vm, getScale: () => s });
          const hand = rig.hand([0.7, -0.8, -2.2]);
          attachModel(hand, 'gun');
          hand.visible = true;
          rig.update({ dt: 1 / 60, dir: V(0, 0, -1), player: {} });
          await a.test.renderOnce();   // (its pass sees the gun, and starts compiling it for its targets)
          await until(() => { let n = 0; vm.traverse((o) => { if (o.isMesh && o.layers.mask !== 1 << 5) n++; }); return n === 0; }, 'held gun');
          window.__smokeMeshes = { fig, vfx, vm, rig, addedCamera };
          return { effects: Object.values(vfx.counts()).reduce((x, y) => x + y, 0), ghost: a.builds.group.visible };
        });
        const s = await draw(page, 'meshes');
        await ui.evaluate((el) => el.remove());
        // (then out of the scene again, the device's call as it was)
        const sync = await page.evaluate(() => {
          const m = window.__smokeMeshes, a = __app, c = window.__smokeSync;
          a.scene.remove(m.fig.root); m.vfx.dispose(); m.rig.dispose(); m.vm.removeFromParent(); a.builds.group.visible = false;
          if (m.addedCamera) a.scene.remove(a.camera);
          a.gpu.device.createRenderPipeline = c.create;
          delete window.__smokeMeshes; delete window.__smokeSync;
          return c.labels;
        });
        ok(r.effects > 0 && r.ghost && s.content >= MIN_CHANGED,
          `meshes: a stickman, ${r.effects} particles, a house's ghost and the held gun drawn: ${pct(s.content)} of the canvas differing from the same view without them (floor ${pct(MIN_CHANGED)}) (${secs()})`);
        ok(!sync.length, `meshes: three built ${sync.length} pipeline(s) synchronously at a first draw${sync.length ? ` (${sync.join(', ')})` : ''}`);
        await page.evaluate(() => { delete window.__smokeEmpty; });
      }
      if (STAGES.includes('worlds')) {
        const wired = await page.evaluate(() => __app.wires.world);
        if (!wired) {
          // the menu's Start on a World map: refused, the box and its scene untouched
          const r = await page.evaluate((maps) => maps.map((m) => {
            const before = [__app.settings.size, __app.sim.id];
            let opened, threw = null;
            try { opened = __app.openMap(m); } catch (e) { threw = e.message; }
            return { m, opened, threw, same: __app.settings.size === before[0] && __app.sim.id === before[1] };
          }), WORLD_MAPS);
          for (const x of r) ok(x.opened === false && !x.threw && x.same, `${x.m}: World maps aren't wired yet: openMap refuses it, the box stays${x.threw ? ` (threw ${x.threw})` : ''}`);
        }
      }
      if (STAGES.includes('views')) {
        const keys = arg('views', null)?.split(',');
        const views = await page.evaluate(async (want) => {
          const { VIEWS } = await import('/src/views.js');
          return VIEWS.filter((v) => !want || want.includes(v.key)).map((v) => ({ id: v.id, key: v.key }));
        }, keys);
        await page.evaluate(() => __app.loadPreset('lab', false));
        for (const v of views) {
          const t = Date.now();
          await page.evaluate((id) => { __app.setView(id); return __app.test.ready(); }, v.id);
          const s = await draw(page, `view-${v.key}`);
          ok(drewScene(s), `view ${v.key}: built and drawn in ${((Date.now() - t) / 1000).toFixed(1)} s: ${drewText(s)}`);
        }
      }
      ok(!errors.length, `no page or GPU errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
      if (allowed.length) console.log(`(${allowed.length} allowed warnings)`);
    }
    await page.close();
  }

  if (STAGES.includes('worlds')) {
    const { page, errors, failed } = await boot(browser, vite, '?size=64&map=labWorld&view=plain&win=64');
    const wired = !failed && await page.evaluate(() => __app.wires.world);
    if (failed) ok(false, `boot ?map=labWorld: ${failed.slice(0, 300)}`);
    else if (!wired) {
      const r = await page.evaluate(() => ({ size: __app.settings.size, win: !!__app.win, dims: [__app.sim.g.nx, __app.sim.g.ny, __app.sim.g.nz] }));
      ok(r.size === '64' && !r.win, `?map=labWorld before the world's port: a 64³ box instead (${r.dims.join('×')}), no window (${secs()})`);
      await page.evaluate(() => __app.loadPreset('lab', false));
      const s = await draw(page, 'world-fallback');
      ok(drewScene(s), `the fallback box draws the lab: ${drewText(s)}`);
    } else {
      await page.close();
      for (const m of WORLD_MAPS) {
        const b = await boot(browser, vite, `?map=${m}&view=plain&win=64`);
        ok(!b.failed, `${m}: boots at ?win=64${b.failed ? `: ${b.failed.slice(0, 300)}` : ''}`);
        if (!b.failed) {
          const dims = await b.page.evaluate(() => [__app.sim.g.nx, __app.sim.g.ny, __app.sim.g.nz]);
          ok(dims[0] === 64 && dims[2] === 64 && await b.page.evaluate(() => !!__app.win), `${m}: a window 64 wide (${dims.join('×')})`);
          await b.page.waitForFunction(() => __app.win?.loaded, null, { polling: 250, timeout: 120000 });
          const s = await draw(b.page, `world-${m}`);
          ok(drewScene(s), `${m}: ${drewText(s)} (${secs()})`);
          ok(!b.errors.length, `${m}: no page or GPU errors${b.errors.length ? `:\n  ${b.errors.join('\n  ')}` : ''}`);
        }
        await b.page.close();
      }
    }
    if (!wired) ok(!errors.length, `no page or GPU errors in the fallback${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
    if (!page.isClosed()) await page.close();
  }

  if (STAGES.includes('arenas')) {
    const { MAPS, isWorld } = await import('../src/maps.js');
    for (const m of MAPS.filter((x) => !isWorld(x) && x.dims.join() !== BOX_DIMS)) {
      const b = await boot(browser, vite, `?map=${m.key}&view=plain`);
      ok(!b.failed, `${m.key}: boots from ?map=${m.key} (${secs()})${b.failed ? `: ${b.failed.slice(0, 300)}` : ''}`);
      if (!b.failed) {
        const r = await b.page.evaluate(() => ({ dims: [__app.sim.g.nx, __app.sim.g.ny, __app.sim.g.nz], preset: __app.settings.preset, arena: !!__app.arena }));
        ok(r.dims.join() === m.dims.join() && r.preset === m.preset && r.arena,
          `${m.key}: its own ${r.dims.join('×')} grid, the ${r.preset} scene, ${r.arena ? 'its arena layout set' : 'NO arena layout'}`);
        const s = await draw(b.page, `arena-${m.key}`);
        ok(drewScene(s), `${m.key}: ${drewText(s)} (${secs()})`);
        ok(!b.errors.length, `${m.key}: no page or GPU errors${b.errors.length ? `:\n  ${b.errors.join('\n  ')}` : ''}`);
      }
      await b.page.close();
    }
  }

  if (STAGES.includes('pov')) await povStage(browser, vite, secs);
  if (STAGES.includes('warm')) await warmStage(browser, vite, secs);
} finally {
  await browser.close();
  await vite.close();
}
console.log(failures ? `\nsmoke: ${failures} failed (shots in ${OUT})` : `\nsmoke: ok (${secs()}; shots in ${OUT})`);
process.exit(failures ? 1 : 0);
