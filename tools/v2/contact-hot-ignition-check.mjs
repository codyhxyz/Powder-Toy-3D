// CPU-only ignition regression. V2 lights a fuel as V1 does (react.js combustion, explosives): at its ignition
// point, or past its flash point with a flame (a FIRE cell, nFire) on one of its six faces, re-tested every step.
// And fire lights fuel by touch (design decision, 2026-10-22, delegated by the user: The Powder Toy, Minecraft):
// a burning front on a block partner (ctHotFront) lights it outright, a flame or burning fuel on one with
// CT_TOUCH_LIGHT a tick, and the fuel lit so takes the flame's heat to its ignition point (a declared source), so
// the thermal rule holds it alight and cooling still puts it out. Explosives keep V1's flame roll. Executes the
// production scalar kernel and contactReference; WGSL is checked through its real generator, not a port.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { PHYS, NOMINAL_STEP_RATE } from '../../src/physics.js';
import * as C from '../../src/v2/contact.js';
import { contactKernelWGSL } from '../../src/shaders/v2/contact-kernel.js';
import { contactWGSL, emitContactKernel } from '../../src/shaders/v2/contact.js';
import { gridLayout } from '../../src/sim.js';
import { v2BlockWGSL } from '../../src/shaders/v2.js';

const STEPS = NOMINAL_STEP_RATE / C.CONTACT_HZ;
const q = T => Math.round((T + 273.25) * 4);
const cell = (id, T = 20, fill = 65536) => C.ctNew(id, q(T), fill);
const flame = () => cell(E.FIRE, 1000);
const burning = (id = E.WOOD, tq = q(1000)) => ({ ...C.ctNew(id, tq, 65536), burning: 1 });
const neighbors = source => [source, cell(E.EMPTY), cell(E.WALL)];
const ledger = (before, after) => assert.equal(C.ctEnergy(after) + after.sink - after.source, C.ctEnergy(before), 'exact BigInt ledger');
const word = (...cores) => C.contactOutsideWord(cores);
const step = (input, ns, seed = 1, outside = [0, 0, 0, 0], faces = 0, touch = 0) => {
  const saved = ns.map(C.ctCopy);
  const out = C.ctStepAtmosphere(input, ns, seed, ...outside, 0, q(20), touch, 0, faces);
  assert.deepEqual(ns, saved, 'neighbors are not mutated');
  ledger(input, out);
  return out;
};
const SEEDS = 4000;
const T = C.CONTACT_CONSTANTS;
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

test('a burning front lights cold fuel outright: a hot flame, burning fuel or burning oil on a partner', () => {
  for (const id of [E.WOOD, E.COAL, E.PLANT, E.SAWDUST, E.OIL, E.MOSS])
    for (const source of [flame(), cell(E.FIRE, 3000), burning(), burning(E.OIL)])
      for (const seed of [0, 1, 2, 3]) {
        const input = cell(id), out = step(input, neighbors(source), seed);
        assert.equal(out.burning, 1, `${ELEMENTS[id].key} beside ${ELEMENTS[source.id].key}, seed ${seed}`);
        // the pilot: the flame's heat to its ignition point, then a tick's burn; both a declared source
        assert(out.tq >= C.ctRow(id).igniteQ, `${ELEMENTS[id].key} at its ignition point`);
        assert(out.life < input.life); assert(out.source > 0n);
      }
  // a front no hotter than the fuel's ignition point, a cold or dying flame, and inert hot matter are none
  for (const [name, source] of [['a 300 °C flame', cell(E.FIRE, 300)], ['a dead flame', { ...flame(), life: 0 }],
    ['smouldering wood under coal\'s point', burning(E.WOOD, q(400))], ['hot stone', cell(E.STONE, 1000)]]) {
    const out = step(cell(E.COAL), neighbors(source), 1);
    if (source.id !== E.STONE) assert.equal(C.ctHotFront(source, C.ctRow(E.COAL).igniteQ), false, name);
    assert.equal(out.burning, 0, `${name} (seed 1 misses the touch chance)`);
  }
  // no air, oxygen or flame face: nothing to burn in
  assert.equal(step(cell(E.WOOD), [burning(), cell(E.WALL), cell(E.WALL)]).burning, 0, 'closed in');
  // a flying burning packet on a partner (ctPacketTouch: its fire on the axis and its front)
  const touch = C.ctPacketTouch(burning(), E.WOOD, 0, 2, 1);
  assert.equal(touch & 7, T.CT_TOUCH_FIRE[1] * 2, 'its fire, on the y axis');
  assert.notEqual(touch & T.CT_TOUCH_FRONT[1], 0, 'its front');
  assert.equal(C.ctPacketTouch(burning(), E.WOOD, 0, 2, 0) & (7 | T.CT_TOUCH_FRONT[1]), 0, 'not on a partner: none');
  assert.equal(step(cell(E.WOOD), neighbors(cell(E.EMPTY)), 1, [0, 0, 0, 0], 0, touch).burning, 1, 'a flying front lights it');
});

