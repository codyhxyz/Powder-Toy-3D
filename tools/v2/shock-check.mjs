// CPU only (no GPU, no browser): V1's shock (elements.js blast.shock; react.js sets an explosive off
// under a hit of ½·μ·u² past it, common.js hitKE) under V2. Checks the derivation of each charge's
// shock in V2's mechanics (dynamics-reference.js SHOCK_FALL_CELLS, the shock field) and a nitroglycerin
// run landing on the executed column passes (shaders/v2/columns.js colShockLand on
// tools/v2/column-wgsl.mjs's CPU grid of production cells), by how far it has fallen (colFall).
// Particle hits are in particle-deposition-check.mjs, a charge set off in flight in airborne-react-check.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ELEMENTS, E, NITRO_FALL_M } from '../../src/elements.js';
import { dynamicsRows, SHOCK_FALL_CELLS, v1OwnShockFall, hitKE, GRAVITY, MASS_PER_DENS, particleLandingSpeed, packetShock, SHOCK_THROW_MS } from '../../src/v2/dynamics-reference.js';
import { legacyVelocityToMS } from '../../src/v2/tools.js';
import { COLUMN, COLUMN_SHOCK, V1_FALL, columnWaterWGSL } from '../../src/shaders/v2/columns.js';
import * as L from '../../src/v2/layout.js';
import { ColumnGrid, wgslFunction, syntax } from './column-wgsl.mjs';

test('each charge\'s shock, in V1\'s units on a packet\'s hit, its fall re-derived on V2\'s laws', () => {
  // C-4: "a hit that would smash wood" (shock = WOOD's hard), now V1's own number in V1's units: the
  // packet's hit is V1's (V1 densities a cell each, dMass = dens·MASS_PER_DENS), not a joule threshold
  assert.equal(ELEMENTS[E.C4].blast.shock, ELEMENTS[E.WOOD].hard);
  for (const e of ELEMENTS) assert.equal(dynamicsRows[e.id].shockKE, (e.blast?.shock ?? 0) * MASS_PER_DENS, e.key);
  assert.equal(dynamicsRows[E.C4].shockFall, 0, 'C-4 is solid: V1 never drops it');
  // nitroglycerin: V1's own fall onto a solid (its liquid falls without drag, react.js), on the particle lane's
  // law: about free fall's speed at that height. elements.js derived its shock from a NITRO_FALL_M fall with
  // drag (fallKE), which V1's falling liquid never feels, so V1 sets it off from about 3 m, not 5.
  const h1 = SHOCK_FALL_CELLS[E.NITRO];
  assert.deepEqual(Object.keys(SHOCK_FALL_CELLS).map(Number), [E.NITRO]);
  assert.equal(h1, v1OwnShockFall(E.NITRO));
  assert.ok(v1LandingKE(E.NITRO, E.METAL, h1 + 1e-9) >= ELEMENTS[E.NITRO].blast.shock && v1LandingKE(E.NITRO, E.METAL, h1) < ELEMENTS[E.NITRO].blast.shock);
  assert.ok(h1 * CELL_M > 2.9 && h1 * CELL_M < 3.2 && h1 * CELL_M < NITRO_FALL_M, `V1's own fall ${(h1 * CELL_M).toFixed(2)} m`);
  const v = particleLandingSpeed(E.NITRO, h1 * CELL_M), free = Math.sqrt(2 * GRAVITY * h1 * CELL_M);
  assert.ok(v < free * 1.03 && v > free * 0.9, `a ${(h1 * CELL_M).toFixed(2)} m fall lands at ${v.toFixed(2)} m/s (free fall ${free.toFixed(2)})`);
  // its landing maps that speed onto the V1 speed that carries its shock on a solid (½·dens·v² = shock)
  assert.ok(Math.abs(0.5 * ELEMENTS[E.NITRO].dens * (v * dynamicsRows[E.NITRO].shockFall) ** 2 - ELEMENTS[E.NITRO].blast.shock) < 1e-9);
  // poured gently it is safe: a 1 m or 2.7 m fall onto metal is not, a 3.3 m or 6 m one is (V1: 9 and 11 cells)
  for (const [m, off] of [[1, false], [2.7, false], [3.3, true], [6, true]])
    assert.equal(packetShock(E.NITRO, E.METAL, particleLandingSpeed(E.NITRO, m), true).mover, off, `${m} m`);
  // V1's throws: SHOCK_THROW_MS m/s a cell/step (v2/tools.js legacyVelocityToMS, the throws' own map)
  assert.equal(SHOCK_THROW_MS, legacyVelocityToMS(1));
  // V1 hitKE: the mover's mass on a solid, the reduced mass otherwise
  assert.equal(hitKE(2, 6, true, 9), 9); assert.equal(hitKE(2, 6, false, 9), 0.5 * 1.5 * 9);
});

