import { E } from '../elements.js';
import { Appearance } from '../appearance.js';
import { LAMP_DC } from '../electricity.js';

export const DESTROYABLE_CITY_SIZE = [256, 96, 128];
export const DESTROYABLE_CITY_SPAWN = [96.5, 30, 102.5];

const STREET = 28;
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const planks = { appearance: Appearance.PLANK_X };
const siding = { appearance: Appearance.PLANK_Y };
const posts = { appearance: Appearance.LOG_Y };

function streetAndCanal(box) {
  box(0, 0, 0, 256, 2, 128, E.WALL);
  box(0, 2, 0, 256, 26, 128, E.ROCK);
  box(0, 26, 0, 256, STREET, 128, E.CERAMIC);
  box(0, 26, 62, 256, STREET, 83, E.BASALT);
  for (const z of [54, 83]) box(0, 27, z, 256, STREET, z + 8, E.BRICK);
  for (let x = 4; x < 250; x += 12) box(x, 27, 72, x + 6, STREET, 73, E.CERAMIC);
  for (const x of [70, 114, 167, 217]) for (let z = 63; z < 83; z += 4) box(x, 27, z, x + 4, STREET, z + 2, E.CERAMIC);

  // River walls and end caps retain the water instead of relying on the box edge.
  box(182, 7, 0, 210, STREET, 128, E.BRICK);
  box(184, 8, 2, 208, STREET, 126, E.EMPTY);
  box(184, 8, 2, 208, 22, 126, E.WATER);
  for (const x of [182, 208]) for (const [z0, z1] of [[2, 62], [83, 126]]) {
    box(x, STREET, z0, x + 2, 30, z1, E.BRICK);
  }
  box(180, 23, 62, 212, STREET, 83, E.BRICK);
  box(180, 27, 65, 212, STREET, 80, E.BASALT);
  box(191, 8, 66, 200, 23, 78, E.BRICK);
  for (const z of [63, 71, 79]) box(182, 23, z, 210, 25, z + 2, E.METAL);
  for (const z of [62, 82]) {
    box(182, 31, z, 210, 32, z + 1, E.METAL);
    for (let x = 182; x <= 208; x += 5) box(x, STREET, z, x + 2, 31, z + 1, E.BRICK);
  }
}

function metro(box, light) {
  box(6, 7, 53, 179, 25, 84, E.BRICK);
  box(8, 8, 54, 177, 24, 83, E.EMPTY);
  box(8, 8, 54, 177, 10, 71, E.CERAMIC);
  for (let x = 9; x < 176; x += 5) box(x, 8, 73, x + 2, 9, 82, E.PLANKS, planks);
  for (const z of [75, 80]) box(8, 9, z, 177, 10, z + 1, E.METAL);
  box(8, 9, 70, 177, 10, 71, E.SANDSTONE);
  for (let x = 20; x < 175; x += 18) {
    box(x, 10, 68, x + 2, 24, 70, E.BRICK);
    light([x, 22, 65], [x, 23, 65]);
  }
  for (let x = 72; x < 165; x += 29) {
    box(x, 10, 56, x + 10, 12, 59, E.PLANKS, planks);
    box(x, 12, 56, x + 10, 14, 57, E.PLANKS, planks);
  }
  // Open cut climbs east to the sidewalk; every tread rises one cell.
  box(12, 10, 54, 52, STREET, 61, E.EMPTY);
  for (let i = 0; i < STREET - 10; i++) box(16 + i * 2, 10, 54, 18 + i * 2, 11 + i, 61, E.BRICK);
  box(11, STREET, 53, 52, 31, 54, E.BRICK);
  box(11, STREET, 61, 52, 31, 62, E.BRICK);
  box(11, STREET, 54, 12, 31, 61, E.BRICK);
  box(49, 31, 53, 52, 34, 54, E.CERAMIC);
}

