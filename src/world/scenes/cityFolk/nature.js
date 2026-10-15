// Original voxel silhouettes: Minecraft's supported trunks/crowns, with
// Animal Crossing's distinct cedar, native apple orchard and beach palm zones.
// Island-local coordinates. Compose only in expanded worlds, before town.
// Requires cfHeight, cfTerrainCell (bare terrain, NOT the composed scene),
// cfPath and cfTownReserved. No seed-dependent landmark positions.
const neighborhood = Object.freeze({
  trees: [
    { at: [-640, -112], floor: 48, kind: 'cedar', radius: 7 },
    ...[[-584, 70], [-720, 70], [-360, 72], [-460, -12], [-216, 72], [216, 12]]
      .map(at => ({ at, floor: 24, kind: 'hardwood', radius: 9 })),
  ],
  rocks: [
    ...[[-440, 88], [-630, 90], [-350, -14], [-222, 52], [256, 56]]
      .map(at => ({ at, floor: 24, kind: 'rock', radius: 3 })),
    { at: [-610, -62], floor: 36, kind: 'rock', radius: 3 },
  ],
});

export const CITY_FOLK_NATURE = Object.freeze({
  neighborhood,
  ints: {
    PITCH: 32, OFFSET: 16, TOP: 30,
    CEDAR_WEST: -800, CEDAR_EAST: 800, CEDAR_NORTH: -136, CEDAR_SOUTH: -60,
    GROVE_WEST: 240, GROVE_EAST: 848, GROVE_NORTH: 64, GROVE_SOUTH: 116,
    ORCHARD_WEST: 560, ORCHARD_EAST: 752,
    PALM_WEST: -848, PALM_EAST: 848, PALM_NORTH: 144, PALM_SOUTH: 164,
  },
  salts: { PATCH: 0x6e6174 },
  landmarks: Object.freeze({
    cedarWoods: { at: [-464, -112], floor: 48, kind: 'cedar', half: [40, 7] },
    hardwoodGrove: { at: [304, 80], floor: 24, kind: 'hardwood', half: [80, 9] },
    nativeOrchard: { at: [624, 80], floor: 24, kind: 'apple', half: [40, 9] },
    beachPalms: { at: [816, 152], floor: 18, kind: 'palm', half: [40, 7] },
    flowerPatch: { at: [400, 120], floor: 24, kind: 'flowers', half: [10, 6] },
    rocks: { at: [464, 120], floor: 24, kind: 'rock', half: [3, 2] },
    shells: { at: [304, 156], floor: 18, kind: 'shell', half: [2, 2] },
    discovery: { at: [432, 120], floor: 24, kind: 'buried-fossil', half: [3, 3] },
    wornGround: { at: [416, 44], floor: 24, kind: 'wear', half: [40, 2] },
    openMeadow: { at: [200, 92], floor: 24, kind: 'meadow', half: [24, 20] },
  }),
  src: /* glsl */ `
bool cfNatureClear(int x, int z) {
  return !cfPath(x, z) && !cfTownReserved(x, z);
}

// Validate the complete trunk footprint, then nine dry, level samples.
// Woods use the crown radius; beach palms need only a small dry root pad,
// allowing fronds to overhang the narrow beach without filling sea water.
// Only called after a candidate exists: no full-scene scans per cell.
bool cfNatureRoot(int x, int z, int h, int radius, bool beach) {
  if (h < 18 || h > 80) return false;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dx = -1; dx <= 1; dx++) {
      int px = x + dx, pz = z + dz;
      if (!cfNatureClear(px, pz) || cfHeight(px, pz) != h) return false;
      int ground = cfTerrainCell(px, h - 1, pz);
      if (beach) {
        if (ground != E_SAND) return false;
      } else {
        if (ground != E_PLANT) return false;
      }
      if (cfTerrainCell(px, h, pz) != E_EMPTY) return false;
    }
  }
  for (int dz = -1; dz <= 1; dz++) {
    for (int dx = -1; dx <= 1; dx++) {
      int px = x + dx * radius, pz = z + dz * radius;
      if (!cfNatureClear(px, pz) || cfHeight(px, pz) != h) return false;
      int ground = cfTerrainCell(px, h - 1, pz);
      if (beach) {
        if (ground != E_SAND) return false;
      } else {
        if (ground != E_PLANT) return false;
      }
      if (cfTerrainCell(px, h, pz) != E_EMPTY) return false;
    }
  }
  return true;
}

int cfNatureTreeMaterial(int x, int y, int z, int h) {
  int ax = thDiv(x, NATURE_PITCH) * NATURE_PITCH + NATURE_OFFSET;
  int az = thDiv(z, NATURE_PITCH) * NATURE_PITCH + NATURE_OFFSET;
  int kind = 0;
  if (ax >= NATURE_CEDAR_WEST && ax <= NATURE_CEDAR_EAST && abs(ax) >= 288 && az >= NATURE_CEDAR_NORTH && az <= NATURE_CEDAR_SOUTH && h >= 36) kind = 1;
  // Mid-terrace cedars line the eastern woods branch; the upper lattice
  // remains intact. The route itself and all crown samples stay excluded.
  if (ax >= 400 && ax <= 720 && z >= -71 && z <= -57 && h >= 36) {
    az = -64;
    kind = 1;
  }
  if (ax >= NATURE_GROVE_WEST && ax <= NATURE_GROVE_EAST && az >= NATURE_GROVE_NORTH && az <= NATURE_GROVE_SOUTH) {
    // Gaps between groves remain usable meadow, not a wall of trees.
    if (thMod(ax - NATURE_OFFSET, 128) != 64) kind = 2;
    if (ax >= NATURE_ORCHARD_WEST && ax <= NATURE_ORCHARD_EAST) kind = 3;
  }
  // The beach uses its own z center rather than the woodland lattice.
  if (z >= NATURE_PALM_NORTH && z <= NATURE_PALM_SOUTH && ax >= NATURE_PALM_WEST && ax <= NATURE_PALM_EAST && abs(ax) >= 256 && (thMod(ax - NATURE_OFFSET, 96) == 32 || abs(ax) >= 800)) {
    az = 152;
    kind = 4;
  }
  // Sparse authored shade beside inhabited lots, reusing the supported
  // Minecraft silhouettes. No lattice across the open meadows/core.
${neighborhood.trees.map(({ at: [x, z], radius, kind }) => `  if (abs(x - (${x})) <= ${radius} && abs(z - (${z})) <= ${radius}) { ax = ${x}; az = ${z}; kind = ${kind === 'cedar' ? 1 : 2}; }`).join('\n')}
  if (kind == 0) return E_EMPTY;
  int dx = x - ax, dz = z - az;
  int radius = kind == 4 ? 10 : kind == 1 ? 7 : 9;
  if (abs(dx) > radius || abs(dz) > radius) return E_EMPTY;
  int root = cfHeight(ax, az), dy = y - root;
  if (dy < 0 || dy > NATURE_TOP || (kind != 4 && root != h)) return E_EMPTY;
  int cell = E_EMPTY;
  if (kind == 1) {
    if (abs(dx) <= 1 && abs(dz) <= 1 && dy <= 26) cell = materialWord(E_WOOD, AP_LOG_Y);
    int tier = dy < 13 ? 7 - thDiv(max(dy - 7, 0), 2) : dy < 20 ? 5 - thDiv(dy - 13, 2) : 3 - thDiv(dy - 20, 2);
    if (materialId(cell) == E_EMPTY && dy >= 7 && dy <= 27 && max(abs(dx), abs(dz)) <= tier && abs(dx) + abs(dz) <= tier + 2) cell = materialWord(E_MOSS, AP_LEAVES);
  } else if (kind == 4) {
    int lean = thDiv(dy, 6);
    if (abs(dx - lean) <= 1 && abs(dz) <= 1 && dy <= 20) cell = materialWord(E_WOOD, AP_BARK);
    int fx = dx - 3, reach = max(abs(fx), abs(dz));
    int frond = 20 - thDiv(reach, 4);
    if (materialId(cell) == E_EMPTY && reach <= 7 && (abs(fx) <= 1 || abs(dz) <= 1 || abs(abs(fx) - abs(dz)) <= 1) && dy >= frond - 1 && dy <= frond) cell = materialWord(E_PLANT, AP_LEAVES);
    if (materialId(cell) == E_EMPTY && dy == 17 && abs(dx - 3) <= 2 && abs(dz) <= 2) cell = E_SANDSTONE;
  } else {
    if (abs(dx) <= 1 && abs(dz) <= 1 && dy <= 17) cell = materialWord(E_WOOD, AP_LOG_Y);
    int cy = dy - 16;
    bool crown = dx * dx + dz * dz + 2 * cy * cy <= 81;
    // Red apple clusters attach to the crown, not loose powder/inventory.
    if (materialId(cell) == E_EMPTY && kind == 3 && dy >= 12 && dy <= 14 && ((abs(dx - 6) <= 1 && abs(dz) <= 1) || (abs(dx + 4) <= 1 && abs(dz - 4) <= 1))) cell = E_BRICK;
    if (materialId(cell) == E_EMPTY && crown) cell = materialWord(E_PLANT, AP_LEAVES);
  }
  if (materialId(cell) == E_EMPTY) return E_EMPTY;
  if (!cfNatureRoot(ax, az, root, kind == 4 ? 2 : radius, kind == 4)) return E_EMPTY;
  return cell;
}
int cfNatureTree(int x, int y, int z, int h) { return materialId(cfNatureTreeMaterial(x, y, z, h)); }

int cfNatureCellMaterial(int x, int y, int z, int h, int id) {
  if (y < h - 3 || y > h + NATURE_TOP || !cfNatureClear(x, z)) return id;
  // Preserve all authored matter, including cottage roofs and bridge timbers.
  if (materialId(id) != E_EMPTY && !(y == h - 1 && materialId(id) == E_PLANT) && !(y == h - 2 && materialId(id) == E_ROCK)) return id;
  // Original cottages and the complete old village stay untouched even when
  // composed into the expanded map. Legacy-size worlds must skip this module.
  if (abs(x) < 192 || abs(x) > 920) return id;
  // Above the low scenery, reject empty silhouette cells before sampling any
  // terrain. Most streamed air therefore never calls the terrain twin again.
  if (y > h + 2) return materialId(id) == E_EMPTY ? cfNatureTreeMaterial(x, y, z, h) : id;
  int ground = cfTerrainCell(x, h - 1, z);
  bool grass = ground == E_PLANT && cfTerrainCell(x, h, z) == E_EMPTY;
  bool sand = ground == E_SAND && cfTerrainCell(x, h, z) == E_EMPTY;
  if (!grass && !sand) return id;
  // Low stones occupy only validated dry grass pads; never add an unstable
  // overhang beside water or a partial stone across a reserved walkway.
${neighborhood.rocks.map(({ at: [x, z], radius }) => `  if (grass && y >= h && y <= h + 2 && abs(x - (${x})) <= ${radius} && abs(z - (${z})) <= ${radius}) {
    int dx = x - (${x}), dz = z - (${z}), dy = y - h;
    if (dx * dx + dz * dz + 2 * dy * dy <= 10 && cfNatureRoot(${x}, ${z}, h, ${radius}, false)) return E_ROCK;
  }`).join('\n')}
  // Static dirt shoulders beside the two busy sprint routes; never the lane.
  if (grass && y == h - 1 && abs(x) <= 896 && (abs(z - 36) <= 10 || abs(z + 28) <= 10)) {
    int wear = thShare(thHash2(thDiv(x, 4), thDiv(z, 2), NATURE_SALT_PATCH));
    if (abs(z - 36) <= 8 || abs(z + 28) <= 8 || wear < 46000) return E_SANDSTONE;
  }
  // Foot traffic feathers out beyond civic/cottage walkways. The reserved
  // surface itself is never changed. Sandstone is the existing stable brown
  // ground material (loose sand/clay would slump or react when streamed).
  if (grass && y == h - 1 && thMod(x + z, 3) != 0 && (cfTownReserved(x - 3, z) || cfTownReserved(x + 3, z) || cfTownReserved(x, z - 3) || cfTownReserved(x, z + 3))) return E_SANDSTONE;
  // Small repeated clearings between trees: flowers, a low stone and a
  // star-shaped dig mark with a pale fossil two cells below the surface.
  int px = thMod(x - 400 + 64, 128) - 64;
  int pz = z - 120;
  if (grass && x >= 240 && x <= 848 && abs(pz) <= 6) {
    if (abs(px) <= 10 && abs(pz) <= 5) {
      int fx = thMod(px + 2, 5) - 2, fz = thMod(pz + 2, 5) - 2;
      if (y == h && fx == 0 && fz == 0) return materialWord(E_PLANT, AP_PLAIN);
      if (y == h + 1 && abs(fx) + abs(fz) <= 1) return thMod(thDiv(x, 5), 2) == 0 ? E_CERAMIC : E_BRICK;
    }
    int rx = abs(px) - 64;
    if (abs(rx) <= 3 && abs(pz) <= 2 && y >= h && y <= h + 2 && rx * rx + pz * pz + 2 * (y - h) * (y - h) <= 10) return E_ROCK;
    int bx = px - 32;
    if (abs(bx) <= 3 && abs(pz) <= 3) {
      if (y == h - 1 && (bx == pz || bx == -pz)) return E_SANDSTONE;
      if (y == h - 2 && (bx * bx + pz * pz <= 5)) return E_LIMESTONE;
    }
  }
  if (sand && y >= h && y <= h + 1 && z >= 148 && z <= 162 && abs(x) >= 256 && abs(x) <= 848) {
    int sx = thMod(x - 496 + 24, 48) - 24, sz = z - 156;
    // Scalloped ivory half-shells, seated directly on the dry sand.
    if (abs(sx) <= 2 && sz >= -2 && sz <= 1 && sx * sx + sz * sz <= 5 && (y == h || (sz == 0 && abs(sx) <= 1))) return E_CERAMIC;
  }
  if (materialId(id) != E_EMPTY) return id;
  int tree = cfNatureTreeMaterial(x, y, z, h);
  return materialId(tree) == E_EMPTY ? id : tree;
}
int cfNatureCell(int x, int y, int z, int h, int id) { return materialId(cfNatureCellMaterial(x, y, z, h, id)); }
`,
});
