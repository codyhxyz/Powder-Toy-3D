// CPU only: V1 react.js heat and phase rules that Physics V2's contact pass
// ports (per-step rates as per-tick ones, NOMINAL_STEP_RATE → CONTACT_HZ).
// Each group fails if its port is reverted. No browser, device or GPU.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { PHYS, NOMINAL_STEP_RATE } from '../../src/physics.js';
import { EDGE } from '../../src/simModes.js';
import * as C from '../../src/v2/contact.js';

const q = T => Math.round((T + 273.25) * 4);
const cell = (id, T = ELEMENTS[id].temp) => C.ctNew(id, q(T), 65536);
const energy = c => C.ctEnergy(c);
const ledger = (before, after) => assert.equal(energy(after) + after.sink - after.source, energy(before), 'exact declared ledger');
const STEPS = NOMINAL_STEP_RATE / C.CONTACT_HZ;
const air = () => [cell(E.EMPTY), cell(E.EMPTY), cell(E.EMPTY)];
let groups = 0;
function test(name, fn) { fn(); groups++; console.log(`ok ${name}`); }

test('row 1: air and gases relax toward ambient at V1 react.js rates, per tick, then rest', () => {
  for (const id of ELEMENTS.map(e => e.id)) {
    const rad = id === E.EMPTY ? PHYS.AIR_AMBIENT_PULL : ELEMENTS[id].rad;
    assert.equal(C.ctRow(id).cool, Math.fround(1 - (1 - rad) ** STEPS), ELEMENTS[id].key);
  }
  // V1: T += (airT - T)·rate a step. Over one tick: (1 - (1-rate)^4) of the gap.
  for (const [id, T] of [[E.EMPTY, 200], [E.SMOKE, 300], [E.CO2, -50], [E.FIRE, 1000], [E.PLASMA, 9000]]) {
    const hot = cell(id, T), out = C.ctAmbient(hot, q(20), 1);
    const rate = C.ctRow(id).cool, moved = (out.tq - hot.tq) / (q(20) - hot.tq);
    assert(Math.abs(moved - rate) < 0.002, `${ELEMENTS[id].key}: moved ${moved} of the gap, V1 ${rate}`);
    assert.equal(out.busy, 1); ledger(hot, out);
  }
  // Matter without rad keeps its heat (V1: rad 0), and the scene's ambient is the target.
  for (const id of [E.WOOD, E.WATER, E.METAL, E.SAND]) assert.equal(C.ctAmbient(cell(id, 300), q(20), 1).tq, q(300), ELEMENTS[id].key);
  let cold = cell(E.EMPTY, 20);
  for (let t = 0; t < 4000; t++) cold = C.ctAmbient({ ...cold, busy: 0 }, q(-15), 1);
  assert.equal(cold.tq, q(-15), 'air settles at a cold scene\'s ambient'); assert.equal(C.ctAmbient({ ...cold, busy: 0 }, q(-15), 1).busy, 0, 'and rests');
  // Hot air in a box: V1's time constant, 1/(AIR_AMBIENT_PULL·240) s ≈ 2.1 s, to within a tick.
  let hot = cell(E.EMPTY, 220), ticks = 0;
  while (hot.tq > q(20 + 200 / Math.E)) { hot = C.ctAmbient(hot, q(20), 1); ticks++; }
  const tau = 1 / (PHYS.AIR_AMBIENT_PULL * NOMINAL_STEP_RATE);
  assert(Math.abs(ticks / C.CONTACT_HZ - tau) < 2 / C.CONTACT_HZ, `air 1/e in ${ticks / C.CONTACT_HZ} s, V1 ${tau} s`);
  // Whole blocks: contactReference ends every cell's tick with the pull.
  const cores = Array.from({ length: 8 }, () => C.packContact(cell(E.EMPTY, 120)).core);
  const out = C.contactReference(cores.map(c => new Uint32Array(c)), new Int32Array(8), 3);
  for (let i = 0; i < 8; i++) assert(C.unpackContact(out.cores[i], out.banks[i]).tq < q(120), 'block air cools');
});

