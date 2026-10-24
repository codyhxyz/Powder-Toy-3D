// The Mines kit (Noita's Kaivos, its first biome under the mountain).
//
// Noita's Mines are not tunnels in rock: they're one huge dark cavern full of
// stacked, floating earth shelves (a few cells thick, ragged, grass on top,
// roots hanging under), held up by timber posts and beams, joined by timber
// stairs, with mine carts on rails, water tanks, crates of gunpowder, dead
// miners and hanging lanterns all over them, loose sand masses slumping at the
// edges, gold and gems lower down and a flooded bottom (docs/descent-reference.md).
// So every tile here is a void, wall to wall and floor to ceiling, and what it
// holds is shelves and the stuff on them. The layer between two layers (the
// tiles' borders: 4 cells of rock) reads as one more shelf, grassed on top.
//
// What a tile holds varies per placement (kit.js variants: chance, weighted
// materials, `any`, scatter): no two shelves of crates or two water tanks
// hold the same. Nothing hot spawns next to what burns: the one lava is a
// sealed basin in the lowest layer with no timber near it.
//
// Format: kit.js (docs/wang-tiles.md). Canonical frame: x 0..48 (two units),
// y 0..24, z 0..24, cells of 0.30 m; a body is 5.5 tall and 1.6 wide, steps a
// cell and jumps about two. The border (2) is rock whatever a tile does; the
// floor is y = 2 and a shelf's top at the high doorways is y = 13.
import { GEOM } from '../kit.js';

// The Mines' doorways are the void going on: 16 wide and as tall as the tile,
// cut only through the border (Noita's Mines have no walls between rooms).
const MINES_GEOM = { DOOR_W: 16, DOOR_H: 19, PORT_DEPTH: 4, PORT_DEPTH_SIDE: 4 };
const G = { ...GEOM, ...MINES_GEOM };
const { U, H, BORDER: B, FLOOR: F, HIGH_FLOOR: HF } = G;
const X = 2 * U;                       // a tile's length
const TOP = H - B;                     // the ceiling's underside
const MID = U / 2;                     // the tile's middle line, z
const C0 = U / 2, C1 = U + U / 2;      // unit 0's and unit 1's centre, x
const SH = G.SHAFT_W / 2 + 2;          // keep features this far from a unit's centre where a shaft may open
const ALL = [[0, 0, 0], [X, H, U]];
const VOID_ROUGH = 1.6;                // cells of noise on the void's walls
const SHELF_ROUGH = 1.1;               // ...a shelf's ragged edges (Noita's shelves are torn earth)
const SHELF_THICK = 3;                 // a shelf's thickness under its top (Noita's: 2–6 cells)
const POST_STEP = 8;                   // timber posts under a shelf's edge, this far apart
const GRASS_COVER = 0.5;               // share of up-facing earth and rock with grass (moss) on it
const ROOT_N = 12;                     // roots hanging from shelves and the ceiling, per tile
const RAIL_GAUGE = G.RAIL_GAUGE;
const LOW_TOP = 4;                     // a low earth step's top: two over the floor, a jump up
const UPPER_TOP = 16;                  // the highest shelf a body stands on (6 cells under the ceiling)

