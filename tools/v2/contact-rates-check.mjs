// V1's per-step chances on V2's per-tick contact clock (src/v2/contact.js CONTACT_CONSTANTS), CPU only.
// V1 runs NOMINAL_STEP_RATE steps a second, V2 ticks at CONTACT_HZ: a tick is STEPS_PER_TICK of V1's
// steps. A rule V1 draws once a step compounds over the steps, never adds: 1 - (1 - p)^n. A rule a
// cell reads off one face meets that face as a block partner half the ticks, so a partnered tick
// carries two ticks' worth (PARTNER_STEPS); a cell's own rule over all six faces runs every tick.
// Each case picks a draw between the compounded chance and the old linear one, so it fails if reverted.
import assert from 'node:assert/strict';
import { E, ELEMENTS, REACTIONS } from '../../src/elements.js';
import { PHYS, NOMINAL_STEP_RATE } from '../../src/physics.js';
import * as C from '../../src/v2/contact.js';
import { RX_PAIRINGS } from '../../src/shaders/react.js';
import { legacyPressureToPa } from '../../src/v2/pressure.js';

const STEPS = NOMINAL_STEP_RATE / C.CONTACT_HZ, PARTNER = 2 * STEPS;
const q = T => Math.round((T + 273.25) * 4);
const cell = (id, T = ELEMENTS[id].temp) => C.ctNew(id, q(T), 65536);
const air = () => cell(E.EMPTY);
const ns = (...cells) => [...cells, air(), air(), air()].slice(0, 3);
const constant = key => Math.fround(C.CONTACT_CONSTANTS[key][1]);
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
// a seed whose draw (salt 1: ctStepAtmosphere's `random`, salt 13: ctAcid's) lies in [lo, hi)
function seedIn(lo, hi, salt = 1) {
  for (let s = 1; s < 1 << 25; s++) { const r = C.ctRoll(s, salt); if (r >= lo && r < hi) return s; }
  throw Error(`no draw in [${lo}, ${hi})`);
}
// the outcome on a draw just under the chance, and on one between it and the old linear chance
function boundary(chance, linear, step, salt = 1) {
  assert.ok(chance < linear, `compounded ${chance} is under the linear ${linear}`);
  const fires = step(seedIn(Math.max(0, chance - 0.01 * chance), chance, salt));
  const misses = step(seedIn(chance, linear, salt));
  assert.ok(fires, 'fires on a draw under the compounded chance');
  assert.ok(!misses, 'misses on a draw past it (the linear conversion would fire)');
}

test('clone: V1 react.js CLONE_RATE a step, one draw however many clones; a clone face is a partner half the ticks', () => {
  // V1: the tick's chance is 1 - (1 - CLONE_RATE)^STEPS; over the two ticks a face takes to be a
  // partner once, 1 - (1 - CLONE_RATE)^PARTNER_STEPS, all of it on the partnered tick
  const chance = 1 - (1 - PHYS.CLONE_RATE) ** PARTNER;
  assert.equal(constant('CT_CLONE_CHANCE'), Math.fround(chance));
  assert.ok(Math.abs(chance - 0.3904) < 1e-4, `${chance}`);
  for (const id of [E.CLONE, E.PCLN]) {
    const clone = cell(id); clone.ctype = E.SAND;
    if (id === E.PCLN) clone.life = 10 * 2048; // on (contact.js ctLife: V1's SWITCH_ON)
    boundary(chance, PHYS.CLONE_RATE * PARTNER, s => C.ctStep(air(), ns(clone), s).id === E.SAND);
  }
});

