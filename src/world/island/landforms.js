import { pcg } from '../scenes/themedShared.js';
import { STRATA_BEDS_SRC } from './strata.js';

// The island's landforms (docs/scaling.md D11, "Island hooks"): what shapes its
// terrain past the generator's heightfield, and where water stands on it, as a
// pure function of the world column and a few sites the CPU picks per world
// (landforms.sites, from world/generator.js worldParams: P.landforms).
//
// Written once in the shared GLSL subset (scenes/themedShared.js): the GPU runs
// it in the island's column bake (scenes/island.js), the CPU its JS twin
// (world/generator.js islandTwin), so both see the same island. islandLandform,
// islandWaterLevel and islandBare run once per world column, in the bake: the
// layers (beaches, plant cover, snow), the trees and every cell then follow
// what they return. islandLakeClearance runs in the cell stage, for the caves.
// The sites reach the GPU as uniforms (landforms.head, .values) and the twin
// as the same accessors (landforms.scope).
//
// In scope: the island's world parameters (uGenSea, uGenRelief, uGenCenterX/Z,
// ...), its noise (genHeight, ...: world/generator.js), the subset's helpers
// (thNoised, thStream, ...) and the strata's beds (strata.js STRATA_BEDS_SRC).
//
//   - A RIA, a drowned river valley (the rias of Galicia and south-west
//     England: valleys cut at the low sea levels of the ice ages, flooded by
//     the sea's rise since): one inlet from the coast into the hills along a
//     meandering centreline. Its floor lies RIA_DEPTH below the sea at the
//     mouth and rises to sea level over the drowned share of its length, so
//     the inlet's water is the sea's, flat and still; upstream it goes on as a
//     dry gorge whose floor rises gently and whose walls are steep enough to
//     show the strata, ending in a rounded head (a box canyon's amphitheatre).
//     The centreline is the axis from a hashed point on the coast toward the
//     high ground, displaced across it by 1D noise (the meander); a column's
//     distance from it is the first-order estimate |f| / |∇f| of the implicit
//     curve f = v - meander(u) (Quilez, "Distance estimation", iquilezles.org).
//   - MESAS: one terraced badlands region of flat-topped buttes. Butte noise
//     lifts the ground, then it is terraced with libnoise's Terrace module
//     (J. Bevins, noise::module::Terrace: between control points c0 < c1 the
//     output is c0 + (c1 - c0)·α², α the input's share of the way; here α is
//     raised to TERRACE_EXP, steeper than libnoise's square, for cliffed
//     risers), its control points the strata's resistant beds (strata.js
//     stBench). So every tread is the top of a sandstone bed where the coal
//     over it weathered back, and the treads follow the beds' dip: the stepped
//     hillsides of the Yorkshire Dales and the Colorado Plateau's buttes.
//   - SEA STACKS: rock pillars in the shallows off the cliff coasts, the
//     remnants of retreated headlands, with flat tops a little below the
//     cliff behind them.
//   - TARNS: two to four small lakes in the high ground, above sea level:
//     cirque floors, carved as bowls under a level LAKE_FREEBOARD below the
//     lowest ground of their rim, with a walkable shore and a steep headwall
//     where the ground around rises higher (a cirque's back wall).
//
// Stability (as world/generator.js's rules):
//   - Water stands at sea level (the ria) or at a tarn's level, and every
//     column within LAKE_RIM cells (wobbled) past a tarn's shore has ground at
//     least LAKE_FREEBOARD above its water, so water at the surface has ground
//     on every side, diagonals too (move.js: liquids move along an axis or
//     topple to a lower diagonal cell through an open one at their level). The
//     rim is enforced (lfLakeGround takes the max), not hoped for; the CPU
//     picks a level that makes it a no-op on the ground already there, so no
//     dam stands out of the ground.
//   - Tarns come last, so nothing carves their rims; other landforms keep
//     clear of them (landforms.sites), and so do caves (islandLakeClearance).
//   - Powders, plant cover and trees follow from the layers, which take a
//     column's water level (islandWaterLevel: the tarn's within its rim) as
//     their sea (generator.js genCover, genTreeZone): beaches around it, plant
//     cover only above it, trees two cells above it.
//   - No trees on the gorge's walls, within RIA_RIM_BARE of its rim or on its
//     floor between tall walls: they are bare (islandBare), so a tree's footing
//     (its root flare grows wood down to the ground, constructions/runtime.js)
//     never hangs down a wall and no crown grows into one. Gorge walls and mesa risers are rock and too steep for sand,
//     plants or trees (the layers' slope limits).
//   - Slopes stay walkable outside the gorge's walls, the mesas' risers, the
//     stacks and tarn headwalls: tarn shores rise LAKE_SHORE per cell, the
//     gorge floor RIA_GRADIENT. The badlands are bare (islandBare): no plant
//     cover, so no trees on the buttes.

