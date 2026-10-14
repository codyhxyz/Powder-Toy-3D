// Original City Folk-inspired urban silhouettes. All scenery is real matter.
// Coordinates are island-local; compose only for expanded worlds (legacy exact).
const ints = {
  FLOOR: 48, WEST: -160, EAST: 160, NORTH: -440, SOUTH: -280,
  STOP_X: -236, STOP_Z: -116, ARRIVAL_X: -220,
  CITY_STOP_Z: -304, PLAZA_Z: -352,
  EMPORIUM_X: -88, EMPORIUM_Z: -394,
  TAILOR_X: 0, TAILOR_Z: -402, THEATRE_X: 88, THEATRE_Z: -394,
  HOUSE_HALF_X: 28, HOUSE_HALF_Z: 18, WALL_H: 24, DOOR_HALF: 4, DOOR_H: 12,
};
const src = /* glsl */ `
int cfCityShop(int x, int y, int z, int cx, int cz, int style) {
  int dx = x - cx, dz = z - cz, ay = y - CITY_FLOOR;
  if (abs(dx) > CITY_HOUSE_HALF_X + 2 || abs(dz) > CITY_HOUSE_HALF_Z + 2) return E_EMPTY;
  int roof = CITY_WALL_H + (style == 1 ? thDiv(CITY_HOUSE_HALF_X - min(abs(dx), CITY_HOUSE_HALF_X), 3) : 0);
  if (ay >= CITY_WALL_H && ay < roof + 2) return style == 1 ? E_WOOD : E_METAL;
  if (abs(dx) > CITY_HOUSE_HALF_X || abs(dz) > CITY_HOUSE_HALF_Z) return E_EMPTY;
  if (ay < 0 || ay >= CITY_WALL_H) return E_EMPTY;
  bool wall = abs(dx) >= CITY_HOUSE_HALF_X - 1 || abs(dz) >= CITY_HOUSE_HALF_Z - 1;
  bool front = dz >= CITY_HOUSE_HALF_Z - 1;
  if (!wall) return E_EMPTY;
  if (front && abs(dx) <= CITY_DOOR_HALF && ay < CITY_DOOR_H) return E_EMPTY;
  if (front && ay >= 4 && ay <= 12 && abs(dx) >= 9 && abs(dx) <= 23) return E_GLASS;
  if (front && ay >= 16 && ay <= 19 && abs(dx) <= 18) return style == 0 ? E_WOOD : style == 1 ? E_GLASS : E_METAL;
  // Emporium masonry, timber tailor bays, theatre's colonnade.
  if (style == 2 && front && thMod(dx + CITY_HOUSE_HALF_X, 8) < 2) return E_ROCK;
  if (style == 1 && (thMod(dx + CITY_HOUSE_HALF_X, 12) < 2 || ay == 14)) return E_WOOD;
  return style == 0 ? E_BRICK : style == 1 ? E_WOOD : E_ROCK;
}
int cfCityStop(int x, int y, int z, int cx, int cz) {
  int dx = x - cx, dz = z - cz, ay = y - CITY_FLOOR;
  // City Folk's open bus shelter: bench, roof and broad boarding apron.
  if (abs(dx) <= 10 && dz >= -8 && dz <= 4) {
    if (ay >= 11 && ay < 13) return E_METAL;
    if (ay >= 0 && ay < 11 && (dz == -8 || (abs(dx) == 10 && dz < 0))) return E_GLASS;
    if (ay >= 0 && ay < 4 && dz >= -6 && dz <= -4 && abs(dx) <= 7) return E_WOOD;
  }
  // Route marker beside, never on, the boarding footprint.
  if (dx >= 12 && dx <= 13 && dz >= -7 && dz <= -6 && ay >= 0 && ay < 14) return E_METAL;
  if (dx >= 10 && dx <= 15 && dz >= -8 && dz <= -5 && ay >= 12 && ay < 16) return E_WOOD;
  return E_EMPTY;
}
int cfCityBusStopCell(int x, int y, int z, int id) {
  bool townStop = x >= CITY_STOP_X - 18 && x <= CITY_ARRIVAL_X + 12 && abs(z - CITY_STOP_Z) <= 10;
  if (!townStop) return id;
  if (y < CITY_FLOOR - 1) return E_ROCK;
  if (y < CITY_FLOOR) return E_BRICK;
  // Town geometry has priority: preserve gate posts and adjacent overlays.
  if (id != E_EMPTY) return id;
  return cfCityStop(x, y, z, CITY_STOP_X, CITY_STOP_Z - 4);
}
int cfCityCell(int x, int y, int z, int id) {
  bool city = x >= CITY_WEST && x <= CITY_EAST && z >= CITY_NORTH && z <= CITY_SOUTH;
  if (!city) return id;
  if (y < CITY_FLOOR - 1) return E_ROCK;
  if (y < CITY_FLOOR) {
    if (city && abs(x) <= 28 && abs(z - CITY_PLAZA_Z) <= 22 && (thMod(x + 28, 8) == 0 || thMod(z - CITY_PLAZA_Z + 22, 8) == 0)) return E_ROCK;
    return E_BRICK;
  }
  int matter = cfCityShop(x, y, z, CITY_EMPORIUM_X, CITY_EMPORIUM_Z, 0);
  if (matter != E_EMPTY) return matter;
  matter = cfCityShop(x, y, z, CITY_TAILOR_X, CITY_TAILOR_Z, 1);
  if (matter != E_EMPTY) return matter;
  matter = cfCityShop(x, y, z, CITY_THEATRE_X, CITY_THEATRE_Z, 2);
  if (matter != E_EMPTY) return matter;
  matter = cfCityStop(x, y, z, 0, CITY_CITY_STOP_Z + 12);
  if (matter != E_EMPTY) return matter;
  int pz = z - CITY_PLAZA_Z;
  // Low corner planters and lamps leave the square's crossing clear.
  if (abs(x) >= 29 && abs(x) <= 34 && abs(pz) >= 23 && abs(pz) <= 28) {
    if (y < CITY_FLOOR + 2) return E_ROCK;
    if (y == CITY_FLOOR + 2) return E_PLANT;
  }
  if (abs(x) == 44 && abs(pz) == 30) {
    if (y < CITY_FLOOR + 13) return E_METAL;
    if (y < CITY_FLOOR + 15) return E_GLASS;
  }
  if ((x == CITY_WEST || x == CITY_EAST || z == CITY_NORTH || z == CITY_SOUTH) && y < CITY_FLOOR + 3) return E_ROCK;
  return E_EMPTY;
}
`;
export const CITY_FOLK_CITY = Object.freeze({
  ints, salts: {}, src,
  landmarks: {
    district: { at: [0, -360], floor: 48, half: [160, 80] },
    square: { at: [0, -352], floor: 48, half: [28, 22] },
    emporium: { at: [-88, -394], entry: [-88, -376], floor: 48, half: [28, 18] },
    tailor: { at: [0, -402], entry: [0, -384], floor: 48, half: [28, 18] },
    theatre: { at: [88, -394], entry: [88, -376], floor: 48, half: [28, 18] },
    townStop: { at: [-236, -116], entry: [-220, -116], floor: 48, half: [18, 10] },
    cityStop: { at: [0, -304], entry: [0, -300], floor: 48, half: [10, 8] },
    townArrival: [-220, 48, -116], cityArrival: [0, 48, -304],
  },
});
