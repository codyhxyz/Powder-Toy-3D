// CPU only (no GPU, no browser): V1's shock (elements.js blast.shock; react.js sets an explosive off
// under a hit of ½·μ·u² past it, common.js hitKE) under V2. Checks the derivation of each charge's
// shock in V2's mechanics (dynamics-reference.js SHOCK_FALL_M, the shock field) and a nitroglycerin
// run landing on the executed column passes (shaders/v2/columns.js colShockLand on
// tools/v2/column-wgsl.mjs's CPU grid of production cells). Particle hits are in
// particle-deposition-check.mjs, a charge set off in flight in airborne-react-check.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ELEMENTS, E, NITRO_FALL_M } from '../../src/elements.js';
import { dynamicsRows, particleFallSpeed, SHOCK_FALL_M, hitKE, GRAVITY } from '../../src/v2/dynamics-reference.js';
import { COLUMN, COLUMN_SHOCK, columnFallSpeed, columnWaterWGSL } from '../../src/shaders/v2/columns.js';
import * as L from '../../src/v2/layout.js';
import { ColumnGrid } from './column-wgsl.mjs';

test('each charge\'s shock, re-derived in V2 from what V1 derived it from', () => {
  // C-4: "a hit that would smash wood" (shock = WOOD's hard); V2 keeps hard as J (toughness)
  assert.equal(ELEMENTS[E.C4].blast.shock, ELEMENTS[E.WOOD].hard);
  assert.equal(dynamicsRows[E.C4].shock, dynamicsRows[E.WOOD].toughness);
  // nitroglycerin: a NITRO_FALL_M fall, on the particle lane's law: about free fall's speed at that height
  assert.equal(SHOCK_FALL_M[E.NITRO], NITRO_FALL_M);
  const v = particleFallSpeed(E.NITRO, NITRO_FALL_M), free = Math.sqrt(2 * GRAVITY * NITRO_FALL_M);
  assert.ok(v < free * 1.03 && v > free * 0.9, `a ${NITRO_FALL_M} m fall lands at ${v.toFixed(2)} m/s (free fall ${free.toFixed(2)})`);
  assert.equal(dynamicsRows[E.NITRO].shock, 0.5 * dynamicsRows[E.NITRO].mass * v ** 2);
  // poured gently it is safe: a 1 m fall carries a fifth of it, a 6 m one more than all of it
  assert.ok(0.5 * dynamicsRows[E.NITRO].mass * particleFallSpeed(E.NITRO, 1) ** 2 < dynamicsRows[E.NITRO].shock / 4);
  assert.ok(0.5 * dynamicsRows[E.NITRO].mass * particleFallSpeed(E.NITRO, 6) ** 2 > dynamicsRows[E.NITRO].shock);
  // every V1 shock has a V2 one, and nothing else has one
  for (const e of ELEMENTS) assert.equal(dynamicsRows[e.id].shock > 0, !!e.blast?.shock, e.key);
  // V1 hitKE: the mover's mass on a solid, the reduced mass otherwise
  assert.equal(hitKE(2, 6, true, 9), 9); assert.equal(hitKE(2, 6, false, 9), 0.5 * 1.5 * 9);
});

test('a run\'s shock speed is its fall on the column law, emitted as the WGSL reads it', () => {
  assert.deepEqual(COLUMN_SHOCK.map(r => r.id), [E.NITRO]);
  // R1's run speed caps the column law: a 5 m fall reaches it (from ~3.7 m), so the shock is the run speed
  assert.equal(columnFallSpeed(NITRO_FALL_M), COLUMN.VT);
  assert.ok(columnFallSpeed(1) < COLUMN.VT);
  assert.match(columnWaterWGSL, new RegExp(`if \\(id == ${E.NITRO}u\\) \\{ return ${COLUMN.VT}; \\}`));
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
    assert.match(code, /colShockLand\(x, z, r0 - d, v\)/);
    assertNaga(code, `${name} ${dims}`);
    assert.deepEqual(wgslGroupingErrors(code), [], `${name}: mixed bitwise operators grouped (Chromium rejects them ungrouped)`);
  }
});

// ---- grid landings ON a charge (dynamics-reference.js SHOCK_LANDINGS): V1's own trigger, a fall height
// per lander and charge, on V2's laws (shaders/v2.js v2ColumnWGSL for grains, columns.js colShockLand for runs)
import { SHOCK_LANDINGS, v1ShockFall } from '../../src/v2/dynamics-reference.js';
import { COLUMN_SHOCK_ON, columnLandingSpeed } from '../../src/shaders/v2/columns.js';
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
  // the emitted speeds are the column law's over V1's falls
  for (const r of COLUMN_SHOCK_ON) assert.ok(Math.abs(r.speed - columnLandingSpeed(r.cells)) < 1e-4, name(r));
});
