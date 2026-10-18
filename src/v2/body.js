import { CELL_M } from '../scale.js';
import { DT, LEGACY_PRESSURE_PA } from './dynamics-reference.js';
import { legacyVelocityToMS } from './tools.js';

// Legacy-authored POV edit fields use cells/reference-step. Their authoring
// reference is240Hz, not the native owner's actual60Hz clock.
export const bodyEditStepRate = (sim, measured) => sim.compact ? 240 : measured;

// Probe gradients are compatibility-pressure units per CELL, body density uses
// the element table's water=10. Convert both lengths to metres, integrate only
// committed native time, and return a cells/s multiplier for the gradient.
export const nativeBodyPressureFactor = (steps, density) =>
  -LEGACY_PRESSURE_PA * (steps * DT) / (density * 100 * CELL_M * CELL_M);

export function coupleNativeBody(sim, values) {
  const owner = sim.compact, dynamics = owner?.dynamics;
  // Never fall through to a legacy velocity edit: importing that edit would
  // refill partial cells/reset banks while losing its B velocity entirely.
  if (sim.nativeTransition || sim.nativeTransitionError || !dynamics?.isReady || typeof dynamics.applyBodyCoupling !== 'function') return false;
  owner.sync();
  const vector = v => Array.isArray(v) ? v : v.toArray();
  const origin = sim.origin.toArray();
  const result = dynamics.applyBodyCoupling({
    lo: values.lo.map((n, i) => n + origin[i]), hi: values.hi.map((n, i) => n + origin[i]),
    velocity: vector(values.vel).map(legacyVelocityToMS),
    pushFluid: legacyVelocityToMS(values.pushFluid), pushPowder: legacyVelocityToMS(values.pushPowder),
    lift: values.lift, ahead: vector(values.ahead), only: values.only,
  });
  const accepted = result?.status === 'queued' || result?.status === 'accepted';
  if (accepted) sim.wake();
  return accepted;
}