test('a flame or burning fuel on a partner lights fuel with CT_TOUCH_LIGHT a tick each (TPT, Minecraft)', () => {
  // a 300 °C flame is no front (ctHotFront: 350 °C), so its touch is the chance alone
  const rate = (ns, outside, touch = 0) => {
    let lit = 0;
    for (let seed = 0; seed < SEEDS; seed++) lit += step(cell(E.WOOD), ns, seed, outside, 0, touch).burning;
    return lit / SEEDS;
  };
  const chance = T.CT_TOUCH_LIGHT[1];
  for (const n of [1, 2]) {
    const ns = [...Array(n).fill(cell(E.FIRE, 300)), cell(E.EMPTY), cell(E.EMPTY)].slice(0, 3);
    const r = rate(ns, [0, 0, 0, 0]);
    assert(Math.abs(r - n * chance) < 0.008, `${n} flame partners: ${r} vs ${n * chance}`);
  }
  // a flying flame's fire mark on one axis counts once; on two, twice
  const one = rate(neighbors(cell(E.EMPTY)), [0, 0, 0, 0], T.CT_TOUCH_FIRE[1]);
  const two = rate(neighbors(cell(E.EMPTY)), [0, 0, 0, 0], T.CT_TOUCH_FIRE[1] * 5);
  assert(Math.abs(one - chance) < 0.008 && Math.abs(two - 2 * chance) < 0.008, `flying: ${one}, ${two}`);
  // a flame outside its block lights it only on the ticks it is a partner (half of them): the outside word is
  // nFire's, for V1's flash-point rule, not a touch
  for (let seed = 0; seed < SEEDS; seed++)
    assert.equal(step(cell(E.WOOD), [cell(E.EMPTY), cell(E.WALL), cell(E.WALL)], seed, [1, 0, 0, 1], word(C.packContact(cell(E.FIRE, 300)).core, null, null)).burning, 0);
});

test('thermal ignition at its own ignition point -1/equal/+1, exposed', () => {
  for (const id of [E.WOOD, E.COAL, E.PLANT, E.OIL]) for (const delta of [-1, 0, 1]) {
    const input = C.ctNew(id, C.ctRow(id).igniteQ + delta, 65536), out = step(input, neighbors(cell(E.EMPTY)));
    assert.equal(out.burning, +(delta >= 0), `${ELEMENTS[id].key} ${delta}`);
    assert.equal(out.life < input.life, delta >= 0);
  }
});

test('flash point: a flame face (partner, outside or flying) lights it; a burning fuel face only by touch', () => {
  const flash = C.ctRow(E.WHISKEY).flashQ;
  assert(flash < C.ctRow(E.WHISKEY).igniteQ);
  for (const delta of [-1, 0, 1]) {
    const input = C.ctNew(E.WHISKEY, flash + delta, 65536), lights = +(delta >= 0);
    assert.equal(step(input, neighbors(flame())).burning, lights, 'flame partner');
    assert.equal(step(input, neighbors(cell(E.EMPTY)), 1, [1, 0, 0, 1], word(C.packContact(flame()).core, null, null)).burning, lights, 'flame outside its block');
    assert.equal(step(input, neighbors(cell(E.EMPTY)), 1, [0, 0, 0, 0], 0, C.CONTACT_CONSTANTS.CT_TOUCH_FLAME[1]).burning, lights, 'flame flying beside it');
    // burning wood is no flame (nFire) to the flash point's rule: past its flash point it is a burning front,
    // under it a touch at CT_TOUCH_LIGHT (seed 1 misses it)
    assert.equal(step(input, neighbors(burning())).burning, lights, 'burning wood: a front past its flash point');
  }
});

