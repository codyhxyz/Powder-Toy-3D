// CPU-only caller identity proof. Canonical scalar rules remain unchanged.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import * as C from '../../src/v2/contact.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';

const count = ELEMENTS.length;
const match = contactWGSL.match(/const ctPairRuleBits = array<u32,(\d+)>\(([^)]*)\);/);
assert.ok(match, 'test reads the actual emitted bitset');
const bits = Uint32Array.from(match[2].split(',').map(word => Number(word.replace(/u$/, ''))));
assert.equal(bits.length, Number(match[1]));
assert.equal(bits.length, Math.ceil(count * count / 32));
assert.equal(C.CONTACT_ROWS.length, count);
function potential(a, b) {
  if (a < 0 || b < 0 || a >= count || b >= count) return false;
  const index = a * count + b;
  return (bits[index >>> 5] & (1 << (index & 31))) !== 0;
}
const pairGuard = 'cells[i].done==0 && cells[j].done==0 && ctPairPotential(cells[i].id,cells[j].id)';
const phaseGuard = 'cells[i].pending>=0 || cells[j].pending>=0';
const plumeGuard = 'cells[i].burning!=0 && cells[i].life!=0 && (cells[i].request&5)==0 && positions[j].y>positions[i].y && (cells[j].id==CT_EMPTY || cells[j].id==CT_OXYGEN)';
for (const guard of [pairGuard, phaseGuard, plumeGuard]) assert.ok(contactWGSL.includes(`if(${guard}){`), guard);
assert.match(contactWGSL, /if\(a<0 \|\| b<0 \|\| a>=\d+ \|\| b>=\d+\)\{return false;\}/);
assert.match(contactWGSL, /return \(ctPairRuleBits\[index>>5u\] & \(1u<<\(index&31u\)\)\)!=0u;/);
for (const id of [-2147483648, -1, count, 255, 2147483647]) {
  assert.equal(potential(id, E.WATER), false);
  assert.equal(potential(E.SINGULARITY, id), false);
}
const newCell = (id, T = 20) => C.ctNew(id, Math.round((T + 273.25) * 4), 65536);
function chain(a, b, seed) {
  let pair = C.ctReaction(a, b, seed);
  if (!pair.changed) pair = C.ctAcid(pair.a, pair.b, seed);
  if (!pair.changed) { const rev = C.ctAcid(pair.b, pair.a, seed); pair = C.ctPairValue(rev.b, rev.a, rev.changed); }
  if (!pair.changed) pair = C.ctSwallow(pair.a, pair.b, seed);
  if (!pair.changed) { const rev = C.ctSwallow(pair.b, pair.a, seed); pair = C.ctPairValue(rev.b, rev.a, rev.changed); }
  return pair;
}
let identityCases = 0, enabled = 0;
for (let a = 0; a < count; a++) for (let b = 0; b < count; b++) {
  const ra = C.ctRow(a), rb = C.ctRow(b);
  const expected = C.ctRxAt(a, b) !== 0 || (ra.acid !== 0 && rb.edible !== 0) ||
    (rb.acid !== 0 && ra.edible !== 0) ||
    (a === E.SINGULARITY && (rb.singFood !== 0 || b === E.SINGULARITY)) ||
    (b === E.SINGULARITY && (ra.singFood !== 0 || a === E.SINGULARITY));
  assert.equal(potential(a, b), expected, `${a}/${b}`);
  if (expected) enabled++;
  for (let variant = 0; variant < 4; variant++) {
    const ca = newCell(a), cb = newCell(b);
    for (const [c, side] of [[ca, 0], [cb, 1]]) {
      c.life = variant * 17000; c.bank = variant % 2 ? -2147483648 + side : 2147483647 - side;
      c.state = (0x12340000 + variant + side) | 0; c.spark = 3608;
      c.raw = c.tq = [0, 1173, 41093, 2700][variant];
      c.pending = variant - 2; c.request = variant; c.busy = variant & 1;
      c.source = BigInt(variant * 12345 + side); c.sink = BigInt(variant * 54321 + side);
      // Any completed endpoint makes every rule in this chain an identity.
      if (expected) c.done = side === (variant & 1) ? 1 : 0;
    }
    const before = structuredClone([ca, cb]);
    assert.deepEqual(chain(ca, cb, variant * 76543), { a: before[0], b: before[1], changed: 0 });
    assert.deepEqual([ca, cb], before, 'scalar inputs stay unchanged');
    identityCases++;
  }
}
// Every oriented reaction entry remains enabled, regardless of chance or temperature.
const rows = new Set();
for (let a = 0; a < count; a++) for (let b = 0; b < count; b++) {
  const code = C.ctRxAt(a, b);
  if (code !== 0) { assert.equal(potential(a, b), true); rows.add(Math.trunc((code - 1) / 2)); }
}
assert.equal(rows.size, C.CONTACT_REACTIONS.length);
assert.equal(potential(E.SINGULARITY, E.SINGULARITY), true);
const singularity = newCell(E.SINGULARITY); singularity.life = 256;
assert.equal(chain(singularity, singularity, 0).changed, 1, 'self-merge cannot be pruned');
const acid = newCell(E.ACID), food = ELEMENTS.find(e => e.id !== E.ACID && C.ctRow(e.id).edible !== 0);
assert.ok(food); assert.equal(potential(E.ACID, food.id), true);
const failedSeed = Array.from({ length: 100 }, (_, i) => i).find(seed => C.ctRoll(seed, 13) >= 0.24);
const failedAcid = C.ctAcid(acid, newCell(food.id), failedSeed);
assert.equal(failedAcid.changed, 0); assert.equal(failedAcid.a.busy, 1); assert.equal(failedAcid.b.busy, 1);

