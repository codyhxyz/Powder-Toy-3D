// The island's generated world, dumped and timed, for comparing two builds of
// its generator (two branches, or this build against itself: a run must be
// deterministic), on WebGPU (docs/webgpu.md G1), in manual mode: run it once
// per build, then compare the dumps.
//   - box: the Island box preset at --size (64³ by default: fill and trees),
//     its state A;
//   - world: the island world's window (?win=64) at load, then after MOVES
//     moves out and MOVES across (slab fills, no stored edits, trees planted),
//     its state A each time, and the far grid over the chunks around the
//     window once they are drawn (the whole far build is minutes of
//     SwiftShader: FAR_CHUNKS of them, the nearest);
//   - timings, the minimum of --runs: the box preset's load (GPU-synced) and a
//     window move (GPU-synced, its leaving slab read back).
// usage: node tools/island-dump.mjs <outDir> [--size 64] [--win 64] [--runs 2] [--port N]
//        node tools/island-dump.mjs --compare <dirA> <dirB>
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const MOVES = 2;           // window moves along each axis
const FAR_CHUNKS = 4;      // far chunks drawn around the window (the nearest)
const CHUNK = 1 << 22;     // bytes per base64 chunk out of the page

if (args[0] === '--compare') { process.exit(compare(args[1], args[2]) ? 0 : 1); }

const out = args[0];
if (!out || out.startsWith('--')) { console.error('usage: node tools/island-dump.mjs <outDir> [--size 64] [--win 64] [--runs 2]'); process.exit(2); }
const size = opt('size', '64');
const win = +opt('win', 64);
const runs = +opt('runs', 2);
mkdirSync(out, { recursive: true });

const vite = await startVite();
const b = await launchBrowser();
let code = 0;
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 320, height: 200 } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 400)));
  await p.addInitScript(() => {
    // bytes out of the page, a chunk at a time (base64)
    window.__dump = { bufs: {} };
    window.__keep = (name, arr) => { window.__dump.bufs[name] = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); return arr.byteLength; };
    window.__chunk = (name, i, n) => {
      const u = window.__dump.bufs[name].subarray(i, i + n);
      let s = '';
      for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000));
      return btoa(s);
    };
    // state A in cell order (x fastest, then z, then y), 4 floats a cell
    window.__cells = async (sim) => {
      const g = sim.g, [a] = await sim.readState(), c = new Float32Array(g.nx * g.ny * g.nz * 4);
      for (let y = 0; y < g.ny; y++)
        for (let z = 0; z < g.nz; z++)
          for (let x = 0; x < g.nx; x++) c.set(a.subarray(sim.cellTexel(x, y, z) * 4, sim.cellTexel(x, y, z) * 4 + 4), ((y * g.nz + z) * g.nx + x) * 4);
      return c;
    };
  });
  const save = async (name) => {
    const n = await p.evaluate((name) => window.__dump.bufs[name].byteLength, name);
    const parts = [];
    for (let i = 0; i < n; i += CHUNK) parts.push(Buffer.from(await p.evaluate(([name, i, c]) => window.__chunk(name, i, c), [name, i, CHUNK]), 'base64'));
    writeFileSync(`${out}/${name}.bin`, Buffer.concat(parts));
    await p.evaluate((name) => { delete window.__dump.bufs[name]; }, name);
  };
  const boot = async (query) => {
    await p.goto(vite.url(query));
    await p.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 150000 });
    const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
    if (failed) throw new Error(`boot ${query}: ${failed.slice(0, 400)}`);
    await p.evaluate(() => window.__app.test.ready());
  };
  const result = {};

  // ---- box
  await boot(`/?preset=island&size=${size}&view=plain`);
  result.box = await p.evaluate(async (runs) => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { loadIsland } = await import('/src/world/gpu.js');
    const ms = [];
    for (let i = 0; i < runs + 1; i++) {
      await a.gpu.fence();
      const t0 = performance.now();
      await loadIsland(sim, {});
      await a.gpu.fence();
      ms.push(performance.now() - t0);
    }
    window.__keep('box', await window.__cells(sim));
    return { dims: [g.nx, g.ny, g.nz], loadMs: ms.slice(1).map((v) => +v.toFixed(1)), firstMs: +ms[0].toFixed(1) };
  }, runs);
  await save('box');

  // ---- world: cells at load, after moves, and the far grid around the window
  await boot(`/?map=island&view=plain&win=${win}`);
  await p.waitForFunction(() => window.__app.win?.loaded, null, { polling: 250, timeout: 150000 });
  result.world = await p.evaluate(async (FAR_CHUNKS) => {
    const a = window.__app, w = a.win, sim = a.sim, g = sim.g, f = w.far;
    const o0 = [sim.origin.x, sim.origin.z];
    w.load([o0[0], 0, o0[1]]);
    f.queue = f.queue.slice(-FAR_CHUNKS);
    while (f.queue.length) { f.sceneChunks(1); await a.gpu.fence(); }
    window.__keep('far', await a.gpu.readback.texture(f.grid));
    window.__keep('win0', await window.__cells(sim));
    return { origin: o0, dims: [g.nx, g.ny, g.nz], far: f.L.bricks.n };
  }, FAR_CHUNKS);
  await save('far');
  await save('win0');
  result.moves = await p.evaluate(async (MOVES) => {
    const a = window.__app, w = a.win, log = [];
    const step = async (dx, dz) => {
      await w.pending;
      await a.gpu.fence();
      const t0 = performance.now();
      w.shift(dx, dz);
      await a.gpu.fence();
      const synced = performance.now() - t0;
      await w.pending;
      log.push({ ms: +w.last.ms.toFixed(2), synced: +synced.toFixed(1), readbackMs: +w.last.readbackMs.toFixed(1), trees: w.last.trees, restored: w.last.restored, kept: w.last.kept });
    };
    for (let i = 0; i < MOVES; i++) await step(16, 0);
    for (let i = 0; i < MOVES; i++) await step(0, 16);
    window.__keep('win1', await window.__cells(a.sim));
    return log;
  }, MOVES);
  await save('win1');
  result.errors = errs;
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  if (errs.length) code = 1;
  await p.close();
} catch (e) {
  console.log(`FAIL ${e.message}`);
  code = 1;
} finally {
  await b.close();
  await vite.close();
}
process.exit(code);

