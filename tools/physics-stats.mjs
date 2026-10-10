// Physics statistics for two builds (docs/scaling.md D7: a precision change is
// proved statistically). Each test runs an ensemble of independent runs per
// build (they differ in the starting step count, which reseeds every random
// stream the step uses) and reports each metric's mean and standard error for
// A and B, and their difference in standard errors (z). Run-to-run noise is
// what the ensembles measure, so |z| beyond about 3 is a real change.
//
// Tests:
//   census    lab, volcano, island: cells per element (mass), energy Σ cap·T,
//             quiet share, mean |v| of powders and liquids (at mid-run, at the
//             end, and averaged over the run), moving cells, every STRIDE
//             steps; and the steps until moving cells fall below SETTLED of
//             their peak (settling time)
//   closed    sand, water and oil at ambient (nothing reacts): every
//             element's cell count must stay exactly constant (checked
//             every few steps: a lost or doubled cell would stay lost)
//   fall      a row of sand grains dropped from FALL_H cells: steps to land
//   pile      sand poured from a point, then settled: the pile's slope
//   splash    a ball of water dropped onto the floor: how far it spreads
//   slope     water poured at the top of a ramp: how far down and how much
//   heap      a block of sand collapsing into a heap: moving grains over
//             time (settling), the steps until they fall below SETTLED of
//             their peak, and the heap's angle of repose
//   level     a column of water released at one side of a closed floor: how
//             level its surface is (spread of column heights) over time
//   lockstep  the lab run LOCK_PRE steps, read back and loaded twice, each
//             load run LOCK_STEPS more: both must match bit for bit (a save
//             or a network snapshot evolves the same wherever it is loaded)
// usage: node tools/physics-stats.mjs --a 5402 --b 5401 [--tests census,closed,fall,pile,splash,slope]
//          [--runs 6] [--presets lab,volcano,island] [--first 1] [--out stats.json]
//   --first: run k starts at step first + k·FRAME_SPACING (a run is
//   deterministic in its start, so a new --first gives a fresh ensemble)
import { launchBrowser, newTestContext, ready } from './browser.mjs';
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ports = { A: opt('a', '5402'), B: opt('b', '5401') };
const tests = opt('tests', 'census,closed,fall,pile,splash,slope').split(',');
const RUNS = +opt('runs', '6');            // ensemble size per build and test
const FRAME_SPACING = 7919;                // starting step counts k·this apart (a prime: no shared parity pattern)
const FIRST = +opt('first', '1');          // run 0's starting step count
const SEED = 12345;                        // Math.random seed (colour seeds only; mulberry32 as tools/regress.mjs)
const P = {
  census: { size: '128', presets: ['lab', 'volcano', 'island'], steps: 1200, stride: 100, settled: 0.05 },   // --presets narrows
  closed: { size: '64', steps: 300, every: 10 },        // counts checked every `every` steps
  fall: { size: '64', height: 56, side: 5, spacing: 8, maxSteps: 600, every: 2 },   // a side × side grid of grains
  pile: { size: '64', pourSteps: 240, settleSteps: 600, radius: 1.5 },
  splash: { size: '64', radius: 6, height: 40, steps: 160 },
  slope: { size: '64', steps: 360, sample: [120, 240, 360] },
  lockstep: { size: '128', pre: 150, steps: 300 },
  heap: { size: '64', half: 6, y0: 2, y1: 42, steps: 600, every: 10, settled: 0.05 },
  level: { size: '64', half: 6, height: 40, steps: 400, sample: [100, 200, 400] },
};

const browser = await launchBrowser();
const pages = {};
async function open(name, size) {
  const key = `${name}:${size}`;
  if (pages[key]) return pages[key];
  const ctx = await newTestContext(browser, { mode: 'manual', viewport: { width: 800, height: 600 } });   // the app loop parked: only this script steps the sim
  await ctx.routeWebSocket(/.*/, () => {});
  await ctx.addInitScript((seed) => {
    let s = seed;
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__reseed = () => { s = seed; };
  }, SEED);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(name, 'PAGEERROR', String(e).slice(0, 300)));
  await page.goto(`http://localhost:${ports[name]}/?size=${size}&preset=empty`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await ready(page);
  await page.evaluate(() => { window.__app.settings.paused = true; window.__app.test.park(); });
  pages[key] = page;
  return page;
}

