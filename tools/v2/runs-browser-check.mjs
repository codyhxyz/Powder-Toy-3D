// GPU: V2's liquid runs against V1 on what only the GPU runs (WS-D, the V2 finish push): each scene on V1
// (tools/outcomes/engine-v1.js, today's Simulation) and on V2 (engine-v2.js: src/v2/physics.js with its dynamics),
// in the outcome bench's bare simulation, every scene a fresh 32³ box (one size: each engine compiles once).
//   spread   a 4³ block of water on the floor: wet columns and its reach from the middle, by time
//   drain    the outcome bench's hole tank (tests/liquids.js hole) in a 32³ box: the tank's level by time
//   splash   a 2×2×2 block of water dropped 10 cells onto the floor: its footprint after landing
//   wall     a 2×1×2 nitroglycerin slab d cells from a side wall dropped h cells, [d, h] in WALL_CASES (V1: move.js
//            land throws it aside, react.js shock goes off against the wall)
//   mounds   4³ blocks of mud and of lava on the floor: their peak and footprint by time
//   mercury  a 2×1×2 mercury slab onto a nitroglycerin pool 2 deep, 0, 1 and 2 cells over it
//   outcomes the outcome bench's tests named by --outcomes (tools/outcomes/tests), their status and numbers
// Without --v1 or --v2 both run (one launch, one GPU slot each: --v1 and --v2 split them).
//   node tools/v2/runs-browser-check.mjs [--v1] [--v2] [--scenes spread,drain,...] [--outcomes hole,yield,...]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const ALL = ['spread', 'drain', 'splash', 'wall', 'mounds', 'mercury'];
const scenes = (arg('--scenes') ?? ALL.join(',')).split(',');
const outcomes = (arg('--outcomes') ?? '').split(',').filter(Boolean);
if (outcomes.length && !scenes.includes('outcomes')) scenes.push('outcomes');
// [cells from the wall, cells dropped] (the slab's row is its drop: its phase is the row's parity)
const WALL_CASES = [[3, 4], [3, 6], [3, 8], [3, 9], [3, 12], [3, 20], [1, 9], [1, 12], [6, 20]];
const engines = ['v1', 'v2'].filter(e => process.argv.includes(`--${e}`));
if (!engines.length) engines.push('v1', 'v2');
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

