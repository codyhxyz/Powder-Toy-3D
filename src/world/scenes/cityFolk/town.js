// Original voxel architecture inspired by Animal Crossing: City Folk's civic
// square, independent shops and neighborhoods, not Nintendo artwork.
// Island-local cells; integration calls this only for the expanded world.
const ints = {
  LOW: 24, MID: 36, HIGH: 48,
  HALL_X: -280, HALL_Z: 12, HALL_HALF_X: 18, HALL_HALF_Z: 10,
  SQUARE_X: -326, SQUARE_Z: 12, SQUARE_HALF_X: 16, SQUARE_HALF_Z: 12,
  BOARD_X: -326, BOARD_Z: 0,
  NOOK_X: -380, ABLE_X: -430, SHOP_Z: 12, SHOP_HALF_X: 16, SHOP_HALF_Z: 10,
  SHOP_PATH_Z: 26,
  MUSEUM_X: 300, MUSEUM_Z: -80, MUSEUM_HALF_X: 22, MUSEUM_HALF_Z: 16,
  CAFE_X: 264, CAFE_Z: -80, CAFE_HALF_X: 14, CAFE_HALF_Z: 12,
  COTTAGE_A_X: -400, COTTAGE_B_X: -680, UPPER_Z: -112, LOWER_Z: 80,
  HOUSE_HALF: 12, UPPER_PATH_Z: -94, LOWER_PATH_Z: 100,
  PLOT_X: -500, PLOT_HALF: 14,
  GATE_X: -260, GATE_Z: -124, GATE_HALF_X: 14, GATE_HALF_Z: 4,
  GATE_DOOR_HALF: 6, GATE_DOOR_H: 18,
  BUS_MIN_X: -244, BUS_MAX_X: -210, BUS_MIN_Z: -123, BUS_MAX_Z: -109,
  PATH_HALF: 5, WALL_H: 16, DOOR_HALF: 4, DOOR_H: 12, ROOF_OVER: 2,
};

const record = (at, entry, floor, half, extra = {}) => Object.freeze({ at, entry, floor, half, ...extra });
const landmarks = Object.freeze({
  townHall: record([-280, 12], [-298, 12], 24, [18, 10], { name: 'Tinker Creek town hall', facing: 'west' }),
  eventSquare: record([-326, 12], [-326, 24], 24, [16, 12]),
  bulletinBoard: record([-326, 0], [-326, 5], 24, [8, 2]),
  nookShop: record([-380, 12], [-380, 22], 24, [16, 10], { name: 'Creek Supply', facing: 'south' }),
  ableShop: record([-430, 12], [-430, 22], 24, [16, 10], { name: 'Thread & Thimble', facing: 'south' }),
  museum: record([300, -80], [300, -64], 36, [22, 16], { name: 'Tinker Creek museum', facing: 'south' }),
  cafe: record([264, -80], [250, -80], 36, [14, 12], { name: 'The Perch café', facing: 'west', museumDoor: [278, -80] }),
  cottages: [
    record([-400, -112], [-400, -100], 48, [12, 12], { neighborhood: 'upper' }),
    record([-680, -112], [-680, -100], 48, [12, 12], { neighborhood: 'upper' }),
    record([-400, 80], [-400, 92], 24, [12, 12], { neighborhood: 'lower' }),
    record([-680, 80], [-680, 92], 24, [12, 12], { neighborhood: 'lower' }),
  ],
  plots: [
    record([-500, -112], [-500, -98], 48, [14, 14], { neighborhood: 'upper' }),
    record([-500, 80], [-500, 94], 24, [14, 14], { neighborhood: 'lower' }),
  ],
  gate: record([-260, -124], [-260, -120], 48, [14, 4], { approach: [-260, -116], passage: [-260, -128] }),
  busReservation: { min: [-244, -123], max: [-210, -109], floor: 48, stop: [-236, -116], arrival: [-220, -116] },
  // Axis-aligned center lines, ten-cell width. Terrain connects the endpoints.
  approaches: [
    [[-298, 12], [-326, 12]], [[-326, 12], [-326, 36]],
    [[-430, 22], [-430, 26]], [[-380, 22], [-380, 26]], [[-430, 26], [-326, 26]],
    [[300, -64], [300, -52]], [[300, -52], [340, -52]], [[340, -52], [340, -80]],
    [[250, -80], [240, -80]],
    [[-400, -100], [-400, -94]], [[-680, -100], [-680, -94]], [[-500, -98], [-500, -94]],
    [[-400, 92], [-400, 100]], [[-680, 92], [-680, 100]], [[-500, 94], [-500, 100]],
    [[-260, -128], [-260, -116]], [[-260, -116], [-220, -116]],
  ],
  // Inclusive rectangles include roof overhangs; approaches are reserved too.
  reservedFootprints: [
    { min: [-300, 0], max: [-260, 24] }, { min: [-344, -6], max: [-308, 30] },
    { min: [-398, 0], max: [-362, 24] }, { min: [-448, 0], max: [-412, 24] },
    { min: [276, -98], max: [324, -62] }, { min: [248, -94], max: [280, -66] },
    ...[-400, -680].flatMap(x => [-112, 80].map(z => ({ min: [x - 14, z - 14], max: [x + 14, z + 14] }))),
    ...[-112, 80].map(z => ({ min: [-516, z - 16], max: [-484, z + 16] })),
    { min: [-276, -130], max: [-244, -118] }, { min: [-244, -123], max: [-210, -109] },
  ],
});

