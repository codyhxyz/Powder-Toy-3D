// The Coal Pits kit (Noita's Hiilikaivos, the biome under the Mines), an open
// kit (geom.OPEN; kits/islands.js): a dark void full of floating, winding
// ribbons and blobs of grey rock streaked with coal and flecked with gold,
// thick enough to walk on. Water and toxic sludge sit in basins inside the
// blobs; loose powder heaps stand fenced in timber cages; planks bridge the
// gaps; scaffold towers stand in the void; a platform swings on chains over a
// drop with something on it; mine carts of coal stand on rails; red tufts of
// fungus grow on the tops (docs/descent-reference.md, from the Noita map).
//
// Then the Coal Pits' dangers, as Noita's: oil seeping out of the rock,
// gunpowder and TNT caches and powder kegs (cold: nothing burns near them),
// heaps of coal laid down burning (EMBER, off the main path, with no coal,
// timber or powder near), acid dripping from pockets in the blobs, lava
// pockets in the lowest layer only, an acid pit with treasure at its bottom,
// the remains of what came before (blood, meat, scrap of old machinery), and
// one rare pool of a magic liquid a level (Noita's rare pools).
//
// Canonical frame: x 0..48, y 0..24, z 0..24, cells of 0.30 m; a body is 5.5
// tall and 1.6 wide, steps a cell and jumps about two.
import {
  X, MID, C0, C1, SPINE, STRIP, stream, spineBody, spineDeck, plankX, blob, vein, basin, pocket, heap,
  post, barrel, cage, cart, railsX, scaffold, swing, openTiles,
  scatter, PLANK_SPUR,
} from './islands.js';

// Quadrants: the voids between the spine's ribbons, where the floating blobs go (canonical x, z)
const QX = [4, 24, 44], QZ = [4, 20];
const SCATTERED = 3;                   // extra blobs a tile scatters through its voids (islands.js scatter)
const LOW = SPINE - 4;                 // a low blob's top: a drop off the spine
const HIGH = 19;                       // a high blob's middle: over the void, out of the walkways' headroom
const GOLD_FLECKS = 7;                 // gold specks a tile scatters through its rock (Noita: gold everywhere in it)
const FLECK_R = 0.8;
const COAL_SEAMS = 3;                  // coal lenses through its rock
const EMBER_CLEAR = 9;                 // cells round a burning heap kept free of coal (rock only): it smoulders, it doesn't spread
const FUNGUS_TUFTS = 3;                // red fungus tufts on the tops

// the island stuff every tile has: the spine, its coal and gold, fungus on the tops
function island(seed, { holes = [0, 1], gap = null, spurs = [0, 1], blobs = [], extra = [], dress = [] } = {}) {
  const r = stream(seed);
  const planked = [0, 1].filter(() => r() < PLANK_SPUR);
  const body = spineBody(r, { holes, gap, spurs, planked });
  const veins = [];
  for (let n = 0; n < COAL_SEAMS; n++) veins.push(vein([r.between(2, X - 2), SPINE - r.between(2, 5), r.between(4, 20)], [r.between(5, 10), 1.3, r.between(2, 4)], 'COAL'));
  for (let n = 0; n < GOLD_FLECKS; n++) veins.push(vein([r.between(1, X - 1), r.between(1, SPINE - 2), r.between(1, 23)], [FLECK_R, FLECK_R, FLECK_R], 'GOLD', ['ROCK', 'COAL'], 0.5));
  const tufts = [];
  for (let n = 0; n < FUNGUS_TUFTS; n++) {
    // on the spine's edge (not the walkway's middle): x along it, either side
    tufts.push({ ball: [[r.between(3, X - 3), SPINE, MID + r.pick([-1, 1]) * (STRIP - 0.5)], [0.9, 1.4, 0.9]], m: 'FUNGUS', only: 'AIR' });
  }
  return [...body, ...scatter(r, SCATTERED), ...blobs, ...veins, ...extra, ...spineDeck({ holes, gap, spurs, planked }), ...dress, ...tufts];
}
const low = (qx, qz, r = [6, 3, 5]) => blob([QX[qx], LOW - r[1] + 1, QZ[qz]], r);
const high = (qx, qz, r = [6, 2.5, 4]) => blob([QX[qx], HIGH, QZ[qz]], r);
// a deck site (loot) on the spine, beside the walkway's middle
const onSpine = (x, side = -1) => ({ kind: 'loot', at: [x, SPINE, MID + side * 2] });

