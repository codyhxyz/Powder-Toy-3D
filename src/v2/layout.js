import { phaseTemperatureQ, phaseOffsetEnergy, phaseLatentEnergy, encodePhaseEnergy, phaseAmount, PHASE_NORMAL_MAX } from './phase.js';
import { E, ELEMENTS, K } from '../elements.js';

// Native v2 format 2. Capacity is measured in 1/(64*FULL) water-cell units;
// one integer energy quantum is that capacity heated by one quarter kelvin.
// The ever-present air capacity makes uniform-temperature drainage leave warm air.
export const MATERIAL_VERSION = 2;
export const FULL = 65536;
export const MAX_FILL = 16 * FULL;
export const AIR_CAPACITY_Q = FULL;
export const FUEL_Q = 2048; // total fuel, not concentration; 16 full cells fit u16.
export const lifeScale = id => ELEMENTS[id]?.key === 'SINGULARITY' ? 256 : FUEL_Q;
export const capacityPerQuantum = id => Math.max(1, Math.round((ELEMENTS[id]?.cap ?? 1) * 64));
export const isLiquid = id => ELEMENTS[id]?.kind === K.LIQUID;
export const isConductor = id => (ELEMENTS[id]?.elec ?? 0) > 0;
export function validateMaterialTable(elements = ELEMENTS) {
  for (const e of elements) {
    if (e.kind === K.LIQUID && e.elec > 0 && (e.burnRate || e.burn || e.flammable || e.fuel || e.life > 0)) throw new Error(`native liquid payload collision: ${e.key}`);
    if (Math.max(1, Math.round((e.cap ?? 1) * 64)) * MAX_FILL + AIR_CAPACITY_Q > 0x7fffffff) throw new Error(`native capacity overflow: ${e.key}`);
  }
}
validateMaterialTable();
export const cid = c => c[0] & 255;
export const cRawTq = c => (c[0] >>> 8) & 65535;
export const cTq = c => phaseTemperatureQ(cid(c), cRawTq(c));
export const cFill = c => c[1] & 0xffffff;
export const payloadOf = c => isLiquid(cid(c)) ? c[3] >>> 16 : c[1] & 65535;
export const ctypeOf = c => isLiquid(cid(c)) ? (c[1] >>> 24) & ((ELEMENTS[cid(c)]?.burnRate ?? 0) > 0 ? 127 : 255) : (c[1] >>> 16) & 255;
export function capacityQ(c) {
  const id = cid(c);
  return AIR_CAPACITY_Q + (id === 0 ? 0 : isLiquid(id) ? cFill(c) : FULL) * capacityPerQuantum(id);
}
export const energyOf = m => BigInt(capacityQ(m.core)) * BigInt(cTq(m.core)) + phaseOffsetEnergy(cid(m.core), phaseAmount(m.core), ctypeOf(m.core)) + phaseLatentEnergy(cid(m.core), cRawTq(m.core), phaseAmount(m.core)) + BigInt(m.bank);
export function withEnergy(m, energy) { return encodeMaterialEnergy(m, energy, capacityQ(m.core)); }
// Flying material owns no stationary air carrier. Its signed bank and phase
// formation/latent energy travel with it; encoding must use that same capacity.
export const packetCapacityQ = core => capacityQ(core) - AIR_CAPACITY_Q;
export const packetOwnedEnergy = m => energyOf(m) - BigInt(AIR_CAPACITY_Q) * BigInt(cTq(m.core));
export const withPacketEnergy = (m, energy) => encodeMaterialEnergy(m, energy, packetCapacityQ(m.core), ctypeOf(m.core));
export function packetEnergyFits(m, energy) {
  try { return packetOwnedEnergy(withPacketEnergy(m, energy)) === energy; } catch { return false; }
}
function encodeMaterialEnergy(m, energy, capacity, phaseCtype = 0) {
  const id = cid(m.core), amount = phaseAmount(m.core), cap = BigInt(capacity);
  const phase = encodePhaseEnergy(id, amount, energy, cap, phaseCtype);
  const sensible = energy - phaseOffsetEnergy(id, amount, ctypeOf(m.core));
  const tq = phase?.raw ?? Number(sensible < 0n || cap === 0n ? 0n : sensible / cap > BigInt(PHASE_NORMAL_MAX) ? BigInt(PHASE_NORMAL_MAX) : sensible / cap);
  const bank = phase?.bank ?? Number(sensible - BigInt(tq) * cap);
  if (!Number.isInteger(bank) || bank < -2147483648 || bank > 2147483647) throw new RangeError('native energy bank overflow');
  const core = new Uint32Array(m.core);
  core[0] = (core[0] & 0xff0000ff) | (tq << 8);
  return { core, bank };
}

