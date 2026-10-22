// CPU witness for the block pass's R3/R4 (src/shaders/v2.js blockExchangeWGSL): EXECUTES the emitted WGSL of the
// motion section (R2 topple through R4b) and its exchange helpers on a CPU grid of production-format cells, on
// the production offset schedule (physics.js offsetOf), and compares what it moves with V1's law (move.js
// vertical and horizontal on react.js forces and JITTER: gravity.js v1PaceRate of the drift times dragF). No GPU.
//   - the pace fit (BLOCK_PACE) against offsetOf's own schedule;
//   - sinking (MV-2), floating up (MV-1), each gas at its own speed and sign (MV-3), mixing without end and the
//     diagonal escape (MV-4), the density law and its tolerance (MV-9).
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { PHYS, SIM_GRAVITY } from '../../src/physics.js';
import { gridLayout } from '../../src/sim.js';
import { offsetOf } from '../../src/v2/physics.js';
import { makeMaterial } from '../../src/v2/layout.js';
import { setFall } from '../../src/v2/fall.js';
import { GRAVITY_MS2, STEPS_PER_TICK, v1PaceRate } from '../../src/v2/gravity.js';
import * as C from '../../src/v2/contact.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { v2BlockWGSL, v2Rows, BLOCK_PACE, V1_FLOAT_CELLS_S, TICK_HZ } from '../../src/shaders/v2.js';
import { densityOf as v1Density } from '../../src/ui/tiles/engine.js';
import { exchangeHelpers, motionSource } from './block-motion.mjs';

const f = Math.fround;
const code = v2BlockWGSL(gridLayout(16, 16, 16), contactWGSL);
const rows = v2Rows();
const V2C = { AIR: 0, SOLID: 1, POWDER: 2, LIQUID: 3, GAS: 4 };
const P = { gravity: GRAVITY_MS2, ambient: 20, gravMode: 0, edge: 0, tick: 0 };
const ctx = exchangeHelpers(code, P);
const { v1Drift, v1Exchange, v2Chance } = ctx;

// ---- 1. the pace fit: the chance's rate on offsetOf's schedule is PACE_A·c + PACE_B·c² (within 6 %)
{
  const T = 120000, oy = Array.from({ length: T }, (_, t) => offsetOf(t)[1]);
  let s = 99; const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (const c of [0.05, 0.2, 0.5, 0.8, 1]) {
    let y = 1 << 20, moved = 0;
    for (let t = 0; t < T; t++) if (((y - oy[t]) & 1) === 0 && r() < c) { y--; moved++; }
    const law = BLOCK_PACE.A * c + BLOCK_PACE.B * c * c;
    assert(Math.abs(moved / T / law - 1) < 0.06, `pace at ${c}: ${moved / T} vs ${law}`);
    // and v2Chance inverts it
    const p = 2 * law / STEPS_PER_TICK / (1 + law / STEPS_PER_TICK);
    assert(Math.abs(v2Chance(f(p)) - c) < 1e-3, `v2Chance(${p}) ${v2Chance(p)} vs ${c}`);
  }
  console.log('pace: the fit matches offsetOf\'s schedule and v2Chance inverts it');
}

// ---- 2. the density law (MV-9): V1's densityOf (the tiles' port of common.js), and its tolerance
const q = t => Math.round((t + 273.25) * 4);
for (const e of ELEMENTS.filter(e => e.kind === K.GAS || e.kind === K.EMPTY)) for (const t of [-40, 20, 172, 400, 704, 1500])
  assert(Math.abs(C.contactDensity(e.id, q(t)) - v1Density(e.id, q(t) / 4 - 273.25)) < 1e-5, `${e.key} at ${t}`);
