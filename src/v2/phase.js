// Pure native phase/enthalpy ABI. No dependency on contact rules or foundation.
import { ELEMENTS, E, K } from '../elements.js';
import { PHYS } from '../physics.js';
const PHASE_FULL = 65536;
export const PHASE_NORMAL_MAX = 41093;
export const PHASE_HOT_BASE = 41094;
export const PHASE_COLD_BASE = 53315;
const PHASE_CODES = 12221;
export const PHASE_STEPS = PHASE_CODES - 1;
// One cap·K is 256 energy units per amount quantum (a ¼ K code: 64), so a whole cell of cap c holds
// c·PHASE_CAP_SCALE a code. Every cell keeps an air carrier, V1's air (elements.js EMPTY cap), and
// matter adds its cap over the carrier's: a whole cell is its element's V1 cap, to 1/PHASE_CAP_SCALE
// (TH-06; native format 3: format 2 rounded caps to 1/64 and its carrier was 1/64, air 0.78x V1's).
const PHASE_ENERGY_PER_CAP_K = 256;
export const PHASE_CAP_SCALE = 64 * PHASE_FULL;
export const PHASE_AIR_CAPACITY = Math.round(ELEMENTS[E.EMPTY].cap * PHASE_CAP_SCALE);
// Matter's cap over the carrier is kept to 1/1024 cap (PHASE_CAP_UNIT): its capacity holding `amount` is
// then ceil(amount·units / PHASE_UNIT_FILL) in u32s, and every formation offset a whole number of units.
export const PHASE_CAP_UNIT = PHASE_CAP_SCALE / 1024;
export const PHASE_UNIT_FILL = PHASE_FULL / PHASE_CAP_UNIT;
// Intentional (decided under the user's delegation, 2026-10-22): matter keeps at least 1/1024 cap over
// the carrier, so a flying packet (which owns no carrier) still holds heat. Gases at or under air's cap
// (hydrogen, mercury vapour, smoke at V1's 0.02) are air's plus that, 0.021 (mercury vapour 2.1x V1's).
export const PHASE_MIN_CAPACITY_DELTA = PHASE_CAP_UNIT;
// A whole cell's capacity over the carrier, in units and in energy a code, and a cell's holding `amount` (FULL a whole cell)
export const phaseCapacityUnits = id => id === E.EMPTY ? 0 : Math.max(1, Math.round((ELEMENTS[id].cap * PHASE_CAP_SCALE - PHASE_AIR_CAPACITY) / PHASE_CAP_UNIT));
export const phaseCapacityDelta = id => phaseCapacityUnits(id) * PHASE_CAP_UNIT;
export const phaseCapacity = (id, amount) => PHASE_AIR_CAPACITY + Math.floor((amount * phaseCapacityUnits(id) + PHASE_UNIT_FILL - 1) / PHASE_UNIT_FILL);
const q = T => Math.round((T + 273.25) * 4);
export const PHASE_ROWS = ELEMENTS.map(e => {
  let hot = e.hot, cold = e.cold;
  if (e.id === E.WATER || e.id === E.CLOUD) {
    hot = { T: 100, into: 'STEAM', latent: PHYS.L_BOIL, puff: 1700 };
    cold = { T: 0, into: e.id === E.CLOUD ? 'SNOW' : 'ICE', latent: PHYS.L_FUSE };
  }
  if (e.id === E.ICE || e.id === E.SNOW) hot = { T: 0, into: 'WATER', latent: PHYS.L_FUSE };
  if (e.id === E.STEAM) cold = { T: 100, into: 'WATER', latent: PHYS.L_BOIL };
  return { hot, cold, hotQ: hot ? q(hot.T) : 0, coldQ: cold ? q(cold.T) : 0,
    hotLatent: Math.round((hot?.latent ?? 0) * PHASE_ENERGY_PER_CAP_K),
    coldLatent: Math.round((cold?.latent ?? 0) * PHASE_ENERGY_PER_CAP_K), offset: 0 };
});
// A formation offset is exact a whole cell (an integer energy a FULL: the capacities' deltas are whole a
// FULL), so a whole cell changed at its transition's energy is at its code exactly, both ways round. A
// row keeps it as whole energy a quantum (offset, floored) and the rest a FULL (offsetRem, 0..FULL-1).
const OFFSET_FULL = PHASE_ROWS.map(() => 0);
const delta = phaseCapacityDelta;
const link = (a, b, T, latent) => { OFFSET_FULL[E[b]] = OFFSET_FULL[E[a]] + (delta(E[a]) - delta(E[b])) * q(T) + Math.round(latent * PHASE_ENERGY_PER_CAP_K) * PHASE_FULL; };
link('WATER', 'ICE', 0, -PHYS.L_FUSE);
link('WATER', 'STEAM', 100, PHYS.L_BOIL);
link('WATER', 'CLOUD', 100, 0);
link('CLOUD', 'SNOW', 0, -PHYS.L_FUSE);
link('MERCURY', 'SOLID_MERCURY', -38.83, -37);
link('MERCURY', 'MERCURY_VAPOR', 356.73, 955);
link('CO2', 'DRY_ICE', -78.5, -213.1);
// Irreversible single-product transitions still need a formation-energy zero:
// latent heat must not turn nitrogen's -196 C vapour into thousands-C air.
// Reversible families above are anchors. Weighted products intentionally keep
// one source enthalpy (selecting a different composition can change its T).
const anchors = new Set(['WATER','ICE','SNOW','CLOUD','STEAM','MERCURY','SOLID_MERCURY','MERCURY_VAPOR','CO2','DRY_ICE']);
for (let pass = 0; pass < ELEMENTS.length; pass++) {
  let changed = false;
  for (const e of ELEMENTS) {
    if (anchors.has(e.key)) continue;
    const row = PHASE_ROWS[e.id], hot = !!row.hot;
    const transition = row.hot ?? row.cold;
    if (!transition || typeof transition.into !== 'string' || transition.into === 'SAME' || transition.into === 'LAVA') continue;
    const product = E[transition.into];
    const offset = OFFSET_FULL[product] + (delta(product) - delta(e.id)) * q(transition.T)
      + (hot ? -row.hotLatent : row.coldLatent) * PHASE_FULL;
    if (offset !== OFFSET_FULL[e.id]) { OFFSET_FULL[e.id] = offset; changed = true; }
  }
  if (!changed) break;
  if (pass === ELEMENTS.length - 1) throw Error('inconsistent native phase formation-energy cycle');
}
const offsetFullOf = id => { if (!Number.isSafeInteger(OFFSET_FULL[id]) || OFFSET_FULL[id] % PHASE_CAP_UNIT !== 0) throw Error('native phase offset is not whole units'); return OFFSET_FULL[id]; };
PHASE_ROWS.forEach((row, id) => { row.offset = Math.floor(offsetFullOf(id) / PHASE_FULL); row.offsetRem = offsetFullOf(id) - row.offset * PHASE_FULL; row.offsetUnits = offsetFullOf(id) / PHASE_CAP_UNIT; });
export const phaseAmount = core => ELEMENTS[core[0] & 255].kind === K.LIQUID ? core[1] & 0xffffff : (core[0] & 255) === E.EMPTY ? 0 : PHASE_FULL;
export function phaseTemperatureQ(id, raw) {
  if (!Number.isInteger(raw) || raw < 0 || raw > 65535 || !PHASE_ROWS[id]) throw Error('invalid native temperature/id');
  if (raw <= PHASE_NORMAL_MAX) return raw;
  const row = PHASE_ROWS[id], hot = raw < PHASE_COLD_BASE;
  if ((hot ? row.hotLatent : row.coldLatent) <= 0) throw Error(`invalid phase tag for ${ELEMENTS[id].key}`);
  return hot ? row.hotQ : row.coldQ;
}
// A whole cell's offset (lava's from the element it melted from), and its whole energy a quantum and rest a FULL
export function phaseOffsetFull(id, ctype = 0) {
  if (id !== E.LAVA) return offsetFullOf(id);
  const source = ELEMENTS[ctype]?.melt > 0 ? ctype : E.STONE;
  return offsetFullOf(source) + (delta(source) - delta(E.LAVA)) * q(ELEMENTS[source].melt);
}
export const phaseOffsetPerQuantum = (id, ctype = 0) => Math.floor(phaseOffsetFull(id, ctype) / PHASE_FULL);
export const phaseOffsetRemainder = (id, ctype = 0) => phaseOffsetFull(id, ctype) - phaseOffsetPerQuantum(id, ctype) * PHASE_FULL;
export const phaseOffsetUnits = (id, ctype = 0) => phaseOffsetFull(id, ctype) / PHASE_CAP_UNIT;
// floor(amount · offset / FULL) = floor(amount · units / PHASE_UNIT_FILL): exact for a whole cell
export function phaseOffsetEnergy(id, amount, ctype = 0) {
  const n = BigInt(amount) * BigInt(phaseOffsetUnits(id, ctype)), d = BigInt(PHASE_UNIT_FILL);
  return n >= 0n ? n / d : -((-n + d - 1n) / d);
}
export const phaseMaterialOffsetEnergy = phaseOffsetEnergy;
export function phaseLatentEnergy(id, raw, amount) {
  phaseTemperatureQ(id, raw); // rejects invalid tags, including zero-latent types
  if (raw <= PHASE_NORMAL_MAX) return 0n;
  const hot = raw < PHASE_COLD_BASE, row = PHASE_ROWS[id];
  const index = raw - (hot ? PHASE_HOT_BASE : PHASE_COLD_BASE);
  const energy = BigInt(hot ? row.hotLatent : row.coldLatent) * BigInt(amount) * BigInt(index) / BigInt(PHASE_STEPS);
  return hot ? energy : -energy;
}
// Return an exact representable phase code+bank, or null for sensible energy.
// The final code includes the full threshold; the contact pass consumes it.
export function encodePhaseEnergy(id, amount, energy, capacity = BigInt(phaseCapacity(id, amount)), ctype = 0) {
  const row = PHASE_ROWS[id];
  const sensible = energy - phaseOffsetEnergy(id, amount, ctype);
  for (const hot of [true, false]) {
    const latent = BigInt(hot ? row.hotLatent : row.coldLatent) * BigInt(amount);
    if (latent <= 0n) continue;
    const threshold = capacity * BigInt(hot ? row.hotQ : row.coldQ);
    const progress = hot ? sensible - threshold : threshold - sensible;
    if (progress < 0n || progress > latent) continue;
    const index = Number(progress * BigInt(PHASE_STEPS) / latent);
    const encoded = latent * BigInt(index) / BigInt(PHASE_STEPS);
    const bank = Number(hot ? progress - encoded : encoded - progress);
    if (bank < -2147483648 || bank > 2147483647) throw Error('phase bank exceeds i32');
    return { raw: (hot ? PHASE_HOT_BASE : PHASE_COLD_BASE) + index, bank };
  }
  return null;
}
export function validatePhaseCore(core) {
  const id = core[0] & 255;
  phaseTemperatureQ(id, (core[0] >>> 8) & 65535);
  if (id === E.LAVA) {
    const source = core[1] >>> 24;
    // Zero is the historical painted-lava default (STONE). Other ctype values
    // must name an actual meltable source, not silently reinterpret a bad save.
    if (source !== 0 && !(ELEMENTS[source]?.melt > 0)) throw Error('invalid native lava source');
  }
}
