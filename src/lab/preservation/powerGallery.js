import { E } from '../../elements.js';

// A press launches real native spark trains through the service cables.
// Lamps' native afterglow displays the arriving wave; no animation script.
export function buildPowerGallery({ box }) {
  const lamps = [];
  for (let x = 12; x <= 68; x += 4) for (const z of [6, 100]) lamps.push([x, 36, z]);
  for (let z = 10; z <= 98; z += 4) for (const x of [6, 74]) lamps.push([x, 36, z]);
  for (const [x, y, z] of lamps) {
    box(x - 1, y - 1, z - 1, x + 2, y + 2, z + 2, E.INSULATOR);
    box(x, y, z, x + 1, y + 1, z + 1, E.LAMP);
  }
  return {
    stations: [{ id: 'light-wave', at: [8, 2, 28], devices: [], lamps,
      label: 'LIGHT WAVE', pulse: true, initialOn: false }],
    landmarks: { powerConsole: [10, 2, 24] },
    plaques: [],
  };
}
