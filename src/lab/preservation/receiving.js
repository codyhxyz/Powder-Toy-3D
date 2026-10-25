import { E } from '../../elements.js';
import { ceilingLight } from './fixtures.js';

// Portal's public chamber / backstage contrast: the window and its machinery
// are two views of ONE exhibit, not two specimens (Valve developer commentary).
export function buildReceiving({ box, set }) {
  box(2, 1, 2, 78, 2, 106, E.CERAMIC);
  // Low, bright public gallery. Skylights align with the enclosing roof.
  box(2, 22, 2, 78, 24, 46, E.CERAMIC);
  box(10, 22, 10, 70, 24, 36, E.GLASS);
  box(2, 2, 46, 78, 24, 48, E.CERAMIC);
  box(20, 4, 46, 56, 18, 48, E.GLASS);
  box(62, 2, 46, 74, 16, 48, E.EMPTY);
  // Reception desk and a conspicuously empty observation booth.
  box(6, 2, 6, 26, 7, 12, E.CERAMIC);
  box(6, 7, 6, 26, 8, 12, E.METAL);
  box(2, 2, 28, 12, 20, 44, E.CERAMIC);
  box(4, 3, 30, 11, 18, 42, E.EMPTY);
  box(11, 6, 30, 12, 16, 42, E.GLASS);
  ceilingLight(box, 5, 16, 32, 4);
  ceilingLight(box, 32, 20, 12, 12);
  ceilingLight(box, 54, 20, 34, 12);
  // The promise is neat. The loose grains and their infrastructure are not.
  box(14, 1, 22, 68, 2, 24, E.GOLD);
  box(66, 1, 22, 68, 2, 76, E.GOLD);
  box(22, 2, 48, 54, 3, 66, E.WALL);
  box(22, 3, 48, 24, 7, 66, E.WALL);
  box(52, 3, 48, 54, 7, 66, E.WALL);
  box(24, 3, 64, 52, 7, 66, E.WALL);
  box(24, 3, 48, 52, 4, 50, E.WALL);
  box(30, 3, 52, 46, 5, 62, E.SAND);
  for (const x of [24, 50]) box(x, 2, 50, x + 2, 44, 52, E.METAL);
  // Tapered finite charge, visible behind the same public pane.
  for (let tier = 0; tier < 7; tier++) {
    const y = 22 + tier * 2, lo = 33 - tier, hi = 39 + tier;
    box(24, y, 50, lo, y + 2, 64, E.METAL);
    box(hi, y, 50, 52, y + 2, 64, E.METAL);
    box(lo, y, 50, hi, y + 2, 53, E.GLASS);
    box(lo, y, 61, hi, y + 2, 64, E.METAL);
  }
  box(24, 36, 50, 27, 44, 64, E.METAL);
  box(45, 36, 50, 52, 44, 64, E.METAL);
  box(27, 36, 50, 45, 44, 53, E.GLASS);
  box(27, 36, 61, 45, 44, 64, E.METAL);
  box(24, 44, 50, 52, 45, 64, E.GLASS);
  box(30, 37, 54, 42, 41, 60, E.SAND);
  box(32, 18, 53, 33, 22, 61, E.METAL);
  box(39, 18, 53, 40, 22, 61, E.METAL);
  box(33, 18, 53, 39, 22, 54, E.GLASS);
  box(33, 18, 60, 39, 22, 61, E.METAL);
  // A lateral service route reveals that the polished window has a back.
  box(2, 2, 68, 42, 3, 102, E.METAL);
  box(4, 3, 98, 36, 7, 102, E.METAL);
  box(4, 7, 98, 36, 8, 102, E.CERAMIC);
  for (const z of [72, 84]) {
    box(4, 8, z, 50, 10, z + 2, E.METAL);
    box(48, 2, z, 50, 10, z + 2, E.METAL);
  }
  box(8, 3, 72, 20, 4, 82, E.ASH);
  box(6, 2, 56, 14, 6, 64, E.METAL);
  ceilingLight(box, 54, 30, 72, 12);
  ceilingLight(box, 18, 30, 90, 12);
  set(60, 8, 47, E.WALL_TORCH);
  return {
    plaques: [
      { cell: [16, 12, 46], normal: [0, 0, -1], text: 'PRESERVATION / Every material. Unchanged. Forever.' },
      { cell: [16, 5, 11], normal: [0, 0, 1], text: 'ALL MATERIALS ACCOUNTED FOR. Please follow the gold line.' },
      { cell: [32, 8, 46], normal: [0, 0, -1], elementKey: 'SAND',
        text: '01 / SAND / One measured charge. Watch the grains, not the display.' },
      { cell: [20, 18, 46], normal: [0, 0, -1], elementKey: 'GLASS',
        text: 'GLASS / The window is also part of the collection.' },
      { cell: [60, 10, 46], normal: [0, 0, -1], text: 'Tour route diverted through service access. Nothing has changed.' },
      { cell: [49, 6, 84], normal: [1, 0, 0], text: 'SAME SPECIMEN, OTHER SIDE / One charge. No automatic refill.' },
      { cell: [18, 5, 101], normal: [0, 0, 1], text: 'Sweepings retained for accounting. Disposal would reduce the collection.' },
    ],
    landmarks: {
      arrival: [16, 2, 20], publicView: [36, 2, 36],
      serviceDoor: [68, 2, 50], behindWindow: [62, 2, 60], serviceExit: [74, 2, 76],
    },
  };
}
