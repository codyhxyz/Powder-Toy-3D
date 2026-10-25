import { E } from '../../elements.js';
import { buildMuseum } from './museum.js';
import { buildReactor } from './reactor.js';
import { buildContainment } from './containment.js';

export const LAB_STUDIES_SIZE = [256, 96, 128];
export const LAB_STUDIES_SPAWN = [128, 2, 16];

// Intentional (user request, 2026-10-25): hand-authored alternatives to play
// side by side before choosing the architecture of the generated collection.
export const LAB_STUDIES_HALLS = [
  { key: 'museum', name: 'A · Aquarium gallery', origin: [6, 0, 28], build: buildMuseum },
  { key: 'reactor', name: 'B · Reactor atrium', origin: [90, 0, 28], build: buildReactor },
  { key: 'containment', name: 'C · Containment block', origin: [174, 0, 28], build: buildContainment },
];

export function buildLabStudies({ box, set }) {
  // A low, roofed concourse connects the three independently authored halls.
  // No sample placement here depends on the catalog or its size.
  box(6, 0, 4, 250, 2, 120, E.WALL);
  box(6, 2, 4, 250, 24, 6, E.WALL);
  box(6, 2, 4, 8, 24, 28, E.WALL);
  box(248, 2, 4, 250, 24, 28, E.WALL);
  box(6, 24, 4, 250, 26, 28, E.WALL);
  box(6, 2, 26, 250, 24, 28, E.WALL);
  // Daylight through real skylights, with light-only fixtures for night.
  box(12, 24, 10, 244, 26, 20, E.GLASS);
  box(12, 2, 12, 244, 3, 14, E.BRICK);
  for (const x of [20, 62, 104, 146, 188, 230]) {
    box(x, 9, 6, x + 2, 12, 7, E.WALL_TORCH);
  }
  const plaques = [{
    cell: [128, 10, 5], normal: [0, 0, 1],
    text: 'Lab Studies · A: gallery · B: vats + hopper · C: containment · V: walk',
  }, {
    cell: [120, 6, 26], normal: [0, 0, -1],
    text: 'Hand-built studies. Q frees the mouse; click specimen labels for facts.',
  }];
  const halls = [];
  for (const hall of LAB_STUDIES_HALLS) {
    const [ox, oy, oz] = hall.origin;
    const built = hall.build({
      box: (x0, y0, z0, x1, y1, z1, id, extra) => box(x0 + ox, y0 + oy, z0 + oz, x1 + ox, y1 + oy, z1 + oz, id, extra),
      set: (x, y, z, id, extra) => set(x + ox, y + oy, z + oz, id, extra),
    });
    box(ox + 32, 2, 26, ox + 44, 14, 30, E.EMPTY);
    plaques.push({ cell: [ox + 23, 10, 26], normal: [0, 0, -1], text: hall.name });
    for (const p of built.plaques) {
      plaques.push({ ...p, cell: p.cell.map((v, i) => v + hall.origin[i]) });
    }
    halls.push({
      key: hall.key, name: hall.name,
      landmarks: Object.fromEntries(Object.entries(built.landmarks ?? {}).map(([k, at]) => [k, at.map((v, i) => v + hall.origin[i])])),
    });
  }
  return { plaques, halls };
}

// Plaques are authored beside their geometry, never a second coordinate list.
export const labStudiesPlaques = () => buildLabStudies({ box() {}, set() {} }).plaques;
