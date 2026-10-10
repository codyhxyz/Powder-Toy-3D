import { E } from '../../elements.js';
import { WORLD_SIZE } from '../../shaders/far.js';
import { pcg } from '../generator.js';
import { ISLAND_VIEW_XZ } from './island.js';

// The giant volcano: the box volcano (presets.js 'volcano') blown up to fill
// the world. One cone in the middle of a sea, a magma chamber under it and a
// conduit up to its summit, an endless lava source there, a ring of snow
// round the top and trees on the flanks.
//
// Scales. Across, the box's times the world's width in boxes (1024 / 128 = 8):
// the cone's foot is 432 cells (130 m) from its summit, leaving the sea a ring
// round it. Up, the world is only 128 cells, so the box's heights are
// stretched as far as fits instead: the top of the conduit's lava (the box's
// highest point, 2 cells over the summit) lands VOLC_HEADROOM below the
// world's top, over a VOLC_FLOOR-cell sea floor. That is 2 cells per box cell:
// the summit stands 96 cells (29 m) over the floor, the sea is 16 cells (5 m)
// deep, and the headroom is room for the lava's fountain, the steam off the
// snow it melts and the smoke of the forest it burns. The cone comes out
// shallow (13° against the box's 42°): a shield volcano, the shape a cone
// takes at this width under this ceiling.
//
// What scales how:
//   - The chamber, the conduit and the CLONE source scale across with the
//     layout (the source's top is 64 times the box's, as the cone's flanks
//     are, so its lava covers them as the box's covers its own), and up with
//     the heights, so the conduit's lava stands as far over its rim as in the
//     box and spills at once.
//   - The snow cap is a layer of the cone's height: 4 cells (1.2 m). On these
//     flanks no column is more than a cell above its neighbour, so a layer of
//     any depth rests (each grain has snow diagonally under it).
//   - The trees are scaled by the vertical scale on every axis, so they stay
//     tree-shaped (8 times wider would be 60 m crowns): 2-cell trunks 16 tall
//     under crowns 12 wide, about 7 m in all. There are ~16 times as many as
//     the box's 14: its band of the flanks (0.55 to 0.8 of the radius) holds
//     rings of sites a tree's spacing apart, most of them planted.
//
// A pure function of the world cell, O(1): a cell finds the one tree it could
// belong to from its ring and angle sector (the sites are far enough apart
// that no crown leaves its own sector), not by looking at every tree. The
// GLSL's #defines and the JS twin (volcCell, ground) come from the constants
// below.

const [WX, WY, WZ] = WORLD_SIZE;
const TAU = 2 * Math.PI;

// The box the preset is laid out in, in its own cells (s = 1), and its layout (presets.js 'volcano').
const BOX_N = 128;
const BOX_R = 54;                 // the cone's radius at its foot
const BOX_H = 48;                 // its height
const BOX_SEA = 8;                // the sea's level
const BOX_CHAMBER_TOP = 14;       // the magma chamber is the conduit's lowest part...
const BOX_CHAMBER_BULGE = 12;     // ...widened by this much at the bottom...
const BOX_CHAMBER_FADE = 16;      // ...narrowing over this height (cut off at its top)...
const BOX_CHAMBER_NECK = 4;       // ...on top of this radius
const BOX_CONDUIT_R = 3.5;        // the conduit above the chamber
const BOX_CONDUIT_OVER = 2;       // its lava stands this far over the summit: it spills at once
const BOX_CLONE_HALF = 2;         // the lava source: half its width, centred on the summit...
const BOX_CLONE_BELOW = 1;        // ...from this far under the summit...
const BOX_CLONE_ABOVE = 1;        // ...to this far over it
const BOX_SNOW_IN = 6;            // the snow cap: a ring from this far from the summit...
const BOX_SNOW_OUT = 20;          // ...to this far
const BOX_SNOW_DEPTH = 2;         // ...this deep
const BOX_TREE_IN = 0.55;         // trees stand from this share of the radius...
const BOX_TREE_OUT = 0.8;         // ...out to this one
const BOX_TRUNK_W = 1;            // a trunk's width
const BOX_TRUNK_H = 8;            // its height
const BOX_CROWN_R = 3;            // its crown: a ball this wide (radius, exclusive)...
const BOX_CROWN_HALF = 2.5;       // ...cut to this far over and under its centre...
const BOX_CROWN_LIFT = 1.5;       // ...centred this far over the trunk's top
const LAVA_T = 1900;              // °C: the conduit's lava, hotter than spawned lava (the box's)
const BOX_TOP = BOX_H + BOX_CONDUIT_OVER;   // the layout's highest point

