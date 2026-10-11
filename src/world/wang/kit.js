import { ELEMENTS, K } from '../../elements.js';

// Wang tile kits: the authoring format and its rasterizer (docs/wang-tiles.md).
//
// A kit is a set of hand-authored tiles that tiling.js stitches into a
// herringbone, Noita's way of building a biome from hand-drawn pieces. Every
// tile is a 2:1 brick authored in one canonical frame (the "H" brick, long
// along x):
//
//          x = 0                 U                  2U
//   z = 0   +---------N0---------+---------N1---------+
//           |                    |                    |
//           W       unit 0       :      unit 1        E      (seen from above,
//           |    (D0 / U0)       :    (D1 / U1)       |       y up out of the page)
//   z = U   +---------S0---------+---------S1---------+
//
// and H cells tall. Its ten ports are the places it can open onto a
// neighbour: W, E (the short ends), N0, N1, S0, S1 (two per long side, one a
// unit), D0, D1 (shafts down through the floor, one a unit) and U0, U1 (up
// through the ceiling). The tiling places it as is, mirrored, or transposed
// (an upright "V" brick, long along z), so one authored tile makes up to eight
// placements.
//
// A tile is plain data:
//   { name, weight, ports: { W: 'DR-', ... }, prims: [...], sites: [...] }
// ports: for each port the colours it accepts, preferred first (the tiling
//   picks the colour of a still-free edge from this order):
//     '-' closed   'D' a doorway at the floor   'R' a doorway with rails
//     'H' a doorway up at the gallery level (HIGH_FLOOR)   'S' a shaft (D/U ports)
//   A port it doesn't list accepts DEFAULT_SIDE ('-D') on the sides and
//   DEFAULT_SHAFT ('-') on the floor and ceiling. The tile promises that
//   every open port it accepts reaches its floor and the floor reaches it
//   (a D port: you fall in; a U port: you fall out of the tile above onto the
//   floor), walking, stepping a cell and jumping two; scripts/check-wang.mjs
//   holds it to that.
// prims: what it is made of, applied in order over solid ROCK, in canonical
//   cells (half-open boxes: a = [x, y, z] its low corner, b its high corner):
//     { box: [a, b], m }                    a box
//     { ramp: [a, b], m, axis, rise }       a wedge in box a..b: solid under a
//                                           floor rising from a's y along axis
//                                           ('x' or 'z'), rise +1 or -1 (which end
//                                           is high); ramp(..., m: 'ROCK')
//     { stairs: [a, b], m, axis, rise }     the same, stepped a cell a cell
//     { ball: [c, r], m }                   an ellipsoid: centre c, radii r [rx, ry, rz]
//     { cyl: [a, r, h], m, axis }           a cylinder: base centre a, radius r,
//                                           length h along axis ('x', 'y', 'z')
//     { capsule: [a, b, r], m }             a capsule from a to b
//   and on any of them:
//     rough   cells of noise on its surface (0: crisp; timber stays crisp)
//     only    the material codes it may replace ('AIR', 'ROCK', or a list),
//             so a fill pours only into what is carved and a vein only
//             threads rock
// sites: [{ kind, at: [x, y, z] }]: places a scene can use (loot on a floor,
//   a treasure nook's prize): bakeWang reports them in world cells.
//
// The rasterizer forces a BORDER of rock around every tile (its walls, floor
// and ceiling), so whatever a tile holds, it touches its neighbours only
// through its ports; the ports are cut at sampling time (glsl.js, tiling.js
// wangCellJS), so one rasterized tile serves every combination of open ports.

