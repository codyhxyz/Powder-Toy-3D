import { gear } from './catalog.js';
import { lampTool } from './lamp.js';

// Lantern: the torch's better-off cousin (lamp.js): a steady, very bright
// white light that reaches about 12 m. Left-click switches it off and on;
// right-click throws it, and it lands unbroken and keeps shining. It never
// burns out and it lights nothing on fire.

export default lampTool({
  ...gear('LANTERN'),
  light: {
    color: [0.95, 0.98, 1],  // linear: a cool white (≈ 6,500 K)
    intensity: 14,           // × SUN_COL's units at LAMP_UNIT (1 m): several times full sun, 1 m off
    range: 40,               // cells (12 m)
    flicker: 0,
  },
  burn: null,
  // the held lantern, in cells (camera space): hanging from the hand on the right
  pose: { pos: [0.5, 0, -1.4], yaw: 0.4 },
});
