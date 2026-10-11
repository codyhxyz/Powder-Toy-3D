// The 3D herringbone Wang tiling: which tile goes where, and the CPU sampler
// over the result (wangCellJS). Pure JS, deterministic from a seed.
//
// After Sean Barrett's herringbone Wang tiles (stb_herringbone_wang_tile.h,
// public domain, 2014; "Herringbone Wang Tiles", nothings.org): a plane tiled
// by 2:1 bricks in a herringbone, edges coloured, each brick filled with a
// hand-made tile whose edge colours match its neighbours'. Square Wang tiles
// line up in rows and columns, and the eye finds the grid; herringbone bricks
// never share a long straight seam, so it can't. Noita builds its biomes this
// way (its data/wang_tiles templates). Wang cubes (Culik & Kari 1995; Lagae &
// Dutre's "An Alternative for Wang Tiles: Colored Edges versus Colored Corners"
// for the colouring) take it to 3D with colours on all six faces; this is a
// cheaper 3D variant that keeps Barrett's 2D herringbone in every horizontal
// layer and joins layers through unit-sized shafts.
//
// One layer, seen from above (x right, z down; a box a unit, U cells square;
// "=" a unit of a brick long along x, "|" of one long along z; drawn by brickAt):
//
//   +---+---+---+---+---+---+---+---+---+---+
//   | =   = | | | | | =   = | | | | | =   = |     unit (i, k), u = (i - k) mod 4:
//   +---+---+---+   +---+---+---+   +---+---+       u = 0, 1: the low / high half of a
//   | | | =   = | | | | | =   = | | | | | = |       brick along x
//   +   +---+---+---+   +---+---+---+   +---+       u = 2, 3: the high / low half of a
//   | | | | | =   = | | | | | =   = | | | | |       brick along z (its other unit at
//   +---+   +---+---+---+   +---+---+---+   +       k - 1 / k + 1)
//   | = | | | | | =   = | | | | | =   = | | |
//   +---+---+   +---+---+---+   +---+---+---+     each row steps a unit: the bricks
//   | =   = | | | | | =   = | | | | | =   = |     climb in diagonals, and no seam
//   +---+---+---+---+---+---+---+---+---+---+     runs straight across
//
// Layers are H cells tall, stacked; each layer's herringbone is shifted by
// whole units (and some layers transposed, so the diagonals cross) from the
// one above, so no vertical seam runs through the stack either. A brick's ten
// ports (kit.js) open onto its six side neighbours (W, E, N0, N1, S0, S1) and,
// unit by unit, onto the bricks above and below (shafts U0, U1, D0, D1): a
// unit of one layer sits exactly over a unit of the next, whatever their
// bricks.
//
// Generation (on the CPU, once per world, like the island's column bake):
//   1. lay the bricks; a brick sticking out of the region is solid rock;
//   2. the main path (Noita's: you can always go down): from the entry brick
//      in the top layer, a wandering walk across each layer (Dijkstra over
//      jittered costs) to a target on the far side, then a shaft down to the
//      next layer, zig-zagging, to the exit brick in the bottom layer;
//   3. extra doorways (loops, as Noita's tunnels braid) and extra shafts;
//   4. repair: a search from the entry (doorways both ways, shafts only down:
//      you fall) and, while a brick is unreached, open an edge from a reached
//      brick to it, so every brick is reachable from the entry;
//   5. tiles: brick by brick, a weighted pick among the kit's tiles and their
//      placements whose accepted colours match every edge (closed, open and
//      already coloured by a neighbour); a still-free open edge takes the
//      tile's preferred colour. The kit's universal tile takes anything, so
//      a pick always exists (compileKit insists on one).
import { GEOM, COL, PORTS, SIDE_PORTS, MAT, WANG_OUT, rasterTile, compileKit, openCap } from './kit.js';

// ---- generation constants
const P_LOOP = 0.32;          // chance a closed doorway between two bricks opens anyway (loops)
const P_SHAFT = 0.07;         // chance a unit's floor opens into the layer below anyway
const PATH_JITTER = 3;        // a path step costs 1 + up to this much: how much the main path wanders
const PATH_TARGET_SIDE = 0.2; // the main path's targets sit this share in from the region's x sides
const PATH_TARGET_Z = 0.3;    // ...and within this share of the middle in z
const PREFER_FIRST = 0.6;     // chance a free edge takes its tile's first open colour (else any it accepts)
const SALT_PATTERN = 0x7a11, SALT_PATH = 0x7a12, SALT_OPEN = 0x7a13, SALT_TILES = 0x7a14;
export const SOLID_TILE = 255;         // placement: a brick that is solid rock
export const ATLAS_MAX = 256;          // a 3D texture's side WebGL2 guarantees (MAX_3D_TEXTURE_SIZE)
const XF_TRANSPOSE = 4;                // transform bits: 1 mirror x, 2 mirror z, 4 transpose (an upright brick)
const XF_SECOND = 8;                   // placement G: this unit is its brick's second

