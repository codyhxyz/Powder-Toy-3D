// Headless check of World's scenes (docs/scaling.md D11, "Scenes"), each
// picked from the Scene row (?size=world):
//   1. switch: the row lists the world scenes; clicking one starts the world
//      over with it, and its passes compile in the background (programs held
//      after each switch, console errors);
//   2. fill vs diff: right after a fresh load (sim paused; a scene with trees,
//      the island, filled again without them) the diff pass flags no brick of
//      the window: what sceneFillFrag writes is what sceneDiffFrag expects;
//   3. far build: it finishes (frames, wall time), and the bricks it draws
//      over the window's region from sceneCell equal the window's own summary
//      of the same freshly generated cells (farSceneFrag ≡ farWinFrag; glow
//      within a step: the scene cells hold °C in half floats; trees left out:
//      the window's are constructions, the far field's their brick-scale
//      shapes, tools/far-check.mjs);
//   4. stills: a god view of each scene once its far field is built, in one
//      montage.
// usage: node tools/scene-check.mjs [outDir] [--port 5411] [--scenes labWorld,giantVolcano]
//   (a vite server on that port: ./node_modules/.bin/vite --port 5411 --strictPort)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'scene-check';
const port = opt('port', '5411');
const only = opt('scenes', null)?.split(',');
mkdirSync(out, { recursive: true });

const LOAD_TIMEOUT = 120000;   // ms a scene may take to compile and load
const BUILD_FRAMES = 2000;     // frames the far build may take before the check gives up
const SETTLE_FRAMES = 90;      // frames for the derived passes, GI and TAA to settle on a still
const STILL = { width: 640, height: 400 };   // each still in the montage
const MONTAGE_COLS = 3;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: STILL });
const errs = [];
// console errors, and WebGL's own complaints (warnings): a draw GL refuses, e.g. an unbound sampler, draws nothing
p.on('console', (m) => {
  if ((m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) || /GL_INVALID/.test(m.text())) errs.push(m.text().slice(0, 600));
});
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
p.on('crash', () => errs.push('PAGE CRASHED'));
await p.goto(`http://localhost:${port}/?size=world`);
await p.waitForFunction(() => window.__app?.win?.loaded, null, { timeout: LOAD_TIMEOUT });
await p.evaluate(() => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;
  const H = window.__sc = {};
  H.frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // the far grid's texels over the window's brick columns, every slice (RGBA16F
  // holding whole numbers: shaders/far.js), as numbers
  H.farWindow = () => {
    const w = a.win, far = w.far, L = far.L, o = a.sim.origin, g = a.sim.g, r = a.renderer;
    const [bx0, bz0, n, m] = [o.x / 4, o.z / 4, g.nx / 4, g.nz / 4], buf = new Uint16Array(n * m * 4), all = [];
    for (let s = 0; s < L.bricks.n[1]; s++) {
      r.readRenderTargetPixels(far.grid, (s % L.bricks.cols) * L.bricks.n[0] + bx0, Math.floor(s / L.bricks.cols) * L.bricks.n[2] + bz0, n, m, buf);
      for (const h of buf) all.push(a.THREE.DataUtils.fromHalfFloat(h));
    }
    return all;
  };
});
// The world's Scene row: the seg row holding a world-only scene (the box's preset row shares the section).
const WORLD_ROW = `[...document.querySelectorAll('.seg.rows')].find((r) => r.querySelector('button[data-value="labWorld"]'))`;
const keys = await p.evaluate((row) => [...eval(row).querySelectorAll('button')].map((e) => e.dataset.value), WORLD_ROW);
const res = { scenes: {}, rowLists: keys };
const stills = [];