const literal = x => String(x).replace('.', '\\.');
test('a run\'s shock is V1\'s own fall law, emitted as the WGSL reads it: R1\'s run speed caps how fast a run falls, not how far', () => {
  assert.deepEqual(COLUMN_SHOCK.map(r => r.id), [E.NITRO]);
  const [nitro] = COLUMN_SHOCK, e = ELEMENTS[E.NITRO];
  assert.equal(nitro.cells, SHOCK_FALL_CELLS[E.NITRO]);
  assert.equal(nitro.speed2, 2 * e.blast.shock / e.dens);
  assert.deepEqual(V1_FALL, { G: SIM_GRAVITY, V_MAX: PHYS.V_MAX });
  // the column law (v += g, a cell a tick at v) reaches the run speed under 4 m into a fall, past V1's own fall
  let v = 0, y = 0;
  while (v + COLUMN.G <= COLUMN.VT) { v += COLUMN.G; y += v; }
  assert.ok(y * CELL_M > 3.5 && y * CELL_M < 4 && y > nitro.cells, `the run speed after ${(y * CELL_M).toFixed(2)} m`);
  assert.match(columnWaterWGSL, new RegExp(`fn colShockSpeed2\\(id: u32\\) -> f32 \\{\\n  if \\(id == ${E.NITRO}u\\) \\{ return ${literal(nitro.speed2)}; \\}`));
  // the emitted colV1FallSpeed, executed: V1's speed after a fall of h cells from rest, as V1 steps it
  // (react.js forces: g a step, no drag on a falling liquid, V_MAX; move.js covers v a step), for every h
  const { args, body } = wgslFunction(columnWaterWGSL, 'colV1FallSpeed');
  const speed = Function(...args, 'min', 'sqrt', 'ceil', syntax(body));
  const v1Speed = h => { let u = 0, y = 0; while (y < h) { u = Math.min(PHYS.V_MAX, u + SIM_GRAVITY); y += u; } return u; };
  // (off the steps' own boundaries, g·n(n+1)/2, where f32 and f64 round either way)
  for (let h = 0.0137; h < 60; h += 0.1) assert.ok(Math.abs(speed(h, Math.min, Math.sqrt, Math.ceil) - v1Speed(h)) < 1e-9, `${h.toFixed(2)} cells`);
});

function world() {
  const w = new ColumnGrid(8, 32, 8);
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) w.set(x, 0, z, E.WALL);
  return w;
}
const requests = (w, id) => {
  const out = [];
  for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === id && (w.events[i] & 1)) out.push(i);
  return out;
};
const landed = (w, id, y0) => { for (let t = 0; t < 120; t++) w.step(); for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === id) assert.ok(Math.floor(i / 64) < y0, 'it fell'); };

test('nitroglycerin poured from height goes off where it lands; poured gently, it does not', () => {
  // a slab from 27 cells (8 m) up onto the stone floor: its bottom cells land at the run speed
  const high = world();
  for (let z = 2; z < 4; z++) for (let x = 2; x < 4; x++) high.set(x, 27, z, E.NITRO);
  landed(high, E.NITRO, 27);
  const fired = requests(high, E.NITRO);
  assert.equal(fired.length, 4, 'each landed bottom cell holds a detonation request');
  for (const i of fired) assert.equal(Math.floor(i / 64), 1, 'on the floor');
  // from 3 cells (0.9 m) up: a gentle pour
  const low = world();
  for (let z = 2; z < 4; z++) for (let x = 2; x < 4; x++) low.set(x, 4, z, E.NITRO);
  landed(low, E.NITRO, 4);
  assert.equal(requests(low, E.NITRO).length, 0);
});

