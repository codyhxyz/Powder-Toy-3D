import { E, ELEMENTS } from '../elements.js';
import {
  HEARTH_ENERGY_PER_LIFE, HEARTH_IGNITION_TARGET, HEARTH_IGNITION_TEMPERATURE,
  HEARTH_MAX_FUEL_TEMPERATURE, HEARTH_MAX_STEP_SECONDS, HEARTH_STEPS_PER_SECOND,
} from '../industry/hearth.js';
import { FUEL_Q, capacityQ, cid, ctypeOf, energyFits, energyOf, payloadOf, withEnergy, withPayload } from './layout.js';
import { PHASE_CAP_SCALE, phaseAmount, phaseOffsetEnergy } from './phase.js';

// Adapt native combustion's debit -> exact energy -> payload ordering (contact.js),
// not its rate or free pilot heat. These are stationary, whole coal cells: their
// native capacity ALREADY includes the carrier and does not scale with fuel life.
export const HEARTH_ENERGY_PER_QUANTUM = BigInt(HEARTH_ENERGY_PER_LIFE) * BigInt(4 * PHASE_CAP_SCALE) / BigInt(FUEL_Q);
const temperatureQ = t => Math.round((t + 273.25) * 4);
const targetEnergy = (m, t) => phaseOffsetEnergy(cid(m.core), phaseAmount(m.core), ctypeOf(m.core))
  + BigInt(capacityQ(m.core)) * BigInt(temperatureQ(t));
const f32 = Math.fround;

/** Native one-cell commit oracle; authorized is the existing guarded evaluator's
 * heating proposal, NOT an independent enable signal. No mutation or extra state.
 * Per-call flooring can discard subquantum dt allowance: it is conservative fuel
 * payment, not exact continuous-rate preservation across differently split calls.
 */
export function nativeHearthBudget(m, dt, authorized = true) {
  const idle = status => ({ material: m, debit: 0, energyGain: 0n, status });
  if (authorized !== true) return idle('unauthorized');
  const id = cid(m.core);
  if (id !== E.COAL && id !== E.BROKENCOAL) return idle('not-fuel');
  dt = f32(dt);
  if (!(dt > 0 && dt < 1e30)) return idle('idle');
  const available = payloadOf(m.core);
  if (!available) return idle('empty');
  const current = energyOf(m), ceiling = targetEnergy(m, HEARTH_MAX_FUEL_TEMPERATURE);
  if (current >= ceiling) return idle('no-room');
  const room = (ceiling - current) / HEARTH_ENERGY_PER_QUANTUM;
  let wanted, status;
  if (current < targetEnergy(m, HEARTH_IGNITION_TEMPERATURE)) {
    const needed = targetEnergy(m, HEARTH_IGNITION_TARGET) - current;
    // The starter target is a minimum: paid overshoot is intentional, never past the cap.
    wanted = (needed + HEARTH_ENERGY_PER_QUANTUM - 1n) / HEARTH_ENERGY_PER_QUANTUM;
    status = 'ignition';
  } else {
    const rate = f32(f32(f32(ELEMENTS[id].burnRate) * HEARTH_STEPS_PER_SECOND) * Math.min(dt, f32(HEARTH_MAX_STEP_SECONDS)));
    wanted = BigInt(Math.floor(f32(rate * FUEL_Q)));
    status = 'burn';
  }
  const debit = Number([BigInt(available), room, wanted].reduce((a, b) => a < b ? a : b));
  if (!debit) return idle('no-quantum');
  const energyGain = BigInt(debit) * HEARTH_ENERGY_PER_QUANTUM, next = current + energyGain;
  if (!energyFits(m, next)) return idle('rejected');
  return { material: withPayload(withEnergy(m, next), available - debit), debit, energyGain, status };
}

const wf = n => Number.isInteger(n) ? `${n}.0` : String(n);
export const nativeHearthWGSL = /* wgsl */ `
const NATIVE_HEARTH_EQ: u32 = ${HEARTH_ENERGY_PER_QUANTUM}u;
fn nativeHearthTarget(m: Material, tq: u32) -> vec2u {
  return energyAdd(phaseMaterialOffsetEnergy(cid(m.core), materialAmount(m.core), ctypeOf(m.core)), energyMul(capacityQ(m.core), tq));
}
fn nativeHearthQuanta(e: vec2u) -> u32 {
  // energyDiv's exact fallback requires a divisor <= 2^31. Eq is even, so
  // floor(floor(e/2)/(Eq/2)) == floor(e/Eq), including odd bank remainders.
  let half = vec2u((e.x >> 1u) | (e.y << 31u), e.y >> 1u);
  return energyDiv(half, NATIVE_HEARTH_EQ / 2u).x;
}
fn nativeHearthProposal(m: Material, r: WeatherResult) -> bool {
  // Only the evaluator's guarded hearth write authorizes this override. Never
  // independently heat a disabled/damaged machine or change other forcing paths.
  let id = cid(m.core);
  return (P.kind == 5u || P.kind == 6u) && (id == ${E.COAL}u || id == ${E.BROKENCOAL}u)
    && r.before.x == r.after.x && (r.after.y > r.before.y || r.after.z < r.before.z);
}
fn nativeHearthUpdate(m: Material, dt: f32) -> Material {
  let id = cid(m.core);
  if ((id != ${E.COAL}u && id != ${E.BROKENCOAL}u) || !(dt > 0.0 && dt < 1.0e30)) { return m; }
  let available = payloadOf(m.core);
  if (available == 0u) { return m; }
  let current = energyOf(m);
  let ceiling = nativeHearthTarget(m, ${temperatureQ(HEARTH_MAX_FUEL_TEMPERATURE)}u);
  if (!phaseLess(current, ceiling)) { return m; }
  let room = nativeHearthQuanta(energySub(ceiling, current));
  var wanted = 0u;
  if (phaseLess(current, nativeHearthTarget(m, ${temperatureQ(HEARTH_IGNITION_TEMPERATURE)}u))) {
    let needed = energySub(nativeHearthTarget(m, ${temperatureQ(HEARTH_IGNITION_TARGET)}u), current);
    wanted = nativeHearthQuanta(needed);
    if (any(energyMul(wanted, NATIVE_HEARTH_EQ) != needed)) { wanted++; }
  } else {
    let rate = select(${wf(ELEMENTS[E.BROKENCOAL].burnRate)}, ${wf(ELEMENTS[E.COAL].burnRate)}, id == ${E.COAL}u);
    wanted = u32(floor(rate * ${wf(HEARTH_STEPS_PER_SECOND)} * min(dt, ${wf(HEARTH_MAX_STEP_SECONDS)}) * ${wf(FUEL_Q)}));
  }
  // No fractional debt: per-call floor can lose subquantum rate allowance.
  let debit = min(available, min(room, wanted));
  if (debit == 0u) { return m; }
  let next = energyAdd(current, energyMul(debit, NATIVE_HEARTH_EQ));
  if (!energyFits(m, next)) { return m; }
  var out = withEnergy(m, next);
  out.core = withPayload(out.core, available - debit);
  return out;
}
`;

export const NATIVE_HEARTH_MATERIAL_UPDATE = Object.freeze({
  decls: nativeHearthWGSL,
  handles: 'nativeHearthProposal(before,r)',
  update: 'nativeHearthUpdate(before,P.dt)',
});
