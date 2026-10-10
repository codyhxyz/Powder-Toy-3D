import { E, ELEMENTS } from '../../elements.js';
import { WORLD_SIZE } from '../../shaders/far.js';

// The giant lab: the box lab (presets.js 'lab') blown up to fill the world.
// The same glass tank of water with an oil slick and an ice cube, the lava pit
// under a metal plate with snow on it, the wooden tower with a gunpowder core
// and an oil puddle at its foot, and the sand pile hanging in the air, about
// to fall.
//
// Scales. Across, the layout is the box's times the world's width in boxes
// (1024 / 128 = 8): the tank is 125 m wide. Up, the world is only 128 cells
// (38 m), so the box's heights are stretched as far as fits instead: the box's
// highest point (the sand pile's top, 90 of 128) lands LAB_HEADROOM below the
// world's top, over a LAB_FLOOR-cell floor. That is 1.2 cells per box cell,
// so the tank is 48 cells (14 m) tall and its water 8 m deep, and the hanging
// sand falls 25 m. The headroom is where the steam off the pit and the smoke
// of a burning tower gather.
//
// Thicknesses aren't layout, so they don't scale with it: they are what the
// matter is at this size.
//   - The tank's glass is GLASS_WALL cells (0.6 m), not 1 or 8: real aquarium
//     panels holding 8-10 m of water are about that thick (the Okinawa
//     Churaumi tank's acrylic is 60 cm for 10 m of water). One cell would be a
//     30 cm skin on a 125 m pool, and 8 would be 2.4 m of glass that dims the
//     view into the tank (glass takes ~5% of the light per cell, SIGMA).
//   - The pit's wall is WALL (indestructible), so its thickness is looks only:
//     the box's 2 cells.
//   - The tower's wood is TOWER_SHELL cells on every side: thick enough to
//     read as a solid block in the far field (a whole brick), thin enough that
//     a fire burns through to the gunpowder as soon as it does in the box.
//   - The metal plate and the snow keep their scaled heights (2 and 5 cells),
//     so the plate heats through and the snow melts on it as in the box.
//
// A pure function of the world cell: the layout is a list of boxes painted in
// order (later ones win, as the preset's box() calls do). The GLSL's #defines
// and if-chain and the JS twin (labId, ground) are both made from that one
// list, so the GPU and the CPU can't disagree.

const [WX, WY, WZ] = WORLD_SIZE;

// The box the preset is laid out in, in its own cells (s = 1).
const BOX_N = 128;
// Its layout (presets.js 'lab'), box cells. x and z extents as [lo, hi), heights from its floor.
const TANK = { lo: 10, hi: 62, top: 40 };                  // glass tank: x and z, its rim
const WATER_TOP = 24;                                      // the tank's water...
const OIL_TOP = 28;                                        // ...and the oil slick on it
const ICE = { lo: 18, hi: 28, bottom: 21, top: 31 };       // the ice cube in it, astride the slick (box: t0 + 8 .. t0 + 18)
const PIT = { lo: 76, hi: 116, top: 10 };                  // the lava pit: x and z, its rim
const PLATE_TOP = 12;                                      // the metal plate over it
const PIT_SNOW = { lo: 88, hi: 104, top: 16 };             // the snow on the plate (box: l0 + 12 .. l1 - 12)
const TOWER = { x0: 20, x1: 34, z0: 80, z1: 94, top: 50 }; // the wooden tower
const PUDDLE = { x0: 25, x1: 29, z0: 74, z1: 80, top: 3 }; // the oil puddle at its foot (box: w0 + 5 .. w1 - 5, zz0 - 6 .. zz0)
const SAND = { x0: 70, x1: 100, z0: 20, z1: 50, bottom: 70, top: 90 };   // the hanging sand pile
const BOX_TOP = SAND.top;                                  // the layout's highest point

// The giant's own numbers, world cells.
export const LAB_FLOOR = 4;       // a WALL floor under everything: one brick, so the far field reads it as solid
const LAB_HEADROOM = 16;          // open air over the highest point (the sand's top) for steam and smoke to gather
const GLASS_WALL = 2;             // the tank's glass (see the top)
const PIT_WALL = 2;               // the lava pit's wall (the box's)
const TOWER_SHELL = 4;            // the tower's wood around its gunpowder core (see the top)
const LAB_XZ = WX / BOX_N;        // world cells per box cell across: the world is 8 boxes wide
const LAB_V = (WY - LAB_HEADROOM - LAB_FLOOR) / BOX_TOP;   // world cells per box cell up (1.2)
const LAB_SALT = 0x91a7b;         // seed stream of its cells' colour seeds

const xz = (b) => b * LAB_XZ;                          // a box x or z, in world cells
const up = (b) => LAB_FLOOR + Math.round(b * LAB_V);   // a box height, in world cells