// ---------------------------------------------------------------- constants
// The geometry's, shared by the GLSL and the JS twin (as LAND_* #defines).
const L = {
  ints: {
    LAKES_MAX: 4,               // uniform slots for tarns...
    STACKS_MAX: 8,              // ...and sea stacks
    LAKE_FREEBOARD: 1,          // cells: a tarn's rim stands at least this far above its water (a splash's margin)
    LAKE_RIM: 3,                // cells past the shore over which the rim holds: a diagonal step plus the wobble's spread
    LAKE_CAVE_MARGIN: 4,        // cells past the rim that caves keep clear of (islandLakeClearance)
  },
  floats: {
    WOBBLE_AMP: 0.18,           // tarn outlines: distances stretched by up to this share...
    WOBBLE_WAVE: 14.0,          // ...over this many cells
    // the ria
    RIA_DEPTH: 6.0,             // its floor at the mouth, cells below the sea
    RIA_GRADIENT: 0.035,        // the gorge floor's rise, cells per cell along it
    RIA_MOUTH_HALF: 11.0,       // its floor's half width at the mouth...
    RIA_GORGE_HALF: 4.0,        // ...narrowing to this over the drowned part, and the gorge's from there on
    RIA_WALL: 3.0,              // walls rise this many cells per cell (72°)
    RIA_ROUGH: 1.5,             // walls in and out by up to this many cells...
    RIA_ROUGH_WAVE: 6.0,        // ...over this many
    RIA_OFFSHORE: 30.0,         // seaward of the mouth the channel shoals to sea level over this many cells
    RIA_DU: 1.0,                // cells: the meander's slope is read over this step either side
    RIA_RIM_BARE: 4.0,          // cells past the gorge's rim kept bare: a tree's root flare (≤ 2.7) would grow footings down its wall...
    RIA_RIM_DROP: 3.0,          // ...where it drops more than this (a tree on the steepest ground it may stand on, 0.8, drops ~2 across its flare)
    RIA_FLOOR_BARE: 8.0,        // its floor is bare where a wall within this many cells rises RIA_RIM_DROP above it (a crown would grow into it)
    MEANDER_AMP: 22.0,          // the centreline swings this far either side of the axis...
    MEANDER_WAVE: 110.0,        // ...over this many cells along it...
    MEANDER_FINE: 0.3,          // ...with a finer octave of this share...
    MEANDER_FINE_WAVE: 37.0,    // ...over this many
    MEANDER_RAMP: 40.0,         // cells from the mouth over which the swing grows in (the mouth stays where it was picked)
    // the mesas
    MESA_CORE: 0.6,             // share of the region's radius at full strength (fading to nothing at its edge)
    BUTTE_WAVE: 32.0,           // butte noise wavelength, cells
    BUTTE_CUT: -0.1,            // buttes where the noise (-1..1) is above this...
    BUTTE_SOFT: 0.3,            // ...rising to full height over this much more
    BUTTE_H: 24.0,              // a butte's height over the plain, cells
    MESA_SINK: 4.0,             // the plain between the buttes is worn down this many cells
    TERRACE_EXP: 4.0,           // the terrace's α exponent (libnoise's is 2): the larger, the flatter the treads
    MESA_BARE: 0.8,             // badlands: no plant cover within this share of the region's radius (wobbled)
    // sea stacks
    STACK_WALL: 4.0,            // their sides rise this many cells per cell (76°)
    STACK_WOBBLE_AMP: 0.35,     // their outlines: distances stretched by up to this share...
    STACK_WOBBLE_WAVE: 5.0,     // ...over this many cells
    STACK_REACH: 16.0,          // cells: the most a stack's side reaches past its radius (wobble included)
    // tarns
    LAKE_DEPTH: 6.0,            // cells: its bowl's depth at the centre...
    LAKE_BOWL_EXP: 2.0,         // ...rising as (d / radius)^this to the shore
    LAKE_SHORE: 0.5,            // its shore rises this many cells per cell (walkable)...
    LAKE_SHORE_W: 6.0,          // ...for this many cells past the rim's top...
    LAKE_HEADWALL: 2.5,         // ...then as a headwall, this steep, where the ground is higher still
    LAKE_REACH: 24.0,           // cells past the shore (wobbled) that its carve reaches: the headwall is above any ground there
    FAR: 1.0e6,                 // farther than anything (lfLakeDist: out of reach)
    CENTRE: 0.5,                // a column's centre, cells past its index (the hooks get the index, the sites are centres)
  },
  salts: {
    WOBBLE: 0x5810,
    MEANDER: 0x5820,
    MEANDER_FINE: 0x5830,
    RIA_ROUGH: 0x5840,
    BUTTE: 0x5850,
  },
};
// The tallest wall the gorge cuts, cells (the world's height): sets how far
// from its floor's edge it can reach.
const WALL_TOP = 128;
L.floats.RIA_REACH = L.floats.RIA_MOUTH_HALF + L.floats.RIA_ROUGH + WALL_TOP / L.floats.RIA_WALL;

export const LANDFORMS = { ...L.ints, ...L.floats };

// ---------------------------------------------------------------- the source
// (x, z) below: a column's centre, world cells, but in the hooks; h: its
// ground height before the landforms. The site accessors (lfRiaX(), ...) are
// landforms.head's on the GPU, landforms.scope's in the twin.

// Both stages: outlines' wobble and the tarns' reach.
const COMMON_SRC = /* glsl */ `
// An outline's wobble at column (x, z): distances are stretched by up to amp over wave cells.
float lfWobble(float x, float z, float amp, float wave) {
  return 1.0 + amp * thNoised(thFdiv(x, wave), thFdiv(z, wave), thStream(LAND_SALT_WOBBLE, 0));
}

// ---- tarns
// Tarn i's wobbled distance from column (x, z), cells (LAND_FAR where even the
// shortest wobble leaves it past the tarn's reach).
float lfLakeDist(int i, float x, float z) {
  float dx = x - lfLakeX(i), dz = z - lfLakeZ(i);
  float reach = thFdiv(lfLakeR(i) + LAND_LAKE_REACH, 1.0 - LAND_WOBBLE_AMP);
  if (dx * dx + dz * dz >= reach * reach) return LAND_FAR;
  return sqrt(dx * dx + dz * dz) * lfWobble(x, z, LAND_WOBBLE_AMP, LAND_WOBBLE_WAVE);
}
`;

