// The Coal Pits kit (Noita's Hiilikaivos, the biome under the Mines): dark
// rock streaked with coal seams, big rough caverns rather than dug galleries,
// pits and drops, toxic sludge pooled in the hollows, heaps of rubble and
// broken coal, a few remnants of the old workings (scaffolds, a rail spur, a
// cart), and rare gold. Noita draws it as grey coal rock round purple-black
// voids, with sludge pools and timber ledges; this kit borrows that mood, not
// its tiles.
//
// "Better than Noita": the third dimension. A bridge crosses a pit you look
// down into from the gallery storey; coal shelves overhang the cave floor;
// sludge pools lie under timber walkways; a chimney cavern runs the layer's
// full height, open to the layer above and below. Seams run at the same
// heights in every tile (STRATA), so they read as beds across the tiling.
//
// Format: kit.js (docs/wang-tiles.md). Canonical frame: x 0..48 (two units),
// y 0..24, z 0..24, cells of 0.30 m; a body is 5.5 tall and 1.6 wide, steps a
// cell and jumps about two. The border (2) is rock whatever a tile does; the
// floor is y = 2 and the gallery storey's floor y = 13.
import { GEOM } from '../kit.js';

const { U, H, BORDER: B, FLOOR: F, HIGH_FLOOR: HF, DOOR_W, DOOR_H, SHAFT_W } = GEOM;
const X = 2 * U;                       // a tile's length
const IN = [B, X - B];                 // the tile's inside, x
const INZ = [B, U - B];                // ...and z
const TOP = H - B;                     // the ceiling's underside
const MID = U / 2;                     // the W/E doorways' centre line, z; a unit's centre
const C0 = U / 2, C1 = U + U / 2;      // unit 0's and unit 1's centre, x
const DH = DOOR_W / 2;                 // half a doorway
const DECK = HF - 1;                   // a shelf's top cell: its top is the gallery storey's floor
const GAL_TOP = F + DOOR_H;            // a low doorway's top
const PAST = 4;                        // a cave box runs this far past the border, so its rough face is clipped flat by it (a floor or ceiling with no lumps to trip on)

// Roughness, cells of noise on a surface. Coal Pits caves are natural, rougher than the Mines' dug galleries.
const ROUGH_TUNNEL = 1.6;              // a crooked tunnel
const ROUGH_CAVE = 2.6;                // a cavern's walls
const ROUGH_PIT = 3.4;                 // the pits' and the great pit's walls
const ROUGH_SEAM = 1.5;                // a coal seam's edges
const ROUGH_HEAP = 0.7;                // a heap's surface

// Coal seams: beds of coal at fixed heights in every tile, so they line up across the tiling as
// strata. The border between tiles is rock, so a bed is drawn as lenses that pinch out short of
// it, each tile's in other places (a bed thins and swells; nobody sees where one tile's ends).
const STRATA = [{ y: 7, t: 1.6 }, { y: 18, t: 2 }];
const LENS_SPANS = [[[3, 20], [26, 45]], [[8, 40]], [[3, 14], [18, 34], [38, 45]], [[12, 45]], [[3, 30]]];
const LENS_DEPTH = 0.75;               // a lens's z half-extent, a share of the tile's width (it pinches out at its tips)

