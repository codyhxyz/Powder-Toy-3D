import { helpersGLSL, definesGLSL, jsConstants, pickGLSL, compileShared, groundScan } from './themedShared.js';

// Lab world: the box lab (presets.js 'lab') grown into an endless research
// facility. The world is a grid of rooms, ROOM cells square, each walled on
// its low-x and low-z sides (its neighbours' walls close the other two), with
// a doorway in each wall and glass windows in some; a WALL floor runs under
// everything, so nothing falls out of the world.
//
// A room holds one, two or four stations (its layout: one big slot, two halves
// or four quarters), and a station is one of the box lab's setups, sized and
// placed inside its slot by its own hash:
//   - TANK: a glass tank of water with an oil slick and an ice cube (the box's),
//     or of water over a sand bed, of acid (glass shrugs it off) or of oil;
//   - PIT: lava (ctype STONE, as the box's) in a WALL basin under a metal plate,
//     with snow on the plate (the box's), or ice, gunpowder, a wooden block or a
//     little glass tank of water to boil; some pits are open;
//   - TOWERS: a row or grid of wooden towers with gunpowder cores, each with an
//     oil puddle at its foot;
//   - BLOCK: a block of ice under a cap of snow;
//   - nothing.
// Over any of them a slot may hang a block of sand (or stone, snow or
// gunpowder) in the air, about to fall, as the box's does.
//
// Every cell is a pure function of its world position and the seed: it looks
// at its own room's hash and its own slot's station only (stations stay inside
// their slots), so a cell costs a few dozen hashes, whatever the world's size.
// The geometry is written once (SRC) in the shared GLSL subset
// (themedShared.js): the GPU runs it, and the CPU runs its JS twin for ground()
// and start(). Everything generated is at its spawn temperature and life, at
// rest; unstable on purpose where the box lab is (falling sand, lava under
// metal under snow, oil that spreads), never invalid.

