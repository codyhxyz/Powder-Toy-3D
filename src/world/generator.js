import { BRICK } from '../shaders/common.js';
import { pcg, definesGLSL, jsConstants, compileShared } from './scenes/themedShared.js';
import { landforms } from './island/landforms.js';
import { strata } from './island/strata.js';
import { caves } from './island/caves.js';

export { pcg };

// Procedural world generator (docs/scaling.md D11, "Generator"): the island.
//
// The terrain is a pure function of world position and a world seed, so any
// region generates seamlessly next to any other. Its algorithm is written once,
// in the shared GLSL subset (scenes/themedShared.js: ISLAND_COLUMN_SRC and
// ISLAND_CELL_SRC below): the GPU compiles it into the island scene's passes
// (scenes/island.js), and the CPU runs its JS twin (islandTwin) for tree
// placement, the scene's start() and ground(), and tools. So the two can't
// drift apart; they agree to float rounding (the GPU's floats are 32-bit).
//
// It comes in two stages, because the costly part depends on x and z only:
//   - per world column (ISLAND_COLUMN_SRC): the terrain height (fBm gradient
//     noise, domain warped, under a noisy island mask), then the landforms
//     hook, two band noises, and the standing water's level (the landforms
//     hook's islandWaterLevel). The GPU bakes these once per world into a
//     texture (scenes/island.js IslandColumns); the twin caches them;
//   - per cell (ISLAND_CELL_SRC), reading a column and its neighbours' baked
//     data (genColHeight, genColBand, genColMeadow, genColWater): which layers
//     the column holds (sand, snow, plant cover), the strata hook for the rock
//     under them, then the caves hook on every cell. islandCell(x, y, z) is the
//     cell's element.
// The hooks (world/island: landforms, strata, caves) are written in the same
// subset, so whatever they do, GPU and CPU see the same island.
//
// The look, top down:
//   - a heightfield: fBm gradient noise, domain warped, under a radial island
//     mask whose coastline is itself noisy, so there is land in the middle and
//     sea toward the edges;
//   - ROCK below the surface (it never moves);
//   - SAND on beaches around the water's level, WATER filling everything below it;
//   - PLANT ground cover on gentle mid slopes, SNOW on gentle high ground.
//
// Stability. A loaded world must not churn.
//   - Powders (sand, snow) topple into a lower diagonal cell when the cell
//     beside it is open (move.js), so they lie only on columns no more than
//     POWDER_STEP_MAX cells above any of their 8 neighbours: the cellular
//     automaton's angle of repose.
//   - They lie at least two cells deep, so the grains resting on rock (the
//     only ones the move pass's landing scatter nudges sideways) are walled in
//     by the neighbouring ground.
//   - Still water keeps being kicked into random flow (the engine's, until
//     docs/scaling.md D2), and it knocks grains in the water sideways, away
//     from it. So no sand in the water where lower columns face each other
//     within two columns along an axis (genCover says why two).
//   - Plants grow into water they touch (react.js), so ground cover starts
//     above the water's level.
//   - The sea fills every column below sea level up to it, so it is flat and
//     walled in by land or the box.
//   - Snow lies on rock frozen to its own temperature (FROST_DEPTH, FROST_SPAN),
//     so the ground doesn't melt it from below. The 20 °C air still will,
//     slowly: the box has no cold upper air.
//   - A world without snow (worldParams snow: false) has bare rock peaks and
//     no frozen rock: everything it generates is at its spawn temperature, so
//     nothing in it drifts.

