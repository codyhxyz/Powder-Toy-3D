import { E } from '../elements.js';

export const NUCLEAR_BUNKER_SIZE = [256, 96, 128];
export const NUCLEAR_BUNKER_SPAWN = [43.5, 33, 63.5];

// TPT saves #5 (Nuclear bunker), #9 (Tsar Bomb Timed), and #37
// (Bunker Smasher): a protected room, deliberate arming, and a range for
// comparing how a layered structure fares under different tests.
const TESTS = [
  { key: 'buster', x: 147, z: 28, head: 39, w: 3, d: 3, recipe: E.LAVA,
    text: '01 BUNKER BUSTER / Heat the C-4 primer; its blast sets off the TNT.' },
  { key: 'thermite', x: 173, z: 53, head: 60, w: 5, d: 5, recipe: E.LAVA,
    text: '02 THERMITE / Ignite the bed to melt through its steel target.' },
  { key: 'nitro', x: 193, z: 78, head: 73, w: 2, d: 2, recipe: E.LAVA,
    text: '03 NITRO SHOCK / Drop hot slag into the nitroglycerin pan.' },
  { key: 'fission', x: 194, z: 103, head: 62, w: 7, d: 7, recipe: E.PLUTONIUM,
    text: '04 FISSION / Fill the test chamber. Wait for neutron pulses.' },
];
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const keyOf = p => p.join(',');

// One face-connected conductor, in an insulating sleeve. Components replace
// the endpoints; the openings are exposed console faces and hardware ports.
function stampCable(set, points, ports = []) {
  const cells = new Map();
  for (let i = 1; i < points.length; i++) {
    const p = [...points[i - 1]], end = points[i], axis = p.findIndex((n, j) => n !== end[j]);
    cells.set(keyOf(p), p.slice());
    if (axis < 0) continue;
    if (p.some((n, j) => j !== axis && n !== end[j])) throw new Error('Cable bends must be face-connected');
    while (p[axis] !== end[axis]) {
      p[axis] += Math.sign(end[axis] - p[axis]);
      cells.set(keyOf(p), p.slice());
    }
  }
  const openings = new Set(ports.map(keyOf));
  for (const p of cells.values()) for (const face of FACES) {
    const n = p.map((v, i) => v + face[i]), key = keyOf(n);
    if (!cells.has(key) && !openings.has(key)) set(...n, E.INSULATOR);
  }
  for (const p of cells.values()) set(...p, E.METAL);
}

function buildRange(box, set) {
  const [nx, , nz] = NUCLEAR_BUNKER_SIZE;
  box(0, 0, 0, nx, 2, nz, E.WALL);
  box(0, 2, 0, nx, 16, nz, E.ROCK);
  box(78, 15, 10, 245, 16, 118, E.BRICK);
  for (const z of [11, 116]) box(78, 15, z, 245, 16, z + 1, E.CERAMIC);
  for (const z of [13, 112]) for (let x = 97; x < 237; x += 12) box(x, 15, z, x + 7, 16, z + 1, E.INSULATOR);

  // Half-dome with sealed footings. The narrowest radial increment is >2
  // cells, so no stair-step in the voxel shell exposes a face of the jacket.
  for (let z = 7; z < 115; z++) for (let x = 115; x < 239; x++) {
    const dx = (x + 0.5 - 177) / 49, dz = (z + 0.5 - 61) / 45;
    const r2 = dx * dx + dz * dz;
    for (let y = 16; y < 49; y++) {
      const dy = (y + 0.5 - 16) / 33, r = Math.sqrt(r2 + dy * dy);
      if (r > 1) {
        if (y < 23 && r2 < (1.2 - (y - 16) * 0.027) ** 2) set(x, y, z, E.ROCK);
      } else if (r > 0.929) set(x, y, z, E.BRICK);
      else if (r > 0.849) set(x, y, z, y < 19 ? E.BRICK : E.WATER);
      else if (r > 0.788) set(x, y, z, E.METAL);
      else if (r > 0.725) set(x, y, z, E.TITANIUM);
    }
  }

  // Footings, banded columns, cap beams and hangers over the test bays.
  for (const x of [85, 231]) for (const z of [13, 112]) {
    box(x - 3, 16, z - 3, x + 7, 20, z + 7, E.BRICK);
    box(x, 20, z, x + 4, 77, z + 4, E.TITANIUM);
    for (const y of [24, 38, 52, 66]) box(x - 1, y, z - 1, x + 5, y + 2, z + 5, E.CERAMIC);
  }
  for (const x of [85, 231]) box(x, 73, 13, x + 4, 77, 116, E.TITANIUM);
  for (const z of [13, 112]) box(85, 73, z, 235, 77, z + 4, E.TITANIUM);
  for (const { x, z, head } of TESTS) {
    box(85, 73, z - 2, 235, 75, z + 3, E.TITANIUM);
    for (const dz of [-9, 9]) {
      box(x - 2, Math.min(head, 73), z + dz, x + 2, 75, z + dz + 2, E.TITANIUM);
      box(x - 2, 73, z - 9, x + 2, 75, z + 11, E.TITANIUM);
    }
  }
}

