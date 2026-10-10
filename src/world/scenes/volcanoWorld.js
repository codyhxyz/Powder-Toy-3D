import { helpersGLSL, definesGLSL, jsConstants, pickGLSL, compileShared } from './themedShared.js';
import { ISLAND_VIEW_XZ } from './island.js';
import { E } from '../../elements.js';

// Volcano isles: the box volcano (presets.js 'volcano') grown into an
// archipelago. A sea SEA cells deep over a gently rolling seabed, and on it
// islands: one site per CELL × CELL cells of the world, its centre jittered
// inside its cell, holding
//   - an ACTIVE volcano: a concave cone with a crater on its summit, a magma
//     chamber at its foot and a conduit up to the crater, lava lying in the
//     crater, and on its floor an endless lava source, CLONE with ctype LAVA,
//     its top above the lava (for the box volcano's reason: a buried source
//     would seal itself in, the cellular automaton has no magma pressure to
//     push lava up). The crater's rim has a breach on one side, down to the
//     lava's level, so the lava the source makes spills out that way and runs
//     down that flank to the sea;
//   - a DORMANT volcano: the same cone, cold, its crater holding a lake (ice
//     on a peak above the snow line);
//   - an ISLET: a low dome of rock;
//   - or open sea.
// Cones are wobbled by noise (no two coasts alike) and roughened away from
// the crater, and neighbouring ones merge into bigger islands. High ground
// carries snow where it can lie and glacier ice where it is too steep for
// powder (both on rock frozen under them, as the island's snow is); gentle
// shores carry beaches; the flanks between carry patchy forest, round trees
// (wood trunks, plant crowns, the box volcano's) low down and pines higher up,
// one candidate per TREE_CELL square.
//
// Every cell is a pure function of its world position and the seed, and looks
// only at the sites of its own CELL square and the eight around it (a cone
// never reaches farther: see REACH below), so a cell costs nine cone
// evaluations and a few noise lookups. Powder (snow, sand) also asks its eight
// neighbouring columns whether it is walled in, and an air cell near the
// ground asks the trees of its own and the eight neighbouring tree cells
// (whose crowns could reach it) for their columns. The geometry is written once (SRC) in the shared GLSL
// subset (themedShared.js): the GPU runs it, the CPU its JS twin.
//
// Stability, as the island's: snow and sand lie only where every neighbouring
// column stands at most a cell lower (the cellular automaton's angle of
// repose), sand only above sea level and only where no neighbour holds sea
// (the sea's flow would knock it about), trees well above the sea (plants grow
// into water they touch) and below the snow. The lava is what moves: it pours
// from the sources, sets fire to the trees in its way, melts snow and boils
// the sea where it reaches it.

