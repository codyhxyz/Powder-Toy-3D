import { E } from '../elements.js';
import { runGenerator, makeRng } from '../constructions/runtime.js';
import { BUILTINS, SHRINE_ALTARS } from '../constructions/builtins.js';

// Dam Valley: a handmade Big Team Battle map (docs/arenas.md).
//
// A long valley along x: the red base on a plateau at the low-x end, the blue
// base on one at the high-x end, mirror images of each other. Across the
// middle runs a river canyon, dammed: a reservoir to the north (high z) held
// back by a concrete dam whose crest is the exposed way across, a maintenance
// tunnel through the dam (close quarters, with a pump room in the middle), and
// a dry spillway basin under the dam's downstream face (the low way across).
// Rock ridges run the length of both long sides for jetpackers, and a forest
// grows on the slopes between each base and the dam, on a grass floor that
// burns. Four perk shrines stand on contested ground: the dam's crest, the
// pump room, and the middle of each ridge.
//
// The dam's body is indestructible masonry, but the pump room's back wall is
// a wooden sluice gate with the reservoir behind it and two powder kegs beside
// it: blow the gate and the reservoir floods the tunnel, pours out of both
// portals into the forests and fills the spillway basin. The bases sit 10
// cells above the valley floor, out of the flood's reach.
//
// Everything is built in code, from existing elements, at a fixed grid size
// (ARENA_SIZE); the round modes rebuild it from scratch between rounds. All
// randomness (the noise, the forest) is seeded, so every rebuild is the same.
//
// Coordinates are grid cells: x along the valley (red at 0), y up, z across it
// (south ridge at 0, the reservoir and the north ridge at the far side). A
// height h means the ground fills y < h, so h is also where feet stand.

export const ARENA_SIZE = [256, 96, 128];
const [NX, NY, NZ] = ARENA_SIZE;
const MID_X = NX / 2;                // the mirror plane between the halves
const SEED = 0xda11e7;               // the map's one seed: noise and forest

// ---- heights (the top of the ground, cells)
const BEDROCK_Y = 2;                 // solid rock everywhere below this
const FLOOR_Y = 12;                  // the valley floor
const BASE_Y = 22;                   // the base plateaus: 10 above the floor, out of the flood's reach
const CREST_Y = 34;                  // the dam's crest and the abutments' tops
const WATER_Y = 31;                  // the reservoir's surface (water fills y < WATER_Y)
const LAKE_BED_Y = 4;                // the reservoir's floor
const BASIN_Y = 6;                   // the spillway basin's floor
const RIDGE_Y = 46;                  // the ridges' tops

// ---- the ground's shape (x is the red half's: the blue half mirrors it)
const BASE_X1 = 40;                  // the plateau's flat top runs x < BASE_X1...
const BASE_GRADE = 0.5;              // ...and slopes down to the floor at this rise per cell (a ramp a jeep takes)
const RIDGE_W = 14;                  // cells from the box's long side the ridge's flat top reaches
const RIDGE_GRADE = 2.8;             // rise per cell of the ridges' inner faces (too steep to walk: jetpack)
const ABUT_X0 = 80;                  // the dam's abutments: a plateau at the crest's height from here to the middle...
const ABUT_GRADE = 0.8;              // ...falling off at this grade (walkable: under one cell of rise per cell)
const LAKE_X0 = 100;                 // the reservoir and dam span x in [LAKE_X0, NX - LAKE_X0)
const DAM_Z0 = 52, DAM_Z1 = 68;      // the dam's footprint across the valley (z)
const LAKE_Z1 = 104;                 // the reservoir runs from the dam's back to here
const LAKE_BANK = 1.6;               // fall per cell of the reservoir's bed away from its shore
const LAKE_CORNER = 16;              // cells: the radius its far corners are rounded to
const SHORE_NOISE = 3;               // cells its shoreline wanders in by
const BASIN_X0 = 108;                // the spillway basin's flat floor spans x in [BASIN_X0, NX - BASIN_X0)...
const BASIN_Z0 = 30;                 // ...and z in [BASIN_Z0, DAM_Z0)
const BASIN_BANK = 0.8;              // rise per cell of the basin's banks (walkable)
const NOISE_CELL = 12;               // cells per lattice step of the ground's value noise
const FLOOR_NOISE = 1.6;             // cells of rise and fall on the valley floor and slopes
const RIDGE_NOISE = 5;               // cells of rise and fall on the ridges' faces
const RIDGE_TOP_NOISE = 1.2;         // ...and on their tops

