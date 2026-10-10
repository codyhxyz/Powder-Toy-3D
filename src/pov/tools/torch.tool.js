import { gear } from './catalog.js';
import { lampTool } from './lamp.js';

// Torch: a burning pitch torch (lamp.js). Its warm, flickering light reaches
// about 10 m. Left-click touches its flame to what you aim at (wood catches);
// right-click throws it, and it burns where it lands for two minutes,
// lighting what's around it and setting fire to anything that burns.

export default lampTool({
  ...gear('TORCH'),
  light: {
    color: [1, 0.52, 0.2],   // linear: a flame's ~1,900 K orange
    intensity: 3,            // × SUN_COL's units at LAMP_UNIT (1 m): about daylight's under a cloud, 1 m off
    range: 34,               // cells (10 m): it fades out over the last few metres (lighting.js lampLight)
    flicker: 0.12,           // its light wavers ±this share
  },
  burn: { seconds: 120 },
  // the held torch, in cells (camera space): low on the right, upright
  pose: { pos: [0.75, -1.15, -1.35], yaw: 0 },
});