test('clone: exact for any number of clone faces, V1\'s one draw a step however many touch it', () => {
  // V1 react.js: an empty cell beside n >= 1 clones (each with an element) misses a step's creation
  // with 1 - CLONE_RATE, so an 8-tick cycle (32 steps) with (1 - CLONE_RATE)^32 whatever n is.
  // V2 (physics.js offsetOf): a cycle visits each partner pattern, one face an axis, once; at each the cell
  // sees k clone partners and the support pass counts the n - k outside (v2SupportWGSL).
  const r = PHYS.CLONE_RATE, missLog = constant('CT_CLONE_MISS_LOG');
  assert.equal(missLog, Math.fround(PARTNER * Math.log(1 - r)));
  const clone = cell(E.CLONE); clone.ctype = E.SAND;
  const chanceOf = (k, out) => (out === 0 ? constant('CT_CLONE_CHANCE') : 1 - Math.exp(missLog * k / (k + out)));
  // the rule fires on a draw under its chance and misses past it, for each count
  for (const [k, out] of [[1, 0], [1, 1], [1, 2], [2, 1], [1, 3], [2, 4], [3, 3]]) {
    const chance = chanceOf(k, out), partners = [...Array(k).fill(clone), air(), air(), air()].slice(0, 3);
    const step = s => C.ctStepAtmosphere(air(), partners, s, 0, 0, 0, 0, 0, C.contactAmbientQ(20), 0, out).id === E.SAND;
    assert.ok(step(seedIn(chance * 0.98, chance)), `k ${k}, outside ${out}: fires under ${chance}`);
    assert.ok(!step(seedIn(chance, chance * 1.02 + 1e-4)), `k ${k}, outside ${out}: misses past it`);
  }
  // every placement of 1 to 6 clone faces: the cycle's miss is V1's 32 steps' (before: 2x for two on one axis)
  for (let faces = 1; faces < 64; faces++) {
    const n = [0, 1, 2, 3, 4, 5].filter(f => faces >> f & 1).length;
    let miss = 1;
    for (let o = 0; o < 8; o++) {
      // partner on axis a: face 2a + bit a of the pattern
      const k = [0, 1, 2].filter(a => faces >> (2 * a + (o >> a & 1)) & 1).length;
      if (k > 0) miss *= 1 - chanceOf(k, n - k);
    }
    assert.ok(Math.abs(miss - (1 - r) ** 32) < 2e-6, `clone faces ${faces.toString(2)}: a cycle misses with ${miss}, V1 ${(1 - r) ** 32}`);
  }
});

test('plant, fungus: V1 react.js RATE·n a step per neighbour, compounded per partner as the flames; moss on its six faces', () => {
  for (const [key, rate] of [['CT_PLANT_MISS_LOG', PHYS.PLANT_GROW], ['CT_FUNGUS_MISS_LOG', PHYS.FUNGUS_GROW]])
    assert.equal(constant(key), Math.fround(PARTNER * Math.log(1 - rate)), key);
  const plant = cell(E.PLANT);
  boundary(1 - (1 - PHYS.PLANT_GROW) ** PARTNER, PHYS.PLANT_GROW * PARTNER, s => C.ctStep(cell(E.WATER), ns(plant), s).id === E.PLANT);
  // two plant partners: each its own face's chance (1 - (1 - p)^(2·PARTNER_STEPS)), never 2·8·p
  boundary(1 - (1 - PHYS.PLANT_GROW) ** (2 * PARTNER), 2 * PHYS.PLANT_GROW * PARTNER, s => C.ctStep(cell(E.WATER), ns(plant, plant), s).id === E.PLANT);
  const moss = cell(E.MOSS, 20); moss.ctype = 2; // damp
  const stone = cell(E.STONE);
  assert.ok(C.ctRow(E.STONE).bed, 'stone is a moss bed');
  // V1 react.js: MOSS_GROW·nWetMoss a step on a mossSite, read on all six faces every step, so every tick's
  // STEPS steps (before: PARTNER_STEPS steps on the ticks both faces were partners, a quarter of them: half V1)
  assert.equal(constant('CT_MOSS_GROW'), Math.fround(PHYS.MOSS_GROW));
  const mossChance = 1 - (1 - PHYS.MOSS_GROW) ** STEPS;
  const grows = (partners, word) => s => C.ctStepAtmosphere(air(), partners, s, 0, 0, 0, 0, 0, C.contactAmbientQ(20), 0, 0, word).id === E.MOSS;
  boundary(mossChance, PHYS.MOSS_GROW * PARTNER, grows(ns(moss, stone), 0));
  // the moss outside its block (the support pass's word) and the bed a partner: the same site, the same chance
  const mossOut = C.contactOutsideWord([C.packContact(moss).core, null, null]), stoneOut = C.contactOutsideWord([null, C.packContact(stone).core, null]);
  boundary(mossChance, PHYS.MOSS_GROW * PARTNER, grows(ns(air(), stone), mossOut));
  boundary(mossChance, PHYS.MOSS_GROW * PARTNER, grows(ns(moss), stoneOut));
  // damp moss and its bed on one axis only is no site (react.js mossSite: different axes)
  const stoneX = C.contactOutsideWord([C.packContact(stone).core, null, null]);
  assert.ok(!grows(ns(moss), stoneX)(seedIn(0, mossChance * 0.5)), 'one axis holding both: no site');
  // two damp moss faces: MOSS_GROW·2 a step
  const twoChance = 1 - (1 - 2 * PHYS.MOSS_GROW) ** STEPS;
  assert.ok(grows(ns(moss, stone), mossOut)(seedIn(twoChance * 0.99, twoChance)) && !grows(ns(moss, stone), mossOut)(seedIn(twoChance, twoChance * 1.01)));
  const fungus = cell(E.FUNGUS, 20); fungus.ctype = 2;
  const wood = cell(E.WOOD, 20);
  assert.ok(C.ctRow(E.WOOD).rots, 'wood rots');
  boundary(1 - Math.exp(constant('CT_FUNGUS_MISS_LOG')), PHYS.FUNGUS_GROW * PARTNER, s => C.ctStep(wood, ns(fungus), s).id === E.FUNGUS);
});

