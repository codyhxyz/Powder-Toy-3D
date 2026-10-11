// The Snowy Depths kit (Noita's Lumen alla, the third biome down): icy caverns
// with snow drifted on every floor, ice-lined walls and icicles, frozen ponds,
// the brick ruins of an older people (walls with arched doorways, pillars),
// rubble, and the cold blue-violet light of crystal. "Better than Noita": it
// uses the third dimension: an ice bridge spans a chasm you can see across, a
// collapsed brick cathedral has a nave, an arcade and a gallery under fallen
// ribs, a frozen waterfall hangs down a shaft, and one warm brick nook (a
// hearth stocked with coal and firewood: light it) hides behind a crawl.
//
// Format: kit.js (docs/wang-tiles.md); kits/mines.js is the worked example.
// Canonical frame: x 0..48 (two units), y 0..24, z 0..24, cells of 0.30 m; a
// body is 5.5 tall and 1.6 wide, steps a cell and jumps about two. The border
// (2) is rock whatever a tile does; the floor is y = 2 and a high gallery's
// floor y = 13. The Snowy Depths scene holds every cell below freezing
// (descent/scenes.js COLD_T), so the ice keeps and the snow stays powder.
//
// Codes reuse kit.js MAT through the palette: BEAM is brick here (the ruins,
// and the doorway sets the sampler cuts become brick jambs and lintels), SAND
// is snow (a powder: drifts), MOSS is the nook's firewood.
import { GEOM } from '../kit.js';

const { U, H, BORDER: B, FLOOR: F, HIGH_FLOOR: HF, DOOR_W, DOOR_H, SHAFT_W } = GEOM;
const X = 2 * U;                       // a tile's length
const IN = [B, X - B];                 // the tile's inside, x
const INZ = [B, U - B];                // ...and z
const TOP = H - B;                     // the ceiling's underside
const MID = U / 2;                     // a long side's door centre, z (W, E); a unit's centre
const C0 = U / 2, C1 = U + U / 2;      // unit 0's and unit 1's centre, x
const DH = DOOR_W / 2;                 // half a doorway
const GAL_Z = [MID - DH, MID + DH];    // a tunnel along x lines up with the W and E doorways
const DECK = HF - 1;                   // a brick deck's cell: its top is the high floor
const HIGH_TOP = HF + DOOR_H;          // a high gallery's ceiling
const TUNNEL_H = DOOR_H + 3;           // an ice tunnel is taller than its doorways: headroom over snow and under icicles
const SNOW_T = 1;                      // cells of snow on a floor (Noita's Snowy Depths: a white rind on every ledge)
const DRIFT_H = 2;                     // a drift's height over the floor: a jump (walk.js JUMP)
const LINING = 1;                      // cells of ice lining a cave's walls (noise eats it to patches)
const ROUGH_WALL = 1.2;                // cells of noise on an ice tunnel's walls
const ROUGH_ROOM = 2.2;                // ...a cave room's
const ROUGH_CAVE = 3.2;                // ...a cavern's
const ROUGH_LINING = 2.0;              // ...the ice lining's (more than the cave's: it shows in patches)
const ROUGH_BRICK = 0;                 // brickwork is crisp
const WAVE = 3;                        // cells a tunnel's line swings in z
const LIFT = 1;                        // cells its floor rises over a hump (+ SNOW_T: a doorway cut to the bare floor is at most a jump below it)
const SLICE = 2;                       // a tunnel's slices (its floor steps a cell at a time)
const ICICLE_R = 0.9;                  // an icicle's radius at its root
const ICICLE_LEN = 2.5;                // ...its length in a tunnel (TUNNEL_H leaves a body room under it)
const ICICLE_LEN_HALL = 6;             // ...in a tall room, over the middle
const PILLAR_R = 1.4;                  // a brick pillar's radius
const ARCH_W = 6;                      // an arched doorway in a ruin wall: its width...
const ARCH_SPRING = 6;                 // ...the height its arch springs from
const WALL_T = 2;                      // a ruin wall's thickness
const CRYSTAL_R = 1.4;

