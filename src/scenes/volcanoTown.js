import { E } from '../elements.js';
import { Appearance } from '../appearance.js';
import { LAMP_DC } from '../electricity.js';

// The Powder Toy #15, Volcano Maker: a finite molten chamber and blastable
// terrain. Like our Volcano preset, the renewable source sits at the outlet:
// the liquid simulation doesn't pump magma from a buried clone up a shaft.
// Low z is uphill; both spillways descend toward the village at high z.
export const VOLCANO_TOWN_SIZE = [256, 96, 128];
export const VOLCANO_TOWN_SPAWN = [97.5, 27, 114.5];
const [NX, , NZ] = VOLCANO_TOWN_SIZE;
const BASALT_MELT = { temp: 1750, ctype: E.BASALT };
const CONE = [61, 40];
const WATERLINE = 42;
const SPILL = [[56, 199, 23], [68, 198, 21], [79, 188, 15], [90, 174, 10], [102, 151, 7], [115, 150, 6], [127, 147, 5]];
const LAVA_RUN = [[50, 68, 66], [59, 82, 52], [69, 94, 35], [79, 104, 22], [89, 116, 12], [98, 147, 7], [102, 151, 7]];
const damBack = x => 59 - Math.floor(Math.abs(x - 199) / 7);
const strata = (x, z) => Math.sin(x * 0.19 + z * 0.13) + Math.sin(z * 0.27 - x * 0.11);
const ceilCone = (x, z) => {
  const dx = x - CONE[0], dz = z - CONE[1], angle = Math.atan2(dz, dx);
  const r = Math.hypot(dx, dz) / (52 + 3 * Math.cos(5 * angle) + 2 * Math.sin(9 * angle));
  return Math.floor(12 + 68 * Math.max(0, 1 - r) ** 0.86 + strata(x, z));
};

function course(points, z) {
  for (let i = 1; i < points.length; i++) {
    const [z0, x0, y0] = points[i - 1], [z1, x1, y1] = points[i];
    if (z < z0 || z > z1) continue;
    const t = (z - z0) / (z1 - z0);
    return [Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t)];
  }
  return null;
}

const controls = [
  { cell: [91, 30, 109], bus: 2, text: 'ERUPT VOLCANO / Open the vent and start the lava cascades.' },
  { cell: [97, 30, 109], bus: 0, text: 'BLOW DAM / Fire the sluice charges. The lake drains toward town.' },
  { cell: [103, 30, 109], bus: 4, text: 'STOP MAGMA / Switch off the lava emitters, not the lava already flowing.' },
];
const manifest = {
  plaques: [
    ...controls.map(({ cell, text }) => ({ cell, normal: [0, 0, 1], text })),
    { cell: [97, 29, 109], normal: [0, 0, 1], text: 'CALDERA LOOKOUT / Use the buttons, or carve your own channels.' },
    { cell: [199, 40, 64], normal: [0, 0, 1], text: 'ALPINE HYDRO / Sluices drain to the village. Use BLOW DAM at the lookout.' },
    { cell: [39, 34, 76], normal: [0, 0, 1], text: 'STEAM CHIMNEY / Erase the glass floor in the water tank to drop the water.' },
    { cell: [57, 24, 61], normal: [0, 0, 1], text: 'MAGMA GALLERY / The upper vent has its own sources. Do not cross the lip.' },
  ],
};
export const volcanoTownManifest = () => manifest;

