// The island's landforms (docs/scaling.md D11, "Island hooks"): what shapes its
// terrain past the generator's heightfield, and where water stands on it.
//
// Written once in the shared GLSL subset (scenes/themedShared.js): the GPU runs
// it in the island's column bake (scenes/island.js), the CPU its JS twin
// (world/generator.js islandTwin), so both see the same island. Both functions
// run once per world column, in the bake: the layers (beaches, plant cover,
// snow), the trees and every cell then follow what they return.
//
// In scope: the island's world parameters (uGenSea, uGenRelief, uGenFloor,
// uGenFeature, uGenCenterX/Z, uGenRadius, ...), its noise (genFbm,
// genErodedFbm, genRidgedFbm, genHeight: world/generator.js) and the subset's
// helpers. Constants go in LANDFORMS (#defines LAND_*, the same names in the
// twin), never as bare numbers.
//
// Now: none. The heightfield is the island's, and the sea is the only water.

export const landforms = {
  prefix: 'LAND',
  tables: { ints: {}, floats: {}, salts: {} },
  src: /* glsl */ `
// The terrain height of world column (x, z) after landforms, in cells (the
// column is ground below it), from h, the generator's height there.
float islandLandform(float x, float z, float h) { return h; }

// The level of the standing water over world column (x, z), whose ground is h
// high (after landforms), in cells: its cells y < this that aren't ground are
// water (the sea's level, or a lake's surface). Layers count beaches and keep
// plant cover and trees clear of it.
float islandWaterLevel(float x, float z, float h) { return uGenSea; }
`,
};