// ---- material codes: what a kit's cells are (not elements: a kit's palette
// maps them to elements, so another biome can make its ROCK coal or ice)
export const MAT = {
  AIR: 0,
  ROCK: 1,       // the host rock
  SOFT: 2,       // softer rock: diggable dirt, the collapsed parts
  BEAM: 3,       // timber: shoring, beams, platforms, stairs
  RAIL: 4,       // mine-cart rails
  RUBBLE: 5,     // loose rubble heaps (a powder)
  WATER: 6,
  OIL: 7,
  GOLD: 8,       // gold veins and the treasure
  CRYSTAL: 9,    // light crystals (they glow)
  COAL: 10,
  MOSS: 11,
  GRAVEL: 12,    // fine loose stone
  METAL: 13,     // iron: carts, braces
  SAND: 14,
  ICE: 15,
  // the Noita stuff a biome is dense with (each maps to the elements.js key of its name by default)
  TOXIC: 16, BLOOD: 17, ACID: 18, LAVA: 19, SLIME: 20, MUD: 21, WHISKEY: 22,
  TELEPORTATIUM: 23, LEVITATIUM: 24, BERSERKIUM: 25, HEALTHIUM: 26, POLYMORPHINE: 27,
  GUNPOWDER: 28, TNT: 29, FUNGUS: 30, MEAT: 31, NUGGETS: 32, CLAY: 33, PLANT: 34, WOOD: 35,
  GLASS: 36,   // acid-proof: what an acid pit is lined with
  TORCH: 37,   // a wall torch's head (its light: elements.js WALL_TORCH), on a BEAM stick
  // ...and the Coal Pits' and Snowy Depths' own (HOTCOAL: coal laid down burning, the kit's temps)
  SNOW: 38, SALTWATER: 39, LIQUID_NITROGEN: 40, DRY_ICE: 41, BRICK: 42, BROKENCOAL: 43, SCRAP: 44,
  HOTCOAL: 45,
};
export const MAT_COUNT = 46;
// A kit's temps: { CODE: °C } lays those codes down at that temperature instead
// of their element's spawn temperature (HOTCOAL burning, a lake's water above
// freezing in the Snowy Depths' cold). wangTemp (glsl.js) / tempJS (bake.js);
// codes without one return WANG_NO_TEMP.
export const WANG_NO_TEMP = -1000;
export const MAT_NAMES = Object.keys(MAT);
// codes the sampler returns outside the tiled region (the scene fills them)
export const WANG_OUT = 255;
// The default palette: code -> element key (elements.js). A kit overrides any.
export const DEFAULT_PALETTE = {
  AIR: 'EMPTY', ROCK: 'ROCK', SOFT: 'LIMESTONE', BEAM: 'WOOD', RAIL: 'METAL', RUBBLE: 'RUBBLE',
  WATER: 'WATER', OIL: 'OIL', GOLD: 'GOLD', CRYSTAL: 'CRYSTAL', COAL: 'COAL', MOSS: 'MOSS',
  GRAVEL: 'STONE', METAL: 'METAL', SAND: 'SAND', ICE: 'ICE',
  // WOOD: timber that isn't the kit's BEAM (crates, barrels, scaffolds) when BEAM is remapped
  ...Object.fromEntries(Object.keys(MAT).filter((n) => MAT[n] >= 16).map((n) => [n, n])),
  TORCH: 'WALL_TORCH',
  HOTCOAL: 'COAL',
};
// liquids a body swims through (the walk checks); TOXIC, ACID, LAVA and
// LIQUID_NITROGEN hurt, so the checks treat them as walls: a path never needs a swim through them
const LIQUIDS = [MAT.WATER, MAT.OIL, MAT.BLOOD, MAT.SLIME, MAT.MUD, MAT.WHISKEY,
  MAT.TELEPORTATIUM, MAT.LEVITATIUM, MAT.BERSERKIUM, MAT.HEALTHIUM, MAT.POLYMORPHINE, MAT.SALTWATER];
// can a body pass through it (air or a liquid: you swim)
export const passable = (m) => m === MAT.AIR || LIQUIDS.includes(m) || m === WANG_OUT;
export const isLiquid = (m) => LIQUIDS.includes(m);

// A wall torch (elements.js WALL_TORCH; Noita's mines are lit by torches on their
// walls): its head (TORCH) at `at`, on a timber stick under it, the stick's
// bracket set in the wall one cell toward `wall` ([dx, dz], pointing into the
// wall), so the torch hangs on the wall even where a rough face was dug back.
// lantern: true (a light added after the authoring: a kit puts these last).
export const wallTorch = ([x, y, z], [dx, dz]) => [
  { box: [[x + dx, y - 1, z + dz], [x + dx + 1, y, z + dz + 1]], m: 'BEAM', lantern: true },
  { box: [[x, y - 1, z], [x + 1, y, z + 1]], m: 'BEAM', lantern: true },
  { box: [[x, y, z], [x + 1, y + 1, z + 1]], m: 'TORCH', lantern: true },
];

// ---- ports (canonical frame)
export const PORTS = ['W', 'E', 'N0', 'N1', 'S0', 'S1', 'D0', 'D1', 'U0', 'U1'];
export const SIDE_PORTS = 6;          // W..S1: the doorways; D0..U1 are shafts
export const COL = { CLOSED: 0, DOOR: 1, RAIL: 2, HIGH: 3, SHAFT: 1 };
const COL_LETTER = { '-': COL.CLOSED, D: COL.DOOR, R: COL.RAIL, H: COL.HIGH, S: COL.SHAFT };
export const DEFAULT_SIDE = '-D';
export const DEFAULT_SHAFT = '-';

