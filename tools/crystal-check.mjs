// Headless GPU check of luminous matter (gfx/materials.js emit, CRYSTAL): one
// browser, a 64³ box.
//   cave-*     a closed rock chamber with a small opening, crystal clusters on
//              its floor, back wall and ceiling and a patch of crystal dust:
//              on arrival and once eyes have adjusted (-adapted), close up,
//              with Lava Lights off; the same chamber with a lava pool instead,
//              and with rock and gravel in the crystals' place (dark)
//   day-*      crystals and dust in the open box in daylight, and close up
//   night-*    the same at midnight, on arrival and adjusted
//   lab*       the lab preset's lava (tools/regress.mjs labLava), its home view
//              by day and at midnight
//   dock       the Solids and Powders tiles
// Then the cost, as the fastest of N runs each with a GPU sync: the view
// (post.render: shading, glow lights, exposure; and with the eye adaptation
// off) and a whole app frame with the
// derived passes rerun (fields, bricks, shadow map, GI), crystal chamber
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
    // kind 'crystal': clusters of crystal and a patch of its dust; 'rock': rock
    // and gravel in the same cells; 'lava': the rock one with a pool of lava
    chamber(kind) {
      const glow = kind === 'crystal', C = glow ? 'CRYSTAL' : 'ROCK', D = glow ? 'CRYSTAL_DUST' : 'STONE';
      t.fresh();
      t.box(14, 49, 0, 30, 14, 49, 'ROCK');      // walls, floor and lid, 3 cells thick
      t.box(17, 46, 3, 27, 17, 46, 'EMPTY');
      t.box(30, 33, 12, 14, 47, 49, 'EMPTY');    // the opening, in the front wall
      t.cluster([[24, 3, 26, 5], [25, 3, 26, 3], [23, 3, 27, 2], [24, 3, 25, 3], [25, 3, 27, 4], [23, 3, 25, 2], [26, 3, 26, 2]], [0, 1, 0], C);
      t.cluster([[36, 16, 17, 3], [37, 17, 17, 2], [35, 15, 17, 2], [36, 18, 17, 1], [38, 16, 17, 1], [35, 17, 17, 1]], [0, 0, 1], C);
      t.cluster([[40, 27, 34, 4], [41, 27, 34, 2], [40, 27, 35, 3], [39, 27, 33, 2], [41, 27, 35, 1]], [0, -1, 0], C);
      t.box(41, 44, 3, 3, 23, 27, D);
      if (kind === 'lava') t.box(28, 33, 3, 3, 27, 32, 'LAVA');
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

const adaptLog = {};
const shot = async (name) => {
  await p.screenshot({ path: `${out}/${name}.png` });
  adaptLog[name] = await ev(() => window.__app.post.adaptation);   // gain, target, view log2 luminance
};
// a frame at a time, yielding between them: the exposure's async readback
// (gfx/post.js adapting) has to land for the pacing to keep the view drawing
const pump = (n) => ev(async (n) => {
  for (let i = 0; i < n; i++) { window.__pump(1); await new Promise((r) => setTimeout(r, 4)); }
}, n);
const view = async (pos, tgt, frames = SETTLE) => { await ev(([pos, tgt]) => window.__t.cam(pos, tgt), [pos, tgt]); await pump(frames); };
const worldView = async (pos, tgt, frames = SETTLE) => {
  await ev(([pos, tgt]) => {
    const a = window.__app;
    a.camera.position.set(...pos);
    a.controls.target.set(...tgt);
    a.controls.update();
    a.post.reset();
  }, [pos, tgt]);
  await pump(frames);
};
const setHour = (h) => ev(async (h) => {
  const { phaseSteps } = await import('/src/gfx/daylight.js');
  window.__app.day.clock = phaseSteps(h / 24);
}, h);
const preset = (name, steps) => ev(([name, steps]) => {
  const a = window.__app;
  a.loadPreset(name, false);
  for (let i = 0; i < steps; i++) a.sim.step();
}, [name, steps]);
const CAVE_CAM = [[33, 15, 46], [29, 8, 24]];
const CAVE_CLOSE = [[31, 8, 34], [24, 5, 25]];
const ADAPTED = 360;   // frames (6 s at 60 fps): long enough for eyes to adjust to the dark

// ---- the cave: crystal clusters, then a lava pool, then the dark control
await setHour(10);
await ev(() => window.__t.chamber('crystal'));
await view(...CAVE_CAM); await shot('cave-crystal');
await pump(ADAPTED); await shot('cave-crystal-adapted');
await view(...CAVE_CLOSE, ADAPTED); await shot('cave-crystal-close');
await ev(() => { window.__app.settings.glowLights = false; });
await view(...CAVE_CAM, ADAPTED); await shot('cave-crystal-nolights');
await ev(() => { window.__app.settings.glowLights = true; });
await ev(() => window.__t.chamber('lava'));
await view(...CAVE_CAM, ADAPTED); await shot('cave-lava');
await ev(() => window.__t.chamber('rock'));
await view(...CAVE_CAM, ADAPTED); await shot('cave-rock');

// ---- daylight, then midnight
await ev(() => window.__t.open());
await view([14, 16, 58], [31, 3, 32], ADAPTED); await shot('day-crystal');
await view([24, 7, 42], [31, 3, 32], ADAPTED); await shot('day-crystal-close');
await setHour(0);
await view([14, 16, 58], [31, 3, 32]); await shot('night-crystal');
await pump(ADAPTED); await shot('night-crystal-adapted');
await setHour(10);

// ---- the lab's lava (tools/regress.mjs labLava), by day and at midnight
await preset('lab', 300);
await worldView([3.6, 1.5, 3.6], [2.6, 0.9, 2.6], ADAPTED); await shot('lab-lava');
await worldView([11, 12.5, 13], [0, 2.5, 0], ADAPTED); await shot('lab');
await setHour(0);
await worldView([11, 12.5, 13], [0, 2.5, 0], ADAPTED); await shot('lab-night');
await setHour(10);

// ---- the dock tiles
for (const abbr of ['CRYS', 'CDST']) {
  const el = p.getByText(abbr, { exact: true }).first();
  const bb = await el.boundingBox().catch(() => null);
  if (bb) await p.screenshot({ path: `${out}/dock-${abbr}.png`, clip: { x: bb.x - 60, y: bb.y - 40, width: bb.width + 120, height: bb.height + 80 } });
  else errs.push(`dock tile ${abbr} not found`);
}

// ---- cost: the view (post.render) and a whole frame with the derived passes
// (fields, bricks, shadow map, GI) rerun, crystal chamber against the rock one
const timing = { view: { crystal: [], rock: [] }, viewNoAdapt: { crystal: [], rock: [] }, viewNoGlowLights: { crystal: [], rock: [] },
  frame: { crystal: [], rock: [] } };
for (let round = 0; round < ROUNDS; round++) {
  for (const kind of ['crystal', 'rock']) {
    await ev((kind) => window.__t.chamber(kind), kind);
    await view(...CAVE_CAM, ADAPTED);
    const r = await ev((n) => {
      const a = window.__app, t = window.__t;
      const v = t.fastest(() => a.post.render(a.scene, a.camera), n);
      a.post.settings.adapt = false;
      const vn = t.fastest(() => a.post.render(a.scene, a.camera), n);
      a.post.settings.adapt = true;
      const u = a.volume.material.uniforms;
      u.uGlowLights.value = false;
      const vg = t.fastest(() => a.post.render(a.scene, a.camera), n);
      u.uGlowLights.value = true;
      const f = t.fastest(() => { a.sim.version++; window.__pump(1); }, n);
      return { v, vn, vg, f };
    }, N);
    timing.view[kind].push(r.v);
    timing.viewNoAdapt[kind].push(r.vn);
    timing.viewNoGlowLights[kind].push(r.vg);
    timing.frame[kind].push(r.f);
  }
}
const min = (xs) => Math.min(...xs);
if (ROUNDS > 0) console.log(JSON.stringify({
  viewMs: { crystal: min(timing.view.crystal), rock: min(timing.view.rock) },
  viewNoAdaptMs: { crystal: min(timing.viewNoAdapt.crystal), rock: min(timing.viewNoAdapt.rock) },
  viewNoGlowLightsMs: { crystal: min(timing.viewNoGlowLights.crystal), rock: min(timing.viewNoGlowLights.rock) },
  frameMs: { crystal: min(timing.frame.crystal), rock: min(timing.frame.rock) },
  rounds: timing,
  pixelRatio: await ev(() => window.__app.renderer.getPixelRatio()),
}, null, 1));
console.log(JSON.stringify({ adaptation: adaptLog }));
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
