// Whitewater's aeration field on the GPU (gfx/foam.js; docs/webgpu.md G4,
// I2.6), driven by tools/aeration-check.mjs: a Simulation on this page's
// device, the field attached, and its reference (the same kernel over every
// brick, aer.enableReference) stepped beside it. After every step both
// current copies are read back and compared word for word.
//   compare(opts)   steps a scene (and idle steps after it), comparing the
//                   field and the reference at each; returns the counts

import { boot, ready, log, test } from './harness.js';
import { Simulation, cellTexel } from '/src/sim.js';
import { E, ELEMENTS } from '/src/elements.js';
import { SEED_MAX, actLayout, ACT_COUNTS } from '/src/shaders/common.js';
import { EDGE } from '/src/simModes.js';
import { setAeration } from '/src/gfx/foam.js';

const h = await boot({ label: 'aeration-check' });
const gpu = h.gpu;

// Math.random from a seed (mulberry32, as tools/regress.mjs), so runs repeat.
const seed = (s0) => {
  let s = s0 >>> 0;
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Scenes: water that falls, lands and splashes, so the field has liquid in
// the air (breakup), landings (entrainment), wakes and pours.
const SCENES = {
  // a pool in a glass tank, a block of water dropped into it from high up,
  // and a thin column falling beside it onto the tank's rim (spray, wakes)
  pool(set, g) {
    const lo = 2, hi = g.nx - 3, top = Math.floor(g.ny / 4);
    for (let y = 0; y <= top; y++)
      for (let z = lo; z <= hi; z++)
        for (let x = lo; x <= hi; x++) {
          const wall = x === lo || x === hi || z === lo || z === hi || y === 0;
          if (wall) set(x, y, z, E.GLASS);
          else if (y < top - 2) set(x, y, z, E.WATER);
        }
    for (let y = g.ny - 9; y < g.ny - 3; y++)
      for (let z = lo + 4; z < lo + 9; z++)
        for (let x = lo + 4; x < lo + 9; x++) set(x, y, z, E.WATER);
    for (let y = top + 6; y < g.ny - 2; y++) set(hi, y, hi - 4, E.WATER);
  },
  // loop edges: water falling across the floor's edge comes back in at the
  // top, and a blob straddling the x edge (edgeCell wraps the source)
  loop(set, g) {
    for (let y = 2; y < 8; y++)
      for (let z = 4; z < 10; z++)
        for (let x = 0; x < 3; x++) { set(x, y, z, E.WATER); set(g.nx - 1 - x, y, z, E.WATER); }
    for (let y = g.ny - 6; y < g.ny; y++)
      for (let z = 12; z < 16; z++)
        for (let x = 12; x < 16; x++) set(x, y, z, E.OIL);
  },
};

function load(sim, name, s) {
  seed(s);
  const g = sim.g;
  const [A, B] = sim.blankState();
  const set = (x, y, z, id) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id;
    A[i + 1] = e.temp;
    A[i + 2] = e.life;
    A[i + 3] = Math.random() * SEED_MAX;
  };
  SCENES[name](set, g);
  sim.load(A, B);
}

// FNV-1a over 32-bit words
const fnv = (w) => {
  let x = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) { x ^= w[i]; x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(16).padStart(8, '0');
};

test('compare', async ({ size = 32, scene = 'pool', steps = 60, idle = 12, dropHistory = false, stopOnMismatch = false, seed: s = 12345 } = {}) => {
  const sim = new Simulation(gpu, size, size, size, { debug: true });
  await sim.ready;
  try {
    if (scene === 'loop') sim.edgeMode = EDGE.LOOP;
    load(sim, scene, s);
    const aer = setAeration(sim, true);
    aer.enableReference();
    aer.test.dropHistory = dropHistory;
    await aer.ready;
    const L = actLayout(sim.g), countAt = (L.count + ACT_COUNTS.AER) * 4;
    const out = { steps: 0, idleSteps: 0, mismatchSteps: 0, firstMismatch: null, maxWords: 0, nonzeroMax: 0, listMin: Infinity, listMax: 0, listSum: 0, hashes: [] };
    const compare = async (label) => {
      const [r, n] = await Promise.all([aer.read(), gpu.readback.buffer(sim.act, countAt, 4)]);
      const listed = new Uint32Array(n)[0];
      let diff = 0, nonzero = 0;
      for (let i = 0; i < r.field.length; i++) {
        if (r.field[i] !== r.reference[i]) diff++;
        if (r.reference[i]) nonzero++;
      }
      out.nonzeroMax = Math.max(out.nonzeroMax, nonzero);
      out.listMin = Math.min(out.listMin, listed);
      out.listMax = Math.max(out.listMax, listed);
      out.listSum += listed;
      if (diff) {
        out.mismatchSteps++;
        out.maxWords = Math.max(out.maxWords, diff);
        out.firstMismatch ??= `${label}: ${diff} words`;
      }
      out.hashes.push(fnv(r.field));
    };
    for (let i = 0; i < steps && !(stopOnMismatch && out.mismatchSteps); i++) {
      sim.step();
      out.steps++;
      await compare(`step ${i + 1}`);
    }
    // the idle path (sim.js step's early return): every cell held in place
    aer.idleSteps = 0;
    for (let i = 0; i < idle && !(stopOnMismatch && out.mismatchSteps); i++) {
      aer.idle(gpu.frame);
      out.idleSteps++;
      await compare(`idle step ${i + 1}`);
    }
    out.nbricks = sim.g.nbricks;
    out.listMean = out.listSum / (out.steps + out.idleSteps);
    out.dbg = await sim.readDebug();
    log(scene, JSON.stringify(out));
    return out;
  } finally { sim.dispose(); }
});

ready();