for (const key of keys.filter((k) => !only || only.includes(k))) {
  const t0 = Date.now();
  // 1. pick it from the Scene row
  await p.evaluate(([k, row]) => { window.__app.settings.paused = true; eval(row).querySelector(`button[data-value="${k}"]`).click(); }, [key, WORLD_ROW]);
  await p.waitForFunction((k) => window.__app.win?.scene.key === k && window.__app.win.loaded && window.__app.win.far.ready, key, { timeout: LOAD_TIMEOUT });
  const r = { loadMs: Date.now() - t0 };
  r.picked = await p.evaluate((k) => window.__app.settings.scene === k, key);

  // 2. fill vs diff, on a fresh load with the sim paused
  r.diff = await p.evaluate(async () => {
    const a = window.__app, w = a.win, g = a.sim.g, o = a.sim.origin;
    a.worldLoad([o.x, 0, o.z]);
    if (w.scene.trees) w.gen.fill(w.P, [o.x, 0, o.z]);   // (without the trees the load planted)
    let flagged = 0;
    for (let x0 = 0; x0 < g.nx; x0 += 16) {
      const bricks = [4, g.ny / 4, g.nz / 4], n = bricks[0] * bricks[1] * bricks[2];
      w.gen.diff(w.P, [x0, 0, 0], bricks, w.diffTarget);
      const f = new Uint8Array(w.diffTarget.width * w.diffTarget.height * 4);
      a.renderer.readRenderTargetPixels(w.diffTarget, 0, 0, w.diffTarget.width, w.diffTarget.height, f);
      for (let i = 0; i < n; i++) if (f[i * 4]) flagged++;
    }
    return { flagged, ok: flagged === 0 };
  });

  // 3. the far build: done, then the window's region redrawn from sceneCell and compared with its own summary
  r.far = await p.evaluate(async ([BUILD_FRAMES]) => {
    const a = window.__app, H = window.__sc, w = a.win, far = w.far;
    for (let i = 0; i < BUILD_FRAMES && far.queue.length; i++) await H.frames(1);
    if (far.queue.length) return { ok: false, left: far.queue.length };
    const built = { ...far.last };
    if (w.scene.trees) far.summarizeWindow();   // (the window filled again without its trees: step 2)
    const fromWindow = H.farWindow();
    const { makeFieldTarget } = await import('/src/sim.js');
    const { farSceneLayout, FAR_SCENE } = await import('/src/shaders/far.js');
    const S = farSceneLayout(far.L), C = FAR_SCENE.CHUNK, o = a.sim.origin, g = a.sim.g;
    // the chunks over the window's region again, with nothing masked
    far.winMask.fill(0);
    far.winMaskTex.needsUpdate = true;
    far.cells = makeFieldTarget(S.width, S.height, 1, a.THREE.HalfFloatType, a.THREE.NearestFilter);
    far.mats.farScene.uniforms.tCells.value = far.cells.texture;
    far.buildStart = performance.now();
    for (let z = Math.floor(o.z / 4 / C) * C; z < (o.z + g.nz) / 4; z += C)
      for (let x = Math.floor(o.x / 4 / C) * C; x < (o.x + g.nx) / 4; x += C) far.queue.push([x, z]);
    while (far.queue.length) await H.frames(1);
    const fromScene = H.farWindow();
    // (the window's outermost brick columns differ: its summary repeats its sides where their cubes reach past them)
    const n = g.nx / 4, m = g.nz / 4;
    let rgb = 0, glow = 0, bricks = 0;
    for (let i = 0; i < fromScene.length; i += 4) {
      const t = i / 4, bx = t % n, bz = Math.floor(t / n) % m;
      if (bx === 0 || bz === 0 || bx === n - 1 || bz === m - 1) continue;
      bricks++;
      if (fromScene[i] !== fromWindow[i] || fromScene[i + 1] !== fromWindow[i + 1] || fromScene[i + 2] !== fromWindow[i + 2]) rgb++;
      if (Math.abs(fromScene[i + 3] - fromWindow[i + 3]) > 1) glow++;
    }
    return { built, bricks, rgbDiffer: rgb, glowDiffer: glow, ok: rgb === 0 && glow === 0 };
  }, [BUILD_FRAMES]);

  // 4. a still once it has settled
  await p.evaluate(async ([n]) => { window.__app.post.reset(); await window.__sc.frames(n); }, [SETTLE_FRAMES]);
  stills.push({ key, png: (await p.screenshot()).toString('base64') });
  r.programs = await p.evaluate(() => window.__app.renderer.info.programs.length);
  r.errors = errs.splice(0);
  res.scenes[key] = r;
  console.log(key, JSON.stringify(r));
}

// the montage: the stills in a grid, labelled
const rows = Math.ceil(stills.length / MONTAGE_COLS);
await p.setViewportSize({ width: STILL.width * MONTAGE_COLS / 2, height: STILL.height * rows / 2 });
await p.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(${MONTAGE_COLS},1fr);background:#111">${
  stills.map((s) => `<div style="position:relative"><img style="width:100%;display:block" src="data:image/png;base64,${s.png}"><span style="position:absolute;left:6px;top:4px;color:#fff;font:12px sans-serif;text-shadow:0 0 3px #000">${s.key}</span></div>`).join('')}</body>`);
await p.screenshot({ path: `${out}/scenes.png` });
writeFileSync(`${out}/scene-check.json`, JSON.stringify(res, null, 1));
await b.close();
const bad = Object.entries(res.scenes).filter(([, r]) => r.errors.length || r.diff?.ok === false || r.far?.ok === false || !r.picked);
console.log(bad.length ? `FAIL: ${bad.map(([k]) => k).join(', ')}` : `all ${Object.keys(res.scenes).length} scenes OK`, `(${out}/scenes.png)`);
process.exit(bad.length ? 1 : 0);
