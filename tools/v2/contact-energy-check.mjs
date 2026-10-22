// CPU only: V2's contact energy against V1 react.js (WS-A: TH-01, TH-02, RX-1a/b/c, RX-6, RX-8,
// EL-9). V1's numbers come from its own rules: the conduction step (react.js condFlux) run on V1's
// clock, rxT = heat/(CAP(oa)+CAP(ob)) on each cell's own T, acid and the singularity leaving the
// victim at its own T (or airT), the void draining to airT. Each group fails if its fix is
// reverted. No browser, device or GPU.
import assert from 'node:assert/strict';
import { E, ELEMENTS, REACTIONS } from '../../src/elements.js';
import { PHYS, NOMINAL_STEP_RATE } from '../../src/physics.js';
import * as C from '../../src/v2/contact.js';
import { offsetOf } from '../../src/v2/physics.js';

const q = T => Math.round((T + 273.25) * 4);
const celsius = c => c.tq / 4 - 273.25;
const cell = (id, T = 20, fill = 65536) => C.ctNew(id, q(T), fill);
const energy = c => C.ctEnergy(c);
const ledger = (cells, before, label) => assert.equal(cells.reduce((n, c) => n + energy(c) + c.sink - c.source, 0n), before, label);
const STEPS_PER_TICK = NOMINAL_STEP_RATE / C.CONTACT_HZ;
const swallow = (a, b, seed, ambientQ) => C.ctSwallow(a, b, seed, ambientQ);
// well-mixed pair seeds, as the block pass's position/tick hash gives (an arithmetic run of seeds correlates ctRoll's salts)
const seedOf = s => (C.ctRoll(s, 77) * 2147483647) | 0;
const failures = [];
let groups = 0;
function test(name, fn) {
  try { fn(); groups++; console.log(`ok ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}\n  ${e.message.split('\n')[0]}`); }
}

// V1 react.js condFlux on a 1-D bar, every face every step, NOMINAL_STEP_RATE steps a second.
function v1Bar(id, cells, seconds, hotT, coldT) {
  const cap = ELEMENTS[id].cap, k = ELEMENTS[id].cond;
  let t = Array(cells).fill(coldT); t[0] = hotT;
  for (let s = 0; s < seconds * NOMINAL_STEP_RATE; s++) {
    const n = t.slice();
    for (let i = 0; i < cells; i++) for (const j of [i - 1, i + 1]) if (j >= 0 && j < cells) {
      const dT = t[j] - t[i], lim = Math.abs(dT) * cap * PHYS.COND_FLUX_SHARE;
      n[i] += Math.max(-lim, Math.min(lim, k * dT)) / cap;
    }
    t = n;
  }
  return t;
}
// The same bar on V2's block pass: (2i, 2i+1) or (2i+1, 2i+2) pairs by the tick's offset (physics.js offsetOf).
function v2Bar(id, cells, seconds, hotT, coldT) {
  let c = Array.from({ length: cells }, (_, i) => cell(id, i ? coldT : hotT));
  const before = c.reduce((n, x) => n + energy(x), 0n);
  for (let tick = 1; tick <= seconds * C.CONTACT_HZ; tick++) {
    for (let i = offsetOf(tick)[0]; i + 1 < cells; i += 2) {
      let f = C.ctFlux(c[i], c[i + 1]); f = -C.ctHeatRoom(c[i + 1], -C.ctHeatRoom(c[i], f));
      c[i] = C.ctHeat(c[i], f); c[i + 1] = C.ctHeat(c[i + 1], -f);
    }
  }
  assert.equal(c.reduce((n, x) => n + energy(x), 0n), before, 'conduction conserves exactly');
  return c.map(celsius);
}

