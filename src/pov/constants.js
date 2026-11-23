// Shared numbers for first-person (POV) mode. Everything here is in grid
// cells (one cell ≈ 30 cm at this scale) or seconds, unless noted. Values only
// one module uses live in that module.

import { CELL_M } from '../scale.js';

// s a dead creature (an NPC, a worm) stays gone before another comes
export const RESPAWN_S = 8;

// The body: an upright box the player stands in.
export const BODY_HEIGHT = 5.5;         // cells, about 1.7 m
export const BODY_WIDTH = 1.6;          // cells, square footprint
export const EYE_HEIGHT = 5.0;          // cells above the feet

// How far the hands reach (shovel, bucket, axe, pickaxe, trowel), measured from the eye:
// Minecraft's 4.5 m. A real arm's 1.5 m barely got past your feet from an eye 1.5 m up.
export const HAND_REACH = 4.5 / CELL_M; // cells

// The lattice the dig and build tools work on (tools/dig.js), and the sizes a
// bite of it can be set to (the wheel, with one of them in hand).
export const BLOCK = 3;                 // cells a side (0.9 m at 30 cm cells: Minecraft's 1 m block)
export const BITE_MIN = 1;              // cells: the finest bite, one cell (the smallest piece the world holds)
export const BITE_MAX = BLOCK;          // cells: the biggest, the block
// a bite's size in words, for the toast and the Controls sheet: '0.3 m'
export const biteLabel = (cells) => `${+(cells * CELL_M).toFixed(2)} m`;

// Density of the body, on the element table's scale (water = 10): a person
// barely floats with full lungs.
export const BODY_DENS = 9.8;

// The melee tools (tools/melee.js): impact sources that are a hand-held blow,
// not a round, for the effects that tell the two apart (sparks, ricochets).
export const MELEE_SOURCES = new Set(['axe', 'pickaxe', 'knife', 'kick', 'jackhammer']);
