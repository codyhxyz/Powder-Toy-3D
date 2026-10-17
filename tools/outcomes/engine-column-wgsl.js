// The outcome bench's engine on the column-run water model as production emits it: the col* bodies of
// src/shaders/v2/columns.js executed on the CPU (tools/v2/column-wgsl.mjs), on production-format cells. So the
// bench's liquid tests and thresholds measure the WGSL's own rules, as engine-column.js measures the prototype.
// Node only. Elements: air, wall and the liquids (water, mud, oil); no powders, heat sources or fire. Jets are
// the emitted pour and launch marks, flown by the prototype's R4 (the dynamics module's flight is not executed).
// Contract: ./engine.js.
import { ColumnGrid } from '../v2/column-wgsl.mjs';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { FULL, cid, cFill, isLiquid } from '../../src/v2/layout.js';
import { stepClock } from './engine.js';
import { tally } from './lib.js';
import { columnLiquidVelocity } from './native-grid.js';

const TICK_HZ = 60, CELL_M = 0.3, G_MS2 = 19.6;
const IDS = { AIR: E.EMPTY, WALL: E.WALL, WATER: E.WATER, MUD: E.MUD, OIL: E.OIL };
const NAMES = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k]));
const kind = (id) => ({ [K.EMPTY]: 'air', [K.SOLID]: 'solid', [K.POWDER]: 'powder', [K.LIQUID]: 'liquid', [K.GAS]: 'gas' }[ELEMENTS[id]?.kind] ?? 'solid');

export function createEngine() {
  let w = null, clock = stepClock(TICK_HZ), lastBusy = 0;
  return {
    name: 'column-wgsl',
    info: {
      label: 'column-run water, emitted WGSL bodies on the CPU (60 Hz, 2 g, one step a tick)', stepsPerSecond: TICK_HZ, clock: `${TICK_HZ} ticks a game second (Speed 1×)`,
      gravity: G_MS2, cellM: CELL_M, fillQuantum: 1 / FULL, velocity: true, pressure: false, airCell: null, burning: false,
    },
    id: (name) => IDS[name] ?? null,
    nameOf: (id) => NAMES[id] ?? `#${id}`,
    kindOf: (id) => kind(id),
    async create([nx, ny, nz]) { w = new ColumnGrid(nx, ny, nz); clock = stepClock(TICK_HZ); lastBusy = 0; },
    box(lo, hi, name, { onlyEmpty = false, v = null, T } = {}) {
      const e = IDS[name];
      if (e === undefined) throw new Error(`column-wgsl: no element ${name}`);
      if (v && v.some((c) => c)) throw new Error('column-wgsl: no thrown matter');
      for (let y = Math.max(0, lo[1]); y <= Math.min(w.ny - 1, hi[1]); y++)
        for (let z = Math.max(0, lo[2]); z <= Math.min(w.nz - 1, hi[2]); z++)
          for (let x = Math.max(0, lo[0]); x <= Math.min(w.nx - 1, hi[0]); x++) {
            if (onlyEmpty && cid(w.cores[w.at(x, y, z)]) !== 0) continue;
            w.set(x, y, z, e, T === undefined ? {} : { T });
          }
    },
    async advance(seconds) { const n = clock.take(seconds); for (let k = 0; k < n; k++) lastBusy = w.step(); },
    get time() { return clock.time; },
    get steps() { return clock.steps; },
    async read() {
      const n = w.n, id = new Int32Array(n), amount = new Float32Array(n);
      for (let i = 0; i < n; i++) { id[i] = cid(w.cores[i]); if (isLiquid(id[i])) amount[i] = cFill(w.cores[i]) / FULL; }
      const particles = w.parts.map((p) => ({ x: p.x, y: p.y, z: p.z, vx: p.vx * CELL_M, vy: p.vy * CELL_M, vz: p.vz * CELL_M, mass: cFill(p.m.core) / FULL, id: cid(p.m.core) }));
      for (const p of particles) {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (x >= 0 && y >= 0 && z >= 0 && x < w.nx && y < w.ny && z < w.nz) amount[w.at(x, y, z)] += p.mass;
      }
      const vel = new Float32Array(3 * n), velocityKnown = new Uint8Array(n).fill(1);
      columnLiquidVelocity({ nx: w.nx, ny: w.ny, nz: w.nz, loop: w.loop }, (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= w.nx || y >= w.ny || z >= w.nz ? null : w.cores[w.at(x, y, z)]), vel, velocityKnown);
      return { nx: w.nx, ny: w.ny, nz: w.nz, id, amount, T: null, burning: null, pressure: null, moving: null, vel, velocityKnown, particles };
    },
    async census() { return tally(await this.read(), this); },
    async activity() {
      const idle = w.idleAt >= 0;
      return { awake: lastBusy, units: w.nb, idle, idleSince: idle ? w.idleAt / TICK_HZ : undefined };
    },
    fall: () => null,
    flight: () => null,
    park() {}, resume() {},
    async dispose() { w = null; },
  };
}
