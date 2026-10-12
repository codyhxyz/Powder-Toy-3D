// Headless check of the world generator, the box's Island preset (src/world/
// generator.js, scenes/island.js, world/gpu.js IslandGenerator), on WebGPU
// (docs/webgpu.md G1), in manual mode:
//   - the Island scene loads without page or GPU errors;
//   - fill time: the fill (the island's prepass and its edit) on the grid,
//     GPU-synced, the minimum of FILL_RUNS (other sessions share the device:
//     the minimum is the uncontended cost);
//   - the JS twin against the GPU: the baked column heights (the scene data's
//     first vec4s) against heightAt, exactly, and every cell's element (the
//     fill, no trees) against islandCellAt;
//   - seams: the grid generated at a shifted world origin matches the
//     overlapping cells exactly (all of state A), and a slab fill (a window
//     move's) keeps the cells outside it as the full fill made them;
//   - stability: the element at every cell after --steps steps vs right after
//     loading (cells whose element changed, by from → to);
//   - with an outDir, a still of the box (test render).
// usage: node tools/gen-check.mjs [outDir] [--size 64|32|128|wide] [--seed N] [--steps 30] [--verbose] [--port N]
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, render } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const size = opt('size', '64');
const seed = opt('seed', null);
const steps = +opt('steps', 30);
const verbose = args.includes('--verbose');
const FILL_RUNS = 3;
const SHIFT = 16;   // cells: the seams' shift (a window step, world/window.js WIN_STEP)
if (out) mkdirSync(out, { recursive: true });

