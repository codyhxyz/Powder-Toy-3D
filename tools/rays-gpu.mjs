// Headless GPU check of the fast-particle layer (docs/particles.md;
// src/raysLayer.js on WebGPU, docs/webgpu.md G4): one browser, a box
// (128³; --size scales the scenes), the app parked (manual mode) and stepped
// by the tool, every result read back (W6).
//   photons   white photons painted inside three closed boxes, of wood, metal
//             and glass: wood soaks them up and catches fire, metal bounces
//             them (they live on, fading), glass lets them out
//   neutrons  painted inside a block of water and a block of stone: water
//             slows them to thermal, stone doesn't touch them
//   fission   a small and a big plutonium block, each seeded with neutrons:
//             the small one's chain dies out, the big one's runs away until
//             it melts and blows itself apart
//   shot      a frame with particles in it: their sprites are drawn with
//             drawIndirect from the live list the deposit kernel compacts
//             (the count it read back and the vertex count it wrote agree,
//             and the sprites change the picture)
//   timing    the particle kernels per step: asleep, awake with none, and with
//             thousands (GPU-synced, best of a few rounds)
// usage: node tools/rays-gpu.mjs <outDir> [--port 5417] [--size 128] [--view plain] [--stages photons,neutrons,fission,shot,timing]
//   --view: the app's view for the shot (plain, the default: the cheapest to build; realistic ...)
//   (it starts its own Vite on that port: tools/vite-server.mjs)
import { mkdirSync, writeFileSync } from 'fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('--') ? args[0] : '/tmp/rays-gpu';
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const size = Number(opt('size', '128'));
const stages = new Set(opt('stages', 'photons,neutrons,fission,shot,timing').split(','));
const view = opt('view', 'plain');
const S = size / 128;   // the scenes are laid out for 128³
mkdirSync(out, { recursive: true });

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };

const vite = await startVite();
const b = await launchBrowser();
const results = {};
try {
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 960, height: 600 } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errs.push(m.text().slice(0, 1500)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 1500)));
  await p.routeWebSocket(/.*/, () => {});
  await p.addInitScript(() => localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, paused: true })));
  await p.goto(vite.url(`/?preset=empty&size=${size}&view=${view}`));
  // (a cold boot on a software adapter builds every pipeline first: give it longer than browser.mjs ready's 2 minutes)
  await p.waitForFunction(() => window.__app?.sim, null, { polling: 250, timeout: 300000 });
  const ev = (fn, arg) => p.evaluate(fn, arg);

  // helpers, kept on window
  await ev(async (S) => {
    const { E, ELEMENTS, itemByKey } = await import('/src/elements.js');
    const { RAYS } = await import('/src/rays.js');
    const a = window.__app;
    a.test.park();
    await a.test.ready();
    await a.sim.rays.prepare();
    const H = (window.__h = { E, ELEMENTS, RAYS, S, PHOTON: itemByKey('PHOTON').id, NEUTRON: itemByKey('NEUTRON').id });
    H.sim = () => a.sim;
    const sc = (v) => Math.round(v * S);
    H.box = (lo, hi) => [lo.map(sc), hi.map(sc)];
    H.at = (c) => c.map((v) => v * S);
    // particles: per kind, optionally inside a box [lo, hi), with neutron energies (the list read back)
    H.parts = async (lo = [-1e9, -1e9, -1e9], hi = [1e9, 1e9, 1e9]) => {
      const { l0, l2 } = await a.sim.rays.readList();
      const N = l0.length / 4;
      const o = { photons: 0, neutrons: 0, meanE: 0, thermal: 0 };
      for (let i = 0; i < N; i++) {
        const k = Math.round(l0[i * 4 + 3]);
        if (!k) continue;
        const q = [l0[i * 4], l0[i * 4 + 1], l0[i * 4 + 2]];
        if (q.some((x, j) => x < lo[j] || x >= hi[j])) continue;
        if (k === 1) o.photons++;
        else { o.neutrons++; o.meanE += l2[i * 4]; if (l2[i * 4] < 1e-6) o.thermal++; }
      }
      if (o.neutrons) o.meanE = +(o.meanE / o.neutrons).toPrecision(3);
      return o;
    };
    // a new state: cells set by fn(x, y, z) → element id or null (air)
    H.fill = (fn) => {
      const sim = a.sim, g = sim.g;
      const [A, B] = sim.blankState();
      for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
        const id = fn(x, y, z);
        if (id == null) continue;
        const i = sim.cellTexel(x, y, z) * 4;
        A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] -= Math.floor(A[i + 3]);
      }
      sim.load(A, B);
    };
    const inBox = (x, y, z, lo, hi) => x >= lo[0] && y >= lo[1] && z >= lo[2] && x < hi[0] && y < hi[1] && z < hi[2];
    H.shell = (x, y, z, lo, hi) => inBox(x, y, z, lo, hi) && !inBox(x, y, z, lo.map((v) => v + 1), hi.map((v) => v - 1));
    H.inBox = inBox;
    H.paint = (tool, c, radius, times, rate = 1) => {
      for (let i = 0; i < times; i++) a.sim.paint({ center: { x: c[0], y: c[1], z: c[2] }, radius, shape: 0, tool, rate, replace: false });
    };
    // per-element census inside a box: count and max °C
    H.census = async (lo, hi) => {
      const sim = a.sim, [A, B] = await sim.readState(), o = {};
      let Pmax = 0;
      for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
        const i = sim.cellTexel(x, y, z) * 4, id = Math.round(A[i]);
        if (!id) { Pmax = Math.max(Pmax, B[i + 3]); continue; }
        const k = ELEMENTS[id].key, e = (o[k] ??= { n: 0, Tmax: -1e9 });
        e.n++; e.Tmax = Math.max(e.Tmax, Math.round(A[i + 1]));
        Pmax = Math.max(Pmax, B[i + 3]);
      }
      o.Pmax = +Pmax.toFixed(1);
      return o;
    };
    H.steps = (n) => a.test.step(n);
  }, S);

  // ---- photons ----
  if (stages.has('photons')) {
    results.photons = await ev(async () => {
      const H = window.__h, { E } = H;
      const boxes = { wood: H.box([8, 0, 57], [22, 14, 71]), metal: H.box([57, 0, 57], [71, 14, 71]), glass: H.box([106, 0, 57], [120, 14, 71]) };
      const ids = { wood: E.WOOD, metal: E.METAL, glass: E.GLASS };
      H.fill((x, y, z) => { for (const [k, [lo, hi]] of Object.entries(boxes)) if (H.shell(x, y, z, lo, hi)) return ids[k]; return null; });
      for (const [, [lo, hi]] of Object.entries(boxes)) H.paint(H.PHOTON, lo.map((v, i) => (v + hi[i]) / 2), 3, 3, 10);
      const row = async () => {
        const o = {};
        for (const [k, [lo, hi]] of Object.entries(boxes)) o[k] = { photons: (await H.parts(lo, hi)).photons, ...(await H.census(lo, hi)) };
        return o;
      };
      const o = { painted: (await H.parts()).photons, at0: await row() };
      H.steps(10); o.at10 = await row();
      H.steps(50); o.at60 = await row();
      o.awakeAfter = H.sim().rays.active;
      return o;
    });
    const r = results.photons;
    console.log(`photons: painted ${r.painted}; at 10 ${JSON.stringify(r.at10)}; at 60 ${JSON.stringify(r.at60)}`);
    ok(r.painted > 0, `photons: ${r.painted} painted`);
    ok(r.at10.metal.photons > r.at10.wood.photons, `photons: metal keeps them longer (${r.at10.metal.photons} at step 10) than wood, which soaks them up (${r.at10.wood.photons})`);
    ok((r.at60.wood.WOOD?.Tmax ?? 0) > (r.at0.wood.WOOD?.Tmax ?? 0) || (r.at60.wood.FIRE?.n ?? 0) > 0, `photons: the wood box warmed or caught fire (Tmax ${r.at0.wood.WOOD?.Tmax} → ${r.at60.wood.WOOD?.Tmax}, fire ${r.at60.wood.FIRE?.n ?? 0})`);
  }

  // ---- neutrons in water and stone ----
  if (stages.has('neutrons')) {
    results.neutrons = await ev(async () => {
      const H = window.__h, { E } = H;
      const water = H.box([8, 0, 34], [60, 50, 94]), stone = H.box([68, 0, 34], [120, 50, 94]);
      H.fill((x, y, z) => (H.inBox(x, y, z, ...water) ? E.WATER : H.inBox(x, y, z, ...stone) ? E.STONE : null));
      H.paint(H.NEUTRON, H.at([34, 25, 64]), 3, 4, 10);
      H.paint(H.NEUTRON, H.at([94, 25, 64]), 3, 4, 10);
      const o = {};
      let last = 0;
      for (const n of [0, 10, 40]) {
        H.steps(n - last); last = n;
        o[`step${n}`] = { water: await H.parts(...water), stone: await H.parts(...stone), all: await H.parts() };
      }
      return o;
    });
    const r = results.neutrons;
    console.log(`neutrons: ${JSON.stringify(r)}`);
    ok(r.step0.all.neutrons > 0, `neutrons: ${r.step0.all.neutrons} painted`);
    ok(r.step40.water.thermal > r.step40.stone.thermal, `neutrons: water thermalises them (${r.step40.water.thermal} thermal) and stone doesn't (${r.step40.stone.thermal})`);
  }

  // ---- fission ----
  const fission = (side, steps, every) => ev(async ({ side, steps, every }) => {
    const H = window.__h, { E } = H, c = Math.round(64 * H.S), h = side / 2;
    const lo = [c - h, 0, c - h], hi = [c + h, side, c + h];
    H.fill((x, y, z) => (H.inBox(x, y, z, lo, hi) ? E.PLUTONIUM : null));
    H.paint(H.NEUTRON, [c, h, c], Math.min(3, h), 2, 5);
    const R = Math.round(40 * H.S);
    const view = [[c - R, 0, c - R], [c + R, Math.round(100 * H.S), c + R]];
    const rows = [];
    for (let s = 0; s <= steps; s += every) {
      if (s) H.steps(every);
      const n = await H.parts(), k = await H.census(...view);
      rows.push({ step: s, neutrons: n.neutrons, Pu: k.PLUTONIUM?.n ?? 0, PuTmax: k.PLUTONIUM?.Tmax, lava: k.LAVA?.n ?? 0, lavaTmax: k.LAVA?.Tmax, Pmax: k.Pmax });
    }
    return rows;
  }, { side, steps, every });
  if (stages.has('fission')) {
    results.fissionSmall = await fission(4, 200, 50);
    results.fissionBig = await fission(16, 400, 25);
    const sm = results.fissionSmall.at(-1), big = results.fissionBig;
    ok(sm.neutrons < 50, `fission: the small block's chain dies out (${sm.neutrons} neutrons at step ${sm.step})`);
    ok(Math.max(...big.map((r) => r.neutrons)) > 4 * big[0].neutrons, `fission: the big block's runs away (peak ${Math.max(...big.map((r) => r.neutrons))} from ${big[0].neutrons})`);
  }

  // ---- a frame with particles, drawn with drawIndirect from the live list ----
  if (stages.has('shot')) {
    // a frame as presented (test.renderOnce's capture: the canvas's RGBA bytes), kept on the page
    const capture = (key) => ev(async (key) => {
      const a = window.__app;
      await a.test.renderOnce();   // (the view's first frame after a change builds what it needs)
      window[key] = await a.test.renderOnce({ capture: true });
    }, key);
    await ev(() => {
      const H = window.__h, { E } = H;
      H.fill((x, y, z) => (y < 3 ? E.WATER : null));
      H.sim().rays.reset();
    });
    // (single frames, test.renderOnce: converging the view, tools/browser.mjs render, takes
    // minutes on a software adapter, and the sprites need no history)
    await capture('__noParticles');
    console.log('shot: the frame without particles');
    const shot = await ev(async () => {
      const H = window.__h, a = window.__app, sim = H.sim(), rays = sim.rays;
      H.paint(H.PHOTON, H.at([50, 20, 64]), 6, 4, 10);
      H.paint(H.NEUTRON, H.at([40, 30, 60]), 5, 4, 10);
      H.steps(6);
      // drawIndirect's arguments (each counts set's words 0-3: vertexCount = the quad's 6,
      // instanceCount = the live list the deposit kernel compacted) and the list itself
      const w = new Uint32Array(await a.gpu.readback.buffer(rays.counts, 0, rays.counts.size));
      const sets = [0, 1].map((k) => ({ vertices: w[k * 8], instances: w[k * 8 + 1] }));
      return { parts: await H.parts(), sets };
    });
    await capture('__particles');
    await p.screenshot({ path: `${out}/particles.png` });
    results.shot = shot;
    const live = shot.parts.photons + shot.parts.neutrons;
    ok(live > 0 && shot.sets.some((s) => s.vertices === 6 && s.instances === live), `shot: drawIndirect draws a 6-vertex quad per live particle (${JSON.stringify(shot.sets)}; ${live} alive in the list)`);
    // the sprites change the picture: pixels that differ by more than 30 levels (sum of RGB)
    const diff = await ev(() => {
      const a = window.__noParticles, b = window.__particles;
      if (!a || !b || a.data.length !== b.data.length) return -1;
      let n = 0;
      for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) n++;
      return n;
    });
    results.shot.changedPx = diff;
    ok(diff > 50, `shot: the sprites change ${diff} pixels`);
  }

  // ---- timing ----
  if (stages.has('timing')) {
    results.timing = await ev(async () => {
      const H = window.__h, { E } = H, sim = H.sim(), rays = sim.rays;
      const time = async (fn, n = 8, rounds = 2) => {
        let best = Infinity;
        for (let r = 0; r < rounds; r++) {
          await sim.gpuSync();
          const t0 = performance.now();
          for (let i = 0; i < n; i++) fn();
          await sim.gpuSync();
          best = Math.min(best, (performance.now() - t0) / n);
        }
        return +best.toFixed(3);
      };
      const passes = () => { rays.step(); rays.settle(); };
      H.fill((x, y, z) => (y < 60 * H.S ? E.WATER : null));
      rays.sleep();
      const o = { asleep: await time(passes) };
      rays.wake();
      o.awakeEmpty = await time(passes);
      for (let i = 0; i < 60; i++) H.paint(H.NEUTRON, H.at([64, 30, 64]), 20 * H.S, 1, 100);
      o.particles = (await H.parts()).neutrons;
      o.many = await time(passes, 4);
      o.stepWithMany = await time(() => sim.step(), 3, 1);
      H.fill((x, y, z) => (y < 60 * H.S ? E.WATER : null));
      rays.sleep();
      o.stepAsleep = await time(() => sim.step(), 3, 1);
      return o;
    });
    console.log(`timing (ms): ${JSON.stringify(results.timing)}`);
  }

  results.errors = errs;
  ok(!errs.length, `no page or GPU errors (${errs.slice(0, 4).join(' | ') || 'none'})`);
} finally {
  await b.close();
  await vite.close();
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
console.log(failures ? `rays-gpu: ${failures} failure(s)` : 'rays-gpu: clean');
process.exit(failures ? 1 : 0);