// ---------------------------------------------------------------- constants
// #defines in the GLSL (GEN_*: islandDefinesGLSL) and the same names in the
// twin. Noise frequencies are per feature length (worldParams' feature, in cells).
export const GEN = {
  // gradient noise and fBm (the noise itself: themedShared.js thNoised)
  OCT_ROT_C: 0.8,            // each octave is turned by this rotation (cos, sin: a 3-4-5 triangle),
  OCT_ROT_S: 0.6,            // so the lattices of successive octaves never line up
  LACUNARITY: 2.0,           // frequency step per octave
  GAIN: 0.5,                 // amplitude step per octave

  // domain warp: the hills are looked up at a point displaced by two fBm fields
  WARP_FREQ: 0.6,            // warp noise
  WARP_AMP: 0.55,            // displacement, feature lengths

  // island mask: 1 - r², r = distance from the centre in island radii, plus coast noise
  COAST_FREQ: 1.6,
  COAST_AMP: 0.3,            // radius wobble, island radii

  // hills: fBm whose octaves are damped where the terrain is already steep
  // (Quilez's gradient-damped fBm), so valleys come out smooth and crests sharp
  HILL_AMP: 0.5,             // hill relief added to the mask, mask units
  HILL_EROSION: 0.6,         // damping per unit of squared accumulated slope (noise units)
  RIDGE_FREQ: 1.3,           // mountain crests: ridged fBm
  RIDGE_AMP: 0.4,            // share of the relief that is crests (the rest is the hills' profile)
  RIDGE_EXP: 1.5,            // crests grow as (land / span)^this: on high ground only
  LAND_SPAN: 0.95,           // land units (mask + hills) from the shore to the highest ground
  SHORE_EXP: 1.7,            // land height grows as (land / span)^this: gentle beaches...
  CLIFF_EXP: 0.75,           // ...or, where the cliff noise says so, steep rocky shores
  CLIFF_FREQ: 1.4,           // cliff noise
  CLIFF_EDGE_LO: 0.25,       // cliff noise (-1..1) range over which beaches turn into cliffs
  CLIFF_EDGE_HI: 0.6,
  CLIFF_SEA: 1.5,            // off cliffs the sea floor falls this much faster
  SEA_SLOPE: 0.7,            // sea floor depth per land unit below 0, shares of the relief
  DETAIL_FREQ: 6.0,          // surface roughness
  DETAIL_AMP: 0.3,           // its relief on high ground, cells (it fades out toward the shore)

  // bands: cells relative to the water's level, or shares of the relief above sea level
  BEACH_BELOW: 4,            // sand reaches this many cells below the water's level...
  BEACH_ABOVE: 3,            // ...and this many above it (plus jitter)
  BEACH_JITTER: 2.5,         // band edge noise, cells
  BEACH_SLOPE_MAX: 0.6,      // sand only where the terrain is gentler than this (cells per cell)
  PLANT_ABOVE: 1,            // ground cover starts this many cells above the water (so it never touches it)
  PLANT_SLOPE_MAX: 1.3,      // ...on terrain gentler than this (cells per cell)
  PLANT_PATCH_FREQ: 2.6,     // meadow patchiness
  PLANT_PATCH_CUT: -0.5,     // ground cover where the patch noise (-1..1) is above this
  MEADOW_BARE: -2.0,         // a bare column's meadow noise (islandBare): under the cut, so no ground cover
  PLANT_JITTER: 3,           // the ground cover's upper edge comes down by up to this many cells (band noise)
  PLANT_SNOW_GAP: 2,         // ...and stays this many cells below the lowest snow, so it never touches snow
  SNOW_LINE: 0.72,           // snow from here up, share of the relief above sea level...
  SNOW_JITTER: 2,            // ...give or take this many cells (band noise)
  SNOW_SLOPE_MAX: 0.9,       // snow only on terrain gentler than this (cells per cell)
  FROST_DEPTH: 6,            // rock is frozen to the snow's temperature from this many cells below the lowest snow up...
  FROST_SPAN: 8,             // ...and warms to ambient over this many cells below that
  BAND_FREQ: 3.3,            // band edge noise
};

// Integer constants (octave counts, layer depths in cells).
export const GEN_INT = {
  WARP_OCT: 3,
  COAST_OCT: 3,
  HILL_OCT: 4,                // each fBm octave adds as much slope as the first: few octaves keep slopes walkable
  RIDGE_OCT: 3,
  DETAIL_OCT: 2,
  BAND_OCT: 2,
  PATCH_OCT: 3,
  CLIFF_OCT: 2,
  SAND_DEPTH: 3,             // sand layer, cells (at least 2: see Stability)
  SNOW_DEPTH: 3,             // snow layer, cells (at least 2: see Stability)
  POWDER_STEP_MAX: 1,        // a powder column may stand this many cells above each neighbour
  KNOCK_REACH: 2,            // columns along an axis within which the water's flow knocks a grain off (genCover)
};

// Hash salts: each noise field gets its own random stream (and each octave
// its own, by adding the octave's index: thStream).
export const GEN_SALT = {
  WARP_X: 0x10, WARP_Z: 0x20, COAST: 0x30, HILLS: 0x40, RIDGE: 0x50,
  DETAIL: 0x60, PATCH: 0x70, BAND: 0x80, CLIFF: 0xa0,
  CELL: 0x90,                // per-cell colour seeds
  SHAPE: 0xb0,               // the island's long axis (worldParams)
  TREE: 0xc0,                // tree candidates (treesIn)
};