// The room grid's constants (cells unless said otherwise; heights above the floor).
const L = {
  ints: {
    ROOM: 64,               // room edge: two box-lab stations side by side, and the 128-cell window shows four rooms
    FLOOR: 2,               // the WALL floor under everything
    WALL: 2,                // wall thickness
    WALL_H: 18,             // wall height: low enough for the god view to look into the rooms
    DOOR_W: 8,              // doorways, wide and tall enough to walk through in first person (a player is about 6 cells)
    DOOR_H: 11,
    DOOR_MARGIN: 8,         // a doorway keeps this far from the room's corners
    WINDOW_LO: 4,           // the glass band of a wall with windows, its bottom and top
    WINDOW_HI: 13,
    WINDOW_EDGE: 4,         // glass keeps this far from corners and doorways
    MARGIN: 3,              // a station keeps this far from its slot's edges: an aisle between stations
    SKY: 104,               // nothing stands this high (the highest hanging block's top)
    PCT: 100,               // per cent: the unit of the shares below given in per cent

    // tanks (the box's: 52 wide, 40 tall, water to 24, oil to 28, a 10-cell ice cube)
    GLASS: 1,               // glass wall and bottom thickness
    TANK_MIN: 10,           // footprint, each side
    TANK_MAX: 56,
    TANK_H_MIN: 12,
    TANK_H_MAX: 40,
    TANK_FILL_LO: 45,       // the liquid's surface, per cent of the tank's height
    TANK_FILL_HI: 70,
    SLICK_MIN: 2,           // oil slick thickness
    SLICK_MAX: 4,
    FREEBOARD: 2,           // the liquid stays this far below the tank's rim
    ICE_MIN: 4,             // ice cube edge; at most a third of the tank's shorter side
    ICE_SHARE_DIV: 3,
    ICE_SINK_DIV: 3,        // a cube sits a third of its edge below the water's surface
    BED_MIN: 2,             // sand bed under an aquarium's water
    BED_MAX: 4,

    // lava pits (the box's: 40 wide, a 2-cell WALL rim, lava 9 deep, a 2-cell metal plate, 4 cells of snow)
    PIT_MIN: 12,
    PIT_MAX: 44,
    PIT_H_MIN: 6,           // basin height
    PIT_H_MAX: 12,
    PIT_RIM: 2,             // WALL rim thickness
    PIT_BED: 1,             // WALL under the lava
    PLATE: 2,               // metal plate thickness
    TOP_INSET_MIN: 2,       // what stands on the plate keeps this far in from its edges...
    TOP_INSET_PCT: 30,      // ...or this share of the pit's shorter side (the box's snow: 12 of 40)
    TOP_H_MIN: 3,
    TOP_H_MAX: 8,

    // wooden towers (the box's: 14 wide, 50 tall, a gunpowder core 3 in from 4 up to 4 down, a 4×6×3 oil puddle)
    TOWER_W_MIN: 8,
    TOWER_W_MAX: 16,
    TOWER_H_MIN: 20,
    TOWER_H_MAX: 56,
    TOWER_GAP: 8,           // between towers (room for the next one's puddle)
    TOWER_N: 3,             // at most this many towers along each side of a slot
    CORE_INSET: 3,          // the gunpowder core's inset from the tower's sides...
    CORE_BASE: 4,           // ...its bottom...
    CORE_TOP: 4,            // ...and how far below the tower's top it ends
    PUDDLE_D: 6,            // the oil puddle in front of a tower: its depth...
    PUDDLE_INSET: 5,        // ...its inset from the tower's sides (it is at least PUDDLE_W_MIN wide)...
    PUDDLE_W_MIN: 2,
    PUDDLE_H: 3,            // ...and height

    // ice blocks
    BLOCK_MIN: 6,
    BLOCK_MAX: 18,
    BLOCK_H_MIN: 6,
    BLOCK_H_MAX: 20,
    SNOW_CAP: 2,            // snow on top

    // hanging blocks (the box's: 30 × 20 × 30, from 70 up)
    HANG_MIN: 6,
    HANG_MAX: 30,
    HANG_H_MIN: 6,
    HANG_H_MAX: 20,
    HANG_LO: 62,            // its bottom: above the tallest tower...
    // ...and its top at most SKY

    // parameter streams of a room's and a slot's hash (thKey)
    K_LAYOUT: 1, K_AXIS: 2, K_DOOR: 3, K_WINDOW: 5, K_SLOT: 7,
    K_KIND: 1, K_W: 2, K_D: 3, K_X: 4, K_Z: 5, K_H: 6, K_FILL: 7, K_VARIANT: 8, K_SLICK: 9,
    K_ICE: 10, K_ICE_X: 11, K_ICE_Z: 12, K_BED: 13, K_PLATE: 14, K_TOP: 15, K_TOP_H: 16,
    K_PUDDLE: 17, K_HANG: 18, K_HANG_Y: 19, K_STUFF: 20, K_TOWER: 32,

    // start(): how much a station counts toward a room being worth starting in
    SCORE_TANK: 2, SCORE_PIT: 3, SCORE_TOWERS: 3, SCORE_BLOCK: 1, SCORE_HANG: 1,
  },
  salts: {
    ROOM: 0x1ab0,           // rooms' hashes
    CELL: 0x1ab1,           // cells' colour seeds
  },
  picks: {
    LAYOUT: [['QUAD', 0.5], ['HALVES', 0.3], ['WHOLE', 0.2]],
    STATION: [['TANK', 0.27], ['PIT', 0.27], ['TOWERS', 0.24], ['BLOCK', 0.08], ['NONE', 0.14]],
    TANK: [['SLICK', 0.5], ['AQUARIUM', 0.2], ['ACID', 0.15], ['OIL', 0.15]],
    TOP: [['SNOW', 0.35], ['ICE', 0.15], ['WATER', 0.15], ['GUNPOWDER', 0.1], ['WOOD', 0.1], ['NONE', 0.15]],
    HANG: [['SAND', 0.6], ['STONE', 0.15], ['SNOW', 0.15], ['GUNPOWDER', 0.1]],
    PLATE: [['YES', 0.8], ['NO', 0.2]],          // a pit's metal plate (or an open pool)
    SLOT_HANG: [['YES', 0.4], ['NO', 0.6]],      // a block hangs over the slot
    WINDOWS: [['YES', 0.5], ['NO', 0.5]],        // a wall has glass windows
    TOWER_PUDDLE: [['YES', 0.75], ['NO', 0.25]], // a tower has its oil puddle
  },
};
const P_ = 'LAB';