// A full-height shell and alternating parallel flights. The last tread is
// flush with the upper floor and the floor hole only covers the approach.
function stairTower(box, floors, lanes, z, material, finish) {
  for (let i = 0; i + 1 < floors.length; i++) {
    const low = floors[i], high = floors[i + 1], rise = high - low;
    const [left, right] = lanes[i % lanes.length];
    const backwards = i % 2 !== 0;
    const start = backwards ? z + 2 : z, end = backwards ? z + rise * 2 : z + (rise - 1) * 2;
    box(left, high - 2, start, right, high, end, E.EMPTY);
    for (let j = 0; j < rise; j++) {
      const zz = z + (backwards ? rise - 1 - j : j) * 2;
      box(left, low, zz, right, low + j + 1, zz + 2, material, finish);
    }
  }
}

function tower(box) {
  const floors = [28, 39, 50, 61, 72, 83];
  box(76, 26, 15, 119, 83, 49, E.BRICK);
  box(78, STREET, 17, 117, 81, 47, E.EMPTY);
  for (const y of floors.slice(0, -1)) {
    box(78, y - 2, 17, 117, y, 47, E.CERAMIC);
    for (let x = 80; x < 114; x += 8) {
      box(x, y + 2, 15, x + 6, y + 8, 17, E.GLASS);
      box(x, y + 2, 47, x + 6, y + 8, 49, E.GLASS);
    }
    for (let z = 19; z < 45; z += 7) {
      box(76, y + 2, z, 78, y + 8, z + 5, E.GLASS);
      box(117, y + 2, z, 119, y + 8, z + 5, E.GLASS);
    }
  }
  for (const x of [75, 118]) box(x, STREET, 47, x + 2, 84, 50, E.BRICK);
  box(92, STREET, 47, 101, 37, 49, E.EMPTY);
  box(90, 37, 47, 103, 39, 52, E.CERAMIC);
  box(90, STREET, 48, 92, 37, 52, E.BRICK);
  box(101, STREET, 48, 103, 37, 52, E.BRICK);
  stairTower(box, floors, [[99, 105], [108, 114]], 22, E.BRICK);
  for (const z of [15, 48]) box(76, 83, z, 119, 85, z + 1, E.BRICK);
  box(82, 83, 22, 90, 85, 30, E.CERAMIC);
  box(85, 85, 25, 87, 94, 27, E.METAL);
  box(80, 91, 25, 92, 92, 26, E.METAL);
  // Footing on the lobby's west side, wired from underneath.
  box(84, STREET, 31, 97, 34, 37, E.BRICK);
  box(92, 34, 32, 95, 39, 36, E.BRICK);
}

function tenement(box, barrel) {
  box(26, 13, 14, 66, 58, 49, E.PLANKS, siding);
  box(28, 15, 16, 64, 56, 47, E.EMPTY);
  box(26, 13, 14, 66, 15, 49, E.BRICK);
  for (const y of [28, 38, 48]) {
    box(28, y - 2, 16, 64, y, 47, E.PLANKS, planks);
    for (const x of [31, 42, 53]) {
      box(x, y + 2, 14, x + 7, y + 6, 16, E.GLASS);
      box(x, y + 2, 47, x + 7, y + 6, 49, E.GLASS);
    }
    for (const z of [20, 35]) {
      box(26, y + 2, z, 28, y + 6, z + 7, E.GLASS);
      box(64, y + 2, z, 66, y + 6, z + 7, E.GLASS);
    }
    if (y > STREET) {
      box(27, y - 1, 49, 45, y, 54, E.PLANKS, planks);
      box(28, y + 2, 53, 45, y + 3, 54, E.WOOD, { appearance: Appearance.LOG_X });
      box(36, y, 47, 41, y + 7, 49, E.EMPTY);
    }
  }
  for (const x of [26, 64]) for (const z of [14, 47]) box(x, STREET, z, x + 2, 58, z + 2, E.WOOD, posts);
  box(40, STREET, 47, 48, 36, 49, E.EMPTY);
  stairTower(box, [15, 28], [[30, 37]], 17, E.PLANKS, planks);
  stairTower(box, [28, 38, 48], [[48, 54], [56, 62]], 20, E.PLANKS, planks);
  for (let i = 0; i < 5; i++) box(24 + i * 4, 58 + i, 12, 68 - i * 4, 59 + i, 51, E.PLANKS, { appearance: Appearance.PLANK_Z });

  box(49, 15, 37, 61, 20, 43, E.WOOD, posts);
  barrel(44, 15, 31, E.OIL, E.CERAMIC);
  barrel(54, 15, 28, E.GUNPOWDER, E.PLANKS);
}

