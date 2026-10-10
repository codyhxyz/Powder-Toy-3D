// Headless GPU check of luminous matter (gfx/materials.js emit, CRYSTAL): one
// browser, a 64³ box.
//   cave-*     a closed rock chamber with a small opening, crystal clusters on
//              its floor, back wall and ceiling and a patch of crystal dust;
//              the same chamber with rock and gravel in their place (dark), and
//              with Lava Lights off (the glow volume alone, unshadowed)
//   day-*      crystals and dust in the open box in daylight, and close up
//   dock       the Solids and Powders tiles
// Then the cost of the light, as the fastest of N runs each with a GPU sync:
// the view (post.render: shading, glow lights) and the derived passes with every
// brick rebuilt (sim.updateBricks: the glow volume's emission), crystal chamber
// against the rock one, interleaved A B A B so contention hits both.
// usage: node tools/crystal-check.mjs <outDir> [--port 5191] [--n 40] [--rounds 3]
//   --rounds 0: the pictures only
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const N = +opt('n', '40');
const ROUNDS = +opt('rounds', '3');
const SETTLE = 48;   // app frames after a load or camera move: fields' EMA, GI feedback, TAA
mkdirSync(out, { recursive: true });

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 2000)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, paused: true, glowLights: true }));
  // A frame loop that can be held and pumped, on a virtual clock that advances
  // a display interval per frame, so frame pacing never skips one
  // (tools/regress.mjs). Timings use the real clock (__now).
  const raf = window.requestAnimationFrame.bind(window);
  window.__now = performance.now.bind(performance);
  let held = null, vt = 0;
  window.requestAnimationFrame = (cb) => {
    if (held) { held.push(cb); return 0; }
    return raf(() => { vt += 1000 / 60; cb(vt); });
  };
  window.__hold = () => { held ??= []; };
  window.__parked = () => held?.length ?? 0;
  window.__pump = (n) => { for (let i = 0; i < n; i++) { const h = held; held = []; vt += 1000 / 60; h.forEach((cb) => cb(vt)); } };
  performance.now = () => vt;
});
await p.goto(`http://localhost:${port}/?preset=empty&size=64`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });
await p.waitForTimeout(2000);
const ev = (fn, arg) => p.evaluate(fn, arg);

await ev(async () => {
  const { E, ELEMENTS } = await import('/src/elements.js');
  const a = window.__app, sim = a.sim, r = a.renderer, gl = r.getContext();
  a.settings.paused = true;
  a.day.clock = 0;   // 10 am
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  window.__hold();
  const idx = (x, y, z) => sim.cellTexel(x, y, z) * 4;
  const t = {
    fresh() { [t.A, t.B] = sim.blankState(); },
    set(x, y, z, key) {
      const id = E[key], i = idx(x, y, z), e = ELEMENTS[id];
      t.A[i] = id; t.A[i + 1] = e.temp; t.A[i + 2] = e.life; t.A[i + 3] = t.A[i + 3] % 1;
      t.B[i] = t.B[i + 1] = t.B[i + 2] = t.B[i + 3] = 0;
    },
    box(x0, x1, y0, y1, z0, z1, key) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) t.set(x, y, z, key);
    },
    // prisms of crystal: [x, y, z, length] from a base cell along d
    cluster(cells, d, key) {
      for (const [x, y, z, len] of cells) for (let k = 0; k < len; k++) t.set(x + d[0] * k, y + d[1] * k, z + d[2] * k, key);
    },
    // glow: crystal and its dust, else rock and gravel in the same cells
    chamber(glow) {
      const C = glow ? 'CRYSTAL' : 'ROCK', D = glow ? 'CRYSTAL_DUST' : 'STONE';
      t.fresh();
      t.box(14, 49, 0, 30, 14, 49, 'ROCK');      // walls, floor and lid, 3 cells thick
      t.box(17, 46, 3, 27, 17, 46, 'EMPTY');
      t.box(30, 33, 12, 14, 47, 49, 'EMPTY');    // the opening, in the front wall
      t.cluster([[24, 3, 26, 5], [25, 3, 26, 3], [23, 3, 27, 2], [24, 3, 25, 3], [25, 3, 27, 4], [23, 3, 25, 2], [26, 3, 26, 2]], [0, 1, 0], C);
      t.cluster([[36, 16, 17, 3], [37, 17, 17, 2], [35, 15, 17, 2], [36, 18, 17, 1], [38, 16, 17, 1], [35, 17, 17, 1]], [0, 0, 1], C);
      t.cluster([[40, 27, 34, 4], [41, 27, 34, 2], [40, 27, 35, 3], [39, 27, 33, 2], [41, 27, 35, 1]], [0, -1, 0], C);
      t.box(41, 44, 3, 3, 23, 27, D);
      sim.frame = 0;
      sim.load(t.A, t.B);
    },
    open() {
      t.fresh();
      t.cluster([[30, 0, 32, 6], [31, 0, 32, 4], [29, 0, 33, 3], [30, 0, 31, 4], [31, 0, 33, 5], [29, 0, 31, 2], [32, 0, 32, 2], [30, 0, 33, 3]], [0, 1, 0], 'CRYSTAL');
      t.box(35, 38, 0, 0, 30, 34, 'CRYSTAL_DUST');
      t.box(22, 25, 0, 2, 30, 33, 'ROCK');   // a rock for scale and comparison
      sim.frame = 0;
      sim.load(t.A, t.B);
    },
    cam(pos, tgt) {
      a.volume.updateMatrixWorld();
      const V = a.camera.position.constructor;
      a.camera.position.copy(a.volume.localToWorld(new V(...pos)));
      a.controls.target.copy(a.volume.localToWorld(new V(...tgt)));
      a.controls.update();
      a.post.reset();
    },
    // GPU sync: the state's texel, then a cleared 1×1 target of our own (after a pass into the canvas)
    own: new sim.targets[0].constructor(1, 1, { depthBuffer: false }),
    px: new Uint8Array(4),
    sync() {
      sim.gpuSync();
      const prev = r.getRenderTarget();
      r.setRenderTarget(t.own);
      r.clear();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, t.px);
      r.setRenderTarget(prev);
    },
    fastest(run, n) {
      run(); t.sync();
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const t0 = window.__now();
        run(); t.sync();
        best = Math.min(best, window.__now() - t0);
      }
      return +best.toFixed(3);
    },
  };
  window.__t = t;
});
// the frame queued before the hold runs once more: wait for it to queue its successor
while (!(await ev(() => window.__parked()))) await p.waitForTimeout(20);

