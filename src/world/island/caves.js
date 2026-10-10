import { definesGLSL, jsConstants, compileShared } from '../scenes/themedShared.js';
import { E } from '../../elements.js';

// Caves under the island: the last step of every island cell. The island
// calls islandCave on each cell with the element its heightfield layers gave
// it, and gets back the element after carving. Written once in the shared GLSL
// subset (scenes/themedShared.js): the GPU runs it, the CPU its JS twin
// (caveTwin; tools/caves-preview.mjs).
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
//   - mouths: on steep hillsides (Minecraft's "entrances" noise picks which)
//     the rock roof thins to nothing, so tunnels running into the slope open
//     out of it. Steep ground is bare rock: no sand, plant cover, snow or trees
//     stand there (world/generator.js: BEACH_SLOPE_MAX, PLANT_SLOPE_MAX,
//     SNOW_SLOPE_MAX, TREE.SLOPE_MAX);
//   - shafts: a few sinkholes, funnels dropping from gentle ground into a
//     level tunnel.
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
// Water. Carved cells below the water table (the column's `water`: the sea
// level) are water: deep caverns hold flat underground lakes, sea-level
// tunnels are flooded to the sea's level. Every carved cell below it is water
// and every one above it air, so the water lies flat and walled in (rock
// around it, or the sea, at the same level). That needs one water table under
// all connected caves: a perched lake's level must not be passed as `water`.
//
// Stability. A loaded world must not churn (world/generator.js "Stability").
//   - Only rock is carved (and plant cover, by shafts): never sand or snow.
//   - Every cave keeps ROOF cells of rock between it and its column's surface.
//     The island's powders lie at most 3 deep, on gentle columns whose
//     neighbours stand within 2 cells of them, so with ROOF at least 3 + 3 no
//     powder cell has a void below it, beside it or diagonally below it.
//   - Mouths thin the roof only on steep ground (MOUTH_SLOPE_LO and up): bare
//     rock, which never moves.
//   - Shafts open only on columns well above the beaches (SHAFT_ABOVE_SEA) and
//     gentle enough to hold no trees' worth of overhang (SHAFT_SLOPE_MAX);
//     they carve whole columns from their floor up, wider toward the top (a
//     funnel), so nothing hangs over them.
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
    CRYSTAL_CELL: 13,       // the crystal site grid, cells cube
    CRYSTAL_MARGIN: 4,      // ...centres this far inside (at least the largest cluster: CRYSTAL_R_MAX)
    CRYSTAL: E.GLASS,       // placeholder for the glowing crystal element until it lands
    SPELEO: E.ROCK,         // what stalactites and stalagmites are made of
    VALUE: 0,               // caveNoise2 / caveNoise3: return the noise's value...
    DIST: 1,                // ...or its (value - shift) over its gradient's length: a distance, cells
    LEVEL_UPPER: 0,         // the level a shaft drops into (thRange over these)
    LEVEL_LOWER: 1,
    // parameter streams of a site's hash (thKey)
    K_CHANCE: 1, K_X: 2, K_Z: 3, K_Y: 4, K_R: 5, K_TITE: 6, K_MITE: 7, K_LEVEL: 8,
  },
  floats: {
    // level tunnels (spaghetti 2D)
    TUN_WAVE: 110.0,        // the path noise's wavelength, cells: tunnels are this far apart, give or take
    TUN_ELEV_WAVE: 170.0,   // the floor's elevation noise
    TUN_SIZE_WAVE: 90.0,    // the size (and presence) noise
    TUN_CUT: -0.15,         // no tunnel where the size noise (about ±1) is below this...
    TUN_SOFT: 0.2,          // ...tapering in over this much more (dead ends narrow and close)...
    TUN_SIZE_SPAN: 0.5,     // ...then growing from H_MIN to H_MAX over this much more
    TUN_H_MIN: 8.0,         // tunnel height, cells (the player is 5.5)
    TUN_H_MAX: 14.0,
    TUN_WIDTH: 0.8,         // half-width over half-height
    UPPER_FLOOR: 28.0,      // the UPPER level's mean floor, cells above the water table...
    UPPER_AMP: 7.0,         // ...rising and falling this much
    LOWER_FLOOR: 3.0,       // LOWER's: dips below the water table into flooded stretches
    LOWER_AMP: 6.0,
    SEA_FLOOR: -5.0,        // SEA's: flat, its lower part flooded...
    SEA_INLAND: 26.0,       // ...under columns no more than this far above the water table...
    SEA_FADE: 8.0,          // ...tapering out over this many cells of ground below that

    // 3D tunnels (spaghetti 3D)
    SPAG_WAVE_H: 96.0,      // the two noises' wavelength across...
    SPAG_WAVE_V: 56.0,      // ...and up and down (shorter: their zero surfaces lie flatter, so the tunnels do)
    SPAG_RARITY_WAVE: 130.0,// the rarity noise (2D): where it is below CUT there are none
    SPAG_CUT: 0.05,
    SPAG_SOFT: 0.2,
    SPAG_SIZE_SPAN: 0.5,
    SPAG_R_MIN: 4.0,        // tube radius, cells
    SPAG_R_MAX: 6.5,

    // caverns (cheese)
    CHEESE_WAVE_H: 105.0,   // the noise's wavelength across...
    CHEESE_WAVE_V: 62.0,    // ...and up and down
    CHEESE_CUT: 0.42,       // a cavern where the noise (about ±1) is above this...
    CHEESE_TOP: 24.0,       // ...below this many cells above the water table...
    CHEESE_FADE: 0.25,      // ...the cut rising by up to this much...
    CHEESE_FADE_SPAN: 12.0, // ...over this many cells below the top and below CHEESE_ROOF's depth

    // mouths (entrances)
    MOUTH_SLOPE_LO: 1.45,   // the roof thins on columns steeper than this (cells per cell; plant cover stops at 1.3)...
    MOUTH_SLOPE_HI: 2.0,    // ...to MOUTH_ROOF at this
    MOUTH_WAVE: 80.0,       // the entrance noise: which steep places open
    MOUTH_CUT: -0.1,
    MOUTH_SOFT: 0.2,

    // shafts (sinkholes)
    SHAFT_CHANCE: 0.6,      // chance a site has one (if a level tunnel runs under it)
    SHAFT_R: 3.5,           // the shaft's radius, cells...
    FUNNEL_DEPTH: 7.0,      // ...widening over this many cells below the surface...
    FUNNEL_FLARE: 1.0,      // ...by this many cells per cell
    SHAFT_ABOVE_SEA: 14.0,  // only on ground this far above the water table (well above the beaches)...
    SHAFT_SLOPE_MAX: 1.0,   // ...and no steeper than this

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
    CRYSTAL_CHANCE_DEEP: 0.65, // ...and deep down
    CRYSTAL_HIGH: 30.0,     // "high": this many cells above the water table and up...
    CRYSTAL_DEEP: 0.0,      // ..."deep": this many and down
    CRYSTAL_R_MIN: 1.8,     // cluster radius, cells
    CRYSTAL_R_MAX: 3.6,
    CRYSTAL_RAGGED: 0.55,   // each cell's reach is this share of the radius and up (a jagged cluster)

    // noise
    NOISE2_NORM: 1.4142,    // 2D gradient noise peaks near ±1/√2: this scales it to about ±1
    TAU: 6.28318530718,
    EPS: 0.0001,            // the smallest gradient a distance is divided by
    FAR: 1000.0,            // farther than any cave, cells
  },
  salts: {
    UPPER_PATH: 0x5c10, UPPER_ELEV: 0x5c11, UPPER_SIZE: 0x5c12,
    LOWER_PATH: 0x5c20, LOWER_ELEV: 0x5c21, LOWER_SIZE: 0x5c22,
    SEA_PATH: 0x5c30, SEA_SIZE: 0x5c32,
    SPAG_A: 0x5c40, SPAG_B: 0x5c41, SPAG_RARITY: 0x5c42,
    CHEESE: 0x5c50,
    MOUTH: 0x5c60,
    SHAFT: 0x5c70,
    SPELEO: 0x5c80,
    CRYSTAL: 0x5c90, CRYSTAL_CELL: 0x5c91,
  },
};
const PREFIX = 'CAVE';
if (C.floats.SPELEO_R_MAX > C.ints.SPELEO_MARGIN) throw new Error('caves: speleothem bases reach past their site cell');
if (C.floats.CRYSTAL_R_MAX > C.ints.CRYSTAL_MARGIN) throw new Error('caves: crystal clusters reach past their site cell');
if (C.floats.SHAFT_R + C.floats.FUNNEL_DEPTH * C.floats.FUNNEL_FLARE > C.ints.SHAFT_MARGIN) throw new Error('caves: funnels reach past their site cell');

