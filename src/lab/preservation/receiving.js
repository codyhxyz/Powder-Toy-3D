import { E } from '../../elements.js';
import { baseMaterial } from '../../industry/catalog.js';
import { hearthRegions, hearthStructureCells } from '../../industry/hearth.js';
import { ceilingLight } from './fixtures.js';

export function buildReceiving({ box, set }) {
  box(2, 1, 2, 78, 2, 106, E.CERAMIC);
  box(2, 22, 2, 78, 24, 46, E.CERAMIC);
  box(10, 22, 10, 70, 24, 36, E.GLASS);
  box(2, 2, 46, 78, 24, 48, E.CERAMIC);
  box(20, 4, 46, 56, 18, 48, E.GLASS);
  box(62, 2, 46, 74, 16, 48, E.EMPTY);
  box(6, 2, 6, 26, 7, 12, E.CERAMIC);
  box(6, 7, 6, 26, 8, 12, E.METAL);
  box(2, 2, 28, 12, 20, 44, E.CERAMIC);
  box(4, 3, 30, 11, 18, 42, E.EMPTY);
  box(11, 6, 30, 12, 16, 42, E.GLASS);
  ceilingLight(box, 5, 16, 32, 4);
  ceilingLight(box, 32, 20, 12, 12);
  ceilingLight(box, 54, 20, 34, 12);
  box(14, 1, 22, 68, 2, 24, E.GOLD);
  box(66, 1, 22, 68, 2, 76, E.GOLD);

  // Native decks: the same charge is visible from public and service sides.
  const devices = [];
  const machine = (id, type, x, y, z, extra = {}) => {
    const d = { id, type, x, y, z, rotation: 0, powered: true, ...extra };
    devices.push(d);
    if (type === 'hearth') {
      for (const at of hearthStructureCells(d)) set(...at, baseMaterial(type));
    } else box(x, y, z, x + 4, y + 1, z + 4, baseMaterial(type));
    return d;
  };
  for (const [x, z] of [[28, 50], [52, 70]]) box(x, 2, z, x + 2, 33, z + 2, E.METAL);
  box(28, 33, 50, 54, 35, 52, E.METAL);
  box(28, 33, 70, 54, 35, 72, E.METAL);
  // Finite hopper: gravity continues even with the drive disconnected.
  box(35, 13, 51, 36, 34, 56, E.GLASS);
  box(40, 13, 51, 41, 34, 56, E.GLASS);
  box(35, 13, 51, 41, 34, 52, E.GLASS);
  box(35, 18, 56, 41, 34, 57, E.GLASS);
  box(35, 34, 51, 41, 35, 57, E.GLASS);
  box(35, 13, 56, 36, 17, 72, E.GLASS);
  box(40, 13, 56, 41, 17, 60, E.GLASS);
  box(40, 13, 64, 41, 17, 72, E.GLASS);
  // Separator sends sand forward and rejected gold right, into retained bins.
  box(34, 8, 71, 42, 9, 80, E.WALL);
  box(34, 9, 71, 35, 17, 80, E.GLASS);
  box(41, 9, 71, 42, 17, 80, E.GLASS);
  box(35, 9, 79, 41, 17, 80, E.GLASS);
  box(35, 9, 71, 41, 12, 72, E.WALL);
  box(39, 8, 58, 50, 9, 66, E.WALL);
  box(39, 9, 58, 40, 12, 66, E.WALL);
  box(40, 9, 58, 50, 16, 59, E.GLASS);
  box(40, 9, 65, 50, 16, 66, E.GLASS);
  box(49, 9, 59, 50, 16, 65, E.GLASS);
  for (const z of [52, 56, 64, 68]) {
    machine(`receiving-sort-belt-${z}`, 'belt', 36, 12, z);
    box(37, 2, z + 1, 39, 12, z + 3, E.WALL);
  }
  machine('receiving-sand-separator', 'separator', 36, 12, 60, { filter: E.SAND });
  box(37, 2, 61, 39, 12, 63, E.WALL);
  for (let y = 26; y < 32; y++) for (let z = 52; z < 56; z++) for (let x = 36; x < 40; x++) {
    set(x, y, z, (x + y + z) % 2 ? E.NUGGETS : E.SAND);
  }

  // Cold scrap is heated by a finite-coal native hearth. The dry catch keeps
  // products rather than shipping them away or prescribing a finished casting.
  box(22, 8, 76, 32, 9, 92, E.WALL);
  box(22, 9, 76, 23, 30, 92, E.GLASS);
  box(31, 9, 76, 32, 30, 92, E.GLASS);
  box(23, 9, 76, 31, 30, 77, E.WALL);
  box(23, 9, 91, 31, 30, 92, E.GLASS);
  box(22, 30, 76, 32, 31, 92, E.WALL);
  box(23, 18, 76, 29, 25, 77, E.EMPTY);
  box(24, 2, 78, 28, 12, 82, E.WALL);
  box(23, 9, 81, 31, 10, 90, E.WALL);
  box(23, 10, 82, 24, 14, 90, E.WALL);
  box(30, 10, 82, 31, 14, 90, E.WALL);
  box(24, 10, 89, 30, 14, 90, E.WALL);
  box(22, 19, 67, 23, 25, 81, E.GLASS);
  box(29, 19, 67, 30, 25, 81, E.GLASS);
  box(22, 19, 67, 30, 25, 68, E.GLASS);
  box(22, 25, 67, 30, 26, 82, E.GLASS);
  box(24, 19, 68, 25, 25, 80, E.WALL);
  box(27, 19, 68, 28, 25, 80, E.WALL);
  box(24, 16, 80, 25, 25, 82, E.WALL);
  box(27, 16, 80, 28, 25, 82, E.WALL);
  box(24, 16, 81, 28, 25, 82, E.WALL);
  for (const z of [68, 72, 76]) {
    machine(`receiving-charge-belt-${z}`, 'belt', 24, 18, z);
    if (z < 76) box(25, 2, z + 1, 27, 18, z + 3, E.WALL);
  }
  const hearth = machine('receiving-coal-hearth', 'hearth', 24, 12, 78);
  const regions = hearthRegions(hearth);
  for (const at of regions.fuel) set(...at, E.BROKENCOAL);
  for (const at of regions.charge.filter(at => at[1] === 13)) set(...at, E.SCRAP);
  set(25, 19, 69, E.SCRAP);
  set(26, 19, 69, E.SCRAP);

  for (let step = 0; step < 9; step++) box(54, 2, 62 + step * 2, 58, 3 + step, 64 + step * 2, E.METAL);
  box(36, 10, 80, 58, 11, 94, E.METAL);
  for (const x of [36, 56]) for (const z of [82, 92]) box(x, 2, z, x + 2, 10, z + 2, E.METAL);
  box(35, 11, 80, 36, 14, 95, E.GLASS);
  box(58, 11, 80, 59, 14, 95, E.GLASS);
  box(36, 11, 94, 58, 14, 95, E.GLASS);
  box(36, 11, 80, 54, 14, 81, E.GLASS);
  box(4, 2, 98, 20, 7, 102, E.METAL);
  box(4, 7, 98, 20, 8, 102, E.CERAMIC);
  ceilingLight(box, 54, 30, 96, 12);
  ceilingLight(box, 8, 30, 88, 10);
  return {
    plaques: [
      { cell: [16, 12, 46], normal: [0, 0, -1], text: 'PRESERVATION / Every material. Unchanged. Forever.' },
      { cell: [16, 5, 11], normal: [0, 0, 1], text: 'POWER GALLERY / Follow gold. Controls drive decks. Gravity never switches off.' },
      { cell: [32, 8, 46], normal: [0, 0, -1], elementKey: 'SAND', text: '01 / SAND / 48 sand grains, 48 gold grains. Both streams stay in their bins.' },
      { cell: [22, 14, 46], normal: [0, 0, -1], elementKey: 'GLASS', text: 'GLASS / One window. The tower and its backstage are the same installation.' },
      { cell: [60, 10, 46], normal: [0, 0, -1], text: 'SERVICE TOUR / Through the east door. Stairs overlook the working foundry.' },
      { cell: [53, 16, 71], normal: [0, 0, 1], text: 'SAME CHARGE / Sand forward. Gold right. No intake removes the evidence.' },
      { cell: [31, 20, 86], normal: [1, 0, 0], text: 'COAL HEARTH / Six fuel grains. Four scrap grains. Dry catch. No refill.' },
      { cell: [18, 5, 101], normal: [0, 0, 1], text: 'SERVICE EXIT / Return down the stairs. Continue east through the marked gate.' },
    ],
    landmarks: {
      arrival: [16, 2, 20], publicView: [36, 2, 36], serviceDoor: [68, 2, 50],
      behindWindow: [62, 2, 60], serviceExit: [74, 2, 76], sortingView: [60, 2, 66],
      foundryView: [38, 11, 86], sortControls: [50, 2, 31], foundryControls: [52, 2, 94],
    },
    devices,
    stations: [
      { id: 'receiving-sort-control', at: [46, 2, 34],
        devices: devices.filter(d => d.id.startsWith('receiving-sort-') || d.type === 'separator').map(d => d.id),
        label: 'FINITE SORTING TOWER', initialOn: false, pulse: false },
      { id: 'receiving-foundry-control', at: [48, 2, 97],
        devices: devices.filter(d => d.id.startsWith('receiving-charge-') || d.type === 'hearth').map(d => d.id),
        label: 'COAL HEARTH AND CHARGE LINE', initialOn: false, pulse: false },
    ],
  };
}