// The column bake's: the landforms and their hooks.
const COLUMN_SRC = /* glsl */ `
// ---- the ria. u: cells along its axis from the mouth; v: across it.
// The centreline's offset across the axis at u: two octaves of 1D gradient
// noise (thNoised along a lattice line, z = 0), growing in from the mouth.
float lfMeander(float u) {
  float n = thNoised(thFdiv(u, LAND_MEANDER_WAVE), 0.0, thStream(LAND_SALT_MEANDER, 0))
          + LAND_MEANDER_FINE * thNoised(thFdiv(u, LAND_MEANDER_FINE_WAVE), 0.0, thStream(LAND_SALT_MEANDER_FINE, 0));
  return LAND_MEANDER_AMP * n * smoothstep(0.0, LAND_MEANDER_RAMP, u);
}
// Its floor at u: RIA_DEPTH under the sea at the mouth (shoaling to sea level
// RIA_OFFSHORE seaward of it, where the sea floor is lower anyway), rising to
// sea level over the drowned part, then a gorge rising RIA_GRADIENT per cell.
float lfRiaFloor(float u) {
  float drown = lfRiaDrown();
  if (u < 0.0) return uGenSea - LAND_RIA_DEPTH * clamp(1.0 + thFdiv(u, LAND_RIA_OFFSHORE), 0.0, 1.0);
  if (u < drown) return uGenSea - LAND_RIA_DEPTH * (1.0 - thFdiv(u, drown));
  return uGenSea + LAND_RIA_GRADIENT * (u - drown);
}
// Its floor's half width at u.
float lfRiaHalf(float u) { return mix(LAND_RIA_MOUTH_HALF, LAND_RIA_GORGE_HALF, smoothstep(0.0, lfRiaDrown(), u)); }
// Column (x, z)'s distance from the ria's centreline (its rounded head past
// the end), cells, before the walls' roughness.
float lfRiaDist(float u, float v) {
  float uc = min(u, lfRiaLen());
  float slope = thFdiv(lfMeander(uc + LAND_RIA_DU) - lfMeander(uc - LAND_RIA_DU), 2.0 * LAND_RIA_DU);
  float across = thFdiv(abs(v - lfMeander(uc)), sqrt(1.0 + slope * slope));
  return sqrt(across * across + (u - uc) * (u - uc));
}
// The ria's surface at column (x, z): its floor and walls, the walls set
// inset cells further out (LAND_FAR out of its reach).
float lfRiaWall(float x, float z, float inset) {
  float len = lfRiaLen();
  if (len <= 0.0) return LAND_FAR;
  float rx = x - lfRiaX(), rz = z - lfRiaZ();
  float u = rx * lfRiaDx() + rz * lfRiaDz(), v = rz * lfRiaDx() - rx * lfRiaDz();
  if (u < -LAND_RIA_OFFSHORE || u > len + LAND_RIA_REACH || abs(v) > LAND_MEANDER_AMP * (1.0 + LAND_MEANDER_FINE) + LAND_RIA_REACH) return LAND_FAR;
  float uc = min(u, len);
  float dist = lfRiaDist(u, v)
             + LAND_RIA_ROUGH * thNoised(thFdiv(x, LAND_RIA_ROUGH_WAVE), thFdiv(z, LAND_RIA_ROUGH_WAVE), thStream(LAND_SALT_RIA_ROUGH, 0));
  return lfRiaFloor(uc) + max(dist - inset - lfRiaHalf(uc), 0.0) * LAND_RIA_WALL;
}
// The ria cut into ground h at column (x, z).
float lfRia(float x, float z, float h) { return min(h, lfRiaWall(x, z, 0.0)); }
// Is column (x, z), its ground h high, within RIA_RIM_BARE cells of a
// gorge wall more than RIA_RIM_DROP tall (or on one)? (The walls that much
// further out would cut it that deep.)
bool lfRiaRim(float x, float z, float h) { return lfRiaWall(x, z, LAND_RIA_RIM_BARE) < h - LAND_RIA_RIM_DROP; }
// Is column (x, z), its ground h high, the ria's own floor or wall (its
// ground is the ria's surface) with a wall within RIA_FLOOR_BARE cells
// rising more than RIA_RIM_DROP above it? A dry slot canyon: no trees.
bool lfRiaSlot(float x, float z, float h) {
  float w = lfRiaWall(x, z, 0.0);
  return w < LAND_FAR && w <= h && lfRiaWall(x, z, -LAND_RIA_FLOOR_BARE) > h + LAND_RIA_RIM_DROP;
}

// ---- the mesas
// libnoise's Terrace (see the top) on stratigraphic height s, its control
// points the beds' benches.
float lfTerrace(float s) {
  float c0 = stBench(s, false), c1 = stBench(s, true);
  float a = clamp(thFdiv(s - c0, c1 - c0), 0.0, 1.0);
  return c0 + (c1 - c0) * pow(a, LAND_TERRACE_EXP);
}
// The mesa region's buttes and terraces on ground h at column (x, z).
float lfMesa(float x, float z, float h) {
  float R = lfMesaR();
  if (R <= 0.0) return h;
  float dx = x - lfMesaX(), dz = z - lfMesaZ();
  float d = sqrt(dx * dx + dz * dz);
  if (d >= R) return h;
  float w = 1.0 - smoothstep(R * LAND_MESA_CORE, R, d);
  float n = thNoised(thFdiv(x, LAND_BUTTE_WAVE), thFdiv(z, LAND_BUTTE_WAVE), thStream(LAND_SALT_BUTTE, 0));
  float raw = h + w * (LAND_BUTTE_H * smoothstep(LAND_BUTTE_CUT, LAND_BUTTE_CUT + LAND_BUTTE_SOFT, n) - LAND_MESA_SINK);
  float datum = uGenSea + stRaise(x, z);   // where stratigraphic height 0 is in this column
  return mix(raw, datum + lfTerrace(raw - datum), w);
}
// Is column (x, z) in the badlands (bare rock, no plant cover)?
bool lfMesaBare(float x, float z) {
  float dx = x - lfMesaX(), dz = z - lfMesaZ();
  return sqrt(dx * dx + dz * dz) * lfWobble(x, z, LAND_WOBBLE_AMP, LAND_WOBBLE_WAVE) < lfMesaR() * LAND_MESA_BARE;
}

// ---- sea stacks: flat-topped pillars, their sides STACK_WALL steep
float lfStacks(float x, float z, float h) {
  float g = h;
  for (int i = 0; i < LAND_STACKS_MAX; i++) {
    if (i >= lfStackCount()) return g;
    float dx = x - lfStackX(i), dz = z - lfStackZ(i);
    float reach = lfStackR(i) + LAND_STACK_REACH;
    if (dx * dx + dz * dz >= reach * reach) continue;
    float d = sqrt(dx * dx + dz * dz) * lfWobble(x, z, LAND_STACK_WOBBLE_AMP, LAND_STACK_WOBBLE_WAVE);
    g = max(g, lfStackTop(i) - LAND_STACK_WALL * max(d - lfStackR(i), 0.0));
  }
  return g;
}

// ---- tarns
// The ground tarn i leaves at wobbled distance d, on ground g: carved (the
// bowl under the water, the shore, the headwall), and the rim enforced: at
// least rim height for LAKE_RIM cells past the shore.
float lfLakeGround(int i, float d, float g) {
  float R = lfLakeR(i), rim = lfLakeLevel(i) + float(LAND_LAKE_FREEBOARD);
  float past = d - R;
  float carve = d < R ? lfLakeLevel(i) - LAND_LAKE_DEPTH * (1.0 - pow(thFdiv(d, R), LAND_LAKE_BOWL_EXP))
              : rim + LAND_LAKE_SHORE * min(past, LAND_LAKE_SHORE_W) + LAND_LAKE_HEADWALL * max(past - LAND_LAKE_SHORE_W, 0.0);
  float ground = min(g, carve);
  if (d >= R && past < float(LAND_LAKE_RIM)) ground = max(ground, rim);
  return ground;
}
float lfLakes(float x, float z, float h) {
  float g = h;
  for (int i = 0; i < LAND_LAKES_MAX; i++) {
    if (i >= lfLakeCount()) return g;
    float d = lfLakeDist(i, x, z);
    if (d < LAND_FAR) g = lfLakeGround(i, d, g);
  }
  return g;
}

// ---- the hooks. (x, z): a world column (its index, as floats); the sites
// and everything above work at its centre.
// The terrain height of world column (x, z) after landforms, in cells, from
// h, the generator's height there.
float islandLandform(float x, float z, float h) {
  float cx = x + LAND_CENTRE, cz = z + LAND_CENTRE;
  float g = lfMesa(cx, cz, h);
  g = lfRia(cx, cz, g);
  g = lfStacks(cx, cz, g);
  return lfLakes(cx, cz, g);
}
// Column (x, z)'s standing-water surface: a tarn's level within its rim, else
// the sea's. Its cells below it are water where they aren't ground. (The
// layers take it as the column's sea.)
float islandWaterLevel(float x, float z, float h) {
  for (int i = 0; i < LAND_LAKES_MAX; i++) {
    if (i >= lfLakeCount()) return uGenSea;
    if (lfLakeDist(i, x + LAND_CENTRE, z + LAND_CENTRE) < lfLakeR(i) + float(LAND_LAKE_RIM)) return lfLakeLevel(i);
  }
  return uGenSea;
}
// Does column (x, z), its ground h high (after landforms), stay bare (no
// plant cover, no trees)? The badlands; the gorge's rims, where a tree's
// footing would hang down a wall; and its floor between tall walls, where a
// crown would grow into them. (The bake gives it no meadow: generator.js
// genMeadow, genTreeZone.)
bool islandBare(float x, float z, float h) {
  float cx = x + LAND_CENTRE, cz = z + LAND_CENTRE;
  return (lfMesaR() > 0.0 && lfMesaBare(cx, cz)) || lfRiaRim(cx, cz, h) || lfRiaSlot(cx, cz, h);
}
`;

