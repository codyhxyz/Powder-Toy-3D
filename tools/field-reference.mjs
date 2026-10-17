// CPU-only quantized oracle. Arithmetic is f32 at each WGSL operation; unorm
// packing chooses nearest-even consistently for both partitions. GPU arithmetic
// agreement still needs a later guarded numerical capture (this is not one).
import { ELEMENTS, E } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { MATERIAL_FIELDS, CHANNELS, MEDIA, FIRE_BASE, HEAT_RANGE, THIN_MIN_PEAK, THIN_MASK_LO, THIN_MASK_HI } from '../src/gfx/materials.js';
import { fieldWeights } from '../src/gfx/fieldDeriver.js';
import { JOIN_REACH } from '../src/shaders/gfx/liquidDetail.js';

export const f = Math.fround;
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export function roundEven(x) { const lo = Math.floor(x), d = x - lo; return d < 0.5 ? lo : d > 0.5 ? lo + 1 : lo + (lo & 1); }
export function pack4(v) { return v.reduce((w, n, i) => (w | (roundEven(f(clamp(n) * 255)) << (8 * i))) >>> 0, 0); }
export function unpack4(w) { return [0, 8, 16, 24].map((s) => f(((w >>> s) & 255) / 255)); }
const bits = new DataView(new ArrayBuffer(4));
export function half(n) {
  bits.setFloat32(0, n, true); const b = bits.getUint32(0, true), sign = (b >>> 16) & 0x8000, e = (b >>> 23) & 255, m = b & 0x7fffff;
  if (e === 255) return sign | 0x7c00 | (m ? 0x200 : 0);
  if (e > 142) return sign | 0x7c00;
  if (e < 102) return sign;
  if (e < 113) return sign | roundEven((m | 0x800000) / 2 ** (126 - e));
  return sign | (((e - 112) << 10) + roundEven(m / 8192));
}
export function unhalf(w) {
  const s = (w & 0x8000) ? -1 : 1, e = (w >>> 10) & 31, m = w & 1023;
  return e === 31 ? (m ? NaN : s * Infinity) : f(s * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24));
}
export const pack2 = (v) => (half(v[0]) | (half(v[1]) << 16)) >>> 0;
export const unpack2 = (w) => [unhalf(w & 65535), unhalf(w >>> 16)];
const mat = (name) => MATERIAL_FIELDS.find((m) => m.fn === name);
const ch = ELEMENTS.map((e) => mat('SURFCH').get(e)), md = ELEMENTS.map((e) => mat('MEDIACH').get(e)), haze = ELEMENTS.map((e) => mat('HAZE').get(e));
const mix = (a, b, t) => f(f(a * f(1 - t)) + f(b * t));
const fract = (a) => f(a - Math.floor(a));
export function validWake(a) {
  if (a.length !== 4 || a.some((v) => !Number.isFinite(v))) return false;
  return a[1] >= 0 || [a[0], a[2], a[3]].every((v) => Math.abs(v) <= 1);
}
export function jetAt(p, aerAt, active = true) {
  if (!active) return false;
  const a = aerAt(p);
  if (!validWake(a)) throw new Error('Unsupported aeration wake');
  if (a[1] > 1.5) return true;
  const v = [a[0], a[2], a[3]];
  const dot = f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
  if (a[1] >= 0 || dot < 0.5) return false;
  for (let k = 1; k <= JOIN_REACH; k++) if (aerAt(p.map((c, i) => c - roundEven(f(v[i] * k))))[1] > 1.5) return true;
  return false;
}
export function emaWords(a, jet, previous = null) {
  const id = Math.trunc(a[0]), channel = ch[id], medium = md[id], sv = [0, 0, 0, 0], m = [0, 0, 0, 0];
  if (channel >= 0) sv[channel] = id === E.STONE ? f(1 - f(f(0.45) * fract(f(fract(a[3]) * f(7.13))))) : 1;
  if (medium === 0) m[0] = clamp(a[2]);
  else if (medium === 1) m[1] = haze[id];
  else if (medium === 2) { m[2] = mix(f(FIRE_BASE), 1, clamp(a[2])); m[3] = f(m[2] * clamp(f(f(a[1] - f(PHYS.AMBIENT)) / HEAT_RANGE))); }
  if (previous) {
    const s0 = unpack4(previous[0]), m0 = unpack4(previous[1]);
    for (let i = 0; i < 4; i++) { sv[i] = mix(s0[i], sv[i], f(CHANNELS[i].ema)); m[i] = mix(m0[i], m[i], f(MEDIA[i].ema)); }
  }
  if (jet) sv[0] = 1;
  const crisp = id !== E.EMPTY && channel < 0 && medium < 0;
  const weight = [0, 1, 2, 3].map((i) => crisp || (i === 0 && channel > 0) ? 0 : 1);
  return [pack4(sv), pack4(m), pack4(weight)];
}

