import { E } from '../../elements.js';

export function buildContainment({ box, set }) {
  const WIDTH = 76, DEPTH = 92, FLOOR = 2;
  const ROOF = 30, TOP = 32, WALL = 2;
  const HALL_L = 30, HALL_R = 46, BULKHEAD = 4;

  // Closed voxel vessels, following the element table's container semantics.
  const shell = (x0, y0, z0, x1, y1, z1, id, t = 1) => {
    box(x0, y0, z0, x1, y1, z1, id);
    box(x0 + t, y0 + t, z0 + t, x1 - t, y1 - t, z1 - t, E.EMPTY);
  };
  box(0, 0, 0, WIDTH, FLOOR, DEPTH, E.WALL);
  box(0, FLOOR, 0, WIDTH, ROOF, DEPTH, E.EMPTY);
  box(0, ROOF, 0, WIDTH, TOP, DEPTH, E.WALL);
  box(0, FLOOR, 0, WALL, ROOF, DEPTH, E.WALL);
  box(WIDTH - WALL, FLOOR, 0, WIDTH, ROOF, DEPTH, E.WALL);
  box(0, FLOOR, DEPTH - WALL, WIDTH, ROOF, DEPTH, E.WALL);
  box(0, FLOOR, 0, WIDTH, ROOF, WALL, E.WALL);
  box(32, FLOOR, 0, 44, 14, WALL, E.EMPTY);

  // Four observation bays flank a broad service spine.
  box(HALL_L - BULKHEAD, FLOOR, 14, HALL_L, ROOF, 74, E.WALL);
  box(HALL_R, FLOOR, 14, HALL_R + BULKHEAD, ROOF, 74, E.WALL);
  for (const z of [14, 42, 70]) {
    box(WALL, FLOOR, z, HALL_L, ROOF, z + BULKHEAD, E.WALL);
    box(HALL_R, FLOOR, z, WIDTH - WALL, ROOF, z + BULKHEAD, E.WALL);
    box(HALL_L, 25, z, HALL_R, ROOF, z + BULKHEAD, E.WALL);
  }
  box(HALL_L, FLOOR, 70, HALL_R, 25, 74, E.WALL);
  box(32, FLOOR, 70, 44, 16, 74, E.EMPTY);

  // Recessed observation glazing, with thick WALL frames.
  for (const z of [22, 50]) {
    box(26, 6, z, 30, 16, z + 16, E.EMPTY);
    box(28, 6, z, 30, 16, z + 16, E.GLASS);
    box(46, 6, z, 50, 16, z + 16, E.EMPTY);
    box(46, 6, z, 48, 16, z + 16, E.GLASS);
  }
  box(6, FLOOR, 22, 22, 6, 38, E.WALL);
  box(8, 3, 24, 20, 6, 36, E.EMPTY);
  box(10, 3, 26, 18, 10, 34, E.SAND);

  // Acid touches only its sealed, acid-resistant glass vessel.
  shell(54, FLOOR, 22, 70, 17, 38, E.GLASS);
  box(55, 3, 23, 69, 8, 37, E.ACID);

  // Insulation and standoff gaps, not a maintained cold environment.
  box(6, FLOOR, 50, 24, 5, 70, E.INSULATOR);
  box(6, 5, 50, 8, 19, 70, E.INSULATOR);
  box(8, 5, 50, 24, 19, 52, E.INSULATOR);
  box(8, 5, 68, 24, 19, 70, E.INSULATOR);
  box(6, 19, 50, 24, 21, 70, E.INSULATOR);
  shell(10, 5, 54, 20, 17, 66, E.GLASS);
  box(12, 6, 56, 18, 12, 62, E.ICE);

  // Deliberately empty secure cell, including an empty inspection plinth.
  shell(54, FLOOR, 50, 70, 22, 70, E.WALL, 2);
  box(54, 6, 54, 56, 16, 66, E.GLASS);
  box(60, 4, 58, 64, 6, 62, E.WALL);

  // Eight-wide service stairs, rise one per two cells.
  box(4, FLOOR, 82, 22, 6, 90, E.WALL);
  for (let step = 0; step < 4; step++) {
    box(28 - 2 * step, FLOOR, 82, 30 - 2 * step, 3 + step, 90, E.WALL);
  }
  box(4, 6, 88, 10, 10, 90, E.INSULATOR);
  shell(50, FLOOR, 84, 60, 14, 89, E.GLASS);
  box(51, 3, 85, 59, 7, 88, E.WATER);
  shell(62, FLOOR, 84, 72, 14, 89, E.GLASS);
  box(63, 3, 85, 71, 13, 88, E.OXYGEN);

  // Noita's wall brackets: these emit light, not fire heat.
  for (const z of [24, 36, 52, 64]) for (let y = 20; y < 23; y++) {
    set(30, y, z, E.WALL_TORCH);
    set(45, y, z, E.WALL_TORCH);
  }
  for (const [x, z] of [[14, 2], [60, 2], [2, 30], [73, 30], [2, 60], [73, 60], [14, 89], [55, 89], [67, 89]]) {
    set(x, 22, z, E.WALL_TORCH);
  }
  return {
    plaques: [
      { cell: [38, 19, 1], normal: [0, 0, 1], text: 'CONTAINMENT / Isolation block' },
      { cell: [29, 18, 30], normal: [1, 0, 0], elementKey: 'SAND',
        text: 'SAND / Ordinary WALL tray; grains settle, not fixed in place.' },
      { cell: [46, 18, 30], normal: [-1, 0, 0], elementKey: 'ACID',
        text: 'ACID / Sealed glass vessel: glass resists acid, not every impact.' },
      { cell: [29, 18, 58], normal: [1, 0, 0], elementKey: 'ICE',
        text: 'ICE / Insulator + air gaps; warms and melts. No active cooling.' },
      { cell: [46, 18, 58], normal: [-1, 0, 0], elementKey: 'SINGULARITY',
        text: 'SINGULARITY / Empty: starves or bursts; no persistent specimen.' },
      { cell: [14, 15, 90], normal: [0, 0, -1],
        text: 'SERVICE / Walk up to the inspection platform. No cooling machinery.' },
      { cell: [55, 16, 90], normal: [0, 0, -1], elementKey: 'WATER',
        text: 'WATER / Sealed reference vessel; liquid levels out.' },
      { cell: [67, 16, 90], normal: [0, 0, -1], elementKey: 'OXYGEN',
        text: 'OXYGEN / Sealed reference vessel; gas fills the available space.' },
    ],
    landmarks: {
      entry: [38, FLOOR, 4], sandView: [34, FLOOR, 30], acidView: [42, FLOOR, 30],
      coldView: [34, FLOOR, 58], emptyStationView: [42, FLOOR, 58],
      servicePlatform: [14, 6, 86], referenceAisle: [60, FLOOR, 78],
    },
  };
}
