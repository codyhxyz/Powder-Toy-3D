// CPU only (no GPU, no browser): V1's shock (elements.js blast.shock; react.js sets an explosive off
// under a hit of ½·μ·u² past it, common.js hitKE) under V2. Checks the derivation of each charge's
// shock in V2's mechanics (dynamics-reference.js SHOCK_FALL_CELLS, the shock field) and a nitroglycerin
// run landing on the executed column passes (shaders/v2/columns.js colShockLand on
// tools/v2/column-wgsl.mjs's CPU grid of production cells), by how far it has fallen (colFall).
// Particle hits are in particle-deposition-check.mjs, a charge set off in flight in airborne-react-check.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ELEMENTS, E, NITRO_FALL_M } from '../../src/elements.js';
import { dynamicsRows, SHOCK_FALL_CELLS, v1OwnShockFall, v1OwnShockLaw, v1LiquidArrival, v1LiquidHit, v1LandingHit, v1GrainOdds, V1_FALL_CELLS_MAX, V1_GRAIN_ODDS, hitKE, GRAVITY, MASS_PER_DENS, particleLandingSpeed, packetShock, SHOCK_THROW_MS } from '../../src/v2/dynamics-reference.js';
import { legacyVelocityToMS } from '../../src/v2/tools.js';
import { COLUMN, COLUMN_SHOCK, columnWaterWGSL } from '../../src/shaders/v2/columns.js';
import * as L from '../../src/v2/layout.js';
import { ColumnGrid, wgslFunction, syntax } from './column-wgsl.mjs';

test('each charge\'s shock, in V1\'s units on a packet\'s hit, its fall re-derived on V2\'s laws', () => {
  // C-4: "a hit that would smash wood" (shock = WOOD's hard), now V1's own number in V1's units: the
  // packet's hit is V1's (V1 densities a cell each, dMass = dens·MASS_PER_DENS), not a joule threshold
  assert.equal(ELEMENTS[E.C4].blast.shock, ELEMENTS[E.WOOD].hard);
  for (const e of ELEMENTS) assert.equal(dynamicsRows[e.id].shockKE, (e.blast?.shock ?? 0) * MASS_PER_DENS, e.key);
  assert.equal(dynamicsRows[E.C4].shockFall, 0, 'C-4 is solid: V1 never drops it');
  // nitroglycerin: V1's own fall onto a solid (its liquid falls without drag, react.js forces, through V1's Margolus
  // move at its paced draws, move.js), on the particle lane's law: about free fall's speed at that height.
  // elements.js derived its shock from a NITRO_FALL_M fall with drag (fallKE), so V1 sets it off from 2.7 m, not 5.
  const h1 = SHOCK_FALL_CELLS[E.NITRO];
  assert.deepEqual(Object.keys(SHOCK_FALL_CELLS).map(Number), [E.NITRO]);
  assert.equal(h1, v1OwnShockFall(E.NITRO));
  assert.deepEqual(v1OwnShockLaw(E.NITRO), { fall: 9, phased: true, cells: 9 });
  const nitroE = ELEMENTS[E.NITRO], ke = h => 0.5 * nitroE.dens * v1LiquidHit(nitroE, h) ** 2;
  assert.ok(ke(9) >= nitroE.blast.shock && ke(8) < nitroE.blast.shock);
  assert.ok(h1 * CELL_M < NITRO_FALL_M, `V1's own fall ${(h1 * CELL_M).toFixed(2)} m`);
  const v = particleLandingSpeed(E.NITRO, h1 * CELL_M), free = Math.sqrt(2 * GRAVITY * h1 * CELL_M);
  assert.ok(v < free * 1.03 && v > free * 0.85, `a ${(h1 * CELL_M).toFixed(2)} m fall lands at ${v.toFixed(2)} m/s (free fall ${free.toFixed(2)})`);
  // its landing maps that speed onto the V1 speed that carries its shock on a solid (½·dens·v² = shock)
  assert.ok(Math.abs(0.5 * ELEMENTS[E.NITRO].dens * (v * dynamicsRows[E.NITRO].shockFall) ** 2 - ELEMENTS[E.NITRO].blast.shock) < 1e-9);
  // poured gently it is safe: a 1 m or 2.4 m (8 cells) fall onto metal is not, a 3.0 m (10 cells) or 6 m one is
  for (const [m, off] of [[1, false], [2.4, false], [3.0, true], [6, true]])
    assert.equal(packetShock(E.NITRO, E.METAL, particleLandingSpeed(E.NITRO, m), true).mover, off, `${m} m`);
  // V1's throws: SHOCK_THROW_MS m/s a cell/step (v2/tools.js legacyVelocityToMS, the throws' own map)
  assert.equal(SHOCK_THROW_MS, legacyVelocityToMS(1));
  // V1 hitKE: the mover's mass on a solid, the reduced mass otherwise
  assert.equal(hitKE(2, 6, true, 9), 9); assert.equal(hitKE(2, 6, false, 9), 0.5 * 1.5 * 9);
});

