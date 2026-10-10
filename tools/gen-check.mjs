// Headless check of the world generator, the box's Island preset (src/world/
// generator.js, scenes/island.js, world/gpu.js IslandGenerator):
//   - the Island scene loads without console errors;
//   - fill time: the column bake + fill pass on the grid, wall clock with a forced
//     sync (a 1-texel readback of the written target), median and minimum of
//     FILL_RUNS (other sessions share the GPU: the minimum is the uncontended cost);
//   - stability: the element at every cell after --steps steps vs right after
//     loading (cells whose element changed, by from → to);
//   - the JS twin against the GPU: the baked column heights against heightAt,
//     and every cell's element (the fill, no trees) against islandCellAt;
//   - seams: the grid generated at a shifted world origin matches the
//     overlapping cells exactly, and a slab fill keeps the cells outside it;
//   - stills: god view, three-quarter, eye level on a meadow and on a beach.
// usage: node tools/gen-check.mjs [outDir] [--port 5371] [--size 128|wide|64|96]
//          [--seed N] [--steps 600] [--no-shots] [--verbose: list the changed cells]
import { launchBrowser, newTestPage } from './browser.mjs';
import { mkdirSync } from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const port = opt('port', '5371');
const size = opt('size', '128');
const seed = opt('seed', null);
const steps = +opt('steps', 600);
const shots = out && !args.includes('--no-shots');
const verbose = args.includes('--verbose');
const FILL_RUNS = 15;
const TAA_FRAMES = 40;     // frames for TAA to converge on a still view
const EYE_CELLS = 5.5;     // eye height above the ground, cells (the POV body's eye)
if (out) mkdirSync(out, { recursive: true });

