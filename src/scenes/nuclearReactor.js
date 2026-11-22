import { E } from '../elements.js';
import { LAMP_DC } from '../electricity.js';

export const NUCLEAR_REACTOR_SIZE = [256, 96, 128];
export const NUCLEAR_REACTOR_SPAWN = [128.5, 38, 106.5];

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const zFront = [0, 0, 1];

// The Powder Toy saves #10 (Realistic Nuclear Reactor Core) and #11 (PWR
// nuclear power plant): a water-cooled core, independent emergency injection,
// and a plant you can watch from the controls. The process uses this game's
// cell/ray rules, not the original saves' URAN pressure heating or NEUT grid.
export function buildNuclearReactor({ box, set }) {
  const plaques = [];
  const sign = (cell, text) => plaques.push({ cell, normal: zFront, text });
  const floor = [106, 22, 47, 151, 23, 81];
  const plug = [131, 22, 59, 138, 23, 72];
  const pit = [106, 4, 47, 151, 19, 81];

  // The site slab, framed catch basin and open drop below the sacrificial plug.
  box(49, 0, 13, 207, 4, 123, E.WALL);
  box(...pit, E.CERAMIC);
  box(108, 6, 49, 149, 19, 79, E.EMPTY);
  box(69, 19, 23, 188, 22, 95, E.METAL);
  box(plug[0], 19, plug[2], plug[3], 22, plug[5], E.EMPTY);
  for (const x of [103, 152]) box(x, 4, 44, x + 3, 22, 84, E.TUNGSTEN);

  // Flatten the near chord of the dome for the panoramic shield window.
  // Steel footing rings and alternating ribs make the shell readable in orbit.
  for (let y = 22; y < 82; y++) for (let z = 17; z <= 94; z++) for (let x = 63; x < 194; x++) {
    const dx = x - 128, dz = z - 60, dy = Math.max(0, y - 38);
    const outer = (dx / 65) ** 2 + (dz / 43) ** 2 + (dy / 43) ** 2;
    if (outer > 1) continue;
    const inner = (dx / 63) ** 2 + (dz / 41) ** 2 + (dy / 41) ** 2;
    if (z === 94 || inner >= 1) {
      const rib = y < 25 || y === 37 || x % 16 < 2 || z < 21;
      set(x, y, z, rib || z === 94 ? E.TUNGSTEN : E.METAL);
    }
  }
  box(100, 38, 94, 157, 51, 95, E.GLASS);
  for (const x of [100, 114, 142, 156]) box(x, 38, 94, x + 1, 51, 95, E.TUNGSTEN);

  // Pressure vessel. The broad front gauge is sacrificial glass; the lower
  // manifold sits below the rods, over a gold fuse that melts before the frame.
  box(...floor, E.TUNGSTEN);
  box(...plug, E.GOLD);
  box(106, 23, 47, 151, 68, 81, E.TUNGSTEN);
  box(108, 23, 49, 149, 67, 80, E.EMPTY);
  box(109, 28, 80, 148, 58, 81, E.GLASS);
  for (const y of [24, 58, 66]) {
    box(104, y, 46, 106, y + 1, 82, E.METAL);
    box(151, y, 46, 153, y + 1, 82, E.METAL);
    box(106, y, 81, 151, y + 1, 82, E.METAL);
  }
  const coolant = [117, 23, 51, 147, 29, 79];
  box(...coolant, E.WATER);
  // A bleed at the rear edge keeps flow going through the lower manifold,
  // then removes the residual inventory after the feed is shut off.
  box(117, 22, 49, 127, 23, 51, E.VOID);
  box(116, 23, 54, 117, 60, 75, E.TUNGSTEN);
  box(108, 23, 54, 116, 59, 55, E.TUNGSTEN);
  box(108, 23, 74, 116, 59, 75, E.TUNGSTEN);
  box(108, 26, 55, 116, 27, 74, E.VOID);

  // Short glass cassettes with spacer plates keep heavy uranium from falling
  // out of its rods at boot. Open channels around them carry coolant and steam.
  const rods = [];
  for (const x of [118, 125, 133, 141]) for (const z of [57, 66, 75]) {
    const fuel = [], foot = [x - 1, 28, z - 1, x + 3, 29, z + 3];
    box(x, 23, z, x + 2, 28, z + 2, E.TUNGSTEN);
    box(x - 1, 28, z - 1, x + 3, 55, z + 3, E.GLASS);
    for (const y of [29, 38, 47]) {
      fuel.push([x, y, z, x + 2, y + 7, z + 2]);
      box(...fuel.at(-1), E.URANIUM);
    }
    rods.push({ foot, fuel });
  }

  // Steam hood and flared tower, with a clear open throat into the vessel and
  // VOID at the top touching steam (VOID is a contact sink, not a vacuum).
  const exhaust = [119, 95, 42, 144, 96, 67];
  for (let y = 67; y < 95; y++) {
    const radius = y < 77 ? 10 : 10 + Math.floor((y - 83) ** 2 / 33);
    box(131 - radius, y, 54 - radius, 132 + radius, y + 1, 55 + radius,
      y % 6 === 0 ? E.TUNGSTEN : E.METAL);
    box(132 - radius, y, 55 - radius, 131 + radius, y + 1, 54 + radius, E.EMPTY);
  }
  box(...exhaust, E.VOID);

  // Visitor balcony, insulated dashboard and service stair to the site slab.
  box(98, 36, 95, 160, 38, 118, E.CERAMIC);
  box(98, 38, 95, 99, 54, 118, E.GLASS);
  box(159, 38, 95, 160, 54, 118, E.GLASS);
  box(98, 38, 117, 160, 54, 118, E.GLASS);
  box(98, 54, 94, 160, 55, 118, E.METAL);
  box(102, 54, 98, 156, 55, 114, E.GLASS);
  box(154, 38, 117, 158, 47, 118, E.EMPTY);
  box(153, 36, 118, 164, 38, 123, E.CERAMIC);
  for (let step = 0; step < 34; step++) box(164 + step, 4, 118, 165 + step, 38 - step, 123, E.CERAMIC);
  box(103, 38, 98, 152, 42, 101, E.CERAMIC);
  for (const x of [104, 151]) {
    box(x - 1, 53, 104, x + 2, 54, 113, E.LAMP, { ctype: LAMP_DC });
    box(x - 1, 54, 104, x + 2, 55, 113, E.BATTERY);
  }
  sign([128, 51, 94], 'REACTOR 01 / Primary loop — control room');

  // Parallel feedthroughs run under the balcony. Each route is physical wire;
  // openings at the button faces, clone nozzles, and sensor samples stay clear.
  const cells = new Map(), ports = new Set();
  const cell = (p, id, extra) => cells.set(p.join(','), { p, id, extra });
  const line = (...turns) => {
    for (let i = 1; i < turns.length; i++) {
      const p = [...turns[i - 1]], q = turns[i];
      const axes = [0, 1, 2].filter(j => p[j] !== q[j]);
      if (axes.length > 1) throw new Error('Reactor cable segments must be axial.');
      const [axis = -1] = axes;
      do {
        cell([...p], E.METAL);
        if (axis < 0 || p[axis] === q[axis]) break;
        p[axis] += Math.sign(q[axis] - p[axis]);
      } while (true);
    }
  };
  const control = (x, y, z, label) => {
    const button = [x, 41, 100], supply = [x, 42, 100];
    line([x, 41, 99], [x, 34, 99], [x, 34, 87], [x, y, 87], [x, y, z]);
    cell(button, E.BUTTON); cell(supply, E.BATTERY);
    ports.add([x, 41, 101].join(','));
    sign([x, 39, 100], label);
    return { button, supply };
  };
  const controls = {
    ignite: control(109, 60, 70, '2. IGNITE / E: pulse to start the neutron source'),
    coolantOn: control(120, 60, 70, '1. COOLANT ON / E: start the blue water feed'),
    coolantOff: control(124, 61, 70, '3. COOLANT OFF / E: cut feed and let the core run hot'),
    aux: control(130, 60, 70, 'AUX HEATER / E: heat the dry core to melt the lower plug'),
    scram: control(140, 60, 70, '4. SCRAM / E: kill starter and heater; flood with LN2'),
  };
  const banks = {};
  const bank = (name, material, x0, x1, z0, z1) => {
    const cellsForBank = [];
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const p = [x, 60, z];
      cell(p, E.PCLN, { ctype: material, life: 0 });
      ports.add([x, 59, z].join(','));
      cellsForBank.push(p);
    }
    (banks[name] ??= []).push(...cellsForBank);
  };
  bank('starter', E.PLUTONIUM, 110, 116, 55, 74);
  bank('water', E.WATER, 121, 127, 64, 74);
  bank('heater', E.LAVA, 131, 137, 56, 74);
  bank('scram', E.LIQUID_NITROGEN, 141, 148, 54, 74);
  bank('scram', E.LIQUID_NITROGEN, 108, 148, 50, 54);
  // A fly-particle NEUTRON tool has no grid id for cloning. The starter
  // instead seeds a bounded chute with Pu: its native decay emits real rays.
  // Uranium only fissions on neutron strikes, not above a temperature setpoint.
  // The chute drains continuously, including after SCRAM closes the source.
  for (const x of [109, 120, 130, 140]) {
    for (let z = 56; z < 74; z++) cell([x, 60, z], E.PSCN);
  }
  // NSCN runs one layer higher. SCRAM has its own bridge above the other nets.
  line([140, 60, 76], [140, 63, 76], [113, 63, 76]);
  for (const x of [113, 134]) line([x, 63, 76], [x, 63, 73], [x, 61, 73]);
  for (const x of [113, 124, 134]) {
    for (let z = 56; z < 74; z++) cell([x, 61, z], E.NSCN);
  }

  const alarms = [
    { sensor: [117, 47, 80], sample: [117, 47, 79], temp: 150, lamp: [117, 44, 100], label: 'BOILING / 150 C' },
    { sensor: [136, 30, 75], sample: [136, 30, 74], temp: 600, lamp: [136, 44, 100], label: 'CRITICAL / 600 C' },
  ];
  for (const { sensor, sample, temp, lamp, label } of alarms) {
    const [x, y, z] = sensor;
    // TSNS ignores wires. A thin ceramic probe face takes heat from the
    // steam space or lower manifold and passes the reading to the rear sensor.
    set(...sample, E.CERAMIC);
    ports.add(sample.join(','));
    line([x, y, z + 1], [x, y, 84], [x, 44, 84], [x, 44, 99]);
    cell(sensor, E.TSNS, { temp }); cell(lamp, E.LAMP);
    ports.add([x, 44, 101].join(','));
    sign([x, 45, 100], label);
  }
  for (const { p } of cells.values()) for (const d of FACES) {
    const q = p.map((n, i) => n + d[i]), key = q.join(',');
    if (!cells.has(key) && !ports.has(key)) set(...q, E.INSULATOR);
  }
  for (const { p, id, extra } of cells.values()) set(...p, id, extra);
  // Alarm labels face the operator, above the insulated lamp housings.
  for (const { lamp: [x, y, z] } of alarms) set(x, y + 1, z, E.CERAMIC);
  sign([149, 39, 100], 'RELOAD MAP / Reset the flood and rebuild any damage');

  return { plaques, rods, coolant, plug, pit, exhaust, banks, controls, alarms };
}

let manifest;
export const nuclearReactorManifest = () => manifest ??= buildNuclearReactor({ box() {}, set() {} });
