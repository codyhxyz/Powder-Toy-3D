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
// across its axis (natGrower; bare rock as the island makes it, so it asks
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
    GROTTO_CELL: 22, GROTTO_MARGIN: 9,
    PIPE_CELL: 44, PIPE_MARGIN: 4,
    IRON_CELL: 8,
    GOLD_CELL: 40,                   // the gold vein site grid, cells cube
    GOLD_MARGIN: 14,                 // ...centres this far inside (at least the largest lens: GOLD_R_MAX)
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
    GOLD_CHANCE: 0.25,               // chance a site has a vein
    GOLD_R_MIN: 6.0,                 // a lens' radius along the vein, cells
    GOLD_R_MAX: 14.0,
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
    IRON: 0x6e40, COPPER: 0x6e41, SULFUR: 0x6e42, SALT: 0x6e43, CINNABAR: 0x6e44,
    LITHIUM: 0x6e45, URANIUM: 0x6e46, TUNGSTEN: 0x6e47, PIPE: 0x6e48,
    GALLERY: 0x6e49, VAULT: 0x6e4a, GROTTO: 0x6e4b,
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
// Tabular sideritic ironstone: compact patches along the base of a coal
// seam. Use the same bedding gate on exposed walls and in the interior.
bool natIronPod(int x, int y, int z) {
  int sx = thDiv(x, NAT_IRON_CELL), sz = thDiv(z, NAT_IRON_CELL);
  uint h = thHash2(sx, sz, NAT_SALT_IRON);
  if (thUnit(thKey(h, NAT_K_CHANCE)) >= 0.6) return false;
  int dx = x - sx * NAT_IRON_CELL - thRange(thKey(h, NAT_K_X), 2, NAT_IRON_CELL - 3);
  int dz = z - sz * NAT_IRON_CELL - thRange(thKey(h, NAT_K_Z), 2, NAT_IRON_CELL - 3);
  return dx * dx + dz * dz <= thRange(thKey(h, NAT_K_R), 2, 4)
      && stUnderCoal(float(x) + 0.5, float(y) + 0.5, float(z) + 0.5, 2.4);
}

// One pinched lens per occupied hash cell, adapted from natGoldVein. The
// direction is one of four strikes; tilt 0 is bedding, 0.25 nearly vertical,
// and 1 diagonal (pegmatites). No new noise fields or octaves.
bool natLens(int x, int y, int z, uint salt, int grid, int r, float halfWidth, float tilt, float chance) {
  int sx = thDiv(x, grid), sy = thDiv(y, grid), sz = thDiv(z, grid);
  uint h = thKey(thHash2(sx, sz, salt), sy);
  if (thUnit(thKey(h, NAT_K_CHANCE)) >= chance) return false;
  int hi = grid - 1 - r;
  int dx = x - sx * grid - thRange(thKey(h, NAT_K_X), r, hi);
  int dy = y - sy * grid - thRange(thKey(h, NAT_K_Y), r, hi);
  int dz = z - sz * grid - thRange(thKey(h, NAT_K_Z), r, hi);
  int d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  int strike = thRange(thKey(h, NAT_K_AZIMUTH), 0, 3);
  float cross = strike == 0 ? float(dx) : (strike == 1 ? float(dz) : 0.707107 * float(dx + (strike == 2 ? dz : -dz)));
  float normal = tilt == 0.0 ? float(dy) : cross + tilt * float(dy);
  return abs(normal) <= halfWidth * (1.0 - thFdiv(float(d2), float(r * r)));
}

// Dry per the local cave water table AND surface water/lakes; include edges
// and corners (the prepass supplies one extra cell in each horizontal axis).
bool natDry(int x, int y, int z, bool sulfur) {
  if (caveLakeClear(x, z)) return false;
  for (int j = -1; j <= 1; j++)
    for (int k = -1; k <= 1; k++)
      for (int i = -1; i <= 1; i++) {
        if (i == 0 && j == 0 && k == 0) continue;
        int n = islandCellBare(x + i, y + j, z + k);
        if (n == E_WATER || (sulfur && (n == E_COAL || n == E_FIRE))) return false;
      }
  return true;
}

