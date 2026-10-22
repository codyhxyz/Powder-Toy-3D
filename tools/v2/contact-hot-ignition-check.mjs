// CPU-only approved hot-front regression. Executes the production scalar kernel
// and contactReference; WGSL is checked through its real generator, not a port.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import * as C from '../../src/v2/contact.js';
import { PHASE_ROWS } from '../../src/v2/phase.js';
import { contactKernelWGSL } from '../../src/shaders/v2/contact-kernel.js';
import { contactWGSL, emitContactKernel } from '../../src/shaders/v2/contact.js';
import { gridLayout } from '../../src/sim.js';
import { v2BlockWGSL } from '../../src/shaders/v2.js';

const q = T => Math.round((T + 273.25) * 4);
const cell = (id, T = 20, fill = 65536) => C.ctNew(id, q(T), fill);
const flame = () => cell(E.FIRE, 1000);
const burning = (id = E.WOOD, tq = q(1000)) => ({ ...C.ctNew(id, tq, 65536), burning: 1 });
const neighbors = source => [source, cell(E.EMPTY), cell(E.WALL)];
const ledger = (before, after) => assert.equal(C.ctEnergy(after) + after.sink - after.source, C.ctEnergy(before), 'exact BigInt ledger');
const step = (input, ns, seed = 1, outside = [0, 0, 0, 0]) => {
  const saved = ns.map(C.ctCopy);
  const out = C.ctStepAtmosphere(input, ns, seed, ...outside, 0, q(20));
  assert.deepEqual(ns, saved, 'catalytic sources/neighbors are not mutated');
  ledger(input, out);
  return out;
};
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
// Exact old cold-source output, captured before the addition (cab5525f).
const oldWoodHit = input => ({ ...input, tq: 1326, raw: 1326, bank: 786420,
  life: 2033, burning: 1, request: 2, busy: 1, source: 201326580n });

test('live hot FIRE and burning ordinary fuel activate room-temperature WOOD on fallback-miss seed 1', () => {
  assert(C.ctRoll(1, 1) > 1 / 60); assert(C.ctRoll(0, 1) < 1 / 60);
  for (const source of [flame(), burning(), burning(E.OIL)]) {
    const input = cell(E.WOOD), out = step(input, neighbors(source));
    assert.deepEqual(out, oldWoodHit(input), 'same existing burn body, no ignition temperature jump');
    assert.equal(input.life - out.life, 15); assert.equal(out.source, 201326580n);
  }
});

test('decoded source threshold -1/equal/+1; FIRE extinction floor and COAL 450 C threshold', () => {
  for (const [id, sourceAt, threshold] of [
    [E.WOOD, tq => burning(E.WOOD, tq), C.ctRow(E.WOOD).igniteQ],
    [E.COAL, tq => C.ctNew(E.FIRE, tq, 65536), C.ctRow(E.COAL).igniteQ],
    [E.WOOD, tq => C.ctNew(E.FIRE, tq, 65536), 2493],
  ]) for (const delta of [-1, 0, 1]) {
    const input = cell(id), out = step(input, neighbors(sourceAt(threshold + delta)));
    assert.equal(out.burning, +(delta >= 0), `${ELEMENTS[id].key} source threshold ${delta}`);
    assert.equal(out.life < input.life, delta >= 0);
  }
});