// The cell stage's: where caves keep clear.
const CELL_SRC = /* glsl */ `
// Must 3D carving (caves) keep clear of world column (x, z)? Within
// LAKE_CAVE_MARGIN of a tarn's rim, over its water and under it: a cave beside
// the water would drain it (its bed lies LAKE_DEPTH below its level).
bool islandLakeClearance(float x, float z) {
  for (int i = 0; i < LAND_LAKES_MAX; i++) {
    if (i >= lfLakeCount()) return false;
    float d = lfLakeDist(i, x + LAND_CENTRE, z + LAND_CENTRE);
    if (d < lfLakeR(i) + float(LAND_LAKE_RIM + LAND_LAKE_CAVE_MARGIN)) return true;
  }
  return false;
}
`;

// ---------------------------------------------------------------- sites
// Where the landforms go, per world: picked on the CPU from the terrain
// before them (height(x, z): the generator's height at a column's centre), the
// seed breaking ties, so another seed gives another island. Ints are cells
// unless said otherwise; shares of the relief are above the sea.
export const SITE = {
  RADIUS_MIN: 200,            // islands smaller than this (the box's Island preset) get none
  STEP: 8,                    // cells between the samples a search reads
  RAY_FAR: 1.6,               // coast searches march in from this many island radii out...
  RAY_STEP: 2,                // ...this many cells at a time
  // the ria
  RIA_TRIES: 12,              // seeded headings tried for the mouth...
  RIA_TURNS: 7,               // ...and directions inland from each, within RIA_CONE (radians) of straight in;
  RIA_CONE: 0.6,              // the pair whose path averages the highest ground wins (the gorge runs deepest)
  RIA_HEAD: 0.6,              // the gorge heads where the ground first reaches this share of the relief...
  RIA_LEN_MIN: 0.5,           // ...but at least this share of the island's radius from the mouth...
  RIA_LEN_MAX: 0.75,          // ...and at most this
  RIA_DROWN: 0.42,            // the drowned share of its length
  RIA_SEA_MAX: 3,             // samples of its path inland may dip under the sea at most this many times
  CLEAR: 16,                  // cells kept between landforms' reaches
  // the mesas
  MESA_R: 80,
  MESA_LO: 0.12,              // its centre's ground: between these shares of the relief
  MESA_HI: 0.45,
  MESA_SHORE: 4,              // its whole disc stands at least this high above the sea
  MESA_RING: 16,              // samples around its edge that check it
  // tarns
  LAKES_MIN: 2,
  LAKES_MAX: 4,
  LAKE_R_MIN: 12,
  LAKE_R_MAX: 20,
  LAKE_HIGH: 0.42,            // their centres' ground is at least this share of the relief
  LAKE_ABOVE_SEA: 8,          // a tarn's bowl bottom stays at least this far above the sea
  LAKE_RELIEF: 12,            // its rim's ground may rise at most this far above its level (the headwall's height)
  LAKE_RING: 24,              // samples around the rim that pre-check a candidate
  // sea stacks
  STACKS_MIN: 3,
  STACK_RAYS: 720,            // coast points examined, evenly around the island
  CLIFF_IN: 12,               // cells inland of the coast where a coast's rise is read: the cliff coasts
  CLIFF_SHARE: 0.25,          // are the steepest this share of it...
  CLIFF_RISE: 1,              // ...that rise at least this far there
  STACK_GAP: 3,               // cells of sea at least between a stack's foot and the coast...
  STACK_OUT: 10,              // ...plus up to this many more (seeded)
  STACK_DEPTH_MIN: 1,         // the sea's depth where a stack stands
  STACK_DEPTH_MAX: 12,
  STACK_R_MIN: 3,
  STACK_R_MAX: 6,
  STACK_TOP: 0.85,            // its top: this share of the cliff's rise...
  STACK_TOP_MIN: 6,           // ...within these, above the sea
  STACK_TOP_MAX: 22,
  STACK_SPACING: 36,          // cells between stacks, at least
  STACK_FLOOR: 6,             // a stack's foot is this far below the sea at most (STACK_REACH's budget)
};
const SITE_SALT = { RIA: 0x5910, MESA: 0x5920, LAKE: 0x5930, LAKE_N: 0x5940, STACK: 0x5950, STACK_N: 0x5960 };
if (SITE.LAKES_MAX > L.ints.LAKES_MAX) throw new Error('landforms: more tarns than uniform slots');
// how far past its radius a stack's sides can reach, wobble included
const stackSpread = (R, top) => (R + (top + SITE.STACK_FLOOR) / L.floats.STACK_WALL) / (1 - L.floats.STACK_WOBBLE_AMP) - R;
if (stackSpread(SITE.STACK_R_MAX, SITE.STACK_TOP_MAX) > L.floats.STACK_REACH) throw new Error('landforms: a stack can reach past STACK_REACH');
// how far from its centre a tarn reaches, cells (lfLakeDist)
const lakeReach = (R) => (R + L.floats.LAKE_REACH) / (1 - L.floats.WOBBLE_AMP);