// ---------------------------------------------------------------- compare
// Every cell of the box and the two windows, and every far texel: the same in
// both dumps, or where and how they differ. Returns whether they are the same.
function compare(A, B) {
  const report = {}, dims = JSON.parse(readFileSync(`${A}/result.json`, 'utf8'));
  let same = true;
  for (const name of ['box', 'win0', 'win1']) {
    if (!existsSync(`${A}/${name}.bin`) || !existsSync(`${B}/${name}.bin`)) continue;
    const a = new Float32Array(readFileSync(`${A}/${name}.bin`).buffer.slice(0)), bb = new Float32Array(readFileSync(`${B}/${name}.bin`).buffer.slice(0));
    const [nx, , nz] = name === 'box' ? dims.box.dims : dims.world.dims, n = a.length / 4;
    let id = 0, T = 0, life = 0, w = 0, Tmax = 0;
    const kinds = {}, where = [];
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      if (a[k] !== bb[k]) {
        id++;
        const key = `${a[k]}->${bb[k]}`;
        kinds[key] = (kinds[key] ?? 0) + 1;
        if (where.length < 12) where.push([i % nx, Math.floor(i / (nx * nz)), Math.floor(i / nx) % nz]);
      } else {
        if (!Object.is(a[k + 1], bb[k + 1])) { T++; Tmax = Math.max(Tmax, Math.abs(a[k + 1] - bb[k + 1])); }
        if (!Object.is(a[k + 2], bb[k + 2])) life++;
        if (!Object.is(a[k + 3], bb[k + 3])) w++;
      }
    }
    if (id || T || life || w) same = false;
    report[name] = { cells: n, idDiffer: id, kinds, where, TDiffer: T, TmaxDiff: Tmax, lifeDiffer: life, ctypeSeedDiffer: w };
  }
  if (existsSync(`${A}/far.bin`) && existsSync(`${B}/far.bin`)) {
    const a = new Uint16Array(readFileSync(`${A}/far.bin`).buffer.slice(0)), bb = new Uint16Array(readFileSync(`${B}/far.bin`).buffer.slice(0));
    let texels = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== bb[i] || a[i + 1] !== bb[i + 1] || a[i + 2] !== bb[i + 2] || a[i + 3] !== bb[i + 3]) texels++;
    if (texels) same = false;
    report.far = { texels: a.length / 4, differ: texels };
  }
  console.log(JSON.stringify(report, null, 1));
  console.log(same ? 'island-dump: the dumps are the same' : 'island-dump: the dumps differ');
  return same;
}
