// Pure unit constants: shared shader preludes must not import the dynamics
// driver or contact kernels (which themselves depend on those preludes).
import { ELEMENTS, E } from '../elements.js';
import { CELL_M } from '../scale.js';
import { PHYS } from '../physics.js';

export const BLAST_SCALE = 1e-3;
export const AIR = Object.freeze({ edge: 4 * CELL_M, rho: 1.225, sound: 50,
  substeps: 8, loss: 0.9999, diffusion: 0.04, pQuantum: 0.02, vQuantum: 0.0002,
  scalarQuantum: 1e-7, quietTicks: 8, gasPressure: 1.225 * 50 ** 2 / 64 });
// Calibrate to the existing Powder Toy gunpowder row and the native acoustic
// energy budget. This is one conversion, not independent pressure/J tables.
export const GUNPOWDER_ENERGY_J = ELEMENTS[E.GUNPOWDER].dens * 100 * CELL_M ** 3 * 3e6 * BLAST_SCALE;
export const GUNPOWDER_PRESSURE = ELEMENTS[E.GUNPOWDER].blast.P;
export const LEGACY_PRESSURE_PA = Math.sqrt(GUNPOWDER_ENERGY_J * 0.25 * 2 * AIR.rho * AIR.sound ** 2 / AIR.edge ** 3) / GUNPOWDER_PRESSURE;
export const legacyPressureToPa = value => value * LEGACY_PRESSURE_PA;
export const specialBlastEnergy = legacyPressure => GUNPOWDER_ENERGY_J * (Math.max(0, Math.min(PHYS.P_MAX, legacyPressure)) / GUNPOWDER_PRESSURE) ** 2;
