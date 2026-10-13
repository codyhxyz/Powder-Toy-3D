// Headless check of the far field (docs/scaling.md D11, phase W4; docs/webgpu.md
// G1) on WebGPU, through a small window (?win=64: the container's budget), in
// manual mode. Each stage is its own boot (--stage):
//   trees: the far field's tree placement on the GPU (a candidate per brick
//          column, thinned: shaders/far.js farTreeCandFrag, farTreeThinFrag)
//          against treesIn's (the window plants those) over a region of the
//          island around its start: every trunk, kind, size and ground;
//   edit:  a wall of lava built in the window (the Lab Complex), then the
//          window moved away until it has left: the far grid holds it where it
//          was (the leaving slab's summary, farWinFrag): lava bricks, glowing;
//   view:  the realistic view of a world, the chunks around the window built:
//          the far view's pipeline builds, draws (the frame differs from one
//          without it over more than MIN_CHANGED of the canvas) and nothing
//          fails. A frame of the far view is seconds of SwiftShader: a small
//          canvas.
// usage: node tools/far-check.mjs [outDir] [--stage trees,edit,view] [--win 64] [--port N]
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : null;
const STAGES = opt('stage', 'trees,edit').split(',');
const WIN = +opt('win', 64);
const TREE_REACH = 192;      // cells around the window's centre where the tree placements are compared
const VIEW_CHUNKS = 9;       // far chunks built around the window for the view (the nearest)
const MIN_CHANGED = 0.05;    // share of the canvas the far view must change
const DIFF = 12;             // levels (0-255) a pixel must change by to count
if (out) mkdirSync(out, { recursive: true });