// The giant's own numbers.
export const VOLC_FLOOR = 4;      // rock under the whole sea: one brick, so the far field reads it as solid
const VOLC_HEADROOM = 24;         // open air over the highest point (see the top)
const VOLC_XZ = WX / BOX_N;       // world cells per box cell across: the world is 8 boxes wide
const VOLC_V = (WY - VOLC_HEADROOM - VOLC_FLOOR) / BOX_TOP;   // world cells per box cell up (2)
const TREE_RINGS = 5;             // rings of tree sites across the band (the box's trees stand at 3 distances)
const TREE_CHANCE = 0.7;          // share of the sites with a tree
const TREE_JITTER = 4;            // cells: a tree stands up to this far off its site, each way
const TRUNK_ROOT = 1;             // cells a trunk reaches into the rock, so no column of it floats
const SALT_CELL = 0x7c41d;        // seed stream of its cells' colour seeds
const SALT_TREE = 0x3e9b5;        // ...of its trees
const BYTE = 255;                 // a hash byte's largest value
const U16 = 65536;                // a hash's low 16 bits: values below this

// World cells.
const CENTER = [WX / 2, WZ / 2];                  // the summit's column (the cone is centred on the world)
const CONE_R = BOX_R * VOLC_XZ;                   // 432
const CONE_H = BOX_H * VOLC_V;                    // 96
export const VOLC_SEA = VOLC_FLOOR + BOX_SEA * VOLC_V;   // 20
const CHAMBER_TOP = VOLC_FLOOR + BOX_CHAMBER_TOP * VOLC_V;
const CONDUIT_R = BOX_CONDUIT_R * VOLC_XZ;
const CONDUIT_TOP = VOLC_FLOOR + BOX_TOP * VOLC_V;
const CLONE_LO = [CENTER[0] - BOX_CLONE_HALF * VOLC_XZ, VOLC_FLOOR + (BOX_H - BOX_CLONE_BELOW) * VOLC_V, CENTER[1] - BOX_CLONE_HALF * VOLC_XZ];
const CLONE_HI = [CENTER[0] + BOX_CLONE_HALF * VOLC_XZ, VOLC_FLOOR + (BOX_H + BOX_CLONE_ABOVE) * VOLC_V, CENTER[1] + BOX_CLONE_HALF * VOLC_XZ];
const SNOW_IN = BOX_SNOW_IN * VOLC_XZ;
const SNOW_OUT = BOX_SNOW_OUT * VOLC_XZ;
const SNOW_DEPTH = BOX_SNOW_DEPTH * VOLC_V;
const TREE_IN = BOX_TREE_IN * CONE_R;             // the innermost ring's radius
const TREE_RING_W = (BOX_TREE_OUT - BOX_TREE_IN) * CONE_R / (TREE_RINGS - 1);   // between rings, and between sites on a ring
const TRUNK_W = BOX_TRUNK_W * VOLC_V;
const TRUNK_H = BOX_TRUNK_H * VOLC_V;
const CROWN_R = BOX_CROWN_R * VOLC_V;
const CROWN_HALF = BOX_CROWN_HALF * VOLC_V;
const CROWN_LIFT = (BOX_TRUNK_H + BOX_CROWN_LIFT) * VOLC_V;   // the crown's centre over the trunk's base
// sites per ring: as many as fit TREE_RING_W apart round it
const TREE_SECTORS = Array.from({ length: TREE_RINGS }, (_, k) => Math.floor((TAU * (TREE_IN + k * TREE_RING_W)) / TREE_RING_W));

