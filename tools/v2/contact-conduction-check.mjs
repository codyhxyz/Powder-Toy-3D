// CPU only: V2 conduction carries V1's rate (react.js condFlux: every face, every step) without
// overshoot. A tick is the block pass's cubes (contactReference, the block pass's twin) at the
// tick's offset (v2/physics.js offsetOf), then the heat pass's (contactHeatReference, shaders/v2/heat.js)
// one cell over on every axis. Fails with the heat pass or ctFluxTick reverted (metal at 0.8× V1).
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { PHYS, NOMINAL_STEP_RATE } from '../../src/physics.js';
import * as C from '../../src/v2/contact.js';
import { offsetOf } from '../../src/v2/physics.js';
import { makeMaterial } from '../../src/v2/layout.js';

const T = c => c.tq / 4 - 273.25 + C.ctTemperatureRemainder(c) / 4;
// a grid of packed cells, stepped by both passes' twins
function grid(nx, ny, nz, at, modes = C.CONTACT_DEFAULT_MODES) {
  const cores = [], banks = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const m = at(x, y, z); cores.push(m.core); banks.push(m.bank); }
  const index = (x, y, z) => x + nx * (y + ny * z), inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;
  const cubes = (o, fn) => {
    for (let z0 = o[2] - 1; z0 < nz; z0 += 2) for (let y0 = o[1] - 1; y0 < ny; y0 += 2) for (let x0 = o[0] - 1; x0 < nx; x0 += 2) {
      const pos = C.CONTACT_POSITIONS.map(([x, y, z]) => [x0 + x, y0 + y, z0 + z]), valid = pos.map(p => inside(...p));
      const at8 = pos.map((p, i) => valid[i] ? index(...p) : -1);
      const cs = at8.map(i => new Uint32Array(i < 0 ? 4 : cores[i])), bs = at8.map(i => i < 0 ? 0 : banks[i]);
      fn(cs, bs, valid, pos);
      at8.forEach((i, k) => { if (i >= 0) { cores[i] = cs[k]; banks[i] = bs[k]; } });
    }
  };
  return {
    tick(t) {
      const o = offsetOf(t);
      cubes(o, (cs, bs, valid, pos) => C.contactReference(cs, bs, t, pos, new Uint32Array(8), valid, undefined, modes));
      cubes(o.map(v => 1 - v), (cs, bs, valid) => C.contactHeatReference(cs, bs, valid, modes));
    },
    T: (x, y, z) => T(C.unpackContact(cores[index(x, y, z)], banks[index(x, y, z)])),
  };
}
// V1 react.js condFlux and its air's pull to ambient (AIR_AMBIENT_PULL), 240 steps a second on six faces, on the
// same grid: `at(x, y, z)` an element id, the bar's x = 0 end at `hot`, the rest at 20 °C; closed walls
function v1Grid(nx, ny, nz, at, hot, seconds, ambientHeat = 1) {
  const n = nx * ny * nz, index = (x, y, z) => x + nx * (y + ny * z), id = new Int32Array(n), t = new Float64Array(n).fill(20);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { id[index(x, y, z)] = at(x, y, z); if (x === 0 && at(x, y, z) !== E.EMPTY) t[index(x, y, z)] = hot; }
  const cap = i => ELEMENTS[id[i]].cap, cond = i => ELEMENTS[id[i]].cond;
  let T = t;
  for (let s = 0; s < seconds * NOMINAL_STEP_RATE; s++) {
    const next = T.slice();
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = index(x, y, z);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        // (ambient heat off: matter trades no heat with the air, react.js)
        if (!ambientHeat && (id[i] === E.EMPTY || id[index(X, Y, Z)] === E.EMPTY)) continue;
        const j = index(X, Y, Z), dT = T[j] - T[i], lim = Math.abs(dT) * Math.min(cap(i), cap(j)) * PHYS.COND_FLUX_SHARE;
        next[i] += Math.max(-lim, Math.min(lim, Math.min(cond(i), cond(j)) * dT)) / cap(i);
      }
      if (id[i] === E.EMPTY) next[i] += (20 - next[i]) * PHYS.AIR_AMBIENT_PULL;
    }
    T = next;
  }
  return (x, y, z) => T[index(x, y, z)];
}
let groups = 0;
function test(name, fn) { fn(); groups++; console.log(`ok ${name}`); }

