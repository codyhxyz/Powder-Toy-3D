import { helpersGLSL, definesGLSL, jsConstants, compileShared, groundScan } from '../themedShared.js';
import { E } from '../../../elements.js';
import { bakeWang, wangGLSL, minesKit, coalKit, snowKit, MAT, GEOM, WANG_OUT } from '../../wang/index.js';

// Descent (docs/descent-contract.md): the starting mountain and the first three
// biomes of Noita's main path, one world scene per level, each ending at the
// bottom in a Holy Mountain.
//
//   descentMines  a forested surface, a snowy mountain with a cave mouth on its
//                 west slope (the spawn) and a ramp down inside it to the entry
//                 hall over the Mines: herringbone Wang tiles (src/world/wang/,
//                 kits/mines.js: shored galleries, rail corridors, halls, sumps,
//                 caverns, crystal lanterns), four 24-cell layers, the bottom
//                 one's exit shaft over the temple's entry shaft
//   descentCoal   the Coal Pits: wider, rougher tunnels in rock with COAL seams,
//                 caverns at crossings, toxic sludge sumps, rubble heaps
//   descentSnow   the Snowy Depths: ice strata in the rock, snow on every floor,
//                 frozen sumps, brick ruins, everything below freezing
//
// Every level is the same slab, DS_WORLD: 512 × 256 × 512 cells (154 × 77 × 154
// m). Why: the window is then 128 × 256 × 128 (4.2 M cells; the island's is
// 2.1 M, the giant volcano's 6.3 M), tall enough for a mountain over five
// tunnel layers over the temple band; and the footprint is a quarter of the
// island's, so a level is a few minutes' walk across, not a continent. Noita's
// biome bands are about 3,600 × 900 px (540 × 135 m at 0.15 m/px): this keeps
// a third of their width and folds their depth into tunnel layers.
//
// Bottom up, every level:
//   y < FLOOR            WALL
//   y < BAND_TOP         the Holy Mountain band: WALL (indestructible, as
//                        Noita's temple walls are), the temple carved in it and
//                        lined with SANDSTONE (Noita's temple brick): an entry
//                        shaft from the lowest tunnel layer at its west end (two
//                        ledges break the fall), a landing and stairs, the
//                        healing pool sunk in the floor, five BRICK shop
//                        pedestals, the spell refresher's and the three perk
//                        altars' sites, crystal lights in the ceiling, and the
//                        exit pit at its east end
//   BIOME_Y0 + k·LAYER_H tunnel layer k (0 the lowest): corridors along x in rows
//                        and along z in columns of a GRID lattice, each segment
//                        open by its hash (the main row through the world's middle
//                        always), shafts down to the layer below at crossings (one
//                        forced on the main row per layer, so there is always a
//                        way down: Noita's main path), a ledge in each
//   above                the surface (Mines) or the roof rock (Coal, Snow)
//
// A pure function of the world cell, written once in the shared GLSL subset
// (themedShared.js): the GPU runs it, the CPU its JS twin (descentTwin) for
// ground() and for levels.js's sites (scripts/check-descent-levels.mjs). A cell
// costs a dozen hashes and, near the surface or in rock, a noise sample or two.
// The world seed is not used: every run gets the same levels (levels.js's
// sites come from the twin), as Noita's main path keeps its shape.

export const DS_WORLD = [512, 256, 512];
export const DS_SEED = 0x5ca1ab1e;   // the hash streams' seed (uSceneSeed), fixed: see above
const SALT_LEVEL_STEP = 0x9e3779b9;   // each level's salts are the base ones plus this many times its index

