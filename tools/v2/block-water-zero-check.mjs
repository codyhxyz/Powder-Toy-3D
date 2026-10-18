// CPU-only identity proof: actual emitted predicate + production contacts and
// mechanical/store source guards. NOT a full native-block interpreter/GPU replay.
import assert from 'node:assert/strict';
import { E, K, ELEMENTS } from '../../src/elements.js';
import * as C from '../../src/v2/contact.js';
import { PHASE_ROWS } from '../../src/v2/phase.js';
import { GRAV, AIR, EDGE } from '../../src/simModes.js';
import { edgeCell } from '../../src/v2/modes.js';
import { offsetOf } from '../../src/v2/physics.js';
import { gridLayout } from '../../src/sim.js';
import { v2BlockWGSL, v2Rows, WGSL_CHECK, v2SupportWGSL } from '../../src/shaders/v2.js';
import { materialStorageWGSL } from '../../src/shaders/v2/state.js';
import { modeWGSL } from '../../src/shaders/v2/modes.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { wgslGroupingErrors, assertNaga, importMinified } from './wgsl-grouping.mjs';

// Changes to these assumptions require re-proving the shortcut, not silently
// treating a new WATER rule/calibration as an identity.
assert.deepEqual(C.CONTACT_ROWS[E.WATER], {
  kind: K.LIQUID, capacity: 64, offset: 0, cond: 0.03, density: 10, spawnQ: 1173, spawnLife: 0,
  hotQ: 1493, hotOut: 1, hotL: 138240, hotGas: 1, hotOf: E.WATER,
  coldQ: 1093, coldOut: 2, coldL: 20480, coldOf: E.WATER,
  meltQ: 65536, meltInto: E.WATER, igniteQ: 65536, flashQ: 65536,
  burn: 0, heat: 0, flameQ: 1093, ash: 1, blast: 0, blastAir: 0, blastChance: 0,
  acid: 0, edible: 0, fizz: 0, bed: 0, rots: 0, singFood: 1, conductor: 1, cost: 100, wire: 0, emitter: 0,
  blastInto: -1, blastOf: 0, blastQ: 0, blastPuff: 0,   // no blast: water's shortcut is unchanged
  cool: 0,   // V1 react.js: water has no rad, so no pull toward ambient
});
assert.deepEqual(PHASE_ROWS[E.WATER], {
  hot: { T: 100, into: 'STEAM', latent: 540, puff: 1700 }, cold: { T: 0, into: 'ICE', latent: 80 },
  hotQ: 1493, coldQ: 1093, hotLatent: 138240, coldLatent: 20480, offset: 0,
});
assert.deepEqual(v2Rows()[E.WATER], { key: 'WATER', cls: 3, drop: 0, vt: 0, dens: 10, yieldHead: 0, damp: 0.01, fade: 0 });
assert.equal(C.CONTACT_RX_INDEX[E.WATER * ELEMENTS.length + E.WATER], 0);

const g = gridLayout(16, 16, 16), dims = [16, 16, 16], shader = v2BlockWGSL(g, contactWGSL);
const start = shader.indexOf('  // Canonical full WATER'), end = shader.indexOf('  // Proven zero-work domain', start);
assert(start > shader.indexOf('oldBanks[i] = bs[i];'));
assert(end > start);
const branch = shader.slice(start, end);
for (const size of [32, 128]) {
  const code = v2BlockWGSL(gridLayout(size, size, size), contactWGSL);
  assert.equal(code.slice(code.indexOf('  // Canonical full WATER'), code.indexOf('  // Proven zero-work domain')), branch);
}
// Execute the actual emitted expression/control flow with syntax-only changes.
const js = branch.replace(/\/\/[^\n]*/g, '')
  .replace(/cs\[([^\]]+)\]\.([xyzw])/g, (_, i, a) => `cs[${i}][${'xyzw'.indexOf(a)}]`)
  .replaceAll('inGrid(positions[k])', 'valid(positions[k])')
  .replaceAll('var ', 'let ').replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1')
  .replace('if (zeroWater) { return; }', 'if (zeroWater) { return true; }');
