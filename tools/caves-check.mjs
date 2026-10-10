// Headless GPU check of the island's caves (src/world/island/caves.js) in
// World mode (?size=world), at the places tools/caves-preview.mjs found
// (its spots.json: a hillside mouth, a shaft, an underground lake, a crystal
// cavern, a long tunnel). For each, the window loaded there:
//   - stability: the element at every cell after --steps steps vs right after
//     loading (cells whose element changed, by from → to);
//   - the JS twin against the GPU: every cell of a fill without trees against
//     islandCellAt with the World's structures in (structureCellAt);
//   - seams: a fill at an origin shifted by a window step matches the
//     overlapping cells (all of state A), and a slab fill (a window move's)
//     leaves the rest of the window as the full fill made it;
//   - fill time: a full window fill and a slab fill, GPU-synced, the minimum of
//     --runs (other sessions share the GPU: the minimum is the uncontended cost).
// Then islandCaveMouth (the structures layer's mouth query) on the GPU against
// its twin over the windows at the mouth and the shaft, the far field's build
// (frames, wall time), and stills: the mouth from outside, the shaft from
// above, the mouth from far off (far field), and first person in the tunnel,
// the crystal cavern and by the lake (as the player sees them: the eyes adapt
// to the dark), in one contact sheet.
// usage: node tools/caves-check.mjs spots.json [outDir] [--port 5394] [--steps 600] [--runs 15] [--no-shots]
//   (a vite server on that port: ./node_modules/.bin/vite --port 5394 --strictPort)
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--no-shots'));
const spots = JSON.parse(readFileSync(pos[0], 'utf8'));
const out = pos[1] ?? 'caves-check';
const port = opt('port', '5394');
const steps = +opt('steps', 600);
const runs = +opt('runs', 15);
const shots = !args.includes('--no-shots');
mkdirSync(out, { recursive: true });

const W = 960, H = 600;                // stills
const WIN = 128;                       // the World's window, cells (app.js WORLDS)
const STEP = 16;                       // a window move (world/window.js WIN_STEP)
const LOAD_FRAMES = 30;                // frames after a load for the fields and the far field's first chunks
const BUILD_FRAMES = 2000;             // frames the far build may take
const FAR_RUNS = 7;                    // far builds timed (the minimum is the uncontended cost)
const SHOT_MS = 1500;                  // a still's settle time (TAA, GI)
const POV_SETTLE_MS = 4000;            // first person: the body lands, the view settles and the eyes adapt to the dark
const FAR_AWAY = 300;                  // cells the window sits from the mouth for the far field's still
const OUTSIDE = [30, 14];              // the mouth's still: this far out from it and up
const ABOVE = [14, 34];                // the shaft's still: this far off its axis and up over the ground
const MONTAGE_TILE = '480x300';
const EYE = 5;                         // the POV eye over its feet, cells (pov/constants.js EYE_HEIGHT)

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
p.on('crash', () => errs.push('PAGE CRASHED'));
await p.goto(`http://localhost:${port}/?size=world`);
await p.waitForFunction(() => window.__app?.win?.P, null, { timeout: 120000 });
await p.waitForTimeout(3000);
await p.addStyleTag({ content: 'body *{visibility:hidden !important} #app > canvas{visibility:visible !important}' });

await p.evaluate(() => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;
  const H = window.__cc = {};
  H.frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // the window's origin that puts world column (x, z) in its middle (whole window steps, inside the world)
  H.origin = (x, z, step, win) => {
    const size = a.win.size, snap = (v, n) => Math.max(0, Math.min(n - win, Math.round((v - win / 2) / step) * step));
    return [snap(x, size[0]), snap(z, size[2])];
  };
  H.load = async (O, frames) => { a.worldLoad([O[0], 0, O[1]]); a.worldFocus = [O[0] + a.sim.g.nx / 2, O[1] + a.sim.g.nz / 2]; await H.frames(frames); };
  // the camera at window-local cells from, looking at to
  H.view = (from, to) => {
    const s = a.scale, v = a.volume.position;
    a.camera.position.set(v.x + from[0] * s, from[1] * s, v.z + from[2] * s);
    a.controls.target.set(v.x + to[0] * s, to[1] * s, v.z + to[2] * s);
    a.controls.update();
  };
  H.ids = () => {
    const sim = a.sim, g = sim.g, [A] = sim.readState(), o = new Uint8Array(g.nx * g.ny * g.nz);
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) o[(y * g.nz + z) * g.nx + x] = Math.round(A[sim.cellTexel(x, y, z) * 4]);
    return o;
  };
  H.stateA = () => a.sim.readState()[0].slice();
});

