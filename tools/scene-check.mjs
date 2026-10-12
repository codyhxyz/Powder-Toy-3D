// Headless check of World's scenes (docs/scaling.md D11, "Scenes"; docs/webgpu.md
// G1), on WebGPU through a small window (?win=64: the container's budget), in
// manual mode. Every world scene (world/scenes/index.js WORLD_SCENES: the
// maps' and Descent's levels), each loaded as the map menu does (the scene
// setting, then the world size):
//   1. switch: the world starts over with that scene and loads;
//   2. fill vs diff: right after a fresh load (a scene with trees, the island,
//      filled again without them) the leaving slab's kernel flags no brick of
//      the window: what the fill writes is what the diff expects (two
//      pipelines from one sceneCell);
//   3. far: the bricks the far field draws over the window's region from
//      sceneCell (farSceneCellsFrag, farSceneFrag) equal the window's own
//      summary of the same freshly generated cells (farWinFrag): r, g, b and
//      the liquid exactly, the glow within a step (the scene cells hold °C as
//      halves); the window's outermost brick columns left out (its summary
//      repeats its sides where their cubes reach past them). Only the chunks
//      over the window are drawn: the whole far build is minutes of
//      SwiftShader.
// Split the scenes over runs (--scenes) to keep each under 3 minutes here.
// usage: node tools/scene-check.mjs [--scenes labWorld,volcanoWorld] [--win 64] [--port N]
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const only = opt('scenes', null)?.split(',');
const WIN = +opt('win', 64);
const LOAD_TIMEOUT = 150000;   // ms a scene may take to compile and load

const { WORLD_SCENES } = await import('../src/world/scenes/index.js');
const keys = WORLD_SCENES.map((s) => s.key).filter((k) => !only || only.includes(k));
const vite = await startVite();
const b = await launchBrowser();
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 320, height: 200 } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 600)));
  await p.goto(vite.url(`/?size=world&scene=${keys[0]}&view=plain&win=${WIN}`));
  await p.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: LOAD_TIMEOUT });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 400)}`);
  for (const key of keys) {
    // 1. the scene, as the map menu loads it
    await p.evaluate((k) => {
      const a = window.__app;
      if (a.win?.scene.key !== k) { a.settings.scene = k; a.setSize('world'); }
    }, key);
    await p.waitForFunction((k) => window.__app.win?.scene.key === k && window.__app.win.loaded, key, { polling: 250, timeout: LOAD_TIMEOUT });
    await p.evaluate(() => window.__app.test.ready());
    ok(true, `${key}: loads (${secs()})`);

    // 2. fill vs diff, on a fresh load
    const diff = await p.evaluate(async () => {
      const a = window.__app, w = a.win, g = a.sim.g, o = a.sim.origin, O = [o.x, 0, o.z];
      a.worldLoad(O);
      if (w.scene.trees) w.gen.fill(w.P, O);   // (without the trees the load planted)
      let flagged = 0;
      const bricks = [4, g.ny / 4, g.nz / 4], n = bricks[0] * bricks[1] * bricks[2];
      for (let x0 = 0; x0 < g.nx; x0 += 16) {
        w.gen.diff(w.P, [x0, 0, 0], bricks, w.leave);
        flagged += Math.min(new Uint32Array(await a.gpu.readback.buffer(w.leave.head, 0, 4))[0], n);
      }
      return { flagged, bricks: g.nx / 4 * g.ny / 4 * g.nz / 4 };
    });
    ok(diff.flagged === 0, `${key}: fill vs diff: ${diff.flagged} of ${diff.bricks} bricks flagged right after a fill (${secs()})`);

    // 3. the far field over the window: from sceneCell against the window's summary
    const far = await p.evaluate(async () => {
      const a = window.__app, w = a.win, f = w.far, sim = a.sim, g = sim.g, o = sim.origin, gpu = a.gpu;
      const { FAR_SCENE } = await import('/src/shaders/far.js');
      const C = FAR_SCENE.CHUNK, by = f.L.bricks.n[1];
      const region = { origin: [o.x / 4, 0, o.z / 4], size: [g.nx / 4, by, g.nz / 4] };
      f.queue = [];
      f.summarizeWindow();   // (the window as step 2 left it: bare)
      const fromWindow = await gpu.readback.texture(f.grid, region);
      // the chunks over the window again, with nothing masked
      f.winMask.fill(0);
      f.maskDirty = true;
      f.g = null;
      f.groups();   // (fresh, empty tree maps: no trees)
      for (let z = Math.floor(o.z / 4 / C) * C; z < (o.z + g.nz) / 4; z += C)
        for (let x = Math.floor(o.x / 4 / C) * C; x < (o.x + g.nx) / 4; x += C) f.queue.push([x, z]);
      while (f.queue.length) { f.sceneChunks(1); await gpu.fence(); }
      const fromScene = await gpu.readback.texture(f.grid, region);
      const n = g.nx / 4, m = g.nz / 4;
      let rgb = 0, glow = 0, liquid = 0, bricks = 0, matter = 0;
      for (let t = 0; t < n * by * m; t++) {
        const bx = t % n, bz = Math.floor(t / (n * by));
        if (bx === 0 || bz === 0 || bx === n - 1 || bz === m - 1) continue;
        bricks++;
        const i = t * 4;
        if (fromWindow[i] & 255) matter++;
        if (fromScene[i] !== fromWindow[i] || fromScene[i + 1] !== fromWindow[i + 1] || fromScene[i + 2] !== fromWindow[i + 2]) rgb++;
        if ((fromScene[i + 3] >> 8) !== (fromWindow[i + 3] >> 8)) liquid++;
        if (Math.abs((fromScene[i + 3] & 255) - (fromWindow[i + 3] & 255)) > 1) glow++;
      }
      f.summarizeWindow();
      return { bricks, matter, rgbDiffer: rgb, liquidDiffer: liquid, glowDiffer: glow };
    });
    ok(far.matter > 0 && far.rgbDiffer === 0 && far.liquidDiffer === 0 && far.glowDiffer === 0,
      `${key}: far field from sceneCell against the window's summary: ${far.rgbDiffer} of ${far.bricks} bricks differ in shares or element, `
      + `${far.liquidDiffer} in the liquid, ${far.glowDiffer} in the glow (${far.matter} with matter; ${secs()})`);
    if (errs.length) { ok(false, `${key}: page or GPU errors:\n  ${errs.splice(0).join('\n  ')}`); }
  }
  await p.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await b.close();
  await vite.close();
}
console.log(failures ? `\nscene-check: ${failures} failed` : `\nscene-check: all ${keys.length} scenes ok (${secs()})`);
process.exit(failures ? 1 : 0);
