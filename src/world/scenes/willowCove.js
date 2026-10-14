import { helpersGLSL, definesGLSL, definesTypes, jsConstants, compileShared, groundScan, memoTwin } from './themedShared.js';
import { toWgsl } from './subsetWgsl.js';
import { sceneStruct, sceneHeadWGSL } from './sceneGpu.js';
import { CITY_FOLK_TERRAIN } from './cityFolk/terrain.js';

export { CITY_FOLK_TERRAIN } from './cityFolk/terrain.js';

// Animal Crossing's village/terraces, with Minecraft's one-cell stairs.
// Fixed topology; the seed changes only material grain. All scenery is matter,
// shared by streaming, diffs, the far field and the CPU twin, not overlays.
// ponytail: finite pond/falls; add a typed spring source when they must persist.
const L = {
  ints: {
    FLOOR: 4, SEA: 16, BEACH: 18, LOW: 24, MID: 36, HIGH: 48, SKY: 80,
    RADIUS: 176, SHORE: 165, BEACH_IN: 148, GRASS_IN: 140,
    LEGACY_WORLD_X: 1024,
    LAND_STRETCH_X: 7, RUN_HALF: 920, RUN_RETURN_Z: -28,
    MID_Z: -48, HIGH_Z: -104, TERRACE_STEP: 12,
    PATH_X: -64, PATH_HALF: 6, PATH_NORTH: -116, PATH_SOUTH: 156,
    LANE_Z: 36, LANE_WEST: -110, LANE_EAST: 128,
    MID_PATH_Z: -72, MID_PATH_WEST: -104, MID_PATH_EAST: 104,
    HIGH_PATH_EAST: 16, BEACH_STAIR_Z: 123,
    PLAZA_X: -28, PLAZA_Z: 12, PLAZA_HALF_X: 28, PLAZA_HALF_Z: 20,
    RIVER_X: 36, RIVER_HALF: 7, BANK_HALF: 12, RIVER_START: -124,
    MOUTH_Z: 132, WATER_DEPTH: 4, FREEBOARD: 4, FALL_DEPTH: 2,
    POND_Z: -124, POND_RADIUS: 14, POND_BANK: 18, POND_DEPTH: 5,
    BRIDGE_HALF: 14, BRIDGE_PILE_X: 12, BRIDGE_RAIL_H: 3,
    DECK_THICK: 2, PILE_HALF: 1,
    COTTAGE_A: -96, COTTAGE_B: -40, COTTAGE_C: 64, COTTAGE_D: 112,
    COTTAGE_Z: 60, HOUSE_HALF: 12, WALL_THICK: 2, WALL_H: 14,
    ROOF_H: 8, ROOF_OVER: 2, DOOR_HALF: 4, DOOR_H: 11,
    WINDOW_HALF: 5, WINDOW_LO: 4, WINDOW_HI: 9,
    ORCHARD_X: -136, ORCHARD_Z: -24, WOODS_X: 80, WOODS_Z: -96,
    GROVE_WIDTH: 48, TREE_PITCH: 24, TREE_TRUNK_HALF: 2,
    TREE_TRUNK_H: 13, TREE_CROWN_Y: 14, TREE_RADIUS: 8,
    DOCK_HALF: 8, DOCK_START: 156, DOCK_END: 196,
    DOCK_PILE_Z: 168, DOCK_PITCH: 16,
  },
  salts: { CELL: 0x5c071e },
};

export const WILLOW_SIZE = [3072, 128, 1024];
// Landmark coordinates are island-local [x,z]; add half the world dimensions.
export const WILLOW_COVE = Object.freeze(L.ints);
export const WILLOW_LANDMARKS = Object.freeze({
  plaza: [L.ints.PLAZA_X, L.ints.PLAZA_Z],
  pond: [L.ints.RIVER_X, L.ints.POND_Z],
  pondLookout: [L.ints.HIGH_PATH_EAST, L.ints.PATH_NORTH],
  lowerStairs: [L.ints.PATH_X, L.ints.MID_Z],
  upperStairs: [L.ints.PATH_X, L.ints.HIGH_Z],
  bridges: [[L.ints.RIVER_X, L.ints.LANE_Z], [L.ints.RIVER_X, L.ints.MID_PATH_Z], [L.ints.RIVER_X, L.ints.RUN_RETURN_Z]],
  runningLoop: [
    [-L.ints.RUN_HALF, L.ints.LANE_Z], [L.ints.RUN_HALF, L.ints.LANE_Z],
    [L.ints.RUN_HALF, L.ints.RUN_RETURN_Z], [-L.ints.RUN_HALF, L.ints.RUN_RETURN_Z],
    [-L.ints.RUN_HALF, L.ints.LANE_Z],
  ],
  orchard: [-88, 0], woods: [80, L.ints.MID_PATH_Z],
  beach: [L.ints.PATH_X, 150], dock: [L.ints.PATH_X, 188],
  cottages: [L.ints.COTTAGE_A, L.ints.COTTAGE_B, L.ints.COTTAGE_C, L.ints.COTTAGE_D]
    .map((x) => [x, L.ints.COTTAGE_Z]),
});