// mulberry32: a small seeded PRNG
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mix = (seed, salt) => (Math.imul(seed ^ salt, 0x9e3779b1) ^ (salt << 7)) >>> 0;

// Layer l's herringbone: a whole-unit shift and maybe a transpose.
export function layerPattern(seed, l) {
  const r = rng(mix(seed, SALT_PATTERN + l * 131));
  return { sx: Math.floor(r() * 4), sz: Math.floor(r() * 4), swap: l % 2 === 1 };
}
// Unit (i, k)'s brick in a layer: its anchor (low unit), whether it's long along z, whether (i, k) is its second unit.
export function brickAt(i, k, pat) {
  const p = (pat.swap ? k + pat.sz : i + pat.sx), q = (pat.swap ? i + pat.sx : k + pat.sz);
  const u = (((p - q) % 4) + 4) % 4;
  let ap = p, aq = q, alongP;
  if (u === 0) alongP = true;
  else if (u === 1) { alongP = true; ap = p - 1; }
  else if (u === 2) { alongP = false; aq = q - 1; }
  else alongP = false;
  const dp = ap - p, dq = aq - q;                       // anchor - unit, in pattern axes
  const di = pat.swap ? dq : dp, dk = pat.swap ? dp : dq;
  return { ai: i + di, ak: k + dk, longZ: pat.swap ? alongP : !alongP, second: di !== 0 || dk !== 0 };
}

// A canonical port's placed unit offset and outward direction under transform xf.
function placedPort(p, xf) {
  const name = PORTS[p];
  const j = name === 'W' ? 0 : name === 'E' ? 1 : Number(name[1]);
  let dcx = 0, dcz = 0, dy = 0;
  if (name === 'W') dcx = -1; else if (name === 'E') dcx = 1;
  else if (name[0] === 'N') dcz = -1; else if (name[0] === 'S') dcz = 1;
  else dy = name[0] === 'U' ? 1 : -1;
  const mx = xf & 1, mz = xf & 2, tr = xf & XF_TRANSPOSE;
  const aUnit = mx ? 1 - j : j, da = mx ? -dcx : dcx, db = mz ? -dcz : dcz;
  return tr ? { ou: [0, aUnit], d: [db, da], dy } : { ou: [aUnit, 0], d: [da, db], dy };
}
const PLACED = Array.from({ length: 8 }, (_, xf) => PORTS.map((_, p) => placedPort(p, xf)));