const TAU = Math.PI * 2;
const UNIT = 0x100000000;
// the seed's hash k in stream salt, as [0, 1)
const unit = (seed, salt, k) => pcg((pcg((seed + salt) >>> 0) + k) >>> 0) / UNIT;

// Distance from point (x, z) to segment a-b.
function segDist(x, z, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, len2 = vx * vx + vz * vz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
  return Math.hypot(x - ax - t * vx, z - az - t * vz);
}

// The outermost land along the ray from the island's centre at angle a:
// [radius, x, z], or null when there is none.
function coastAlong(P, height, a) {
  const cx = P.center[0], cz = P.center[1], dx = Math.cos(a), dz = Math.sin(a);
  for (let r = SITE.RAY_FAR * P.radius; r > 0; r -= SITE.RAY_STEP) {
    const x = cx + dx * r, z = cz + dz * r;
    if (x < 0 || z < 0 || x >= P.size[0] || z >= P.size[2]) continue;
    if (height(x, z) >= P.sea) return [r, x, z];
  }
  return null;
}

function pickRia(P, height) {
  const relief = P.relief, head = P.sea + SITE.RIA_HEAD * relief;
  let best = null;
  for (let t = 0; t < SITE.RIA_TRIES; t++) {
    const coast = coastAlong(P, height, unit(P.seed, SITE_SALT.RIA, t) * TAU);
    if (!coast) continue;
    const [, sx, sz] = coast;
    const inward = Math.atan2(P.center[1] - sz, P.center[0] - sx);
    for (let k = 0; k < SITE.RIA_TURNS; k++) {
      const a = inward + SITE.RIA_CONE * ((2 * k) / (SITE.RIA_TURNS - 1) - 1);
      const dx = Math.cos(a), dz = Math.sin(a);
      let len = SITE.RIA_LEN_MAX * P.radius, sum = 0, n = 0, wet = 0;
      for (let u = SITE.STEP; u <= SITE.RIA_LEN_MAX * P.radius; u += SITE.STEP) {
        const h = height(sx + dx * u, sz + dz * u);
        if (h < P.sea) wet++;
        sum += h; n++;
        if (h >= head && u >= SITE.RIA_LEN_MIN * P.radius) { len = u; break; }
      }
      if (wet > SITE.RIA_SEA_MAX) continue;
      const score = sum / n;
      if (!best || score > best.score) best = { x: sx, z: sz, dx, dz, len, drown: SITE.RIA_DROWN * len, score };
    }
  }
  return best;
}