const SRC = /* glsl */ `
bool wcExpanded() { return uWillowWorldX > WC_LEGACY_WORLD_X; }

${CITY_FOLK_TERRAIN.shapeSrc}

int wcRadius(int x, int z) {
  if (wcExpanded() && abs(x) >= 200) return cfRadius(x, z);
  // Stretch the terrain, not Animal Crossing's cottages, trees or river.
  int ax = thDiv(abs(x), wcExpanded() ? WC_LAND_STRETCH_X : 1);
  return max(max(ax, abs(z)), thDiv(3 * (ax + abs(z)), 4));
}

// Rock-backed octagonal shore; dry sand is a single supported layer bounded
// by a rock lip at the same height, so it cannot topple into the sea.
int wcBaseHeight(int x, int z) {
  int r = wcRadius(x, z);
  if (r > WC_RADIUS) return WC_FLOOR;
  if (r >= WC_SHORE) return max(WC_FLOOR, WC_BEACH - (r - WC_SHORE));
  if (r >= WC_BEACH_IN) return WC_BEACH;
  int h = WC_LOW;
  if (r < WC_GRASS_IN && z < WC_MID_Z) h = WC_MID;
  if (r < WC_GRASS_IN && z < WC_HIGH_Z) h = WC_HIGH;
  if (abs(x - WC_PATH_X) < WC_PATH_HALF) {
    if (z >= WC_MID_Z && z <= WC_MID_Z + WC_TERRACE_STEP)
      h = WC_LOW + clamp(WC_MID_Z + WC_TERRACE_STEP - z, 0, WC_TERRACE_STEP);
    if (z >= WC_HIGH_Z && z <= WC_HIGH_Z + WC_TERRACE_STEP)
      h = WC_MID + clamp(WC_HIGH_Z + WC_TERRACE_STEP - z, 0, WC_TERRACE_STEP);
    if (z > WC_BEACH_STAIR_Z) h = max(WC_BEACH, WC_LOW - (z - WC_BEACH_STAIR_Z));
  }
  return h;
}

bool wcPath(int x, int z) {
  if (wcExpanded()) {
    if (abs(x) <= WC_RUN_HALF && (abs(z - WC_LANE_Z) < WC_PATH_HALF || abs(z - WC_RUN_RETURN_Z) < WC_PATH_HALF)) return true;
    if (abs(abs(x) - WC_RUN_HALF) < WC_PATH_HALF && z >= WC_RUN_RETURN_Z && z <= WC_LANE_Z) return true;
  }
  if (abs(x - WC_PATH_X) < WC_PATH_HALF && z >= WC_PATH_NORTH - WC_PATH_HALF && z < WC_PATH_SOUTH) return true;
  if (abs(z - WC_LANE_Z) < WC_PATH_HALF && x >= WC_LANE_WEST && x <= WC_LANE_EAST) return true;
  if (abs(z - WC_MID_PATH_Z) < WC_PATH_HALF && x >= WC_MID_PATH_WEST && x <= WC_MID_PATH_EAST) return true;
  if (abs(z - WC_PATH_NORTH) < WC_PATH_HALF && x >= WC_PATH_X && x <= WC_HIGH_PATH_EAST) return true;
  if (abs(z - WC_PLAZA_Z) < WC_PATH_HALF && x >= WC_PATH_X && x <= WC_PLAZA_X) return true;
  if (z >= -WC_PATH_HALF && z <= WC_PATH_HALF && x >= WC_ORCHARD_X + WC_GROVE_WIDTH && x <= WC_PATH_X) return true;
  return abs(x - WC_PLAZA_X) <= WC_PLAZA_HALF_X && abs(z - WC_PLAZA_Z) <= WC_PLAZA_HALF_Z;
}

${CITY_FOLK_TERRAIN.src}

int wcHeight(int x, int z) { return cfHeight(x, z); }

int wcHouseX(int x) {
  if (x < WC_PLAZA_X - WC_PLAZA_HALF_X) return WC_COTTAGE_A;
  if (x < WC_RIVER_X) return WC_COTTAGE_B;
  if (x < thDiv(WC_COTTAGE_C + WC_COTTAGE_D, 2)) return WC_COTTAGE_C;
  return WC_COTTAGE_D;
}

// Hollow timber shells, brick pitched roofs, glazed windows, 8x11 doors.
// Returns EMPTY both outside and inside; only callers above the ground use it.
int wcHouse(int x, int y, int z) {
  int a = x - wcHouseX(x), b = z - WC_COTTAGE_Z;
  if (abs(a) > WC_HOUSE_HALF + WC_ROOF_OVER || abs(b) > WC_HOUSE_HALF + WC_ROOF_OVER) return E_EMPTY;
  int roof = WC_LOW + WC_WALL_H + max(0, WC_ROOF_H - thDiv(abs(a), 2));
  if (y >= roof - WC_ROOF_OVER && y < roof) return E_BRICK;
  if (a < -WC_HOUSE_HALF || a >= WC_HOUSE_HALF || b < -WC_HOUSE_HALF || b >= WC_HOUSE_HALF || y >= roof) return E_EMPTY;
  bool front = b < -WC_HOUSE_HALF + WC_WALL_THICK;
  if (front && a >= -WC_DOOR_HALF && a < WC_DOOR_HALF && y < WC_LOW + WC_DOOR_H) return E_EMPTY;
  bool side = a < -WC_HOUSE_HALF + WC_WALL_THICK || a >= WC_HOUSE_HALF - WC_WALL_THICK;
  bool back = b >= WC_HOUSE_HALF - WC_WALL_THICK;
  if (!front && !back && !side) return E_EMPTY;
  if (y >= WC_LOW + WC_WINDOW_LO && y < WC_LOW + WC_WINDOW_HI &&
      ((side && abs(b) < WC_WINDOW_HALF) || (back && abs(a) < WC_WINDOW_HALF))) return E_GLASS;
  return E_WOOD;
}

int wcTree(int x, int y, int z) {
  bool orchard = x >= WC_ORCHARD_X && x < WC_ORCHARD_X + WC_GROVE_WIDTH && z >= WC_ORCHARD_Z && z < WC_ORCHARD_Z + WC_GROVE_WIDTH;
  bool woods = x >= WC_WOODS_X && x < WC_WOODS_X + WC_GROVE_WIDTH && z >= WC_WOODS_Z && z < WC_WOODS_Z + WC_GROVE_WIDTH;
  if (!orchard && !woods) return E_EMPTY;
  int ox = orchard ? WC_ORCHARD_X : WC_WOODS_X;
  int oz = orchard ? WC_ORCHARD_Z : WC_WOODS_Z;
  int cx = ox + thDiv(x - ox, WC_TREE_PITCH) * WC_TREE_PITCH + thDiv(WC_TREE_PITCH, 2);
  int cz = oz + thDiv(z - oz, WC_TREE_PITCH) * WC_TREE_PITCH + thDiv(WC_TREE_PITCH, 2);
  int h = wcHeight(cx, cz);
  if (h != (orchard ? WC_LOW : WC_MID)) return E_EMPTY;
  int a = x - cx, b = z - cz, c = y - h;
  if (abs(a) < WC_TREE_TRUNK_HALF && abs(b) < WC_TREE_TRUNK_HALF && c < WC_TREE_TRUNK_H) return E_WOOD;
  int cy = c - WC_TREE_CROWN_Y;
  if (a * a + b * b + cy * cy < WC_TREE_RADIUS * WC_TREE_RADIUS) return E_PLANT;
  return E_EMPTY;
}

int wcBaseCell(int wx, int y, int wz) {
  if (wx < 0 || wz < 0 || y < 0 || wx >= uWillowWorldX || wz >= uWillowWorldZ || y >= uWillowWorldY) return E_EMPTY;
  if (y < WC_FLOOR) return E_ROCK;
  if (y >= WC_SKY) return E_EMPTY;
  int x = wx - thDiv(uWillowWorldX, 2), z = wz - thDiv(uWillowWorldZ, 2);
  if (cfOuter(x)) return cfOuterCell(x, y, z);
  int r = wcRadius(x, z);
  if (r > WC_RADIUS && !(abs(x - WC_PATH_X) <= WC_DOCK_HALF && z >= WC_DOCK_START && z < WC_DOCK_END))
    return y < WC_SEA ? E_WATER : E_EMPTY;
  int h = wcHeight(x, z);

  // Bank-anchored timber bridges, including the running circuit's return.
  bool upperBridge = z < 0 && (!wcExpanded() || z < WC_MID_Z);
  int bz = upperBridge ? WC_MID_PATH_Z : z < 0 ? WC_RUN_RETURN_Z : WC_LANE_Z;
  int bh = upperBridge ? WC_MID : WC_LOW;
  if (abs(z - bz) < WC_PATH_HALF && abs(x - WC_RIVER_X) <= WC_BRIDGE_HALF) {
    if (y >= bh - WC_DECK_THICK && y < bh) return E_WOOD;
    if (abs(z - bz) == WC_PATH_HALF - 1 && y >= bh && y < bh + WC_BRIDGE_RAIL_H) return E_WOOD;
    if (abs(abs(x - WC_RIVER_X) - WC_BRIDGE_PILE_X) <= WC_PILE_HALF && abs(z - bz) >= WC_PATH_HALF - 2 && y >= WC_SEA && y < bh) return E_WOOD;
  }
  if (abs(x - WC_PATH_X) <= WC_DOCK_HALF && z >= WC_DOCK_START && z < WC_DOCK_END) {
    if (y >= WC_BEACH - WC_DECK_THICK && y < WC_BEACH) return E_WOOD;
    if (abs(x - WC_PATH_X) == WC_DOCK_HALF - 2 && thMod(z - WC_DOCK_PILE_Z, WC_DOCK_PITCH) < WC_DECK_THICK && y < WC_BEACH) return E_WOOD;
  }

  int dx = x - WC_RIVER_X, dz = z - WC_POND_Z;
  int fallBank = 0;
  if (z >= WC_HIGH_Z && z < WC_HIGH_Z + WC_FALL_DEPTH) fallBank = WC_HIGH;
  if (z >= WC_MID_Z && z < WC_MID_Z + WC_FALL_DEPTH) fallBank = WC_MID;
  if (z >= WC_MOUTH_Z && z < WC_MOUTH_Z + WC_FALL_DEPTH) fallBank = WC_LOW;
  if (abs(dx) >= WC_RIVER_HALF && abs(dx) <= WC_BANK_HALF && y < fallBank) return E_ROCK;
  bool pond = dx * dx + dz * dz < WC_POND_RADIUS * WC_POND_RADIUS;
  bool river = abs(dx) < WC_RIVER_HALF && z >= WC_RIVER_START && z <= WC_RADIUS;
  if (pond || river) {
    int water = z < WC_HIGH_Z ? WC_HIGH - WC_FREEBOARD : z < WC_MID_Z ? WC_MID - WC_FREEBOARD : z < WC_MOUTH_Z ? WC_LOW - WC_FREEBOARD : WC_SEA;
    int bed = water - (pond ? WC_POND_DEPTH : WC_WATER_DEPTH);
    if (y < bed) return E_ROCK;
    // Initial sheets connect each pool to the downstream reach; they drain.
    if (z >= WC_HIGH_Z && z < WC_HIGH_Z + WC_FALL_DEPTH) water = WC_HIGH - WC_FREEBOARD;
    if (z >= WC_MID_Z && z < WC_MID_Z + WC_FALL_DEPTH) water = WC_MID - WC_FREEBOARD;
    if (z >= WC_MOUTH_Z && z < WC_MOUTH_Z + WC_FALL_DEPTH) water = WC_LOW - WC_FREEBOARD;
    return y < water ? E_WATER : E_EMPTY;
  }

  int hx = x - wcHouseX(x), hz = z - WC_COTTAGE_Z;
  bool houseFloor = abs(hx) <= WC_HOUSE_HALF && abs(hz) <= WC_HOUSE_HALF;
  bool doorstep = hx >= -WC_PATH_HALF && hx < WC_PATH_HALF && z >= WC_LANE_Z && z < WC_COTTAGE_Z;
  if (y < h) {
    if (y < h - 1) return E_ROCK;
    if (wcPath(x, z) || doorstep || houseFloor) return E_BRICK;
    bool bank = (abs(dx) <= WC_BANK_HALF && z >= WC_RIVER_START) || dx * dx + dz * dz <= WC_POND_BANK * WC_POND_BANK;
    if (!bank && r > WC_BEACH_IN && r < WC_SHORE - 1) return E_SAND;
    return r < WC_GRASS_IN && !bank ? E_PLANT : E_ROCK;
  }
  if (y < WC_SEA) return E_WATER;
  if (y >= WC_LOW && z >= WC_COTTAGE_Z - WC_HOUSE_HALF - WC_ROOF_OVER && z <= WC_COTTAGE_Z + WC_HOUSE_HALF + WC_ROOF_OVER) {
    int id = wcHouse(x, y, z);
    if (id != E_EMPTY) return id;
  }
  return wcTree(x, y, z);
}

// Public island-local BASE terrain API. It never invokes overlay modules.
int cfTerrainCell(int x, int y, int z) {
  return wcBaseCell(x + thDiv(uWillowWorldX, 2), y, z + thDiv(uWillowWorldZ, 2));
}

int wcCell(int wx, int y, int wz) {
  return cfTerrainCell(wx - thDiv(uWillowWorldX, 2), y, wz - thDiv(uWillowWorldZ, 2));
}
`;