// Codes the source hands around: what covers a column's ground (genCover)
// and the zone a tree may stand in (genTreeZone).
const GEN_CODE = {
  COVER_NONE: 0, COVER_SAND: 1, COVER_SNOW: 2, COVER_PLANT: 3,
  ZONE_NONE: 0, ZONE_PALM: 1, ZONE_MID: 2, ZONE_HIGH: 3,
};
// The deepest cover, cells: ground cells deeper than this are bedrock without asking genCover.
const COVER_DEPTH = Math.max(GEN_INT.SAND_DEPTH, GEN_INT.SNOW_DEPTH, 1);

// ---------------------------------------------------------------- world parameters
// A world: its seed and size, and its levels and shape in cells. Sea level is
// a share of the world's height and the relief a share of the island's radius
// (slopes stay walkable), so the same island fits every grid size.
export const WORLD_SEED = 20261008;   // the default world
const SEA_SHARE = 0.14;               // sea level, share of the world's height
const RELIEF_PER_RADIUS = 0.6;        // the highest ground above sea level, cells per cell of island radius
const PEAK_SHARE_MAX = 0.62;          // ...but no higher than this share of the world's height
const FLOOR_CELLS = 2;                // rock under even the deepest sea, cells
const ISLAND_SHARE = 0.76;            // island diameter (if it were round), share of the world's shorter side
const FEATURE_SHARE = 0.38;           // the largest hills' wavelength, share of the world's shorter side
const STRETCH_MAX = 1.18;             // the island is longer than wide by up to this squared (seeded)
const TAU = Math.PI * 2;

// size: the world in cells [x, y, z]; snow: false leaves the peaks bare rock
export function worldParams({ size, seed = WORLD_SEED, snow = true } = {}) {
  const [wx, wy, wz] = size;
  const side = Math.min(wx, wz);
  const sea = Math.round(SEA_SHARE * wy);
  const radius = (ISLAND_SHARE * side) / 2;
  const relief = Math.min(RELIEF_PER_RADIUS * radius, PEAK_SHARE_MAX * wy - sea);
  // the island's long axis and how much longer than wide it is, from the seed
  const shape = pcg((seed + GEN_SALT.SHAPE) >>> 0);
  const angle = ((shape & 0xffff) / 0x10000) * TAU;
  const P = {
    seed: seed >>> 0,
    size: [wx, wy, wz],
    sea,                              // cells below this height (y < sea) are sea where not ground
    relief,                           // cells from sea level to the highest ground
    floor: FLOOR_CELLS,
    center: [wx / 2, wz / 2],         // island centre (world cells, x and z)
    radius,
    axis: [Math.cos(angle), Math.sin(angle)],   // the island's long axis (unit, x and z)
    stretch: 1 + (STRETCH_MAX - 1) * ((shape >>> 16) / 0x10000),   // long / wide = stretch²
    feature: FEATURE_SHARE * side,    // cells per feature length (noise frequency unit)
    snow,                             // snow on gentle high ground, on frozen rock
  };
  // where the landforms go, picked from the terrain before them (the twin of P without them)
  return { ...P, landforms: landforms.sites(P, islandTwin(P)) };
}

// The world's parameters by the names the source reads them by: uniforms on
// the GPU (scenes/island.js islandUniforms), constants in the twin.
export const islandParamValues = (P) => ({
  uGenSea: P.sea, uGenRelief: P.relief, uGenFloor: P.floor,
  uGenCenterX: P.center[0], uGenCenterZ: P.center[1], uGenRadius: P.radius,
  uGenAxisX: P.axis[0], uGenAxisZ: P.axis[1], uGenStretch: P.stretch, uGenFeature: P.feature,
  uGenSnow: P.snow,
  ...landforms.values(P),
});
// GLSL before both stages' sources, after the world's parameters: the hooks' uniforms (scenes/island.js)
export const ISLAND_HEAD_GLSL = landforms.head;

