// V2's pull and fall, V1's (user decision, 2026-10-21: "V2 matches V1's fall speed"). One module so every V2
// owner (column runs, the powder column, packets, the flow, air buoyancy, the shock rules) reads one law.
//
// V1's law (react.js forces, move.js vertical, physics.js PHYS):
//   - a step adds gravity: SIM_GRAVITY cells/step² (sim.js GRAVITY_DEFAULT) at NOMINAL_STEP_RATE steps/s,
//     times the element's GRAV and the gravity setting's share of its default;
//   - then drag takes DRAG of the velocity, except from a liquid in free fall (`flying`);
//   - PHYS.V_MAX caps each component: 1 cell/step;
//   - the move (a Margolus block pass) moves a cell down only from a 2x2x2 block's top half, when its draw
//     falls under its speed: a miss leaves it on a bottom half for the next step too, so a cell falling at u
//     cells/step goes u / (2 - u) cells a step on average (v1PaceRate; a liquid into air draws on the R3
//     sequence at its fall age, move.js draw, PACE.Y, fallAge: dynamics-reference.js v1LiquidArrival steps it).
// In V2's units: m/s and m/s² (CELL_M a cell), a 60 Hz tick of LEGACY_STEPS_PER_TICK V1 steps.
import { SIM_GRAVITY, NOMINAL_STEP_RATE, PHYS } from '../physics.js';
import { CELL_M } from '../scale.js';
import { HOST_HZ, LEGACY_STEPS_PER_TICK } from './host.js';

// m/s for each cell/step: V1's velocity unit (v2/tools.js legacyVelocityToMS, the throws' map)
export const V1_STEP_MS = NOMINAL_STEP_RATE * CELL_M;
// the reference pull, m/s²: V1's default gravity, 0.025 cells/step² at 240 steps/s of 0.3 m cells (432 m/s²)
export const GRAVITY_MS2 = SIM_GRAVITY * NOMINAL_STEP_RATE ** 2 * CELL_M;
// V1's terminal speed, m/s: V_MAX (1 cell/step, 72 m/s)
export const TERMINAL_MS = PHYS.V_MAX * V1_STEP_MS;
// V1 steps in a V2 tick, and a V1 step's seconds
export const STEPS_PER_TICK = LEGACY_STEPS_PER_TICK;
export const STEP_S = 1 / (HOST_HZ * STEPS_PER_TICK);
// V1's Margolus pacing: the cells a step a cell falling at u cells/step moves on average (a hit on a top half
// moves it and keeps it on one; a miss costs it the step after on a bottom half too), at most V_MAX
export const v1PaceRate = (u) => { const p = Math.min(Math.max(u, 0), PHYS.V_MAX); return p / (2 - p); };
// V1's drag a step on an element (react.js forces): none on a liquid in free fall
export const v1Keep = (e, flying) => 1 - (flying ? 0 : (e.drag ?? 0));
// V1's terminal fall speed (m/s) of a cell of e under the reference pull: its drag's balance, to V_MAX
export function v1TerminalMS(e, flying = false) {
  const keep = v1Keep(e, flying), g = SIM_GRAVITY * Math.abs(e.grav ?? 0);
  const u = keep >= 1 ? PHYS.V_MAX : Math.min(PHYS.V_MAX, g * keep / (1 - keep));
  return u * V1_STEP_MS;
}