test('a bar warms along its length at V1\'s rate: metal, gold, tungsten and the slow conductors (±5 %)', () => {
  const N = 24;
  for (const key of ['METAL', 'GOLD', 'TUNGSTEN', 'STONE', 'GLASS', 'SAND']) {
    const id = E[key];
    // a bar one cell thick in 20 °C air
    const bar = (x, y, z) => y === 1 && z === 1 ? id : E.EMPTY;
    // with ambient heat off (V1's and V2's mode: no matter/air exchange), so only the bar's own rate counts
    const modes = { ...C.CONTACT_DEFAULT_MODES, ambientHeat: 0 };
    const g = grid(N, 3, 3, (x, y, z) => makeMaterial(bar(x, y, z), x === 0 && bar(x, y, z) === id ? 1000 : 20), modes);
    for (let t = 1; t <= 60; t++) g.tick(t);
    const v1 = v1Grid(N, 3, 3, bar, 1000, 1, 0), cells = [1, 4, 8];
    const v2 = cells.map(x => g.T(x, 1, 1)), want = cells.map(x => v1(x, 1, 1));
    // 4 and 8 cells along (the hot end itself runs up to 9 % warm: a face traded twice running moves less)
    for (const i of [1, 2]) assert(Math.abs(v2[i] - want[i]) <= 0.05 * want[i], `${key} cell ${cells[i]} after 1 s: V2 ${v2[i].toFixed(1)} °C, V1 ${want[i].toFixed(1)} °C`);
    console.log(`  ${key} cells ${cells.join('/')} after 1 s: V2 ${v2.map(v => v.toFixed(0)).join('/')} °C, V1 ${want.map(v => v.toFixed(0)).join('/')} °C`);
  }
});

test('a pair never crosses its equilibrium: an isolated hot/cold metal pair relaxes without flicker', () => {
  // every element pair, hot and cold either way: the tick's flux stays within the pair's equilibrium
  const ids = [E.METAL, E.GOLD, E.TUNGSTEN, E.WATER, E.ICE, E.LAVA, E.STONE, E.EMPTY, E.STEAM, E.FIRE];
  for (const a of ids) for (const b of ids) for (const [ta, tb] of [[900, 20], [20, 900], [-100, 400]]) {
    const ca = C.ctNew(a, Math.round((ta + 273.25) * 4), 65536), cb = C.ctNew(b, Math.round((tb + 273.25) * 4), 65536);
    const f = Number(C.ctFluxTick(ca, cb)), Ca = C.ctCapacity(ca), Cb = C.ctCapacity(cb);
    const eq = (cb.tq - ca.tq) * Ca * Cb / (Ca + Cb);
    assert(Math.sign(f) === Math.sign(eq) || f === 0, `${ELEMENTS[a].key}/${ELEMENTS[b].key}: flux against ΔT`);
    assert(Math.abs(f) <= Math.abs(eq) + 1, `${ELEMENTS[a].key}/${ELEMENTS[b].key} ${ta}/${tb}: past equilibrium`);
  }
  // two metal cells in a closed 2×1×1 grid: ΔT keeps its sign and shrinks every tick, at V1's 4 steps a tick
  const g = grid(2, 1, 1, x => makeMaterial(E.METAL, x === 0 ? 500 : 20));
  const share = Math.min(ELEMENTS[E.METAL].cond, ELEMENTS[E.METAL].cap * PHYS.COND_FLUX_SHARE) / ELEMENTS[E.METAL].cap;
  let gap = 480;
  for (let t = 1; t <= 12; t++) {
    g.tick(t);
    const now = g.T(0, 0, 0) - g.T(1, 0, 0);
    assert(now > 0 && now < gap, `tick ${t}: ΔT ${now.toFixed(2)} after ${gap.toFixed(2)}`);
    // V1: an isolated pair keeps (1 - 2·cond/cap)^4 of ΔT a tick (the heat-capacity units' rounding aside)
    if (t === 1) assert(Math.abs(now / 480 - (1 - 2 * share) ** (NOMINAL_STEP_RATE / C.CONTACT_HZ)) < 0.03, `pair keeps ${(now / 480).toFixed(3)} of ΔT a tick`);
    gap = now;
  }
});

console.log(`contact-conduction-check: ${groups} groups passed`);