test('TH-01: metal conducts as metal, not wood: a heated bar spreads at V1 react.js rates', () => {
  // A bar with one end at 400 °C: the far cells' warming after 1 s and 4 s, against V1's per-step rule.
  for (const key of ['METAL', 'GOLD', 'TUNGSTEN', 'STONE', 'WOOD', 'SAND']) {
    const id = E[key];
    for (const seconds of [1, 4]) {
      const v1 = v1Bar(id, 24, seconds, 400, 20), v2 = v2Bar(id, 24, seconds, 400, 20);
      for (const at of [4, 8]) {
        const rise1 = v1[at] - 20, rise2 = v2[at] - 20;
        // the block pass's pairs reach their equilibrium at most, so the fastest conductors spread
        // somewhat slower than V1's six-face step; never the old one-share cap's wood-like rate
        assert(rise2 > 0.6 * rise1 && rise2 < 1.4 * rise1 + 1, `${key} cell ${at} after ${seconds} s: V2 +${rise2.toFixed(1)} °C, V1 +${rise1.toFixed(1)}`);
      }
    }
  }
  // Metal beats wood clearly, as in V1 (the old cap gave every conductor wood's rate).
  const metal = v2Bar(E.METAL, 24, 1, 400, 20)[8], wood = v2Bar(E.WOOD, 24, 1, 400, 20)[8];
  assert(metal - 20 > 3 * (wood - 20), `metal +${(metal - 20).toFixed(1)} °C vs wood +${(wood - 20).toFixed(1)} at cell 8`);
});

test('TH-01: a face carries V1 react.js min(cond)·ΔT for PARTNER_STEPS steps, never past the pair\'s equilibrium', () => {
  // min(cond), not the harmonic mean: metal with air is air's conductance (V1: COND(a) vs COND(b) min).
  const metal = cell(E.METAL, 120), air = cell(E.EMPTY, 20);
  const want = Math.min(ELEMENTS[E.METAL].cond, ELEMENTS[E.EMPTY].cond) * (metal.tq - air.tq) * 2 * STEPS_PER_TICK * C.CT_ENERGY_PER_CAP_C / 4;
  assert(Math.abs(-C.ctFlux(metal, air) - want) <= 1 + want * 1e-6, `metal/air flux ${-C.ctFlux(metal, air)} vs ${want}`);
  // Ice in water: V1's rate (the old 1/6 cap made it about 3x slower).
  const water = cell(E.WATER, 20), ice = cell(E.ICE, -20);
  const v1 = Math.min(ELEMENTS[E.WATER].cond, ELEMENTS[E.ICE].cond) * 40 * 2 * STEPS_PER_TICK;
  assert(Math.abs(C.ctFlux(ice, water) / C.CT_ENERGY_PER_CAP_C - v1) / v1 < 0.01, `ice/water ${C.ctFlux(ice, water) / C.CT_ENERGY_PER_CAP_C} cap·°C, V1 ${v1}`);
  // Every pair stops at its equilibrium at most: neither cell crosses the other.
  for (const [a, b] of [[E.METAL, E.METAL], [E.GOLD, E.SCRAP], [E.HYDROGEN, E.METAL], [E.FIRE, E.METAL], [E.PLASMA, E.TUNGSTEN]]) {
    const hot = cell(a, 300), cold = cell(b, 100), f = C.ctFlux(hot, cold);
    const h = C.ctHeat(hot, f), c = C.ctHeat(cold, -f);
    assert(h.tq >= c.tq && h.tq <= hot.tq && c.tq >= cold.tq, `${ELEMENTS[a].key}/${ELEMENTS[b].key}: ${celsius(h)} / ${celsius(c)}`);
  }
});