test('acid: V1 react.js ACID_USE a step per acid neighbour, compounded per partner pair', () => {
  const chance = 1 - (1 - PHYS.ACID_USE) ** PARTNER;
  assert.equal(constant('CT_ACID_EAT'), Math.fround(chance));
  boundary(chance, PHYS.ACID_USE * PARTNER, s => C.ctAcid(cell(E.ACID), cell(E.STONE), s).changed !== 0, 13);
});

test('acid: V1 react.js spends ACID_USE of its life a step per victim, eaten or not', () => {
  // V1 (react.js ACIDIC): life -= ACID_USE · victims every step; at life <= 0 it is smoke or air.
  // One victim face: dead at the first step whose f32 countdown from its spawn life reaches 0.
  let life = Math.fround(ELEMENTS[E.ACID].life ?? 1), v1Steps = 0;
  while (life > 0) { life = Math.fround(life - Math.fround(PHYS.ACID_USE)); v1Steps++; }
  // V2: that face is a block partner every other tick (PARTNER_STEPS steps a time), and each time
  // it spends PARTNER_STEPS steps' worth, whether or not its draw dissolves the victim
  assert.equal(C.CONTACT_CONSTANTS.CT_ACID_SPENT[1], Math.round(PHYS.ACID_USE * PARTNER * 2048));
  const miss = seedIn(constant('CT_ACID_EAT'), 1, 13);
  let acid = cell(E.ACID), times = 0;
  const full = acid.life;
  while (acid.id === E.ACID && times < 1000) {
    const r = C.ctAcid(acid, cell(E.STONE), miss); times++;
    assert.equal(r.b.id, E.STONE, 'a missed draw leaves its victim');
    if (r.a.id === E.ACID) assert.equal(r.a.life, Math.max(0, full - times * C.CONTACT_CONSTANTS.CT_ACID_SPENT[1]), `partnered ${times}: life spent though nothing dissolved`);
    acid = r.a;
  }
  assert.ok(acid.id === E.EMPTY || acid.id === E.SMOKE, 'used up, smoke or air');
  // it runs out in the partnered tick that holds V1's last step (V2's ~9x longer life before)
  assert.equal(times, Math.ceil(v1Steps / PARTNER), `${times} partnered ticks for V1's ${v1Steps} steps`);
  // eating, it spends the same (and leaves smoke or air where the victim was)
  const hit = seedIn(0, constant('CT_ACID_EAT'), 13), r = C.ctAcid(cell(E.ACID), cell(E.STONE), hit);
  assert.equal(r.a.life, full - C.CONTACT_CONSTANTS.CT_ACID_SPENT[1]);
  assert.ok(r.b.id === E.EMPTY || r.b.id === E.SMOKE);
});