// How far from point (x, z) the ria's walls (the reach of its carve) are, cells.
function riaClear(S, x, z) {
  if (!S.ria) return Infinity;
  const r = S.ria, swing = L.floats.MEANDER_AMP * (1 + L.floats.MEANDER_FINE);
  return segDist(x, z, r.x, r.z, r.x + r.dx * r.len, r.z + r.dz * r.len) - swing - L.floats.RIA_REACH;
}

function pickMesa(P, height, T, S) {
  let best = null;
  const R = SITE.MESA_R;
  for (let z = SITE.STEP / 2; z < P.size[2]; z += SITE.STEP)
    for (let x = SITE.STEP / 2; x < P.size[0]; x += SITE.STEP) {
      const h = height(x, z);
      if (h < P.sea + SITE.MESA_LO * P.relief || h > P.sea + SITE.MESA_HI * P.relief) continue;
      if (riaClear(S, x, z) < R + SITE.CLEAR) continue;
      // in the coal measures, so its steps are sandstone
      if (T.stHeight(x, h, z) < T.stLimeTop()) continue;
      let ok = true;
      for (let k = 0; k < SITE.MESA_RING && ok; k++) {
        const a = (k / SITE.MESA_RING) * TAU;
        ok = height(x + R * Math.cos(a), z + R * Math.sin(a)) >= P.sea + SITE.MESA_SHORE;
      }
      if (!ok) continue;
      const score = unit(P.seed, SITE_SALT.MESA, (x * P.size[2] + z) >>> 0);
      if (!best || score > best.score) best = { x, z, r: R, score };
    }
  return best;
}

// Tarn level for a centre and radius: LAKE_FREEBOARD under the lowest ground
// of its rim (every column within LAKE_RIM past its wobbled shore), so the
// rim needs no raising; null when the site won't do: too low, too steep
// around (the headwall would be taller than LAKE_RELIEF), or with ground
// above its headwall where its carve ends.
function lakeLevel(P, height, T, x, z, R) {
  const rimOut = R + L.ints.LAKE_RIM, box = rimOut / (1 - L.floats.WOBBLE_AMP);
  let lo = Infinity, hi = -Infinity;
  for (let j = Math.floor(z - box); j <= z + box; j++)
    for (let i = Math.floor(x - box); i <= x + box; i++) {
      const cx = i + 0.5, cz = j + 0.5;
      const d = Math.hypot(cx - x, cz - z) * T.lfWobble(cx, cz, L.floats.WOBBLE_AMP, L.floats.WOBBLE_WAVE);
      if (d < R || d >= rimOut) continue;
      const h = Math.floor(height(cx, cz) + 0.5);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
  const level = lo - L.ints.LAKE_FREEBOARD;
  if (level - L.floats.LAKE_DEPTH < P.sea + SITE.LAKE_ABOVE_SEA || hi - level > SITE.LAKE_RELIEF) return null;
  // where the carve ends, its headwall stands above the ground
  const F = L.floats, wall = level + L.ints.LAKE_FREEBOARD + F.LAKE_SHORE * F.LAKE_SHORE_W + F.LAKE_HEADWALL * (F.LAKE_REACH - F.LAKE_SHORE_W);
  for (let k = 0; k < SITE.LAKE_RING; k++) {
    const a = (k / SITE.LAKE_RING) * TAU, r = lakeReach(R);
    if (height(x + r * Math.cos(a), z + r * Math.sin(a)) >= wall) return null;
  }
  return level;
}

function pickLakes(P, height, T, S) {
  const count = SITE.LAKES_MIN + Math.floor(unit(P.seed, SITE_SALT.LAKE_N, 0) * (SITE.LAKES_MAX - SITE.LAKES_MIN + 1));
  const cands = [];
  for (let z = SITE.STEP / 2; z < P.size[2]; z += SITE.STEP)
    for (let x = SITE.STEP / 2; x < P.size[0]; x += SITE.STEP) {
      const h = height(x, z);
      if (h < P.sea + SITE.LAKE_HIGH * P.relief) continue;
      const k = (x * P.size[2] + z) >>> 0;
      const R = SITE.LAKE_R_MIN + Math.floor(unit(P.seed, SITE_SALT.LAKE, k) * (SITE.LAKE_R_MAX - SITE.LAKE_R_MIN + 1));
      const reach = lakeReach(R);
      if (riaClear(S, x, z) < reach + SITE.CLEAR) continue;
      if (S.mesa && Math.hypot(x - S.mesa.x, z - S.mesa.z) < S.mesa.r + reach + SITE.CLEAR) continue;
      // pre-check: the ground around the rim varies no more than the headwall allows
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < SITE.LAKE_RING; j++) {
        const a = (j / SITE.LAKE_RING) * TAU, r = R + L.ints.LAKE_RIM;
        const g = height(x + r * Math.cos(a), z + r * Math.sin(a));
        lo = Math.min(lo, g); hi = Math.max(hi, g);
      }
      if (hi - lo > SITE.LAKE_RELIEF - L.ints.LAKE_FREEBOARD) continue;
      // flatter sites first, the seed shuffling near-ties
      cands.push({ x: x + L.floats.CENTRE, z: z + L.floats.CENTRE, r: R, score: (hi - lo) / SITE.LAKE_RELIEF + unit(P.seed, SITE_SALT.LAKE, k + 1) });
    }
  cands.sort((a, b) => a.score - b.score);
  const lakes = [];
  for (const c of cands) {
    if (lakes.length >= count) break;
    if (lakes.some((l) => Math.hypot(l.x - c.x, l.z - c.z) < lakeReach(l.r) + lakeReach(c.r) + SITE.CLEAR)) continue;
    const level = lakeLevel(P, height, T, c.x, c.z, c.r);
    if (level !== null) lakes.push({ x: c.x, z: c.z, r: c.r, level });
  }
  return lakes;
}