// ---------------------------------------------------------------- the source
// Per world column. (x, z): the column, as floats (the twin's heightAt also
// asks between columns). Hooks: landforms (world/island/landforms.js; its
// islandBare leaves a column without meadow, so without ground cover).
export const ISLAND_COLUMN_SRC = /* glsl */ `
// fBm, normalised to about ±1 (each octave its own stream). Each octave's
// point is the last one turned (so the lattices never line up) and scaled.
float genFbm(float x, float z, uint salt, int oct) {
  float sum = 0.0, amp = 1.0, norm = 0.0, px = x, pz = z;
  for (int i = 0; i < oct; i++) {
    sum += amp * thNoised(px, pz, thStream(salt, i));
    norm += amp;
    amp *= GEN_GAIN;
    float ox = GEN_LACUNARITY * (GEN_OCT_ROT_C * px - GEN_OCT_ROT_S * pz);
    pz = GEN_LACUNARITY * (GEN_OCT_ROT_S * px + GEN_OCT_ROT_C * pz);
    px = ox;
  }
  return thFdiv(sum, norm);
}
// gradient-damped fBm (Quilez): an octave counts less where the ones before it
// are steep, so valleys come out smooth and crests sharp
float genErodedFbm(float x, float z, uint salt, int oct) {
  float sum = 0.0, amp = 1.0, norm = 0.0, px = x, pz = z, dx = 0.0, dz = 0.0;
  for (int i = 0; i < oct; i++) {
    float n = thNoised(px, pz, thStream(salt, i));
    dx += thNoiseDx();
    dz += thNoiseDz();
    sum += thFdiv(amp * n, 1.0 + GEN_HILL_EROSION * (dx * dx + dz * dz));
    norm += amp;
    amp *= GEN_GAIN;
    float ox = GEN_LACUNARITY * (GEN_OCT_ROT_C * px - GEN_OCT_ROT_S * pz);
    pz = GEN_LACUNARITY * (GEN_OCT_ROT_S * px + GEN_OCT_ROT_C * pz);
    px = ox;
  }
  return thFdiv(sum, norm);
}
// ridged fBm in [0, 1]: sharp crests where the noise crosses zero
float genRidgedFbm(float x, float z, uint salt, int oct) {
  float sum = 0.0, amp = 1.0, norm = 0.0, px = x, pz = z;
  for (int i = 0; i < oct; i++) {
    float r = 1.0 - abs(thNoised(px, pz, thStream(salt, i)));
    sum += amp * r * r;
    norm += amp;
    amp *= GEN_GAIN;
    float ox = GEN_LACUNARITY * (GEN_OCT_ROT_C * px - GEN_OCT_ROT_S * pz);
    pz = GEN_LACUNARITY * (GEN_OCT_ROT_S * px + GEN_OCT_ROT_C * pz);
    px = ox;
  }
  return thFdiv(sum, norm);
}

// The generator's terrain height at world column (x, z), in cells: the column
// is ground below it. Continuous.
float genHeight(float x, float z) {
  float qx = thFdiv(x + 0.5, uGenFeature), qz = thFdiv(z + 0.5, uGenFeature);   // the column's centre, in feature lengths
  // domain warp: everything below is looked up at a displaced point
  float wx = qx + GEN_WARP_AMP * genFbm(qx * GEN_WARP_FREQ, qz * GEN_WARP_FREQ, GEN_SALT_WARP_X, GEN_WARP_OCT);
  float wz = qz + GEN_WARP_AMP * genFbm(qx * GEN_WARP_FREQ, qz * GEN_WARP_FREQ, GEN_SALT_WARP_Z, GEN_WARP_OCT);
  // island mask: distance from the centre in island radii, along the island's
  // (seeded) long axis and across it, plus coast noise
  float dx = wx * uGenFeature - uGenCenterX, dz = wz * uGenFeature - uGenCenterZ;
  float along = thFdiv(dx * uGenAxisX + dz * uGenAxisZ, uGenStretch), across = (dz * uGenAxisX - dx * uGenAxisZ) * uGenStretch;
  float r = thFdiv(sqrt(along * along + across * across), uGenRadius)
          + GEN_COAST_AMP * genFbm(wx * GEN_COAST_FREQ, wz * GEN_COAST_FREQ, GEN_SALT_COAST, GEN_COAST_OCT);
  float land = 1.0 - r * r + GEN_HILL_AMP * genErodedFbm(wx, wz, GEN_SALT_HILLS, GEN_HILL_OCT);
  // cliffs: where this noise is high the shore rises (and the sea floor falls) steeply
  float cliff = smoothstep(GEN_CLIFF_EDGE_LO, GEN_CLIFF_EDGE_HI,
                           genFbm(wx * GEN_CLIFF_FREQ, wz * GEN_CLIFF_FREQ, GEN_SALT_CLIFF, GEN_CLIFF_OCT));
  if (land <= 0.0) return max(uGenFloor, uGenSea + land * GEN_SEA_SLOPE * (1.0 + GEN_CLIFF_SEA * cliff) * uGenRelief);
  float t = min(thFdiv(land, GEN_LAND_SPAN), 1.0);
  float shore = pow(t, mix(GEN_SHORE_EXP, GEN_CLIFF_EXP, cliff));
  float ridge = genRidgedFbm(wx * GEN_RIDGE_FREQ, wz * GEN_RIDGE_FREQ, GEN_SALT_RIDGE, GEN_RIDGE_OCT);
  float detail = genFbm(wx * GEN_DETAIL_FREQ, wz * GEN_DETAIL_FREQ, GEN_SALT_DETAIL, GEN_DETAIL_OCT);
  float h = (1.0 - GEN_RIDGE_AMP) * shore + GEN_RIDGE_AMP * ridge * pow(t, GEN_RIDGE_EXP);
  return uGenSea + h * uGenRelief + GEN_DETAIL_AMP * detail * t;
}

${landforms.src}

// What the GPU bakes per world column (and the twin caches): its height after
// landforms, its band edge and meadow patch noise (about ±1) and its standing
// water's level.
float genColumnHeight(float x, float z) { return islandLandform(x, z, genHeight(x, z)); }
float genBand(float x, float z) {
  return genFbm(thFdiv(x + 0.5, uGenFeature) * GEN_BAND_FREQ, thFdiv(z + 0.5, uGenFeature) * GEN_BAND_FREQ, GEN_SALT_BAND, GEN_BAND_OCT);
}
float genMeadow(float x, float z, float h) {
  if (islandBare(x, z, h)) return GEN_MEADOW_BARE;
  return genFbm(thFdiv(x + 0.5, uGenFeature) * GEN_PLANT_PATCH_FREQ, thFdiv(z + 0.5, uGenFeature) * GEN_PLANT_PATCH_FREQ,
                GEN_SALT_PATCH, GEN_PATCH_OCT);
}
float genWater(float x, float z, float h) { return islandWaterLevel(x, z, h); }
`;

