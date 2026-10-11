// The simulation's harness page (docs/webgpu.md I1, I2): the Simulation on
// this page's WebGPU device, no app. tools/sim-check.mjs, activity-check.mjs
// --harness, budget-check's sim scenarios and the sim bench page drive it
// through window.__harness: they call the helpers below from page.evaluate.
//   make(n | [nx, ny, nz], opts)   a Simulation, its pipelines ready
//   scene(sim, name, seed)         load a scene built on the CPU (seeded)
//   hashes(sim)                    FNV-1a of the state, flow, copies and maps
//   seed(s)                        seed Math.random (mulberry32, as tools/regress.mjs)

import { boot, ready, log, test } from './harness.js';
import { Simulation, cellTexel, slotCell } from '/src/sim.js';
import { buildPreset } from '/src/presets.js';
import { E, ELEMENTS, TOOLS, PROP_TOOL, DECO_TOOLS } from '/src/elements.js';
import { PHYS } from '/src/physics.js';
import { SEED_MAX, SUPER_TEX, prelude, STATE_OPTS } from '/src/shaders/common.js';
import { MOVE_FORM, MOVE_FORMS } from '/src/shaders/move.js';
import { uniformStruct } from '/src/gpu/params.js';
import { GRAV, AIR, EDGE, SIM_MODE_DEFAULTS } from '/src/simModes.js';
import { PROP, boxFromCorners, oneShotRate, runFill } from '/src/editing.js';

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