const dens = (id, t, ambient = 20) => C.contactDensity(id, q(t), ambient);
// CO2 rises through ambient air only once it is past ~704 °C in V1 (not 172 °C)
assert(dens(E.CO2, 400) > dens(E.EMPTY, 20), 'CO2 at 400 °C still denser than air');
assert(dens(E.CO2, 720) < dens(E.EMPTY, 20));
// a warm cell of air: 1 K warm has 1/1000th of 1000 K warm's lift (each rises at its own speed, V1 react.js lift)
const airPair = (tLow) => v2Chance(v1Exchange(V2C.AIR, V2C.AIR, dens(E.EMPTY, 20), dens(E.EMPTY, tLow), v1Drift(0, 20), v1Drift(0, tLow)));
assert(airPair(21) < 0.02 * airPair(120), `1 K warm air ${airPair(21)} vs 100 K ${airPair(120)}`);
console.log(`density: V1's law at every gas and temperature; warm air rises by its warmth (1 K ${airPair(21).toFixed(4)}, 100 K ${airPair(120).toFixed(3)} a tick)`);

// ---- 3. behaviour: the emitted motion section on a CPU grid
const motion = motionSource(code);
const pcg = v => { const s = (Math.imul(v, 747796405) + 2891336453) >>> 0; const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
const seed3 = (p, tick, salt) => pcg((p[0] + pcg((p[1] + pcg((p[2] + pcg((Math.imul(tick, 1664525) + salt) >>> 0)) >>> 0)) >>> 0)) >>> 0);
const clsOf = c => rows[c[0] & 255].cls;
const withAge = (c, age) => new Uint32Array([(c[0] & 0xffffff) | (Math.min(age, 255) << 24), c[1], c[2], c[3]]);
const zeroQ = c => [0, 3].includes(clsOf(c)) ? new Uint32Array([c[0], c[1], 0, c[3] & 0xffff0000]) : c;
class Grid {
  constructor(n, ny, fill) {
    Object.assign(this, { n, ny }); this.cores = []; this.tick = 1;
    for (let i = 0; i < n * n * ny; i++) this.cores.push(makeMaterial(fill).core);
  }
  at(x, y, z) { return x + this.n * (z + this.n * y); }
  valid(p) { return p[0] >= 0 && p[2] >= 0 && p[1] >= 0 && p[0] < this.n && p[2] < this.n && p[1] < this.ny; }
  set(x, y, z, id, t = 20) { this.cores[this.at(x, y, z)] = makeMaterial(id, t).core; }
  find(id) { const out = []; this.cores.forEach((c, i) => { if ((c[0] & 255) === id) out.push([i % this.n, Math.floor(i / (this.n * this.n)), Math.floor(i / this.n) % this.n]); }); return out; }
  step() {
    const tick = this.tick++, o = offsetOf(tick), frozen = this.cores.map(c => new Uint32Array(c));
    const supportAt = p => !this.valid(p) || [1, 2].includes(clsOf(frozen[this.at(...p)]));
    const wall = new Uint32Array([E.WALL, 0, 0, 0]);
    const params = { ...P, tick };
    const h = this.h ??= {
      add: (a, b) => a.map((v, i) => v + b[i]), pcg, seed3, unit: s => f(f(f(s >>> 8) * 256) + f(s & 255)) / 4294967296,
      clsOf, inGrid: p => this.valid(p), fluidC: c => [0, 3, 4].includes(clsOf(c)), dropOfE: id => rows[id].drop,
      cid: c => c[0] & 255, cAge: c => c[0] >>> 24, cTq: c => (c[0] >>> 8) & 0xffff, withAge, zeroQ, setFall,
      resetMotionAge: c => clsOf(c) === 3 ? c : clsOf(c) === 2 ? setFall(c, 0, 0) : withAge(c, 0),
      motionDensity: c => C.contactDensity(c[0] & 255, (c[0] >>> 8) & 0xffff, P.ambient), noteTopple: () => {}, markBusy: () => {},
      MOORE_U: 0x80000000, ...ctx,
    };
    const move = this.move ??= new Function(...Object.keys(h), 'cs', 'bs', 'positions', 'pending', 'P', 'down', 'supportAt',
      `const gravityOn=down.some(v=>v!==0),blockCount=8,columnCount=4;let fromCell=[0,1,2,3,4,5,6,7];${motion}`);
    for (let by = o[1] - 1; by < this.ny; by += 2) for (let bz = o[2] - 1; bz < this.n; bz += 2) for (let bx = o[0] - 1; bx < this.n; bx += 2) {
      const ps = Array.from({ length: 8 }, (_, i) => [bx + (i & 1), by + (i >> 2), bz + ((i >> 1) & 1)]);
      const cs = ps.map(p => this.valid(p) ? new Uint32Array(this.cores[this.at(...p)]) : wall);
      move(...Object.values(h), cs, new Int32Array(8), ps, new Uint32Array(8), params, [0, -1, 0], supportAt);
      ps.forEach((p, i) => { if (this.valid(p)) this.cores[this.at(...p)] = cs[i]; });
    }
  }
}
// the rate (cells/s) a lone cell of `id` crosses a box of `medium` (up or down), as the median of `trials` runs
function rate(id, medium, dir, { trials = 9, ny = 48, t = 20 } = {}) {
  const speeds = [];
  for (let k = 0; k < trials; k++) {
    const g = new Grid(4, ny, medium), y0 = dir < 0 ? ny - 4 : 3;
    g.tick = 1 + 977 * k; g.set(1 + (k & 1), y0, 2, id, t);
    let start = null, ticks = 0;
    for (; ticks < 4000; ticks++) {
      g.step();
      const at = g.find(id); if (at.length !== 1) break;
      const y = at[0][1];
      if (start === null && Math.abs(y - y0) >= 4) start = [ticks, y];
      if (start && Math.abs(y - start[1]) >= ny - 16) { speeds.push(Math.abs(y - start[1]) / (ticks - start[0]) * TICK_HZ); break; }
    }
  }
  speeds.sort((a, b) => a - b);
  return speeds.length ? speeds[speeds.length >> 1] : 0;
}
// V1's rate (cells/s): its terminal pace through the medium (gravity.js v1PaceRate of drift·dragF, V1's 240 steps/s)
const v1DragFOf = (a, b) => { const gl = e => e.kind === K.GAS || e.kind === K.EMPTY, la = a.kind === K.LIQUID, lb = b.kind === K.LIQUID;
  return (la && !gl(b)) || (lb && !gl(a)) ? PHYS.DRAG_LIQUID_MIN + PHYS.DRAG_LIQUID_SPAN * Math.min(1, PHYS.DRAG_LIQUID_DENS * Math.abs(a.dens - b.dens) / Math.max(a.dens, b.dens)) : 1; };
const v1Rate = (id, medium) => { const e = ELEMENTS[id], keep = 1 - e.drag, ut = Math.min(PHYS.V_MAX, SIM_GRAVITY * Math.abs(e.grav) * keep / (1 - keep));
  return v1PaceRate(ut * v1DragFOf(e, ELEMENTS[medium])) * STEPS_PER_TICK * TICK_HZ; };
// V2's block pass moves a cell at most PACE_A + PACE_B a tick (the column pass's share past it: not here)
const CAP = (BLOCK_PACE.A + BLOCK_PACE.B) * TICK_HZ;
const expect = (id, medium, dir, want, tol = 0.2) => {
  const got = rate(id, medium, dir), target = Math.min(want, CAP);
  assert(Math.abs(got / target - 1) < tol, `${ELEMENTS[id].key} through ${ELEMENTS[medium].key}: ${got.toFixed(1)} cells/s, want ${target.toFixed(1)} (V1 ${want.toFixed(1)})`);
  return `${ELEMENTS[id].key} ${got.toFixed(1)} (V1 ${want.toFixed(1)})`;
};
const lines = [];
// MV-2: sinking at V1's pace through a liquid (sand, uranium past the block pass's own reach)
lines.push(expect(E.SAND, E.WATER, -1, v1Rate(E.SAND, E.WATER)));
lines.push(expect(E.URANIUM, E.WATER, -1, v1Rate(E.URANIUM, E.WATER)));
// MV-1: a lighter powder floats up through a liquid, at V1's measured rate
lines.push(expect(E.SAWDUST, E.WATER, 1, V1_FLOAT_CELLS_S, 0.3));
lines.push(expect(E.ASH, E.OIL, 1, V1_FLOAT_CELLS_S, 0.3));
// MV-3: each gas at its own speed and sign
lines.push(expect(E.HYDROGEN, E.EMPTY, 1, v1Rate(E.HYDROGEN, E.EMPTY)));
lines.push(expect(E.CO2, E.EMPTY, -1, v1Rate(E.CO2, E.EMPTY), 0.3));
lines.push(expect(E.PROPANE, E.EMPTY, -1, v1Rate(E.PROPANE, E.EMPTY), 0.3));
lines.push(expect(E.SMOKE, E.EMPTY, 1, v1Rate(E.SMOKE, E.EMPTY), 0.3));
console.log(`rates (cells/s, block pass): ${lines.join(', ')}`);
// MV-4: a gas keeps spreading sideways without end, and two gases mix
{
  // (V1's spread of a lone CO2 cell in air, the tiles' CPU port: 0.91 cells² a tick on each axis)
  const g = new Grid(64, 2, E.EMPTY); g.tick = 5;
  for (let y = 0; y < 2; y++) for (let k = 0; k < 4; k++) g.set(30 + 2 * k, y, 32, E.CO2);
  const n = 8, spread = () => g.find(E.CO2).reduce((s, p, i) => s + (p[0] - (30 + 2 * ((i >> 0) % 4))) ** 0 * 0 + (p[2] - 32) ** 2, 0) / n;
  for (let t = 0; t < 60; t++) g.step();
  const at1 = spread();
  for (let t = 0; t < 120; t++) g.step();
  const at3 = spread(), v1At3 = 0.91 * 180;
  assert(at3 > 2.5 * at1 && Math.abs(at3 / v1At3 - 1) < 0.35, `CO2 spread ${at1.toFixed(1)} cells² at 1 s, ${at3.toFixed(1)} at 3 s (V1 ${v1At3.toFixed(0)})`);
  const at2 = at1, at5 = at3;
  const m = new Grid(8, 4, E.EMPTY); m.tick = 9;
  for (let y = 0; y < 4; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) m.set(x, y, z, x < 4 ? E.HYDROGEN : E.OXYGEN);
  for (let t = 0; t < 120; t++) m.step();
  const crossed = m.find(E.HYDROGEN).filter(p => p[0] >= 4).length;
  assert(crossed > 16, `hydrogen and oxygen side by side never mix (${crossed})`);
  console.log(`mixing: CO2 spread (z) ${at2.toFixed(1)} cells² at 1 s, ${at5.toFixed(1)} at 3 s (V1 ${(0.91 * 180).toFixed(0)}); ${crossed} of 128 hydrogen cells crossed into the oxygen in 2 s`);
}
// MV-4: a buoyant gas under an overhang slides out diagonally
{
  let escaped = 0;
  for (let k = 0; k < 8; k++) {
    const g = new Grid(4, 6, E.EMPTY); g.tick = 3 + 131 * k;
    for (let z = 0; z < 4; z++) for (let x = 0; x < 2; x++) g.set(x, 3, z, E.WALL);
    g.set(0, 2, 1, E.HYDROGEN);
    for (let t = 0; t < 30; t++) g.step();
    if (g.find(E.HYDROGEN)[0][1] > 3) escaped++;
  }
  assert(escaped >= 6, `hydrogen under an overhang escaped ${escaped}/8`);
  console.log(`overhang: hydrogen escaped from under a ledge in ${escaped}/8 runs within 0.5 s`);
}
console.log('exchange-check: ok');