// Derive only the three caller guards from the production text. Keep the full
// canonical block protocol, including original-core packing, as the test model.
let guardedSource = C.contactReference.toString();
const translate = text => text.replace(/==/g, '===').replace(/!=/g, '!==')
  .replaceAll('CT_EMPTY', 'E.EMPTY').replaceAll('CT_OXYGEN', 'E.OXYGEN')
  .replace(/positions\[([ij])\]\.y/g, 'positions[$1][1]');
for (const [needle, guard] of [
  ['let pair = ctReaction(cells[i], cells[j], seedAt(i) ^ j);', pairGuard],
  ['let pair = ctResolvePhase(cells[i], cells[j]);', phaseGuard],
  ['const pair = ctPlume(cells[i], cells[j], seedAt(i) ^ j, up);', plumeGuard],
]) {
  assert.equal(guardedSource.split(needle).length, 2);
  guardedSource = guardedSource.replace(needle, `if (!(${translate(guard)})) continue;\n    ${needle}`);
}
const names = Object.keys(C);
const optimizedReference = Function(...names, 'E', 'ctPairPotential', `return (${guardedSource});`)(...names.map(name => C[name]), E, potential);
function compare(cores, banks, tick = 0, positions = C.CONTACT_POSITIONS, pending = new Uint32Array(8), valid = Array(8).fill(true), outside = Array.from({ length: 8 }, () => [0, 0, 0, 0])) {
  const args = [cores, banks, tick, positions, pending, valid, outside];
  const original = C.contactReference(...structuredClone(args));
  const optimized = optimizedReference(...structuredClone(args));
  assert.deepEqual(optimized, original, `full block tick ${tick}`);
  return optimized;
}
let blocks = 0;
const permutation = [7, 6, 5, 4, 3, 2, 1, 0];
let rng = 812731;
const random = n => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % n; };
for (let scenario = 0; scenario < 320; scenario++) {
  const cells = Array.from({ length: 8 }, (_, i) => {
    const id = scenario < count ? scenario : random(count), c = newCell(id, [0, 20, 100, 400, 1500][random(5)]);
    c.bank = [0, -1, 31, -1000][random(4)];
    if (scenario % 5 === 0 && C.ctRow(id).burn !== 0) c.burning = 1;
    if (scenario % 7 === 0 && C.ctRow(id).conductor !== 0) c.spark = 3608;
    return C.packContact(c, Uint32Array.of(id, 0, i * 12345, 0x12340000 + i));
  });
  let cores = cells.map(m => m.core), banks = cells.map(m => m.bank);
  const valid = Array.from({ length: 8 }, (_, i) => scenario % 9 !== 0 || i < 5);
  const outside = Array.from({ length: 8 }, () => Array.from({ length: 4 }, () => random(4)));
  let pending = Uint32Array.from({ length: 8 }, () => scenario % 13 === 0 ? random(8) : 0);
  for (let tick = 0; tick < 4; tick++) {
    const out = compare(cores, banks, tick + scenario * 17, C.CONTACT_POSITIONS, pending, valid, outside);
    compare(permutation.map(i => cores[i]), permutation.map(i => banks[i]), tick + scenario * 17,
      permutation.map(i => C.CONTACT_POSITIONS[i]), Uint32Array.from(permutation.map(i => pending[i])),
      permutation.map(i => valid[i]), permutation.map(i => outside[i]));
    cores = out.cores; banks = out.banks; pending = out.requests; blocks += 2;
  }
}
// Exercise every oriented reaction family in the complete monolithic block,
// including temperatures outside its window and pending source obligations.
for (let a = 0; a < count; a++) for (let b = 0; b < count; b++) {
  const code = C.ctRxAt(a, b); if (code === 0) continue;
  const row = C.ctRx(Math.trunc((code - 1) / 2));
  for (const tq of [Math.max(0, row.minQ - 1), row.minQ, Math.min(41093, row.maxQ + 1)]) {
    const cells = Array.from({ length: 8 }, () => newCell(E.EMPTY));
    cells[0] = C.ctNew(a, tq, 65536); cells[1] = C.ctNew(b, tq, 65536);
    const packed = cells.map(c => C.packContact(c));
    for (const seedTick of [0, 48, 311]) {
      compare(packed.map(m => m.core), packed.map(m => m.bank), seedTick);
      const pending = new Uint32Array(8); pending[0] = 5;
      compare(packed.map(m => m.core), packed.map(m => m.bank), seedTick, C.CONTACT_POSITIONS, pending);
      blocks += 2;
    }
  }
}
// Disjoint blocks retain exact results under list permutation and replay.
const patches = Array.from({ length: 12 }, (_, b) => {
  const packed = Array.from({ length: 8 }, (_, i) => C.packContact(newCell([E.WATER, E.METAL, E.WOOD][b % 3], 20 + i * 20)));
  return { cores: packed.map(m => m.core), banks: packed.map(m => m.bank),
    positions: C.CONTACT_POSITIONS.map(p => [p[0] + b * 2, p[1], p[2]]) };
});
const runPatches = order => {
  const world = structuredClone(patches);
  for (let tick = 0; tick < 8; tick++) for (const b of order) {
    const p = world[b], out = compare(p.cores, p.banks, tick, p.positions);
    p.cores = out.cores; p.banks = out.banks; blocks++;
  }
  return world;
};
assert.deepEqual(runPatches(patches.map((_, i) => i)), runPatches(patches.map((_, i) => i).reverse()));
// pending==0 is a valid EMPTY product, even with source.done already set.
const phaseA = newCell(E.EMPTY), phaseB = newCell(E.EMPTY); phaseA.pending = 0; phaseA.done = 1;
assert.equal(C.ctResolvePhase(phaseA, phaseB).changed, 1);
assert.ok(!(phaseA.pending < 0 && phaseB.pending < 0));
for (const [a, b] of [[newCell(E.WATER), newCell(E.METAL)], [phaseB, phaseB]])
  assert.deepEqual(C.ctResolvePhase(a, b), { a, b, changed: 0 });
