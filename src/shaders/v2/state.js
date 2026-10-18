import { phaseWGSL } from './phase.js';
import { ELEMENTS } from '../../elements.js';
import { capacityPerQuantum, AIR_CAPACITY_Q, FULL, MAX_FILL, FUEL_Q, lifeScale } from '../../v2/layout.js';

// No additional table binding: these immutable format tables are shared by every family.
export const nativeStateWGSL = /* wgsl */ `
const MATERIAL_CAP = array<u32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${capacityPerQuantum(e.id)}u`).join(',')});
const MATERIAL_LIFE = array<u32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${Math.round((e.life ?? 0) * lifeScale(e.id))}u`).join(',')});
const MATERIAL_LIFE_SCALE = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${lifeScale(e.id)}.0`).join(',')});
const MATERIAL_CONDUCTS = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.elec > 0)).join(',')});
const MATERIAL_BURNS = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.burnRate > 0)).join(',')});
const MAX_FILL: u32 = ${MAX_FILL}u;
const FUEL_Q: f32 = ${FUEL_Q}.0;
struct Material { core: vec4u, bank: i32 }
${phaseWGSL}
fn materialAmount(c: vec4u) -> u32 { if (cid(c) == 0u) { return 0u; } if (isLiq(c)) { return cFill(c); } return 65536u; }
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
fn energyDivExact(a: vec2u, d: u32) -> vec2u {
  if (d == 0u) { return vec2u(0xffffffffu, a.x); }
  var r = 0u; var q = 0u;
  // Leading zero bits contribute nothing; a data-dependent bound also avoids
  // expanding 64 rounds at each inlined thermal conversion during compilation.
  var top = 31 - i32(countLeadingZeros(a.x));
  if (a.y != 0u) { top = 63 - i32(countLeadingZeros(a.y)); }
  for (var i = top; i >= 0; i--) {
    var bit = 0u;
    if (i >= 32) { bit = (a.y >> u32(i - 32)) & 1u; } else { bit = (a.x >> u32(i)) & 1u; }
    r = (r << 1u) | bit;
    if (r >= d) { r -= d; if (i < 32) { q |= 1u << u32(i); } }
  }
  return vec2u(q, r);
}
// Unsigned limb comparison (phaseLess is signed).
fn energyLess(a: vec2u, b: vec2u) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn energyDiv(a: vec2u, d: u32) -> vec2u {
  // Preserve the original low-word quotient contract, including d==0, outside
  // the bounded-quotient domain. The exact fallback supports d <= 2^31.
  if (d == 0u || a.y >= d) { return energyDivExact(a, d); }
  if (a.y == 0u) { return vec2u(a.x / d, a.x % d); }
  if ((d & (d - 1u)) == 0u) {
    let shift = firstTrailingBit(d); // hi<d and hi!=0 imply 1<=shift<=31.
    return vec2u((a.x >> shift) | (a.y << (32u - shift)), a.x & (d - 1u));
  }
  // A float is only a candidate, NEVER the result. Clamp below 2^32 before
  // conversion (the greatest f32 below 2^32 is 2^32-256). Four corrections
  // bound work even with backend rounding/FMA differences or huge quotients.
  var q = u32(clamp((f32(a.y) * 4294967296.0 + f32(a.x)) / f32(d), 0.0, 4294967040.0));
  var product = energyMul(q, d); // u32*u32 always fits u64.
  for (var attempt = 0u; attempt < 4u; attempt++) {
    if (energyLess(a, product)) {
      if (q == 0u) { break; }
      q--; product = energySub(product, vec2u(d, 0u));
    } else {
      let r = energySub(a, product);
      if (r.y == 0u && r.x < d) { return vec2u(q, r.x); }
      if (q == 0xffffffffu) { break; }
      q++; product = energyAdd(product, vec2u(d, 0u));
    }
  }
  return energyDivExact(a, d);
}
// Scale signed energy by n/d (0 <= n <= d), retaining all wide bits.
// The quotient is bounded by source energy per fill quantum (u32 here).
fn energyScale(e: vec2u, n: u32, d: u32) -> vec2u {
  if (d == 0u || n == 0u) { return vec2u(0u); }
  if (n == d) { return e; }
  let negative = (e.y & 0x80000000u) != 0u;
  let magnitude = select(e, energyNeg(e), negative);
  let qr = energyDiv(magnitude, d);
  let scaled = energyAdd(energyMul(qr.x, n), vec2u(energyDiv(energyMul(qr.y, n), d).x, 0u));
  return select(scaled, energyNeg(scaled), negative);
}
fn energyShare(e: vec2u, prefix: u32, n: u32, d: u32) -> vec2u {
  if (d == 0u || n == 0u || all(e == vec2u(0u))) { return vec2u(0u); }
  if (prefix == 0u && n == d) { return e; }
  let negative = (e.y & 0x80000000u) != 0u;
  let magnitude = select(e, energyNeg(e), negative);
  // Out-of-domain quotients keep the original scale behavior.
  if (magnitude.y >= d) { return energySub(energyScale(e, prefix + n, d), energyScale(e, prefix, d)); }
  let qr = energyDiv(magnitude, d);
  // floor(E*(p+n)/d)-floor(E*p/d) = q*n + the remainder shares.
  var tail = 0u;
  if (qr.y != 0u) {
    tail = qr.y;
    if (prefix + n != d) { tail = energyDiv(energyMul(qr.y, prefix + n), d).x; }
    if (prefix != 0u) { tail -= energyDiv(energyMul(qr.y, prefix), d).x; }
  }
  let packet = energyAdd(energyMul(qr.x, n), vec2u(tail, 0u));
  return select(packet, energyNeg(packet), negative);
}
fn energyOf(m: Material) -> vec2u {
  let amount = materialAmount(m.core); let id = cid(m.core);
  let sensible = energyAdd(energyMul(capacityQ(m.core), cTq(m.core)), energySigned(m.bank));
  return energyAdd(sensible, energyAdd(phaseMaterialOffsetEnergy(id, amount, ctypeOf(m.core)), phaseLatentEnergy(id, cRawTq(m.core), amount)));
}
fn withEnergy(m: Material, e: vec2u) -> Material { return encodeMaterialEnergy(m,e,capacityQ(m.core),0u); }
fn packetCapacityQ(c: vec4u) -> u32 { return capacityQ(c) - 65536u; }
fn packetOwnedEnergy(m: Material) -> vec2u { return energySub(energyOf(m),energyMul(65536u,cTq(m.core))); }
fn withPacketEnergy(m: Material, e: vec2u) -> Material { return encodeMaterialEnergy(m,e,packetCapacityQ(m.core),ctypeOf(m.core)); }
fn packetEnergyFits(m: Material, e: vec2u) -> bool { return all(packetOwnedEnergy(withPacketEnergy(m,e)) == e); }
fn encodeMaterialEnergy(m: Material, e: vec2u, capacity: u32, phaseCtype: u32) -> Material {
  var out = m; let id = cid(m.core); let amount = materialAmount(m.core);
  let phase = phaseEncodeCapacity(id, amount, e, capacity, phaseCtype);
  var tq = phase.x; var bank = phase.y;
  if (tq == 0xffffffffu) {
    let sensible = energySub(e, phaseMaterialOffsetEnergy(id, amount, ctypeOf(m.core))); tq = 0u;
    if ((sensible.y & 0x80000000u) == 0u && capacity != 0u) { tq = min(41093u, energyDiv(sensible, capacity).x); }
    bank = energySub(sensible, energyMul(capacity, tq)).x;
  }
  out.core.x = (m.core.x & 0xff0000ffu) | (tq << 8u);
  out.bank = bitcast<i32>(bank);
  return out;
}
// Call before committing a transfer/rule: an extreme signed bank is allowed,
// but a sum outside the format must remain at its source, never truncate.
fn energyFits(m: Material, e: vec2u) -> bool {
  let id = cid(m.core); let amount = materialAmount(m.core); let capacity = capacityQ(m.core);
  // Grid latent encoding uses ctype=0, unlike packet encoding. Check plateaus
  // first: cold STEAM can extend below the normal interval. The CPU admission
  // proof checks every row/fill: latent bucket residuals and capacity fit i32,
  // latent*PHASE_STEPS fits u64, and latent-bearing offsets ignore ctype.
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
}
struct EnergyBounds { lo: vec2u, hi: vec2u }
// This affine interval contains all supported liquid plateaus. Restricting
// a tagged receiver to its plateau incorrectly dams hot/cold arrivals.
fn energyBounds(c: vec4u, amount: u32) -> EnergyBounds {
  let id = cid(c); let capacity = 65536u + amount * capacityPerQuantum(id);
  let offset = phaseMaterialOffsetEnergy(id, amount, ctypeOf(c));
  return EnergyBounds(energyAdd(offset, energySigned(-2147483648)),
    energyAdd(energyAdd(offset, energyMul(capacity, 41093u)), energySigned(2147483647)));
}
fn energyPacketFits(src: Material, dst: Material, packet: vec2u, n: u32) -> bool {
  var receiver = dst.core;
  if (cid(receiver) == 0u) { receiver.x = (receiver.x & 0xffffff00u) | cid(src.core); receiver.y = ctypeOf(src.core) << 24u; }
  let amount = materialAmount(dst.core);
  let b = energyBounds(receiver, amount); let next = energyBounds(receiver, amount + n);
  let dry = energyBounds(receiver, 0u); let carrier = energyMul(65536u, cTq(dst.core));
  let e = energyOf(dst);
  // Other faces may drain the receiver this pass. Reserve only headroom that
  // exists both before and after complete drainage, not outgoing heat twice.
  let currentLo = energySub(e, b.lo); let dryLo = energySub(carrier, dry.lo);
  let currentHi = energySub(b.hi, e); let dryHi = energySub(dry.hi, carrier);
  let roomLo = select(currentLo, dryLo, phaseLess(dryLo, currentLo));
  let roomHi = select(currentHi, dryHi, phaseLess(dryHi, currentHi));
  let excessLo = energySub(packet, energySub(next.lo, b.lo));
  let excessHi = energySub(packet, energySub(next.hi, b.hi));
  if (phaseLess(excessLo, vec2u(0u)) && phaseLess(roomLo, phaseMulSmall(energyNeg(excessLo), 6u))) { return false; }
  if (phaseLess(vec2u(0u), excessHi) && phaseLess(roomHi, phaseMulSmall(excessHi, 6u))) { return false; }
  return true;
}
fn ctypeOf(c: vec4u) -> u32 { if (isLiq(c)) { return (c.y >> 24u) & select(255u, 127u, MATERIAL_BURNS[cid(c)]); } return (c.y >> 16u) & 255u; }
fn withCtype(c: vec4u, ct: u32) -> vec4u { var o = c; if (isLiq(c)) {
  let mask = select(255u, 127u, MATERIAL_BURNS[cid(c)]);
  o.y = (c.y & ~(mask << 24u)) | ((ct & mask) << 24u);
} else { o.y = (c.y & 0xff00ffffu) | ((ct & 255u) << 16u); } return o; }
fn payloadOf(c: vec4u) -> u32 { if (isLiq(c)) { return c.w >> 16u; } return c.y & 65535u; }
fn withPayload(c: vec4u, v: u32) -> vec4u { var o = c; if (isLiq(c)) { o.w = (c.w & 65535u) | (v << 16u); } else { o.y = (c.y & 0xffff0000u) | v; } return o; }
fn lifeOf(c: vec4u) -> f32 { return f32(payloadOf(c)) / MATERIAL_LIFE_SCALE[cid(c)]; }
fn withLife(c: vec4u, v: f32) -> vec4u { return withPayload(c, u32(clamp(round(v * MATERIAL_LIFE_SCALE[cid(c)]), 0.0, 65535.0))); }
fn sparkOf(c: vec4u) -> u32 { if (isLiq(c)) { return (c.w >> 16u) & 4095u; } return c.w & 4095u; }
fn withSpark(c: vec4u, code: u32) -> vec4u { var o = c; if (isLiq(c)) { o.w = (c.w & 0xf000ffffu) | ((code & 4095u) << 16u); } else { o.w = (c.w & 0xfffff000u) | (code & 4095u); } return o; }
fn makeMaterial(id: u32, temperature: f32, amount: u32, ct: u32) -> Material {
  let tq = u32(clamp(round((temperature + 273.25) * 4.0), 0.0, 41093.0));
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