// a small seeded generator for the scattered detail (icicles): the kit is data, the same every load
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ---- helpers: each returns a list of primitives
const SALT0 = 1000;                    // shared noise streams start here (past any prim index)
let salt = SALT0;
// an ice tunnel along x: a natural cave, ice-lined, snow on its floor, icicles
// on its roof. It meanders (WAVE in z, LIFT up) pinned straight at its ends,
// where the doorways meet it.
function tunnelX(x0, x1, { zr = GAL_Z, y0 = F, h = TUNNEL_H, rough = ROUGH_WALL, wave = WAVE, lift = LIFT, phase = 0, icicles = 5, seed = 1 } = {}) {
  const lining = [], air = [], floor = [], snow = [];
  const len = x1 - x0, s = salt++, sl = salt++;
  const pad = Math.ceil(rough) + 1;
  const tops = [];
  for (let x = x0; x < x1; x += SLICE) {
    const t = (x + SLICE / 2 - x0) / len, pin = Math.sin(Math.PI * t);
    const dz = Math.round(wave * pin * Math.sin(2 * Math.PI * t + phase));
    const dy = Math.max(0, Math.round(lift * pin * Math.sin(3 * Math.PI * t + phase * 2)));
    const xe = Math.min(x + SLICE, x1);
    const a = [Math.max(x0, x - pad), y0 + dy, zr[0] + dz], b = [Math.min(x1, xe + pad), y0 + dy + h, zr[1] + dz];
    lining.push({ box: [[a[0], a[1] - 1, a[2] - LINING], [b[0], b[1] + LINING, b[2] + LINING]], m: 'ICE', only: 'ROCK', rough: ROUGH_LINING, salt: sl });
    air.push({ box: [a, b], m: 'AIR', rough, salt: s });
    floor.push({ box: [[x, y0 - 1, zr[0] + dz], [xe, y0 + dy, zr[1] + dz]], m: 'ROCK' });
    snow.push({ box: [[x, y0 + dy, zr[0] + dz - 1], [xe, y0 + dy + SNOW_T, zr[1] + dz + 1]], m: 'SAND', only: 'AIR' });
    tops.push([x + 1, y0 + dy + h, (zr[0] + zr[1]) / 2 + dz]);
  }
  const r = lcg(seed * 7 + x0), ic = [];
  for (let n = 0; n < icicles; n++) {
    const [x, y, z] = tops[Math.floor(r() * tops.length)];
    ic.push(icicle([x, y, z + (r() - 0.5) * (zr[1] - zr[0] - 2)], ICICLE_LEN * (0.6 + 0.4 * r())));
  }
  return [...lining, ...air, ...floor, ...snow, ...ic.filter(Boolean)];
}
// a straight tunnel along z through x = xc
function tunnelZ(z0, z1, xc, { y0 = F, h = TUNNEL_H, w = DOOR_W, rough = ROUGH_WALL } = {}) {
  const xr = [xc - w / 2, xc + w / 2];
  return [
    { box: [[xr[0] - LINING, y0 - 1, z0], [xr[1] + LINING, y0 + h + LINING, z1]], m: 'ICE', only: 'ROCK', rough: ROUGH_LINING },
    { box: [[xr[0], y0, z0], [xr[1], y0 + h, z1]], m: 'AIR', rough },
    { box: [[xr[0], y0 - 1, z0], [xr[1], y0, z1]], m: 'ROCK' },
    { box: [[xr[0] - 1, y0, z0], [xr[1] + 1, y0 + SNOW_T, z1]], m: 'SAND', only: 'AIR' },
  ];
}
// a cave room: an ice-lined box of air, its floor flat and snowed
function room(a, b, { rough = ROUGH_ROOM, lined = true, snowed = true } = {}) {
  return [
    ...(lined ? [{ box: [[a[0] - LINING, a[1] - 1, a[2] - LINING], [b[0] + LINING, b[1] + LINING, b[2] + LINING]], m: 'ICE', only: 'ROCK', rough: ROUGH_LINING }] : []),
    { box: [a, b], m: 'AIR', rough },
    { box: [[a[0], a[1] - 1, a[2]], [b[0], a[1], b[2]]], m: 'ROCK' },
    ...(snowed ? [{ box: [[a[0] - 1, a[1], a[2] - 1], [b[0] + 1, a[1] + SNOW_T, b[2] + 1]], m: 'SAND', only: 'AIR' }] : []),
  ];
}
// a short passage from a side port's face (for a port the tile accepts but whose room stops short)
const STUB_DEPTH = 10;
function stub(port, { y0 = F, depth = STUB_DEPTH, rough = ROUGH_WALL } = {}) {
  const top = y0 + DOOR_H + 1;
  const x = port.endsWith('1') ? C1 : C0;
  const flat = (a, b) => [{ box: [a, b], m: 'AIR', rough }, { box: [[a[0], y0 - 1, a[2]], [b[0], y0, b[2]]], m: 'ROCK' }];
  if (port === 'W') return flat([IN[0], y0, GAL_Z[0]], [IN[0] + depth, top, GAL_Z[1]]);
  if (port === 'E') return flat([IN[1] - depth, y0, GAL_Z[0]], [IN[1], top, GAL_Z[1]]);
  if (port[0] === 'N') return flat([x - DH, y0, INZ[0]], [x + DH, top, INZ[0] + depth]);
  return flat([x - DH, y0, INZ[1] - depth], [x + DH, top, INZ[1]]);
}
// an icicle hanging from a roof at (x, y, z): a spindle half in the rock, half hanging.
// None hangs in a shaft's column (a unit's centre): a body falling in from above lands on the floor.
const SHAFT_CLEAR = SHAFT_W / 2 + 2;
const inShaftColumn = (x, z) => Math.abs(z - MID) < SHAFT_CLEAR && (Math.abs(x - C0) < SHAFT_CLEAR || Math.abs(x - C1) < SHAFT_CLEAR);
const icicle = ([x, y, z], len, r = ICICLE_R) => (inShaftColumn(x, z) ? null : { ball: [[x, y + 1, z], [r, len + 1, r]], m: 'ICE', only: 'AIR' });
// a row of them along x under a roof at y
function icicleRow(x0, x1, y, zs, len, seed) {
  const rr = lcg(seed), out = [];
  for (let x = x0; x < x1; x += 2 + Math.floor(rr() * 3)) out.push(icicle([x + 0.5, y, zs[Math.floor(rr() * zs.length)] + rr() * 2 - 1], len * (0.5 + 0.5 * rr()), ICICLE_R * (0.7 + 0.5 * rr())));
  return out.filter(Boolean);
}
// an ice stalagmite on a floor
const stalagmite = ([x, y, z], hgt, r = 1.3) => ({ ball: [[x, y, z], [r, hgt, r]], m: 'ICE', only: ['AIR', 'SAND'] });
// a snow drift on a floor at (x, z), banked against whatever is there
const drift = (x, z, rx, rz = rx * 0.7, y = F) => ({ ball: [[x, y, z], [rx, DRIFT_H + 0.5, rz]], m: 'SAND', only: 'AIR', rough: 0.5 });
// a crystal cluster (the cold light) at c
const crystal = (c, r = CRYSTAL_R) => ({ ball: [c, [r, r * 1.6, r]], m: 'CRYSTAL', only: ['ROCK', 'AIR', 'ICE'] });
// a brick deck (its top at the high floor) over x0..x1 × z0..z1
const deck = (x0, x1, z0, z1, y = DECK) => ({ box: [[x0, y, z0], [x1, y + 1, z1]], m: 'BEAM' });
// a brick pillar at (x, z), from y0 up h cells
const pillar = (x, z, h, y0 = F, r = PILLAR_R) => ({ cyl: [[x, y0, z], r, h], axis: 'y', m: 'BEAM', rough: ROUGH_BRICK });
// a ruin wall across an x tunnel at x (filling only what is open there), with an arched doorway at zc
function ruinWall(x, zc = MID, { y0 = F, gap = true } = {}) {
  const out = [{ box: [[x, y0, INZ[0]], [x + WALL_T, TOP, INZ[1]]], m: 'BEAM', only: ['AIR', 'SAND', 'ICE'] }];
  if (gap) out.push(
    { box: [[x, y0, zc - ARCH_W / 2], [x + WALL_T, y0 + ARCH_SPRING, zc + ARCH_W / 2]], m: 'AIR' },
    { cyl: [[x, y0 + ARCH_SPRING, zc], ARCH_W / 2, WALL_T], axis: 'x', m: 'AIR' },
  );
  return out;
}
// a brick ruin wall along x at z (a room's arcade side), arched openings every `bay` cells
function arcade(x0, x1, z, { y0 = F, top = 18, bay = 8, spring = 10 } = {}) {
  const out = [{ box: [[x0, y0, z - 1], [x1, top, z + 1]], m: 'BEAM', only: ['AIR', 'SAND'] }];
  for (let x = x0 + bay / 2; x < x1; x += bay) {
    const w = bay - 2 * PILLAR_R;
    out.push({ box: [[x - w / 2, y0, z - 1], [x + w / 2, y0 + spring, z + 1]], m: 'AIR', only: 'BEAM' });
    out.push({ cyl: [[x, y0 + spring, z - 1], w / 2, 2], axis: 'z', m: 'AIR', only: 'BEAM' });
  }
  return out;
}
// a bay round a floor shaft at a unit's centre: walkways past the hole on both sides
const BAY_WALK = 4;
function bay(xc) {
  const hw = SHAFT_W / 2 + BAY_WALK;
  return room([xc - hw, F, MID - hw], [xc + hw, F + TUNNEL_H, MID + hw], { rough: ROUGH_WALL });
}
// a chimney: open from a tunnel up to the ceiling at a unit's centre, so a shaft from above lands in it
const CHIMNEY_W = SHAFT_W + 4;
const chimney = (xc, y0 = F) => ({ box: [[xc - CHIMNEY_W / 2, y0, MID - CHIMNEY_W / 2], [xc + CHIMNEY_W / 2, TOP, MID + CHIMNEY_W / 2]], m: 'AIR', rough: ROUGH_WALL });
const rubble = (x, z, r, y = F) => ({ ball: [[x, y, z], [r, r * 0.55, r]], m: 'RUBBLE', only: ['AIR', 'SAND'], rough: 0.6 });