function depot(box, barrel) {
  box(126, STREET, 14, 174, 50, 50, E.BRICK);
  box(128, STREET, 16, 172, 50, 48, E.EMPTY);
  for (const x of [126, 141, 157, 172]) {
    for (const z of [14, 48]) box(x, STREET, z, x + 2, 51, z + 2, E.METAL);
    box(x, 47, 14, x + 2, 49, 50, E.METAL);
  }
  box(126, 49, 14, 174, 51, 50, E.METAL);
  box(131, 50, 18, 169, 52, 46, E.METAL);
  box(134, 50, 20, 166, 52, 44, E.EMPTY);
  box(134, 51, 20, 166, 52, 44, E.GLASS);
  for (const x of [141, 157]) box(x, 51, 20, x + 2, 53, 44, E.METAL);
  box(133, STREET, 48, 143, 40, 50, E.EMPTY);
  box(160, STREET, 48, 169, 37, 50, E.EMPTY);
  box(128, 31, 48, 132, 34, 50, E.GLASS);
  box(144, 40, 48, 169, 45, 50, E.GLASS);
  box(148, 43, 16, 172, 45, 24, E.METAL);   // storage loft
  box(144, STREET, 26, 156, 34, 32, E.METAL); // loaded pier
  for (const [x, z, id] of [[158, 19, E.PROPANE], [165, 19, E.PROPANE], [158, 26, E.OIL],
    [165, 26, E.OIL], [158, 33, E.GUNPOWDER], [165, 33, E.GUNPOWDER]]) barrel(x, STREET, z, id, E.METAL);
  box(165, STREET, 39, 171, 31, 43, E.PLANKS, planks);
}

function observationStand(box) {
  box(66, STREET, 93, 127, 30, 122, E.BRICK);
  box(68, 29, 95, 125, 30, 120, E.CERAMIC);
  box(65, STREET, 99, 66, 29, 117, E.BRICK);
  box(127, STREET, 99, 128, 29, 117, E.BRICK);
  box(73, STREET, 122, 120, 29, 124, E.BRICK);
  for (const x of [66, 124]) for (const z of [106, 120]) box(x, 30, z, x + 2, 41, z + 2, E.BRICK);
  box(65, 40, 105, 128, 42, 123, E.METAL);
  box(70, 40, 109, 123, 42, 118, E.GLASS);
  box(68, 30, 121, 125, 36, 122, E.GLASS);
  box(66, 30, 93, 127, 31, 94, E.BRICK);
}

// Hand-routed utility conduits at two levels under the metro and canal. Only
// native materials run the circuit: BATTERY → BUTTON → METAL → PSCN sets a
// FIRE PCLN on (TPT's powered clone latch, shared by the V1/V2 rules). In both
// engines the clone lights the fuse through an air pocket. The hot end of
// the fuse—not the spark or an incidental flame heating roll—lights TNT/C4.
function rig({ box, set }, label, x, route, chargeId) {
  const cells = new Map();
  const add = (p, id, extra) => cells.set(p.join(','), { p, id, extra });
  const button = [x, 34, 94], supply = [x, 33, 94], indicator = [x + 1, 34, 94];
  const points = [[x, 34, 93], ...route];
  for (let i = 1; i < points.length; i++) {
    const p = [...points[i - 1]], end = points[i];
    if (p.filter((n, axis) => n !== end[axis]).length !== 1) throw new Error('Demolition conduit needs axis-aligned runs.');
    const axis = p.findIndex((n, a) => n !== end[a]);
    for (; p[axis] !== end[axis]; p[axis] += Math.sign(end[axis] - p[axis])) add([...p], E.METAL);
    add(end, E.METAL);
  }
  const [tx, y, z] = points.at(-1);
  const silicon = [tx + 1, y, z], pilot = [tx + 2, y, z], pocket = [tx + 3, y, z];
  const fuse = [[tx + 4, y, z], [tx + 5, y, z]], charge = [tx + 6, y, z];
  box(tx + 6, y - 1, z - 2, tx + 10, y + 2, z + 3, chargeId);
  // Charge contact is reserved so the sleeve cannot cut the fuse handoff.
  add(charge, chargeId);
  add(silicon, E.PSCN);
  add(pilot, E.PCLN, { ctype: E.FIRE });
  add(pocket, E.EMPTY);
  for (const p of fuse) add(p, E.FUSE);
  add(button, E.BUTTON);
  add(supply, E.BATTERY);
  add(indicator, E.LAMP);
  const exposed = new Set([button, indicator].map(([xx, yy, zz]) => [xx, yy, zz + 1].join(',')));
  for (const { p, id } of cells.values()) {
    if (id === chargeId) continue;
    for (const d of FACES) {
      const q = p.map((v, i) => v + d[i]), key = q.join(',');
      if (!cells.has(key) && !exposed.has(key)) set(...q, E.INSULATOR);
    }
  }
  for (const { p, id, extra } of cells.values()) set(...p, id, extra);
  box(x - 2, 31, 93, x + 3, 33, 95, E.CERAMIC);
  return { label, button, supply, indicator, silicon, pilot, pocket, fuse, charge, chargeId };
}