const V = {
  ints: {
    SEA: 16,                // sea level: cells y < this are sea where they aren't ground (the box volcano's 8, deeper)
    FLOOR: 3,               // rock under even the deepest sea
    CELL: 128,              // the site grid: one island (or none) per this many cells square
    MARGIN: 20,             // a site's centre keeps this far inside its cell
    ROW: 3,                 // the sites a column looks at: its own cell's and its neighbours', ROW × ROW
    SLOTS: 9,               // ...ROW², numbered x fastest; SLOTS also stands for "the seabed"
    SELF: 4,                // ...the middle one, the column's own
    SLOT_ONE: 256,          // volColumn packs ground top + SLOT_ONE × slot (tops stay below it)
    PEAK: 96,               // no crater rim stands higher: room above for lava, steam and smoke
    SKY: 98,                // nothing stands this high
    DEPTH_MIN: 5,           // crater depth below its rim
    DEPTH_MAX: 8,
    LAVA_LAKE: 2,           // lava lying in an active crater, cells above its floor
    WATER_LAKE: 3,          // a dormant crater's lake
    CLONE_HALF: 2,          // the lava source is 2 × this cells square (the box volcano's 4)...
    CLONE_SINK: 2,          // ...from this far below the crater's floor up to a cell above the lava
    CHAMBER_ROOF: 4,        // rock over the magma chamber, at least
    SNOW_LINE: 44,          // snow on gentle ground from this height up (give or take SNOW_JITTER)
    SNOW_DEPTH: 2,          // snow layer (at least 2: grains on rock are walled in by their neighbours')
    FROST_DEPTH: 6,         // rock is frozen to the snow's temperature from this far below the lowest snow up...
    FROST_SPAN: 8,          // ...and warms to ambient over this many cells below that
    BEACH_ABOVE: 3,         // beaches on shore columns standing at most this far above the sea
    SAND_DEPTH: 2,
    TREE_CELL: 7,           // one tree candidate per this many cells square (at least CROWN_R)
    CROWN_R: 3,             // a crown's reach from its trunk, at most (the box volcano's)...
    CROWN_R2: 9,            // ...a round crown's cells are closer than √this to its centre...
    CROWN_UP: 2,            // ...centred this far above the trunk's top cell
    PINE_SKIRT: 2,          // a pine's cone of leaves starts this far up its trunk...
    PINE_TIP: 3,            // ...and ends this far above its top
    PINE_LINE: 28,          // trees standing this high or higher are pines
    TREE_MARGIN: 1,         // a trunk keeps this far inside its tree cell (trunks stand at least 2 × this apart)
    TRUNK_MIN: 5,
    TRUNK_MAX: 9,
    TREE_REACH: 16,         // cells above a column's ground that a neighbouring tree may reach (crown top, uphill)
    TREE_ABOVE_SEA: 5,      // trunks stand this far above the sea: off the beach (BEACH_ABOVE), leaves clear of the water
    TREE_SNOW_GAP: 3,       // ...and this far below the lowest snow (whose meltwater their leaves would grow into)
    ISLET_ABOVE_MIN: 4,     // an islet's top, above sea level
    ISLET_ABOVE_MAX: 12,

    // parameter streams of a site's hash (thKey), and of a tree cell's
    K_KIND: 1, K_X: 2, K_Z: 3, K_R: 4, K_SLOPE: 5, K_DEPTH: 6, K_BREACH: 7, K_TRUNK: 8,
  },
  floats: {
    SEABED: 7.0,            // the seabed's mean height...
    SEABED_AMP: 3.0,        // ...rolling this much up and down...
    SEABED_WAVE: 70.0,      // ...over this many cells
    CONE_BASE: 4.0,         // a cone's foot: the lowest seabed (SEABED - SEABED_AMP), so it rises out of it
    R_MIN: 40.0,            // a volcano's radius at its foot
    R_MAX: 100.0,
    ISLET_R_MIN: 16.0,
    ISLET_R_MAX: 44.0,
    SLOPE_LO: 0.6,          // a volcano's apex rises this much per cell of its radius (crater cut off)
    SLOPE_HI: 0.95,
    EXP: 1.35,               // the profile, (1 - d / R)^this: concave, steepest at the top
    ISLET_EXP: 0.6,         // an islet's: convex, a dome
    CRATER_SHARE: 0.14,     // the crater's rim radius, share of the volcano's...
    CRATER_MIN: 6.0,        // ...within these
    CRATER_MAX: 14.0,
    CRATER_EXP: 4.0,        // its bowl rises as (d / rim radius)^this: a flat floor, steep walls
    WOBBLE_AMP: 0.2,        // distances from a centre are stretched by up to this share (noise)...
    WOBBLE_WAVE: 40.0,      // ...over this many cells...
    WOBBLE_FINE: 0.3,       // ...this share of it by a finer octave...
    WOBBLE_FINE_WAVE: 13.0, // ...over this many
    ROUGH_AMP: 2.0,         // surface roughness, cells...
    ROUGH_WAVE: 11.0,        // ...over this many cells
    ROUGH_CLEAR: 1.6,       // ...fading in from this many crater radii out (the crater stays clean)
    BREACH_HALF: 2.5,       // the rim's breach: half its width...
    BREACH_LEN: 30.0,       // ...how far past the rim its channel runs...
    BREACH_FALL: 0.3,       // ...falling this much per cell
    CONDUIT_R: 3.5,         // the conduit's radius (the box volcano's)
    CHAMBER_SHARE: 0.16,    // the magma chamber's radius, share of the volcano's...
    CHAMBER_MIN: 6.0,       // ...within these...
    CHAMBER_MAX: 16.0,
    CHAMBER_FLAT: 0.5,      // ...and its height over its width
    SNOW_JITTER: 3.0,       // the snow line's wobble, cells
    SNOW_CRATER_GAP: 1.25,  // no snow within this many crater radii of an active crater (it would melt at once)
    TREE_CRATER_GAP: 2.5,   // no trees within this many crater radii of a crater
    FOREST_WAVE: 34.0,      // forest patches: their noise's wavelength, cells...
    FOREST_EDGE: -0.4,      // ...clearings where it is below this...
    FOREST_SOFT: 0.6,       // ...thickening to full over this much more
    MAGMA_T: 1900.0,        // °C: chamber, conduit and crater lava (the box volcano's)
    NOISE_NORM: 1.4142,     // 2D gradient noise peaks near ±1/√2: this scales it to about ±1
    TAU: 6.28318530718,
    FAR: 1000.0,            // farther (in crater radii) than any gap above
  },
  salts: {
    SITE: 0x7a10,           // sites
    WOBBLE: 0x7a20,         // noise fields
    ROUGH: 0x7a30,
    SEABED: 0x7a40,
    SNOW: 0x7a50,
    TREE: 0x7a60,           // tree candidates
    WOBBLE_FINE: 0x7a80,
    FOREST: 0x7a90,
    CELL: 0x7a70,           // cells' colour seeds
  },
  picks: {
    KIND: [['NONE', 0.08], ['ISLET', 0.2], ['DORMANT', 0.2], ['ACTIVE', 0.52]],
    TREE: [['YES', 0.8], ['NO', 0.2]],     // a tree cell has a tree (in the thick of a forest)
  },
};
const P_ = 'VOL';
const V_KIND = Object.fromEntries(V.picks.KIND.map(([k], i) => [k, i]));
// The farthest a cone reaches from its centre, wobble included (the wobble
// noise is clamped to ±1): within a cell, so the ROW × ROW sites around a
// column are all that can reach it.
const REACH = V.floats.R_MAX / (1 - V.floats.WOBBLE_AMP);
if (REACH > V.ints.CELL) throw new Error(`volcanoWorld: cones reach ${REACH} cells, past a site cell (${V.ints.CELL})`);

