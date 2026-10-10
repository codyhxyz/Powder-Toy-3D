// Headless GPU check of the fast-particle layer (docs/particles.md): one
// browser, a 128³ box, the app's frame loop held.
//   photons   white photons painted inside three closed boxes, of wood, metal
//             and glass: wood soaks them up and catches fire, metal bounces
//             them (they live on, fading), glass lets them out
//   neutrons  painted inside a block of water and a block of stone: water
//             slows them to thermal, stone doesn't touch them
//   fission   a small and a big plutonium block, each seeded with neutrons:
//             the small one's chain dies out, the big one's runs away until
//             it melts and blows itself apart
//   shot      a frame with particles in it
//   timing    the particle passes per step: asleep, awake with none, and with
//             tens of thousands (GPU-synced, best of a few rounds)
// usage: node tools/rays-gpu.mjs <outDir> [--port 5417]
//   (serve with: npx vite --config tools/rays-vite.config.mjs --port 5417 --strictPort)
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const args = process.argv.slice(2);
const out = args[0] ?? '/tmp/rays-gpu';
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5417');
mkdirSync(out, { recursive: true });

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 1500)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 1500)));
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, paused: true }));
  // a frame loop that can be held and pumped (tools/crystal-check.mjs); timings use the real clock (__now)
  const raf = window.requestAnimationFrame.bind(window);
  window.__now = performance.now.bind(performance);
  let held = null, vt = 0;
  window.requestAnimationFrame = (cb) => {
    if (held) { held.push(cb); return 0; }
    return raf(() => { vt += 1000 / 60; cb(vt); });
  };
  window.__hold = () => { held ??= []; };
  window.__pump = (n) => { for (let i = 0; i < n; i++) { const h = held; held = []; vt += 1000 / 60; h.forEach((cb) => cb(vt)); } };
  performance.now = () => vt;
});
await p.goto(`http://localhost:${port}/?preset=empty&size=128`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 90000 });
await p.waitForTimeout(1500);
const ev = (fn, arg) => p.evaluate(fn, arg);