// (sim-check --unit super sets h.sleepUnit: every sim then sleeps by supertiles, D5.2's A/B)
h.sleepUnit = null;
h.make = async (n, opts = {}) => {
  const [nx, ny, nz] = Array.isArray(n) ? n : [n, n, n];
  const sim = new Simulation(gpu, nx, ny, nz, { debug: true, sleepUnit: h.sleepUnit, ...opts });
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
// runs compare), and hashes after each stretch, with the share of units the
// current map draws (share: the sleeping rules skipped the rest).
async function script(sim, { steps, every, paint = true }) {
  const g = sim.g, out = [];
  for (let k = 0; k < steps / every; k++) {
    if (paint) {
      const tool = [E.SAND, E.WATER, -2, E.OIL][k % 4];   // -2: heat (elements.js TOOLS)
      sim.paint({ center: V(g.nx * (0.3 + 0.1 * (k % 4)), g.ny * 0.7, g.nz * 0.4), radius: 3, shape: k & 1, tool, rate: 1, replace: false });
    }
    for (let i = 0; i < every; i++) sim.step();
    const [hs, n] = await Promise.all([h.hashes(sim), sim.readCounts()]);
    out.push({ ...hs, share: n.drawn / n.units });
  }
  return out;
}
// The lowest and highest DRAWN share of a script's checkpoints, as text.
const shares = (r) => {
  const s = r.map((x) => x.share);
  return `DRAWN ${(100 * Math.min(...s)).toFixed(0)}-${(100 * Math.max(...s)).toFixed(0)}% of units`;
};

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
  async determinism({ size = 32, steps = size > 32 ? 24 : 72, every = size > 32 ? 8 : 18, scene = 'lab' } = {}) {
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
    // (only where it fits the stage's budget: at 32³ here, at every size on the Mac's GPU)
    if (size > 32 && gpu.adapterInfo.isFallbackAdapter) return out;
    const probe = (test) => run(size, scene, { test: { raceProbe: true, ...test } }, (sim) => script(sim, { steps, every }));
    const r1 = await probe({}), r2 = await probe({ listOrder: 'reverse', blockOrder: 'reverse' });
    const raceDiffs = r1.r.filter((x, i) => same(r2.r[i], x, ['state']).length).length;
    out.raceProbe = `race probe (reads the next block's cell in place), in order vs lists and blocks reversed: state differs at ${raceDiffs} of ${r1.r.length} checkpoints`;
    return out;
  },

  // I2.2: skipping exact (every brick dispatched vs the sleeping rules), and
  // DRAWN bounded with one-step maps and a write every step
  async sleep({ size = 32, steps = size > 32 ? 24 : 48, every = 12, scenes = size > 32 ? ['lab', 'pile'] : ['lab', 'pile', 'pool', 'idle'] } = {}) {
    const out = { checks: [], ms: {} };
    // (each comparison also asserts the sleeping run skipped units at some
    // checkpoint: one that draws every unit compares nothing)
    const skipped = (r) => Math.min(...r.map((x) => x.share)) < 1;
    for (const scene of scenes) {
      const a = await run(size, scene, {}, (sim) => script(sim, { steps, every }));
      const b = await run(size, scene, { setup: (sim) => { sim.skipSleeping = false; } }, (sim) => script(sim, { steps, every }));
      out.ms[scene] = { sleeping: a.ms / steps, everyBrick: b.ms / steps };
      const diffs = a.r.map((x, i) => same(x, b.r[i], LINES).map((k) => `${k}@${(i + 1) * every}`)).flat();
      check(out, `${scene}: sleeping = every brick (state, flow, copies, maps; ${a.r.length} checkpoints)`, !diffs.length, diffs.join(' '));
      check(out, `${scene}: the sleeping run skipped units (${shares(a.r)})`, skipped(a.r));
      check(out, `${scene}: no out-of-grid access`, a.dbg === 0 && b.dbg === 0, `dbgOob ${a.dbg}, ${b.dbg}`);
    }
    // writes between single steps: a paint after every step, so every map gets one step (the case D5.3 exists for)
    const single = (sim) => script(sim, { steps: size > 32 ? 8 : 20, every: 1 });
    const a = await run(size, 'pile', {}, single);
    const b = await run(size, 'pile', { setup: (sim) => { sim.skipSleeping = false; } }, single);
    const diffs = a.r.map((x, i) => same(x, b.r[i], LINES).map((k) => `${k}@${i + 1}`)).flat();
    check(out, `a write between single steps: sleeping = every brick (${shares(a.r)})`, !diffs.length && skipped(a.r),
      skipped(a.r) ? diffs.join(' ') : 'every unit drawn at every checkpoint');
    // bounded: a unit DRAWN under map k was AWAKE under one of maps k-2..k, or holds a brick the paint touches
    const bounded = await run(size, 'pile', {}, async (sim) => {
      const g = sim.g, c = V(g.nx / 2, 4, g.nz / 2), r = 2;
      const box = sim.touchCentres([c.x - r, c.y - r, c.z - r], [c.x + r, c.y + r, c.z + r]);
      const inBox = (bx, by, bz) => [bx, by, bz].every((v, k) => v * 4 + 3 >= box.lo[k] && v * 4 <= box.hi[k]);
      const last = new Map();
      const bad = [];
      let maxDrawn = 0;
      for (let k = 0; k < (size > 32 ? 12 : 32); k++) {
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
        if (k > 2) maxDrawn = Math.max(maxDrawn, drawn);   // (past the load's forced maps)
      }
      return { bad, maxDrawn };
    });
    check(out, `one-step maps with a write every step: DRAWN bounded (at most ${bounded.r.maxDrawn} of ${size ** 3 / 64} bricks)`, !bounded.r.bad.length, bounded.r.bad.slice(0, 5).join(', '));
    return out;
  },

  // I2.3: cells per element exact where the rules conserve them; Σ cap·T in
  // a closed metal world within 1e-5 relative
  async conservation({ size = 32, steps = size > 32 ? 100 : 300, every = 50 } = {}) {
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
    const hs = size > 32 ? 40 : 100;
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
  // world at rest certifies idle
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
    // A world at rest certifies idle: sand lying wall to wall (it starts at
    // rest). Not a block that falls and settles: a settled pile's corner grain
    // whose diagonal-below cell is air never tests inert (inertNear's lower
    // ring, kept from the WebGL build), though no Margolus block ever holds
    // both cells (that takes mixed parities), so it can't fall there; and
    // impact heat keeps a pile awake for hundreds of steps. Both are the WebGL
    // build's rules, kept for parity (docs/webgpu.md A goal 2).
    const rest = await run(size, 'floor', {}, async (sim) => {
      let steps = 0;
      for (; steps < 200 && !sim.idleCertified; steps++) {
        sim.step();
        if (steps % 8 === 7) { await sim.gpuSync(); await wait(); }
      }
      const c = await sim.readCounts();
      return { steps, idle: sim.idleCertified, counts: c };
    });
    check(out, `sand at rest wall to wall certifies idle (after ${rest.r.steps} steps; AWAKE ${rest.r.counts.awake}, DRAWN ${rest.r.counts.drawn})`, rest.r.idle);
    check(out, 'no out-of-grid access', [sand, water, burn, heat, rest].every((x) => x.dbg === 0));
    return out;
  },

  // I2.5: the move in place and out of place (whitewater's mode, one pipeline)
  // give the same state and flow; and the move's two code forms (D2: the
  // shipping one and the other, which the sim bench times against it) give
  // the same state, so the bench's A/B and a later switch are exact
  async moves({ size = 32, steps = size > 32 ? 30 : 60, every = 15, scene = 'lab' } = {}) {
    const out = { checks: [], ms: {} };
    const a = await run(size, scene, {}, (sim) => script(sim, { steps, every }));
    // an aeration field that does nothing but asks for the out-of-place move (gfx/foam.js attaches the real one)
    const stub = { active: true, step() {}, idle() {}, reset() {} };
    const b = await run(size, scene, { setup: (sim) => sim.attachAeration(stub) }, (sim) => script(sim, { steps, every }));
    out.ms = { inPlace: a.ms / steps, outOfPlace: b.ms / steps };
    const keys = [...LINES, 'drawn'];
    const diffs = a.r.map((x, i) => same(x, b.r[i], keys).map((k) => `${k}@${(i + 1) * every}`)).flat();
    check(out, `in place = out of place (state, flow, copies, maps, drawn; ${a.r.length} checkpoints)`, !diffs.length, diffs.join(' '));
    for (const form of Object.keys(MOVE_FORMS).filter((f) => f !== MOVE_FORM)) {
      const c = await run(size, scene, { sim: { form } }, (sim) => script(sim, { steps, every }));
      out.ms[form] = c.ms / steps;
      const fd = a.r.map((x, i) => same(x, c.r[i], keys).map((k) => `${k}@${(i + 1) * every}`)).flat();
      check(out, `the move's ${form} form = its ${MOVE_FORM} form (state, flow, copies, maps, drawn; ${a.r.length} checkpoints)`, !fd.length, fd.join(' '));
      check(out, `${form} form: no out-of-grid access`, c.dbg === 0, `dbgOob ${c.dbg}`);
    }
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
      // a two-phase edit (reads: 'neighbours', D6): every cell of the box takes
      // the state of the cell below it, every read seeing the state before the edit
      const lift = sim.editKernel('liftCheck', {
        reads: 'neighbours',
        update: /* wgsl */ `fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let q = p - vec3i(0, 1, 0);
  if (inGrid(q)) { *oA = fetchA(q); *oB = fetchB(q); }
}`,
      });
      await lift.ready;
      // A one-brick edit, then at once (same task: the encoder holding the
      // first is still open) one over a box that outgrows its scratch. The
      // scratch the first used is retired without a flush, and the bind group
      // that held it dropped; both lifts land.
      const g = sim.g, small = { lo: [8, 8, 8], hi: [9, 9, 9] }, lo = [3, 2, 5], hi = [g.nx - 6, Math.floor(g.ny / 2), g.nz - 3];
      const [A0, B0] = await sim.readState();
      sim.edit(lift, small);
      const scratch = sim.editScratch, open = gpu.frame.open, flushes = gpu.stats.flushes;
      sim.edit(lift, { lo, hi });
      const grown = { open, regrown: sim.editScratch !== scratch, groups: lift.groups.size, flushes: gpu.stats.flushes - flushes };
      const [A1, B1] = await sim.readState();
      // the reference: both lifts on the CPU, each reading the state before it
      const liftRef = ([A, B], l, u) => {
        const [A2, B2] = [A.slice(), B.slice()];
        for (let y = l[1]; y <= u[1]; y++) for (let z = l[2]; z <= u[2]; z++) for (let x = l[0]; x <= u[0]; x++) {
          if (y === 0) continue;   // (the cell below is outside the grid: kept)
          const t = cellTexel(g, x, y, z) * 4, src = cellTexel(g, x, y - 1, z) * 4;
          A2.set(A.subarray(src, src + 4), t);
          B2.set(B.subarray(src, src + 4), t);
        }
        return [A2, B2];
      };
      const [AR, BR] = liftRef(liftRef([A0, B0], small.lo, small.hi), lo, hi);
      let wrong = 0;
      for (let i = 0; i < AR.length; i++) if (!Object.is(A1[i], AR[i]) || !Object.is(B1[i], BR[i])) wrong++;
      // a probe (sim.probe, D6): a kernel reads cells into slots of a ring of
      // the caller's; each slot holds what readCell reads
      const PP = uniformStruct('ProbeCheckParams', { cell: 'vec3i', slot: 'u32' });
      const ring = gpu.readback.ring('sim-check probe', 32, 8);
      const probeLayout = gpu.layout('sim-check probe', [{ binding: 0, buffer: { type: 'storage' } }]);
      const probe = gpu.kernel({
        name: 'probeCheck', layouts: [sim.L.TABLES, sim.L.STATE_RO, probeLayout], params: PP, workgroupSize: [1, 1, 1],
        code: /* wgsl */ `${prelude(g, STATE_OPTS.STATE_RO)}
${PP.wgsl}
@group(3) @binding(1) var<uniform> P: ProbeCheckParams;
@group(2) @binding(0) var<storage, read_write> res: array<vec4f>;
@compute @workgroup_size(1) fn main() { res[2u * P.slot] = fetchA(P.cell); res[2u * P.slot + 1u] = fetchB(P.cell); }`,
      });
      await probe.ready;
      const probeGroup = gpu.bindGroup(probeLayout, [{ binding: 0, resource: { buffer: ring.buffer } }], 'sim-check probe');
      const cells = [[3, 1, 4], [g.nx / 2, 0, g.nz / 2], [g.nx - 1, g.ny - 1, g.nz - 1], [10, 5, g.nz - 12]];
      const probed = await Promise.all(cells.map((c) => sim.probe(probe, [1, 1, 1], { ring, bind: [sim.tables, sim.bindRO, probeGroup], params: { cell: c } })));
      const read = await Promise.all(cells.map((c) => sim.readCell(...c)));
      const probeWrong = cells.filter((c, i) => {
        const f = new Float32Array(probed[i]);
        return [...read[i][0], ...read[i][1]].some((x, j) => !Object.is(x, f[j]));
      }).length;
      ring.close();
      // an edit with bindings of its own (editKernel's layout, edit's opts.bind):
      // every cell of a box takes its A from the caller's buffer, a vec4f a cell, x fastest
      const stamp = sim.editKernel('stampCheck', {
        layout: [{ binding: 0, buffer: { type: 'read-only-storage' } }],
        decls: '@group(2) @binding(0) var<storage, read> stampA: array<vec4f>;',
        update: /* wgsl */ `fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let n = P.editHi - P.editLo + vec3i(1);
  let q = p - P.editLo;
  *oA = stampA[q.x + n.x * (q.y + n.y * q.z)];
}`,
      });
      await stamp.ready;
      // Three boxes of one size, from two ranges of one buffer (a pooled
      // upload buffer's sub-ranges, B6): the first from the range at 0, the
      // second and third from the range after it. Two bind groups, one per range.
      const sn = [10, 7, 6], boxes = [[5, 3, 6], [5, 3, 18], [17, 3, 6]].map((l) => ({ lo: l, hi: l.map((v, k) => v + sn[k] - 1) }));
      const cellsIn = sn[0] * sn[1] * sn[2], bytes = cellsIn * 16, range = Math.ceil(bytes / 256) * 256;
      const values = [0, 1].map((r) => {
        const v = new Float32Array(cellsIn * 4);
        const ids = r ? [E.WATER, E.OIL, E.STONE] : [E.STONE, E.WATER, E.SAND, E.EMPTY, E.OIL];
        for (let i = 0; i < cellsIn; i++) v.set([ids[i % ids.length], 20 + r * 30 + (i % 7), 0, ((i + r) * 0.37) % 1], i * 4);
        return v;
      });
      const stampBuf = gpu.createBuffer({ label: 'sim-check stamp', size: 2 * range, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      gpu.write(stampBuf, 0, values[0]);
      gpu.write(stampBuf, range, values[1]);
      const [S0, T0] = await sim.readState();
      boxes.forEach((box, i) => sim.edit(stamp, box, {}, { bind: [{ buffer: stampBuf, offset: i ? range : 0, size: bytes }] }));
      const stampGroups = stamp.groups.size;
      const [S1, T1] = await sim.readState();
      let stampWrong = 0;
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const t = cellTexel(g, x, y, z) * 4;
        const i = boxes.findIndex((b) => [x, y, z].every((v, k) => v >= b.lo[k] && v <= b.hi[k]));
        const q = i < 0 ? null : [x, y, z].map((v, k) => v - boxes[i].lo[k]);
        const want = q ? values[i ? 1 : 0].subarray((q[0] + sn[0] * (q[1] + sn[1] * q[2])) * 4) : S0.subarray(t);
        for (let c = 0; c < 4; c++) if (!Object.is(S1[t + c], want[c]) || !Object.is(T1[t + c], T0[t + c])) stampWrong++;
      }
      stampBuf.destroy();
      // more ranges than a kernel keeps groups for (EDIT_GROUPS_MAX, 64): 70
      // one-cell edits, each from a range of its own, still each write its value
      const many = 70, cellAt = (i) => [2 + (i % 10) * 2, 12, 2 + Math.floor(i / 10) * 2];
      const manyBuf = gpu.createBuffer({ label: 'sim-check ranges', size: many * 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const manyVal = (i) => [[E.STONE, E.SAND, E.WATER][i % 3], 100 + i, 0, 0.5];
      for (let i = 0; i < many; i++) gpu.write(manyBuf, i * 256, new Float32Array(manyVal(i)));
      for (let i = 0; i < many; i++) sim.edit(stamp, { lo: cellAt(i), hi: cellAt(i) }, {}, { bind: [{ buffer: manyBuf, offset: i * 256, size: 16 }] });
      const manyGroups = stamp.groups.size;
      const [S2] = await sim.readState();
      let manyWrong = 0;
      for (let i = 0; i < many; i++) {
        const t = cellTexel(g, ...cellAt(i)) * 4, want = manyVal(i);
        for (let c = 0; c < 4; c++) if (!Object.is(S2[t + c], Math.fround(want[c]))) manyWrong++;
      }
      manyBuf.destroy();
      return {
        exact, sameState: before.state === after.state, copiesEqual, painted: painted.state !== pre.state, undone: undone.state === pre.state,
        wrong, probeWrong, stampWrong, stampGroups, manyWrong, manyGroups, grown,
      };
    });
    check(out, 'two-phase edits read the state before them: two boxes lifted by one cell, exactly', r.r.wrong === 0, `${r.r.wrong} values wrong`);
    const gr = r.r.grown;
    check(out, `a two-phase edit outgrowing the scratch of one still in the open encoder: no flush, one bind group left (open ${gr.open}, regrown ${gr.regrown}, ${gr.flushes} flushes, ${gr.groups} group)`,
      gr.open && gr.regrown && gr.flushes === 0 && gr.groups === 1);
    check(out, 'a probe (sim.probe) reads what readCell reads, at 4 cells', r.r.probeWrong === 0, `${r.r.probeWrong} cells differ`);
    check(out, 'edits with bindings of their own write their boxes from them, and nothing else', r.r.stampWrong === 0, `${r.r.stampWrong} values wrong`);
    check(out, `edits bound to two ranges of one buffer get a bind group a range (${r.r.stampGroups})`, r.r.stampGroups === 2);
    check(out, `70 edits from 70 ranges: each writes its own, the kernel keeps ≤ 64 groups (${r.r.manyGroups})`,
      r.r.manyWrong === 0 && r.r.manyGroups <= 64, `${r.r.manyWrong} values wrong`);
    check(out, 'readState → load → readState: every float bit for bit', r.r.exact && r.r.sameState);
    check(out, 'readCopies after syncCopies: both copies equal, flags included', r.r.copiesEqual);
    check(out, 'snapshot, paint, undo restores the state exactly', r.r.painted && r.r.undone);
    check(out, 'no out-of-grid access', r.dbg === 0, `dbgOob ${r.dbg}`);
    return out;
  },

  // I2.9: after a shift, an edit over the entering slab and 50 steps, the state
  // and flow are the same with and without syncCopies after the fill
  async shift({ size = 32, steps = size > 32 ? 30 : 50 } = {}) {
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
// (modes: simulation modes to set first, src/simModes.js)
test('budget:frame', async ({ scene = 'lab', size = 32, steps = 4, modes = null } = {}) => {
  const sim = await h.make(size, { debug: false });
  try {
    if (modes) Object.assign(sim, modes);
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

// ---------------------------------------------------------------- simulation modes, edges, the brush's tools
// (main's tools/sim-modes-check.mjs, brush-tools-gpu.mjs and editing-gpu-check.mjs,
// on the harness's Simulation at 32³; docs/webgpu.md Sync log S2, S4)

// A scene of boxes (half-open, clipped to the grid): box(x0, y0, z0, x1, y1, z1, key, { T, P, life }).
const boxes = (sim, fill, seed = 12345) => {
  h.seed(seed);
  const g = sim.g, [A, B] = sim.blankState();
  const box = (x0, y0, z0, x1, y1, z1, key, o = {}) => {
    const id = E[key];
    for (let x = Math.max(x0, 0); x < Math.min(x1, g.nx); x++)
      for (let y = Math.max(y0, 0); y < Math.min(y1, g.ny); y++)
        for (let z = Math.max(z0, 0); z < Math.min(z1, g.nz); z++) {
          const i = cellTexel(g, x, y, z) * 4;
          A[i] = id; A[i + 1] = o.T ?? ELEMENTS[id].temp; A[i + 2] = o.life ?? ELEMENTS[id].life; A[i + 3] = Math.random() * SEED_MAX;
          if (o.P != null) B[i + 3] = o.P;
        }
  };
  fill(box, g);
  sim.load(A, B);
};
// Per element: n, mean x, y, z and distance from the centre r, ymax, mean T;
// the air's T range and fastest wind; pressure Σ|P| and max |P|.
const tally = async (sim) => {
  const g = sim.g, [A, B] = await sim.readState();
  const o = { air: { Tmax: -1e9, Tmin: 1e9, vmax: 0 }, Pabs: 0, Pmax: 0 };
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
    const i = cellTexel(g, x, y, z) * 4, id = Math.round(A[i]);
    o.Pabs += Math.abs(B[i + 3]); o.Pmax = Math.max(o.Pmax, Math.abs(B[i + 3]));
    if (id === E.EMPTY) {
      o.air.Tmax = Math.max(o.air.Tmax, A[i + 1]); o.air.Tmin = Math.min(o.air.Tmin, A[i + 1]);
      o.air.vmax = Math.max(o.air.vmax, Math.abs(B[i]), Math.abs(B[i + 1]), Math.abs(B[i + 2]));
      continue;
    }
    const e = (o[ELEMENTS[id]?.key ?? id] ??= { n: 0, x: 0, y: 0, z: 0, ymax: 0, r: 0, T: 0 });
    e.n++; e.x += x; e.y += y; e.z += z; e.ymax = Math.max(e.ymax, y); e.T += A[i + 1];
    e.r += Math.hypot(x + 0.5 - g.nx / 2, y + 0.5 - g.ny / 2, z + 0.5 - g.nz / 2);
  }
  for (const k in o) if (o[k].n) for (const f of ['x', 'y', 'z', 'r', 'T']) o[k][f] /= o[k].n;
  return o;
};
const count = (t, key) => t[key]?.n ?? 0;
const fmt = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v));
const setModes = (sim, m) => Object.assign(sim, { ...SIM_MODE_DEFAULTS, ...m });
const stepN = (sim, k) => { for (let i = 0; i < k; i++) sim.step(); };

const MODE_STAGES = {
  // the gravity modes, judged as main's tools/sim-modes-check.mjs judges
  // them (its 64³ scenes scaled to the grid)
  async modes({ size = 32 } = {}) {
    const out = { checks: [], ms: {} };
    const sim = await h.make(size);
    const n = size, c = n / 2;
    const t0 = performance.now();
    let steps = 0;
    const go = (m) => { stepN(sim, m); steps += m; };
    try {
      // vertical (the default): a block of sand in mid-air falls to the floor
      const SAND = 4 ** 3;
      setModes(sim, {});
      boxes(sim, (box) => box(c - 2, n - 12, c - 2, c + 2, n - 8, c + 2, 'SAND'));
      go(120);
      let t = await tally(sim);
      check(out, `vertical: sand falls to the floor (${fmt(t.SAND)})`, count(t, 'SAND') === SAND && t.SAND.y < 5);
      // off: it stays up; a column on the floor doesn't topple
      setModes(sim, { gravityMode: GRAV.OFF });
      check(out, `off: sim.gravity reads 0 (the body, shots and physgun float): ${sim.gravity}`, sim.gravity === 0);
      boxes(sim, (box) => { box(c - 2, 20, c - 2, c + 2, 24, c + 2, 'SAND'); box(5, 0, 5, 7, 8, 7, 'SAND'); });
      go(50);
      t = await tally(sim);
      {
        const [A] = await sim.readState(), at = (x, y, z) => Math.round(A[cellTexel(sim.g, x, y, z) * 4]);
        let aloft = 0, top = -1;
        for (let y = 15; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) if (at(x, y, z) === E.SAND) aloft++;
        for (let y = 0; y < n; y++) for (let z = 5; z < 7; z++) for (let x = 5; x < 7; x++) if (at(x, y, z) === E.SAND) top = Math.max(top, y);
        check(out, `off: sand in mid-air stays up (${aloft} of ${SAND} aloft)`, aloft > 0.9 * SAND);
        check(out, `off: a sand column stands (top ${top})`, top === 7);
      }
      // radial: sand from the eight corners gathers at the centre; nothing is made or lost
      setModes(sim, { gravityMode: GRAV.RADIAL });
      const lo = 1, hi = n - 4;
      boxes(sim, (box) => {
        for (const x of [lo, hi]) for (const y of [lo, hi]) for (const z of [lo, hi]) box(x, y, z, x + 3, y + 3, z + 3, 'SAND');
        box(c - 3, n - 7, c - 3, c + 3, n - 5, c + 3, 'WATER');
      });
      const r0 = await tally(sim);
      // (where the water's centre of mass is, every 10 steps: since main's
      // sync 3 a liquid in free fall feels no drag, so the water falls in,
      // through the centre and out again, and keeps sloshing round it, |v| ≈
      // 0.5, instead of settling: its mean distance from the centre stays
      // near where it started, its centre of mass doesn't)
      const fromCentre = (w) => (w ? Math.hypot(w.x + 0.5 - c, w.y + 0.5 - c, w.z + 0.5 - c) : n);
      const wr = [];
      for (let k = 0; k < 22; k++) { go(10); wr.push(fromCentre((await tally(sim)).WATER)); }
      t = await tally(sim);
      check(out, `radial: sand gathers at the centre (mean r ${r0.SAND.r.toFixed(1)} → ${t.SAND.r.toFixed(1)})`, t.SAND.r < 0.5 * r0.SAND.r);
      check(out, `radial: no cell made or lost (sand ${count(r0, 'SAND')} → ${count(t, 'SAND')}, water ${count(r0, 'WATER')} → ${count(t, 'WATER')})`,
        count(t, 'SAND') === 8 * 27 && count(t, 'WATER') === count(r0, 'WATER'));
      check(out, `radial: water falls in too (its centre of mass ${fromCentre(r0.WATER).toFixed(1)} from the centre → ${wr.map((r) => r.toFixed(1)).join(', ')})`,
        Math.min(...wr) < 0.4 * fromCentre(r0.WATER));
      out.ms.step = (performance.now() - t0) / steps;
      check(out, 'no out-of-grid access', (await sim.readDebug()) === 0);
    } finally { sim.dispose(); }
    return out;
  },

  // the edge modes (main's tools/sim-modes-check.mjs, its 64³ scenes scaled to the grid)
  async edgemodes({ size = 32 } = {}) {
    const out = { checks: [], ms: {} };
    const sim = await h.make(size);
    const n = size, c = n / 2, SAND = 4 ** 3;
    const t0 = performance.now();
    let steps = 0, t;
    const go = (m) => { stepN(sim, m); steps += m; };
    try {
      // void edges: sand falls out of the floor and is gone
      setModes(sim, { edgeMode: EDGE.VOID });
      boxes(sim, (box) => box(c - 2, 1, c - 2, c + 2, 5, c + 2, 'SAND'));
      go(80);
      t = await tally(sim);
      check(out, `void: sand falls out of the box (${count(t, 'SAND')} of ${SAND} left)`, count(t, 'SAND') < 0.2 * SAND);
      // ...and a blast vents through the sides
      const vent = async (m) => { setModes(sim, m); boxes(sim, (box) => box(0, c - 2, c - 2, 3, c + 2, c + 2, 'EMPTY', { P: 100 })); go(30); return (await tally(sim)).Pabs; };
      const pVoid = await vent({ edgeMode: EDGE.VOID }), pSolid = await vent({});
      check(out, `void: pressure drains out of the sides (Σ|P| ${pVoid.toFixed(1)} void, ${pSolid.toFixed(1)} walls)`, pVoid < pSolid);
      // loop edges: sand falls through the floor and comes back in at the top
      setModes(sim, { edgeMode: EDGE.LOOP });
      boxes(sim, (box) => box(c - 2, 1, c - 2, c + 2, 5, c + 2, 'SAND'));
      let top = 0, lost = 0;
      for (let i = 0; i < 6; i++) {
        go(10);
        t = await tally(sim);
        top = Math.max(top, t.SAND?.ymax ?? 0);
        if (count(t, 'SAND') !== SAND) lost++;
      }
      check(out, `loop: sand falls through the floor and in at the top (highest ${top}), none lost`, top > n - 6 && !lost);
      // ...and water thrown out of +x comes in at -x. (Paced since main's sync
      // 3, a falling blob pushed at 0.8 cells a step crosses a cell on every
      // one of its first 30 steps, so by the last it has gone round the whole
      // box: judged at every push, from the lowest mean x it reached.)
      boxes(sim, (box) => box(n - 4, c - 2, c - 2, n, c + 2, c + 2, 'WATER'));
      let xMin = n;
      lost = 0;
      for (let i = 0; i < 12; i++) {
        const [A, B] = await sim.readState();
        let k = 0, sx = 0;
        for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
          const q = cellTexel(sim.g, x, y, z) * 4;
          if (Math.round(A[q]) !== E.WATER) continue;
          B[q] = 0.8;   // keep pushing it toward +x
          k++; sx += x;
        }
        if (i > 0) xMin = Math.min(xMin, sx / k);
        if (k !== 64) lost++;
        sim.load(A, B);
        go(3);
      }
      t = await tally(sim);
      check(out, `loop: water thrown out of +x comes in at -x (mean x down to ${xMin.toFixed(1)}), none lost (${count(t, 'WATER')})`,
        count(t, 'WATER') === 64 && !lost && xMin < n / 2);
      out.ms.step = (performance.now() - t0) / steps;
      check(out, 'no out-of-grid access', (await sim.readDebug()) === 0);
    } finally { sim.dispose(); }
    return out;
  },

  // the air modes and ambient heat (main's tools/sim-modes-check.mjs)
  async air({ size = 32 } = {}) {
    const out = { checks: [], ms: {} };
    const sim = await h.make(size);
    const c = size / 2;
    try {
      // a blob of pressure
      const blast = async (m) => {
        setModes(sim, m);
        boxes(sim, (box) => box(c - 3, c - 3, c - 3, c + 3, c + 3, c + 3, 'EMPTY', { P: 80 }));
        stepN(sim, 1);
        const t1 = await tally(sim);
        stepN(sim, 16);
        return [t1, await tally(sim)];
      };
      let [a1, a2] = await blast({});
      // (the shock front spreads it, so the total grows while the peak falls)
      check(out, `air on: pressure spreads, fades and blows (Pmax ${a1.Pmax.toFixed(1)} → ${a2.Pmax.toFixed(1)}, wind ${a2.air.vmax.toFixed(3)})`,
        a2.Pmax < a1.Pmax && a2.air.vmax > 0.05);
      [a1, a2] = await blast({ airMode: AIR.PRESSURE_OFF });
      check(out, `pressure off: none left (${a1.Pmax}, ${a2.Pmax})`, a1.Pmax === 0 && a2.Pmax === 0);
      [a1, a2] = await blast({ airMode: AIR.VELOCITY_OFF });
      check(out, `velocity off: pressure stays (${a2.Pmax.toFixed(1)}), the air is still (${a2.air.vmax})`, a2.Pmax > 0 && a2.air.vmax === 0);
      [a1, a2] = await blast({ airMode: AIR.OFF });
      check(out, `air off: no pressure, no wind (${a2.Pmax}, ${a2.air.vmax})`, a2.Pmax === 0 && a2.air.vmax === 0);
      [a1, a2] = await blast({ airMode: AIR.NO_UPDATE });
      check(out, `no update: pressure holds where it is (Σ|P| ${a1.Pabs.toFixed(1)} → ${a2.Pabs.toFixed(1)})`, Math.abs(a2.Pabs - a1.Pabs) < 1e-3 * a1.Pabs);
      // ambient heat: a hot metal block in air
      const hot = async (m) => { setModes(sim, m); boxes(sim, (box) => box(c - 3, c - 3, c - 3, c + 3, c + 3, c + 3, 'METAL', { T: 600 })); stepN(sim, 60); return tally(sim); };
      const on = await hot({}), off = await hot({ ambientHeat: false });
      check(out, `ambient heat on: the metal warms the air (to ${on.air.Tmax.toFixed(1)}) and cools (${on.METAL.T.toFixed(1)})`, on.air.Tmax > 30 && on.METAL.T < 600);
      check(out, `ambient heat off: the air stays at ambient (${off.air.Tmax}), the metal keeps its heat (${off.METAL.T.toFixed(2)})`,
        off.air.Tmax === PHYS.AMBIENT && off.METAL.T > 599.9);
      check(out, 'no out-of-grid access', (await sim.readDebug()) === 0);
    } finally { sim.dispose(); }
    return out;
  },

  // Edges and the in-place move (docs/webgpu.md Sync log S2): one owner per
  // block (the owner check: none twice, and with loop or void edges, or after
  // a switch to loop edges, every cell exactly once a step; the margin run
  // anyway under loop edges must be caught); void
  // edges lose matter only from the boundary; the decoration plane rides the
  // move (U17's attach point), in place and out of place.
  async edges({ size = 32 } = {}) {
    const out = { checks: [], ms: {} };
    const g0 = { slots: size ** 3 };
    // owners under solid edges (the margin runs at odd steps)
    let r = await run(size, 'lab', {}, async (sim) => { stepN(sim, 12); return sim.readOwners(); });
    check(out, `solid edges, the lab, 12 steps: no cell covered twice in a step (${r.r.dup})`, r.r.dup === 0);
    // every brick DRAWN (loop or void edges, radial gravity): every cell has
    // exactly one owner a step; k steps, each's dup and cells not covered
    const onceEach = async (sim, k) => {
      const res = [];
      for (let i = 0; i < k; i++) {
        sim.step();
        const o = await sim.readOwners();
        let other = 0;
        for (let s = 0; s < o.stamps.length; s++) if (o.stamps[s] !== sim.frame) other++;
        res.push({ frame: sim.frame, dup: o.dup, other });
      }
      return res;
    };
    const once = (res) => res.every((x) => x.dup === 0 && x.other === 0);
    const say = (res) => res.map((x) => `${x.frame}: dup ${x.dup}, missed ${x.other}`).join('; ');
    // loop edges: the margin isn't recorded (its blocks are the lists' seen from the far side)
    r = await run(size, 'mix', { setup: (sim) => setModes(sim, { edgeMode: EDGE.LOOP, gravityMode: GRAV.RADIAL }) }, (sim) => onceEach(sim, 4));
    check(out, `loop edges, radial gravity: every cell covered exactly once at each of 4 steps (${say(r.r)})`, once(r.r));
    // void edges: the margin's blocks at odd steps and the lists' blocks, every brick drawn
    r = await run(size, 'mix', { setup: (sim) => setModes(sim, { edgeMode: EDGE.VOID, gravityMode: GRAV.RADIAL }) }, (sim) => onceEach(sim, 4));
    check(out, `void edges, radial gravity: every cell covered exactly once at each of 4 steps (${say(r.r)})`, once(r.r));
    check(out, 'void edges: no out-of-grid access', r.dbg === 0, `dbgOob ${r.dbg}`);
    // a switch mid-run: the lab under solid edges until bricks are quiet, then
    // loop edges (every cell once a step from the next), then solid again
    r = await run(size, 'lab', {}, async (sim) => {
      stepN(sim, 5);
      const quiet = (await sim.readMaps()).quiet.reduce((m, v) => m + v, 0);
      setModes(sim, { edgeMode: EDGE.LOOP });
      const loop = await onceEach(sim, 4);
      setModes(sim, { edgeMode: EDGE.SOLID });
      stepN(sim, 6);
      return { quiet, loop, back: (await sim.readOwners()).dup };
    });
    check(out, `solid → loop edges after ${r.r.quiet} bricks went quiet: every cell covered exactly once at each of 4 steps (${say(r.r.loop)}); back to solid, none twice in 6 steps (${r.r.back})`,
      r.r.quiet > 0 && once(r.r.loop) && r.r.back === 0);
    check(out, 'the switches: no out-of-grid access', r.dbg === 0, `dbgOob ${r.dbg}`);
    // the negative control: the margin's blocks run too under loop edges, so blocks straddling an edge get a second owner
    r = await run(size, 'mix', { setup: (sim) => setModes(sim, { edgeMode: EDGE.LOOP }), test: { loopMargin: true } }, async (sim) => {
      do sim.step(); while ((sim.frame & 1) === 0);   // to an odd step: the margin's
      return sim.readOwners();
    });
    check(out, `negative control: the margin run under loop edges is caught (${r.r.dup} cells covered twice)`, r.r.dup > 0);
    check(out, 'no out-of-grid access', r.dbg === 0, `dbgOob ${r.dbg}`);
    // void edges: per step, an element loses at most what it had on the
    // boundary (a cell next to the void), none at even steps (no block
    // straddles an edge), and nothing is made
    r = await run(size, 'empty', { setup: (sim) => setModes(sim, { edgeMode: EDGE.VOID }) }, async (sim) => {
      const n = size;
      boxes(sim, (box) => {
        box(4, 0, 4, n - 4, 2, n - 4, 'SAND');
        box(0, 3, n / 2 - 4, 4, 8, n / 2 + 4, 'WATER');
        box(n / 2 - 3, n / 2, n / 2 - 3, n / 2 + 3, n / 2 + 4, n / 2 + 3, 'OIL');
      });
      const census = async () => {
        const [A] = await sim.readState(), all = {}, edge = {};
        for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
          const id = Math.round(A[cellTexel(sim.g, x, y, z) * 4]);
          all[id] = (all[id] ?? 0) + 1;
          if (x === 0 || y === 0 || z === 0 || x === n - 1 || y === n - 1 || z === n - 1) edge[id] = (edge[id] ?? 0) + 1;
        }
        return { all, edge };
      };
      let prev = await census(), lost = 0;
      const bad = [];
      for (let i = 0; i < 30; i++) {
        sim.step();
        const now = await census();
        for (const id of [E.SAND, E.WATER, E.OIL]) {
          const d = (prev.all[id] ?? 0) - (now.all[id] ?? 0);
          lost += Math.max(d, 0);
          if (d < 0 || d > (prev.edge[id] ?? 0) || (d > 0 && (sim.frame & 1) === 0)) bad.push(`${ELEMENTS[id].key} −${d} at step ${sim.frame} (${prev.edge[id] ?? 0} on the boundary)`);
        }
        prev = now;
      }
      return { lost, bad };
    });
    check(out, `void edges: matter leaves only from the boundary, at odd steps (${r.r.lost} cells gone over 30 steps)`, r.r.lost > 0 && !r.r.bad.length, r.r.bad.slice(0, 4).join('; '));
    // a sealed glass tank on the floor: water inside it, a block falling in
    r = await run(size, 'empty', { setup: (sim) => setModes(sim, { edgeMode: EDGE.VOID }) }, async (sim) => {
      const n = size;
      boxes(sim, (box) => {
        box(2, 0, 2, n - 2, n - 10, n - 2, 'GLASS');
        box(3, 1, 3, n - 3, n - 11, n - 3, 'EMPTY');
        box(3, 1, 3, n - 3, 8, n - 3, 'WATER');
        box(6, n - 15, 6, 10, n - 12, 10, 'WATER');
      });
      const c0 = (await h.census(sim)).n;
      stepN(sim, 40);
      const c1 = (await h.census(sim)).n;
      return { c0, c1 };
    });
    check(out, `void edges: a sealed glass tank keeps every cell (water ${r.r.c0[E.WATER]} → ${r.r.c1[E.WATER]}, glass ${r.r.c0[E.GLASS]} → ${r.r.c1[E.GLASS]})`,
      r.r.c0[E.WATER] === r.r.c1[E.WATER] && r.r.c0[E.GLASS] === r.r.c1[E.GLASS]);
    // the decoration plane (U17's attach point): tag every non-empty cell with
    // its state A's w (bits), which these scenes never change; after the
    // steps every cell must hold its content's tag, or 0 for air
    const decoRun = (name, m, aer) => run(size, 'mix', { setup: (sim) => setModes(sim, m) }, async (sim) => {
      const g = sim.g, n = g.slots;
      sim.attachDeco({});
      const tags = async () => {
        const [A] = await sim.readState(), a32 = new Uint32Array(A.buffer, A.byteOffset, A.length), t = new Uint32Array(n);
        for (let s = 0; s < n; s++) {
          const q = cellTexel(g, ...slotCell(g, s)) * 4;
          t[s] = Math.round(A[q]) === E.EMPTY ? 0 : a32[q + 3];
        }
        return t;
      };
      gpu.write(sim.decoPlane.buffer, sim.decoPlane.offset, await tags());
      // whitewater's moveSrc plane comes after it: the plane moves to a new buffer, its words kept
      if (aer) sim.attachAeration({ active: true, step() {}, idle() {}, reset() {} });
      stepN(sim, 30);
      const want = await tags(), p = sim.decoPlane;
      const got = new Uint32Array(await gpu.readback.buffer(p.buffer, p.offset, p.size));
      let wrong = 0, painted = 0;
      for (let s = 0; s < n; s++) { if (got[s] !== want[s]) wrong++; if (want[s]) painted++; }
      return { wrong, painted, side: sim.moveSrc.size };
    });
    for (const [name, m, aer] of [['vertical gravity', {}, false], ['radial gravity and loop edges, out of place', { gravityMode: GRAV.RADIAL, edgeMode: EDGE.LOOP }, true]]) {
      r = await decoRun(name, m, aer);
      check(out, `${name}: the decoration plane rides the move (${r.r.wrong} of ${g0.slots} cells wrong, ${r.r.painted} tagged; moveSrc's buffer ${r.r.side} B)`,
        r.r.wrong === 0 && r.r.painted > 0 && r.r.side === g0.slots * 4 * (aer ? 2 : 1));
    }
    return out;
  },

  // Radial gravity and loop edges: cells per element exact (the move's frames
  // and wrapped blocks only permute), and permuted lists and blocks give the
  // same hashes (I2.1)
  async radial({ size = 32, steps = 60 } = {}) {
    const out = { checks: [], ms: {} };
    const keep = [E.SAND, E.WATER, E.STONE, E.WALL, E.OIL];
    let r;
    for (const [name, m] of [['radial gravity', { gravityMode: GRAV.RADIAL }], ['loop edges', { edgeMode: EDGE.LOOP }],
      ['radial gravity and loop edges', { gravityMode: GRAV.RADIAL, edgeMode: EDGE.LOOP }]]) {
      r = await run(size, 'mix', { setup: (sim) => setModes(sim, m) }, async (sim) => {
        const c0 = (await h.census(sim)).n, bad = [];
        for (let k = 0; k < 3; k++) {
          stepN(sim, steps / 3);
          const c = (await h.census(sim)).n;
          for (const id of keep) if ((c[id] ?? 0) !== (c0[id] ?? 0)) bad.push(`${ELEMENTS[id].key} ${c0[id]} → ${c[id]} at ${(k + 1) * steps / 3}`);
        }
        return { c0, bad };
      });
      out.ms[name] = r.ms / steps;
      check(out, `${name}: cells per element exact over ${steps} steps (${keep.map((id) => `${ELEMENTS[id].key} ${r.r.c0[id] ?? 0}`).join(', ')})`, !r.r.bad.length, r.r.bad.join('; '));
      check(out, `${name}: no out-of-grid access`, r.dbg === 0, `dbgOob ${r.dbg}`);
    }
    // determinism with radial gravity and loop edges (I2.1): permuted lists and blocks
    const det = (test) => run(size, 'lab', { setup: (sim) => setModes(sim, { gravityMode: GRAV.RADIAL, edgeMode: EDGE.LOOP }), test }, (sim) => script(sim, { steps: 24, every: 8 }));
    const base = await det({});
    for (const [name, test] of [['listOrder reverse', { listOrder: 'reverse' }], ['blockOrder reverse', { blockOrder: 'reverse' }]]) {
      const v = await det(test);
      const diffs = v.r.map((x, i) => same(base.r[i], x, [...LINES, 'drawn']).map((k) => `${k}@${(i + 1) * 8}`)).flat();
      check(out, `radial gravity, loop edges: ${name} = base (state, flow, copies, maps, drawn at ${v.r.length} checkpoints)`, !diffs.length, diffs.join(' '));
    }
    check(out, 'no out-of-grid access', base.dbg === 0, `dbgOob ${base.dbg}`);
    return out;
  },

  // TPT's brush tools and editing tools on the brush's kernel, no steps
  // (main's tools/brush-tools-gpu.mjs and editing-gpu-check.mjs, scaled to
  // 32³), and the console's rectangle read
  async tools({ size = 32 } = {}) {
    const out = { checks: [] };
    const sim = await h.make(size);
    const n = size, c = [n / 2, n / 2, n / 2], cc = c.map((x) => x + 0.5);
    const T = Object.fromEntries(TOOLS.map((t) => [t.key, t.id]));
    const V = (x, y, z) => ({ x, y, z });
    const paint = (tool, { at = cc, radius = 5, shape = 0, wind = null, times = 1, ...more } = {}) => {
      for (let i = 0; i < times; i++) sim.paint({ center: V(...at), radius, shape, tool, rate: 1, replace: false, wind, ...more });
    };
    const cell = async (x, y, z) => { const [A, B] = await sim.readCell(x, y, z); return { id: Math.round(A[0]), T: A[1], v: [B[0], B[1], B[2]], P: B[3] }; };
    const near = (x, want, tol = 1e-3) => Math.abs(x - want) <= tol * Math.max(1, Math.abs(want));
    const ids = (A) => { const m = {}; for (let i = 0; i < A.length; i += 4) m[Math.round(A[i])] = (m[Math.round(A[i])] ?? 0) + 1; return m; };
    const fill = (f) => {
      const [A, B] = sim.blankState();
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) {
        const key = f(x, y, z);
        if (!key) continue;
        const id = E[key], i = cellTexel(sim.g, x, y, z) * 4;
        A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = Math.random() * SEED_MAX;
      }
      sim.load(A, B);
    };
    try {
      h.seed(4242);
      // ---- Mix ----
      const layer = (y) => ['SAND', 'SALT', 'WATER', 'OIL', 'STEAM', 'SMOKE'][(y >> 1) % 6];
      fill((x, y, z) => (Math.hypot(x + 0.5 - c[0], z + 0.5 - c[2]) < 6 && y < n ? ((x + y + z) % 11 === 0 ? 'WALL' : (y % 7 === 6 ? null : layer(y))) : null));
      const [A0, B0] = await sim.readState();
      paint(T.MIX, { radius: 5, times: 100 });
      const [A1, B1] = await sim.readState();
      const n0 = ids(A0), n1 = ids(A1);
      let changed = 0, fixed = 0, pMoved = 0;
      for (let i = 0; i < A0.length; i += 4) {
        const i0 = Math.round(A0[i]), i1 = Math.round(A1[i]);
        if (i0 !== i1) changed++;
        if ((i0 === E.EMPTY || i0 === E.WALL) && i1 !== i0) fixed++;
        if (!Object.is(B0[i + 3], B1[i + 3])) pMoved++;
      }
      check(out, `Mix keeps every element's cell count (${Object.keys(n0).length} elements) and mixed ${changed} cells`,
        Object.keys({ ...n0, ...n1 }).every((k) => n0[k] === n1[k]) && changed > 0);
      check(out, `Mix never moves air or walls (${fixed}), leaves pressure in place (${pMoved})`, fixed === 0 && pMoved === 0);
      // ---- Vacuum ----
      fill(() => null);
      paint(T.VACUUM);
      let p = (await cell(...c)).P;
      check(out, `Vacuum: -${PHYS.TOOL_PRESSURE} at the centre (${p})`, near(p, -PHYS.TOOL_PRESSURE));
      paint(T.VACUUM, { times: 20 });
      p = (await cell(...c)).P;
      check(out, `Vacuum stops at P_MIN (${p})`, near(p, PHYS.P_MIN));
      // ---- Wind, Cyclone, gravity wells, ambient heat: on air, a sand cell and a wall cell ----
      const [sx, sy, sz] = [c[0] + 3, c[1], c[2]];   // east of the centre, inside the brush's falloff
      const fresh = () => fill((x, y, z) => (x === sx && y === sy && z === sz ? 'SAND' : x === sx - 1 && y === sy && z === sz ? 'WALL' : null));
      const air = () => cell(c[0] + 1, c[1], c[2]), sand = () => cell(sx, sy, sz), wall = () => cell(sx - 1, sy, sz);
      fresh();
      paint(T.WIND, { wind: [2, 0, 0] });
      const ra = PHYS.RHO_MIN / Math.max(ELEMENTS[E.SAND].dens * PHYS.RHO_SCALE, PHYS.RHO_MIN);
      const [wa, ws, ww] = [await air(), await sand(), await wall()];
      check(out, `Wind: air +x at ${wa.v[0].toFixed(3)} (want ${(2 * PHYS.TOOL_WIND).toFixed(3)}), sand its share (${ws.v[0].toFixed(4)}), walls still`,
        near(wa.v[0], 2 * PHYS.TOOL_WIND, 0.02) && ws.v[0] > 0 && ws.v[0] < wa.v[0] * ra * 1.01 && ww.v.every((v) => v === 0));
      fresh();
      paint(T.CYCLONE);
      const cs = await sand();
      check(out, `Cyclone: east of the centre goes north (-z): ${cs.v.map((v) => v.toFixed(4))}`, cs.v[2] < 0 && Math.abs(cs.v[0]) < 1e-6);
      fresh();
      paint(T.GRAV_IN);
      const [gs, ga] = [await sand(), await air()];
      check(out, `PGRV pulls sand in (${gs.v[0].toFixed(3)}), not air`, gs.v[0] < 0 && ga.v.every((v) => v === 0));
      fresh();
      paint(T.GRAV_OUT);
      check(out, `NGRV pushes sand out (${(await sand()).v[0].toFixed(3)})`, (await sand()).v[0] > 0);
      fresh();
      const sT = (await sand()).T;
      paint(T.AMB_HEAT);
      let ct = (await cell(...c)).T;
      check(out, `AMBP warms air (${ct}), not sand`, near(ct, PHYS.AMBIENT + PHYS.TOOL_HEAT) && (await sand()).T === sT);
      fresh();
      paint(T.AMB_COOL);
      ct = (await cell(...c)).T;
      check(out, `AMBM cools air (${ct}), not sand`, near(ct, PHYS.AMBIENT - PHYS.TOOL_HEAT) && (await sand()).T === sT);
      // ---- the editing tools: a line, a box, replace with a target, PROP, specific delete, a fill ----
      fill(() => null);
      const census = async () => (await h.census(sim)).n;
      const full = (id) => oneShotRate(id, 1);
      const la = [4.5, 20.5, 16.5], lb = [28.5, 20.5, 20.5], R = 2;
      sim.paint({ center: V(...la), end: V(...lb), radius: R, shape: 0, tool: E.SAND, rate: full(E.SAND), replace: false });
      let want = 0;
      const s = lb.map((v, k) => v - la[k]), ss = s.reduce((m, v) => m + v * v, 0);
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) {
        const d = [x + 0.5 - la[0], y + 0.5 - la[1], z + 0.5 - la[2]];
        const t = Math.min(Math.max((d[0] * s[0] + d[1] * s[1] + d[2] * s[2]) / ss, 0), 1);
        if (Math.hypot(d[0] - s[0] * t, d[1] - s[1] * t, d[2] - s[2] * t) <= R) want++;
      }
      const nl = (await census())[E.SAND] ?? 0;
      check(out, `a line is the brush swept along it (${nl} cells, the CPU's ${want})`, Math.abs(nl - want) <= want * 0.01);
      const bx = boxFromCorners({ x: 10.5, y: 3, z: 10.5 }, { x: 15.5, y: 3, z: 13.5 }, 2, [n, n, n]);
      const wet = boxFromCorners({ x: 13.5, y: 3, z: 9.5 }, { x: 18.5, y: 3, z: 14.5 }, 2, [n, n, n]);
      const vol = (b) => b.hi.map((v, k) => v - b.lo[k]).reduce((m, v) => m * v, 1);
      sim.paint({ center: V(bx.center.x, bx.center.y, bx.center.z), grow: bx.grow, radius: 2, shape: 1, tool: E.WALL, rate: full(E.WALL), replace: false });
      const nw = (await census())[E.WALL] ?? 0, corner = await cell(...bx.lo), past = await cell(bx.hi[0], bx.lo[1], bx.lo[2]);
      check(out, `a box fills exactly its cells (${nw} of ${vol(bx)})`, nw === vol(bx) && corner.id === E.WALL && past.id === E.EMPTY);
      sim.paint({ center: V(wet.center.x, wet.center.y, wet.center.z), grow: wet.grow, radius: 2, shape: 1, tool: E.WATER, rate: full(E.WATER), replace: true, filter: E.WALL });
      const overlap = [0, 1, 2].map((k) => Math.max(0, Math.min(bx.hi[k], wet.hi[k]) - Math.max(bx.lo[k], wet.lo[k]))).reduce((m, v) => m * v, 1);
      let cn = await census();
      check(out, `replace with a target touches only the target (water ${cn[E.WATER] ?? 0} = ${overlap}, wall ${cn[E.WALL]} = ${vol(bx) - overlap})`,
        (cn[E.WATER] ?? 0) === overlap && cn[E.WALL] === vol(bx) - overlap);
      sim.paint({ center: V(bx.center.x, bx.center.y, bx.center.z), grow: bx.grow, radius: 2, shape: 1, tool: PROP_TOOL, rate: 1, replace: false, prop: { field: PROP.TEMP, value: 500 } });
      const wallT = (await cell(...bx.lo)).T, airT = (await cell(bx.lo[0], bx.hi[1] + 1, bx.lo[2])).T;
      sim.paint({ center: V(5.5, 25.5, 5.5), radius: 2, shape: 1, tool: PROP_TOOL, rate: 1, replace: false, prop: { field: PROP.PRESSURE, value: 42 } });
      const airP = (await cell(5, 25, 5)).P;
      check(out, `PROP sets matter (${wallT} °C), leaves the air's temperature (${airT}), sets the air's pressure (${airP})`, wallT === 500 && airT === PHYS.AMBIENT && near(airP, 42));
      sim.paint({ center: V(wet.center.x, wet.center.y, wet.center.z), grow: wet.grow, radius: 2, shape: 1, tool: E.SAND, rate: 1, replace: false, erase: true, filter: E.WATER });
      cn = await census();
      check(out, `specific delete erases only the target (water ${cn[E.WATER] ?? 0}, wall ${cn[E.WALL]})`, !cn[E.WATER] && cn[E.WALL] === vol(bx) - overlap);
      // a flood fill: a wall bowl (x, z 4..11, y 0..5, hollow 5..10 from y 1), water up to y = 3
      fill((x, y, z) => (x >= 4 && x < 12 && z >= 4 && z < 12 && y < 6 && (y === 0 || x === 4 || x === 11 || z === 4 || z === 11) ? 'WALL' : null));
      const fr = await runFill(sim, { cell: [7, 1, 7], id: E.EMPTY, maxY: 3, stroke: { radius: 3, shape: 0, tool: E.WATER, rate: full(E.WATER), replace: false, erase: false, prop: null } });
      cn = await census();
      check(out, `the fill fills the bowl to its level (${fr.count} cells, water ${cn[E.WATER] ?? 0}, want ${6 * 6 * 3})`, fr.count === 6 * 6 * 3 && cn[E.WATER] === 6 * 6 * 3);
      // U17's hooks (docs/webgpu.md Sync log S3): the first deco stroke makes
      // the decoration layer (decoFactory), and a brush stroke shows it the
      // box's cells before its in-place write (beforeWrite) and after it
      // (scrub), so it can scrub the cells given a new element
      fill(() => null);
      const slots = sim.g.slots, bytes = slots * 16;
      const plane = (label) => gpu.createBuffer({ label, size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const seen = { before: plane('deco check before'), after: plane('deco check after'), calls: [], made: 0 };
      const keepA = (f, into) => f.copy(sim.state.A, sim.cur * bytes, into, 0, bytes);
      try {
        sim.decoFactory = () => {
          seen.made++;
          return {
            paint: (stroke) => seen.calls.push(`paint ${stroke.tool}`),
            beforeWrite: (f, box) => { seen.calls.push('before'); seen.box = box; keepA(f, seen.before); },
            scrub: (f, box) => { seen.calls.push(box === seen.box ? 'scrub' : 'scrub (another box)'); keepA(f, seen.after); },
          };
        };
        const deco = DECO_TOOLS[0].id;
        paint(deco, { times: 2 });
        sim.paint({ center: V(...cc), radius: 3, shape: 0, tool: E.SAND, rate: full(E.SAND), replace: false });
        const [A1] = await sim.readState();
        const [before, after] = (await Promise.all([seen.before, seen.after].map((b) => gpu.readback.buffer(b, 0, bytes)))).map((x) => new Float32Array(x));
        let made = 0, wrongBefore = 0, wrongAfter = 0, outside = 0;
        const { lo, hi } = seen.box;
        for (let s = 0; s < slots; s++) {
          const p = slotCell(sim.g, s), id = Math.round(after[4 * s]);
          if (before[4 * s] !== E.EMPTY) wrongBefore++;
          if (id !== Math.round(A1[cellTexel(sim.g, ...p) * 4])) wrongAfter++;
          if (id === E.EMPTY) continue;
          made++;
          if (p.some((v, k) => v < lo[k] || v > hi[k])) outside++;
        }
        const calls = seen.calls.join(', '), want = `paint ${deco}, paint ${deco}, before, scrub`;
        check(out, `deco hooks: made on the first deco stroke (${seen.made}), then ${calls}`, seen.made === 1 && calls === want && sim.deco !== null, `want ${want}`);
        check(out, `deco hooks: beforeWrite sees the cells before the write (${wrongBefore} not air), scrub after it (${wrongAfter} wrong; ${made} sand cells, ${outside} outside its box)`,
          wrongBefore === 0 && wrongAfter === 0 && made > 0 && outside === 0);
        let threw = false;
        try { sim.scrubDeco(); } catch { threw = true; }
        check(out, 'scrubDeco on its own is a J3 stub (the scrub rides on the write)', threw);
      } finally {
        sim.decoFactory = null;
        sim.attachDeco(null);
        sim._retire(seen.before);   // (once the frame that copies into them is done)
        sim._retire(seen.after);
      }
      // the console's reads (src/console/gpu.js): rectangles of the atlas,
      // async only, each converting only itself; several in one task share
      // the scratch (each copy is recorded before the next one's dispatch)
      const [SA, SB] = await sim.readState(), g = sim.g;
      const rects = [[8, 4, 24, 6], [0, 0, SUPER_TEX, SUPER_TEX], [g.width - SUPER_TEX, g.height - SUPER_TEX, SUPER_TEX, SUPER_TEX], [0, 3, g.width, 2 * SUPER_TEX - 3], [5, 7, 1, 1]];
      const bufs = rects.map(([, , w, hh]) => [new Float32Array(w * hh * 4), new Float32Array(w * hh * 4)]);
      await Promise.all(rects.map(([x, y, w, hh], i) => sim.readStateRect(x, y, w, hh, ...bufs[i], true)));
      let rectWrong = 0;
      rects.forEach(([rx, ry, rw, rh], i) => {
        const [ra2, rb2] = bufs[i];
        for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) for (let k = 0; k < 4; k++) {
          const t = ((ry + y) * g.width + rx + x) * 4 + k, q = (y * rw + x) * 4 + k;
          if (!Object.is(SA[t], ra2[q]) || !Object.is(SB[t], rb2[q])) rectWrong++;
        }
      });
      // as the state is at the call: a paint recorded after it isn't in it
      const pc = cellTexel(g, 3, 3, 3), [pa, pb] = [new Float32Array(4), new Float32Array(4)];
      const pending = sim.readStateRect(pc % g.width, Math.floor(pc / g.width), 1, 1, pa, pb, true);
      sim.paint({ center: V(3.5, 3.5, 3.5), radius: 1, shape: 1, tool: E.STONE, rate: full(E.STONE), replace: true });
      await pending;
      const painted = (await cell(3, 3, 3)).id;
      let threw = false, rejected = false;
      try { sim.readStateRect(8, 4, 24, 6, bufs[0][0], bufs[0][1]); } catch { threw = true; }
      try { await sim.readStateRect(g.width - 4, 0, 8, 1, bufs[0][0], bufs[0][1], true).catch(() => { rejected = true; }); } catch { rejected = false; }
      check(out, `readStateRect reads readState's rectangles (${rects.length} in one task, a row band and a texel among them: ${rectWrong} wrong)`, rectWrong === 0);
      check(out, `readStateRect reads the state at the call (${Math.round(pa[0])} there, ${painted} after the paint recorded next)`, Math.round(pa[0]) === Math.round(SA[pc * 4]) && painted === E.STONE && Math.round(pa[0]) !== E.STONE);
      check(out, 'readStateRect refuses to read synchronously (throws), and rejects a rectangle outside the atlas', threw && rejected);
      check(out, 'no out-of-grid access', (await sim.readDebug()) === 0);
    } finally { sim.dispose(); }
    return out;
  },
};
Object.assign(STAGES, MODE_STAGES);

