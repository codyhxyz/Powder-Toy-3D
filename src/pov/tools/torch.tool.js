import { gear } from './catalog.js';
import { lampTool } from './lamp.js';
import { FLAME_COLOR } from '../../gfx/lamps.js';

// Torch: a burning pitch torch (lamp.js). Its warm, flickering light reaches
// about 7 m. Right-click throws it, and it burns where it lands for two
// minutes, lighting what's around it. Its flame sets nothing alight
// (burn.ignites false): a light, not a fire-starter (the flamethrower is that).

export default lampTool({
  ...gear('TORCH'),
  light: {
    color: FLAME_COLOR,      // a flame's blackbody colour at 1,850 K, unit luminance (gfx/lamps.js)
    intensity: 0.6,          // luminance, × SUN_COL's units at LAMP_UNIT (1 m): a small warm pool, not a floodlight (Noita's torch);
                             // 3 washed caves out once the eyes adjusted to them (gfx/post.js ADAPT)
    range: 24,               // cells (7 m): it fades out over the last few metres (lighting.js lampLight) into darkness
    flicker: 0.12,           // its light wavers ±this share
  },
  burn: { seconds: 120, ignites: false },
  // the held torch, in cells (camera space): low on the right, upright
  pose: { pos: [0.75, -1.15, -1.35], yaw: 0 },
});