// Per cell, from the baked columns: genColHeight, genColBand, genColMeadow and
// genColWater (x, z) read world column (x, z)'s (texel fetches on the GPU, the
// twin's cache on the CPU). Hooks: strata and caves (world/island), and the
// landforms' cell-stage part (islandLakeClearance, which caves read).
export const ISLAND_CELL_SRC = /* glsl */ `
// The top of world column (x, z)'s ground: cells y < it are ground.
int genTop(int x, int z) { return thRound(genColHeight(x, z)); }
// The lowest snow (the snow line less its jitter).
float genFrostLine() { return uGenSea + GEN_SNOW_LINE * uGenRelief - GEN_SNOW_JITTER; }
// The highest ground cover on a column with band noise band: just below the lowest snow.
float genPlantLine(float band) { return genFrostLine() - GEN_PLANT_SNOW_GAP - GEN_PLANT_JITTER * (1.0 + band) * 0.5; }
// Rock is frozen to the snow's temperature from FROST_DEPTH cells below the
// lowest snow up, and warms to ambient over FROST_SPAN cells below that, so
// snow lies on a cold slab that the warm rock under it takes long to reach:
// 0 warm, 1 frozen.
float genFrost(int y) {
  return clamp(thFdiv(float(y) - genFrostLine() + GEN_FROST_DEPTH + GEN_FROST_SPAN, GEN_FROST_SPAN), 0.0, 1.0);
}
// The terrain's slope at world column (x, z), cells per cell.
float genSlope(int x, int z) {
  float sx = genColHeight(x + 1, z) - genColHeight(x - 1, z), sz = genColHeight(x, z + 1) - genColHeight(x, z - 1);
  return 0.5 * sqrt(sx * sx + sz * sz);
}

// What covers world column (x, z)'s ground: GEN_COVER_SAND (its top
// GEN_SAND_DEPTH ground cells), _SNOW (GEN_SNOW_DEPTH), _PLANT (its top
// cell) or _NONE.
int genCover(int x, int z) {
  int g = genTop(x, z);
  float gf = float(g), water = genColWater(x, z), band = genColBand(x, z);
  // powders stay put only on columns at most a step above each neighbour (the angle of repose)
  int drop = 0;
  for (int dz = -1; dz <= 1; dz++)
    for (int dx = -1; dx <= 1; dx++) drop = max(drop, g - genTop(x + dx, z + dz));
  bool stable = drop <= GEN_POWDER_STEP_MAX;
  // The water's flow knocks a grain in it from the side, away from the water
  // beside it (move.js collisions are along an axis). It moves if there is
  // water beyond it, or shoves the grain next to it (only that one: the shove
  // dies there) into water beyond that. So no sand in the water where a lower
  // column on one side faces one on the other within GEN_KNOCK_REACH columns.
  int k = GEN_KNOCK_REACH;
  bool lxm = genTop(x - 1, z) < g, lxp = genTop(x + 1, z) < g, lzm = genTop(x, z - 1) < g, lzp = genTop(x, z + 1) < g;
  bool knocked = gf <= water
              && ((lxm && (lxp || genTop(x + k, z) < g)) || (lxp && genTop(x - k, z) < g)
               || (lzm && (lzp || genTop(x, z + k) < g)) || (lzp && genTop(x, z - k) < g));
  float slope = genSlope(x, z);
  bool beach = gf >= water - GEN_BEACH_BELOW && gf <= water + GEN_BEACH_ABOVE + GEN_BEACH_JITTER * band
            && slope < GEN_BEACH_SLOPE_MAX && !knocked;
  bool snow = uGenSnow && gf >= genFrostLine() + GEN_SNOW_JITTER * (1.0 + band) && slope < GEN_SNOW_SLOPE_MAX;
  if (stable && beach) return GEN_COVER_SAND;
  if (stable && snow) return GEN_COVER_SNOW;
  if (gf >= water + GEN_PLANT_ABOVE && gf <= genPlantLine(band) && slope < GEN_PLANT_SLOPE_MAX
      && genColMeadow(x, z) > GEN_PLANT_PATCH_CUT) return GEN_COVER_PLANT;
  return GEN_COVER_NONE;
}

${landforms.cellSrc}

${strata.src}

${caves.src}

// The element at world cell (x, y, z): water below the column's water level,
// its cover over its bedrock (strata), then carved (caves).
int islandCell(int x, int y, int z) {
  float h = genColHeight(x, z), water = genColWater(x, z);
  int top = thRound(h);
  int id = E_EMPTY;
  if (y >= top) {
    if (float(y) < water) id = E_WATER;
  } else {
    int depth = top - 1 - y;   // 0: the top ground cell
    int cover = depth < GEN_COVER_DEPTH ? genCover(x, z) : GEN_COVER_NONE;
    if (cover == GEN_COVER_SAND && depth < GEN_SAND_DEPTH) id = E_SAND;
    else if (cover == GEN_COVER_SNOW && depth < GEN_SNOW_DEPTH) id = E_SNOW;
    else if (cover == GEN_COVER_PLANT && depth == 0) id = E_PLANT;
    else id = islandRock(x, y, z, h);
  }
  return islandCave(x, y, z, h, water, id);
}

// Can a tree's trunk stand on world column (x, z) (treesIn's ground check),
// and in which zone: GEN_ZONE_PALM (a beach), _MID, _HIGH or _NONE. Its
// footing, the column's top ground cell as islandCell makes it, must be plant
// cover or sand.
int genTreeZone(int x, int z) {
  int top = genTop(x, z);
  float above = float(top) - genColWater(x, z);
  if (above < GEN_TREE_ABOVE_SEA || genSlope(x, z) >= GEN_TREE_SLOPE_MAX) return GEN_ZONE_NONE;
  if (genColMeadow(x, z) == GEN_MEADOW_BARE) return GEN_ZONE_NONE;   // bare ground (islandBare): no trees, not even on sand
  if (float(top) > genFrostLine() - GEN_TREE_SNOW_GAP) return GEN_ZONE_NONE;
  int foot = islandCell(x, top - 1, z);
  if (foot == E_SAND) return above <= GEN_TREE_PALM_BELOW ? GEN_ZONE_PALM : GEN_ZONE_NONE;
  if (foot != E_PLANT) return GEN_ZONE_NONE;
  return float(top) - uGenSea >= GEN_TREE_PINE_ABOVE * uGenRelief ? GEN_ZONE_HIGH : GEN_ZONE_MID;
}
`;

