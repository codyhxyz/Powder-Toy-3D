// Headless GPU check of the island's landforms and strata (src/world/island)
// on WebGPU (docs/webgpu.md G1), as tools/gen-check.mjs checks the generator,
// but over the World's island (worldParams at WORLD_SIZE, which has the
// landforms; no structures: the twin is islandCell alone), through the World
// map's window (?win=64: 64 × 128 × 64, the container's budget), a window
// around each landform, in manual mode:
//   - the column bake against the JS twin: heights (and the ground they round
//     to), water levels and bare columns, over every BAKE_STRIDE-th column;
//   - each window's fill against the twin's islandCell, cell for cell;
//   - seams: the window filled at an origin SHIFT further matches the overlap
//     exactly, and a slab fill keeps the cells outside it.
// Give the landforms over several runs (--sites ria-mouth,mesa) to keep each
// under 3 minutes here; --list prints them.
// usage: node tools/landforms-gpu.mjs [--sites a,b] [--list] [--seed N] [--win 64] [--port N]
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const seed = opt('seed', null);
const only = opt('sites', null)?.split(',');
const list = args.includes('--list');
const WIN = +opt('win', 64);
const SHIFT = 16;            // cells: the seam check's origin shift (D11's window step)
const BAKE_STRIDE = 2;       // columns compared with the twin: every this many along x and z
const SITES_DEFAULT = 3;     // landforms a run checks without --sites (the first ones)
const HEIGHT_EPS = 1e-3;     // cells: the bake's heights against the twin's (floats against doubles; the ground they round to is exact)

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
  await p.goto(vite.url(`/?map=island&view=plain&win=${WIN}`));
  await p.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 300000 });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 400)}`);
  await p.evaluate(() => window.__app.test.ready());

  // the world, its generator on the window's grid, the bake against the twin, the sites
  const head = await p.evaluate(async ([seed, BAKE_STRIDE]) => {
    const a = window.__app, sim = a.sim, gpu = a.gpu;
    const { WorldGenerator } = await import('/src/world/gpu.js');
    const { island } = await import('/src/world/scenes/island.js');
    const { worldParams, islandTwin, GEN, COLUMN_MARGIN: M } = await import('/src/world/generator.js');
    const { WORLD_SIZE } = await import('/src/shaders/farShared.js');
    const P = worldParams({ size: WORLD_SIZE, seed: seed == null ? undefined : +seed, snow: false });
    const T = islandTwin(P), S = P.landforms;
    const gen = window.__lfGen = new WorldGenerator(sim, island, P);
    window.__lfP = P;
    await gen.ready;
    const cw = P.size[0] + 2 * M, ch = P.size[2] + 2 * M;
    const cols = new Float32Array(await gpu.readback.buffer(gen.res.data, 0, cw * ch * 16));
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
    const sites = [];
    if (S.ria) {
      const q = S.ria, along = (u) => [q.x + q.dx * u - q.dz * T.lfMeander(u), q.z + q.dz * u + q.dx * T.lfMeander(u)];
      sites.push(['ria-mouth', q.x, q.z], ['ria-gorge', ...along(0.6 * q.len)], ['ria-head', ...along(q.len)]);
    }
    if (S.mesa) sites.push(['mesa', S.mesa.x, S.mesa.z]);
    S.lakes.forEach((l, i) => sites.push([`tarn-${i}`, l.x, l.z]));
    S.stacks.slice(0, 2).forEach((s, i) => sites.push([`stack-${i}`, s.x, s.z]));
    return { seed: P.seed, sites, bake: { compared, maxHeight, groundDiff, waterDiff, bareDiff } };
  }, [seed, BAKE_STRIDE]);
  if (list) console.log(`landforms: ${head.sites.map((s) => s[0]).join(', ')}`);
  const bk = head.bake;
  ok(bk.maxHeight <= HEIGHT_EPS && !bk.groundDiff && !bk.waterDiff && !bk.bareDiff,
    `the column bake against the twin over ${bk.compared} columns: max height difference ${bk.maxHeight.toExponential(2)} (at most ${HEIGHT_EPS}), ${bk.groundDiff} ground, ${bk.waterDiff} water level and ${bk.bareDiff} bare columns differ (${secs()})`);

  const sites = head.sites.filter(([label], i) => (only ? only.includes(label) : i < SITES_DEFAULT));
  for (const [label, cx, cz] of sites) {
    const w = await p.evaluate(async ([cx, cz, SHIFT]) => {
      const a = window.__app, sim = a.sim, g = sim.g, gen = window.__lfGen, P = window.__lfP;
      const { islandTwin } = await import('/src/world/generator.js');
      const { ELEMENTS } = await import('/src/elements.js');
      const T = islandTwin(P);
      const name = (id) => ELEMENTS[id]?.key ?? id;
      const clampO = (v, n, size) => Math.max(0, Math.min(size - n - SHIFT, Math.round((v - n / 2) / 16) * 16));
      const o = [clampO(cx, g.nx, P.size[0]), 0, clampO(cz, g.nz, P.size[2])];
      const readA = async () => (await sim.readState())[0];
      const at = (x, y, z) => sim.cellTexel(x, y, z) * 4;
      gen.fill(P, o);
      const base = await readA();
      let twin = 0;
      const kinds = {};
      for (let y = 0; y < g.ny; y++)
        for (let z = 0; z < g.nz; z++)
          for (let x = 0; x < g.nx; x++) {
            const gid = Math.round(base[at(x, y, z)]), cpu = T.islandCell(o[0] + x, y, o[2] + z);
            if (gid !== cpu) { twin++; const k = `${name(gid)}/${name(cpu)}`; kinds[k] = (kinds[k] ?? 0) + 1; }
          }
      const s = [o[0] + SHIFT, 0, o[2] + SHIFT];
      gen.fill(P, s);
      const shifted = await readA();
      let seam = 0, slab = 0;
      for (let y = 0; y < g.ny; y++)
        for (let z = 0; z < g.nz - SHIFT; z++)
          for (let x = 0; x < g.nx - SHIFT; x++) {
            const i = at(x, y, z), k = at(x + SHIFT, y, z + SHIFT);
            for (let c = 0; c < 4; c++) if (!Object.is(shifted[i + c], base[k + c])) { seam++; break; }
          }
      gen.fill(P, o);
      gen.fill(P, s, [0, 0, 0], [SHIFT, g.ny, g.nz]);
      const mixed = await readA();
      for (let y = 0; y < g.ny; y++)
        for (let z = 0; z < g.nz; z++)
          for (let x = 0; x < g.nx; x++) {
            const i = at(x, y, z), want = x < SHIFT ? shifted : base;
            for (let c = 0; c < 4; c++) if (!Object.is(mixed[i + c], want[i + c])) { slab++; break; }
          }
      return { origin: o, cells: g.nx * g.ny * g.nz, twin, kinds, seam, slab };
    }, [cx, cz, SHIFT]);
    ok(w.twin === 0, `${label} (window at ${w.origin[0]}, ${w.origin[2]}): the fill against islandCell: ${w.twin} of ${w.cells} cells differ${w.twin ? ` (${JSON.stringify(w.kinds)})` : ''}`);
    ok(w.seam === 0 && w.slab === 0, `${label}: seams: ${w.seam} cells differ ${SHIFT} cells over, ${w.slab} after a slab fill (${secs()})`);
  }
  await p.evaluate(() => window.__lfGen.dispose());
  ok(!errs.length, `no page or GPU errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
  await p.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await b.close();
  await vite.close();
}
console.log(failures ? `\nlandforms-gpu: ${failures} failed` : `\nlandforms-gpu: ok (${secs()})`);
process.exit(failures ? 1 : 0);