test('cloud: its own rule on its six faces every tick, STEPS_PER_TICK of V1 react.js steps, not a partner correction', () => {
  // V1: r < CLOUD_RAIN·max(nCloud - CLOUD_RAIN_NB, 0) a step, nCloud of six: its three partners and the
  // support pass's three outside faces (CT_OUT_CLOUD), so its tick is STEPS steps, not PARTNER_STEPS
  const c = cell(E.CLOUD, 20), word = (...ids) => C.contactOutsideWord(ids.slice(0, 3).map(id => (id === null ? null : C.packContact(cell(id)).core)));
  const step = (input, partners, out) => s => C.ctStepAtmosphere(input, partners, s, 0, 0, 0, 0, 0, C.contactAmbientQ(PHYS.AMBIENT), 0, 0, out);
  for (const outside of [1, 2, 3]) {
    const rain = PHYS.CLOUD_RAIN * (3 + outside - PHYS.CLOUD_RAIN_NB);
    assert.ok(Math.abs(C.ctPerTick(rain) - (1 - (1 - rain) ** STEPS)) < 1e-15);
    boundary(1 - (1 - rain) ** STEPS, rain * PARTNER, s => step(c, ns(c, c, c), word(...[E.CLOUD, E.CLOUD, E.CLOUD].slice(0, outside), null, null, null))(s).id === E.WATER);
  }
  // three cloud faces of six never rain (before: three partners counted as six)
  for (let s = 1; s < 20000; s++) assert.equal(C.ctStep(c, ns(c, c, c), s).id, E.CLOUD);
  // evaporation at the scene's ambient (saturation 1): three air partners and outside air
  const cloud = cell(E.CLOUD, PHYS.AMBIENT);
  for (const outside of [1, 2, 3]) {
    const evap = PHYS.CLOUD_EVAP * (3 + outside - PHYS.CLOUD_EVAP_NB);
    boundary(1 - (1 - evap) ** STEPS, evap * PARTNER, s => step(cloud, ns(air(), air(), air()), word(...[E.EMPTY, E.EMPTY, E.EMPTY].slice(0, outside), null, null, null))(s).id === E.EMPTY);
  }
  // an edge with three air faces of six holds (V1: CLOUD_EVAP_NB of them stay), outside cloud or not
  for (let s = 1; s < 20000; s++) assert.equal(C.ctStep(cloud, ns(air(), air(), air()), s).id, E.CLOUD);
});

test('reactions: V1 react.js min(1, chance·RX_PAIRINGS) a pairing, a pair partnered every RX_PAIRINGS steps', () => {
  assert.equal(C.V1_RX_PAIRINGS, RX_PAIRINGS, 'restated react.js RX_PAIRINGS');
  // V1: a touching pair is partners NOMINAL_STEP_RATE / RX_PAIRINGS times a second; V2: a face is a block
  // partner CONTACT_HZ / 2 ticks a second. A second's miss must be V1's for every row.
  const v1Pairings = NOMINAL_STEP_RATE / RX_PAIRINGS, v2Partnered = C.CONTACT_HZ / 2;
  const rows = REACTIONS.map((r, i) => ({ key: `${r.a}+${r.b}`, a: E[r.a], b: E[r.b] ?? E.EMPTY, v1: r.chance ?? 1, row: C.CONTACT_REACTIONS[i], minT: r.minT, maxT: r.maxT }));
  for (const r of rows) {
    const p = Math.min(1, r.v1 * RX_PAIRINGS), miss = (1 - r.row.chance) ** v2Partnered, v1Miss = (1 - p) ** v1Pairings;
    assert.ok(Math.abs(miss - v1Miss) < 1e-6 + 1e-4 * v1Miss, `${r.key}: a second's miss ${miss} vs V1 ${v1Miss}`);
  }
  // the fastest row V1 doesn't make certain reacts on a draw between the old 8-step compounding and V1's
  const partial = rows.filter(r => r.v1 * RX_PAIRINGS < 1 && E[REACTIONS.find(x => x.a === ELEMENTS[r.a].key)?.b] !== undefined && r.minT === undefined && r.maxT === undefined).sort((a, b) => b.v1 - a.v1)[0];
  const old = 1 - (1 - partial.v1) ** PARTNER;
  assert.ok(partial.row.chance > old, `${partial.key}: ${partial.row.chance} over the old ${old}`);
  const reacts = s => C.ctReaction(cell(partial.a), cell(partial.b), s).changed !== 0;
  assert.ok(reacts(seedIn(old, partial.row.chance, 10)), `${partial.key} reacts on a draw the old chance missed`);
  assert.ok(!reacts(seedIn(partial.row.chance, 1, 10)), `${partial.key} misses past V1's chance`);
});