const b = await launchBrowser();
const p = await newTestPage(b, { mode: 'visual', viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body *{visibility:hidden !important} #app > canvas{visibility:visible !important}';
    document.head.appendChild(st);
  });
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 600)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
await p.goto(`http://localhost:${port}/?preset=island&size=${size}&paused=1${seed != null ? `&seed=${seed}` : ''}`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

const res = await p.evaluate(async ([steps, FILL_RUNS, seed, verbose]) => {
  const a = window.__app;
  a.settings.paused = true;
  a.autoRes.enabled = false;
  const { generatorFor, loadIsland } = await import('/src/world/gpu.js');
  const { worldParams, treesIn, heightAt, islandCellAt, COLUMN_MARGIN: M } = await import('/src/world/generator.js');
  const { ELEMENTS } = await import('/src/elements.js');
  const sim = a.sim, g = sim.g, r = a.renderer;
  const P = worldParams({ size: [g.nx, g.ny, g.nz], seed: seed == null ? undefined : +seed });
  const gen = generatorFor(sim);
  const sync = () => sim.gpuSync();
  const median = (v) => v.sort((x, y) => x - y)[v.length >> 1];
  const stat = (v) => `${median(v).toFixed(2)} (min ${Math.min(...v).toFixed(2)})`;
  const time = (fn) => { const t0 = performance.now(); fn(); sync(); return performance.now() - t0; };

  // timing (the first run compiles the shaders)
  time(() => loadIsland(sim, { seed: P.seed }));
  const fill = [], column = [], fillOnly = [], trees = [];
  for (let i = 0; i < FILL_RUNS; i++) {
    gen.columns.key = '';
    fill.push(time(() => { gen.prepare(P); gen.fill(P); }));
    column.push(time(() => { gen.columns.key = ''; gen.prepare(P); }));
    fillOnly.push(time(() => gen.fill(P)));
    trees.push(time(() => gen.plantTrees(P)));
  }
  const treeList = treesIn(0, 0, g.nx, g.nz, P);

  // stability
  loadIsland(sim, { seed: P.seed });
  const read = () => {
    const { nx, ny, nz } = g;
    const [buf] = sim.readState();
    const ids = new Uint8Array(nx * ny * nz), T = new Float32Array(nx * ny * nz);
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const i = sim.cellTexel(x, y, z) * 4, j = (y * nz + z) * nx + x;
          ids[j] = Math.round(buf[i]); T[j] = buf[i + 1];
        }
    return { ids, T };
  };
  const s0 = read();
  sim.frame = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) sim.step();
  sync();
  const stepMs = (performance.now() - t0) / steps;
  const s1 = read();
  const name = (id) => ELEMENTS[id]?.key ?? id;
  const census = {}, changes = {};
  let changed = 0, snowMaxT = -1e9;
  const list = [];
  for (let j = 0; j < s0.ids.length; j++) {
    census[name(s0.ids[j])] = (census[name(s0.ids[j])] ?? 0) + 1;
    if (s1.ids[j] === ELEMENTS.findIndex((e) => e.key === 'SNOW')) snowMaxT = Math.max(snowMaxT, s1.T[j]);
    if (s0.ids[j] !== s1.ids[j]) {
      changed++;
      const k = `${name(s0.ids[j])}->${name(s1.ids[j])}`;
      changes[k] = (changes[k] ?? 0) + 1;
      const x = j % g.nx, z = Math.floor(j / g.nx) % g.nz, y = Math.floor(j / (g.nx * g.nz));
      if (verbose && list.length < 40) list.push(`${k} at (${x}, ${y}, ${z}) T ${s0.T[j].toFixed(1)} -> ${s1.T[j].toFixed(1)}`);
    }
  }
  const matter = s0.ids.length - (census.EMPTY ?? 0);
  // snow at its melting point, and what touches it
  const SNOW = ELEMENTS.findIndex((e) => e.key === 'SNOW'), melting = [];
  for (let j = 0; j < s1.ids.length && verbose && melting.length < 6; j++) {
    if (s1.ids[j] !== SNOW || s1.T[j] < -0.5) continue;
    const x = j % g.nx, z = Math.floor(j / g.nx) % g.nz, y = Math.floor(j / (g.nx * g.nz));
    const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => {
      const q = ((y + dy) * g.nz + z + dz) * g.nx + x + dx;
      return x + dx < 0 || x + dx >= g.nx || y + dy < 0 || y + dy >= g.ny || z + dz < 0 || z + dz >= g.nz ? 'box'
        : `${name(s1.ids[q])}@${s1.T[q].toFixed(0)}`;
    });
    melting.push(`(${x}, ${y}, ${z}) ${s1.T[j].toFixed(1)}: ${nb.join(' ')}`);
  }

  // JS twin vs GPU: the baked column heights against heightAt
  gen.columns.key = '';
  gen.prepare(P);
  const cw = g.nx + 2 * M, ch = g.nz + 2 * M, cols = new Float32Array(cw * ch * 4);
  r.readRenderTargetPixels(gen.columns.target, 0, 0, cw, ch, cols);
  let twinMax = 0, twinGround = 0;
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++) {
      const gpu = cols[(j * cw + i) * 4], cpu = heightAt(i - M, j - M, P);
      twinMax = Math.max(twinMax, Math.abs(gpu - cpu));
      if (Math.floor(gpu + 0.5) !== Math.floor(cpu + 0.5)) twinGround++;
    }

  // seams: generate at origin 0, then at a shifted origin, and compare where they overlap
  // (the shifted grid reaches past the box's world: its columns baked over a wider one, the same island)
  const SHIFT = 16;   // cells (D11's window step)
  const wide = { ...P, size: [g.nx + SHIFT, g.ny, g.nz + SHIFT] };
  const readRaw = () => sim.readState()[0];
  const at = (x, y, z) => sim.cellTexel(x, y, z) * 4;
  gen.prepare(wide);
  gen.fill(wide, [0, 0, 0]);
  const base = readRaw();
  gen.fill(wide, [SHIFT, 0, SHIFT]);
  const shifted = readRaw();
  let seamDiff = 0;
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz - SHIFT; z++)
      for (let x = 0; x < g.nx - SHIFT; x++) {
        const i = at(x, y, z), k = at(x + SHIFT, y, z + SHIFT);
        for (let c = 0; c < 4; c++) if (shifted[i + c] !== base[k + c]) { seamDiff++; break; }
      }
  // every cell of the fill (origin 0, no trees) against the twin's islandCell
  let twinCells = 0;
  const twinKinds = {};
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const gpu = Math.round(base[at(x, y, z)]), cpu = islandCellAt(x, y, z, P);
        if (gpu === cpu) continue;
        twinCells++;
        const k = `${name(gpu)}/${name(cpu)}`;
        twinKinds[k] = (twinKinds[k] ?? 0) + 1;
        if (verbose && list.length < 40) list.push(`twin: GPU ${name(gpu)}, CPU ${name(cpu)} at (${x}, ${y}, ${z})`);
      }
  // a slab fill: x < SHIFT from the shifted world, the rest kept
  gen.fill(wide, [0, 0, 0]);
  gen.fill(wide, [SHIFT, 0, SHIFT], [0, 0, 0], [SHIFT, g.ny, g.nz]);
  const slab = readRaw();
  let slabDiff = 0;
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const i = at(x, y, z), want = x < SHIFT ? shifted : base;
        for (let c = 0; c < 4; c++) if (slab[i + c] !== want[i + c]) { slabDiff++; break; }
      }
  gen.prepare(P);

  return {
    world: { seed: P.seed, sea: P.sea, relief: +P.relief.toFixed(1), radius: P.radius },
    timingMs: { columnAndFill: stat(fill), columnPass: stat(column), fillPass: stat(fillOnly),
      trees: stat(trees), treeCount: treeList.length, step: +stepMs.toFixed(2) },
    trees: treeList.map((t) => t.variant).join(' '),
    census, matter,
    stability: { steps, changed, shareOfMatter: +(changed / matter).toExponential(2), changes, snowMaxT: +snowMaxT.toFixed(2), list, melting },
    twin: { maxHeightDiff: +twinMax.toExponential(2), groundDiffColumns: twinGround, columns: cw * ch,
      cellsDiffering: twinCells, kinds: twinKinds, cells: g.nx * g.ny * g.nz },
    seams: { shift: SHIFT, cellsDiffering: seamDiff, slabFillCellsDiffering: slabDiff },
  };
}, [steps, FILL_RUNS, seed, verbose]);
console.log(JSON.stringify(res, null, 1));

