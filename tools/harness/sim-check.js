// The simulation's harness page (docs/webgpu.md I1, I2): the Simulation on
// this page's WebGPU device, no app. tools/sim-check.mjs, activity-check.mjs
// --harness, budget-check's sim scenarios and the sim bench page drive it
// through window.__harness: they call the helpers below from page.evaluate.
//   make(n | [nx, ny, nz], opts)   a Simulation, its pipelines ready
//   scene(sim, name, seed)         load a scene built on the CPU (seeded)
//   hashes(sim)                    FNV-1a of the state, flow, copies and maps
//   seed(s)                        seed Math.random (mulberry32, as tools/regress.mjs)

import { boot, ready, log, test } from './harness.js';
import { Simulation, cellTexel } from '/src/sim.js';
import { buildPreset } from '/src/presets.js';
import { E, ELEMENTS } from '/src/elements.js';
import { SEED_MAX } from '/src/shaders/common.js';
import { inertFold } from '/src/shaders/activity.js';

const h = await boot({ label: 'sim-check' });
const gpu = h.gpu;
Object.assign(h, { Simulation, E, ELEMENTS, cellTexel });

// Math.random from a seed (mulberry32, as tools/regress.mjs), so scenes and
// blankState's seeds repeat.
h.seed = (seed) => {
  let s = seed >>> 0;
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

h.make = async (n, opts = {}) => {
  const [nx, ny, nz] = Array.isArray(n) ? n : [n, n, n];
  const sim = new Simulation(gpu, nx, ny, nz, { debug: true, ...opts });
  await sim.ready;
  return sim;
};

// Scenes built on the CPU (seeded): the app's presets (presets.js
// buildPreset: lab, volcano, …) and small ones of our own.
const SCENES = {
  // a block of sand in the air over a few stones: it falls, piles and settles
  pile(set, g) {
    const c = g.nx / 2, w = Math.max(4, g.nx / 4);
    for (let y = Math.floor(g.ny * 0.5); y < Math.floor(g.ny * 0.5) + w; y++)
      for (let z = c - w / 2; z < c + w / 2; z++)
        for (let x = c - w / 2; x < c + w / 2; x++) set(x, y, z, E.SAND);
    for (let x = 2; x < g.nx - 2; x += 7) set(x, 0, c, E.STONE);
  },
  // a pool in a glass tank, a block of water dropped beside it
  pool(set, g) {
    const lo = 2, hi = g.nx - 3, top = Math.floor(g.ny / 3);
    for (let y = 0; y <= top; y++)
      for (let z = lo; z <= hi; z++)
        for (let x = lo; x <= hi; x++) {
          const wall = x === lo || x === hi || z === lo || z === hi || y === 0;
          if (wall) set(x, y, z, E.GLASS);
          else if (y < top - 2) set(x, y, z, E.WATER);
        }
    for (let y = top + 4; y < top + 8; y++)
      for (let z = lo + 3; z < lo + 7; z++)
        for (let x = lo + 3; x < lo + 7; x++) set(x, y, z, E.WATER);
  },
  // a resting block of stone and sand on the floor: settles to idle
  idle(set, g) {
    const c = g.nx / 2;
    for (let y = 0; y < 3; y++)
      for (let z = c - 4; z < c + 4; z++)
        for (let x = c - 4; x < c + 4; x++) set(x, y, z, y < 2 ? E.STONE : E.SAND);
  },
  // nothing at all
  empty() {},
  // the whole grid metal with a hot spot (conservation of Σ cap·T: the grid's
  // edges insulate, metal neither moves nor radiates)
  heat(set, g) {
    const c = [g.nx / 2, g.ny / 2, g.nz / 2];
    for (let y = 0; y < g.ny; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const hot = Math.abs(x - c[0]) < 3 && Math.abs(y - c[1]) < 3 && Math.abs(z - c[2]) < 3;
          set(x, y, z, E.METAL, { temp: hot ? 600 : 20 });
        }
  },
  // what moves but doesn't react: sand, rubble, water and oil around wall pillars
  mix(set, g) {
    const c = g.nx / 2;
    for (let x = 3; x < g.nx - 3; x += 9) for (let y = 0; y < g.ny / 2; y++) set(x, y, c, E.WALL);
    for (let y = 2; y < 8; y++)
      for (let z = 2; z < c - 2; z++)
        for (let x = 2; x < c - 2; x++) set(x, y + Math.floor(g.ny / 3), z, (x + z) % 3 ? E.SAND : E.STONE);
    for (let y = 0; y < 5; y++)
      for (let z = c + 2; z < g.nz - 2; z++)
        for (let x = c + 2; x < g.nx - 2; x++) set(x, y + Math.floor(g.ny / 4), z, y < 3 ? E.WATER : E.OIL);
  },
  // sand over the whole floor, wall to wall: nowhere to go, so it comes to rest
  floor(set, g) {
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) set(x, y, z, E.SAND);
  },
  // a wood pile past its ignition point in oxygen, so it burns out in a test's
  // steps (in air a wood cell's fuel lasts about 560 steps; oxygen feeds it
  // O2_PER_AIR times faster, physics.js)
  burn(set, g) {
    const c = g.nx / 2;
    for (let y = 0; y < 14; y++)
      for (let z = c - 8; z < c + 8; z++)
        for (let x = c - 8; x < c + 8; x++) set(x, y, z, E.OXYGEN);
    for (let y = 0; y < 3; y++)
      for (let z = c - 4; z < c + 4; z++)
        for (let x = c - 4; x < c + 4; x++) set(x, y, z, E.WOOD, { temp: 400 });
  },
};
h.SCENES = Object.keys(SCENES);