test('singularity: V1 react.js evaporates SING_EVAP / max(m², SING_MASS_MIN) a step, on average exactly', () => {
  for (const mass of [100, 40, 15, 5]) {
    const sing = cell(E.SINGULARITY); sing.life = mass * 256;
    let lost = 0; const n = 20000;
    for (let s = 1; s <= n; s++) lost += sing.life - C.ctStep(sing, ns(), s).life;
    // V1, four steps of f32 mass: the tick's loss in 1/256 units
    let m = Math.fround(mass);
    for (let k = 0; k < STEPS; k++) m = Math.fround(m - Math.fround(PHYS.SING_EVAP / Math.max(m * m, PHYS.SING_MASS_MIN)));
    const v1 = (mass - m) * 256, mean = lost / n;
    assert.ok(Math.abs(mean - v1) < 0.02 + 0.01 * v1, `mass ${mass}: ${mean} a tick, V1 ${v1}`);
  }
});

test('storm charge: V1 react.js CHARGE_RATE·closing a step, snow falling onto the cloud', () => {
  const cold = cell(E.CLOUD, PHYS.CHARGE_T_MAX), up = 2 * C.CONTACT_CONSTANTS.CT_OUT_UP[1];
  for (const fall of [0.05, 0.2, 0.6]) {   // cells a tick
    const snow = cell(E.SNOW); snow.fallSpeed = fall;
    let gained = 0; const n = 20000;
    for (let s = 1; s <= n; s++) gained += C.ctStepAtmosphere(cold, ns(air(), snow), s, 0, 0, 0, 0, 0, C.contactAmbientQ(20), 0, 0, up).ctype;
    // V1: a step's chance CHARGE_RATE·closing (closing in cells a step), PARTNER steps a partnered tick
    const v1 = PARTNER * Math.min(1, PHYS.CHARGE_RATE * fall / STEPS);
    assert.ok(Math.abs(gained / n - v1) < 0.03 * v1 + 0.01, `fall ${fall}: ${gained / n} a partnered tick, V1 ${v1}`);
  }
  // too warm: none (CHARGE_T_MAX)
  const warm = cell(E.CLOUD, PHYS.CHARGE_T_MAX + 1), snow = cell(E.SNOW); snow.fallSpeed = 0.6;
  for (let s = 1; s < 200; s++) assert.equal(C.ctStepAtmosphere(warm, ns(air(), snow), s, 0, 0, 0, 0, 0, C.contactAmbientQ(20), 0, 0, up).ctype, 0);
  // at most CHARGE_MAX
  const full = { ...cold, ctype: PHYS.CHARGE_MAX };
  for (let s = 1; s < 200; s++) assert.equal(C.ctStepAtmosphere(full, ns(air(), snow), s, 0, 0, 0, 0, 0, C.contactAmbientQ(20), 0, 0, up).ctype, PHYS.CHARGE_MAX);
});

test('burning puff, explosive flame roll: V1 per-step pressure and draws over a tick', () => {
  // V1 react.js: Pr += BURN_P a step, as the GAS request's puff in Pa
  assert.equal(C.CONTACT_CONSTANTS.CT_BURN_PUFF_PA[1], Math.round(legacyPressureToPa(PHYS.BURN_P * STEPS)));
  // V1 react.js: a flame on any face sets an explosive off with blast.flame a step: the tick's STEPS draws
  for (const e of ELEMENTS.filter(e => e.blast?.flame)) assert.equal(C.ctRow(e.id).blastChance, 1 - (1 - e.blast.flame) ** STEPS, e.key);
});

console.log(`${checks} V1 per-step rate groups passed (CPU only)`);
