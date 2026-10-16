import { deviceCell } from './catalog.js';

// This exact integer is representable in f32 and distinct from the gate's owner
// marker. Tungsten has no native life-bank use for A.z.
export const PUMP_BACKPLATE_TAG = 1048572;

/** The new physical pump's 4×6 tungsten backplate, rotated with its device. */
export function pumpBackplateCells(device) {
  const cells = [];
  for (let y = 1; y <= 6; y++) for (let x = 0; x < 4; x++)
    cells.push(deviceCell(device, x, y, 3));
  return cells;
}

/** Floor and backplate for an explicitly constructed pump; legacy saves are untouched. */
export function pumpStructureCells(device) {
  const floor = [];
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++)
    floor.push(deviceCell(device, x, 0, z));
  // Minecraft-like real machine casing: every backing cell is visible, physical matter.
  return [...floor, ...pumpBackplateCells(device)];
}
