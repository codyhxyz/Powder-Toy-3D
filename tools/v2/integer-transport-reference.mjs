// CPU limb-for-limb mirror of state.js/phase.js arithmetic. BigInt belongs in
// the oracle, not this implementation. Float candidates use WGSL f32 rounding.
const F = Math.fround;
export const limbs = n => [Number(BigInt.asUintN(32, n)), Number(BigInt.asUintN(32, n >> 32n))];
export const wide = a => BigInt(a[0]) | BigInt(a[1]) << 32n;
export const signed = a => BigInt.asIntN(64, wide(a));
export const less = (a, b) => a[1] < b[1] || a[1] === b[1] && a[0] < b[0];
export function add(a, b) { const lo = (a[0] + b[0]) >>> 0; return [lo, (a[1] + b[1] + (lo < a[0] ? 1 : 0)) >>> 0]; }
export const neg = a => add([~a[0] >>> 0, ~a[1] >>> 0], [1, 0]);
export const sub = (a, b) => add(a, neg(b));
export const highestBit = a => a[1] ? 63-Math.clz32(a[1]) : 31-Math.clz32(a[0]);
export function mul(a, b) {
  const a0 = a & 65535, a1 = a >>> 16, b0 = b & 65535, b1 = b >>> 16;
  const p = a0 * b0, t = a1 * b0 + (p >>> 16), t0 = t & 65535, t1 = a0 * b1 + t0;
  return [((t1 << 16) | (p & 65535)) >>> 0, (a1 * b1 + (t >>> 16) + (t1 >>> 16)) >>> 0];
}
export function mulSmall(a, n) { const low = mul(a[0], n); return [low[0], (low[1] + a[1] * n) >>> 0]; }
const count = (options, key, n = 1) => { if (options.stats) options.stats[key] = (options.stats[key] ?? 0) + n; };
function candidate(a, b, options) {
  const av = F(F(F(a[1]) * F(4294967296)) + F(a[0]));
  const bv = F(F(F(b[1]) * F(4294967296)) + F(b[0]));
  const q = F(av / bv);
  // Deliberately perturb by f32 ULPs to cover contraction/rounding uncertainty.
  const ulp = 2 ** (Math.floor(Math.log2(Math.max(q, 2 ** -126))) - 23);
  return options.estimate ? options.estimate(q) : F(q + (options.perturb ?? 0) * ulp);
}
export function energyDivExact(a, d) {
  if(d===0) return [0xffffffff,a[0]];
  let r = 0, q = 0;
  for (let i = highestBit(a); i >= 0; i--) {
    const bit = i >= 32 ? (a[1] >>> (i - 32)) & 1 : (a[0] >>> i) & 1;
    r = ((r << 1) | bit) >>> 0;
    if (r >= d) { r = (r - d) >>> 0; if (i < 32) q = (q | (1 << i)) >>> 0; }
  }
  return [q, r];
}
export function energyDiv(a, d, options = {}) {
  count(options, 'energyCalls');
  const fallback = () => { count(options, 'energyFallback'); count(options, 'bitIterations', d ? highestBit(a)+1 : 0); return energyDivExact(a, d); };
  if (d === 0 || a[1] >= d) return fallback();
  if (a[1] === 0) { count(options, 'energyU32'); return [Math.floor(a[0] / d), a[0] % d]; }
  if ((d & (d - 1)) === 0) {
    count(options, 'energyShift'); const shift = 31 - Math.clz32(d);
    return [((a[0] >>> shift) | (a[1] << (32 - shift))) >>> 0, (a[0] & (d - 1)) >>> 0];
  }
  count(options, 'energyEstimate');
  let q = Math.trunc(Math.max(0, Math.min(4294967040, candidate(a, [d, 0], options)))), product = mul(q, d);
  for (let attempt = 0; attempt < 4; attempt++) {
    count(options, 'correctionChecks');
    if (less(a, product)) { if (!q) break; q--; product = sub(product, [d, 0]); }
    else {
      const r = sub(a, product); if (!r[1] && r[0] < d) return [q, r[0]];
      if (q === 0xffffffff) break; q++; product = add(product, [d, 0]);
    }
  }
  return fallback();
}
export function phaseDivExact(a, b) {
  let q = [0, 0], r = [0, 0]; if (!(b[0] || b[1])) return q;
  for (let bit = highestBit(a); bit >= 0; bit--) {
    r = [(r[0] << 1) >>> 0, ((r[1] << 1) | (r[0] >>> 31)) >>> 0];
    const incoming = bit >= 32 ? (a[1] >>> (bit - 32)) & 1 : (a[0] >>> bit) & 1;
    r[0] = (r[0] | incoming) >>> 0;
    if (!less(r, b)) { r = sub(r, b); const word = bit >= 32 ? 1 : 0; q[word] = (q[word] | (1 << (bit % 32))) >>> 0; }
  }
  return q;
}
export function phaseDiv(a, b, options = {}) {
  count(options, 'phaseCalls');
  if (!(b[0] || b[1]) || less(a, b)) { count(options, 'phaseZero'); return [0, 0]; }
  if (!b[1] && (b[0] & (b[0] - 1)) === 0) {
    count(options, 'phaseShift'); if (b[0] === 1) return a;
    const shift = 31 - Math.clz32(b[0]);
    return [((a[0] >>> shift) | (a[1] << (32 - shift))) >>> 0, a[1] >>> shift];
  }
  if (!b[1] && b[0] <= 0x80000000) {
    count(options, 'phaseLimbs');
    const high = Math.floor(a[1] / b[0]), rem = a[1] % b[0];
    if (b[0] <= 65536) {
      count(options, 'phaseU16');
      const middle = ((rem << 16) | (a[0] >>> 16)) >>> 0;
      const low = (((middle % b[0]) << 16) | (a[0] & 65535)) >>> 0;
      return [((Math.floor(middle / b[0]) << 16) | Math.floor(low / b[0])) >>> 0, high];
    }
    return [energyDiv([a[0], rem], b[0], options)[0], high];
  }
  if (!b[0] && (b[1] & (b[1] - 1)) === 0) { count(options, 'phaseShift'); return [a[1] >>> (31 - Math.clz32(b[1])), 0]; }
  if (b[1] <= 65535) {
    const estimate = candidate(a, b, options);
    if (estimate < 65536) {
      count(options, 'phaseEstimate');
      let q = Math.trunc(Math.max(estimate, 0)), product = mulSmall(b, q);
      for (let attempt = 0; attempt < 4; attempt++) {
        count(options, 'correctionChecks');
        if (less(a, product)) { if (!q) break; q--; product = sub(product, b); }
        else { if (less(sub(a, product), b)) return [q, 0]; if (q === 65535) break; q++; product = add(product, b); }
      }
    }
  }
  count(options, 'phaseFallback'); count(options, 'bitIterations', highestBit(a)+1); return phaseDivExact(a, b);
}
export function energyScale(e, n, d, options = {}) {
  if (!d || !n) return [0, 0]; if (n === d) return e;
  const negative = !!(e[1] & 0x80000000), magnitude = negative ? neg(e) : e, qr = energyDiv(magnitude, d, options);
  const scaled = add(mul(qr[0], n), [energyDiv(mul(qr[1], n), d, options)[0], 0]);
  return negative ? neg(scaled) : scaled;
}
export function energyShare(e, prefix, n, d, options = {}) {
  if (!d || !n || !(e[0] || e[1])) return [0, 0]; if (!prefix && n === d) return e;
  const negative = !!(e[1] & 0x80000000), magnitude = negative ? neg(e) : e;
  if (magnitude[1] >= d) return sub(energyScale(e, prefix + n, d, options), energyScale(e, prefix, d, options));
  const qr = energyDiv(magnitude, d, options);
  let tail = 0;
  if (qr[1]) {
    tail = qr[1];
    if (prefix + n !== d) tail = energyDiv(mul(qr[1], prefix + n), d, options)[0];
    if (prefix !== 0) tail -= energyDiv(mul(qr[1], prefix), d, options)[0];
  }
  const packet = add(mul(qr[0], n), [tail, 0]); return negative ? neg(packet) : packet;
}
export function shareUnsigned(total, prefix, n, fill, options = {}) {
  if (!fill || !total || !n) return 0;
  return energyDiv(mul(total, prefix + n), fill, options)[0] - energyDiv(mul(total, prefix), fill, options)[0];
}
