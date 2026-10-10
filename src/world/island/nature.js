import { PHYS } from '../../physics.js';

// What lives and lies in the island's caves (docs/scaling.md D11, "Island
// hooks"): moss and fungus on their walls, gold in the basement and on the
// beds of its underground lakes. islandCell (world/generator.js) calls
// islandNature last, on every cell, with the element the layers, strata and
// caves gave it (islandCellBare), and gets back the element after these.
//
// Written once in the shared GLSL subset (scenes/themedShared.js): the GPU runs
// it in the island's sceneCell (scenes/island.js), the CPU its JS twin
// (world/generator.js islandTwin; tools/nature-check.mjs audits it). In scope:
// the island's world parameters, its baked columns, the cell stage's functions
// (genTop, ...), the strata's and the caves' (caveShaft, ...), and
// islandCellBare, the cell before this hook.
//
// - GOLD: lode gold, the way it sits in quartz veins in old crystalline rock
//   (orogenic gold: Groves et al. 1998, "Orogenic gold deposits", Ore Geology
//   Reviews 13): rare steep lenses in the basement (ROCK: the strata's folded
//   slate and greywacke, world/island/strata.js), never in the beds over it.
//   A vein is a lens a cell or two thick that thins to its edge, and the gold
//   in it is patchy (miners' "nugget effect"). A solid: it never moves.
// - NUGGETS: placer gold. Gold weathered out of the veins is 19 times denser
//   than water and collects in the lowest cracks of a bed under water, so
//   nuggets lie in the bedrock floor of underground lakes on the basement, each
//   in a socket of rock (four sides and the 3 × 3 cells under it), so it
//   can't move (move.js: a grain topples only past an open side).
// - MOSS: a plant. It needs light, so it lines the caves only where daylight
//   gets in (the twilight zone of a cave mouth, a sea cave's opening, a cenote's
//   walls: natLit), and only near the water table, where the rock is wet.
// - FUNGUS: needs no light. Foxfire (its bioluminescence: gfx/materials.js)
//   in the dark: patches deep under the ground (FUNGUS_DEPTH, below tree roots
//   and away from the mouths and their mines' timbers), on any cave wall.
//
// Growers at rest (docs/elements.md, "Placing growers at rest"). Moss and
// fungus keep their damp in their ctype (react.js dampOf): DAMP_REACH beside
// water, else one less than the dampest grower beside them. Damp moss grows
// into an air cell that touches it and bare rock across its axis (mossSite);
// damp fungus rots WOOD, SAWDUST and PLANT. So a placed grower must carry its
// settled damp, and damp moss must have no such air cell beside it. A
// grower's settled damp is a distance along the mat, which a cell can't see,
// so the placement keeps it a function of height alone (islandDamp):
//   - no grower lies below the water table's top water row (sea - 1), and one
//     in that row touches water: its damp is DAMP_REACH;
//   - a grower above it touches no water, and up to WET_RISE above the water
//     table (where its damp is still 1 or more) it stands on a grower: its
//     damp is one less than the one under it, DAMP_REACH - 1 - (y - sea), and
//     nothing beside it is damper than that;
//   - higher growers are dry (0), whatever touches them: the nearest damp one
//     is DAMP_REACH cells down.
// Damp moss is placed only where no air cell beside it touches bare rock
// across its axis (natMossSafe; bare rock as the island makes it, so it asks
// more than it must), and damp fungus only deep, where no wood or plant is.
// Every grower replaces bare rock (react.js mossBed's) on a cave wall: it
// touches cave air (or, in the water row, cave water).

const DEG = Math.PI / 180;