// ---- helpers: each returns a list of primitives
// the void: the whole tile open, its walls ragged
// the void: the whole tile open, and (the tiles are `open`) on into its open neighbours, so
// the Mines are one cavern, not a grid of halls; rock and earth masses stand at some corners
// (where four tiles meet) and break the grid up
const CORNER_R = [4, 12, 4];           // a corner mass's radii (x, y, z)
const voidAll = () => [
  { box: [[0, F, 0], [X, H, U]], m: 'AIR' },
  ...[[0, 0], [X, 0], [0, U], [X, U]].map(([x, z]) => ({ ball: [[x, H / 2, z], CORNER_R], m: { ROCK: 2, SOFT: 1 }, rough: 2, chance: 0.5 })),
];
// a floating earth shelf, top at y over x0..x1 × z0..z1: torn edges, a flat top,
// timber beams along its long edges and posts down to the floor (or whatever is under)
function shelf(x0, x1, z0, z1, top, { thick = SHELF_THICK, posts = true, beams = true, m = 'SOFT' } = {}) {
  const out = [
    { box: [[x0, top - thick, z0], [x1, top, z1]], m, rough: SHELF_ROUGH, only: 'AIR' },
    { box: [[x0 - 2, top, z0 - 2], [x1 + 2, top + 2, z1 + 2]], m: 'AIR', only: m },   // a flat top to walk
  ];
  if (beams) {
    out.push({ box: [[x0, top - 1, z0], [x1, top, z0 + 1]], m: 'BEAM', appearance: 'plank-x' }, { box: [[x0, top - 1, z1 - 1], [x1, top, z1]], m: 'BEAM', appearance: 'plank-x' });
  }
  if (posts && top - thick > F + 1) {
    for (let x = x0 + 1; x < x1 - 1; x += POST_STEP) {
      for (const z of [z0, z1 - 1]) out.push({ box: [[x, F, z], [x + 1, top - 1, z + 1]], m: 'BEAM', appearance: 'plank-y', only: ['AIR', m] });
    }
    out.push(...[z0, z1 - 1].map((z) => ({ box: [[x1 - 2, F, z], [x1 - 1, top - 1, z + 1]], m: 'BEAM', appearance: 'plank-y', only: ['AIR', m] })));
  }
  return out;
}
// timber stairs from y0 up to top along x (rise +1: climbing toward +x), z0..z1 wide
const stairsX = (x0, z0, z1, y0, top, rise = 1) => {
  const run = top - y0;
  const a = rise > 0 ? x0 : x0 - run;
  return { stairs: [[a, y0, z0], [a + run, top, z1]], m: 'BEAM', appearance: 'plank-z', axis: 'x', rise };
};
const stairsZ = (z0, x0, x1, y0, top, rise = 1) => {
  const run = top - y0;
  const a = rise > 0 ? z0 : z0 - run;
  return { stairs: [[x0, y0, a], [x1, top, a + run]], m: 'BEAM', appearance: 'plank-x', axis: 'z', rise };
};
// grass on what faces up, roots and drips under what faces down: every tile ends with these
const growth = ({ cover = GRASS_COVER, roots = ROOT_N, fungus = 0 } = {}) => [
  { coat: ALL, m: 'MOSS', face: 'up', cover, only: ['ROCK', 'SOFT'] },
  ...(fungus ? [{ coat: ALL, m: 'FUNGUS', face: 'down', cover: fungus, only: ['ROCK', 'SOFT'] }] : []),
  { scatter: [[B, F, B], [X - B, TOP, U - B]], n: roots, on: 'ceiling', put: [{ box: [[0, -1, 0], [1, 1, 1]], m: 'PLANT', only: 'AIR' }] },
];
// a crate: a wooden box (4 cells) round what it holds (Noita's skull crates hold gunpowder)
const CRATE_FILL = { GUNPOWDER: 4, NUGGETS: 2, COAL: 2, TNT: 1, RUBBLE: 1 };
const crate = (fill = CRATE_FILL) => [
  { box: [[0, 0, 0], [4, 4, 4]], m: 'PLANKS', appearance: 'plank-x', only: 'AIR' },
  { box: [[1, 1, 1], [3, 3, 3]], m: fill },
];
// an explosive barrel: an iron drum of oil or gunpowder (Noita's red barrels)
const BARREL_FILL = { OIL: 3, GUNPOWDER: 2, WATER: 1 };
const barrel = (fill = BARREL_FILL) => [
  { cyl: [[1.5, 0, 1.5], 1.5, 4], m: 'METAL', axis: 'y', only: 'AIR' },
  { cyl: [[1.5, 1, 1.5], 0.7, 2.5], m: fill, axis: 'y' },
];
// a TNT box
const tnt = () => [{ box: [[0, 0, 0], [2, 2, 2]], m: 'TNT', only: 'AIR' }];
// a dead miner: meat and a splash of blood (Noita's corpses)
const remains = () => [
  { ball: [[0.5, 0.5, 0.5], [1.4, 0.8, 1]], m: 'MEAT', only: 'AIR' },
  { box: [[-2, 0, -2], [3, 1, 3]], m: 'BLOOD', only: 'AIR' },
];
// a small heap of gold nuggets
const nuggets = () => [{ ball: [[0.5, 0.5, 0.5], [1.2, 0.8, 1.2]], m: 'NUGGETS', only: 'AIR' }];
// scatter `put` over the shelf with top at y over x0..x1 × z0..z1
const onShelf = (x0, x1, z0, z1, top, n, put) => ({ scatter: [[x0 + 1, top, z0 + 1], [x1 - 1, top + 3, z1 - 1]], n, put });
// a water tank: a timber basin standing on a surface at y, full (Noita's water tanks on shelves)
const TANK_FILL = { WATER: 8, OIL: 2, BLOOD: 1, TOXIC: 1 };
const tank = (x0, x1, z0, z1, y, h = 4, fill = TANK_FILL) => [
  { box: [[x0, y, z0], [x1, y + h, z1]], m: 'PLANKS', appearance: 'plank-x' },
  { box: [[x0 + 1, y + 1, z0 + 1], [x1 - 1, y + h, z1 - 1]], m: fill },
];
// a mine cart on rails along x at y: an iron tub of ore
const CART_FILL = { GOLD: 2, NUGGETS: 2, COAL: 3, RUBBLE: 2 };
const cart = (x, y, zc = MID, fill = CART_FILL) => [
  { box: [[x, y + 1, zc - 2], [x + 6, y + 4, zc + 2]], m: 'METAL' },
  { box: [[x + 1, y + 2, zc - 1], [x + 5, y + 4, zc + 1]], m: fill },
  { box: [[x + 1, y, zc - 2], [x + 2, y + 1, zc + 2]], m: 'METAL' }, { box: [[x + 4, y, zc - 2], [x + 5, y + 1, zc + 2]], m: 'METAL' },
];
const railsX = (x0, x1, y = F, zc = MID) => [
  { box: [[x0, y, zc - RAIL_GAUGE / 2], [x1, y + 1, zc - RAIL_GAUGE / 2 + 1]], m: 'RAIL' },
  { box: [[x0, y, zc + RAIL_GAUGE / 2 - 1], [x1, y + 1, zc + RAIL_GAUGE / 2]], m: 'RAIL' },
];
// a light under a shelf or the ceiling at (x, y, z): a torch (the Mines' light: Noita's Mines
// are lit by torches and lanterns, warm, not by crystal) on a timber stick hung from it, its
// head (TORCH: elements.js WALL_TORCH, light and no heat: it sets nothing alight) at the
// stick's foot. Tagged so a light rule can find them all, and they go last: see the end.
const TORCH_STICK = 2;                 // cells of stick under the shelf
const lantern = (x, y, z) => [
  { box: [[x, y - TORCH_STICK, z], [x + 1, y, z + 1]], m: 'BEAM', appearance: 'plank-y', lantern: true },
  { box: [[x, y - TORCH_STICK - 1, z], [x + 1, y - TORCH_STICK, z + 1]], m: 'TORCH', lantern: true },
];
// a hanging chain: iron, cells down from the ceiling at (x, z)
const chain = (x, z, len) => ({ box: [[x, TOP - len, z], [x + 1, TOP, z + 1]], m: 'METAL', only: 'AIR' });
// gold threaded through the rock round the void (veins), and the odd nugget in the earth
const veins = (n = 2) => Array.from({ length: n }, (_, i) => ({
  capsule: [[4 + i * 20, 3 + (i % 2) * 14, 1], [20 + i * 18, 18 - (i % 2) * 12, 23], 1.1], m: 'GOLD', only: 'ROCK', rough: 1.4, chance: 0.6,
}));
// loose earth heaped against a wall (z0 side): Noita's sand masses, at their slope so they hold until dug
const slump = (x0, x1, h, m = { SAND: 3, GRAVEL: 1 }) => ({ ramp: [[x0, F, B], [x1, F + h, B + h + 2]], m, axis: 'z', rise: -1, only: 'AIR' });

