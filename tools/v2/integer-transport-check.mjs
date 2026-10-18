// CPU-only exact arithmetic oracle + sampled whole-format work census. No GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ELEMENTS } from '../../src/elements.js';
import { columnWaterWGSL } from '../../src/shaders/v2/columns.js';
import { FULL, MAX_FILL, capacityPerQuantum, isLiquid, share } from '../../src/v2/layout.js';
import { PHASE_ROWS, PHASE_STEPS, PHASE_NORMAL_MAX } from '../../src/v2/phase.js';
import { limbs, wide, signed, mul, mulSmall, energyDiv, energyDivExact, phaseDiv, phaseDivExact, highestBit, energyScale, energyShare, shareUnsigned } from './integer-transport-reference.mjs';
const U32 = 0xffffffffn, U64 = (1n << 64n) - 1n;
let seed = 0x71abc987, checks = 0;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const randomWide = () => BigInt(rnd()) << 32n | BigInt(rnd());
function checkEnergy(a, d, options = {}) {
  const result = energyDiv(limbs(a), d, options);
  assert.deepEqual(result, d ? [Number((a / BigInt(d)) & U32), Number(a % BigInt(d))] : [0xffffffff,Number(a & U32)]); checks++;
}
function checkPhase(a, b, options = {}) { assert.equal(wide(phaseDiv(limbs(a), limbs(b), options)), b ? a / b : 0n); checks++; }
function checkShare(e, p, n, d, options = {}) {
  // This is the documented bounded-quotient domain (including INT_MIN banks).
  assert.equal(signed(energyShare(limbs(e), p, n, d, options)), share(e, p, n, d)); checks++;
}
const edges = [0n, 1n, 2n, 3n, (1n << 31n) - 1n, 1n << 31n, (1n << 32n) - 1n, 1n << 32n,
  (1n << 32n) + 1n, (1n << 63n) - 1n, 1n << 63n, U64 - 1n, U64];
