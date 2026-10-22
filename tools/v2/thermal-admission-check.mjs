// CPU-only grid energyFits proof. Independent old WGSL encode/decode oracle:
// all arithmetic wraps u64, normal division keeps quotient low-u32, bank is i32.
// Do not use CPU withEnergy: it throws instead of modeling overflowing banks.
import assert from 'node:assert/strict';
import { ELEMENTS, E } from '../../src/elements.js';
import { FULL, MAX_FILL, AIR_CAPACITY_Q, capacityOf, capacityDelta, isLiquid } from '../../src/v2/layout.js';
import { PHASE_ROWS, PHASE_HOT_BASE, PHASE_COLD_BASE, PHASE_STEPS, PHASE_NORMAL_MAX, phaseOffsetPerQuantum, phaseOffsetRemainder, phaseOffsetEnergy, phaseOffsetUnits, phaseCapacityUnits } from '../../src/v2/phase.js';
import { nativeStateWGSL } from '../../src/shaders/v2/state.js';

const U32 = 0xffffffffn, U64 = (1n << 64n) - 1n;
const wrap = n => n & U64;
const add = (a, b) => wrap(a + b), sub = (a, b) => wrap(a - b);
const i32 = n => BigInt.asIntN(32, n);
const oldLess = (a, b) => BigInt.asIntN(64, a) < BigInt.asIntN(64, b);
// Predicate comparisons follow phaseLess's signed high word / unsigned low word.
const less = (a, b) => {
  const ah = Number(a >> 32n) | 0, bh = Number(b >> 32n) | 0;
  return ah < bh || (ah === bh && (a & U32) < (b & U32));
};
const MIN_BANK = -2147483648n, MAX_BANK = 2147483647n;
const STEPS = BigInt(PHASE_STEPS), NORMAL_MAX = BigInt(PHASE_NORMAL_MAX);
const fills = [0, 1, FULL, MAX_FILL];
const ctypes = Array.from({ length: 256 }, (_, i) => i);
let maxCapacity = 0n, maxBucket = 0n, maxLatentProduct = 0n;
assert.equal(PHASE_ROWS.length, ELEMENTS.length);
assert.equal(PHASE_NORMAL_MAX, 41093);
assert.equal(PHASE_STEPS, 12220);
assert.equal(PHASE_HOT_BASE + PHASE_STEPS, PHASE_COLD_BASE - 1);
assert.equal(PHASE_COLD_BASE + PHASE_STEPS, 65535);

function state(id, fill, ct) {
  const amount = id === E.EMPTY ? 0 : isLiquid(id) ? fill : FULL;
  const capacity = BigInt(capacityOf(id, amount));
  return { id, fill, ct, amount, capacity, row: PHASE_ROWS[id],
    offset: wrap(phaseOffsetEnergy(id, amount, ct)),
    offset0: wrap(phaseOffsetEnergy(id, amount, 0)) };
}

// Compute, don't assume, the domain facts needed to remove the round trip.
// Include all rows at 0/FULL/MAX_FILL (and min nonzero) even when a row's
// materialAmount ignores fill. All 256 ctypes cover LAVA's source fallback too.
for (const element of ELEMENTS) for (const fill of fills) {
  const s = state(element.id, fill, 0);
  assert(s.capacity > 0n && s.capacity < (1n << 31n), `${element.key}: capacity`);
  maxCapacity = s.capacity > maxCapacity ? s.capacity : maxCapacity;
  for (const hot of [true, false]) {
    const per = hot ? s.row.hotLatent : s.row.coldLatent;
    assert(Number.isInteger(per) && per >= 0 && per <= 0x7fffffff);
    if (!per) continue;
    assert.notEqual(element.id, E.LAVA, 'LAVA must have no latent side');
    for (const ct of ctypes) assert.equal(phaseOffsetPerQuantum(element.id, ct) * FULL + phaseOffsetRemainder(element.id, ct), phaseOffsetPerQuantum(element.id, 0) * FULL + phaseOffsetRemainder(element.id, 0), `${element.key}: ctype-independent latent offset`);
    const latent = BigInt(per) * BigInt(s.amount);
    const bucket = (latent + STEPS - 1n) / STEPS;
    assert(bucket < (1n << 31n), `${element.key}: latent residual`);
    assert(latent * STEPS < (1n << 64n), `${element.key}: latent multiply overflow`);
    assert(latent < (1n << 63n), `${element.key}: signed latent comparison`);
    maxBucket = bucket > maxBucket ? bucket : maxBucket;
    maxLatentProduct = latent * STEPS > maxLatentProduct ? latent * STEPS : maxLatentProduct;
  }
}
assert.equal(PHASE_ROWS[E.LAVA].hotLatent, 0);
assert.equal(PHASE_ROWS[E.LAVA].coldLatent, 0);

