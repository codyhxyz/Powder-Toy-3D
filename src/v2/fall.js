import { ELEMENTS, K } from '../elements.js';
import { CELL_M } from '../scale.js';

// Native powder motion, still 16 bytes: z's sign marks the new format (including
// -0); its magnitude is downward m/s. Q15 remainder uses x[24..31], y[25..31].
// y[24] burning, life/ctype and all w seed/spark bits remain owned by material.
export const FALL_HZ = 60;
export const FALL_GRAVITY = 19.6; // TF2's 2g, as in R1.
export const FALL_Q = 32768;
export const FALL_QUANTIZATION_BOUND = 1 / FALL_Q; // cells per tick (floor encoding)
// Minecraft snow / Noita ash remain visibly slower than bulk grains.
export const fallTerminal = id => ELEMENTS[id]?.kind === K.POWDER ? ({ ASH: 3, SNOW: 3, SAWDUST: 4 }[ELEMENTS[id].key] ?? 12) : 0;
const bits = new DataView(new ArrayBuffer(4));
const toFloat = word => { bits.setUint32(0, word, true); return bits.getFloat32(0, true); };
const toWord = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };
export const hasFallVelocity = core => (core[2] & 0x80000000) !== 0;
export function fallVelocity(core) {
  if (ELEMENTS[core[0] & 255]?.kind !== K.POWDER) return 0;
  // Legacy saves have no historical gravity setting in each cell. Decode their
  // age once at the old nominal clock; never reinterpret marked velocity.
  return hasFallVelocity(core) ? -toFloat(core[2]) : Math.min((core[0] >>> 24) * FALL_GRAVITY / FALL_HZ, fallTerminal(core[0] & 255));
}
export function fallFraction(core) {
  return hasFallVelocity(core) ? ((core[0] >>> 24) | ((core[1] >>> 25) << 8)) / FALL_Q : toFloat(core[2]);
}
export function setFall(core, velocity, fraction) {
  if (!Number.isFinite(velocity) || velocity < 0 || !Number.isFinite(Math.fround(velocity))) throw new RangeError('Invalid native fall velocity');
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new RangeError('Invalid native fall fraction');
  const out = new Uint32Array(core), q = Math.min(FALL_Q - 1, Math.floor(Math.fround(fraction) * FALL_Q));
  out[0] = (out[0] & 0xffffff) | ((q & 255) << 24);
  out[1] = (out[1] & 0x1ffffff) | ((q >>> 8) << 25);
  out[2] = toWord(-velocity) | 0x80000000;
  return out;
}
export function stepFall(core, gravity) {
  const velocity = Math.fround(Math.min(Math.fround(fallVelocity(core) + Math.fround(gravity / FALL_HZ)), fallTerminal(core[0] & 255)));
  const distance = Math.fround(fallFraction(core) + Math.fround(velocity / (CELL_M * FALL_HZ)));
  const cells = Math.floor(distance);
  return { core: setFall(core, velocity, Math.fround(distance - cells)), cells };
}
export function validateFall(core) {
  const value = toFloat(core[2]);
  if (!Number.isFinite(value) || (!hasFallVelocity(core) && (value < 0 || value >= 1))) throw new Error('Invalid native fall state');
}