// Steps until the world certifies idle (at most k steps), reading the counts as it goes.
const settle = async (sim, k) => {
  let steps = 0;
  for (; steps < k && !sim.idleCertified; steps++) {
    sim.step();
    if (steps % 8 === 7) { await sim.gpuSync(); await wait(); }
  }
  return { steps, idle: sim.idleCertified };
};

// Main's sync-3 rules (docs/webgpu.md Sync log, sync 3).
const SYNC3_STAGES = {
  // The scene's ambient air temperature (sim.airT, the tables' airT: main's
  // uAirT) and the rest rules: a matter face rests while the heat it carries
  // is at most REST_FLUX; water, ice and snow pinned at the phase point with
  // latent heat banked rest. airT is the device's (one value for every
  // simulation, as main's uniform), so each case sets it and the stage puts
  // it back.
  async rest({ size = 32 } = {}) {
    const out = { checks: [] };
    const n = size;
    const sim = await h.make(n);
    const frozen = (T = -15) => boxes(sim, (box) => box(0, 0, 0, n, n, n, 'EMPTY', { T }));
    const airRange = (t) => `${t.air.Tmin.toFixed(3)}..${t.air.Tmax.toFixed(3)}`;
    try {
      // air at -15 °C: at room temperature's airT it isn't at rest and warms
      frozen();
      let r = await settle(sim, 24);
      let t = await tally(sim);
      check(out, `airT ${PHYS.AMBIENT}: air at -15 °C doesn't rest and warms (idle ${r.idle} after ${r.steps} steps, air ${airRange(t)})`, !r.idle && t.air.Tmin > -15);
      // ...and at airT -15 it rests, exactly where it is. Set on a live state:
      // every cell's flags are redone (they hold the rest test as written)
      frozen();
      sim.airT = -15;
      await sim.prepare('fresh');   // (the redo waits for its kernel, then records)
      r = await settle(sim, 40);
      t = await tally(sim);
      check(out, `airT -15: the same air rests (idle after ${r.steps} steps) and keeps -15 °C (${airRange(t)})`, r.idle && t.air.Tmin === -15 && t.air.Tmax === -15);
      // set back on the idle world: it wakes, and the air warms toward the new airT
      sim.airT = PHYS.AMBIENT;
      await sim.prepare('fresh');
      const woke = !sim.idleCertified;
      stepN(sim, 16);
      t = await tally(sim);
      check(out, `airT set back on the idle world: it wakes (${woke}) and the air warms (${airRange(t)})`, woke && t.air.Tmax > -15);
      // void edges bring in still air at airT: no heat crosses the box's sides
      sim.airT = -15;
      setModes(sim, { edgeMode: EDGE.VOID });
      frozen();
      stepN(sim, 24);
      t = await tally(sim);
      check(out, `void edges at airT -15: the air keeps -15 °C exactly (${airRange(t)})`, t.air.Tmin === -15 && t.air.Tmax === -15);
      setModes(sim, {});
      // the brush's erase leaves air at airT
      boxes(sim, (box) => { box(0, 0, 0, n, n, n, 'EMPTY', { T: -15 }); box(4, 0, 4, 12, 6, 12, 'STONE', { T: -15 }); });
      sim.paint({ center: V(8, 3, 8), radius: 3, shape: 1, tool: TOOLS.find((x) => x.key === 'ERASE').id, rate: 1, replace: false });
      t = await tally(sim);
      check(out, `the brush's erase leaves air at airT (stone ${count(t, 'STONE')} of 384 left, air ${airRange(t)})`, count(t, 'STONE') < 384 && t.air.Tmin === -15 && t.air.Tmax === -15);
      // snow wall to wall at 0 °C with latent heat banked (life: toward melting)
      // under air at 0 °C, airT 0 (main's Mines): pinned at the phase point, it
      // rests (main's rule before sync 3 kept it awake: life ≠ 0)
      sim.airT = 0;
      boxes(sim, (box) => { box(0, 0, 0, n, n, n, 'EMPTY', { T: 0 }); box(0, 0, 0, n, 3, n, 'SNOW', { T: 0, life: 0.4 }); });
      r = await settle(sim, 40);
      t = await tally(sim);
      check(out, `snow at 0 °C with latent heat banked, airT 0: rests (idle ${r.idle} after ${r.steps} steps; snow ${count(t, 'SNOW')} at ${t.SNOW?.T})`,
        r.idle && count(t, 'SNOW') === 3 * n * n);
      sim.airT = PHYS.AMBIENT;
      // A matter face rests by the heat it carries (REST_FLUX): two slabs 0.1 °C
      // apart. Wood (cond 0.008: tolerance REST_FLUX / 0.008 = 0.125 °C)
      // rests at once; metal (cond 0.1: 0.01 °C, MATTER_REST_T) doesn't
      // where the slabs meet. (Before sync 3 every matter face had 0.01 °C.)
      const slabs = async (key) => {
        boxes(sim, (box) => { box(0, 0, 0, n, n / 2, n, key, { T: 20 }); box(0, n / 2, 0, n, n, n, key, { T: 20.1 }); });
        sim.step();
        const m = await sim.readMaps();
        return m.inert.length - m.inert.reduce((a, v) => a + (v ? 1 : 0), 0);
      };
      const wood = await slabs('WOOD'), metal = await slabs('METAL');
      check(out, `slabs 0.1 °C apart: wood rests (${wood} bricks not inert), metal doesn't where they meet (${metal} of ${2 * (n / 4) ** 2})`,
        wood === 0 && metal === 2 * (n / 4) ** 2);
      check(out, 'no out-of-grid access', (await sim.readDebug()) === 0);
    } finally {
      sim.airT = PHYS.AMBIENT;
      sim.dispose();
    }
    // the shift's uncovered cells are air at airT (a window's grid)
    const win = await h.make(n, { windowed: true });
    try {
      win.airT = -15;
      boxes(win, (box) => box(0, 0, 0, n, n, n, 'STONE', { T: -15 }));
      win.shift(n / 2, 0);
      const [A] = await win.readState();
      let wrong = 0;
      for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = n / 2; x < n; x++) {
        const i = cellTexel(win.g, x, y, z) * 4;
        if (Math.round(A[i]) !== E.EMPTY || A[i + 1] !== -15) wrong++;
      }
      check(out, `a shift uncovers air at airT -15 (${wrong} of ${n * n * n / 2} cells otherwise)`, wrong === 0);
      check(out, 'the shift: no out-of-grid access', (await win.readDebug()) === 0);
    } finally {
      win.airT = PHYS.AMBIENT;
      win.dispose();
    }
    return out;
  },

  // Main's coherent jets (ca75fdb, 1c87096): liquid at rest under a head
  // leaves an opening at Torricelli's ORIFICE_CV·√(2gh), counted up its
  // column through a one-cell bubble, capped at FLOW; and a liquid falling
  // through a gas is paced (move.js PACE): a slab of water dropped in the air
  // falls as one layer.
  async jets({ size = 32 } = {}) {
    const out = { checks: [] };
    const n = size;
    const sim = await h.make(n);
    try {
      // Shafts of water in rock, each open at its foot through a tunnel to the
      // air at +x: column[y] says what the shaft holds at height y (W water,
      // a gas cell .), air above. The head h counts the water over the foot
      // cell's centre (0.5, then 1 a water cell), on through a lone gas cell,
      // up to two in a row; the scan stops once √(2gh) reaches FLOW, so a
      // tall column leaves at ORIFICE_CV·√(2gh) of the h it stopped at (just
      // under FLOW: main's rule, kept).
      const shafts = ['WW', 'WWWW', 'WWWWWWW', 'WWWWWWWWWWW', 'WWWWWWWWWWWWWWWW', 'W'.repeat(24), 'WWWW.WWWWW', 'WWWW..WWWW'];
      const water = ELEMENTS[E.WATER], g = Math.fround(sim.gravity) * water.grav, f = Math.fround(water.flow);
      const head = (col) => {
        let h = 0.5, gas = false;
        for (let y = 1; y < n && 2 * g * h < f * f; y++) {
          const c = y < col.length ? col[y] : '.';
          if (c !== 'W' && gas) break;
          gas = c !== 'W';
          if (c === 'W') h += 1;
        }
        return h;
      };
      boxes(sim, (box) => {
        box(2, 0, 1, 7, n, 1 + 3 * shafts.length, 'ROCK');
        shafts.forEach((col, k) => {
          const z = 2 + 3 * k;
          box(4, 0, z, 5, n, z + 1, 'EMPTY');
          for (let y = 0; y < col.length; y++) if (col[y] === 'W') box(4, y, z, 5, y + 1, z + 1, 'WATER');
          box(5, 0, z, 7, 1, z + 1, 'EMPTY');   // the tunnel out
        });
      });
      sim.step();
      const got = await Promise.all(shafts.map((_, k) => sim.readCell(4, 0, 2 + 3 * k)));
      const rows = shafts.map((col, k) => {
        const h = head(col), want = Math.min(Math.fround(PHYS.ORIFICE_CV) * Math.sqrt(2 * g * h), f);
        const [, B] = got[k];
        return { col, h, want, vx: B[0], vz: B[2], ok: Math.abs(B[0] - want) <= 1e-5 * want && B[2] === 0 };
      });
      check(out, `Torricelli: the foot of each shaft leaves at min(ORIFICE_CV·√(2gh), FLOW) toward its opening (${rows.map((r) => `h ${r.h}: ${r.vx.toFixed(4)}/${r.want.toFixed(4)}`).join(', ')})`,
        rows.every((r) => r.ok), rows.filter((r) => !r.ok).map((r) => `${r.col}: vx ${r.vx} vz ${r.vz} want ${r.want}`).join('; '));
      // a 4×1×4 slab of water in the air: every cell falls on the same paced
      // steps, so it stays one layer all the way down
      const y0 = n - 6, c = n / 2;
      boxes(sim, (box) => box(c - 2, y0, c - 2, c + 2, y0 + 1, c + 2, 'WATER'));
      const layers = [];
      for (let k = 0; k < 4; k++) {
        stepN(sim, 9);
        const [A] = await sim.readState();
        const ys = new Set();
        for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
          if (Math.round(A[cellTexel(sim.g, x, y, z) * 4]) === E.WATER) ys.add(y);
        }
        layers.push([...ys]);
      }
      const last = layers.at(-1);
      check(out, `a falling slab of water stays one layer (heights at steps 9, 18, 27, 36: ${layers.map((l) => l.join('/')).join(', ')})`,
        layers.every((l) => l.length === 1) && last[0] < y0 - 6);
      check(out, 'no out-of-grid access', (await sim.readDebug()) === 0);
    } finally { sim.dispose(); }
    return out;
  },
};
Object.assign(STAGES, SYNC3_STAGES);