// A part-filled liquid exactly at its phase edge (ctHeatRoom stops a latent bank there).
function atEdge(id, fill, hot) {
  const r = C.ctRow(id), c0 = C.ctNew(id, hot ? r.hotQ : r.coldQ, fill), amount = BigInt(C.ctAmount(c0));
  const base = BigInt(C.ctCapacity(c0)) * BigInt(hot ? r.hotQ : r.coldQ) + C.ctOffset(c0);
  return C.ctSetEnergy(c0, hot ? base + BigInt(r.hotL) * amount : base - BigInt(r.coldL) * amount);
}
test('TH-02: a part-filled liquid freezes, boils or bakes into whole cells by its fill, at its own temperature', () => {
  for (const [id, hot, into, T] of [[E.WATER, false, E.ICE, 0], [E.WATER, true, E.STEAM, 100], [E.MUD, true, E.CLAY, 100]]) {
    for (const fill of [49152, 16384, 8192]) {
      const c = atEdge(id, fill, hot), n = 4000;
      let made = 0;
      for (let s = 0; s < n; s++) {
        const out = C.ctPhase({ ...c, source: 0n, sink: 0n }, 1, (s + 0.5) / n);
        assert.equal(out.pending, -1, 'no wait on a partner');
        assert(out.id === into || out.id === E.EMPTY, `${ELEMENTS[id].key} -> ${ELEMENTS[out.id].key}`);
        // V1 keeps T through the change: no -273 °C ice, no superheated water borrowing a partner's heat
        assert.equal(celsius(out), T, `${ELEMENTS[id].key} fill ${fill / 65536}: ${ELEMENTS[out.id].key} at ${celsius(out)} °C`);
        ledger([out], energy(c));
        if (out.id === into) made++;
      }
      const share = fill / 65536, sd = Math.sqrt(share * (1 - share) / n);
      assert(Math.abs(made / n - share) < 4 * sd + 0.005, `${ELEMENTS[id].key} fill ${share}: ${made / n} whole cells a cell`);
    }
  }
  // A whole cell is unchanged: energy-exact, every time.
  const full = atEdge(E.WATER, 65536, false), ice = C.ctPhase(full, 1, 0.99);
  assert.equal(ice.id, E.ICE); assert.equal(energy(ice), energy(full)); assert.equal(celsius(ice), 0);
  // ...and partial lava sets into stone at its own temperature, not a cold whole stone.
  const lava = cell(E.LAVA, C.ctRow(E.STONE).meltQ / 4 - 273.25 - 151, 16384);
  for (let s = 0; s < 50; s++) { const out = C.ctPhase(lava, 1, (s + 0.5) / 50); assert.equal(out.tq, lava.tq, 'lava sets at its own T'); }
});