const predicate = new Function('cs', 'bs', 'positions', 'pending', 'P', 'blockCount', 'valid', `${js}\nreturn false;`);
const valid = p => p.every((x, a) => x >= 0 && x < dims[a]);
const word = ((1173 << 8) | E.WATER) >>> 0;
const water = () => Array.from({ length: 8 }, () => new Uint32Array([word, 65536, 0, 0]));
const positions = Array.from({ length: 8 }, (_, i) => [6 + (i & 1), 6 + (i >> 2), 6 + ((i >> 1) & 1)]);
const banks = new Int32Array(8), pending = new Uint32Array(8);
const modes = { edge: EDGE.SOLID, airMode: AIR.ON, ambientHeat: 1, ambient: 20 };
const eligible = (cs = water(), bs = banks, ps = positions, requests = pending, P = modes, count = 8) =>
  predicate(cs, bs, ps, requests, P, count, valid);
assert(eligible());
assert(!eligible(Array.from({ length: 8 }, () => new Uint32Array([1173 << 8, 0, 0, 0]))), 'AIR has its own separate predicate');
let cases = 0;
function prove(cs, tick = 1, ps = positions, outside = Array.from({ length: 8 }, () => [3, 0, 0, 3])) {
  assert(eligible(cs, banks, ps));
  const before = cs.map(c => new Uint32Array(c));
  const out = C.contactReference(cs, banks, tick, ps, pending, Array(8).fill(true), outside);
  assert.deepEqual(cs, before, 'contact reference must not mutate inputs');
  assert.deepEqual(out.cores, before, 'all packed liquid flux remains byte-exact');
  assert.deepEqual(out.banks, banks); assert.deepEqual(out.requests, pending);
  assert.deepEqual(out.busy, []); assert.deepEqual(out.sources, Array(8).fill(0n)); assert.deepEqual(out.sinks, Array(8).fill(0n));
  assert.equal(C.ctDensity(C.unpackContact(cs[0])), C.ctDensity(C.unpackContact(cs[7])));
  for (let i = 0; i < 8; i++) for (const open of [1, 3, 5]) {
    const boundary = C.ctBoundary(C.unpackContact(out.cores[i], out.banks[i]), open, 1173);
    assert.deepEqual(C.packContact(boundary, out.cores[i]), { core: before[i], bank: 0 });
    assert.equal(boundary.busy, 0); assert.equal(boundary.request, 0);
    assert.equal(boundary.source, 0n); assert.equal(boundary.sink, 0n);
  }
  cases++;
}
// Every allowed flux bit in each cell (8 * 48), then combined flux patterns.
for (let i = 0; i < 8; i++) for (let bit = 0; bit < 48; bit++) {
  const cs = water(); cs[i][bit < 32 ? 2 : 3] = 2 ** (bit % 32);
  prove(cs, [0, 1, 7, 0xffffffff][bit % 4]);
}
let seed = 0x57a7e2;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (let n = 0; n < 256; n++) {
  const cs = water(); for (const c of cs) { c[2] = random(); c[3] = random() & 65535; }
  prove(cs, random());
}
for (let byte = 0; byte < 256; byte++) {
  const cs = water(); for (const c of cs) { c[2] = random(); c[3] = random() & 65535; }
  const outside = Array.from({ length: 8 }, (_, i) => {
    const b = (byte + 31 * i) & 255; return [b & 3, (b >> 2) & 3, (b >> 4) & 3, b >> 6];
  });
  prove(cs, random(), positions, outside);
}
assert.equal(cases, 896);
console.log('WATER identity: 384 individual flux bits, 256 random blocks and 256 atmosphere bytes; exact cores/banks/requests and zero activity/energy ledgers');

