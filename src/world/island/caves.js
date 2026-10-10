// The island's caves (docs/scaling.md D11, "Island hooks"): 3D carving, the
// one step that isn't a heightfield. islandCell (world/generator.js) calls
// islandCave last, on every cell, with the element the layers and strata gave
// it, and gets back the element after carving.
//
// Written once in the shared GLSL subset (scenes/themedShared.js): the GPU runs
// it in the island's sceneCell (scenes/island.js), the CPU its JS twin
// (world/generator.js islandTwin: islandCell, which tree placement and the
// scene's ground() go through; tools/caves-preview.mjs previews and audits it).
// In scope: the island's world parameters (uGenSea, ...), its baked columns
// (genColHeight, genColWater, ...), the cell stage's functions declared before
// the hooks (genTop, genSlope, genCover) and the subset's helpers.
//
// The approach is Minecraft 1.18's noise caves (Caves & Cliffs part II; the
// density functions of its NoiseRouterData, as the Minecraft Wiki's "Cave"
// article, "Noise caves", describes them), sized for a 5.5-cell player in a
// 128-cell-high world:
//   - "spaghetti 2D" level tunnels: a 2D noise's zero line is the tunnel's
//     path, a second 2D noise its floor's elevation, a third its size (and
//     where it ends: Minecraft's rarity modulator). Three levels: UPPER under
//     the big hills, LOWER around the water table (flooded stretches), SEA at
//     the water table under the coast (sea caves, and sea arches where one
//     crosses a cliff headland);
//   - "spaghetti 3D" tunnels: where two 3D noises are both near zero, the
//     curve where their zero surfaces cross. They wander up and down, so
//     they link the levels, the caverns and the hillsides;
//   - "cheese" caverns: where a low-frequency 3D noise is above a threshold
//     that rises toward the surface and toward the top of their range, so they
//     stay deep;
//   - mouths: on bare-rock ground (Minecraft's "entrances" noise picks
//     where) the rock roof thins to nothing, so the tunnels that run under it
//     near the surface open out of the hillside. Bare rock holds no sand, plant
//     cover, snow or trees; it is the high ground above the plant line, rocky
//     patches between the meadows, and the steep ground (world/generator.js
//     BEACH_SLOPE_MAX, PLANT_SLOPE_MAX, SNOW_SLOPE_MAX, TREE.SLOPE_MAX). Near
//     the water only cliffs open, which is where sea caves come out;
//   - shafts: a few sinkholes, funnels dropping from gentle ground past the
//     water table: cenotes, opening into whatever tunnels and caverns they
//     pass.
// Every family's test gives a signed distance to its wall, in cells (< 0 is
// cave): the 2D and 3D noises' value over their gradient's length (Quilez,
// "distance to an implicit function": a noise's zero set is d = n / |∇n|
// away, to first order), so tunnels come out the size asked for wherever the
// noise is steep or flat. Their minimum is the cave; a thin shell around its
// wall is where crystal clusters grow (some sites only, more of them deeper),
// and in caverns stalactites and stalagmites hang and stand, rock cones whose
// test is two more noise lookups: is the ceiling (the floor) within the cone's
// length above (below) this cell?
//
// Water. Carved cells below the sea level (uGenSea, the caves' one water
// table, not the column's standing water: a mountain lake's level would put
// water beside air in the next column's cave) are water: deep caverns hold
// flat underground lakes, sea-level tunnels are flooded to the sea's level.
// Every carved cell below it is water and every one above it air, so the water
// lies flat and walled in (rock around it, or the sea, at the same level).
//
// Slope and cover. Mouths and shafts ask for the column's slope and cover
// (genSlope, genCover: the layers' own), and only cells near the surface or a
// shaft ask, so the deep cells (most of them) never read the 17 columns cover
// reads.
//
// Stability. A loaded world must not churn (world/generator.js "Stability").
//   - Only bedrock (any stratum) is carved, and plant cover by shafts: never
//     sand or snow, nor the water of the sea or a lake.
//   - Every cave keeps ROOF cells of rock between it and its column's surface,
//     so no powder (at most 3 deep) has a void under it.
//   - Mouths thin the roof only on bare rock, which never moves, and only well
//     above the beaches (MOUTH_ABOVE_SEA) or on cliffs too steep for sand.
//   - No mouths or shafts under standing water (the sea, a lake) or within a
//     lake's clearance (landforms' islandLakeClearance), so no cave reaches a
//     lake's water to drain it.
//   - Trees keep TREE_CLEAR columns from any open cave (caveOpenNear, which
//     genTreeZone asks), so no tree's footing hangs over a mouth or a shaft.
//   - Whatever the terrain, no cell beside or diagonally below a powder cell
//     of its own or a neighbouring column is carved (cavePowderNear): the
//     roof alone kept powder clear only while powder lay on gentle ground.
//   - Shafts open only on rock or plant cover well above the beaches
//     (SHAFT_ABOVE_SEA), on gentle ground (SHAFT_SLOPE_MAX); they carve whole
//     columns from their floor up, wider toward the top (a funnel), so nothing
//     hangs over them.
//   - Speleothems and crystals are solids: they never move.
//
// Cost. Noise is evaluated only between BOTTOM and the roof; each family
// first checks its own range (a level its height band, the 3D tunnels a 2D
// rarity noise, the caverns their depth band) and skips its 3D noise where it
// can't reach. tools/caves-preview.mjs counts the evaluations per cell.

