// Headless GPU check of the island's caves (src/world/island/caves.js) in
// World mode on WebGPU (docs/webgpu.md G1), through a small window (?win=64:
// the container's budget), in manual mode, at the places tools/caves-preview.mjs
// found (its spots.json: a hillside mouth, a shaft, an underground lake, a
// crystal cavern, a long tunnel) or, without one, at a cave mouth and a cave
// the JS twin finds near the world's start. For each, the window loaded there:
//   - the JS twin against the GPU: every cell of a fill without trees against
//     islandCellAt with the World's structures in (structureCellAt), the cells
//     the island's prepass made (its caves) read back through sceneCell;
//   - seams: a fill at an origin shifted by a window step matches the
//     overlapping cells (all of state A), and a slab fill (a window move's)
//     leaves the rest of the window as the full fill made it;
//   - fill time: a full window fill and a slab fill, GPU-synced, the minimum of --runs.
// Then islandCaveMouth (the structures layer's mouth query) on the GPU, a
// kernel over the window's columns, against its twin at each spot.
// Give the spots over several runs (--spots hill,shaft) to keep each under 3
// minutes here.
// usage: node tools/caves-check.mjs [spots.json] [--spots hill,shaft] [--win 64] [--runs 2] [--port N]
import { readFileSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const file = args[0] && !args[0].startsWith('--') ? args[0] : null;
const WIN = +opt('win', 64);
const runs = +opt('runs', 2);
const STEP = 16;   // a window move (world/window.js WIN_STEP)
const SEARCH = 256;   // cells around the world's start the twin looks for a mouth and a cave in (no spots.json)
const spotsFile = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
const names = opt('spots', spotsFile ? 'hill,shaft' : 'mouth,cave').split(',');

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
  await p.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 400)}`);
  await p.evaluate(() => window.__app.test.ready());

  // the spots: spots.json's, or a mouth and a cave the twin finds near the start
  const spots = spotsFile ?? await p.evaluate(async (SEARCH) => {
    const a = window.__app, w = a.win, P = w.P, o = a.sim.origin, g = a.sim.g;
    const { islandTwin, islandCellAt } = await import('/src/world/generator.js');
    const { E } = await import('/src/elements.js');
    const T = islandTwin(P), out = {};
    const c = [o.x + g.nx / 2, o.z + g.nz / 2];
    for (let r = 0; r <= SEARCH && !(out.mouth && out.cave); r += 8)
      for (let k = 0; k < Math.max(1, r) && !(out.mouth && out.cave); k += 4) {
        const ang = (k / Math.max(1, r)) * 2 * Math.PI, x = Math.round(c[0] + r * Math.cos(ang)), z = Math.round(c[1] + r * Math.sin(ang));
        if (x < 0 || z < 0 || x >= P.size[0] || z >= P.size[2]) continue;
        if (!out.mouth && T.islandCaveMouth(x, z) > 0) out.mouth = { at: [x, 0, z] };
        if (!out.cave) {
          const top = Math.floor(T.column(x, z)[0]);
          for (let y = Math.max(1, Math.floor(P.sea)); y < top - 4; y += 2) {
            if (islandCellAt(x, y, z, P) === E.EMPTY) { out.cave = { at: [x, y, z] }; break; }
          }
        }
      }
    return out;
  }, SEARCH);

  for (const name of names) {
    const s = spots[name];
    if (!s) { ok(false, `${name}: no such spot${spotsFile ? ' in the spots file' : ' found near the start'}`); continue; }
    const at = s.at ?? s.feet;
    const r = await p.evaluate(async ([at, runs, STEP]) => {
      const a = window.__app, sim = a.sim, g = sim.g, w = a.win, P = w.P, gpu = a.gpu;
      const { islandCellAt } = await import('/src/world/generator.js');
      const { structureCellAt } = await import('/src/world/structures.js');
      const { ELEMENTS } = await import('/src/elements.js');
      const cellAt = (x, y, z) => structureCellAt(P, x, y, z, islandCellAt(x, y, z, P), (yy) => islandCellAt(x, yy, z, P));
      const name = (id) => ELEMENTS[id]?.key ?? id;
      // the window's origin that puts the spot in its middle (whole window steps, inside the world)
      const snap = (v, n, span) => Math.max(0, Math.min(n - span, Math.round((v - span / 2) / STEP) * STEP));
      const O = [snap(at[0], w.size[0], g.nx), snap(at[2], w.size[2], g.nz)];
      a.worldLoad([O[0], 0, O[1]]);
      const stateA = async () => (await sim.readState())[0];
      // the twin vs the GPU (the generator alone)
      w.gen.fill(P, [O[0], 0, O[1]]);
      const A0 = await stateA(), kinds = {}, where = [];
      let differ = 0;
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const cpu = cellAt(O[0] + x, y, O[1] + z), gid = Math.round(A0[sim.cellTexel(x, y, z) * 4]);
        if (cpu === gid) continue;
        differ++;
        const k = `${name(cpu)}/${name(gid)}`;
        kinds[k] = (kinds[k] ?? 0) + 1;
        if (where.length < 4) where.push([O[0] + x, y, O[1] + z]);
      }
      // seams: a fill a window step over matches where the two overlap; a slab fill keeps the rest
      w.gen.fill(P, [O[0] + STEP, 0, O[1] + STEP]);
      const A1 = await stateA();
      let seam = 0;
      for (let y = 0; y < g.ny; y++) for (let z = STEP; z < g.nz; z++) for (let x = STEP; x < g.nx; x++) {
        const i = sim.cellTexel(x, y, z) * 4, k = sim.cellTexel(x - STEP, y, z - STEP) * 4;
        for (let c = 0; c < 4; c++) if (!Object.is(A0[i + c], A1[k + c])) { seam++; break; }
      }
      w.gen.fill(P, [O[0], 0, O[1]]);
      w.gen.fill(P, [O[0], 0, O[1]], [0, 0, 0], [STEP, g.ny, g.nz]);
      const A2 = await stateA();
      let slab = 0;
      for (let i = 0; i < A0.length; i += 4) for (let c = 0; c < 4; c++) if (!Object.is(A0[i + c], A2[i + c])) { slab++; break; }
      // fill time
      const time = async (fn) => { await gpu.fence(); const t = performance.now(); fn(); await gpu.fence(); return performance.now() - t; };
      const full = [], part = [];
      for (let i = 0; i < runs; i++) {
        full.push(await time(() => w.gen.fill(P, [O[0], 0, O[1]])));
        part.push(await time(() => w.gen.fill(P, [O[0], 0, O[1]], [0, 0, 0], [STEP, g.ny, g.nz])));
      }
      // islandCaveMouth over the window's columns, on the GPU, against the twin
      const { prelude } = await import('/src/shaders/common.js');
      const { sceneLayout, SCENE_BINDING } = await import('/src/world/scenes/sceneGpu.js');
      const { islandTwin } = await import('/src/world/generator.js');
      const res = w.gen.res;
      const MouthParams = (await import('/src/gpu/params.js')).uniformStruct('MouthParams', { lo: 'vec2i' });
      const layout = gpu.layout('caves-check mouth', [...sceneLayout({ data: true }), { binding: SCENE_BINDING.next, buffer: { type: 'storage' } }]);
      const kernel = gpu.kernel({
        name: 'caves-check mouth', layouts: [sim.L.TABLES, gpu.L.EMPTY, layout], params: MouthParams,
        code: `${prelude(g, { state: false })}\n${w.scene.glsl(g)}\n${MouthParams.wgsl}\n@group(3) @binding(1) var<uniform> MP: MouthParams;\n`
          + `@group(2) @binding(${SCENE_BINDING.next}) var<storage, read_write> mouth: array<f32>;\n`
          + `@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {\n`
          + `  if (id.x >= ${g.nx * g.nz}u) { return; }\n  let c = MP.lo + vec2i(i32(id.x % ${g.nx}u), i32(id.x / ${g.nx}u));\n`
          + `  mouth[id.x] = islandCaveMouth(c.x, c.y);\n}\n`,
      });
      await kernel.ready;
      const buf = gpu.createBuffer({ label: 'caves-check mouth', size: g.nx * g.nz * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const group = gpu.bindGroup(layout, res.entries([{ binding: SCENE_BINDING.next, resource: { buffer: buf } }]), 'caves-check mouth');
      kernel.dispatch(gpu.frame, [Math.ceil(g.nx * g.nz / 64), 1, 1], { bind: [sim.tables, null, group], params: { lo: O } });
      const px = new Float32Array(await gpu.readback.buffer(buf));
      buf.destroy();
      const T = islandTwin(P);
      let open = 0, mouthDiffer = 0;
      for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
        const cpu = T.islandCaveMouth(O[0] + i, O[1] + j);
        if (cpu > 0) open++;
        if (px[j * g.nx + i] !== cpu) mouthDiffer++;
      }
      const ms = (v) => +Math.min(...v).toFixed(1);
      return { origin: O, cells: g.nx * g.ny * g.nz, twin: { differ, kinds, where }, seams: { shifted: seam, slab }, fillMs: ms(full), slabFillMs: ms(part), mouth: { columns: g.nx * g.nz, open, differ: mouthDiffer } };
    }, [at, runs, STEP]);
    ok(r.twin.differ === 0, `${name} (window at ${r.origin}): the twin against the fill: ${r.twin.differ} of ${r.cells} cells differ${r.twin.differ ? ` (${JSON.stringify(r.twin.kinds)} at ${JSON.stringify(r.twin.where)})` : ''}`);
    ok(r.seams.shifted === 0 && r.seams.slab === 0, `${name}: seams: ${r.seams.shifted} cells differ a step over, ${r.seams.slab} after a slab fill`);
    ok(r.mouth.differ === 0, `${name}: islandCaveMouth on the GPU against the twin: ${r.mouth.differ} of ${r.mouth.columns} columns differ (${r.mouth.open} open)`);
    console.log(`${name}: fill ${r.fillMs} ms, slab fill ${r.slabFillMs} ms (${secs()})`);
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
console.log(failures ? `\ncaves-check: ${failures} failed` : `\ncaves-check: ok (${secs()})`);
process.exit(failures ? 1 : 0);
