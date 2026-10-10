// The island's strata (docs/scaling.md D11, "Island hooks"): which rock its
// bedrock is, cell by cell.
//
// Written once in the shared GLSL subset (scenes/themedShared.js): the GPU runs
// it in the island's sceneCell (scenes/island.js), the CPU its JS twin
// (world/generator.js islandTwin). It runs for every ground cell under the
// column's cover (sand, snow, plant cover): the cells that would be rock.
//
// In scope: the island's world parameters (uGenSea, uGenRelief, ...), its
// baked columns (genColHeight, genColWater, ...: world/generator.js), the
// subset's helpers (thNoised, thHash2, ...) and the element ids (E_*). Under
// snow (the box Island preset) every solid it returns but plant is frozen like
// the rock (scenes/island.js sceneCell). Constants go in STRATA (#defines
// STRATA_*, the same names in the twin), never as bare numbers.
//
// Now: all of it is rock.

export const strata = {
  prefix: 'STRATA',
  tables: { ints: {}, floats: {}, salts: {} },
  src: /* glsl */ `
// The bedrock element at world cell (x, y, z) of a column whose terrain height
// is ground (cells, after landforms: its ground cells are y < thRound(ground)).
int islandRock(int x, int y, int z, float ground) { return E_ROCK; }
`,
};