// Every cell of a tree must lie in its own site's ring and sector, or the
// cell would look up the wrong site. A tree's trunk is within TRUNK_REACH of
// its site (the jitter, across and along the ring, where the along part is an
// angle so it grows outward; the rounding to whole columns; half the trunk),
// and all its cells' centres within TREE_REACH (the crown round the trunk).
const TRUNK_REACH = Math.hypot(TREE_JITTER, TREE_JITTER * (1 + TREE_JITTER / TREE_IN)) + 0.5 + TRUNK_W / 2;
const TREE_REACH = TRUNK_REACH - TRUNK_W / 2 + CROWN_R;
if (TREE_REACH >= TREE_RING_W / 2) throw new Error('giant volcano: trees reach out of their rings');
TREE_SECTORS.forEach((n, k) => {
  const ring = TREE_IN + k * TREE_RING_W;
  if (Math.asin(TREE_REACH / (ring - TREE_REACH)) >= Math.PI / n) throw new Error(`giant volcano: ring ${k}'s trees reach out of their sectors`);
});
if (CONDUIT_TOP > WY - VOLC_HEADROOM) throw new Error('giant volcano: the conduit reaches into the headroom');

// It starts on the shore the god view looks from (island.js ISLAND_VIEW_XZ:
// from +x +z), with the summit and its lava ahead: the window's centre this
// share of its width inland from the waterline, so it holds the sea, the
// shore and the outer trees.
const START_INLAND = 0.25;

// ---- the JS twin (sceneCell's, step for step) ----

// the rock's top at world column (x, z): the floor, and the cone over it
function coneTop(x, z) {
  const d = Math.hypot(x + 0.5 - CENTER[0], z + 0.5 - CENTER[1]);
  return VOLC_FLOOR + Math.max(0, Math.floor(CONE_H * (1 - d / CONE_R) + 0.5));
}
// the conduit's radius at height y (the chamber's below CHAMBER_TOP); 0 outside it
function conduitR(y) {
  if (y < VOLC_FLOOR || y >= CONDUIT_TOP) return 0;
  if (y >= CHAMBER_TOP) return CONDUIT_R;
  return VOLC_XZ * (BOX_CHAMBER_BULGE * (1 - (y - VOLC_FLOOR) / (VOLC_V * BOX_CHAMBER_FADE)) + BOX_CHAMBER_NECK);
}
const jitter = (h) => ((h & BYTE) / BYTE * 2 - 1) * TREE_JITTER;
// the tree a cell at distance d from the summit and offset (ox, oz) from it
// could be part of: { x, z, base } (its trunk's low corner column and its
// base), or null where its site has none
function treeAt(ox, oz, d, seed) {
  const k = Math.floor((d - TREE_IN) / TREE_RING_W + 0.5);
  if (k < 0 || k >= TREE_RINGS) return null;
  const n = TREE_SECTORS[k];
  let a = Math.atan2(oz, ox);
  if (a < 0) a += TAU;
  return treeSite(k, Math.min(Math.floor((a * n) / TAU), n - 1), seed);
}
// the tree at site j of ring k, or null
function treeSite(k, j, seed) {
  const n = TREE_SECTORS[k];
  const h = pcg((j + pcg((k + pcg((seed + SALT_TREE) >>> 0)) >>> 0)) >>> 0);
  if ((h & (U16 - 1)) / U16 >= TREE_CHANCE) return null;
  const h2 = pcg(h);
  const ring = TREE_IN + k * TREE_RING_W;
  const r = ring + jitter(h2), th = ((j + 0.5) * TAU) / n + jitter(h2 >>> 8) / ring;
  const x = Math.floor(CENTER[0] + r * Math.cos(th) - TRUNK_W / 2 + 0.5);
  const z = Math.floor(CENTER[1] + r * Math.sin(th) - TRUNK_W / 2 + 0.5);
  return { x, z, base: coneTop(x, z) };
}