function pickStacks(P, height, S) {
  const count = SITE.STACKS_MIN + Math.floor(unit(P.seed, SITE_SALT.STACK_N, 0) * (L.ints.STACKS_MAX - SITE.STACKS_MIN + 1));
  // the coast all around, and how far it rises CLIFF_IN inland
  const coasts = [];
  for (let k = 0; k < SITE.STACK_RAYS; k++) {
    const a = (k / SITE.STACK_RAYS) * TAU, dx = Math.cos(a), dz = Math.sin(a);
    const coast = coastAlong(P, height, a);
    if (!coast) continue;
    const [r0, cx, cz] = coast;
    coasts.push({ k, dx, dz, r0, rise: height(cx - dx * SITE.CLIFF_IN, cz - dz * SITE.CLIFF_IN) - P.sea });
  }
  const steep = coasts.map((c) => c.rise).sort((a, b) => b - a)[Math.floor(SITE.CLIFF_SHARE * coasts.length)] ?? Infinity;
  const cands = [];
  for (const { k, dx, dz, r0, rise } of coasts) {
    if (rise < Math.max(steep, SITE.CLIFF_RISE)) continue;
    const R = SITE.STACK_R_MIN + Math.floor(unit(P.seed, SITE_SALT.STACK, 2 * k) * (SITE.STACK_R_MAX - SITE.STACK_R_MIN + 1));
    const top = P.sea + Math.min(SITE.STACK_TOP_MAX, Math.max(SITE.STACK_TOP_MIN, Math.round(SITE.STACK_TOP * rise)));
    // the foot: its radius and its sides' spread down to the sea floor, wobbled, clear of the coast
    const foot = R + stackSpread(R, top - P.sea);
    const out = foot + SITE.STACK_GAP + unit(P.seed, SITE_SALT.STACK, 2 * k + 1) * SITE.STACK_OUT;
    const x = P.center[0] + dx * (r0 + out), z = P.center[1] + dz * (r0 + out);
    const depth = P.sea - height(x, z);
    if (depth < SITE.STACK_DEPTH_MIN || depth > SITE.STACK_DEPTH_MAX) continue;
    if (riaClear(S, x, z) < foot + SITE.CLEAR) continue;
    cands.push({ x, z, r: R, top, score: unit(P.seed, SITE_SALT.STACK_N, k + 1) });
  }
  cands.sort((a, b) => a.score - b.score);
  const stacks = [];
  for (const c of cands) {
    if (stacks.length >= count) break;
    if (stacks.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < SITE.STACK_SPACING)) continue;
    stacks.push({ x: c.x, z: c.z, r: c.r, top: c.top });
  }
  return stacks;
}

// The landform sites of world P (worldParams' sea, relief, centre, radius,
// size, seed): { ria, mesa, lakes, stacks }, from T, the twin of P without
// sites (its genHeight is the terrain before landforms). The ria comes first
// and the others keep clear of it, the mesa of the tarns.
function pickSites(P, T) {
  const S = { ria: null, mesa: null, lakes: [], stacks: [] };
  if (P.radius < SITE.RADIUS_MIN) return S;
  const height = (x, z) => T.genHeight(x - L.floats.CENTRE, z - L.floats.CENTRE);
  S.ria = pickRia(P, height);
  S.mesa = pickMesa(P, height, T, S);
  S.lakes = pickLakes(P, height, T, S);
  S.stacks = pickStacks(P, height, S);
  // (without the picks' scores: P carries them, and is a cache key)
  if (S.ria) delete S.ria.score;
  if (S.mesa) delete S.mesa.score;
  return S;
}
const SITES_KEEP = 8;                 // worlds whose sites are kept (picking one takes a few hundred ms)
const siteCache = new Map();