// The geometry, in the shared GLSL subset. uLabWorldX, uLabWorldZ: the world's
// size (its far sides get a solid wall).
const SRC = /* glsl */ `
${pickGLSL(P_, 'LAYOUT', L.picks.LAYOUT, 'labPickLayout')}
${pickGLSL(P_, 'STATION', L.picks.STATION, 'labPickStation')}
${pickGLSL(P_, 'TANK', L.picks.TANK, 'labPickTank')}
${pickGLSL(P_, 'TOP', L.picks.TOP, 'labPickTop')}
${pickGLSL(P_, 'HANG', L.picks.HANG, 'labPickHang')}

uint labRoom(int rx, int rz) { return thHash2(rx, rz, LAB_SALT_ROOM); }
bool labYes(uint h, int cut) { return thShare(h) < cut; }

// A cell of one of a room's walls: k 0 is its low-x wall, 1 its low-z wall;
// along: the cell's place along the wall (room-local); open: the wall has a
// doorway (not on the world's edge); h: height above the floor.
int labWall(uint rh, int k, bool open, int along, int h) {
  if (h >= LAB_WALL_H) return E_EMPTY;
  int d0 = thRange(thKey(rh, LAB_K_DOOR + k), LAB_DOOR_MARGIN, LAB_ROOM - LAB_DOOR_MARGIN - LAB_DOOR_W);
  if (open && along >= d0 && along < d0 + LAB_DOOR_W && h < LAB_DOOR_H) return E_EMPTY;
  bool windows = labYes(thKey(rh, LAB_K_WINDOW + k), LAB_WINDOWS_YES_CUT);
  bool nearDoor = open && along >= d0 - LAB_WINDOW_EDGE && along < d0 + LAB_DOOR_W + LAB_WINDOW_EDGE;
  if (windows && !nearDoor && h >= LAB_WINDOW_LO && h < LAB_WINDOW_HI
      && along >= LAB_WINDOW_EDGE && along < LAB_ROOM - LAB_WINDOW_EDGE) return E_GLASS;
  return E_WALL;
}

// A station's extent along one side of its slot (slot cells long): its size,
// in [lo, hi] and inside the slot's margins, and where it starts.
int labSize(uint h, int k, int slot, int lo, int hi) {
  int room = slot - 2 * LAB_MARGIN;
  return thRange(thKey(h, k), min(lo, room), min(hi, room));
}
int labStart(uint h, int k, int slot, int size) {
  return thRange(thKey(h, k), LAB_MARGIN, slot - LAB_MARGIN - size);
}
int labPct(int n, int pct) { return thDiv(n * pct, LAB_PCT); }

// Each station below: the element at (px, py, pz), slot-local (py: height
// above the floor), in a slot sw × sd cells, of a station with hash h.

// A glass tank (open at the top).
int labTank(uint h, int sw, int sd, int px, int py, int pz) {
  int w = labSize(h, LAB_K_W, sw, LAB_TANK_MIN, LAB_TANK_MAX);
  int d = labSize(h, LAB_K_D, sd, LAB_TANK_MIN, LAB_TANK_MAX);
  int tx = px - labStart(h, LAB_K_X, sw, w), tz = pz - labStart(h, LAB_K_Z, sd, d);
  if (tx < 0 || tz < 0 || tx >= w || tz >= d) return E_EMPTY;
  int th = thRange(thKey(h, LAB_K_H), LAB_TANK_H_MIN, LAB_TANK_H_MAX);
  if (py >= th) return E_EMPTY;
  if (py < LAB_GLASS || tx < LAB_GLASS || tz < LAB_GLASS || tx >= w - LAB_GLASS || tz >= d - LAB_GLASS) return E_GLASS;
  int rim = th - LAB_FREEBOARD;
  int fill = min(labPct(th, thRange(thKey(h, LAB_K_FILL), LAB_TANK_FILL_LO, LAB_TANK_FILL_HI)), rim);
  int v = labPickTank(thKey(h, LAB_K_VARIANT));
  if (v == LAB_TANK_ACID) return py < fill ? E_ACID : E_EMPTY;
  if (v == LAB_TANK_OIL) return py < fill ? E_OIL : E_EMPTY;
  if (v == LAB_TANK_AQUARIUM) {
    if (py < LAB_GLASS + thRange(thKey(h, LAB_K_BED), LAB_BED_MIN, LAB_BED_MAX)) return E_SAND;
    return py < fill ? E_WATER : E_EMPTY;
  }
  // water, an oil slick on it and an ice cube through its surface (the box lab's)
  int inner = min(w, d) - 2 * LAB_GLASS;
  int c = thRange(thKey(h, LAB_K_ICE), LAB_ICE_MIN, max(LAB_ICE_MIN, thDiv(inner, LAB_ICE_SHARE_DIV)));
  if (c < inner) {
    int ix = tx - thRange(thKey(h, LAB_K_ICE_X), LAB_GLASS, w - LAB_GLASS - c);
    int iz = tz - thRange(thKey(h, LAB_K_ICE_Z), LAB_GLASS, d - LAB_GLASS - c);
    int iy = py - max(LAB_GLASS, fill - thDiv(c, LAB_ICE_SINK_DIV));
    if (ix >= 0 && iz >= 0 && iy >= 0 && ix < c && iz < c && iy < c) return E_ICE;
  }
  if (py < fill) return E_WATER;
  int slick = min(fill + thRange(thKey(h, LAB_K_SLICK), LAB_SLICK_MIN, LAB_SLICK_MAX), rim);
  return py < slick ? E_OIL : E_EMPTY;
}

// A lava pit: a WALL basin of lava under a metal plate, and something on the plate.
int labPit(uint h, int sw, int sd, int px, int py, int pz) {
  int w = labSize(h, LAB_K_W, sw, LAB_PIT_MIN, LAB_PIT_MAX);
  int d = labSize(h, LAB_K_D, sd, LAB_PIT_MIN, LAB_PIT_MAX);
  int tx = px - labStart(h, LAB_K_X, sw, w), tz = pz - labStart(h, LAB_K_Z, sd, d);
  if (tx < 0 || tz < 0 || tx >= w || tz >= d) return E_EMPTY;
  int ph = thRange(thKey(h, LAB_K_H), LAB_PIT_H_MIN, LAB_PIT_H_MAX);
  if (py < ph) {
    if (py < LAB_PIT_BED || tx < LAB_PIT_RIM || tz < LAB_PIT_RIM || tx >= w - LAB_PIT_RIM || tz >= d - LAB_PIT_RIM) return E_WALL;
    return E_LAVA;
  }
  if (!labYes(thKey(h, LAB_K_PLATE), LAB_PLATE_YES_CUT)) return E_EMPTY;
  if (py < ph + LAB_PLATE) return E_METAL;
  int q = max(LAB_TOP_INSET_MIN, labPct(min(w, d), LAB_TOP_INSET_PCT));
  int ux = tx - q, uz = tz - q, uy = py - ph - LAB_PLATE;
  int uw = w - 2 * q, ud = d - 2 * q;
  int top = labPickTop(thKey(h, LAB_K_TOP));
  int uh = thRange(thKey(h, LAB_K_TOP_H), LAB_TOP_H_MIN, LAB_TOP_H_MAX);
  if (top == LAB_TOP_NONE || ux < 0 || uz < 0 || ux >= uw || uz >= ud || uy >= uh) return E_EMPTY;
  if (top == LAB_TOP_SNOW) return E_SNOW;
  if (top == LAB_TOP_ICE) return E_ICE;
  if (top == LAB_TOP_GUNPOWDER) return E_GUNPOWDER;
  if (top == LAB_TOP_WOOD) return E_WOOD;
  // a little glass tank of water, filled to a cell below its rim
  if (uy < LAB_GLASS || ux < LAB_GLASS || uz < LAB_GLASS || ux >= uw - LAB_GLASS || uz >= ud - LAB_GLASS) return E_GLASS;
  return uy < uh - LAB_GLASS ? E_WATER : E_EMPTY;
}

// Wooden towers with gunpowder cores, in a row or grid centred in the slot,
// each with an oil puddle at its foot on its low-z side.
int labTowers(uint h, int sw, int sd, int px, int py, int pz) {
  int tw = thRange(thKey(h, LAB_K_W), LAB_TOWER_W_MIN, LAB_TOWER_W_MAX);
  int pitch = tw + LAB_TOWER_GAP;
  int ax = sw - 2 * LAB_MARGIN, az = sd - 2 * LAB_MARGIN - LAB_PUDDLE_D;
  int nx = clamp(thDiv(ax + LAB_TOWER_GAP, pitch), 1, LAB_TOWER_N);
  int nz = clamp(thDiv(az + LAB_TOWER_GAP, pitch), 1, LAB_TOWER_N);
  int cw = nx * pitch - LAB_TOWER_GAP, cd = nz * pitch - LAB_TOWER_GAP;
  int qx = px - LAB_MARGIN - thDiv(ax - cw, 2);
  int qz = pz - LAB_MARGIN - LAB_PUDDLE_D - thDiv(az - cd, 2);
  if (qx < 0 || qx >= cw) return E_EMPTY;
  int i = thDiv(qx, pitch), ux = qx - i * pitch;
  int j = thDiv(qz + LAB_PUDDLE_D, pitch), uz = qz - j * pitch;
  if (ux >= tw || j < 0 || j >= nz) return E_EMPTY;
  uint th = thKey(h, LAB_K_TOWER + i + LAB_TOWER_N * j);
  if (uz < 0) {
    int inset = min(LAB_PUDDLE_INSET, thDiv(tw - LAB_PUDDLE_W_MIN, 2));
    bool puddle = labYes(thKey(th, LAB_K_PUDDLE), LAB_TOWER_PUDDLE_YES_CUT);
    return puddle && py < LAB_PUDDLE_H && ux >= inset && ux < tw - inset ? E_OIL : E_EMPTY;
  }
  int height = thRange(thKey(th, LAB_K_H), LAB_TOWER_H_MIN, LAB_TOWER_H_MAX);
  if (uz >= tw || py >= height) return E_EMPTY;
  bool core = ux >= LAB_CORE_INSET && uz >= LAB_CORE_INSET && ux < tw - LAB_CORE_INSET && uz < tw - LAB_CORE_INSET
           && py >= LAB_CORE_BASE && py < height - LAB_CORE_TOP;
  return core ? E_GUNPOWDER : E_WOOD;
}

// A block of ice under a cap of snow.
int labBlock(uint h, int sw, int sd, int px, int py, int pz) {
  int w = labSize(h, LAB_K_W, sw, LAB_BLOCK_MIN, LAB_BLOCK_MAX);
  int d = labSize(h, LAB_K_D, sd, LAB_BLOCK_MIN, LAB_BLOCK_MAX);
  int tx = px - labStart(h, LAB_K_X, sw, w), tz = pz - labStart(h, LAB_K_Z, sd, d);
  if (tx < 0 || tz < 0 || tx >= w || tz >= d) return E_EMPTY;
  int bh = thRange(thKey(h, LAB_K_H), LAB_BLOCK_H_MIN, LAB_BLOCK_H_MAX);
  return py < bh ? E_ICE : py < bh + LAB_SNOW_CAP ? E_SNOW : E_EMPTY;
}

// A block hanging in the air over the slot (or none).
int labHang(uint sh, int sw, int sd, int px, int py, int pz) {
  uint h = thKey(sh, LAB_K_HANG);
  if (!labYes(h, LAB_SLOT_HANG_YES_CUT)) return E_EMPTY;
  int w = labSize(h, LAB_K_W, sw, LAB_HANG_MIN, LAB_HANG_MAX);
  int d = labSize(h, LAB_K_D, sd, LAB_HANG_MIN, LAB_HANG_MAX);
  int tx = px - labStart(h, LAB_K_X, sw, w), tz = pz - labStart(h, LAB_K_Z, sd, d);
  if (tx < 0 || tz < 0 || tx >= w || tz >= d) return E_EMPTY;
  int hh = thRange(thKey(h, LAB_K_H), LAB_HANG_H_MIN, LAB_HANG_H_MAX);
  int y0 = thRange(thKey(h, LAB_K_HANG_Y), LAB_HANG_LO, LAB_SKY - LAB_FLOOR - hh);
  if (py < y0 || py >= y0 + hh) return E_EMPTY;
  int m = labPickHang(thKey(h, LAB_K_STUFF));
  return m == LAB_HANG_SAND ? E_SAND : m == LAB_HANG_STONE ? E_STONE : m == LAB_HANG_SNOW ? E_SNOW : E_GUNPOWDER;
}

// How many slots a room of this layout has.
int labSlots(int lay) { return lay == LAB_LAYOUT_QUAD ? 4 : lay == LAB_LAYOUT_HALVES ? 2 : 1; }

// The element at world cell (x, y, z).
int labCell(int x, int y, int z) {
  if (y < LAB_FLOOR) return E_WALL;
  int py = y - LAB_FLOOR;
  if (y >= LAB_SKY) return E_EMPTY;
  if (x >= uLabWorldX - LAB_WALL || z >= uLabWorldZ - LAB_WALL) return py < LAB_WALL_H ? E_WALL : E_EMPTY;
  int rx = thDiv(x, LAB_ROOM), rz = thDiv(z, LAB_ROOM);
  int lx = x - rx * LAB_ROOM, lz = z - rz * LAB_ROOM;
  uint rh = labRoom(rx, rz);
  if (lx < LAB_WALL) return labWall(rh, 0, rx > 0, lz, py);
  if (lz < LAB_WALL) return labWall(rh, 1, rz > 0, lx, py);
  // the interior: which slot, and the cell in it
  int inner = LAB_ROOM - LAB_WALL, mid = thDiv(inner, 2);
  int ix = lx - LAB_WALL, iz = lz - LAB_WALL;
  int lay = labPickLayout(thKey(rh, LAB_K_LAYOUT));
  bool alongX = thRange(thKey(rh, LAB_K_AXIS), 0, 1) == 0;
  bool hiX = ix >= mid, hiZ = iz >= mid;
  int s = 0;
  int sw = inner, sd = inner, px = ix, pz = iz;
  if (lay == LAB_LAYOUT_QUAD || (lay == LAB_LAYOUT_HALVES && alongX)) {
    s = hiX ? 1 : 0;
    sw = hiX ? inner - mid : mid;
    px = hiX ? ix - mid : ix;
  }
  if (lay == LAB_LAYOUT_QUAD || (lay == LAB_LAYOUT_HALVES && !alongX)) {
    s = s + (hiZ ? 2 : 0);
    sd = hiZ ? inner - mid : mid;
    pz = hiZ ? iz - mid : iz;
  }
  uint sh = thKey(rh, LAB_K_SLOT + s);
  int kind = labPickStation(thKey(sh, LAB_K_KIND));
  int id = E_EMPTY;
  if (kind == LAB_STATION_TANK) id = labTank(sh, sw, sd, px, py, pz);
  else if (kind == LAB_STATION_PIT) id = labPit(sh, sw, sd, px, py, pz);
  else if (kind == LAB_STATION_TOWERS) id = labTowers(sh, sw, sd, px, py, pz);
  else if (kind == LAB_STATION_BLOCK) id = labBlock(sh, sw, sd, px, py, pz);
  if (id == E_EMPTY) id = labHang(sh, sw, sd, px, py, pz);
  return id;
}

// How much is going on in room (rx, rz): its stations' scores (start()).
int labRoomScore(int rx, int rz) {
  uint rh = labRoom(rx, rz);
  int n = labSlots(labPickLayout(thKey(rh, LAB_K_LAYOUT)));
  int score = 0;
  for (int s = 0; s < n; s++) {
    uint sh = thKey(rh, LAB_K_SLOT + s);
    int kind = labPickStation(thKey(sh, LAB_K_KIND));
    score += kind == LAB_STATION_TANK ? LAB_SCORE_TANK : kind == LAB_STATION_PIT ? LAB_SCORE_PIT
           : kind == LAB_STATION_TOWERS ? LAB_SCORE_TOWERS : kind == LAB_STATION_BLOCK ? LAB_SCORE_BLOCK : 0;
    if (labYes(thKey(sh, LAB_K_HANG), LAB_SLOT_HANG_YES_CUT)) score += LAB_SCORE_HANG;
  }
  return score;
}
`;

