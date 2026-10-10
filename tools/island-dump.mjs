// The island's generated world, dumped and timed, for comparing two builds of
// its generator (say origin/main and a branch): run it against each build's dev
// server, then compare the dumps.
//   - box: the Island box preset at 128³ (fill and trees), its state A;
//   - world: the island world's window at load, then after MOVES moves out and
//     MOVES across (slab fills, stored edits none, trees planted), its state A
//     each time, and the far grid once complete;
//   - timings, the minimum of --runs: the box preset's load (GPU-synced), a
//     switch box → world until the window is loaded and until its far field is
//     complete, a window move (GPU-synced) and its slab fill alone.
// usage: node tools/island-dump.mjs <outDir> [--port 5391] [--runs 3]
//        node tools/island-dump.mjs --compare <dirA> <dirB>
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const MOVES = 4;           // window moves along each axis
const MOVE_RUNS = 8;       // timed moves (back and forth)
const CHUNK = 1 << 22;     // bytes per base64 chunk out of the page
const FAR_TIMEOUT = 120000;

if (args[0] === '--compare') { compare(args[1], args[2]); process.exit(0); }

const out = args[0];
const port = opt('port', '5391');
const runs = +opt('runs', 3);
mkdirSync(out, { recursive: true });

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true, size: '128', preset: 'island', scene: 'island' }));
  // cells' raw bytes out of the page, a chunk at a time (base64)
  window.__dump = { bufs: {} };
  window.__keep = (name, arr) => { window.__dump.bufs[name] = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); return arr.byteLength; };
  window.__chunk = (name, i, n) => {
    const u = window.__dump.bufs[name].subarray(i, i + n);
    let s = '';
    for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000));
    return btoa(s);
  };
  // state A in cell order (x fastest, then z, then y), 4 floats a cell
  window.__cells = (sim) => {
    const g = sim.g, [a] = sim.readState(), c = new Float32Array(g.nx * g.ny * g.nz * 4);
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) c.set(a.subarray(sim.cellTexel(x, y, z) * 4, sim.cellTexel(x, y, z) * 4 + 4), ((y * g.nz + z) * g.nx + x) * 4);
    return c;
  };
  window.__frames = (n) => new Promise((r) => { const f = () => (n-- <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 400)));
async function save(name) {
  const n = await p.evaluate((name) => window.__dump.bufs[name].byteLength, name);
  const parts = [];
  for (let i = 0; i < n; i += CHUNK) parts.push(Buffer.from(await p.evaluate(([name, i, c]) => window.__chunk(name, i, c), [name, i, CHUNK]), 'base64'));
  writeFileSync(`${out}/${name}.bin`, Buffer.concat(parts));
  await p.evaluate((name) => { delete window.__dump.bufs[name]; }, name);
}

await p.goto(`http://localhost:${port}/?size=128&preset=island`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });
await p.waitForTimeout(1500);
const result = {};

// ---- box
result.box = await p.evaluate(async (runs) => {
  const a = window.__app, sim = a.sim;
  const { loadIsland } = await import('/src/world/gpu.js');
  const ms = [];
  for (let i = 0; i < runs + 1; i++) {
    sim.gpuSync();
    const t0 = performance.now();
    loadIsland(sim, {});
    sim.gpuSync();
    ms.push(performance.now() - t0);
  }
  window.__keep('box', window.__cells(sim));
  return { loadMs: ms.slice(1).map((v) => +v.toFixed(1)), firstMs: +ms[0].toFixed(1) };
}, runs);
await save('box');

// ---- world: switches box → world
result.switches = [];
for (let r = 0; r < runs; r++) {
  const s = await p.evaluate(async (FAR_TIMEOUT) => {
    const a = window.__app;
    a.setSize('128');
    await window.__frames(10);
    const t0 = performance.now();
    a.setSize('world');
    let loaded = null;
    while (performance.now() - t0 < FAR_TIMEOUT) {
      await window.__frames(1);
      const w = a.win;
      if (!w) continue;
      if (loaded == null && w.loaded) loaded = performance.now() - t0;
      if (w.loaded && w.far?.built && w.far.ready && !w.far.queue?.length) break;
    }
    a.sim.gpuSync();
    return { loadedMs: +loaded.toFixed(0), farCompleteMs: +(performance.now() - t0).toFixed(0), farLast: a.win.far.last };
  }, FAR_TIMEOUT);
  result.switches.push(s);
}