test('re-tested every tick: cooled under its ignition point, smothered or without air it goes out', () => {
  const lit = burning(E.WOOD, q(400));
  assert.equal(step(lit, neighbors(cell(E.EMPTY))).burning, 1);
  for (const T of [299, 250, 20]) {
    const cooled = burning(E.WOOD, q(T)), out = step(cooled, neighbors(cell(E.EMPTY)));
    assert.equal(out.burning, 0, `wood at ${T} °C`); assert.equal(out.life, cooled.life); assert.equal(out.source, 0n); assert.equal(out.request, 0);
  }
  // water, ice and liquid nitrogen faces cool it; it's out once under its ignition point (before: lit for good)
  const closed = step(lit, [cell(E.WALL), cell(E.WALL), cell(E.WALL)]);
  assert.equal(closed.burning, 0); assert.equal(closed.life, lit.life);
  // six-face oxygen gates: outside air or oxygen alone expose it; 30% CO2 of its gas smothers it
  assert.equal(step(lit, [cell(E.WALL), cell(E.WALL), cell(E.WALL)], 1, [1, 0, 0, 1]).burning, 1, 'outside-only air');
  assert.equal(step(lit, [cell(E.WALL), cell(E.WALL), cell(E.WALL)], 1, [0, 1, 0, 1]).burning, 1, 'outside-only O2');
  assert.equal(step(lit, [flame(), cell(E.WALL), cell(E.WALL)]).burning, 1, 'a flame face is burning air (V1 react.js)');
  for (const [ns, outside, lights] of [
    [[cell(E.EMPTY), cell(E.EMPTY), cell(E.CO2)], [1, 0, 0, 1], true], // 1/4
    [[cell(E.EMPTY), cell(E.EMPTY), cell(E.CO2)], [0, 0, 0, 0], false], // 1/3
  ]) assert.equal(step(lit, ns, 1, outside).burning, +lights);
});

test('explosives: a burning fuel is no flame (BL-13); a flame face rolls blast.flame a step, the tick\'s steps', () => {
  // propane (blast.air) below its 470 °C beside smouldering wood: V1 never sets it off
  for (let seed = 0; seed < SEEDS; seed++) {
    const out = step(cell(E.PROPANE, 400), [burning(E.WOOD, q(450)), cell(E.EMPTY), cell(E.EMPTY)], seed);
    assert.equal(out.id, E.PROPANE); assert.equal(out.request & 1, 0);
  }
  // gunpowder with a flame face: the tick's chance is 1 - (1 - blast.flame)^STEPS, however many flame faces
  const chance = 1 - (1 - ELEMENTS[E.GUNPOWDER].blast.flame) ** STEPS;
  for (const flames of [1, 3]) {
    let off = 0;
    for (let seed = 0; seed < SEEDS; seed++) off += step(cell(E.GUNPOWDER), [...Array(flames).fill(flame()), cell(E.EMPTY), cell(E.EMPTY)].slice(0, 3), seed).request & 1;
    assert(Math.abs(off / SEEDS - chance) < 0.03, `${flames} flame faces: ${off / SEEDS} vs V1 ${chance}`);
  }
});

test('finite fuel, burnt-out residue, the burning puff, exact ledgers', () => {
  let fuel = burning(E.WOOD, q(500)), calls = 0, released = 0n;
  while (fuel.id === E.WOOD && calls < 400) {
    const out = step({ ...fuel, source: 0n, sink: 0n }, neighbors(cell(E.EMPTY)));
    // V1 react.js: Pr += BURN_P a step, the tick's on the GAS request
    if (out.id === E.WOOD) { assert.equal(Math.floor(out.request / C.CONTACT_PUFF_UNIT), C.CONTACT_CONSTANTS.CT_BURN_PUFF_PA[1]); released += out.source; }
    else { assert(out.tq >= q(PHYS.BURNT_MIN_T)); assert(out.id === E.FIRE || out.id === E.ASH); assert.equal(Math.floor(out.request / C.CONTACT_PUFF_UNIT), C.CONTACT_CONSTANTS.CT_BURN_PUFF_PA[1]); }
    fuel = out; calls++;
  }
  assert.notEqual(fuel.id, E.WOOD); assert(released <= 2048n * 13421772n);
});