// The geometry, in the shared GLSL subset.
const SRC = /* glsl */ `
${pickGLSL(P_, 'KIND', V.picks.KIND, 'volKind')}

// Gradient noise at world column (x, z), wavelength wave cells, in stream
// salt: about ±1. Gradients at a hashed angle per lattice point; Perlin's
// quintic fade 6t⁵ - 15t⁴ + 10t³ (its published coefficients).
float volNoise(int x, int z, float wave, uint salt) {
  float px = thFdiv(float(x) + 0.5, wave), pz = thFdiv(float(z) + 0.5, wave);
  float fx0 = floor(px), fz0 = floor(pz);
  int ix = int(fx0), iz = int(fz0);
  float fx = px - fx0, fz = pz - fz0;
  float ux = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0);
  float uz = fz * fz * fz * (fz * (fz * 6.0 - 15.0) + 10.0);
  float a = thLattice(ix, iz, salt) * VOL_TAU, b = thLattice(ix + 1, iz, salt) * VOL_TAU;
  float c = thLattice(ix, iz + 1, salt) * VOL_TAU, d = thLattice(ix + 1, iz + 1, salt) * VOL_TAU;
  float va = cos(a) * fx + sin(a) * fz;
  float vb = cos(b) * (fx - 1.0) + sin(b) * fz;
  float vc = cos(c) * fx + sin(c) * (fz - 1.0);
  float vd = cos(d) * (fx - 1.0) + sin(d) * (fz - 1.0);
  return clamp(mix(mix(va, vb, ux), mix(vc, vd, ux), uz) * VOL_NOISE_NORM, -1.0, 1.0);
}
// how much distances from a centre are stretched at column (x, z)
float volWobble(int x, int z) {
  float n = mix(volNoise(x, z, VOL_WOBBLE_WAVE, VOL_SALT_WOBBLE), volNoise(x, z, VOL_WOBBLE_FINE_WAVE, VOL_SALT_WOBBLE_FINE), VOL_WOBBLE_FINE);
  return 1.0 + VOL_WOBBLE_AMP * n;
}

// ---- sites: site (sx, sz) is the one of cell (sx, sz) of the site grid
uint volSite(int sx, int sz) { return thHash2(sx, sz, VOL_SALT_SITE); }
int volSiteKind(uint h) { return volKind(thKey(h, VOL_K_KIND)); }
bool volHasCrater(int kind) { return kind == VOL_KIND_ACTIVE || kind == VOL_KIND_DORMANT; }
// its centre along one axis (k: VOL_K_X or VOL_K_Z; s: its cell's index on that axis), on a column's centre
float volCentre(uint h, int k, int s) { return float(s * VOL_CELL + thRange(thKey(h, k), VOL_MARGIN, VOL_CELL - 1 - VOL_MARGIN)) + 0.5; }
float volRadius(uint h, int kind) {
  float u = thUnit(thKey(h, VOL_K_R));
  return kind == VOL_KIND_ISLET ? mix(VOL_ISLET_R_MIN, VOL_ISLET_R_MAX, u) : mix(VOL_R_MIN, VOL_R_MAX, u);
}
float volCraterR(float R) { return clamp(R * VOL_CRATER_SHARE, VOL_CRATER_MIN, VOL_CRATER_MAX); }
// a volcano's rim height over its apex's (the profile at the crater's radius)
float volRimShare(float R) { return pow(1.0 - thFdiv(volCraterR(R), R), VOL_EXP); }
// the apex's height above the cones' foot: a volcano's from its slope (its rim
// no higher than PEAK), an islet's from its top
float volRise(uint h, int kind, float R) {
  if (kind == VOL_KIND_ISLET) {
    return float(VOL_SEA + thRange(thKey(h, VOL_K_SLOPE), VOL_ISLET_ABOVE_MIN, VOL_ISLET_ABOVE_MAX)) - VOL_CONE_BASE;
  }
  float rise = R * mix(VOL_SLOPE_LO, VOL_SLOPE_HI, thUnit(thKey(h, VOL_K_SLOPE)));
  return min(rise, thFdiv(float(VOL_PEAK) - VOL_CONE_BASE, volRimShare(R)));
}
float volRim(uint h, int kind, float R) { return VOL_CONE_BASE + volRise(h, kind, R) * volRimShare(R); }
// the crater floor's top (at its centre) and the lake's: cells y < these are ground, lake
int volFloorTop(uint h, int kind, float R) {
  return thRound(volRim(h, kind, R) - float(thRange(thKey(h, VOL_K_DEPTH), VOL_DEPTH_MIN, VOL_DEPTH_MAX)));
}
int volLakeTop(uint h, int kind, float R) {
  return volFloorTop(h, kind, R) + (kind == VOL_KIND_ACTIVE ? VOL_LAVA_LAKE : VOL_WATER_LAKE);
}

// Site h's ground height at a column (dx, dz) from its centre, d its wobbled
// distance, rough the column's roughness (cells); below zero beyond its foot.
float volCone(uint h, int kind, float R, float dx, float dz, float d, float rough) {
  float t = thFdiv(d, R);
  if (t >= 1.0) return -1.0;
  float rise = volRise(h, kind, R);
  if (kind == VOL_KIND_ISLET) return VOL_CONE_BASE + rise * pow(1.0 - t, VOL_ISLET_EXP) + rough;
  float g = VOL_CONE_BASE + rise * pow(1.0 - t, VOL_EXP);
  float rc = volCraterR(R);
  float rim = VOL_CONE_BASE + rise * volRimShare(R);
  // (volFloorTop and volLakeTop, without working out the rim again)
  int floorTop = thRound(rim - float(thRange(thKey(h, VOL_K_DEPTH), VOL_DEPTH_MIN, VOL_DEPTH_MAX)));
  float depth = rim - float(floorTop);
  if (d < rc) {
    // the crater: a bowl from the rim down to its floor
    g = rim - depth * (1.0 - pow(thFdiv(d, rc), VOL_CRATER_EXP));
  }
  g += rough * clamp(thFdiv(d, rc) - VOL_ROUGH_CLEAR, 0.0, 1.0);
  if (kind == VOL_KIND_ACTIVE) {
    // the breach: a channel from the crater through the rim at the lava's level, falling away down the flank
    float a = thUnit(thKey(h, VOL_K_BREACH)) * VOL_TAU;
    float along = dx * cos(a) + dz * sin(a), across = abs(dx * sin(a) - dz * cos(a));
    if (along > 0.0 && along < rc + VOL_BREACH_LEN && across < VOL_BREACH_HALF) {
      g = min(g, float(floorTop + VOL_LAVA_LAKE) - VOL_BREACH_FALL * max(along - rc, 0.0));
    }
  }
  return g;
}

// World column (x, z): the top of its ground (cells y < top are ground) +
// VOL_SLOT_ONE × the slot of the site whose cone it is (the ROW × ROW sites
// around its own, x fastest; VOL_SLOTS: the seabed).
int volColumn(int x, int z) {
  float wob = volWobble(x, z);
  float rough = VOL_ROUGH_AMP * volNoise(x, z, VOL_ROUGH_WAVE, VOL_SALT_ROUGH);
  float best = max(float(VOL_FLOOR), VOL_SEABED + VOL_SEABED_AMP * volNoise(x, z, VOL_SEABED_WAVE, VOL_SALT_SEABED));
  int slot = VOL_SLOTS;
  int sx = thDiv(x, VOL_CELL), sz = thDiv(z, VOL_CELL);
  for (int k = 0; k < VOL_SLOTS; k++) {
    int ax = sx + thMod(k, VOL_ROW) - 1, az = sz + thDiv(k, VOL_ROW) - 1;
    uint h = volSite(ax, az);
    int kind = volSiteKind(h);
    if (kind == VOL_KIND_NONE) continue;
    float dx = float(x) + 0.5 - volCentre(h, VOL_K_X, ax), dz = float(z) + 0.5 - volCentre(h, VOL_K_Z, az);
    float g = volCone(h, kind, volRadius(h, kind), dx, dz, sqrt(dx * dx + dz * dz) * wob, rough);
    if (g > best) { best = g; slot = k; }
  }
  return thRound(best) + VOL_SLOT_ONE * slot;
}
int volTop(int col) { return thMod(col, VOL_SLOT_ONE); }
int volSlot(int col) { return thDiv(col, VOL_SLOT_ONE); }
// the site grid cell of slot k around column (x, z), along x and along z
int volSlotX(int x, int k) { return thDiv(x, VOL_CELL) + thMod(k, VOL_ROW) - 1; }
int volSlotZ(int z, int k) { return thDiv(z, VOL_CELL) + thDiv(k, VOL_ROW) - 1; }

// How far column (x, z) is from the crater of the site of its slot, in crater
// radii (VOL_FAR when that site has no crater, or a dormant one unless
// dormantToo).
float volCraterDist(int x, int z, int slot, bool dormantToo) {
  if (slot >= VOL_SLOTS) return VOL_FAR;
  int ax = volSlotX(x, slot), az = volSlotZ(z, slot);
  uint h = volSite(ax, az);
  int kind = volSiteKind(h);
  if (kind != VOL_KIND_ACTIVE && !(dormantToo && kind == VOL_KIND_DORMANT)) return VOL_FAR;
  float dx = float(x) + 0.5 - volCentre(h, VOL_K_X, ax), dz = float(z) + 0.5 - volCentre(h, VOL_K_Z, az);
  return thFdiv(sqrt(dx * dx + dz * dz), volCraterR(volRadius(h, kind)));
}

// What the volcano of the column's site puts at cell (x, y, z), the column's
// ground topping out at top: its lava source, crater lake, conduit or magma
// chamber; E_WALL (never generated) for none of these.
int volVent(int x, int y, int z, int top, int slot) {
  if (slot >= VOL_SLOTS) return E_WALL;
  int ax = volSlotX(x, slot), az = volSlotZ(z, slot);
  uint h = volSite(ax, az);
  int kind = volSiteKind(h);
  if (!volHasCrater(kind)) return E_WALL;
  float R = volRadius(h, kind);
  float rc = volCraterR(R);
  float dx = float(x) + 0.5 - volCentre(h, VOL_K_X, ax), dz = float(z) + 0.5 - volCentre(h, VOL_K_Z, az);
  float r = sqrt(dx * dx + dz * dz);
  int lakeTop = volLakeTop(h, kind, R);
  bool inLake = y >= top && y < lakeTop && r * volWobble(x, z) < rc;
  if (kind == VOL_KIND_DORMANT) return inLake ? (lakeTop > VOL_SNOW_LINE ? E_ICE : E_WATER) : E_WALL;
  float hw = float(VOL_CLONE_HALF);
  if (dx >= -hw && dx < hw && dz >= -hw && dz < hw
      && y >= volFloorTop(h, kind, R) - VOL_CLONE_SINK && y <= lakeTop) return E_CLONE;
  if (inLake) return E_LAVA;
  if (y >= top) return E_WALL;
  float rx = clamp(R * VOL_CHAMBER_SHARE, VOL_CHAMBER_MIN, VOL_CHAMBER_MAX), ry = rx * VOL_CHAMBER_FLAT;
  float cy = float(VOL_FLOOR) + ry;
  if (r < VOL_CONDUIT_R && float(y) >= cy) return E_LAVA;
  float ey = thFdiv(float(y) + 0.5 - cy, ry);
  if (thFdiv(r * r, rx * rx) + ey * ey < 1.0 && y < top - VOL_CHAMBER_ROOF) return E_LAVA;
  return E_WALL;
}

// Do all eight columns around (x, z) have ground up to at least lo? (Then
// powder on this column is walled in.)
bool volSteady(int x, int z, int lo) {
  for (int k = 0; k < VOL_SLOTS; k++) {
    if (k == VOL_SELF) continue;
    if (volTop(volColumn(x + thMod(k, VOL_ROW) - 1, z + thDiv(k, VOL_ROW) - 1)) < lo) return false;
  }
  return true;
}
int volSnowLine(int x, int z) { return VOL_SNOW_LINE + thRound(VOL_SNOW_JITTER * volNoise(x, z, VOL_ROUGH_WAVE, VOL_SALT_SNOW)); }

// A ground cell's element: on high ground snow where it lies still and
// glacier ice where it wouldn't (too steep for powder), sand on gentle shores,
// else rock.
int volGround(int x, int y, int z, int top, int slot) {
  int depth = top - 1 - y;   // 0: the top ground cell
  if (depth < VOL_SNOW_DEPTH && top >= volSnowLine(x, z) && volCraterDist(x, z, slot, false) > VOL_SNOW_CRATER_GAP) {
    return volSteady(x, z, top - 1) ? E_SNOW : E_ICE;
  }
  if (depth < VOL_SAND_DEPTH && top > VOL_SEA && top <= VOL_SEA + VOL_BEACH_ABOVE
      && volSteady(x, z, max(VOL_SEA + 1, top - 1))) return E_SAND;
  return E_ROCK;
}

// What tree cell (cx, cz)'s tree puts at air cell (x, y, z): wood (its
// trunk), plant (its crown) or nothing (no tree there, or not this cell).
// Its trunk stands on its column's ground, if that is in the forest band
// (above the beach, below the snow, away from craters) and the forest's patch
// noise has a tree there.
int volTreePart(int x, int y, int z, int cx, int cz) {
  uint h = thHash2(cx, cz, VOL_SALT_TREE);
  int tx = cx * VOL_TREE_CELL + thRange(thKey(h, VOL_K_X), VOL_TREE_MARGIN, VOL_TREE_CELL - 1 - VOL_TREE_MARGIN);
  int tz = cz * VOL_TREE_CELL + thRange(thKey(h, VOL_K_Z), VOL_TREE_MARGIN, VOL_TREE_CELL - 1 - VOL_TREE_MARGIN);
  int dx = x - tx, dz = z - tz;
  if (abs(dx) > VOL_CROWN_R || abs(dz) > VOL_CROWN_R) return E_EMPTY;
  float forest = clamp(thFdiv(volNoise(tx, tz, VOL_FOREST_WAVE, VOL_SALT_FOREST) - VOL_FOREST_EDGE, VOL_FOREST_SOFT), 0.0, 1.0);
  if (float(thShare(h)) >= float(VOL_TREE_YES_CUT) * forest) return E_EMPTY;
  int col = volColumn(tx, tz);
  int base = volTop(col);
  if (base < VOL_SEA + VOL_TREE_ABOVE_SEA || base > VOL_SNOW_LINE - thRound(VOL_SNOW_JITTER) - VOL_TREE_SNOW_GAP) return E_EMPTY;
  if (volCraterDist(tx, tz, volSlot(col), true) < VOL_TREE_CRATER_GAP) return E_EMPTY;
  int trunk = thRange(thKey(h, VOL_K_TRUNK), VOL_TRUNK_MIN, VOL_TRUNK_MAX);
  if (dx == 0 && dz == 0 && y >= base && y < base + trunk) return E_WOOD;
  int r2 = dx * dx + dz * dz;
  if (base >= VOL_PINE_LINE) {
    // a pine: a cone of leaves, CROWN_R across at its skirt, narrowing to its tip
    int ch = trunk + VOL_PINE_TIP - VOL_PINE_SKIRT, u = y - base - VOL_PINE_SKIRT;
    int w = VOL_CROWN_R * (ch - u);
    return u >= 0 && u < ch && r2 * ch * ch < w * w ? E_PLANT : E_EMPTY;
  }
  // a round crown (the box volcano's)
  int cy = y - (base + trunk - 1 + VOL_CROWN_UP);
  return r2 + cy * cy < VOL_CROWN_R2 ? E_PLANT : E_EMPTY;
}

// An air cell's element: part of a tree (a crown reaches no farther than a
// tree cell, so the ROW × ROW tree cells around are all that can reach it;
// trunks before leaves) or air.
int volTree(int x, int y, int z, int top) {
  if (y > top + VOL_TREE_REACH) return E_EMPTY;
  int cx = thDiv(x, VOL_TREE_CELL), cz = thDiv(z, VOL_TREE_CELL);
  int found = E_EMPTY;
  for (int k = 0; k < VOL_SLOTS; k++) {
    int part = volTreePart(x, y, z, cx + thMod(k, VOL_ROW) - 1, cz + thDiv(k, VOL_ROW) - 1);
    if (part == E_WOOD) return E_WOOD;
    if (part == E_PLANT) found = E_PLANT;
  }
  return found;
}

// The element at world cell (x, y, z), its column being col (volColumn).
int volCellIn(int x, int y, int z, int col) {
  if (y < VOL_FLOOR) return E_ROCK;
  if (y >= VOL_SKY) return E_EMPTY;
  int top = volTop(col), slot = volSlot(col);
  int vent = volVent(x, y, z, top, slot);
  if (vent != E_WALL) return vent;
  if (y < top) return volGround(x, y, z, top, slot);
  if (y < VOL_SEA) return E_WATER;
  return volTree(x, y, z, top);
}
int volCell(int x, int y, int z) { return y >= VOL_SKY ? E_EMPTY : volCellIn(x, y, z, volColumn(x, z)); }

// Rock's frost at height y: 0 warm, 1 frozen to the snow's temperature (the island's ramp).
float volFrost(int y) {
  float lowest = float(VOL_SNOW_LINE) - VOL_SNOW_JITTER;
  return clamp(thFdiv(float(y) - lowest + float(VOL_FROST_DEPTH + VOL_FROST_SPAN), float(VOL_FROST_SPAN)), 0.0, 1.0);
}
`;

