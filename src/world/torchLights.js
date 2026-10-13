import { lamps } from '../pov/lamps.js';
import { LAMP_MAX } from '../gfx/lamps.js';

// Wall torches as lights (elements.js WALL_TORCH). A torch is one cell, and the
// glow volume (shaders/passes.js brickFrag) spreads a cell's light over bricks:
// it lights nothing round it that way. So the torches nearest the eye are lit
// as point lamps (pov/lamps.js setFixed → shaders/gfx/lighting.js lampLight):
// inverse-square with a soft core, faded out at their reach, shadowed by a
// traced ray. Each is a warm pool a few metres across with the dark between
// them, as Noita's torches are; the glow volume adds a faint wider glow (gfx/
// materials.js TORCH_SHED), and the ones past the nearest few keep only that.
// A scene lists its torches (world scene `torches()`: world cells of the heads);
// a torch dug out or burnt goes dark (the shader checks its cell is a torch).
export const TORCH_LIGHT = {
  color: [1, 0.52, 0.2],   // linear: a pitch flame's ~1,900 K orange (the hand torch's, pov/tools/torch.tool.js)
  intensity: 0.5,          // × SUN_COL's units at LAMP_UNIT (1 m): half the hand torch's (the hand's lights what you look at)
  range: 14,               // cells: the pool fades out over the last few (Karis's window) into darkness
  slots: LAMP_MAX - 2,     // at most this many lit at once, the nearest: the hand's torch and a thrown one keep theirs
  reach: 40,               // cells: no farther from the eye than this (past it a pool is a speck)
  moved: 1,                // cells the eye (or the window) moves before the nearest are picked again
  radius: 0.5,             // cells: the light is the burning head, one cell (gfx/lamps.js: a tube light of the light's own size)
  length: 0,
};

export function createTorchLights() {
  let list = null, of = null;            // the scene's torches (world cells), and whose
  const at = [NaN, NaN, NaN];            // the eye (world cells) the lamps were picked for...
  const o = [NaN, NaN, NaN];             // ...and the window's origin then (the lamps are in grid cells)
  let lit = 0;
  return {
    // scene: the world scene (or null); eye: the camera in grid cells; origin: the window's (world cells)
    update(scene, eye, origin) {
      if (scene !== of) { of = scene; list = scene?.torches?.() ?? null; at[0] = NaN; }
      if (!list?.length) { if (lit) { lamps.setFixed([]); lit = 0; } return; }
      const ex = eye.x + origin.x, ey = eye.y + origin.y, ez = eye.z + origin.z;
      const same = origin.x === o[0] && origin.y === o[1] && origin.z === o[2];
      if (same && (ex - at[0]) ** 2 + (ey - at[1]) ** 2 + (ez - at[2]) ** 2 < TORCH_LIGHT.moved ** 2) return;
      at[0] = ex; at[1] = ey; at[2] = ez;
      o[0] = origin.x; o[1] = origin.y; o[2] = origin.z;
      const near = [];
      const R2 = TORCH_LIGHT.reach ** 2;
      for (const t of list) {
        const d2 = (t[0] + 0.5 - ex) ** 2 + (t[1] + 0.5 - ey) ** 2 + (t[2] + 0.5 - ez) ** 2;
        if (d2 < R2) near.push([d2, t]);
      }
      near.sort((a, b) => a[0] - b[0]);
      const color = TORCH_LIGHT.color.map((c) => c * TORCH_LIGHT.intensity);
      lamps.setFixed(near.slice(0, TORCH_LIGHT.slots).map(([, t]) => ({
        pos: [t[0] + 0.5 - origin.x, t[1] + 0.5 - origin.y, t[2] + 0.5 - origin.z], range: TORCH_LIGHT.range, color, radius: TORCH_LIGHT.radius, length: TORCH_LIGHT.length,
      })));
      lit = Math.min(near.length, TORCH_LIGHT.slots);
    },
  };
}