const shot = (name) => p.screenshot({ path: `${out}/${name}.png` });
const view = async (pos, tgt) => { await ev(([pos, tgt]) => window.__t.cam(pos, tgt), [pos, tgt]); await ev((n) => window.__pump(n), SETTLE); };
const CAVE_CAM = [[33, 15, 46], [29, 8, 24]];
const CAVE_CLOSE = [[31, 8, 34], [24, 5, 25]];

// ---- the cave
await ev(() => window.__t.chamber(true));
await view(...CAVE_CAM); await shot('cave-crystal');
await view(...CAVE_CLOSE); await shot('cave-crystal-close');
await ev(() => { window.__app.settings.glowLights = false; });
await view(...CAVE_CAM); await shot('cave-crystal-nolights');
await ev(() => { window.__app.settings.glowLights = true; });
await ev(() => window.__t.chamber(false));
await view(...CAVE_CAM); await shot('cave-rock');

// ---- daylight
await ev(() => window.__t.open());
await view([14, 16, 58], [31, 3, 32]); await shot('day-crystal');
await view([24, 7, 42], [31, 3, 32]); await shot('day-crystal-close');

// ---- the dock tiles
for (const abbr of ['CRYS', 'CDST']) {
  const el = p.getByText(abbr, { exact: true }).first();
  const bb = await el.boundingBox().catch(() => null);
  if (bb) await p.screenshot({ path: `${out}/dock-${abbr}.png`, clip: { x: bb.x - 60, y: bb.y - 40, width: bb.width + 120, height: bb.height + 80 } });
  else errs.push(`dock tile ${abbr} not found`);
}

// ---- cost
const timing = { view: { crystal: [], rock: [] }, derived: { crystal: [], rock: [] } };
for (let round = 0; round < ROUNDS; round++) {
  for (const glow of [true, false]) {
    await ev((glow) => window.__t.chamber(glow), glow);
    await view(...CAVE_CAM);
    const r = await ev((n) => {
      const a = window.__app, t = window.__t;
      const v = t.fastest(() => a.post.render(a.scene, a.camera), n);
      a.sim.incremental = false;   // every brick rebuilt
      const d = t.fastest(() => a.sim.updateBricks(), n);
      a.sim.incremental = true;
      return { v, d };
    }, N);
    timing.view[glow ? 'crystal' : 'rock'].push(r.v);
    timing.derived[glow ? 'crystal' : 'rock'].push(r.d);
  }
}
const min = (xs) => Math.min(...xs);
if (ROUNDS > 0) console.log(JSON.stringify({
  viewMs: { crystal: min(timing.view.crystal), rock: min(timing.view.rock) },
  derivedMs: { crystal: min(timing.derived.crystal), rock: min(timing.derived.rock) },
  rounds: timing,
  pixelRatio: await ev(() => window.__app.renderer.getPixelRatio()),
}, null, 1));
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