const vite = await startVite();
const b = await launchBrowser();
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 640, height: 400 } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 600)));
  await p.goto(vite.url(`/?preset=island&size=${size}&view=plain${seed != null ? `&seed=${seed}` : ''}`));
  await p.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 400)}`);
  await p.evaluate(() => window.__app.test.ready());

  const res = await p.evaluate(async ([steps, FILL_RUNS, seed, verbose, SHIFT]) => {
    const a = window.__app, sim = a.sim, g = sim.g, gpu = a.gpu;
    const { generatorFor, loadIsland, WorldGenerator } = await import('/src/world/gpu.js');
    const { island } = await import('/src/world/scenes/island.js');
    const { worldParams, heightAt, islandCellAt, COLUMN_MARGIN: M } = await import('/src/world/generator.js');
    const { ELEMENTS } = await import('/src/elements.js');
    const P = worldParams({ size: [g.nx, g.ny, g.nz], seed: seed == null ? undefined : +seed });
    const gen = generatorFor(sim, P);
    await gen.ready;
    const name = (id) => ELEMENTS[id]?.key ?? id;
    const at = (x, y, z) => sim.cellTexel(x, y, z) * 4;
    const readA = async () => (await sim.readState())[0];

    // timing (the pipelines are built: gen.ready)
    const fill = [];
    for (let i = 0; i < FILL_RUNS; i++) {
      await gpu.fence();
      const t0 = performance.now();
      gen.fill(P);
      await gpu.fence();
      fill.push(performance.now() - t0);
    }

    // the JS twin: the baked columns' heights, then every cell of the fill (origin 0, no trees)
    const cw = g.nx + 2 * M, ch = g.nz + 2 * M;
    const cols = new Float32Array(await gpu.readback.buffer(gen.res.data, 0, cw * ch * 16));
    let twinMax = 0, twinGround = 0;
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        const h = cols[(j * cw + i) * 4], cpu = heightAt(i - M, j - M, P);
        twinMax = Math.max(twinMax, Math.abs(h - cpu));
        if (Math.floor(h + 0.5) !== Math.floor(cpu + 0.5)) twinGround++;
      }
    gen.fill(P);
    const base0 = await readA();
    let twinCells = 0;
    const twinKinds = {}, list = [];
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const id = Math.round(base0[at(x, y, z)]), cpu = islandCellAt(x, y, z, P);
          if (id === cpu) continue;
          twinCells++;
          const k = `${name(id)}/${name(cpu)}`;
          twinKinds[k] = (twinKinds[k] ?? 0) + 1;
          if (verbose && list.length < 40) list.push(`twin: GPU ${name(id)}, CPU ${name(cpu)} at (${x}, ${y}, ${z})`);
        }

    // seams: generate at origin 0, then at a shifted origin, and compare where they overlap
    // (the shifted grid reaches past the box's world: a generator for a wider one, the same island)
    const wide = { ...P, size: [g.nx + SHIFT, g.ny, g.nz + SHIFT] };
    const genW = new WorldGenerator(sim, island, wide);
    await genW.ready;
    genW.fill(wide, [0, 0, 0]);
    const base = await readA();
    genW.fill(wide, [SHIFT, 0, SHIFT]);
    const shifted = await readA();
    let seamDiff = 0;
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz - SHIFT; z++)
        for (let x = 0; x < g.nx - SHIFT; x++) {
          const i = at(x, y, z), k = at(x + SHIFT, y, z + SHIFT);
          for (let c = 0; c < 4; c++) if (!Object.is(shifted[i + c], base[k + c])) { seamDiff++; break; }
        }
    // a slab fill: x < SHIFT from the shifted world, the rest kept
    genW.fill(wide, [0, 0, 0]);
    genW.fill(wide, [SHIFT, 0, SHIFT], [0, 0, 0], [SHIFT, g.ny, g.nz]);
    const slab = await readA();
    let slabDiff = 0;
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const i = at(x, y, z), want = x < SHIFT ? shifted : base;
          for (let c = 0; c < 4; c++) if (!Object.is(slab[i + c], want[i + c])) { slabDiff++; break; }
        }
    genW.dispose();

    // stability: the Island as loaded (its trees in), then steps
    await loadIsland(sim, { seed: P.seed });
    const s0 = await readA();
    a.test.step(steps);
    const s1 = await readA();
    const census = {}, changes = {};
    let changed = 0, matter = 0;
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const i0 = Math.round(s0[at(x, y, z)]), i1 = Math.round(s1[at(x, y, z)]);
          census[name(i0)] = (census[name(i0)] ?? 0) + 1;
          if (i0) matter++;
          if (i0 !== i1) {
            changed++;
            const k = `${name(i0)}->${name(i1)}`;
            changes[k] = (changes[k] ?? 0) + 1;
            if (verbose && list.length < 80) list.push(`${k} at (${x}, ${y}, ${z})`);
          }
        }
    return {
      world: { seed: P.seed, sea: P.sea, relief: +P.relief.toFixed(1), radius: P.radius },
      fillMs: { min: +Math.min(...fill).toFixed(1), runs: fill.map((t) => +t.toFixed(1)) },
      twin: { maxHeightDiff: twinMax, groundDiffColumns: twinGround, columns: cw * ch, cellsDiffering: twinCells, kinds: twinKinds, cells: g.nx * g.ny * g.nz },
      seams: { shift: SHIFT, cellsDiffering: seamDiff, slabFillCellsDiffering: slabDiff },
      stability: { steps, changed, shareOfMatter: +(changed / Math.max(matter, 1)).toExponential(2), changes },
      census, list,
    };
  }, [steps, FILL_RUNS, seed, verbose, SHIFT]);

  console.log(JSON.stringify({ world: res.world, fillMs: res.fillMs, census: res.census }, null, 1));
  if (verbose && res.list.length) console.log(res.list.join('\n'));
  const t = res.twin, s = res.seams;
  ok(t.maxHeightDiff === 0 && t.groundDiffColumns === 0, `twin: the baked columns' heights against heightAt over ${t.columns} columns: max difference ${t.maxHeightDiff}, ${t.groundDiffColumns} ground cells apart`);
  ok(t.cellsDiffering === 0, `twin: every cell of the fill against islandCellAt: ${t.cellsDiffering} of ${t.cells} differ${t.cellsDiffering ? ` (${JSON.stringify(t.kinds)})` : ''}`);
  ok(s.cellsDiffering === 0, `seams: a fill shifted by ${s.shift} cells against the overlap: ${s.cellsDiffering} cells differ`);
  ok(s.slabFillCellsDiffering === 0, `seams: a slab fill keeps the rest of the grid: ${s.slabFillCellsDiffering} cells differ`);
  console.log(`stability: ${res.stability.changed} cells changed element in ${res.stability.steps} steps (${res.stability.shareOfMatter} of the matter): ${JSON.stringify(res.stability.changes)}`);
  if (out) {
    await render(p);
    await p.screenshot({ path: `${out}/island-${size}.png` });
  }
  ok(!errs.length, `no page or GPU errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
  await p.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await b.close();
  await vite.close();
}
console.log(failures ? `\ngen-check: ${failures} failed` : '\ngen-check: ok');
process.exit(failures ? 1 : 0);