test('source exclusions isolate the new route, while hit/miss fallback outputs remain exact', () => {
  const excluded = [
    ['invalid', { ...flame(), valid: 0 }, false],
    ['done', { ...flame(), done: 1 }, true],
    ['pending', { ...flame(), pending: E.SMOKE }, true],
    ['DETONATE', { ...flame(), request: 1 }, true],
    ['NEUTRON', { ...flame(), request: 4 }, true],
    ['dead FIRE', { ...flame(), life: 0 }, true],
    ['cold FIRE', cell(E.FIRE), true],
    ['extinguished FIRE', C.ctNew(E.FIRE, 2492, 65536), true],
    ['dead burning fuel', { ...burning(), life: 0 }, true],
    ['cold burning fuel', burning(E.WOOD, q(20)), true],
    ['pending burning fuel', { ...burning(), pending: E.ASH }, true],
    ['done burning fuel', { ...burning(), done: 1 }, true],
    ['DETONATE fuel', { ...burning(), request: 1 }, true],
    ['NEUTRON fuel', { ...burning(), request: 4 }, true],
    ['inert hot solid', cell(E.STONE, 1000), false],
    ['unburning hot fuel', cell(E.WOOD, 1000), false],
    ['electrical only', { ...cell(E.METAL, 1000), spark: 3608 }, false],
    ['BATTERY', cell(E.BATTERY, 1000), false],
    ['PLASMA', cell(E.PLASMA, 1000), false],
    ['FUSE', { ...cell(E.FUSE, 1000), burning: 1 }, false],
  ];
  for (const [name, source, countedFire] of excluded) for (const seed of [1, 0]) {
    const input = cell(E.WOOD), out = step(input, neighbors(source), seed);
    const expected = countedFire && seed === 0 ? oldWoodHit(input) : { ...input, busy: +countedFire };
    assert.deepEqual(out, expected, `${name}, legacy seed ${seed}`);
  }
  assert.equal(step(cell(E.WOOD), neighbors({ ...flame(), request: 2 })).burning, 1, 'GAS request is not excluded');
});

test('six-face oxygen gates and actual CO2 fraction apply to deterministic activation', () => {
  // V1 react.js counts a flame as burning air to the fuel beside it, so the
  // closed case's hot source is a burning fuel (no air, oxygen or flame face).
  const input = cell(E.WOOD), closed = [burning(), cell(E.WALL), cell(E.WALL)];
  const blocked = step(input, closed);
  assert.equal(step(input, [flame(), cell(E.WALL), cell(E.WALL)]).burning, 1, 'a flame face is burning air (V1 react.js)');
  assert.equal(blocked.burning, 0); assert.equal(blocked.life, input.life); assert.equal(blocked.source, 0n); assert.equal(blocked.request, 0);
  assert.equal(step(input, neighbors(burning())).burning, 1, 'owned air');
  assert.equal(step(input, closed, 1, [1, 0, 0, 1]).burning, 1, 'outside-only air');
  assert.equal(step(input, closed, 1, [0, 1, 0, 1]).burning, 1, 'outside-only O2');
  const noLocalSource = step(input, [cell(E.WALL), cell(E.WALL), cell(E.WALL)], 1, [0, 3, 0, 3]);
  assert.equal(noLocalSource.burning, 0); assert.equal(noLocalSource.source, 0n, 'outside atmosphere counters cannot stand in for a hot source');
  assert.equal(step(input, neighbors({ ...flame(), ctype: E.OXYGEN })).burning, 1, 'owned FIRE-O2');
  // 30% itself is not representable with six integral faces. Nearest tested
  // realizable fractions straddle it, including frozen outside-only CO2.
  for (const [ns, outside, lights] of [
    [[flame(), cell(E.EMPTY), cell(E.CO2)], [1, 0, 0, 1], true], // 1/4
    [[flame(), cell(E.EMPTY), cell(E.CO2)], [0, 0, 0, 0], false], // 1/3
    [neighbors(flame()), [1, 0, 1, 2], true], // 1/4
    [neighbors(flame()), [0, 0, 1, 1], false], // 1/3
  ]) {
    const out = step(input, ns, 1, outside);
    assert.equal(out.burning, +lights); assert.equal(out.life < input.life, lights);
    if (!lights) { assert.equal(out.source, 0n); assert.equal(out.request, 0); }
  }
});

test('WHISKEY low-flash prerequisite preserves old certainty and below-flash stochastic behavior', () => {
  const flash = C.ctRow(E.WHISKEY).flashQ;
  for (const delta of [-1, 0, 1]) for (const seed of [1, 0]) for (const source of [flame(), cell(E.FIRE)]) {
    const input = C.ctNew(E.WHISKEY, flash + delta, 65536), out = step(input, neighbors(source), seed);
    const lights = delta >= 0 || seed === 0;
    const expected = lights ? { ...input, tq: input.tq + 22, raw: input.raw + 22, life: 1982,
      bank: 3604436, burning: 1, request: 2, busy: 1, source: 87228372n } : { ...input, busy: 1 };
    assert.deepEqual(out, expected, 'equality already ignited even beside cold FIRE before this change');
  }
});