export function makeMaterial(id, temperature = 20, amount = FULL, ctype = 0) {
  const tq = Math.max(0, Math.min(PHASE_NORMAL_MAX, Math.round((temperature + 273.25) * 4)));
  if (isLiquid(id) && (!Number.isInteger(amount) || amount < 0 || amount > MAX_FILL)) throw new RangeError('native fill');
  const m = { core: new Uint32Array([id | tq << 8, isLiquid(id) ? amount | ctype << 24 : ctype << 16, 0, 0]), bank: 0 };
  return withPayload(m, Math.round((ELEMENTS[id]?.life ?? 0) * lifeScale(id) * (isLiquid(id) ? amount / FULL : 1)));
}
export function withPayload(m, payload) {
  if (!Number.isInteger(payload) || payload < 0 || payload > 65535) throw new RangeError('native payload');
  const core = new Uint32Array(m.core);
  if (isLiquid(cid(core))) core[3] = (core[3] & 65535) | payload << 16;
  else core[1] = (core[1] & 0xffff0000) | payload;
  return { core, bank: m.bank };
}
// Cumulative integer apportionment telescopes: no rounding loss, even when dry.
export const share = (total, before, amount, fill) => fill ? BigInt(total) * BigInt(before + amount) / BigInt(fill) - BigInt(total) * BigInt(before) / BigInt(fill) : 0n;
export function energyFits(m, e) { try { return energyOf(withEnergy(m, e)) === e; } catch { return false; } }
export function energyBounds(core, amount) {
  const id = cid(core), cap = BigInt(AIR_CAPACITY_Q + amount * capacityPerQuantum(id)), offset = phaseOffsetEnergy(id, amount, ctypeOf(core));
  // Every current liquid plateau lies inside this representable interval.
  // Restricting a tagged receiver to its plateau makes its drained headroom
  // zero and incorrectly dams ordinary hot/cold arrivals.
  return { lo: offset - 2147483648n, hi: offset + cap * BigInt(PHASE_NORMAL_MAX) + 2147483647n };
}
export function energyPacketFits(src, dst, packet, n) {
  const receiver = new Uint32Array(dst.core);
  if (!cid(receiver)) { receiver[0] = (receiver[0] & 0xffffff00) | cid(src.core); receiver[1] = ctypeOf(src.core) << 24; }
  const amount = phaseAmount(dst.core), b = energyBounds(receiver, amount), next = energyBounds(receiver, amount + n), dry = energyBounds(receiver, 0);
  const e = energyOf(dst), carrier = BigInt(AIR_CAPACITY_Q) * BigInt(cTq(dst.core));
  const min = (a, b) => a < b ? a : b;
  const roomLo = min(e - b.lo, carrier - dry.lo), roomHi = min(b.hi - e, dry.hi - carrier);
  const lo = packet - (next.lo - b.lo), hi = packet - (next.hi - b.hi);
  return !(lo < 0n && -lo * 6n > roomLo || hi > 0n && hi * 6n > roomHi);
}
export function advectReference(materials, transfers, gated = false) {
  const energy = materials.map(energyOf), fill = materials.map(m => isLiquid(cid(m.core)) ? cFill(m.core) : 0);
  const fuel = materials.map(m => isConductor(cid(m.core)) ? 0 : payloadOf(m.core));
  const spark = materials.map(m => isConductor(cid(m.core)) ? payloadOf(m.core) : 0);
  const prefix = materials.map(() => 0), ids = materials.map(m => cid(m.core)), ct = materials.map(m => ctypeOf(m.core));
  const strongest = materials.map(() => 0);
  const lavaClaim = materials.map(m => cid(m.core) === E.LAVA ? ctypeOf(m.core) : -1);
  for (const { from, to } of transfers) {
    if (!cid(materials[to].core) && cid(materials[from].core) === E.LAVA) lavaClaim[to] = Math.max(lavaClaim[to], ctypeOf(materials[from].core));
  }
  for (const { from, to, amount } of transfers) {
    const src = materials[from], n = cFill(src.core), start = prefix[from];
    if (start + amount > n) throw new RangeError('source overdraft');
    const carried = energyOf(src) - BigInt(AIR_CAPACITY_Q) * BigInt(cTq(src.core));
    const e = share(carried, start, amount, n);
    const f = Number(share(isConductor(cid(src.core)) ? 0 : payloadOf(src.core), start, amount, n));
    prefix[from] += amount;
    if (cid(src.core) === E.LAVA && ctypeOf(src.core) !== lavaClaim[to]) continue;
    if (gated && (!energyPacketFits(src, materials[to], e, amount) || f > Math.floor((65535 - payloadOf(materials[to].core)) / 6))) continue;
    energy[from] -= e; energy[to] += e; fill[from] -= amount; fill[to] += amount;
    fuel[from] -= f; fuel[to] += f;
    if (amount && isConductor(cid(src.core))) spark[to] = Math.max(spark[to], payloadOf(src.core));
    if (!ids[to]) ids[to] = cid(src.core);
    if (!cid(materials[to].core) && amount > strongest[to]) { ct[to] = ctypeOf(src.core); strongest[to] = amount; }
  }
  return materials.map((m, i) => {
    const core = new Uint32Array(m.core), id = fill[i] ? ids[i] : 0;
    core[0] = (core[0] & 0xffffff00) | id;
    core[1] = fill[i] ? fill[i] | ct[i] << 24 : 0;
    if (!fill[i]) core[3] &= 65535;
    let out = withEnergy({ core, bank: m.bank }, energy[i]);
    if (fill[i]) out = withPayload(out, isConductor(id) ? spark[i] : fuel[i]);
    return out;
  });
}