// ---- helpers: each returns a primitive or a list of them
const SALT0 = 1000;                    // shared noise streams start here (past any prim index)
let salt = SALT0;
// The kit's own fixed random stream (mulberry32): the shapes vary tile to tile but every load
// builds the same kit, so the bake stays deterministic.
const KIT_SEED = 0xc0a1;
let rs = KIT_SEED;
const rand = () => {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + (b - a) * rand();
// a crooked tunnel through points [x, z] (its floor at y0), capsules sharing one noise field, so
// the joints don't show. Every leg gets a kink (KINK cells aside at its middle) and its own
// radius; a capsule's centre sits r - 1 over the floor, so the border clips its belly flat.
const TUNNEL_R = [4.8, 5.8];           // a leg's radius: the floor about 2√(3r) wide, 2r - 1 high
const KINK = 4;
function tunnel(pts, { y0 = F, r = TUNNEL_R, rough = ROUGH_TUNNEL, m = 'AIR', kink = KINK } = {}) {
  const s = salt++, out = [];
  const R = () => (Array.isArray(r) ? between(r[0], r[1]) : r);
  for (let i = 1; i < pts.length; i++) {
    const [ax, az, ay = 0] = pts[i - 1], [bx, bz, by = 0] = pts[i];
    const len = Math.hypot(bx - ax, bz - az), k = len > 4 * kink ? between(-kink, kink) : 0;
    // the kink: aside, across the leg
    const mx = (ax + bx) / 2 - (k * (bz - az)) / (len || 1), mz = (az + bz) / 2 + (k * (bx - ax)) / (len || 1), my = (ay + by) / 2;
    const r1 = R(), r2 = R();
    out.push({ capsule: [[ax, y0 + r1 - 1 + ay, az], [mx, y0 + r1 - 1 + my, mz], r1], m, rough, salt: s });
    out.push({ capsule: [[mx, y0 + r2 - 1 + my, mz], [bx, y0 + r2 - 1 + by, bz], r2], m, rough, salt: s });
  }
  return out;
}
// a cavern in box a..b: a chain of vaults (ellipsoids) along its length, each its own width,
// height and line, sharing one noise field. Their bellies run under the floor, so the border
// clips the floor flat; their crowns make the roof (b's y, or the layer's top with roof: false).
const VAULT_LEN = 13;                  // cells of the cavern's length a vault covers
const VAULT_SINK = 0.35;               // a vault's centre over the floor, a share of its height
const VAULT_WIDTH = [0.6, 1.05];       // a vault's z radius, a share of the box's half-width: caverns pinch and swell
const VAULT_SWING = 0.3;               // ...its line's swing off the box's centre line, the same share
const ALCOVE = 0.5;                    // chance a vault has an alcove bulging off one side at the floor
const ALCOVE_R = [3.5, 5.5];           // ...its radius
function cave(a, b, { rough = ROUGH_CAVE, roof = true } = {}) {
  const s = salt++, out = [], len = b[0] - a[0], n = Math.max(1, Math.round(len / VAULT_LEN)), step = len / n;
  const zc = (a[2] + b[2]) / 2, zr = (b[2] - a[2]) / 2, top = roof ? b[1] : TOP + 1;
  for (let i = 0; i < n; i++) {
    const ry = (top - F - between(0, 3)) / (1 + VAULT_SINK) + 1;
    const cx = a[0] + (i + 0.5) * step + between(-1.5, 1.5), cz = zc + between(-VAULT_SWING, VAULT_SWING) * zr;
    const rz = zr * between(...VAULT_WIDTH);
    out.push({ ball: [[cx, F + VAULT_SINK * ry, cz], [step * 0.5 + between(3, 6), ry, rz]], m: 'AIR', rough, salt: s });
    if (rand() < ALCOVE) {
      const side = rand() < 0.5 ? -1 : 1, r = between(...ALCOVE_R);
      out.push({ ball: [[cx + between(-3, 3), F + r * 0.3, cz + side * rz], [r * 1.3, r, r]], m: 'AIR', rough, salt: s });
    }
  }
  return out;
}
// headroom over a walkway at the gallery storey (or a stair): open from y0 up through the
// layer's top, its sides rough, its roof the border's flat underside
const storey = (a, b, y0 = HF) => ({ box: [[a[0], y0, a[1]], [b[0], TOP + PAST, b[1]]], m: 'AIR', rough: ROUGH_TUNNEL });
// a chimney under a ceiling shaft at a unit's centre xc: a body falling in from the layer above lands on its floor
const CHIMNEY_HALF = SHAFT_W / 2 + 2;
const chimney = (xc, zc = MID) => ({ box: [[xc - CHIMNEY_HALF, F, zc - CHIMNEY_HALF], [xc + CHIMNEY_HALF, TOP + PAST, zc + CHIMNEY_HALF]], m: 'AIR', rough: ROUGH_TUNNEL });
// a pillar of rock left standing in a cavern, floor to roof (Noita's caves keep islands of rock), and a
// stalactite of coal hanging from a roof
const PILLAR_R = 2.4;
const pillar = (a, b, r = PILLAR_R) => ({ capsule: [a, b, r], m: 'ROCK', rough: 1 });
const stalactite = (x, z, len, r = 2) => ({ ball: [[x, TOP, z], [r, len, r]], m: 'COAL', rough: 1, only: 'AIR' });
// a dome: an ellipsoid of air (a vault over a cavern)
const dome = (c, r, rough = ROUGH_PIT) => ({ ball: [c, r], m: 'AIR', rough });
// a crystal cluster (the light) at c
const CRYSTAL_R = 1.4;
const crystal = (c, r = CRYSTAL_R) => ({ ball: [c, [r, r * 1.6, r]], m: 'CRYSTAL', only: ['ROCK', 'COAL', 'AIR'] });
// a heap on the floor at (x, z): RUBBLE (stone) or SAND (broken coal, the palette's)
const HEAP_SLOPE = 0.55;               // height / radius: a heap a body walks over (a cell up a step)
const heap = (x, z, r, m = 'RUBBLE', y = F) => ({ ball: [[x, y, z], [r, r * HEAP_SLOPE, r]], m, only: 'AIR', rough: ROUGH_HEAP });
// a pool of sludge (the palette's WATER) poured into what's carved
const pool = (a, b) => ({ box: [a, b], m: 'WATER', only: 'AIR' });
// a bay round a floor shaft at (xc, zc): floor round the hole on every side, so a hole never cuts a path
const BAY_WALK = 4;                    // cells of floor each side of the hole
function bay(xc, zc = MID, h = DOOR_H) {
  const hw = SHAFT_W / 2 + BAY_WALK;
  return { box: [[xc - hw, F - PAST, zc - hw], [xc + hw, F + h, zc + hw]], m: 'AIR', rough: ROUGH_TUNNEL };
}
// a timber plank (a walkway, a scaffold deck) with its top at y + 1
const plank = (x0, x1, z0, z1, y = DECK) => ({ box: [[x0, y, z0], [x1, y + 1, z1]], m: 'BEAM' });
// a timber post from the floor up to y
const post = (x, z, y) => ({ box: [[x, F, z], [x + 1, y, z + 1]], m: 'BEAM' });
// the coal beds through what rock is left (last in a tile, so they show in its walls)
let strataN = 0;
const strata = (lift = 0) => {
  const n = strataN++;
  return STRATA.flatMap(({ y, t }, b) => LENS_SPANS[(n + 2 * b) % LENS_SPANS.length].map(([x0, x1]) => (
    { ball: [[(x0 + x1) / 2, y + lift, MID], [(x1 - x0) / 2, t, U * LENS_DEPTH]], m: 'COAL', only: 'ROCK', rough: ROUGH_SEAM })));
};
// a pocket of coal: a lump of seam in the rock round a cave
const pocket = (c, r) => ({ ball: [c, r], m: 'COAL', only: 'ROCK', rough: ROUGH_SEAM });
// gold specks (the Coal Pits' are rare: a few per tile that has any)
const GOLD_SPECK = 0.9;
const speck = (c) => ({ ball: [c, [GOLD_SPECK, GOLD_SPECK, GOLD_SPECK]], m: 'GOLD', only: ['ROCK', 'COAL'] });
// rails along x on the floor (a rail spur), centred on zc
const RAIL_GAUGE = GEOM.RAIL_GAUGE;
const railsX = (x0, x1, zc = MID, y = F) => [
  { box: [[x0, y, zc - RAIL_GAUGE / 2], [x1, y + 1, zc - RAIL_GAUGE / 2 + 1]], m: 'RAIL' },
  { box: [[x0, y, zc + RAIL_GAUGE / 2 - 1], [x1, y + 1, zc + RAIL_GAUGE / 2]], m: 'RAIL' },
];
// a timber set across an x passage at x (posts and a cap)
const frameX = (x, z0, z1, y0 = F, h = DOOR_H) => [
  { box: [[x, y0, z0], [x + 1, y0 + h, z0 + 1]], m: 'BEAM' },
  { box: [[x, y0, z1 - 1], [x + 1, y0 + h, z1]], m: 'BEAM' },
  { box: [[x, y0 + h - 1, z0], [x + 1, y0 + h, z1]], m: 'BEAM' },
];

const tiles = [
  // ---- the universal tile: a coal hall, two storeys high, a shelf of coal all
  // round at the gallery storey, rock stairs up both long sides. It takes any
  // colour on any port (the fallback that makes a pick always exist).
  {
    name: 'coal hall', weight: 0.6,
    ports: { W: 'DHR-', E: 'DHR-', N0: 'DHR-', N1: 'DHR-', S0: 'DHR-', S1: 'DHR-', D0: 'S-', D1: 'S-', U0: 'S-', U1: 'S-' },
    prims: [
      ...cave([IN[0], F, INZ[0]], [IN[1], TOP, INZ[1]], { roof: false }),
      storey([IN[0], INZ[0]], [IN[1], INZ[0] + 7]), storey([IN[0], INZ[1] - 7], [IN[1], INZ[1]]),
      storey([IN[0], INZ[0]], [IN[0] + 7, INZ[1]]), storey([IN[1] - 7, INZ[0]], [IN[1], INZ[1]]),
      chimney(C0), chimney(C1),
      storey([16, INZ[0] + 5], [32, INZ[1] - 5], F + 4),          // over the stairs
      // the shelf: a ring of coal 5 wide, its top the gallery floor
      plank(IN[0], IN[1], INZ[0], INZ[0] + 5), plank(IN[0], IN[1], INZ[1] - 5, INZ[1]),
      plank(IN[0], IN[0] + 5, INZ[0], INZ[1]), plank(IN[1] - 5, IN[1], INZ[0], INZ[1]),
      { box: [[IN[0], DECK - 1, INZ[0]], [IN[1], DECK + 1, INZ[0] + 4]], m: 'COAL' },
      { box: [[IN[0], DECK - 1, INZ[1] - 4], [IN[1], DECK + 1, INZ[1]]], m: 'COAL' },
      ...[8, 24, 40].flatMap((x) => [post(x, INZ[0] + 4, DECK), post(x, INZ[1] - 5, DECK)]),
      // stairs up to it on both long sides
      { stairs: [[18, F, INZ[0] + 5], [18 + HF - F, HF, INZ[0] + 8]], m: 'ROCK', axis: 'x', rise: -1 },
      { stairs: [[30 - (HF - F), F, INZ[1] - 8], [30, HF, INZ[1] - 5]], m: 'ROCK', axis: 'x', rise: 1 },
      heap(24, MID, 3, 'SAND'),
      crystal([C0, TOP, MID - 5]), crystal([C1, TOP, MID + 5]),
      ...strata(),
    ],
    sites: [{ kind: 'loot', at: [24, HF, INZ[0] + 2] }],
  },
  // ---- a crooked tunnel along a coal seam: the plain connector
  {
    name: 'seam tunnel', weight: 3,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D0: '-S', D1: '-S', U1: '-S' },
    prims: [
      ...tunnel([[IN[0], MID], [9, MID], [17, 6, 1], [30, 18, 1], [39, MID], [IN[1], MID]]),
      bay(C0), bay(C1), chimney(C1),
      heap(28, 18, 2.5, 'SAND'),
      pocket([20, 12, 3], [7, 3, 3]),
      crystal([C1 + 6, GAL_TOP, 6]),
      ...strata(),
    ],
  },
  // ---- the same seam a storey up, low on its W side: a tunnel that climbs
  {
    name: 'climbing seam', weight: 1.2,
    ports: { W: 'D', E: 'H', N0: '-D', N1: '-', S1: '-H' },
    prims: [
      ...tunnel([[IN[0], MID], [12, MID]]),
      // the climb: a rough passage over a rock ramp
      { box: [[10, F - PAST, 6], [40, HF + DOOR_H, 18]], m: 'AIR', rough: ROUGH_TUNNEL },
      { ramp: [[14, F - PAST, 6], [36, HF, 18]], m: 'ROCK', axis: 'x', rise: 1 },
      { box: [[36, F - PAST, 6], [IN[1], HF, 18]], m: 'ROCK' },
      ...tunnel([[34, MID], [IN[1], MID]], { y0: HF }),
      { box: [[30, HF, 12], [42, HF + DOOR_H, INZ[1]]], m: 'AIR', rough: ROUGH_TUNNEL },   // the S1 high door's landing
      { box: [[30, F, 12], [42, HF, INZ[1]]], m: 'ROCK' },
      crystal([26, HF + 6, 6]),
      ...strata(1),
    ],
  },
  // ---- sludge pooled in a hollow, a timber walkway across it on posts
  {
    name: 'sludge walk', weight: 1.4,
    ports: { W: 'D-', E: 'D-', N0: '-D', S1: '-D' },
    prims: [
      ...cave([4, F, 4], [44, 17, 20]),
      dome([24, 14, 12], [16, 5, 8]),
      // benches up to the walkway at both ends, the hollow between
      { ramp: [[9, F - PAST, 4], [16, F + 6, 20]], m: 'ROCK', axis: 'x', rise: 1 },
      { ramp: [[32, F - PAST, 4], [39, F + 6, 20]], m: 'ROCK', axis: 'x', rise: -1 },
      pool([16, F, 4], [32, F + 4, 20]),
      plank(15, 33, 10, 14, F + 5),
      ...[18, 24, 30].flatMap((x) => [post(x, 10, F + 5), post(x, 13, F + 5)]),
      crystal([24, F, 18], 1.2), crystal([12, 16, 5]),
      ...strata(),
    ],
  },
  // ---- the pit: a hole the layer's full height, a timber bridge across it at
  // the gallery storey, sludge at its bottom, a rock ramp climbing its side.
  // You look down into it from the bridge and across it from either end.
  {
    name: 'pit bridge', weight: 1.6,
    ports: { W: 'DH-', E: 'DH-', N0: '-D', S1: '-D', D1: 'S-' },
    prims: [
      // the two ends: a low tunnel under a high hall, rock between
      ...tunnel([[IN[0], MID], [16, MID]]),
      { box: [[IN[0], HF, 4], [18, TOP + PAST, 21]], m: 'AIR', rough: ROUGH_TUNNEL },
      ...cave([32, F, 3], [IN[1], GAL_TOP + 1, 21]),
      { box: [[32, HF, 4], [IN[1], TOP + PAST, 20]], m: 'AIR', rough: ROUGH_TUNNEL },
      { box: [[32, GAL_TOP + 1, 3], [IN[1], HF, 21]], m: 'ROCK' },
      // the pit
      ...cave([14, F, 3], [34, TOP, 21], { rough: ROUGH_PIT, roof: false }),
      pool([18, F, 3], [30, F + 3, 9]),
      // the ramp up its south wall to the west hall's floor
      storey([14, 15], [34, 21], F),
      { ramp: [[17, F - PAST, 15], [34, HF, 21]], m: 'ROCK', axis: 'x', rise: -1 },
      { box: [[IN[0], F + DOOR_H + 1, 15], [18, HF, 21]], m: 'ROCK' },
      // the bridge, open overhead
      storey([13, 8], [35, 16]),
      plank(13, 35, 10, 14), ...[13, 34].flatMap((x) => [post(x, 10, DECK), post(x, 13, DECK)]),
      crystal([24, F + 1, 3]), crystal([16, 18, 4]), crystal([34, 9, 20]),
      ...strata(),
    ],
  },
  // ---- the chimney cavern: open from the layer above to the layer below, coal
  // shelves overhanging it at two heights, an old scaffold on its wall
  {
    name: 'chimney cavern', weight: 1,
    ports: { W: 'D-', E: 'D-', N1: '-D', S0: '-D', D0: 'S-', U0: 'S-', U1: 'S-' },
    prims: [
      ...cave([3, F, 3], [45, 11, 21]),
      dome([24, 13, 12], [22, 12, 10]),
      ...cave([C0 - 8, F, MID - 8], [C0 + 8, TOP, MID + 8], { rough: ROUGH_PIT, roof: false }),
      ...cave([C1 - 7, F, MID - 7], [C1 + 7, TOP, MID + 7], { rough: ROUGH_PIT, roof: false }),
      chimney(C0), chimney(C1),
      pillar([25, F, 17], [22, TOP, 18]),
      // overhangs of coal (not on the walking floor: you look up at them)
      { box: [[22, 13, 3], [34, 16, 8]], m: 'COAL', rough: 1 },
      { box: [[4, 17, 15], [14, 19, 21]], m: 'COAL', rough: 1 },
      // the scaffold: a post-and-deck tower against the north wall
      post(40, 4, 15), post(44, 4, 15), plank(39, 45, 4, 8, 15),
      heap(30, 18, 3), heap(36, 5, 2, 'SAND'),
      pool([18, F, 16], [24, F + 1, 21]),
      crystal([3, 9, 6]), crystal([45, 14, 14]), crystal([24, 21, 12], 1.8),
      ...strata(),
    ],
  },
  // ---- an overhanging coal shelf: the cave's north half has a second floor
  // of coal at the gallery storey, reached by rock stairs, open beneath
  {
    name: 'coal shelf', weight: 1.2,
    ports: { W: 'D-', E: 'DH-', N0: '-', S0: '-D', N1: '-H' },
    prims: [
      ...cave([3, F, 3], [45, TOP, 21], { roof: false }),
      storey([6, INZ[0]], [IN[1], 14], F + 4),
      { box: [[20, DECK - 2, INZ[0]], [IN[1], DECK + 1, 13]], m: 'COAL', rough: 0 },
      { ball: [[33, DECK - 2, 7], [12, 2.5, 5]], m: 'COAL', rough: ROUGH_SEAM, only: 'AIR' },   // its ragged underside
      { stairs: [[8, F, INZ[0]], [20, HF, 8]], m: 'ROCK', axis: 'x', rise: 1 },
      heap(14, 17, 3), heap(36, 18, 2.5, 'SAND'),
      crystal([28, DECK - 3, 9]), crystal([44, 20, 18]),
      ...strata(),
    ],
    sites: [{ kind: 'loot', at: [42, HF, 6] }],
  },
  // ---- a cave the roof fell into: heaps of stone and broken coal
  {
    name: 'rubble cave', weight: 1.3,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D1: '-S', U0: '-S' },
    prims: [
      ...cave([4, F, 4], [44, 16, 20]), chimney(C0),
      pillar([27, F, 5], [24, 16, 7], 2.2),
      dome([20, 13, 12], [14, 6, 8]),
      bay(C1),
      heap(10, 7, 5), heap(22, 16, 6), heap(28, 6, 4, 'SAND'), heap(44, 18, 3),
      { capsule: [[16, F, 6], [22, 11, 10], 0.8], m: 'BEAM' },        // a fallen prop
      crystal([40, 15, 5]),
      ...strata(),
    ],
    sites: [{ kind: 'loot', at: [18, F, 18] }],
  },
  // ---- the old rail spur: a straighter, shored passage, rails, a cart of coal
  {
    name: 'rail spur', weight: 1.6,
    ports: { W: 'DR-', E: 'DR-', N1: '-D', S0: '-D' },
    prims: [
      { box: [[IN[0], F - PAST, MID - 7], [IN[1], GAL_TOP + 1, MID + 7]], m: 'AIR', rough: ROUGH_TUNNEL },
      ...railsX(IN[0], IN[1]),
      ...[8, 20, 40].flatMap((x) => frameX(x, MID - 7, MID + 7, F, DOOR_H + 1)),
      { box: [[26, F + 1, MID - 3], [33, F + 4, MID + 3]], m: 'METAL' },
      { box: [[27, F + 2, MID - 2], [32, F + 5, MID + 2]], m: 'SAND' },
      heap(14, MID + 5, 2, 'SAND'),
      crystal([36, GAL_TOP, MID + 6]),
      ...strata(),
    ],
  },
  // ---- a scaffold shaft: a drop through unit 0, timber platforms round its walls
  {
    name: 'scaffold shaft', weight: 1.8,
    ports: { W: 'D-', E: 'D-R', S1: '-D', D0: 'S', U0: 'S-' },
    prims: [
      ...tunnel([[IN[0], MID], [14, MID], [30, 15], [IN[1], MID]]),
      ...cave([C0 - 8, F, MID - 8], [C0 + 8, TOP, MID + 8], { rough: ROUGH_PIT, roof: false }), chimney(C0),
      plank(C0 - 8, C0 - 3, MID - 8, MID + 1, 8), plank(C0 + 3, C0 + 8, MID - 2, MID + 8, 14),
      plank(C0 - 8, C0 + 1, MID + 3, MID + 8, 18),
      post(C0 - 8, MID - 8, 8), post(C0 + 7, MID + 7, 14),
      heap(38, 17, 2.5),
      crystal([C0 + 8, 10, MID - 7]),
      ...strata(),
    ],
  },
  // ---- a crossroads cave: tunnels along x and z meeting in a chamber
  {
    name: 'crossroads cave', weight: 1.3,
    ports: { W: 'D-', E: 'D-', N0: 'D-', S0: 'D-', N1: '-D', S1: '-D', D1: '-S', U0: '-S' },
    prims: [
      ...tunnel([[IN[0], MID], [20, 11], [IN[1], MID]]),
      ...tunnel([[C0, INZ[0]], [C0 + 1, MID], [C0, INZ[1]]]),
      dome([C0, 7, MID], [8, 6, 8]), chimney(C0),
      bay(C1),
      heap(C0 + 6, 18, 2.5, 'SAND'),
      crystal([C0, 13, MID - 5]),
      ...strata(),
    ],
  },
  // ---- the cistern: a low cave half full of sludge, a causeway of rock through it
  {
    name: 'sludge cistern', weight: 1,
    ports: { W: 'D-', E: 'D-', N1: '-D' },
    prims: [
      ...cave([4, F, 3], [44, 14, 21]),
      dome([24, 10, 12], [18, 5, 9]), stalactite(20, 16, 4), stalactite(31, 8, 3, 1.6),
      // the causeway: a crooked rock ridge a step over the sludge
      ...tunnel([[4, MID], [16, 9], [32, 15], [44, MID]], { r: 3.5, rough: 1, m: 'ROCK', y0: F - 3 }),
      pool([4, F, 3], [44, F + 2, 21]),
      crystal([14, 13, 20]), crystal([36, 12, 4]),
      ...strata(),
    ],
  },
  // ---- a pocket of coal: the tunnel opens into a cave walled with coal, broken coal on its floor
  {
    name: 'coal pocket', weight: 1.1,
    ports: { W: 'D-', E: 'D-', S0: '-D', N1: '-D', U1: '-S' },
    prims: [
      ...tunnel([[IN[0], MID], [14, 14], [34, 10], [IN[1], MID]]),
      pocket([26, 9, 12], [14, 9, 9]),
      dome([26, 6, 12], [10, 6, 7]), chimney(C1),
      heap(22, 8, 3, 'SAND'), heap(30, 16, 2.5, 'SAND'),
      crystal([26, 14, 6]),
      ...strata(),
    ],
    sites: [{ kind: 'loot', at: [26, F, 12] }],
  },
  // ---- rare gold: a narrow working where a gold vein crosses the seam
  {
    name: 'gold working', weight: 0.35,
    ports: { W: 'D-', E: 'D-', S1: '-D' },
    prims: [
      ...tunnel([[IN[0], MID], [20, 9], [IN[1], MID]]),
      dome([28, 6, 12], [9, 5, 6]),
      { capsule: [[18, 3, 4], [38, 15, 20], 1], m: 'GOLD', only: ['ROCK', 'COAL'], rough: ROUGH_SEAM },
      speck([12, 14, 6]), speck([40, 4, 19]),
      ...frameX(14, 4, 14), ...frameX(34, 7, 18),
      crystal([30, 12, 17]),
      ...strata(),
    ],
    sites: [{ kind: 'gold', at: [28, F, 12] }],
  },
  // ---- a drop cave: its floor gives way into the layer below in both units, planks between
  {
    name: 'drop cave', weight: 0.8,
    ports: { W: 'D-', E: '-D', N1: '-D', D0: 'S-', D1: 'S-', U1: '-S' },
    prims: [
      ...cave([IN[0], F, 5], [IN[1], 15, 19]),
      ...cave([C1 - 6, F, MID - 6], [C1 + 6, TOP, MID + 6], { roof: false }), chimney(C1),
      plank(20, 28, 5, 19, F), heap(24, MID, 2.5),
      crystal([4, 13, 6]),
      ...strata(),
    ],
  },
  // ---- the great pit: a vault the layer's height, ledges, sludge, crystals. The set piece.
  {
    name: 'great pit', weight: 0.6,
    ports: { W: 'D-', E: 'D-', N0: '-D', N1: '-D', S0: '-D', S1: '-D', D0: '-S', D1: '-S', U0: '-S', U1: '-S' },
    prims: [
      dome([24, 12, 12], [25, 14, 12]),
      ...cave([3, F, 3], [45, 10, 21]), chimney(C0), chimney(C1),
      pillar([24, F, 7], [21, TOP, 5]), stalactite(30, 14, 6), stalactite(17, 17, 4),
      pool([28, F, 15], [42, F + 2, 21]),
      { ramp: [[4, F - PAST, 3], [16, 10, 8]], m: 'ROCK', axis: 'x', rise: -1 },
      { box: [[30, 16, 3], [44, 17, 8]], m: 'COAL', rough: 1 },   // an overhang
      plank(6, 14, 15, 21, 14),
      heap(18, 17, 3), heap(36, 6, 2.5, 'SAND'),
      crystal([5, 18, 12], 2), crystal([43, 15, 6], 1.8), crystal([24, 21, 12], 2),
      ...strata(),
    ],
    sites: [{ kind: 'loot', at: [8, 10, 5] }],
  },
  // ---- a treasure nook: one way in, a crooked crawl, gold and a light at its end
  {
    name: 'treasure nook', weight: 2,
    ports: { E: 'D', W: '-', N0: '-', N1: '-', S0: '-', S1: '-' },
    prims: [
      ...tunnel([[IN[1], MID], [34, MID], [24, 7]]),
      ...cave([8, F, 3], [24, 11, 13]),
      { box: [[11, F, 5], [15, F + 2, 9]], m: 'GOLD' },
      crystal([10, 10, 4]), crystal([22, 10, 12]),
      ...strata(),
    ],
    sites: [{ kind: 'treasure', at: [13, F + 2, 7] }, { kind: 'wand', at: [18, F, 8] }],
  },
  // ---- a miners' cache: a dead-end cave with their crates and a coal heap
  {
    name: 'miners cache', weight: 1.4,
    ports: { S1: 'D', W: '-', E: '-', N0: '-', N1: '-', S0: '-' },
    prims: [
      ...cave([10, F, 4], [42, 11, 15]),
      ...tunnel([[C1, INZ[1]], [C1, 10]]),
      { box: [[12, F, 5], [16, F + 3, 8]], m: 'BEAM' }, { box: [[12, F + 3, 5], [15, F + 5, 8]], m: 'BEAM' },
      heap(24, 8, 3, 'SAND'),
      crystal([30, 11, 5]),
      ...strata(),
    ],
    sites: [{ kind: 'loot', at: [20, F, 11] }],
  },
];

export default {
  name: 'coal',
  // wall torches (kit.js placeTorches): Noita's Coal Pits are dark rock lit by a torch here and there
  torches: { every: 16, max: 3, lights: ['TORCH'] },
  // Noita's Coal Pits: dark rock, coal beds, toxic sludge in the hollows, broken coal and stone heaps
  palette: {
    ROCK: 'ROCK', COAL: 'COAL', BEAM: 'WOOD', RAIL: 'METAL', METAL: 'METAL',
    RUBBLE: 'STONE', GRAVEL: 'STONE', SAND: 'BROKENCOAL', WATER: 'TOXIC', GOLD: 'GOLD',
    CRYSTAL: 'EMBER',   // the Coal Pits' clusters of light are smouldering coal, not crystal: warm, as Noita's are
  },
  tiles,
};