test('row 1: steam cools and condenses on its own in V1 react.js time (rad 0.03, L_BOIL)', () => {
  // V1: steam pinned at 100 °C banks (100 - 20)·rad·cap a step toward L_BOIL.
  const v1Steps = PHYS.L_BOIL / ((100 - PHYS.AMBIENT) * ELEMENTS[E.STEAM].rad * ELEMENTS[E.STEAM].cap);
  let steam = cell(E.STEAM, 110), ticks = 0;
  while (steam.id === E.STEAM && ticks < 2000) {
    const before = steam;
    steam = C.ctAmbient(C.ctStep({ ...steam, source: 0n, sink: 0n }, air(), ticks), q(20), 1); ticks++;
    ledger({ ...before, source: 0n, sink: 0n }, steam);
  }
  assert.equal(steam.id, E.CLOUD, 'open-air steam condenses into cloud');
  assert(Math.abs(ticks * STEPS - v1Steps) / v1Steps < 0.1, `condensed in ${ticks * STEPS} steps, V1 ≈ ${v1Steps.toFixed(0)}`);
});

test('row 2: ambient heat off holds air at ambient and stops matter trading heat with it', () => {
  const hotAir = cell(E.EMPTY, 300), pinned = C.ctAmbient(hotAir, q(20), 0);
  assert.equal(pinned.tq, q(20)); assert.equal(pinned.bank, 0); ledger(hotAir, pinned);
  assert.equal(C.ctAmbient(cell(E.EMPTY, 20), q(20), 0).busy, 0, 'air at ambient rests');
  const steam = cell(E.STEAM, 300); assert(C.ctAmbient(steam, q(20), 0).tq < steam.tq, 'gases still radiate (V1 applies rad either way)');
  const metal = cell(E.METAL, 500), wood = cell(E.WOOD, 20), gas = cell(E.EMPTY, 20);
  assert.equal(C.ctConducts(metal, gas, 0), false); assert.equal(C.ctConducts(gas, metal, 0), false);
  assert.equal(C.ctConducts(gas, gas, 0), false, 'V1: no conduction with an EMPTY cell at all');
  assert.equal(C.ctConducts(metal, wood, 0), true, 'matter still conducts with matter');
  assert.equal(C.ctConducts(metal, gas, 1), true);
  // In a block: hot metal beside air keeps its heat with ambient heat off.
  const cells = Array.from({ length: 8 }, () => cell(E.EMPTY, 20)); cells[0] = metal;
  const run = ambientHeat => {
    const out = C.contactReference(cells.map(c => C.packContact(c).core), new Int32Array(8), 1, C.CONTACT_POSITIONS, new Uint32Array(8), Array(8).fill(true), undefined, { ambient: 20, ambientHeat, edge: EDGE.SOLID });
    return out.cores.map((c, i) => C.unpackContact(c, out.banks[i]));
  };
  assert.equal(run(0)[0].tq, metal.tq, 'metal trades no heat with air'); assert(run(0).slice(1).every(c => c.tq === q(20)), 'air held at ambient');
  assert(run(1)[0].tq < metal.tq, 'with ambient heat on it does');
});

test('row 6: evaporating cloud cools its air by CLOUD_EVAP_COOL; saturation reads the scene ambient', () => {
  const cloud = cell(E.CLOUD, 20);
  // V1 react.js: four air faces of six (CLOUD_EVAP_NB stay): its three partners and one outside (the support pass's word)
  const outAir = C.contactOutsideWord([C.packContact(cell(E.EMPTY, 20)).core, null, null]);
  let evaporated = null;
  for (let seed = 0; seed < 200000 && !evaporated; seed++) { const out = C.ctStepAtmosphere(cloud, air(), seed, 0, 0, 0, 0, 0, q(20), 0, 0, outAir); if (out.id === E.EMPTY) evaporated = out; }
  assert(evaporated, 'edge cloud evaporates');
  assert.equal(evaporated.tq, cloud.tq - Math.round(PHYS.CLOUD_EVAP_COOL * 4), 'V1: T -= CLOUD_EVAP_COOL'); ledger(cloud, evaporated);
  // Magnus e_s(T)/e_s(airT): at the scene's own ambient the rate is the base rate, colder ambient makes 20 °C mist go faster.
  const rate = ambientQ => { let n = 0; for (let seed = 0; seed < 400000; seed++) if (C.ctStepAtmosphere(cloud, air(), seed, 0, 0, 0, 0, 0, ambientQ, 0, 0, outAir).id === E.EMPTY) n++; return n; };
  const warm = rate(q(20)), cold = rate(q(-10));
  const v1 = Math.exp(PHYS.MAGNUS_A * (20 / (20 + PHYS.MAGNUS_B) - -10 / (-10 + PHYS.MAGNUS_B)));
  assert(Math.abs(cold / warm - v1) / v1 < 0.15, `cold-scene speedup ${cold / warm} vs V1 ${v1}`);
});