// V1 measured on the GPU (2026-10-22, tools/outcomes/engine-v1.js, fresh boxes: frame 0, so a cell placed at row
// y0 falls at phase y0 & 1). A lone water cell's speed (cells/step) the step before it lands on the floor (react.js
// left it unlanded once more, after its drag: dynamics-reference.js v1LandingHit's u2), by height:
const V1_WATER_LANDING = [[2, 0.297], [4, 0.5445], [6, 0.6435], [8, 0.693], [10, 0.792], [12, 0.8415], [14, 0.9405], [16, 0.99], [18, 1], [30, 1]];
// nitroglycerin cells and one-layer slabs on the floor of a 64×16×64 box, [fall, frame parity at placement, off]
// (the frame parity flips the phase: phase (y0 + frame) & 1)
const V1_NITRO_LONE = [[8, 0, false], [9, 0, false], [10, 0, true], [9, 1, true], [8, 1, false], [10, 1, true]];
test('V1\'s fall law is V1\'s measured fall: its Margolus move at its paced draws, by height and phase', () => {
  const water = ELEMENTS[E.WATER];
  for (const [h, u] of V1_WATER_LANDING) {
    const k = v1LiquidArrival(h, h & 1);
    assert.ok(Math.abs(Math.min(PHYS.V_MAX, (Math.min(PHYS.V_MAX, k * SIM_GRAVITY) + SIM_GRAVITY) * (1 - water.drag)) - u) < 1e-6, `${h} cells: ${k} steps`);
  }
  // V1 loses its first step to the partition at phase 1: a fall at phase 1 is phase 0's a cell shorter
  for (let h = 2; h < 40; h++) assert.equal(v1LiquidArrival(h, 1), v1LiquidArrival(h - 1, 0), `${h} cells`);
  // its own shock on the floor, as measured: the law's fall at the cell's phase (y0 = h: the floor is row 0)
  const nitro = ELEMENTS[E.NITRO];
  for (const [h, frame, off] of V1_NITRO_LONE) {
    const k = v1LiquidArrival(h, (h + frame) & 1);
    assert.equal(0.5 * nitro.dens * v1LandingHit(nitro, k) ** 2 >= nitro.blast.shock, off, `${h} cells at frame parity ${frame}`);
  }
  assert.equal(V1_FALL_CELLS_MAX, 17, 'V_MAX from 17 cells');
});

