// The Snowy Depths kit (Noita's Lumen alla, the third biome down), an open kit
// (geom.OPEN; kits/islands.js): a dark void full of floating islands of rock
// marbled with ice, snow on every top, every underside fringed with long
// icicles; dark water held in pockets inside them; wooden cabins hung on
// chains in the void with gold and a frozen body inside (treasure rooms);
// plank bridges, snow drifts, the brick ruins of an older people
// (docs/descent-reference.md, from the Noita map).
//
// The Snowy Depths scene holds every cell at −15 °C (descent/scenes.js COLD_T),
// so what is liquid here is what stays liquid at −15: saltwater (it freezes at
// −21 °C), whiskey (−23 °C), liquid nitrogen. Water and the potions would
// freeze, so the kit lays them down above freezing (temps): a frozen lake's
// water under its ice lid, Noita's whiskey and healthium caches in timber
// barrels (timber insulates), the rare pool in a timber-lined basin. Liquid
// nitrogen and dry ice lie in pockets off the main path.
//
// Canonical frame: x 0..48, y 0..24, z 0..24, cells of 0.30 m; a body is 5.5
// tall and 1.6 wide, steps a cell and jumps about two.
import {
  X, U, MID, C0, C1, SPINE, STRIP, stream, spineBody, spineDeck, plankX, blob, vein, basin, pocket, heap,
  post, barrel, openTiles, spineStrips,
  scatter,
} from './islands.js';

const QX = [4, 24, 44], QZ = [4, 20];   // the voids between the ribbons (canonical x, z)
const SCATTERED = 3;                     // extra blobs a tile scatters through its voids (islands.js scatter)
const LOW = SPINE - 4;                   // a low blob's top: a drop off the spine
const HIGH = 19;                         // a high blob's middle, over a void
const MARBLE = 5;                        // streaks of ice through a tile's rock (Noita's marbled islands)
const ICICLES = 14;                      // icicles hung under a tile's ribbons and blobs
const ICICLE_LEN = [3, 8];               // ...their length (cells): long, as Noita's
const ICICLE_R = 0.8;
const SNOW_T = 1;                        // cells of snow on every walked top
const SHAFT_CLEAR = 6;                   // nothing hangs within this of a unit's centre (a shaft's fall)
const FLECKS = 4;                        // gold specks through the rock

const nearShaft = (x, z) => Math.abs(z - MID) < SHAFT_CLEAR && (Math.abs(x - C0) < SHAFT_CLEAR || Math.abs(x - C1) < SHAFT_CLEAR);
// an icicle hanging from whatever is over (x, z) at y: a spindle of ice grown down out of the island
const icicle = (x, z, y, len) => (nearShaft(x, z) ? null : { capsule: [[x, y, z], [x, y - len, z], ICICLE_R], m: 'ICE', only: 'AIR' });

function island(seed, { gap = null, blobs = [], hangers = [], extra = [], dress = [] } = {}) {
  const r = stream(seed);
  const body = spineBody(r, { gap });
  const veins = [];
  for (let n = 0; n < MARBLE; n++) veins.push(vein([r.between(2, X - 2), r.between(1, SPINE - 2), r.between(3, 21)], [r.between(5, 10), 1, r.between(2, 4)], 'ICE', 'ROCK', 2));
  for (let n = 0; n < FLECKS; n++) veins.push(vein([r.between(1, X - 1), r.between(1, SPINE - 2), r.between(1, 23)], [0.8, 0.8, 0.8], 'GOLD', 'ROCK', 0.5));
  // icicles: under the ribbon's edges (where its body thins) and under the high blobs
  const ice = [];
  for (let n = 0; n < ICICLES; n++) {
    const x = r.between(1, X - 1), z = MID + r.pick([-1, 1]) * r.between(STRIP + 1, STRIP + 4);
    ice.push(icicle(x, z, SPINE - 2, r.between(...ICICLE_LEN)));
  }
  for (const [x, y, z, w] of hangers) for (let n = 0; n < 4; n++) ice.push(icicle(x + r.between(-w, w), z + r.between(-2, 2), y, r.between(...ICICLE_LEN)));
  // snow on the walked tops (over the deck, before what stands on it)
  const snow = spineStrips({ gap }).map(([a, b]) => ({ box: [[a[0], SPINE, a[1]], [b[0], SPINE + SNOW_T, b[1]]], m: 'SNOW', only: 'AIR' }));
  return [...body, ...scatter(r, SCATTERED), ...blobs, ...veins, ...extra, ...spineDeck({ gap }), ...ice.filter(Boolean), ...snow, ...dress];
}
const lowBlob = (qx, qz, r = [6, 3, 5]) => blob([QX[qx], LOW - r[1] + 1, QZ[qz]], r);
const highBlob = (qx, qz, r = [6, 2.5, 4]) => blob([QX[qx], HIGH, QZ[qz]], r);
const highHang = (qx, qz, w = 5) => [QX[qx], HIGH - 2, QZ[qz], w];
const drift = (x, y, z, rx, rz = rx * 0.7) => ({ ball: [[x, y, z], [rx, 2, rz]], m: 'SNOW', only: 'AIR', rough: 0.5 });
const onSpine = (x, side = -1) => ({ kind: 'loot', at: [x, SPINE + SNOW_T, MID + side * 2] });

