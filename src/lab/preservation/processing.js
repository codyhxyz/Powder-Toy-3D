import { E } from '../../elements.js';

export function buildProcessing({ box, set }) {
  // One dominant reservoir. The oil sump and exhaust serve different roles.
  box(22, 2, 38, 60, 12, 94, E.CERAMIC);
  box(24, 4, 40, 58, 12, 92, E.EMPTY);
  box(24, 4, 40, 58, 10, 92, E.WATER);
  box(22, 5, 68, 24, 11, 82, E.GLASS);
  for (let i = 0; i < 8; i++) {
    const z = 62 - i * 2;
    box(24, 4, z, 32, 5 + i, z + 2, E.METAL);
  }
  box(24, 4, 40, 32, 12, 48, E.METAL);
  box(14, 10, 38, 24, 12, 62, E.METAL);
  box(22, 12, 60, 24, 20, 62, E.CERAMIC);
  // Two broad stairs connect public observation and the service floor.
  for (let i = 0; i < 18; i++) {
    const top = 3 + i, westZ = 74 - i * 2, eastZ = 4 + i * 2;
    box(4, 2, westZ, 14, top, westZ + 2, E.METAL);
    box(58, 2, eastZ, 68, top, eastZ + 2, E.METAL);
    // Leave a turning gap at the stair feet instead of fencing the only exit.
    if (i > 1) {
      box(3, top + 2, westZ, 4, top + 3, westZ + 2, E.METAL);
      box(68, top + 2, eastZ, 69, top + 3, eastZ + 2, E.METAL);
    }
    if (i > 1 && (i % 4 === 0 || i === 17)) {
      box(3, top, westZ, 4, top + 3, westZ + 1, E.METAL);
      box(68, top, eastZ, 69, top + 3, eastZ + 1, E.METAL);
    }
  }
  box(4, 18, 30, 24, 20, 40, E.METAL);
  box(14, 18, 40, 68, 20, 50, E.METAL);
  box(58, 18, 50, 68, 20, 58, E.METAL);
  for (const [x, z] of [[4, 32], [22, 32], [66, 52]]) box(x, 2, z, x + 2, 18, z + 2, E.METAL);
  box(26, 22, 40, 58, 23, 41, E.METAL);
  box(14, 22, 49, 38, 23, 50, E.METAL);
  box(48, 22, 49, 58, 23, 50, E.METAL);
  for (const x of [26, 40, 57]) box(x, 20, 40, x + 1, 23, 41, E.METAL);
  for (const x of [14, 28, 37, 48, 57]) box(x, 20, 49, x + 1, 23, 50, E.METAL);
  box(68, 22, 40, 69, 23, 58, E.METAL);
  box(58, 22, 57, 68, 23, 58, E.METAL);
  for (const z of [40, 48, 57]) box(68, 20, z, 69, 23, z + 1, E.METAL);
  box(58, 20, 57, 59, 23, 58, E.METAL);
  // Portal's observation booth is both an implied workplace and a light source.
  box(4, 18, 10, 24, 20, 30, E.CERAMIC);
  box(4, 20, 10, 6, 32, 30, E.CERAMIC);
  box(22, 20, 10, 24, 32, 30, E.CERAMIC);
  box(6, 20, 10, 22, 32, 12, E.CERAMIC);
  box(6, 20, 28, 12, 32, 30, E.CERAMIC);
  box(20, 20, 28, 22, 32, 30, E.CERAMIC);
  box(12, 28, 28, 20, 32, 30, E.CERAMIC);
  box(6, 22, 28, 12, 30, 30, E.GLASS);
  box(20, 22, 28, 22, 30, 30, E.GLASS);
  box(22, 22, 12, 24, 30, 28, E.GLASS);
  box(4, 32, 10, 24, 34, 30, E.CERAMIC);
  // Sealed gas vessel and capped, disconnected duct housing.
  box(28, 2, 10, 50, 32, 34, E.CERAMIC);
  box(30, 4, 12, 48, 30, 32, E.EMPTY);
  box(30, 4, 12, 48, 27, 32, E.CO2);
  box(30, 8, 32, 48, 28, 34, E.GLASS);
  box(48, 8, 14, 50, 28, 30, E.GLASS);
  box(34, 30, 18, 40, 42, 24, E.METAL);
  box(34, 38, 18, 70, 44, 24, E.METAL);
  box(36, 30, 20, 38, 42, 22, E.EMPTY);
  box(36, 40, 20, 68, 42, 22, E.EMPTY);
  box(62, 2, 84, 76, 14, 100, E.CERAMIC);
  box(64, 4, 86, 74, 12, 98, E.EMPTY);
  box(64, 4, 86, 74, 8, 98, E.OIL);
  box(64, 5, 84, 74, 11, 86, E.GLASS);
  box(62, 12, 84, 76, 14, 100, E.METAL);
  for (const x of [70, 74]) {
    box(x, 34, 24, x + 2, 36, 98, E.METAL);
    box(x, 14, 96, x + 2, 34, 98, E.METAL);
  }
  for (const z of [68, 100]) {
    box(4, 38, z, 76, 40, z + 2, E.METAL);
    box(74, 2, z, 76, 38, z + 2, E.METAL);
  }
  box(4, 6, 96, 12, 7, 104, E.METAL);
  for (const x of [4, 11]) for (const z of [96, 103]) box(x, 2, z, x + 1, 6, z + 1, E.METAL);
  box(5, 7, 98, 8, 8, 99, E.METAL);
  box(9, 7, 100, 10, 9, 102, E.CERAMIC);
  box(4, 2, 86, 6, 12, 88, E.CERAMIC);
  for (const [x, y, z] of [[5, 10, 85], [6, 27, 12], [65, 16, 52], [74, 10, 83]]) set(x, y, z, E.WALL_TORCH);
  return {
    plaques: [
      { cell: [5, 8, 86], normal: [0, 0, -1], text: 'PROCESSING / Public tour above. Maintenance below.' },
      { cell: [22, 8, 72], normal: [-1, 0, 0], elementKey: 'WATER',
        text: 'WATER / Finite reservoir. Jump bay above; submerged stairs west.' },
      { cell: [39, 24, 33], normal: [0, 0, 1], elementKey: 'CO2',
        text: 'CO2 / Sealed exhaust sample. Heavy gas; no live extraction.' },
      { cell: [69, 8, 84], normal: [0, 0, -1], elementKey: 'OIL',
        text: 'OIL / Finite machinery sump; a separate sealed vessel.' },
      { cell: [36, 22, 49], normal: [0, 0, -1], text: 'JUMP BAY / Water below. West submerged stair returns to the dry route.' },
      { cell: [22, 16, 60], normal: [0, 0, -1], text: 'SERVICE BYPASS / Retained inspection access. Main tour uses the gantry.' },
      { cell: [9, 25, 29], normal: [0, 0, 1], text: 'MAINTENANCE / Each preserved sample adds another inspection. No reset.' },
    ],
    landmarks: {
      entry: [8, 2, 80], ascent: [9, 12, 57], observation: [16, 20, 24],
      bridge: [42, 20, 45], jump: [43, 20, 48], gasView: [39, 20, 43],
      waterStairFoot: [28, 5, 63], waterExitTop: [28, 12, 46],
      bypassMerge: [18, 12, 56], waterWindow: [18, 2, 76], groundBypass: [18, 2, 92],
      bench: [16, 2, 100], oilView: [69, 2, 78], descent: [63, 12, 22], exit: [74, 2, 30],
    },
  };
}