for (let i = 0; i < 8; i++) {
  for (const w of [0, 1, 3]) for (let bit = w === 3 ? 16 : 0; bit < 32; bit++) {
    const cs = water(); cs[i][w] = (cs[i][w] ^ 2 ** bit) >>> 0; assert(!eligible(cs), `prohibited slot ${i}, word ${w}, bit ${bit}`);
  }
  for (const bank of [-2147483648, -1, 1, 2147483647]) { const bs = new Int32Array(8); bs[i] = bank; assert(!eligible(water(), bs)); }
  for (let bit = 0; bit < 32; bit++) { const requests = new Uint32Array(8); requests[i] = 2 ** bit; assert(!eligible(water(), banks, positions, requests)); }
  for (let axis = 0; axis < 3; axis++) for (const value of [-1, 16]) {
    const ps = positions.map(p => [...p]); ps[i][axis] = value; assert(!eligible(water(), banks, ps));
  }
  for (const id of [E.EMPTY, E.SAND, E.STEAM, E.WALL]) {
    const cs = water(); cs[i][0] = ((1173 << 8) | id) >>> 0;
    if (id === E.EMPTY) cs[i][1] = 0;
    assert(!eligible(cs), 'mixed AIR/WATER or another material must take the full path');
  }
}
for (let count = 0; count < 8; count++) assert(!eligible(water(), banks, positions, pending, modes, count));
for (const q of [0, 1093, 1172, 1174, 1493, 41093, 41094, 53315, 65535]) {
  const cs = water(); for (const c of cs) c[0] = (q << 8) | E.WATER; assert(!eligible(cs));
}
for (const ambient of [-273.25, 0, 19.999, 20.001, 20.125, 100, NaN, Infinity])
  assert(!eligible(water(), banks, positions, pending, { ...modes, ambient: Math.fround(ambient) }));

// Mechanical equivalence is source-checked, NOT an independent block simulator.
const r2 = shader.slice(shader.indexOf('  // R2 topple'), shader.indexOf('  // R3 sink'));
const r3 = shader.slice(shader.indexOf('  // R3 sink'), shader.indexOf('  // R4 gas:'));
assert(r2.includes('if (clsOf(gr) != C_POWDER) { continue; }'));
assert.equal(v2Rows()[E.WATER].cls, 3);
assert(r3.indexOf('if (dU <= dL) { continue; }') < r3.indexOf('markBusy(pU);'));
assert(r3.indexOf('if (dU <= dL) { continue; }') < r3.indexOf('var rs = seed3'));
assert(shader.includes('if (!young) { continue; }'));
assert(shader.includes('k0 == C_GAS && k1 == C_AIR'));
assert(shader.includes('k1 == C_GAS && k0 == C_AIR'));
assert(shader.includes('if (clsOf(cs[i]) == C_GAS && cAge(cs[i]) < DIFFUSE_AGE)'));
assert(shader.indexOf('if (zeroWater) { return; }') < shader.indexOf('  // R2 topple'));
assert(shader.includes('events[slot] = ctMergeRequest(pending[i], requests[i]);'));   // flags OR, the larger puff
assert(v2SupportWGSL(g).includes('liquidScratch[s].x=(liquidScratch[s].x&0xffffff00u)|air|(oxygen<<2u)|(co2<<4u)|(gas<<6u);'));
assert(!v2SupportWGSL(g).includes('zeroWater'), 'support snapshots remain unconditional for AIR/WATER and halo targets');
for (const code of ['', contactWGSL + '\n', 'fn contactBlock() {}']) assert(!v2BlockWGSL(g, code).includes('var zeroWater'));
const probe = WGSL_CHECK.find(k => k.name === 'v2contactABI').code(g);
assert(!probe.includes('var zeroWater')); assert(probe.includes('energySigned(-1)')); assert(probe.includes('(*requests)[0] |= 1u;'));

// Evaluate the real corner permutation, including radial dominant axes and seams.
const permutation = modeWGSL.slice(modeWGSL.indexOf('  var p=o;'), modeWGSL.indexOf('\nfn mAirVelocity'))
  .replace(/}\s*$/, '').replace('var p=o;', 'let p=[...o];').replace(/vec3i\(([^)]+)\)/g, '[$1]')
  .replace(/\b(o|p|down)\.([xyz])/g, (_, v, a) => `${v}[${'xyz'.indexOf(a)}]`);
