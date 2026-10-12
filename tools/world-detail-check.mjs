// Headless check of the world's detail meshes (world/detail.js,
// docs/world-lod.md) on WebGPU (docs/webgpu.md G1), through a small window
// (?win=64: the container's budget), in manual mode, on the Lab Complex:
//   - the cells a chunk is meshed from (shaders/far.js farSceneCellsFrag's
//     live variant, `<scene> detailCells`): where the chunk's padding overlaps
//     the window they are its live cells, element and temperature;
//   - the cache: the nearest wanted chunks are read back, meshed in the worker
//     and kept (at most CHUNKS of them here: each is a readback and a mesh),
//     inside the budget, each with its mask entry set;
//   - the draw: the frame with the meshes (and their chunks' field left to them)
//     differs from the coarse field's alone over more than MIN_CHANGED of the
//     canvas, and nothing fails;
//   - the stale-job contract: a job valid before an invalidate isn't after
//     it, and the chunk's mesh and mask entry are gone.
// usage: node tools/world-detail-check.mjs [outDir] [--map labWorld] [--win 64] [--port N]
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const MAP = opt('map', 'labWorld');
const WIN = +opt('win', 64);
const FAR_CHUNKS = 2;        // far chunks built around the window (the nearest: the coarse field the meshes replace)
const CHUNKS = 4;            // detail chunks meshed (the nearest wanted)
const MIN_CHANGED = 0.005;   // share of the canvas the meshes must change
const DIFF = 12;             // levels (0-255) a pixel must change by to count
const MAX_BYTES = 96 * 1024 * 1024;   // world/detail.js's
if (out) mkdirSync(out, { recursive: true });