// The tiling of a region nx × ny × nz units (ny layers). Returns bricks, edges and placement.
export function generateTiling({ kit: rawKit, seed, units, entry, exit }) {
  const kit = rawKit.tiles[0]?.accepts ? rawKit : compileKit(rawKit);
  const [nx, ny, nz] = units;
  const pats = Array.from({ length: ny }, (_, l) => layerPattern(seed, l));
  // 1. bricks
  const unitBrick = new Int32Array(nx * ny * nz).fill(-1);
  const uIdx = (i, l, k) => i + nx * (k + nz * l);
  const inside = (i, k) => i >= 0 && k >= 0 && i < nx && k < nz;
  const bricks = [];
  for (let l = 0; l < ny; l++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const b = brickAt(i, k, pats[l]);
    if (b.second) continue;
    const units2 = [[b.ai, b.ak], b.longZ ? [b.ai, b.ak + 1] : [b.ai + 1, b.ak]];
    if (!units2.every(([a, c]) => inside(a, c))) continue;   // a brick sticking out: solid
    const id = bricks.length;
    bricks.push({ id, l, ai: b.ai, ak: b.ak, longZ: b.longZ, units: units2 });
    for (const [a, c] of units2) unitBrick[uIdx(a, l, c)] = id;
  }
  // (a brick whose anchor lies outside the region is never laid: its inside unit stays -1, solid)
  const brickOfUnit = (i, l, k) => (inside(i, k) && l >= 0 && l < ny ? unitBrick[uIdx(i, l, k)] : -1);

  // a brick's placed edges, canonical port order for its orientation (xf 0 or transpose)
  const edgeKey = (l, i, k, d, dy) => {
    if (dy > 0) return `v${l},${i},${k}`;
    if (dy < 0) return `v${l - 1},${i},${k}`;
    if (d[0]) return `x${l},${d[0] > 0 ? i : i - 1},${k}`;
    return `z${l},${i},${d[1] > 0 ? k : k - 1}`;
  };
  for (const b of bricks) {
    const xf = b.longZ ? XF_TRANSPOSE : 0;
    b.edges = PLACED[xf].map((pp) => {
      const i = b.ai + pp.ou[0], k = b.ak + pp.ou[1];
      const key = edgeKey(b.l, i, k, pp.d, pp.dy);
      const nb = pp.dy ? brickOfUnit(i, b.l + pp.dy, k) : brickOfUnit(i + pp.d[0], b.l, k + pp.d[1]);
      return { key, nb, unit: [i, k], dy: pp.dy };
    });
  }
  const open = new Map();     // edge key -> true (open)
  const colour = new Map();   // edge key -> colour, once fixed
  const nbs = (b) => b.edges.filter((e) => e.nb >= 0 && !e.dy).map((e) => [e.nb, e.key]);

  // 2. the main path
  const R = rng(mix(seed, SALT_PATH));
  const nearestLive = (l, i, k) => {
    let best = -1, bd = Infinity;
    for (const b of bricks) if (b.l === l) {
      for (const [a, c] of b.units) {
        const d = (a - i) ** 2 + (c - k) ** 2;
        if (d < bd) { bd = d; best = b.id; }
      }
    }
    return best;
  };
  const entryUnit = entry ?? [Math.floor(nx * PATH_TARGET_SIDE), Math.floor(nz / 2)];
  const exitUnit = exit ?? [Math.ceil(nx * (1 - PATH_TARGET_SIDE)) - 1, Math.floor(nz / 2)];
  const entryBrick = nearestLive(ny - 1, ...entryUnit);
  const exitBrick = nearestLive(0, ...exitUnit);
  if (entryBrick < 0 || exitBrick < 0) throw new Error('wang: the region holds no whole brick');
  const unitNear = (b, [i, k]) => b.units.reduce((best, u) => ((u[0] - i) ** 2 + (u[1] - k) ** 2 < (best[0] - i) ** 2 + (best[1] - k) ** 2 ? u : best));
  const entryEdge = bricks[entryBrick].edges.find((e) => e.dy > 0 && e.unit.join() === unitNear(bricks[entryBrick], entryUnit).join());
  const exitEdge = bricks[exitBrick].edges.find((e) => e.dy < 0 && e.unit.join() === unitNear(bricks[exitBrick], exitUnit).join());
  open.set(entryEdge.key, true); colour.set(entryEdge.key, COL.SHAFT);
  open.set(exitEdge.key, true); colour.set(exitEdge.key, COL.SHAFT);

  const walk = (from, to) => {   // Dijkstra over jittered costs within a layer; opens the path's doorways
    const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
    const cost = new Map();
    while (true) {
      let cur = -1, cd = Infinity;
      for (const [b, d] of dist) if (!done.has(b) && d < cd) { cd = d; cur = b; }
      if (cur < 0 || cur === to) break;
      done.add(cur);
      for (const [nb, key] of nbs(bricks[cur])) {
        if (!cost.has(key)) cost.set(key, 1 + R() * PATH_JITTER);
        const nd = cd + cost.get(key);
        if (nd < (dist.get(nb) ?? Infinity)) { dist.set(nb, nd); prev.set(nb, [cur, key]); }
      }
    }
    const path = [to];
    for (let b = to; b !== from;) {
      const [p, key] = prev.get(b);
      open.set(key, true);
      path.unshift(p);
      b = p;
    }
    return path;
  };
  // A shaft may not continue straight on through the brick below (a unit's floor and
  // ceiling both open): a fall would pass the brick by, and the search above would
  // count it reached when nothing lands in it.
  const shaftOk = (e) => {
    if (!e.dy) return true;
    const [l, i, k] = e.key.slice(1).split(',').map(Number);
    return !open.has(`v${l - 1},${i},${k}`) && !open.has(`v${l + 1},${i},${k}`);
  };
  const canDrop = (e) => e.dy < 0 && e.nb >= 0 && shaftOk(e);
  const mainPath = [];
  let cur = entryBrick;
  for (let l = ny - 1; l >= 0; l--) {
    let target;
    if (l === 0) target = exitBrick;
    else {
      // zig-zag: the far side from where this layer starts
      const [ci] = bricks[cur].units[0];
      const side = ci < nx / 2 ? 1 - PATH_TARGET_SIDE : PATH_TARGET_SIDE;
      const ti = Math.floor(nx * side + (R() - 0.5) * nx * PATH_TARGET_SIDE);
      const tk = Math.floor(nz / 2 + (R() - 0.5) * 2 * nz * PATH_TARGET_Z);
      target = nearestLive(l, ti, tk);
    }
    mainPath.push(...walk(cur, target).filter((b, i, a) => !(i === 0 && mainPath.at(-1) === b)));
    cur = target;
    if (l > 0) {
      // drop: a unit of this brick whose brick below is whole
      const downs = bricks[cur].edges.filter(canDrop);
      if (!downs.length) {
        // no whole brick under (or only under the shaft it came in by): walk on to the nearest that has one
        const [ci, ck] = bricks[cur].units[0];
        const alt = bricks.filter((b) => b.l === l && b.edges.some(canDrop))
          .sort((a, b) => (a.units[0][0] - ci) ** 2 + (a.units[0][1] - ck) ** 2 - (b.units[0][0] - ci) ** 2 - (b.units[0][1] - ck) ** 2)[0];
        mainPath.push(...walk(cur, alt.id).slice(1));
        cur = alt.id;
      }
      const d = bricks[cur].edges.filter(canDrop);
      const e = d[Math.floor(R() * d.length)];
      open.set(e.key, true);
      cur = e.nb;
      mainPath.push(cur);
    }
  }

  // 3. loops and extra shafts
  const RO = rng(mix(seed, SALT_OPEN));
  for (const b of bricks) for (const e of b.edges) {
    if (e.nb < 0 || e.nb < b.id) continue;          // each edge once, between whole bricks
    if (open.has(e.key)) continue;
    if (RO() < (e.dy ? kit.shafts ?? P_SHAFT : kit.loops ?? P_LOOP) && shaftOk(e)) open.set(e.key, true);
  }
  // 4. repair: every brick reachable from the entry (doorways both ways, shafts down)
  const reached = new Uint8Array(bricks.length);
  const flood = () => {
    const q = [];
    for (let b = 0; b < bricks.length; b++) if (reached[b]) q.push(b);
    if (!q.length) { reached[entryBrick] = 1; q.push(entryBrick); }
    while (q.length) {
      const b = q.pop();
      for (const e of bricks[b].edges) {
        if (e.nb < 0 || reached[e.nb] || !open.has(e.key) || e.dy > 0) continue;
        reached[e.nb] = 1; q.push(e.nb);
      }
    }
  };
  flood();
  for (;;) {
    const cands = [];
    for (const b of bricks) if (reached[b.id]) for (const e of b.edges) {
      if (e.nb >= 0 && !reached[e.nb] && e.dy <= 0 && shaftOk(e)) cands.push(e);
    }
    if (!cands.length) break;
    // prefer doorways (walkable both ways) to shafts
    const doors = cands.filter((e) => !e.dy);
    const pool = doors.length ? doors : cands;
    open.set(pool[Math.floor(RO() * pool.length)].key, true);
    flood();
  }

  // 5. tiles
  const RT = rng(mix(seed, SALT_TILES));
  const place = new Array(bricks.length);
  const onPath = new Set(mainPath), placed = new Map();   // a tile's placements so far (its max)
  for (const b of bricks) {
    const xfs = b.longZ ? [4, 5, 6, 7] : [0, 1, 2, 3];
    const cands = [];
    let total = 0;
    for (const t of kit.tiles) for (const xf of xfs) {
      if (t.deepest !== undefined && b.l >= t.deepest) continue;   // a deep tile: only in the lowest layers
      if (t.max !== undefined && (placed.get(t.index) ?? 0) >= t.max) continue;   // a rare tile: at most max a region
      if (t.offPath && onPath.has(b.id)) continue;                  // a hazard: never on the main path
      // canonical port p sits on the edge PLACED[xf][p] points at; find it among b.edges
      const map = mapPorts(b, xf);
      let ok = true;
      for (let p = 0; p < PORTS.length && ok; p++) {
        const e = map[p], acc = t.accepts[p];
        if (!open.has(e.key)) ok = acc.includes(COL.CLOSED);
        else if (colour.has(e.key)) ok = acc.includes(colour.get(e.key));
        else ok = acc.some((c) => c !== COL.CLOSED);
      }
      if (ok) { cands.push([t, xf, map]); total += t.weight / xfs.length; }
    }
    if (!cands.length) throw new Error(`wang: no tile fits brick ${b.id} (the kit's universal tile should)`);
    let pick = RT() * total, chosen = cands[cands.length - 1];
    for (const c of cands) { pick -= c[0].weight / xfs.length; if (pick < 0) { chosen = c; break; } }
    const [t, xf, map] = chosen;
    const cols = map.map((e, p) => {
      if (!open.has(e.key)) return COL.CLOSED;
      if (!colour.has(e.key)) {
        const opts = t.accepts[p].filter((c) => c !== COL.CLOSED);
        colour.set(e.key, RT() < PREFER_FIRST ? opts[0] : opts[Math.floor(RT() * opts.length)]);
      }
      return colour.get(e.key);
    });
    placed.set(t.index, (placed.get(t.index) ?? 0) + 1);
    place[b.id] = { tile: t.index, xf, cols };
  }
  return { kit, units, pats, bricks, unitBrick, brickOfUnit, place, open, colour, mainPath, entryBrick, exitBrick, entryEdge, exitEdge };
}
// canonical port -> the brick's edge it lies on, under transform xf
function mapPorts(b, xf) {
  const base = b.longZ ? XF_TRANSPOSE : 0;
  return PLACED[xf].map((pp) => b.edges.find((_, q) => {
    const bp = PLACED[base][q];
    return bp.ou[0] === pp.ou[0] && bp.ou[1] === pp.ou[1] && bp.d[0] === pp.d[0] && bp.d[1] === pp.d[1] && bp.dy === pp.dy;
  }));
}

