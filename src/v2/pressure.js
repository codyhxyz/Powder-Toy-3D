// Pure unit constants: shared shader preludes must not import the dynamics
// driver or contact kernels (which themselves depend on those preludes).
import { ELEMENTS, E } from '../elements.js';
import { CELL_M } from '../scale.js';
import { PHYS } from '../physics.js';
import { LEGACY_STEPS_PER_TICK, LEGACY_STEP_HZ } from './host.js';

export const BLAST_SCALE = 1e-3;
// Cells a side of an air brick.
export const AIR_CELLS = 4;
// sound: the calibration speed of the J -> Pa conversion below (blasts' p² V / 2ρc²), not a
// propagation speed: the air moves by V1's law (V1_AIR). substeps: one a V1 step (V1_AIR).
export const AIR = Object.freeze({ edge: AIR_CELLS * CELL_M, rho: 1.225, sound: 50,
  substeps: LEGACY_STEPS_PER_TICK, diffusion: 0.04, pQuantum: 0.02, vQuantum: 0.0002,
  scalarQuantum: 1e-7, quietTicks: 8, gasPressure: 1.225 * 50 ** 2 / 64 });
// Calibrate to the existing Powder Toy gunpowder row and the native acoustic
// energy budget. This is one conversion, not independent pressure/J tables.
export const GUNPOWDER_ENERGY_J = ELEMENTS[E.GUNPOWDER].dens * 100 * CELL_M ** 3 * 3e6 * BLAST_SCALE;
export const GUNPOWDER_PRESSURE = ELEMENTS[E.GUNPOWDER].blast.P;
export const LEGACY_PRESSURE_PA = Math.sqrt(GUNPOWDER_ENERGY_J * 0.25 * 2 * AIR.rho * AIR.sound ** 2 / AIR.edge ** 3) / GUNPOWDER_PRESSURE;
export const legacyPressureToPa = value => value * LEGACY_PRESSURE_PA;
export const specialBlastEnergy = legacyPressure => GUNPOWDER_ENERGY_J * (Math.max(0, Math.min(PHYS.P_MAX, legacyPressure)) / GUNPOWDER_PRESSURE) ** 2;

// V1's air (react.js "air pressure" and "forces" on an EMPTY cell) on V2's 4³ bricks, in Pa and m/s.
// Pressure, once a tick (air.js step, substep 0): spread = max(P + diffuse·lap, front·strongest open
// neighbour)·decay, a closed face reflecting the brick's own, clamped to [P_MIN, P_MAX]. V1's front
// crosses a cell a step keeping P_FRONT, and everything keeps P_DECAY a step, sealed or not: a brick is
// AIR_CELLS cells and a tick LEGACY_STEPS_PER_TICK steps, so a front crosses a brick a tick keeping
// P_FRONT^AIR_CELLS, and a tick keeps P_DECAY^LEGACY_STEPS_PER_TICK. V1's Laplacian diffusion
// (P_DIFFUSE cells² a step) is P_DIFFUSE·steps/AIR_CELLS² on the brick lattice.
// Velocity, each substep (a V1 step): v -= ∇P·P_ACCEL/ρ with ρ = RHO_MIN (EMPTY's dens·RHO_SCALE is
// below it), then v *= 1 - DRAG(EMPTY), each component clamped to V_MAX. ∇P per cell is the brick
// difference (P+ - P-) over 2·AIR_CELLS cells, in V1 units (LEGACY_PRESSURE_PA); a cell a step is
// LEGACY_STEP_HZ·CELL_M m/s.
const V1_SPEED_SI = LEGACY_STEP_HZ * CELL_M;
export const V1_AIR = Object.freeze({
  front: PHYS.P_FRONT ** AIR_CELLS,
  decay: PHYS.P_DECAY ** LEGACY_STEPS_PER_TICK,
  diffuse: PHYS.P_DIFFUSE * LEGACY_STEPS_PER_TICK / AIR_CELLS ** 2,
  pMin: PHYS.P_MIN * LEGACY_PRESSURE_PA, pMax: PHYS.P_MAX * LEGACY_PRESSURE_PA,
  accel: PHYS.P_ACCEL / PHYS.RHO_MIN / (2 * AIR_CELLS * LEGACY_PRESSURE_PA) * V1_SPEED_SI,
  keep: 1 - ELEMENTS[E.EMPTY].drag,
  vMax: PHYS.V_MAX * V1_SPEED_SI,
});