const results = {};
for (const name of ['hill', 'shaft', 'lake', 'crystal', 'tunnel']) {
  const s = spots[name];
  if (!s) { results[name] = 'no such spot'; continue; }
  const at = s.at ?? s.feet;
  results[name] = await p.evaluate(async ([at, steps, runs, STEP, WIN]) => {
    const a = window.__app, H = window.__cc, sim = a.sim, g = sim.g, w = a.win, P = w.P;
    const { islandCellAt } = await import('/src/world/generator.js');
    const { structureCellAt } = await import('/src/world/structures.js');
    const cellAt = (x, y, z) => structureCellAt(P, x, y, z, islandCellAt(x, y, z, P), (yy) => islandCellAt(x, yy, z, P));
    const { ELEMENTS } = await import('/src/elements.js');
    const name = (id) => ELEMENTS[id]?.key ?? id;
    const O = H.origin(at[0], at[2], STEP, WIN);
    await H.load(O, 2);
    // stability (with its trees)
    const s0 = H.ids();
    for (let i = 0; i < steps; i++) sim.step();
    const s1 = H.ids(), changes = {};
    let changed = 0;
    for (let j = 0; j < s0.length; j++) if (s0[j] !== s1[j]) { changed++; const k = `${name(s0[j])}->${name(s1[j])}`; changes[k] = (changes[k] ?? 0) + 1; }
    // the twin vs the GPU (the generator alone)
    w.gen.fill(P, [O[0], 0, O[1]]);
    const gpu = H.ids(), kinds = {}, where = [];
    let differ = 0;
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const cpu = cellAt(O[0] + x, y, O[1] + z), gid = gpu[(y * g.nz + z) * g.nx + x];
      if (cpu === gid) continue;
      differ++;
      const k = `${name(cpu)}/${name(gid)}`;
      kinds[k] = (kinds[k] ?? 0) + 1;
      if (where.length < 4) where.push([O[0] + x, y, O[1] + z]);
    }
    // seams: a fill a window step over matches where the two overlap; a slab fill keeps the rest
    const A0 = H.stateA();
    w.gen.fill(P, [O[0] + STEP, 0, O[1] + STEP]);
    const A1 = H.stateA();
    let seam = 0;
    for (let y = 0; y < g.ny; y++) for (let z = STEP; z < g.nz; z++) for (let x = STEP; x < g.nx; x++) {
      const i = sim.cellTexel(x, y, z) * 4, k = sim.cellTexel(x - STEP, y, z - STEP) * 4;
      for (let c = 0; c < 4; c++) if (!Object.is(A0[i + c], A1[k + c])) { seam++; break; }
    }
    w.gen.fill(P, [O[0], 0, O[1]]);
    w.gen.fill(P, [O[0], 0, O[1]], [0, 0, 0], [STEP, g.ny, g.nz]);
    const A2 = H.stateA();
    let slab = 0;
    for (let i = 0; i < A0.length; i += 4) for (let c = 0; c < 4; c++) if (!Object.is(A0[i + c], A2[i + c])) { slab++; break; }
    // fill time
    const time = (fn) => { const t0 = performance.now(); fn(); sim.gpuSync(); return performance.now() - t0; };
    const full = [], part = [];
    for (let i = 0; i < runs; i++) {
      full.push(time(() => w.gen.fill(P, [O[0], 0, O[1]])));
      part.push(time(() => w.gen.fill(P, [O[0], 0, O[1]], [0, 0, 0], [STEP, g.ny, g.nz])));
    }
    const ms = (v) => ({ min: +Math.min(...v).toFixed(2), median: +v.sort((x, y) => x - y)[v.length >> 1].toFixed(2) });
    return { origin: O, stability: { steps, changed, changes }, twin: { differ, kinds, where }, seams: { shifted: seam, slab }, fillMs: ms(full), slabFillMs: ms(part) };
  }, [at, steps, runs, STEP, WIN]);
  console.log(name, JSON.stringify(results[name]));
}