const tiles = [
  // ---- the universal tile: a frozen brick hall of two storeys, a brick balcony all
  // round at the gallery level, stairs up both long sides, icicles from its vault.
  // It takes any colour on any port.
  {
    name: 'frozen hall', weight: 0.6,
    ports: { W: 'DH-R', E: 'DH-R', N0: 'DH-R', N1: 'DH-R', S0: 'DH-R', S1: 'DH-R', D0: 'S-', D1: 'S-', U0: 'S-', U1: 'S-' },
    prims: [
      ...room([IN[0], F, INZ[0]], [IN[1], TOP, INZ[1]], { rough: ROUGH_WALL, lined: false }),
      deck(IN[0], IN[1], INZ[0], INZ[0] + 5), deck(IN[0], IN[1], INZ[1] - 5, INZ[1]),
      deck(IN[0], IN[0] + 5, INZ[0], INZ[1]), deck(IN[1] - 5, IN[1], INZ[0], INZ[1]),
      ...[8, 16, 24, 32, 40].flatMap((x) => [pillar(x + 0.5, INZ[0] + 4.5, DECK - F, F, 0.9), pillar(x + 0.5, INZ[1] - 4.5, DECK - F, F, 0.9)]),
      { stairs: [[18, F, INZ[0] + 5], [18 + HF - F, HF, INZ[0] + 8]], m: 'BEAM', axis: 'x', rise: -1 },
      { stairs: [[30 - (HF - F), F, INZ[1] - 8], [30, HF, INZ[1] - 5]], m: 'BEAM', axis: 'x', rise: 1 },
      // snow blown onto the balcony's open edge, icicles off its lip and from the vault
      { box: [[IN[0], HF, INZ[0]], [IN[1], HF + SNOW_T, INZ[0] + 2]], m: 'SAND', only: 'AIR' },
      ...icicleRow(10, 40, DECK, [INZ[0] + 5, INZ[1] - 5], 1.5, 11),
      ...icicleRow(10, 40, TOP, [MID - 3, MID + 3], 3, 12),
      crystal([C0, TOP, MID - 6]), crystal([C1, TOP, MID + 6]),
      drift(24, MID, 4),
    ],
    sites: [{ kind: 'loot', at: [24, HF, INZ[0] + 2] }],
  },
  // ---- ice tunnel: the common piece, side doors where it may open
  {
    name: 'ice tunnel', weight: 3,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D' },
    prims: [...tunnelX(IN[0], IN[1], { phase: 0.4, seed: 2 }), drift(C0 - 8, GAL_Z[0], 3), crystal([C1 + 4, F + TUNNEL_H, GAL_Z[1]])],
  },
  // ---- a long drift tunnel: the snow banks up against one wall the whole way
  {
    name: 'drift tunnel', weight: 2,
    ports: { W: 'D-', E: 'D-', N0: '-D', S1: '-D' },
    prims: [
      ...tunnelX(IN[0], IN[1], { phase: 2.4, seed: 3, zr: [GAL_Z[0] - 2, GAL_Z[1]] }),
      drift(14, GAL_Z[0] - 2, 6, 2.5), drift(32, GAL_Z[0] - 1, 7, 2.5), drift(40, GAL_Z[1], 4, 2),
      crystal([24, F + TUNNEL_H, GAL_Z[0]]),
    ],
  },
  // ---- ice crossroads: tunnels along x and along z through unit 0, a bay round unit 1's floor
  {
    name: 'ice crossroads', weight: 1.4,
    ports: { W: 'D-', E: 'D-', N0: 'D-', S0: 'D-', N1: '-D', S1: '-D', D1: '-S' },
    prims: [
      ...tunnelX(IN[0], IN[1], { phase: 4.0, seed: 4, wave: 1 }), ...tunnelZ(INZ[0], INZ[1], C0), ...bay(C1),
      stalagmite([C1 + 8, F, MID - 7], 3), icicle([C0 + 4, F + TUNNEL_H, MID + 5], 3), crystal([C1 - 9, F + TUNNEL_H, MID + 8]),
    ],
  },
  // ---- the ice bridge: a chasm the tile's length, crossed at the high floor by a
  // bridge of ice between two cliffs; the chasm's floor is a frozen pond, and brick
  // stairs climb from it to the west cliff. You see the far side as you cross.
  {
    name: 'ice bridge', weight: 1.3,
    ports: { W: 'H', E: 'H', N0: '-D', N1: '-D', S0: '-', S1: '-D', D1: '-S', U0: '-S', U1: '-S' },
    prims: [
      { box: [[IN[0] - 1, F - 1, INZ[0] - 1], [IN[1] + 1, TOP + 1, INZ[1] + 1]], m: 'ICE', only: 'ROCK', rough: ROUGH_LINING },
      { box: [[IN[0], F, INZ[0]], [IN[1], TOP, INZ[1]]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[IN[0], F - 1, INZ[0]], [IN[1], F, INZ[1]]], m: 'ROCK' },
      // the cliffs, ice-faced
      { box: [[IN[0], F, INZ[0]], [8, HF, INZ[1]]], m: 'ROCK', rough: 1 },
      { box: [[40, F, INZ[0]], [IN[1], HF, INZ[1]]], m: 'ROCK', rough: 1 },
      { box: [[IN[0], F, INZ[0]], [8, HF, INZ[1]]], m: 'ROCK' },
      { box: [[40, F, INZ[0]], [IN[1], HF, INZ[1]]], m: 'ROCK' },
      { box: [[8, F, INZ[0]], [9, HF - 1, INZ[1]]], m: 'ICE', only: 'AIR', rough: 1 },
      { box: [[39, F, INZ[0]], [40, HF - 1, INZ[1]]], m: 'ICE', only: 'AIR', rough: 1 },
      // the bridge: a slab of ice at the high floor, sagging beneath, hung with icicles
      { box: [[7, DECK - 1, MID - 3], [41, HF, MID + 3]], m: 'ICE' },
      { ball: [[24, DECK - 1, MID], [15, 3, 2.5]], m: 'ICE', only: 'AIR' },
      ...icicleRow(10, 38, DECK - 2, [MID - 2, MID + 2], 3, 21),
      // the pond, frozen flush with the chasm's snow
      { box: [[14, F, 6], [34, F + SNOW_T, 18]], m: 'ICE' },
      { box: [[9, F, INZ[0]], [39, F + SNOW_T, INZ[1]]], m: 'SAND', only: 'AIR' },
      drift(36, INZ[0] + 2, 4, 3), drift(12, INZ[1] - 2, 3, 2),
      // brick stairs from the chasm floor to the west cliff, along its south wall
      { stairs: [[8, F, INZ[1] - 4], [8 + HF - F + 1, HF, INZ[1]]], m: 'BEAM', axis: 'x', rise: -1 },
      { box: [[8, F, INZ[1] - 4], [8 + HF - F + 1, F + SNOW_T, INZ[1]]], m: 'BEAM' },
      crystal([IN[0] + 1, 18, 5]), crystal([IN[1] - 1, 17, 19]), crystal([24, F + 1, INZ[0]], 1.8),
    ],
    sites: [{ kind: 'loot', at: [24, F + SNOW_T, 15] }],
  },
  // ---- the frozen waterfall: a shaft down through unit 0 with a fall of ice
  // down its north wall into a frozen plunge pool, ice ledges round it, the tunnel past it
  {
    name: 'frozen waterfall', weight: 1.4,
    ports: { W: 'D-', E: 'D-', S1: '-D', D0: 'S', U0: 'S-' },
    prims: [
      ...tunnelX(IN[0], IN[1], { phase: 2.6, lift: 0, seed: 6 }),
      { box: [[C0 - 8, F, MID - 8], [C0 + 8, TOP, MID + 8]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[C0 - 8, F - 1, MID - 8], [C0 + 8, F, MID + 8]], m: 'ROCK' },
      // the fall: a sheet of ice from the roof to the floor, bulging, fluted
      { box: [[C0 - 5, F, MID - 9], [C0 + 5, TOP, MID - 6]], m: 'ICE', rough: 1.5 },
      ...[-3, 0, 3].map((dx) => ({ capsule: [[C0 + dx, TOP, MID - 6], [C0 + dx * 1.3, F, MID - 5], 1.2], m: 'ICE', only: 'AIR' })),
      { ball: [[C0, F, MID - 5], [7, 1.5, 2.5]], m: 'ICE', only: ['AIR', 'SAND'] },
      // ledges stepping round the other walls (out of the drop's line)
      { box: [[C0 + 4, 9, MID - 2], [C0 + 8, 10, MID + 8]], m: 'ICE' },
      { box: [[C0 - 8, 15, MID + 3], [C0, 16, MID + 8]], m: 'ICE' },
      { box: [[C0 + 4, 10, MID - 2], [C0 + 8, 10 + SNOW_T, MID + 8]], m: 'SAND', only: 'AIR' },
      ...icicleRow(C0 + 4, C0 + 8, 9, [MID + 2, MID + 6], 2, 61),
      crystal([C0 + 8, 18, MID - 7]), crystal([C0 - 8, 6, MID + 7]),
    ],
  },
  // ---- the ruin: two brick walls across an ice tunnel, arched doorways through
  // them, a broken pillar between, brick rubble and snow where the roof came in
  {
    name: 'brick ruin', weight: 1.6,
    ports: { W: 'D-', E: 'D-', N0: '-D', S1: '-D' },
    prims: [
      ...tunnelX(IN[0], IN[1], { phase: 1.5, seed: 7, wave: 1, lift: 0, zr: [GAL_Z[0] - 2, GAL_Z[1] + 2], h: TUNNEL_H + 2 }),
      ...ruinWall(17, MID), ...ruinWall(31, MID + 1),
      // a breach in the second wall's top
      { ball: [[32, TOP - 3, MID - 4], [3, 4, 3]], m: 'AIR', only: 'BEAM' },
      pillar(24, MID - 4, 7), pillar(24, MID + 5, 3),
      rubble(26, MID + 3, 3), rubble(34, MID - 4, 2.5), drift(10, GAL_Z[1] + 1, 4, 2),
      crystal([24, F + TUNNEL_H + 2, MID]),
    ],
    sites: [{ kind: 'loot', at: [24, F + SNOW_T, MID] }],
  },
  // ---- the collapsed cathedral: a brick nave under a vault of ribs, an arcade each
  // side, a gallery along the north wall reached by stairs, ribs fallen across the
  // floor, an ice rose window lit from behind; the roof is open to the layer above.
  {
    name: 'collapsed cathedral', weight: 0.7,
    ports: { W: 'D-', E: 'D-', N0: 'H-', N1: '-', S0: '-D', S1: '-D', U0: '-S', U1: '-S' },
    prims: [
      { box: [[4, F, INZ[0]], [44, TOP, INZ[1]]], m: 'AIR', rough: 1 },
      { ball: [[24, 10, MID], [22, 13, 11]], m: 'AIR', rough: ROUGH_ROOM },
      { box: [[4, F - 1, INZ[0]], [44, F, INZ[1]]], m: 'BEAM' },          // the paving
      ...stub('W'), ...stub('E'),
      // the vault's ribs: brick rings across the nave, hollowed (before the arcades)
      ...[16, 24, 32, 40].flatMap((x) => [
        { cyl: [[x, 7, MID], 13, 1], axis: 'x', m: 'BEAM', only: 'AIR' },
        { cyl: [[x, 7, MID], 12, 1], axis: 'x', m: 'AIR', only: 'BEAM' },
      ]),
      { box: [[4, F, INZ[0]], [44, 14, INZ[1]]], m: 'AIR', only: 'BEAM' },   // ribs spring from the arcades, not the floor...
      { box: [[4, HF, INZ[0]], [44, TOP, 6]], m: 'AIR', only: 'BEAM' },      // ...nor over the gallery
      { box: [[4, F - 1, INZ[0]], [44, F, INZ[1]]], m: 'BEAM' },
      // two ribs fell: one broken at its crown, one lying across the nave
      { ball: [[32, 19, MID + 2], [2, 4, 5]], m: 'AIR', only: 'BEAM' },
      { box: [[23, 13, INZ[0]], [26, TOP, INZ[1]]], m: 'AIR', only: 'BEAM' },
      { capsule: [[20, F + 1, 9], [27, F + 1, 16], 1], m: 'BEAM' },
      // the arcades: pillars and arches each side of the nave
      ...arcade(4, 44, 7, { top: 17, spring: 10 }), ...arcade(4, 44, 17, { top: 17, spring: 10 }),
      { box: [[36, 12, 16], [44, 17, 18]], m: 'AIR', only: 'BEAM' },        // a fallen stretch
      // the gallery over the north aisle, and its stairs (high at the west end)
      deck(IN[0], 28, INZ[0], 6),
      { stairs: [[28, F, INZ[0]], [28 + HF - F, HF, 6]], m: 'BEAM', axis: 'x', rise: -1 },
      // brick rubble, snow fallen through the roof
      rubble(30, 12, 4), rubble(38, 15, 3), rubble(10, 19, 2.5),
      drift(26, 12, 5, 3), { box: [[4, F, 8], [44, F + SNOW_T, 16]], m: 'SAND', only: 'AIR' },
      // the rose window: a disc of ice in the east wall, a crystal behind it
      { cyl: [[44, 14, MID], 4, 2], axis: 'x', m: 'ICE', only: 'ROCK' },
      crystal([45.5, 14, MID], 1.2),
      crystal([6, 20, MID]), crystal([24, TOP, MID], 1.8),
      ...icicleRow(6, 42, TOP - 1, [MID - 4, MID + 4], 4, 81),
    ],
    sites: [{ kind: 'loot', at: [10, HF, 4] }, { kind: 'wand', at: [40, F + SNOW_T, MID] }],
  },
  // ---- the frozen pond: a low cave room, the pond iced flush with its snow, an ice column in it
  {
    name: 'frozen pond', weight: 1.2,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D0: '-S' },
    prims: [
      ...room([4, F, 4], [44, 15, 20]), ...stub('W'), ...stub('E'),
      { ball: [[28, F, 12], [11, 1, 6]], m: 'ICE', only: ['AIR', 'SAND', 'ROCK'] },
      { box: [[17, F - 1, 6], [39, F, 18]], m: 'ICE' },
      { cyl: [[34, F, 12], 1.6, 13], axis: 'y', m: 'ICE', rough: 0.6 },
      { ball: [[34, 15, 12], [3, 3, 3]], m: 'ICE', only: ['AIR', 'ROCK'] },
      drift(8, 6, 4, 2.5), drift(42, 18, 4, 2.5),
      ...icicleRow(6, 42, 15, [8, 16], 3, 91),
      crystal([6, 14, 18]), crystal([44, 12, 5]),
    ],
  },
  // ---- the icicle hall: a tall cave, a forest of icicles and stalagmites, shafts in its roof
  {
    name: 'icicle hall', weight: 1.1,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', U0: '-S', U1: '-S' },
    prims: [
      ...room([4, F, 4], [44, 12, 20]), { ball: [[24, 12, 12], [21, 10, 9]], m: 'AIR', rough: ROUGH_CAVE }, chimney(C0), chimney(C1),
      { box: [[4, F - 1, 4], [44, F, 20]], m: 'ROCK' }, { box: [[3, F, 3], [45, F + SNOW_T, 21]], m: 'SAND', only: 'AIR' },
      ...stub('W'), ...stub('E'),
      ...icicleRow(8, 40, TOP - 1, [6, 9, 15, 18], ICICLE_LEN_HALL, 101),
      ...icicleRow(18, 30, TOP, [MID], ICICLE_LEN_HALL + 2, 102),
      stalagmite([17, F, 7], 4), stalagmite([31, F, 17], 5), stalagmite([40, F, 8], 3), stalagmite([8, F, 16], 3),
      crystal([5, 9, 5]), crystal([43, 15, 19]), crystal([24, TOP, 4], 1.8),
    ],
  },
  // ---- a ruined stair: brick steps climb a storey through a broken stairwell, low at W, high at E
  {
    name: 'ruined stair', weight: 1,
    ports: { W: 'D', E: 'H', N0: '-D', N1: '-', S0: '-', S1: '-' },
    prims: [
      { box: [[IN[0] - 1, F - 1, GAL_Z[0] - 2], [IN[1] + 1, HIGH_TOP + 2, GAL_Z[1] + 2]], m: 'ICE', only: 'ROCK', rough: ROUGH_LINING },
      { box: [[IN[0], F, GAL_Z[0] - 1], [IN[1], HIGH_TOP + 1, GAL_Z[1] + 1]], m: 'AIR', rough: ROUGH_WALL },
      { stairs: [[10, F, GAL_Z[0] - 1], [10 + 2 * (HF - F), HF, GAL_Z[1] + 1]], m: 'BEAM', axis: 'x', rise: 1 },
      { box: [[10 + 2 * (HF - F), F, GAL_Z[0] - 1], [IN[1], HF, GAL_Z[1] + 1]], m: 'BEAM' },
      { box: [[IN[0], F - 1, GAL_Z[0] - 1], [10, F, GAL_Z[1] + 1]], m: 'ROCK' },
      { box: [[IN[0], F, GAL_Z[0] - 1], [10, F + SNOW_T, GAL_Z[1] + 1]], m: 'SAND', only: 'AIR' },
      // arches over the flight, one fallen
      ...ruinWall(16, MID, { y0: F + 3 }).map((p) => ({ ...p, only: p.m === 'AIR' ? undefined : ['AIR', 'SAND'] })),
      ...ruinWall(28, MID, { y0: F + 9 }).map((p) => ({ ...p, only: p.m === 'AIR' ? undefined : ['AIR', 'SAND'] })),
      rubble(6, GAL_Z[1], 2.5), { capsule: [[38, HF + 1, GAL_Z[0]], [44, HF + 1, GAL_Z[0] + 2], 0.9], m: 'BEAM' },
      crystal([22, HIGH_TOP, MID]),
    ],
  },
  // ---- two storeys: a brick gallery over an ice tunnel, a stairwell between; either end high or low
  {
    name: 'two storeys', weight: 1.1,
    ports: { W: 'DH-', E: 'HD-', S0: '-D', N1: '-H' },
    prims: [
      ...tunnelX(IN[0], IN[1], { wave: 0, lift: 0, h: DOOR_H + 1, icicles: 0, seed: 12 }),
      { box: [[IN[0], HF, GAL_Z[0]], [IN[1], HIGH_TOP, GAL_Z[1]]], m: 'AIR', rough: ROUGH_WALL },
      deck(IN[0], IN[1], GAL_Z[0], GAL_Z[1]),
      ...[8, 18, 30, 40].map((x) => ({ box: [[x, HF, GAL_Z[0]], [x + 1, HIGH_TOP, GAL_Z[0] + 1]], m: 'BEAM' })),
      ...[8, 18, 30, 40].map((x) => ({ box: [[x, HF, GAL_Z[1] - 1], [x + 1, HIGH_TOP, GAL_Z[1]]], m: 'BEAM' })),
      // the stairwell, beside the galleries
      ...room([16, F, INZ[0]], [34, HIGH_TOP, GAL_Z[0]], { rough: ROUGH_WALL }),
      { stairs: [[16, F, INZ[0]], [16 + HF - F + 2, HF, GAL_Z[0]]], m: 'BEAM', axis: 'x', rise: -1 },
      ...icicleRow(10, 40, DECK, [GAL_Z[0] + 2, GAL_Z[1] - 2], 1.5, 121),
      crystal([30, HIGH_TOP, INZ[0] + 2]), crystal([6, F + DOOR_H, GAL_Z[1]]),
    ],
  },
  // ---- a snowed-in room: the roof came down on a brick room and the snow came with it
  {
    name: 'snowed-in room', weight: 1.2,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D1: '-S' },
    prims: [
      ...room([4, F, 4], [44, 16, 20], { lined: false }),
      ...stub('W'), ...stub('E'),
      // what's left of its brick walls
      { box: [[4, F, 4], [44, 9, 5]], m: 'BEAM' }, { box: [[4, F, 19], [22, 7, 20]], m: 'BEAM' },
      { box: [[10, F, 4], [16, 9, 5]], m: 'AIR', only: 'BEAM' },
      drift(14, 9, 5), drift(30, 15, 6, 4), drift(40, 7, 3),
      { ball: [[22, 17, 12], [7, 3, 5]], m: 'SAND', only: 'ROCK', rough: 1 },     // more snow in the roof: dig, and it falls
      rubble(24, 6, 3), { capsule: [[8, F, 6], [16, 11, 9], 0.9], m: 'BEAM' },
      crystal([40, 14, 18]),
    ],
    sites: [{ kind: 'loot', at: [24, F + SNOW_T, 10] }],
  },
  // ---- the ice chimney: a tunnel with chimneys up both units: shafts from above land here
  {
    name: 'ice chimney', weight: 1.3,
    ports: { W: 'D-', E: 'D-', N0: '-D', S1: '-D', D0: 'S-', D1: '-S', U0: 'S-', U1: '-S' },
    prims: [
      ...tunnelX(IN[0], IN[1], { phase: 2.1, lift: 0, seed: 14 }), chimney(C0), chimney(C1),
      { box: [[C0 - 5, 14, MID - 5], [C0 - 2, 15, MID + 5]], m: 'ICE' },
      ...icicleRow(C1 + 6, C1 + 9, TOP, [MID - 3, MID + 3], 5, 141),
      drift(C1 + 7, MID, 3),
      crystal([C0 + 5, 18, MID + 5]),
    ],
  },
  // ---- thin ice: a room whose floor gives way into the layer below in both units
  {
    name: 'thin ice', weight: 0.8,
    ports: { W: 'D-', E: '-D', N1: '-D', D0: 'S-', D1: 'S-', U1: '-S' },
    prims: [
      ...room([IN[0], F, 6], [IN[1], 15, 18]), chimney(C1), ...stub('W'), ...stub('E'),
      { box: [[20, F, 6], [28, F + 1, 18]], m: 'ICE' },          // a sheet of ice between the holes
      drift(24, 7, 3, 1.5),
      ...icicleRow(6, 42, 15, [8, 16], 3, 151),
      crystal([IN[0] + 1, 12, 7]),
    ],
  },
  // ---- the great ice cavern: a natural vault, a frozen lake, ice columns, crystals, a brick scaffold
  {
    name: 'great ice cavern', weight: 0.7,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D0: '-S', D1: '-S', U0: '-S', U1: '-S' },
    prims: [
      { ball: [[24, 12, 12], [26, 15, 14]], m: 'ICE', only: 'ROCK', rough: ROUGH_CAVE },
      { ball: [[24, 12, 12], [24, 13, 12]], m: 'AIR', rough: ROUGH_CAVE },
      ...room([3, F, 3], [45, 10, 21], { lined: false }),
      ...stub('W'), ...stub('E'),
      { box: [[26, F - 1, 15], [42, F + SNOW_T, 20]], m: 'ICE' },
      { cyl: [[30, F, 18], 1.5, 20], axis: 'y', m: 'ICE', rough: 0.6 }, { cyl: [[8, F, 6], 1.2, 20], axis: 'y', m: 'ICE', rough: 0.6 },
      { ramp: [[4, F, 3], [16, 10, 8]], m: 'ROCK', axis: 'x', rise: -1 },
      { box: [[4, 10, 3], [10, 10 + SNOW_T, 8]], m: 'SAND', only: 'AIR' },
      crystal([6, 18, 12], 2), crystal([42, 16, 6], 1.8), crystal([24, 22, 12], 2),
      ...icicleRow(10, 40, 22, [8, 12, 16], ICICLE_LEN_HALL, 161),
      drift(18, 16, 4),
      { box: [[32, 15, 4], [44, 16, 9]], m: 'BEAM' },
    ],
    sites: [{ kind: 'loot', at: [8, 10 + SNOW_T, 5] }],
  },
  // ---- the warm nook (hidden): one way in, a crooked crawl, a brick-lined room with a
  // hearth stocked with coal and firewood (light it), gold, and no snow or ice at all
  {
    name: 'warm nook', weight: 1.6,
    ports: { E: 'D', W: '-', N0: '-', N1: '-', S0: '-', S1: '-' },
    prims: [
      ...tunnelX(32, IN[1], { icicles: 1, seed: 17, wave: 0, lift: 0 }),
      { capsule: [[33, F + 3, MID], [22, F + 3, MID - 6], 3.2], m: 'AIR', rough: 0.8 },
      { box: [[7, F - 1, 2], [25, 13, 14]], m: 'BEAM', only: ['ROCK', 'ICE'] },     // the brick lining
      { box: [[8, F, 3], [24, 12, 13]], m: 'AIR' },
      { box: [[20, F - 1, 4], [32, F, 12]], m: 'ROCK' },
      { capsule: [[22, F + 3, MID - 6], [26, F + 3, MID - 5], 3], m: 'AIR' },       // the crawl breaks through the brick
      // the hearth against the west wall: a brick firebox, coal in it, firewood stacked by it
      { box: [[8, F, 5], [11, 9, 11]], m: 'BEAM' },
      { box: [[8, F + 1, 6], [10, F + 4, 10]], m: 'AIR' },
      { box: [[8, F + 1, 6], [10, F + 2, 10]], m: 'COAL' },
      { box: [[12, F, 11], [16, F + 3, 13]], m: 'MOSS' },
      { box: [[18, F, 3], [22, F + 2, 6]], m: 'GOLD' },
      crystal([23, 11, 12], 1.1),
    ],
    sites: [{ kind: 'treasure', at: [20, F + 2, 4] }, { kind: 'wand', at: [16, F, 8] }],
  },
  // ---- a frozen cache: a side cave, a chest's worth of gold frozen into a block of ice
  {
    name: 'frozen cache', weight: 1.3,
    ports: { S1: 'D', W: '-', E: '-', N0: '-', N1: '-', S0: '-' },
    prims: [
      ...room([10, F, 4], [42, 12, 15]),
      { box: [[14, F, 5], [20, F + 5, 9]], m: 'ICE' },
      { box: [[16, F + 1, 6], [18, F + 3, 8]], m: 'GOLD' },
      stalagmite([26, F, 6], 3), drift(38, 6, 4, 2.5),
      ...icicleRow(12, 40, 12, [7, 11], 2.5, 181),
      crystal([28, 12, 5]),
    ],
    sites: [{ kind: 'loot', at: [26, F + SNOW_T, 11] }, { kind: 'gold', at: [17, F + 1, 7] }],
  },
  // ---- the hermit's cell: a brick room off the tunnel, up two steps, a bed of brick and a lamp of crystal
  {
    name: 'hermit cell', weight: 1,
    ports: { W: 'D-', E: 'D-', S0: '-D', S1: '-D' },
    prims: [
      ...tunnelX(IN[0], IN[1], { phase: 0.9, lift: 0, seed: 19 }),
      { box: [[17, F + 2 - 1, INZ[0]], [39, 15, GAL_Z[0] + 1]], m: 'BEAM', only: ['ROCK', 'ICE'] },
      { box: [[18, F + 2, INZ[0]], [38, 14, GAL_Z[0]]], m: 'AIR' },
      { stairs: [[22, F, GAL_Z[0] - 2], [28, F + 2, GAL_Z[0] + 1]], m: 'BEAM', axis: 'z', rise: -1 },
      { box: [[22, F + 2, GAL_Z[0]], [28, 12, GAL_Z[0] + 1]], m: 'AIR' },
      { box: [[30, F + 2, INZ[0]], [36, F + 4, INZ[0] + 3]], m: 'BEAM' },
      { box: [[18, F + 2, INZ[0]], [38, F + 2 + SNOW_T, INZ[0] + 1]], m: 'SAND', only: 'AIR' },
      crystal([20, 14, INZ[0] + 1], 1.1),
    ],
    sites: [{ kind: 'loot', at: [33, F + 4, INZ[0] + 1] }],
  },
];

export default {
  name: 'snow',
  // Noita's Snowy Depths: dark stone with ice through it, snow on every floor,
  // brick ruins, crystal's cold light
  palette: {
    ROCK: 'ROCK', SOFT: 'SNOW', BEAM: 'BRICK', RAIL: 'METAL', RUBBLE: 'RUBBLE', SAND: 'SNOW',
    ICE: 'ICE', CRYSTAL: 'CRYSTAL', COAL: 'COAL', MOSS: 'WOOD', GRAVEL: 'STONE',
  },
  tiles,
};