test('water/saltwater/raw meat/inert recipients, pending phases and latent decoding retain semantics', () => {
  for (const id of [E.WATER, E.SALTWATER, E.MEAT, E.STONE]) {
    const input = cell(id), out = step(input, neighbors(flame()));
    assert.deepEqual(out, input, ELEMENTS[id].key);
  }
  const pending = { ...cell(E.WOOD), pending: E.ASH };
  assert.deepEqual(step(pending, neighbors(flame())), pending, 'pending conversion returns before ignition');
  const done = { ...cell(E.WOOD), done: 1 };
  assert.deepEqual(step(done, neighbors(flame())), done);
  const rawMeat = cell(E.MEAT), mr = PHASE_ROWS[E.MEAT];
  const cooked = C.ctSetEnergy(rawMeat, BigInt(C.ctCapacity(rawMeat)) * BigInt(mr.hotQ) + C.ctOffset(rawMeat) + BigInt(mr.hotLatent) * 65536n);
  const out = step(cooked, neighbors(flame()));
  assert.equal(out.id, E.COOKED_MEAT); assert.equal(out.burning, 0, 'phase conversion still returns first');
  const whiskey = burning(E.WHISKEY), wr = PHASE_ROWS[E.WHISKEY];
  const latent = C.ctSetEnergy(whiskey, BigInt(C.ctCapacity(whiskey)) * BigInt(wr.hotQ) + C.ctOffset(whiskey) + BigInt(wr.hotLatent) * 32768n);
  const packed = C.packContact(latent), decoded = C.unpackContact(packed.core, packed.bank);
  assert(decoded.raw > 41093); assert.equal(decoded.tq, wr.hotQ); assert(decoded.tq < C.ctRow(E.WOOD).igniteQ);
  assert.equal(step(cell(E.WOOD), neighbors(decoded)).burning, 0, 'large raw tag/bank is not hot source temperature');
  assert.equal(step(cell(E.WOOD), [flame(), cell(E.WATER), cell(E.EMPTY)]).burning, 1, 'one water neighbor is not a wood moisture field');
});

test('finite existing fuel, zero fuel, exact ledgers, unchanged sources and opaque/liquid payloads', () => {
  for (const life of [0, 1, 15, 16]) {
    const input = { ...cell(E.WOOD), life }, out = step(input, neighbors(flame()));
    // Fuel heat is finite; burnt out, V1 react.js lifts the residue to
    // BURNT_MIN_T (600 °C), a declared source on top of it.
    if (out.id === E.WOOD) assert(out.source <= BigInt(life) * 13421772n);
    else { assert(out.tq >= q(600), 'burnt-out residue at least BURNT_MIN_T'); assert(out.id === E.FIRE || out.id === E.ASH); }
    if (life > 15) assert.equal(out.life, life - 15);
  }
  let fuel = cell(E.WOOD), released = 0n, calls = 0;
  while (fuel.id === E.WOOD && calls < 200) {
    const out = step({ ...fuel, source: 0n, sink: 0n }, neighbors(flame()));
    if (out.id === E.WOOD) released += out.source; fuel = out; calls++;
  }
  assert.equal(calls, 137); assert.notEqual(fuel.id, E.WOOD); assert(released <= 2048n * 13421772n);
  for (const id of [E.WOOD, E.OIL, E.WHISKEY]) {
    const input = cell(id, id === E.WHISKEY ? 26 : 20), material = C.packContact(input);
    material.core[2] = 0xaabbccdd; material.core[3] = (material.core[3] | 0xbabe) >>> 0;
    if (id === E.WOOD) material.core[1] = (material.core[1] | 0xa8000000) >>> 0;
    const decoded = C.unpackContact(material.core, material.bank), out = step(decoded, neighbors(flame()));
    const packed = C.packContact(out, material.core), back = C.unpackContact(packed.core, packed.bank);
    assert.equal(packed.core[2], material.core[2], 'opaque word2 / liquid payload');
    assert.equal(packed.core[3] & 65535, material.core[3] & 65535, 'reserved / foam bits');
    if (id === E.WOOD) assert.equal(packed.core[1] & 0xfe000000, material.core[1] & 0xfe000000, 'reserved bits');
    else assert.equal(back.fill, decoded.fill, 'liquid amount unchanged');
    assert.equal(back.life, decoded.life - C.ctRow(id).burn);
    assert.equal(back.burning, 1); assert.equal(C.materialEnergy(packed.core, packed.bank) + out.sink - out.source, C.ctEnergy(decoded));
  }
});