// a cabin hung on chains in the void beside the spine (Noita's treasure cabins): timber walls, a
// doorway onto the walkway, gold and a frozen body inside, chains up to the tile's top
const CABIN = { x0: 18, x1: 30, z0: MID + 5, z1: MID + 11, h: 8 };
function cabin() {
  const { x0, x1, z0, z1, h } = CABIN, y0 = SPINE - 1;
  return [
    { box: [[x0, y0, z0], [x1, y0 + h, z1]], m: 'WOOD' },
    { box: [[x0 + 1, y0 + 1, z0 + 1], [x1 - 1, y0 + h - 1, z1 - 1]], m: 'AIR' },
    { box: [[x0 + 4, y0 + 1, z0 - 1], [x0 + 8, y0 + 7, z0 + 1]], m: 'AIR' },                 // its doorway, onto the walkway
    { box: [[x0 + 3, y0 - 2, z0 - 1], [x0 + 9, y0 + 1, z0 + 1]], m: 'WOOD', only: 'AIR' },    // ...and a sill bridging the step to it
    { box: [[x1 - 4, y0 + 1, z1 - 3], [x1 - 1, y0 + 3, z1 - 1]], m: 'GOLD' },
    { ball: [[x1 - 6, y0 + 1, z1 - 2], [1.5, 0.8, 1]], m: 'NUGGETS', only: 'AIR' },
    { box: [[x0 + 1, y0 + 1, z1 - 3], [x0 + 4, y0 + 3, z1 - 1]], m: 'ICE' },                  // a body frozen in a block of ice
    { box: [[x0 + 2, y0 + 1, z1 - 2], [x0 + 3, y0 + 2, z1 - 1]], m: 'MEAT' },
    post(x0 + 1, z0 + 2, y0 + h, 24, 'METAL'), post(x1 - 2, z1 - 2, y0 + h, 24, 'METAL'),
  ];
}