// Loads scene `name` into sim from Math.random seeded with `seed`.
h.scene = (sim, name, seed = 12345) => {
  h.seed(seed);
  if (!SCENES[name]) return buildPreset(name, sim);
  const g = sim.g;
  const [A, B] = sim.blankState();
  const set = (x, y, z, id, extra = {}) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id;
    A[i + 1] = extra.temp ?? e.temp;
    A[i + 2] = e.life;
    A[i + 3] = (extra.ctype ?? 0) + Math.random() * SEED_MAX;
  };
  SCENES[name](set, g);
  sim.load(A, B);
  return null;
};

// FNV-1a over 32-bit words.
const fnv = (words, h0 = 0x811c9dc5) => {
  let x = h0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    x = Math.imul(x ^ (w & 0xff), 16777619); x = Math.imul(x ^ ((w >>> 8) & 0xff), 16777619);
    x = Math.imul(x ^ ((w >>> 16) & 0xff), 16777619); x = Math.imul(x ^ (w >>> 24), 16777619);
  }
  return x >>> 0;
};
const hex = (x) => x.toString(16).padStart(8, '0');
h.fnv = fnv;

// The determinism lines (as tools/state-hash.mjs hashes them): state (A and B
// of every cell, in cell order), flow, copies (both copies, flags included),
// maps (inert, quiet, awake) and drawn. Read right after a step (no
// recording in between), so the current copy is the one sim.cur names.
h.hashes = async (sim) => {
  const g = sim.g;
  const [[A, B], flow, copies, maps] = await Promise.all([sim.readState(), sim.readFlow(), sim.readCopies(), sim.readMaps()]);
  const a32 = new Uint32Array(A.buffer, A.byteOffset, A.length), b32 = new Uint32Array(B.buffer, B.byteOffset, B.length);
  const cells = new Uint32Array(g.slots * 8);
  let k = 0;
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const t = cellTexel(g, x, y, z) * 4;
        for (let c = 0; c < 4; c++) cells[k++] = a32[t + c];
        for (let c = 0; c < 4; c++) cells[k++] = b32[t + c];
      }
  const w32 = (x) => new Uint32Array(x.buffer, x.byteOffset, x.byteLength / 4);
  // (the current copy first: the in-place and out-of-place moves leave the current state in different halves)
  let cp = 0x811c9dc5;
  for (const c of [sim.cur, 1 - sim.cur]) for (const arr of [copies.A[c], copies.B[c], copies.F[c]]) cp = fnv(w32(arr), cp);
  const mapWords = (m) => Uint32Array.from(m);
  return {
    state: hex(fnv(cells)),
    flow: hex(fnv(new Uint32Array(flow.buffer, flow.byteOffset, flow.byteLength / 4))),
    copies: hex(cp),
    maps: hex(fnv(mapWords(maps.awake), fnv(mapWords(maps.quiet), fnv(mapWords(maps.inert))))),
    drawn: hex(fnv(mapWords(maps.drawn))),
  };
};