// Shared by all three levels (cells, unless said otherwise).
const COMMON = {
  WX: DS_WORLD[0], WY: DS_WORLD[1], WZ: DS_WORLD[2],
  FLOOR: 2,             // WALL under everything
  PERMILLE: 1000,       // chances are in per mille
  SHARE_ONE: 0x10000,   // a hash share's range (themedShared.js SHARE_ONE)
  // the Holy Mountain band and its temple (Noita: a sealed band under every biome)
  BAND_TOP: 40,         // the band's top: indestructible below, but for the temple
  BIOME_Y0: 44,         // the lowest tunnel layer's floor (4 cells of biome rock over the band)
  TX0: 186,             // the temple's air volume: x [TX0, TX1)...
  TX1: 330,             // ...144 cells (43 m) long, as Noita's is long and low
  TZC: 256,             // ...z centred here (the world's middle, the main row's)...
  TZ_HALF: 10,          // ...20 cells (6 m) wide...
  TY0: 14,              // ...from its floor's top...
  TY1: 30,              // ...to its ceiling (16 cells, 4.8 m: a body is 6)
  LINING: 2,            // SANDSTONE this thick round it and its pit, WALL beyond
  ESHAFT_X0: 190,       // the entry shaft: its west edge (temple x + 4)...
  ESHAFT_W: 8,          // ...8 × 8 cells, z centred on TZC, from the lowest layer's floor down into the temple
  LEDGE_A: 35,          // a sandstone ledge in it, on its west half (a 8-cell drop from the layer's floor)...
  LEDGE_B: 28,          // ...and one on its east half lower down (7 cells), over the landing (6 cells):
                        //  every drop under vitals.js SAFE_FALL_M (3 m = 10 cells)
  LAND_W: 14,           // the landing under the shaft: this long from the temple's west end...
  LAND_H: 8,            // ...this high; stairs down from it, 1 cell per 2 across
  POOL_REL0: 34,        // the healing pool (Noita's): x from the temple's west end...
  POOL_REL1: 50,
  POOL_INSET: 2,        // ...its sides this far in from the temple's...
  POOL_D: 4,            // ...this deep under the floor
  SHOP_REL0: 60,        // the first of the shop pedestals (Noita: 5 items, wands and spells)...
  SHOP_STEP: 10,        // ...one every this many cells
  SHOP_N: 5,
  PED_H: 3,             // a pedestal: 2 × 2 cells, this tall (BRICK)
  REFRESH_REL: 80,      // the spell refresher's site: by the middle pedestal...
  REFRESH_DZ: 7,        // ...this far towards the temple's back wall
  ALTAR_REL0: 112,      // the perk altar's three sites (perks.js SHRINE_OFFERS = 3)...
  ALTAR_STEP: 6,
  ALTAR_N: 3,
  PIT_REL0: 132,        // the exit pit: from here to the temple's east end...
  PIT_Y0: 4,            // ...down to this floor
  EXIT_H: 6,            // the exit volume: the pit's bottom this tall (falling into it descends)
  LIGHT_STEP: 16,       // crystal lights in the temple's ceiling, one every this many cells
  // the tunnel lattice
  GRID: 48,             // between corridor centres, both ways (14 m)
  GRID_HALF: 24,
  GRID_OFF: 16,         // the first corridor's centre
  COLS: 11,             // corridors along z (x centres 16, 64, ... 496)...
  ROWS: 11,             // ...and along x
  MAIN_ROW: 5,          // the row through the world's middle (z 256), always open, featureless
  LAYER_H: 16,          // floor to floor (4.8 m): a drop down a shaft, with its ledge halfway, never hurts
  SHAFT_HALF: 3,        // a shaft: 5 × 5 cells
  SHAFT_COL_LO: 1,      // the main row's forced shaft: in a column from this...
  SHAFT_COL_HI: 9,      // ...to this
  LEDGE_Y: 7,           // a shaft's ledge: this far over the lower layer's floor, on its west half
  BUMP_W: 4,            // a tunnel's ceiling rises by up to BUMP_H in blocks this wide
  SUMP_D: 3,            // a sump: the floor's liquid this deep under it...
  SUMP_A: 14,           // ...from this far along its segment to as far from its end
  K_SUMP: 1,            // feature keys of a segment's hash
  K_OIL: 2,
  K_FEATURE: 3,
  LANTERN_REL: 24,      // Mines: the crystal lantern under the frame in a segment's middle
  BEAM: 8,              // Mines: a timber frame every this many cells
  PILLAR: 12,           // Snow: brick pillars in a ruin, every this many cells
  RUIN_T: 1,            // Snow: a ruin's wall: this far each side of the segment's middle...
  DOOR_HALF: 3,         // ...with a doorway 5 wide...
  DOOR_H: 8,            // ...and 7 tall over its brick sill
  RUBBLE_H: 4,          // Coal: a rubble heap's height in the segment's middle (slopes 1 in 2)
  // Mines: the surface
  SURF: 144,            // the forest floor's mean height
  HILL_A_I: 4,          // the hills' amplitude, whole cells (SURF_LO)
  MTN_X: 256,           // the mountain's peak column...
  MTN_Z: 256,
  SNOW_LINE: 196,       // snow on the mountain over this height...
  SNOW_D: 3,            // ...this deep (and on the Snowy Depths' roof)
  GRASS_MTN: 6,         // grass on the ground where the mountain rises less than this
  MOUTH_Y: 152,         // the cave mouth's floor (8 cells up the slope)
  APPROACH_OUT: 8,     // the cut up to the mouth starts this far out from the mountain's foot...
  PORCH_HALF: 6,        // ...its causeway 11 wide (the cut itself a tunnel's width)...
  PORCH_D: 10,          // ...and this thick under the cut's floor
  JOIN_L: 8,            // the doorway from the ramp's foot into the main row: this long
  TREE_G: 16,           // tree sites: one per this many cells square...
  TREE_G_HALF: 8,
  TREE_JIT: 1,          // ...a trunk up to this far off its site's middle...
  TREE_ON: 450,         // ...in this many per mille
  TRUNK_H: 12,          // a trunk: 2 × 2 cells, this tall (3.6 m), under...
  TREE_MTN_D: 150,      // ...trees only this far from the peak (off the mountain)
};
const COMMON_F = {
  HILL_F: 0.018,        // hills: noise frequency, per cell...
  HILL_A: 4.0,          // ...amplitude
  MTN_XF: 256.0,        // the peak's column (floats)
  MTN_ZF: 256.0,
  MTN_R: 140.0,         // the mountain's foot from the peak
  MTN_H: 88.0,          // its height over the forest floor (26 m)
  MTN_PROFILE: 1.3,     // concave flanks (giantVolcano.js VOLC_PROFILE)
  MTN_NF: 0.05,         // rock roughness on it: frequency...
  MTN_NA: 4.0,          // ...amplitude, fading to nothing at the foot
  CROWN_R: 4.5,         // a tree's crown: a ball this wide round the trunk's top
  ROOF_F: 0.03,         // Coal, Snow: the roof rock's top: noise frequency...
  ROOF_A: 4.0,          // ...amplitude
  SEAM_F: 0.035,        // Coal's seams / Snow's ice strata: their wobble's frequency...
  SEAM_A: 5.0,          // ...amplitude
  COLD_T: -15.0,        // °C: everything in the Snowy Depths, so its ice keeps
};
const COMMON_SALTS = {
  SEGX: 0x51a7e1, SEGZ: 0x3b2c19, MAIN: 0x7f4a23, SHAFT: 0x2d9e57, BUMP: 0x6c1f0b, HALL: 0x48e3a1,
  ORE: 0x1b77c5, SEAM: 0x5f0e93, HILL: 0x0c6b3d, MTN: 0x27a4f1, TREE: 0x6e9b25, ROOF: 0x33d10f, CELL: 0x4a52c7,
};