const seedAt = (p, tick) => (Math.imul(p[0], 73856093) ^ Math.imul(p[1], 19349663) ^ Math.imul(p[2], 83492791) ^ Math.imul(tick, 2654435761)) | 0;
const block = (cells, tick = 1, positions = C.CONTACT_POSITIONS, valid = Array(8).fill(true)) => {
  const packed = cells.map(c => C.packContact(c)), before = cells.reduce((sum, c) => sum + C.ctEnergy(c), 0n);
  const out = C.contactReference(packed.map(m => m.core), packed.map(m => m.bank), tick, positions, new Uint32Array(8), valid, Array.from({ length: 8 }, () => [1, 0, 0, 1]));
  const decoded = out.cores.map((core, i) => C.unpackContact(core, out.banks[i]));
  assert.equal(decoded.reduce((sum, c) => sum + C.ctEnergy(c), 0n) + out.sinks.reduce((a, b) => a + b, 0n) - out.sources.reduce((a, b) => a + b, 0n), before);
  return { out, decoded };
};

test('actual post-pair single-contact witness ignites below bulk threshold; source has only its existing own step', () => {
  const wood = cell(E.WOOD), fire = flame(), flux = C.ctFlux(wood, fire);
  const postWood = C.ctHeat(wood, flux), postFire = C.ctHeat(fire, -flux);
  assert.equal(postWood.tq / 4 - 273.25, 220.5); assert.equal(postFire.tq / 4 - 273.25, 799.25);
  assert(postWood.tq < C.ctRow(E.WOOD).igniteQ); assert(postFire.tq >= C.ctRow(E.WOOD).igniteQ);
  const cells = Array.from({ length: 8 }, () => cell(E.WALL)); cells[0] = wood; cells[1] = fire;
  const positions = C.CONTACT_POSITIONS.map(p => p.map(v => v + 6));
  assert(C.ctRoll(seedAt(positions[0], 1), 1) > 1 / 60, 'actual position/tick fallback misses');
  const { out, decoded } = block(cells, 1, positions, [true, true, false, false, false, false, false, false]);
  assert.equal(decoded[0].burning, 1); assert.equal(decoded[0].life, wood.life - 15); assert.equal(out.sources[0], 201326580n);
  const invalid = { ...cell(E.WALL), valid: 0 };
  // The block ends with V1's per-gas pull toward ambient (FIRE's rad): ctAmbient.
  const expectedSource = C.ctAmbient(step(postFire, [postWood, invalid, invalid], seedAt(positions[1], 1), [1, 0, 0, 1]), q(20), 1);
  const sourcePacked = C.packContact(expectedSource, C.packContact(fire).core);
  assert.deepEqual(out.cores[1], sourcePacked.core); assert.equal(out.banks[1], sourcePacked.bank);
  assert.equal(out.sources[1], 0n, 'no catalytic debit/refund');
});