// ---- the geometry every kit shares (cells; a cell is 0.30 m, a body 5.5 tall and 1.6 wide)
export const GEOM = {
  U: 24,              // a unit: a brick is 2U × H × U
  H: 24,              // a layer's height: 7.2 m
  BORDER: 2,          // rock every tile keeps at its faces (2 + 2 between neighbours)
  FLOOR: 2,           // the floor's top: a doorway's bottom (= BORDER)
  HIGH_FLOOR: 13,     // a high doorway's bottom: the gallery storey over a low gallery
  DOOR_W: 8,          // a doorway's width: 6 clear between its timber posts
  DOOR_H: 9,          // ...its height: 8 clear under the lintel (a body is 5.5)
  PORT_DEPTH: 5,      // how far an end port (W, E) cuts into its tile: past the BORDER into the gallery that runs the tile's length
  PORT_DEPTH_SIDE: 12, // how far a side port (N, S) cuts: to the tile's middle, where its long gallery runs
  FRAME_DEPTH: 2,     // the timber set in a doorway, this far in from the tile's face
  RAIL_GAUGE: 4,      // cells between a rail line's two rails (centred)
  SHAFT_W: 6,         // a shaft's square side
  SHAFT_CUT: 2,       // a floor shaft cuts this far above the floor too (through a raised floor or a heap)
  JITTER: 1,          // cells a port's walls and roof wander (world hash), so seams aren't ruled lines
  OPEN: 0,            // 1: an open kit (islands in a void, no border, no doorways; see openCap)
  SPINE: 0,           // an open kit's walking height (kits/islands.js): its floor shafts cut down through it
};
// An open kit's region is closed only at its top and bottom: the top layer's top BORDER cells and
// the bottom layer's cells under FLOOR are rock (the shafts still cut through them: the way in, the
// way out), so the entry hall has a floor and the body lands on one at the bottom. Its sides are
// the region's edge (rock outside). Shared by the sampler's twins (tiling.js, glsl.js).
export function openCap(G, code, l, layers, cy) {
  if (!G.OPEN) return code;
  if (l === layers - 1 && cy >= G.H - G.BORDER) return MAT.ROCK;
  if (l === 0 && cy < G.FLOOR) return MAT.ROCK;
  return code;
}

// ---- the rasterizer
const NOISE_SALT = 0x5a17;          // a tile's surface noise stream
const NOISE_SCALE = 0.19;           // noise frequency, 1/cells (about a 5-cell grain)
const NOISE_OCT2 = 2.1;             // the second octave's frequency multiple...
const NOISE_OCT2_GAIN = 0.45;       // ...and its weight
const DIST_EPS = 1e-6;
const NOISE_TILE_STRIDE = 977;      // a tile's noise streams, apart from the next tile's...
const NOISE_PRIM_STRIDE = 31;       // ...and a primitive's from the next (pr.salt: share one, as a gallery's slices do)

function hash3(x, y, z, s) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ Math.imul(s, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = fade(x - xi), fy = fade(y - yi), fz = fade(z - zi);
  let v = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2;
    v += hash3(xi + dx, yi + dy, zi + dz, s) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
  }
  return v * 2 - 1;
}
// about ±1 fractal noise at canonical cell p
function surfNoise(p, s) {
  const [x, y, z] = p.map((v) => v * NOISE_SCALE);
  return (vnoise(x, y, z, s) + NOISE_OCT2_GAIN * vnoise(x * NOISE_OCT2, y * NOISE_OCT2, z * NOISE_OCT2, s + 1)) / (1 + NOISE_OCT2_GAIN);
}

const AXIS = { x: 0, y: 1, z: 2 };
// signed distance of cell centre p (cell + 0.5) to a primitive; < 0 inside
function sdf(pr, p) {
  if (pr.box) {
    const [a, b] = pr.box;
    let out = 0, inMax = -Infinity;
    for (let i = 0; i < 3; i++) {
      const d = Math.max(a[i] - p[i], p[i] - b[i]);
      out += Math.max(d, 0) ** 2;
      inMax = Math.max(inMax, d);
    }
    return out > 0 ? Math.sqrt(out) : inMax;
  }
  if (pr.ramp || pr.stairs) {
    const [a, b] = pr.ramp ?? pr.stairs;
    const ax = AXIS[pr.axis], len = b[ax] - a[ax], hgt = b[1] - a[1];
    let t = (p[ax] - a[ax]) / len;                    // 0..1 along the run
    if (pr.rise < 0) t = 1 - t;
    let top = a[1] + hgt * t;
    if (pr.stairs) top = a[1] + Math.ceil(hgt * t - DIST_EPS);
    const box = sdf({ box: [a, b] }, p);
    return Math.max(box, p[1] - top);
  }
  if (pr.ball) {
    const [c, r] = pr.ball;
    let k = 0;
    for (let i = 0; i < 3; i++) k += ((p[i] - c[i]) / r[i]) ** 2;
    return (Math.sqrt(k) - 1) * Math.min(...r);
  }
  if (pr.cyl) {
    const [a, r, h] = pr.cyl, ax = AXIS[pr.axis ?? 'y'];
    let rad = 0;
    for (let i = 0; i < 3; i++) if (i !== ax) rad += (p[i] - a[i]) ** 2;
    const along = p[ax] - a[ax];
    return Math.max(Math.sqrt(rad) - r, -along, along - h);
  }
  if (pr.capsule) {
    const [a, b, r] = pr.capsule;
    const ab = b.map((v, i) => v - a[i]), ap = p.map((v, i) => v - a[i]);
    const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 + DIST_EPS)));
    return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t) - r;
  }
  throw new Error(`wang: unknown primitive ${JSON.stringify(pr)}`);
}
const codeOf = (m) => {
  const c = typeof m === 'number' ? m : MAT[m];
  if (c === undefined) throw new Error(`wang: unknown material ${m}`);
  return c;
};

