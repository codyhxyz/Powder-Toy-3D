import { E } from '../../elements.js';

// An authored industrial alternative, not a procedural specimen layout.
export function buildReactor({ box, set }) {
  const WIDTH = 76, DEPTH = 92, FLOOR = 2, ROOF = 62, TOP = 64;
  const DECK = 24, DECK_BOTTOM = 22, STAIR_START = 8, STEP_RUN = 2;
  const VAT_FRONT = 60, VAT_BACK = 84, VAT_RIM = 12, LIQUID_TOP = 10;
  box(0, 0, 0, WIDTH, FLOOR, DEPTH, E.WALL);
  box(0, FLOOR, 0, 32, ROOF, 2, E.WALL);
  box(44, FLOOR, 0, WIDTH, ROOF, 2, E.WALL);
  box(32, 14, 0, 44, ROOF, 2, E.WALL);
  box(0, FLOOR, 2, 2, ROOF, DEPTH, E.WALL);
  box(74, FLOOR, 2, WIDTH, ROOF, DEPTH, E.WALL);
  box(2, FLOOR, 90, 74, ROOF, DEPTH, E.WALL);
  box(0, ROOF, 0, WIDTH, TOP, DEPTH, E.WALL);
  box(16, ROOF, 8, 26, TOP, 84, E.GLASS);
  box(50, ROOF, 8, 60, TOP, 84, E.GLASS);
  box(26, 15, 0, 50, 22, 2, E.METAL);
  for (const z of [12, 36, 58, 84]) {
    box(2, FLOOR, z, 4, ROOF, z + 2, E.METAL);
    box(72, FLOOR, z, 74, ROOF, z + 2, E.METAL);
    box(2, 56, z, 74, 58, z + 2, E.METAL);
    const lightY = z === 12 ? 16 : z === 36 ? 30 : 12;
    set(4, lightY, z, E.WALL_TORCH);
    set(71, lightY, z, E.WALL_TORCH);
    set(4, 40, z, E.WALL_TORCH);
    set(71, 40, z, E.WALL_TORCH);
  }
  // Noita's light-only embers: overhead illumination, not exposed heaters.
  box(18, 60, 12, 20, ROOF, 84, E.EMBER);
  box(56, 60, 12, 58, ROOF, 84, E.EMBER);
  function gantryStair(x0, x1) {
    for (let step = 0; step < DECK - FLOOR; step++) {
      const z = STAIR_START + step * STEP_RUN, tread = FLOOR + step + 1;
      box(x0, FLOOR, z, x1, tread, z + STEP_RUN, E.METAL);
      for (const railX of [x0 - 1, x1]) {
        box(railX, tread + 2, z, railX + 1, tread + 3, z + STEP_RUN, E.METAL);
        if (step % 4 === 0 || step === DECK - FLOOR - 1) box(railX, tread, z, railX + 1, tread + 3, z + 1, E.METAL);
      }
    }
  }
  gantryStair(4, 12);
  gantryStair(64, 72);
  box(2, DECK_BOTTOM, 52, 14, DECK, 90, E.METAL);
  box(62, DECK_BOTTOM, 52, 74, DECK, 90, E.METAL);
  box(12, DECK_BOTTOM, 52, 64, DECK, 62, E.METAL);
  box(12, DECK_BOTTOM, 80, 64, DECK, 90, E.METAL);
  for (const x of [8, 66]) box(x, FLOOR, 54, x + 2, DECK_BOTTOM, 56, E.METAL);
  for (const x of [12, 62]) box(x, FLOOR, 86, x + 2, DECK_BOTTOM, 88, E.METAL);
  box(12, 26, 52, 64, 27, 53, E.METAL);
  box(12, 26, 61, 26, 27, 62, E.METAL);
  box(34, 26, 61, 64, 27, 62, E.METAL);
  for (const x of [12, 25, 34, 63]) box(x, DECK, 61, x + 1, 27, 62, E.METAL);
  box(12, 26, 80, 64, 27, 81, E.METAL);
  for (const x of [13, 62]) {
    box(x, 26, 62, x + 1, 27, 80, E.METAL);
    for (const z of [64, 72, 78]) box(x, DECK, z, x + 1, 27, z + 1, E.METAL);
  }
  box(24, 21, 53, 32, DECK_BOTTOM, 54, E.EMBER);
  box(44, 21, 53, 52, DECK_BOTTOM, 54, E.EMBER);
  box(14, FLOOR, 8, 16, 8, 10, E.METAL);

  function vat(x0, x1, liquid, stairX, outsideX) {
    box(x0, FLOOR, VAT_FRONT, x1, 3, VAT_BACK, E.WALL);
    box(x0, 3, VAT_FRONT, x1, VAT_RIM, VAT_FRONT + 2, E.WALL);
    box(x0, 3, VAT_BACK - 2, x1, VAT_RIM, VAT_BACK, E.WALL);
    box(x0, 3, VAT_FRONT + 2, x0 + 2, VAT_RIM, VAT_BACK - 2, E.WALL);
    box(x1 - 2, 3, VAT_FRONT + 2, x1, VAT_RIM, VAT_BACK - 2, E.WALL);
    box(x0 + 2, 3, VAT_FRONT + 2, x1 - 2, LIQUID_TOP, VAT_BACK - 2, liquid);
    for (let step = 0; step < VAT_RIM - FLOOR; step++) {
      const z = 40 + step * STEP_RUN;
      box(outsideX, FLOOR, z, stairX + 8, FLOOR + step + 1, z + STEP_RUN, E.METAL);
    }
    for (let step = 0; step < VAT_RIM - 3; step++) {
      const z = 78 - step * STEP_RUN;
      box(stairX, 3, z, stairX + 8, 4 + step, z + STEP_RUN, E.METAL);
    }
  }
  vat(14, 36, E.WATER, 16, 12);
  vat(44, 66, E.OIL, 56, 56);
  box(24, 4, VAT_FRONT, 34, 10, VAT_FRONT + 2, E.GLASS);
  box(46, 4, VAT_FRONT, 56, 10, VAT_FRONT + 2, E.GLASS);

  // Finite hopper: a tapering open throat empties into a real catch tray.
  box(26, FLOOR, 10, 50, 3, 32, E.WALL);
  box(26, 3, 10, 50, 6, 12, E.GLASS);
  box(26, 3, 30, 50, 6, 32, E.WALL);
  box(26, 3, 12, 28, 6, 30, E.WALL);
  box(48, 3, 12, 50, 6, 30, E.WALL);
  for (const x of [26, 48]) for (const z of [10, 30]) box(x, 3, z, x + 2, 56, z + 2, E.METAL);
  function hopperShell(y0, y1, ix0, iz0, ix1, iz1) {
    box(28, y0, 12, ix0, y1, 30, E.METAL);
    box(ix1, y0, 12, 48, y1, 30, E.METAL);
    box(ix0, y0, 12, ix1, y1, iz0, E.GLASS);
    box(ix0, y0, iz1, ix1, y1, 30, E.METAL);
  }
  for (let tier = 0; tier < 8; tier++) {
    const y = 28 + tier * 2;
    hopperShell(y, y + 2, 36 - tier, Math.max(13, 19 - tier), 40 + tier, Math.min(29, 23 + tier));
  }
  hopperShell(44, 54, 29, 13, 47, 29);
  box(28, 54, 12, 48, 55, 30, E.GLASS);
  box(35, 20, 18, 36, 28, 24, E.METAL);
  box(40, 20, 18, 41, 28, 24, E.METAL);
  box(36, 20, 18, 40, 28, 19, E.GLASS);
  box(36, 20, 23, 40, 28, 24, E.METAL);
  box(32, 46, 16, 44, 50, 26, E.SAND);
  box(34, 3, 17, 42, 4, 25, E.SAND);
  box(36, 4, 19, 40, 5, 23, E.SAND);

  box(32, FLOOR, 32, 44, 3, 46, E.METAL);
  box(32, 3, 32, 33, 50, 46, E.GLASS);
  box(43, 3, 32, 44, 50, 46, E.GLASS);
  box(33, 3, 32, 43, 50, 33, E.GLASS);
  box(33, 3, 45, 43, 50, 46, E.GLASS);
  box(32, 50, 32, 44, 52, 46, E.METAL);
  box(33, 3, 33, 43, 45, 45, E.CO2);
  set(44, 15, 34, E.WALL_TORCH);
  set(44, 34, 34, E.WALL_TORCH);
  return {
    plaques: [
      { cell: [38, 18, 1], normal: [0, 0, 1], text: 'REACTOR ATRIUM' },
      { cell: [15, 6, 8], normal: [0, 0, -1], text: 'CATWALK / Side stairs rise to the jump deck.' },
      { cell: [38, 4, 10], normal: [0, 0, -1], elementKey: 'SAND',
        text: 'SAND / Finite hopper: one charge falls into the tray.' },
      { cell: [43, 9, 40], normal: [1, 0, 0], elementKey: 'CO2',
        text: 'CO2 / Sealed column. The gas settles; no continuous supply.' },
      { cell: [30, 7, 60], normal: [0, 0, -1], elementKey: 'WATER',
        text: 'WATER / Open vat. Submerged steps at the front-left.' },
      { cell: [49, 7, 60], normal: [0, 0, -1], elementKey: 'OIL',
        text: 'OIL / Separate vat. Front-right steps return to the floor.' },
      { cell: [28, 11, 82], normal: [0, 0, -1],
        text: 'WATER EXIT / Front-left submerged steps lead back to the floor.' },
      { cell: [50, 11, 82], normal: [0, 0, -1],
        text: 'OIL EXIT / Front-right submerged steps lead back to the floor.' },
      { cell: [25, 25, 61], normal: [0, 0, 1], text: 'JUMP GAP / Water below. Return by the vat steps.' },
    ],
    landmarks: {
      entry: [38, FLOOR, 4], hopperView: [38, FLOOR, 8], gasView: [48, FLOOR, 40],
      catwalk: [38, DECK, 56], jump: [30, DECK, 60], rearCatwalk: [38, DECK, 86],
      water: [28, LIQUID_TOP, 72], oil: [50, LIQUID_TOP, 72],
      waterExit: [20, VAT_RIM, 61], oilExit: [60, VAT_RIM, 61],
    },
  };
}