const C = {
  ints: {
    BOTTOM: 3,              // the lowest cave cell: rock below, above the generator's floor (FLOOR_CELLS, 2)
    ROOF: 6,                // rock between any cave and its column's surface, cells (see Stability)
    MOUTH_ROOF: 0,          // ...thinning to this on the steepest ground of a mouth
    CHEESE_ROOF: 12,        // caverns keep at least this much rock over them...
    SHAFT_CELL: 112,        // the shaft site grid: one candidate per this many columns square
    SHAFT_MARGIN: 12,       // ...its centre this far inside its square (at least the funnel's top radius)
    SPELEO_CELL: 7,         // the speleothem site grid, columns square
    SPELEO_MARGIN: 3,       // ...centres this far inside (at least the widest base: SPELEO_R_MAX)
    CRYSTAL_CELL: 14,       // the crystal site grid, cells cube
    CRYSTAL_MARGIN: 5,      // ...centres this far inside (at least the largest cluster: CRYSTAL_R_MAX)
    TREE_CLEAR: 3,          // trees stand at least this many columns from an open cave (caveOpenNear: the widest root flare)
    VALUE: 0,               // caveNoise2 / caveNoise3: return the noise's value...
    DIST: 1,                // ...or its (value - shift) over its gradient's length: a distance, cells
    // parameter streams of a site's hash (thKey)
    K_CHANCE: 1, K_X: 2, K_Z: 3, K_Y: 4, K_R: 5, K_TITE: 6, K_MITE: 7,
  },
  floats: {
    // level tunnels (spaghetti 2D)
    TUN_WAVE: 100.0,        // the path noise's wavelength, cells: tunnels are about half this apart
    TUN_ELEV_WAVE: 170.0,   // the floor's elevation noise
    TUN_STRETCH_WAVE: 120.0,// the stretch noise: tunnels run where it (about ±1) is above CUT...
    TUN_CUT: -0.3,
    TUN_GROW: 40.0,         // ...growing from H_MIN at a stretch's end to H_MAX this many cells in
    TUN_H_MIN: 8.0,         // tunnel height, cells (the player is 5.5)
    TUN_H_MAX: 14.0,
    TUN_WIDTH: 0.8,         // half-width over half-height
    UPPER_FLOOR: 28.0,      // the UPPER level's mean floor, cells above the water table...
    UPPER_AMP: 7.0,         // ...rising and falling this much
    LOWER_FLOOR: 3.0,       // LOWER's: dips below the water table into flooded stretches
    LOWER_AMP: 6.0,
    SEA_FLOOR: -5.0,        // SEA's: flat, its lower part flooded...
    SEA_INLAND: 26.0,       // ...ending under ground higher than this above the water table

    // 3D tunnels (spaghetti 3D)
    SPAG_WAVE_H: 96.0,      // the two noises' wavelength across...
    SPAG_WAVE_V: 56.0,      // ...and up and down (shorter: their zero surfaces lie flatter, so the tunnels do)
    SPAG_RARITY_WAVE: 130.0,// the rarity noise (2D): they run where it is above CUT...
    SPAG_CUT: -0.1,
    SPAG_GROW: 40.0,        // ...growing from R_MIN at a stretch's end to R_MAX this many cells in
    SPAG_R_MIN: 4.0,        // tube radius, cells
    SPAG_R_MAX: 6.5,

    // caverns (cheese)
    CHEESE_WAVE_H: 56.0,    // the noise's wavelength across...
    CHEESE_WAVE_V: 36.0,    // ...and up and down
    CHEESE_CUT: 0.5,        // a cavern where the noise (about ±1) is above this...
    CHEESE_TOP: 24.0,       // ...below this many cells above the water table...
    CHEESE_FADE: 0.25,      // ...the cut rising by up to this much...
    CHEESE_FADE_SPAN: 12.0, // ...over this many cells below the top and below CHEESE_ROOF's depth

    // mouths (entrances)
    MOUTH_WAVE: 80.0,       // the entrance noise: which bare-rock places open...
    MOUTH_CUT: -0.3,        // ...where it (about ±1) is above this...
    MOUTH_SOFT: 0.2,        // ...the roof thinning to MOUTH_ROOF over this much more
    MOUTH_ABOVE_SEA: 8.0,   // on ground at least this far above the water table (clear of the beaches)...
    CLIFF_LO: 1.0,          // ...or lower down on cliffs: from this steepness (cells per cell; sand stops at 0.6, a few columns away)...
    CLIFF_HI: 1.4,          // ...fully at this

    // shafts (sinkholes)
    SHAFT_CHANCE: 0.25,     // chance a site has one
    SHAFT_R: 3.5,           // the shaft's radius, cells...
    FUNNEL_DEPTH: 7.0,      // ...widening over this many cells below the surface...
    FUNNEL_FLARE: 1.0,      // ...by this many cells per cell
    SHAFT_ABOVE_SEA: 14.0,  // only on rock or plant cover this far above the water table (well above the beaches)...
    SHAFT_SLOPE_MAX: 1.0,   // ...and no steeper than this
    SHAFT_SUMP: 4.0,        // shafts drop this far below the water table (a cenote: water at the bottom)

    // speleothems (cones in caverns)
    SPELEO_CHANCE: 0.45,    // chance a site has one
    SPELEO_R_MIN: 1.3,      // base radius, cells
    SPELEO_R_MAX: 2.8,
    TITE_MIN: 2.0,          // stalactite length, cells
    TITE_MAX: 11.0,
    MITE_MIN: 1.0,          // stalagmite height, cells
    MITE_MAX: 6.0,

    // crystal clusters (on cave walls)
    CRYSTAL_IN: 1.6,        // the wall's shell: cells into the cave...
    CRYSTAL_OUT: 1.0,       // ...and into the rock
    CRYSTAL_CHANCE_HIGH: 0.12, // chance a site has a cluster, high up...
    CRYSTAL_CHANCE_DEEP: 0.65, // ...and deep down (but above the water: only faces open to air glow)
    CRYSTAL_HIGH: 30.0,     // "high": this many cells above the water table and up...
    CRYSTAL_DEEP: 2.0,      // ..."deep": this many and down, to the water
    CRYSTAL_R_MIN: 2.2,     // cluster radius, cells
    CRYSTAL_R_MAX: 4.5,
    CRYSTAL_RAGGED: 0.55,   // each cell's reach is this share of the radius and up (a jagged cluster)

    // noise
    EPS: 0.0001,            // the smallest gradient a distance is divided by
    FAR: 1000.0,            // farther than any cave, cells
  },
  salts: {
    UPPER_PATH: 0x5c10, UPPER_ELEV: 0x5c11, UPPER_STRETCH: 0x5c12,
    LOWER_PATH: 0x5c20, LOWER_ELEV: 0x5c21, LOWER_STRETCH: 0x5c22,
    SEA_PATH: 0x5c30, SEA_STRETCH: 0x5c32,
    SPAG_A: 0x5c40, SPAG_B: 0x5c41, SPAG_RARITY: 0x5c42,
    CHEESE: 0x5c50,
    MOUTH: 0x5c60,
    SHAFT: 0x5c70,
    SPELEO: 0x5c80,
    CRYSTAL: 0x5c90, CRYSTAL_CELL: 0x5c91,
  },
};
if (C.floats.SPELEO_R_MAX > C.ints.SPELEO_MARGIN) throw new Error('caves: speleothem bases reach past their site cell');
if (C.floats.CRYSTAL_R_MAX > C.ints.CRYSTAL_MARGIN) throw new Error('caves: crystal clusters reach past their site cell');
if (C.floats.SHAFT_R + C.floats.FUNNEL_DEPTH * C.floats.FUNNEL_FLARE > C.ints.SHAFT_MARGIN) throw new Error('caves: funnels reach past their site cell');