// The layout: boxes [lo, hi) of world cells, painted in this order (the preset's).
const tankIn = [xz(TANK.lo) + GLASS_WALL, up(0) + GLASS_WALL, xz(TANK.lo) + GLASS_WALL];
const tankInHi = (top) => [xz(TANK.hi) - GLASS_WALL, up(top), xz(TANK.hi) - GLASS_WALL];
const pitIn = [xz(PIT.lo) + PIT_WALL, up(0), xz(PIT.lo) + PIT_WALL];
const pitInHi = [xz(PIT.hi) - PIT_WALL, up(PIT.top), xz(PIT.hi) - PIT_WALL];
export const LAB_BOXES = [
  { name: 'FLOOR', id: E.WALL, lo: [0, 0, 0], hi: [WX, LAB_FLOOR, WZ] },
  // glass tank of water with an oil slick and an ice cube, open at the top
  { name: 'TANK', id: E.GLASS, lo: [xz(TANK.lo), up(0), xz(TANK.lo)], hi: [xz(TANK.hi), up(TANK.top), xz(TANK.hi)] },
  { name: 'TANK_IN', id: E.EMPTY, lo: tankIn, hi: tankInHi(TANK.top) },
  { name: 'WATER', id: E.WATER, lo: tankIn, hi: tankInHi(WATER_TOP) },
  { name: 'OIL', id: E.OIL, lo: [tankIn[0], up(WATER_TOP), tankIn[2]], hi: tankInHi(OIL_TOP) },
  { name: 'ICE', id: E.ICE, lo: [xz(ICE.lo), up(ICE.bottom), xz(ICE.lo)], hi: [xz(ICE.hi), up(ICE.top), xz(ICE.hi)] },
  // lava pit (its lava remembers it was stone) under a metal plate with snow on top
  { name: 'PIT', id: E.WALL, lo: [xz(PIT.lo), up(0), xz(PIT.lo)], hi: [xz(PIT.hi), up(PIT.top), xz(PIT.hi)] },
  { name: 'LAVA', id: E.LAVA, ctype: E.STONE, lo: pitIn, hi: pitInHi },
  { name: 'PLATE', id: E.METAL, lo: [xz(PIT.lo), up(PIT.top), xz(PIT.lo)], hi: [xz(PIT.hi), up(PLATE_TOP), xz(PIT.hi)] },
  { name: 'PIT_SNOW', id: E.SNOW, lo: [xz(PIT_SNOW.lo), up(PLATE_TOP), xz(PIT_SNOW.lo)],
    hi: [xz(PIT_SNOW.hi), up(PIT_SNOW.top), xz(PIT_SNOW.hi)] },
  // wooden tower with a gunpowder core, and an oil puddle at its foot
  { name: 'TOWER', id: E.WOOD, lo: [xz(TOWER.x0), up(0), xz(TOWER.z0)], hi: [xz(TOWER.x1), up(TOWER.top), xz(TOWER.z1)] },
  { name: 'CORE', id: E.GUNPOWDER, lo: [xz(TOWER.x0) + TOWER_SHELL, up(0) + TOWER_SHELL, xz(TOWER.z0) + TOWER_SHELL],
    hi: [xz(TOWER.x1) - TOWER_SHELL, up(TOWER.top) - TOWER_SHELL, xz(TOWER.z1) - TOWER_SHELL] },
  { name: 'PUDDLE', id: E.OIL, lo: [xz(PUDDLE.x0), up(0), xz(PUDDLE.z0)], hi: [xz(PUDDLE.x1), up(PUDDLE.top), xz(PUDDLE.z1)] },
  // sand pile hanging in the air, about to fall
  { name: 'SAND', id: E.SAND, lo: [xz(SAND.x0), up(SAND.bottom), xz(SAND.z0)], hi: [xz(SAND.x1), up(SAND.top), xz(SAND.z1)] },
];
for (const b of LAB_BOXES) {
  if (b.hi[1] > WY - LAB_HEADROOM) throw new Error(`giant lab: ${b.name} reaches ${b.hi[1]}, into the headroom`);
}

// It starts on the snow's corner nearest the tank: the window holds a quarter
// of the snow on the plate, which the lava under it heats until the snow melts
// and boils off, and the god view (looking from +x +z, island.js
// ISLAND_VIEW_XZ) sees the rest of the lab ahead of it in the far field: the
// tank straight on, the sand pile to the right, the tower to the left.
const LAB_START = [xz(PIT_SNOW.lo), xz(PIT_SNOW.lo)];

// The element at world cell (x, y, z), and its ctype: the JS twin of sceneCell.
export function labCell(x, y, z) {
  let cell = { id: E.EMPTY, ctype: 0 };
  for (const b of LAB_BOXES) {
    if (x >= b.lo[0] && y >= b.lo[1] && z >= b.lo[2] && x < b.hi[0] && y < b.hi[1] && z < b.hi[2]) cell = b;
  }
  return { id: cell.id, ctype: cell.ctype ?? 0 };
}

const v3 = (a) => `ivec3(${a.join(', ')})`;
const glsl = () => /* glsl */ `
${LAB_BOXES.map((b) => `#define GLAB_${b.name}_LO ${v3(b.lo)}\n#define GLAB_${b.name}_HI ${v3(b.hi)}`).join('\n')}
#define GLAB_SALT ${LAB_SALT}u
uniform uint uSceneSeed;
bool glabIn(ivec3 w, ivec3 lo, ivec3 hi) { return all(greaterThanEqual(w, lo)) && all(lessThan(w, hi)); }
void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  int id = E_EMPTY;
  float ctype = 0.0;
${LAB_BOXES.map((b) => `  if (glabIn(w, GLAB_${b.name}_LO, GLAB_${b.name}_HI)) { id = E_${ELEMENTS[b.id].key}; ctype = ${b.ctype ? `float(E_${ELEMENTS[b.ctype].key})` : '0.0'}; }`).join('\n')}
  float seed = float(seedWorld(w, uSceneSeed, GLAB_SALT)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), SPAWNT[id], SPAWNLIFE[id], ctype + seed);
  B = vec4(0.0);
}
`;

export const giantLab = {
  key: 'giantLab',
  label: 'Giant lab',
  params: ({ size, seed }) => ({ size, seed, sea: 0, floor: LAB_FLOOR }),
  glsl,
  uniforms: (P) => ({ uSceneSeed: { value: P.seed } }),
  start: () => [...LAB_START],
  // the top of the topmost matter in the column (the hanging sand counts)
  ground(x, z) {
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let y = WY - 1; y >= 0; y--) if (labCell(cx, y, cz).id !== E.EMPTY) return y + 1;
    return 0;
  },
};