test('only a hit V1 counts: not on its own pool, not on a liquid it outweighs, not water', () => {
  // onto a nitro pool (its own element) and onto water (the reduced mass, under the run speed): nothing
  for (const pool of [E.NITRO, E.WATER]) {
    const w = world();
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) w.set(x, 1, z, pool);
    for (let z = 2; z < 4; z++) for (let x = 2; x < 4; x++) w.set(x, 27, z, E.NITRO);
    for (let t = 0; t < 120; t++) w.step();
    assert.equal(requests(w, E.NITRO).length, 0, `onto ${ELEMENTS[pool].key}`);
  }
  // water from the same height: no charge, no request
  const w = world();
  for (let z = 2; z < 4; z++) for (let x = 2; x < 4; x++) w.set(x, 27, z, E.WATER);
  for (let t = 0; t < 120; t++) w.step();
  assert.equal(w.events.reduce((n, v) => n + (v & 1), 0), 0);
});

test('the runs and pairs passes that land the runs still validate (Naga, grouping)', async () => {
  const { V2_KERNELS } = await import('../../src/shaders/v2.js');
  const { gridLayout } = await import('../../src/sim.js');
  const { assertNaga, wgslGroupingErrors } = await import('./wgsl-grouping.mjs');
  for (const dims of [[32, 32, 32], [48, 16, 32]]) for (const name of ['v2runs', 'v2pairs']) {
    const code = V2_KERNELS.find(k => k.name === name).code(gridLayout(...dims));
    assert.match(code, /colShockLand\(x, z, r0 - d, fallen\)/);
    assertNaga(code, `${name} ${dims}`);
    assert.deepEqual(wgslGroupingErrors(code), [], `${name}: mixed bitwise operators grouped (Chromium rejects them ungrouped)`);
  }
});

// ---- grid landings ON a charge (dynamics-reference.js SHOCK_LANDINGS): V1's own trigger, a fall height
// per lander and charge, on V2's laws (shaders/v2.js v2ColumnWGSL for grains, columns.js colShockLand for runs)
import { SHOCK_LANDINGS, v1ShockFall } from '../../src/v2/dynamics-reference.js';
import { COLUMN_SHOCK_ON, COLUMN_KEEPS_FALL } from '../../src/shaders/v2/columns.js';
import { powderLandingSpeed, stepFall, fallVelocity, fallTerminal } from '../../src/v2/fall.js';
import { SIM_GRAVITY, PHYS } from '../../src/physics.js';
import { K } from '../../src/elements.js';
import { CELL_M } from '../../src/scale.js';

// V1 react.js forces and the shock (common.js hitKE, shockActs), stepped as V1 runs them: the KE a cell of
// faller carries landing on charge after a fall of h cells from rest
function v1LandingKE(faller, charge, h) {
  const j = ELEMENTS[faller], k = ELEMENTS[charge], drag = j.kind === K.LIQUID ? 0 : j.drag;
  let v = 0, y = 0;
  while (y < h) { v = Math.min(PHYS.V_MAX, (v + SIM_GRAVITY * j.grav) * (1 - drag)); y += v; }
  return hitKE(j.dens, k.dens, k.kind === K.SOLID, v * v);
}
const name = r => `${ELEMENTS[r.faller].key} on ${ELEMENTS[r.charge].key}`;
const { V2_KERNELS } = await import('../../src/shaders/v2.js');
const { gridLayout } = await import('../../src/sim.js');
const columnCode = dims => V2_KERNELS.find(k => k.name === 'v2column').code(gridLayout(...dims));