// Inspired by The Powder Toy's Destroyable city 5 (with metro) and City:
// a cutaway of layered rooms and utilities, translated into walkable blocks.
export function buildDestroyableCity({ box, set }) {
  const lights = [];
  const light = (lamp, battery) => {
    set(...battery, E.BATTERY);
    set(...lamp, E.LAMP, { ctype: LAMP_DC });
    lights.push({ lamp, battery });
  };
  const barrel = (x, y, z, contents, caseId) => {
    box(x, y, z, x + 5, y + 6, z + 5, caseId);
    box(x + 1, y + 1, z + 1, x + 4, y + 5, z + 4, contents);
  };
  streetAndCanal(box);
  metro(box, light);
  tower(box);
  tenement(box, barrel);
  depot(box, barrel);
  observationStand(box);
  for (const x of [59, 79, 101, 123, 152, 174, 217, 238]) for (const z of [60, 85]) {
    box(x, STREET, z, x + 2, 38, z + 2, E.METAL);
    box(x, 38, z - 1, x + 2, 40, z + 3, E.INSULATOR);
    const arm = z === 60 ? z + 2 : z - 1;
    for (const dx of [0, 1]) light([x + dx, 38, arm], [x + dx, 39, arm]);
  }
  const stamp = (label, x, route, id) => rig({ box, set }, label, x, route, id);
  const circuits = [
    stamp('TIMBER ROW', 73, [[73, 34, 92], [73, 3, 92], [73, 3, 40], [50, 3, 40], [50, 16, 40]], E.TNT),
    stamp('BRICK TOWER', 86, [[86, 34, 92], [86, 5, 92], [86, 5, 34], [86, 29, 34]], E.C4),
    stamp('FUEL DEPOT', 107, [[107, 34, 92], [107, 3, 92], [107, 3, 52], [145, 3, 52], [145, 3, 29], [145, 30, 29]], E.TNT),
    stamp('CANAL BRIDGE', 120, [[120, 34, 92], [120, 5, 92], [120, 5, 90], [192, 5, 90], [192, 5, 72], [192, 24, 72]], E.C4),
  ];
  const plaques = circuits.map(({ label, button: [x, , z] }) => ({ cell: [x, 32, z], normal: [0, 0, 1],
    text: `${label} / E: fire the charge. Lamp: signal sent. Fuse burns first.` }));
  plaques.push({ cell: [51, 32, 53], normal: [1, 0, 0], text: 'METRO / Turn down the stairs for the platform under the boulevard.' });
  plaques.push({ cell: [91, 34, 51], normal: [0, 0, 1], text: 'BRICK TOWER / Lobby and stairs to the roof.' });
  plaques.push({ cell: [122, 35, 121], normal: [0, 0, -1], text: 'DESTROYABLE CITY / Head to the rail. Aim at a button and press E.' });
  return { plaques, circuits, lights };
}

let manifest;
export const destroyableCityManifest = () => manifest ??= buildDestroyableCity({ box() {}, set() {} });