const SIDES_OPEN = { N0: '-D', N1: '-D', S0: '-D', S1: '-D' };

const tiles = [
  // ---- the universal tile: a timber-shored hall, a ring of earth shelves at the high
  // doorways all round, stairs up to it on both sides. It takes any colour on any port.
  {
    name: 'shelf hall', weight: 0.8, variants: 3,
    ports: { W: 'DHR-', E: 'DHR-', N0: 'DHR-', N1: 'DHR-', S0: 'DHR-', S1: 'DHR-', D0: 'S-', D1: 'S-', U0: 'S-', U1: 'S-' },
    prims: [
      ...voidAll(),
      ...shelf(B, X - B, B, B + 6, HF), ...shelf(B, X - B, U - B - 6, U - B, HF),
      ...shelf(B, B + 6, B, U - B, HF, { beams: false }), ...shelf(X - B - 6, X - B, B, U - B, HF, { beams: false }),
      stairsX(18, B + 6, B + 9, F, HF, -1), stairsX(30, U - B - 9, U - B - 6, F, HF, 1),
      onShelf(B, X - B, B, B + 6, HF, 3, [{ any: [crate(), barrel(), remains(), nuggets()] }]),
      { any: [cart(21, F, MID), tank(20, 28, MID - 3, MID + 3, F, 3), [], remains()] },
      chain(24, MID, 6),
      lantern(C0, HF - SHELF_THICK, B + 3), lantern(C1, HF - SHELF_THICK, U - B - 4),
      ...growth(),
    ],
    sites: [{ kind: 'loot', at: [24, HF, B + 3] }],
  },
  // ---- shelf cavern: the Mines' commonest piece. Two or three ragged shelves at
  // different heights over an open floor, posts and stairs, stuff all over them.
  {
    name: 'shelf cavern', weight: 3, variants: 6,
    ports: { W: 'DR-', E: 'DR-', ...SIDES_OPEN, D0: '-S', D1: '-S', U0: '-S', U1: '-S' },
    prims: [
      ...voidAll(), ...veins(),
      {
        any: [
          [...shelf(6, 30, 3, 11, HF), ...shelf(22, 44, 14, 21, UPPER_TOP - 1), stairsX(30, 5, 8, F, HF, 1)],
          [...shelf(4, 22, 13, 21, HF), ...shelf(26, 44, 3, 10, HF), ...shelf(16, 34, 6, 13, UPPER_TOP, { posts: false }), stairsZ(4, 22, 25, F, HF, 1)],
          // a low earth ledge mid-floor, two jumps up (a step, then the ledge)
          [...shelf(8, 40, 15, 21, HF), ...shelf(18, 30, 6, 14, LOW_TOP + 2, { posts: false }), { box: [[30, F, 7], [33, LOW_TOP, 13]], m: 'SOFT' }],
        ],
      },
      { scatter: [[4, F, 3], [44, HF + 1, 21]], n: 4, put: [{ any: [crate(), barrel(), tnt(), remains(), nuggets(), nuggets()] }] },
      { scatter: [[4, F, 3], [44, F + 1, 21]], n: 2, put: [{ any: [remains(), nuggets(), [{ ball: [[0, 0, 0], [2.5, 1.5, 2.5]], m: { SAND: 2, RUBBLE: 2, GRAVEL: 1 }, only: 'AIR' }]] }] },
      { box: [[30, F, 16], [40, F + 2, 21]], m: { WATER: 4, OIL: 1, BLOOD: 1 }, only: 'AIR', chance: 0.35 },
      chain(18, 14, 5), chain(34, 8, 7),
      lantern(18, HF - SHELF_THICK, 6), lantern(34, UPPER_TOP - 1 - SHELF_THICK, 16),
      ...growth({ fungus: 0.12 }),
    ],
    sites: [{ kind: 'loot', at: [12, F, MID] }, { kind: 'gold', at: [36, F, 8] }],
  },
  // ---- the rail line: rails the tile's length on the floor, carts of ore on them, a shelf over
  {
    name: 'rail line', weight: 2, variants: 4,
    ports: { W: 'RD', E: 'RD', N1: '-D', S0: '-D', D0: '-S', U1: '-S' },
    prims: [
      ...voidAll(), ...veins(1),
      ...railsX(B, X - B),
      cart(6, F), { any: [cart(30, F), [], cart(36, F)] },
      ...shelf(4, 44, 16, 22, HF), stairsX(14, 16, 19, F, HF, -1),
      onShelf(4, 44, 16, 22, HF, 3, [{ any: [crate(), barrel(), crate({ COAL: 3, NUGGETS: 1 })] }]),
      { box: [[38, F, 3], [44, F + 3, 7]], m: { COAL: 2, RUBBLE: 1 }, rough: 0.8, only: 'AIR' },   // a spill of ore by the line
      lantern(24, HF - SHELF_THICK, 18),
      ...growth(),
    ],
  },
  // ---- the water tanks: timber basins on the floor and on a shelf; a pool in the floor's dip
  {
    name: 'water tanks', weight: 1.4, variants: 4,
    ports: { W: 'D-', E: 'D-', ...SIDES_OPEN },
    prims: [
      ...voidAll(),
      ...shelf(18, 44, 3, 11, HF),
      tank(24, 36, 4, 10, HF, 4), stairsX(18, 3, 6, F, HF, 1),
      tank(4, 12, 14, 21, F, 4),
      { box: [[16, F, 16], [30, F + 2, 21]], m: 'SOFT', rough: 0.7 },
      { box: [[18, F + 1, 17], [28, F + 2, 20]], m: { WATER: 5, OIL: 1, TOXIC: 1 } },   // a pool in the bank
      chain(14, 8, 6),
      lantern(30, HF - SHELF_THICK, 7),
      ...growth({ fungus: 0.25, cover: 0.65 }),   // damp: moss thick, fungus under the shelves
    ],
    sites: [{ kind: 'loot', at: [38, F, 16] }],
  },
  // ---- the powder store: crates of gunpowder, TNT and barrels stacked on and under a shelf
  // (Noita's skull crates: shoot one and the store goes up). Nothing hot near: no lantern.
  {
    name: 'powder store', weight: 1, variants: 4,
    ports: { W: 'D-R', E: 'D-R', S0: '-D', S1: '-D' },
    prims: [
      ...voidAll(),
      ...shelf(4, 44, 3, 10, HF), stairsX(30, 11, 14, F, HF, 1),
      onShelf(4, 44, 3, 10, HF, 6, [{ any: [crate({ GUNPOWDER: 1 }), crate(), tnt(), barrel({ OIL: 1, GUNPOWDER: 1 })], weights: [3, 2, 2, 2] }]),
      { scatter: [[4, F, 3], [44, F + 1, 10]], n: 4, put: [{ any: [crate({ GUNPOWDER: 1 }), tnt(), barrel()] }] },
      { ball: [[24, 18, 1], [8, 2, 2]], m: 'GUNPOWDER', only: 'ROCK', rough: 1, chance: 0.5 },   // a seam of powder in the rock
      { box: [[40, F, 16], [44, F + 1, 20]], m: 'GUNPOWDER', only: 'AIR', chance: 0.5 },          // a spilt heap
      ...growth({ roots: 6 }),
    ],
    sites: [{ kind: 'loot', at: [12, HF, 6] }],
  },
  // ---- the acid pit: a mound of earth with an acid-filled pit in it, glass-lined (acid eats
  // all but glass, gold and walls), gold at its bottom: get it out without dissolving
  {
    name: 'acid pit', weight: 0.7, variants: 2,
    ports: { W: 'D-', E: 'D-', N0: '-D', S0: '-D', N1: '-', S1: '-' },
    prims: [
      ...voidAll(),
      { box: [[16, F, B], [37, F + 7, U - B]], m: 'SOFT', rough: 0.6 },     // the mound, wall to wall
      { box: [[14, F + 7, B], [42, F + 9, U - B]], m: 'AIR', only: 'SOFT' },
      stairsX(9, 4, 8, F, F + 7, 1),                                         // up from the west, down to the east
      stairsX(44, 16, 20, F, F + 7, -1),          // (inside the doorway's cut)
      { box: [[21, F, 7], [35, F + 7, 17]], m: 'GLASS' },                   // the lining
      { box: [[22, F + 1, 8], [34, F + 7, 16]], m: 'ACID' },
      { box: [[25, F + 1, 10], [29, F + 2, 14]], m: 'GOLD' },               // the treasure
      { ball: [[31, F + 1.5, 12], [1.5, 1, 1.5]], m: 'NUGGETS' },
      { box: [[21, F + 7, 7], [35, F + 8, 8]], m: 'BEAM', appearance: 'plank-x' }, { box: [[21, F + 7, 16], [35, F + 8, 17]], m: 'BEAM', appearance: 'plank-x' },
      lantern(28, TOP, 4),
      ...growth({ roots: 8 }),
    ],
    sites: [{ kind: 'gold', at: [18, F + 7, 4] }, { kind: 'treasure', at: [38, F + 7, 19] }],
  },
  // ---- the sand slump: a huge loose mass heaped against the wall, a shelf and a cart
  // half buried in it (Noita's Mines' edges: earth that comes down when you dig)
  {
    name: 'sand slump', weight: 1, variants: 3,
    ports: { W: 'D-', E: 'D-', N0: '-', N1: '-', S0: '-D', S1: '-D' },
    prims: [
      ...voidAll(),
      slump(4, 44, 9),
      ...shelf(30, 44, 14, 21, HF), stairsX(30, 18, 21, F, HF, -1),
      { any: [cart(20, F + 3, 6), [], remains()] },
      onShelf(30, 44, 14, 21, HF, 2, [{ any: [crate(), nuggets()] }]),
      ...growth({ roots: 8 }),
    ],
  },
  // ---- the scaffold: a cross-braced timber tower floor to ceiling, platforms in it, stairs round
  {
    name: 'scaffold', weight: 1, variants: 3,
    ports: { W: 'D-R', E: 'D-R', ...SIDES_OPEN, D1: '-S', U1: '-S' },
    prims: [
      ...voidAll(),
      ...[[6, 4], [18, 4], [6, 14], [18, 14]].map(([x, z]) => ({ box: [[x, F, z], [x + 1, TOP, z + 1]], m: 'BEAM', appearance: 'plank-y' })),
      { capsule: [[6.5, F, 4.5], [18.5, HF - 1, 4.5], 0.5], m: 'BEAM', appearance: 'plank-x' }, { capsule: [[6.5, F, 14.5], [18.5, HF - 1, 14.5], 0.5], m: 'BEAM', appearance: 'plank-x' },
      { capsule: [[6.5, HF, 4.5], [18.5, TOP - 1, 4.5], 0.5], m: 'BEAM', appearance: 'plank-x' },
      { box: [[6, HF - 1, 4], [19, HF, 15]], m: 'PLANKS', appearance: 'plank-x' },                    // the platform
      stairsX(19, 8, 11, F, HF, -1),
      onShelf(6, 19, 4, 15, HF, 2, [{ any: [crate(), barrel(), nuggets(), remains()] }]),
      ...shelf(28, 44, 12, 21, UPPER_TOP - 2), stairsX(28, 12, 15, F, UPPER_TOP - 2, -1),
      { any: [cart(30, F, 6), tank(30, 40, 3, 9, F, 3), []] },
      chain(24, MID, 8),
      lantern(12, HF - 1, 9),
      ...growth(),
    ],
    sites: [{ kind: 'loot', at: [12, HF, 9] }],
  },
  // ---- dead miners' camp: a lantern, crates, the miners
  {
    name: 'miners camp', weight: 0.8, variants: 3,
    ports: { W: 'D-', E: 'D-', N1: '-D', S0: '-D', D0: '-S' },
    prims: [
      ...voidAll(), ...veins(2),
      ...shelf(26, 44, 3, 12, HF), stairsZ(13, 22, 25, F, HF, -1),
      { scatter: [[4, F, 3], [44, F + 1, 21]], n: 3, put: remains() },
      onShelf(26, 44, 3, 12, HF, 3, [{ any: [crate(), remains(), nuggets()] }]),
      ...[0, 1].map((i) => ({ box: [[28 + i * 6, F, 15], [32 + i * 6, F + 4, 19]], m: 'PLANKS', appearance: 'plank-x' })),   // crates by the wall
      lantern(34, HF - SHELF_THICK, 6), lantern(10, TOP, 16),
      ...growth({ fungus: 0.2 }),
    ],
    sites: [{ kind: 'loot', at: [38, HF, 6] }, { kind: 'wand', at: [20, F, 18] }],
  },
  // ---- a rare pool of one of Noita's magic liquids in an earth basin
  {
    name: 'magic pool', weight: 0.12,
    ports: { W: 'D-', E: 'D-', N0: '-D', S1: '-D' },
    prims: [
      ...voidAll(),
      { box: [[14, F, 6], [34, F + 4, 18]], m: 'SOFT', rough: 0.8 },
      { box: [[16, F + 1, 8], [32, F + 4, 16]], m: { TELEPORTATIUM: 2, LEVITATIUM: 2, BERSERKIUM: 2, HEALTHIUM: 2, WHISKEY: 2, POLYMORPHINE: 1 } },
      lantern(24, TOP, 11),
      ...growth({ cover: 0.7 }),
    ],
    sites: [{ kind: 'loot', at: [40, F, 12] }],
  },
  // ---- the flooded bottom: earth banks and standing water (only in the lowest layer),
  // and sometimes a sealed basin of lava in rock, no timber near it
  {
    name: 'flooded bottom', weight: 1.5, variants: 4, deepest: 1,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-', S1: '-' },
    prims: [
      ...voidAll(),
      // the walk along the north wall; the water stands in an earth bank to the south
      { box: [[4, F, 10], [44, F + 3, U - B]], m: 'SOFT', rough: 0.6 },
      { box: [[6, F + 1, 12], [42, F + 3, 20]], m: { WATER: 6, TOXIC: 1, MUD: 1 } },
      { any: [[{ ball: [[24, F + 1, 16], [6, 1.5, 3]], m: 'GOLD', only: 'SOFT' }], []] },
      ...growth({ fungus: 0.2, cover: 0.6 }),
      // sometimes a basin of lava sunk in rock in the bank (after the growth: no moss at its rim)
      { any: [[{ box: [[30, F, 13], [44, F + 6, 21]], m: 'ROCK' }, { box: [[32, F + 2, 15], [42, F + 5, 19]], m: 'LAVA' }], []], weights: [1, 2] },
    ],
    sites: [{ kind: 'gold', at: [8, F + 3, 4] }],
  },
  // ---- the hidden treasure nook: one way in, a crooked crawl, gold and a light at the end
  {
    name: 'treasure nook', weight: 2, open: false,
    ports: { E: 'D', W: '-', N0: '-', N1: '-', S0: '-', S1: '-' },
    prims: [
      { box: [[30, F, B], [X - B, TOP, U - B]], m: 'AIR', rough: VOID_ROUGH },
      { capsule: [[33, F + 3, MID], [22, F + 3, MID - 6], 3.2], m: 'AIR', rough: 0.8 },
      { box: [[8, F, 3], [24, 12, 13]], m: 'AIR', rough: 2.2 },
      { box: [[8, F - 1, 3], [24, F, 13]], m: 'ROCK' },
      { box: [[20, F - 1, 4], [32, F, 12]], m: 'ROCK' },
      { box: [[11, F, 5], [15, F + 2, 9]], m: 'GOLD' },
      { ball: [[17, F + 0.5, 10], [1.5, 1, 1.5]], m: 'NUGGETS', only: 'AIR' },
      lantern(10, 11, 4), lantern(22, 11, 9),
      ...growth({ roots: 6 }),
    ],
    sites: [{ kind: 'treasure', at: [13, F + 2, 7] }, { kind: 'wand', at: [18, F, 8] }],
  },
  // ---- a store off to the side: shelves of crates, gold on the floor
  {
    name: 'side store', weight: 1.4, variants: 2, open: false,
    ports: { S1: 'D', W: '-', E: '-', N0: '-', N1: '-', S0: '-' },
    prims: [
      { box: [[10, F, 4], [42, 14, U - B]], m: 'AIR', rough: 2.2 },
      { box: [[10, F - 1, 4], [42, F, 15]], m: 'ROCK' },
      { box: [[12, F, 5], [16, F + 4, 9]], m: 'PLANKS', appearance: 'plank-x' }, { box: [[13, F + 1, 6], [15, F + 3, 8]], m: { GUNPOWDER: 1, NUGGETS: 1 } },
      { box: [[12, F + 4, 5], [16, F + 7, 9]], m: 'PLANKS', appearance: 'plank-x' },
      { box: [[18, F, 5], [21, F + 2, 7]], m: 'GOLD' },
      lantern(26, 13, 5),
      ...growth({ roots: 4 }),
    ],
    sites: [{ kind: 'loot', at: [24, F, 10] }],
  },
];
// the lanterns go last in each tile (after the stuff they hang over)
for (const t of tiles) {
  t.open ??= true;
  const flat = t.prims.flat();
  t.prims = [...flat.filter((pr) => !pr.lantern), ...flat.filter((pr) => pr.lantern)];
}

export default {
  name: 'mines',
  // wall torches where the hung ones don't reach (kit.js placeTorches: pillars, the void's walls)
  // (and on posts at a shelf's rim where no wall takes one), one every ~20 cells
  torches: { every: 20, max: 3, lights: ['TORCH'], posts: true },
  // Noita's Mines: brown earth and dark rock, timber, a lot of it diggable
  palette: { ROCK: 'BASALT', SOFT: 'SANDSTONE', BEAM: 'PLANKS', RAIL: 'METAL', RUBBLE: 'RUBBLE' },
  geom: MINES_GEOM,
  loops: 0.7,          // Noita's Mines are one cavern: most neighbours open onto each other
  tiles,
};