const literal = x => String(x).replace('.', '\\.');
test('a run\'s shock is V1\'s own fall law, emitted as the WGSL reads it: V1\'s fall, so V1\'s speed at its landing', () => {
  assert.deepEqual(COLUMN_SHOCK.map(r => r.id), [E.NITRO]);
  const [nitro] = COLUMN_SHOCK, e = ELEMENTS[E.NITRO];
  assert.equal(nitro.cells, SHOCK_FALL_CELLS[E.NITRO]);
  assert.equal(nitro.speed2, 2 * e.blast.shock / e.dens);
  // a run falls on V1's own chain (colFall): V1's gravity a step, V1's V_MAX, four V1 steps a tick
  assert.equal(COLUMN.G_STEP, SIM_GRAVITY);
  assert.equal(COLUMN.V_MAX, PHYS.V_MAX);
  assert.equal(COLUMN.STEPS, 4);
  assert.match(columnWaterWGSL, new RegExp(`fn colShockSpeed2\\(id: u32\\) -> f32 \\{\\n  if \\(id == ${E.NITRO}u\\) \\{ return ${literal(nitro.speed2)}; \\}`));
  // the emitted colV1FallSpeed, colV1Fall and colV1Hit, executed: V1's hit after a fall at phase 0, for every fall;
  // the fall a stack counts (its top's); a lone cell's hit at its own landing speed (v1LandingHit)
  const { args, body } = wgslFunction(columnWaterWGSL, 'colV1FallSpeed');
  const speed = Function(...args, syntax(body));
  for (let h = -1; h < 60; h++) assert.ok(Math.abs(speed(E.NITRO, h) - v1LiquidHit(e, Math.min(h, V1_FALL_CELLS_MAX))) < 1e-9, `${h} cells`);
  assert.equal(speed(E.WATER, 30), 0);
  const fallFn = wgslFunction(columnWaterWGSL, 'colV1Fall');
  const counted = Function(...fallFn.args, 'floor', 'i32', 'f32', syntax(fallFn.body));
  const at = (h, n) => counted(h, n, Math.floor, Math.trunc, Math.fround);
  for (let h = 1; h < 30; h++) for (const dh of [-0.3, 0, 0.3]) for (const n of [1, 2, 3, 5]) assert.equal(at(h + dh, n), h + n - 1, `stack of ${n}`);
  const hitFn = wgslFunction(columnWaterWGSL, 'colV1Hit');
  const hit = (id, u1) => Function(...hitFn.args, 'max', 'min', 'colStepGravity', 'COL_V_MAX', syntax(hitFn.body))(id, u1, Math.max, Math.min, () => SIM_GRAVITY, PHYS.V_MAX);
  for (let k = 0; k <= 45; k++) assert.ok(Math.abs(hit(E.NITRO, Math.min(PHYS.V_MAX, k * SIM_GRAVITY)) - v1LandingHit(e, k)) < 1e-9, `${k} steps`);
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
    assert.match(code, /colShockLand\(x, z, r0 - d, fallen, r1 - r0, hit\)/);
    assertNaga(code, `${name} ${dims}`);
    assert.deepEqual(wgslGroupingErrors(code), [], `${name}: mixed bitwise operators grouped (Chromium rejects them ungrouped)`);
  }
});

// ---- grid landings ON a charge (dynamics-reference.js SHOCK_LANDINGS): V1's own trigger, a fall height
// per lander and charge, on V2's laws (shaders/v2.js v2ColumnWGSL for grains, columns.js colShockLand for runs)
import { SHOCK_LANDINGS, v1ShockFall, v1GrainOddsTable, GRAIN_ODDS_FULL } from '../../src/v2/dynamics-reference.js';
import { COLUMN_SHOCK_ON } from '../../src/shaders/v2/columns.js';
import { PACE } from '../../src/shaders/move.js';
import { powderLandingSpeed, stepFall, fallVelocity, fallTerminal } from '../../src/v2/fall.js';
import { SIM_GRAVITY, PHYS } from '../../src/physics.js';
import { K } from '../../src/elements.js';
import { CELL_M } from '../../src/scale.js';