const vite = await startVite();
const b = await launchBrowser();
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 192, height: 120 } });
  // only the canvas in the shots
  await p.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = 'body *{visibility:hidden !important} canvas{visibility:visible !important}';
    document.head.appendChild(st);
  }));
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 600)));
  await p.goto(vite.url(`/?map=${MAP}&win=${WIN}`));
  await p.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 200000 });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 400)}`);
  await p.evaluate(() => window.__app.test.ready());
  console.log(`booted ${MAP} (${secs()})`);

  // the far chunks around the window, the pipelines; the camera low by the
  // window's -x side (+x at the world's edge), looking out over the world beside it
  const head = await p.evaluate(async (N) => {
    const a = window.__app, f = a.win.far, d = f.detail, gpu = a.gpu;
    f.queue = f.queue.slice(-N);
    while (f.queue.length) { f.sceneChunks(1); await gpu.fence(); }
    await Promise.all([f.viewPipe.build(), d.stage.build(), d.pipe.build()]);
    a.post.settings.taa = false;
    a.day.fixed = { az: 215, el: 38 };
    const g = a.sim.g, s = a.scale, v = a.volume.position;
    const out = window.__out = a.sim.origin.x >= 64 ? -1 : 1;
    const edge = out < 0 ? 0 : g.nx - 1, ground = Math.floor(a.win.scene.ground(a.sim.origin.x + edge, a.sim.origin.z + g.nz / 2, a.win.P));
    const scene = (q) => [v.x + q[0] * s, v.y + q[1] * s, v.z + q[2] * s];
    a.camera.position.set(...scene([edge - 8 * out, ground + 24, g.nz / 2]));
    a.controls.target.set(...scene([edge + 40 * out, ground, g.nz / 2 + 8]));
    a.controls.update();
    await a.test.renderOnce();
    return { stage: d.stage.state, pipe: d.pipe.state, wanted: d.wanted.length, nx: d.nx, nz: d.nz };
  }, FAR_CHUNKS);
  ok(head.stage === 'ready' && head.pipe === 'ready' && head.wanted > 0,
    `the detail kernel ${head.stage}, its pipeline ${head.pipe}; the view wants ${head.wanted} of ${head.nx * head.nz} chunks (${secs()})`);

  // the cells of the chunk by the window's edge (its padding reaches into the
  // window) against the window's live cells
  const cells = await p.evaluate(async () => {
    const a = window.__app, d = a.win.far.detail, sim = a.sim, g = sim.g, o = sim.origin, gpu = a.gpu;
    const { SCENE_CELLS_BINDING, sceneCellsDispatch } = await import('/src/shaders/far.js');
    const C = 32, PAD = 4, S = d.layout;
    const cx = Math.floor((window.__out < 0 ? o.x - 1 : o.x + g.nx) / C) * C, cz = Math.floor((o.z + g.nz / 2) / C) * C;   // the chunk just outside, at the window's middle
    const lo = [cx - PAD, -PAD, cz - PAD];
    const res = a.win.gen.res;
    res.prepassFor([Math.max(0, lo[0]), 0, Math.max(0, lo[2])], [lo[0] + S.side, a.win.size[1], lo[2] + S.side]);
    d.group ??= gpu.bindGroup(d.stage.groups[2], res.entries([{ binding: SCENE_CELLS_BINDING, resource: { buffer: d.cells } }]), 'detail cells');
    d.stage.dispatch(gpu.frame, sceneCellsDispatch(S), { bind: [sim.tables, sim.bindRO, d.group], header: sim.header(), params: { chunkLo: [lo[0], lo[2]] } });
    const raw = new Uint32Array(await gpu.readback.buffer(d.cells));
    const A = (await sim.readState())[0];
    const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = h >> 15 ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
    let inside = 0, idDiff = 0, tDiff = 0, bad = 0, solid = 0;
    for (let y = 0; y < Math.min(g.ny, a.win.size[1]); y++)
      for (let z = 0; z < S.side; z++)
        for (let x = 0; x < S.side; x++) {
          const w = raw[x + S.side * (z + S.side * y)], id = half(w & 0xffff), t = half(w >>> 16);
          if (!Number.isInteger(id) || id < 0 || id > 255) bad++;
          if (id) solid++;
          const wx = lo[0] + x, wz = lo[2] + z;
          if (wx < o.x || wx >= o.x + g.nx || wz < o.z || wz >= o.z + g.nz || wx < 0 || wz < 0) continue;
          inside++;
          const k = sim.cellTexel(wx - o.x, y - o.y, wz - o.z) * 4;
          if (id !== Math.round(A[k])) idDiff++;
          if (Math.abs(t - A[k + 1]) > Math.max(0.5, Math.abs(A[k + 1]) / 512)) tDiff++;   // (a half's precision)
        }
    return { chunk: [cx, cz], inside, idDiff, tDiff, bad, solid, cells: S.side * S.side * a.win.size[1] };
  });
  ok(cells.inside > 0 && !cells.idDiff && !cells.tDiff && !cells.bad && cells.solid > 0,
    `the cells of chunk ${cells.chunk}: ${cells.inside} in the window, ${cells.idDiff} elements and ${cells.tDiff} temperatures differ from its live cells; ${cells.bad} not an element, ${cells.solid} of ${cells.cells} not empty (${secs()})`);

  // the nearest wanted chunks meshed
  const cache = await p.evaluate(async (N) => {
    const a = window.__app, d = a.win.far.detail, gpu = a.gpu;
    const until = performance.now() + 120000;
    while (d.entries.size < Math.min(N, d.wanted.length) && !d.failed && performance.now() < until) {
      if (!d.pending) d.tick();
      await gpu.fence();
      await new Promise((r) => setTimeout(r, 50));
      if (!d.pending && d.blocked.size >= d.wanted.length) break;
    }
    while (d.pending && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
    await a.test.renderOnce();   // (the mask uploaded)
    const keys = [...d.entries.keys()];
    return {
      entries: keys.length, bytes: d.bytes, failed: !!d.failed, wanted: d.wanted.length, blocked: d.blocked.size,
      masked: keys.filter((k) => d.mask[k] === 1 || d.mask[k] === 2).length,
      empty: d.wanted.slice(0, N).filter((c) => !d.entries.has(c.key)).length,
      indices: keys.reduce((n, k) => n + d.entries.get(k).count, 0),
    };
  }, CHUNKS);
  ok(!cache.failed && cache.entries > 0 && cache.masked === cache.entries && cache.bytes <= MAX_BYTES,
    `the cache: ${cache.entries} chunks meshed (${cache.indices / 3} triangles, ${(cache.bytes / 1048576).toFixed(1)} MiB) of the ${cache.wanted} wanted, each masked (${cache.masked}); ${cache.empty} of the nearest ${CHUNKS} without a mesh, ${cache.blocked} blocked (${secs()})`);

  // the frame with the meshes against the coarse field's alone (with outDir: both shot)
  const ms = await p.evaluate(async () => {
    const a = window.__app;
    a.test.resetView();
    const t = performance.now();
    window.__shot = await a.test.renderOnce({ capture: true });
    return performance.now() - t;
  });
  if (out) await p.screenshot({ path: `${out}/detail.png` });
  await p.evaluate(async () => {
    const a = window.__app, d = a.win.far.detail;
    window.__restore = { mask: d.mask.slice(), draw: d.draw };
    d.mask.fill(0); d.maskDirty = true; d.draw = () => 0;
    a.test.resetView();
    window.__bare = await a.test.renderOnce({ capture: true });
  });
  if (out) await p.screenshot({ path: `${out}/coarse.png` });
  const frame = await p.evaluate(async (DIFF) => {
    const a = window.__app, d = a.win.far.detail, shot = window.__shot, bare = window.__bare;
    d.mask.set(window.__restore.mask); d.maskDirty = true; d.draw = window.__restore.draw;
    await a.test.renderOnce();
    let n = 0;
    for (let i = 0; i < shot.data.length; i += 4) {
      if (Math.max(Math.abs(shot.data[i] - bare.data[i]), Math.abs(shot.data[i + 1] - bare.data[i + 1]), Math.abs(shot.data[i + 2] - bare.data[i + 2])) > DIFF) n++;
    }
    return { changed: n / (shot.width * shot.height), visible: d.visible };
  }, DIFF);
  ok(frame.visible && frame.changed >= MIN_CHANGED,
    `the draw: ${(100 * frame.changed).toFixed(1)}% of the canvas changed by the meshes (floor ${100 * MIN_CHANGED}%; a frame ${ms.toFixed(0)} ms; ${secs()})`);

  // the stale-job contract (nothing persisted changes)
  const own = await p.evaluate(() => {
    const d = window.__app.win.far.detail, c = d.wanted.find((c) => d.entries.has(c.key));
    if (!c) return null;
    const token = { ...c, epoch: d.epoch, revision: d.revisions[c.key] };
    const before = d.valid(token);
    d.invalidate([c.x, 0, c.z], [32, 128, 32]);
    return { before, after: d.valid(token), mask: d.mask[c.key], mesh: d.entries.has(c.key) };
  });
  ok(own && own.before && !own.after && !own.mask && !own.mesh,
    `invalidate: a job valid before (${own?.before}) isn't after (${own?.after}), the chunk's mask ${own?.mask} and mesh ${own?.mesh ? 'kept' : 'gone'}`);
  ok(!errs.length, `no page or GPU errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
  await p.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await b.close();
  await vite.close();
}
console.log(failures ? `\nworld-detail-check: ${failures} failed` : `\nworld-detail-check: ok (${secs()})`);
process.exit(failures ? 1 : 0);
