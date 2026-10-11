// The Descent levels (docs/descent-contract.md): plain data, no imports, so the
// wand loot and the Holy Mountain code read it without pulling in the
// generator. World cells, integers; a site is the cell its feet stand in.
//
// GENERATED from the scenes' JS twins (src/world/scenes/descent/sites.js):
// don't edit by hand. Regenerate and check with
//   node scripts/check-descent-levels.mjs --write
export const DESCENT_LEVELS = [
  {
    key: 'descentMines', name: 'Mines', tier: 1,
    spawn: [170, 151, 256],
    temple: {
      box: [186, 14, 246, 330, 30, 266],
      pool: [220, 10, 248, 236, 14, 264],
      altars: [[298, 14, 256], [304, 14, 256], [310, 14, 256]],
      shop: [[246, 17, 256], [256, 17, 256], [266, 17, 256], [276, 17, 256], [286, 17, 256]],
      refresher: [266, 14, 263],
      exit: [318, 4, 246, 330, 10, 266],
    },
    loot: [
      {x: 211, y: 118, z: 103, kind: 'wand', tier: 1},
      {x: 257, y: 94, z: 33, kind: 'wand', tier: 1},
      {x: 89, y: 118, z: 118, kind: 'wand', tier: 1},
      {x: 464, y: 118, z: 432, kind: 'wand', tier: 1},
      {x: 185, y: 70, z: 225, kind: 'wand', tier: 1},
      {x: 338, y: 46, z: 160, kind: 'spell', tier: 1},
      {x: 26, y: 118, z: 399, kind: 'spell', tier: 1},
      {x: 385, y: 57, z: 453, kind: 'spell', tier: 1},
      {x: 146, y: 46, z: 476, kind: 'spell', tier: 1},
      {x: 121, y: 94, z: 87, kind: 'spell', tier: 1},
      {x: 386, y: 94, z: 39, kind: 'spell', tier: 1},
      {x: 293, y: 118, z: 159, kind: 'gold', tier: 1},
      {x: 94, y: 70, z: 304, kind: 'gold', tier: 1},
      {x: 121, y: 118, z: 451, kind: 'gold', tier: 1},
      {x: 262, y: 94, z: 375, kind: 'gold', tier: 1},
      {x: 50, y: 46, z: 19, kind: 'gold', tier: 1},
      {x: 409, y: 118, z: 451, kind: 'gold', tier: 1},
      {x: 485, y: 46, z: 232, kind: 'gold', tier: 1},
      {x: 317, y: 70, z: 111, kind: 'gold', tier: 1},
      {x: 25, y: 94, z: 300, kind: 'gold', tier: 1},
      {x: 194, y: 46, z: 67, kind: 'gold', tier: 1},
    ],
  },
  {
    key: 'descentCoal', name: 'Coal Pits', tier: 2,
    spawn: [306, 140, 256],
    temple: {
      box: [186, 14, 246, 330, 30, 266],
      pool: [220, 10, 248, 236, 14, 264],
      altars: [[298, 14, 256], [304, 14, 256], [310, 14, 256]],
      shop: [[246, 17, 256], [256, 17, 256], [266, 17, 256], [276, 17, 256], [286, 17, 256]],
      refresher: [266, 14, 263],
      exit: [318, 4, 246, 330, 10, 266],
    },
    loot: [
      {x: 307, y: 94, z: 12, kind: 'wand', tier: 2},
      {x: 125, y: 94, z: 358, kind: 'wand', tier: 2},
      {x: 46, y: 94, z: 201, kind: 'wand', tier: 2},
      {x: 214, y: 94, z: 369, kind: 'wand', tier: 2},
      {x: 443, y: 70, z: 159, kind: 'wand', tier: 2},
      {x: 181, y: 81, z: 191, kind: 'spell', tier: 2},
      {x: 88, y: 118, z: 423, kind: 'spell', tier: 2},
      {x: 98, y: 70, z: 150, kind: 'spell', tier: 2},
      {x: 481, y: 46, z: 409, kind: 'spell', tier: 2},
      {x: 109, y: 129, z: 152, kind: 'spell', tier: 2},
      {x: 402, y: 129, z: 316, kind: 'spell', tier: 2},
      {x: 146, y: 118, z: 56, kind: 'gold', tier: 2},
      {x: 210, y: 70, z: 111, kind: 'gold', tier: 2},
      {x: 378, y: 118, z: 135, kind: 'gold', tier: 2},
      {x: 417, y: 46, z: 207, kind: 'gold', tier: 2},
      {x: 330, y: 94, z: 232, kind: 'gold', tier: 2},
      {x: 306, y: 118, z: 160, kind: 'gold', tier: 2},
      {x: 278, y: 81, z: 464, kind: 'gold', tier: 2},
      {x: 371, y: 118, z: 40, kind: 'gold', tier: 2},
      {x: 61, y: 129, z: 200, kind: 'gold', tier: 2},
      {x: 68, y: 57, z: 118, kind: 'gold', tier: 2},
    ],
  },
  {
    key: 'descentSnow', name: 'Snowy Depths', tier: 3,
    spawn: [306, 140, 256],
    temple: {
      box: [186, 14, 246, 330, 30, 266],
      pool: [220, 10, 248, 236, 14, 264],
      altars: [[298, 14, 256], [304, 14, 256], [310, 14, 256]],
      shop: [[246, 17, 256], [256, 17, 256], [266, 17, 256], [276, 17, 256], [286, 17, 256]],
      refresher: [266, 14, 263],
      exit: [318, 4, 246, 330, 10, 266],
    },
    loot: [
      {x: 241, y: 71, z: 164, kind: 'wand', tier: 3},
      {x: 245, y: 46, z: 380, kind: 'wand', tier: 3},
      {x: 121, y: 47, z: 476, kind: 'wand', tier: 3},
      {x: 438, y: 47, z: 40, kind: 'wand', tier: 3},
      {x: 342, y: 47, z: 135, kind: 'wand', tier: 3},
      {x: 182, y: 47, z: 87, kind: 'spell', tier: 3},
      {x: 229, y: 57, z: 143, kind: 'spell', tier: 3},
      {x: 408, y: 119, z: 244, kind: 'spell', tier: 3},
      {x: 374, y: 119, z: 159, kind: 'spell', tier: 3},
      {x: 134, y: 47, z: 136, kind: 'spell', tier: 3},
      {x: 166, y: 95, z: 172, kind: 'spell', tier: 3},
      {x: 298, y: 122, z: 402, kind: 'gold', tier: 3},
      {x: 363, y: 95, z: 460, kind: 'gold', tier: 3},
      {x: 99, y: 95, z: 388, kind: 'gold', tier: 3},
      {x: 138, y: 129, z: 171, kind: 'gold', tier: 3},
      {x: 57, y: 105, z: 134, kind: 'gold', tier: 3},
      {x: 313, y: 119, z: 148, kind: 'gold', tier: 3},
      {x: 194, y: 71, z: 292, kind: 'gold', tier: 3},
      {x: 186, y: 81, z: 483, kind: 'gold', tier: 3},
      {x: 254, y: 119, z: 137, kind: 'gold', tier: 3},
      {x: 459, y: 47, z: 27, kind: 'gold', tier: 3},
    ],
  },
];
export const levelByScene = (key) => DESCENT_LEVELS.find((l) => l.key === key) ?? null;
// the level after this one, or null after the last
export const nextLevel = (key) => DESCENT_LEVELS[DESCENT_LEVELS.findIndex((l) => l.key === key) + 1] ?? null;
// is world point p ([x, y, z], cells) inside box b ([x0, y0, z0, x1, y1, z1])?
export const inBox = (b, p) => p[0] >= b[0] && p[1] >= b[1] && p[2] >= b[2] && p[0] < b[3] && p[1] < b[4] && p[2] < b[5];