// ---- the dam
const PARAPET_H = 2;                 // cells of wall along both edges of the crest (cover on the exposed way)
const PARAPET_GAP = 10;              // a gap in the parapets every this many cells...
const PARAPET_GAP_W = 2;             // ...this wide (to drop off or climb on)
const TUN_Y = 14;                    // the tunnel's floor
const TUN_H = 9;                     // its headroom (the body is 5.5)
const TUN_Z0 = 57, TUN_Z1 = 63;      // its width across the dam
const TUN_PORTAL_COVER = 3;          // cells of rock a portal needs over its roof (open cut where there's less)
const ROOM_X0 = 114;                 // the pump room spans x in [ROOM_X0, NX - ROOM_X0)...
const ROOM_Z0 = 54, ROOM_Z1 = 66;    // ...z in [ROOM_Z0, ROOM_Z1)...
const ROOM_H = 14;                   // ...and this tall (the shrine's roof is 12 up)
const GATE_X0 = 120;                 // the sluice gate spans x in [GATE_X0, NX - GATE_X0) of the room's back wall
const GATE_H = 10;                   // ...this high from the room's floor
const WINDOW_EVERY = 12;             // a window slit through the dam's face onto the tunnel every this many cells
const WINDOW_W = 3, WINDOW_Y0 = 4, WINDOW_H = 3;   // a slit's width, its sill above the tunnel floor, its height
const ROOM_WINDOW_Y0 = 3, ROOM_WINDOW_H = 7;       // the pump room's window band onto the basin
const KEG_SIZE = 2;                  // construction size of the powder kegs by the gate
const KEG_X = 116, KEG_Z = 63;       // a keg's middle (red side; the other mirrors it), clear of the shrine

// ---- the bases (red's; blue's mirrors them)
const FORT_X0 = 4, FORT_X1 = 32;     // the fortress's outer walls span x in [FORT_X0, FORT_X1)...
const FORT_Z0 = 46, FORT_Z1 = 82;    // ...and z in [FORT_Z0, FORT_Z1)
const PLATEAU_Z0 = 26;               // the plateau is levelled and cleared across z in [PLATEAU_Z0, NZ - PLATEAU_Z0)
const FORT_WALL = 2;                 // wall thickness
const FORT_H = 12;                   // cells from the floor to the roof
const SPAWN_X1 = 16;                 // the spawn room is the back of the fortress, x < SPAWN_X1
const DOOR_H = 8;                    // doorways' height
const FRONT_DOOR_Z = [59, 69];       // the front doorway's span (z)
const SIDE_DOOR_X = [20, 28];        // the side doorways' span (x)
const INNER_DOOR_Z = [[52, 57], [71, 76]];   // the spawn room's two doorways into the hall (z)
const WIN_Y0 = 4, WIN_H = 3;         // window bands: sill above the floor, height
const MERLON_EVERY = 3;              // a merlon on the roof's edge every this many cells
const TOWER = 7;                     // the front corners' towers: this many cells square...
const TOWER_RISE = 7;                // ...rising this far over the roof, open on top behind merlons
const STAND_X = 26, STAND_Z = 64;    // the flag stand's middle
const STAND_R = 1;                   // its half-width (a 3×3 steel plinth, one cell high)
const PAD_H = 1;                     // vehicle pads are this thick (flush with the plateau)

// ---- the forest
const FOREST_X0 = 44, FOREST_X1 = 92;   // trees stand in x in [FOREST_X0, FOREST_X1) (red's)...
const FOREST_Z0 = 28, FOREST_Z1 = 100;  // ...and z in [FOREST_Z0, FOREST_Z1)
const TREE_GAP = 11;                 // cells between trunks at least
const TREE_TRIES = 400;              // candidate spots tried
const TREE_MAX = 16;                 // trees per side
const TREE_SIZE = [2, 4];            // construction sizes (T scales the tree) they're drawn from
const TREE_KINDS = ['oak', 'oak', 'birch', 'birch', 'pine'];   // (a pine's skirt of needles reaches the ground: a few)
const ROAD_Z = [30, 44];             // the open road along the south of the valley: no trees
const TRENCH_CLEAR = 6;              // cells either side of the tunnel's approach kept clear
const LAKE_CLEAR = 4;                // cells from the reservoir's water no leaf may reach

