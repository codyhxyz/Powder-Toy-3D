// Shared numbers for first-person (POV) mode. Everything here is in grid
// cells (one cell ≈ 30 cm at this scale) or seconds, unless noted. Values only
// one module uses live in that module.

// The body: an upright box the player stands in.
export const BODY_HEIGHT = 5.5;         // cells, about 1.7 m
export const BODY_WIDTH = 1.6;          // cells, square footprint
export const EYE_HEIGHT = 5.0;          // cells above the feet

// How far the hands reach (shovel, bucket, axe), measured from the eye.
export const HAND_REACH = 5;            // cells

// Density of the body, on the element table's scale (water = 10): a person
// barely floats with full lungs.
export const BODY_DENS = 9.8;