// V1 react.js and the shock (common.js hitKE, shockActs): the KE a lone cell of a liquid faller (V1's paced fall,
// at phase 0) carries landing on charge after a fall of h cells from rest
function v1LandingKE(faller, charge, h) {
  const j = ELEMENTS[faller], k = ELEMENTS[charge];
  return hitKE(j.dens, k.dens, k.kind === K.SOLID, v1LiquidHit(j, h) ** 2);
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
    const j = ELEMENTS[r.faller], k = ELEMENTS[r.charge], shock = k.blast.shock, mu = k.kind === K.SOLID ? j.dens : j.dens * k.dens / (j.dens + k.dens);
    if (j.kind === K.LIQUID && !(r.faller === E.MERCURY && r.charge === E.NITRO) && !(r.faller === E.MUD && r.charge === E.NITRO)) {
      // a liquid's own law: from its fall at phase 0 it goes off, short of it (a cell less) not
      assert.ok(r.phased && r.cells === r.fall, name(r));
      assert.ok(v1LandingKE(r.faller, r.charge, r.fall) >= shock, `${name(r)} from ${r.fall}`);
      assert.ok(v1LandingKE(r.faller, r.charge, r.fall - 1) < shock, `${name(r)} short of ${r.fall}`);
    } else if (j.kind === K.POWDER) {
      // a grain's: V1's odds over its random draws reach V1_GRAIN_ODDS from its fall, not a cell short of it
      assert.ok(!r.phased && r.cells === r.fall - 0.5, name(r));
      assert.ok(v1GrainOdds(j, mu, shock, r.fall) >= V1_GRAIN_ODDS && v1GrainOdds(j, mu, shock, r.fall - 1) < V1_GRAIN_ODDS, name(r));
    }
  }
  // V1 measured (2026-10-22, engine-v1.js, 2×2 slabs in fresh boxes, [faller, charge, fall, frame parity, off]):
  // mercury onto C-4 is its own fall's law; heavier liquids sinking into nitroglycerin go off sooner than a lone
  // landing's hit (mercury from 2 cells, mud from 15 at phase 0), dynamics-reference.js V1_SINKING_FALLS
  const law = (f, c) => SHOCK_LANDINGS.find(r => r.faller === f && r.charge === c);
  for (const [f, c, h, frame, off, landRow] of [[E.MERCURY, E.C4, 4, 0, false, 1], [E.MERCURY, E.C4, 4, 1, true, 1], [E.MERCURY, E.C4, 3, 0, false, 1],
    [E.MERCURY, E.C4, 3, 1, false, 1], [E.MERCURY, E.C4, 5, 0, true, 1], [E.MERCURY, E.C4, 5, 1, true, 1], [E.MERCURY, E.C4, 6, 0, true, 1],
    [E.MERCURY, E.NITRO, 2, 0, true, 2], [E.MERCURY, E.NITRO, 2, 1, true, 2], [E.MERCURY, E.NITRO, 8, 0, true, 2],
    [E.MUD, E.NITRO, 14, 0, false, 2], [E.MUD, E.NITRO, 14, 1, false, 2], [E.MUD, E.NITRO, 15, 0, false, 2], [E.MUD, E.NITRO, 15, 1, true, 2],
    [E.MUD, E.NITRO, 16, 0, true, 2], [E.MUD, E.NITRO, 16, 1, true, 2], [E.MUD, E.NITRO, 17, 0, true, 2]]) {
    const r = law(f, c), phase = r.phased ? (landRow + h + frame) & 1 : 0;
    assert.equal(h - phase >= r.fall, off, `${name(r)} from ${h} at frame parity ${frame}`);
  }
  assert.equal(law(E.URANIUM, E.C4).fall, 3);
  assert.equal(law(E.SCRAP, E.C4).fall, 9);
  for (const key of ['SAND', 'STONE', 'GUNPOWDER', 'SALT', 'WATER', 'OIL', 'ACID', 'SNOW'])
    for (const charge of [E.C4, E.NITRO]) assert.equal(v1ShockFall(E[key], charge), null, `${key} never`);
  assert.equal(v1ShockFall(E.NITRO, E.NITRO), null, 'never its own element');
});