export function buildVolcanoTown({ box, set }) {
  const column = (x, z, lo, hi, id, extra) => box(x, lo, z, x + 1, hi, z + 1, id, extra);
  const pine = (x, y, z, h) => {
    box(x, y, z, x + 1, y + h, z + 1, E.WOOD, { appearance: Appearance.LOG_Y });
    for (let dy = 3; dy <= h + 1; dy++) {
      const radius = Math.ceil((h + 1 - dy) / 2);
      for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) + Math.abs(dz) <= radius + 1 && (dx || dz || dy >= h)) {
          set(x + dx, y + dy, z + dz, E.PLANT, { appearance: Appearance.LEAVES });
        }
      }
    }
  };

  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const cone = ceilCone(x, z);
    let top = cone, water = false, dam = false, lava = false;
    // A stepped alpine bowl with a rising rim at the back and sides; the
    // downstream edge of every wet column is behind the continuous dam face.
    if (x >= 151 && x < 240 && z < damBack(x) + 5) {
      const rim = Math.min(x - 151, 239 - x, z - 3 - Math.max(0, Math.abs(x - 195) - 22) * 0.55);
      top = Math.max(top, Math.round(47 - Math.min(24, rim * 1.7)));
      if (z < damBack(x)) water = top < WATERLINE;
      else {
        const crest = 48 - 2 * (z - damBack(x));
        column(x, z, 0, Math.min(top, 23), E.ROCK);
        top = Math.max(top, crest);
        column(x, z, Math.min(top, 23), top, E.BRICK);
        dam = true;
      }
    }
    if (!dam && !water) {
      const spill = course(SPILL, z), run = course(LAVA_RUN, z);
      // Low levees at the town keep a little dry riverbed at rest, but the
      // finite reservoir has plenty of water to overtop them after a breach.
      if (spill && (z >= 64 || x < 185 || x >= 214)) {
        const dx = Math.abs(x - spill[0]);
        if (dx < 8) top = spill[1];
        else if (dx < 18 && z >= 81) top = Math.min(top, spill[1] + 3 + Math.floor((dx - 8) / 3));
      }
      if (run) {
        const dx = Math.abs(x - run[0]);
        if (dx <= 5 || (dx <= 12 && z === 50)) { top = run[1]; lava = true; }
        else if (dx <= 7) { top = Math.max(top, run[1] + 3); lava = true; }
      }
      const ridge = z >= 106 && z < 124 && x >= 78 && x < 108;
      if (ridge) top = 27;
      if (z >= 110 && z < 118 && x >= 108 && x < 125) top = Math.max(10, 27 - (x - 107));
    }
    if (dam) continue;
    const snow = !lava && cone >= 64 && top === cone;
    const surface = lava || (cone > 34 && cone === top && (z + Math.floor(strata(x, z) * 2)) % 9 < 4) ? E.BASALT : E.ROCK;
    column(x, z, 0, top - 1, E.ROCK, snow ? { temp: -20 } : undefined);
    column(x, z, top - 1, top, surface, snow ? { temp: -20 } : undefined);
    if (snow) column(x, z, top, top + 1, E.SNOW);
    if (water) column(x, z, top, WATERLINE, E.WATER);
    if (z >= 120 && Math.abs(x - course(SPILL, z)[0]) < 7 && top === 5) column(x, z, top, 6, E.WATER);
    // Deterministic fir stands on the flanks and reservoir's outer bank.
    const gallery = x >= 53 && x < 69 && z >= 46;
    if (x % 7 === 3 && z % 7 === 3 && !lava && !water && !snow && !gallery && (x < 108 && cone > 24 && cone < 46 && z < 91 || x > 231 && x < NX - 5 && z > 11 && z < 43)) {
      pine(x, top, z, 6 + ((x + z) % 3));
    }
  }

  // Ellipsoidal chamber, open gallery above the pool's lip, and a dark throat
  // visible in cutaway. The upper vent is perched above the chamber proper.
  for (let z = 24; z <= 56; z++) for (let x = 42; x <= 80; x++) {
    const d = ((x - 61) / 19) ** 2 + ((z - 40) / 16) ** 2;
    if (d >= 1) continue;
    const r = Math.floor(17 * Math.sqrt(1 - d));
    column(x, z, 31 - r, 32 + r, E.EMPTY);
    if (31 - r < 23) column(x, z, 31 - r, 23, E.LAVA, BASALT_MELT);
  }
  box(58, 46, 37, 65, 65, 44, E.EMPTY);
  box(56, 23, 46, 66, 34, 90, E.EMPTY);
  box(56, 23, 60, 58, 29, 62, E.ROCK);
  box(59, 65, 36, 77, 76, 50, E.ROCK);
  box(61, 66, 38, 76, 75, 49, E.EMPTY);
  box(62, 66, 39, 75, 68, 49, E.LAVA, BASALT_MELT);
  box(62, 75, 38, 74, 76, 49, E.ROCK);
  box(63, 76, 39, 73, 77, 48, E.SAND);
  // A thin rock lip between the perched lava and its downhill run. Charges
  // are above the initial lava, but face freshly cloned lava when enabled.
  box(63, 67, 49, 74, 68, 50, E.BRICK);
  box(62, 68, 49, 75, 74, 50, E.SAND);
  for (const x of [64, 68, 72]) box(x, 69, 48, x + 2, 71, 49, E.C4);

  // Side experiment: a glass-bottomed cistern and its own open chimney.
  // Remove the glass at y=39. Water then falls into the hot pool while the
  // neighbouring shaft gives the pressure puff and steam a path to the sky.
  box(30, 23, 66, 45, 46, 77, E.ROCK);
  box(31, 24, 67, 44, 30, 76, E.EMPTY);
  box(31, 24, 67, 44, 26, 76, E.LAVA, BASALT_MELT);
  box(31, 30, 68, 36, 46, 75, E.EMPTY);
  box(37, 30, 68, 43, 46, 75, E.EMPTY);
  box(37, 39, 68, 43, 40, 75, E.GLASS);
  box(37, 40, 68, 43, 44, 75, E.WATER);
  box(30, 30, 74, 31, 38, 77, E.GLASS);

  // Three recessed sluices like Dam Valley, but with breakable brick/rock
  // abutments. The timber bulkheads back onto water; all charges are dry,
  // downstream of the gate. Gates can also be cut directly by the player.
  box(185, 23, 56, 214, 39, 65, E.EMPTY);
  box(185, 39, 56, 214, 43, 65, E.BRICK);
  for (const x of [185, 194, 204, 213]) box(x, 23, 56, x + 1, 39, 65, E.ROCK);
  box(186, 23, 56, 213, 39, 57, E.PLANKS, { appearance: Appearance.PLANK_Y });
  for (const x of [194, 204]) box(x, 23, 56, x + 1, 39, 57, E.ROCK);
  for (const x of [188, 197, 208]) {
    box(x, 23, 57, x + 4, 25, 59, E.C4);
    box(x, 25, 57, x + 4, 27, 59, E.TNT);
  }
  box(185, 38, 63, 214, 41, 64, E.BRICK);
  for (const x of [186, 195, 205]) box(x, 36, 63, x + 8, 38, 64, E.METAL);

  function house(x, y, z, w, d, hall = false) {
    const wall = hall ? E.BRICK : E.PLANKS;
    const boards = { appearance: Appearance.PLANK_Y };
    box(x, y - 2, z, x + w, y, z + d, E.ROCK);
    box(x, y, z, x + w, y + 7, z + d, wall, hall ? undefined : boards);
    box(x + 1, y, z + 1, x + w - 1, y + 7, z + d - 1, E.EMPTY);
    box(x + 2, y, z + d - 1, x + 5, y + 5, z + d, E.EMPTY);
    for (const a of [x + 2, x + w - 5]) {
      box(a, y + 3, z, a + 3, y + 5, z + 1, E.GLASS);
      if (a !== x + 2) box(a, y + 3, z + d - 1, a + 3, y + 5, z + d, E.GLASS);
    }
    for (const a of [x, x + w - 1]) {
      box(a, y + 3, z + 3, a + 1, y + 5, z + 6, E.GLASS);
      if (!hall) for (const b of [z, z + d - 1]) box(a, y, b, a + 1, y + 7, b + 1, E.WOOD, { appearance: Appearance.LOG_Y });
    }
    for (let layer = 0; layer * 2 < w + 2; layer++) {
      const a = x - 1 + layer, b = x + w - layer;
      box(a, y + 7 + layer, z - 1, a + 1, y + 8 + layer, z + d + 1, E.PLANKS, { appearance: Appearance.PLANK_Z });
      box(b, y + 7 + layer, z - 1, b + 1, y + 8 + layer, z + d + 1, E.PLANKS, { appearance: Appearance.PLANK_Z });
      if (a + 1 < b) for (const end of [z, z + d - 1]) box(a + 1, y + 7 + layer, end, b, y + 8 + layer, end + 1, wall, hall ? undefined : boards);
    }
    box(x + w - 4, y + 6, z + 2, x + w - 2, y + 13, z + 4, E.BRICK);
  }
  house(120, 11, 92, 12, 11);
  house(163, 11, 100, 12, 12);
  house(171, 12, 87, 12, 10);
  house(137, 10, 109, 10, 10);
  house(123, 10, 107, 13, 14, true);
  box(139, 10, 103, 166, 11, 108, E.PLANKS, { appearance: Appearance.PLANK_X });
  for (const x of [140, 148, 156, 164]) for (const z of [103, 107]) {
    box(x, 7, z, x + 1, 14, z + 1, E.WOOD, { appearance: Appearance.LOG_Y });
  }
  for (const z of [103, 107]) box(139, 13, z, 166, 14, z + 1, E.PLANKS, { appearance: Appearance.PLANK_X });
  // Low landing attached to the river cottage; the piles stand in both flows.
  box(146, 10, 113, 153, 11, 118, E.PLANKS, { appearance: Appearance.PLANK_X });
  for (const z of [113, 117]) box(151, 6, z, 152, 10, z + 1, E.WOOD, { appearance: Appearance.LOG_Y });
  for (const [x, y, z] of [[137, 11, 104], [160, 11, 109], [165, 11, 97], [119, 11, 105]]) {
    box(x, y, z, x + 1, y + 6, z + 1, E.WOOD, { appearance: Appearance.LOG_Y });
    set(x, y + 6, z, E.BATTERY);
    set(x, y + 6, z + 1, E.LAMP, { ctype: LAMP_DC });
  }

  // Native battery -> momentary BUTTON -> buried METAL -> silicon. No
  // scripted events or proximity triggers; every terminal is face-connected.
  // Separate y planes and separated risers prevent start/stop cross-talk.
  function cable(control, [tx, ty, tz], silicon) {
    const { cell: [x, y, z], bus } = control;
    const turn = 104;
    column(x, z, bus, y, E.METAL);
    box(x, bus, turn, x + 1, bus + 1, z + 1, E.METAL);
    box(Math.min(x, tx), bus, turn, Math.max(x, tx) + 1, bus + 1, turn + 1, E.METAL);
    box(tx, bus, Math.min(turn, tz), tx + 1, bus + 1, Math.max(turn, tz) + 1, E.METAL);
    // Riser stays buried, with a rock sheath around the terminal.
    box(tx - 1, ty - 4, tz - 1, tx + 2, ty + 2, tz + 2, E.ROCK);
    column(tx, tz, bus, ty, E.METAL);
    set(tx, ty, tz, silicon);
  }
  for (const control of controls) {
    const [x, y, z] = control.cell;
    box(x - 1, 27, z - 2, x + 2, y, z + 1, E.INSULATOR);
    box(x - 1, y, z - 2, x + 2, y + 1, z, E.INSULATOR);
    set(x, y, z - 1, E.BATTERY);
    set(x, y, z, E.BUTTON);
  }

  // A hidden clone spine carries life (not sparks) through its sheath to
  // each exposed nozzle. N-type has its own feed to every spine, so stopping
  // magma propagates through exactly the same faces as starting it did.
  function magmaSpine(x, y, z, end, exposedZ) {
    cable(controls[0], [x - 1, y, z], E.PSCN);
    cable(controls[2], [x + 2, y, z - 1], E.NSCN);
    box(x, y, z, end + 1, y + 1, z + 1, E.PCLN, { ctype: E.LAVA });
    box(end - 2, y, z, end + 1, y + 1, exposedZ + 1, E.PCLN, { ctype: E.LAVA });
  }
  magmaSpine(57, 70, 45, 73, 46);
  // Across the vent width, leaving a face of air before each charge pack.
  box(63, 69, 46, 74, 71, 47, E.PCLN, { ctype: E.LAVA });
  // A shallow pocket of basalt-rich melt at the confluence keeps its own
  // composition. The lower cascade can overrun it after it crusts over.
  box(138, 6, 96, 144, 7, 98, E.LAVA, BASALT_MELT);
  box(138, 7, 96, 144, 8, 98, E.EMPTY);
  for (const [z, x, y] of [[79, 104, 22], [89, 116, 12], [96, 140, 8]]) {
    box(x - 18, y, z - 3, x - 5, y + 4, z + 1, E.ROCK);
    // Low spill steps restart the visible cascade if the upstream flow
    // crusts over. Basalt lining can remelt and quench back to solid basalt.
    magmaSpine(x - 16, y + 2, z - 1, x - 5, z + 1);
  }

  // C-4 and TNT do not ignite from a spark here. A dry, roofed lava pilot
  // produces hot liquid across one air cell to request native blasts. A
  // longer return wire from the same button resets the pilot via NSCN so
  // a dam-only run gets water, not a second sustained magma source.
  cable(controls[1], [183, 26, 60], E.PSCN);
  box(183, 0, 29, 184, 1, 61, E.METAL);
  box(183, 0, 29, 220, 1, 30, E.METAL);
  box(219, 0, 29, 220, 1, 61, E.METAL);
  column(219, 60, 0, 26, E.METAL);
  set(219, 26, 60, E.NSCN);
  box(184, 23, 60, 219, 28, 62, E.ROCK);
  box(212, 23, 59, 219, 28, 60, E.ROCK);
  box(184, 24, 60, 212, 25, 61, E.PCLN, { ctype: E.LAVA });
  box(184, 26, 60, 219, 27, 61, E.PCLN, { ctype: E.LAVA });
  set(184, 25, 60, E.PCLN, { ctype: E.LAVA });
  return manifest;
}
