// V2 matches V1's element rules for reactions' puffs, explosives, breaking, dust, sensors,
// moss and singularities (the "elements boom" audit rows). CPU only: no browser, no GPU.
import assert from 'node:assert/strict';
import { E, ELEMENTS, REACTIONS } from '../../src/elements.js';
import { PHYS } from '../../src/physics.js';
import { CEDAR_BASE } from '../../src/appearance.js';
import * as C from '../../src/v2/contact.js';
import { dynamicsRows, LEGACY_PRESSURE_PA, EVENT } from '../../src/v2/dynamics-reference.js';
import { validateDynamicState } from '../../src/v2/dynamics.js';
import { blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { airWGSL } from '../../src/shaders/v2/air.js';
import { nativeDynamicsHead } from '../../src/shaders/v2.js';
import { gridLayout } from '../../src/sim.js';

const q = T => Math.round((T + 273.25) * 4);
const cell = (id, T = ELEMENTS[id].temp) => C.ctNew(id, q(T), 65536);
const ns = (...cells) => [...cells, ...Array.from({ length: 3 }, () => cell(E.EMPTY))].slice(0, 3);
const puffOf = request => Math.floor(request / C.CONTACT_PUFF_UNIT);
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

test('row 22: cedar-leaf moss keeps its look and reads its damp, not its appearance code', () => {
  // V1 appearanceCtype: cedar moss beside water is CEDAR_BASE + DAMP_REACH, still cedar.
  const cedar = cell(E.MOSS); cedar.ctype = CEDAR_BASE;
  assert.equal(C.ctStep(cedar, ns(cell(E.WATER)), 0).ctype, CEDAR_BASE + PHYS.DAMP_REACH);
  // dry cedar moss (damp 0) far from water stays dry and cedar
  assert.equal(C.ctStep(cedar, ns(cell(E.ROCK)), 0).ctype, CEDAR_BASE);
  // V1 physicalCtype: dry cedar moss is not wet, so it spreads no damp ...
  assert.equal(C.ctStep(cell(E.MOSS), ns(cedar), 0).ctype, 0);
  assert.equal(C.ctStep(cell(E.FUNGUS), ns(cedar), 0).ctype, 0);
  // ... and cannot grow into air (V1 counts only wet moss)
  const air = C.ctStep(cell(E.EMPTY), ns(cedar, cell(E.ROCK)), 0);
  assert.equal(air.busy, 0, 'dry cedar moss keeps no air awake');
  // damp cedar moss wicks one less, as plain moss does
  const wet = cell(E.MOSS); wet.ctype = CEDAR_BASE + 3;
  assert.equal(C.ctStep(cell(E.MOSS), ns(wet), 0).ctype, 2);
  // a hot cedar mat dries but keeps its look (V1: dampOf 0 above DAMP_DRY_T)
  const hot = cell(E.MOSS, PHYS.DAMP_DRY_T + 10); hot.ctype = CEDAR_BASE + 4;
  assert.equal(C.ctStep(hot, ns(cell(E.WATER)), 0).ctype, CEDAR_BASE);
});

test('row 23: only liquid water wets moss and fungus (V1 dampOf), not saltwater', () => {
  assert.equal(C.ctStep(cell(E.MOSS), ns(cell(E.SALTWATER)), 0).ctype, 0);
  assert.equal(C.ctStep(cell(E.FUNGUS), ns(cell(E.SALTWATER)), 0).ctype, 0);
  assert.equal(C.ctStep(cell(E.MOSS), ns(cell(E.WATER)), 0).ctype, PHYS.DAMP_REACH);
});

test('row 19: suspended dust needs V1 DUST_RICH_AIR air faces of six, counting the outside faces', () => {
  const dust = cell(E.DUST, 500); dust.fallSpeed = C.DUST_MIN_FALL_SPEED;
  const wall = cell(E.STONE);
  // one in-block air face and none outside: a heap's rich top, it does not go off
  assert.equal(C.ctStepAtmosphere(dust, [cell(E.DUST), wall, cell(E.EMPTY)], 0, 0, 0, 0, 0).request & 1, 0);
  // one in-block and one outside air face: two of six, a cloud
  assert.ok(C.ctStepAtmosphere(dust, [cell(E.DUST), wall, cell(E.EMPTY)], 0, 1, 0, 0, 1).request & 1);
  // no dust face: a lone mote burns, it does not go off
  assert.equal(C.ctStepAtmosphere(dust, [wall, cell(E.EMPTY), cell(E.EMPTY)], 0, 3, 0, 0, 3).request & 1, 0);
});

test('row 20: the temperature sensor fires past V1 MATTER_REST_T, sub-quantum heat included', () => {
  const sensor = cell(E.TSNS, 50), stone = cell(E.STONE, 50);
  // same quarter-kelvin, but half a quantum hotter in its bank: V1 fires (> 0.01 K)
  stone.bank = Math.floor(C.ctCapacity(stone) / 2);
  assert.ok(C.ctTemperatureRemainder(stone) * 0.25 > PHYS.MATTER_REST_T);
  assert.ok(C.ctLife(C.ctStep(sensor, ns(stone), 0)) >= 1, 'fires on a sub-quantum excess');
  assert.equal(C.ctLife(C.ctStep(sensor, ns(cell(E.STONE, 50)), 0)), 0, 'equal: no fire');
});

test('row 16: thermite turns into its LAVA of METAL at blast.T with its puff, not a charge', () => {
  const th = cell(E.THERMITE, ELEMENTS[E.THERMITE].ignite + 10), out = C.ctStep(th, ns(), 0);
  assert.equal(out.id, E.LAVA); assert.equal(out.ctype, E.METAL);
  assert.equal(out.tq, q(ELEMENTS[E.THERMITE].blast.T));
  assert.equal(out.request & EVENT.DETONATE, 0, 'no blast-pass charge');
  assert.ok(out.request & EVENT.GAS);
  assert.equal(puffOf(out.request), Math.max(1, Math.round(ELEMENTS[E.THERMITE].blast.P * LEGACY_PRESSURE_PA)));
  assert.ok(out.source > 0n, 'the reaction heat is a declared source');
  assert.equal(C.ctEnergy(out), C.ctEnergy(th) + out.source - out.sink);
  // a cold one waits
  assert.equal(C.ctStep(cell(E.THERMITE), ns(), 0).id, E.THERMITE);
  // every other explosive still requests the blast pass
  for (const e of ELEMENTS.filter(e => e.blast && !e.blast.into)) assert.equal(C.ctRow(e.id).blastInto, -1, e.key);
});

test('row 13: a reaction puffs V1 pressure (half puffP a cell, capped at P_MAX); antimatter blasts', () => {
  const sizes = new Set();
  for (const [i, r] of REACTIONS.entries()) {
    const row = C.CONTACT_REACTIONS[i];
    const want = r.puff ? Math.max(1, Math.round(Math.min(PHYS.P_MAX, 0.5 * PHYS.STEAM_BOIL_PUFF * r.puff / PHYS.STEAM_EXPANSION) * LEGACY_PRESSURE_PA)) : 0;
    assert.equal(row.puff, want, `${r.a}+${r.b}`); if (want) sizes.add(want);
  }
  assert.ok(sizes.size > 1, 'puffs differ in size');
  // annihilation: both cells at P_MAX
  let pair = null;
  for (let seed = 0; seed < 64 && !pair?.changed; seed++) pair = C.ctReaction(cell(E.ANTIMATTER), cell(E.STONE), seed);
  assert.ok(pair.changed);
  for (const c of [pair.a, pair.b]) { assert.ok(c.request & EVENT.GAS); assert.equal(puffOf(c.request), C.CONTACT_PUFF_MAX_PA); }
  // two unconsumed puffs keep the larger, never an OR of their bits
  assert.equal(C.ctPuff(C.ctPuff(0, 5), 6), 2 | (6 * C.CONTACT_PUFF_UNIT));
  assert.equal(C.ctPuff(1 | (9 * C.CONTACT_PUFF_UNIT), 4), 3 | (9 * C.CONTACT_PUFF_UNIT));
});

const g = gridLayout(32, 32, 32);
test('puffs reach the air: the source adds them clamped to P_MAX and saves keep them', () => {
  const source = airWGSL(g, nativeDynamicsHead, 'source');
  assert.match(source, /let payload=events\[s\]\/256u;/);
  assert.match(source, /events\[s\]&=5u;/);
  assert.ok(source.includes(`${C.CONTACT_PUFF_MAX_PA}.0-a.vp.w`));
  // a pending GAS request with a puff restores; a puff without GAS is corrupt
  const ok = bits => { try { validateDynamicState({ ...minimalSnapshot(), pendingEvents: [{ worldCell: [0, 0, 0], bits }] }, g); return true; } catch { return false; } };
  assert.ok(ok(EVENT.GAS | (77 * C.CONTACT_PUFF_UNIT)));
  assert.ok(!ok(77 * C.CONTACT_PUFF_UNIT));
  assert.ok(!ok(EVENT.DETONATE | (77 * C.CONTACT_PUFF_UNIT)));
});

test('rows 15 and 17: V1 per-cell pressure breaks solids and sets off C4, nitro and TNT', () => {
  for (const e of ELEMENTS) {
    const row = dynamicsRows[e.id];
    if (e.breakInto) assert.equal(row.strength, e.hard * PHYS.P_BREAK_PER_HARD * LEGACY_PRESSURE_PA, e.key);
    assert.equal(row.crush, e.blast?.crushP ? e.blast.crushP * LEGACY_PRESSURE_PA : 0, e.key);
  }
  for (const key of ['C4', 'NITRO', 'TNT']) assert.ok(dynamicsRows[E[key]].crush > 0, key);
  const plan = blastsWGSL(g, nativeDynamicsHead, 'couplePlan');
  // the break reads per-cell pressures with a solid neighbour holding none
  assert.match(plan, /difference = max\(difference,abs\(dOpenPressure\(p\+dAxis\(a\)\)-dOpenPressure\(p-dAxis\(a\)\)\)\)/);
  assert.match(plan, /if \(on>dCrush\(id\)\) \{ events\[t\]\|=1u; noteEvents\(t,events\[t\]\);/);
  assert.match(plan, /fn dPressureCell\(p: vec3i\)/);
});

test('row 24: a singularity holds the brick at the mean of V1 per-cell vacuums', () => {
  const source = airWGSL(g, nativeDynamicsHead, 'source');
  assert.match(source, /a\.vp\.w=\(a\.vp\.w\*\(64\.0-pins\.y-pins\.w\)\+pins\.x\+min\(a\.vp\.w\*pins\.w,pins\.z\)\)\/64\.0;/);
  assert.ok(!/a\.vp\.w=min\(a\.vp\.w,vacuum\)/.test(source), 'no whole-brick vacuum');
  const plan = blastsWGSL(g, nativeDynamicsHead, 'couplePlan');
  assert.ok(plan.includes(`${PHYS.SING_RING}*contactVacuum(`), 'the per-cell read keeps the ring');
});

function minimalSnapshot() {
  return { version: 1, dims: [g.nx, g.ny, g.nz], origin: [0, 0, 0], particles: new Uint32Array(65536 * 12), air: new Uint32Array(g.nbricks * 8),
    control: new Uint32Array(32), held: new Uint32Array(65536), shocks: new Uint32Array(g.nbricks), rayRemaining: new Uint32Array(64),
    requests: [], pendingEvents: [], airArchive: [], sequence: 0, blastBatch: 8 };
}
console.log(`${checks} elements-boom CPU groups passed; no GPU launched`);