// ---------------------------------------------------------------- uniforms
// The sites on the GPU: uniforms, read through the accessors the source calls.
const HEAD_GLSL = /* glsl */ `
uniform vec4 uLandRia;                     // the ria's mouth (x, z) and inland direction (unit x, z)
uniform vec2 uLandRiaLen;                  // its length and its drowned part's, cells (0: no ria)
uniform vec3 uLandMesa;                    // the mesa region's centre (x, z) and radius, cells (0: none)
uniform int uLandLakes;                    // tarns: how many, and each one's centre (x, z), radius and water level
uniform vec4 uLandLake[LAND_LAKES_MAX];
uniform int uLandStacks;                   // sea stacks: how many, and each one's centre (x, z), radius and top
uniform vec4 uLandStack[LAND_STACKS_MAX];
float lfRiaX() { return uLandRia.x; }
float lfRiaZ() { return uLandRia.y; }
float lfRiaDx() { return uLandRia.z; }
float lfRiaDz() { return uLandRia.w; }
float lfRiaLen() { return uLandRiaLen.x; }
float lfRiaDrown() { return uLandRiaLen.y; }
float lfMesaX() { return uLandMesa.x; }
float lfMesaZ() { return uLandMesa.y; }
float lfMesaR() { return uLandMesa.z; }
int lfLakeCount() { return uLandLakes; }
float lfLakeX(int i) { return uLandLake[i].x; }
float lfLakeZ(int i) { return uLandLake[i].y; }
float lfLakeR(int i) { return uLandLake[i].z; }
float lfLakeLevel(int i) { return uLandLake[i].w; }
int lfStackCount() { return uLandStacks; }
float lfStackX(int i) { return uLandStack[i].x; }
float lfStackZ(int i) { return uLandStack[i].y; }
float lfStackR(int i) { return uLandStack[i].z; }
float lfStackTop(int i) { return uLandStack[i].w; }
`;
const NO_SITES = { ria: null, mesa: null, lakes: [], stacks: [] };
// the uniforms' values for world P's sites (P.landforms)
function values(P) {
  const S = P.landforms ?? NO_SITES;
  const pad = (list, max) => Array.from({ length: max * 4 }, (_, k) => list[Math.floor(k / 4)]?.[k % 4] ?? 0);
  return {
    uLandRia: S.ria ? [S.ria.x, S.ria.z, S.ria.dx, S.ria.dz] : [0, 0, 1, 0],
    uLandRiaLen: S.ria ? [S.ria.len, S.ria.drown] : [0, 0],
    uLandMesa: S.mesa ? [S.mesa.x, S.mesa.z, S.mesa.r] : [0, 0, 0],
    uLandLakes: S.lakes.length,
    uLandLake: pad(S.lakes.map((l) => [l.x, l.z, l.r, l.level]), L.ints.LAKES_MAX),
    uLandStacks: S.stacks.length,
    uLandStack: pad(S.stacks.map((s) => [s.x, s.z, s.r, s.top]), L.ints.STACKS_MAX),
  };
}
// the twin's accessors for world P's sites
function scope(P) {
  const S = P.landforms ?? NO_SITES;
  return {
    lfRiaX: () => S.ria?.x ?? 0, lfRiaZ: () => S.ria?.z ?? 0,
    lfRiaDx: () => S.ria?.dx ?? 1, lfRiaDz: () => S.ria?.dz ?? 0,
    lfRiaLen: () => S.ria?.len ?? 0, lfRiaDrown: () => S.ria?.drown ?? 0,
    lfMesaX: () => S.mesa?.x ?? 0, lfMesaZ: () => S.mesa?.z ?? 0, lfMesaR: () => S.mesa?.r ?? 0,
    lfLakeCount: () => S.lakes.length,
    lfLakeX: (i) => S.lakes[i].x, lfLakeZ: (i) => S.lakes[i].z,
    lfLakeR: (i) => S.lakes[i].r, lfLakeLevel: (i) => S.lakes[i].level,
    lfStackCount: () => S.stacks.length,
    lfStackX: (i) => S.stacks[i].x, lfStackZ: (i) => S.stacks[i].z,
    lfStackR: (i) => S.stacks[i].r, lfStackTop: (i) => S.stacks[i].top,
  };
}

// The landforms hook (world/generator.js):
//   prefix, tables  its constants (#defines LAND_*, the same names in the twin)
//   src             the column bake's source (with the strata's beds, which the terraces read)
//   cellSrc         the cell stage's (islandLakeClearance, for the caves)
//   head            GLSL before both stages' sources: the sites' uniforms and accessors
//   values(P)       those uniforms' values for world P
//   scope(P)        the twin's accessors for world P
//   sites(P, T)     world P's sites (P.landforms), T the twin of P without them
export const landforms = {
  prefix: 'LAND',
  tables: L,
  src: `${STRATA_BEDS_SRC}
${COMMON_SRC}
${COLUMN_SRC}`,
  cellSrc: `${COMMON_SRC}
${CELL_SRC}`,
  head: HEAD_GLSL,
  values,
  scope,
  sites(P, T) {
    const key = JSON.stringify(P);
    if (!siteCache.has(key)) {
      if (siteCache.size >= SITES_KEEP) siteCache.clear();
      siteCache.set(key, pickSites(P, T));
    }
    return siteCache.get(key);
  },
};
