import { E, ELEMENTS } from '../../elements.js';
import { buildReceiving } from './receiving.js';
import { buildProcessing } from './processing.js';
import { buildExceptions } from './exceptions.js';
import { buildArchive } from './archive.js';
import { ceilingLight } from './fixtures.js';

export const PRESERVATION_SIZE = [256, 96, 128];
export const PRESERVATION_SPAWN = [20, 28, 28];
export const PRESERVATION_CHAPTERS = [
  { key: 'receiving', origin: [4, 26, 8], build: buildReceiving },
  { key: 'processing', origin: [84, 26, 8], build: buildProcessing },
  { key: 'exceptions', origin: [164, 26, 8], build: buildExceptions },
];
export const PRESERVATION_GATES = [
  [82, 28, 78, 86, 42, 90],
  [162, 28, 32, 166, 42, 44],
];

// Intentional (user request, 2026-10-25): one authored narrative, not competing
// specimen rooms. Only the inventory archive is laid out from the catalog.
export function buildPreservation({ box, set, elements = ELEMENTS }) {
  const plaques = [], chapters = [];
  for (const chapter of PRESERVATION_CHAPTERS) {
    const [ox, oy, oz] = chapter.origin;
    const localBox = (x0, y0, z0, x1, y1, z1, id, extra) => box(x0 + ox, y0 + oy, z0 + oz, x1 + ox, y1 + oy, z1 + oz, id, extra);
    localBox(0, 0, 0, 80, 2, 108, E.WALL);
    localBox(0, 2, 0, 2, 48, 108, E.WALL);
    localBox(78, 2, 0, 80, 48, 108, E.WALL);
    localBox(2, 2, 0, 78, 48, 2, E.CERAMIC);
    localBox(2, 2, 106, 78, 48, 108, E.CERAMIC);
    localBox(0, 48, 0, 80, 50, 108, E.WALL);
    localBox(10, 48, 8, 70, 50, 36, E.GLASS);
    localBox(32, 48, 68, 68, 50, 98, E.GLASS);
    ceilingLight(localBox, 14, 46, 48, 12);
    ceilingLight(localBox, 50, 46, 96, 12);
    const built = chapter.build({
      box: localBox,
      set: (x, y, z, id, extra) => set(x + ox, y + oy, z + oz, id, extra),
    });
    for (const p of built.plaques) plaques.push({ ...p, cell: p.cell.map((n, i) => n + chapter.origin[i]) });
    chapters.push({
      key: chapter.key,
      landmarks: Object.fromEntries(Object.entries(built.landmarks).map(([key, at]) => [key, at.map((n, i) => n + chapter.origin[i])])),
    });
  }
  for (const gate of PRESERVATION_GATES) box(...gate, E.EMPTY);
  // An enclosed side stair descends from processing to the inventory floor.
  box(80, 0, 114, 156, 2, 128, E.WALL);
  box(80, 2, 114, 82, 46, 128, E.WALL);
  box(154, 2, 114, 156, 46, 128, E.WALL);
  box(80, 2, 126, 156, 46, 128, E.WALL);
  box(80, 46, 114, 156, 48, 128, E.WALL);
  box(96, 46, 118, 146, 48, 124, E.GLASS);
  for (let step = 0; step < 26; step++) {
    const x = 86 + step * 2;
    box(x, 2, 120, x + 2, 3 + step, 126, E.METAL);
  }
  box(138, 2, 116, 154, 28, 126, E.METAL);
  box(140, 28, 114, 152, 42, 118, E.EMPTY);
  ceilingLight(box, 100, 44, 122, 12);
  plaques.push({ cell: [148, 32, 117], normal: [0, 0, 1], text: 'MATERIAL ARCHIVE DOWNSTAIRS / Every other material. Follow the stairs.' });
  // The sign above has a physical jamb, not a free-floating text anchor.
  box(148, 28, 116, 150, 36, 118, E.CERAMIC);
  plaques.push({ cell: [5, 34, 28], normal: [1, 0, 0],
    text: 'ALL MATERIALS / Archive downstairs, through processing. Tour continues ahead.' });
  plaques.push({ cell: [88, 34, 114], normal: [0, 0, -1],
    text: 'MATERIAL ARCHIVE / Follow this rear wall to the marked descending stairs.' });

  const featured = plaques.filter(p => p.elementKey).map(p => p.elementKey);
  if (new Set(featured).size !== featured.length) throw new Error('Preservation repeats a primary specimen.');
  const archive = buildArchive({ box, elements, featured });
  plaques.push(...archive.plaques);
  return { plaques, chapters, stocks: archive.stocks, catalog: archive.catalog };
}

let manifest;
export const preservationManifest = () => manifest ??= buildPreservation({ box() {}, set() {} });