test('a grain rolls V1\'s own odds by its fall on each landing (BL-7; behaviour: tools/v2/grain-landing-check.mjs)', () => {
  const code = columnCode([32, 32, 32]);
  for (const r of SHOCK_LANDINGS.filter(r => ELEMENTS[r.faller].kind === K.POWDER)) {
    // the pair's odds table, by fall, is V1's (v1GrainOdds) to the first fall that always sets it off
    assert.match(code, new RegExp(`if \\(faller == ${r.faller}u && charge == ${r.charge}u\\) \\{ at = \\d+; n = \\d+; \\}`), name(r));
    const table = v1GrainOddsTable(r.faller, r.charge);
    assert.ok(table.at(-1) >= GRAIN_ODDS_FULL && table.every((o, i) => i === 0 || o >= table[i - 1]), name(r));
    // the V1 fall where the odds pass a half is the old single height's (v1ShockLaw)
    assert.equal(table.findIndex(o => o >= 0.5) + 1, r.fall, name(r));
  }
  // sand, the commonest grain, has no trigger on either charge
  assert.doesNotMatch(code, new RegExp(`faller == ${E.SAND}u`));
});

test('the column pass lands its grains through grainLands and validates', async () => {
  const { assertNaga, wgslGroupingErrors } = await import('./wgsl-grouping.mjs');
  for (const dims of [[32, 32, 32], [48, 16, 32]]) {
    const code = columnCode(dims);
    assert.match(code, /if \(to <= fl\) \{\n\s*\/\/[^\n]*\n\s*if \(!runFalling\) \{ landHeat = grainLands\(vec3i\(x, fl - 1, z\), c, v, grainFallen\(cid\(c\), fallVelocity\(c\)\) \+ y - fl\); \}/);
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
  for (const r of COLUMN_SHOCK_ON) assert.match(columnWaterWGSL, new RegExp(`if \\(faller == ${r.faller}u && charge == ${r.charge}u\\) \\{ return ${r.fall}; \\}`), name(r));
});

// A run of liquid one cell across (a column of the CPU twin's production pass) dropped `fall` cells, bottom to
// bottom, onto `under` (the floor itself when WALL, else a layer of it on the floor): the requests it lands.
// moveAt: that tick, every cell (cores, banks, requests) goes into a fresh grid, `dx` cells along x: a save
// and a load, an undo, a World window's shift (shaders/v2/window.js moves cores and banks); nothing else goes.
// tall: a run of that many cells (its bottom falls `fall`); wide: a slab of wide × wide such runs
function drop(liquid, under, fall, { moveAt = -1, dx = 0, tall = 1, wide = 1 } = {}) {
  const make = () => {
    const w = new ColumnGrid(8, Math.ceil((fall + tall + 8) / 4) * 4, 4);
    for (let z = 0; z < 4; z++) for (let x = 0; x < 8; x++) { w.set(x, 0, z, E.WALL); if (under !== E.WALL) w.set(x, 1, z, under); }
    return w;
  };
  let w = make();
  for (let k = 0; k < tall; k++) for (let z = 1; z < 1 + wide; z++) for (let x = 1; x < 1 + wide; x++) w.set(x, (under === E.WALL ? 1 : 2) + fall + k, z, liquid);
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

test('a run counts all its fall: each landing goes off from its own fall, at its phase', () => {
  // nitroglycerin onto the floor (WALL at row 0: it lands at row 1, starts at row 1 + fall) and onto a metal layer
  // (lands at row 2): from 9 cells at phase 0 (its start row even), from 10 at phase 1, as V1's (V1_NITRO_LONE)
  const [nitro] = COLUMN_SHOCK;
  assert.equal(nitro.cells, 9);
  for (const [under, fall, off] of [[E.WALL, 7, false], [E.WALL, 8, false], [E.WALL, 9, true], [E.METAL, 9, false], [E.METAL, 10, true],
    [E.WALL, 10, true], [E.WALL, 13, true], [E.WALL, 16, true], [E.METAL, 8, false]])
    assert.equal(drop(E.NITRO, under, fall), +off, `onto ${ELEMENTS[under].key} from ${fall} (row ${(under === E.WALL ? 1 : 2) + fall})`);
  // a slab lands as its cells: four requests or none
  assert.equal(drop(E.NITRO, E.WALL, 9, { wide: 2 }), 4);
  assert.equal(drop(E.NITRO, E.METAL, 9, { wide: 2 }), 0);
  // a stack counts its top's fall at any phase (V1, 4×4 blocks 3 and 5 tall: rest from a top's fall of 8, go off
  // from 9): a run 3 tall whose bottom falls 6 or 7 cells
  for (const under of [E.WALL, E.METAL]) for (const tall of [2, 3, 5]) {
    assert.equal(drop(E.NITRO, under, 9 - tall, { tall }), 0, `${tall} tall, its top falling 8, onto ${ELEMENTS[under].key}`);
    assert.equal(drop(E.NITRO, under, 10 - tall, { tall }), 1, `${tall} tall, its top falling 9, onto ${ELEMENTS[under].key}`);
  }
  // lava and mud onto nitroglycerin (a layer at row 1: they land at row 2) from their own falls (13 and 15 at
  // phase 0), both past the run speed's; mercury from any fall (V1_SINKING_FALLS: V1 measured 0, 1, 2 to 9 cells)
  for (const liquid of [E.LAVA, E.MUD]) {
    const r = COLUMN_SHOCK_ON.find(r => r.faller === liquid && r.charge === E.NITRO);
    assert.ok(r.fall > 12 && r.phased, `${ELEMENTS[liquid].key}: V1's fall is past the run speed's`);
    const even = r.fall - (r.fall & 1);   // a fall whose start row (2 + fall) is even: phase 0
    assert.equal(drop(liquid, E.NITRO, even - 2), 0, `${ELEMENTS[liquid].key} short of V1's fall`);
    assert.equal(drop(liquid, E.NITRO, even + (r.fall & 1 ? 2 : 0)), 1, `${ELEMENTS[liquid].key} from V1's fall`);
  }
  assert.equal(drop(E.MUD, E.NITRO, 15), 0, 'mud from 15 at phase 1');
  assert.equal(drop(E.MUD, E.NITRO, 16), 1, 'mud from 16 at phase 0');
  assert.equal(drop(E.MERCURY, E.NITRO, 1), 1);
  assert.equal(drop(E.MERCURY, E.NITRO, 2), 1);
  assert.equal(drop(E.MERCURY, E.NITRO, 3), 1);
  // nitroglycerin onto a liquid it does not outweigh much: the reduced mass, from V1's own fall for it (mercury:
  // 9 cells at phase 0); onto one it outweighs too much, never (water: V1's V_MAX caps its hit)
  let need = 1; while (v1LandingKE(E.NITRO, E.MERCURY, need) < ELEMENTS[E.NITRO].blast.shock) need++;
  assert.equal(need, 9);
  // (onto the layer at row 1 it lands at row 2: from 9 cells it starts at row 11, phase 1; from 10 at phase 0)
  assert.equal(drop(E.NITRO, E.MERCURY, 8), 0);
  assert.equal(drop(E.NITRO, E.MERCURY, 9), 0);
  assert.equal(drop(E.NITRO, E.MERCURY, 10), 1);
  assert.equal(drop(E.NITRO, E.WATER, 60), 0);
});

test('the fall lives in the run\'s cells: it moves as every run does, and carries its fall through a save, an undo or a shift', () => {
  // mud dropped 22 cells onto nitroglycerin, copied away mid-fall: it still sets it off from V1's 15 cells, and from
  // 14 it still does not
  for (const dx of [0, 2]) {
    assert.equal(drop(E.MUD, E.NITRO, 22, { moveAt: 8, dx }), 1, `moved ${dx} cells`);
    assert.equal(drop(E.MUD, E.NITRO, 14, { moveAt: 6, dx }), 0, `moved ${dx} cells`);
  }
});

// V1's own fall, as V1 runs it (dynamics-reference.js v1LiquidArrival: V1's measured landings to the digit), and the
// step at which it arrives: a lone liquid cell placed at row y0 of a fresh box (phase y0 & 1) falling `fall` cells
function v1Arrival(fall, phase) {
  const g = Math.fround(SIM_GRAVITY), f32 = Math.fround;
  let y = fall, v = 0, parity = (phase + fall) & 1;
  for (let n = 0; n < 1000; n++) {
    parity ^= 1;
    if (v > 0 && ((y - parity) & 1) === 1) {
      const age = v < PHYS.V_MAX ? Math.floor(f32(f32(v / g) + 0.5)) : 0;
      const s = Math.imul(age, PACE.Y) >>> 0, draw = f32(f32(f32((s >>> 8) * 256) + (s & 255)) * f32(2 ** -32));
      if (v >= PHYS.V_MAX || draw < v) { y -= 1; if (y === 0) return { step: n + 1, speed: v }; }
    }
    v = Math.min(PHYS.V_MAX, f32(v + g));
  }
  throw new Error('no landing');
}
test('a run falls on V1\'s fall: it arrives in the tick V1\'s cell does, at V1\'s speed, whatever its height, phase or width', () => {
  for (let fall = 1; fall <= 48; fall++) for (const wide of [1, 2]) {
    const y0 = 1 + fall, w = new ColumnGrid(4, Math.ceil((y0 + 6) / 4) * 4, 4);
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) w.set(x, 0, z, E.WALL);
    for (let z = 1; z < 1 + wide; z++) for (let x = 1; x < 1 + wide; x++) w.set(x, y0, z, E.WATER);
    const v1 = v1Arrival(fall, y0 & 1), lane = c => new Float16Array(new Uint16Array([c[2] >>> 16]).buffer)[0];
    let tick = 0, before = 0;
    for (;;) {
      w.step(); tick++;
      const c = w.cores[w.at(1, 1, 1)];
      // (it lands, or its landing splashes it aside at once: V1's move.js land, columns.js colSplash)
      if (L.cid(c) === E.WATER || w.parts.length) break;
      let y = 1; while (L.cid(w.cores[w.at(1, y, 1)]) !== E.WATER) y++;
      before = lane(w.cores[w.at(1, y, 1)]) / COLUMN.STEPS;
      assert.ok(tick < 100, `${fall} cells: no landing`);
    }
    // V1's step n is in tick ceil(n / 4) (V1 steps four a tick); its speed then, that many steps of g, to V_MAX
    assert.equal(tick, Math.ceil(v1.step / COLUMN.STEPS), `${fall} cells (${wide} wide): V2 tick ${tick}, V1 step ${v1.step}`);
    assert.ok(before <= v1.speed + 1e-3 && v1.speed - before <= COLUMN.STEPS * SIM_GRAVITY + 1e-3, `${fall} cells: ${before} the tick before, V1 ${v1.speed}`);
  }
  // V1's terminal speed: past V1_FALL_CELLS_MAX a run falls a cell a step, its lane V_MAX (cells/tick: four)
  const w = new ColumnGrid(4, 64, 4);
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) w.set(x, 0, z, E.WALL);
  w.set(1, 60, 1, E.NITRO); w.set(1, 61, 1, E.NITRO);
  const rows = [];
  for (let t = 0; t < 14; t++) { w.step(); let y = 1; while (L.cid(w.cores[w.at(1, y, 1)]) !== E.NITRO) y++; rows.push(y); }
  assert.equal(rows.at(-2) - rows.at(-1), COLUMN.STEPS * PHYS.V_MAX, `four cells a tick at V_MAX: ${rows}`);
});
