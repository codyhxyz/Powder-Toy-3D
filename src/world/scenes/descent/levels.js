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
    spawn: [170, 151, 264],
    temple: {
      box: [186, 14, 246, 330, 30, 266],
      pool: [220, 10, 248, 236, 14, 264],
      altars: [[298, 14, 256], [304, 14, 256], [310, 14, 256]],
      shop: [[246, 17, 256], [256, 17, 256], [266, 17, 256], [276, 17, 256], [286, 17, 256]],
      refresher: [266, 14, 263],
      exit: [318, 4, 246, 330, 10, 266],
    },
    loot: [
      {x: 388, y: 108, z: 304, kind: 'wand', tier: 1},
      {x: 64, y: 108, z: 460, kind: 'wand', tier: 1},
      {x: 460, y: 76, z: 16, kind: 'wand', tier: 1},
      {x: 304, y: 92, z: 220, kind: 'wand', tier: 1},
      {x: 304, y: 92, z: 316, kind: 'wand', tier: 1},
      {x: 496, y: 76, z: 28, kind: 'spell', tier: 1},
      {x: 256, y: 76, z: 52, kind: 'spell', tier: 1},
      {x: 268, y: 108, z: 304, kind: 'spell', tier: 1},
      {x: 316, y: 92, z: 256, kind: 'spell', tier: 1},
      {x: 244, y: 108, z: 352, kind: 'spell', tier: 1},
      {x: 16, y: 60, z: 124, kind: 'spell', tier: 1},
      {x: 316, y: 92, z: 448, kind: 'gold', tier: 1},
      {x: 448, y: 76, z: 268, kind: 'gold', tier: 1},
      {x: 196, y: 44, z: 400, kind: 'gold', tier: 1},
      {x: 256, y: 108, z: 412, kind: 'gold', tier: 1},
      {x: 244, y: 76, z: 112, kind: 'gold', tier: 1},
      {x: 172, y: 108, z: 496, kind: 'gold', tier: 1},
      {x: 388, y: 44, z: 160, kind: 'gold', tier: 1},
      {x: 496, y: 92, z: 220, kind: 'gold', tier: 1},
      {x: 400, y: 76, z: 292, kind: 'gold', tier: 1},
      {x: 268, y: 92, z: 64, kind: 'gold', tier: 1},
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
