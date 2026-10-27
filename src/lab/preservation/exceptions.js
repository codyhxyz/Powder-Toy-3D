import { E } from '../../elements.js';
import { hearthRegions, hearthStructureCells } from '../../industry/hearth.js';

export function buildExceptions({ box, set }) {
  const FLOOR = 2;
  const shell = (x0, y0, z0, x1, y1, z1, id) => {
    box(x0, y0, z0, x1, y1, z1, id);
    box(x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1, E.EMPTY);
  };
  box(40, FLOOR, 6, 72, 26, 34, E.INSULATOR);
  box(44, 5, 10, 68, 23, 30, E.EMPTY);
  box(40, 8, 14, 44, 18, 26, E.EMPTY);
  shell(44, 5, 10, 64, 21, 30, E.GLASS);
  box(48, 6, 16, 58, 14, 24, E.ICE);
  box(40, 2, 6, 72, 4, 34, E.CERAMIC);
  box(40, 24, 6, 72, 26, 34, E.CERAMIC);
  box(70, 4, 6, 72, 24, 34, E.METAL);

  // Heat must physically ignite the finite thermite charge. No hot seed,
  // reaction timer, replenishment or map-owned temperature/matter updates.
  const hearth = {
    id: 'exceptions-reaction-hearth', type: 'hearth',
    x: 16, y: 8, z: 10, rotation: 0, powered: true,
  };
  box(8, FLOOR, 4, 30, 12, 6, E.CERAMIC);
  box(8, FLOOR, 6, 10, 12, 28, E.CERAMIC);
  box(28, FLOOR, 6, 30, 12, 28, E.CERAMIC);
  box(28, FLOOR, 28, 30, 12, 30, E.CERAMIC);
  box(16, FLOOR, 10, 20, 8, 14, E.CERAMIC);
  box(10, FLOOR, 14, 28, 3, 26, E.TUNGSTEN);
  box(10, 3, 14, 12, 7, 26, E.TUNGSTEN);
  box(26, 3, 14, 28, 7, 26, E.TUNGSTEN);
  box(12, 3, 24, 26, 5, 26, E.TUNGSTEN);
  box(16, 3, 14, 20, 7, 18, E.TUNGSTEN);
  box(17, 7, 16, 19, 8, 18, E.METAL);
  for (const at of hearthStructureCells(hearth)) set(...at, E.TUNGSTEN);
  for (const at of hearthRegions(hearth).fuel) set(...at, E.COAL);
  box(16, 12, 11, 20, 18, 14, E.TUNGSTEN);
  box(17, 12, 12, 19, 18, 13, E.EMPTY);
  box(17, 9, 12, 19, 17, 13, E.THERMITE);
  // Wire admission is reserved at x=13 from the port's height to the roof.
  box(56, 18, 34, 60, 22, 37, E.METAL);
  box(56, 18, 39, 60, 22, 42, E.METAL);
  box(2, FLOOR, 42, 60, 48, 46, E.CERAMIC);
  box(58, FLOOR, 42, 60, 18, 46, E.METAL);
  box(60, 18, 42, 78, 22, 46, E.METAL);
  box(22, FLOOR, 56, 78, 48, 60, E.CERAMIC);
  box(22, FLOOR, 56, 24, 18, 60, E.METAL);
  box(2, 18, 56, 22, 22, 60, E.METAL);

  // The excessive chamber remains deliberately empty.
  box(26, FLOOR, 64, 30, 48, 104, E.CERAMIC);
  box(30, FLOOR, 64, 76, 48, 68, E.CERAMIC);
  box(30, FLOOR, 100, 76, 48, 104, E.CERAMIC);
  box(72, FLOOR, 68, 76, 48, 100, E.CERAMIC);
  box(28, FLOOR, 68, 30, 48, 100, E.WALL);
  box(30, FLOOR, 66, 74, 48, 68, E.WALL);
  box(30, FLOOR, 100, 74, 48, 102, E.WALL);
  box(72, FLOOR, 68, 74, 48, 100, E.WALL);
  box(26, 10, 72, 30, 32, 96, E.GLASS);
  const frame = (x, z0, z1, top, id) => {
    box(x, FLOOR, z0, x + 2, top, z0 + 2, id);
    box(x, FLOOR, z1 - 2, x + 2, top, z1, id);
    box(x, FLOOR, z0 + 2, x + 2, 4, z1 - 2, id);
    box(x, top - 2, z0 + 2, x + 2, top, z1 - 2, id);
  };
  frame(32, 68, 100, 44, E.WALL);
  frame(40, 72, 96, 38, E.METAL);
  frame(48, 76, 92, 32, E.WALL);
  box(54, FLOOR, 78, 66, 3, 90, E.METAL);
  box(56, 3, 80, 64, 4, 88, E.CERAMIC);
  for (let step = 0; step < 8; step++) {
    const z = 64 + step * 2;
    box(10, FLOOR, z, 26, 3 + step, z + 2, E.CERAMIC);
  }
  box(2, FLOOR, 80, 26, 10, 106, E.CERAMIC);
  box(24, 10, 80, 26, 11, 96, E.METAL);
  box(2, 10, 80, 4, 12, 96, E.METAL);
  box(2, 10, 96, 10, 22, 98, E.CERAMIC);
  box(18, 10, 96, 26, 22, 98, E.CERAMIC);
  box(2, 14, 96, 10, 21, 98, E.GLASS);
  box(18, 14, 96, 26, 21, 98, E.GLASS);
  box(2, 10, 98, 4, 22, 104, E.METAL);
  box(4, 10, 103, 12, 12, 105, E.CERAMIC);
  for (const x of [12, 36, 54]) set(x, 20, 41, E.WALL_TORCH);
  for (const x of [28, 50, 70]) set(x, 20, 55, E.WALL_TORCH);
  for (const [x, y, z] of [[39, 22, 12], [25, 22, 70], [25, 24, 98], [42, 26, 73], [42, 26, 94]]) set(x, y, z, E.WALL_TORCH);
  return {
    plaques: [
      { cell: [18, 4, 25], normal: [0, 0, 1], elementKey: 'THERMITE', text: 'THERMITE / Coal heats the finite charge. Heat, not a timer, ignites it.' },
      { cell: [12, 4, 25], normal: [0, 0, 1], text: 'ENABLE / Lamp means powered draft, not safe. OFF cannot stop hot chemistry.' },
      { cell: [9, 8, 27], normal: [0, 0, 1], text: 'DANGER / Molten metal, flame and splash. Stand back; no blast-proof glass.' },
      { cell: [29, 8, 29], normal: [0, 0, 1], text: 'FINITE LOAD / 6 coal + 16 thermite. Reload by hand only after cooling.' },
      { cell: [40, 8, 30], normal: [-1, 0, 0], elementKey: 'ICE', text: 'ICE / Insulated, not refrigerated. This specimen can melt.' },
      { cell: [56, 8, 33], normal: [0, 0, 1], text: 'MAINTENANCE / Cooling disconnected. Insulation only slows heat flow.' },
      { cell: [26, 12, 70], normal: [-1, 0, 0], text: 'CONTAINMENT SUCCESSFUL / Specimen presence under review.' },
      { cell: [26, 14, 98], normal: [-1, 0, 0], elementKey: 'SINGULARITY', text: 'SINGULARITY / Empty: starved specimens evaporate; fed specimens can burst.' },
      { cell: [3, 16, 100], normal: [1, 0, 0], text: 'INSPECTION RECORD / No persistent specimen. Material facts remain available.' },
    ],
    devices: [hearth],
    stations: [{
      id: 'exceptions-reaction-station', at: [22, FLOOR, 34],
      devices: [hearth.id], initialOn: false, pulse: false,
      label: 'REACTION HEARTH / FINITE LOAD',
    }],
    landmarks: {
      reactionView: [14, FLOOR, 32], reactionControls: [26, FLOOR, 31],
      entry: [6, FLOOR, 30], coldView: [34, FLOOR, 22], coolingInspection: [56, FLOOR, 38],
      firstPassage: [68, FLOOR, 40], crossAisle: [40, FLOOR, 51], secondPassage: [12, FLOOR, 62],
      reveal: [18, 7, 72], emptyView: [20, 10, 84], finalDais: [18, 10, 92], rearInspection: [14, 10, 101],
    },
  };
}
