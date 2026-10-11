// Electric lights: lamps (elements.js LAMP) on batteries, as constructions
// (the palette's Light) and as fittings other constructions and maps put in
// their dark rooms (builtins.js house, structures.js, arenas/damValley.js).
//
// Each lamp cell touches a battery, so it is on direct current: lit and still
// from the moment it is placed, and in a loaded world as generated
// (electricity.js LAMP_DC). The fixtures are insulator and ceramic, never a
// metal touching a battery or a lamp, which would carry sparks and glow along
// its length. The battery hides behind the lamps, inside the fitting or the
// wall. Shoot or kick a bulb and it shatters and that cell goes dark (Noita's
// lamps); break the battery and the whole fitting goes out a moment later.
//
// The wall light is Halo's: a strip light in a grey housing on the wall, like
// the sconces down the UNSC ships' corridors. The rest are what a house or a street has.

const FRAME = 'INSULATOR';   // the housings: pale grey, Halo's UNSC panels
const SHADE = 'CERAMIC';     // shades: white porcelain

// A wall light whose bulbs sit at (x, y, z), out of a wall toward (dx, dz) (a
// unit step along x or z): a strip of WALL_LIGHT.STRIP lamps across the wall,
// its battery strip in the wall behind it (replacing those wall cells) and a
// hood over it. Lights out and down: the hood shades the ceiling.
export const WALL_LIGHT = { STRIP: 3 };
export function wallLight({ put }, x, y, z, dx, dz) {
  const half = (WALL_LIGHT.STRIP - 1) / 2;
  const sx = dz !== 0 ? 1 : 0, sz = dx !== 0 ? 1 : 0;   // along the wall
  for (let i = -half - 1; i <= half + 1; i++) {
    const ax = x + sx * i, az = z + sz * i;
    const end = Math.abs(i) > half;
    put(ax - dx, y, az - dz, end ? FRAME : 'BATTERY');   // in the wall
    put(ax, y, az, end ? FRAME : 'LAMP');
    put(ax, y + 1, az, FRAME);                         // the hood
    put(ax - dx, y + 1, az - dz, FRAME);
  }
}

// A ceiling light hanging from (x, top, z) down a cord of CEILING_LIGHT.DROP
// cells: a row of lamps under a battery bar, in a porcelain shade.
export const CEILING_LIGHT = { DROP: 2 };
export function ceilingLight({ put, box }, x, top, z) {
  const y = top - CEILING_LIGHT.DROP - 2;   // the bulbs' row: cord, then the battery bar over them
  box(x, y + 2, z, x, top, z, FRAME);       // the cord (and its ceiling rose)
  box(x - 2, y + 1, z - 1, x + 2, y + 1, z + 1, SHADE);
  box(x - 1, y + 1, z, x + 1, y + 1, z, 'BATTERY');
  box(x - 1, y, z, x + 1, y, z, 'LAMP');
}

// The palette's Light: built around its base (0, 0, 0) with its back on z = 0,
// so placed on a wall it hangs there (constructions.js puts the base by the
// face clicked, its front toward the camera), and placed under a ceiling it
// hangs from it. Fixed sizes, like the shrine: lights are built to the room
// and the body, not the brush.
const FLOOR_LAMP = { POLE: 4 };                // cells of pole: its bulb at 1.5 m, eye level is 1.65
const STREET_LAMP = { POLE: 12, ARM: 3 };      // 3.6 m to the arm, which reaches this far out over the road
export function light(api, variant) {
  const { put, box, footing } = api;
  if (variant === 'ceiling') return ceilingLight(api, 0, CEILING_LIGHT.DROP + 2, 1);
  if (variant === 'floor') {
    footing();
    box(-1, 0, 0, 1, 0, 2, SHADE);                   // the foot
    box(0, 1, 1, 0, FLOOR_LAMP.POLE, 1, FRAME);       // the pole
    const y = FLOOR_LAMP.POLE + 1;
    put(0, y, 1, 'LAMP');
    put(0, y + 1, 1, 'BATTERY');
    for (const [ox, oz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) put(ox, y + 1, 1 + oz, SHADE);   // the shade
    box(-1, y + 2, 0, 1, y + 2, 2, SHADE);
    return;
  }
  if (variant === 'street') {
    footing();
    box(-1, 0, 0, 1, 0, 2, 'WALL');                    // a concrete plinth
    const P = STREET_LAMP.POLE, A = STREET_LAMP.ARM;
    box(0, 1, 1, 0, P, 1, 'METAL');                    // the pole and its arm: steel, kept off the battery
    box(0, P, 2, 0, P, A, 'METAL');
    const z0 = 1 + A;                                  // the head: an insulator collar, then the battery over the bulbs
    box(-1, P, z0, 1, P, z0, FRAME);
    box(-1, P, z0 + 1, 1, P, z0 + 2, 'BATTERY');
    box(-1, P - 1, z0 + 1, 1, P - 1, z0 + 2, 'LAMP');
    box(-2, P + 1, z0, 2, P + 1, z0 + 3, FRAME);       // the head's cap, a cell over all round
    for (const x of [-2, 2]) box(x, P, z0, x, P, z0 + 3, FRAME);
    box(-1, P, z0 + 3, 1, P, z0 + 3, FRAME);
    return;
  }
  // the wall light: its back plate on z = 0 (wallLight sets its battery into it), the bulbs a cell out
  const half = (WALL_LIGHT.STRIP - 1) / 2;
  box(-half - 1, 0, 0, half + 1, 2, 0, FRAME);
  wallLight(api, 0, 1, 1, 0, 1);
}