test('V1 sets a charge off under a landing only from the very heavy powders and the heavy liquids, each past its own fall', () => {
  const keys = SHOCK_LANDINGS.map(name).sort();
  assert.deepEqual(keys, ['LAVA on NITRO', 'MERCURY on C4', 'MERCURY on NITRO', 'MUD on NITRO', 'NUGGETS on C4', 'NUGGETS on NITRO',
    'PLUTONIUM on C4', 'PLUTONIUM on NITRO', 'SCRAP on C4', 'SCRAP on NITRO', 'SINGULARITY on C4', 'URANIUM on C4', 'URANIUM on NITRO']);
  for (const r of SHOCK_LANDINGS) {
    const shock = ELEMENTS[r.charge].blast.shock;
    // past the fall it goes off, short of it (a step less) not: V1's own law decides
    assert.ok(v1LandingKE(r.faller, r.charge, r.cells + 1e-9) >= shock, `${name(r)} past ${r.cells}`);
    assert.ok(v1LandingKE(r.faller, r.charge, r.cells) < shock, `${name(r)} at ${r.cells}`);
  }
  // uranium onto C-4 from about 1.5 m, scrap from about 3.8 m; nothing light ever, from any height
  assert.ok(Math.abs(v1ShockFall(E.URANIUM, E.C4) * CELL_M - 1.46) < 0.01);
  assert.ok(Math.abs(v1ShockFall(E.SCRAP, E.C4) * CELL_M - 3.75) < 0.01);
  for (const key of ['SAND', 'STONE', 'GUNPOWDER', 'SALT', 'WATER', 'OIL', 'ACID', 'SNOW'])
    for (const charge of [E.C4, E.NITRO]) assert.equal(v1ShockFall(E[key], charge), null, `${key} never`);
  assert.equal(v1ShockFall(E.NITRO, E.NITRO), null, 'never its own element');
});

test('a grain lands at the powder law\'s speed for its fall: past V1\'s fall it carries the trigger, short of it not', () => {
  const code = columnCode([32, 32, 32]);
  for (const r of SHOCK_LANDINGS.filter(r => ELEMENTS[r.faller].kind === K.POWDER)) {
    const on = Number(code.match(new RegExp(`if \\(faller == ${r.faller}u && charge == ${r.charge}u\\) \\{ return ([0-9.e-]+); \\}`))[1]);
    assert.ok(on > 0 && Math.abs(on - powderLandingSpeed(r.faller, r.cells)) < 1e-3, name(r));
    // the column pass's grain (fall.js stepFall, its CPU twin) dropped from rest into a gap of h cells: the
    // speed it lands with (v2ColumnWGSL: the tick its fall reaches its floor)
    const lands = h => { let c = new Uint32Array([r.faller, 0, 0, 0]), y = 0;
      for (;;) { const s = stepFall(c, 19.6); c = s.core; y += s.cells; if (y >= h) return fallVelocity(c); } };
    const terminal = fallTerminal(r.faller);
    if (on < terminal * 0.999) assert.ok(lands(Math.floor(r.cells) - 1) < on, `${name(r)}: short of V1's fall`);
    assert.ok(lands(Math.ceil(r.cells) + 2) >= on, `${name(r)}: past V1's fall`);
  }
  // sand, the commonest grain, has no trigger on either charge
  assert.doesNotMatch(code, new RegExp(`faller == ${E.SAND}u`));
});