function buildVault(box) {
  box(146, 2, 42, 211, 21, 86, E.TUNGSTEN);
  box(148, 4, 44, 209, 19, 84, E.DIAMOND);
  box(150, 6, 46, 207, 17, 82, E.EMPTY);
  box(151, 5, 63, 206, 6, 77, E.METAL);
  // View out of the east bulkhead into a sunken inspection trench.
  box(207, 8, 52, 211, 15, 70, E.GLASS);
  box(211, 6, 50, 246, 17, 72, E.EMPTY);
  box(211, 5, 50, 246, 6, 72, E.BRICK);
  for (let i = 0; i < 10; i++) box(226 + i * 2, 6, 61, 228 + i * 2, 7 + i, 72, E.BRICK);
  box(204, 6, 51, 207, 8, 71, E.TUNGSTEN);
  for (const x of [176, 194]) box(x, 6, 48, x + 6, 9, 56, E.CERAMIC);
  for (const x of [169, 183, 197]) {
    box(x, 15, 60, x + 4, 16, 63, E.LAMP);
    box(x, 16, 60, x + 4, 17, 63, E.BATTERY);
  }

  // Broad two-cell treads, then a 90-degree turn under the berm. Offset
  // armored openings form the two baffles of the command-room airlock.
  for (let i = 0; i <= 26; i++) {
    const x = 62 + 2 * i, y = 33 - i;
    box(x, y - 1, 95, x + 2, y, 109, E.TUNGSTEN);
    box(x, y, 95, x + 2, Math.max(17, y + 9), 109, E.EMPTY);
    box(x, y - 1, 94, x + 2, y + 2, 95, E.BRICK);
    box(x, y - 1, 109, x + 2, y + 2, 110, E.BRICK);
  }
  box(113, 6, 63, 125, 7, 109, E.TUNGSTEN);
  box(113, 7, 63, 125, 15, 109, E.EMPTY);
  box(113, 6, 63, 151, 7, 77, E.TUNGSTEN);
  box(113, 7, 63, 151, 15, 77, E.EMPTY);
  for (const [x, lo, hi] of [[154, 64, 70], [162, 72, 78]]) {
    box(x, 6, 46, x + 2, 17, 82, E.TUNGSTEN);
    box(x, 6, lo, x + 2, 15, hi, E.EMPTY);
  }
  for (const x of [116, 130, 144, 157]) {
    box(x, 14, 67, x + 3, 15, 69, E.LAMP);
    box(x, 15, 67, x + 3, 16, 69, E.BATTERY);
  }
}

function buildDeck(box) {
  for (const x of [21, 56]) for (const z of [22, 103]) {
    box(x, 16, z, x + 4, 31, z + 4, E.TUNGSTEN);
    box(x - 1, 16, z - 1, x + 5, 19, z + 5, E.BRICK);
  }
  box(18, 30, 19, 62, 32, 110, E.BRICK);
  box(18, 32, 19, 62, 33, 110, E.CERAMIC);
  box(18, 33, 19, 20, 36, 110, E.TUNGSTEN);
  box(20, 33, 19, 62, 36, 21, E.TUNGSTEN);
  box(20, 33, 109, 62, 36, 110, E.TUNGSTEN);
  box(60, 33, 21, 62, 35, 95, E.TUNGSTEN);
  box(60, 35, 21, 62, 44, 95, E.GLASS);
  for (const z of [21, 39, 64, 89, 94]) box(60, 35, z, 62, 45, z + 1, E.TUNGSTEN);
  box(60, 44, 21, 62, 45, 95, E.TUNGSTEN);
  for (let z = 24; z < 95; z += 6) box(47, 32, z, 49, 33, z + 3, E.METAL);
}

function buildPayloads(box) {
  // Buster: cast blocks are stationary, even without their breakaway carrier.
  box(139, 32, 21, 155, 33, 36, E.CERAMIC);
  box(145, 33, 25, 150, 37, 32, E.TNT);
  box(145, 37, 26, 150, 38, 31, E.C4);
  for (const z of [21, 35]) box(139, 33, z, 155, 41, z + 1, E.CERAMIC);
  box(139, 33, 22, 140, 39, 35, E.GLASS);

  // Thermite's own hot molten-metal product is what attacks the steel coupon.
  box(164, 51, 44, 183, 59, 63, E.CERAMIC);
  box(166, 51, 46, 181, 52, 61, E.METAL);
  box(166, 52, 46, 181, 59, 61, E.THERMITE);
  box(164, 53, 47, 166, 58, 60, E.GLASS);

  // The nitro rests against glass; it is the cloned lava which falls. V2's
  // liquid column has a dedicated LAVA → NITRO landing rule, plus hot contact.
  box(188, 48, 73, 199, 53, 84, E.GLASS);
  box(189, 49, 74, 198, 52, 83, E.NITRO);
  box(189, 52, 74, 198, 53, 83, E.EMPTY);
  for (const z of [73, 83]) box(188, 53, z, 199, 73, z + 1, E.TITANIUM);
  box(198, 53, 74, 199, 73, 83, E.GLASS);

  // No fissile cells at boot: the armed head fills a glass hopper surrounded
  // by a closed water sleeve. Native plutonium emits real neutron packets;
  // neutron is a tool/particle, not a valid PCLN material ctype.
  box(182, 33, 91, 207, 63, 116, E.GLASS);
  box(183, 34, 92, 206, 62, 115, E.WATER);
  box(185, 34, 94, 204, 63, 113, E.GLASS);
  box(186, 36, 95, 203, 62, 112, E.EMPTY);
}