// Columns around a column that the cell stage reads, on each side: the GPU
// bakes the world's columns plus this margin (scenes/island.js). A hook that
// reads farther gets the edge's columns past the margin.
export const COLUMN_MARGIN = GEN_INT.KNOCK_REACH;

// The constant tables, and the hooks', with their prefixes.
const tables = () => [
  ['GEN', { floats: GEN, ints: { ...GEN_INT, ...GEN_CODE, COVER_DEPTH }, salts: GEN_SALT }],
  ['GEN_TREE', { floats: treeGround() }],
  ...[landforms, strata, caves].map((h) => [h.prefix, h.tables]),
];
// Every #define the source needs (scenes/island.js puts it before the source).
export const islandDefinesGLSL = () => tables().map(([prefix, t]) => definesGLSL(prefix, t)).join('\n');
const islandConstants = () => Object.assign({}, ...tables().map(([prefix, t]) => jsConstants(prefix, t)));

// ---------------------------------------------------------------- the twin
// The JS twin of world P's source: every function of both stages, the cell
// stage reading columns from a cache the column stage fills (column(x, z):
// [height, band, meadow, water]). One per world, kept.
const TWINS_KEEP = 8;                 // worlds whose twins are kept (box sizes, the world, tools' seeds)
const COLUMNS_KEEP = 1 << 17;         // world columns a twin keeps baked (~130k: a window and its trees' reach many times over)
const COLUMN_KEY_STRIDE = 1 << 21;    // a column's cache key, x · stride + z (|z| well under half of it)
const twins = new Map();
export function islandTwin(P) {
  const key = JSON.stringify(P);
  let twin = twins.get(key);
  if (twin) return twin;
  const consts = { ...islandConstants(), ...islandParamValues(P), ...landforms.scope(P) };
  const col = compileShared(ISLAND_COLUMN_SRC, P.seed, consts);
  const cache = new Map();
  const column = (x, z) => {
    const k = x * COLUMN_KEY_STRIDE + z;
    let c = cache.get(k);
    if (!c) {
      if (cache.size >= COLUMNS_KEEP) cache.clear();
      const h = col.genColumnHeight(x, z);
      c = [h, col.genBand(x, z), col.genMeadow(x, z, h), col.genWater(x, z, h)];
      cache.set(k, c);
    }
    return c;
  };
  const cell = compileShared(ISLAND_CELL_SRC, P.seed, {
    ...consts,
    genColHeight: (x, z) => column(x, z)[0], genColBand: (x, z) => column(x, z)[1],
    genColMeadow: (x, z) => column(x, z)[2], genColWater: (x, z) => column(x, z)[3],
  });
  if (twins.size >= TWINS_KEEP) twins.clear();
  twin = { ...col, ...cell, column };
  twins.set(key, twin);
  return twin;
}

