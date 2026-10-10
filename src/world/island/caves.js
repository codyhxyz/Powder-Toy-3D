// The island's caves (docs/scaling.md D11, "Island hooks"): 3D carving, the
// one step that isn't a heightfield.
//
// Written once in the shared GLSL subset (scenes/themedShared.js): the GPU runs
// it in the island's sceneCell (scenes/island.js), the CPU its JS twin
// (world/generator.js islandTwin: islandCell, which tree placement and the
// scene's ground() go through, so trees don't stand over a hole). It runs
// last, on every cell: ground, cover, water and air.
//
// In scope: the island's world parameters (uGenSea, uGenRelief, ...), its
// baked columns (genColHeight, genColWater, ...: world/generator.js), the
// subset's helpers (thNoised, thHash2, ...) and the element ids (E_*).
// Constants go in CAVES (#defines CAVE_*, the same names in the twin), never as
// bare numbers.
//
// Now: nothing is carved.

export const caves = {
  prefix: 'CAVE',
  tables: { ints: {}, floats: {}, salts: {} },
  src: /* glsl */ `
// The element at world cell (x, y, z) after carving, given id, what the island
// put there: id where nothing is carved. ground: the column's terrain height
// (cells, after landforms: its ground cells are y < thRound(ground)); water:
// its standing water's level (cells y < water that aren't ground are water).
int islandCave(int x, int y, int z, float ground, float water, int id) { return id; }
`,
};