if (shots) {
  const frames = (n) => p.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
  // reload a fresh island for the stills
  await p.evaluate((seed) => window.__app.loadPreset('island', false), seed);
  const cam = async (name, fn, arg) => {
    await p.evaluate(fn, arg);
    await p.evaluate(() => { window.__app.controls.update(); window.__app.post.reset(); });
    await frames(TAA_FRAMES);
    await p.screenshot({ path: `${out}/${name}.png` });
  };
  await cam('god', () => window.__app.rig.reset(true));
  await cam('three-quarter', () => { const a = window.__app; a.camera.position.set(6.2, 3.6, 6.8); a.controls.target.set(0, 1.4, 0); });
  // eye level: stand on open meadow (looking up at the summit) or on a beach
  // (looking along the shore, the island on one side and the sea on the other)
  const eye = async (name, want, EYE) => cam(name, async ([want, EYE]) => {
    const a = window.__app, g = a.sim.g, s = a.scale;
    const { worldParams, layersAt, treesIn, heightAt } = await import('/src/world/generator.js');
    const seed = new URLSearchParams(location.search).get('seed');
    const P = worldParams({ size: [g.nx, g.ny, g.nz], seed: seed == null ? undefined : +seed });
    const trees = treesIn(0, 0, g.nx, g.nz, P);
    const CLEAR = 7;    // cells to the nearest trunk
    let best = null, top = { h: -1 };
    for (let z = 0; z < g.nz; z += 2)
      for (let x = 0; x < g.nx; x += 2) { const h = heightAt(x, z, P); if (h > top.h) top = { x, z, h }; }
    for (let k = 0; k < 24 && !best; k++) {
      const ang = (k / 24) * Math.PI * 2 + 0.4;
      for (let d = g.nx * 0.45; d > 4 && !best; d -= 1) {
        const x = Math.round(P.center[0] + Math.cos(ang) * d), z = Math.round(P.center[1] + Math.sin(ang) * d);
        if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < CLEAR)) continue;
        const L = layersAt(x, z, P);
        if (want === 'beach' ? L.sand && L.ground > P.sea : L.plant && L.slope < 0.6) best = { x, z, y: L.ground, ang };
      }
    }
    if (!best) return;
    const toW = (x, y, z) => [(x + 0.5 - g.nx / 2) * s, y * s, (z + 0.5 - g.nz / 2) * s];
    a.camera.position.set(...toW(best.x, best.y + EYE, best.z));
    const SHORE_TURN = 1.25;   // rad off the inland direction: mostly along the shore
    const look = want === 'beach'
      ? [best.x - Math.cos(best.ang - SHORE_TURN) * 40, best.y + EYE, best.z - Math.sin(best.ang - SHORE_TURN) * 40]
      : [top.x, top.h, top.z];
    a.controls.target.set(...toW(...look));
  }, [want, EYE]);
  await eye('eye-meadow', 'meadow', EYE_CELLS);
  await eye('eye-beach', 'beach', EYE_CELLS);
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