// ---------------------------------------------------------------- page side
// One run of a test, in the page: returns { metric: number, ... }.
async function runTest({ test, p, frame }) {
  const a = window.__app, sim = a.sim, g = sim.g;
  const { ELEMENTS, E, K } = await import('/src/elements.js');
  const { BRICK } = await import('/src/shaders/common.js');
  const kindOf = (id) => ELEMENTS[id]?.kind;
  const V3 = sim.mats.paint.uniforms.uCenter.value.constructor;
  // a CPU-built scene: fill(set) gets set(x, y, z, id, extra), then it loads
  const scene = (fill) => {
    window.__reseed();
    const [A, B] = sim.blankState();
    const set = (x, y, z, id, { vy = 0 } = {}) => {
      if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
      const i = sim.cellTexel(x, y, z) * 4, e = ELEMENTS[id];
      A[i] = id; A[i + 1] = e.temp; A[i + 2] = e.life; A[i + 3] = (A[i + 3] % 1);
      B[i] = 0; B[i + 1] = vy; B[i + 2] = 0; B[i + 3] = 0;
    };
    fill(set);
    sim.load(A, B);
  };
  const start = () => { sim.frame = frame; sim.actDirty = true; };
  const read = () => sim.readState();
  const at = (A, x, y, z) => Math.round(A[sim.cellTexel(x, y, z) * 4]);
  const quietShare = () => {
    const t = sim.actQuiet, q = new Uint8Array(t.width * t.height * 4);
    a.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, q);
    let k = 0;
    for (let i = 0; i < q.length; i += 4) if (q[i] > 127) k++;
    return k / ((g.nx / BRICK) * (g.ny / BRICK) * (g.nz / BRICK));
  };
  const out = {};

  if (test === 'census') {
    window.__reseed();
    a.loadPreset(p.preset, false);
    start();
    const series = [];
    for (let s = 0; s <= p.steps; s += p.stride) {
      if (s) for (let i = 0; i < p.stride; i++) sim.step();
      const [A, B] = read();
      const n = {}, vBy = {};
      let energy = 0, vP = 0, nP = 0, vL = 0, nL = 0, moving = 0;
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = sim.cellTexel(x, y, z) * 4, id = Math.round(A[i]), e = ELEMENTS[id];
        n[id] = (n[id] ?? 0) + 1;
        energy += e.cap * A[i + 1];
        if (e.kind === K.POWDER || e.kind === K.LIQUID) {
          const v = Math.hypot(B[i], B[i + 1], B[i + 2]);
          if (e.kind === K.POWDER) { vP += v; nP++; } else { vL += v; nL++; }
          if (v > 0) moving++;
          vBy[id] = (vBy[id] ?? 0) + v;
        }
      }
      series.push({ s, n, vBy, energy, vPowder: nP ? vP / nP : 0, vLiquid: nL ? vL / nL : 0, moving, quiet: s ? quietShare() : null });
    }
    const last = series.at(-1), peak = Math.max(...series.map((x) => x.moving));
    out.settleSteps = series.find((x) => x.s > 0 && x.moving <= p.settled * peak)?.s ?? p.steps + p.stride;
    out.energyEnd = last.energy;
    out.energyMid = series[series.length >> 1].energy;
    out.vPowderMid = series[series.length >> 1].vPowder;
    out.vLiquidMid = series[series.length >> 1].vLiquid;
    out.vPowderEnd = last.vPowder;
    out.vLiquidEnd = last.vLiquid;
    // over every sample after the start: steadier than one moment
    const later = series.slice(1);
    out.vPowderAvg = later.reduce((t, x) => t + x.vPowder, 0) / later.length;
    out.vLiquidAvg = later.reduce((t, x) => t + x.vLiquid, 0) / later.length;
    out.movingAvg = later.reduce((t, x) => t + x.moving, 0) / later.length;
    // per loose element: its summed speed and its cells, over the run
    for (const id of new Set(later.flatMap((x) => Object.keys(x.vBy)))) {
      const key = ELEMENTS[id].key;
      out[`vSum_${key}`] = later.reduce((t, x) => t + (x.vBy[id] ?? 0), 0) / later.length;
      out[`nAvg_${key}`] = later.reduce((t, x) => t + (x.n[id] ?? 0), 0) / later.length;
    }
    out.movingEnd = last.moving;
    out.quietEnd = last.quiet;
    out.quietMean = series.filter((x) => x.quiet !== null).reduce((s, x) => s + x.quiet, 0) / (series.length - 1);
    for (const [id, c] of Object.entries(last.n)) out[`cells_${ELEMENTS[id].key}`] = c;
  } else if (test === 'closed') {
    const c = g.nx / 2;
    scene((set) => {
      for (let y = 20; y < 36; y++) for (let z = c - 8; z < c + 8; z++) for (let x = c - 20; x < c - 4; x++) set(x, y, z, E.SAND);
      for (let y = 4; y < 24; y++) for (let z = c - 10; z < c + 10; z++) for (let x = c + 2; x < c + 22; x++) set(x, y, z, E.WATER);
      for (let y = 30; y < 34; y++) for (let z = c - 6; z < c + 6; z++) for (let x = c + 4; x < c + 16; x++) set(x, y, z, E.OIL);
    });
    start();
    const count = () => {
      const [A] = read(), n = {};
      for (let i = 0; i < A.length; i += 4) { const id = Math.round(A[i]); n[id] = (n[id] ?? 0) + 1; }
      return n;
    };
    const n0 = count();
    let drift = 0;
    for (let s = 1; s <= p.steps; s++) {
      sim.step();
      if (s % p.every) continue;
      const n = count();
      for (const id of new Set([...Object.keys(n0), ...Object.keys(n)])) drift = Math.max(drift, Math.abs((n[id] ?? 0) - (n0[id] ?? 0)));
    }
    out.maxCountDrift = drift;
  } else if (test === 'fall') {
    // a grid of grains, p.spacing cells apart, at rest at height p.height
    const cols = [], h = (p.side - 1) / 2;
    for (let i = 0; i < p.side * p.side; i++) {
      cols.push([g.nx / 2 + p.spacing * ((i % p.side) - h), g.nz / 2 + p.spacing * (Math.floor(i / p.side) - h)]);
    }
    scene((set) => { for (const [x, z] of cols) set(x, p.height, z, E.SAND); });
    start();
    const landed = cols.map(() => null);
    for (let s = 1; s <= p.maxSteps && landed.some((x) => x === null); s++) {
      sim.step();
      if (s % p.every) continue;   // (landing times to within p.every steps)
      const [A] = read();
      cols.forEach(([x, z], k) => { if (landed[k] === null && at(A, x, 0, z) === E.SAND) landed[k] = s; });
    }
    out.fallSteps = landed.reduce((s, x) => s + (x ?? p.maxSteps), 0) / landed.length;
  } else if (test === 'pile') {
    scene(() => {});
    start();
    const c = new V3(g.nx / 2, g.ny - 6, g.nz / 2);
    for (let s = 0; s < p.pourSteps; s++) { sim.paint({ center: c, radius: p.radius, shape: 0, tool: E.SAND, rate: 1, replace: false }); sim.step(); }
    for (let s = 0; s < p.settleSteps; s++) sim.step();
    // height of each column, and the slope: least squares of height on distance from the axis
    const [A] = read();
    let n = 0, sr = 0, sh = 0, srr = 0, srh = 0, cells = 0, hmax = 0;
    for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      let h = 0;
      for (let y = g.ny - 1; y >= 0; y--) if (at(A, x, y, z) === E.SAND) { h = y + 1; break; }
      for (let y = 0; y < h; y++) if (at(A, x, y, z) === E.SAND) cells++;
      hmax = Math.max(hmax, h);
      const r = Math.hypot(x + 0.5 - g.nx / 2, z + 0.5 - g.nz / 2);
      if (h > 2 && r > 2) { n++; sr += r; sh += h; srr += r * r; srh += r * h; }
    }
    const slope = (n * srh - sr * sh) / (n * srr - sr * sr);
    out.pileAngleDeg = Math.atan(-slope) * 180 / Math.PI;
    out.pileHeight = hmax;
    out.pileCells = cells;
  } else if (test === 'splash') {
    const c = [g.nx / 2, p.height, g.nz / 2];
    scene((set) => {
      for (let z = -p.radius; z <= p.radius; z++) for (let y = -p.radius; y <= p.radius; y++) for (let x = -p.radius; x <= p.radius; x++)
        if (x * x + y * y + z * z <= p.radius * p.radius) set(c[0] + x, c[1] + y, c[2] + z, E.WATER);
    });
    start();
    for (let s = 0; s < p.steps; s++) sim.step();
    const [A] = read();
    let n = 0, r2 = 0, rmax = 0, ymax = 0;
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      if (at(A, x, y, z) !== E.WATER) continue;
      const r = Math.hypot(x + 0.5 - c[0], z + 0.5 - c[2]);
      n++; r2 += r * r; rmax = Math.max(rmax, r); ymax = Math.max(ymax, y);
    }
    out.splashRmsRadius = Math.sqrt(r2 / n);
    out.splashMaxRadius = rmax;
    out.waterCells = n;
  } else if (test === 'lockstep') {
    window.__reseed();
    a.loadPreset('lab', false);
    start();
    for (let s = 0; s < p.pre; s++) sim.step();
    const [A0, B0] = read();
    const hash = (xs) => { let h = 2166136261 >>> 0; const u = new Uint32Array(xs.buffer); for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0; return h; };
    const after = () => {
      sim.load(A0.slice(), B0.slice());
      sim.frame = frame + p.pre;
      sim.actDirty = true;
      for (let s = 0; s < p.steps; s++) sim.step();
      const [A, B] = read();
      return [hash(A), hash(B)];
    };
    const h1 = after(), h2 = after();
    out.lockstepSame = h1[0] === h2[0] && h1[1] === h2[1] ? 1 : 0;
  } else if (test === 'heap') {
    const c = g.nx / 2;
    scene((set) => { for (let y = p.y0; y < p.y1; y++) for (let z = c - p.half; z < c + p.half; z++) for (let x = c - p.half; x < c + p.half; x++) set(x, y, z, E.SAND); });
    start();
    const moving = [];
    for (let s = 1; s <= p.steps; s++) {
      sim.step();
      if (s % p.every) continue;
      const [A, B] = read();
      let m = 0;
      for (let i = 0; i < A.length; i += 4) if (Math.round(A[i]) === E.SAND && (B[i] || B[i + 1] || B[i + 2])) m++;
      moving.push(m);
    }
    const peak = Math.max(...moving);
    out.heapSettleSteps = (moving.findIndex((m, k) => k > moving.indexOf(peak) && m <= p.settled * peak) + 1) * p.every || p.steps + p.every;
    out.heapMovingAvg = moving.reduce((t, m) => t + m, 0) / moving.length;
    for (const k of [10, 20, 30, 45, 60]) out[`heapMoving_${k * p.every}`] = moving[k - 1];
    const [A] = read();
    let n = 0, sr = 0, sh = 0, srr = 0, srh = 0, hmax = 0;
    for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      let h = 0;
      for (let y = g.ny - 1; y >= 0; y--) if (at(A, x, y, z) === E.SAND) { h = y + 1; break; }
      hmax = Math.max(hmax, h);
      const r = Math.hypot(x + 0.5 - c, z + 0.5 - c);
      if (h > 1 && r > 2) { n++; sr += r; sh += h; srr += r * r; srh += r * h; }
    }
    out.heapAngleDeg = Math.atan(-(n * srh - sr * sh) / (n * srr - sr * sr)) * 180 / Math.PI;
    out.heapHeight = hmax;
    out.heapFootprint = n;
  } else if (test === 'level') {
    // a closed 64² floor (wall rim); water column in one corner region
    scene((set) => {
      for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) if (x === 0 || z === 0 || x === g.nx - 1 || z === g.nz - 1) for (let y = 0; y < 12; y++) set(x, y, z, E.WALL);
      for (let y = 0; y < p.height; y++) for (let z = 4; z < 4 + 2 * p.half; z++) for (let x = 4; x < 4 + 2 * p.half; x++) set(x, y, z, E.WATER);
    });
    start();
    for (let s = 1; s <= p.steps; s++) {
      sim.step();
      if (!p.sample.includes(s)) continue;
      const [A] = read();
      const hs = [];
      for (let z = 1; z < g.nz - 1; z++) for (let x = 1; x < g.nx - 1; x++) {
        let h = 0;
        for (let y = 0; y < g.ny; y++) if (at(A, x, y, z) === E.WATER) h++;
        hs.push(h);
      }
      const m = hs.reduce((t, h) => t + h, 0) / hs.length;
      out[`levelSd_${s}`] = Math.sqrt(hs.reduce((t, h) => t + (h - m) ** 2, 0) / hs.length);
      out[`levelMax_${s}`] = Math.max(...hs);
      out[`levelWet_${s}`] = hs.filter((h) => h > 0).length;
    }
  } else if (test === 'slope') {
    // a wall ramp along x: height falls 1 cell per 2 along x, the full width in z
    const ramp = (x) => Math.max(0, Math.round((g.nx - x) / 2) - 4);
    scene((set) => { for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) for (let y = 0; y < ramp(x); y++) set(x, y, z, E.WALL); });
    start();
    const src = new V3(6, ramp(6) + 4, g.nz / 2);
    for (let s = 1; s <= p.steps; s++) {
      sim.paint({ center: src, radius: 2, shape: 0, tool: E.WATER, rate: 1, replace: false });
      sim.step();
      if (p.sample.includes(s)) {
        const [A] = read();
        let front = 0, low = 0, n = 0;
        for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
          if (at(A, x, y, z) !== E.WATER) continue;
          n++; front = Math.max(front, x);
          if (x >= g.nx * 3 / 4) low++;
        }
        out[`front_${s}`] = front;
        out[`lowWater_${s}`] = low;
        out[`water_${s}`] = n;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- run
const results = {};
for (const test of tests) {
  const cfg = P[test];
  const presets = opt('presets') ? opt('presets').split(',') : cfg.presets;
  const variants = test === 'census' ? presets.map((preset) => ({ name: `census:${preset}`, p: { ...cfg, preset } })) : [{ name: test, p: cfg }];
  for (const v of variants) {
    const r = (results[v.name] = { A: [], B: [] });
    for (let k = 0; k < RUNS; k++) {
      for (const name of k % 2 ? ['B', 'A'] : ['A', 'B']) {
        const page = await open(name, cfg.size);
        r[name].push(await page.evaluate(runTest, { test, p: v.p, frame: FIRST + k * FRAME_SPACING }));
      }
      process.stderr.write(`${v.name} run ${k + 1}/${RUNS}\n`);
    }
  }
}
await browser.close();

// ---------------------------------------------------------------- report
const stat = (xs) => {
  const n = xs.length, m = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
  return { m, se: sd / Math.sqrt(n), sd };
};
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(4));
const report = {};
for (const [name, r] of Object.entries(results)) {
  console.log(`\n## ${name} (${r.A.length} runs each; mean ± standard error)`);
  console.log('| metric | A | B | B − A | z |\n|---|---|---|---|---|');
  report[name] = {};
  const keys = [...new Set([...r.A, ...r.B].flatMap((x) => Object.keys(x)))];
  for (const k of keys) {
    const a = stat(r.A.map((x) => x[k] ?? 0)), b = stat(r.B.map((x) => x[k] ?? 0));
    const se = Math.hypot(a.se, b.se), z = se > 0 ? (b.m - a.m) / se : (b.m === a.m ? 0 : Infinity);
    report[name][k] = { A: a, B: b, z };
    console.log(`| ${k} | ${fmt(a.m)} ± ${fmt(a.se)} | ${fmt(b.m)} ± ${fmt(b.se)} | ${fmt(b.m - a.m)} | ${Number.isFinite(z) ? z.toFixed(2) : 'inf'} |`);
  }
}
if (opt('out')) writeFileSync(opt('out'), JSON.stringify({ ports, runs: RUNS, P, results, report }, null, 2));