// TPT's Mix after the first stroke (a two-phase edit: two dispatches), a
// flood fill after the first (a read of state A, an upload of its mask and
// one edit; its buffer is made once), and the console's reads of 4 blocks in
// one frame after the first (src/console/gpu.js readBlocks: a read a block,
// each converting only its supertile's square).
test('budget:tools', async () => {
  const sim = await h.make(32, { debug: false });
  try {
    h.scene(sim, 'pile');
    const req = { cell: [16, 1, 16], id: E.EMPTY, maxY: 3, stroke: { radius: 3, shape: 0, tool: E.WATER, rate: 1, replace: false, erase: false, prop: null } };
    const mixStroke = () => sim.paint({ center: V(16, 18, 16), radius: 4, shape: 0, tool: TOOLS.find((t) => t.key === 'MIX').id, rate: 1, replace: false });
    await runFill(sim, req);
    mixStroke();   // (the first makes the two-phase edits' scratch)
    await sim.gpuSync();
    const mix = await measure(async () => { mixStroke(); await sim.gpuSync(); });
    let fill;
    const fillStats = await measure(async () => { fill = await runFill(sim, req); await sim.gpuSync(); });
    const T = SUPER_TEX, block = () => [new Float32Array(T * T * 4), new Float32Array(T * T * 4)];
    const readBlocks = () => Promise.all([0, 1, 2, 3].map((i) => sim.readStateRect(i * T, 0, T, T, ...block(), true)));
    await readBlocks();
    const reads = await measure(readBlocks);
    return { mix, fill: fillStats, filled: fill.count ?? 0, maskBytes: sim.g.width * sim.g.height, reads, blockTexels: T * T };
  } finally { sim.dispose(); }
});

h.STAGES = Object.keys(STAGES);
for (const [name, fn] of Object.entries(STAGES)) test(`stage:${name}`, fn);

log('sim-check page ready');
ready();