const vite = await startVite();
const b = await launchBrowser();
let failures = 0;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
async function boot(query, viewport = { width: 320, height: 200 }) {
  const p = await newTestPage(b, { mode: 'manual', viewport });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 600)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 600)));
  await p.goto(vite.url(query));
  await p.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 300000 });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot ${query}: ${failed.slice(0, 400)}`);
  await p.evaluate(() => window.__app.test.ready());
  return { p, errs };
}
try {
  // ------------------------------------------------------------- trees
  if (STAGES.includes('trees')) {
    const { p, errs } = await boot(`/?map=island&view=plain&win=${WIN}`);
    const r = await p.evaluate(async (REACH) => {
      const a = window.__app, w = a.win, f = w.far, o = a.sim.origin, g = a.sim.g;
      const { treesIn, TREE } = await import('/src/world/generator.js');
      const { TREE_VARIANTS } = await import('/src/shaders/far.js');
      const { BRICK } = await import('/src/shaders/common.js');
      const [bx, , bz] = f.L.bricks.n;
      f.queue = [];
      f.groups();
      const map = f.placeTrees();
      const buf = new Float32Array(await a.gpu.readback.buffer(map));
      const c = [o.x + g.nx / 2, o.z + g.nz / 2];
      const R = [Math.max(0, c[0] - REACH), Math.max(0, c[1] - REACH), Math.min(w.size[0], c[0] + REACH), Math.min(w.size[2], c[1] + REACH)];
      const gpu = new Map();   // trunk column → { variant, size, ground }
      for (let i = 0; i < bx * bz; i++) {
        if (!buf[i * 4]) continue;
        const k = buf[i * 4] - 1, cx = i % bx, cz = Math.floor(i / bx);
        const x = cx * BRICK + (k % BRICK), z = cz * BRICK + (Math.floor(k / BRICK) % BRICK);
        if (x < R[0] || x >= R[2] || z < R[1] || z >= R[3]) continue;
        const rest = Math.floor(k / (BRICK * BRICK));
        gpu.set(`${x},${z}`, { variant: TREE_VARIANTS[rest % TREE_VARIANTS.length], size: TREE.SIZE_MIN + Math.floor(rest / TREE_VARIANTS.length), ground: buf[i * 4 + 1] });
      }
      const js = treesIn(R[0], R[1], R[2], R[3], w.P);
      let same = 0, differ = 0, onlyJs = 0;
      for (const t of js) {
        const key = `${t.x},${t.z}`, gt = gpu.get(key);
        if (!gt) { onlyJs++; continue; }
        gpu.delete(key);
        if (gt.variant === t.variant && gt.size === t.size && gt.ground === t.y) same++; else differ++;
      }
      return { region: R, treesIn: js.length, same, differ, onlyTreesIn: onlyJs, onlyGpu: gpu.size };
    }, TREE_REACH);
    ok(r.treesIn > 0 && r.same === r.treesIn && !r.differ && !r.onlyTreesIn && !r.onlyGpu,
      `trees over ${r.region}: treesIn places ${r.treesIn}, the GPU the same ${r.same} (${r.differ} differ, ${r.onlyTreesIn} only in treesIn, ${r.onlyGpu} only on the GPU; ${secs()})`);
    ok(!errs.length, `trees: no page or GPU errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
    await p.close();
  }

  // ------------------------------------------------------------- edit
  if (STAGES.includes('edit')) {
    const { p, errs } = await boot(`/?map=labWorld&view=plain&win=${WIN}`);
    const r = await p.evaluate(async () => {
      const a = window.__app, w = a.win, f = w.far, sim = a.sim, g = sim.g, gpu = a.gpu;
      const { E } = await import('/src/elements.js');
      f.queue = [];
      // a lava wall by the window's centre, on its ground
      const x = g.nx / 2, z = g.nz / 2, y = Math.floor(w.scene.ground(sim.origin.x + x, sim.origin.z + z, w.P)) + 4;
      sim.paint({ center: new a.THREE.Vector3(x, y, z), radius: 3, shape: 1, tool: E.LAVA, rate: 1, replace: true });
      a.test.step(2);
      const wall = [sim.origin.x + x, y, sim.origin.z + z];
      // away along x until the wall has left the window (the leaving slabs summarized)
      const dir = sim.origin.x + g.nx + 64 <= w.size[0] ? 16 : -16;
      for (let i = 0; i < (g.nx + 16) / 16; i++) { w.shift(dir, 0); await gpu.fence(); await w.pending; }
      const inWin = wall[0] >= sim.origin.x && wall[0] < sim.origin.x + g.nx;
      // the far grid's bricks round the wall
      const b0 = [Math.floor(wall[0] / 4) - 1, Math.floor(wall[1] / 4) - 1, Math.floor(wall[2] / 4) - 1];
      const t = await gpu.readback.texture(f.grid, { origin: b0, size: [3, 3, 3] });
      let lava = 0, glow = 0;
      for (let i = 0; i < 27; i++) {
        if ((t[i * 4 + 2] & 255) === E.LAVA) lava++;
        if (t[i * 4 + 3] & 255) glow++;
      }
      return { wall, inWin, lava, glow };
    });
    ok(!r.inWin && r.lava > 0 && r.glow > 0, `edit: a lava wall at ${r.wall}, the window moved off it${r.inWin ? ' (NOT: still in it)' : ''}: the far grid holds ${r.lava} lava bricks round it, ${r.glow} glowing (${secs()})`);
    ok(!errs.length, `edit: no page or GPU errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
    await p.close();
  }

  // ------------------------------------------------------------- view
  if (STAGES.includes('view')) {
    const { p, errs } = await boot(`/?map=labWorld&win=${WIN}`, { width: 128, height: 80 });
    const r = await p.evaluate(async ([N, DIFF]) => {
      const a = window.__app, f = a.win.far, gpu = a.gpu;
      f.queue = f.queue.slice(-N);
      while (f.queue.length) { f.sceneChunks(1); await gpu.fence(); }
      await f.viewPipe.build();
      a.post.settings.taa = false;
      const t = performance.now();
      const shot = await a.test.renderOnce({ capture: true });
      const ms = performance.now() - t;
      const visible = f.visible;
      // the same frame without the far view
      const draw = f.draw;
      f.draw = () => false;
      const bare = await a.test.renderOnce({ capture: true });
      f.draw = draw;
      let n = 0;
      for (let i = 0; i < shot.data.length; i += 4) {
        if (Math.max(Math.abs(shot.data[i] - bare.data[i]), Math.abs(shot.data[i + 1] - bare.data[i + 1]), Math.abs(shot.data[i + 2] - bare.data[i + 2])) > DIFF) n++;
      }
      return { ms, visible, changed: n / (shot.width * shot.height), view: f.viewPipe.state, viewMs: f.viewPipe.buildMs };
    }, [VIEW_CHUNKS, DIFF]);
    ok(r.visible && r.changed >= MIN_CHANGED, `view: the far view drew (pipeline ${r.view} in ${r.viewMs?.toFixed(0)} ms), ${(100 * r.changed).toFixed(1)}% of the canvas changed by it (floor ${100 * MIN_CHANGED}%; a frame ${r.ms.toFixed(0)} ms; ${secs()})`);
    if (out) await p.screenshot({ path: `${out}/far-view.png` });
    ok(!errs.length, `view: no page or GPU errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
    await p.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await b.close();
  await vite.close();
}
console.log(failures ? `\nfar-check: ${failures} failed` : `\nfar-check: ok (${secs()})`);
process.exit(failures ? 1 : 0);