// Each level's own: its biome's tunnels and features. kit: a Wang tile kit
// (src/world/wang/kits/) tiles the biome band instead of the lattice: swapping
// another kit in is one `kit:` here (then node scripts/check-descent-levels.mjs
// --write regenerates levels.js). All three levels are Wang now (2026-10-11).
export const DS_LEVEL_DEFS = [
  { key: 'descentMines', label: 'Descent: Mines', name: 'Mines', tier: 1, kit: minesKit, ints: {
    LEVEL: 0, LAYERS: 5, TUN_HALF: 4, TUN_H: 10, BUMP_H: 2,   // 7 wide, 10 tall (+2): Noita's mine galleries
    SEG_ON: 620, SHAFT_ON: 120, SUMP_ON: 220, OIL_ON: 300, FEATURE_ON: 0,
    HALL_ON: 0, HALL_R2: 0, HALL_H: 0, ORE: 6,                 // gold: blocks of 3³ in this many per mille of the rock
    ROOF: 0,
    ENTRY_I: 8, ENTRY_K: 10 } },                               // Wang levels: the top layer's unit the way in drops into
                                                               // (Mines: just east of where the ramp from the mouth bottoms out)
  { key: 'descentCoal', label: 'Descent: Coal Pits', name: 'Coal Pits', tier: 2, kit: coalKit, ints: {
    LEVEL: 1, LAYERS: 7, TUN_HALF: 5, TUN_H: 11, BUMP_H: 1,   // 9 wide, 11 tall (+1)
    SEG_ON: 560, SHAFT_ON: 150, SUMP_ON: 300, OIL_ON: 0, FEATURE_ON: 350,   // rubble heaps
    HALL_ON: 450, HALL_R2: 121, HALL_H: 14, ORE: 25,           // caverns of radius 11 at crossings; coal pockets
    ROOF: 168,
    ENTRY_I: 12, ENTRY_K: 10 } },                              // (under the level above's exit pit, as the lattice's spawn)
  { key: 'descentSnow', label: 'Descent: Snowy Depths', name: 'Snowy Depths', tier: 3, kit: snowKit, ints: {
    LEVEL: 2, LAYERS: 7, TUN_HALF: 4, TUN_H: 11, BUMP_H: 1,
    SEG_ON: 600, SHAFT_ON: 130, SUMP_ON: 280, OIL_ON: 0, FEATURE_ON: 300,   // brick ruins
    HALL_ON: 250, HALL_R2: 81, HALL_H: 13, ORE: 2,             // smaller ice halls; crystal pockets
    ROOF: 168,
    ENTRY_I: 12, ENTRY_K: 10 } },
];

// Derived constants: the cave mouth on the mountain's west slope, where the
// rock's top (less its roughness and the hills) clears the mouth's ceiling by
// MOUTH_COVER, and the ramp down from it to the top layer's floor.
const MOUTH_COVER = 2;
// A level with a Wang kit (DS_LEVEL_DEFS kit; docs/wang-tiles.md) tiles its biome
// band with it instead of the lattice: the region starts at BIOME_Y0 (its bottom
// layer's exit shaft opens straight into the temple's entry shaft, so the region
// is offset in x and z to put a unit's centre over that shaft) and holds as many
// layers as fit under the surface (Mines) or the roof rock. The way in ends in
// the entry hall, a chamber on the region's top over the top layer's entry
// shaft: the Mines' ramp from the cave mouth bottoms out into it; the Coal Pits'
// and Snowy Depths' spawns stand in it.
const ENTRY_HALL_HALF_X = 10;   // the entry hall: this far each side of the entry shaft in x...
const ENTRY_HALL_HALF_Z = 7;    // ...and in z (the shaft is GEOM.SHAFT_W across: a walkway round it)
const ENTRY_HALL_LIGHT = 4;     // its crystal lantern: this far in from the hall's ends, in its ceiling
const posMod = (a, n) => ((a % n) + n) % n;
function wangDerived(ints, ceiling) {
  const { U, H } = GEOM;
  const ex = COMMON.ESHAFT_X0 + COMMON.ESHAFT_W / 2, ez = COMMON.TZC;   // the temple's entry shaft's middle
  const x0 = posMod(ex - U / 2, U), z0 = posMod(ez - U / 2, U);
  const layers = Math.floor((ceiling - COMMON.BIOME_Y0) / H);
  const top = COMMON.BIOME_Y0 + layers * H;
  const cx = x0 + ints.ENTRY_I * U + U / 2, cz = z0 + ints.ENTRY_K * U + U / 2;
  return {
    WANG_X0: x0, WANG_Z0: z0, WANG_Y0: COMMON.BIOME_Y0,
    WANG_NX: Math.floor((COMMON.WX - x0) / U), WANG_NZ: Math.floor((COMMON.WZ - z0) / U), WANG_LAYERS: layers,
    WANG_TOP: top,
    WANG_EXIT_I: (ex - U / 2 - x0) / U, WANG_EXIT_K: (ez - U / 2 - z0) / U,
    ENTRY_CX: cx, ENTRY_CZ: cz,
    EHALL_X0: cx - ENTRY_HALL_HALF_X, EHALL_X1: cx + ENTRY_HALL_HALF_X,
    EHALL_Z0: cz - ENTRY_HALL_HALF_Z, EHALL_Z1: cz + ENTRY_HALL_HALF_Z,
    EHALL_LIGHT: ENTRY_HALL_LIGHT,
  };
}
function derived(ints, kit) {
  const need = COMMON.MOUTH_Y - COMMON.SURF + ints.TUN_H + MOUTH_COVER + COMMON_F.MTN_NA + COMMON_F.HILL_A;
  const d = COMMON_F.MTN_R * (1 - (need / COMMON_F.MTN_H) ** (1 / COMMON_F.MTN_PROFILE));
  const mouthX = Math.floor(COMMON.MTN_X - d);
  const topFloor = COMMON.BIOME_Y0 + (ints.LAYERS - 1) * COMMON.LAYER_H;
  const surfLo = COMMON.SURF - COMMON.HILL_A_I - 1;
  const roofLo = ints.ROOF - Math.ceil(COMMON_F.ROOF_A) - 1;
  const W = wangDerived(ints, ints.LEVEL === 0 ? surfLo + 1 : roofLo);
  return {
    ...W,
    WANG: kit ? 1 : 0,
    // Wang levels: the ramp runs from the mouth along the entry hall's middle, down to the region's top
    RAMP_FLOOR: kit ? W.WANG_TOP : topFloor,
    MOUTH_X: mouthX,
    RAMP_X1: kit ? W.EHALL_X1 : mouthX + 2 * (COMMON.MOUTH_Y - topFloor),   // 1 cell down per 2 across
    TOP_FLOOR: topFloor,
    RAMP_Z0: kit ? W.ENTRY_CZ - ints.TUN_HALF + 1 : COMMON.TZC + ints.TUN_HALF + 1,   // the way in's band: a cell of wall from the main row's
    RAMP_ZC: kit ? W.ENTRY_CZ : COMMON.TZC + 2 * ints.TUN_HALF,                      // ...its middle
    SURF_LO: surfLo,
    APPROACH_X0: COMMON.MTN_X - COMMON_F.MTN_R - COMMON.APPROACH_OUT,
    APPROACH_Y0: COMMON.SURF - COMMON.HILL_A_I,          // the cut's floor where it starts: the hills' lowest
    TREE_TOP: COMMON.SURF + COMMON.HILL_A_I + 1 + COMMON.TRUNK_H + Math.ceil(COMMON_F.CROWN_R) + 1,
    ROOF_LO: roofLo,
  };
}

