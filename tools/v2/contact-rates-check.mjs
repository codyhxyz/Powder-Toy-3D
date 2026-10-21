// V1's per-step chances on V2's per-tick contact clock (src/v2/contact.js CONTACT_CONSTANTS), CPU only.
// V1 runs NOMINAL_STEP_RATE steps a second, V2 ticks at CONTACT_HZ: a tick is STEPS_PER_TICK of V1's
// steps. A rule V1 draws once a step compounds over the steps, never adds: 1 - (1 - p)^n. A rule a
// cell reads off one face meets that face as a block partner half the ticks, so a partnered tick
// carries two ticks' worth (PARTNER_STEPS); a cell's own rule over all six faces runs every tick.
// Each case picks a draw between the compounded chance and the old linear one, so it fails if reverted.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { PHYS, NOMINAL_STEP_RATE } from '../../src/physics.js';
import * as C from '../../src/v2/contact.js';

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

test('plant, moss, fungus: V1 react.js RATE·n a step per neighbour, compounded per partner as the flames', () => {
  for (const [key, rate] of [['CT_PLANT_MISS_LOG', PHYS.PLANT_GROW], ['CT_MOSS_MISS_LOG', PHYS.MOSS_GROW], ['CT_FUNGUS_MISS_LOG', PHYS.FUNGUS_GROW]])
    assert.equal(constant(key), Math.fround(PARTNER * Math.log(1 - rate)), key);
  const plant = cell(E.PLANT);
  boundary(1 - (1 - PHYS.PLANT_GROW) ** PARTNER, PHYS.PLANT_GROW * PARTNER, s => C.ctStep(cell(E.WATER), ns(plant), s).id === E.PLANT);
  // two plant partners: each its own face's chance (1 - (1 - p)^(2·PARTNER_STEPS)), never 2·8·p
  boundary(1 - (1 - PHYS.PLANT_GROW) ** (2 * PARTNER), 2 * PHYS.PLANT_GROW * PARTNER, s => C.ctStep(cell(E.WATER), ns(plant, plant), s).id === E.PLANT);
  const moss = cell(E.MOSS, 20); moss.ctype = 2; // damp
  const stone = cell(E.STONE);
  assert.ok(C.ctRow(E.STONE).bed, 'stone is a moss bed');
  boundary(1 - Math.exp(constant('CT_MOSS_MISS_LOG')), PHYS.MOSS_GROW * PARTNER, s => C.ctStep(air(), ns(moss, stone), s).id === E.MOSS);
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
  // V1: r < CLOUD_RAIN·max(nCloud - CLOUD_RAIN_NB, 0) a step, nCloud of six; V2 counts three partners
  // and doubles them (an unbiased estimate of six), so its tick is STEPS steps, not PARTNER_STEPS
  const c = cell(E.CLOUD, 20);
  const rain = PHYS.CLOUD_RAIN * (2 * 3 - PHYS.CLOUD_RAIN_NB);
  assert.ok(Math.abs(C.ctPerTick(rain) - (1 - (1 - rain) ** STEPS)) < 1e-15);
  boundary(1 - (1 - rain) ** STEPS, rain * PARTNER, s => C.ctStep(c, ns(c, c, c), s).id === E.WATER);
  // evaporation at the scene's ambient (saturation 1): three air partners
  const evap = PHYS.CLOUD_EVAP * (2 * 3 - PHYS.CLOUD_EVAP_NB);
  boundary(1 - (1 - evap) ** STEPS, evap * PARTNER, s => C.ctStep(cell(E.CLOUD, PHYS.AMBIENT), ns(air(), air(), air()), s).id === E.EMPTY);
});

console.log(`${checks} V1 per-step rate groups passed (CPU only)`);