// Verify models' input tables are exactly the tables used by production WGSL.
for (const [name, values] of [
  ['phaseCapacityUnitsTable', ELEMENTS.map(e => phaseCapacityUnits(e.id))],
  ...['hotQ', 'coldQ', 'hotLatent', 'coldLatent'].map(key => [
    `phase${key[0].toUpperCase() + key.slice(1)}Table`, PHASE_ROWS.map(r => r[key])]),
  ['phaseLavaOffsetUnitsTable', ELEMENTS.map(e => phaseOffsetUnits(E.LAVA, e.id))],
  ['phaseOffsetUnitsTable', PHASE_ROWS.map(r => r.offsetUnits)],
]) {
  const match = nativeStateWGSL.match(new RegExp(`const ${name} = array<[^>]+>\\(([^)]*)\\);`));
  assert(match, name);
  assert.deepEqual(match[1].split(',').map(v => Number(v.trim().replace(/u$/, ''))), values, name);
}
// Lock the actual predicate to the independently exercised model below. This
// catches changed operators, ctype, side order, bounds, and reintroduced encode.
const production = nativeStateWGSL.match(/fn energyFits\(m: Material, e: vec2u\) -> bool \{([\s\S]*?)\n\}\nstruct EnergyBounds/)[1];
const expected = `
  let id = cid(m.core); let amount = materialAmount(m.core); let capacity = capacityQ(m.core);
  for (var side = 0u; side < 2u; side++) {
    let hot = side == 0u;
    let per = select(phaseColdLatent(id), phaseHotLatent(id), hot);
    if (per <= 0 || amount == 0u) { continue; }
    let latent = energyMul(u32(per), amount);
    let base = energyAdd(phaseMaterialOffsetEnergy(id, amount, 0u),
      energyMul(capacity, u32(select(phaseColdQ(id), phaseHotQ(id), hot))));
    var progress = energySub(base, e);
    if (hot) { progress = energySub(e, base); }
    if (!phaseLess(progress, vec2u(0u)) && !phaseLess(latent, progress)) { return true; }
  }
  let sensible = energySub(e, phaseMaterialOffsetEnergy(id, amount, ctypeOf(m.core)));
  let hi = energyAdd(energyMul(capacity, 41093u), energySigned(2147483647));
  return !phaseLess(sensible, energySigned(-2147483648)) && !phaseLess(hi, sensible);
`;
const normalize = text => text.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
assert.equal(normalize(production), normalize(expected));
assert(!/withEnergy|energyOf|energyDiv|phaseDiv|encodeMaterialEnergy/.test(production));
assert(nativeStateWGSL.includes('fn packetEnergyFits(m: Material, e: vec2u) -> bool { return all(packetOwnedEnergy(withPacketEnergy(m,e)) == e); }'));