const react = (a, b, tries = 4000) => { for (let s = 0; s < tries; s++) { const p = C.ctReaction(a, b, seedOf(s)); if (p.changed) return p; } throw Error('no reaction'); };
const v1Rx = (i, pa, pb) => (REACTIONS[i].heat ?? 0) / (ELEMENTS[pa].cap + ELEMENTS[pb].cap);
const rowOf = (a, b) => REACTIONS.findIndex(r => r.a === a && r.b === b);
test('RX-1a: reactions keep each cell\'s own T plus V1 react.js rxT, no pooling and no hydrogen ceiling', () => {
  // Hydrogen burning in air from 600 °C: V1 ~2834 °C (the old ceiling held 1057 °C).
  let i = rowOf('HYDROGEN', 'EMPTY'), p = react(cell(E.HYDROGEN, 600), cell(E.EMPTY, 600));
  for (const c of [p.a, p.b]) assert(Math.abs(celsius(c) - (600 + v1Rx(i, p.a.id, p.b.id))) < 30, `H2+air ${ELEMENTS[c.id].key} ${celsius(c)} °C`);
  ledger([p.a, p.b], energy(cell(E.HYDROGEN, 600)) + energy(cell(E.EMPTY, 600)));
  // With oxygen: V1 ~3380 °C.
  i = rowOf('HYDROGEN', 'OXYGEN'); p = react(cell(E.HYDROGEN, 600), cell(E.OXYGEN, 600));
  assert(Math.abs(celsius(p.a) - (600 + v1Rx(i, p.a.id, p.b.id))) < 30, `H2+O2 ${celsius(p.a)} °C`);
  // A flame lighting cold hydrogen: each product keeps its own cell's T plus the heat.
  i = rowOf('HYDROGEN', 'FIRE'); p = react(cell(E.HYDROGEN, 20), cell(E.FIRE, 1500));
  assert(Math.abs(celsius(p.a) - (20 + v1Rx(i, p.a.id, p.b.id))) < 30 && Math.abs(celsius(p.b) - (1500 + v1Rx(i, p.a.id, p.b.id))) < 30, `H2+FIRE ${celsius(p.a)} / ${celsius(p.b)} °C`);
  // Salting water cools it a few degrees (V1 15–17 °C), never freezes it.
  for (let s = 0; s < 400; s++) {
    const r = C.ctReaction(cell(E.SALT, 20), cell(E.WATER, 20), seedOf(s));
    if (r.changed) for (const c of [r.a, r.b]) assert(celsius(c) > 10 && celsius(c) < 20, `salt+water ${ELEMENTS[c.id].key} ${celsius(c)} °C`);
  }
  // Clay soaking water: mud at room temperature (old: 777 °C); levitatium with slime: fire at 20 °C (old: -273 °C).
  p = react(cell(E.CLAY, 20), cell(E.WATER, 20));
  assert.equal(p.a.id, E.MUD); assert.equal(celsius(p.a), 20); assert.equal(celsius(p.b), 20);
  p = react(cell(E.LEVITATIUM, 20), cell(E.SLIME, 20));
  assert.equal(celsius(p.a), 20); assert.equal(celsius(p.b), 20);
  // Toxic purified by water keeps its own heat: V1 80 °C and 20 °C, not 23/23.
  p = react(cell(E.TOXIC, 80), cell(E.WATER, 20));
  assert.equal(celsius(p.a), 80); assert.equal(celsius(p.b), 20);
  assert(C.CONTACT_REACTIONS.every(r => r.ceiling === C.CONTACT_CONSTANTS.CT_Q_MAX[1]), 'no reaction ceiling below the codes\' top');
});

test('RX-1b: acid eats quietly: the victim and spent acid become smoke or air at their own T', () => {
  for (const id of [E.METAL, E.STONE, E.SAND, E.WOOD]) {
    for (let s = 0; s < 300; s++) {
      const acid = cell(E.ACID, 20); acid.life = 30;
      const victim = cell(id, 20), p = C.ctAcid(acid, victim, seedOf(s));
      if (!p.changed) continue;
      for (const c of [p.a, p.b]) assert.equal(celsius(c), 20, `acid on ${ELEMENTS[id].key}: ${ELEMENTS[c.id].key} at ${celsius(c)} °C`);
      ledger([p.a, p.b], energy(acid) + energy(victim));
    }
  }
});

test('RX-1c: a feeding singularity keeps its own temperature; what it eats leaves air at the scene\'s ambient', () => {
  let s = cell(E.SINGULARITY, 20); s.life = 2560;
  for (let i = 1; i <= 40; i++) {
    const sand = cell(E.SAND, 20), p = swallow(s, sand, i * 31, q(-15));
    assert.equal(p.changed, 1); ledger([p.a, p.b], energy(s) + energy(sand));
    assert.equal(p.b.id, E.EMPTY); assert.equal(celsius(p.b), -15, 'V1 react.js: T = airT()');
    s = { ...p.a, done: 0, busy: 0, source: 0n, sink: 0n };
  }
  assert.equal(celsius(s), 20, `after 40 cells of sand: ${celsius(s)} °C (V1 20; old 2969)`);
  assert(s.life > 2560 + 39 * 256, 'it still gains their mass');
});