export function buildNuclearBunker({ box, set }) {
  buildRange(box, set);
  buildVault(box);
  buildDeck(box);
  buildPayloads(box);

  const plaques = [];
  const plate = (cell, normal, text) => plaques.push({ cell, normal, text });
  plate([60, 44, 57], [-1, 0, 0], 'NUCLEAR BUNKER / Aim at a button and press E. Reload the map to reset.');
  plate([60, 38, 94], [-1, 0, 0], 'COMMAND VAULT / Take the stairs, then turn left at the bottom.');
  plate([145, 13, 77], [0, 0, -1], 'AIRLOCK / Follow the offset blast baffles into the command room.');
  plate([163, 12, 62], [1, 0, 0], 'CORE / Tungsten bulkheads and a diamond liner protect the crew.');
  plate([207, 12, 61], [-1, 0, 0], 'VIEWPORT / Four cells of glass facing the inspection trench.');
  // A cross-section legend on the approach to the dome, readable from the range.
  for (const [z, id, text] of [
    [26, E.BRICK, 'OUTER SHELL / Sacrificial brick breaks; the rock berm backs it.'],
    [46, E.GLASS, 'WATER JACKET / Sealed coolant absorbs heat and damps shock.'],
    [66, E.TITANIUM, 'ARMOR / Steel spreads heat; titanium stands up to the shock.'],
  ]) {
    box(101, 16, z, 104, 24, z + 9, id);
    plate([101, 21, z + 4], [-1, 0, 0], text);
  }

  const tests = TESTS.map(({ key, x, z, head, w, d, recipe, text }) => {
    const button = [54, 37, z], battery = [55, 37, z];
    box(54, 33, z - 2, 58, 40, z + 4, E.CERAMIC);
    stampCable(set, [[54, 36, z], [54, 23, z], [88, 23, z], [88, 77, z], [x, 77, z], [x, head + 1, z]], [button]);
    set(...button, E.BUTTON);
    set(...battery, E.BATTERY);
    // In V2 PSCN turns PCLN on. The head copies down into the one-cell
    // ignition gap (or open hopper) at the recipe's normal temperature.
    box(x - w - 1, head + 1, z - d - 1, x + w + 2, head + 3, z + d + 2, E.INSULATOR);
    box(x - w, head + 1, z - d, x + w + 1, head + 2, z + d + 1, E.PSCN);
    box(x - w - 1, head, z - d - 1, x + w + 2, head + 1, z + d + 2, E.INSULATOR);
    box(x - w, head, z - d, x + w + 1, head + 1, z + d + 1, E.PCLN, { ctype: recipe, life: 0 });
    // Re-open the long riser's connection through the back of the head.
    set(x, head + 2, z, E.METAL);
    plate([54, 39, z], [-1, 0, 0], text);
    return { key, button, battery, clone: [x, head, z], recipe };
  });

  const alarms = [
    { sensor: [147, 32, 28], lamp: [169, 14, 50], label: 'BUSTER PAD / Heat alarm' },
    { sensor: [173, 50, 53], lamp: [173, 14, 54], label: 'THERMITE PAD / Heat alarm' },
  ].map(({ sensor, lamp, label }) => {
    const [x, y, z] = sensor, [lx, , lz] = lamp;
    stampCable(set, [[x, y - 1, z], [x, 16, z], [lx, 16, z], [lx, 16, lz], [lx, 15, lz]], [sensor, lamp]);
    set(...sensor, E.TSNS, { temp: 130 });
    set(...lamp, E.LAMP);
    plate(lamp, [0, -1, 0], label);
    return { sensor, lamp };
  });
  plate([178, 16, 45], [0, 0, 1], 'BLAST WATCH / The warning lamps respond to heat at the test pads.');
  return { plaques, tests, alarms, vaultInterior: [184.5, 6, 70.5] };
}

let manifest;
export const nuclearBunkerManifest = () => manifest ??= buildNuclearBunker({ box() {}, set() {} });
