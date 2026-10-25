import { E } from '../../elements.js';
import { LAMP_DC } from '../../electricity.js';

// Existing battery-fed DC lamps, not decorative lights or temperature clamps.
export function ceilingLight(box, x, y, z, width = 8) {
  box(x, y, z, x + width, y + 1, z + 2, E.LAMP, { ctype: LAMP_DC });
  box(x, y + 1, z, x + width, y + 2, z + 2, E.BATTERY);
}