test('RX-8: a film reacts for its share of a whole cell: mud, plant and singularity mass by fill', () => {
  // Clay with a film of water: mud in proportion to the water (V1: one water cell soaks one clay cell).
  let mud = 0, clay = 0, n = 0;
  for (let s = 0; s < 20000 && n < 3000; s++) {
    const p = C.ctReaction(cell(E.CLAY, 20), cell(E.WATER, 20, 8192), seedOf(s));
    if (!p.changed) continue; n++;
    if (p.a.id === E.MUD) mud++; else { assert.equal(p.a.id, E.CLAY, 'clay that takes no part stays clay'); clay++; }
    assert.equal(p.b.id, E.EMPTY, 'the film is taken up');
  }
  assert(Math.abs(mud / n - 1 / 8) < 0.03, `mud per film ${mud / n} (1/8 of a cell's)`);
  // Salt with a film of water: brine of the film's fill, the salt used at the film's share.
  let used = 0, m = 0;
  for (let s = 0; s < 40000 && m < 3000; s++) {
    const p = C.ctReaction(cell(E.SALT, 20), cell(E.WATER, 20, 8192), seedOf(s));
    if (!p.changed) continue; m++;
    assert.equal(p.b.id, E.SALTWATER); assert.equal(p.b.fill, 8192, 'brine keeps the film\'s fill');
    if (p.a.id !== E.SALT) used++;
  }
  const saltUsed = C.CONTACT_PRODUCTS[C.CONTACT_REACTIONS[0].aOut].limit;
  assert(used / m < saltUsed / 8 + 0.01, `salt used per film ${used / m}, V1 per cell ${saltUsed}`);
  // A singularity gains a film's share of the mass a cell of water gives.
  const sing = cell(E.SINGULARITY, 20); sing.life = 2560;
  const full = swallow(sing, cell(E.WATER, 20), 1, q(20)).a.life - 2560, film = swallow(sing, cell(E.WATER, 20, 8192), 1, q(20)).a.life - 2560;
  assert(Math.abs(film - full / 8) <= 1, `film mass ${film} vs a cell's ${full}`);
  // Water growing into plant (ctGrow): a whole plant with the film's chance, else taken up.
  let plant = 0;
  for (let s = 0; s < 4000; s++) { const out = C.ctGrow(cell(E.WATER, 20, 16384), E.PLANT, (s + 0.5) / 4000); if (out.id === E.PLANT) plant++; else assert.equal(out.id, E.EMPTY); }
  assert(Math.abs(plant / 4000 - 0.25) < 0.01, `plant per quarter film ${plant / 4000}`);
});

test('EL-9: Joule heat warms a film as V1 warms its whole cell, not 8x', () => {
  const word = C.CONTACT_CONSTANTS.CT_ELEC_PENDING[1] + C.CONTACT_CONSTANTS.CT_ELEC_SPENT_UNIT[1] * ELEC_SPARK_V();
  const rise = fill => { const w = cell(E.WATER, 20, fill), out = C.ctElecApply(w, word, 1); ledger([out], energy(w)); return celsius(out) - 20 + C.ctTemperatureRemainder(out) / 4; };
  const full = rise(65536), film = rise(8192);
  assert(Math.abs(film - full) < 0.15 * full, `full spark spent: full cell +${full.toFixed(2)} °C, 1/8 film +${film.toFixed(2)} °C`);
});
function ELEC_SPARK_V() { return C.CONTACT_CONSTANTS.CT_SPARK_V[1]; }

test('RX-6: the void drains a cell to air at the scene\'s ambient, not at the cell\'s heat', () => {
  for (const ambient of [20, -15]) {
    const lava = cell(E.LAVA, 1200), ns = [cell(E.VOID), cell(E.EMPTY), cell(E.EMPTY)];
    const out = C.ctStepAtmosphere(lava, ns, 7, 0, 0, 0, 0, 0, q(ambient), 0, 0);
    assert.equal(out.id, E.EMPTY); assert.equal(celsius(out), ambient, `lava into void leaves air at ${celsius(out)} °C`);
    ledger([out], energy(lava));
  }
});

console.log(`${groups} V2 contact energy groups passed against V1 react.js (CPU only)`);
if (failures.length) { console.log(`FAILED: ${failures.join('; ')}`); process.exit(1); }
