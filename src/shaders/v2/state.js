import { ELEMENTS } from '../../elements.js';
import { capacityPerQuantum, AIR_CAPACITY_Q, FULL, MAX_FILL, FUEL_Q } from '../../v2/layout.js';

// No additional table binding: these immutable format tables are shared by every family.
export const nativeStateWGSL = /* wgsl */ `
const MATERIAL_CAP = array<u32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${capacityPerQuantum(e.id)}u`).join(',')});
const MATERIAL_LIFE = array<u32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${Math.round((e.life ?? 0) * FUEL_Q)}u`).join(',')});
const MATERIAL_CONDUCTS = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(!!e.conducts)).join(',')});
const MAX_FILL: u32 = ${MAX_FILL}u;
const FUEL_Q: f32 = ${FUEL_Q}.0;
struct Material { core: vec4u, bank: i32 }
fn capacityPerQuantum(id: u32) -> u32 { return MATERIAL_CAP[id]; }
fn conductsNative(id: u32) -> bool { return MATERIAL_CONDUCTS[id]; }
fn capacityQ(c: vec4u) -> u32 {
  var n = ${FULL}u;
  if (cid(c) == 0u) { n = 0u; } else if (isLiq(c)) { n = cFill(c); }
  return ${AIR_CAPACITY_Q}u + n * capacityPerQuantum(cid(c));
}
// Signed 64-bit energy in two u32 limbs (WebGPU has no portable i64).
fn energyAdd(a: vec2u, b: vec2u) -> vec2u { let lo = a.x + b.x; return vec2u(lo, a.y + b.y + select(0u, 1u, lo < a.x)); }
fn energyNeg(a: vec2u) -> vec2u { return energyAdd(~a, vec2u(1u, 0u)); }
fn energySub(a: vec2u, b: vec2u) -> vec2u { return energyAdd(a, energyNeg(b)); }
fn energySigned(a: i32) -> vec2u { return vec2u(bitcast<u32>(a), select(0u, 0xffffffffu, a < 0)); }
fn energyMul(a: u32, b: u32) -> vec2u {
  let a0 = a & 65535u; let a1 = a >> 16u; let b0 = b & 65535u; let b1 = b >> 16u;
  let p = a0 * b0; let t = a1 * b0 + (p >> 16u); let t0 = t & 65535u;
  let t1 = a0 * b1 + t0;
  return vec2u((t1 << 16u) | (p & 65535u), a1 * b1 + (t >> 16u) + (t1 >> 16u));
}
// Positive dividend, divisor <= 2^31; returns quotient low word and exact remainder.
fn energyDiv(a: vec2u, d: u32) -> vec2u {
  var r = 0u; var q = 0u;
  for (var i = 63; i >= 0; i--) {
    var bit = 0u;
    if (i >= 32) { bit = (a.y >> u32(i - 32)) & 1u; } else { bit = (a.x >> u32(i)) & 1u; }
    r = (r << 1u) | bit;
    if (r >= d) { r -= d; if (i < 32) { q |= 1u << u32(i); } }
  }
  return vec2u(q, r);
}
// Scale signed energy by n/d (0 <= n <= d), retaining all wide bits.
// The quotient is bounded by source energy per fill quantum (u32 here).
fn energyScale(e: vec2u, n: u32, d: u32) -> vec2u {
  if (d == 0u || n == 0u) { return vec2u(0u); }
  let negative = (e.y & 0x80000000u) != 0u;
  let magnitude = select(e, energyNeg(e), negative);
  let qr = energyDiv(magnitude, d);
  let scaled = energyAdd(energyMul(qr.x, n), vec2u(energyDiv(energyMul(qr.y, n), d).x, 0u));
  return select(scaled, energyNeg(scaled), negative);
}
fn energyShare(e: vec2u, prefix: u32, n: u32, d: u32) -> vec2u {
  return energySub(energyScale(e, prefix + n, d), energyScale(e, prefix, d));
}
fn energyOf(m: Material) -> vec2u { return energyAdd(energyMul(capacityQ(m.core), cTq(m.core)), energySigned(m.bank)); }
fn withEnergy(m: Material, e: vec2u) -> Material {
  var out = m; var tq = 0u;
  if ((e.y & 0x80000000u) == 0u) { tq = min(65535u, energyDiv(e, capacityQ(m.core)).x); }
  out.core.x = (m.core.x & 0xff0000ffu) | (tq << 8u);
  out.bank = bitcast<i32>(energySub(e, energyMul(capacityQ(m.core), tq)).x);
  return out;
}
fn ctypeOf(c: vec4u) -> u32 { if (isLiq(c)) { return c.y >> 24u; } return (c.y >> 16u) & 255u; }
fn withCtype(c: vec4u, ct: u32) -> vec4u { var o = c; if (isLiq(c)) { o.y = (c.y & 0xffffffu) | ((ct & 255u) << 24u); } else { o.y = (c.y & 0xff00ffffu) | ((ct & 255u) << 16u); } return o; }
fn payloadOf(c: vec4u) -> u32 { if (isLiq(c)) { return c.w >> 16u; } return c.y & 65535u; }
fn withPayload(c: vec4u, v: u32) -> vec4u { var o = c; if (isLiq(c)) { o.w = (c.w & 65535u) | (v << 16u); } else { o.y = (c.y & 0xffff0000u) | v; } return o; }
fn lifeOf(c: vec4u) -> f32 { return f32(payloadOf(c)) / FUEL_Q; }
fn withLife(c: vec4u, v: f32) -> vec4u { return withPayload(c, u32(clamp(round(v * FUEL_Q), 0.0, 65535.0))); }
fn sparkOf(c: vec4u) -> u32 { if (isLiq(c)) { return (c.w >> 16u) & 4095u; } return c.w & 4095u; }
fn withSpark(c: vec4u, code: u32) -> vec4u { var o = c; if (isLiq(c)) { o.w = (c.w & 0xf000ffffu) | ((code & 4095u) << 16u); } else { o.w = (c.w & 0xfffff000u) | (code & 4095u); } return o; }
fn makeMaterial(id: u32, temperature: f32, amount: u32, ct: u32) -> Material {
  let tq = u32(clamp(round((temperature + 273.25) * 4.0), 0.0, 65535.0));
  var c = vec4u(id | (tq << 8u), 0u, 0u, 0u);
  if (cls(id) == C_LIQUID) { c.y = min(amount, MAX_FILL) | (ct << 24u); } else { c.y = ct << 16u; }
  var life = MATERIAL_LIFE[id];
  if (cls(id) == C_LIQUID) { life = energyDiv(energyMul(life, min(amount, MAX_FILL)), ${FULL}u).x; }
  return Material(withPayload(c, life), 0);
}
`;
export const materialStorageWGSL = /* wgsl */ `
@group(2) @binding(4) var<storage, read_write> banks: array<i32>;
fn loadMaterial(slot: u32) -> Material { return Material(loadCore(slot), banks[slot]); }
fn storeMaterial(slot: u32, before: Material, after: Material) {
  noteVisible(cellOf(slot), before.core, after.core);
  if (any(before.core != after.core) || before.bank != after.bank) { noteState(slot); }
  storeCore(slot, after.core); banks[slot] = after.bank;
}
`;