// A face on a buried cave, rather than merely sticking out of a cliff.
bool natCaveWall(int x, int y, int z, bool wet) {
  for (int i = 0; i < 6; i++) {
    int qx = x + natFace(i, 0), qy = y + natFace(i, 1), qz = z + natFace(i, 2);
    if (qy >= genTop(qx, qz)) continue;
    int n = islandCellBare(qx, qy, qz);
    if (n == E_EMPTY || (wet && (n == E_WATER || n == E_CRYSTAL))) return true;
  }
  return false;
}

// Kimberlite diatremes: rare narrow volcanic columns widening upward.
// A pipe has one small diamond string and discontinuous, heatless embers.
int natKimberlite(int x, int y, int z, int sea) {
  if (y < CAVE_BOTTOM || y > sea + 5) return E_ROCK;
  int sx = thDiv(x, NAT_PIPE_CELL), sz = thDiv(z, NAT_PIPE_CELL);
  uint h = thHash2(sx, sz, NAT_SALT_PIPE);
  if (thUnit(thKey(h, NAT_K_CHANCE)) >= 0.19) return E_ROCK;
  int lo = NAT_PIPE_MARGIN, hi = NAT_PIPE_CELL - 1 - lo;
  int dx = x - sx * NAT_PIPE_CELL - thRange(thKey(h, NAT_K_X), lo, hi);
  int dz = z - sz * NAT_PIPE_CELL - thRange(thKey(h, NAT_K_Z), lo, hi);
  int r2 = y >= sea - 4 ? 9 : 5;
  if (dx * dx + dz * dz > r2 || genTop(x, z) - y < CAVE_ROOF) return E_ROCK;
  int gem = thRange(thKey(h, NAT_K_Y), CAVE_BOTTOM + 1, max(CAVE_BOTTOM + 1, sea - 5));
  if (dx == 0 && dz == 0 && y >= gem && y < gem + thRange(thKey(h, NAT_K_R), 1, 3)) return E_DIAMOND;
  if (dx == 1 && dz == 0 && thUnit(thKey(h, thDiv(y, 5) + 16)) < 0.38) return E_EMBER;
  return E_BASALT;
}