test('the column pass emits the grains\' triggers in its landing branch and validates', async () => {
  const { assertNaga, wgslGroupingErrors } = await import('./wgsl-grouping.mjs');
  for (const dims of [[32, 32, 32], [48, 16, 32]]) {
    const code = columnCode(dims);
    assert.match(code, /if \(to <= fl\) \{\n\s*\/\/[^\n]*\n\s*if \(fl > 0 && !runFalling\) \{ shockLand\(vec3i\(x, fl - 1, z\), cid\(c\), v\); \}/);
    assertNaga(code, `v2column ${dims}`);
    assert.deepEqual(wgslGroupingErrors(code), []);
  }
});

test('a liquid run landing on a charge: mercury poured from height onto C-4 sets it off, gently not, water never', () => {
  const pour = (liquid, charge, y0, layer = 1) => {
    const w = world();
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) w.set(x, layer, z, charge);
    for (let z = 2; z < 4; z++) for (let x = 2; x < 4; x++) w.set(x, y0, z, liquid);
    for (let t = 0; t < 120; t++) w.step();
    return requests(w, charge);
  };
  // mercury from 25 cells (7.5 m) above the C-4 layer: the four cells it lands on; from 3 cells: none
  const high = pour(E.MERCURY, E.C4, 27);
  assert.equal(high.length, 4);
  for (const i of high) assert.equal(Math.floor(i / 64), 1, 'the C-4 under the slab');
  assert.equal(pour(E.MERCURY, E.C4, 5).length, 0);
  assert.equal(pour(E.WATER, E.C4, 27).length, 0, 'water never');
  // lava and mud onto a nitroglycerin pool from 8 m: it goes off where they land
  for (const liquid of [E.LAVA, E.MERCURY, E.MUD]) assert.ok(pour(liquid, E.NITRO, 27).length > 0, ELEMENTS[liquid].key);
  assert.equal(pour(E.WATER, E.NITRO, 27).length, 0);
  // the emitted falls are V1's own
  assert.deepEqual(COLUMN_SHOCK_ON, SHOCK_LANDINGS.filter(r => ELEMENTS[r.faller].kind === K.LIQUID));
  for (const r of COLUMN_SHOCK_ON) assert.match(columnWaterWGSL, new RegExp(`if \\(faller == ${r.faller}u && charge == ${r.charge}u\\) \\{ return ${literal(r.cells)}; \\}`), name(r));
});

// A run of liquid one cell across (a column of the CPU twin's production pass) dropped `fall` cells, bottom to
// bottom, onto `under` (the floor itself when WALL, else a layer of it on the floor): the requests it lands.
// moveAt: that tick, every cell (cores, banks, requests) goes into a fresh grid, `dx` cells along x: a save
// and a load, an undo, a World window's shift (shaders/v2/window.js moves cores and banks); nothing else goes.
function drop(liquid, under, fall, { moveAt = -1, dx = 0 } = {}) {
  const make = () => {
    const w = new ColumnGrid(8, Math.ceil((fall + 8) / 4) * 4, 4);
    for (let z = 0; z < 4; z++) for (let x = 0; x < 8; x++) { w.set(x, 0, z, E.WALL); if (under !== E.WALL) w.set(x, 1, z, under); }
    return w;
  };
  let w = make();
  w.set(1, (under === E.WALL ? 1 : 2) + fall, 1, liquid);
  for (let t = 0; t < 240; t++) {
    if (t === moveAt) {
      const n = make();
      for (let y = 0; y < w.ny; y++) for (let z = 0; z < 4; z++) for (let x = 0; x + dx < 8; x++) {
        const i = w.at(x, y, z), j = n.at(x + dx, y, z);
        n.cores[j] = new Uint32Array(w.cores[i]); n.banks[j] = w.banks[i]; n.events[j] = w.events[i];
      }
      n.busyIn.fill(1); w = n;
    }
    w.step();
  }
  return w.events.reduce((n, v) => n + (v & 1), 0);
}
const dens = id => ELEMENTS[id].dens;

