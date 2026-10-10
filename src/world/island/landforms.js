import { definesGLSL, jsConstants, compileShared } from '../scenes/themedShared.js';
import { pcg } from '../generator.js';
import { NOISE_SRC, noiseDefinesGLSL, noiseConstants } from './noise.js';
import { STRATA_SRC, strataDefinesGLSL, strataConstants } from './strata.js';

// The island's landforms: what the heightfield gets on top of its hills and
// coast, as a pure function of the world column and a few sites the CPU
// picks per world (landformSites). Written once in the shared GLSL subset
// (scenes/themedShared.js): the GPU runs it, the CPU its JS twin.
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
//     rim is enforced (lfLakes takes the max), not hoped for; the CPU picks a
//     level that makes it a no-op on the ground already there.
//   - Tarns come last, so nothing carves their rims; other landforms keep
//     clear of them (landformSites).
//   - Powders, plant cover and trees follow from the layers, which take a
//     column's water level (islandWaterLevel: the tarn's within its rim) as
//     their sea: beaches around it, plant cover only above it, trees two cells
//     above it. Gorge walls and mesa risers are rock and too steep for sand,
//     plants or trees (the layers' slope limits).
//   - Slopes stay walkable outside the gorge's walls, the mesas' risers, the
//     stacks and tarn headwalls: tarn shores rise LAKE_SHORE per cell, the
//     gorge floor RIA_GRADIENT.