test('row 7: steam condensing on the box floor becomes water, in open air cloud (V1 surface rule)', () => {
  // Steam that has banked its whole latent heat: exactly on the cold transition.
  let steam = cell(E.STEAM, 100);
  steam = C.ctSetEnergy(steam, energy(steam) - BigInt(Math.round(PHYS.L_BOIL * 256)) * 65536n);
  assert.equal(C.ctStep(steam, air(), 0).id, E.CLOUD, 'open air: cloud');
  assert.equal(C.ctStepAtmosphere(steam, air(), 0, 0, 0, 0, 0, 1, q(20)).id, E.WATER, 'on the floor: water');
  // V1 react.js: a non-gas face of any of its six inside the grid (a lid, a wall, a cold pipe) is a surface:
  // one outside its block (the support pass's word) too; past the grid's edge is none
  for (const id of [E.METAL, E.WATER, E.SAND, E.GLASS]) {
    const lid = C.contactOutsideWord([null, C.packContact(cell(id, 20)).core, null]);
    assert.equal(C.ctStepAtmosphere(steam, air(), 0, 0, 0, 0, 0, 0, q(20), 0, 0, lid).id, E.WATER, `outside ${ELEMENTS[id].key}: water`);
  }
  for (const id of [E.EMPTY, E.STEAM, E.CO2]) {
    const gas = C.contactOutsideWord([C.packContact(cell(id, 20)).core, null, null]);
    assert.equal(C.ctStepAtmosphere(steam, air(), 0, 0, 0, 0, 0, 0, q(20), 0, 0, gas).id, E.CLOUD, `outside ${ELEMENTS[id].key}: cloud`);
  }
  assert.equal(C.contactOutsideWord([null, null, null]), 0, 'beyond the grid: no surface');
  // In blocks: positions on y = 0 with a solid edge count the floor; a void edge (open air past it) and y > 0 do not.
  const block = (y, edge) => {
    const cells = Array.from({ length: 8 }, () => cell(E.EMPTY, 20)); cells[0] = steam;
    const positions = C.CONTACT_POSITIONS.map(p => [p[0] + 4, p[1] + y, p[2] + 4]);
    const out = C.contactReference(cells.map(c => C.packContact(c).core), new Int32Array(8), 1, positions, new Uint32Array(8), Array(8).fill(true), undefined, { ambient: 20, ambientHeat: 1, edge });
    return out.cores[0][0] & 255;
  };
  assert.equal(block(0, EDGE.SOLID), E.WATER); assert.equal(block(1, EDGE.SOLID), E.CLOUD); assert.equal(block(0, EDGE.VOID), E.CLOUD);
});

test('conduction and the pull stop a latent bank exactly on its transition (no unrepresentable steam)', () => {
  let steam = cell(E.STEAM, 100);
  steam = C.ctSetEnergy(steam, energy(steam) - BigInt(Math.round(PHYS.L_BOIL * 256)) * 65536n + 1000n);
  const metal = cell(E.METAL, -100), flux = C.ctFlux(steam, metal);
  assert(flux < 0 && C.ctHeatRoom(steam, flux) === -1000, 'only the 1000 units left before the transition');
  const cells = Array.from({ length: 8 }, () => cell(E.METAL, -100)); cells[0] = steam;
  const packed = cells.map(c => C.packContact(c)), before = cells.reduce((n, c) => n + energy(c), 0n);
  const out = C.contactReference(packed.map(m => m.core), packed.map(m => m.bank), 1);
  const after = out.cores.reduce((n, c, i) => n + C.materialEnergy(c, out.banks[i]), 0n);
  assert.equal(after + out.sinks.reduce((a, b) => a + b, 0n) - out.sources.reduce((a, b) => a + b, 0n), before);
  const pulled = C.ctAmbient(steam, q(20), 1);
  assert(C.ctPastPhase(pulled, false), 'the pull lands on the transition'); assert.equal(C.ctStep(pulled, air(), 0).id, E.CLOUD);
});

console.log(`${groups} V1 heat/phase parity groups passed (CPU only)`);
