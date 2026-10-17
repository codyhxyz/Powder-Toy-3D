// The outcome bench's engine on the column-water prototype (tools/v2/column-water.mjs: column runs with a
// hydrostatic head, compression only under lids, one 60 Hz step; docs/v2/water-cost-first-principles.md),
// so the bench's liquid tests and thresholds measure it exactly as they measure lean (engine-lean.js) and
// the GPU. Node only. Its elements are air, wall and two liquids (water, mud); no powders, heat, fire or air.
// Its resident velocities are complete under its own model (depth-averaged face fluxes, falling runs,
// surface continuity), so the splash test is expressible. Contract: ./engine.js.
import { World, AIR, WALL, WATER, MUD, FULL, TICK_HZ, CELL_M, G_MS2 } from '../v2/column-water.mjs';
import { stepClock } from './engine.js';
import { tally } from './lib.js';

const IDS = { AIR, WALL, WATER, MUD };
const NAMES = { [AIR]: 'AIR', [WALL]: 'WALL', [WATER]: 'WATER', [MUD]: 'MUD' };
const KINDS = { [AIR]: 'air', [WALL]: 'solid', [WATER]: 'liquid', [MUD]: 'liquid' };

export function createEngine() {
  let w = null, clock = stepClock(TICK_HZ), lastBusy = 0;
  return {
    name: 'column',
    info: {
      label: 'column-water World (CPU prototype, 60 Hz, 2 g, one step a tick)', stepsPerSecond: TICK_HZ, clock: `${TICK_HZ} ticks a game second (Speed 1×)`,
      gravity: G_MS2, cellM: CELL_M, fillQuantum: 1 / FULL, velocity: true, pressure: false, airCell: null, burning: false,
    },
    id: (name) => IDS[name] ?? null,
    nameOf: (id) => NAMES[id] ?? `#${id}`,
    kindOf: (id) => KINDS[id] ?? 'solid',
    async create([nx, ny, nz]) { w = new World(nx, ny, nz); clock = stepClock(TICK_HZ); lastBusy = 0; },
    box(lo, hi, name, { onlyEmpty = false, v = null } = {}) {
      const e = IDS[name];
      if (e === undefined) throw new Error(`column: no element ${name}`);
      if (v && v.some((c) => c)) throw new Error('column: no thrown matter');
      for (let y = Math.max(0, lo[1]); y <= Math.min(w.ny - 1, hi[1]); y++)
        for (let z = Math.max(0, lo[2]); z <= Math.min(w.nz - 1, hi[2]); z++)
          for (let x = Math.max(0, lo[0]); x <= Math.min(w.nx - 1, hi[0]); x++) {
            if (onlyEmpty && w.id[w.at(x, y, z)] !== AIR) continue;
            w.set(x, y, z, e);
          }
    },
    async advance(seconds) { const n = clock.take(seconds); for (let k = 0; k < n; k++) lastBusy = w.step(); },
    get time() { return clock.time; },
    get steps() { return clock.steps; },
    async read() {
      const n = w.n, id = Int32Array.from(w.id), amount = new Float32Array(n);
      for (let i = 0; i < n; i++) if (id[i] === WATER || id[i] === MUD) amount[i] = w.fill[i] / FULL;
      const particles = w.parts.map((p) => ({ x: p.x, y: p.y, z: p.z, vx: p.vx * CELL_M, vy: p.vy * CELL_M, vz: p.vz * CELL_M, mass: p.m / FULL, id: WATER }));
      for (const p of particles) {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (w.inside(x, y, z)) amount[w.at(x, y, z)] += p.mass;
      }
      // the bench's index is x + nx (z + nz y): the World's own order
      return { nx: w.nx, ny: w.ny, nz: w.nz, id, amount, T: null, burning: null, pressure: null, moving: null, vel: w.velocities(), particles };
    },
    async census() { return tally(await this.read(), this); },
    async activity() {
      const idle = w.idleAt >= 0;
      return { awake: lastBusy, units: w.busy.length, idle, idleSince: idle ? w.idleAt / TICK_HZ : undefined };
    },
    fall: () => null,
    flight: () => null,
    park() {}, resume() {},
    async dispose() { w = null; },
  };
}