// The terrain's height at world column (x, z), in cells (after landforms: the
// column is ground below it). x and z may fall between columns.
export const heightAt = (x, z, P) => islandTwin(P).genColumnHeight(x, z);
// The element at world cell (x, y, z) (integers), as the GPU generates it but
// for its trees (world/gpu.js stamps them).
export const islandCellAt = (x, y, z, P) => islandTwin(P).islandCell(x, y, z);
// What world column (x, z) holds: ground = the number of ground cells (y <
// ground), the depths of its sand and snow layers (0: none), whether its top
// cell is plant cover, and its slope. (Tools.)
export function layersAt(x, z, P) {
  const T = islandTwin(P), cover = T.genCover(x, z), C = GEN_CODE;
  return {
    ground: T.genTop(x, z),
    sand: cover === C.COVER_SAND ? GEN_INT.SAND_DEPTH : 0,
    snow: cover === C.COVER_SNOW ? GEN_INT.SNOW_DEPTH : 0,
    plant: cover === C.COVER_PLANT,
    slope: T.genSlope(x, z),
  };
}

// ---------------------------------------------------------------- trees
// Trees are the TREE constructions (constructions/builtins.js), stamped by
// world/gpu.js. Each brick column (BRICK × BRICK cells) may hold one
// candidate, hashed from its brick coordinates and the world seed: whether
// it has one, where in the column, which kind, how big, which way it faces
// and its construction seed. A candidate on unsuitable ground is dropped
// (genTreeZone, in the source: the GPU's far field asks the same), and one
// with a higher-priority candidate within TREE_SPACING is too (Matérn
// thinning), so placement depends only on nearby brick columns: any region
// places the same trees as any other.
export const TREE = {
  CHANCE: 0.5,               // chance a brick column has a candidate
  SPACING: 8,                // cells: no two trees stand closer
  ABOVE_SEA: 2,              // trunks stand at least this many cells above the water's level
  SLOPE_MAX: 0.8,            // ...on ground gentler than this (cells per cell; the stamp grows a footing)
  SIZE_MIN: 3,               // construction size (runtime.js scaleFor: 3..5 is 0.78..1 of the default tree)
  SIZE_MAX: 5,
  PALM_BELOW: 4,             // palms grow on beaches, up to this many cells above the water's level
  PINE_ABOVE: 0.3,           // pines from this share of the relief above sea level
  SNOW_GAP: 5,               // cells: trees stand at least this far below the lowest snow, so their crowns don't reach it
  REACH: 16,                 // cells: the widest crown's reach from its trunk (a region stamps trees this far outside it)
};
// The ground check's share of TREE (GEN_TREE_* in the source).
function treeGround() {
  const { ABOVE_SEA, SLOPE_MAX, PALM_BELOW, PINE_ABOVE, SNOW_GAP } = TREE;
  return { ABOVE_SEA, SLOPE_MAX, PALM_BELOW, PINE_ABOVE, SNOW_GAP };
}
// Kinds by zone: cumulative weights for the mid slopes (the rest is dead trees).
// (The far field places the same trees on the GPU: scenes/island.js islandTreesGLSL.)
export const MID_TREES = [['oak', 0.5], ['birch', 0.75], ['pine', 0.95]];
export const HIGH_TREES = [['pine', 0.85], ['birch', 0.97]];   // the rest dead
const UNIT16 = 0x10000;                                         // 16-bit hash field to [0, 1)
const stream = (seed, salt) => pcg((seed + salt) >>> 0);
const latticeHash = (ix, iz, s) => pcg(((ix >>> 0) + pcg(((iz >>> 0) + s) >>> 0)) >>> 0);