// Per-element counts and Σ T·cap of the current state.
h.census = async (sim) => {
  const [A] = await sim.readState();
  const g = sim.g, n = {}, heat = { sum: 0 };
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const t = cellTexel(g, x, y, z) * 4, id = Math.floor(A[t] + 0.5);
        n[id] = (n[id] ?? 0) + 1;
        heat.sum += A[t + 1] * ELEMENTS[id].cap;
      }
  return { n, heat: heat.sum };
};


// ---------------------------------------------------------------- the I2 stages
// Each returns { checks: [{ name, ok, detail }], …measurements }; the tool
// prints them and fails on any check not ok (docs/webgpu.md I2).
const check = (out, name, ok, detail = '') => { out.checks.push({ name, ok: Boolean(ok), detail }); return ok; };
const same = (a, b, keys) => keys.filter((k) => a[k] !== b[k]);
const V = (x, y, z) => ({ x, y, z });
const LINES = ['state', 'flow', 'copies', 'maps'];
const wait = () => new Promise((r) => setTimeout(r, 0));

// Steps `steps` steps, painting before every `every`th (a fixed script, so
// runs compare), and hashes after each stretch.
async function script(sim, { steps, every, paint = true }) {
  const g = sim.g, out = [];
  for (let k = 0; k < steps / every; k++) {
    if (paint) {
      const tool = [E.SAND, E.WATER, -2, E.OIL][k % 4];   // -2: heat (elements.js TOOLS)
      sim.paint({ center: V(g.nx * (0.3 + 0.1 * (k % 4)), g.ny * 0.7, g.nz * 0.4), radius: 3, shape: k & 1, tool, rate: 1, replace: false });
    }
    for (let i = 0; i < every; i++) sim.step();
    out.push(await h.hashes(sim));
  }
  return out;
}

async function run(n, scene, opts, fn) {
  const sim = await h.make(n, opts.sim);
  Object.assign(sim.test, opts.test ?? {});
  if (opts.test?.listOrder) await sim.prepare('permute');
  if (opts.test?.raceProbe) await sim.prepare('moveRace');
  if (opts.setup) opts.setup(sim);
  h.scene(sim, scene, opts.seed ?? 12345);
  try {
    const t0 = performance.now();
    const r = await fn(sim);
    return { r, ms: performance.now() - t0, dbg: await sim.readDebug() };
  } finally { sim.dispose(); }
}

// ms per step per kernel (split timestamps) over `steps` steps, and wall ms per step.
async function kernelTimes(sim, steps) {
  const timing = gpu.timing;
  await sim.gpuSync();
  timing.enabled = true; timing.split = true;
  const before = timing.lastFrame, t0 = performance.now();
  for (let i = 0; i < steps; i++) sim.step();
  gpu.endFrame();
  await sim.gpuSync();
  const wall = (performance.now() - t0) / steps;
  for (let k = 0; k < 200 && timing.lastFrame === before; k++) await wait();
  timing.enabled = false; timing.split = false;
  return { wall, gpu: Object.fromEntries(Object.entries(timing.last).map(([k, v]) => [k, v / steps])) };
}