test('original static corner cube, production corner/pair order: 714–895 C sources survive conduction', () => {
  // The original bay's WOOD x=2..5,y=0..3,z=2..5; FIRE x=1,y=0..1,z=2.
  // This bounded contact opportunity is not the moving six-bay GPU outcome.
  const positions = Array.from({ length: 8 }, (_, i) => [1 + (i & 1), i >> 2, 2 + ((i >> 1) & 1)]);
  const cells = positions.map(([x, , z]) => x === 2 ? cell(E.WOOD) : z === 2 ? flame() : cell(E.EMPTY));
  const postPair = cells.map(C.ctCopy);
  for (const [i, j] of C.CONTACT_PAIRS) {
    const flux = C.ctFlux(postPair[i], postPair[j]);
    postPair[i] = C.ctHeat(postPair[i], flux); postPair[j] = C.ctHeat(postPair[j], -flux);
    assert.equal(C.ctReaction(postPair[i], postPair[j], seedAt(positions[i], 1) ^ j).changed, 0);
  }
  assert.deepEqual([0, 1, 4, 5].map(i => postPair[i].tq / 4 - 273.25), [894.5, 146.75, 713.75, 184.75]);
  const { out, decoded } = block(cells, 1, positions);
  for (const i of [1, 5]) {
    assert(C.ctRoll(seedAt(positions[i], 1), 1) > 1 / 60, 'original fallback misses');
    assert(postPair[i].tq < C.ctRow(E.WOOD).igniteQ, 'bulk threshold not reached');
    assert.equal(decoded[i].burning, 1); assert.equal(decoded[i].life, 2033); assert.equal(out.sources[i], 201326580n);
  }
  // V1 react.js flame life: FIRE_BURN + FIRE_BURN_SPREAD·rnd a step (per tick here).
  const burn = C.CONTACT_CONSTANTS.CT_FIRE_BURN_TICK[1], spread = C.CONTACT_CONSTANTS.CT_FIRE_BURN_SPREAD_TICK[1];
  for (const i of [0, 4]) { assert(decoded[i].life <= 2048 - Math.floor(burn) && decoded[i].life >= 2048 - Math.ceil(burn + spread)); assert.equal(out.sources[i], 0n); }
  for (const i of [3, 7]) assert.equal(decoded[i].burning, 0, 'no front cascade to next wood face on this call');
});

test('post-pair frozen snapshot prevents intra-call cascade in either self iteration direction', () => {
  for (const [source, middle, distal] of [[0, 1, 3], [3, 1, 0]]) {
    const cells = Array.from({ length: 8 }, () => cell(E.WALL));
    cells[source] = flame(); cells[middle] = cell(E.WOOD); cells[distal] = cell(E.WOOD);
    const valid = cells.map((_, i) => [source, middle, distal].includes(i));
    const { decoded } = block(cells, 1, C.CONTACT_POSITIONS, valid);
    assert.equal(decoded[middle].burning, 1); assert.equal(decoded[distal].burning, 0);
    assert.equal(decoded[distal].life, cells[distal].life, 'new middle flame cannot cascade through the self loop');
  }
  const dying = { ...flame(), life: 1 };
  assert.equal(step(cell(E.WOOD), neighbors(dying)).burning, 1, 'snapshot source may expire in its own subsequent self step');
  assert.equal(step(dying, [cell(E.EMPTY), cell(E.WALL), cell(E.WALL)]).id, E.SMOKE);
});

test('shuffled disjoint production contact blocks replay identically with global position/tick seeds', () => {
  function replay(order) {
    const states = Array.from({ length: 12 }, (_, b) => {
      const cells = Array.from({ length: 8 }, () => cell(E.WOOD));
      cells[b % 8] = flame(); cells[(b + 3) % 8] = cell(E.WATER);
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

test('real generator and snapshot/order/custom-contact contracts are unchanged', () => {
  assert.equal(contactKernelWGSL, C.CONTACT_KERNEL.map(([fn, args, result]) => emitContactKernel(fn, args, result)).join('\n'));
  // (flames into air are ctLick, called with the step's own seed)
  const scalar = C.ctStepAtmosphere.toString() + C.ctLick.toString();
  assert(C.ctStepAtmosphere.toString().includes('ctLick(c, hotFuel, flameQ, smothered, seed)'), 'the step lights air with its own seed');
  // (2 was the spark cost's draw: electricity is the electric pass's now, its own salts CT_ELEC_SALT + step)
  assert.deepEqual([...scalar.matchAll(/ctRoll\(seed, (\d+)\)/g)].map(m => +m[1]), [1, 3, 4, 5, 6, 7, 18, 19], 'no extra RNG calls or changed salts (5–7, 18–19: V1 flame life and flames into air)');
  assert(scalar.includes('random < ctF(fire) / 60'), 'original stochastic expression remains intact');
  const body = contactWGSL.slice(contactWGSL.indexOf('fn contactBlock('));
  assert(body.indexOf('let snapshot=cells;') > body.indexOf('flux=ctFlux('));
  assert(body.includes('array<CTCell,3>(snapshot[i^1u],snapshot[i^2u],snapshot[i^4u])'));
  assert(!body.includes('loadCore('), 'no new live outside material reads');
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
console.log(`${checks} hot-contact CPU groups passed; no GPU/runtime acceptance claimed`);
