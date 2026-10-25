import { E } from '../../elements.js';

// Hand-built aquarium arcade, not an element-catalog layout. Supported
// powders adapt the existing lab's sand-bed tank (labWorld.js), not frozen
// decorative material: their shapes may settle after the room opens.
const ROOM = { width: 76, depth: 92, floor: 2, ceiling: 38, top: 40, wall: 2 };
const ENTRY = { left: 32, right: 44, top: 14 };
const CASE = { bottom: 6, top: 22, lid: 24, depth: 20 };
const POOL = { left: 50, right: 58, front: 50, back: 68, bed: 3, surface: 6 };

export function buildMuseum({ box, set }) {
  const { width, depth, floor, ceiling, top, wall } = ROOM;
  box(0, 0, 0, width, floor, depth, E.WALL);
  box(0, floor, 0, wall, top, depth, E.WALL);
  box(width - wall, floor, 0, width, top, depth, E.WALL);
  box(0, floor, depth - wall, width, top, depth, E.WALL);
  // Leave the entry empty without clearing a caller's shared foyer.
  box(0, floor, 0, ENTRY.left, top, wall, E.WALL);
  box(ENTRY.right, floor, 0, width, top, wall, E.WALL);
  box(ENTRY.left, ENTRY.top, 0, ENTRY.right, top, wall, E.WALL);
  box(0, ceiling, 0, width, top, depth, E.WALL);
  // Complete glass roof band admits actual daylight, not an open ceiling.
  box(28, ceiling, 6, 48, top, 86, E.GLASS);

  // Monumental square ribs frame the long central promenade.
  for (const z of [8, 32, 56, 80]) {
    box(26, floor, z, 28, 28, z + 2, E.WALL);
    // The bathing court's rib stops overhead, keeping its deck eight wide.
    const eastFoot = z === 56 ? 16 : floor;
    box(46, eastFoot, z, 48, 28, z + 2, E.WALL);
    box(2, 28, z, 74, 31, z + 2, E.WALL);
    box(26, 31, z, 48, ceiling, z + 2, E.WALL);
    // Light-only torches, as in Noita's lit terrain; no heaters or wiring.
    set(28, 11, z, E.WALL_TORCH);
    set(45, z === 56 ? 17 : 11, z, E.WALL_TORCH);
  }

  // Repeated 16-by-16 windows on solid plinths. Geometry repeats, but the
  // samples below are explicitly authored and isolated from each other.
  // Close narrow spaces behind/between the cases, rather than fake aisles.
  box(2, floor, 12, 6, CASE.lid, 80, E.WALL);
  box(6, floor, 32, 26, CASE.lid, 36, E.WALL);
  box(6, floor, 56, 26, CASE.lid, 60, E.WALL);
  function westWindow(z) {
    box(4, floor, z, 26, CASE.bottom, z + CASE.depth, E.WALL);
    box(4, CASE.bottom, z, 6, CASE.lid, z + CASE.depth, E.WALL);
    box(6, CASE.bottom, z, 26, CASE.lid, z + 2, E.WALL);
    box(6, CASE.bottom, z + 18, 26, CASE.lid, z + CASE.depth, E.WALL);
    box(6, CASE.top, z + 2, 26, CASE.lid, z + 18, E.WALL);
    box(24, CASE.bottom, z + 2, 26, CASE.top, z + 18, E.GLASS);
    set(23, 20, z + 1, E.WALL_TORCH);
  }
  westWindow(12);
  westWindow(36);
  westWindow(60);
  // Supported cubes can slump at their free edges; ash begins as a heap.
  box(10, CASE.bottom, 17, 20, 16, 27, E.SAND);
  box(8, CASE.bottom, 39, 22, 8, 53, E.ASH);
  box(10, 8, 41, 20, 10, 51, E.ASH);
  box(12, 10, 43, 18, 12, 49, E.ASH);
  box(10, CASE.bottom, 65, 20, 16, 75, E.STONE);

  // Sealed gas window opposite the powders: CO2 is not a smoke texture.
  box(50, floor, 12, 66, CASE.bottom, 32, E.WALL);
  box(64, CASE.bottom, 12, 66, CASE.lid, 32, E.WALL);
  box(50, CASE.bottom, 12, 64, CASE.lid, 14, E.WALL);
  box(50, CASE.bottom, 30, 64, CASE.lid, 32, E.WALL);
  box(50, CASE.top, 14, 64, CASE.lid, 30, E.WALL);
  box(50, CASE.bottom, 14, 52, CASE.top, 30, E.GLASS);
  box(52, CASE.bottom, 14, 64, 14, 30, E.CO2);
  set(63, 20, 13, E.WALL_TORCH);

  // Walk-onto bathing court, not an industrial tank. The deck rises four
  // cells on broad 1:2 stairs; its water is only three cells deep.
  box(42, floor, 46, 66, POOL.surface, POOL.front, E.WALL);
  box(42, floor, POOL.front, POOL.left, POOL.surface, 78, E.WALL);
  box(POOL.right, floor, POOL.front, 66, POOL.surface, 78, E.WALL);
  box(POOL.left, floor, POOL.back, POOL.right, POOL.surface, 78, E.WALL);
  box(POOL.left, floor, POOL.front, POOL.right, POOL.bed, POOL.back, E.WALL);
  box(POOL.left, POOL.bed, POOL.front, POOL.right, POOL.surface, POOL.back, E.WATER);
  for (let step = 0; step < 4; step++) {
    const z = 40 + step * 2;
    box(48, floor, z, 66, floor + step + 1, z + 2, E.WALL);
  }
  // Full-width submerged exit stairs, with two-cell-long treads.
  box(POOL.left, POOL.bed, 50, POOL.right, 6, 52, E.WALL);
  box(POOL.left, POOL.bed, 52, POOL.right, 5, 54, E.WALL);
  box(POOL.left, POOL.bed, 54, POOL.right, 4, 56, E.WALL);
  // Rear observation seat. The eight-cell east service strip stays open.
  box(54, POOL.surface, 76, 64, 8, 78, E.WALL);
  for (const z of [20, 44, 68, 84]) set(73, 11, z, E.WALL_TORCH);
  box(30, 10, 89, 46, 13, 90, E.WALL);
  for (const x of [32, 38, 44]) set(x, 11, 88, E.WALL_TORCH);

  return {
    plaques: [
      { cell: [38, 18, 1], normal: [0, 0, 1], text: 'THE AQUARIUM ARCADE' },
      { cell: [25, 4, 22], normal: [1, 0, 0], elementKey: 'SAND',
        text: 'Sand / a supported cube; its edges can settle into slopes.' },
      { cell: [25, 4, 46], normal: [1, 0, 0], elementKey: 'ASH',
        text: 'Ash / a light powder mound, kept dry behind glass.' },
      { cell: [25, 4, 70], normal: [1, 0, 0], elementKey: 'STONE',
        text: 'Stone / loose heavy grains, not a carved solid block.' },
      { cell: [50, 4, 22], normal: [-1, 0, 0], elementKey: 'CO2',
        text: 'Carbon dioxide / sealed gas; watch its distribution change.' },
      { cell: [42, 4, 62], normal: [-1, 0, 0], elementKey: 'WATER',
        text: 'Wading court / three cells deep. Broad exit steps at the front.' },
      { cell: [60, 8, 90], normal: [0, 0, -1],
        text: 'Observation nook / still water, dry specimens, one quiet room.' },
    ],
    landmarks: {
      entry: [38, floor, 4],
      promenade: [38, floor, 46],
      sandWindow: [30, floor, 22],
      gasWindow: [46, floor, 22],
      waterSteps: [56, POOL.surface, 48],
      wadingPool: [56, POOL.bed, 62],
      observationNook: [58, POOL.surface, 72],
      serviceStrip: [70, floor, 60],
    },
  };
}