// ---- what the round modes and vehicles read (cells)
const SPAWN_ROWS = [8, 12];          // spawn points: two rows across the spawn room (x)...
const SPAWN_ZS = [54, 64, 74];       // ...three each (z)
const JEEP_AT = [20, 36];            // a team's jeep pad (x, z: south of the fortress)...
const BIKE_AT = [[14, 92], [26, 92]];   // ...and hoverbike pads (north of it)
const JEEP_PAD = [9, 5];             // pad half-extents (x, z)
const BIKE_PAD = [4, 4];
const HILL_R = 9;                    // KOTH zones' radius
const CORE_R = 8;                    // siege: the core room's radius
const SHRINE_LIFT = 1;               // a shrine's floor is a slab one cell up: feet stand on it

// ---------------------------------------------------------------- noise

const hash = (ix, iz, k) => {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(k, 0x9e3779b9) ^ SEED;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t) => t * t * (3 - 2 * t);
// smooth value noise in [-1, 1]
function noise(x, z, k) {
  const fx = x / NOISE_CELL, fz = z / NOISE_CELL;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = smooth(fx - ix), tz = smooth(fz - iz);
  const a = hash(ix, iz, k), b = hash(ix + 1, iz, k), c = hash(ix, iz + 1, k), d = hash(ix + 1, iz + 1, k);
  return 2 * (a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz) - 1;
}

// ---------------------------------------------------------------- the ground

const mirror = (x) => (x < MID_X ? x : NX - 1 - x);
// distance from (x, z) to a rectangle [x0, x1) × [z0, z1) (0 inside)
const rectDist = (x, z, x0, x1, z0, z1) => Math.hypot(Math.max(x0 - x, 0, x - (x1 - 1)), Math.max(z0 - z, 0, z - (z1 - 1)));
// a flat-topped hill over a rectangle, falling off at `grade`
const hill = (x, z, x0, x1, z0, z1, top, grade) => top - grade * rectDist(x, z, x0, x1, z0, z1);

const inLake = (x, z) => x >= LAKE_X0 && x < NX - LAKE_X0 && z >= DAM_Z1 && z < LAKE_Z1;

// The ground's height at column (x, z), before anything is built on it.
export function groundAt(x, z) {
  const xr = mirror(x);
  const n = noise(xr, z, 1);
  // the valley floor, gently rolling
  let h = FLOOR_Y + FLOOR_NOISE * n;
  // the base plateau
  h = Math.max(h, hill(xr, z, 0, BASE_X1, 0, NZ, BASE_Y, BASE_GRADE));
  // the ridges along both long sides: rough faces, flat-ish tops
  const dz = Math.min(z, NZ - 1 - z);
  const face = Math.max(0, dz - RIDGE_W);
  const ridge = RIDGE_Y - RIDGE_GRADE * face + (face > 0 ? RIDGE_NOISE * noise(xr, z, 2) : RIDGE_TOP_NOISE * noise(xr, z, 3));
  h = Math.max(h, Math.min(RIDGE_Y + RIDGE_TOP_NOISE, ridge));
  // the abutments and the rim round the reservoir: one plateau at the crest's height
  h = Math.max(h, hill(xr, z, ABUT_X0, MID_X, DAM_Z0, NZ, CREST_Y, ABUT_GRADE) + (xr < ABUT_X0 ? FLOOR_NOISE * n : 0));
  // the reservoir's bed, banked up from the middle (the dam closes its south side)
  if (inLake(x, z)) {
    // cells from the shore (the dam's side has none), round in the far corners, wandering
    const dx = xr - LAKE_X0, dz = LAKE_Z1 - 1 - z;
    let d = Math.min(dx, dz);
    if (dx < LAKE_CORNER && dz < LAKE_CORNER) d = LAKE_CORNER - Math.hypot(LAKE_CORNER - dx, LAKE_CORNER - dz);
    d -= SHORE_NOISE * (1 + noise(xr, z, 4));
    h = Math.min(h, Math.max(LAKE_BED_Y, CREST_Y - LAKE_BANK * (d + 1)));
  }
  // the spillway basin under the dam (downstream only: upstream, the abutments hold the reservoir)
  if (z < DAM_Z0) h = Math.min(h, BASIN_Y + BASIN_BANK * rectDist(xr, z, BASIN_X0, MID_X, BASIN_Z0, DAM_Z0));
  return Math.max(BEDROCK_Y, Math.min(NY - 1, Math.round(h)));
}