// ---- the baked form: the atlas of rasterized tiles and the per-unit placement
export function atlasLayout(kit) {
  const G = kit.geom, perCol = Math.floor(ATLAS_MAX / G.U);
  const rows = Math.ceil(kit.tiles.length / perCol);
  const dims = [2 * G.U, rows * G.H, Math.min(kit.tiles.length, perCol) * G.U];
  if (dims[1] > ATLAS_MAX) throw new Error(`wang: kit ${kit.name} has too many tiles for one atlas`);
  return { perCol, dims, origin: (t) => [0, Math.floor(t / perCol) * G.H, (t % perCol) * G.U] };
}
export function bakeAtlas(kit) {
  const G = kit.geom, lay = atlasLayout(kit), [AX, AY, AZ] = lay.dims;
  const data = new Uint8Array(AX * AY * AZ).fill(MAT.ROCK);
  const X = 2 * G.U;
  kit.tiles.forEach((t, ti) => {
    const cells = rasterTile(t, ti, G), [, y0, z0] = lay.origin(ti);
    for (let z = 0; z < G.U; z++) for (let y = 0; y < G.H; y++) {
      data.set(cells.subarray(X * (y + G.H * z), X * (y + G.H * z) + X), AX * (y0 + y + AY * (z0 + z)));
    }
  });
  return { data, dims: lay.dims, perCol: lay.perCol };
}
// placement texels: RGBA8 per unit, laid out x = unit i, y = unit k, z = layer
//   R tile (SOLID_TILE: rock)  G transform | XF_SECOND  B, A: the port colours,
//   canonical order, 2 bits a side port (B: W E N0 N1, A low nibble: S0 S1), 1 bit a shaft (A high nibble: D0 D1 U0 U1)
export function packPlacement(T) {
  const [nx, ny, nz] = T.units, data = new Uint8Array(nx * nz * ny * 4);
  for (let l = 0; l < ny; l++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const o = 4 * (i + nx * (k + nz * l)), b = T.unitBrick[i + nx * (k + nz * l)];
    if (b < 0) { data[o] = SOLID_TILE; continue; }
    const br = T.bricks[b], pl = T.place[b];
    const second = br.units[1][0] === i && br.units[1][1] === k;
    let bits = 0;
    // an open kit cuts no doorways (its tiles meet where their islands do), only the shafts
    if (!T.kit.geom.OPEN) for (let p = 0; p < SIDE_PORTS; p++) bits |= pl.cols[p] << (2 * p);
    for (let p = SIDE_PORTS; p < PORTS.length; p++) bits |= (pl.cols[p] ? 1 : 0) << (2 * SIDE_PORTS + p - SIDE_PORTS);
    data[o] = pl.tile;
    data[o + 1] = pl.xf | (second ? XF_SECOND : 0);
    data[o + 2] = bits & 0xff;
    data[o + 3] = bits >> 8;
  }
  return data;
}

