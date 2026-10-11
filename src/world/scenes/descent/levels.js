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
      {x: 101, y: 94, z: 321, kind: 'wand', tier: 1},
      {x: 173, y: 118, z: 430, kind: 'wand', tier: 1},
      {x: 238, y: 118, z: 214, kind: 'wand', tier: 1},
      {x: 221, y: 70, z: 22, kind: 'wand', tier: 1},
      {x: 427, y: 46, z: 300, kind: 'wand', tier: 1},
      {x: 373, y: 129, z: 392, kind: 'spell', tier: 1},
      {x: 402, y: 73, z: 359, kind: 'spell', tier: 1},
      {x: 374, y: 57, z: 152, kind: 'spell', tier: 1},
      {x: 469, y: 105, z: 152, kind: 'spell', tier: 1},
      {x: 110, y: 129, z: 224, kind: 'spell', tier: 1},
      {x: 465, y: 57, z: 483, kind: 'spell', tier: 1},
      {x: 97, y: 118, z: 80, kind: 'gold', tier: 1},
      {x: 290, y: 94, z: 311, kind: 'gold', tier: 1},
      {x: 434, y: 46, z: 176, kind: 'gold', tier: 1},
      {x: 297, y: 118, z: 328, kind: 'gold', tier: 1},
      {x: 73, y: 70, z: 167, kind: 'gold', tier: 1},
      {x: 225, y: 118, z: 160, kind: 'gold', tier: 1},
      {x: 249, y: 118, z: 87, kind: 'gold', tier: 1},
      {x: 26, y: 94, z: 47, kind: 'gold', tier: 1},
      {x: 249, y: 118, z: 183, kind: 'gold', tier: 1},
      {x: 169, y: 46, z: 392, kind: 'gold', tier: 1},
    ],
  },
  {
    key: 'descentCoal', name: 'Coal Pits', tier: 2,
    spawn: [324, 140, 256],
    temple: {
      box: [186, 14, 246, 330, 30, 266],
      pool: [220, 10, 248, 236, 14, 264],
      altars: [[298, 14, 256], [304, 14, 256], [310, 14, 256]],
      shop: [[246, 17, 256], [256, 17, 256], [266, 17, 256], [276, 17, 256], [286, 17, 256]],
      refresher: [266, 14, 263],
      exit: [318, 4, 246, 330, 10, 266],
    },
    loot: [
      {x: 112, y: 92, z: 364, kind: 'wand', tier: 2},
      {x: 124, y: 140, z: 256, kind: 'wand', tier: 2},
      {x: 316, y: 60, z: 496, kind: 'wand', tier: 2},
      {x: 304, y: 108, z: 76, kind: 'wand', tier: 2},
      {x: 160, y: 140, z: 172, kind: 'wand', tier: 2},
      {x: 352, y: 76, z: 388, kind: 'spell', tier: 2},
      {x: 172, y: 76, z: 208, kind: 'spell', tier: 2},
      {x: 364, y: 44, z: 16, kind: 'spell', tier: 2},
      {x: 196, y: 92, z: 448, kind: 'spell', tier: 2},
      {x: 400, y: 140, z: 460, kind: 'spell', tier: 2},
      {x: 364, y: 44, z: 160, kind: 'spell', tier: 2},
      {x: 256, y: 124, z: 148, kind: 'gold', tier: 2},
      {x: 412, y: 92, z: 256, kind: 'gold', tier: 2},
      {x: 160, y: 92, z: 100, kind: 'gold', tier: 2},
      {x: 292, y: 44, z: 208, kind: 'gold', tier: 2},
      {x: 340, y: 60, z: 112, kind: 'gold', tier: 2},
      {x: 256, y: 124, z: 436, kind: 'gold', tier: 2},
      {x: 28, y: 76, z: 448, kind: 'gold', tier: 2},
      {x: 400, y: 44, z: 436, kind: 'gold', tier: 2},
      {x: 448, y: 108, z: 196, kind: 'gold', tier: 2},
      {x: 160, y: 92, z: 484, kind: 'gold', tier: 2},
    ],
  },
  {
    key: 'descentSnow', name: 'Snowy Depths', tier: 3,
    spawn: [324, 141, 256],
    temple: {
      box: [186, 14, 246, 330, 30, 266],
      pool: [220, 10, 248, 236, 14, 264],
      altars: [[298, 14, 256], [304, 14, 256], [310, 14, 256]],
      shop: [[246, 17, 256], [256, 17, 256], [266, 17, 256], [276, 17, 256], [286, 17, 256]],
      refresher: [266, 14, 263],
      exit: [318, 4, 246, 330, 10, 266],
    },
    loot: [
      {x: 208, y: 93, z: 436, kind: 'wand', tier: 3},
      {x: 196, y: 109, z: 256, kind: 'wand', tier: 3},
      {x: 16, y: 77, z: 268, kind: 'wand', tier: 3},
      {x: 400, y: 109, z: 436, kind: 'wand', tier: 3},
      {x: 460, y: 141, z: 160, kind: 'wand', tier: 3},
      {x: 148, y: 93, z: 256, kind: 'spell', tier: 3},
      {x: 412, y: 109, z: 160, kind: 'spell', tier: 3},
      {x: 292, y: 141, z: 352, kind: 'spell', tier: 3},
      {x: 388, y: 45, z: 256, kind: 'spell', tier: 3},
      {x: 112, y: 125, z: 292, kind: 'spell', tier: 3},
      {x: 16, y: 45, z: 76, kind: 'spell', tier: 3},
      {x: 160, y: 109, z: 244, kind: 'gold', tier: 3},
      {x: 160, y: 77, z: 244, kind: 'gold', tier: 3},
      {x: 148, y: 109, z: 496, kind: 'gold', tier: 3},
      {x: 496, y: 77, z: 364, kind: 'gold', tier: 3},
      {x: 436, y: 93, z: 256, kind: 'gold', tier: 3},
      {x: 388, y: 141, z: 64, kind: 'gold', tier: 3},
      {x: 148, y: 77, z: 352, kind: 'gold', tier: 3},
      {x: 208, y: 45, z: 364, kind: 'gold', tier: 3},
      {x: 28, y: 109, z: 448, kind: 'gold', tier: 3},
      {x: 400, y: 61, z: 292, kind: 'gold', tier: 3},
    ],
  },
];
export const levelByScene = (key) => DESCENT_LEVELS.find((l) => l.key === key) ?? null;
// the level after this one, or null after the last
export const nextLevel = (key) => DESCENT_LEVELS[DESCENT_LEVELS.findIndex((l) => l.key === key) + 1] ?? null;
// is world point p ([x, y, z], cells) inside box b ([x0, y0, z0, x1, y1, z1])?
export const inBox = (b, p) => p[0] >= b[0] && p[1] >= b[1] && p[2] >= b[2] && p[0] < b[3] && p[1] < b[4] && p[2] < b[5];