int natMineral(int x, int y, int z, int id) {
  int sea = natSea();
  if (id == E_ROCK) {
    if (natGoldVein(x, y, z)) return E_GOLD;
    int pipe = natKimberlite(x, y, z, sea);
    if (pipe != id) return pipe;
    if (y <= sea + 2 && natLens(x, y, z, NAT_SALT_TUNGSTEN, 18, 4, 1.4, 0.4, 0.13)) return E_TUNGSTEN_ORE;
    if (y <= sea + 6 && natLens(x, y, z, NAT_SALT_URANIUM, 17, 5, 1.65, 0.4, 0.66)
        && genTop(x, z) - y >= 16 && (natCaveWall(x, y, z, true)
          || natLens(x, y, z, NAT_SALT_URANIUM, 17, 5, 1.65, 0.4, 0.21))) return E_URANIUM_ORE;
    if (y >= sea + 2 && natLens(x, y, z, NAT_SALT_LITHIUM, 13, 4, 2.2, 1.0, 0.65) && natDry(x, y, z, false)) return E_LITHIUM_ORE;
  } else if (id == E_LIMESTONE) {
    if (natLens(x, y, z, NAT_SALT_COPPER, 13, 5, 1.55, 0.32, 0.75)
        && (stHeight(float(x) + 0.5, float(y) + 0.5, float(z) + 0.5) < STRATA_BASEMENT_TOP + 8.0
          || natLens(x, y, z, NAT_SALT_COPPER, 13, 5, 1.55, 0.32, 0.35))) return E_COPPER_ORE;
    if (natLens(x, y, z, NAT_SALT_CINNABAR, 15, 5, 0.8, 0.20, 0.24)) return E_CINNABAR;
    if (y >= sea + 2) {
      bool vault = caveRegion(x, z) == CAVE_VAULT && genTop(x, z) - y >= 12;
      bool crust = thUnit(thHash2(x, z, NAT_SALT_VAULT)) < 0.16;
      bool vaultWall = vault && y >= sea + 4 && natCaveWall(x, y, z, false);
      if (((vaultWall && crust) || (natLens(x, y, z, NAT_SALT_SULFUR, 10, 3, 1.7, 0.0, 0.66) && natCaveWall(x, y, z, false)))
          && natDry(x, y, z, true)) return E_SULFUR;
      if (y >= sea + 4 && (vaultWall || natLens(x, y, z, NAT_SALT_SALT, 12, 4, 1.3, 0.0, 0.42))
          && natDry(x, y, z, false)) return E_ROCK_SALT;
    }
  } else if (id == E_SANDSTONE) {
    if (natIronPod(x, y, z)) return E_IRON_ORE;
  } else if (id == E_COAL && caveRegion(x, z) == CAVE_GALLERY && genTop(x, z) - y >= 12) {
    uint h = thHash2(thDiv(x, 4), z, NAT_SALT_GALLERY);
    if (thUnit(h) < 0.42 && islandCellBare(x, y - 1, z) == E_EMPTY) return E_EMBER;
  }
  return id;
}

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
  if (y + 1 >= genTop(x, z)) return false;
  // probe -1: the cell over it, cave water; then the socket (one call of islandCellBare: the GPU inlines each)
  for (int n = -1; n < NAT_PLACER_CUP; n++) {
    bool side = n >= 0 && n < 4;
    int i = n < 2 ? n : n + 2;   // faces 0, 1, 4, 5: the four sides
    int dx = n < 0 ? 0 : (side ? natFace(i, 0) : thMod(n - 4, 3) - 1);
    int dz = n < 0 ? 0 : (side ? natFace(i, 2) : thDiv(n - 4, 3) - 1);
    int j = islandCellBare(x + dx, n < 0 ? y + 1 : (side ? y : y - 1), z + dz);
    if (n < 0 ? j != E_WATER : !natSolid(j)) return false;
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
  bool grotto = y <= natSea() + 16 && caveRegion(x, z) == CAVE_GROTTO;
  int size = grotto ? NAT_GROTTO_CELL : NAT_FUNGUS_CELL;
  int sx = thDiv(x, size), sy = thDiv(y, size), sz = thDiv(z, size);
  uint h = thKey(thHash2(sx, sz, grotto ? NAT_SALT_GROTTO : NAT_SALT_FUNGUS), sy);
  if (thUnit(thKey(h, NAT_K_CHANCE)) >= (grotto ? 0.85 : NAT_FUNGUS_CHANCE)) return false;
  int lo = grotto ? NAT_GROTTO_MARGIN : NAT_FUNGUS_MARGIN, hi = size - 1 - lo;
  float ox = float(x - sx * size - thRange(thKey(h, NAT_K_X), lo, hi));
  float oy = float(y - sy * size - thRange(thKey(h, NAT_K_Y), lo, hi));
  float oz = float(z - sz * size - thRange(thKey(h, NAT_K_Z), lo, hi));
  float R = mix(grotto ? 6.0 : NAT_FUNGUS_R_MIN, grotto ? float(NAT_GROTTO_MARGIN) : NAT_FUNGUS_R_MAX, thUnit(thKey(h, NAT_K_R)));
  float reach = R * mix(NAT_FUNGUS_RAGGED, 1.0, thUnit(thKey(thHash2(x, z, NAT_SALT_FUNGUS_CELL), y)));
  return ox * ox + oy * oy + oz * oz < reach * reach;
}

// 2 to the power i
int natBit(int i) {
  int b = 1;
  for (int k = 0; k < i; k++) b *= 2;
  return b;
}

