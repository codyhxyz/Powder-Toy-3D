// The simulation's harness page (docs/webgpu.md I1, I2): the Simulation on
// this page's WebGPU device, no app. tools/sim-check.mjs, activity-check.mjs
// --harness, budget-check's sim scenarios and the sim bench page drive it
// through window.__harness: they call the helpers below from page.evaluate.
//   make(n | [nx, ny, nz], opts)   a Simulation, its pipelines ready
//   scene(sim, name, seed)         load a scene built on the CPU (seeded)
//   hashes(sim)                    FNV-1a of the state, flow, copies and maps
//   seed(s)                        seed Math.random (mulberry32, as tools/regress.mjs)

import { boot, ready, log } from './harness.js';
import { Simulation, cellTexel } from '/src/sim.js';
import { buildPreset } from '/src/presets.js';
import { E, ELEMENTS } from '/src/elements.js';
import { SEED_MAX } from '/src/shaders/common.js';

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
  // a closed metal box with a hot spot (conservation of Σ cap·T)
  heat(set, g) {
    const lo = 4, hi = Math.min(g.nx, g.ny, g.nz) - 5;
    for (let y = lo; y <= hi; y++)
      for (let z = lo; z <= hi; z++)
        for (let x = lo; x <= hi; x++) {
          const shell = x === lo || x === hi || y === lo || y === hi || z === lo || z === hi;
          const hot = Math.abs(x - (lo + hi) / 2) < 2 && Math.abs(y - (lo + hi) / 2) < 2 && Math.abs(z - (lo + hi) / 2) < 2;
          set(x, y, z, E.METAL, shell ? {} : { temp: hot ? 600 : 20 });
        }
  },
  // a wood pile with a flame on top
  burn(set, g) {
    const c = g.nx / 2;
    for (let y = 0; y < 4; y++)
      for (let z = c - 4; z < c + 4; z++)
        for (let x = c - 4; x < c + 4; x++) set(x, y, z, E.WOOD);
    for (let z = c - 2; z < c + 2; z++)
      for (let x = c - 2; x < c + 2; x++) set(x, 4, z, E.FIRE);
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
// maps (inert, quiet, awake) and drawn.
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
  let cp = 0x811c9dc5;
  for (const c of [0, 1]) for (const arr of [copies.A[c], copies.B[c], copies.F[c]]) cp = fnv(w32(arr), cp);
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

log('sim-check page ready');
ready();
