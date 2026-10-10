// Headless GPU check of the island's landforms and strata (src/world/island),
// as tools/gen-check.mjs checks the generator, but over the World's island
// (worldParams at WORLD_SIZE, which has the landforms: the box's Island preset
// is too small for them), a box-sized window around each landform:
//   - the column bake against the JS twin: heights (and the ground they round
//     to), water levels and bare columns, over every BAKE_STRIDE-th column;
//   - each window's fill against the twin's islandCell, cell for cell;
//   - stability: the element at every cell after --steps steps vs right after
//     the fill (no trees: they are constructions, stamped separately);
//   - seams: the window filled at an origin SHIFT further matches the overlap
//     exactly, and a slab fill keeps the cells outside it;
//   - stills (with an outDir): each landform in the World scene from above and
//     at eye level, and a contact sheet of them.
// usage: node tools/landforms-gpu.mjs [outDir] [--port 5395] [--seed N] [--steps 600] [--no-shots] [--no-checks]
//   (the stills are of the World's own island, the default seed's)
//   (a vite server on that port: ./node_modules/.bin/vite --port 5395 --strictPort)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const port = opt('port', '5395');
const seed = opt('seed', null);
const steps = +opt('steps', 600);
const shots = out && !args.includes('--no-shots');
const checks = !args.includes('--no-checks');
if (out) mkdirSync(out, { recursive: true });

const SHIFT = 16;            // cells: the seam check's origin shift (D11's window step)
const BAKE_STRIDE = 2;       // columns compared with the twin: every this many along x and z
const W = 1280, H = 800;     // still size
const SETTLE_MS = 1500;      // after moving the window: the fill, derived passes and TAA settle
const EYE = 5.5;             // cells: the POV body's eye height
const TREE_CLEAR = 7;        // cells: an eye-level camera stands this far from any trunk (else it is in a crown)
const SHEET_COLS = 3;        // contact sheet: stills per row...
const SHEET_W = 640;         // ...each this wide

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errs = [];
const page = async (url) => {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
  await p.addInitScript(() => localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true })));
  await p.goto(`http://localhost:${port}/${url}`);
  return p;
};