// start(): the room corners tried, within this many rooms of the world's centre
// (the window, centred on a corner, shows the four rooms around it).
const START_SEARCH = 3;

const twins = new Map();   // the JS twin per world (seed and size)
function twin(P) {
  const k = `${P.seed}:${P.size}`;
  if (!twins.has(k)) {
    twins.set(k, compileShared(SRC, P.seed, { ...jsConstants(P_, L), uLabWorldX: P.size[0], uLabWorldZ: P.size[2] }));
  }
  return twins.get(k);
}

export const LAB = L.ints;
export const labTwin = twin;   // (tools/scene-themed-preview.mjs)

export const labWorld = {
  key: 'labWorld',
  label: 'Lab world',
  params: ({ size, seed }) => ({ size, seed: seed >>> 0, sea: 0, floor: L.ints.FLOOR }),
  glsl: () => /* glsl */ `
${definesGLSL(P_, L)}
${helpersGLSL}
uniform int uLabWorldX;   // the world's size along x and z, cells
uniform int uLabWorldZ;
${SRC}
void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  int id = labCell(w.x, w.y, w.z);
  float ctype = id == E_LAVA ? float(E_STONE) : 0.0;   // lava remembers it was stone (the box lab's)
  float seed = float(seedWorld(w, uSceneSeed, LAB_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), SPAWNT[id], SPAWNLIFE[id], ctype + seed);
  B = vec4(0.0);
}
`,
  uniforms: (P) => ({
    uSceneSeed: { value: P.seed },
    uLabWorldX: { value: P.size[0] },
    uLabWorldZ: { value: P.size[2] },
  }),
  // the room corner near the world's centre with the most going on in the four rooms around it
  start(P) {
    const T = twin(P), R = L.ints.ROOM;
    const cx = Math.round(P.size[0] / 2 / R), cz = Math.round(P.size[2] / 2 / R);
    let best = null, bestScore = -1;
    for (let dz = -START_SEARCH; dz <= START_SEARCH; dz++)
      for (let dx = -START_SEARCH; dx <= START_SEARCH; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x * R >= P.size[0] || z * R >= P.size[2]) continue;
        const score = T.labRoomScore(x - 1, z - 1) + T.labRoomScore(x, z - 1) + T.labRoomScore(x - 1, z) + T.labRoomScore(x, z);
        if (score > bestScore) { bestScore = score; best = [x * R, z * R]; }
      }
    return best;
  },
  ground: (x, z, P) => groundScan(twin(P).labCell, x, z, L.ints.SKY),
};
