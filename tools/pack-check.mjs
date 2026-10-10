// CPU check of the packed state's arithmetic (src/shaders/common.js PACK,
// packGLSL, unpackA/unpackB), mirrored in float32 (Math.fround). It proves
// what the D7 rules ask of the packing:
//   - a decoded velocity packs back to the same velocity (every exponent, and
//     every magnitude code of each component beside a spread of the others,
//     every sign), and every finite half packs back to itself under either
//     rounding a GPU's packHalf2x16 may use (to nearest or toward zero);
//   - zero packs to zero;
//   - the velocity's exponent is the smallest that holds its largest
//     component, so that one keeps its 8 significant bits;
//   - stochastic rounding is unbiased: a value between two codes or halves
//     packs to the upper one with probability equal to its distance from the
//     lower one in steps, so the expected value is the value (at creeping speeds a velocity
//     component never packs across REST_V);
//   - ctype + seed decodes and packs back exactly for every ctype its field
//     holds (element ids, a cloud's charge, a conductor's spark: up to
//     SPARK_CTYPE_MAX) and every seed, and every rule's largest ctype fits.
// usage: node tools/pack-check.mjs
import { PACK, SPARK_CTYPE_MAX, VEL_GUARD_KMAX } from '../src/shaders/common.js';
import { PHYS } from '../src/physics.js';
import { ELEMENTS } from '../src/elements.js';

const f = Math.fround;
const fails = [];
const check = (ok, what) => { if (!ok && fails.length < 20) fails.push(what); return ok; };