// ---------------------------------------------------------------- layout

// The feet of a body standing on the ground at column (x, z).
const onGround = (x, z) => [x, groundAt(x, z), z];
const team = (x, side) => (side === 'red' ? x : NX - 1 - x);
const SHRINES = [
  [MID_X, CREST_Y, (DAM_Z0 + DAM_Z1) / 2],                // the dam's crest
  [MID_X, TUN_Y, (ROOM_Z0 + ROOM_Z1) / 2],                // the pump room
  [MID_X, RIDGE_Y, Math.floor(RIDGE_W / 2)],               // the south ridge
  [MID_X, RIDGE_Y, NZ - 1 - Math.floor(RIDGE_W / 2)],      // the north ridge
];
const SHRINE_HALF = [8, 5];          // the shrine's floor's half-extents (constructions/builtins.js shrine)
const SHRINE_HEIGHT = 12;            // cells from its floor to the top of its roof

// What the round modes and vehicles build against (grid cells; feet positions;
// yaw as the POV camera's: 0 faces -z, π/2 faces -x).
const FACE_BLUE = -Math.PI / 2, FACE_RED = Math.PI / 2;
const RED_FOREST = [68, 84], BLUE_FOREST = [NX - 1 - 68, 84];
export const DAM_VALLEY_LAYOUT = {
  name: 'Dam Valley',
  size: [...ARENA_SIZE],
  spawns: Object.fromEntries(['red', 'blue'].map((side) => [side,
    SPAWN_ROWS.flatMap((x) => SPAWN_ZS.map((z) => [team(x, side), BASE_Y, z]))])),
  flags: { red: [STAND_X, BASE_Y + PAD_H, STAND_Z], blue: [NX - 1 - STAND_X, BASE_Y + PAD_H, STAND_Z] },
  hills: [
    [MID_X, CREST_Y + SHRINE_LIFT, DAM_Z1 - 4, HILL_R],               // the crest, round the shrine
    [...onGround(...RED_FOREST), HILL_R],                            // red's forest
    [...onGround(...BLUE_FOREST), HILL_R],                           // blue's forest
    [MID_X, BASIN_Y, (BASIN_Z0 + DAM_Z0) / 2, HILL_R],               // the spillway basin
    [MID_X, TUN_Y + SHRINE_LIFT, ROOM_Z1 - 2, Math.min(HILL_R, (ROOM_Z1 - ROOM_Z0) / 2)],   // the pump room
  ],
  siege: { attackers: 'red', core: [NX - 1 - (SPAWN_X1 + STAND_X) / 2, BASE_Y, STAND_Z, CORE_R] },
  shrines: SHRINES.map(([x, y, z]) => [x, y + SHRINE_LIFT, z]),
  vehicles: ['red', 'blue'].flatMap((side) => [
    { kind: 'jeep', team: side, at: [team(JEEP_AT[0], side), BASE_Y, JEEP_AT[1]], yaw: side === 'red' ? FACE_BLUE : FACE_RED },
    ...BIKE_AT.map(([x, z]) => ({ kind: 'hoverbike', team: side, at: [team(x, side), BASE_Y, z], yaw: side === 'red' ? FACE_BLUE : FACE_RED })),
  ]),
};

// Where each shrine's perk orbs float (grid cells: each orb's foot), as the
// Shrine construction's anchors (constructions.js _anchored).
// `s` is a layout shrine (feet on its floor).
export const shrineAltars = (s) => SHRINE_ALTARS.map(([x, y, z]) => [s[0] + x + 0.5, s[1] - SHRINE_LIFT + y, s[2] + z + 0.5]);

