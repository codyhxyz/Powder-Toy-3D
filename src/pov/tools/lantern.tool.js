import { gear } from './catalog.js';
import { lampTool } from './lamp.js';

// Lantern: the torch's better-off cousin (lamp.js): a steady, warm light
// that reaches about 10 m. Left-click switches it off and on;
// right-click throws it, and it lands unbroken and keeps shining. It never
// burns out and it lights nothing on fire.

export default lampTool({
  ...gear('LANTERN'),
  light: {
    color: [1, 0.78, 0.5],   // linear: an oil lantern's warm white (≈ 2,700 K)
    intensity: 2.5,          // × SUN_COL's units at LAMP_UNIT (1 m): brighter than the torch, still a pool of light;
                             // 14 floodlit a cave white once the eyes adjusted to it (gfx/post.js ADAPT)
    range: 32,               // cells (10 m)
    flicker: 0,
  },
  burn: null,
  // the held lantern, in cells (camera space): hanging from the hand on the right
  pose: { pos: [0.5, 0, -1.4], yaw: 0.4 },
});