// One tile's cells in its canonical frame: Uint8Array, index x + 2U (y + H z).
// A variant (compileKit) rasterizes with its authored tile's noise (tile.noise),
// so every variant of a tile has the same rock and only its contents differ.
export function rasterTile(tile, index, G = GEOM) {
  // an open kit's tiles (geom.OPEN: Noita's Coal Pits and Snowy Depths, islands in a void) start
  // as air and keep no border: they meet their neighbours wherever their islands do
  const X = 2 * G.U, Y = G.H, Z = G.U, out = new Uint8Array(X * Y * Z).fill(G.OPEN ? MAT.AIR : MAT.ROCK);
  const dims = [X, Y, Z], noiseIndex = tile.noise ?? index;
  coated = new Set();
  tile.prims.forEach((pr, pi) => applyPrim(out, dims, pr, NOISE_SALT + noiseIndex * NOISE_TILE_STRIDE + (pr.salt ?? tile.prims.indexOf(pr)) * NOISE_PRIM_STRIDE, tile.vseed ?? 0, pr.salt ?? pi));
  // the border: rock at every face, so a tile meets its neighbours only through its ports
  // (an `open` tile keeps only its floor and ceiling: its void runs on into an open neighbour's)
  // (but a solid coat stays: the floor is the border, and moss grows on it)
  // (an open kit, geom.OPEN, keeps none: its region is capped instead, openCap)
  if (!G.OPEN) for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
    const side = !tile.open && (x < G.BORDER || x >= X - G.BORDER || z < G.BORDER || z >= Z - G.BORDER);
    if (side || y < G.BORDER || y >= Y - G.BORDER) {
      const i = x + X * (y + Y * z);
      if (!coated.has(i)) out[i] = MAT.ROCK;
    }
  }
  settleLoose(out, dims);
  if (tile.torches) placeTorches(out, tile.torches, index, G);
  coated = null;
  return out;
}
// Loose dressing (heaps, crate fills, gravel: elements.js powders by the default
// palette) that would fall off a ledge at load isn't laid down: a cell with
// open space in its lower ring (where the move pass would let it fall or
// topple) over a drop deeper than LOOSE_DROP_MAX. What a later carve (a doorway,
// a shaft) or the tile's face left hanging spilled at load otherwise: gold
// nuggets (dens 193) falling a storey land with ~100 units of kinetic energy,
// ~250 °C of impact heat (physics.js KE_TO_HEAT), and that hot spot kept the
// Mines' caverns simulating for minutes. A step down onto the floor beside a
// heap is fine (the toppling there barely warms it). Repeated until nothing
// changes: a cell left hanging by one taken out under it goes too.
const LOOSE = new Set(Object.entries(DEFAULT_PALETTE).filter(([, k]) => ELEMENTS.find((e) => e.key === k)?.kind === K.POWDER).map(([n]) => MAT[n]));
const LOOSE_DROP_MAX = 2;   // cells: the deepest drop a loose cell may stand over the edge of
function settleLoose(out, [X, Y, Z]) {
  const at = (x, y, z) => x + X * (y + Y * z);
  const drop = (x, y, z) => {   // open cells from (x, y, z) down, past LOOSE_DROP_MAX at most
    let d = 0;
    while (y - d >= 0 && d <= LOOSE_DROP_MAX && passable(out[at(x, y - d, z)])) d++;
    return y - d < 0 ? 0 : d;   // (the tile's floor: its neighbour below decides)
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let y = 1; y < Y; y++) for (let z = 0; z < Z; z++) for (let x = 0; x < X; x++) {
      const i = at(x, y, z);
      if (!LOOSE.has(out[i])) continue;
      let hangs = false;
      for (let dz = -1; dz <= 1 && !hangs; dz++) for (let dx = -1; dx <= 1 && !hangs; dx++) {
        const qx = x + dx, qz = z + dz;
        if (qx >= 0 && qz >= 0 && qx < X && qz < Z) hangs = drop(qx, y - 1, qz) > LOOSE_DROP_MAX;
      }
      if (hangs) { out[i] = MAT.AIR; changed = true; }
    }
  }
}
// Wall lights a kit doesn't place by hand (kit.torches, or a tile's own: { every, max,
// lights }): after the carving, on walls TORCH_Y over a floor, at least `every` cells
// apart and from any light already there (CRYSTAL, TORCH), up to `max` a tile,
// taking `lights` in turn ('TORCH': kit.js wallTorch's stick and head; 'CRYSTAL': a
// two-cell cluster on the wall). The candidates go in a fixed hashed order, so every
// load gets the same ones. Noita lights its caves this way: a torch on a wall here
// and there, darkness between.
export const TORCH_Y = 7;              // a light's head this far over the floor: over a body's head (5.5)
const TORCH_HASH = 0x9e3779b1;
// posts: true (the open kits' islands, which have few walls to hang one on): where
// no wall will take one, a torch on a timber post at an island's rim, the post
// POST_H cells tall (Noita's Coal Pits light their ledges with torches on poles).
// It stands at the rim, off the walkway's middle, where nothing walks into it.
export const POST_H = 5;               // the post's timber, cells: the head at a body's head height (5.5)
function placeTorches(out, { every = 16, max = 3, lights = ['TORCH'], posts = false }, index, G) {
  const X = 2 * G.U, Y = G.H, Z = G.U;
  const at = (x, y, z) => x + X * (y + Y * z);
  const solid = (c) => !passable(c) && c !== MAT.BEAM;
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const cand = [];
  for (let z = G.BORDER; z < Z - G.BORDER; z++) for (let x = G.BORDER; x < X - G.BORDER; x++)
    for (let y = G.BORDER + TORCH_Y; y < Y - G.BORDER - 1; y++) {
      // head and stick in air, air down to a floor TORCH_Y under the head, a wall beside the stick
      let ok = true;
      for (let k = 0; k <= TORCH_Y && ok; k++) ok = out[at(x, y - k, z)] === MAT.AIR;
      if (!ok || !solid(out[at(x, y - TORCH_Y - 1, z)])) continue;
      const wall = SIDES.find(([dx, dz]) => solid(out[at(x + dx, y - 1, z + dz)]) && solid(out[at(x + dx, y, z + dz)])
        && out[at(x - dx, y - 1, z - dz)] === MAT.AIR);   // open in front: on a wall, not in a crack
      if (wall) cand.push({ x, y, z, wall, h: Math.imul((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ index, TORCH_HASH) >>> 0 });
    }
  cand.sort((a, b) => a.h - b.h);
  // then the posts (after every wall spot: a wall torch is the first choice)
  const postCand = [];
  if (posts) for (let z = G.BORDER + 1; z < Z - G.BORDER - 1; z++) for (let x = G.BORDER + 1; x < X - G.BORDER - 1; x++)
    for (let y = G.BORDER; y < Y - G.BORDER - POST_H - 2; y++) {
      // rock (no timber: a plank won't hold it) with air POST_H + 2 over it, at the rim: a side open down to under the floor
      if (!solid(out[at(x, y, z)]) || out[at(x, y, z)] === MAT.TORCH) continue;
      let ok = true;
      for (let k = 1; k <= POST_H + 2 && ok; k++) ok = out[at(x, y + k, z)] === MAT.AIR;
      if (!ok) continue;
      const rim = SIDES.some(([dx, dz]) => out[at(x + dx, y, z + dz)] === MAT.AIR && out[at(x + dx, y - 1, z + dz)] === MAT.AIR);
      if (rim) postCand.push({ x, y: y + POST_H + 1, z, post: true, h: Math.imul((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ index, TORCH_HASH) >>> 0 });
    }
  postCand.sort((a, b) => a.h - b.h);
  cand.push(...postCand);
  const lit = [];
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
    const c = out[at(x, y, z)];
    if (c === MAT.CRYSTAL || c === MAT.TORCH) lit.push([x, y, z]);
  }
  const far = (x, y, z) => lit.every(([a, b, c]) => (a - x) ** 2 + (b - y) ** 2 + (c - z) ** 2 >= every * every);
  let n = 0;
  for (const { x, y, z, wall, post } of cand) {
    if (n >= max) break;
    if (!far(x, y, z)) continue;
    const kind = lights[n % lights.length];
    if (post) {   // (always a torch: a crystal doesn't grow on a pole)
      for (let k = 1; k <= POST_H; k++) out[at(x, y - k, z)] = MAT.BEAM;
      out[at(x, y, z)] = MAT.TORCH;
    } else if (kind === 'TORCH') {
      const [dx, dz] = wall;
      out[at(x + dx, y - 1, z + dz)] = MAT.BEAM;
      out[at(x, y - 1, z)] = MAT.BEAM;
      out[at(x, y, z)] = MAT.TORCH;
    } else {
      out[at(x, y - 1, z)] = MAT[kind];
      out[at(x, y, z)] = MAT[kind];
    }
    lit.push([x, y, z]);
    n++;
  }
}
const onlySet = (pr, dflt) => {
  const o = pr.only ?? dflt;
  return o === undefined ? null : new Set([].concat(o).map(codeOf));
};
// one primitive onto out (dims [X, Y, Z]); salt: its noise stream; vseed, pi: its variant's random stream
function applyPrim(out, [X, Y, Z], pr, salt, vseed, pi) {
  const at = (x, y, z) => x + X * (y + Y * z);
  if (pr.coat) return coat(out, [X, Y, Z], pr, salt);
  if (pr.scatter) return scatter(out, [X, Y, Z], pr, salt, vseed, pi);
  const m = codeOf(pr.m ?? 'AIR');
  const only = onlySet(pr);
  const rough = pr.rough ?? 0;
  // the primitive's box, padded by its roughness (a cheap bound)
  const lo = [0, 0, 0], hi = [X, Y, Z];
  const bb = boundsOf(pr);
  for (let i = 0; i < 3; i++) {
    lo[i] = Math.max(0, Math.floor(bb[0][i] - rough - 1));
    hi[i] = Math.min([X, Y, Z][i], Math.ceil(bb[1][i] + rough + 1));
  }
  for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
    const p = [x + 0.5, y + 0.5, z + 0.5];
    let d = sdf(pr, p);
    if (rough) d += rough * surfNoise(p, salt);
    if (d >= 0) continue;
    const i = at(x, y, z);
    if (only && !only.has(out[i])) continue;
    out[i] = m;
  }
}
// { coat: [a, b], m, face, cover, only, depth }: growth on the surfaces in box
// a..b (Noita's moss and fungus, a blood splash): a cell of `only` (default
// ROCK) with AIR within `depth` cells (default 1) on `face` becomes m, in
// patches covering about `cover` (0..1, default 0.5) of them. face: 'up' (the
// floors), 'down' (the ceilings), 'side' (the walls), 'any'.
let coated = null;                      // the cells a solid coat made, this rasterTile (kept through the border)
const COAT_SCALE = 2.2;                 // patch noise is this much coarser than the surface noise (patches a couple of metres across)
const FACES = { up: [[0, 1, 0]], down: [[0, -1, 0]], side: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] };
FACES.any = [...FACES.up, ...FACES.down, ...FACES.side];
const COAT_SPREAD = 2;                  // the patch noise's usual span is about ±1/COAT_SPREAD: cover maps over it
function coat(out, [X, Y, Z], pr, salt) {
  const [a, b] = pr.coat, m = codeOf(pr.m), only = onlySet(pr, 'ROCK'), dirs = FACES[pr.face ?? 'any'];
  const cover = pr.cover ?? 0.5, depth = pr.depth ?? 1, at = (x, y, z) => x + X * (y + Y * z);
  const thresh = (1 - 2 * cover) / COAT_SPREAD;
  const hits = [];
  for (let z = Math.max(0, a[2]); z < Math.min(Z, b[2]); z++) for (let y = Math.max(0, a[1]); y < Math.min(Y, b[1]); y++) for (let x = Math.max(0, a[0]); x < Math.min(X, b[0]); x++) {
    if (!only.has(out[at(x, y, z)])) continue;
    if (surfNoise([x / COAT_SCALE, y / COAT_SCALE, z / COAT_SCALE], salt) < thresh) continue;
    for (const [dx, dy, dz] of dirs) {
      let ok = false;
      for (let d = 1; d <= depth && !ok; d++) {
        const nx = x + dx * d, ny = y + dy * d, nz = z + dz * d;
        ok = nx >= 0 && ny >= 0 && nz >= 0 && nx < X && ny < Y && nz < Z && out[at(nx, ny, nz)] === MAT.AIR;
      }
      if (ok) { hits.push(at(x, y, z)); break; }
    }
  }
  for (const i of hits) { out[i] = m; if (!passable(m)) coated.add(i); }
}
// { scatter: [a, b], n, put: [prims], on }: n copies of `put` (prims in cells
// relative to their spot) at random columns of box a..b. on 'floor' (default)
// the spot is the first AIR cell standing on something solid, scanning down
// from b's y; on 'ceiling' the first AIR cell under solid, scanning up from
// a's y (hang a chain from it: prims going down). The columns come from the
// variant's random stream (compileKit `variants`), so each variant scatters
// differently; a column with no such surface is skipped.
const SCATTER_SALT = 0x5ca7;
function scatter(out, [X, Y, Z], pr, salt, vseed, pi) {
  const [a, b] = pr.scatter, n = pr.n ?? 1, ceiling = pr.on === 'ceiling', at = (x, y, z) => x + X * (y + Y * z);
  const solidAt = (x, y, z) => { const c = out[at(x, y, z)]; return c !== MAT.AIR && !isLiquid(c); };
  for (let k = 0; k < n; k++) {
    const x = a[0] + Math.floor(hash3(vseed, pi, 3 * k, SCATTER_SALT) * (b[0] - a[0]));
    const z = a[2] + Math.floor(hash3(vseed, pi, 3 * k + 1, SCATTER_SALT) * (b[2] - a[2]));
    if (x < 1 || z < 1 || x >= X - 1 || z >= Z - 1) continue;
    let y = -1;
    if (ceiling) { for (let yy = Math.max(1, a[1]); yy < Math.min(Y - 1, b[1]); yy++) if (out[at(x, yy, z)] === MAT.AIR && solidAt(x, yy + 1, z)) { y = yy; break; } }
    else for (let yy = Math.min(Y - 2, b[1] - 1); yy >= Math.max(1, a[1]); yy--) if (out[at(x, yy, z)] === MAT.AIR && solidAt(x, yy - 1, z)) { y = yy; break; }
    if (y < 0) continue;
    if (!ceiling && !settled(out, [X, Y, Z], pr.put ?? [], [x, y, z], solidAt)) continue;
    (pr.put ?? []).forEach((q, qi) => applyPrim(out, [X, Y, Z], shiftPrim(q, [x, y, z]), salt + qi + 1, vseed, pi * 64 + k));
  }
}
// Does a floor scatter's `put` at spot o sit whole and at rest? Its footprint
// (the prims' bounds, x and z) inside the tile clear of its edge cells, and a
// solid under every column of it. A heap or crate hanging over a shelf's edge,
// or cut by the tile's face where a neighbour's doorway opens, spilled its
// nuggets and powder at load: gold (dens 193) falling a storey lands with
// ~100 units of kinetic energy, ~250 °C of impact heat (physics.js KE_TO_HEAT),
// and broke the moss it hit, and that hot spot's heat kept the Mines' caverns
// awake for minutes. Noita's props stand on the ground they are placed on.
function settled(out, [X, Y, Z], put, o, solidAt) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let loose = false;
  for (const q of put) {
    if (q.coat || q.scatter) continue;
    const [a, b] = boundsOf(shiftPrim(q, o));
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], Math.floor(a[i])); hi[i] = Math.max(hi[i], Math.ceil(b[i])); }
    loose ||= [].concat(typeof q.m === 'object' && q.m ? Object.keys(q.m) : q.m ?? []).some((n) => LOOSE.has(MAT[n]));
  }
  if (lo[0] === Infinity) return true;
  if (lo[0] < 1 || lo[2] < 1 || hi[0] > X - 1 || hi[2] > Z - 1) return false;
  for (let z = lo[2]; z < hi[2]; z++) for (let x = lo[0]; x < hi[0]; x++) if (!solidAt(x, o[1] - 1, z)) return false;
  // loose stuff clear of where a doorway may be cut (tiling.js cutPorts, at sampling: it
  // would cut the crate or the shelf under it), with a cell under it for the support
  return !loose || !inPortCut([lo[0], o[1] - 1, lo[2]], [hi[0], hi[1], hi[2]]);
}
// Does box [a, b) (canonical cells) touch any doorway tiling.js cutPorts may cut (any
// side port, either floor, the jitter included)?
function inPortCut(a, b, G = GEOM) {
  const U = G.U, half = G.DOOR_W / 2 + G.JITTER, span = (lo, hi, l, h) => lo < h && hi > l;
  const ys = [G.FLOOR, G.HIGH_FLOOR].some((yb) => span(a[1], b[1], yb, yb + G.DOOR_H + G.JITTER));
  if (!ys) return false;
  const lat = (lo, hi, c) => span(lo, hi, c - half, c + half);
  if (lat(a[2], b[2], U / 2) && (span(a[0], b[0], 0, G.PORT_DEPTH) || span(a[0], b[0], 2 * U - G.PORT_DEPTH, 2 * U))) return true;   // W, E
  return [0, 1].some((u) => lat(a[0], b[0], u * U + U / 2) && (span(a[2], b[2], 0, G.PORT_DEPTH_SIDE) || span(a[2], b[2], U - G.PORT_DEPTH_SIDE, U)));   // N, S
}
// a primitive moved by o (cells)
const add =(p, o) => p.map((v, i) => v + o[i]);
export function shiftPrim(pr, o) {
  const q = { ...pr };
  for (const k of ['box', 'ramp', 'stairs', 'coat', 'scatter']) if (pr[k]) q[k] = pr[k].map((p) => add(p, o));
  if (pr.ball) q.ball = [add(pr.ball[0], o), pr.ball[1]];
  if (pr.cyl) q.cyl = [add(pr.cyl[0], o), pr.cyl[1], pr.cyl[2]];
  if (pr.capsule) q.capsule = [add(pr.capsule[0], o), add(pr.capsule[1], o), pr.capsule[2]];
  return q;
}
function boundsOf(pr) {
  if (pr.box) return pr.box;
  if (pr.ramp || pr.stairs) return pr.ramp ?? pr.stairs;
  if (pr.ball) { const [c, r] = pr.ball; return [c.map((v, i) => v - r[i]), c.map((v, i) => v + r[i])]; }
  if (pr.cyl) {
    const [a, r, h] = pr.cyl, ax = AXIS[pr.axis ?? 'y'];
    return [a.map((v, i) => (i === ax ? v : v - r)), a.map((v, i) => (i === ax ? v + h : v + r))];
  }
  if (pr.capsule) { const [a, b, r] = pr.capsule; return [a.map((v, i) => Math.min(v, b[i]) - r), a.map((v, i) => Math.max(v, b[i]) + r)]; }
  return [[0, 0, 0], [Infinity, Infinity, Infinity]];
}

