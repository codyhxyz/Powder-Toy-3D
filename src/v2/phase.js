// Pure native phase/enthalpy ABI. No dependency on contact rules or foundation.
import { ELEMENTS, E, K } from '../elements.js';
import { PHYS } from '../physics.js';
export const PHASE_FULL = 65536;
export const PHASE_NORMAL_MAX = 41093;
export const PHASE_HOT_BASE = 41094;
export const PHASE_COLD_BASE = 53315;
export const PHASE_CODES = 12221;
export const PHASE_STEPS = PHASE_CODES - 1;
// Foundation capacityPerQuantum = round(cap*64); one cap·K is 256
// energy units per amount quantum. Persistent carrier is always FULL.
export const PHASE_ENERGY_PER_CAP_K = 256;
const q = T => Math.round((T + 273.25) * 4);
const cp = id => Math.max(1, Math.round(ELEMENTS[id].cap * 64));
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
const link = (a, b, T, latent) => { PHASE_ROWS[E[b]].offset = PHASE_ROWS[E[a]].offset + (cp(E[a]) - cp(E[b])) * q(T) + Math.round(latent * PHASE_ENERGY_PER_CAP_K); };
link('WATER', 'ICE', 0, -PHYS.L_FUSE);
link('WATER', 'STEAM', 100, PHYS.L_BOIL);
link('WATER', 'CLOUD', 100, 0);
link('CLOUD', 'SNOW', 0, -PHYS.L_FUSE);
link('MERCURY', 'SOLID_MERCURY', -38.83, -37);
link('MERCURY', 'MERCURY_VAPOR', 356.73, 955);
link('CO2', 'DRY_ICE', -78.5, -213.1);
export const phaseAmount = core => ELEMENTS[core[0] & 255].kind === K.LIQUID ? core[1] & 0xffffff : (core[0] & 255) === E.EMPTY ? 0 : PHASE_FULL;
export function phaseTemperatureQ(id, raw) {
  if (!Number.isInteger(raw) || raw < 0 || raw > 65535 || !PHASE_ROWS[id]) throw Error('invalid native temperature/id');
  if (raw <= PHASE_NORMAL_MAX) return raw;
  const row = PHASE_ROWS[id], hot = raw < PHASE_COLD_BASE;
  if ((hot ? row.hotLatent : row.coldLatent) <= 0) throw Error(`invalid phase tag for ${ELEMENTS[id].key}`);
  return hot ? row.hotQ : row.coldQ;
}
export function phaseOffsetEnergy(id, amount) { return BigInt(PHASE_ROWS[id].offset) * BigInt(amount); }
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
export function encodePhaseEnergy(id, amount, energy) {
  const row = PHASE_ROWS[id], capacity = BigInt(PHASE_FULL + amount * cp(id));
  const sensible = energy - phaseOffsetEnergy(id, amount);
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
export function validatePhaseCore(core) { phaseTemperatureQ(core[0] & 255, (core[0] >>> 8) & 65535); }