// Every tree for world seed `seed`, and whether world cell (x, y, z) is part
// of tree t by its shape alone (no site lookup): for tools/scene-giant-preview.mjs,
// which checks the lookup finds every cell of every tree.
export function volcTrees(seed) {
  const trees = [];
  TREE_SECTORS.forEach((n, k) => { for (let j = 0; j < n; j++) { const t = treeSite(k, j, seed); if (t) trees.push(t); } });
  return trees;
}
export function volcTreePart(t, x, y, z) {
  const rx = x + 0.5 - (t.x + TRUNK_W / 2), ry = y + 0.5 - (t.base + CROWN_LIFT), rz = z + 0.5 - (t.z + TRUNK_W / 2);
  if (Math.abs(ry) < CROWN_HALF && rx * rx + ry * ry + rz * rz < CROWN_R * CROWN_R) return E.PLANT;
  if (x >= t.x && x < t.x + TRUNK_W && z >= t.z && z < t.z + TRUNK_W && y >= t.base - TRUNK_ROOT && y < t.base + TRUNK_H) return E.WOOD;
  return E.EMPTY;
}
export const VOLC_TREE_BOX = { reach: Math.ceil(CROWN_R + TRUNK_W), below: TRUNK_ROOT, above: Math.ceil(CROWN_LIFT + CROWN_HALF) };

// The element at world cell (x, y, z) for world seed `seed`.
export function volcCell(x, y, z, seed) {
  const ox = x + 0.5 - CENTER[0], oz = z + 0.5 - CENTER[1], d = Math.hypot(ox, oz);
  const top = coneTop(x, z);
  let id = y < top ? E.ROCK : y < VOLC_SEA ? E.WATER : E.EMPTY;
  if (d < conduitR(y)) id = E.LAVA;
  if (x >= CLONE_LO[0] && y >= CLONE_LO[1] && z >= CLONE_LO[2] && x < CLONE_HI[0] && y < CLONE_HI[1] && z < CLONE_HI[2]) id = E.CLONE;
  const t = treeAt(ox, oz, d, seed);
  const part = t ? volcTreePart(t, x, y, z) : E.EMPTY;
  if (part !== E.EMPTY) id = part;
  if (d > SNOW_IN && d < SNOW_OUT && y >= top && y < top + SNOW_DEPTH) id = E.SNOW;
  return id;
}

// Where ground() starts looking down: over the highest matter, the conduit's
// lava, the snow on the summit's rock and the innermost trees' crowns.
const treeBase = (d) => VOLC_FLOOR + Math.max(0, Math.floor(CONE_H * (1 - d / CONE_R) + 0.5));
const MATTER_TOP = Math.max(CONDUIT_TOP, VOLC_FLOOR + CONE_H + SNOW_DEPTH,
  Math.ceil(treeBase(TREE_IN - TREE_REACH) + CROWN_LIFT + CROWN_HALF));