// ---------------------------------------------------------------- checks, in a box
if (checks) {
const p = await page('?preset=island&size=128');
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });
await p.waitForTimeout(1500);
const res = await p.evaluate(async ([steps, seed, SHIFT, BAKE_STRIDE]) => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;
  const { generatorFor, loadIsland } = await import('/src/world/gpu.js');
  const { worldParams, islandTwin, GEN, COLUMN_MARGIN: M } = await import('/src/world/generator.js');
  const { WORLD_SIZE } = await import('/src/shaders/far.js');
  const { ELEMENTS } = await import('/src/elements.js');
  const sim = a.sim, g = sim.g, r = a.renderer;
  loadIsland(sim, {});
  const P = worldParams({ size: WORLD_SIZE, seed: seed == null ? undefined : +seed, snow: false });
  const T = islandTwin(P), S = P.landforms;
  const gen = generatorFor(sim);
  const name = (id) => ELEMENTS[id]?.key ?? id;
  const tally = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

  // the column bake against the twin
  gen.prepare(P);
  const cw = P.size[0] + 2 * M, ch = P.size[2] + 2 * M, cols = new Float32Array(cw * ch * 4);
  r.readRenderTargetPixels(gen.columns.target, 0, 0, cw, ch, cols);
  let maxHeight = 0, groundDiff = 0, waterDiff = 0, bareDiff = 0, compared = 0;
  for (let j = 0; j < ch; j += BAKE_STRIDE)
    for (let i = 0; i < cw; i += BAKE_STRIDE) {
      const k = (j * cw + i) * 4, c = T.column(i - M, j - M);
      compared++;
      maxHeight = Math.max(maxHeight, Math.abs(cols[k] - c[0]));
      if (Math.floor(cols[k] + 0.5) !== Math.floor(c[0] + 0.5)) groundDiff++;
      if (Math.abs(cols[k + 3] - c[3]) > 1e-3) waterDiff++;
      if ((cols[k + 2] === GEN.MEADOW_BARE) !== (c[2] === GEN.MEADOW_BARE)) bareDiff++;
    }

  // the windows: a box around each landform
  const sites = [];
  if (S.ria) {
    const q = S.ria, along = (u) => [q.x + q.dx * u - q.dz * T.lfMeander(u), q.z + q.dz * u + q.dx * T.lfMeander(u)];
    sites.push(['ria-mouth', q.x, q.z], ['ria-gorge', ...along(0.6 * q.len)], ['ria-head', ...along(q.len)]);
  }
  if (S.mesa) sites.push(['mesa', S.mesa.x, S.mesa.z]);
  S.lakes.forEach((l, i) => sites.push([`tarn-${i}`, l.x, l.z]));
  S.stacks.slice(0, 2).forEach((s, i) => sites.push([`stack-${i}`, s.x, s.z]));
  const clampO = (v, n, size) => Math.max(0, Math.min(size - n, Math.round(v - n / 2)));
  const readA = () => sim.readState()[0];
  const at = (x, y, z) => sim.cellTexel(x, y, z) * 4;
  const windows = [];
  for (const [label, cx, cz] of sites) {
    const o = [clampO(cx, g.nx, P.size[0]), 0, clampO(cz, g.nz, P.size[2])];
    const w = { label, origin: o };
    // the fill against the twin
    gen.fill(P, o);
    const base = readA();
    let twin = 0;
    const census = {}, twinKinds = {};
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const gpu = Math.round(base[at(x, y, z)]), cpu = T.islandCell(o[0] + x, y, o[2] + z);
          tally(census, name(gpu));
          if (gpu !== cpu) { twin++; tally(twinKinds, `${name(gpu)}/${name(cpu)}`); }
        }
    w.census = census;
    w.twin = { cellsDiffering: twin, kinds: twinKinds };
    // stability: step the fill
    sim.frame = 0;
    for (let i = 0; i < steps; i++) sim.step();
    sim.gpuSync();
    const after = readA(), changes = {};
    let changed = 0;
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const k = at(x, y, z), i0 = Math.round(base[k]), i1 = Math.round(after[k]);
          if (i0 !== i1) { changed++; tally(changes, `${name(i0)}->${name(i1)}`); }
        }
    w.stability = { steps, changed, changes };
    // seams: shifted by SHIFT, the overlap matches; a slab fill keeps the rest
    gen.fill(P, o);
    const again = readA();
    const s = [o[0] + SHIFT, 0, o[2] + SHIFT];
    gen.fill(P, s);
    const shifted = readA();
    let seam = 0, slab = 0;
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz - SHIFT; z++)
        for (let x = 0; x < g.nx - SHIFT; x++) {
          const i = at(x, y, z), k = at(x + SHIFT, y, z + SHIFT);
          for (let c = 0; c < 4; c++) if (shifted[i + c] !== again[k + c]) { seam++; break; }
        }
    gen.fill(P, o);
    gen.fill(P, s, [0, 0, 0], [SHIFT, g.ny, g.nz]);
    const mixed = readA();
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const i = at(x, y, z), want = x < SHIFT ? shifted : again;
          for (let c = 0; c < 4; c++) if (mixed[i + c] !== want[i + c]) { slab++; break; }
        }
    w.seams = { cellsDiffering: seam, slabFillCellsDiffering: slab };
    windows.push(w);
  }
  return {
    world: { seed: P.seed, sea: P.sea, sites: S },
    bake: { columnsCompared: compared, maxHeightDiff: +maxHeight.toExponential(2), groundDiffColumns: groundDiff,
      waterLevelDiffColumns: waterDiff, bareDiffColumns: bareDiff },
    windows,
  };
}, [steps, seed, SHIFT, BAKE_STRIDE]);
for (const w of res.windows) {
  const keep = ['SANDSTONE', 'LIMESTONE', 'COAL', 'ROCK', 'WATER', 'SAND', 'PLANT'];
  w.census = Object.fromEntries(keep.filter((k) => w.census[k]).map((k) => [k, w.census[k]]));
}
console.log(JSON.stringify(res, null, 1));
await p.close();
}