const STAGES = {
  // I2.1, I2.10: two runs with the same seed, and the lists and the thread →
  // block map permuted, give the same hashes at every checkpoint
  async determinism({ size = 32, steps = 96, every = 24, scene = 'lab' } = {}) {
    const out = { checks: [], ms: {} };
    const variants = [
      ['repeat', {}], ['listOrder reverse', { listOrder: 'reverse' }], ['listOrder shuffle:7', { listOrder: 'shuffle:7' }],
      ['blockOrder reverse', { blockOrder: 'reverse' }],
    ];
    const base = await run(size, scene, {}, (sim) => script(sim, { steps, every }));
    out.ms.base = base.ms / steps;
    check(out, 'base run: no out-of-grid access (I2.8)', base.dbg === 0, `dbgOob ${base.dbg}`);
    for (const [name, test] of variants) {
      const v = await run(size, scene, { test }, (sim) => script(sim, { steps, every }));
      const diffs = v.r.map((x, i) => same(base.r[i], x, [...LINES, 'drawn']).map((k) => `${k}@${(i + 1) * every}`)).flat();
      check(out, `${name} = base (state, flow, copies, maps, drawn at ${v.r.length} checkpoints)`, !diffs.length, diffs.join(' '));
      check(out, `${name}: no out-of-grid access`, v.dbg === 0, `dbgOob ${v.dbg}`);
    }
    // I2.10: the race probe reads a cell of the next block, which another thread
    // moves in place: run in two orders, it should differ, which shows the
    // check can see a race. Reported, not asserted: SwiftShader runs blocks
    // nearly in order (it must fail on the Mac, I4.0)
    const probe = (test) => run(size, scene, { test: { raceProbe: true, ...test } }, (sim) => script(sim, { steps, every }));
    const r1 = await probe({}), r2 = await probe({ listOrder: 'reverse', blockOrder: 'reverse' });
    const raceDiffs = r1.r.filter((x, i) => same(r2.r[i], x, ['state']).length).length;
    out.raceProbe = `race probe (reads the next block's cell in place), in order vs lists and blocks reversed: state differs at ${raceDiffs} of ${r1.r.length} checkpoints`;
    return out;
  },

  // I2.2: skipping exact (every brick dispatched vs the sleeping rules), and
  // DRAWN bounded with one-step maps and a write every step
  async sleep({ size = 32, steps = 60, every = 15, scenes = ['lab', 'pile', 'pool', 'idle'] } = {}) {
    const out = { checks: [], ms: {} };
    for (const scene of scenes) {
      const a = await run(size, scene, {}, (sim) => script(sim, { steps, every }));
      const b = await run(size, scene, { setup: (sim) => { sim.skipSleeping = false; } }, (sim) => script(sim, { steps, every }));
      out.ms[scene] = { sleeping: a.ms / steps, everyBrick: b.ms / steps };
      const diffs = a.r.map((x, i) => same(x, b.r[i], LINES).map((k) => `${k}@${(i + 1) * every}`)).flat();
      check(out, `${scene}: sleeping = every brick (state, flow, copies, maps; ${a.r.length} checkpoints)`, !diffs.length, diffs.join(' '));
      check(out, `${scene}: no out-of-grid access`, a.dbg === 0 && b.dbg === 0, `dbgOob ${a.dbg}, ${b.dbg}`);
    }
    // writes between single steps: a paint after every step, so every map gets one step (the case D5.3 exists for)
    const single = (sim) => script(sim, { steps: 24, every: 1 });
    const a = await run(size, 'pile', {}, single);
    const b = await run(size, 'pile', { setup: (sim) => { sim.skipSleeping = false; } }, single);
    const diffs = a.r.map((x, i) => same(x, b.r[i], LINES).map((k) => `${k}@${i + 1}`)).flat();
    check(out, 'a write between single steps: sleeping = every brick', !diffs.length, diffs.join(' '));
    // bounded: a unit DRAWN under map k was AWAKE under one of maps k-2..k, or holds a brick the paint touches
    const bounded = await run(size, 'pile', {}, async (sim) => {
      const g = sim.g, c = V(g.nx / 2, 4, g.nz / 2), r = 2;
      const box = sim.touchCentres([c.x - r, c.y - r, c.z - r], [c.x + r, c.y + r, c.z + r]);
      const inBox = (bx, by, bz) => [bx, by, bz].every((v, k) => v * 4 + 3 >= box.lo[k] && v * 4 <= box.hi[k]);
      const last = new Map();
      const bad = [];
      let maxDrawn = 0;
      for (let k = 0; k < 40; k++) {
        sim.paint({ center: c, radius: r, shape: 1, tool: k & 1 ? -3 : -2, rate: 1, replace: false });   // heat, cool: always a change
        sim.step();
        const m = await sim.readMaps();
        let drawn = 0;
        for (let i = 0; i < m.drawn.length; i++) {
          if (m.awake[i]) last.set(i, k);
          if (!m.drawn[i]) continue;
          drawn++;
          const bx = i % g.bx, by = Math.floor(i / g.bx) % g.by, bz = Math.floor(i / (g.bx * g.by));
          if (k > 2 && !inBox(bx, by, bz) && k - (last.get(i) ?? -1e9) > 2) bad.push(`brick ${i} at map ${k}`);
        }
        maxDrawn = Math.max(maxDrawn, drawn);
      }
      return { bad, maxDrawn };
    });
    check(out, `one-step maps with a write every step: DRAWN bounded (max ${bounded.r.maxDrawn} bricks)`, !bounded.r.bad.length, bounded.r.bad.slice(0, 5).join(', '));
    return out;
  },

  // I2.3: cells per element exact where the rules conserve them; Σ cap·T in
  // a closed metal world within 1e-5 relative
  async conservation({ size = 32, steps = 300, every = 50 } = {}) {
    const out = { checks: [], ms: {} };
    const keep = [E.SAND, E.WATER, E.STONE, E.WALL, E.OIL];
    const r = await run(size, 'mix', {}, async (sim) => {
      const c0 = (await h.census(sim)).n, bad = [];
      for (let k = 0; k < steps / every; k++) {
        for (let i = 0; i < every; i++) sim.step();
        const c = (await h.census(sim)).n;
        for (const id of keep) if ((c[id] ?? 0) !== (c0[id] ?? 0)) bad.push(`${ELEMENTS[id].key} ${c0[id]} → ${c[id]} at ${(k + 1) * every}`);
      }
      return { c0, bad };
    });
    out.ms.mix = r.ms / steps;
    check(out, `cells per element exact over ${steps} steps (${keep.map((id) => `${ELEMENTS[id].key} ${r.r.c0[id] ?? 0}`).join(', ')})`, !r.r.bad.length, r.r.bad.join('; '));
    const hs = 100;
    const heat = await run(size, 'heat', {}, async (sim) => {
      const e0 = (await h.census(sim)).heat, rel = [];
      for (let k = 0; k < 4; k++) {
        for (let i = 0; i < hs / 4; i++) sim.step();
        rel.push(Math.abs((await h.census(sim)).heat - e0) / e0);
      }
      return rel;
    });
    out.ms.heat = heat.ms / hs;
    check(out, `Σ cap·T within 1e-5 relative over ${hs} steps (max ${Math.max(...heat.r).toExponential(2)})`, Math.max(...heat.r) <= 1e-5);
    check(out, 'no out-of-grid access', r.dbg === 0 && heat.dbg === 0, `dbgOob ${r.dbg}, ${heat.dbg}`);
    return out;
  },

  // I2.4: sand falls and piles, water levels, wood burns, heat diffuses, a
  // block of powder comes to rest and the world certifies idle
  async behaviour({ size = 32 } = {}) {
    const out = { checks: [], ms: {} };
    const cells = async (sim) => {
      const [A] = await sim.readState(), g = sim.g, at = (x, y, z) => Math.floor(A[cellTexel(g, x, y, z) * 4] + 0.5);
      return { at, g, A };
    };
    const sand = await run(size, 'pile', {}, async (sim) => {
      const com = async () => {
        const { at, g } = await cells(sim);
        let n = 0, y0 = 0;
        for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) if (at(x, y, z) === E.SAND) { n++; y0 += y; }
        return y0 / n;
      };
      const y0 = await com();
      for (let i = 0; i < 300; i++) sim.step();
      const y1 = await com();
      const { at, g } = await cells(sim);
      let floating = 0;
      for (let y = 1; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        if (at(x, y, z) !== E.SAND) continue;
        const below = at(x, y - 1, z);
        if (below === E.EMPTY) floating++;
      }
      return { y0, y1, floating };
    });
    out.ms.pile = sand.ms / 300;
    check(out, `sand falls (centre of mass ${sand.r.y0.toFixed(1)} → ${sand.r.y1.toFixed(1)}) and rests (grains over air: ${sand.r.floating})`, sand.r.y1 < sand.r.y0 - 4 && sand.r.floating === 0);
    const water = await run(size, 'pool', {}, async (sim) => {
      for (let i = 0; i < 240; i++) sim.step();
      const { at, g } = await cells(sim);
      const tops = [];
      for (let z = 3; z < g.nz - 3; z++) for (let x = 3; x < g.nx - 3; x++) {
        let top = -1;
        for (let y = 0; y < g.ny; y++) if (at(x, y, z) === E.WATER) top = y;
        if (top >= 0) tops.push(top);
      }
      return { lo: Math.min(...tops), hi: Math.max(...tops) };
    });
    out.ms.pool = water.ms / 240;
    check(out, `water levels (top surface ${water.r.lo}..${water.r.hi})`, water.r.hi - water.r.lo <= 1);
    const burn = await run(size, 'burn', {}, async (sim) => {
      const c0 = (await h.census(sim)).n;
      let fire = 0, smoke = 0;
      for (let k = 0; k < 6; k++) {
        for (let i = 0; i < 30; i++) sim.step();
        const c = (await h.census(sim)).n;
        fire = Math.max(fire, c[E.FIRE] ?? 0);
        smoke = Math.max(smoke, c[E.SMOKE] ?? 0);
      }
      const c1 = (await h.census(sim)).n;
      return { wood0: c0[E.WOOD], wood1: c1[E.WOOD] ?? 0, fire, smoke };
    });
    out.ms.burn = burn.ms / 180;
    check(out, `wood burns (wood ${burn.r.wood0} → ${burn.r.wood1}, fire up to ${burn.r.fire}, smoke up to ${burn.r.smoke})`, burn.r.wood1 < burn.r.wood0 && burn.r.fire > 0 && burn.r.smoke > 0);
    const heat = await run(size, 'heat', {}, async (sim) => {
      const variance = async () => {
        const { A, g } = await cells(sim);
        let n = 0, s1 = 0, s2 = 0;
        for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
          const T = A[cellTexel(g, x, y, z) * 4 + 1];
          n++; s1 += T; s2 += T * T;
        }
        return s2 / n - (s1 / n) ** 2;
      };
      const v = [await variance()];
      for (let k = 0; k < 4; k++) { for (let i = 0; i < 15; i++) sim.step(); v.push(await variance()); }
      return v;
    });
    check(out, `heat diffuses (variance of T ${heat.r.map((x) => x.toFixed(1)).join(' → ')})`, heat.r.every((x, i) => i === 0 || x < heat.r[i - 1]));
    const rest = await run(size, 'floor', {}, async (sim) => {
      let steps = 0;
      for (; steps < 200 && !sim.idleCertified; steps++) {
        sim.step();
        if (steps % 8 === 7) { await sim.gpuSync(); await wait(); }
      }
      const c = await sim.readCounts();
      return { steps, idle: sim.idleCertified, counts: c };
    });
    check(out, `a block of powder comes to rest and the world certifies idle (after ${rest.r.steps} steps; AWAKE ${rest.r.counts.awake}, DRAWN ${rest.r.counts.drawn})`, rest.r.idle);
    check(out, 'no out-of-grid access', [sand, water, burn, heat, rest].every((x) => x.dbg === 0));
    return out;
  },

  // I2.5: the move in place and out of place (whitewater's mode, one pipeline) give the same state and flow
  async moves({ size = 32, steps = 60, every = 15, scene = 'lab' } = {}) {
    const out = { checks: [], ms: {} };
    const a = await run(size, scene, {}, (sim) => script(sim, { steps, every }));
    // an aeration field that does nothing but asks for the out-of-place move (gfx/foam.js attaches the real one)
    const stub = { active: true, step() {}, idle() {}, reset() {} };
    const b = await run(size, scene, { setup: (sim) => sim.attachAeration(stub) }, (sim) => script(sim, { steps, every }));
    out.ms = { inPlace: a.ms / steps, outOfPlace: b.ms / steps };
    const diffs = a.r.map((x, i) => same(x, b.r[i], [...LINES, 'drawn']).map((k) => `${k}@${(i + 1) * every}`)).flat();
    check(out, `in place = out of place (state, flow, copies, maps, drawn; ${a.r.length} checkpoints)`, !diffs.length, diffs.join(' '));
    check(out, 'no out-of-grid access', a.dbg === 0 && b.dbg === 0);
    return out;
  },

  // I2.7: readState/load round trip, readCopies after syncCopies, undo
  async io({ size = 32 } = {}) {
    const out = { checks: [] };
    const r = await run(size, 'lab', {}, async (sim) => {
      for (let i = 0; i < 20; i++) sim.step();
      const before = await h.hashes(sim);
      const [A, B] = await sim.readState();
      sim.load(A, B);
      const after = await h.hashes(sim);
      const [A2, B2] = await sim.readState();
      const exact = A.every((x, i) => Object.is(x, A2[i])) && B.every((x, i) => Object.is(x, B2[i]));
      sim.syncCopies();
      const cp = await sim.readCopies();
      const eq = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
      const copiesEqual = eq(cp.A[0], cp.A[1]) && eq(cp.B[0], cp.B[1]) && eq(cp.F[0], cp.F[1]);
      for (let i = 0; i < 6; i++) sim.step();
      const pre = await h.hashes(sim);
      sim.snapshot();
      sim.paint({ center: V(sim.g.nx / 2, sim.g.ny / 2, sim.g.nz / 2), radius: 5, shape: 0, tool: E.STONE, rate: 1, replace: true });
      const painted = await h.hashes(sim);
      sim.undo();
      const undone = await h.hashes(sim);
      return { exact, sameState: before.state === after.state, copiesEqual, painted: painted.state !== pre.state, undone: undone.state === pre.state };
    });
    check(out, 'readState → load → readState: every float bit for bit', r.r.exact && r.r.sameState);
    check(out, 'readCopies after syncCopies: both copies equal, flags included', r.r.copiesEqual);
    check(out, 'snapshot, paint, undo restores the state exactly', r.r.painted && r.r.undone);
    check(out, 'no out-of-grid access', r.dbg === 0, `dbgOob ${r.dbg}`);
    return out;
  },

  // I2.9: after a shift, an edit over the entering slab and 50 steps, the state
  // and flow are the same with and without syncCopies after the fill
  async shift({ size = 32, steps = 50 } = {}) {
    const out = { checks: [] };
    const go = (sync) => run(size, 'lab', { sim: { windowed: true } }, async (sim) => {
      const fill = sim.editKernel('slabFill', {
        update: /* wgsl */ `fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (p.y < 4) { *oA = vec4f(f32(E_SAND), AMBIENT, 0.0, fract(a.w)); }
  else if (p.y < 6 && (p.x + p.z) % 5 == 0) { *oA = vec4f(f32(E_WATER), AMBIENT, 0.0, fract(a.w)); }
}`,
      });
      await fill.ready;
      for (let i = 0; i < 10; i++) sim.step();
      const g = sim.g, dx = 16;
      sim.shift(dx, 0);
      sim.edit(fill, { lo: [g.nx - dx, 0, 0], hi: [g.nx - 1, g.ny - 1, g.nz - 1] });
      if (sync) sim.syncCopies();
      for (let i = 0; i < steps; i++) sim.step();
      return h.hashes(sim);
    });
    const a = await go(false), b = await go(true);
    check(out, `shift + slab edit + ${steps} steps: same state and flow without syncCopies`, a.r.state === b.r.state && a.r.flow === b.r.flow,
      `state ${a.r.state}/${b.r.state} flow ${a.r.flow}/${b.r.flow}`);
    check(out, 'no out-of-grid access', a.dbg === 0 && b.dbg === 0);
    return out;
  },

  // ms per step per kernel (timestamps, split passes) for the tools' step budgets
  async timing({ sizes = [32, 64], scenes = ['empty', 'lab', 'pile'], steps = 10 } = {}) {
    const out = { checks: [], times: [] };
    for (const n of sizes) {
      for (const scene of scenes) {
        const r = await run(n, scene, { sim: { debug: false } }, async (sim) => {
          for (let i = 0; i < 6; i++) sim.step();
          const t = await kernelTimes(sim, steps);
          return { ...t, counts: await sim.readCounts() };
        });
        out.times.push({ n, scene, ...r.r });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- budgets (tools/budgets/sim.mjs)
const measure = async (fn) => {
  const before = { ...gpu.stats };
  await fn();
  return Object.fromEntries(Object.entries(gpu.stats).map(([k, v]) => [k, v - before[k]]));
};
// An idle-certified world's steps record nothing (docs/webgpu.md D4).
test('budget:asleep', async (steps = 10) => {
  const sim = await h.make(32, { debug: false });
  try {
    h.scene(sim, 'floor');
    for (let i = 0; i < 200 && !sim.idleCertified; i++) {
      sim.step();
      if (i % 8 === 7) { await sim.gpuSync(); await wait(); }
    }
    await sim.gpuSync();
    const stats = await measure(async () => { for (let i = 0; i < steps; i++) sim.step(); await sim.gpuSync(); });
    return { stats, idle: sim.idleCertified ? 1 : 0 };
  } finally { sim.dispose(); }
});
// A frame of the lab at 4 steps per frame (the app's default speed): one
// submit, one compute pass, and the indirect dispatches' workgroups (their
// arguments read back) equal to what the lists' lengths call for.
test('budget:frame', async ({ scene = 'lab', size = 32, steps = 4 } = {}) => {
  const sim = await h.make(size, { debug: false });
  try {
    h.scene(sim, scene);
    for (let i = 0; i < 8; i++) sim.step();
    await sim.gpuSync();
    sim.test.logCounts = true;
    sim.countsLog = [];
    const from = gpu.indirectLog.length;
    const stats = await measure(async () => { for (let i = 0; i < steps; i++) sim.step(); gpu.endFrame(); await sim.gpuSync(); });
    sim.test.logCounts = false;
    // (the arguments are read back after the frame, so only the last build's are still there:
    // its steps' move and react dispatches; the inert dispatch's are reset by its own build)
    const log = gpu.indirectLog.slice(from);
    const tail = log.slice(log.map((e) => e.kernel).lastIndexOf('inert') + 1);
    const args = await Promise.all(tail.map((e) => gpu.readback.buffer(e.buffer, e.offset, 12)));
    const workgroups = args.reduce((n, a) => { const [x, y, z] = new Uint32Array(a); return n + x * y * z; }, 0);
    const last = sim.countsLog.at(-1);
    const [, nD, nM] = new Uint32Array(await last.counts);
    const u = sim.unit.bricks;
    let expected = 0;
    for (let frame = last.frame; frame <= sim.frame; frame++) expected += Math.ceil(((frame & 1 ? nM : nD) * u * 8) / 64) + nD * u;
    const builds = sim.countsLog.length;
    const counts = await sim.readCounts();
    return { stats, workgroups, expected, matchesLists: workgroups === expected ? 1 : 0, builds, drawnShare: counts.drawn / counts.units };
  } finally { sim.dispose(); }
});
// One brush stroke: one dispatch (an edit), nothing allocated.
test('budget:paint', async () => {
  const sim = await h.make(32, { debug: false });
  try {
    h.scene(sim, 'empty');
    await sim.gpuSync();
    const stats = await measure(async () => {
      sim.paint({ center: V(16, 16, 16), radius: 4, shape: 0, tool: E.SAND, rate: 1, replace: false });
      await sim.gpuSync();
    });
    return { stats };
  } finally { sim.dispose(); }
});

h.STAGES = Object.keys(STAGES);
for (const [name, fn] of Object.entries(STAGES)) test(`stage:${name}`, fn);

log('sim-check page ready');
ready();