const stressStats = {};
for(let width=0;width<=64;width++) {
  const a=(1n<<BigInt(width))-1n;
  assert.equal(highestBit(limbs(a)),width-1);
  for(const d of [1,3,65537,0x80000000]) {
    assert.deepEqual(energyDivExact(limbs(a),d),[Number((a/BigInt(d))&U32),Number(a%BigInt(d))]);
    checks++;
  }
  for(const b of [0n,1n,3n,1n<<32n,1n<<63n]) {
    assert.equal(wide(phaseDivExact(limbs(a),limbs(b))),b?a/b:0n);
    checks++;
  }
}
for(const file of ['state','phase']) {
  const source=readFileSync(new URL(`../../src/shaders/v2/${file}.js`,import.meta.url),'utf8');
  assert(source.includes('countLeadingZeros(a.x)') && source.includes('countLeadingZeros(a.y)'));
  assert(!/for\s*\(\s*var\s+(?:i|bit)\s*=\s*63\b/.test(source),'exact division must use its data-dependent leading bit');
}
for (const a of edges) for (const d of [0, 1, 2, 3, 65535, FULL, FULL + 1, MAX_FILL, 0x7fffffff, 0x80000000]) {
  for (const perturb of [-8, 0, 8]) checkEnergy(a, d, { perturb, stats: stressStats });
}
for (const a of edges) for (const b of [...edges, 12220n, 65535n, 65537n, ...Array.from({ length: 64 }, (_, i) => 1n << BigInt(i))]) for (const perturb of [-8, 0, 8]) checkPhase(a, b, { perturb, stats: stressStats });
for (let i = 0; i < 40000; i++) {
  const a = randomWide(), d = (rnd() & 0x7fffffff) + 1, b = randomWide();
  const options = { perturb: [-8, -1, 0, 1, 8][i % 5], stats: stressStats };
  checkEnergy(a, d, options); checkPhase(a, b, options);
  assert.equal(wide(mul(rnd(), 0xffffffff)), BigInt(seed) * U32); checks++;
  // Nearly divisible products and maximal u32 quotient exercise clamping,
  // corrections in both directions, and the fixed-attempt exact fallback.
  const q = i % 2 ? rnd() : 0xffffffff, divisor = BigInt(d);
  for (const delta of [-1n, 0n, 1n]) {
    const numerator = BigInt(q) * divisor + delta;
    if (numerator >= 0n) checkEnergy(numerator, d, options);
  }
  const denominator = (1n << 32n) + BigInt(rnd()), quotient = BigInt(rnd() % 65536);
  for (const delta of [-1n, 0n, 1n]) checkPhase(denominator * quotient + delta + denominator, denominator, options);
}
// Deliberately wild candidates cannot influence exact output. Force fallback.
for (const estimate of [() => 0, () => 4294967040, q => q + 1000]) {
  checkEnergy(123456789012345n, 1000003, { estimate, stats: stressStats });
  checkPhase(123456789012345n, (1n << 32n) + 7n, { estimate, stats: stressStats });
}
assert.ok(stressStats.energyFallback > 0 && stressStats.phaseFallback > 0);
// phaseMulSmall fast-path bound: b<2^48, q<=65535 (including carry).
for (const b of [(1n << 48n) - 1n, 1n << 32n, (1n << 48n) - (1n << 32n)]) {
  for (const q of [0, 1, PHASE_STEPS, 65535]) assert.equal(wide(mulSmall(limbs(b), q)), b * BigInt(q));
}
// Scale identities retain every bit, including signed i64 minimum, regardless
// of the old truncated quotient contract outside normal transport bounds.
for (const e of [...edges.map(x => BigInt.asIntN(64, x)), -2147483648n]) {
  assert.equal(signed(energyScale(limbs(e), 0, 0)), 0n);
  assert.equal(signed(energyScale(limbs(e), FULL, FULL)), e);
  assert.equal(signed(energyShare(limbs(e), 0, FULL, FULL)), e);
}
// Preserve low-word quotient semantics outside the transport domain, rather
// than quietly returning a float approximation or overflowing q conversion.
for (const e of [(1n << 63n) - 1n, -(1n << 63n), (1n << 48n) + 1n]) {
  for (const d of [3, 65535]) {
    const magnitude = e < 0n ? -e : e;
    const legacyScale = n => (((magnitude / BigInt(d)) & U32) * BigInt(n) + magnitude % BigInt(d) * BigInt(n) / BigInt(d)) * (e < 0n ? -1n : 1n);
    assert.equal(signed(energyScale(limbs(e), 1, d)), legacyScale(1));
    assert.equal(signed(energyShare(limbs(e), 1, 1, d)), legacyScale(2) - legacyScale(1));
  }
}
for (let i = 0; i < 20000; i++) {
  const d = rnd() % MAX_FILL + 1, n = rnd() % (d + 1), p = rnd() % (d - n + 1);
  const magnitude = BigInt(rnd()) * BigInt(d) + BigInt(rnd() % d);
  const e = i % 2 ? -magnitude : magnitude;
  checkShare(e, p, n, d, { perturb: [-8, 0, 8][i % 3] });
  assert.equal(signed(energyScale(limbs(e), n, d)), e * BigInt(n) / BigInt(d)); checks++;
  assert.equal(shareUnsigned(rnd(), p, n, d), Number(share(seed, p, n, d))); checks++;
}
for (const e of [-2147483648n, -1n, 0n, 1n, 2147483647n]) for (const d of [1, 3, FULL, MAX_FILL]) checkShare(e, 0, Math.floor(d / 2), d);

// Whole actual TABLE domain, not just room-temperature water: every material,
// normal-temperature endpoints and uniform random samples over 0..41093,
// all plateau endpoints + random indices, fill 1..MAX_FILL, signed bank ends,
// and zero/one/full/random flux + prefix. This is sampling, not enumeration of
// the huge cross product. Record fallback rate separately from adversarial tests.
const stats = {}, perturbedStats = {};
let samples = 0, phaseSamples = 0, maxCapacity = 0, maxLatentProduct = 0n, maxOffset = 0n;
const banks = [-2147483648, -1, 0, 1, 2147483647];
for (const material of ELEMENTS) {
  const row = PHASE_ROWS[material.id], cap = capacityPerQuantum(material.id);
  for (let i = 0; i < 256; i++) {
    const amount = material.id === 0 ? 0 : isLiquid(material.id) ? [1, 2, 3, FULL - 1, FULL, FULL + 1, MAX_FILL - 1, MAX_FILL, rnd() % MAX_FILL + 1][i % 9] : FULL;
    const tq = [0, 1, PHASE_NORMAL_MAX - 1, PHASE_NORMAL_MAX, rnd() % (PHASE_NORMAL_MAX + 1)][i % 5];
    const capacity = FULL + amount * cap; maxCapacity = Math.max(maxCapacity, capacity);
    const offset = BigInt(row.offset) * BigInt(amount); maxOffset = maxOffset > (offset < 0n ? -offset : offset) ? maxOffset : (offset < 0n ? -offset : offset);
    const sensible = BigInt(capacity) * BigInt(tq) + BigInt(banks[i % banks.length]);
    if (sensible >= 0n) checkEnergy(sensible, capacity, { stats });
    if (isLiquid(material.id)) {
      const e = BigInt(amount * cap) * BigInt(tq) + offset + BigInt(banks[i % banks.length]);
      const n = [0, 1, amount, rnd() % (amount + 1)][i % 4], prefix = rnd() % (amount - n + 1);
      checkShare(e, prefix, n, amount, { stats });
      checkShare(e, prefix, n, amount, { stats: perturbedStats, perturb: i % 2 ? -2 : 2 });
      const fuel = [0, 1, 65535, rnd() % 65536][i % 4];
      assert.equal(shareUnsigned(fuel, prefix, n, amount, { stats }), Number(share(fuel, prefix, n, amount))); samples++;
    }
    for (const hot of [true, false]) {
      const per = hot ? row.hotLatent : row.coldLatent;
      if (per <= 0 || !amount) continue;
      const latent = BigInt(per) * BigInt(amount), index = [0, 1, PHASE_STEPS - 1, PHASE_STEPS, rnd() % (PHASE_STEPS + 1)][i % 5];
      const product = latent * BigInt(PHASE_STEPS); maxLatentProduct = maxLatentProduct > product ? maxLatentProduct : product;
      assert.ok(product < 1n << 63n, 'actual phase products fit signed energy');
      const encoded = latent * BigInt(index) / BigInt(PHASE_STEPS);
      const progress = [0n, 1n, latent - 1n, latent, encoded][i % 5];
      checkPhase(progress * BigInt(PHASE_STEPS), latent, { stats });
      checkPhase(latent * BigInt(index), BigInt(PHASE_STEPS), { stats });
      checkPhase(progress * BigInt(PHASE_STEPS), latent, { stats: perturbedStats, perturb: i % 2 ? -2 : 2 });
      checkPhase(latent * BigInt(index), BigInt(PHASE_STEPS), { stats: perturbedStats, perturb: i % 2 ? -2 : 2 });
      if (isLiquid(material.id)) {
        const e = BigInt(amount * cap) * BigInt(hot ? row.hotQ : row.coldQ) + offset + (hot ? encoded : -encoded) + BigInt(banks[i % banks.length]);
        checkShare(e, 0, Math.floor(amount / 2), amount, { stats });
        checkShare(e, 0, Math.floor(amount / 2), amount, { stats: perturbedStats, perturb: i % 2 ? -2 : 2 });
      }
      phaseSamples++;
    }
  }
}
// An uneven six-face partition must telescope exactly, including negative heat.
for (let i = 0; i < 1000; i++) {
  const d = rnd() % MAX_FILL + 1, e = BigInt(rnd()) * BigInt(d) * (i % 2 ? -1n : 1n);
  let prefix = 0, sum = 0n;
  for (let face = 0; face < 6; face++) { const n = face === 5 ? d - prefix : rnd() % (d - prefix + 1); sum += signed(energyShare(limbs(e), prefix, n, d)); prefix += n; }
  assert.equal(sum, e); checks++;
}
// Cartesian extremes independently combine every liquid's temperature, fill,
// bank and phase endpoint (the seeded census above supplies interior values).
for (const material of ELEMENTS.filter(e => isLiquid(e.id))) {
  const row = PHASE_ROWS[material.id], cap = capacityPerQuantum(material.id);
  for (const amount of [1, 3, FULL, MAX_FILL]) for (const tq of [0, PHASE_NORMAL_MAX]) for (const bank of [-2147483648, 2147483647]) {
    const e = BigInt(amount) * (BigInt(cap * tq) + BigInt(row.offset)) + BigInt(bank);
    checkShare(e, 0, Math.floor(amount / 2), amount, { stats });
    for (const hot of [true, false]) {
      const per = hot ? row.hotLatent : row.coldLatent;
      if (per <= 0) continue;
      const threshold = BigInt(amount) * (BigInt(cap * (hot ? row.hotQ : row.coldQ)) + BigInt(row.offset));
      const end = threshold + BigInt(amount * per) * (hot ? 1n : -1n) + BigInt(bank);
      checkShare(end, 0, Math.floor(amount / 2), amount, { stats });
    }
  }
}
// The column model's one transfer (colMove): each packet's heat is computed once and the same value leaves
// the source and reaches the receiver, so the share's exactness above is the transfer's.
const move = columnWaterWGSL.slice(columnWaterWGSL.indexOf('fn colMove('), columnWaterWGSL.indexOf('// ---- the head of a record'));
assert.match(move, /let heat = energyShare\(carried, 0u, n, have\);/);
assert.match(move, /let sentEnergy = energySub\(energyOf\(src\), heat\);/);
assert.match(move, /let gotEnergy = energyAdd\(energyOf\(dst\), heat\);/);
assert.equal((move.match(/energyShare\(/g) ?? []).length, 1, 'each packet computed once');
const report = s => ({ ...s, fallbackRate: `${(100 * ((s.energyFallback ?? 0) + (s.phaseFallback ?? 0)) / (s.energyCalls + s.phaseCalls)).toFixed(5)}%` });
console.log(`${checks} exact BigInt oracle checks; all ${ELEMENTS.length} materials; ${samples} liquid + ${phaseSamples} phase domain samples`);
console.log(`bounds: capacity=${maxCapacity}; latent*PHASE_STEPS=${maxLatentProduct}; |offset|=${maxOffset}`);
console.log('actual-domain work:', JSON.stringify(report(stats)));
console.log('actual-domain +/-2 ULP work:', JSON.stringify(report(perturbedStats)));
console.log('adversarial fallback coverage:', JSON.stringify(report(stressStats)));
console.log('static successful face: 2 heat + 2 fuel evaluations -> 1 each; nonzero partial energyShare: 4 wide divisions -> <=3; zero fuel -> 0; fast paths -> 0 bit iterations, estimate <=4 exact checks; fallback remains 64. Not GPU timing.');