// The geometry, in the shared GLSL subset. (x, y, z) are cell centres where
// floats; G is the column's ground (cells y < G are ground), water the water
// table.
const SRC = /* glsl */ `
// smoothstep, either way round (a > b falls)
float caveSmooth(float a, float b, float x) {
  float t = clamp(thFdiv(x - a, b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
// Perlin's quintic fade 6t⁵ - 15t⁴ + 10t³ and its derivative 30t²(t - 1)²
float caveFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float caveFadeD(float t) { return 30.0 * t * t * (t * (t - 2.0) + 1.0); }

// 2D gradient noise at (x, z), wavelength wave cells, stream salt: its value
// (about ±1), or with want == CAVE_DIST (value - shift) / |gradient|, the
// distance in cells to where it equals shift. Gradients at a hashed angle per
// lattice point (as shaders/generate.js genNoised).
float caveNoise2(float x, float z, float wave, uint salt, float shift, int want) {
  float px = thFdiv(x, wave), pz = thFdiv(z, wave);
  float x0 = floor(px), z0 = floor(pz);
  int ix = int(x0), iz = int(z0);
  float fx = px - x0, fz = pz - z0;
  float a = thLattice(ix, iz, salt) * CAVE_TAU, b = thLattice(ix + 1, iz, salt) * CAVE_TAU;
  float c = thLattice(ix, iz + 1, salt) * CAVE_TAU, d = thLattice(ix + 1, iz + 1, salt) * CAVE_TAU;
  float ax = cos(a), az = sin(a), bx = cos(b), bz = sin(b);
  float cx = cos(c), cz = sin(c), dx = cos(d), dz = sin(d);
  float va = ax * fx + az * fz, vb = bx * (fx - 1.0) + bz * fz;
  float vc = cx * fx + cz * (fz - 1.0), vd = dx * (fx - 1.0) + dz * (fz - 1.0);
  float ux = caveFade(fx), uz = caveFade(fz);
  float n = mix(mix(va, vb, ux), mix(vc, vd, ux), uz) * CAVE_NOISE2_NORM;
  if (want == CAVE_VALUE) return n;
  float gx = mix(mix(ax, bx, ux), mix(cx, dx, ux), uz) + caveFadeD(fx) * mix(vb - va, vd - vc, uz);
  float gz = mix(mix(az, bz, ux), mix(cz, dz, ux), uz) + caveFadeD(fz) * mix(vc - va, vd - vb, ux);
  return thFdiv(n - shift, max(thFdiv(sqrt(gx * gx + gz * gz) * CAVE_NOISE2_NORM, wave), CAVE_EPS));
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
// inside). Its floor averages base (cells), its size is scaled by scale (0..1,
// 0: none). The cross-section is an ellipse whose lower half is squashed
// flatter (v² below the middle), so the floor is walkable across most of the
// width.
float caveLevel(float x, float y, float z, float base, float amp, float scale, uint pathSalt, uint elevSalt, uint sizeSalt) {
  if (scale <= 0.0 || y < base - amp - CAVE_CRYSTAL_OUT || y > base + amp + CAVE_TUN_H_MAX + CAVE_CRYSTAL_OUT) return CAVE_FAR;
  float s = caveNoise2(x, z, CAVE_TUN_SIZE_WAVE, sizeSalt, 0.0, CAVE_VALUE);
  float k = scale * caveSmooth(CAVE_TUN_CUT, CAVE_TUN_CUT + CAVE_TUN_SOFT, s);
  if (k <= 0.0) return CAVE_FAR;
  float semi = 0.5 * k * mix(CAVE_TUN_H_MIN, CAVE_TUN_H_MAX,
                             caveSmooth(CAVE_TUN_CUT + CAVE_TUN_SOFT, CAVE_TUN_CUT + CAVE_TUN_SOFT + CAVE_TUN_SIZE_SPAN, s));
  float v = thFdiv(y - caveLevelFloor(x, z, base, amp, elevSalt) - semi, semi);
  if (abs(v) > 1.0 + thFdiv(CAVE_CRYSTAL_OUT, semi)) return CAVE_FAR;
  float w = semi * CAVE_TUN_WIDTH;
  float u = thFdiv(caveNoise2(x, z, CAVE_TUN_WAVE, pathSalt, 0.0, CAVE_DIST), w);
  float vv = v < 0.0 ? v * v : v;
  return (sqrt(u * u + vv * vv) - 1.0) * min(w, semi);
}
float caveUpper(float x, float y, float z, float water) {
  return caveLevel(x, y, z, water + CAVE_UPPER_FLOOR, CAVE_UPPER_AMP, 1.0, CAVE_SALT_UPPER_PATH, CAVE_SALT_UPPER_ELEV, CAVE_SALT_UPPER_SIZE);
}
float caveLower(float x, float y, float z, float water) {
  return caveLevel(x, y, z, water + CAVE_LOWER_FLOOR, CAVE_LOWER_AMP, 1.0, CAVE_SALT_LOWER_PATH, CAVE_SALT_LOWER_ELEV, CAVE_SALT_LOWER_SIZE);
}
// the sea level: only under the coast (ground no higher than SEA_INLAND above the water)
float caveSea(float x, float y, float z, float G, float water) {
  float scale = caveSmooth(water + CAVE_SEA_INLAND, water + CAVE_SEA_INLAND - CAVE_SEA_FADE, G);
  return caveLevel(x, y, z, water + CAVE_SEA_FLOOR, 0.0, scale, CAVE_SALT_SEA_PATH, CAVE_SALT_SEA_PATH, CAVE_SALT_SEA_SIZE);
}

// ---- 3D tunnels (spaghetti 3D): a tube of radius r around the curve where
// two noises' zero surfaces cross
float caveSpaghetti(float x, float y, float z) {
  float s = caveNoise2(x, z, CAVE_SPAG_RARITY_WAVE, CAVE_SALT_SPAG_RARITY, 0.0, CAVE_VALUE);
  float k = caveSmooth(CAVE_SPAG_CUT, CAVE_SPAG_CUT + CAVE_SPAG_SOFT, s);
  if (k <= 0.0) return CAVE_FAR;
  float r = k * mix(CAVE_SPAG_R_MIN, CAVE_SPAG_R_MAX,
                    caveSmooth(CAVE_SPAG_CUT + CAVE_SPAG_SOFT, CAVE_SPAG_CUT + CAVE_SPAG_SOFT + CAVE_SPAG_SIZE_SPAN, s));
  float a = caveNoise3(x, y, z, CAVE_SPAG_WAVE_H, CAVE_SPAG_WAVE_V, CAVE_SALT_SPAG_A, 0.0, CAVE_DIST);
  if (abs(a) > r + CAVE_CRYSTAL_OUT) return CAVE_FAR;   // far from the first surface: skip the second noise
  float b = caveNoise3(x, y, z, CAVE_SPAG_WAVE_H, CAVE_SPAG_WAVE_V, CAVE_SALT_SPAG_B, 0.0, CAVE_DIST);
  return sqrt(a * a + b * b) - r;
}

// ---- caverns (cheese)
// the noise's cut at height y in a column with ground G: rising toward the
// top of the caverns' range and toward the surface (Minecraft's sloped-cheese
// term does the second)
float caveCheeseCut(float y, float G, float water) {
  float top = water + CAVE_CHEESE_TOP, roof = G - float(CAVE_CHEESE_ROOF);
  float rise = max(caveSmooth(top - CAVE_CHEESE_FADE_SPAN, top, y), caveSmooth(roof - CAVE_CHEESE_FADE_SPAN, roof, y));
  return CAVE_CHEESE_CUT + CAVE_CHEESE_FADE * rise;
}
bool caveCheeseRange(float y, float G, float water) {
  return y < water + CAVE_CHEESE_TOP && y < G - float(CAVE_CHEESE_ROOF);
}
float caveCheese(float x, float y, float z, float G, float water) {
  if (!caveCheeseRange(y - CAVE_CRYSTAL_OUT, G, water)) return CAVE_FAR;
  float cut = caveCheeseCut(y, G, water);
  return -caveNoise3(x, y, z, CAVE_CHEESE_WAVE_H, CAVE_CHEESE_WAVE_V, CAVE_SALT_CHEESE, cut, CAVE_DIST);
}
// whether cell height y of column (x, z) is cavern rock (not carved by the caverns)
bool caveCheeseSolid(float x, float y, float z, float G, float water, float top) {
  if (y >= top || y < float(CAVE_BOTTOM) || !caveCheeseRange(y, G, water)) return true;
  return caveNoise3(x, y, z, CAVE_CHEESE_WAVE_H, CAVE_CHEESE_WAVE_V, CAVE_SALT_CHEESE, 0.0, CAVE_VALUE) <= caveCheeseCut(y, G, water);
}

// ---- speleothems: a site per SPELEO_CELL square of columns (some empty)
// holds a stalactite of base radius R and length L, and a stalagmite under it.
// A cavern cell d from the site's axis is inside the stalactite when the
// ceiling is within L (1 - d / R) above it: a cone hanging from the ceiling,
// whatever its shape. (The stalagmite likewise, from the floor.)
bool caveSpeleo(int x, int z, float y, float G, float water, float top) {
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
  if (caveCheeseSolid(px, y + up, pz, G, water, top)) return true;
  float down = share * mix(CAVE_MITE_MIN, CAVE_MITE_MAX, thUnit(thKey(h, CAVE_K_MITE)));
  return caveCheeseSolid(px, y - down, pz, G, water, top);
}

// ---- crystal clusters: a site per CRYSTAL_CELL cube (more of them hold one
// deeper down); a cluster is the part of a ragged ball around it that lies in
// the wall's shell, f (the distance to the wall) between -IN and OUT
bool caveCrystal(int x, int y, int z, float f, float water) {
  if (f <= -CAVE_CRYSTAL_IN || f >= CAVE_CRYSTAL_OUT) return false;
  int sx = thDiv(x, CAVE_CRYSTAL_CELL), sy = thDiv(y, CAVE_CRYSTAL_CELL), sz = thDiv(z, CAVE_CRYSTAL_CELL);
  uint h = thKey(thHash2(sx, sz, CAVE_SALT_CRYSTAL), sy);
  int lo = CAVE_CRYSTAL_MARGIN, hi = CAVE_CRYSTAL_CELL - 1 - CAVE_CRYSTAL_MARGIN;
  float cy = float(sy * CAVE_CRYSTAL_CELL + thRange(thKey(h, CAVE_K_Y), lo, hi)) + 0.5;
  float chance = mix(CAVE_CRYSTAL_CHANCE_HIGH, CAVE_CRYSTAL_CHANCE_DEEP,
                     caveSmooth(water + CAVE_CRYSTAL_HIGH, water + CAVE_CRYSTAL_DEEP, cy));
  if (thUnit(thKey(h, CAVE_K_CHANCE)) >= chance) return false;
  float ox = float(x - sx * CAVE_CRYSTAL_CELL - thRange(thKey(h, CAVE_K_X), lo, hi));
  float oz = float(z - sz * CAVE_CRYSTAL_CELL - thRange(thKey(h, CAVE_K_Z), lo, hi));
  float oy = float(y) + 0.5 - cy;
  float R = mix(CAVE_CRYSTAL_R_MIN, CAVE_CRYSTAL_R_MAX, thUnit(thKey(h, CAVE_K_R)));
  float reach = R * mix(CAVE_CRYSTAL_RAGGED, 1.0, thUnit(thKey(thHash2(x, z, CAVE_SALT_CRYSTAL_CELL), y)));
  return ox * ox + oy * oy + oz * oz < reach * reach;
}

// ---- mouths: the rock kept over caves in column (x, z), cells: ROOF, thinning
// on steep ground where the entrance noise says so
float caveRoof(int x, int z, float slope) {
  if (slope <= CAVE_MOUTH_SLOPE_LO) return float(CAVE_ROOF);
  float gate = caveNoise2(float(x) + 0.5, float(z) + 0.5, CAVE_MOUTH_WAVE, CAVE_SALT_MOUTH, 0.0, CAVE_VALUE);
  float k = caveSmooth(CAVE_MOUTH_SLOPE_LO, CAVE_MOUTH_SLOPE_HI, slope) * caveSmooth(CAVE_MOUTH_CUT, CAVE_MOUTH_CUT + CAVE_MOUTH_SOFT, gate);
  return mix(float(CAVE_ROOF), float(CAVE_MOUTH_ROOF), k);
}

// ---- shafts: a site per SHAFT_CELL square of columns may hold a sinkhole, a
// shaft of radius SHAFT_R dropping from the surface to the floor of the level
// tunnel under it (if one runs there), flaring into a funnel near the top.
// The distance from cell height y of column (x, z) to its wall, cells.
float caveShaft(int x, int z, float y, float G, float water, float slope) {
  if (G < water + CAVE_SHAFT_ABOVE_SEA || slope > CAVE_SHAFT_SLOPE_MAX) return CAVE_FAR;
  int sx = thDiv(x, CAVE_SHAFT_CELL), sz = thDiv(z, CAVE_SHAFT_CELL);
  uint h = thHash2(sx, sz, CAVE_SALT_SHAFT);
  if (thUnit(thKey(h, CAVE_K_CHANCE)) >= CAVE_SHAFT_CHANCE) return CAVE_FAR;
  float cx = float(sx * CAVE_SHAFT_CELL + thRange(thKey(h, CAVE_K_X), CAVE_SHAFT_MARGIN, CAVE_SHAFT_CELL - 1 - CAVE_SHAFT_MARGIN)) + 0.5;
  float cz = float(sz * CAVE_SHAFT_CELL + thRange(thKey(h, CAVE_K_Z), CAVE_SHAFT_MARGIN, CAVE_SHAFT_CELL - 1 - CAVE_SHAFT_MARGIN)) + 0.5;
  float ox = float(x) + 0.5 - cx, oz = float(z) + 0.5 - cz;
  float d = sqrt(ox * ox + oz * oz);
  float r = CAVE_SHAFT_R + max(0.0, CAVE_FUNNEL_DEPTH - (G - y)) * CAVE_FUNNEL_FLARE;
  if (d >= r + CAVE_CRYSTAL_OUT) return CAVE_FAR;
  // the level it drops into, and whether that level's tunnel runs under the site
  bool upper = thRange(thKey(h, CAVE_K_LEVEL), CAVE_LEVEL_UPPER, CAVE_LEVEL_LOWER) == CAVE_LEVEL_UPPER;
  float base = water + (upper ? CAVE_UPPER_FLOOR : CAVE_LOWER_FLOOR);
  float floorY = upper ? caveLevelFloor(cx, cz, base, CAVE_UPPER_AMP, CAVE_SALT_UPPER_ELEV)
                       : caveLevelFloor(cx, cz, base, CAVE_LOWER_AMP, CAVE_SALT_LOWER_ELEV);
  float mid = floorY + 0.5 * CAVE_TUN_H_MIN;
  float tunnel = upper ? caveUpper(cx, mid, cz, water) : caveLower(cx, mid, cz, water);
  if (tunnel >= 0.0 || y < floorY) return CAVE_FAR;
  return d - r;
}

// The element of island cell (x, y, z) after carving: id is what the
// heightfield's layers gave it, ground its column's height (cells y < ground,
// rounded, are ground), water the water table, slope the column's steepness
// (cells per cell, as the layers measure it).
int islandCave(int x, int y, int z, float ground, float water, float slope, int id) {
  if (y < CAVE_BOTTOM || (id != E_ROCK && id != E_PLANT)) return id;
  float G = float(thRound(ground));
  float py = float(y) + 0.5;
  float shaft = caveShaft(x, z, py, G, water, slope);
  float top = G - caveRoof(x, z, slope);
  float f = shaft;
  if (id == E_ROCK && float(y) < top) {
    float px = float(x) + 0.5, pz = float(z) + 0.5;
    float tunnels = min(min(caveUpper(px, py, pz, water), caveLower(px, py, pz, water)),
                        min(caveSea(px, py, pz, G, water), caveSpaghetti(px, py, pz)));
    float cavern = caveCheese(px, py, pz, G, water);
    f = min(f, min(tunnels, cavern));
    if (f < 0.0 && cavern < 0.0 && tunnels >= 0.0 && shaft >= 0.0 && caveSpeleo(x, z, py, G, water, top)) return CAVE_SPELEO;
    if (caveCrystal(x, y, z, f, water)) return CAVE_CRYSTAL;
  }
  if (f >= 0.0) return id;
  return float(y) < water ? E_WATER : E_EMPTY;
}
`;

export const CAVE = { ...C.ints, ...C.floats };
export const CAVE_SRC = SRC;
// The #defines SRC needs (after the prelude and themedShared's helpersGLSL).
export const caveDefinesGLSL = () => definesGLSL(PREFIX, C);
export const caveGLSL = () => `${caveDefinesGLSL()}\n${SRC}`;
// Its constants for a JS twin (compileShared's consts).
export const caveConstants = () => jsConstants(PREFIX, C);
// The JS twin for world seed `seed`, with some constants changed (change: { CAVE_NAME: value }).
export const caveTwin = (seed, change = {}) => compileShared(SRC, seed, { ...caveConstants(), ...change });