const seedAt = (p, tick) => (Math.imul(p[0], 73856093) ^ Math.imul(p[1], 19349663) ^ Math.imul(p[2], 83492791) ^ Math.imul(tick, 2654435761)) | 0;
const block = (cells, tick = 1, positions = C.CONTACT_POSITIONS, valid = Array(8).fill(true)) => {
  const packed = cells.map(c => C.packContact(c)), before = cells.reduce((sum, c) => sum + C.ctEnergy(c), 0n);
  const out = C.contactReference(packed.map(m => m.core), packed.map(m => m.bank), tick, positions, new Uint32Array(8), valid, Array.from({ length: 8 }, () => [1, 0, 0, 1]));
  const decoded = out.cores.map((core, i) => C.unpackContact(core, out.banks[i]));
  assert.equal(decoded.reduce((sum, c) => sum + C.ctEnergy(c), 0n) + out.sinks.reduce((a, b) => a + b, 0n) - out.sources.reduce((a, b) => a + b, 0n), before);
  return { out, decoded };
};

// The behaviour (design decision, 2026-10-22, delegated by the user): a flame lights the wood it touches, as
// fire spreads to wood in The Powder Toy and Minecraft, and the wood burns on after the flame is gone.
test('a block: a flame lights the cold wood beside it, which burns on after the flame is gone', () => {
  let cells = Array.from({ length: 8 }, () => cell(E.WALL)); cells[0] = cell(E.WOOD); cells[1] = flame();
  const positions = C.CONTACT_POSITIONS.map(p => p.map(v => v + 6)), valid = [true, true, false, false, false, false, false, false];
  let litAt = null;
  for (let tick = 1; tick <= 60; tick++) {
    const { decoded } = block(cells, tick, positions, valid);
    cells = decoded.map(c => ({ ...c, source: 0n, sink: 0n, busy: 0, request: 0 }));
    if (litAt === null && decoded[0].burning) litAt = tick;
    if (litAt !== null) assert.equal(decoded[0].burning, 1, `tick ${tick}: still burning`);
  }
  assert.equal(litAt, 1, 'lit on its first tick (the flame is a burning front)');
  assert.notEqual(cells[1].id, E.FIRE, 'the flame is gone');
  assert(cells[0].id === E.WOOD && cells[0].tq > C.ctRow(E.WOOD).igniteQ, 'the wood burns on, past its ignition point');
});

// V1 react.js lit tests an explosive's temperature the step it is (one step's conduction before it): a charge at
// its ignition point beside cold matter goes off on its first step. The block's pairs trade a partnered tick's
// heat first (CT_COND_FLUX), which took a 400 °C C-4 corner of a cold block to 211 °C and 250 °C nitroglycerin on
// a metal floor to 213-221 °C, under their points, so neither went off (tools/v2/blast-damage-browser-check.mjs
// block, walls NITRO). A charge it would light trades none (ctLitHot): it goes off this tick, and so does a
// cold charge touching it at that heat (hotTouch: V1 reads the neighbour as the step came in).
test('a charge at its ignition point goes off before a tick\'s conduction can cool it (V1: the first step)', () => {
  const nitroFloor = i => (i & 2) ? cell(E.NITRO, 250) : cell(E.METAL);
  for (const [what, make, hot] of [
    ['a 400 °C corner of a cold C-4 block', i => cell(E.C4, i === 0 ? 400 : 20), [0, 1, 2, 4]],
    ['250 °C nitroglycerin on a metal floor', nitroFloor, [2, 3, 6, 7]],
    ['300 °C TNT on a metal floor', i => (i & 2) ? cell(E.TNT, 300) : cell(E.METAL), [2, 3, 6, 7]],
    ['a 250 °C gunpowder grain in a cold pile', i => cell(E.GUNPOWDER, i === 0 ? 250 : 20), [0, 1, 2, 4]],
  ]) {
    const { out } = block(Array.from({ length: 8 }, (_, i) => make(i)));
    for (let i = 0; i < 8; i++) assert.equal(out.requests[i] & 1, +hot.includes(i), `${what}: cell ${i}`);
  }
  // a charge under its point still warms and cools as before
  const { decoded } = block(Array.from({ length: 8 }, (_, i) => cell(E.C4, i === 0 ? 250 : 20)));
  assert(decoded[0].tq < q(250) && decoded[1].tq > q(20), 'a C-4 cell under its ignition point trades heat');
  // propane (blast.air) is lit by its exposure, so it trades as any gas
  assert.equal(C.ctLitHot(cell(E.PROPANE, 500), cell(E.EMPTY)), false);
});