const N = {
  ints: {
    NONE: 0, MOSS: 1, FUNGUS: 2,     // natGrower's answers
    DAMP_REACH: PHYS.DAMP_REACH,     // a grower's damp beside water (physics.js)
    WET_RISE: PHYS.DAMP_REACH - 2,   // growers up to this many cells above the water table are damp (stand on growers)
    MOSS_RISE: 6,                    // moss from the top water row up to this many cells above the water table (the wet rock)
    LIGHT_STEP: 4,                   // daylight: open ground looked for this many columns apart...
    LIGHT_RINGS: 2,                  // ...out to this many steps...
    LIGHT_DIRS: 8,                   // ...in this many directions
    FUNGUS_DEPTH: 12,                // fungus at least this many cells under its column's ground (dark, below roots)
    FUNGUS_CELL: 20,                 // the fungus patch site grid, cells cube
    FUNGUS_MARGIN: 6,                // ...centres this far inside (at least the largest patch: FUNGUS_R_MAX)
    GOLD_CELL: 40,                   // the gold vein site grid, cells cube
    GOLD_MARGIN: 12,                 // ...centres this far inside (at least the largest lens: GOLD_R_MAX)
    PLACER_CELL: 16,                 // the placer site grid, columns square
    PLACER_MARGIN: 4,                // ...centres this far inside (at least PLACER_R)
    PLACER_CUP: 13,                  // cells a nugget's socket holds: its 4 sides and the 3 × 3 under it
    // parameter streams of a site's hash (thKey)
    K_CHANCE: 1, K_X: 2, K_Y: 3, K_Z: 4, K_R: 5, K_AZIMUTH: 6, K_DIP: 7,
  },
  floats: {
    FUNGUS_CHANCE: 0.3,              // chance a site has a patch
    FUNGUS_R_MIN: 3.0,               // patch radius, cells
    FUNGUS_R_MAX: 6.0,
    FUNGUS_RAGGED: 0.5,              // each cell's reach is this share of the radius and up (a ragged patch)
    GOLD_CHANCE: 0.12,               // chance a site has a vein
    GOLD_R_MIN: 6.0,                 // a lens' radius along the vein, cells
    GOLD_R_MAX: 12.0,
    GOLD_HALF: 0.9,                  // its half-thickness at the middle, cells (~0.5 m of vein)
    GOLD_DIP_MIN: 55 * DEG,          // veins are steep (filled faults)
    GOLD_DIP_MAX: 88 * DEG,
    GOLD_SHARE: 0.45,                // share of a vein's cells that are gold (the nugget effect)
    PLACER_CHANCE: 0.35,             // chance a site has a placer
    PLACER_R: 4.0,                   // its radius, columns
    PLACER_SHARE: 0.4,               // share of its socketed bed cells holding nuggets
    TAU: 2 * Math.PI,
  },
  salts: {
    FUNGUS: 0x6e10, FUNGUS_CELL: 0x6e11,
    GOLD: 0x6e20, GOLD_CELL: 0x6e21,
    PLACER: 0x6e30, PLACER_CELL: 0x6e31,
  },
};
if (N.floats.FUNGUS_R_MAX > N.ints.FUNGUS_MARGIN) throw new Error('nature: fungus patches reach past their site cell');
if (N.floats.GOLD_R_MAX > N.ints.GOLD_MARGIN) throw new Error('nature: gold lenses reach past their site cell');
if (N.floats.PLACER_R > N.ints.PLACER_MARGIN) throw new Error('nature: placers reach past their site cell');
if (N.ints.WET_RISE >= N.ints.MOSS_RISE) throw new Error('nature: damp moss must stay inside the moss rows');