// a trunk on the outermost ring still stands on the shore, not in the sea
if (treeBase(TREE_IN + (TREE_RINGS - 1) * TREE_RING_W + TRUNK_REACH) <= VOLC_SEA) throw new Error('giant volcano: trees stand in the sea');

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const glsl = () => /* glsl */ `
#define GVOL_CENTER vec2(${f(CENTER[0])}, ${f(CENTER[1])})   // the summit's column
#define GVOL_R ${f(CONE_R)}             // the cone's radius at its foot
#define GVOL_H ${f(CONE_H)}              // its height over the floor
#define GVOL_FLOOR ${VOLC_FLOOR}               // rock under everything
#define GVOL_SEA ${VOLC_SEA}                // the sea's level
#define GVOL_XZ ${f(VOLC_XZ)}              // world cells per box cell, across and up
#define GVOL_V ${f(VOLC_V)}
#define GVOL_CHAMBER_TOP ${CHAMBER_TOP}        // the magma chamber, under the conduit
#define GVOL_CHAMBER_BULGE ${f(BOX_CHAMBER_BULGE)}  // (box cells)
#define GVOL_CHAMBER_FADE ${f(BOX_CHAMBER_FADE)}
#define GVOL_CHAMBER_NECK ${f(BOX_CHAMBER_NECK)}
#define GVOL_CONDUIT_R ${f(CONDUIT_R)}
#define GVOL_CONDUIT_TOP ${CONDUIT_TOP}       // its lava's top, over the summit
#define GVOL_LAVA_T ${f(LAVA_T)}         // °C
#define GVOL_CLONE_LO ivec3(${CLONE_LO.join(', ')})   // the endless lava source
#define GVOL_CLONE_HI ivec3(${CLONE_HI.join(', ')})
#define GVOL_SNOW_IN ${f(SNOW_IN)}          // the snow cap's ring
#define GVOL_SNOW_OUT ${f(SNOW_OUT)}
#define GVOL_SNOW_DEPTH ${SNOW_DEPTH}
#define GVOL_TREE_RINGS ${TREE_RINGS}
#define GVOL_TREE_IN ${f(TREE_IN)}       // the innermost ring's radius
#define GVOL_TREE_RING_W ${f(TREE_RING_W)}
#define GVOL_TREE_CHANCE ${f(TREE_CHANCE)}
#define GVOL_TREE_JITTER ${f(TREE_JITTER)}
#define GVOL_TRUNK_W ${TRUNK_W}
#define GVOL_TRUNK_H ${TRUNK_H}
#define GVOL_TRUNK_ROOT ${TRUNK_ROOT}
#define GVOL_CROWN_R ${f(CROWN_R)}
#define GVOL_CROWN_HALF ${f(CROWN_HALF)}
#define GVOL_CROWN_LIFT ${f(CROWN_LIFT)}
#define GVOL_SALT_CELL ${SALT_CELL}u
#define GVOL_SALT_TREE ${SALT_TREE}u
#define GVOL_BYTE ${BYTE}u
#define GVOL_U16 ${U16}u
#define GVOL_TAU 6.28318530718
const int GVOL_TREE_SECTORS[GVOL_TREE_RINGS] = int[GVOL_TREE_RINGS](${TREE_SECTORS.join(', ')});   // sites per ring
uniform uint uSceneSeed;

// the rock's top at world column c: the floor, and the cone over it
int gvolTop(ivec2 c) {
  float d = length(vec2(c) + 0.5 - GVOL_CENTER);
  return GVOL_FLOOR + max(0, int(floor(GVOL_H * (1.0 - d / GVOL_R) + 0.5)));
}
// the conduit's radius at height y (the chamber's below GVOL_CHAMBER_TOP); 0 outside it
float gvolConduitR(int y) {
  if (y < GVOL_FLOOR || y >= GVOL_CONDUIT_TOP) return 0.0;
  if (y >= GVOL_CHAMBER_TOP) return GVOL_CONDUIT_R;
  return GVOL_XZ * (GVOL_CHAMBER_BULGE * (1.0 - float(y - GVOL_FLOOR) / (GVOL_V * GVOL_CHAMBER_FADE)) + GVOL_CHAMBER_NECK);
}
float gvolJitter(uint h) { return (float(h & GVOL_BYTE) / float(GVOL_BYTE) * 2.0 - 1.0) * GVOL_TREE_JITTER; }
// the tree a cell at distance d from the summit and offset o from it could be
// part of: (its trunk's low corner column x, z, its base), base -1 where its site has none
ivec3 gvolTree(vec2 o, float d) {
  int k = int(floor((d - GVOL_TREE_IN) / GVOL_TREE_RING_W + 0.5));
  if (k < 0 || k >= GVOL_TREE_RINGS) return ivec3(0, 0, -1);
  int n = GVOL_TREE_SECTORS[k];
  float a = atan(o.y, o.x);
  if (a < 0.0) a += GVOL_TAU;
  int j = min(int(floor(a * float(n) / GVOL_TAU)), n - 1);
  uint h = pcg(uint(j) + pcg(uint(k) + pcg(uSceneSeed + GVOL_SALT_TREE)));
  if (float(h & (GVOL_U16 - 1u)) / float(GVOL_U16) >= GVOL_TREE_CHANCE) return ivec3(0, 0, -1);
  uint h2 = pcg(h);
  float ring = GVOL_TREE_IN + float(k) * GVOL_TREE_RING_W;
  float r = ring + gvolJitter(h2), th = (float(j) + 0.5) * GVOL_TAU / float(n) + gvolJitter(h2 >> 8u) / ring;
  ivec2 t = ivec2(floor(GVOL_CENTER + r * vec2(cos(th), sin(th)) - 0.5 * float(GVOL_TRUNK_W) + 0.5));
  return ivec3(t, gvolTop(t));
}

void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  vec2 o = vec2(w.xz) + 0.5 - GVOL_CENTER;
  float d = length(o);
  int top = gvolTop(w.xz);
  // the cone on the sea floor, the sea round it
  int id = w.y < top ? E_ROCK : w.y < GVOL_SEA ? E_WATER : E_EMPTY;
  // the magma chamber and the conduit, full of lava
  if (d < gvolConduitR(w.y)) id = E_LAVA;
  // An endless lava source on the summit. (A buried source would just seal
  // itself in: the cellular automaton has no magma pressure to push lava up.)
  if (all(greaterThanEqual(w, GVOL_CLONE_LO)) && all(lessThan(w, GVOL_CLONE_HI))) id = E_CLONE;
  // trees on the flanks
  ivec3 t = gvolTree(o, d);
  if (t.z >= 0) {
    vec3 c = vec3(float(t.x) + 0.5 * float(GVOL_TRUNK_W), float(t.z) + GVOL_CROWN_LIFT, float(t.y) + 0.5 * float(GVOL_TRUNK_W));
    vec3 r = vec3(w) + 0.5 - c;
    if (abs(r.y) < GVOL_CROWN_HALF && dot(r, r) < GVOL_CROWN_R * GVOL_CROWN_R) id = E_PLANT;
    else if (all(greaterThanEqual(w.xz, t.xy)) && all(lessThan(w.xz, t.xy + GVOL_TRUNK_W))
             && w.y >= t.z - GVOL_TRUNK_ROOT && w.y < t.z + GVOL_TRUNK_H) id = E_WOOD;
  }
  // the snow cap
  if (d > GVOL_SNOW_IN && d < GVOL_SNOW_OUT && w.y >= top && w.y < top + GVOL_SNOW_DEPTH) id = E_SNOW;
  // The conduit's is the only lava, hotter than spawned lava and remembering
  // it was stone; the source is the only clone, already copying lava.
  float T = id == E_LAVA ? GVOL_LAVA_T : SPAWNT[id];
  float ctype = id == E_LAVA ? float(E_STONE) : id == E_CLONE ? float(E_LAVA) : 0.0;
  float seed = float(seedWorld(w, uSceneSeed, GVOL_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), T, SPAWNLIFE[id], ctype + seed);
  B = vec4(0.0);
}
`;

export const giantVolcano = {
  key: 'giantVolcano',
  label: 'Giant volcano',
  params: ({ size, seed }) => ({ size, seed, sea: VOLC_SEA, floor: VOLC_FLOOR }),
  glsl,
  uniforms: (P) => ({ uSceneSeed: { value: P.seed } }),
  start(P, win) {
    const len = Math.hypot(...ISLAND_VIEW_XZ), dir = ISLAND_VIEW_XZ.map((v) => v / len);
    const at = (r) => [CENTER[0] + dir[0] * r, CENTER[1] + dir[1] * r];
    let r = 0;
    while (r < CONE_R && coneTop(...at(r).map(Math.floor)) >= VOLC_SEA) r++;
    return at(r - START_INLAND * Math.max(...win));
  },
  // the top of the topmost matter in the column (the sea's, off the shore)
  ground(x, z, P) {
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let y = MATTER_TOP; y >= 0; y--) if (volcCell(cx, y, cz, P.seed) !== E.EMPTY) return y + 1;
    return 0;
  },
};