test('a run counts all its fall past R1\'s run speed: each landing goes off past its own height, not at the run speed\'s', () => {
  // nitroglycerin onto the floor: past V1's own fall (10.15 cells, 3.0 m: its liquid falls without drag), the
  // shock check's 4.8 m drop (16 cells) included, under it not; not at NITRO_FALL_M's 16.7 cells
  const [nitro] = COLUMN_SHOCK;
  assert.equal(drop(E.NITRO, E.WALL, 8), 0);
  assert.equal(drop(E.NITRO, E.WALL, Math.floor(nitro.cells)), 0, 'short of V1\'s fall');
  assert.equal(drop(E.NITRO, E.WALL, Math.ceil(nitro.cells)), 1, 'past V1\'s fall');
  assert.equal(drop(E.NITRO, E.WALL, 13), 1, 'at the run speed\'s fall');
  assert.equal(drop(E.NITRO, E.WALL, 16), 1, '4.8 m, short of NITRO_FALL_M');
  // lava and mud onto nitroglycerin past V1's own falls (4.7 m and 5.6 m), both past the run speed's
  for (const liquid of [E.LAVA, E.MUD]) {
    const { cells } = COLUMN_SHOCK_ON.find(r => r.faller === liquid && r.charge === E.NITRO);
    assert.ok(cells > 13, `${ELEMENTS[liquid].key}: V1's fall is past the run speed's`);
    assert.equal(drop(liquid, E.NITRO, Math.floor(cells)), 0, `${ELEMENTS[liquid].key} short of V1's fall`);
    assert.equal(drop(liquid, E.NITRO, Math.floor(cells) + 1), 1, `${ELEMENTS[liquid].key} past V1's fall`);
  }
  // and under it, to the cell: mercury onto nitroglycerin past V1's 10.9 cells
  assert.equal(drop(E.MERCURY, E.NITRO, 10), 0);
  assert.equal(drop(E.MERCURY, E.NITRO, 11), 1);
  // nitroglycerin onto a liquid it does not outweigh much: the reduced mass, past V1's own fall for it (mercury:
  // 10.9 cells); onto one it outweighs too much, never (water: V1's V_MAX caps its hit)
  let need = 0; while (v1LandingKE(E.NITRO, E.MERCURY, need + 0.5) < ELEMENTS[E.NITRO].blast.shock) need += 0.5;
  assert.ok(need > nitro.cells && need < 12, `${need} cells`);
  assert.equal(drop(E.NITRO, E.MERCURY, Math.floor(need)), 0);
  assert.equal(drop(E.NITRO, E.MERCURY, Math.ceil(need + 0.5)), 1);
  assert.equal(drop(E.NITRO, E.WATER, 60), 0);
});

test('the fall lives in the run\'s cells: it moves as every run does, and carries its fall through a save, an undo or a shift', () => {
  assert.deepEqual([...COLUMN_KEEPS_FALL].sort((a, b) => a - b), [E.LAVA, E.MERCURY, E.MUD, E.NITRO].sort((a, b) => a - b));
  // mud dropped 21 cells onto nitroglycerin, copied away mid-fall: it still sets it off past V1's 18.5 cells
  // (counted on from the run speed's 12.6 cells it would not), and from 18 it still does not
  for (const dx of [0, 2]) {
    assert.equal(drop(E.MUD, E.NITRO, 21, { moveAt: 42, dx }), 1, `moved ${dx} cells`);
    assert.equal(drop(E.MUD, E.NITRO, 18, { moveAt: 40, dx }), 0, `moved ${dx} cells`);
  }
  // a nitroglycerin slab and a water slab dropped 40 cells move cell for cell alike (the cap holds the move)
  // until they land; past the run speed the nitroglycerin's lane is the speed its fall carries, ½u² = g·h, the
  // water's R1's run speed as before
  const lane = (c, k) => new Float16Array(new Uint16Array([k ? c[2] >>> 16 : c[2] & 65535]).buffer)[0];
  const fall = (id) => {
    const w = new ColumnGrid(8, 48, 8);
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) w.set(x, 0, z, E.WALL);
    for (let z = 2; z < 6; z++) for (let x = 2; x < 6; x++) for (let y = 41; y < 43; y++) w.set(x, y, z, id);
    const frames = [], bottom = [];
    for (let t = 0; t < 75; t++) {
      w.step();
      frames.push(w.cores.map(c => `${L.cid(c) ? 1 : 0}${c[2] & 65535}`).join());
      let y = 0; while (!L.cid(w.cores[w.at(3, y + 1, 3)])) y++;
      const c = w.cores[w.at(3, y + 1, 3)];
      bottom.push({ descent: 40 - y + lane(c, 0), lane: lane(c, 1) });
    }
    return { frames, bottom };
  };
  const water = fall(E.WATER), nitro = fall(E.NITRO);
  assert.ok(water.frames.every((f, t) => f === nitro.frames[t]), 'the same cells, the same fractions, every tick');
  assert.ok(water.bottom.every(b => b.lane <= Math.f16round(COLUMN.VT)));
  const past = nitro.bottom.filter(b => b.lane > Math.f16round(COLUMN.VT));
  assert.ok(past.length > 30 && past.at(-1).descent > 30, `${past.length} ticks past the run speed`);
  for (const b of past) assert.ok(Math.abs(b.lane ** 2 / (2 * COLUMN.G) - b.descent) < 0.25, `lane ${b.lane} after ${b.descent.toFixed(2)} cells`);
});