// ---- half precision (IEEE binary16), both roundings packHalf2x16 may use
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
function toHalf(x, nearest) {
  F32[0] = x;
  const u = U32[0], sign = (u >>> 16) & 0x8000, e = (u >>> 23) & 0xff, m = u & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  const ue = e - 127 + 15;                   // unbiased exponent re-biased for half
  if (ue >= 0x1f) return sign | 0x7c00;      // overflow
  let mant, exp, shift;
  if (ue <= 0) {                             // subnormal half
    if (ue < -10) return sign;
    mant = m | 0x800000; shift = 14 - ue; exp = 0;
  } else { mant = m; shift = 13; exp = ue; }
  let h = (exp << 10) | (mant >>> shift);
  const rest = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
  if (nearest && (rest > half || (rest === half && (h & 1)))) h++;
  return sign | h;
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
// packHalfSR (common.js), with r uniform in [0, 1)
function packHalfSR(x, r, nearest) {
  const h = toHalf(x, nearest), y = fromHalf(h);
  if (y === x) return h;
  const h2 = (y < x) === (x >= 0) ? h + 1 : h - 1;
  return r < f((x - y) / f(fromHalf(h2) - y)) ? h2 : h;
}

// ---- velocity codes (three magnitudes sharing an exponent: unpackVel, packVel)
const MANT_BITS = PACK.VEL_MANT_BITS, MANT_MAX = 2 ** MANT_BITS - 1, SIGN_SHIFT = 3 * MANT_BITS, EXP_SHIFT = SIGN_SHIFT + 3;
const V = f(PHYS.V_MAX), REST_V = f(PHYS.REST_V);
const KMAX = Math.ceil(Math.log2(PHYS.V_MAX / MANT_MAX)), KMIN = KMAX - (2 ** PACK.VEL_EXP_BITS - 1);
const pow2i = (k) => 2 ** k;   // exact in float32 for these k (normal exponents)
function decodeVel(w) {
  const k = (w >>> EXP_SHIFT) + KMIN;
  return [0, 1, 2].map((i) => f(((w >>> (SIGN_SHIFT + i)) & 1 ? -1 : 1) * ((w >>> (i * MANT_BITS)) & MANT_MAX) * pow2i(k)));
}
// the exponent's scale for a largest magnitude top > 0 (packVel)
function scaleOf(top) {
  let k = Math.min(Math.max(Math.ceil(Math.log2(f(top / MANT_MAX))), KMIN), KMAX);
  if (k > KMIN && top <= f(MANT_MAX * pow2i(k - 1))) k--;
  else if (top > f(MANT_MAX * pow2i(k))) k++;
  return k;
}
// packVel with the random numbers rs (one per component)
function packVel(v, rs) {
  const a = v.map((c) => Math.min(Math.abs(c), V)), top = Math.max(...a);
  if (top === 0) return 0;
  const k = scaleOf(top);
  let w = (k - KMIN) << EXP_SHIFT;
  for (let i = 0; i < 3; i++) {
    const x = f(a[i] * pow2i(-k));
    let m = Math.floor(x);
    if (rs[i] < f(x - m)) m += 1;
    if (k <= VEL_GUARD_KMAX && (a[i] >= REST_V) !== (m >= f(REST_V * pow2i(-k)))) m = a[i] >= REST_V ? Math.ceil(x) : Math.floor(x);   // creeping: never across REST_V
    w |= m << (i * MANT_BITS);
    if (v[i] < 0 && m > 0) w |= 1 << (SIGN_SHIFT + i);
  }
  return w >>> 0;
}
const same = (u, v) => u.every((c, i) => c === v[i]);
const RS = [[0, 0, 0], [0.5, 0.5, 0.5], [0.999999, 0.999999, 0.999999], [0, 0.999999, 0.3]];

// 1. decoded velocities pack back to themselves; zero to 0; V_MAX is a code
const OTHERS = [0, 1, 2, MANT_MAX >> 1, (MANT_MAX >> 1) + 1, MANT_MAX - 1, MANT_MAX];
let velCodes = 0;
for (let e = 0; e < 2 ** PACK.VEL_EXP_BITS; e++) {
  for (let i = 0; i < 3; i++) {
    for (let m = 0; m <= MANT_MAX; m++) {
      for (const o1 of OTHERS) for (const o2 of OTHERS) for (let sg = 0; sg < 8; sg++) {
        const ms = [o1, o2]; ms.splice(i, 0, m);
        const w = ((e << EXP_SHIFT) | (sg << SIGN_SHIFT) | ms[0] | (ms[1] << MANT_BITS) | (ms[2] << (2 * MANT_BITS))) >>> 0;
        const v = decodeVel(w);
        if (Math.max(...v.map(Math.abs)) > PHYS.V_MAX) continue;   // past V_MAX: clamped, never stored
        velCodes++;
        for (const rs of RS) {
          const back = decodeVel(packVel(v, rs));
          if (!check(same(back, v), `velocity code 0x${w.toString(16)} (${v}) packs to ${back} (rs ${rs})`)) break;
        }
      }
    }
  }
}
check(packVel([0, 0, 0], [0.999999, 0.999999, 0.999999]) === 0 && packVel([-0, 0, -0], [0, 0, 0]) === 0, 'velocity 0 packs to code 0');
check(same(decodeVel(packVel([PHYS.V_MAX, -PHYS.V_MAX, 0], [0.5, 0.5, 0.5])), [V, -V, 0]), 'V_MAX packs exactly');
check(pow2i(KMIN) < PHYS.REST_V / 1e6, `the finest step (${pow2i(KMIN)}) is far below REST_V`);

// 2. the exponent is the smallest that holds the largest component, and
// rounding is unbiased: each component rounds up exactly when r < p, p its
// distance from the step below in steps, so the expected value is the value;
// except that at creeping speeds a component never rounds across REST_V
let maxBiasV = 0, vecs = 0, guarded = 0;
const rng = ((s) => () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(12345);
for (let n = 0; n < 20000; n++) {
  const v = [0, 1, 2].map(() => (rng() < 0.15 ? 0 : f(Math.exp(-22 + rng() * 22) * PHYS.V_MAX * (rng() < 0.5 ? -1 : 1))));   // 0 or ±3e-10 … ±V_MAX
  const a = v.map(Math.abs), top = Math.max(...a);
  if (top === 0) continue;
  vecs++;
  const k = scaleOf(top);
  check(top <= MANT_MAX * pow2i(k) && (k === KMIN || top > MANT_MAX * pow2i(k - 1)), `velocity ${v}: exponent ${k} isn't the smallest holding ${top}`);
  for (let i = 0; i < 3; i++) {
    const x = a[i] * pow2i(-k), lo = Math.floor(x), p = f(x - lo);
    if (p === 0) continue;
    const pick = (r) => { const rs = [0.5, 0.5, 0.5]; rs[i] = r; return decodeVel(packVel(v, rs))[i]; };
    const s = v[i] < 0 ? -1 : 1, up = f(s * (lo + 1) * pow2i(k)), down = f(s * lo * pow2i(k));
    if (k <= VEL_GUARD_KMAX && lo * pow2i(k) < REST_V && (lo + 1) * pow2i(k) >= REST_V) {   // creeping, the step straddling REST_V: its own side
      guarded++;
      const own = a[i] >= REST_V ? up : (down || 0);
      check(pick(0) === own && pick(0.9999999) === own, `velocity ${v} component ${i}: rounds across REST_V`);
      continue;
    }
    check(pick(Math.max(0, p - 1e-6)) === up && pick(Math.min(0.9999999, p + 1e-6)) === (down || 0), `velocity ${v} component ${i}: rounds up below p = ${p} and down above it`);
    maxBiasV = Math.max(maxBiasV, Math.abs(lo + p - x));
  }
}

// 3. halves round-trip, both roundings; zero and -0 stay
for (const nearest of [true, false]) {
  for (let h = 0; h < 0x10000; h++) {
    const e = (h >> 10) & 0x1f;
    if (e === 0x1f) continue;   // inf, NaN
    const x = fromHalf(h);
    for (const r of [0, 0.999999]) check(packHalfSR(x, r, nearest) === h, `half 0x${h.toString(16)} (${x}) packs to 0x${packHalfSR(x, r, nearest).toString(16)} (${nearest ? 'nearest' : 'toward zero'})`);
  }
}

// 4. half rounding is unbiased and lands on a neighbour, for values life and pressure take
let maxRelBiasH = 0;
const samples = [];
for (let k = 1; k < 4000; k++) samples.push(f(Math.exp(-14 + (k / 4000) * 21) * (k & 1 ? 1 : -1)));   // ±1e-6 … ±1e3
for (const nearest of [true, false]) {
  for (const x of samples) {
    const h = toHalf(x, nearest), y = fromHalf(h);
    if (y === x) continue;
    const h2 = (y < x) === (x >= 0) ? h + 1 : h - 1, y2 = fromHalf(h2);
    check((x - y) * (x - y2) < 0, `half rounding of ${x}: ${y} and ${y2} don't bracket it`);
    const p = f((x - y) / f(y2 - y));
    const expect = y + p * (y2 - y);
    maxRelBiasH = Math.max(maxRelBiasH, Math.abs(expect - x) / Math.abs(y2 - y));
  }
}

// 5. ctype + seed, every ctype the field holds and every seed
const SEED_SCALE = 2 ** PACK.SEED_BITS, CTYPES = 2 ** PACK.CTYPE_BITS;
check(ELEMENTS.length <= 2 ** PACK.ID_BITS, `${ELEMENTS.length} elements, ${PACK.ID_BITS}-bit ids`);
check(Math.max(SPARK_CTYPE_MAX, PHYS.CHARGE_MAX, ELEMENTS.length - 1) < CTYPES, `ctype up to ${SPARK_CTYPE_MAX}, ${PACK.CTYPE_BITS}-bit field`);
let seeds = 0;
for (let ct = 0; ct < CTYPES; ct++) {
  for (let s = 0; s < SEED_SCALE; s++) {
    const w = f(ct + f(s / SEED_SCALE));            // unpackA's A.w
    const c2 = Math.floor(w), s2 = Math.trunc(f(f(w - c2) * SEED_SCALE));   // packState's fields
    if (!check(c2 === ct && s2 === s, `ctype ${ct} seed ${s}: A.w ${w} packs to ctype ${c2} seed ${s2}`)) break;
    seeds++;
  }
}

const stepAt = (sp) => pow2i(scaleOf(sp)) / sp;
console.log(`velocity: ${velCodes} codes pack back to their velocity, ${vecs} velocities round unbiased (bias at most ${maxBiasV.toExponential(1)} of a step; ${guarded} creeping components in the step straddling REST_V keep their side); steps ${(100 * stepAt(PHYS.REST_V)).toFixed(2)}% of the speed at REST_V, ${(100 * stepAt(PHYS.V_MAX)).toFixed(2)}% at V_MAX, finest ${pow2i(KMIN).toExponential(1)} cells/step`);
console.log(`halves: every finite half round-trips under both roundings; rounding bias at most ${maxRelBiasH.toExponential(1)} of a step`);
console.log(`ctype + seed: ${seeds} of ${CTYPES * SEED_SCALE} combinations round-trip (ctype up to ${CTYPES - 1}; rules write up to ${SPARK_CTYPE_MAX}); ids: ${ELEMENTS.length} of ${2 ** PACK.ID_BITS}`);
console.log(fails.length ? `FAILED:\n${fails.join('\n')}` : 'pack check OK');
process.exit(fails.length ? 1 : 0);
