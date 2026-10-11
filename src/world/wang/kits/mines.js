// The Mines kit (Noita's Kaivos, its first biome under the mountain): timber-
// shored galleries, collapsed rooms full of rubble, mine-cart corridors with
// rails, flooded sumps, oil pockets, gold veins, a hidden treasure nook, a big
// natural cavern. "Better than Noita": it uses the third dimension: galleries
// cross over each other on timber bridges, rooms have a gallery storey,
// shafts drop through several layers past ledges, and corridors climb.
//
// Format: kit.js (docs/wang-tiles.md). Canonical frame: x 0..48 (two units),
// y 0..24, z 0..24, cells of 0.30 m; a body is 5.5 tall and 1.6 wide, steps a
// cell and jumps about two. The border (2) is rock whatever a tile does; the
// floor is y = 2 and a high gallery's floor y = 13.
import { GEOM, wallTorch } from '../kit.js';

const { U, H, BORDER: B, FLOOR: F, HIGH_FLOOR: HF, DOOR_W, DOOR_H } = GEOM;
const X = 2 * U;                       // a tile's length
const IN = [B, X - B];                 // the tile's inside, x
const INZ = [B, U - B];                // ...and z
const TOP = H - B;                     // the ceiling's underside
const MID = U / 2;                     // a long side's door centre, z (W, E); a unit's centre
const C0 = U / 2, C1 = U + U / 2;      // unit 0's and unit 1's centre, x
const DH = DOOR_W / 2;                 // half a doorway
const GAL_Z = [MID - DH, MID + DH];    // a gallery along x lines up with the W and E doorways
const GAL_TOP = F + DOOR_H;            // ...and is as tall as they are
const DECK = HF - 1;                   // a timber deck's cell: its top is the high floor
const HIGH_TOP = HF + DOOR_H;          // a high gallery's ceiling
const FRAME_STEP = 6;                  // timber sets along a gallery, this far apart (Noita's Mines: a set every few metres)
const ROUGH_WALL = 1.1;                // cells of noise on a dug gallery's walls
const ROUGH_ROOM = 2.2;                // ...a collapsed room's or a natural cave's
const ROUGH_CAVE = 3.2;                // ...the big cavern's
const ROUGH_VEIN = 1.6;                // ...a vein's
const RAIL_GAUGE = GEOM.RAIL_GAUGE;
const CART_BAY = 7;
const SUMP_HEADROOM = 4;               // the sump's gallery is this much taller: headroom over its sills                    // half the rail corridor's width: room to walk past a cart
const WAVE = 3;                       // cells a gallery's line swings in z (Noita's Mines tunnels never run ruler-straight)
const LIFT = 2;                       // cells its floor rises over a hump

