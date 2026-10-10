// Shared numbers for first-person (POV) mode. Everything here is in grid
// cells (one cell ≈ 30 cm at this scale) or seconds, unless noted. Values only
// one module uses live in that module.

import { CELL_M } from '../scale.js';

// The body: an upright box the player stands in.
export const BODY_HEIGHT = 5.5;         // cells, about 1.7 m
export const BODY_WIDTH = 1.6;          // cells, square footprint
export const EYE_HEIGHT = 5.0;          // cells above the feet

// How far the hands reach (shovel, bucket, axe, pickaxe, trowel), measured from the eye:
// Minecraft's 4.5 m. A real arm's 1.5 m barely got past your feet from an eye 1.5 m up.
export const HAND_REACH = 4.5 / CELL_M; // cells

// Density of the body, on the element table's scale (water = 10): a person
// barely floats with full lungs.
export const BODY_DENS = 9.8;

// The melee tools (tools/melee.js): impact sources that are a hand-held blow,
// not a round, for the effects that tell the two apart (sparks, ricochets).
export const MELEE_SOURCES = new Set(['axe', 'pickaxe', 'knife']);