function oldDecode(s, raw, bank) {
  // WGSL accepts every 16-bit raw code, even tags on zero-latent rows.
  const hot = raw < PHASE_COLD_BASE;
  const tq = raw <= PHASE_NORMAL_MAX ? raw : hot ? s.row.hotQ : s.row.coldQ;
  let latent = 0n;
  if (raw > PHASE_NORMAL_MAX) {
    const total = BigInt(hot ? s.row.hotLatent : s.row.coldLatent) * BigInt(s.amount);
    const magnitude = wrap(total * BigInt(raw - (hot ? PHASE_HOT_BASE : PHASE_COLD_BASE))) / STEPS;
    latent = hot ? magnitude : wrap(-magnitude);
  }
  return wrap(s.capacity * BigInt(tq) + s.offset + latent + i32(bank));
}
function oldFits(s, e) {
  const sensible0 = sub(e, s.offset0);
  for (const hot of [true, false]) {
    const per = hot ? s.row.hotLatent : s.row.coldLatent;
    if (per <= 0) continue;
    const latent = BigInt(per) * BigInt(s.amount);
    if (!latent) continue;
    const threshold = s.capacity * BigInt(hot ? s.row.hotQ : s.row.coldQ);
    const progress = hot ? sub(sensible0, threshold) : sub(threshold, sensible0);
    if (oldLess(progress, 0n) || oldLess(latent, progress)) continue;
    const index = Number((wrap(progress * STEPS) / latent) & U32);
    const encoded = wrap(latent * BigInt(index)) / STEPS;
    const bank = hot ? sub(progress, encoded) : sub(encoded, progress);
    const raw = ((hot ? PHASE_HOT_BASE : PHASE_COLD_BASE) + index) & 65535;
    return oldDecode(s, raw, bank) === e;
  }
  const sensible = sub(e, s.offset);
  let tq = 0;
  if ((sensible & (1n << 63n)) === 0n && s.capacity !== 0n) {
    tq = Math.min(PHASE_NORMAL_MAX, Number((sensible / s.capacity) & U32));
  }
  const bank = sub(sensible, s.capacity * BigInt(tq));
  return oldDecode(s, tq, bank) === e;
}
function fits(s, e) {
  for (const hot of [true, false]) {
    const per = hot ? s.row.hotLatent : s.row.coldLatent;
    if (per <= 0 || !s.amount) continue;
    const latent = BigInt(per) * BigInt(s.amount);
    const base = add(s.offset0, s.capacity * BigInt(hot ? s.row.hotQ : s.row.coldQ));
    const progress = hot ? sub(e, base) : sub(base, e);
    if (!less(progress, 0n) && !less(latent, progress)) return true;
  }
  const sensible = sub(e, s.offset);
  const hi = add(s.capacity * NORMAL_MAX, MAX_BANK);
  return !less(sensible, wrap(MIN_BANK)) && !less(hi, sensible);
}
let checks = 0, accepted = 0, refused = 0;
function check(s, value) {
  const e = wrap(value), actual = fits(s, e), expected = oldFits(s, e);
  if (actual !== expected) assert.fail(`id=${s.id} fill=${s.fill} ct=${s.ct} e=0x${e.toString(16)}: ${actual} != ${expected}`);
  checks++; if (actual) accepted++; else refused++;
}
let seed = 0x3765d26e;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const random64 = () => (BigInt(rnd()) << 32n) | BigInt(rnd());
const signedEdges = [0n, 1n, U32, 1n << 32n, (1n << 63n) - 1n, 1n << 63n, U64];
const banks = [MIN_BANK, MIN_BANK + 1n, -1n, 0n, 1n, MAX_BANK - 1n, MAX_BANK];
for (const element of ELEMENTS) for (const fill of fills) for (const ct of element.id === E.LAVA ? ctypes : [0, 255]) {
  const s = state(element.id, fill, ct);
  for (const edge of signedEdges) for (const delta of [-1n, 0n, 1n]) check(s, edge + delta);
  // Normal bounds, division boundaries, both bank signs and bank overflow.
  for (const tq of [0, 1, PHASE_NORMAL_MAX - 1, PHASE_NORMAL_MAX]) {
    for (const bank of [...banks, MIN_BANK - 1n, MAX_BANK + 1n]) check(s, s.offset + s.capacity * BigInt(tq) + bank);
  }
  for (const hot of [true, false]) {
    const per = hot ? s.row.hotLatent : s.row.coldLatent;
    if (!per || !s.amount) continue;
    const total = BigInt(per) * BigInt(s.amount);
    const base = add(s.offset0, s.capacity * BigInt(hot ? s.row.hotQ : s.row.coldQ));
    for (const progress of [-1n, 0n, 1n, total - 1n, total, total + 1n]) check(s, hot ? base + progress : base - progress);
    for (const index of [0, 1, PHASE_STEPS - 1, PHASE_STEPS]) {
      const raw = (hot ? PHASE_HOT_BASE : PHASE_COLD_BASE) + index;
      for (const bank of banks) check(s, oldDecode(s, raw, bank));
    }
  }
  for (let i = 0; i < 64; i++) check(s, random64());
}
// Every raw normal/hot/cold code for every row, including invalid zero-latent
// tags as raw WGSL inputs. Rotate all valid fill extremes and all bank signs;
// the cross-product bank/fill edge coverage above complements this sweep.
for (const element of ELEMENTS) {
  const states = fills.map(fill => state(element.id, fill, 0));
  for (let raw = 0; raw <= 65535; raw++) {
    const s = states[raw % states.length];
    check(s, oldDecode(s, raw, banks[raw % banks.length]));
  }
}
// Explicit regression: cold STEAM admits energies below its normal lower bound.
const steam = state(E.STEAM, FULL, 0);
const coldEnd = add(steam.offset0, steam.capacity * BigInt(steam.row.coldQ) - BigInt(steam.row.coldLatent) * BigInt(steam.amount));
assert(less(sub(coldEnd, steam.offset), wrap(MIN_BANK)));
assert(fits(steam, coldEnd) && oldFits(steam, coldEnd));
assert(accepted > 0 && refused > 0);
console.log(`thermal admission: ${checks} modulo-u64/i32 oracle cases, 0 mismatches (${accepted} admitted, ${refused} refused)`);
console.log(`all ${ELEMENTS.length} rows/fill extremes: max capacity=${maxCapacity}, max latent bucket=${maxBucket}, max latent*steps=${maxLatentProduct}; source predicate and all raw codes checked`);
