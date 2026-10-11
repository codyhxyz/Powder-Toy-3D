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
  // ...and the Coal Pits' and Snowy Depths' own (EMBER: coal laid down burning, the kit's temps)
  SNOW: 36, SALTWATER: 37, LIQUID_NITROGEN: 38, DRY_ICE: 39, BRICK: 40, BROKENCOAL: 41, SCRAP: 42,
  EMBER: 43,
};
export const MAT_COUNT = 44;
// A kit's temps: { CODE: °C } lays those codes down at that temperature instead
// of their element's spawn temperature (EMBER burning, a lake's water above
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
  EMBER: 'COAL',
};
// liquids a body swims through (the walk checks); TOXIC, ACID, LAVA and
// LIQUID_NITROGEN hurt, so the checks treat them as walls: a path never needs a swim through them
const LIQUIDS = [MAT.WATER, MAT.OIL, MAT.BLOOD, MAT.SLIME, MAT.MUD, MAT.WHISKEY,
  MAT.TELEPORTATIUM, MAT.LEVITATIUM, MAT.BERSERKIUM, MAT.HEALTHIUM, MAT.POLYMORPHINE, MAT.SALTWATER];
// can a body pass through it (air or a liquid: you swim)
export const passable = (m) => m === MAT.AIR || LIQUIDS.includes(m) || m === WANG_OUT;
export const isLiquid = (m) => LIQUIDS.includes(m);

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
export function rasterTile(tile, index, G = GEOM) {
  // an open kit's tiles (geom.OPEN: Noita's Coal Pits and Snowy Depths, islands in a void) start
  // as air and keep no border: they meet their neighbours wherever their islands do
  const X = 2 * G.U, Y = G.H, Z = G.U, out = new Uint8Array(X * Y * Z).fill(G.OPEN ? MAT.AIR : MAT.ROCK);
  const at = (x, y, z) => x + X * (y + Y * z);
  for (const pr of tile.prims) {
    const m = codeOf(pr.m ?? 'AIR');
    const only = pr.only === undefined ? null : new Set([].concat(pr.only).map(codeOf));
    const rough = pr.rough ?? 0;
    const salt = NOISE_SALT + index * NOISE_TILE_STRIDE + (pr.salt ?? tile.prims.indexOf(pr)) * NOISE_PRIM_STRIDE;
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
  // the border: rock at every face, so a tile meets its neighbours only through its ports
  if (!G.OPEN) for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
    if (x < G.BORDER || x >= X - G.BORDER || z < G.BORDER || z >= Z - G.BORDER || y < G.BORDER || y >= Y - G.BORDER) {
      out[at(x, y, z)] = MAT.ROCK;
    }
  }
  return out;
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

// Check and normalize a kit: { name, palette, temps, tiles }. A tile may also carry
//   layers: [lo, hi]   the layers it may be placed in, 0 the bottom (Coal Pits' lava: the lowest only)
//   max: n             at most n placements in a region (Noita's rare pools: one a level)
//   offPath: true      never on the main path (hazards: burning coal, liquid nitrogen)
export function compileKit(kit) {
  if (!kit.tiles?.length) throw new Error(`wang: kit ${kit.name} has no tiles`);
  const palette = { ...DEFAULT_PALETTE, ...(kit.palette ?? {}) };
  const tiles = kit.tiles.map((t, i) => ({ ...t, index: i, weight: t.weight ?? 1, accepts: portAccepts(t), sites: t.sites ?? [] }));
  // a kit must have a tile that takes every colour on every port, so a slot always has a tile
  const universal = tiles.filter((t) => t.accepts.every((cols, i) => (i < SIDE_PORTS ? [0, 1, 2, 3] : [0, 1]).every((c) => cols.includes(c))));
  if (!universal.length) throw new Error(`wang: kit ${kit.name} needs a tile accepting every colour on every port (its fallback)`);
  return { ...kit, palette, tiles, geom: { ...GEOM, ...(kit.geom ?? {}) } };
}