const blockOffset = new Function('o', 'down', permutation);
const downAxes = [[0, 0, 0], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
for (const gravMode of Object.values(GRAV)) for (const edge of Object.values(EDGE))
  for (const airMode of Object.values(AIR)) for (const ambientHeat of [0, 1]) {
    const P = { ...modes, gravMode, edge, airMode, ambientHeat };
    for (const down of downAxes) for (const tick of [1, 2, 7, 8]) {
      const c0 = offsetOf(tick).map(v => 6 + v);
      const ps = positions.map((_, i) => c0.map((v, a) => v + blockOffset([i & 1, i >> 2, (i >> 1) & 1], down)[a]));
      assert.equal(new Set(ps.map(p => p.join(','))).size, 8);
      const cs = water(); for (const c of cs) { c[2] = random(); c[3] = random() & 65535; }
      assert(eligible(cs, banks, ps, pending, P)); prove(cs, tick, ps);
    }
    const seam = positions.map((_, i) => edgeCell([-1 + (i & 1), 6 + (i >> 2), 6 + ((i >> 1) & 1)], dims, edge) ?? [-1, 6, 6]);
    assert.equal(eligible(water(), banks, seam, pending, P), seam.every(valid));
  }

// Execute actual store/noteVisible guards. Equal inputs imply equal values for
// deterministic compactA; its float projection is not reimplemented here.
const noteSource = shader.slice(shader.indexOf('fn noteVisible('), shader.indexOf('\nfn noteState'));
const noteBody = noteSource.slice(noteSource.indexOf('{') + 1, noteSource.lastIndexOf('}'))
  .replace('all(compactA(p, before) == compactA(p, after))', 'same(compactA(p, before), compactA(p, after))')
  .replace(/atomicStore\(&act2\[V2_(VISIBLE|LEGACY) \+ b\], 1u\);/g, (_, name) => `mark('${name}');`).replaceAll('let ', 'const ');
const ageExpression = shader.match(/fn cAge\([^]*?return ([^;]+);/)[1].replace('c.x', 'c[0]').replace(/(\d+)u/g, '$1');
const age = new Function('c', `return ${ageExpression};`);
const note = new Function('p', 'before', 'after', 'compactA', 'same', 'isLiq', 'cAge', 'brickOfCell', 'mark', noteBody);
const storeBody = materialStorageWGSL.match(/fn storeMaterial\([^]*?\) \{([^]*)\}/)[1]
  .replace('any(before.core != after.core)', 'before.core.some((v,i)=>v!==after.core[i])');
const store = new Function('slot', 'before', 'after', 'noteVisible', 'cellOf', 'noteState', 'storeCore', 'banks', storeBody);
for (const preserveLegacyMarks of [0, 1]) for (let n = 0; n < 64; n++) {
  const core = water()[0]; core[2] = random(); core[3] = random() & 65535;
  const marks = { VISIBLE: 0xa5a5, LEGACY: 0xffffffff, DIRTY: 1 }, previous = { ...marks }, bs = new Int32Array(8);
  let liquidChecks = 0, ageChecks = 0, stores = 0;
  const visible = (_p, before, after) => note(_p, before, after,
    (_p, c) => { assert.deepEqual(c, core); return [E.WATER, 20, 0, 0]; },
    (a, b) => a.every((v, i) => v === b[i]),
    c => { liquidChecks++; return ELEMENTS[c[0] & 255].kind === K.LIQUID; },
    c => { ageChecks++; return age(c); }, () => 0, name => { marks[name] = 1; });
  store(0, { core, bank: 0 }, { core: new Uint32Array(core), bank: 0 }, visible, s => s,
    () => { marks.DIRTY = 2; }, (_s, c) => { stores++; assert.deepEqual(c, core); }, bs);
  assert.equal(liquidChecks, 1); assert.equal(ageChecks, 2, 'liquid-specific noteVisible equality is exercised');
  assert.equal(stores, 1); assert.deepEqual(marks, previous); assert.deepEqual(bs, banks);
  assert(!storeBody.includes('preserveLegacyMarks'), 'equal stores preserve existing marks in both modes');
}
const marked = [], original = water()[0], aerated = new Uint32Array(original); aerated[0] |= 1 << 24;
note(positions[0], original, aerated, () => [E.WATER, 20, 0, 0],
  (a, b) => a.every((v, i) => v === b[i]), () => true, age, () => 0, name => marked.push(name));
assert.deepEqual(marked, ['VISIBLE', 'LEGACY'], 'liquid age inequality must still reach the real visibility marks');
console.log('Strict negative domain, all modes/corner permutations, mechanical/boundary/custom ABI and actual liquid store/noteVisible guards passed');

const minified = await importMinified('src/shaders/v2.js');
assert.equal(minified.v2BlockWGSL(g, contactWGSL), shader);
assert(!minified.v2BlockWGSL(g, contactWGSL + '\n').includes('var zeroWater'));
assert.deepEqual(wgslGroupingErrors(shader), []);
assertNaga(shader, 'block');
console.log('Full minified production block byte-identical; CPU Naga and Chromium expression grouping valid; no GPU/performance claim');
