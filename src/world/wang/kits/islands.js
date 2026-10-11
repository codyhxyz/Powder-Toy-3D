// Open-kit building blocks (kit geom.OPEN, docs/wang-tiles.md "Open kits"):
// Noita's Coal Pits and Snowy Depths are not tunnels through rock but a dark
// void full of floating ribbons and blobs of rock (or marbled ice), joined by
// timber planks, with pools sitting inside the blobs, scaffolds standing in
// the void and things hung over drops. A tile here starts as air; its
// islands are the prims.
//
// The one rule that makes a layer walkable: every tile has a SPINE, a ribbon
// whose walking top is y = SPINE, reaching the middle of each of its six
// faces (W and E at z = MID; N and S at both units' centres, x = C0, C1).
// Neighbouring tiles meet face to face there whatever the tiling's
// transform, so a layer is one walk; the voids between the ribbons drop the
// body to the layer below. scripts/check-wang.mjs walks each tile's spine to
// every face (mirrored too). Every tile rings both units' centres with walkway:
// where the tiling opens a floor shaft the sampler cuts it down through the
// spine there (tiling.js cutPorts), and the ring walks round it. The way out
// of the bottom layer is such a hole over the temple's shaft; the way in
// lands on a ring (the tiling never opens a unit's floor under its ceiling).
import { GEOM } from '../kit.js';

export const { U, H, DOOR_W, SHAFT_W } = GEOM;
export const X = 2 * U;                    // a tile's length
export const MID = U / 2;                  // the W/E faces' middle, z; a unit's centre
export const C0 = U / 2, C1 = U + U / 2;   // unit 0's and unit 1's centre, x
export const SPINE = 8;                    // the spine's walking top, cells over the tile's bottom
export const HEAD = 10;                    // cells kept clear over a walkway (a body is 6, a jump 2, and some)
export const STRIP = 3;                    // a walkway's half-width (6 wide: room to pass what stands on it)
export const PLANK_W = 2;                  // a plank's half-width
export const PLANK_SPUR = 0.4;             // chance a spur is a timber walkway over the void, not a ribbon of rock
export const DECK_T = 3;                   // the walkway's crisp top slab, cells thick
export const RING = 6;                     // a unit centre's ring of walkway, this far each way (round a SHAFT_W hole: 6 cells of walk)
export const BODY_DROP = 5;                // a ribbon's body hangs this far under its top...
export const BODY_R = [3.5, 5];            // ...as blobs of this half-width (cells), each its own: a ribbon, not a slab
export const ROUGH_BODY = 2;             // cells of noise on a ribbon's or a blob's underside
export const LUMP = 9;                     // cells of ribbon a blob covers

// The tile's own seeded stream (mulberry32): the kit is data, the same every load.
export function stream(seed) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.between = (a, b) => a + (b - a) * r();
  r.pick = (a) => a[Math.floor(r() * a.length)];
  return r;
}

const SALT0 = 2000;                        // shared noise streams (past any prim index)
let salt = SALT0;