// What grows on cell (x, y, z), whose element is id (after the gold; id < 0:
// look it up), by its own rules (islandNature adds the cells under it):
// NAT_MOSS, NAT_FUNGUS or NAT_NONE. Bare rock on a cave wall: lit and near the
// water table, moss; in the dark, deep, in a patch, fungus. In the water
// table's top water row it touches water and the caves; above it, cave air and
// no water. Damp moss, besides, only where no air cell beside it touches bare
// rock across the moss's axis (react.js mossSite: that cell would grow moss),
// bare rock as the island makes it (some of it may turn to moss or gold, so
// this asks more than it must).
// The cells it reads come from one call of islandCellBare in one loop (the
// GPU inlines each call of it, and it holds the caves): probe -1 the cell
// itself, 0..5 its faces, then for damp moss 6 x 6 more, face i's faces k.
int natGrower(int x, int y, int z, int id) {
  int sea = natSea();
  if (y < sea - 1 || (id >= 0 && !natBed(id))) return NAT_NONE;
  bool mossRow = y < sea + NAT_MOSS_RISE;
  bool inPatch = genTop(x, z) - y >= NAT_FUNGUS_DEPTH && natFungusPatch(x, y, z);
  if (!mossRow && !inPatch) return NAT_NONE;
  bool lit = natLit(x, y, z);
  int kind = lit ? (mossRow ? NAT_MOSS : NAT_NONE) : (inPatch ? NAT_FUNGUS : NAT_NONE);
  if (kind == NAT_NONE) return NAT_NONE;
  int air = 0, water = 0, cave = 0;   // faces on cave air, on water, on the caves (cave air or water)
  int open = 0;                       // faces on any air: the sum of their natBit
  for (int n = id < 0 ? -1 : 0; n < 42; n++) {
    if (n == 6) {
      if (y == sea - 1 ? (water == 0 || cave == 0) : (water > 0 || air == 0)) return NAT_NONE;
      if (kind != NAT_MOSS || y > sea + NAT_WET_RISE) return kind;
    }
    int i = n < 6 ? n : thDiv(n - 6, 6), k = n < 6 ? -1 : thMod(n - 6, 6);
    if (k >= 0 && (thDiv(k, 2) == thDiv(i, 2) || thMod(thDiv(open, natBit(i)), 2) == 0)) continue;
    int qx = x, qy = y, qz = z;
    if (n >= 0) { qx += natFace(i, 0); qy += natFace(i, 1); qz += natFace(i, 2); }
    if (k >= 0) { qx += natFace(k, 0); qy += natFace(k, 1); qz += natFace(k, 2); }
    int j = islandCellBare(qx, qy, qz);
    if (n < 0) {
      if (!natBed(natMineral(x, y, z, j))) return NAT_NONE;
    } else if (k >= 0) {
      // The prepass can now also supply basalt, itself a moss bed. The
      // ore moss beds all replace members of natBed, already rejected here.
      if (natBed(j) || j == E_BASALT) return NAT_NONE;
    } else {
      bool carved = qy < genTop(qx, qz);
      if (j == E_EMPTY) open += natBit(i);
      if (j == E_WATER) water++;
      if ((j == E_WATER || j == E_EMPTY) && carved) cave++;
      if (j == E_EMPTY && carved) air++;
    }
  }
  return kind;
}

// The element at world cell (x, y, z) after gold and growers, given id, what
// the island put there (islandCellBare). A grower damp enough to stand on
// others (up to WET_RISE above the water table) is placed only on a column of
// growers down to the water's top row.
int islandNature(int x, int y, int z, int id) {
  int m = natMineral(x, y, z, id);
  if (m == E_GOLD) return m;
  if (natPlacer(x, y, z, id)) return E_NUGGETS;
  if (m != id) return m;
  int sea = natSea();
  int down = y >= sea - 1 && y <= sea + NAT_WET_RISE ? y - (sea - 1) : 0;
  int kind = NAT_NONE;
  for (int k = 0; k <= down; k++) {
    int g = natGrower(x, y - k, z, k == 0 ? id : -1);
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