const plumeSource = newCell(E.WOOD, 400); plumeSource.burning = 1;
let emitted = false;
for (let seed = 0; seed < 100; seed++) {
  const output = C.ctPlume(plumeSource, newCell(E.EMPTY), seed, 1);
  if (output.changed) emitted = true;
  for (const [source, target, up] of [
    [{ ...plumeSource, burning: 0 }, phaseB, 1], [{ ...plumeSource, life: 0 }, phaseB, 1],
    [{ ...plumeSource, request: 5 }, phaseB, 1], [plumeSource, phaseB, 0], [plumeSource, newCell(E.METAL), 1],
  ]) assert.deepEqual(C.ctPlume(source, target, seed, up), { a: source, b: target, changed: 0 });
}
assert.ok(emitted, 'successful plume retains the full rule');
const opaqueCells = Array.from({ length: 8 }, () => newCell(E.EMPTY));
opaqueCells[0] = plumeSource; opaqueCells[2] = newCell(E.SMOKE); opaqueCells[2].life = 6;
const opaque = opaqueCells.map((c, i) => C.packContact(c, Uint32Array.of(c.id, 0, 0, i === 2 ? 0x12340000 : 0)));
const history = compare(opaque.map(m => m.core), opaque.map(m => m.bank), 48);
assert.equal(history.cores[2][0] & 255, E.SMOKE);
assert.equal(history.cores[2][3], 0x12340000, 'SMOKE -> EMPTY -> SMOKE retains original opaque word3');
console.log(`Contact caller applicability: ${count ** 2} oriented pairs (${enabled} enabled), ${identityCases} scalar identities, ${rows.size} reaction rows, ${blocks} full-block replays; opaque tick48 and phase/plume edges pass; CPU only`);