// A tile's accepted colours per canonical port: arrays of colour codes, preferred first.
export function portAccepts(tile) {
  return PORTS.map((name, i) => {
    const s = tile.ports?.[name] ?? (i < SIDE_PORTS ? DEFAULT_SIDE : DEFAULT_SHAFT);
    const cols = [...s].map((ch) => {
      const c = COL_LETTER[ch];
      if (c === undefined || (i >= SIDE_PORTS && !'-S'.includes(ch)) || (i < SIDE_PORTS && ch === 'S')) {
        throw new Error(`wang: tile ${tile.name} port ${name}: bad colour '${ch}'`);
      }
      return c;
    });
    return cols;
  });
}

// ---- variants: one authored tile, several rasterized versions (Noita's rooms
// vary per placement in what they hold, not in their shape). A tile with
// `variants: N` becomes N tiles of weight / N, each with its prims resolved by
// its own random stream (fixed by the kit, so the checks walk every variant);
// the tiling picks among them per placement, by the bake's seed. Resolved:
//   { ..., chance: p }                  kept in about p of the variants
//   { ..., m: { WATER: 6, OIL: 1 } }    a material picked by weight
//   { any: [[prims], [prims], ...], weights }   one of the lists (a list may be [])
//   [prims]                             a nested list, flattened
// and scatter prims draw their spots from the variant's stream (tile.vseed).
const VARIANT_SALT = 0x7a71;
const VSEED_STRIDE = 4099;              // a tile's variants' streams, apart from the next tile's
const pickWeighted = (w, r) => {
  let pick = r() * w.reduce((s, v) => s + v, 0), i = 0;
  while (i < w.length - 1 && (pick -= w[i]) >= 0) i++;
  return i;
};
// Each resolved prim keeps the salt of its authored place (its noise stream),
// so a variant's rock is its tile's whatever the variant drops.
const NEST_SALT = 64;                   // a nested list's prims' salts: its place's × this + theirs
const isRandom = (pr) => Array.isArray(pr) || pr.chance !== undefined || pr.any || (pr.m && typeof pr.m === 'object') || pr.scatter;
function resolvePrims(prims, r, base = 0) {
  const out = [];
  for (const [i, pr] of prims.entries()) {
    const salt = base * NEST_SALT + i;
    if (Array.isArray(pr)) { out.push(...resolvePrims(pr, r, salt + 1)); continue; }
    if (pr.chance !== undefined && r() >= pr.chance) { if (pr.any) r(); continue; }
    if (pr.any) { const k = pickWeighted(pr.weights ?? pr.any.map(() => 1), r); out.push(...resolvePrims(pr.any[k], r, (salt + 1) * NEST_SALT + k)); continue; }
    const q = { salt, ...pr };
    delete q.chance;
    if (q.m && typeof q.m === 'object') { const ent = Object.entries(q.m); q.m = ent[pickWeighted(ent.map(([, v]) => v), r)][0]; }
    if (q.scatter && (q.n ?? 1) > 1 && q.put?.some(isRandom)) {
      // each copy resolves its own `put` (a shelf of different crates), its own spot stream
      for (let k = 0; k < q.n; k++) out.push({ ...q, n: 1, salt: salt * NEST_SALT + k + 1, put: resolvePrims(q.put, r, salt + 1) });
      continue;
    }
    if (q.put) q.put = resolvePrims(q.put, r, salt + 1);
    out.push(q);
  }
  return out;
}
function expandVariants(tiles) {
  return tiles.flatMap((t, ai) => {
    const n = t.variants ?? 1;
    // a plain tile (or one already compiled) stays as it is
    if (t.noise !== undefined || (n === 1 && !t.prims.some(isRandom))) return [{ ...t, noise: t.noise ?? ai }];
    return Array.from({ length: n }, (_, v) => {
      // mulberry32 (tiling.js rng) seeded by the tile and variant: an even stream
      let a = Math.floor(hash3(ai, v, 0, VARIANT_SALT) * 4294967296) >>> 0;
      const r = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let q = Math.imul(a ^ (a >>> 15), a | 1);
        q ^= q + Math.imul(q ^ (q >>> 7), q | 61);
        return ((q ^ (q >>> 14)) >>> 0) / 4294967296;
      };
      return { ...t, name: n > 1 ? `${t.name} ~${v}` : t.name, weight: (t.weight ?? 1) / n, variants: undefined, prims: resolvePrims(t.prims, r), noise: ai, vseed: ai * VSEED_STRIDE + v + 1 };
    });
  });
}