const SRC = /* glsl */ `
// faces 0..5: +x, -x, +y, -y, +z, -z; face i's offset along axis a (0: x, 1: y, 2: z)
int natFace(int i, int a) { return thDiv(i, 2) == a ? 1 - 2 * thMod(i, 2) : 0; }
// bare rock: what moss creeps over (react.js mossBed; STONE is never generated)
bool natBed(int id) { return id == E_ROCK || id == E_LIMESTONE || id == E_SANDSTONE; }
bool natSolid(int id) { return natBed(id) || id == E_COAL || id == E_CRYSTAL || id == E_GOLD; }
// the water table's level: cells y < it below it are cave water (caves.js)
int natSea() { return thRound(uGenSea); }

// ---- gold: a site per GOLD_CELL cube (some empty) holds a lens of vein, a
// disc of radius R through the site at a hashed strike and dip, GOLD_HALF thick
// in the middle, thinning to nothing at its rim; GOLD_SHARE of its cells gold
bool natGoldVein(int x, int y, int z) {
  int sx = thDiv(x, NAT_GOLD_CELL), sy = thDiv(y, NAT_GOLD_CELL), sz = thDiv(z, NAT_GOLD_CELL);
  uint h = thKey(thHash2(sx, sz, NAT_SALT_GOLD), sy);
  if (thUnit(thKey(h, NAT_K_CHANCE)) >= NAT_GOLD_CHANCE) return false;
  int lo = NAT_GOLD_MARGIN, hi = NAT_GOLD_CELL - 1 - NAT_GOLD_MARGIN;
  float ox = float(x - sx * NAT_GOLD_CELL - thRange(thKey(h, NAT_K_X), lo, hi));
  float oy = float(y - sy * NAT_GOLD_CELL - thRange(thKey(h, NAT_K_Y), lo, hi));
  float oz = float(z - sz * NAT_GOLD_CELL - thRange(thKey(h, NAT_K_Z), lo, hi));
  float a = thUnit(thKey(h, NAT_K_AZIMUTH)) * NAT_TAU;
  float dip = mix(NAT_GOLD_DIP_MIN, NAT_GOLD_DIP_MAX, thUnit(thKey(h, NAT_K_DIP)));
  float across = sin(dip) * (ox * cos(a) + oz * sin(a)) + cos(dip) * oy;   // along the lens' normal
  float R = mix(NAT_GOLD_R_MIN, NAT_GOLD_R_MAX, thUnit(thKey(h, NAT_K_R)));
  float along = thFdiv(ox * ox + oy * oy + oz * oz - across * across, R * R);   // in the lens' plane, radii squared
  if (along >= 1.0 || abs(across) > NAT_GOLD_HALF * (1.0 - along)) return false;
  return thUnit(thKey(thHash2(x, z, NAT_SALT_GOLD_CELL), y)) < NAT_GOLD_SHARE;
}
// the element after the gold: veins only in the basement (the strata's ROCK)
int natMineral(int x, int y, int z, int id) { return id == E_ROCK && natGoldVein(x, y, z) ? E_GOLD : id; }

// ---- placer gold: a site per PLACER_CELL square of columns (some empty)
// holds a placer PLACER_R across; in it, a bed cell of basement under cave
// water whose socket (4 sides, 3 × 3 under) is all solid holds nuggets
// PLACER_SHARE of the time
bool natPlacer(int x, int y, int z, int id) {
  if (id != E_ROCK || y >= natSea() - 1) return false;
  int sx = thDiv(x, NAT_PLACER_CELL), sz = thDiv(z, NAT_PLACER_CELL);
  uint h = thHash2(sx, sz, NAT_SALT_PLACER);
  if (thUnit(thKey(h, NAT_K_CHANCE)) >= NAT_PLACER_CHANCE) return false;
  int lo = NAT_PLACER_MARGIN, hi = NAT_PLACER_CELL - 1 - NAT_PLACER_MARGIN;
  float ox = float(x - sx * NAT_PLACER_CELL - thRange(thKey(h, NAT_K_X), lo, hi));
  float oz = float(z - sz * NAT_PLACER_CELL - thRange(thKey(h, NAT_K_Z), lo, hi));
  if (ox * ox + oz * oz >= NAT_PLACER_R * NAT_PLACER_R) return false;
  if (thUnit(thKey(thHash2(x, z, NAT_SALT_PLACER_CELL), y)) >= NAT_PLACER_SHARE) return false;
  if (islandCellBare(x, y + 1, z) != E_WATER || y + 1 >= genTop(x, z)) return false;   // under cave water
  for (int n = 0; n < NAT_PLACER_CUP; n++) {
    bool side = n < 4;
    int i = n < 2 ? n : n + 2;   // faces 0, 1, 4, 5: the four sides
    int dx = side ? natFace(i, 0) : thMod(n - 4, 3) - 1;
    int dz = side ? natFace(i, 2) : thDiv(n - 4, 3) - 1;
    if (!natSolid(islandCellBare(x + dx, side ? y : y - 1, z + dz))) return false;
  }
  return true;
}

// ---- light: does daylight reach height y of column (x, z)? Where open
// ground (or water) lies at or below it within LIGHT_RINGS steps of
// LIGHT_STEP columns (a cave mouth, a sea cave's opening, a cliff's foot), or
// a cenote's shaft opens beside it. A proxy: it doesn't trace the light's way
// in, so rock a few cells thick between counts as open.
bool natLit(int x, int y, int z) {
  for (int r = 1; r <= NAT_LIGHT_RINGS; r++)
    for (int i = 0; i < NAT_LIGHT_DIRS; i++) {
      float a = float(i) * thFdiv(NAT_TAU, float(NAT_LIGHT_DIRS)), d = float(r * NAT_LIGHT_STEP);
      if (genTop(x + thRound(d * cos(a)), z + thRound(d * sin(a))) <= y) return true;
    }
  float G = float(genTop(x, z));
  if (!caveOpenable(G, genColWater(x, z)) || caveLakeClear(x, z)) return false;
  return caveShaft(x, z, float(y) + 0.5, G, uGenSea) < CAVE_CRYSTAL_OUT;   // on a shaft's wall
}

// ---- fungus patches: a site per FUNGUS_CELL cube (some empty), a ragged
// ball around it (as caves.js caveCrystal's)
bool natFungusPatch(int x, int y, int z) {
  int sx = thDiv(x, NAT_FUNGUS_CELL), sy = thDiv(y, NAT_FUNGUS_CELL), sz = thDiv(z, NAT_FUNGUS_CELL);
  uint h = thKey(thHash2(sx, sz, NAT_SALT_FUNGUS), sy);
  if (thUnit(thKey(h, NAT_K_CHANCE)) >= NAT_FUNGUS_CHANCE) return false;
  int lo = NAT_FUNGUS_MARGIN, hi = NAT_FUNGUS_CELL - 1 - NAT_FUNGUS_MARGIN;
  float ox = float(x - sx * NAT_FUNGUS_CELL - thRange(thKey(h, NAT_K_X), lo, hi));
  float oy = float(y - sy * NAT_FUNGUS_CELL - thRange(thKey(h, NAT_K_Y), lo, hi));
  float oz = float(z - sz * NAT_FUNGUS_CELL - thRange(thKey(h, NAT_K_Z), lo, hi));
  float R = mix(NAT_FUNGUS_R_MIN, NAT_FUNGUS_R_MAX, thUnit(thKey(h, NAT_K_R)));
  float reach = R * mix(NAT_FUNGUS_RAGGED, 1.0, thUnit(thKey(thHash2(x, z, NAT_SALT_FUNGUS_CELL), y)));
  return ox * ox + oy * oy + oz * oz < reach * reach;
}

// Damp moss at (x, y, z) stays put only if no air cell beside it touches bare
// rock across the moss's axis (react.js mossSite: that cell would grow moss).
// The faces' cells and theirs as the island makes them (islandCellBare): some
// of that rock may turn to moss or gold, so this asks more than it must.
bool natMossSafe(int x, int y, int z) {
  bool air = false;
  for (int n = 0; n < 42; n++) {
    int i = thDiv(n, 7), k = thMod(n, 7) - 1;   // face i's cell (k = -1), then its faces k
    if (k >= 0 && (!air || thDiv(k, 2) == thDiv(i, 2))) continue;
    int dx = natFace(i, 0), dy = natFace(i, 1), dz = natFace(i, 2);
    if (k >= 0) { dx += natFace(k, 0); dy += natFace(k, 1); dz += natFace(k, 2); }
    int j = islandCellBare(x + dx, y + dy, z + dz);
    if (k < 0) air = j == E_EMPTY;
    else if (natBed(j)) return false;
  }
  return true;
}

// What grows on cell (x, y, z), whose element is id (after the gold), by its
// own rules (islandNature adds the cells under it): NAT_MOSS, NAT_FUNGUS or
// NAT_NONE. Bare rock on a cave wall: lit and near the water table, moss; in
// the dark, deep, in a patch, fungus. In the water table's top water row it
// touches water and the caves; above it, cave air and no water.
int natGrower(int x, int y, int z, int id) {
  int sea = natSea();
  if (!natBed(id) || y < sea - 1) return NAT_NONE;
  bool mossRow = y < sea + NAT_MOSS_RISE;
  bool patch = genTop(x, z) - y >= NAT_FUNGUS_DEPTH && natFungusPatch(x, y, z);
  if (!mossRow && !patch) return NAT_NONE;
  bool lit = natLit(x, y, z);
  int kind = lit ? (mossRow ? NAT_MOSS : NAT_NONE) : (patch ? NAT_FUNGUS : NAT_NONE);
  if (kind == NAT_NONE) return NAT_NONE;
  int air = 0, water = 0, cave = 0;   // faces on cave air, on water, on the caves (cave air or water)
  for (int i = 0; i < 6; i++) {
    int qx = x + natFace(i, 0), qy = y + natFace(i, 1), qz = z + natFace(i, 2);
    int j = islandCellBare(qx, qy, qz);
    bool carved = qy < genTop(qx, qz);
    if (j == E_WATER) water++;
    if ((j == E_WATER || j == E_EMPTY) && carved) cave++;
    if (j == E_EMPTY && carved) air++;
  }
  if (y == sea - 1 ? (water == 0 || cave == 0) : (water > 0 || air == 0)) return NAT_NONE;
  if (kind == NAT_MOSS && y <= sea + NAT_WET_RISE && !natMossSafe(x, y, z)) return NAT_NONE;
  return kind;
}

// The element at world cell (x, y, z) after gold and growers, given id, what
// the island put there (islandCellBare). A grower damp enough to stand on
// others (up to WET_RISE above the water table) is placed only on a column of
// growers down to the water's top row.
int islandNature(int x, int y, int z, int id) {
  int m = natMineral(x, y, z, id);
  if (m != id) return m;
  if (natPlacer(x, y, z, id)) return E_NUGGETS;
  int sea = natSea();
  int down = y >= sea - 1 && y <= sea + NAT_WET_RISE ? y - (sea - 1) : 0;
  int kind = NAT_NONE;
  for (int k = 0; k <= down; k++) {
    int g = natGrower(x, y - k, z, k == 0 ? id : natMineral(x, y - k, z, islandCellBare(x, y - k, z)));
    if (g == NAT_NONE) return id;
    if (k == 0) kind = g;
  }
  return kind == NAT_MOSS ? E_MOSS : E_FUNGUS;
}

// A generated cell's ctype at height y, element id: a grower's settled damp
// (react.js dampOf; see the rules above), else 0.
float islandDamp(int y, int id) {
  if (id != E_MOSS && id != E_FUNGUS) return 0.0;
  int sea = natSea();
  return float(y < sea ? NAT_DAMP_REACH : max(NAT_DAMP_REACH - 1 - (y - sea), 0));
}
`;

export const nature = { prefix: 'NAT', tables: N, src: SRC };
export const NATURE = { ...N.ints, ...N.floats };