// Lazy, stage-by-stage evaluation lets fixtures exhaust boundary stencils
// without allocating a dense 384-tall world. Every in-world scratch access is
// checked, so accidental scratch-edge normalization cannot hide here.
export class QuantizedFields {
  constructor({ bounds, raw, aeration = () => [0, 0, 0, 0], history = null, smoothing = 1, scratchOrigin = null, scratchSize = 64, active = true, domainFor = null }) {
    Object.assign(this, { bounds, raw, aeration, history, scratchOrigin, scratchSize, active, domainFor });
    this.weights = fieldWeights(smoothing);
    this.cache = new Map();
  }
  inside(p) { return p.every((v, i) => v >= this.bounds.min[i] && v < this.bounds.max[i]); }
  access(p) {
    if (this.inside(p) && this.scratchOrigin && p.some((v, i) => v < this.scratchOrigin[i] || v >= this.scratchOrigin[i] + this.scratchSize)) throw new Error('Unavailable in-world scratch neighbor');
  }
  aer(p) { if (!this.inside(p)) return [0, 0, 0, 0]; this.access(p); return this.aeration(p).map((v) => unhalf(half(v))); }
  jet(p) { return jetAt(p, (q) => this.aer(q), this.active); }
  stage(name, p) {
    this.access(p);
    if (this.domainFor && this.scratchOrigin) {
      const interval = this.domainFor(name);
      if (p.some((v, i) => v - this.scratchOrigin[i] < interval.lo[i] || v - this.scratchOrigin[i] >= interval.hi[i])) throw new Error(`Outside demanded ${name} interval`);
    }
    if (!this.inside(p)) throw new Error('Stage requested outside world');
    const key = `${name}:${p}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let out;
    if (name === 'ema') out = emaWords(this.raw(p).map(f), this.jet(p), this.history?.(p));
    else if (name.startsWith('blur')) {
      const axis = +name[4], prev = axis ? `blur${axis - 1}` : 'ema', sv = [0, 0, 0, 0], m = [0, 0, 0, 0], d = [0, 0, 0, 0];
      for (let tap = 0; tap < 5; tap++) {
        const q = [...p]; q[axis] += tap - 2;
        if (!this.inside(q)) continue;
        const words = this.stage(prev, q), v = unpack4(words[0]), media = unpack4(words[1]), weight = unpack4(words[2]);
        for (let i = 0; i < 4; i++) {
          const w = f(this.weights.w[tap][i]);
          sv[i] = f(sv[i] + f(w * v[i])); m[i] = f(m[i] + f(f(this.weights.w[tap][0]) * media[i])); d[i] = f(d[i] + f(w * weight[i]));
        }
      }
      if (axis < 2) out = [pack4(sv), pack4(m), pack4(d)];
      else {
        const s = sv.map((v, i) => f(f((d[i] >= f(0.02) ? 1 : 0) * v) / Math.max(d[i], f(0.02))));
        const media = m.map((v) => f(f((d[0] >= f(0.02) ? 1 : 0) * v) / Math.max(d[0], f(0.02))));
        out = [pack2(s.slice(0, 2)), pack2(s.slice(2)), pack2(media.slice(0, 2)), pack2(media.slice(2))];
      }
    } else if (name.startsWith('boost')) {
      const axis = +name[5], prev = axis ? `boost${axis - 1}` : 'blur2', acc = [0, 0, 0, 0], occ = [0, 0, 0, 0];
      for (let tap = -1; tap <= 1; tap++) {
        const q = p.map((v, i) => clamp(v + (i === axis ? tap : 0), this.bounds.min[i], this.bounds.max[i] - 1));
        const words = this.stage(prev, q), phi = axis ? unpack4(words[0]) : [...unpack2(words[0]), ...unpack2(words[1])];
        for (let i = 0; i < 4; i++) {
          const w = tap ? f(0.5 * f(1 - f(this.weights.s[i]))) : f(this.weights.s[i]);
          acc[i] = f(acc[i] + f(w * phi[i]));
        }
        if (axis) { const o = unpack4(words[1]); for (let i = 0; i < 4; i++) occ[i] = Math.max(occ[i], o[i]); }
        else { const channel = ch[Math.trunc(this.raw(q)[0])]; if (channel >= 0) occ[channel] = 1; if (this.jet(q)) occ[0] = 1; }
      }
      out = [pack4(acc), pack4(occ)];
    } else if (name === 'peak') {
      const peak = [0, 0, 0, 0];
      for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        const q = [p[0] + x, p[1] + y, p[2] + z]; if (!this.inside(q)) continue;
        const a = unpack4(this.stage('boost2', q)[0]); for (let i = 0; i < 4; i++) peak[i] = Math.max(peak[i], a[i]);
      }
      const b = this.stage('blur2', p), phi = [...unpack2(b[0]), ...unpack2(b[1])], media = [...unpack2(b[2]), ...unpack2(b[3])], occ = unpack4(this.stage('boost2', p)[1]);
      const k = peak.map((v, i) => Math.max(1, f(f(this.weights.bulk[i]) / Math.max(v, f(THIN_MIN_PEAK)))));
      const surf = phi.map((v, i) => half(f(v * (occ[i] >= 0.5 ? k[i] : 1))));
      const thin = k.map((v, i) => { const t = clamp(f(f(v - f(THIN_MASK_LO)) / f(f(THIN_MASK_HI) - f(THIN_MASK_LO)))); return half(occ[i] >= 0.5 ? f(f(t * t) * f(3 - f(2 * t))) : 0); });
      out = [...surf, ...media.map(half), ...thin];
    } else throw new Error(`Unknown field reference stage ${name}`);
    this.cache.set(key, out); return out;
  }
}