const tiles = openTiles([
  // ---- the universal tile: ribbons and rings, a high blob over the void, icicles
  {
    name: 'ice rings', weight: 0.6,
    prims: island(201, { blobs: [highBlob(1, 0), lowBlob(1, 1)], hangers: [highHang(1, 0)], dress: [drift(24, LOW + 1, 20, 3)] }),
    sites: [onSpine(24)],
  },
  // ---- plain ribbons, marbled, a drift and a high blob
  {
    name: 'ice ribbons', weight: 2.2,
    prims: island(202, { blobs: [lowBlob(0, 0), highBlob(1, 1), lowBlob(2, 1)], hangers: [highHang(1, 1)], dress: [drift(4, LOW + 1, 4, 3), drift(30, SPINE + 1, MID - 3, 2.5, 1.2)] }),
  },
  // ---- a plank bridge over a break, saltwater (dark water) in a blob under it
  {
    name: 'plank bridge', weight: 1.8,
    prims: island(203, {
      gap: [18, 30],
      blobs: [lowBlob(1, 1, [7, 3.5, 5]), highBlob(1, 0)],
      hangers: [highHang(1, 0)],
      extra: [basin(24, LOW, 20, 4.5, 2, 3, 'SALTWATER'), pocket([22, LOW - 3, 4], [2.5, 1.5, 2], 'SALTWATER')],
      dress: [plankX(16, 32, MID, SPINE + 1)],
    }),
  },
  // ---- the frozen lake: a great blob holding water (laid down above freezing) under a lid of ice
  {
    name: 'frozen lake', weight: 1.2,
    prims: island(204, {
      blobs: [blob([24, LOW - 2, 20], [11, 4, 5])],
      extra: [basin(24, LOW, 20, 8, 3, 3.5, 'WATER'), { ball: [[24, LOW, 20], [8.5, 0.9, 4]], m: 'ICE', only: 'WATER' }],
      dress: [drift(14, LOW + 1, 20, 2.5)],
    }),
    sites: [onSpine(10, 1)],
  },
  // ---- thin ice: the walkway itself is a skin of ice over deep water for a stretch
  {
    name: 'thin ice', weight: 0.9,
    prims: island(205, {
      blobs: [lowBlob(1, 0)],
      extra: [{ box: [[18, 1, MID - 4], [30, SPINE, MID + 4]], m: 'WATER', only: 'ROCK' }],
      dress: [{ box: [[18, SPINE - 1, MID - 4], [30, SPINE, MID + 4]], m: 'ICE' }, { box: [[18, SPINE, MID - 4], [30, SPINE + 1, MID + 4]], m: 'AIR', only: 'SNOW' }],
    }),
  },
  // ---- a cabin hung on chains: gold and a frozen body inside
  {
    name: 'hanging cabin', weight: 0.9,
    prims: island(206, { blobs: [lowBlob(0, 0), highBlob(2, 0)], hangers: [highHang(2, 0)], dress: cabin() }),
    sites: [{ kind: 'treasure', at: [26, SPINE, CABIN.z1 - 3] }, { kind: 'gold', at: [23, SPINE, CABIN.z0 + 3] }],
  },
  // ---- brick ruins on the ribbon's flank, rubble, an arch
  {
    name: 'brick ruin', weight: 1.4,
    prims: island(207, {
      blobs: [lowBlob(1, 1, [9, 3, 5]), highBlob(0, 0)],
      hangers: [highHang(0, 0)],
      dress: [{ box: [[17, LOW, 17], [31, LOW + 7, 19]], m: 'BRICK' }, { box: [[21, LOW, 17], [25, LOW + 5, 19]], m: 'AIR' },
        { cyl: [[23, LOW + 5, 17], 2, 2], axis: 'z', m: 'AIR', only: 'BRICK' }, { box: [[26, LOW + 5, 17], [31, LOW + 7, 19]], m: 'AIR' },
        heap(28, LOW, 21, 2.5, 'RUBBLE'), heap(19, LOW, 21, 1.8, 'RUBBLE'), { box: [[2, SPINE, MID + 3], [6, SPINE + 4, MID + 4]], m: 'BRICK' }],
    }),
    sites: [onSpine(24, -1), { kind: 'loot', at: [23, LOW, 20] }],
  },
  // ---- Noita's caches: whiskey and healthium in timber barrels (laid down above freezing), slime in a pot
  {
    name: 'cellar', weight: 1,
    prims: island(208, {
      blobs: [lowBlob(1, 0, [8, 3, 5])],
      dress: [...barrel(20, LOW, 4, 'WHISKEY'), ...barrel(24, LOW, 4, 'WHISKEY'), ...barrel(28, LOW, 5, 'HEALTHIUM'),
        ...barrel(44, SPINE + 1, MID - 3, 'SLIME'), { box: [[17, LOW, 2], [31, LOW + 1, 3]], m: 'WOOD' }],
    }),
    sites: [{ kind: 'loot', at: [24, LOW, 8] }],
  },
  // ---- a cold pocket off the main path: liquid nitrogen in a blob's basin, blocks of dry ice
  {
    name: 'cold pocket', weight: 0.7, offPath: true,
    prims: island(209, {
      blobs: [blob([24, LOW - 1, 20], [8, 3.5, 4.5])],
      extra: [basin(24, LOW, 20, 4, 2, 2.5, 'LIQUID_NITROGEN')],
      dress: [{ box: [[16, LOW, 18], [18, LOW + 2, 21]], m: 'DRY_ICE' }, { box: [[30, LOW, 19], [32, LOW + 3, 21]], m: 'DRY_ICE' }],
    }),
  },
  // ---- gold in the ice: veins, nuggets spilled, a TNT cache someone left to get at it
  {
    name: 'gold vein', weight: 1.1,
    prims: island(210, {
      blobs: [lowBlob(1, 0, [7, 3, 5]), lowBlob(2, 1)],
      extra: [{ capsule: [[18, 1, 2], [30, LOW, 6], 1], m: 'GOLD', only: ['ROCK', 'ICE'], rough: 1 }],
      dress: [heap(24, LOW, 4, 2, 'NUGGETS'), { box: [[42, LOW, 19], [45, LOW + 3, 22]], m: 'TNT' }, { box: [[41, LOW, 18], [46, LOW + 1, 23]], m: 'WOOD', only: 'AIR' }],
    }),
    sites: [{ kind: 'gold', at: [24, LOW + 1, 6] }],
  },
  // ---- saltwater pools in the blobs, a frozen body in the ice by them
  {
    name: 'brine pools', weight: 1,
    prims: island(211, {
      blobs: [lowBlob(0, 1, [7, 3, 4]), lowBlob(2, 0, [7, 3, 4]), highBlob(1, 1)],
      hangers: [highHang(1, 1)],
      extra: [basin(4, LOW, 20, 3.5, 2, 2.5, 'SALTWATER'), basin(44, LOW, 4, 3.5, 2, 2.5, 'SALTWATER'),
        { box: [[22, SPINE - 3, MID + 5], [25, SPINE - 1, MID + 7]], m: 'MEAT', only: 'ROCK' }],
    }),
  },
  // ---- the rare pool (Noita's): one a level, levitatium in a timber-lined basin, a crystal over it
  {
    name: 'rare pool', weight: 0.5, max: 1,
    prims: island(212, {
      blobs: [blob([24, LOW - 1, 20], [8, 3.5, 4.5])],
      extra: [basin(24, LOW, 20, 5.5, 2.5, 3.5, 'WOOD'), basin(24, LOW, 20, 4.5, 1.8, 2.7, 'LEVITATIUM', 'WOOD')],
      dress: [{ ball: [[24, 23, 20], [1.4, 2, 1.4]], m: 'CRYSTAL' }],
    }),
    sites: [onSpine(24, 1)],
  },
  // ---- a snowed-in ledge: deep drifts that slide off into the void when disturbed
  {
    name: 'snow drifts', weight: 1.2,
    prims: island(213, {
      blobs: [lowBlob(1, 1, [9, 3, 5]), lowBlob(0, 0)],
      dress: [drift(22, LOW + 1, 20, 6, 3.5), drift(4, LOW + 1, 4, 3.5), heap(28, SPINE + 1, MID + 3, 1.2, 'SNOW')],
    }),
  },
]);

export default {
  name: 'snow',
  geom: { OPEN: 1, SPINE },
  palette: {
    ROCK: 'ROCK', SOFT: 'SNOW', BEAM: 'WOOD', RAIL: 'METAL', RUBBLE: 'RUBBLE', SAND: 'SNOW',
    ICE: 'ICE', CRYSTAL: 'CRYSTAL', COAL: 'COAL', GRAVEL: 'STONE',
  },
  // laid down above freezing in the Snowy Depths' −15 °C (scenes.js COLD_T): they freeze from
  // their edges in, slowly (timber and their own ice insulate them)
  temps: { WATER: 2, HEALTHIUM: 4, SLIME: 4, LEVITATIUM: 4 },
  tiles,
};