// The spine's rock: lumpy ribbons along x (z = MID) and along z at both units' centres (x = C0,
// C1), their tops sliced flat at SPINE. m: the island material. holes: which units' centres open
// down (D ports). gap: [x0, x1] where the x ribbon breaks (a plank crosses it; see plankX).
export function spineBody(r, { m = 'ROCK', holes = [0, 1], gap = null, spurs = [0, 1], planked = [] } = {}) {
  const s = salt++, out = [];
  const lumps = (a, b, along) => {
    for (let t = a; t < b; t += LUMP) {
      const c = t + r.between(0, LUMP);
      const rr = r.between(...BODY_R), drop = BODY_DROP + r.between(-1, 2);
      if (along === 'x') out.push({ ball: [[c, SPINE - drop / 2, MID + r.between(-1, 1)], [LUMP * 0.75, drop, rr]], m, rough: ROUGH_BODY, salt: s });
      else out.push({ ball: [[along, SPINE - drop / 2, c], [rr, drop, LUMP * 0.75]], m, rough: ROUGH_BODY, salt: s });
    }
  };
  if (gap) { lumps(-3, gap[0] - 2, 'x'); lumps(gap[1] + 2, X + 3, 'x'); } else lumps(-3, X + 3, 'x');
  for (const u of spurs) if (!planked.includes(u)) lumps(-3, U + 3, u ? C1 : C0);
  // the hole's ring: a broader blob round the unit's centre
  for (const u of holes) out.push({ ball: [[u ? C1 : C0, SPINE - 3, MID], [RING + 1, BODY_DROP + 1, RING + 1]], m, rough: ROUGH_BODY, salt: s });
  return out;
}
// ...its walking top: clear HEAD cells over the walkways, then their crisp slabs (after every
// island, so nothing hangs into the headroom), then the holes
// the walkways in plan, [[x0, z0], [x1, z1]] each
export function spineStrips({ holes = [0, 1], gap = null, spurs = [0, 1], planked = [] } = {}) {
  const strips = [];
  if (gap) strips.push([[-1, MID - STRIP], [gap[0], MID + STRIP]], [[gap[1], MID - STRIP], [X + 1, MID + STRIP]]);
  else strips.push([[-1, MID - STRIP], [X + 1, MID + STRIP]]);
  for (const u of spurs) if (!planked.includes(u)) { const c = u ? C1 : C0; strips.push([[c - STRIP, -1], [c + STRIP, U + 1]]); }
  for (const u of holes) { const c = u ? C1 : C0; strips.push([[c - RING, MID - RING], [c + RING, MID + RING]]); }
  return strips;
}
export function spineDeck({ m = 'ROCK', holes = [0, 1], gap = null, spurs = [0, 1], planked = [] } = {}) {
  const out = [], strips = spineStrips({ holes, gap, spurs, planked });
  // a planked spur: a timber walkway from the ring out to the face, headroom over it
  for (const u of planked) {
    const c = u ? C1 : C0;
    out.push({ box: [[c - PLANK_W, SPINE, -1], [c + PLANK_W, SPINE + HEAD, U + 1]], m: 'AIR' });
    out.push({ box: [[c - PLANK_W, SPINE - 1, -1], [c + PLANK_W, SPINE, U + 1]], m: 'WOOD' });
  }
  for (const [a, b] of strips) out.push({ box: [[a[0], SPINE, a[1]], [b[0], SPINE + HEAD, b[1]]], m: 'AIR' });
  for (const [a, b] of strips) out.push({ box: [[a[0], SPINE - DECK_T, a[1]], [b[0], SPINE, b[1]]], m });
  return out;
}
// a timber plank along x over a gap, its top the spine's (Noita's plank bridges)
export const plankX = (x0, x1, z = MID, y = SPINE) => ({ box: [[x0, y - 1, z - PLANK_W], [x1, y, z + PLANK_W]], m: 'WOOD' });
// a floating blob: a rough ellipsoid of island (its top flattened by a slab where it is walked on)
export const blob = (c, r, m = 'ROCK', rough = ROUGH_BODY) => ({ ball: [c, r], m, rough, salt: salt++ });
// a vein or lens of mat threading an island's material (coal seams, gold, marbling)
export const vein = (c, r, mat, inside = 'ROCK', rough = 1.5) => ({ ball: [c, r], m: mat, only: inside, rough });
// a basin let into an island's top at (x, y, z): a lens of liquid where island was (a pool
// sitting inside a blob), its surface at y
export const basin = (x, y, z, rx, depth, rz, liquid, inside = 'ROCK') => ({ ball: [[x, y, z], [rx, depth, rz]], m: liquid, only: [].concat(inside) });
// a pocket sealed inside an island (water or toxic you dig into, oil that seeps out of a cut face)
export const pocket = (c, r, liquid, inside = 'ROCK') => ({ ball: [c, r], m: liquid, only: [].concat(inside) });
// a heap of powder on a surface at y (its slope a body walks over: a cell up a step)
export const HEAP_SLOPE = 0.55;
export const heap = (x, y, z, r, m) => ({ ball: [[x, y, z], [r, r * HEAP_SLOPE, r]], m, only: 'AIR', rough: 0.6 });
// a timber post / a vertical chain (a 1-cell column) from y0 up to y1
export const post = (x, z, y0, y1, m = 'WOOD') => ({ box: [[x, y0, z], [x + 1, y1, z + 1]], m });
// a barrel standing at (x, y, z): a timber shell round a fill (OIL: it burns; GUNPOWDER: a powder
// keg; WHISKEY, HEALTHIUM: Noita's caches). Timber insulates: what's in it keeps its warmth.
export const BARREL_R = 1.6, BARREL_H = 4;
export const barrel = (x, y, z, fill) => [
  { cyl: [[x, y, z], BARREL_R, BARREL_H], axis: 'y', m: 'WOOD' },
  { cyl: [[x, y + 1, z], BARREL_R - 0.9, BARREL_H - 2], axis: 'y', m: fill },
];
// a timber cage (posts and a rim) round a heap of powder at (x, y, z): Noita fences its loose
// powders in so they don't spill into the void
export function cage(x, y, z, r, fill, h = 4) {
  const out = [heap(x, y, z, r, fill), { ball: [[x, y, z], [r - 0.5, h - 1, r - 0.5]], m: fill, only: 'AIR' }];
  for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) out.push(post(Math.round(x + dx * r), Math.round(z + dz * r), y, y + h));
  out.push({ box: [[x - r, y + h - 1, z - r], [x + r + 1, y + h, z - r + 1]], m: 'WOOD' }, { box: [[x - r, y + h - 1, z + r], [x + r + 1, y + h, z + r + 1]], m: 'WOOD' });
  out.push({ box: [[x - r, y, z - r], [x + r + 1, y + 1, z + r + 1]], m: 'WOOD', only: 'AIR' });
  return out;
}
// a mine cart at (x, y, z) along x: an iron box full of coal (or scrap), on rails
export const cart = (x, y, z, fill = 'BROKENCOAL') => [
  { box: [[x, y, z - 2], [x + 6, y + 3, z + 2]], m: 'METAL' },
  { box: [[x + 1, y + 1, z - 1], [x + 5, y + 4, z + 1]], m: fill },
];
export const railsX = (x0, x1, z, y = SPINE) => [
  { box: [[x0, y, z - 2], [x1, y + 1, z - 1]], m: 'RAIL' },
  { box: [[x0, y, z + 1], [x1, y + 1, z + 2]], m: 'RAIL' },
];
// a scaffold tower: four posts from y0 up to a deck at y1 (its top), standing in the void
export function scaffold(x, z, y0, y1, w = 4) {
  return [post(x, z, y0, y1), post(x + w, z, y0, y1), post(x, z + w, y0, y1), post(x + w, z + w, y0, y1),
    { box: [[x, y1 - 1, z], [x + w + 1, y1, z + w + 1]], m: 'WOOD' },
    { box: [[x, Math.round((y0 + y1) / 2), z], [x + w + 1, Math.round((y0 + y1) / 2) + 1, z + 1]], m: 'WOOD' }];
}
// a platform hung on two chains from an anchor over it (Noita's swing over a drop): its top at y,
// along x from x0 (w long) at z, the chains up to y1
export const swing = (x0, w, z, y, y1, chain = 'METAL') => [
  { box: [[x0, y - 1, z - 2], [x0 + w, y, z + 2]], m: 'WOOD' },
  post(x0, z, y, y1, chain), post(x0 + w - 1, z, y, y1, chain),
];
// An open tile takes any colour on its sides and lets a shaft in from above anywhere (no
// doorways are cut, so a side's colour means nothing to it; it falls in or out where it can):
// its rings take a floor shaft cut through them too.
const OPEN_SIDE = 'DHR-', OPEN_SHAFT = 'S-';
export const openTiles = (tiles) => tiles.map((t) => ({
  ...t,
  ports: { W: OPEN_SIDE, E: OPEN_SIDE, N0: OPEN_SIDE, N1: OPEN_SIDE, S0: OPEN_SIDE, S1: OPEN_SIDE, U0: OPEN_SHAFT, U1: OPEN_SHAFT, D0: OPEN_SHAFT, D1: OPEN_SHAFT, ...t.ports },
}));
// n blobs scattered in the voids between the ribbons, low (a drop off the spine) or high (over
// the void), each its own size: Noita's islands are anything but a grid
const SCATTER_X = [[0, 6], [18, 30], [42, 48]], SCATTER_Z = [[0, 5], [19, 24]];
const SCATTER_LOW = [1, 5], SCATTER_HIGH = [16, 22];
export function scatter(r, n, m = 'ROCK') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const xs = r.pick(SCATTER_X), zs = r.pick(SCATTER_Z), y = r() < 0.5 ? r.between(...SCATTER_LOW) : r.between(...SCATTER_HIGH);
    out.push(blob([r.between(...xs), y, r.between(...zs)], [r.between(3, 7), r.between(1.5, 3), r.between(2.5, 5)], m));
  }
  return out;
}