// start(): the window centres between the chosen volcano's summit and the
// camera, this share of its radius out (so the god view looks across its
// shore and flank up to the lava), but no more than this share of the window.
const START_OUT = 0.45;
const START_WIN = 0.3;

const twins = new Map();   // the JS twin per world seed
function twin(P) {
  if (!twins.has(P.seed)) twins.set(P.seed, compileShared(SRC, P.seed, jsConstants(P_, V)));
  return twins.get(P.seed);
}

export const VOL = { ...V.ints, ...V.floats };
export const volcanoTwin = twin;   // (tools/scene-themed-preview.mjs)

export const volcanoWorld = {
  key: 'volcanoWorld',
  label: 'Volcano isles',
  params: ({ size, seed }) => ({ size, seed: seed >>> 0, sea: V.ints.SEA, floor: V.ints.FLOOR }),
  glsl: () => /* glsl */ `
${definesGLSL(P_, V)}
${helpersGLSL}
${SRC}
void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  int id = volCell(w.x, w.y, w.z);
  float T = SPAWNT[id], ctype = 0.0;
  if (id == E_ROCK) T = mix(SPAWNT[E_ROCK], SPAWNT[E_SNOW], volFrost(w.y));
  if (id == E_LAVA) { T = VOL_MAGMA_T; ctype = float(E_STONE); }   // magma, which sets to stone
  if (id == E_CLONE) ctype = float(E_LAVA);                        // the endless lava source
  float seed = float(seedWorld(w, uSceneSeed, VOL_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), T, SPAWNLIFE[id], ctype + seed);
  B = vec4(0.0);
}
`,
  uniforms: (P) => ({ uSceneSeed: { value: P.seed } }),
  // The active volcano nearest the world's centre (bigger ones count as nearer),
  // seen from the camera's side.
  start(P, win) {
    const T = twin(P), C = V.ints.CELL;
    const mid = [P.size[0] / 2, P.size[2] / 2];
    let best = null, bestScore = Infinity;
    for (let sz = 0; sz * C < P.size[2]; sz++)
      for (let sx = 0; sx * C < P.size[0]; sx++) {
        const h = T.volSite(sx, sz), kind = T.volSiteKind(h);
        if (kind !== V_KIND.ACTIVE) continue;
        const x = T.volCentre(h, V.ints.K_X, sx), z = T.volCentre(h, V.ints.K_Z, sz), R = T.volRadius(h, kind);
        const score = Math.hypot(x - mid[0], z - mid[1]) - R;
        if (score < bestScore) { bestScore = score; best = { x, z, R }; }
      }
    if (!best) return mid;
    const len = Math.hypot(...ISLAND_VIEW_XZ), out = Math.min(START_OUT * best.R, START_WIN * Math.max(...win));
    return [best.x + (ISLAND_VIEW_XZ[0] / len) * out, best.z + (ISLAND_VIEW_XZ[1] / len) * out];
  },
  ground(x, z, P) {
    const T = twin(P), xi = Math.floor(x), zi = Math.floor(z), col = T.volColumn(xi, zi);
    for (let y = V.ints.SKY - 1; y >= 0; y--) if (T.volCellIn(xi, y, zi, col) !== E.EMPTY) return y + 1;
    return 0;
  },
};