// The JS twin per world (seed and size): the seed is in scope for any shared
// hash calls.
export const willowCoveTwin = memoTwin((P) => `${P.seed}:${P.size}`, (P) => compileShared(SRC, P.seed, {
  ...jsConstants('WC', L), uWillowWorldX: P.size[0], uWillowWorldY: P.size[1], uWillowWorldZ: P.size[2],
}));

// The scene's WGSL (scenes/sceneGpu.js): its uniforms (the world's size,
// cells), constants, the helpers, the geometry (from the subset:
// scenes/subsetWgsl.js) and sceneCell.
const WC_U = sceneStruct({ uWillowWorldX: 'i32', uWillowWorldY: 'i32', uWillowWorldZ: 'i32' });
let srcWgsl = null;
const willowWgsl = () => /* wgsl */ `
${sceneHeadWGSL(WC_U)}
${definesGLSL('WC', L)}
${helpersGLSL}
${srcWgsl ??= toWgsl(SRC, { consts: definesTypes('WC', L), uniforms: WC_U.sceneTypes })}
fn sceneCell(w: vec3i) -> SceneCell {
  let id = wcCell(w.x, w.y, w.z);
  let seed = u32ToF32(seedWorld(w, SU.uSceneSeed, WC_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  return SceneCell(vec4f(f32(id), SPAWNT(id), SPAWNLIFE(id), seed), vec4f(0.0));
}
`;

export const willowCove = {
  key: 'willowCove', label: 'Tinker Creek', shrine: false,
  size: WILLOW_SIZE,
  legacySize: [L.ints.LEGACY_WORLD_X, 128, 1024], // Old voxel saves keep their original terrain and coordinates.
  view: { dir: [0.65, 1.15, 1.4], dist: 240, lift: 12 },
  params: ({ size, seed }) => ({ size, seed: seed >>> 0, sea: L.ints.SEA, floor: L.ints.FLOOR }),
  glsl: () => willowWgsl(),
  uniformStruct: WC_U,
  uniforms: (P) => ({ uSceneSeed: P.seed, uWillowWorldX: P.size[0], uWillowWorldY: P.size[1], uWillowWorldZ: P.size[2] }),
  start: (P) => [Math.floor(P.size[0] / 2) + L.ints.PLAZA_X, Math.floor(P.size[2] / 2) + L.ints.PLAZA_Z],
  ground: (x, z, P) => groundScan(willowCoveTwin(P).wcCell, x, z, Math.min(P.size[1], L.ints.SKY)),
};