// ---- helpers: each returns a list of primitives
// a dug gallery along x from x0 to x1 (z range zr, floor y0, height h), shored
// with timber sets. It meanders: its line swings up to wave cells in z and its
// floor rises up to lift cells, both pinned to straight at its ends (where the
// doorways meet it), phase choosing where; slices of SLICE cells, so the floor
// steps a cell at a time.
const SLICE = 2;
const GALLERY_SALT = 1000;             // galleries' shared noise streams start here (past any prim index)
let gallerySalt = GALLERY_SALT;
function galleryX(x0, x1, { zr = GAL_Z, y0 = F, h = DOOR_H, frames = true, rough = ROUGH_WALL, wave = WAVE, lift = LIFT, phase = 0 } = {}) {
  const air = [], floor = [], timber = [];
  const len = x1 - x0, salt = gallerySalt++;
  let lamp = false, side = 0;
  for (let x = x0; x < x1; x += SLICE) {
    const t = (x + SLICE / 2 - x0) / len, pin = Math.sin(Math.PI * t);
    const dz = Math.round(wave * pin * Math.sin(2 * Math.PI * t + phase));
    const dy = Math.max(0, Math.round(lift * pin * Math.sin(3 * Math.PI * t + phase * 2)));
    const xe = Math.min(x + SLICE, x1);
    // the slices overlap (by their roughness and a cell) and share one noise field, so the
    // noise roughens the gallery's walls, not the seams between its slices
    const pad = Math.ceil(rough) + 1;
    air.push({ box: [[Math.max(x0, x - pad), y0 + dy, zr[0] + dz], [Math.min(x1, xe + pad), y0 + dy + h, zr[1] + dz]], m: 'AIR', rough, salt });
    // the floor stays solid under the noise (and under a raised stretch)
    floor.push({ box: [[x, y0 - 1, zr[0] + dz], [xe, y0 + dy, zr[1] + dz]], m: 'ROCK' });
    if (frames && (x - x0) % FRAME_STEP === 0 && x > x0) {
      timber.push(...frameX(x, [zr[0] + dz, zr[1] + dz], y0 + dy, h));
      lamp ||= ((x - x0) / FRAME_STEP) % LANTERN_FRAMES === 0;
      if (lamp && clearOfShafts(x, MID)) { timber.push(...torchX(x, [zr[0] + dz, zr[1] + dz], y0 + dy, h, side++)); lamp = false; }
    }
  }
  return [...air, ...floor, ...timber];
}
function galleryZ(z0, z1, xc, { y0 = F, h = DOOR_H, w = DOOR_W, frames = true, rough = ROUGH_WALL } = {}) {
  const xr = [xc - w / 2, xc + w / 2];
  const out = [{ box: [[xr[0], y0, z0], [xr[1], y0 + h, z1]], m: 'AIR', rough }];
  out.push({ box: [[xr[0], y0 - 1, z0], [xr[1], y0, z1]], m: 'ROCK' });
  if (frames) {
    let lamp = false, side = 0;
    for (let z = z0 + FRAME_STEP / 2, n = 1; z < z1 - 1; z += FRAME_STEP, n++) {
      out.push(...frameZ(z, xr, y0, h));
      lamp ||= n % LANTERN_FRAMES === 0;
      if (lamp && clearOfShafts(xc, z) && z + 1 < z1) { out.push(...torchZ(z, xr, y0, h, side++)); lamp = false; }
    }
  }
  return out;
}
// A wall torch beside a timber set (kit.js wallTorch): the Mines' light. The
// galleries are dark but for these (as Noita's mines are dark but for their
// torches and what glows), one every few sets (LANTERN_FRAMES sets, 18 cells:
// 5 m), on the wall just past the set's post, the sides taking turns, so a
// gallery reads as warm pools of light with darkness between.
const lamp = (pr) => ({ ...pr, lantern: true });   // a light added after the authoring (goes last: see the end)
const LANTERN_FRAMES = 3;              // a torch every this many timber sets (the next clear one)
const LANTERN_SHAFT_CLEAR = GEOM.SHAFT_W / 2 + 2;   // ...not over a unit's shaft: you'd land on it
const clearOfShafts = (x, z) => [C0, C1].every((c) => Math.abs(x - c) >= LANTERN_SHAFT_CLEAR || Math.abs(z - MID) >= LANTERN_SHAFT_CLEAR);
const TORCH_Y = 7;                     // a torch's head this far over the floor (over a body's head, 5.5), under the cap
const torchY = (y0, h) => y0 + Math.min(TORCH_Y, h - 2);
// on an x gallery's wall (z range zr) one cell past the set at x; side 0, 1: its low, high z wall in turn
const torchX = (x, zr, y0, h, side) => (side % 2 === 0
  ? wallTorch([x + 1, torchY(y0, h), zr[0]], [0, -1])
  : wallTorch([x + 1, torchY(y0, h), zr[1] - 1], [0, 1]));
const torchZ = (z, xr, y0, h, side) => (side % 2 === 0
  ? wallTorch([xr[0], torchY(y0, h), z + 1], [-1, 0])
  : wallTorch([xr[1] - 1, torchY(y0, h), z + 1], [1, 0]));