test('shuffled disjoint production contact blocks replay identically with global position/tick seeds', () => {
  function replay(order) {
    const states = Array.from({ length: 12 }, (_, b) => {
      const cells = Array.from({ length: 8 }, () => cell(E.WOOD));
      cells[b % 8] = burning(E.WOOD, q(600)); cells[(b + 3) % 8] = cell(E.WATER);
      return cells;
    });
    for (let tick = 1; tick <= 12; tick++) for (const b of order) {
      const positions = C.CONTACT_POSITIONS.map(p => [p[0] + 2 * b, p[1] + 6, p[2] + 6]);
      states[b] = block(states[b], tick, positions).decoded;
    }
    return states;
  }
  assert.deepEqual(replay([7, 2, 9, 0, 11, 4, 1, 8, 5, 10, 3, 6]), replay(Array.from({ length: 12 }, (_, i) => i)));
});

test('real generator and snapshot/order/custom-contact contracts', () => {
  assert.equal(contactKernelWGSL, C.CONTACT_KERNEL.map(([fn, args, result]) => emitContactKernel(fn, args, result)).join('\n'));
  // (flames into air are ctLick, called with the step's own seed)
  const scalar = C.ctStepAtmosphere.toString() + C.ctLick.toString();
  assert(C.ctStepAtmosphere.toString().includes('ctLick(c, hotFuel, flameQ, smothered, seed)'), 'the step lights air with its own seed');
  assert.deepEqual([...scalar.matchAll(/ctRoll\(seed, (\d+)\)/g)].map(m => +m[1]), [1, 3, 4, 5, 6, 7, 18, 19], 'salts (5–7, 18–19: V1 flame life and flames into air)');
  // touch ignition is in the emitted kernel and the flying packets' marks carry the face's axis
  assert(/fn ctHotFront\(/.test(contactKernelWGSL) && contactKernelWGSL.includes('CT_TOUCH_LIGHT'), 'the touch rules are emitted');
  const body = contactWGSL.slice(contactWGSL.indexOf('fn contactBlock('));
  assert(body.indexOf('let snapshot=cells;') > body.indexOf('flux=ctFlux('));
  assert(body.includes('ns[axis]=snapshot[j];'), 'partners in axis order (x y z), as the outside word');
  assert(!body.includes('loadCore('), 'no live outside material reads');
  const g = gridLayout(16, 16, 16), original = v2BlockWGSL(g, contactWGSL), compact = v2BlockWGSL(g, contactWGSL, true);
  assert.equal(compact.slice(compact.indexOf('  // R2 topple')), original.slice(original.indexOf('  // R2 topple')), 'updated compact/noncompact heavy body exact');
  for (const custom of ['', contactWGSL + '\n', 'fn contactBlock() {}']) assert.equal(v2BlockWGSL(g, custom, true), v2BlockWGSL(g, custom));
  for (const id of [E.EMPTY, E.WATER]) {
    const cells = Array.from({ length: 8 }, () => cell(id)), packed = cells.map(c => C.packContact(c));
    const { out } = block(cells);
    assert.deepEqual(out.cores, packed.map(m => m.core)); assert.deepEqual(out.banks, packed.map(m => m.bank));
    assert.deepEqual([...out.requests], Array(8).fill(0)); assert.deepEqual(out.busy, []);
    assert(out.sources.every(n => n === 0n)); assert(out.sinks.every(n => n === 0n));
  }
});
console.log(`${checks} ignition CPU groups passed; no GPU/runtime acceptance claimed`);