const src = /* glsl */ `
bool cfTownSegment(int x, int z, int ax, int az, int bx, int bz) {
  return x >= min(ax, bx) - TOWN_PATH_HALF && x < max(ax, bx) + TOWN_PATH_HALF &&
    z >= min(az, bz) - TOWN_PATH_HALF && z < max(az, bz) + TOWN_PATH_HALF;
}

bool cfTownPath(int x, int z) {
  if (cfTownSegment(x, z, -298, 12, -326, 12) || cfTownSegment(x, z, -326, 12, -326, 36)) return true;
  if (cfTownSegment(x, z, TOWN_ABLE_X, 22, TOWN_ABLE_X, TOWN_SHOP_PATH_Z) || cfTownSegment(x, z, TOWN_NOOK_X, 22, TOWN_NOOK_X, TOWN_SHOP_PATH_Z)) return true;
  if (cfTownSegment(x, z, TOWN_ABLE_X, TOWN_SHOP_PATH_Z, TOWN_SQUARE_X, TOWN_SHOP_PATH_Z)) return true;
  if (cfTownSegment(x, z, 300, -64, 300, -52) || cfTownSegment(x, z, 300, -52, 340, -52) || cfTownSegment(x, z, 340, -52, 340, -80)) return true;
  if (cfTownSegment(x, z, 250, -80, 240, -80)) return true;
  if (cfTownSegment(x, z, TOWN_COTTAGE_A_X, -100, TOWN_COTTAGE_A_X, TOWN_UPPER_PATH_Z) || cfTownSegment(x, z, TOWN_COTTAGE_B_X, -100, TOWN_COTTAGE_B_X, TOWN_UPPER_PATH_Z)) return true;
  if (cfTownSegment(x, z, TOWN_COTTAGE_A_X, 92, TOWN_COTTAGE_A_X, TOWN_LOWER_PATH_Z) || cfTownSegment(x, z, TOWN_COTTAGE_B_X, 92, TOWN_COTTAGE_B_X, TOWN_LOWER_PATH_Z)) return true;
  if (cfTownSegment(x, z, TOWN_PLOT_X, -98, TOWN_PLOT_X, TOWN_UPPER_PATH_Z) || cfTownSegment(x, z, TOWN_PLOT_X, 94, TOWN_PLOT_X, TOWN_LOWER_PATH_Z)) return true;
  return cfTownSegment(x, z, TOWN_GATE_X, -128, TOWN_GATE_X, -116) || cfTownSegment(x, z, TOWN_GATE_X, -116, -220, -116);
}

bool cfTownRect(int x, int z, int cx, int cz, int hx, int hz) {
  return abs(x - cx) <= hx && abs(z - cz) <= hz;
}

bool cfTownReserved(int x, int z) {
  if (cfTownPath(x, z)) return true;
  if (cfTownRect(x, z, TOWN_HALL_X, TOWN_HALL_Z, 20, 12) || cfTownRect(x, z, TOWN_SQUARE_X, TOWN_SQUARE_Z, 18, 18)) return true;
  if (cfTownRect(x, z, TOWN_NOOK_X, TOWN_SHOP_Z, 18, 12) || cfTownRect(x, z, TOWN_ABLE_X, TOWN_SHOP_Z, 18, 12)) return true;
  if (cfTownRect(x, z, TOWN_MUSEUM_X, TOWN_MUSEUM_Z, 24, 18) || cfTownRect(x, z, TOWN_CAFE_X, TOWN_CAFE_Z, 16, 14)) return true;
  if ((abs(x - TOWN_COTTAGE_A_X) <= 14 || abs(x - TOWN_COTTAGE_B_X) <= 14) && (abs(z - TOWN_UPPER_Z) <= 14 || abs(z - TOWN_LOWER_Z) <= 14)) return true;
  if (abs(x - TOWN_PLOT_X) <= 16 && (abs(z - TOWN_UPPER_Z) <= 16 || abs(z - TOWN_LOWER_Z) <= 16)) return true;
  if (cfTownRect(x, z, TOWN_GATE_X, TOWN_GATE_Z, 16, 6)) return true;
  return x >= TOWN_BUS_MIN_X && x <= TOWN_BUS_MAX_X && z >= TOWN_BUS_MIN_Z && z <= TOWN_BUS_MAX_Z;
}

// a = across façade, b = toward entrance. Hollow supported shells have 8x12
// doors (the original cottages use 8x11), and no invisible door colliders.
int cfTownShell(int a, int y, int b, int f, int hx, int hz, int kind, int id) {
  if (abs(a) > hx + TOWN_ROOF_OVER || abs(b) > hz + TOWN_ROOF_OVER || y < 0 || y >= f + 36) return id;
  bool inside = abs(a) <= hx && abs(b) <= hz;
  int wall = kind == 1 || kind == 4 ? E_LIMESTONE : E_WOOD;
  int roofMaterial = kind == 3 || kind == 5 ? E_BASALT : E_BRICK;
  int roof = f + TOWN_WALL_H + max(2, 7 - thDiv(abs(a), 3));
  if (kind == 4) roof = f + TOWN_WALL_H + max(2, 7 - thDiv(abs(a), 4));
  // Civic clock tower, with metal hands on a glass clock face.
  if (kind == 1 && abs(a) <= 3 && abs(b + 6) <= 3 && y >= f + 21 && y < f + 34) {
    if (y >= f + 32) return E_BRICK;
    if (b == -3 && y >= f + 25 && y <= f + 30) return a == 0 || y == f + 27 ? E_METAL : E_GLASS;
    return E_LIMESTONE;
  }
  if (kind == 5 && a >= 5 && a <= 7 && b >= -7 && b <= -5 && y >= f + 18 && y < f + 29) return E_BRICK;
  if (y >= roof - 2 && y < roof) return roofMaterial;
  if (!inside) return id;
  if (y < f - 1) return E_ROCK;
  if (y == f - 1) return E_BRICK;
  if (y >= roof) return id;
  bool front = b >= hz - 1;
  bool side = abs(a) >= hx - 1;
  bool back = b <= -hz + 1;
  if (front && a >= -TOWN_DOOR_HALF && a < TOWN_DOOR_HALF && y < f + TOWN_DOOR_H) return E_EMPTY;
  // Museum west door joins café east door at their shared wall.
  if (kind == 4 && a <= -hx + 1 && abs(b) < TOWN_DOOR_HALF && y < f + TOWN_DOOR_H) return E_EMPTY;
  if (kind == 5 && back && abs(a) < TOWN_DOOR_HALF && y < f + TOWN_DOOR_H) return E_EMPTY;
  if (front && (kind == 1 || kind == 4) && abs(a) >= 6 && abs(a) <= 8) return E_LIMESTONE;
  if (front && abs(a) >= 6 && abs(a) <= hx - 3 && y >= f + 4 && y < f + 11) return E_GLASS;
  // Textile stripes and supply's timber sign band distinguish the shops.
  if (front && kind == 3 && y >= f + 12 && y < f + 14) return thMod(a, 4) < 2 ? E_BRICK : E_LIMESTONE;
  if (front && kind == 2 && y >= f + 12 && y < f + 14) return E_WOOD;
  // Original leaf and crossed-needle voxel emblems.
  if (front && y >= f + 14 && y < f + 18) {
    if (kind == 2 && abs(a - (y - f - 16)) <= 2) return E_CERAMIC;
    if (kind == 3 && (a == y - f - 16 || a == 16 - (y - f))) return E_METAL;
  }
  if ((side && abs(b) < 5 || back && abs(a) < 5) && y >= f + 5 && y < f + 10) return E_GLASS;
  if (front || side || back) return wall;
  // Reception/supply shelves, tailor bench, museum plinths and café bar.
  // All leave the center aisle body-clear.
  if (y < f + 5 && b <= -hz + 6 && abs(a) >= 6 && abs(a) <= hx - 3) return kind == 4 ? E_LIMESTONE : E_WOOD;
  if (kind == 4 && y >= f + 5 && y < f + 9 && b <= -hz + 5 && abs(a) >= 9 && abs(a) <= 11) return E_BASALT;
  if (kind == 3 && y == f + 5 && b <= -hz + 6 && a >= 6 && a <= 10) return E_METAL;
  if (kind == 5 && a <= -6 && a >= -8 && b >= -3 && b <= 3 && y < f + 5) return E_WOOD;
  return E_EMPTY;
}

int cfTownPlot(int a, int y, int b, int f, int id) {
  if (abs(a) > TOWN_PLOT_HALF || abs(b) > TOWN_PLOT_HALF || y < 0 || y >= f + 10) return id;
  // Survey plots may overhang a river-bank pad: retain the base channel
  // beneath its deck, rather than damming the connected west waterfalls.
  if (y < f - 1) return id == E_WATER ? id : E_ROCK;
  if (y == f - 1) return E_BRICK;
  // Survey stakes and a sign, leaving a wide southern entrance.
  if (abs(a) >= TOWN_PLOT_HALF - 1 && abs(b) >= TOWN_PLOT_HALF - 1 && y < f + 4) return E_WOOD;
  if (a >= 7 && a <= 11 && b == TOWN_PLOT_HALF && y >= f + 4 && y < f + 8) return E_WOOD;
  if (a == 9 && b == TOWN_PLOT_HALF && y < f + 4) return E_WOOD;
  return E_EMPTY;
}

int cfTownCell(int x, int y, int z, int h, int id) {
  if (y < 0 || !cfTownReserved(x, z)) return id;
  int outId = id;
  if (cfTownPath(x, z) && y == h - 1) outId = E_BRICK;
  if (cfTownRect(x, z, TOWN_SQUARE_X, TOWN_SQUARE_Z, TOWN_SQUARE_HALF_X, TOWN_SQUARE_HALF_Z)) {
    if (y < TOWN_LOW - 1) outId = E_ROCK;
    if (y == TOWN_LOW - 1) outId = thMod(x + z, 8) < 2 ? E_LIMESTONE : E_BRICK;
    if (y >= TOWN_LOW && y < TOWN_LOW + 16) outId = E_EMPTY;
  }
  int ba = x - TOWN_BOARD_X, bb = z - TOWN_BOARD_Z;
  if (abs(ba) <= 8 && abs(bb) <= 1 && y >= TOWN_LOW && y < TOWN_LOW + 14) {
    if (abs(ba) >= 6 || y >= TOWN_LOW + 12) outId = E_WOOD;
    if (y >= TOWN_LOW + 5 && y < TOWN_LOW + 12) outId = abs(ba) < 5 && bb == 1 ? E_CERAMIC : E_WOOD;
  }
  outId = cfTownShell(z - TOWN_HALL_Z, y, TOWN_HALL_X - x, TOWN_LOW, TOWN_HALL_HALF_Z, TOWN_HALL_HALF_X, 1, outId);
  outId = cfTownShell(x - TOWN_NOOK_X, y, z - TOWN_SHOP_Z, TOWN_LOW, TOWN_SHOP_HALF_X, TOWN_SHOP_HALF_Z, 2, outId);
  outId = cfTownShell(x - TOWN_ABLE_X, y, z - TOWN_SHOP_Z, TOWN_LOW, TOWN_SHOP_HALF_X, TOWN_SHOP_HALF_Z, 3, outId);
  outId = cfTownShell(x - TOWN_MUSEUM_X, y, z - TOWN_MUSEUM_Z, TOWN_MID, TOWN_MUSEUM_HALF_X, TOWN_MUSEUM_HALF_Z, 4, outId);
  outId = cfTownShell(z - TOWN_CAFE_Z, y, TOWN_CAFE_X - x, TOWN_MID, TOWN_CAFE_HALF_Z, TOWN_CAFE_HALF_X, 5, outId);
  outId = cfTownShell(x - TOWN_COTTAGE_A_X, y, z - TOWN_UPPER_Z, TOWN_HIGH, TOWN_HOUSE_HALF, TOWN_HOUSE_HALF, 0, outId);
  outId = cfTownShell(x - TOWN_COTTAGE_B_X, y, z - TOWN_UPPER_Z, TOWN_HIGH, TOWN_HOUSE_HALF, TOWN_HOUSE_HALF, 0, outId);
  outId = cfTownShell(x - TOWN_COTTAGE_A_X, y, z - TOWN_LOWER_Z, TOWN_LOW, TOWN_HOUSE_HALF, TOWN_HOUSE_HALF, 0, outId);
  outId = cfTownShell(x - TOWN_COTTAGE_B_X, y, z - TOWN_LOWER_Z, TOWN_LOW, TOWN_HOUSE_HALF, TOWN_HOUSE_HALF, 0, outId);
  outId = cfTownPlot(x - TOWN_PLOT_X, y, z - TOWN_UPPER_Z, TOWN_HIGH, outId);
  outId = cfTownPlot(x - TOWN_PLOT_X, y, z - TOWN_LOWER_Z, TOWN_LOW, outId);
  if (cfTownRect(x, z, TOWN_GATE_X, TOWN_GATE_Z, TOWN_GATE_HALF_X, TOWN_GATE_HALF_Z)) {
    if (y < TOWN_HIGH - 1) return E_ROCK;
    if (y == TOWN_HIGH - 1) return E_BRICK;
    if (y < TOWN_HIGH + TOWN_GATE_DOOR_H) return abs(x - TOWN_GATE_X) >= TOWN_GATE_DOOR_HALF ? E_LIMESTONE : E_EMPTY;
    if (y < TOWN_HIGH + TOWN_GATE_DOOR_H + 4) return E_BRICK;
  }
  return outId;
}
`;

export const CITY_FOLK_TOWN = Object.freeze({ ints: Object.freeze(ints), salts: Object.freeze({}), src, landmarks });