function treeCandidate(bx, bz, P, T) {
  const h = latticeHash(bx, bz, stream(P.seed, GEN_SALT.TREE));
  if ((h & 0xffff) / UNIT16 >= TREE.CHANCE) return null;
  const h2 = pcg(h), h3 = pcg(h2);
  const x = bx * BRICK + (h2 & (BRICK - 1)), z = bz * BRICK + ((h2 >>> 2) & (BRICK - 1));
  const zone = T.genTreeZone(x, z), C = GEN_CODE;
  if (zone === C.ZONE_NONE) return null;
  const pick = (h3 & 0xffff) / UNIT16;
  const kinds = zone === C.ZONE_PALM ? [['palm', 1]] : zone === C.ZONE_HIGH ? HIGH_TREES : MID_TREES;
  const variant = kinds.find(([, w]) => pick < w)?.[0] ?? 'dead';
  return {
    x, y: T.genTop(x, z), z, variant,
    size: TREE.SIZE_MIN + ((h3 >>> 16) % (TREE.SIZE_MAX - TREE.SIZE_MIN + 1)),
    quarter: (h3 >>> 20) & 3,          // which way its front faces (runtime.js bake)
    seed: pcg(h3),                     // its construction seed
    priority: h2 >>> 8,
  };
}

// The trees whose trunks stand in world columns [x0, x1) × [z0, z1). cache
// keeps the brick columns' candidates of world P between calls (a caller
// asking for neighbouring regions again and again: world/window.js).
export function treesIn(x0, z0, x1, z1, P, cache = new Map()) {
  const B = BRICK, R = Math.ceil(TREE.SPACING / B), T = islandTwin(P);
  const bx0 = Math.floor(x0 / B), bz0 = Math.floor(z0 / B), bx1 = Math.ceil(x1 / B), bz1 = Math.ceil(z1 / B);
  const candidate = (bx, bz) => {
    const k = `${bx},${bz}`;
    if (!cache.has(k)) cache.set(k, treeCandidate(bx, bz, P, T));
    return cache.get(k);
  };
  const out = [];
  for (let bz = bz0; bz < bz1; bz++)
    for (let bx = bx0; bx < bx1; bx++) {
      const c = candidate(bx, bz);
      if (!c || c.x < x0 || c.x >= x1 || c.z < z0 || c.z >= z1) continue;
      let wins = true;
      for (let dz = -R; dz <= R && wins; dz++)
        for (let dx = -R; dx <= R && wins; dx++) {
          if (!dx && !dz) continue;
          const o = candidate(bx + dx, bz + dz);
          if (!o || Math.hypot(o.x - c.x, o.z - c.z) >= TREE.SPACING) continue;
          // the higher priority stays (ties: the lower brick index)
          if (o.priority > c.priority || (o.priority === c.priority && (dz < 0 || (dz === 0 && dx < 0)))) wins = false;
        }
      if (wins) out.push(c);
    }
  return out;
}