// ---- the sampler's port cutting, shared shape with glsl.js wangPorts (keep them in step)
export function portHash(x, y, z) {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
const JITTER_BIT = 16;   // which bit of the hash jitters a port's wall
// code: the atlas's cell; ports: the packed 16 bits; (cx, cy, cz) canonical; r: region-relative cell
export function cutPorts(G, code, ports, cx, cy, cz, rx, ry, rz) {
  const U = G.U, half = G.DOOR_W / 2, j = ((portHash(rx, ry, rz) >>> JITTER_BIT) & 1) * G.JITTER;
  for (let p = 0; p < SIDE_PORTS; p++) {
    const c = (ports >> (2 * p)) & 3;
    if (!c) continue;
    let depth, lat;
    if (p < 2) { depth = p === 0 ? cx : 2 * U - 1 - cx; lat = cz - U / 2; }
    else { const unit = (p - 2) & 1; depth = p < 4 ? cz : U - 1 - cz; lat = cx - unit * U - U / 2; }
    if (depth >= (p < 2 ? G.PORT_DEPTH : G.PORT_DEPTH_SIDE)) continue;
    const yb = c === COL.HIGH ? G.HIGH_FLOOR : G.FLOOR;
    if (cy < yb || cy >= yb + G.DOOR_H + j || lat < -half - j || lat >= half + j) continue;
    if (cy >= yb + G.DOOR_H || lat < -half || lat >= half) { code = MAT.AIR; continue; }  // the jittered rim
    if (depth === G.FRAME_DEPTH && (lat === -half || lat === half - 1 || cy === yb + G.DOOR_H - 1)) return MAT.BEAM;
    if (c === COL.RAIL && cy === yb && (lat === -G.RAIL_GAUGE / 2 || lat === G.RAIL_GAUGE / 2 - 1)) return MAT.RAIL;
    return MAT.AIR;
  }
  for (let p = 0; p < 4; p++) {
    if (!((ports >> (2 * SIDE_PORTS + p)) & 1)) continue;
    const unit = p & 1, up = p >= 2;
    const dx = cx - unit * U - U / 2, dz = cz - U / 2, sh = G.SHAFT_W / 2;
    if (dx < -sh || dx >= sh || dz < -sh || dz >= sh) continue;
    // (an open kit's floor shaft cuts down through its spine: its tiles ring every unit's centre with walkway)
    if (up ? cy >= G.H - G.BORDER : cy < (G.OPEN ? G.SPINE + 1 : G.FLOOR + G.SHAFT_CUT)) return MAT.AIR;
  }
  return code;
}

// The CPU twin of glsl.js wangCell over a bake's arrays: the kit's material
// code at region-relative cell r (WANG_OUT outside the region).
export function makeSampler({ kit, units, atlas, placement }) {
  const G = kit.geom, [nx, ny, nz] = units, [AX, AY] = atlas.dims, U = G.U;
  return function wangAt(rx, ry, rz) {
    if (rx < 0 || ry < 0 || rz < 0) return WANG_OUT;
    const i = Math.floor(rx / U), l = Math.floor(ry / G.H), k = Math.floor(rz / U);
    if (i >= nx || l >= ny || k >= nz) return WANG_OUT;
    const o = 4 * (i + nx * (k + nz * l));
    const tile = placement[o];
    if (tile === SOLID_TILE) return MAT.ROCK;
    const g = placement[o + 1], xf = g & 7, tr = xf & XF_TRANSPOSE;
    let ai = i, ak = k;
    if (g & XF_SECOND) { if (tr) ak--; else ai--; }
    const lx = rx - ai * U, ly = ry - l * G.H, lz = rz - ak * U;
    const a = tr ? lz : lx, b = tr ? lx : lz;
    const cx = xf & 1 ? 2 * U - 1 - a : a, cz = xf & 2 ? U - 1 - b : b;
    const ty = Math.floor(tile / atlas.perCol) * G.H, tz = (tile % atlas.perCol) * U;
    const code = openCap(G, atlas.data[cx + AX * (ty + ly + AY * (tz + cz))], l, ny, ly);
    return cutPorts(G, code, placement[o + 2] | (placement[o + 3] << 8), cx, ly, cz, rx, ry, rz);
  };
}