// a timber set across an x gallery at x: two posts and a cap
function frameX(x, zr, y0, h) {
  return [
    { box: [[x, y0, zr[0]], [x + 1, y0 + h, zr[0] + 1]], m: 'BEAM' },
    { box: [[x, y0, zr[1] - 1], [x + 1, y0 + h, zr[1]]], m: 'BEAM' },
    { box: [[x, y0 + h - 1, zr[0]], [x + 1, y0 + h, zr[1]]], m: 'BEAM' },
  ];
}
function frameZ(z, xr, y0, h) {
  return [
    { box: [[xr[0], y0, z], [xr[0] + 1, y0 + h, z + 1]], m: 'BEAM' },
    { box: [[xr[1] - 1, y0, z], [xr[1], y0 + h, z + 1]], m: 'BEAM' },
    { box: [[xr[0], y0 + h - 1, z], [xr[1], y0 + h, z + 1]], m: 'BEAM' },
  ];
}
// a short dug passage from a side port's face to depth (for a port the tile accepts)
const STUB_DEPTH = 10;
function stub(port, { y0 = F, depth = STUB_DEPTH, rough = ROUGH_WALL } = {}) {
  const top = y0 + DOOR_H;
  const x = port.endsWith('1') ? C1 : C0;
  const flat = (a, b) => [{ box: [a, b], m: 'AIR', rough }, { box: [[a[0], y0 - 1, a[2]], [b[0], y0, b[2]]], m: 'ROCK' }];
  if (port === 'W') return flat([IN[0], y0, GAL_Z[0]], [IN[0] + depth, top, GAL_Z[1]]);
  if (port === 'E') return flat([IN[1] - depth, y0, GAL_Z[0]], [IN[1], top, GAL_Z[1]]);
  if (port[0] === 'N') return flat([x - DH, y0, INZ[0]], [x + DH, top, INZ[0] + depth]);
  return flat([x - DH, y0, INZ[1] - depth], [x + DH, top, INZ[1]]);
}
// rails along x on the floor, centred on z
const railsX = (x0, x1, zc = MID, y = F) => [
  { box: [[x0, y, zc - RAIL_GAUGE / 2], [x1, y + 1, zc - RAIL_GAUGE / 2 + 1]], m: 'RAIL' },
  { box: [[x0, y, zc + RAIL_GAUGE / 2 - 1], [x1, y + 1, zc + RAIL_GAUGE / 2]], m: 'RAIL' },
];
const railsZ = (z0, z1, xc, y = F) => [
  { box: [[xc - RAIL_GAUGE / 2, y, z0], [xc - RAIL_GAUGE / 2 + 1, y + 1, z1]], m: 'RAIL' },
  { box: [[xc + RAIL_GAUGE / 2 - 1, y, z0], [xc + RAIL_GAUGE / 2, y + 1, z1]], m: 'RAIL' },
];
// a crystal cluster (the light) at c
const CRYSTAL_R = 1.4;
const crystal = (c, r = CRYSTAL_R) => ({ ball: [c, [r, r * 1.6, r]], m: 'CRYSTAL', only: ['ROCK', 'AIR'] });
// a rubble heap on the floor at (x, z)
const heap = (x, z, r, y = F) => ({ ball: [[x, y, z], [r, r * 0.6, r]], m: 'RUBBLE', only: 'AIR', rough: 0.6 });
// a chimney: open from a gallery up to the ceiling at a unit's centre, so a shaft from above lands in it
const CHIMNEY_W = GEOM.SHAFT_W + 4;
const chimney = (xc, y0 = F) => ({ box: [[xc - CHIMNEY_W / 2, y0, MID - CHIMNEY_W / 2], [xc + CHIMNEY_W / 2, TOP, MID + CHIMNEY_W / 2]], m: 'AIR', rough: ROUGH_WALL });
// a bay round a floor shaft at a unit's centre: walkways past the hole on both sides, so a
// shaft never cuts the gallery it opens in (scripts/check-wang.mjs opens every hole a tile takes)
const BAY_WALK = 4;                    // cells of floor each side of the hole
function bay(xc) {
  const hw = GEOM.SHAFT_W / 2 + BAY_WALK;
  return [
    { box: [[xc - hw, F, MID - hw], [xc + hw, GAL_TOP, MID + hw]], m: 'AIR', rough: ROUGH_WALL },
    { box: [[xc - hw, F - 1, MID - hw], [xc + hw, F, MID + hw]], m: 'ROCK' },
  ];
}
// a deck of timber (its top at the high floor) over x0..x1 × z0..z1
const deck = (x0, x1, z0, z1, y = DECK) => ({ box: [[x0, y, z0], [x1, y + 1, z1]], m: 'BEAM' });