// islandCaveMouth on the GPU (a pass over the window's columns) against the twin
results.mouth = {};
for (const name of ['hill', 'shaft']) {
  if (!spots[name]) continue;
  results.mouth[name] = await p.evaluate(async ([at, STEP, WIN]) => {
    const a = window.__app, H = window.__cc, THREE = a.THREE, sim = a.sim, g = sim.g, w = a.win;
    const { prelude } = await import('/src/shaders/common.js');
    const { rawMat, makeFieldTarget } = await import('/src/sim.js');
    const { islandTwin } = await import('/src/world/generator.js');
    const O = H.origin(at[0], at[2], STEP, WIN);
    const frag = `${prelude(g)}\n${w.scene.glsl(g)}\nuniform ivec2 uMouthLo;\nout vec4 oC;\nvoid main() {\n`
      + `  ivec2 c = uMouthLo + ivec2(gl_FragCoord.xy);\n  oC = vec4(islandCaveMouth(c.x, c.y), 0.0, 0.0, 1.0);\n}\n`;
    const mat = rawMat(frag, { ...w.sceneU, uMouthLo: { value: new THREE.Vector2(O[0], O[1]) } });
    const target = makeFieldTarget(g.nx, g.nz, 1, THREE.FloatType, THREE.NearestFilter);
    sim.run(mat, target);
    const px = new Float32Array(g.nx * g.nz * 4);
    a.renderer.readRenderTargetPixels(target, 0, 0, g.nx, g.nz, px);
    const T = islandTwin(w.P);
    let open = 0, differ = 0;
    for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
      const cpu = T.islandCaveMouth(O[0] + i, O[1] + j);
      if (cpu > 0) open++;
      if (px[(j * g.nx + i) * 4] !== cpu) differ++;
    }
    target.dispose();
    mat.dispose();
    return { origin: O, columns: g.nx * g.nz, mouthColumns: open, differ };
  }, [spots[name].at, STEP, WIN]);
}
console.log('islandCaveMouth', JSON.stringify(results.mouth));

// the far build: from fresh loads at the hill mouth, its wall time the minimum of FAR_RUNS
results.far = await p.evaluate(async ([at, STEP, WIN, BUILD_FRAMES, FAR_RUNS]) => {
  const a = window.__app, H = window.__cc, far = a.win.far, ms = [];
  let left = 0, frames = 0;
  for (let r = 0; r < FAR_RUNS; r++) {
    await H.load(H.origin(at[0], at[2], STEP, WIN), 1);
    for (let i = 0; i < BUILD_FRAMES && far.queue.length; i++) await H.frames(1);
    left = Math.max(left, far.queue.length);
    ms.push(far.last.buildMs);
    frames = far.last.frames;
  }
  return { left, frames, buildMs: { min: +Math.min(...ms).toFixed(1), median: +ms.sort((x, y) => x - y)[ms.length >> 1].toFixed(1) } };
}, [spots.hill?.at ?? [512, 0, 512], STEP, WIN, BUILD_FRAMES, FAR_RUNS]);
console.log('far', JSON.stringify(results.far));
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));