// Check and normalize a kit: { name, palette, temps, tiles }. A tile may also say
// `deepest: n`: placed only in the region's n lowest layers (Noita's lava lies
// low), `variants` (above), `max: n`: at most n placements in a region (Noita's
// rare pools: one a level), and `offPath: true`: never on the main path
// (hazards: burning coal, liquid nitrogen).
export function compileKit(kit) {
  if (!kit.tiles?.length) throw new Error(`wang: kit ${kit.name} has no tiles`);
  const palette = { ...DEFAULT_PALETTE, ...(kit.palette ?? {}) };
  const tiles = expandVariants(kit.tiles).map((t, i) => ({ ...t, index: i, weight: t.weight ?? 1, accepts: portAccepts(t), sites: t.sites ?? [], torches: t.torches ?? kit.torches }));
  // a kit must have a tile that takes every colour on every port, so a slot always has a tile
  const universal = tiles.filter((t) => t.accepts.every((cols, i) => (i < SIDE_PORTS ? [0, 1, 2, 3] : [0, 1]).every((c) => cols.includes(c))));
  if (!universal.length) throw new Error(`wang: kit ${kit.name} needs a tile accepting every colour on every port (its fallback)`);
  return { ...kit, palette, tiles, geom: { ...GEOM, ...(kit.geom ?? {}) } };
}