// helpers, kept on window
await ev(async () => {
  const { E, ELEMENTS, itemByKey } = await import('/src/elements.js');
  const { RAYS } = await import('/src/rays.js');
  const THREE = await import('three');
  const a = window.__app, r = a.renderer;
  a.settings.paused = true;
  window.__hold();
  const T = RAYS.RAY_TEX, N = T * T, l0 = new Float32Array(N * 4), l2 = new Float32Array(N * 4);
  const H = (window.__h = { E, ELEMENTS, RAYS, PHOTON: itemByKey('PHOTON').id, NEUTRON: itemByKey('NEUTRON').id });
  H.sim = () => a.sim;
  // particles: per kind, optionally inside a box [lo, hi), with neutron energies
  H.parts = (lo = [-1e9, -1e9, -1e9], hi = [1e9, 1e9, 1e9]) => {
    const rays = a.sim.rays;
    r.readRenderTargetPixels(rays.list, 0, 0, T, T, l0, undefined, 0);
    r.readRenderTargetPixels(rays.list, 0, 0, T, T, l2, undefined, 2);
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
    const sim = a.sim;
    sim.clear();
    const [A, B] = sim.readState(), g = sim.g;
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
    for (let i = 0; i < times; i++) a.sim.paint({ center: new THREE.Vector3(...c), radius, shape: 0, tool, rate, replace: false });
  };
  // per-element census inside a box: count and max °C
  H.census = (lo, hi) => {
    const sim = a.sim, [A, B] = sim.readState(), o = {};
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
  H.steps = (n) => { for (let i = 0; i < n; i++) a.sim.step(); };
});

const results = {};

// ---- photons ----
results.photons = await ev(() => {
  const H = window.__h, { E } = H;
  const boxes = { wood: [[8, 0, 57], [22, 14, 71]], metal: [[57, 0, 57], [71, 14, 71]], glass: [[106, 0, 57], [120, 14, 71]] };
  const ids = { wood: E.WOOD, metal: E.METAL, glass: E.GLASS };
  H.fill((x, y, z) => { for (const [k, [lo, hi]] of Object.entries(boxes)) if (H.shell(x, y, z, lo, hi)) return ids[k]; return null; });
  for (const [, [lo, hi]] of Object.entries(boxes)) H.paint(H.PHOTON, lo.map((v, i) => (v + hi[i]) / 2), 3, 3, 10);
  const row = (step) => Object.fromEntries(Object.entries(boxes).map(([k, [lo, hi]]) => [k, { photons: H.parts(lo, hi).photons, ...H.census(lo, hi) }]));
  const o = { painted: H.parts().photons, at0: row(0) };
  H.steps(10); o.at10 = row(10);
  H.steps(50); o.at60 = row(60);
  o.awakeAfter = H.sim().rays.active;
  return o;
});

// ---- neutrons in water and stone ----
results.neutrons = await ev(() => {
  const H = window.__h, { E } = H;
  const water = [[8, 0, 34], [60, 50, 94]], stone = [[68, 0, 34], [120, 50, 94]];
  H.fill((x, y, z) => (H.inBox(x, y, z, ...water) ? E.WATER : H.inBox(x, y, z, ...stone) ? E.STONE : null));
  H.paint(H.NEUTRON, [34, 25, 64], 3, 4, 10);
  H.paint(H.NEUTRON, [94, 25, 64], 3, 4, 10);
  const o = {};
  for (const n of [0, 10, 40, 120]) {
    H.steps(n - (o.last ?? 0)); o.last = n;
    o[`step${n}`] = { water: H.parts(...water), stone: H.parts(...stone), all: H.parts() };
  }
  delete o.last;
  return o;
});

// ---- fission ----
const fission = async (side, steps, every) => ev(({ side, steps, every }) => {
  const H = window.__h, { E } = H, c = 64, h = side / 2;
  const lo = [c - h, 0, c - h], hi = [c + h, side, c + h];
  H.fill((x, y, z) => (H.inBox(x, y, z, lo, hi) ? E.PLUTONIUM : null));
  H.paint(H.NEUTRON, [c, h, c], Math.min(3, h), 2, 5);
  const view = [[c - 40, 0, c - 40], [c + 40, 100, c + 40]];
  const rows = [];
  for (let s = 0; s <= steps; s += every) {
    if (s) H.steps(every);
    const n = H.parts(), k = H.census(...view);
    rows.push({ step: s, neutrons: n.neutrons, Pu: k.PLUTONIUM?.n ?? 0, PuTmax: k.PLUTONIUM?.Tmax, lava: k.LAVA?.n ?? 0, lavaTmax: k.LAVA?.Tmax, Pmax: k.Pmax });
  }
  return rows;
}, { side, steps, every });
results.fissionSmall = await fission(4, 200, 50);
results.fissionBig = await fission(16, 400, 25);

// ---- a frame with particles ----
await ev(() => {
  const H = window.__h, { E } = H;
  H.fill((x, y, z) => (y < 3 ? E.WATER : (x > 70 && x < 76 && y < 40 && z > 40 && z < 88) ? E.METAL : null));
  H.paint(H.PHOTON, [50, 20, 64], 6, 4, 10);
  H.paint(H.NEUTRON, [40, 30, 60], 5, 4, 10);
  H.steps(6);
  window.__pump(6);
});
await p.screenshot({ path: `${out}/particles.png` });

// ---- timing ----
results.timing = await ev(() => {
  const H = window.__h, { E } = H, sim = H.sim(), rays = sim.rays, now = window.__now;
  const time = (fn, n = 60, rounds = 4) => {
    let best = Infinity;
    for (let r = 0; r < rounds; r++) {
      sim.gpuSync();
      const t0 = now();
      for (let i = 0; i < n; i++) fn();
      sim.gpuSync();
      best = Math.min(best, (now() - t0) / n);
    }
    return +best.toFixed(4);
  };
  const passes = () => { rays.step(); rays.settle(); };
  H.fill((x, y, z) => (y < 60 ? E.WATER : null));
  rays.sleep();
  const o = { asleep: time(passes) };
  rays.wake();
  o.awakeEmpty = time(passes);
  for (let i = 0; i < 140; i++) H.paint(H.NEUTRON, [64, 30, 64], 20, 1, 100);
  o.particles = H.parts().neutrons;
  o.many = time(passes, 30);
  o.stepWithMany = time(() => sim.step(), 30);
  H.fill((x, y, z) => (y < 60 ? E.WATER : null));
  rays.sleep();
  o.stepAsleep = time(() => sim.step(), 30);
  return o;
});

console.log(JSON.stringify(results, null, 1));
console.log(errs.length ? `console errors:\n${errs.slice(0, 8).join('\n')}` : 'no console errors');
await b.close();