function tables(level) {
  const def = DS_LEVEL_DEFS[level];
  const salts = Object.fromEntries(Object.entries(COMMON_SALTS).map(([k, v]) => [k, (v + level * SALT_LEVEL_STEP) >>> 0]));
  return { ints: { ...COMMON, ...def.ints, ...derived(def.ints, def.kit) }, floats: COMMON_F, salts };
}
const PREFIX = 'DS';

// ---- the shared source (themedShared.js subset)
const SRC = /* glsl */ `
// a hash of three ints
uint dsH3(int a, int b, int c, uint salt) { return thKey(thHash2(a, b, salt), c); }
// does hash h come up, pm times in a thousand?
bool dsChance(uint h, int pm) { return thShare(h) * DS_PERMILLE < pm * DS_SHARE_ONE; }

// ---- the tunnel lattice
// is layer k's corridor along x in row j open between columns s and s + 1?
bool dsSegX(int k, int j, int s) {
  if (s < 0 || s >= DS_COLS - 1 || j < 0 || j >= DS_ROWS) return false;
  if (j == DS_MAIN_ROW) return true;
  return dsChance(dsH3(k, j, s, DS_SALT_SEGX), DS_SEG_ON);
}
// ...along z in column i, between rows s and s + 1?
bool dsSegZ(int k, int i, int s) {
  if (s < 0 || s >= DS_ROWS - 1 || i < 0 || i >= DS_COLS) return false;
  return dsChance(dsH3(k, i, s, DS_SALT_SEGZ), DS_SEG_ON);
}
// is crossing (i, j) of layer k open (a corridor reaches it)?
bool dsOpen(int k, int i, int j) { return dsSegX(k, j, i - 1) || dsSegX(k, j, i) || dsSegZ(k, i, j - 1) || dsSegZ(k, i, j); }
// the column where layer k's main row drops to the layer below
int dsMainShaft(int k) { return thRange(thHash2(k, 0, DS_SALT_MAIN), DS_SHAFT_COL_LO, DS_SHAFT_COL_HI); }
// is there a shaft from layer k down to layer k - 1 at crossing (i, j)?
bool dsShaft(int k, int i, int j) {
  if (k <= 0 || k >= DS_LAYERS) return false;
  if (j == DS_MAIN_ROW && i == dsMainShaft(k)) return true;
  if (!dsOpen(k, i, j) || !dsOpen(k - 1, i, j)) return false;
  return dsChance(dsH3(k, i, j, DS_SALT_SHAFT), DS_SHAFT_ON);
}
// is there a cavern at crossing (i, j) of layer k?
bool dsHall(int k, int i, int j) { return DS_HALL_ON > 0 && dsOpen(k, i, j) && dsChance(dsH3(k, i, j, DS_SALT_HALL), DS_HALL_ON); }
// the liquid in layer k's sump under the corridor cell at (dx, dz) from crossing (i, j), or -1
int dsSump(int k, int i, int j, int dx, int dz) {
  if (k < 0 || k >= DS_LAYERS) return -1;
  bool inX = abs(dz) < DS_TUN_HALF - 1;
  bool inZ = abs(dx) < DS_TUN_HALF - 1;
  if (inX == inZ) return -1;
  if (inX && j == DS_MAIN_ROW) return -1;
  int s = inX ? (dx < 0 ? i - 1 : i) : (dz < 0 ? j - 1 : j);
  int rel = inX ? (dx < 0 ? dx + DS_GRID : dx) : (dz < 0 ? dz + DS_GRID : dz);
  if (rel < DS_SUMP_A || rel >= DS_GRID - DS_SUMP_A) return -1;
  if (inX && !dsSegX(k, j, s)) return -1;
  if (inZ && !dsSegZ(k, i, s)) return -1;
  uint h = inX ? dsH3(k, j, s, DS_SALT_SEGX) : dsH3(k, i, s, DS_SALT_SEGZ);
  if (!dsChance(thKey(h, DS_K_SUMP), DS_SUMP_ON)) return -1;
  if (DS_LEVEL == 1) return E_TOXIC;
  if (DS_LEVEL == 2) return E_ICE;
  return dsChance(thKey(h, DS_K_OIL), DS_OIL_ON) ? E_OIL : E_WATER;
}

// THE TUNNEL LAYOUT, behind one function: is world cell (x, y, z) open, and
// what fills or lines it (air, a sump's liquid, a tunnel's timber, rubble,
// snow, brick), or -1 for rock. Everything from "the tunnel lattice" above to
// here is the layout (the lattice of corridors, shafts, halls, sumps and their
// features); it is meant to be replaced (Herringbone Wang tiles, Noita's
// technique) without touching the rest: the temple band (dsTemple), the
// surface and mountain (dsMines' way in, dsDeep's roof), the rock (dsRock) and
// the sites. A replacement must keep: the layers' floors at BIOME_Y0 + k·LAYER_H
// (the way in's ramp lands on the top one; the entry shaft opens up into the
// lowest one at ESHAFT_X0, z TZC, so a corridor must pass over it), the main
// row's open path the spawns stand on, and no cell under y BIOME_Y0. sites.js
// (reachable, the loot candidates) reads the lattice through the twin and
// must change with it.
int dsTunnel(int x, int y, int z) {
  // a level with a Wang kit: its tiles instead (dsWang: the scene's glsl / the twin's bake)
  if (DS_WANG == 1) return dsWang(x, y, z);
  int k = thDiv(y - DS_BIOME_Y0, DS_LAYER_H);
  int yl = y - DS_BIOME_Y0 - k * DS_LAYER_H;
  int i = thDiv(x - DS_GRID_OFF + DS_GRID_HALF, DS_GRID);
  int dx = x - DS_GRID_OFF - i * DS_GRID;
  int j = thDiv(z - DS_GRID_OFF + DS_GRID_HALF, DS_GRID);
  int dz = z - DS_GRID_OFF - j * DS_GRID;
  // the layer above's sump, under its floor
  if (yl >= DS_LAYER_H - DS_SUMP_D) {
    int liquid = dsSump(k + 1, i, j, dx, dz);
    if (liquid >= 0) return liquid;
  }
  if (k < 0 || k >= DS_LAYERS) return -1;
  // a shaft from the layer above, down through this one's rock to its floor, a ledge halfway
  bool inShaft = abs(dx) < DS_SHAFT_HALF && abs(dz) < DS_SHAFT_HALF;
  if (inShaft && dsShaft(k + 1, i, j)) return yl == DS_LEDGE_Y && dx < 0 ? E_WOOD : E_EMPTY;
  bool inX = abs(dz) < DS_TUN_HALF;
  bool inZ = abs(dx) < DS_TUN_HALF;
  int sx = dx < 0 ? i - 1 : i;
  int sz = dz < 0 ? j - 1 : j;
  int roof = DS_TUN_H + thRange(dsH3(thDiv(x, DS_BUMP_W), k, thDiv(z, DS_BUMP_W), DS_SALT_BUMP), 0, DS_BUMP_H);
  bool crossing = inX && inZ;
  bool open = false;
  if (crossing) open = dsOpen(k, i, j);
  else if (inX) open = dsSegX(k, j, sx);
  else if (inZ) open = dsSegZ(k, i, sz);
  bool tunnel = open && yl < roof;
  bool hall = DS_HALL_ON > 0 && yl < DS_HALL_H && dx * dx + dz * dz < DS_HALL_R2 && dsHall(k, i, j);
  if (!tunnel && !hall) return -1;
  // nothing stands on the floor over this layer's own shaft down
  bool overShaft = inShaft && dsShaft(k, i, j);
  if (!tunnel || crossing) return yl == 0 && DS_LEVEL == 2 && !overShaft ? E_SNOW : E_EMPTY;
  // a corridor segment: along it (rel from column or row s), across it (side)
  int rel = inX ? (dx < 0 ? dx + DS_GRID : dx) : (dz < 0 ? dz + DS_GRID : dz);
  int side = inX ? dz : dx;
  bool onMain = inX && j == DS_MAIN_ROW;
  uint h = inX ? dsH3(k, j, sx, DS_SALT_SEGX) : dsH3(k, i, sz, DS_SALT_SEGZ);
  bool feature = !onMain && DS_FEATURE_ON > 0 && dsChance(thKey(h, DS_K_FEATURE), DS_FEATURE_ON);
  if (DS_LEVEL == 0) {
    // timber frames: posts at the walls and a lintel, every BEAM cells; a crystal lantern under the middle one
    if (thMod(rel, DS_BEAM) == 0) {
      if (abs(side) == DS_TUN_HALF - 1 || yl == DS_TUN_H - 1) return E_WOOD;
      if (rel == DS_LANTERN_REL && side == 0 && yl == DS_TUN_H - 2) return E_CRYSTAL;
    }
    return E_EMPTY;
  }
  if (DS_LEVEL == 1) {
    // a rubble heap in the segment's middle
    if (feature && yl < DS_RUBBLE_H - thDiv(abs(rel - DS_GRID_HALF), 2)) return E_RUBBLE;
    return E_EMPTY;
  }
  // the Snowy Depths: a ruin (a brick wall across the corridor with a doorway, a
  // brick floor, pillars), else snow on the floor
  if (feature) {
    if (abs(rel - DS_GRID_HALF) <= DS_RUIN_T && (yl == 0 || abs(side) >= DS_DOOR_HALF || yl >= DS_DOOR_H)) return E_BRICK;
    if (yl == 0) return E_BRICK;
    if (abs(side) == DS_TUN_HALF - 1 && thMod(rel, DS_PILLAR) == 0) return E_BRICK;
    return E_EMPTY;
  }
  return yl == 0 ? E_SNOW : E_EMPTY;
}

// The biome's rock at (x, y, z): Mines rock with gold, Coal Pits rock with coal
// seams and pockets, Snowy Depths rock with ice strata and crystal.
int dsRock(int x, int y, int z) {
  bool ore = dsChance(dsH3(thDiv(x, 3), thDiv(y, 3), thDiv(z, 3), DS_SALT_ORE), DS_ORE);
  if (DS_LEVEL == 0) return ore ? E_GOLD : E_ROCK;
  float wob = thNoised(float(x) * DS_SEAM_F, float(z) * DS_SEAM_F, thStream(DS_SALT_SEAM, 0)) * DS_SEAM_A;
  int band = thMod(y + thRound(wob), DS_LAYER_H);
  if (DS_LEVEL == 1) return ore || band < 2 ? E_COAL : E_ROCK;
  if (ore) return E_CRYSTAL;
  return band >= 6 && band < 9 ? E_ICE : E_ROCK;
}

// ---- the Holy Mountain: the band, the temple, its entry shaft. -1 above the band.
int dsTemple(int x, int y, int z) {
  bool shaftCol = x >= DS_ESHAFT_X0 && x < DS_ESHAFT_X0 + DS_ESHAFT_W
    && z >= DS_TZC - thDiv(DS_ESHAFT_W, 2) && z < DS_TZC + thDiv(DS_ESHAFT_W, 2);
  bool westHalf = x < DS_ESHAFT_X0 + thDiv(DS_ESHAFT_W, 2);
  if (shaftCol && y >= DS_TY1 && y < DS_BIOME_Y0) return y == DS_LEDGE_A && westHalf ? E_SANDSTONE : E_EMPTY;
  if (y >= DS_BAND_TOP) return -1;
  if (y < DS_FLOOR) return E_WALL;
  int tz0 = DS_TZC - DS_TZ_HALF;
  int tz1 = DS_TZC + DS_TZ_HALF;
  bool block = x >= DS_TX0 - DS_LINING && x < DS_TX1 + DS_LINING && z >= tz0 - DS_LINING && z < tz1 + DS_LINING
    && y >= DS_PIT_Y0 - DS_LINING && y < DS_TY1 + DS_LINING;
  if (!block) return E_WALL;
  bool inPlan = x >= DS_TX0 && x < DS_TX1 && z >= tz0 && z < tz1;
  int rel = x - DS_TX0;
  if (inPlan && y >= DS_TY0 && y < DS_TY1) {
    if (shaftCol && y == DS_LEDGE_B && !westHalf) return E_SANDSTONE;
    // the landing under the shaft, and the stairs down from it
    if (rel < DS_LAND_W && y < DS_TY0 + DS_LAND_H) return E_SANDSTONE;
    if (rel >= DS_LAND_W && rel < DS_LAND_W + 2 * DS_LAND_H && y < DS_TY0 + DS_LAND_H - 1 - thDiv(rel - DS_LAND_W, 2)) return E_SANDSTONE;
    // the shop's pedestals
    int rp = rel - DS_SHOP_REL0 + 1;
    if (rp >= 0 && thMod(rp, DS_SHOP_STEP) < 2 && thDiv(rp, DS_SHOP_STEP) < DS_SHOP_N
        && z >= DS_TZC - 1 && z < DS_TZC + 1 && y < DS_TY0 + DS_PED_H) return E_BRICK;
    return E_EMPTY;
  }
  // under the floor: the healing pool, and the exit pit
  if (inPlan && y < DS_TY0) {
    if (rel >= DS_POOL_REL0 && rel < DS_POOL_REL1 && z >= tz0 + DS_POOL_INSET && z < tz1 - DS_POOL_INSET && y >= DS_TY0 - DS_POOL_D) return E_WATER;
    if (rel >= DS_PIT_REL0 && y >= DS_PIT_Y0) return E_EMPTY;
  }
  // lights in the ceiling
  if (inPlan && y == DS_TY1 && z == DS_TZC && thMod(rel, DS_LIGHT_STEP) == thDiv(DS_LIGHT_STEP, 2)) return E_CRYSTAL;
  return E_SANDSTONE;
}

// ---- Mines: the surface
float dsHill(int x, int z) { return thNoised(float(x) * DS_HILL_F, float(z) * DS_HILL_F, thStream(DS_SALT_HILL, 0)) * DS_HILL_A; }
// the mountain's rise over the forest floor at column (x, z)
float dsMtn(int x, int z) {
  float ox = float(x) + 0.5 - DS_MTN_XF;
  float oz = float(z) + 0.5 - DS_MTN_ZF;
  float t = max(0.0, 1.0 - thFdiv(sqrt(ox * ox + oz * oz), DS_MTN_R));
  if (t <= 0.0) return 0.0;
  return DS_MTN_H * pow(t, DS_MTN_PROFILE) + thNoised(float(x) * DS_MTN_NF, float(z) * DS_MTN_NF, thStream(DS_SALT_MTN, 0)) * DS_MTN_NA * t;
}
// the top of the rock (the first cell over it) at column (x, z)
int dsTop(int x, int z) { return DS_SURF + thRound(dsHill(x, z) + dsMtn(x, z)); }
// a tree's cell at (x, y, z) (WOOD, PLANT), or -1: one site per TREE_G square, off the mountain
int dsTree(int x, int y, int z) {
  int gx = thDiv(x, DS_TREE_G);
  int gz = thDiv(z, DS_TREE_G);
  uint h = thHash2(gx, gz, DS_SALT_TREE);
  if (!dsChance(h, DS_TREE_ON)) return -1;
  int tx = gx * DS_TREE_G + DS_TREE_G_HALF + thRange(thKey(h, 1), 0 - DS_TREE_JIT, DS_TREE_JIT);
  int tz = gz * DS_TREE_G + DS_TREE_G_HALF + thRange(thKey(h, 2), 0 - DS_TREE_JIT, DS_TREE_JIT);
  int mx = tx - DS_MTN_X;
  int mz = tz - DS_MTN_Z;
  if (mx * mx + mz * mz < DS_TREE_MTN_D * DS_TREE_MTN_D) return -1;
  int base = DS_SURF + thRound(dsHill(tx, tz));
  if (x >= tx && x < tx + 2 && z >= tz && z < tz + 2 && y >= base - 1 && y < base + DS_TRUNK_H) return E_WOOD;
  float cx = float(x - tx) - 0.5;
  float cy = float(y - base - DS_TRUNK_H);
  float cz = float(z - tz) - 0.5;
  if (cx * cx + cy * cy + cz * cz < DS_CROWN_R * DS_CROWN_R) return E_PLANT;
  return -1;
}

// the Wang levels' entry hall (see wangDerived), its lantern hung in the ceiling, or -1
int dsEntryHall(int x, int y, int z) {
  if (x < DS_EHALL_X0 || x >= DS_EHALL_X1 || z < DS_EHALL_Z0 || z >= DS_EHALL_Z1) return -1;
  if (y < DS_WANG_TOP || y > DS_WANG_TOP + DS_TUN_H) return -1;
  bool lamp = z == DS_ENTRY_CZ && (x == DS_EHALL_X0 + DS_EHALL_LIGHT || x == DS_EHALL_X1 - 1 - DS_EHALL_LIGHT);
  if (y == DS_WANG_TOP + DS_TUN_H) return lamp ? E_CRYSTAL : -1;
  return E_EMPTY;
}

int dsMines(int x, int y, int z) {
  // The way in, beside the top layer's main row (z RAMP_Z0 on, a wall between): a cut up
  // the west slope, open to the sky and rising 1 in 2 from the forest floor to the
  // mouth, over a causeway of rock; then a ramp down inside the mountain, 1 in 2, to
  // the top layer's floor, where a doorway opens into the main row. A Wang level's
  // ramp runs along the entry hall's middle instead and levels out on the region's
  // top (RAMP_FLOOR), into the hall.
  if (DS_WANG == 1) {
    int hall = dsEntryHall(x, y, z);
    if (hall >= 0) return hall;
  }
  bool band = z >= DS_RAMP_Z0 && z < DS_RAMP_Z0 + 2 * DS_TUN_HALF - 1;
  if (x >= DS_APPROACH_X0 && x < DS_MOUTH_X && abs(z - DS_RAMP_ZC) < DS_PORCH_HALF) {
    int fl = max(DS_APPROACH_Y0, DS_MOUTH_Y - thDiv(DS_MOUTH_X - 1 - x, 2));
    if (y < fl && y >= fl - DS_PORCH_D) return E_ROCK;
    if (band && y >= fl) return E_EMPTY;
  }
  if (band && x >= DS_MOUTH_X && x < DS_RAMP_X1) {
    int f = max(DS_RAMP_FLOOR, DS_MOUTH_Y - thDiv(x - DS_MOUTH_X, 2));
    if (y >= f && y < f + DS_TUN_H) return E_EMPTY;
  }
  if (DS_WANG == 0 && x >= DS_RAMP_X1 - DS_JOIN_L && x < DS_RAMP_X1 && z >= DS_TZC && z < DS_RAMP_Z0 + 2 * DS_TUN_HALF - 1
      && y >= DS_TOP_FLOOR && y < DS_TOP_FLOOR + DS_TUN_H) return E_EMPTY;
  if (y >= DS_SURF_LO) {
    float mtn = dsMtn(x, z);
    int top = DS_SURF + thRound(dsHill(x, z) + mtn);
    if (y >= top) {
      if (top >= DS_SNOW_LINE && y < top + DS_SNOW_D) return E_SNOW;
      if (y == top && mtn < float(DS_GRASS_MTN)) return E_PLANT;
      if (y < DS_TREE_TOP) {
        int tree = dsTree(x, y, z);
        if (tree >= 0) return tree;
      }
      return E_EMPTY;
    }
  }
  int c = dsTunnel(x, y, z);
  return c >= 0 ? c : dsRock(x, y, z);
}

// ---- Coal Pits, Snowy Depths: under a roof of rock
int dsRoof(int x, int z) { return DS_ROOF + thRound(thNoised(float(x) * DS_ROOF_F, float(z) * DS_ROOF_F, thStream(DS_SALT_ROOF, 0)) * DS_ROOF_A); }
int dsDeep(int x, int y, int z) {
  if (DS_WANG == 1) {
    int hall = dsEntryHall(x, y, z);
    if (hall >= 0) return hall;
  }
  if (y >= DS_ROOF_LO) {
    int top = dsRoof(x, z);
    if (y >= top) return DS_LEVEL == 2 && y < top + DS_SNOW_D ? E_SNOW : E_EMPTY;
  }
  int c = dsTunnel(x, y, z);
  return c >= 0 ? c : dsRock(x, y, z);
}

int dsCell(int x, int y, int z) {
  int t = dsTemple(x, y, z);
  if (t >= 0) return t;
  return DS_LEVEL == 0 ? dsMines(x, y, z) : dsDeep(x, y, z);
}
`;