// Team banners (src/arenas/markers.js draws them; no element is red or blue):
// a pole's foot in grid cells, and its team. Two on the fortress's front
// towers, two flanking its front door.
const TOWER_TOP = BASE_Y + FORT_H + TOWER_RISE + 1;
export const DAM_VALLEY_BANNERS = ['red', 'blue'].flatMap((side) => [
  [FORT_X1 - 2, TOWER_TOP, FORT_Z0 + 1], [FORT_X1 - 2, TOWER_TOP, FORT_Z1 - 2],
  [FORT_X1 + 1, BASE_Y, FRONT_DOOR_Z[0] - 2], [FORT_X1 + 1, BASE_Y, FRONT_DOOR_Z[1] + 1],
].map(([x, y, z]) => ({ team: side, at: [team(x, side), y, z] })));

// ---------------------------------------------------------------- the builder

// Build Dam Valley into a fresh id grid: a Uint8Array of element ids,
// index (y * NZ + z) * NX + x. Returns { ids, layout }.
export function buildDamValley() {
  const ids = new Uint8Array(NX * NY * NZ);
  const at = (x, y, z) => (y * NZ + z) * NX + x;
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < NX && y < NY && z < NZ;
  const put = (x, y, z, id) => { if (inside(x, y, z)) ids[at(x, y, z)] = id; };
  const get = (x, y, z) => (inside(x, y, z) ? ids[at(x, y, z)] : E.WALL);
  // [x0, x1) × [y0, y1) × [z0, z1)
  const box = (x0, y0, z0, x1, y1, z1, id) => {
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) put(x, y, z, id);
  };
  // a construction's cells with its base point at (x, y, z), its x flipped when `flip`
  const stamp = (cells, x, y, z, flip = false) => {
    for (let i = 0; i < cells.n; i++) put(x + (flip ? -cells.x[i] : cells.x[i]), y + cells.y[i], z + cells.z[i], cells.id[i]);
  };

  // ---- the ground: rock, with grass on the valley's soft ground
  const height = new Int16Array(NX * NZ);
  for (let z = 0; z < NZ; z++)
    for (let x = 0; x < NX; x++) {
      const h = groundAt(x, z);
      height[z * NX + x] = h;
      box(x, 0, z, x + 1, h, z + 1, E.ROCK);
      const xr = mirror(x);
      const grassy = h >= FLOOR_Y - 1 && h < CREST_Y && xr >= BASE_X1 && Math.min(z, NZ - 1 - z) > RIDGE_W
        && !inLake(x, z) && rectDist(xr, z, LAKE_X0, MID_X, DAM_Z0, LAKE_Z1) > LAKE_CLEAR;
      if (grassy) put(x, h - 1, z, E.PLANT);
    }
  // the basin's dry riverbed: a layer of sand on its flat floor
  for (let z = BASIN_Z0; z < DAM_Z0; z++)
    for (let x = BASIN_X0; x < NX - BASIN_X0; x++) if (height[z * NX + x] === BASIN_Y) put(x, BASIN_Y - 1, z, E.SAND);

  // ---- the reservoir
  for (let z = DAM_Z1; z < LAKE_Z1; z++)
    for (let x = LAKE_X0; x < NX - LAKE_X0; x++) box(x, height[z * NX + x], z, x + 1, WATER_Y, z + 1, E.WATER);

  // ---- the dam: masonry from the basin's floor to the crest, across the canyon
  box(LAKE_X0, BEDROCK_Y, DAM_Z0, NX - LAKE_X0, CREST_Y, DAM_Z1, E.WALL);
  // parapets along both edges of the crest, with gaps
  for (const z of [DAM_Z0, DAM_Z1 - 1])
    for (let x = LAKE_X0; x < NX - LAKE_X0; x++) {
      const k = Math.abs(x - MID_X + 0.5) % PARAPET_GAP;
      if (k >= PARAPET_GAP_W) box(x, CREST_Y, z, x + 1, CREST_Y + PARAPET_H, z + 1, E.WALL);
    }
  // the maintenance tunnel, end to end, open-cut where the abutments are low
  for (let x = 0; x < NX; x++) {
    const xr = mirror(x);
    if (xr < BASE_X1) continue;
    let deep = true;   // has the tunnel got enough rock over it here?
    for (let z = TUN_Z0; z < TUN_Z1; z++) deep = deep && height[z * NX + x] >= TUN_Y + TUN_H + TUN_PORTAL_COVER;
    const inDam = x >= LAKE_X0 && x < NX - LAKE_X0;
    if (!deep && !inDam) {
      // the approach: a cutting down to the tunnel's floor, open to the sky
      let open = false;
      for (let z = TUN_Z0; z < TUN_Z1; z++) open = open || height[z * NX + x] > TUN_Y;
      if (open) box(x, TUN_Y, TUN_Z0, x + 1, NY, TUN_Z1, E.EMPTY);
      if (open) box(x, BEDROCK_Y, TUN_Z0, x + 1, TUN_Y, TUN_Z1, E.ROCK);
      continue;
    }
    box(x, TUN_Y, TUN_Z0, x + 1, TUN_Y + TUN_H, TUN_Z1, E.EMPTY);
    box(x, TUN_Y - 1, TUN_Z0, x + 1, TUN_Y, TUN_Z1, E.WALL);                    // a paved floor
    box(x, TUN_Y + TUN_H, TUN_Z0, x + 1, TUN_Y + TUN_H + 1, TUN_Z1, E.WALL);    // and a lined roof
  }
  // window slits through the dam's downstream face onto the tunnel
  for (let d = WINDOW_EVERY / 2; MID_X + d + WINDOW_W <= NX - LAKE_X0; d += WINDOW_EVERY)
    for (const x of [MID_X + d, MID_X - d - WINDOW_W])
      box(x, TUN_Y + WINDOW_Y0, DAM_Z0, x + WINDOW_W, TUN_Y + WINDOW_Y0 + WINDOW_H, TUN_Z0, E.GLASS);
  // the pump room in the middle, its sluice gate in the back wall, a window band onto the basin
  box(ROOM_X0, TUN_Y, ROOM_Z0, NX - ROOM_X0, TUN_Y + ROOM_H, ROOM_Z1, E.EMPTY);
  box(ROOM_X0, TUN_Y - 1, ROOM_Z0, NX - ROOM_X0, TUN_Y, ROOM_Z1, E.WALL);
  box(GATE_X0, TUN_Y, ROOM_Z1, NX - GATE_X0, TUN_Y + GATE_H, DAM_Z1, E.WOOD);
  box(ROOM_X0, TUN_Y + ROOM_WINDOW_Y0, DAM_Z0, NX - ROOM_X0, TUN_Y + ROOM_WINDOW_Y0 + ROOM_WINDOW_H, ROOM_Z0, E.GLASS);
  // the powder kegs by the gate
  const keg = runGenerator(BUILTINS.BARREL, { size: KEG_SIZE, seed: SEED, variant: 'keg' });
  stamp(keg, KEG_X, TUN_Y, KEG_Z);
  stamp(keg, NX - 1 - KEG_X, TUN_Y, KEG_Z, true);

  // ---- the bases
  for (const side of ['red', 'blue']) {
    const fx = (x0, x1) => (side === 'red' ? [x0, x1] : [NX - x1, NX - x0]);   // an x span on this side
    const B = (x0, y0, z0, x1, y1, z1, id) => { const [a, b] = fx(x0, x1); box(a, y0, z0, b, y1, z1, id); };
    const top = BASE_Y + FORT_H;
    // the plateau under the whole base is flattened: rock up to the floor, clear air above
    B(0, BEDROCK_Y, PLATEAU_Z0, BASE_X1, BASE_Y, NZ - PLATEAU_Z0, E.ROCK);
    B(0, BASE_Y, PLATEAU_Z0, BASE_X1, NY, NZ - PLATEAU_Z0, E.EMPTY);
    // the fortress: a masonry floor, stone walls, a wooden roof with stone merlons
    B(FORT_X0, BASE_Y - 1, FORT_Z0, FORT_X1, BASE_Y, FORT_Z1, E.WALL);
    B(FORT_X0, BASE_Y, FORT_Z0, FORT_X1, top, FORT_Z1, E.ROCK);
    B(FORT_X0 + FORT_WALL, BASE_Y, FORT_Z0 + FORT_WALL, FORT_X1 - FORT_WALL, top, FORT_Z1 - FORT_WALL, E.EMPTY);
    B(FORT_X0, top, FORT_Z0, FORT_X1, top + 1, FORT_Z1, E.WOOD);
    for (let x = FORT_X0; x < FORT_X1; x += MERLON_EVERY) {
      B(x, top + 1, FORT_Z0, x + 1, top + 3, FORT_Z0 + 1, E.ROCK);
      B(x, top + 1, FORT_Z1 - 1, x + 1, top + 3, FORT_Z1, E.ROCK);
    }
    for (let z = FORT_Z0; z < FORT_Z1; z += MERLON_EVERY) {
      B(FORT_X0, top + 1, z, FORT_X0 + 1, top + 3, z + 1, E.ROCK);
      B(FORT_X1 - 1, top + 1, z, FORT_X1, top + 3, z + 1, E.ROCK);
    }
    // towers on the front corners, over the roof (a lookout down the valley)
    for (const [z0, z1] of [[FORT_Z0, FORT_Z0 + TOWER], [FORT_Z1 - TOWER, FORT_Z1]]) {
      B(FORT_X1 - TOWER, top, z0, FORT_X1, top + TOWER_RISE, z1, E.ROCK);
      B(FORT_X1 - TOWER, top + TOWER_RISE, z0, FORT_X1, top + TOWER_RISE + 1, z1, E.WOOD);
      for (let k = 0; k < TOWER; k += 2) {
        B(FORT_X1 - TOWER + k, top + TOWER_RISE + 1, z0, FORT_X1 - TOWER + k + 1, top + TOWER_RISE + 3, z0 + 1, E.ROCK);
        B(FORT_X1 - TOWER + k, top + TOWER_RISE + 1, z1 - 1, FORT_X1 - TOWER + k + 1, top + TOWER_RISE + 3, z1, E.ROCK);
        B(FORT_X1 - 1, top + TOWER_RISE + 1, z0 + k, FORT_X1, top + TOWER_RISE + 3, z0 + k + 1, E.ROCK);
        B(FORT_X1 - TOWER, top + TOWER_RISE + 1, z0 + k, FORT_X1 - TOWER + 1, top + TOWER_RISE + 3, z0 + k + 1, E.ROCK);
      }
    }
    // the spawn room's wall, with two doorways into the hall
    B(SPAWN_X1, BASE_Y, FORT_Z0 + FORT_WALL, SPAWN_X1 + FORT_WALL, top, FORT_Z1 - FORT_WALL, E.ROCK);
    for (const [z0, z1] of INNER_DOOR_Z) B(SPAWN_X1, BASE_Y, z0, SPAWN_X1 + FORT_WALL, BASE_Y + DOOR_H, z1, E.EMPTY);
    // doorways: the front (toward the enemy) and both sides
    B(FORT_X1 - FORT_WALL, BASE_Y, FRONT_DOOR_Z[0], FORT_X1, BASE_Y + DOOR_H, FRONT_DOOR_Z[1], E.EMPTY);
    B(SIDE_DOOR_X[0], BASE_Y, FORT_Z0, SIDE_DOOR_X[1], BASE_Y + DOOR_H, FORT_Z0 + FORT_WALL, E.EMPTY);
    B(SIDE_DOOR_X[0], BASE_Y, FORT_Z1 - FORT_WALL, SIDE_DOOR_X[1], BASE_Y + DOOR_H, FORT_Z1, E.EMPTY);
    // glass window bands in the front and the hall's sides; wooden shutters over the spawn room's
    const wy0 = BASE_Y + WIN_Y0, wy1 = wy0 + WIN_H;
    B(FORT_X1 - FORT_WALL, wy0, FORT_Z0 + 4, FORT_X1, wy1, FRONT_DOOR_Z[0] - 2, E.GLASS);
    B(FORT_X1 - FORT_WALL, wy0, FRONT_DOOR_Z[1] + 2, FORT_X1, wy1, FORT_Z1 - 4, E.GLASS);
    B(SPAWN_X1 + FORT_WALL + 1, wy0, FORT_Z0, SIDE_DOOR_X[0] - 1, wy1, FORT_Z0 + FORT_WALL, E.GLASS);
    B(SIDE_DOOR_X[1] + 1, wy0, FORT_Z0, FORT_X1 - FORT_WALL - 1, wy1, FORT_Z0 + FORT_WALL, E.GLASS);
    B(SPAWN_X1 + FORT_WALL + 1, wy0, FORT_Z1 - FORT_WALL, SIDE_DOOR_X[0] - 1, wy1, FORT_Z1, E.GLASS);
    B(SIDE_DOOR_X[1] + 1, wy0, FORT_Z1 - FORT_WALL, FORT_X1 - FORT_WALL - 1, wy1, FORT_Z1, E.GLASS);
    B(FORT_X0 + 3, wy0, FORT_Z0, SPAWN_X1 - 1, wy1, FORT_Z0 + FORT_WALL, E.WOOD);
    B(FORT_X0 + 3, wy0, FORT_Z1 - FORT_WALL, SPAWN_X1 - 1, wy1, FORT_Z1, E.WOOD);
    // the flag stand: a steel plinth in the hall
    B(STAND_X - STAND_R, BASE_Y, STAND_Z - STAND_R, STAND_X + STAND_R + 1, BASE_Y + PAD_H, STAND_Z + STAND_R + 1, E.METAL);
    // vehicle pads: steel-edged concrete, flush with the plateau
    const pad = ([x, z], [hx, hz]) => {
      B(x - hx, BASE_Y - PAD_H, z - hz, x + hx + 1, BASE_Y, z + hz + 1, E.METAL);
      B(x - hx + 1, BASE_Y - PAD_H, z - hz + 1, x + hx, BASE_Y, z + hz, E.WALL);
    };
    pad(JEEP_AT, JEEP_PAD);
    for (const b of BIKE_AT) pad(b, BIKE_PAD);
  }

  // ---- the forest: the same trees on both sides, mirrored
  const rng = makeRng(SEED);
  const trees = [];
  for (let t = 0; t < TREE_TRIES && trees.length < TREE_MAX; t++) {
    const x = Math.floor(FOREST_X0 + rng() * (FOREST_X1 - FOREST_X0));
    const z = Math.floor(FOREST_Z0 + rng() * (FOREST_Z1 - FOREST_Z0));
    if (z >= ROAD_Z[0] && z < ROAD_Z[1]) continue;
    if (z >= TUN_Z0 - TRENCH_CLEAR && z < TUN_Z1 + TRENCH_CLEAR) continue;
    if (rectDist(x, z, LAKE_X0, MID_X, DAM_Z0, LAKE_Z1) < LAKE_CLEAR * 3) continue;
    const h = height[z * NX + x];
    if (h < FLOOR_Y - 1 || h >= CREST_Y || get(x, h - 1, z) !== E.PLANT) continue;
    if (trees.some((o) => Math.hypot(o.x - x, o.z - z) < TREE_GAP)) continue;
    trees.push({ x, z, h, kind: TREE_KINDS[Math.floor(rng() * TREE_KINDS.length)],
      size: TREE_SIZE[0] + Math.floor(rng() * (TREE_SIZE[1] - TREE_SIZE[0] + 1)), seed: Math.floor(rng() * 2 ** 31) });
  }
  for (const t of trees) {
    const cells = runGenerator(BUILTINS.TREE, { size: t.size, seed: t.seed, variant: t.kind });
    // leaves only fill air (a crown may brush a slope)
    for (const flip of [false, true]) {
      const x0 = flip ? NX - 1 - t.x : t.x;
      for (let i = 0; i < cells.n; i++) {
        const x = x0 + (flip ? -cells.x[i] : cells.x[i]), y = t.h + cells.y[i], z = t.z + cells.z[i];
        if (cells.id[i] === E.PLANT && get(x, y, z) !== E.EMPTY) continue;
        put(x, y, z, cells.id[i]);
      }
    }
  }

  // ---- the shrines (their perk orbs are the app's: shrineAltars)
  const shrine = runGenerator(BUILTINS.SHRINE, { size: 1, seed: SEED });
  for (const [x, y, z] of SHRINES) {
    // a level, clear site: solid under its floor, air over it
    const [hx, hz] = SHRINE_HALF;
    for (let zz = z - hz; zz <= z + hz; zz++)
      for (let xx = x - hx; xx <= x + hx; xx++) {
        if (get(xx, y - 1, zz) === E.EMPTY) put(xx, y - 1, zz, E.ROCK);
        box(xx, y, zz, xx + 1, y + SHRINE_HEIGHT, zz + 1, E.EMPTY);
      }
    stamp(shrine, x, y, z);
  }
  return { ids, layout: DAM_VALLEY_LAYOUT };
}