// ---- world: cells at load, after moves, and the far grid
result.world = await p.evaluate(async () => {
  const a = window.__app, w = a.win, sim = a.sim;
  a.settings.paused = true;
  const o0 = [sim.origin.x, sim.origin.z];
  // the app's focus held on the window's centre, so only these moves move it
  const hold = () => { a.worldFocus = [sim.origin.x + sim.g.nx / 2, sim.origin.z + sim.g.nz / 2]; };
  window.__hold = hold;
  hold();
  w.load([o0[0], 0, o0[1]]);
  while (w.far.queue?.length) await window.__frames(1);
  window.__keep('far', (() => {
    // RGBA16F holding whole numbers (shaders/far.js): as float32s
    const t = w.far.grid, buf = new Uint16Array(t.width * t.height * 4);
    a.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    return Float32Array.from(buf, (h) => a.THREE.DataUtils.fromHalfFloat(h));
  })());
  window.__keep('win0', window.__cells(sim));
  return { origin: o0 };
});
await save('far');
await save('win0');
const moveLog = await p.evaluate(async (MOVES) => {
  const a = window.__app, w = a.win, log = [];
  const step = async (dx, dz) => {
    while (w.pending) await window.__frames(1);
    w.shift(dx, dz);
    window.__hold();
    log.push({ ...w.last });
    while (w.pending) await window.__frames(1);
  };
  for (let i = 0; i < MOVES; i++) await step(16, 0);
  for (let i = 0; i < MOVES; i++) await step(0, 16);
  window.__keep('win1', window.__cells(a.sim));
  return log.map((l) => ({ ms: +l.ms.toFixed(2), trees: l.trees, restored: l.restored }));
}, MOVES);
await save('win1');
result.moves = moveLog;

// ---- timings: a move, GPU-synced, and its slab fill alone
result.moveTiming = await p.evaluate(async (MOVE_RUNS) => {
  const a = window.__app, w = a.win, sim = a.sim, g = sim.g;
  const move = [], fill = [], diff = [];
  for (let i = 0; i < MOVE_RUNS; i++) {
    while (w.pending) await window.__frames(1);
    sim.gpuSync();
    const d = i % 2 ? -16 : 16, t0 = performance.now();
    w.shift(d, 0);
    sim.gpuSync();
    move.push(performance.now() - t0);
    window.__hold();
    while (w.pending) await window.__frames(1);
  }
  const o = sim.origin;
  for (let i = 0; i < MOVE_RUNS; i++) {
    const lo = [i % 2 ? 0 : g.nx - 16, 0, 0], hi = [lo[0] + 16, g.ny, g.nz];
    // (alternating origins: the column pass, where there is one, runs every time, as on a move)
    const origin = [o.x + (i % 2 ? 16 : 0), 0, o.z];
    sim.gpuSync();
    let t0 = performance.now();
    w.gen.fill(w.P, origin, lo, hi);
    sim.gpuSync();
    fill.push(performance.now() - t0);
    t0 = performance.now();
    w.gen.diff(w.P, lo, [4, g.ny / 4, g.nz / 4], w.diffTarget);
    sim.gpuSync();
    diff.push(performance.now() - t0);
  }
  const st = (v) => ({ min: +Math.min(...v).toFixed(2), median: +v.sort((x, y) => x - y)[v.length >> 1].toFixed(2) });
  return { moveMs: st(move), slabFillMs: st(fill), slabDiffMs: st(diff) };
}, MOVE_RUNS);
result.errors = errs;
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await b.close();

// ---------------------------------------------------------------- compare
function compare(A, B) {
  const report = {};
  for (const name of ['box', 'win0', 'win1']) {
    if (!existsSync(`${A}/${name}.bin`) || !existsSync(`${B}/${name}.bin`)) continue;
    const a = new Float32Array(readFileSync(`${A}/${name}.bin`).buffer.slice(0)), bb = new Float32Array(readFileSync(`${B}/${name}.bin`).buffer.slice(0));
    const n = a.length / 4, side = Math.round(Math.cbrt(n));
    let id = 0, T = 0, life = 0, w = 0, Tmax = 0;
    const kinds = {}, where = [];
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      if (a[k] !== bb[k]) {
        id++;
        const key = `${a[k]}->${bb[k]}`;
        kinds[key] = (kinds[key] ?? 0) + 1;
        if (where.length < 12) where.push([i % side, Math.floor(i / (side * side)), Math.floor(i / side) % side]);
      } else {
        if (a[k + 1] !== bb[k + 1]) { T++; Tmax = Math.max(Tmax, Math.abs(a[k + 1] - bb[k + 1])); }
        if (a[k + 2] !== bb[k + 2]) life++;
        if (a[k + 3] !== bb[k + 3]) w++;
      }
    }
    report[name] = { cells: n, idDiffer: id, kinds, where, TDiffer: T, TmaxDiff: Tmax, lifeDiffer: life, ctypeSeedDiffer: w };
  }
  if (existsSync(`${A}/far.bin`) && existsSync(`${B}/far.bin`)) {
    const a = new Float32Array(readFileSync(`${A}/far.bin`).buffer.slice(0)), bb = new Float32Array(readFileSync(`${B}/far.bin`).buffer.slice(0));
    let texels = 0, maxCh = 0;
    for (let i = 0; i < a.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - bb[i + c]));
      if (d) { texels++; maxCh = Math.max(maxCh, d); }
    }
    report.far = { texels: a.length / 4, differ: texels, maxChannelDiff: maxCh };
  }
  console.log(JSON.stringify(report, null, 1));
}
