// The outcome bench's engine on the CPU prototype (tools/v2/lean-sim.mjs's
// World: column fall, block topple, fill + flux liquid, jets as particles), so
// the bench's tests and thresholds are measured on the prototype exactly as on
// the GPU (tools/outcomes.mjs --engine lean). Node only. Its elements are
// air, wall, sand, flour and water; everything else is not expressible (n/a).
// It has no heat, fire, pressure or thrown solids. Contract: ./engine.js.
import { World, AIR, WALL, SAND, FLOUR, WATER, FULL, TICK_HZ, CELL_M, G_MS2, G, VT_SAND } from '../v2/lean-sim.mjs';
import { stepClock } from './engine.js';
import { census } from './lib.js';

const IDS = { AIR, WALL, SAND, FLOUR, WATER };
const NAMES = ['AIR', 'WALL', 'SAND', 'FLOUR', 'WATER'];
const KINDS = { [AIR]: 'air', [WALL]: 'solid', [SAND]: 'powder', [FLOUR]: 'powder', [WATER]: 'liquid' };

export function createEngine() {
  let w = null, clock = stepClock(TICK_HZ), lastBusy = 0;
  return {
    name: 'lean',
    info: { label: 'lean-sim World (CPU prototype, 60 Hz, 2 g)', stepsPerSecond: TICK_HZ, gravity: G_MS2, cellM: CELL_M, fillQuantum: 1 / FULL, pressure: false, burning: false },
    id: (name) => IDS[name] ?? null,
    nameOf: (id) => NAMES[id] ?? `#${id}`,
    kindOf: (id) => KINDS[id] ?? 'solid',
    async create([nx, ny, nz]) {
      w = new World(nx, ny, nz);
      clock = stepClock(TICK_HZ);
      lastBusy = 0;
    },
    box(lo, hi, name, { onlyEmpty = false, v = null } = {}) {
      const e = IDS[name];
      if (e === undefined) throw new Error(`lean: no element ${name}`);
      if (v && v.some((c) => c)) throw new Error('lean: no thrown matter (its particles are liquid only)');
      for (let y = Math.max(0, lo[1]); y <= Math.min(w.ny - 1, hi[1]); y++)
        for (let z = Math.max(0, lo[2]); z <= Math.min(w.nz - 1, hi[2]); z++)
          for (let x = Math.max(0, lo[0]); x <= Math.min(w.nx - 1, hi[0]); x++) {
            const i = w.at(x, y, z);
            if (onlyEmpty && w.id[i] !== AIR) continue;
            w.set(x, y, z, e);
            w.vy[i] = 0; w.acc[i] = 0; w.qx[i] = 0; w.qy[i] = 0; w.qz[i] = 0;
          }
    },
    async advance(seconds) {
      const n = clock.take(seconds);
      for (let k = 0; k < n; k++) lastBusy = w.step();
    },
    get time() { return clock.time; },
    get steps() { return clock.steps; },
    async read() {
      const n = w.n, id = Int32Array.from(w.id), amount = new Float32Array(n);
      for (let i = 0; i < n; i++) if (w.id[i] === WATER) amount[i] = w.fill[i] / FULL;
      const particles = w.parts.map((p) => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, mass: p.m / FULL, id: WATER }));
      for (const p of particles) {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (w.inside(x, y, z)) amount[w.at(x, y, z)] += p.mass;
      }
      return { nx: w.nx, ny: w.ny, nz: w.nz, id, amount, T: null, burning: null, pressure: null, moving: null, particles };
    },
    async census() { return census(await this.read(), this); },
    async activity() {
      const idle = w.idleAt >= 0;
      return { awake: lastBusy, units: w.busy.length, idle, idleSince: idle ? w.idleAt / TICK_HZ : undefined };
    },
    // R1's column fall: a run speeds up by g each tick to its terminal speed (lean-sim slab's ideal)
    fall(name, seconds) {
      if (name !== 'SAND' && name !== 'FLOUR') return null;
      let v = 0, f = 0;
      for (let k = 0; k < Math.round(seconds * TICK_HZ); k++) { v = Math.min(v + G, VT_SAND); f += v; }
      return f;
    },
    flight: () => null,
    park() {}, resume() {},
    async dispose() { w = null; },
  };
}