const SIDES = ['N0', 'N1', 'S0', 'S1'];

const tiles = [
  // ---- the universal tile: a two-storey timber hall, a balcony all round at the
  // gallery level, stairs up both long sides. It takes any colour on any port.
  {
    name: 'timber hall', weight: 0.6,
    ports: { W: 'DHR-', E: 'DHR-', N0: 'DHR-', N1: 'DHR-', S0: 'DHR-', S1: 'DHR-', D0: 'S-', D1: 'S-', U0: 'S-', U1: 'S-' },
    prims: [
      { box: [[IN[0], F, INZ[0]], [IN[1], TOP, INZ[1]]], m: 'AIR', rough: ROUGH_WALL },
      { box: [[IN[0], F - 1, INZ[0]], [IN[1], F, INZ[1]]], m: 'ROCK' },
      // the balcony: a ring of timber 5 wide
      deck(IN[0], IN[1], INZ[0], INZ[0] + 5), deck(IN[0], IN[1], INZ[1] - 5, INZ[1]),
      deck(IN[0], IN[0] + 5, INZ[0], INZ[1]), deck(IN[1] - 5, IN[1], INZ[0], INZ[1]),
      // its posts
      ...[8, 16, 24, 32, 40].flatMap((x) => [
        { box: [[x, F, INZ[0] + 4], [x + 1, DECK, INZ[0] + 5]], m: 'BEAM' },
        { box: [[x, F, INZ[1] - 5], [x + 1, DECK, INZ[1] - 4]], m: 'BEAM' },
      ]),
      // stairs up to it on both long sides
      { stairs: [[18, F, INZ[0] + 5], [18 + HF - F, HF, INZ[0] + 8]], m: 'BEAM', axis: 'x', rise: -1 },
      { stairs: [[30 - (HF - F), F, INZ[1] - 8], [30, HF, INZ[1] - 5]], m: 'BEAM', axis: 'x', rise: 1 },
      crystal([C0, TOP, MID - 6]), crystal([C1, TOP, MID + 6]),
      heap(24, MID, 3),
    ],
    sites: [{ kind: 'loot', at: [24, HF, INZ[0] + 2] }],
  },
  // ---- plain shored gallery, side niches where it may open
  {
    name: 'gallery', weight: 3,
    ports: { W: 'DR-', E: 'DR-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D0: '-S', D1: '-S' },
    prims: [...galleryX(IN[0], IN[1], { phase: 0.4 }), heap(C0 - 8, GAL_Z[0] + 1, 2.5)],
  },
  // ---- a gallery whose floor caves in: shafts from above land in it, its floor drops away
  {
    name: 'chimney gallery', weight: 1.5,
    ports: { W: 'D-R', E: 'D-R', N0: '-D', S1: '-D', D0: 'S-', D1: '-S', U0: 'S-', U1: '-S' },
    prims: [
      ...galleryX(IN[0], IN[1], { phase: 2.1, lift: 0 }), chimney(C0), chimney(C1),
      { box: [[C0 - 6, 14, MID - 6], [C0 - 3, 15, MID + 6]], m: 'BEAM' },   // a ledge in the chimney
      heap(C1 + 6, MID, 2),
    ],
  },
  // ---- mine-cart corridor: rails end to end, an iron cart parked on them
  {
    name: 'rail corridor', weight: 2,
    ports: { W: 'RD', E: 'RD', N1: '-D', S0: '-D' },
    prims: [
      // wide enough to pass the cart
      ...galleryX(IN[0], IN[1], { wave: 0, lift: 0, zr: [MID - CART_BAY, MID + CART_BAY] }), ...railsX(IN[0], IN[1]),
      { box: [[30, F + 1, MID - 3], [36, F + 4, MID + 3]], m: 'METAL' },
      { box: [[31, F + 2, MID - 2], [35, F + 4, MID + 2]], m: 'GRAVEL' },
    ],
  },
  // ---- rail junction: the line forks off along z through unit 1
  {
    name: 'rail junction', weight: 1,
    ports: { W: 'RD', E: 'RD-', S1: 'R', N1: '-RD' },
    prims: [
      ...galleryX(IN[0], IN[1], { wave: 0, lift: 0 }), ...galleryZ(INZ[0], INZ[1], C1),
      ...railsX(IN[0], C1 + RAIL_GAUGE), ...railsZ(MID, INZ[1], C1),
      crystal([C1 + 5, GAL_TOP, MID - 5]),
    ],
  },
  // ---- crossroads: galleries along x and along z through unit 0
  {
    name: 'crossroads', weight: 1.5,
    ports: { W: 'D-R', E: 'D-R', N0: 'D-', S0: 'D-', N1: '-D', S1: '-D', D1: '-S' },
    prims: [...galleryX(IN[0], IN[1], { phase: 4.0 }), ...galleryZ(INZ[0], INZ[1], C0), ...bay(C1), heap(C1 + 8, MID + 6, 2)],
  },
  // ---- overpass: a gallery along x, a timber bridge crossing over it along z
  // (unit 1, the high doorways), and stairs between them
  {
    name: 'overpass', weight: 1.4,
    ports: { W: 'D-R', E: 'D-R', N1: 'H-', S1: 'H-', N0: '-D' },
    prims: [
      ...galleryX(IN[0], IN[1], { phase: 1.2, lift: 0 }),
      // the bridge: an open cut along z over unit 1, decked at the high floor
      { box: [[C1 - DH, HF, INZ[0]], [C1 + DH, HIGH_TOP, INZ[1]]], m: 'AIR', rough: ROUGH_WALL },
      // the stair hall beside the gallery, up to the bridge
      { box: [[12, F, MID], [C1 + DH, HIGH_TOP, INZ[1] - 1]], m: 'AIR', rough: ROUGH_WALL },   // (into the bridge's cut: no rough seam between them)
      { box: [[12, F - 1, MID], [C1 - DH, F, INZ[1] - 1]], m: 'ROCK' },
      { stairs: [[C1 - DH - (HF - F) - 2, F, GAL_Z[1] + 1], [C1 - DH, HF, INZ[1] - 1]], m: 'BEAM', axis: 'x', rise: 1 },
      deck(C1 - DH, C1 + DH, INZ[0], INZ[1]),   // (after the stair hall, which cuts through its line)
      crystal([C1, HIGH_TOP, MID]),
    ],
  },
  // ---- two storeys: a gallery over a gallery, a stairwell between; either end may be high or low
  {
    name: 'two storeys', weight: 1.2,
    ports: { W: 'DH-', E: 'HD-', S0: '-D', N1: '-H' },
    prims: [
      ...galleryX(IN[0], IN[1], { wave: 0, lift: 0 }), ...galleryX(IN[0], IN[1], { y0: HF, wave: 0, lift: 0 }), deck(IN[0], IN[1], GAL_Z[0], GAL_Z[1]),

      // the stairwell, beside the galleries
      { box: [[16, F, INZ[0]], [34, HIGH_TOP, GAL_Z[0]]], m: 'AIR', rough: ROUGH_WALL },
      { box: [[16, F - 1, INZ[0]], [34, F, GAL_Z[0]]], m: 'ROCK' },
      { stairs: [[16, F, INZ[0]], [16 + HF - F + 2, HF, GAL_Z[0]]], m: 'BEAM', axis: 'x', rise: -1 },
      crystal([30, HIGH_TOP, INZ[0] + 2]),
    ],
  },
  // ---- a corridor climbing a storey: low at W, high at E
  {
    name: 'incline', weight: 1,
    ports: { W: 'D', E: 'H', N0: '-D', N1: '-', S0: '-', S1: '-' },
    prims: [
      { box: [[IN[0], F, GAL_Z[0]], [IN[1], HIGH_TOP, GAL_Z[1]]], m: 'AIR', rough: ROUGH_WALL },
      { ramp: [[10, F, GAL_Z[0]], [38, HF, GAL_Z[1]]], m: 'ROCK', axis: 'x', rise: 1 },
      { box: [[38, F, GAL_Z[0]], [IN[1], HF, GAL_Z[1]]], m: 'ROCK' },
      { box: [[IN[0], F - 1, GAL_Z[0]], [10, F, GAL_Z[1]]], m: 'ROCK' },

      ...[16, 24, 32].flatMap((x) => frameX(x, GAL_Z, F + Math.round(((x - 10) * (HF - F)) / 28), DOOR_H)),
      ...wallTorch([24, HF + TORCH_Y, GAL_Z[0]], [0, -1]),
    ],
  },
  // ---- collapsed room: the roof came down; rubble heaps, broken timber, soft fallen rock
  {
    name: 'collapsed room', weight: 1.3,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D1: '-S' },
    prims: [
      { box: [[4, F, 4], [44, 16, 20]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[4, F - 1, 4], [44, F, 20]], m: 'ROCK' },
      ...['W', 'E'].flatMap((p) => stub(p)),
      heap(14, 9, 5), heap(30, 15, 6), heap(38, 7, 3),
      { ball: [[22, 18, 12], [6, 3, 4]], m: 'SOFT', only: 'ROCK', rough: 1 },
      { capsule: [[8, F, 6], [16, 12, 9], 0.8], m: 'BEAM' },      // a fallen prop
      { capsule: [[26, F + 1, 18], [36, F + 6, 10], 0.8], m: 'BEAM' },
      crystal([40, 14, 18]),
    ],
    sites: [{ kind: 'loot', at: [24, F, 8] }],
  },
  // ---- a shaft down through unit 0, ledges on its walls, the gallery past it
  {
    name: 'shaft', weight: 1.4,
    ports: { W: 'D-', E: 'D-R', S1: '-D', D0: 'S', U0: 'S-' },
    prims: [
      ...galleryX(IN[0], IN[1], { phase: 2.6, lift: 0 }),
      { box: [[C0 - 7, F, MID - 7], [C0 + 7, TOP, MID + 7]], m: 'AIR', rough: ROUGH_ROOM },
      // ledges stepping round the walls (out of the drop's line)
      { box: [[C0 - 7, 8, MID - 7], [C0 - 3, 9, MID + 1]], m: 'BEAM' },
      { box: [[C0 + 3, 14, MID - 2], [C0 + 7, 15, MID + 7]], m: 'BEAM' },
      { box: [[C0 - 7, 18, MID + 3], [C0 + 1, 19, MID + 7]], m: 'BEAM' },
      crystal([C0 + 7, 10, MID - 6]),
    ],
  },
  // ---- a drop room: the floor gives way into the layer below in both units
  {
    name: 'drop room', weight: 0.8,
    ports: { W: 'D-', E: '-D', N1: '-D', D0: 'S-', D1: 'S-', U1: '-S' },
    prims: [
      { box: [[IN[0], F, 6], [IN[1], 15, 18]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[IN[0], F - 1, 6], [IN[1], F, 18]], m: 'ROCK' },
      chimney(C1), ...stub('W'), ...stub('E'),
      heap(24, MID, 3), { box: [[20, F, 6], [28, F + 1, 18]], m: 'BEAM' },   // planks over the gap between the holes
      ...wallTorch([24, F + TORCH_Y, 6], [0, -1]),
    ],
  },
  // ---- flooded sump: the gallery dips behind two sills and the water stands in it
  {
    name: 'flooded sump', weight: 1,
    ports: { W: 'D-', E: 'D-', N1: '-D' },
    prims: [
      ...galleryX(IN[0], IN[1], { wave: 0, lift: 0, h: DOOR_H + SUMP_HEADROOM }),
      { box: [[14, F, GAL_Z[0] - 2], [34, GAL_TOP + 4, GAL_Z[1] + 2]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[14, F - 1, GAL_Z[0] - 2], [34, F, GAL_Z[1] + 2]], m: 'ROCK' },
      { ramp: [[10, F, GAL_Z[0]], [15, F + 4, GAL_Z[1]]], m: 'ROCK', axis: 'x', rise: 1 },
      { ramp: [[33, F, GAL_Z[0]], [38, F + 4, GAL_Z[1]]], m: 'ROCK', axis: 'x', rise: -1 },
      { box: [[15, F, GAL_Z[0] - 2], [33, F + 4, GAL_Z[1] + 2]], m: 'WATER', only: 'AIR' },

      crystal([24, GAL_TOP + 4, MID]),
    ],
  },
  // ---- oil pocket: a sealed lens of oil in the rock over the gallery (dig, and it pours), a slick on the floor
  {
    name: 'oil pocket', weight: 0.9,
    ports: { W: 'D-R', E: 'D-R', S0: '-D' },
    prims: [
      ...galleryX(IN[0], IN[1], { phase: 3.1 }),
      { ball: [[28, 17, MID], [10, 2.5, 5]], m: 'OIL', only: 'ROCK', rough: 1 },
      { box: [[20, F, GAL_Z[0] + 1], [26, F + 1, GAL_Z[1] - 1]], m: 'OIL', only: 'AIR' },
    ],
  },
  // ---- gold vein: the gallery widens into a working face threaded with gold
  {
    name: 'gold face', weight: 0.9,
    ports: { W: 'D-', E: 'D-R', N0: '-D', S1: '-D' },
    prims: [
      ...galleryX(IN[0], IN[1], { phase: 5.2 }),
      { ball: [[28, 8, MID], [10, 7, 8]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[18, F - 1, MID - 8], [38, F, MID + 8]], m: 'ROCK' },
      { capsule: [[16, 4, 3], [40, 16, 21], 1.2], m: 'GOLD', only: 'ROCK', rough: ROUGH_VEIN },
      { capsule: [[22, 18, 3], [36, 6, 21], 0.9], m: 'GOLD', only: 'ROCK', rough: ROUGH_VEIN },
      crystal([28, 14, MID + 7]),
    ],
    sites: [{ kind: 'gold', at: [28, F, MID] }],
  },
  // ---- the hidden treasure nook: one way in, a crooked crawl, gold and a light at the end
  {
    name: 'treasure nook', weight: 2,
    ports: { E: 'D', W: '-', N0: '-', N1: '-', S0: '-', S1: '-' },
    prims: [
      ...galleryX(32, IN[1], { frames: false }),
      { capsule: [[33, F + 3, MID], [22, F + 3, MID - 6], 3.2], m: 'AIR', rough: 0.8 },
      { box: [[8, F, 3], [24, 12, 13]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[8, F - 1, 3], [24, F, 13]], m: 'ROCK' },
      { box: [[20, F - 1, 4], [32, F, 12]], m: 'ROCK' },
      { box: [[11, F, 5], [15, F + 2, 9]], m: 'GOLD' },
      crystal([10, 11, 4]), crystal([22, 11, 12]),
    ],
    sites: [{ kind: 'treasure', at: [13, F + 2, 7] }, { kind: 'wand', at: [18, F, 8] }],
  },
  {
    name: 'side nook', weight: 1.4,
    ports: { S1: 'D', W: '-', E: '-', N0: '-', N1: '-', S0: '-' },
    prims: [

      { box: [[10, F, 4], [42, 11, 15]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[10, F - 1, 4], [42, F, 15]], m: 'ROCK' },
      { box: [[12, F, 5], [16, F + 3, 8]], m: 'BEAM' },      // crates
      { box: [[12, F + 3, 5], [15, F + 5, 8]], m: 'BEAM' },
      { box: [[18, F, 5], [21, F + 2, 7]], m: 'GOLD' },
      crystal([26, 11, 5]),
    ],
    sites: [{ kind: 'loot', at: [24, F, 10] }],
  },
  // ---- the big cavern set piece: a natural vault, crystals, a pool, ledges
  {
    name: 'great cavern', weight: 0.7,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D0: '-S', D1: '-S', U0: '-S', U1: '-S' },
    prims: [
      { ball: [[24, 12, 12], [24, 13, 12]], m: 'AIR', rough: ROUGH_CAVE },
      { box: [[3, F, 3], [45, 10, 21]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[3, F - 1, 3], [45, F, 21]], m: 'ROCK' },
      ...['W', 'E'].flatMap((p) => stub(p)),
      { box: [[28, F, 15], [40, F + 2, 20]], m: 'WATER', only: 'AIR' },
      { ball: [[28, F, 14], [2, 2, 1]], m: 'ROCK' },
      { ramp: [[4, F, 3], [16, 10, 8]], m: 'ROCK', axis: 'x', rise: -1 },
      crystal([6, 18, 12], 2), crystal([42, 16, 6], 1.8), crystal([24, 21, 12], 2),
      heap(18, 16, 3),
      { box: [[32, 15, 4], [44, 16, 9]], m: 'BEAM' },   // an old scaffold
    ],
    sites: [{ kind: 'loot', at: [8, 10, 5] }],
  },
  // ---- a crooked natural crawl: no timber, moss on the walls
  {
    name: 'moss crawl', weight: 1,
    ports: { W: 'D-', E: 'D-', S0: '-D', N1: '-D' },
    prims: [
      { capsule: [[3, 7, MID], [16, 8, 7], 4.5], m: 'AIR', rough: ROUGH_ROOM },
      { capsule: [[16, 8, 7], [32, 7, 17], 4.5], m: 'AIR', rough: ROUGH_ROOM },
      { capsule: [[32, 7, 17], [45, 7, MID], 4.5], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[IN[0], F - 1, INZ[0]], [IN[1], F, INZ[1]]], m: 'ROCK' },
      ...stub('W'), ...stub('E'),
      { capsule: [[3, 7, MID], [16, 8, 7], 5.6], m: 'MOSS', only: 'ROCK', rough: ROUGH_ROOM },
      { capsule: [[16, 8, 7], [32, 7, 17], 5.6], m: 'MOSS', only: 'ROCK', rough: ROUGH_ROOM },
      { box: [[22, F, 9], [27, F + 1, 15]], m: 'WATER', only: 'AIR' },
      lamp(crystal([24, 12.5, 12])),
    ],
  },
  // ---- a side chamber up three steps off the gallery: the miners' store
  {
    name: 'store room', weight: 1,
    ports: { W: 'D-R', E: 'D-R', S0: '-D', S1: '-D' },
    prims: [
      ...galleryX(IN[0], IN[1], { phase: 0.9, lift: 0 }),
      { box: [[18, F + 3, INZ[0]], [38, 14, GAL_Z[0]]], m: 'AIR', rough: ROUGH_WALL },
      { stairs: [[18, F, GAL_Z[0] - 3], [24, F + 3, GAL_Z[0]]], m: 'ROCK', axis: 'z', rise: -1 },
      { box: [[18, F, INZ[0]], [38, F + 3, GAL_Z[0] - 3]], m: 'ROCK' },
      { box: [[30, F + 3, INZ[0]], [34, F + 6, INZ[0] + 3]], m: 'BEAM' },
      { box: [[34, F + 3, INZ[0]], [37, F + 5, INZ[0] + 3]], m: 'BEAM' },
      crystal([26, 14, INZ[0] + 1]),
    ],
    sites: [{ kind: 'loot', at: [28, F + 3, INZ[0] + 2] }],
  },
];
// the lanterns go last in each tile: a prim's noise stream is its index
// (kit.js NOISE_PRIM_STRIDE), so the shapes stay as authored
for (const t of tiles) t.prims = [...t.prims.filter((pr) => !pr.lantern), ...t.prims.filter((pr) => pr.lantern)];

export default {
  name: 'mines',
  // wall torches where the timber sets' don't reach (kit.js placeTorches: rooms, caverns, stores)
  torches: { every: 18, max: 2, lights: ['TORCH'] },
  // Noita's Mines: brown-grey rock, timber, a lot of it diggable
  palette: { ROCK: 'ROCK', SOFT: 'LIMESTONE', BEAM: 'WOOD', RAIL: 'METAL', RUBBLE: 'RUBBLE' },
  tiles,
};
