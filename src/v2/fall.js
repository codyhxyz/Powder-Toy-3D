import { ELEMENTS, K } from '../elements.js';
import { SIM_GRAVITY, PHYS } from '../physics.js';
import { GRAVITY_MS2, STEPS_PER_TICK, V1_STEP_MS, v1TerminalMS } from './gravity.js';

// Native powder motion, still 16 bytes: z's sign marks the new format (including
// -0); its magnitude is downward m/s. Q15 remainder uses x[24..31], y[25..31].
// y[24] burning, life/ctype and all w seed/spark bits remain owned by material.
export const FALL_HZ = 60;
// A grain falls on V1's law (v2/gravity.js; user decision 2026-10-21): STEPS_PER_TICK V1 steps a tick, each moving
// it v1PaceRate of its speed (V1's Margolus move on its block's random draws: a miss costs it the next step too, so
// a grain at u cells/step falls u/(2-u) a step, V1's mean fall to a step at every height: tools/v2/gravity-check.mjs),
// then adding V1's gravity (SIM_GRAVITY cells/step² at the reference pull, P.gravity's share of it) and taking V1's
// drag (react.js forces: DRAG a step), to V_MAX. Its terminal speed is V1's: its drag's balance (sand 43 m/s, ash 16).
export const FALL_GRAVITY = GRAVITY_MS2;
// Legacy-format cells (an age, no velocity) were saved under R1's 2 g: their age decodes at that pull.
export const LEGACY_FALL_GRAVITY = 19.6;
export const FALL_Q = 32768;
export const FALL_QUANTIZATION_BOUND = 1 / FALL_Q; // cells per tick (floor encoding)
export const fallTerminal = id => ELEMENTS[id]?.kind === K.POWDER ? v1TerminalMS(ELEMENTS[id]) : 0;
// V1's per-step keep (1 - DRAG) of each element, and the step's gravity per m/s² of P.gravity (cells/step²)
export const FALL_KEEP = ELEMENTS.map(e => Math.fround(1 - (e.drag ?? 0)));
export const FALL_G_PER_MS2 = SIM_GRAVITY / GRAVITY_MS2;
for (const e of ELEMENTS) if (e.kind === K.POWDER && e.grav !== 1) throw new Error(`fall.js: ${e.key}'s GRAV is not 1 (the grain law assumes it)`);
const bits = new DataView(new ArrayBuffer(4));
const toFloat = word => { bits.setUint32(0, word, true); return bits.getFloat32(0, true); };
const toWord = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };
const hasFallVelocity = core => (core[2] & 0x80000000) !== 0;
export function fallVelocity(core) {
  if (ELEMENTS[core[0] & 255]?.kind !== K.POWDER) return 0;
  // Legacy saves have no historical gravity setting in each cell. Decode their
  // age once at the old nominal clock; never reinterpret marked velocity.
  return hasFallVelocity(core) ? -toFloat(core[2]) : Math.min((core[0] >>> 24) * LEGACY_FALL_GRAVITY / FALL_HZ, fallTerminal(core[0] & 255));
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
// One tick of a grain's fall at P.gravity `gravity` (m/s²): its speed after (m/s) and the cells it has moved,
// the carried fraction included (shaders/v2/fall.js fallStep, f32 op for op). Without a pull (gravity 0) drag
// stills it, as V1's does, and under REST_V it is still.
export function fallSteps(core, gravity) {
  const f = Math.fround, keep = FALL_KEEP[core[0] & 255], g = f(gravity * f(FALL_G_PER_MS2));
  let u = f(fallVelocity(core) / V1_STEP_MS), d = fallFraction(core);
  for (let k = 0; k < STEPS_PER_TICK; k++) {
    const p = Math.min(u, PHYS.V_MAX);
    d = f(d + f(p / f(2 - p)));
    u = Math.min(f(f(u + g) * keep), PHYS.V_MAX);
  }
  if (g === 0 && u < PHYS.REST_V) u = 0;
  return { velocity: f(u * V1_STEP_MS), distance: d };
}
export function stepFall(core, gravity) {
  const { velocity, distance } = fallSteps(core, gravity);
  const cells = Math.floor(distance);
  return { core: setFall(core, velocity, Math.fround(distance - cells)), cells };
}
// The powder law's landing speed (m/s) after a fall of more than `cells` from rest at the reference pull, on
// stepFall's own f32 steps: a powder's shock trigger on landing (shaders/v2.js v2ColumnWGSL lands it at the
// tick its fall reaches its floor, at that tick's speed).
export function powderLandingSpeed(id, cells) {
  if (!(fallTerminal(id) > 0)) return 0;
  let core = setFall(new Uint32Array([id, 0, 0, 0]), 0, 0), y = 0;
  for (;;) { const s = stepFall(core, FALL_GRAVITY); core = s.core; y += s.cells; if (y + fallFraction(core) > cells) return fallVelocity(core); }
}
export function validateFall(core) {
  const value = toFloat(core[2]);
  if (!Number.isFinite(value) || (!hasFallVelocity(core) && (value < 0 || value >= 1))) throw new Error('Invalid native fall state');
}