// ---- the Wang tilings (levels with a kit), one bake per level: CPU, ~150 ms,
// pure in the kit and the fixed seed, so levels.js's sites stay put
const bakes = new Map();
export function descentWang(level) {
  const def = DS_LEVEL_DEFS[level];
  if (!def.kit) return null;
  if (!bakes.has(level)) {
    const C = descentConstants(level), { U, H } = GEOM;
    const W = bakeWang({
      kit: def.kit, seed: (DS_SEED + level * SALT_LEVEL_STEP) >>> 0,
      size: [C.WANG_NX * U, C.WANG_LAYERS * H, C.WANG_NZ * U], origin: [C.WANG_X0, C.WANG_Y0, C.WANG_Z0],
      entry: [C.ENTRY_I, C.ENTRY_K], exit: [C.WANG_EXIT_I, C.WANG_EXIT_K],
    });
    // the tiling may move the entry or exit to the nearest whole brick: the hall and the temple must not move
    const want = { entry: [C.ENTRY_CX, C.WANG_TOP, C.ENTRY_CZ], exit: [C.ESHAFT_X0 + C.ESHAFT_W / 2, C.WANG_Y0, C.TZC] };
    for (const k of ['entry', 'exit']) {
      if (W[k].join() !== want[k].join()) throw new Error(`descent ${def.key}: the Wang ${k} is at ${W[k]}, not ${want[k]} (pick another ENTRY_I/K or seed)`);
    }
    bakes.set(level, W);
  }
  return bakes.get(level);
}
// dsWang's JS twin: the element a Wang level's tile puts at a cell, -1 for its rock or outside it
const dsWangJS = (W) => (W
  ? (x, y, z) => { const c = W.wangCellJS(x, y, z); return c === WANG_OUT || c === MAT.ROCK ? -1 : W.elementJS(c); }
  : () => -1);
