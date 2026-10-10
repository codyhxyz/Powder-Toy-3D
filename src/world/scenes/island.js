import { worldParams, heightAt } from '../generator.js';

// The island: the generator's own world (world/generator.js, shaders/generate.js),
// filled by its column pass and planted with its trees, not through sceneCell.

// It starts where the most is going on: on the shore the god view looks from
// (app.js WORLD_VIEW_DIR, across x and z), the sea in front, then beach,
// meadows and trees, and the hills behind. Found by walking from the island's
// centre toward the camera to the waterline, START_STEP at a time, then this
// share of the window's width back inland.
export const ISLAND_VIEW_XZ = [11, 13];   // the god view's direction across the ground (app.js WORLD_VIEW_DIR's x, z)
const START_STEP = 16;                    // cells per step of the walk (a window step, world/window.js WIN_STEP)
const START_INLAND = 0.25;                // share of the window's width inland from the waterline

export const island = {
  key: 'island',
  label: 'Island',
  island: true,
  params: ({ size, seed }) => worldParams({ size, seed, snow: false }),
  start(P, win) {
    const len = Math.hypot(...ISLAND_VIEW_XZ), d = ISLAND_VIEW_XZ.map((v) => v / len);
    const at = (r) => [P.center[0] + d[0] * r, P.center[1] + d[1] * r];
    let r = 0;
    while (r < Math.max(P.size[0], P.size[2]) / 2 && heightAt(...at(r), P) >= P.sea) r += START_STEP;
    return at(r - START_INLAND * Math.max(...win));
  },
  ground: (x, z, P) => Math.max(heightAt(x, z, P), P.sea),
};
