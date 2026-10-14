import { E, ELEMENTS } from '../elements.js';
import { NOMINAL_STEP_RATE } from '../physics.js';
import { deviceCell, deviceDirection } from './catalog.js';

// Minecraft's furnace has a fuel-bearing firebox; this local forced-draft
// abstraction spends TPT's real fuel life rather than changing coal globally.
export const HEARTH_FUEL_IDS = Object.freeze([E.COAL, E.BROKENCOAL]);
/** Local game-abstraction energy units (cell cap × °C) per consumed unit of
 * saved fuel life. Not coal calorific value: at coal's 0.0005 life/native-step,
 * this supplies 150 units per step, enough for native conduction's 130.8-unit
 * loss at 2200 °C across six ambient tungsten faces (6 × 0.01 × 2180).
 */
export const HEARTH_ENERGY_PER_LIFE = 300000;
/** Use the real coal ignition threshold for the hearth's paid built-in spark. */
export const HEARTH_IGNITION_TEMPERATURE = ELEMENTS[E.COAL].ignite;
/** Minecraft-furnace-style paid starter headroom. A 100 °C margin survives
 * the native one-step loss to six 20 °C tungsten neighbors: 550 → 470.5 °C.
 */
export const HEARTH_IGNITION_MARGIN = 100;
export const HEARTH_IGNITION_TARGET = HEARTH_IGNITION_TEMPERATURE + HEARTH_IGNITION_MARGIN;
/** Local hot-source clamp; it does not bypass native charge phase changes. */
export const HEARTH_MAX_FUEL_TEMPERATURE = 2200;
// Match the existing Industry step's dt cap, then convert seconds to native ticks.
export const HEARTH_MAX_STEP_SECONDS = 0.1;
export const HEARTH_STEPS_PER_SECOND = NOMINAL_STEP_RATE;

// Coordinates are device-local and rotate with the existing 4×4 Industry
// footprint. The tungsten deck is y=0; fuel sits in the rear row, charge in
// the two middle rows, and molten output leaves through the front row (+z).
export const HEARTH_LAYOUT = Object.freeze({
  footprint: 4,
  height: 4,
  deckY: 0,
  fuel: Object.freeze({ x: Object.freeze([0, 3]), y: Object.freeze([1, 3]), z: Object.freeze([0, 0]) }),
  charge: Object.freeze({ x: Object.freeze([0, 3]), y: Object.freeze([1, 3]), z: Object.freeze([1, 2]) }),
  outlet: Object.freeze({ x: Object.freeze([0, 3]), y: Object.freeze([1, 3]), z: Object.freeze([3, 3]) }),
  mouth: Object.freeze({ x: Object.freeze([0, 3]), y: Object.freeze([1, 3]), z: Object.freeze([4, 4]) }),
  outputDirection: Object.freeze([0, 0, 1]),
});

/** Return rotated world cells for the buildable fuel, charge, outlet, and
 * four-cell mouth regions. The mouth is just beyond the existing footprint;
 * all other regions are inside its 4×4×4 working volume.
 */
export function hearthRegions(device) {
  if (!device || ![device.x, device.y, device.z, device.rotation].every(Number.isInteger)
      || device.rotation < 0 || device.rotation > 3) {
    throw new TypeError('A hearth needs integer coordinates and rotation 0–3');
  }
  const cells = region => {
    const out = [];
    for (let z = region.z[0]; z <= region.z[1]; z++)
      for (let y = region.y[0]; y <= region.y[1]; y++)
        for (let x = region.x[0]; x <= region.x[1]; x++) out.push(deviceCell(device, x, y, z));
    return out;
  };
  return {
    fuel: cells(HEARTH_LAYOUT.fuel),
    charge: cells(HEARTH_LAYOUT.charge),
    outlet: cells(HEARTH_LAYOUT.outlet),
    mouth: cells(HEARTH_LAYOUT.mouth),
    outputDirection: deviceDirection(device),
  };
}

const noBudget = (cell, status) => ({
  status,
  consumedLife: 0,
  heatBudget: 0,
  heatApplied: 0,
  heatWasted: 0,
  temperature: cell?.temperature,
  life: cell?.life,
});

/** Pure one-cell preview of the hearth's finite local heat budget.
 * `cell` uses {id, temperature, life}, corresponding to a terrain cell's
 * authoritative element id, T, and life fields. This never mutates its input.
 * Call once per real cell in HEARTH_LAYOUT.fuel; `enabled` represents the
 * existing machine base/control guard. This helper is a budget oracle, not a
 * CPU twin of surrounding 3D conduction or native phase changes.
 */
export function hearthFuelBudget(cell, dt, enabled = true) {
  if (enabled !== true) return noBudget(cell, 'disabled');
  if (!Number.isFinite(dt) || dt <= 0) return noBudget(cell, 'idle');
  if (!cell || !HEARTH_FUEL_IDS.includes(cell.id)) return noBudget(cell, 'not-fuel');
  if (!Number.isFinite(cell.temperature) || !Number.isFinite(cell.life) || cell.life <= 0) return noBudget(cell, 'empty');

  const row = ELEMENTS[cell.id];
  const temperature = cell.temperature;
  const cap = row.cap;
  let consumedLife;
  let phase;
  if (temperature < HEARTH_IGNITION_TEMPERATURE) {
    // The built-in starter is a paid spark with headroom for native conduction;
    // partial fuel still buys only its finite share of the temperature rise.
    const sparkEnergy = (HEARTH_IGNITION_TARGET - temperature) * cap;
    consumedLife = Math.min(cell.life, sparkEnergy / HEARTH_ENERGY_PER_LIFE);
    phase = 'ignition';
  } else {
    consumedLife = Math.min(cell.life, row.burnRate * HEARTH_STEPS_PER_SECOND * Math.min(dt, HEARTH_MAX_STEP_SECONDS));
    phase = 'burn';
  }
  const heatBudget = consumedLife * HEARTH_ENERGY_PER_LIFE;
  const headroom = Math.max(0, (HEARTH_MAX_FUEL_TEMPERATURE - temperature) * cap);
  const heatApplied = Math.min(heatBudget, headroom);
  // Native combustion already spends life; the industrial boost pays only for delivered heat.
  if (heatApplied < heatBudget) consumedLife = heatApplied / HEARTH_ENERGY_PER_LIFE;
  const paidBudget = consumedLife * HEARTH_ENERGY_PER_LIFE;
  return {
    status: phase,
    consumedLife,
    heatBudget: paidBudget,
    heatApplied,
    heatWasted: Math.max(0, paidBudget - heatApplied),
    temperature: temperature + heatApplied / cap,
    life: Math.max(0, cell.life - consumedLife),
  };
}