const tiles = openTiles([
  // ---- the universal tile: the ribbons ring both units' centres round holes into the
  // layer below; it takes any colour on any port
  {
    name: 'coal rings', weight: 0.6,   // (every open tile takes any colour: openTiles)
    prims: island(101, { blobs: [high(1, 0), low(1, 1)], dress: [heap(24, LOW, 20, 2.5, 'BROKENCOAL')] }),
    sites: [onSpine(24)],
  },
  // ---- a plank across a break in the ribbon, sludge in a blob below it
  {
    name: 'plank gap', weight: 2,
    prims: island(102, { gap: [18, 30],
      blobs: [low(1, 1, [7, 3.5, 5]), low(1, 0, [5, 3, 4]), high(0, 1)],
      extra: [basin(24, LOW, 20, 4, 2, 3, 'TOXIC'), pocket([22, LOW - 3, 4], [2, 1.5, 2], 'WATER')],
      dress: [plankX(16, 32), post(19, MID - 3, LOW - 2, SPINE - 1), post(28, MID + 2, LOW - 2, SPINE - 1)],
    }),
  },
  // ---- gold-rich blobs: veins of gold through them, nuggets spilled on their tops
  {
    name: 'gold blobs', weight: 1.4,
    prims: island(103, {
      blobs: [low(1, 0, [7, 3, 5]), low(2, 1), high(1, 1)],
      extra: [{ capsule: [[18, 1, 2], [30, LOW, 6], 1], m: 'GOLD', only: ['ROCK', 'COAL'], rough: 1 },
        vein([44, LOW - 2, 20], [3, 1.5, 2], 'GOLD', ['ROCK', 'COAL'])],
      dress: [heap(24, LOW, 4, 2, 'NUGGETS'), heap(42, LOW, 19, 1.5, 'NUGGETS'), heap(26, SPINE, MID - 3, 1, 'NUGGETS')],
    }),
    sites: [{ kind: 'gold', at: [24, LOW + 1, 6] }, onSpine(30, 1)],
  },
  // ---- a big blob holding a sludge basin and a water pocket, moss round the water
  {
    name: 'sludge basin', weight: 1.4,
    prims: island(104, {
      blobs: [blob([22, LOW - 1, 20], [10, 4, 5]), low(0, 0), high(2, 0)],
      extra: [basin(22, LOW, 20, 7, 2.5, 3.5, 'TOXIC'), basin(4, LOW, 4, 3, 1.5, 3, 'WATER'),
        vein([4, LOW, 4], [4.5, 1, 4], 'MOSS')],
    }),
    sites: [onSpine(10, 1)],
  },
  // ---- the miners' powder: gunpowder fenced in timber cages, a TNT crate, powder kegs, all cold
  {
    name: 'powder cages', weight: 1.1,
    prims: island(105, {
      blobs: [low(1, 0, [8, 3, 5]), low(1, 1, [8, 3, 5])],
      dress: [...cage(22, LOW, 4, 2.5, 'GUNPOWDER'), ...cage(26, LOW, 20, 2.5, 'GUNPOWDER'),
        { box: [[18, LOW, 18], [21, LOW + 3, 21]], m: 'TNT' }, { box: [[17, LOW, 17], [22, LOW + 1, 22]], m: 'WOOD', only: 'AIR' },
        ...barrel(30, LOW, 5, 'GUNPOWDER'), ...barrel(44, SPINE, MID - 3, 'OIL'), ...barrel(4, SPINE, MID + 3, 'GUNPOWDER')],
    }),
    sites: [onSpine(24)],
  },
  // ---- a cart line: rails along the ribbon, carts of coal, a coal pile beside them
  {
    name: 'cart line', weight: 1.4,
    prims: island(106, {
      blobs: [low(2, 1), high(1, 0)],
      dress: [...railsX(22, X, MID + 2), ...cart(24, SPINE + 1, MID + 2), ...cart(38, SPINE + 1, MID + 2, 'SCRAP'),
        heap(44, LOW, 20, 3, 'BROKENCOAL'), heap(30, SPINE, MID - 3, 1.2, 'BROKENCOAL')],
    }),
    sites: [onSpine(32, -1)],
  },
  // ---- a scaffold tower standing in the void from a low blob, a plank bridge past it
  {
    name: 'scaffold void', weight: 1.2,
    prims: island(107, { gap: [17, 30],
      blobs: [blob([24, 1, 20], [7, 2, 4]), high(0, 0)],
      dress: [plankX(15, 32), ...scaffold(20, 17, 3, SPINE, 5), post(20, MID + 2, 3, SPINE - 1), post(25, MID + 2, 3, SPINE - 1),
        heap(26, 3, 21, 1.5, 'BROKENCOAL')],
    }),
    sites: [{ kind: 'loot', at: [22, SPINE, 19] }],
  },
  // ---- a platform swinging on chains under a high blob, over a drop, with something on it
  {
    name: 'swing', weight: 1,
    prims: island(108, {
      blobs: [blob([26, 21, 20], [9, 2.5, 4]), low(2, 0)],
      dress: [...swing(20, 10, 19, SPINE - 2, 20)],
    }),
    sites: [{ kind: 'wand', at: [25, SPINE - 2, 19] }],
  },
  // ---- old machinery: iron girders, scrap heaps, oil barrels, oil seeping from the rock
  {
    name: 'machinery', weight: 1,
    prims: island(109, {
      blobs: [low(1, 0, [8, 3, 5]), high(1, 1)],
      extra: [pocket([24, LOW - 1, 1.5], [3, 2, 2], 'OIL')],
      dress: [{ box: [[16, LOW, 2], [32, LOW + 1, 3]], m: 'METAL' }, post(17, 2, LOW, LOW + 6, 'METAL'), post(30, 2, LOW, LOW + 6, 'METAL'),
        { box: [[17, LOW + 6, 2], [31, LOW + 7, 3]], m: 'METAL' },
        heap(22, LOW, 6, 2.5, 'SCRAP'), heap(28, LOW, 5, 1.5, 'SCRAP'), ...barrel(10, SPINE, MID - 3, 'OIL'), ...barrel(13, SPINE, MID - 3, 'OIL')],
    }),
    sites: [onSpine(40, 1)],
  },
  // ---- what came before: blood pooled in a blob, meat, fungus over it all
  {
    name: 'remains', weight: 0.8,
    prims: island(110, {
      blobs: [low(0, 1, [7, 3, 4]), low(1, 0)],
      extra: [basin(5, LOW, 20, 3.5, 1.2, 2.5, 'BLOOD'), vein([24, LOW, 4], [5, 1, 3], 'FUNGUS')],
      dress: [heap(8, LOW, 18, 1.6, 'MEAT'), heap(24, LOW, 5, 1.2, 'MEAT'), heap(18, SPINE, MID + 3, 0.9, 'MEAT')],
    }),
    sites: [onSpine(20, -1)],
  },
  // ---- the acid pit: a deep basin of acid in a great blob, gold and nuggets at its bottom
  // (acid can't touch gold); a plank runs over it for a look down
  {
    name: 'acid pit', weight: 0.6, max: 3,
    prims: island(111, {
      spurs: [0, 1],
      blobs: [blob([24, LOW - 1, 20], [10, LOW, 5])],
      extra: [basin(24, LOW, 20, 6, LOW - 1, 3.5, 'ACID'),
        { box: [[22, 1, 19], [26, 2, 21]], m: 'GOLD' }, { ball: [[24, 2, 20], [2.5, 1, 1.5]], m: 'NUGGETS', only: 'ACID' }],
      dress: [plankX(18, 30, 20, LOW + 1)],
    }),
    sites: [{ kind: 'treasure', at: [24, 2, 20] }, { kind: 'wand', at: [23, 2, 20] }],
  },
  // ---- acid in pockets under a high blob, dripping onto a low one
  {
    name: 'acid drips', weight: 0.6,
    prims: island(112, {
      blobs: [blob([28, 19, 20], [8, 3, 4]), low(1, 1)],
      extra: [pocket([26, 16.5, 20], [1.6, 1.2, 1.6], 'ACID'), pocket([31, 16.5, 19], [1.2, 1, 1.2], 'ACID')],
    }),
  },
  // ---- oil seeping out of cut rock into puddles on a blob
  {
    name: 'oil seeps', weight: 0.8,
    prims: island(113, {
      blobs: [low(1, 0, [8, 3.5, 5]), low(0, 1)],
      extra: [pocket([18, LOW + 1, 1], [2.5, 2, 2], 'OIL'), basin(26, LOW, 4, 3, 1, 2, 'OIL'), basin(4, LOW, 20, 2.5, 1, 2.5, 'WATER')],
    }),
    sites: [onSpine(28, 1)],
  },
  // ---- coal laid down burning (EMBER): a smouldering heap on a bare-rock blob off the main
  // path, no coal, timber or powder within EMBER_CLEAR cells
  {
    name: 'burning coal', weight: 0.25, offPath: true,
    prims: [
      ...island(114, { blobs: [blob([24, LOW - 2, 20], [8, 3, 4])] }),
      vein([24, LOW, 20], [EMBER_CLEAR + 4, EMBER_CLEAR, EMBER_CLEAR], 'ROCK', ['COAL', 'GOLD', 'FUNGUS'], 0),
      { box: [[14, SPINE, 15], [34, SPINE + 3, 24]], m: 'AIR', only: 'FUNGUS' },
      { ball: [[24, LOW, 20], [3, 1.8, 2]], m: 'EMBER', only: 'AIR' },
    ],
  },
  // ---- a lava pocket in a blob of bare rock: the lowest layer only, off the main path
  {
    name: 'lava pocket', weight: 1.5, deepest: 1, offPath: true,
    prims: [
      ...island(115, { blobs: [blob([24, LOW - 1, 20], [9, 4, 4.5])] }),
      vein([24, LOW, 20], [EMBER_CLEAR + 4, EMBER_CLEAR, EMBER_CLEAR], 'ROCK', ['COAL', 'GOLD', 'FUNGUS'], 0),
      { box: [[12, SPINE, 15], [36, SPINE + 3, 24]], m: 'AIR', only: 'FUNGUS' },
      basin(24, LOW, 20, 5, 2.5, 2.5, 'LAVA'),
    ],
  },
  // ---- the rare pool (Noita's): one a level, a basin of teleportatium in a blob, a crystal over it
  {
    name: 'rare pool', weight: 0.5, max: 1,
    prims: island(116, {
      blobs: [blob([24, LOW - 1, 20], [8, 3.5, 4.5])],
      extra: [basin(24, LOW, 20, 5, 2, 3, 'TELEPORTATIUM')],
      dress: [{ ball: [[24, 23, 20], [1.4, 2, 1.4]], m: 'CRYSTAL' }],
    }),
    sites: [onSpine(24, 1)],
  },
  // ---- plain ribbons with a TNT crate and a red rubble heap (brick, from older workings)
  {
    name: 'coal ribbons', weight: 2.2,
    prims: island(117, {
      blobs: [low(2, 0), high(1, 1), low(1, 1, [5, 2.5, 3])],
      dress: [{ box: [[42, LOW, 3], [45, LOW + 3, 6]], m: 'TNT' }, ...cage(24, LOW, 20, 2, 'RUBBLE', 3), heap(30, SPINE, MID + 3, 1.3, 'BROKENCOAL')],
    }),
  },
]);

export default {
  name: 'coal',
  geom: { OPEN: 1, SPINE },
  palette: {
    ROCK: 'ROCK', COAL: 'COAL', BEAM: 'WOOD', RAIL: 'METAL', METAL: 'METAL',
    RUBBLE: 'RUBBLE', GRAVEL: 'STONE', SAND: 'BROKENCOAL', WATER: 'WATER', GOLD: 'GOLD', CRYSTAL: 'CRYSTAL',
  },
  // coal laid down burning (it lights at 450 °C, elements.js COAL)
  temps: { EMBER: 600 },
  tiles,
};