// ...and on the GPU (after wangGLSL(kit))
const dsWangGLSL = (kit) => (kit ? /* glsl */ `
${wangGLSL(kit)}
int dsWang(int x, int y, int z) {
  int c = wangCell(ivec3(x, y, z));
  return c == WANG_OUT || c == WANG_ROCK ? -1 : wangElement(c);
}
// the temperature the kit lays the cell at w down at (its temps: burning coal, a lake's water), if
// the cell is the tile's (id is what dsCell made of it); else T
float dsWangT(ivec3 w, int id, float T) {
  int c = wangCell(w);
  if (c == WANG_OUT || c == WANG_ROCK || wangElement(c) != id) return T;
  float t = wangTemp(c);
  return t > WANG_NO_TEMP ? t : T;
}` : `int dsWang(int x, int y, int z) { return -1; }
float dsWangT(ivec3 w, int id, float T) { return T; }`);

// ---- the JS twins, one per level
const twins = new Map();
export function descentTwin(level) {
  if (!twins.has(level)) {
    const t = compileShared(SRC, DS_SEED, { ...jsConstants(PREFIX, tables(level)), dsWang: dsWangJS(descentWang(level)) });
    twins.set(level, t);
  }
  return twins.get(level);
}
// a level's constants, by name without the prefix (scripts/check-descent-levels.mjs, levels.js's sites)
export function descentConstants(level) {
  const t = tables(level);
  return { ...t.ints, ...t.floats };
}