// ---------------------------------------------------------------- constants
// The geometry's, shared by the GLSL and the JS twin (as LF_* #defines).
const L = {
  ints: {
    LAKES_MAX: 4,               // uniform slots for tarns...
    STACKS_MAX: 8,              // ...and sea stacks
    LAKE_FREEBOARD: 1,          // cells: a tarn's rim stands at least this far above its water (a splash's margin)
    LAKE_RIM: 3,                // cells past the shore over which the rim holds: a diagonal step plus the wobble's spread
  },
  floats: {
    WOBBLE_AMP: 0.18,           // tarn and stack outlines: distances stretched by up to this share...
    WOBBLE_WAVE: 14.0,          // ...over this many cells
    // the ria
    RIA_DEPTH: 6.0,             // its floor at the mouth, cells below the sea
    RIA_GRADIENT: 0.035,        // the gorge floor's rise, cells per cell along it
    RIA_MOUTH_HALF: 11.0,       // its floor's half width at the mouth...
    RIA_GORGE_HALF: 4.0,        // ...narrowing to this over the drowned part, and the gorge's from there on
    RIA_WALL: 3.0,              // walls rise this many cells per cell (72°)
    RIA_ROUGH: 1.5,             // walls in and out by up to this many cells...
    RIA_ROUGH_WAVE: 6.0,        // ...over this many
    RIA_OFFSHORE: 40.0,         // the channel goes on this far seaward of the mouth (the sea floor is lower past it)
    RIA_DU: 1.0,                // cells: the meander's slope is read over this step either side
    MEANDER_AMP: 22.0,          // the centreline swings this far either side of the axis...
    MEANDER_WAVE: 110.0,        // ...over this many cells along it...
    MEANDER_FINE: 0.3,          // ...with a finer octave of this share...
    MEANDER_FINE_WAVE: 37.0,    // ...over this many
    MEANDER_RAMP: 40.0,         // cells from the mouth over which the swing grows in (the mouth stays where it was picked)
    // the mesas
    MESA_CORE: 0.6,             // share of the region's radius at full strength (fading to nothing at its edge)
    BUTTE_WAVE: 45.0,           // butte noise wavelength, cells
    BUTTE_CUT: 0.05,            // buttes where the noise (-1..1) is above this...
    BUTTE_SOFT: 0.35,           // ...rising to full height over this much more
    BUTTE_H: 24.0,              // a butte's height over the plain, cells
    MESA_SINK: 4.0,             // the plain between the buttes is worn down this many cells
    TERRACE_EXP: 4.0,           // the terrace's α exponent (libnoise's is 2): the larger, the flatter the treads
    // sea stacks
    STACK_WALL: 4.0,            // their sides rise this many cells per cell (76°)
    STACK_REACH: 16.0,          // cells: the most a stack's side reaches past its radius (wobble included)
    // tarns
    LAKE_DEPTH: 6.0,            // cells: its bowl's depth at the centre...
    LAKE_BOWL_EXP: 2.0,         // ...rising as (d / radius)^this to the shore
    LAKE_SHORE: 0.5,            // its shore rises this many cells per cell (walkable)...
    LAKE_SHORE_W: 6.0,          // ...for this many cells past the rim's top...
    LAKE_HEADWALL: 2.5,         // ...then as a headwall, this steep, where the ground is higher still
    LAKE_SKIRT: 0.5,            // outside the rim, ground it had to raise falls away this steeply (a moraine dam)
    LAKE_REACH: 28.0,           // cells past the shore that a tarn reaches (its carve and its dam)
    FAR: 1.0e6,                 // farther than anything (lfLakeDist: out of reach)
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

export const LANDFORM_PREFIX = 'LF';
export const LANDFORMS = { ...L.ints, ...L.floats };

// ---------------------------------------------------------------- shared source
// Needs the noise and strata sources before it, and the site accessors
// (landformUniformsGLSL on the GPU, the twin's scope on the CPU). (x, z): a
// column's centre, world cells; h: its ground height before the landforms.
export const LANDFORM_SRC = /* glsl */ `
float lfWobble(float x, float z) {
  return 1.0 + LF_WOBBLE_AMP * lfNoise2(thFdiv(x, LF_WOBBLE_WAVE), thFdiv(z, LF_WOBBLE_WAVE), LF_SALT_WOBBLE);
}

// ---- the ria. u: cells along its axis from the mouth; v: across it.
// The centreline's offset across the axis at u: two octaves of 1D noise,
// growing in from the mouth.
float lfMeander(float u) {
  float n = lfNoise1(thFdiv(u, LF_MEANDER_WAVE), LF_SALT_MEANDER)
          + LF_MEANDER_FINE * lfNoise1(thFdiv(u, LF_MEANDER_FINE_WAVE), LF_SALT_MEANDER_FINE);
  return LF_MEANDER_AMP * n * lfSmooth(0.0, LF_MEANDER_RAMP, u);
}
// Its floor at u: RIA_DEPTH under the sea at the mouth, rising to sea level
// over the drowned part, then a gorge rising RIA_GRADIENT per cell.
float lfRiaFloor(float u) {
  float drown = lfRiaDrown();
  if (u < drown) return uIslandSea - LF_RIA_DEPTH * (1.0 - clamp(thFdiv(u, drown), 0.0, 1.0));
  return uIslandSea + LF_RIA_GRADIENT * (u - drown);
}
// Its floor's half width at u.
float lfRiaHalf(float u) { return mix(LF_RIA_MOUTH_HALF, LF_RIA_GORGE_HALF, lfSmooth(0.0, lfRiaDrown(), u)); }
// Column (x, z)'s distance from the ria's centreline (its rounded head past
// the end), cells, before the walls' roughness.
float lfRiaDist(float u, float v) {
  float len = lfRiaLen();
  if (u > len) {
    float dv = v - lfMeander(len);
    return sqrt(dv * dv + (u - len) * (u - len));
  }
  float slope = thFdiv(lfMeander(u + LF_RIA_DU) - lfMeander(u - LF_RIA_DU), 2.0 * LF_RIA_DU);
  return thFdiv(abs(v - lfMeander(u)), sqrt(1.0 + slope * slope));
}
// The ria cut into ground h at column (x, z).
float lfRia(float x, float z, float h) {
  float len = lfRiaLen();
  if (len <= 0.0) return h;
  float rx = x - lfRiaX(), rz = z - lfRiaZ();
  float u = rx * lfRiaDx() + rz * lfRiaDz(), v = rz * lfRiaDx() - rx * lfRiaDz();
  if (u < -LF_RIA_OFFSHORE || u > len + LF_RIA_REACH || abs(v) > LF_MEANDER_AMP * (1.0 + LF_MEANDER_FINE) + LF_RIA_REACH) return h;
  float uc = min(u, len);
  float dist = lfRiaDist(u, v)
             + LF_RIA_ROUGH * lfNoise2(thFdiv(x, LF_RIA_ROUGH_WAVE), thFdiv(z, LF_RIA_ROUGH_WAVE), LF_SALT_RIA_ROUGH);
  return min(h, lfRiaFloor(uc) + max(dist - lfRiaHalf(uc), 0.0) * LF_RIA_WALL);
}

// ---- the mesas
// libnoise's Terrace (see the top) on stratigraphic height s, its control
// points the beds' benches.
float lfTerrace(float s) {
  float c0 = stBench(s, false), c1 = stBench(s, true);
  float a = clamp(thFdiv(s - c0, c1 - c0), 0.0, 1.0);
  return c0 + (c1 - c0) * pow(a, LF_TERRACE_EXP);
}
// The mesa region's buttes and terraces on ground h at column (x, z).
float lfMesa(float x, float z, float h) {
  float R = lfMesaR();
  if (R <= 0.0) return h;
  float dx = x - lfMesaX(), dz = z - lfMesaZ();
  float d = sqrt(dx * dx + dz * dz);
  if (d >= R) return h;
  float w = 1.0 - lfSmooth(R * LF_MESA_CORE, R, d);
  float n = lfNoise2(thFdiv(x, LF_BUTTE_WAVE), thFdiv(z, LF_BUTTE_WAVE), LF_SALT_BUTTE);
  float raw = h + w * (LF_BUTTE_H * lfSmooth(LF_BUTTE_CUT, LF_BUTTE_CUT + LF_BUTTE_SOFT, n) - LF_MESA_SINK);
  float datum = uIslandSea + stRaise(x, z);   // where stratigraphic height 0 is in this column
  return mix(raw, datum + lfTerrace(raw - datum), w);
}

// ---- sea stacks: flat-topped pillars, their sides STACK_WALL steep
float lfStacks(float x, float z, float h) {
  float g = h;
  for (int i = 0; i < LF_STACKS_MAX; i++) {
    if (i >= lfStackCount()) return g;
    float dx = x - lfStackX(i), dz = z - lfStackZ(i);
    float reach = lfStackR(i) + LF_STACK_REACH;
    if (dx * dx + dz * dz >= reach * reach) continue;
    float d = sqrt(dx * dx + dz * dz) * lfWobble(x, z);
    g = max(g, lfStackTop(i) - LF_STACK_WALL * max(d - lfStackR(i), 0.0));
  }
  return g;
}

// ---- tarns
// Tarn i's wobbled distance from column (x, z), cells (LF_FAR out of its reach).
float lfLakeDist(int i, float x, float z) {
  float dx = x - lfLakeX(i), dz = z - lfLakeZ(i);
  float reach = lfLakeR(i) + LF_LAKE_REACH;
  if (dx * dx + dz * dz >= reach * reach) return LF_FAR;
  return sqrt(dx * dx + dz * dz) * lfWobble(x, z);
}
// The ground tarn i leaves at wobbled distance d, on ground g.
float lfLakeGround(int i, float d, float g) {
  float R = lfLakeR(i), rim = lfLakeLevel(i) + float(LF_LAKE_FREEBOARD);
  // carved: the bowl under the water, the shore, the headwall
  float past = d - R;
  float carve = d < R ? lfLakeLevel(i) - LF_LAKE_DEPTH * (1.0 - pow(thFdiv(d, R), LF_LAKE_BOWL_EXP))
              : rim + LF_LAKE_SHORE * min(past, LF_LAKE_SHORE_W) + LF_LAKE_HEADWALL * max(past - LF_LAKE_SHORE_W, 0.0);
  float ground = min(g, carve);
  // the rim, enforced: at least rim height for LAKE_RIM cells past the shore, then falling away no steeper than SKIRT
  if (d >= R) ground = max(ground, rim - LF_LAKE_SKIRT * max(past - float(LF_LAKE_RIM), 0.0));
  return ground;
}
float lfLakes(float x, float z, float h) {
  float g = h;
  for (int i = 0; i < LF_LAKES_MAX; i++) {
    if (i >= lfLakeCount()) return g;
    float d = lfLakeDist(i, x, z);
    if (d < LF_FAR) g = lfLakeGround(i, d, g);
  }
  return g;
}

// ---- the foundation's hooks
// The ground height of column (x, z) after the landforms, its height before them h.
float islandLandform(float x, float z, float h) {
  float g = lfMesa(x, z, h);
  g = lfRia(x, z, g);
  g = lfStacks(x, z, g);
  return lfLakes(x, z, g);
}
// Column (x, z)'s standing-water surface: a tarn's level within its rim, else
// the sea's. Its cells below it are water where they aren't ground. (The
// layers take it as the column's sea.)
float islandWaterLevel(float x, float z, float h) {
  for (int i = 0; i < LF_LAKES_MAX; i++) {
    if (i >= lfLakeCount()) return uIslandSea;
    if (lfLakeDist(i, x, z) < lfLakeR(i) + float(LF_LAKE_RIM)) return lfLakeLevel(i);
  }
  return uIslandSea;
}
`;

// ---------------------------------------------------------------- uniforms
// The world scalars the sources read (uIslandSea, uIslandCx, uIslandCz: the
// foundation's sea level and island centre) and the sites, with the
// accessors LANDFORM_SRC calls. The JS twin binds the same names (twinScope).
export const landformUniformsGLSL = /* glsl */ `
uniform float uIslandSea;              // sea level, cells
uniform float uIslandCx;               // the island's centre, world cells
uniform float uIslandCz;
uniform vec4 uLfRia;                   // the ria's mouth (x, z) and inland direction (unit x, z)
uniform vec2 uLfRiaLen;                // its length and its drowned part's, cells (0: no ria)
uniform vec3 uLfMesa;                  // the mesa region's centre (x, z) and radius, cells (0: none)
uniform int uLfLakes;                  // tarns: how many, and each one's centre (x, z), radius and water level
uniform vec4 uLfLake[LF_LAKES_MAX];
uniform int uLfStacks;                 // sea stacks: how many, and each one's centre (x, z), radius and top
uniform vec4 uLfStack[LF_STACKS_MAX];
float lfRiaX() { return uLfRia.x; }
float lfRiaZ() { return uLfRia.y; }
float lfRiaDx() { return uLfRia.z; }
float lfRiaDz() { return uLfRia.w; }
float lfRiaLen() { return uLfRiaLen.x; }
float lfRiaDrown() { return uLfRiaLen.y; }
float lfMesaX() { return uLfMesa.x; }
float lfMesaZ() { return uLfMesa.y; }
float lfMesaR() { return uLfMesa.z; }
int lfLakeCount() { return uLfLakes; }
float lfLakeX(int i) { return uLfLake[i].x; }
float lfLakeZ(int i) { return uLfLake[i].y; }
float lfLakeR(int i) { return uLfLake[i].z; }
float lfLakeLevel(int i) { return uLfLake[i].w; }
int lfStackCount() { return uLfStacks; }
float lfStackX(int i) { return uLfStack[i].x; }
float lfStackZ(int i) { return uLfStack[i].y; }
float lfStackR(int i) { return uLfStack[i].z; }
float lfStackTop(int i) { return uLfStack[i].w; }
`;

// Everything the GPU needs, after the prelude and themedShared's helpersGLSL.
export const landformGLSL = () => [
  noiseDefinesGLSL(), strataDefinesGLSL(), definesGLSL(LANDFORM_PREFIX, L),
  landformUniformsGLSL, NOISE_SRC, STRATA_SRC, LANDFORM_SRC,
].join('\n');

// The uniforms' values for world P with sites S (landformSites).
export function landformUniforms(P, S) {
  const pad = (list, max) => Array.from({ length: max * 4 }, (_, k) => list[Math.floor(k / 4)]?.[k % 4] ?? 0);
  return {
    uIslandSea: { value: P.sea },
    uIslandCx: { value: P.center[0] },
    uIslandCz: { value: P.center[1] },
    uLfRia: { value: S.ria ? [S.ria.x, S.ria.z, S.ria.dx, S.ria.dz] : [0, 0, 1, 0] },
    uLfRiaLen: { value: S.ria ? [S.ria.len, S.ria.drown] : [0, 0] },
    uLfMesa: { value: S.mesa ? [S.mesa.x, S.mesa.z, S.mesa.r] : [0, 0, 0] },
    uLfLakes: { value: S.lakes.length },
    uLfLake: { value: pad(S.lakes.map((l) => [l.x, l.z, l.r, l.level]), L.ints.LAKES_MAX) },
    uLfStacks: { value: S.stacks.length },
    uLfStack: { value: pad(S.stacks.map((s) => [s.x, s.z, s.r, s.top]), L.ints.STACKS_MAX) },
  };
}

// The JS twin's bindings of the same names, reading sites box.sites.
function twinScope(P, box) {
  const s = () => box.sites;
  return {
    uIslandSea: P.sea, uIslandCx: P.center[0], uIslandCz: P.center[1],
    lfRiaX: () => s().ria?.x ?? 0, lfRiaZ: () => s().ria?.z ?? 0,
    lfRiaDx: () => s().ria?.dx ?? 1, lfRiaDz: () => s().ria?.dz ?? 0,
    lfRiaLen: () => s().ria?.len ?? 0, lfRiaDrown: () => s().ria?.drown ?? 0,
    lfMesaX: () => s().mesa?.x ?? 0, lfMesaZ: () => s().mesa?.z ?? 0, lfMesaR: () => s().mesa?.r ?? 0,
    lfLakeCount: () => s().lakes.length,
    lfLakeX: (i) => s().lakes[i].x, lfLakeZ: (i) => s().lakes[i].z,
    lfLakeR: (i) => s().lakes[i].r, lfLakeLevel: (i) => s().lakes[i].level,
    lfStackCount: () => s().stacks.length,
    lfStackX: (i) => s().stacks[i].x, lfStackZ: (i) => s().stacks[i].z,
    lfStackR: (i) => s().stacks[i].r, lfStackTop: (i) => s().stacks[i].top,
  };
}

// ---------------------------------------------------------------- sites
// Where the landforms go, per world: picked on the CPU from the terrain
// before them (height(x, z): the ground height at a column's centre), the
// seed breaking ties, so another seed gives another island. Ints are cells
// unless said otherwise; shares of the relief are above the sea.
export const SITE = {
  STEP: 8,                    // cells between the samples a search reads
  RAY_FAR: 1.6,               // coast searches march in from this many island radii out...
  RAY_STEP: 2,                // ...this many cells at a time
  // the ria
  RIA_TRIES: 12,              // seeded headings tried for the mouth...
  RIA_TURNS: 7,               // ...and directions inland from each, within RIA_CONE (radians) of straight in;
  RIA_CONE: 0.6,              // the pair whose path averages the highest ground wins (the gorge runs deepest)
  RIA_HEAD: 0.5,              // the gorge heads where the ground first reaches this share of the relief...
  RIA_LEN_MIN: 0.4,           // ...but at least this share of the island's radius from the mouth...
  RIA_LEN_MAX: 0.75,          // ...and at most this
  RIA_DROWN: 0.38,            // the drowned share of its length
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
if (SITE.STACK_R_MAX * L.floats.WOBBLE_AMP + (SITE.STACK_TOP_MAX + SITE.STACK_FLOOR) / L.floats.STACK_WALL > L.floats.STACK_REACH) {
  throw new Error('landforms: a stack can reach past STACK_REACH');
}

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
// rim needs no raising; null when the site won't do.
function lakeLevel(P, height, T, x, z, R) {
  const reach = R + L.ints.LAKE_RIM + 1, rimOut = R + L.ints.LAKE_RIM;
  let lo = Infinity, hi = -Infinity;
  for (let j = Math.floor(z - reach / (1 - L.floats.WOBBLE_AMP)); j <= z + reach / (1 - L.floats.WOBBLE_AMP); j++)
    for (let i = Math.floor(x - reach / (1 - L.floats.WOBBLE_AMP)); i <= x + reach / (1 - L.floats.WOBBLE_AMP); i++) {
      const cx = i + 0.5, cz = j + 0.5;
      const d = Math.hypot(cx - x, cz - z) * T.lfWobble(cx, cz);
      if (d < R || d >= rimOut) continue;
      const h = Math.floor(height(cx, cz) + 0.5);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
  const level = lo - L.ints.LAKE_FREEBOARD;
  if (level - L.floats.LAKE_DEPTH < P.sea + SITE.LAKE_ABOVE_SEA || hi - level > SITE.LAKE_RELIEF) return null;
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
      const reach = R + L.floats.LAKE_REACH;
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
      cands.push({ x: x + 0.5, z: z + 0.5, r: R, score: (hi - lo) / SITE.LAKE_RELIEF + unit(P.seed, SITE_SALT.LAKE, k + 1) });
    }
  cands.sort((a, b) => a.score - b.score);
  const lakes = [];
  for (const c of cands) {
    if (lakes.length >= count) break;
    const reach = c.r + L.floats.LAKE_REACH;
    if (lakes.some((l) => Math.hypot(l.x - c.x, l.z - c.z) < l.r + L.floats.LAKE_REACH + reach + SITE.CLEAR)) continue;
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
    // the foot: its radius, wobbled, and its sides' spread down to the sea floor, clear of the coast
    const foot = R * (1 + L.floats.WOBBLE_AMP) + (top - P.sea + SITE.STACK_FLOOR) / L.floats.STACK_WALL;
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
// size, seed) over terrain height(x, z): { ria, mesa, lakes, stacks }. The
// ria comes first and the others keep clear of it, the mesa of the tarns.
export function landformSites(P, height, T = landformTwin(P, null)) {
  const S = { ria: null, mesa: null, lakes: [], stacks: [] };
  S.ria = pickRia(P, height);
  S.mesa = pickMesa(P, height, T, S);
  S.lakes = pickLakes(P, height, T, S);
  S.stacks = pickStacks(P, height, S);
  return S;
}

// The JS twin of the sources for world P with sites S (null: only the parts
// that need none, for picking them).
export function landformTwin(P, S) {
  const box = { sites: S };
  const consts = { ...noiseConstants(), ...strataConstants(), ...jsConstants(LANDFORM_PREFIX, L), ...twinScope(P, box) };
  return compileShared(`${NOISE_SRC}\n${STRATA_SRC}\n${LANDFORM_SRC}`, P.seed, consts);
}