if (shots) {
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const files = [];
  const shot = async (name, ms = SHOT_MS) => { await p.waitForTimeout(ms); const f = `${out}/${name}.png`; await p.screenshot({ path: f }); files.push(f); console.log(`shot ${name}`); };
  // a view from world cell `from` toward world cell `to`, the window loaded around `around`
  const god = (around, from, to) => ev(async ([around, from, to, STEP, WIN, LOAD_FRAMES]) => {
    const a = window.__app, H = window.__cc;
    await H.load(H.origin(around[0], around[2], STEP, WIN), LOAD_FRAMES);
    const o = a.sim.origin;
    H.view([from[0] - o.x, from[1], from[2] - o.z], [to[0] - o.x, to[1], to[2] - o.z]);
  }, [around, from, to, STEP, WIN, LOAD_FRAMES]);
  if (spots.hill) {
    const { at, out: d } = spots.hill, l = Math.hypot(...d) || 1;
    const from = [at[0] + (d[0] / l) * OUTSIDE[0], at[1] + OUTSIDE[1], at[2] + (d[1] / l) * OUTSIDE[0]];
    await god(at, from, at);
    await shot('mouth-outside');
    // the same mouth from far off, the window elsewhere: the far field draws it
    const away = [at[0] - (d[0] / l) * FAR_AWAY, 0, at[2] - (d[1] / l) * FAR_AWAY];
    await ev(async ([away, from, at, STEP, WIN]) => {
      const a = window.__app, H = window.__cc, far = a.win.far;
      await H.load(H.origin(away[0], away[2], STEP, WIN), 2);
      while (far.queue.length) await H.frames(1);
      const o = a.sim.origin;
      H.view([from[0] - o.x, from[1], from[2] - o.z], [at[0] - o.x, at[1], at[2] - o.z]);
    }, [away, [at[0] + (d[0] / l) * OUTSIDE[0] * 2, at[1] + OUTSIDE[1] * 2, at[2] + (d[1] / l) * OUTSIDE[0] * 2], at, STEP, WIN]);
    await shot('mouth-far-field');
  }
  if (spots.shaft) {
    const { at, ground } = spots.shaft;
    await god(at, [at[0] + ABOVE[0], ground + ABOVE[1], at[2] + ABOVE[0]], [at[0], ground - ABOVE[0], at[2]]);
    await shot('shaft-above');
  }
  // first person: feet at a world cell, looking toward another
  await ev(async () => { const a = window.__app; a.pov.test.assumeLocked = true; await a.pov.enter(); });
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => console.log('POV did not come on'));
  const pov = (name, feet, dir, pitch) => ev(async ([feet, dir, pitch, STEP, WIN, LOAD_FRAMES]) => {
    const a = window.__app, H = window.__cc, V = a.camera.position.constructor;
    await H.load(H.origin(feet[0], feet[2], STEP, WIN), LOAD_FRAMES);
    const o = a.sim.origin;
    a.pov.player.spawn(new V(feet[0] - o.x + 0.5, feet[1], feet[2] - o.z + 0.5));
    a.pov.setLook(Math.atan2(-dir[0], -dir[1]), pitch);   // yaw 0 looks toward -z
  }, [feet, dir, pitch, STEP, WIN, LOAD_FRAMES]).then(() => shot(name, POV_SETTLE_MS));
  const toward = (feet, look) => {
    const d = [look[0] - feet[0], look[1] + 0.5 - feet[1] - EYE, look[2] - feet[2]];
    return { dir: [d[0], d[2]], pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) };
  };
  if (spots.tunnel) await pov('pov-tunnel', spots.tunnel.feet, spots.tunnel.dir, -0.05);
  if (spots.crystal) { const t = toward(spots.crystal.feet, spots.crystal.look); await pov('pov-crystal-cavern', spots.crystal.feet, t.dir, t.pitch); }
  if (spots.lake) { const t = toward(spots.lake.feet, spots.lake.look); await pov('pov-lake', spots.lake.feet, t.dir, t.pitch); }
  await ev(() => window.__app.pov.exit());
  execFileSync('montage', [...files, '-tile', '3x', '-geometry', `${MONTAGE_TILE}+4+4`, `${out}/contact.png`]);
  console.log(`contact sheet ${out}/contact.png`);
}
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close();