// The geometry, in the shared GLSL subset. (x, y, z) are cell centres where
// floats; G is the column's ground (cells y < G are ground), sea the caves'
// water table.
const SRC = /* glsl */ `
// smoothstep, either way round (a > b falls)
float caveSmooth(float a, float b, float x) {
  float t = clamp(thFdiv(x - a, b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
// Perlin's quintic fade 6t⁵ - 15t⁴ + 10t³ and its derivative 30t²(t - 1)²
float caveFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float caveFadeD(float t) { return 30.0 * t * t * (t * (t - 2.0) + 1.0); }

// 2D gradient noise (thNoised) at (x, z), wavelength wave cells, stream salt:
// its value (about ±1), or with want == CAVE_DIST (value - shift) / |gradient|,
// the distance in cells to where it equals shift.
float caveNoise2(float x, float z, float wave, uint salt, float shift, int want) {
  float n = thNoised(thFdiv(x, wave), thFdiv(z, wave), thStream(salt, 0));
  if (want == CAVE_VALUE) return n;
  float dx = thNoiseDx(), dz = thNoiseDz();
  return thFdiv(n - shift, max(thFdiv(sqrt(dx * dx + dz * dz), wave), CAVE_EPS));
}

// Perlin's improved-noise gradients (Perlin 2002, "Improving Noise"; Minecraft's
// ImprovedNoise uses the same set): the midpoints of a cube's 12 edges, g in
// 0..11, one component at a time. Group g / 4 says which component is 0, and
// g's two low bits the other two's signs.
float caveGx(int g) { return thDiv(g, 4) == 2 ? 0.0 : (thMod(g, 2) == 0 ? 1.0 : -1.0); }
float caveGy(int g) {
  int grp = thDiv(g, 4);
  if (grp == 1) return 0.0;
  return thMod(grp == 0 ? thDiv(g, 2) : g, 2) == 0 ? 1.0 : -1.0;
}
float caveGz(int g) { return thDiv(g, 4) == 0 ? 0.0 : (thMod(thDiv(g, 2), 2) == 0 ? 1.0 : -1.0); }
float caveDot(int g, float fx, float fy, float fz) { return caveGx(g) * fx + caveGy(g) * fy + caveGz(g) * fz; }
// the trilinear blend of 8 corner values (000, 100, 010, 110, 001, 101, 011, 111)
float caveBlend(float a, float b, float c, float d, float e, float f, float g, float h, float ux, float uy, float uz) {
  return mix(mix(mix(a, b, ux), mix(c, d, ux), uy), mix(mix(e, f, ux), mix(g, h, ux), uy), uz);
}

// 3D gradient noise at (x, y, z), wavelength waveH cells across and waveV up
// and down, stream salt: its value (about ±1), or with want == CAVE_DIST
// (value - shift) / |gradient|, the distance in cells to where it equals
// shift. The gradient is analytic: the product rule through the blend
// (Quilez, "gradient noise derivatives").
float caveNoise3(float x, float y, float z, float waveH, float waveV, uint salt, float shift, int want) {
  float px = thFdiv(x, waveH), py = thFdiv(y, waveV), pz = thFdiv(z, waveH);
  float x0 = floor(px), y0 = floor(py), z0 = floor(pz);
  int ix = int(x0), iy = int(y0), iz = int(z0);
  float fx = px - x0, fy = py - y0, fz = pz - z0;
  // corner (ix + a, iy + b, iz + c) has gradient gABC
  uint h00 = thHash2(iy, iz, salt), h10 = thHash2(iy + 1, iz, salt);
  uint h01 = thHash2(iy, iz + 1, salt), h11 = thHash2(iy + 1, iz + 1, salt);
  int g000 = thRange(thKey(h00, ix), 0, 11), g100 = thRange(thKey(h00, ix + 1), 0, 11);
  int g010 = thRange(thKey(h10, ix), 0, 11), g110 = thRange(thKey(h10, ix + 1), 0, 11);
  int g001 = thRange(thKey(h01, ix), 0, 11), g101 = thRange(thKey(h01, ix + 1), 0, 11);
  int g011 = thRange(thKey(h11, ix), 0, 11), g111 = thRange(thKey(h11, ix + 1), 0, 11);
  float v000 = caveDot(g000, fx, fy, fz), v100 = caveDot(g100, fx - 1.0, fy, fz);
  float v010 = caveDot(g010, fx, fy - 1.0, fz), v110 = caveDot(g110, fx - 1.0, fy - 1.0, fz);
  float v001 = caveDot(g001, fx, fy, fz - 1.0), v101 = caveDot(g101, fx - 1.0, fy, fz - 1.0);
  float v011 = caveDot(g011, fx, fy - 1.0, fz - 1.0), v111 = caveDot(g111, fx - 1.0, fy - 1.0, fz - 1.0);
  float ux = caveFade(fx), uy = caveFade(fy), uz = caveFade(fz);
  float n = caveBlend(v000, v100, v010, v110, v001, v101, v011, v111, ux, uy, uz);
  if (want == CAVE_VALUE) return n;
  float nx = caveBlend(caveGx(g000), caveGx(g100), caveGx(g010), caveGx(g110), caveGx(g001), caveGx(g101), caveGx(g011), caveGx(g111), ux, uy, uz)
           + caveFadeD(fx) * mix(mix(v100 - v000, v110 - v010, uy), mix(v101 - v001, v111 - v011, uy), uz);
  float ny = caveBlend(caveGy(g000), caveGy(g100), caveGy(g010), caveGy(g110), caveGy(g001), caveGy(g101), caveGy(g011), caveGy(g111), ux, uy, uz)
           + caveFadeD(fy) * mix(mix(v010 - v000, v110 - v100, ux), mix(v011 - v001, v111 - v101, ux), uz);
  float nz = caveBlend(caveGz(g000), caveGz(g100), caveGz(g010), caveGz(g110), caveGz(g001), caveGz(g101), caveGz(g011), caveGz(g111), ux, uy, uz)
           + caveFadeD(fz) * mix(mix(v001 - v000, v101 - v100, ux), mix(v011 - v010, v111 - v110, ux), uy);
  float sx = thFdiv(nx, waveH), sy = thFdiv(ny, waveV), sz = thFdiv(nz, waveH);
  return thFdiv(n - shift, max(sqrt(sx * sx + sy * sy + sz * sz), CAVE_EPS));
}

// ---- level tunnels (spaghetti 2D)
// A level's floor at column (x, z): base, rising and falling amp.
float caveLevelFloor(float x, float z, float base, float amp, uint elevSalt) {
  return amp > 0.0 ? base + amp * caveNoise2(x, z, CAVE_TUN_ELEV_WAVE, elevSalt, 0.0, CAVE_VALUE) : base;
}
// The distance from cell (x, y, z) to a level's tunnel wall, cells (< 0
// inside). Its floor averages base (cells). The cross-section is an ellipse
// whose lower half is squashed flatter (v² below the middle), so the floor is
// walkable across most of the width. A stretch of tunnel ends in a wall where
// the stretch noise falls below its cut (Minecraft's rarity modulator), or
// where the tunnel no longer fits under room (the roof's underside), or
// where cap (a distance, cells) says so; it is H_MIN tall at its ends,
// growing toward H_MAX inside.
float caveLevel(float x, float y, float z, float base, float amp, float room, float cap, uint pathSalt, uint elevSalt, uint stretchSalt) {
  if (cap > CAVE_CRYSTAL_OUT || y < base - amp - CAVE_CRYSTAL_OUT || y > base + amp + CAVE_TUN_H_MAX + CAVE_CRYSTAL_OUT) return CAVE_FAR;
  float inside = caveNoise2(x, z, CAVE_TUN_STRETCH_WAVE, stretchSalt, CAVE_TUN_CUT, CAVE_DIST);
  if (inside < -CAVE_CRYSTAL_OUT) return CAVE_FAR;
  float semi = 0.5 * mix(CAVE_TUN_H_MIN, CAVE_TUN_H_MAX, caveSmooth(0.0, CAVE_TUN_GROW, inside));
  float floorY = caveLevelFloor(x, z, base, amp, elevSalt);
  float v = thFdiv(y - floorY - semi, semi);
  if (abs(v) > 1.0 + thFdiv(CAVE_CRYSTAL_OUT, semi)) return CAVE_FAR;
  float w = semi * CAVE_TUN_WIDTH;
  float u = thFdiv(caveNoise2(x, z, CAVE_TUN_WAVE, pathSalt, 0.0, CAVE_DIST), w);
  float vv = v < 0.0 ? v * v : v;
  float tube = (sqrt(u * u + vv * vv) - 1.0) * min(w, semi);
  return max(max(tube, -inside), max(cap, floorY + 2.0 * semi - room));
}
float caveUpper(float x, float y, float z, float sea, float room) {
  return caveLevel(x, y, z, sea + CAVE_UPPER_FLOOR, CAVE_UPPER_AMP, room, -CAVE_FAR,
                   CAVE_SALT_UPPER_PATH, CAVE_SALT_UPPER_ELEV, CAVE_SALT_UPPER_STRETCH);
}
float caveLower(float x, float y, float z, float sea, float room) {
  return caveLevel(x, y, z, sea + CAVE_LOWER_FLOOR, CAVE_LOWER_AMP, room, -CAVE_FAR,
                   CAVE_SALT_LOWER_PATH, CAVE_SALT_LOWER_ELEV, CAVE_SALT_LOWER_STRETCH);
}
// the sea level: only under the coast, ending under ground higher than SEA_INLAND above the water
float caveSea(float x, float y, float z, float G, float sea, float room) {
  return caveLevel(x, y, z, sea + CAVE_SEA_FLOOR, 0.0, room, G - sea - CAVE_SEA_INLAND,
                   CAVE_SALT_SEA_PATH, CAVE_SALT_SEA_PATH, CAVE_SALT_SEA_STRETCH);
}

// ---- 3D tunnels (spaghetti 3D): a tube of radius r around the curve where
// two noises' zero surfaces cross; stretches of it end as the level tunnels' do
float caveSpaghetti(float x, float y, float z) {
  float inside = caveNoise2(x, z, CAVE_SPAG_RARITY_WAVE, CAVE_SALT_SPAG_RARITY, CAVE_SPAG_CUT, CAVE_DIST);
  if (inside < -CAVE_CRYSTAL_OUT) return CAVE_FAR;
  float r = mix(CAVE_SPAG_R_MIN, CAVE_SPAG_R_MAX, caveSmooth(0.0, CAVE_SPAG_GROW, inside));
  float a = caveNoise3(x, y, z, CAVE_SPAG_WAVE_H, CAVE_SPAG_WAVE_V, CAVE_SALT_SPAG_A, 0.0, CAVE_DIST);
  if (abs(a) > r + CAVE_CRYSTAL_OUT) return CAVE_FAR;   // far from the first surface: skip the second noise
  float b = caveNoise3(x, y, z, CAVE_SPAG_WAVE_H, CAVE_SPAG_WAVE_V, CAVE_SALT_SPAG_B, 0.0, CAVE_DIST);
  return max(sqrt(a * a + b * b) - r, -inside);
}

// ---- caverns (cheese)
// the noise's cut at height y in a column with ground G: rising toward the
// top of the caverns' range and toward the surface (Minecraft's sloped-cheese
// term does the second)
float caveCheeseCut(float y, float G, float sea) {
  float top = sea + CAVE_CHEESE_TOP, roof = G - float(CAVE_CHEESE_ROOF);
  float rise = max(caveSmooth(top - CAVE_CHEESE_FADE_SPAN, top, y), caveSmooth(roof - CAVE_CHEESE_FADE_SPAN, roof, y));
  return CAVE_CHEESE_CUT + CAVE_CHEESE_FADE * rise;
}
bool caveCheeseRange(float y, float G, float sea) {
  return y < sea + CAVE_CHEESE_TOP && y < G - float(CAVE_CHEESE_ROOF);
}
float caveCheese(float x, float y, float z, float G, float sea) {
  if (!caveCheeseRange(y - CAVE_CRYSTAL_OUT, G, sea)) return CAVE_FAR;
  float cut = caveCheeseCut(y, G, sea);
  return -caveNoise3(x, y, z, CAVE_CHEESE_WAVE_H, CAVE_CHEESE_WAVE_V, CAVE_SALT_CHEESE, cut, CAVE_DIST);
}
// whether cell height y of column (x, z) is cavern rock (not carved by the caverns)
bool caveCheeseSolid(float x, float y, float z, float G, float sea, float top) {
  if (y >= top || y < float(CAVE_BOTTOM) || !caveCheeseRange(y, G, sea)) return true;
  return caveNoise3(x, y, z, CAVE_CHEESE_WAVE_H, CAVE_CHEESE_WAVE_V, CAVE_SALT_CHEESE, 0.0, CAVE_VALUE) <= caveCheeseCut(y, G, sea);
}

// ---- speleothems: a site per SPELEO_CELL square of columns (some empty)
// holds a stalactite of base radius R and length L, and a stalagmite under it.
// A cavern cell d from the site's axis is inside the stalactite when the
// ceiling is within L (1 - d / R) above it: a cone hanging from the ceiling,
// whatever its shape. (The stalagmite likewise, from the floor.)
bool caveSpeleo(int x, int z, float y, float G, float sea, float top) {
  int sx = thDiv(x, CAVE_SPELEO_CELL), sz = thDiv(z, CAVE_SPELEO_CELL);
  uint h = thHash2(sx, sz, CAVE_SALT_SPELEO);
  if (thUnit(thKey(h, CAVE_K_CHANCE)) >= CAVE_SPELEO_CHANCE) return false;
  float cx = float(sx * CAVE_SPELEO_CELL + thRange(thKey(h, CAVE_K_X), CAVE_SPELEO_MARGIN, CAVE_SPELEO_CELL - 1 - CAVE_SPELEO_MARGIN)) + 0.5;
  float cz = float(sz * CAVE_SPELEO_CELL + thRange(thKey(h, CAVE_K_Z), CAVE_SPELEO_MARGIN, CAVE_SPELEO_CELL - 1 - CAVE_SPELEO_MARGIN)) + 0.5;
  float ox = float(x) + 0.5 - cx, oz = float(z) + 0.5 - cz;
  float R = mix(CAVE_SPELEO_R_MIN, CAVE_SPELEO_R_MAX, thUnit(thKey(h, CAVE_K_R)));
  float share = 1.0 - thFdiv(sqrt(ox * ox + oz * oz), R);
  if (share <= 0.0) return false;
  float px = float(x) + 0.5, pz = float(z) + 0.5;
  float up = share * mix(CAVE_TITE_MIN, CAVE_TITE_MAX, thUnit(thKey(h, CAVE_K_TITE)));
  if (caveCheeseSolid(px, y + up, pz, G, sea, top)) return true;
  float down = share * mix(CAVE_MITE_MIN, CAVE_MITE_MAX, thUnit(thKey(h, CAVE_K_MITE)));
  return caveCheeseSolid(px, y - down, pz, G, sea, top);
}

// ---- crystal clusters: a site per CRYSTAL_CELL cube (more of them hold one
// deeper down, none under the water, where no face is open to air to glow); a
// cluster is the part of a ragged ball around it that lies in the wall's
// shell, f (the distance to the wall) between -IN and OUT
bool caveCrystal(int x, int y, int z, float f, float sea) {
  if (f <= -CAVE_CRYSTAL_IN || f >= CAVE_CRYSTAL_OUT) return false;
  int sx = thDiv(x, CAVE_CRYSTAL_CELL), sy = thDiv(y, CAVE_CRYSTAL_CELL), sz = thDiv(z, CAVE_CRYSTAL_CELL);
  uint h = thKey(thHash2(sx, sz, CAVE_SALT_CRYSTAL), sy);
  int lo = CAVE_CRYSTAL_MARGIN, hi = CAVE_CRYSTAL_CELL - 1 - CAVE_CRYSTAL_MARGIN;
  float cy = float(sy * CAVE_CRYSTAL_CELL + thRange(thKey(h, CAVE_K_Y), lo, hi)) + 0.5;
  if (cy < sea) return false;
  float chance = mix(CAVE_CRYSTAL_CHANCE_HIGH, CAVE_CRYSTAL_CHANCE_DEEP,
                     caveSmooth(sea + CAVE_CRYSTAL_HIGH, sea + CAVE_CRYSTAL_DEEP, cy));
  if (thUnit(thKey(h, CAVE_K_CHANCE)) >= chance) return false;
  float ox = float(x - sx * CAVE_CRYSTAL_CELL - thRange(thKey(h, CAVE_K_X), lo, hi));
  float oz = float(z - sz * CAVE_CRYSTAL_CELL - thRange(thKey(h, CAVE_K_Z), lo, hi));
  float oy = float(y) + 0.5 - cy;
  float R = mix(CAVE_CRYSTAL_R_MIN, CAVE_CRYSTAL_R_MAX, thUnit(thKey(h, CAVE_K_R)));
  float reach = R * mix(CAVE_CRYSTAL_RAGGED, 1.0, thUnit(thKey(thHash2(x, z, CAVE_SALT_CRYSTAL_CELL), y)));
  return ox * ox + oy * oy + oz * oz < reach * reach;
}

// ---- mouths: the rock kept over caves in column (x, z), cells: ROOF, thinning
// to MOUTH_ROOF where the entrance noise says so, on bare rock (the layers'
// cover: none) well above the sea, or on cliffs nearer it. The caller asks only
// on dry land clear of lakes.
float caveRoof(int x, int z, float G, float sea) {
  float site = G >= sea + CAVE_MOUTH_ABOVE_SEA ? 1.0 : caveSmooth(CAVE_CLIFF_LO, CAVE_CLIFF_HI, genSlope(x, z));
  if (site <= 0.0) return float(CAVE_ROOF);
  float gate = caveNoise2(float(x) + 0.5, float(z) + 0.5, CAVE_MOUTH_WAVE, CAVE_SALT_MOUTH, 0.0, CAVE_VALUE);
  float k = site * caveSmooth(CAVE_MOUTH_CUT, CAVE_MOUTH_CUT + CAVE_MOUTH_SOFT, gate);
  if (k <= 0.0 || genCover(x, z) != GEN_COVER_NONE) return float(CAVE_ROOF);
  return mix(float(CAVE_ROOF), float(CAVE_MOUTH_ROOF), k);
}

// ---- shafts: a site per SHAFT_CELL square of columns may hold a sinkhole, a
// shaft of radius SHAFT_R from the surface down past the water table (a
// cenote: water stands at its bottom, at the sea's level, and any tunnel or
// cavern it passes opens into it), flaring into a funnel near the top, on
// gentle bare rock or plant cover. The distance from cell height y of column
// (x, z) to its wall, cells. The caller asks only on dry land clear of lakes.
float caveShaft(int x, int z, float y, float G, float sea) {
  if (G < sea + CAVE_SHAFT_ABOVE_SEA || y < sea - CAVE_SHAFT_SUMP) return CAVE_FAR;
  int sx = thDiv(x, CAVE_SHAFT_CELL), sz = thDiv(z, CAVE_SHAFT_CELL);
  uint h = thHash2(sx, sz, CAVE_SALT_SHAFT);
  if (thUnit(thKey(h, CAVE_K_CHANCE)) >= CAVE_SHAFT_CHANCE) return CAVE_FAR;
  float ox = float(x - sx * CAVE_SHAFT_CELL - thRange(thKey(h, CAVE_K_X), CAVE_SHAFT_MARGIN, CAVE_SHAFT_CELL - 1 - CAVE_SHAFT_MARGIN));
  float oz = float(z - sz * CAVE_SHAFT_CELL - thRange(thKey(h, CAVE_K_Z), CAVE_SHAFT_MARGIN, CAVE_SHAFT_CELL - 1 - CAVE_SHAFT_MARGIN));
  float d = sqrt(ox * ox + oz * oz) - CAVE_SHAFT_R - max(0.0, CAVE_FUNNEL_DEPTH - (G - y)) * CAVE_FUNNEL_FLARE;
  if (d >= CAVE_CRYSTAL_OUT || genSlope(x, z) > CAVE_SHAFT_SLOPE_MAX) return CAVE_FAR;
  int cover = genCover(x, z);
  return cover == GEN_COVER_NONE || cover == GEN_COVER_PLANT ? d : CAVE_FAR;
}

// Whether column (x, z) is within a mountain lake's clearance, where nothing
// is carved (no cave may reach a lake's water and drain it): landforms'
// islandLakeClearance, in the cell stage ahead of this source.
bool caveLakeClear(int x, int z) { return islandLakeClearance(float(x), float(z)); }
// Whether caves may open out of column (x, z), its ground G (cells) and
// standing water at water: on dry land only (not under the sea or a lake).
bool caveOpenable(float G, float water) { return water <= G; }

// Whether a powder cell (sand, snow: the layers' cover, genCover) of column
// (x, z) or one of its 8 neighbours could topple into cell (x, y, z): the cell
// beside one, or diagonally below it (move.js). Such a cell is never carved,
// however the terrain stands: landforms put sand floors and beaches at the
// foot of walls a cave runs behind. Only a neighbour whose cover reaches down
// to this cell is asked for its cover.
bool cavePowderNear(int x, int y, int z) {
  int deepest = max(GEN_SAND_DEPTH, GEN_SNOW_DEPTH);
  for (int dz = -1; dz <= 1; dz++)
    for (int dx = -1; dx <= 1; dx++) {
      int g = genTop(x + dx, z + dz);
      if (y >= g || y < g - deepest - 1) continue;
      int cover = genCover(x + dx, z + dz);
      int depth = cover == GEN_COVER_SAND ? GEN_SAND_DEPTH : (cover == GEN_COVER_SNOW ? GEN_SNOW_DEPTH : 0);
      if (depth > 0 && y >= g - depth - 1) return true;
    }
  return false;
}

// The element at world cell (x, y, z) after carving, given id, what the island
// put there: id where nothing is carved. ground: the column's terrain height
// (cells, after landforms: its ground cells are y < thRound(ground)); water:
// its standing water's level, which says only where mouths and shafts may open
// (dry land): the caves' own water table is the sea's (uGenSea), whatever a
// lake's level.
int islandCave(int x, int y, int z, float ground, float water, int id) {
  if (y < CAVE_BOTTOM || id == E_EMPTY || id == E_WATER || id == E_SAND || id == E_SNOW) return id;
  if (caveLakeClear(x, z)) return id;
  float G = float(thRound(ground)), sea = uGenSea, py = float(y) + 0.5;
  bool open = caveOpenable(G, water);   // mouths and shafts
  float shaft = open ? caveShaft(x, z, py, G, sea) : CAVE_FAR;
  // the roof: only cells a level tunnel could reach it from ask whether it thins here
  float roof = float(CAVE_ROOF);
  if (open && py + CAVE_TUN_H_MAX + CAVE_CRYSTAL_OUT > G - float(CAVE_ROOF)) roof = caveRoof(x, z, G, sea);
  float top = G - roof, f = shaft;
  if (id != E_PLANT && float(y) < top) {
    float px = float(x) + 0.5, pz = float(z) + 0.5;
    // level tunnels end where they no longer fit under a full roof; at mouths they run out into the open
    float room = roof < float(CAVE_ROOF) ? CAVE_FAR : top;
    float tunnels = min(min(caveUpper(px, py, pz, sea, room), caveLower(px, py, pz, sea, room)),
                        min(caveSea(px, py, pz, G, sea, room), caveSpaghetti(px, py, pz)));
    float cavern = caveCheese(px, py, pz, G, sea);
    f = min(f, min(tunnels, cavern));
    if (f < 0.0 && cavern < 0.0 && tunnels >= 0.0 && shaft >= 0.0 && caveSpeleo(x, z, py, G, sea, top)) return id;   // a speleothem: the stratum's rock
    if (caveCrystal(x, y, z, f, sea)) return E_CRYSTAL;
  }
  if (f >= 0.0 || cavePowderNear(x, y, z)) return id;
  return float(y) < sea ? E_WATER : E_EMPTY;
}

// How open a hillside cave mouth is at world column (x, z): how many of its
// top ROOF ground cells the caves carve where the roof thins for a mouth (0:
// no mouth; a shaft's funnel doesn't count). The structures layer
// (world/structures.js) reads it to set mines at cave mouths.
float islandCaveMouth(int x, int z) {
  float ground = genColHeight(x, z), water = genColWater(x, z);
  float G = float(thRound(ground));
  if (!caveOpenable(G, water) || caveLakeClear(x, z) || caveRoof(x, z, G, uGenSea) >= float(CAVE_ROOF)
      || caveShaft(x, z, G - 0.5, G, uGenSea) < 0.0) return 0.0;
  float open = 0.0;
  for (int d = 1; d <= CAVE_ROOF; d++) {
    int c = islandCave(x, int(G) - d, z, ground, water, E_ROCK);
    if (c == E_EMPTY || c == E_WATER) open += 1.0;
  }
  return open;
}

// Whether a cave may open within TREE_CLEAR columns of column (x, z): a
// column there whose roof thins (a mouth's) or that a shaft's funnel takes.
// genTreeZone keeps trees off them, so no tree's footing or root flare hangs
// over an open cave.
bool caveOpenNear(int x, int z) {
  for (int dz = -CAVE_TREE_CLEAR; dz <= CAVE_TREE_CLEAR; dz++)
    for (int dx = -CAVE_TREE_CLEAR; dx <= CAVE_TREE_CLEAR; dx++) {
      int cx = x + dx, cz = z + dz;
      float G = float(genTop(cx, cz));
      if (!caveOpenable(G, genColWater(cx, cz)) || caveLakeClear(cx, cz)) continue;
      if (caveRoof(cx, cz, G, uGenSea) < float(CAVE_ROOF) || caveShaft(cx, cz, G - 0.5, G, uGenSea) < 0.0) return true;
    }
  return false;
}
`;

export const caves = { prefix: 'CAVE', tables: C, src: SRC };
export const CAVE = { ...C.ints, ...C.floats };