const glsl = (level) => () => /* glsl */ `
${definesGLSL(PREFIX, tables(level))}
${helpersGLSL}
${dsWangGLSL(DS_LEVEL_DEFS[level].kit)}
${SRC}
void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  int id = dsCell(w.x, w.y, w.z);
  float T = SPAWNT[id];
  if (DS_LEVEL == 2) T = min(T, DS_COLD_T);   // the Snowy Depths are frozen through
  if (dsTemple(w.x, w.y, w.z) < 0) T = dsWangT(w, id, T);   // ...but for what a kit lays down warm (or burning)
  float seed = float(seedWorld(w, uSceneSeed, DS_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), T, SPAWNLIFE[id], seed);
  B = vec4(0.0);
}
`;

// the god view: from the west (the mouth's side), over the spawn
const VIEW_DIR = [-11, 7, 6];
const VIEW_DIST = 150;            // cells from the orbit target
const VIEW_LIFT = 0;
// how far over a column's rock ground() starts looking down: snow, a tree's crown
const GROUND_OVER = COMMON.SNOW_D + COMMON.TRUNK_H + Math.ceil(COMMON_F.CROWN_R) + 2;

function makeScene(level) {
  const def = DS_LEVEL_DEFS[level];
  const C = descentConstants(level);
  let spawn = null;   // levels.js's, set by setDescentSpawns (no import cycle: levels.js is plain data)
  return {
    key: def.key,
    label: def.label,
    size: DS_WORLD,
    descentLevel: level,
    shrine: false,     // app.js worldShrine: the temple's altar is its shrine
    view: { dir: VIEW_DIR, dist: VIEW_DIST, lift: VIEW_LIFT },
    params: ({ size, seed }) => ({ size, seed: seed >>> 0, sea: 0, floor: COMMON.FLOOR }),
    glsl: glsl(level),
    // a Wang level: the bake is CPU work, done here or on the first uniforms() (descentWang)
    prepare: async () => { descentWang(level); },
    uniforms: () => ({ uSceneSeed: { value: DS_SEED }, ...(def.kit ? descentWang(level).uniforms() : {}) }),
    dispose: () => { if (def.kit) descentWang(level).dispose(); },
    start: () => (spawn ? [spawn[0], spawn[2]] : [COMMON.TX0, COMMON.TZC]),
    setSpawn(s) { spawn = s; },
    ground(x, z) {
      const T = descentTwin(level);
      const xi = Math.floor(x), zi = Math.floor(z);
      const top = level === 0 ? T.dsTop(xi, zi) : T.dsRoof(xi, zi);
      return groundScan(T.dsCell, xi, zi, Math.min(C.WY, top + GROUND_OVER));
    },
  };
}

export const descentMines = makeScene(0);
export const descentCoal = makeScene(1);
export const descentSnow = makeScene(2);
export const DESCENT_SCENES = [descentMines, descentCoal, descentSnow];
export const DS_ELEMENTS = E;   // (the checks read element ids through here)