async function setup(name) {
  const { createEngine } = await import(`/tools/outcomes/engine-${name}.js`);
  window.__runs = { e: createEngine(window.__harness.gpu) };
}
// the page side: every scene's numbers (the same code on both engines)
async function run([list, wallCases, tests]) {
  const { e } = window.__runs, out = {}, N = [32, 32, 32];
  const r2 = (x) => Math.round(x * 100) / 100;
  // liquid of `key` per column (fills and flying packets binned to their cell), the wet columns, the reach
  // (Chebyshev, columns from the middle cell c) and the peak level
  const columns = (g, key) => {
    const id = e.id(key), col = new Float32Array(g.nx * g.nz), top = new Float32Array(g.nx * g.nz);
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const i = x + g.nx * (z + g.nz * y);
      if (g.id[i] === id && g.amount[i] > 0) { col[x + g.nx * z] += g.amount[i]; top[x + g.nx * z] = Math.max(top[x + g.nx * z], y + g.amount[i]); }
    }
    for (const p of g.particles ?? []) if (p.id === id) { const x = Math.floor(p.x), z = Math.floor(p.z); if (x >= 0 && z >= 0 && x < g.nx && z < g.nz) col[x + g.nx * z] += p.mass; }
    return { col, top };
  };
  const footprint = (g, key, cx, cz) => {
    const { col, top } = columns(g, key);
    let cols = 0, reach = 0, peak = 0, mass = 0;
    for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const a = col[x + g.nx * z]; if (!(a > 1e-4)) continue;
      cols++; mass += a; peak = Math.max(peak, top[x + g.nx * z]); reach = Math.max(reach, Math.abs(x - cx), Math.abs(z - cz));
    }
    return { cols, reach, peak: r2(peak), mass: r2(mass) };
  };
  const amount = async (key) => (await e.census()).liquid[e.nameOf(e.id(key))] ?? 0;
  if (list.includes('spread')) {
    await e.create(N); e.box([14, 0, 14], [17, 3, 17], 'WATER');
    const rows = [];
    for (const t of [0.1, 0.2, 0.4, 0.8, 1.6]) { await e.advance(t - e.time); rows.push([t, footprint(await e.read(), 'WATER', 15.5, 15.5)]); }
    out.spread = rows;
  }
  if (list.includes('drain')) {
    await e.create(N);
    e.box([0, 0, 0], [8, 31, 7], 'WALL'); e.box([1, 13, 1], [7, 31, 6], 'AIR'); e.box([1, 13, 1], [7, 30, 6], 'WATER'); e.box([8, 14, 3], [8, 14, 3], 'AIR');
    const level = (g) => { const id = e.id('WATER'); let m = 0; for (let y = 13; y < 32; y++) for (let z = 1; z <= 6; z++) for (let x = 1; x <= 7; x++) { const i = x + g.nx * (z + g.nz * y); if (g.id[i] === id) m += g.amount[i]; } return 13 + m / 42; };
    const rows = [[0, r2(level(await e.read()))]];
    for (const t of [0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]) { await e.advance(t - e.time); rows.push([t, r2(level(await e.read()))]); }
    out.drain = rows;
  }
  if (list.includes('splash')) {
    await e.create(N); e.box([15, 10, 15], [16, 11, 16], 'WATER');
    const rows = [];
    for (const t of [0.1, 0.15, 0.2, 0.3, 0.45, 0.8]) { await e.advance(t - e.time); rows.push([t, footprint(await e.read(), 'WATER', 15.5, 15.5)]); }
    out.splash = rows;
  }
  if (list.includes('wall')) {
    const rows = [];
    for (const [d, h] of wallCases) {
      await e.create(N); e.box([d, h, 14], [d + 1, h, 15], 'NITRO');
      await e.advance(0.05); const before = await amount('NITRO');
      await e.advance(0.75); rows.push([d, h, r2(before), r2(await amount('NITRO'))]);
    }
    out.wall = rows;
  }
  if (list.includes('mounds')) {
    for (const key of ['MUD', 'LAVA']) {
      await e.create(N); e.box([14, 0, 14], [17, 3, 17], key);
      const rows = [];
      for (const t of [0.5, 1, 2, 3]) { await e.advance(t - e.time); rows.push([t, footprint(await e.read(), key, 15.5, 15.5)]); }
      out[key.toLowerCase()] = rows;
    }
  }
  if (list.includes('mercury')) {
    const rows = [];
    for (const gap of [0, 1, 2]) {
      await e.create(N); e.box([12, 0, 12], [19, 1, 19], 'NITRO'); e.box([15, 2 + gap, 15], [16, 2 + gap, 16], 'MERCURY');
      await e.advance(0.05); const before = await amount('NITRO');
      await e.advance(1.0); rows.push([gap, r2(before), r2(await amount('NITRO'))]);
    }
    out.mercury = rows;
  }
  if (list.includes('outcomes')) {
    const { TESTS } = await import('/tools/outcomes/tests/index.js');
    const { runTest } = await import('/tools/outcomes/run.js');
    for (const name of tests) {
      const r = await runTest(TESTS.find(t => t.name === name), e, { seed: 1 });
      out[`outcome ${name}`] = { status: r.status, headline: r.headline ?? r.reason, criteria: (r.criteria ?? []).map(c => [c.name, c.measured]), numbers: r.numbers };
    }
  }
  await e.dispose();
  return out;
}

const vite = await startVite({ harness: true });
let browser;
const errors = [];
try {
  browser = await launchBrowser();
  for (const engine of engines) {
    const page = await openHarness(browser, vite, `/tools/harness/outcomes.html?engine=${engine}`, { errors, timeout: 20000 });
    await page.evaluate(setup, engine);
    const out = await page.evaluate(run, [scenes, WALL_CASES, outcomes]);
    await page.close();
    for (const [k, v] of Object.entries(out)) console.log(`${engine} ${k}: ${JSON.stringify(v)}`);
    console.log(`${engine} done [${at()}]`);
  }
} finally {
  await browser?.close();
  await vite.close();
}
console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'no page errors', `(${at()})`);
process.exit(errors.length ? 1 : 0);