// ---------------------------------------------------------------- stills, in the World
if (shots) {
  const q = await page('?size=world');
  await q.waitForFunction(() => window.__app?.win?.P, null, { timeout: 120000 });
  await q.waitForTimeout(4000);
  await q.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });
  // The views, from the twin: [name, [cx, cz] the world column the window centres on, from, to] (world cells)
  const views = await q.evaluate(async ([EYE, TREE_CLEAR]) => {
    const a = window.__app, P = a.win.P, S = P.landforms, sea = P.sea;
    const { islandTwin, treesIn } = await import('/src/world/generator.js');
    const T = islandTwin(P);
    const ground = (x, z) => T.genTop(Math.floor(x), Math.floor(z));
    const clear = (x, z) => treesIn(x - TREE_CLEAR, z - TREE_CLEAR, x + TREE_CLEAR, z + TREE_CLEAR, P, a.win.candidates)
      .every((t) => Math.hypot(t.x - x, t.z - z) >= TREE_CLEAR);
    const v = [];
    if (S.ria) {
      const r = S.ria, len = r.len;
      // the centreline at u along the axis, and its floor
      const c = (u) => [r.x + r.dx * u - r.dz * T.lfMeander(u), r.z + r.dz * u + r.dx * T.lfMeander(u)];
      const at = (u, up) => { const [x, z] = c(u); return [x, ground(x, z) + up, z]; };
      const [mx, mz] = c(70);
      v.push(['ria-mouth', c(0), [r.x - r.dx * 55, sea + 55, r.z - r.dz * 55], [mx, sea, mz]]);
      const [ix, iz] = c(0.12 * len), [jx, jz] = c(0.12 * len + 45);
      v.push(['ria-inlet-eye', [ix, iz], [ix, sea + EYE, iz], [jx, sea + 4, jz]]);
      const [gx, gz] = c(0.6 * len), gy = ground(gx, gz);
      v.push(['ria-gorge-above', [gx, gz], [gx - r.dx * 18, gy + 75, gz - r.dz * 18], [gx + r.dx * 12, gy, gz + r.dz * 12]]);
      v.push(['ria-gorge-eye', c(0.5 * len), at(0.5 * len, EYE), at(0.5 * len + 35, EYE + 5)]);
      v.push(['ria-head-eye', c(len - 30), at(len - 45, EYE), at(len, EYE + 14)]);
    }
    S.lakes.slice(0, 2).forEach((l, i) => {
      v.push([`tarn-${i}-above`, [l.x, l.z], [l.x - 35, l.level + 40, l.z - 35], [l.x, l.level, l.z]]);
      // on its shore where no tree stands, looking across the water
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2, dx = Math.cos(ang), dz = Math.sin(ang);
        const x = l.x + dx * (l.r + 5), z = l.z + dz * (l.r + 5);
        if (!clear(x, z)) continue;
        v.push([`tarn-${i}-eye`, [l.x, l.z], [x, ground(x, z) + EYE, z], [l.x - dx * l.r, l.level + 1, l.z - dz * l.r]]);
        break;
      }
    });
    if (S.mesa) {
      const m = S.mesa, my = ground(m.x, m.z);
      v.push(['mesa-above', [m.x, m.z], [m.x - 70, my + 60, m.z - 70], [m.x, my, m.z]]);
      v.push(['mesa-eye', [m.x, m.z], [m.x - 50, ground(m.x - 50, m.z - 10) + EYE, m.z - 10], [m.x + 20, my + 10, m.z + 5]]);
    }
    S.stacks.slice(0, 2).forEach((s, i) => {
      const d = Math.hypot(s.x - P.center[0], s.z - P.center[1]), ux = (s.x - P.center[0]) / d, uz = (s.z - P.center[1]) / d;
      v.push([`stack-${i}`, [s.x, s.z], [s.x + ux * 30 - uz * 20, sea + 18, s.z + uz * 30 + ux * 20], [s.x, sea + 3, s.z]]);
    });
    return v;
  }, [EYE, TREE_CLEAR]);
  // move the window over world column (cx, cz) and frame a view from, to (world cells)
  const still = async ([name, [cx, cz], from, to]) => {
    await q.evaluate(async ([cx, cz, from, to]) => {
      const a = window.__app;
      const o = [Math.round((cx - 64) / 16) * 16, Math.round((cz - 64) / 16) * 16];
      a.worldLoad([o[0], 0, o[1]]);
      a.worldFocus = [o[0] + 64, o[1] + 64];
      for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
      const s = a.scale, v = a.volume.position, ox = a.sim.origin.x, oz = a.sim.origin.z;
      a.camera.position.set(v.x + (from[0] - ox) * s, from[1] * s, v.z + (from[2] - oz) * s);
      a.controls.target.set(v.x + (to[0] - ox) * s, to[1] * s, v.z + (to[2] - oz) * s);
      a.controls.update();
      a.post?.reset?.();
    }, [cx, cz, from, to]);
    await q.waitForTimeout(SETTLE_MS);
    await q.screenshot({ path: `${out}/${name}.png` });
    return name;
  };
  const names = [];
  for (const view of views) names.push(await still(view));
  // a contact sheet: the stills in a grid, labelled
  const sheet = await b.newPage({ viewport: { width: SHEET_COLS * SHEET_W, height: 400 } });
  const imgs = names.map((n) => `<figure><img src="data:image/png;base64,${readFileSync(`${out}/${n}.png`).toString('base64')}"><figcaption>${n}</figcaption></figure>`).join('');
  await sheet.setContent(`<style>body{margin:0;display:grid;grid-template-columns:repeat(${SHEET_COLS},${SHEET_W}px);background:#111;font:14px sans-serif;color:#eee}
    figure{margin:0;position:relative}img{width:${SHEET_W}px;display:block}figcaption{position:absolute;left:6px;top:4px;text-shadow:0 0 3px #000}</style>${imgs}`);
  await sheet.screenshot({ path: `${out}/contact-sheet.png`, fullPage: true });
  console.log(`stills: ${names.join(', ')}; contact sheet ${out}/contact-sheet.png`);
}
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close();
