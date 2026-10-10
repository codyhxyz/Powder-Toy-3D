import { E } from '../../elements.js';
import { WORLD_SIZE } from '../../shaders/far.js';
import { pcg } from '../generator.js';
import { ISLAND_VIEW_XZ } from './island.js';

// The giant volcano: the box volcano (presets.js 'volcano') blown up to fill
// the world. One cone in the middle of a sea, a magma chamber under it and a
// conduit up to its summit, an endless lava source there, a ring of snow
// round the top and trees on the flanks.
//
// Its world is three times as tall as the other scenes' (VOLC_SIZE: 384 cells,
// 115 m; the window spans it), so the cone keeps the box's steepness instead
// of flattening into a shield. Across, it is the box's times the world's width
// in boxes (1024 / 128 = 8): the cone's foot is 432 cells (130 m) from its
// summit. Up, it is as tall as fits: the summit stands 350 cells (105 m)
// over the sea floor, the lava source on it VOLC_HEADROOM below the world's
// top. The flanks are concave (VOLC_PROFILE), as a stratovolcano's are: 46°
// under the summit (the box's 42°), easing to a gentle foot where the sea
// laps it, about 390 cells out.
//
// What scales how:
//   - The summit is the box's: a point, the source on it, the conduit's lava
//     standing over it, so it spills at once, all round. Lava runs off it
//     down the steep flanks, and the stone it cools into rolls away, so the
//     source stays open. (In a crater, or on a source as wide as the layout
//     scales, the lava pooled, its crust froze into stone that settled on
//     the source, and the volcano went quiet within a minute.)
//   - Everything but the cone keeps the old flat giant's cells (VOLC_DETAIL:
//     2 per box cell on every axis): the conduit, the magma chamber at the
//     cone's root and the source, the snow's depth and the trees (2-cell
//     trunks 16 tall under crowns 12 wide, about 7 m in all). Lava under 300
//     cells of rock is never seen, but every cell of it is simulated, hot and
//     stirring, whenever the window is over the summit: scaled across, the
//     conduit and chamber held a million cells and the step took 6 times the
//     island's. The sea is 16 cells (5 m) deep.
//   - The snow cap is a layer 4 cells (1.2 m) deep on the steepest flanks,
//     where a column stands up to two cells over its neighbours, so the
//     layer's top grains slide a little before it rests, as the box's do.
//   - There are ~16 times as many trees as the box's 14: its band of the
//     flanks (0.55 to 0.8 of the radius) holds rings of sites a tree's spacing
//     apart, most of them planted.
//
// A pure function of the world cell, O(1): a cell finds the one tree it could
// belong to from its ring and angle sector (the sites are far enough apart
// that no crown leaves its own sector), not by looking at every tree. The
// GLSL's #defines and the JS twin (volcCell, ground) come from the constants
// below.

const VOLC_WORLD_Y = 384;         // cells: its world's height (the other scenes' is WORLD_SIZE's, 128)
export const VOLC_SIZE = [WORLD_SIZE[0], VOLC_WORLD_Y, WORLD_SIZE[2]];
const [WX, WY, WZ] = VOLC_SIZE;
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
const BOX_CLONE_ABOVE = 1;        // ...to this far over it (the giant's: over the conduit's lava)
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

// The giant's own numbers.
export const VOLC_FLOOR = 4;      // rock under the whole sea: one brick, so the far field reads it as solid
const VOLC_HEADROOM = 24;         // open air over the highest point: room for the lava's fountain, the steam off the snow it melts and the smoke of the forest it burns
const VOLC_XZ = WX / BOX_N;       // world cells per box cell across: the world is 8 boxes wide
const VOLC_DETAIL = 2;            // world cells per box cell for everything but the cone, every axis (see the top)
const VOLC_PROFILE = 1.3;         // the flanks' concavity: the cone's height goes as (1 - d / R) to this power (1: the box's straight cone)
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
const CONDUIT_OVER = BOX_CONDUIT_OVER * VOLC_DETAIL;
const CLONE_OVER = CONDUIT_OVER + BOX_CLONE_ABOVE * VOLC_DETAIL;   // the source's top over the summit: the layout's highest point
const CONE_H = WY - VOLC_HEADROOM - CLONE_OVER - VOLC_FLOOR;     // 350: the summit as high as the headroom leaves room for
export const VOLC_SEA = VOLC_FLOOR + BOX_SEA * VOLC_DETAIL;   // 20
const SUMMIT = VOLC_FLOOR + CONE_H;
const CHAMBER_TOP = VOLC_FLOOR + BOX_CHAMBER_TOP * VOLC_DETAIL;
const CONDUIT_R = BOX_CONDUIT_R * VOLC_DETAIL;
const CONDUIT_TOP = SUMMIT + CONDUIT_OVER;
const CLONE_HALF = BOX_CLONE_HALF * VOLC_DETAIL;
const CLONE_LO = [CENTER[0] - CLONE_HALF, SUMMIT - BOX_CLONE_BELOW * VOLC_DETAIL, CENTER[1] - CLONE_HALF];
const CLONE_HI = [CENTER[0] + CLONE_HALF, SUMMIT + CLONE_OVER, CENTER[1] + CLONE_HALF];
const SNOW_IN = BOX_SNOW_IN * VOLC_XZ;
const SNOW_OUT = BOX_SNOW_OUT * VOLC_XZ;
const SNOW_DEPTH = BOX_SNOW_DEPTH * VOLC_DETAIL;
const TREE_IN = BOX_TREE_IN * CONE_R;             // the innermost ring's radius
const TREE_RING_W = (BOX_TREE_OUT - BOX_TREE_IN) * CONE_R / (TREE_RINGS - 1);   // between rings, and between sites on a ring
const TRUNK_W = BOX_TRUNK_W * VOLC_DETAIL;
const TRUNK_H = BOX_TRUNK_H * VOLC_DETAIL;
const CROWN_R = BOX_CROWN_R * VOLC_DETAIL;
const CROWN_HALF = BOX_CROWN_HALF * VOLC_DETAIL;
const CROWN_LIFT = (BOX_TRUNK_H + BOX_CROWN_LIFT) * VOLC_DETAIL;   // the crown's centre over the trunk's base
const MAX_SLOPE = (VOLC_PROFILE * CONE_H) / CONE_R;   // the flanks' steepest (under the summit): cells up per cell across
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
if (CLONE_HI[1] > WY - VOLC_HEADROOM) throw new Error('giant volcano: the source reaches into the headroom');
if (CHAMBER_TOP >= SUMMIT) throw new Error('giant volcano: the chamber reaches the summit');
// A tree's cells stand from TRUNK_ROOT under its base to its crown's top, and
// its base (the rock's top at its trunk's corner) is within the flanks'
// steepest slope over that reach (plus a cell for rounding each top) of the
// rock's top under any of its cells. Cells outside this band over their own
// rock's top can't be part of a tree, so they skip the lookup.
const TREE_SLOPE = Math.ceil(MAX_SLOPE * (TREE_REACH + TRUNK_W)) + 1;
const TREE_BELOW = TRUNK_ROOT + TREE_SLOPE;                         // cells under the rock's top
const TREE_ABOVE = Math.ceil(CROWN_LIFT + CROWN_HALF) + TREE_SLOPE;  // cells over it

// It starts on the shore the god view looks from (island.js ISLAND_VIEW_XZ:
// from +x +z), with the summit and its lava ahead: the window's centre this
// share of its width inland from the waterline, so it holds the sea, the
// shore and the outer trees.
const START_INLAND = 0.25;
// The god view's home (index.js view): from low over the sea and far back, so
// the whole cone stands in view over the shore the window starts on.
const VIEW_ELEVATION = 12;        // degrees the camera looks down from
const VIEW_DIST = 576;            // cells from the orbit target
const VIEW_LIFT = 150;            // cells the orbit target hangs over the shore (the camera looks up the cone)
const DEG = Math.PI / 180;

// ---- the JS twin (sceneCell's, step for step) ----

// the rock's top at distance d from the summit (of a column's centre): the floor, and the cone over it
const topAt = (d) => VOLC_FLOOR + Math.floor(CONE_H * Math.max(0, 1 - d / CONE_R) ** VOLC_PROFILE + 0.5);
// ...at world column (x, z)
const coneTop = (x, z) => topAt(Math.hypot(x + 0.5 - CENTER[0], z + 0.5 - CENTER[1]));
// the conduit's radius at height y (the chamber's below CHAMBER_TOP); 0 outside it
function conduitR(y) {
  if (y < VOLC_FLOOR || y >= CONDUIT_TOP) return 0;
  if (y >= CHAMBER_TOP) return CONDUIT_R;
  return VOLC_DETAIL * (BOX_CHAMBER_BULGE * (1 - (y - VOLC_FLOOR) / (VOLC_DETAIL * BOX_CHAMBER_FADE)) + BOX_CHAMBER_NECK);
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
  const top = topAt(d);
  let id = y < top ? E.ROCK : y < VOLC_SEA ? E.WATER : E.EMPTY;
  if (d < conduitR(y)) id = E.LAVA;
  if (x >= CLONE_LO[0] && y >= CLONE_LO[1] && z >= CLONE_LO[2] && x < CLONE_HI[0] && y < CLONE_HI[1] && z < CLONE_HI[2]) id = E.CLONE;
  const t = y >= top - TREE_BELOW && y < top + TREE_ABOVE ? treeAt(ox, oz, d, seed) : null;
  const part = t ? volcTreePart(t, x, y, z) : E.EMPTY;
  if (part !== E.EMPTY) id = part;
  if (d > SNOW_IN && d < SNOW_OUT && y >= top && y < top + SNOW_DEPTH) id = E.SNOW;
  return id;
}

// Where ground() starts looking down in a column whose rock's top is `top`:
// over the highest matter that can stand there, the sea, the snow and any
// tree's crown, and by the summit the conduit's lava and the source.
const LAVA_REACH = Math.max(CONDUIT_R, Math.SQRT2 * CLONE_HALF);   // cells from the summit's column they reach
const MATTER_TOP = Math.max(CONDUIT_TOP, CLONE_HI[1]);
const columnTop = (top, d) => (d < LAVA_REACH ? MATTER_TOP : Math.max(VOLC_SEA, top + Math.max(SNOW_DEPTH, TREE_ABOVE)));
// a trunk on the outermost ring still stands on the shore, not in the sea
if (topAt(TREE_IN + (TREE_RINGS - 1) * TREE_RING_W + TRUNK_REACH) <= VOLC_SEA) throw new Error('giant volcano: trees stand in the sea');

const GLSL_DIGITS = 6;            // decimals a float #define keeps (float32 holds ~7 significant digits)
const f = (x) => { const r = +x.toFixed(GLSL_DIGITS); return Number.isInteger(r) ? r.toFixed(1) : String(r); };
const glsl = () => /* glsl */ `
#define GVOL_CENTER vec2(${f(CENTER[0])}, ${f(CENTER[1])})   // the summit's column
#define GVOL_R ${f(CONE_R)}             // the cone's radius at its foot
#define GVOL_H ${f(CONE_H)}             // its height over the floor
#define GVOL_PROFILE ${f(VOLC_PROFILE)}           // the flanks' concavity
#define GVOL_FLOOR ${VOLC_FLOOR}               // rock under everything
#define GVOL_SEA ${VOLC_SEA}                // the sea's level
#define GVOL_DETAIL ${f(VOLC_DETAIL)}            // world cells per box cell for the chamber
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
#define GVOL_TREE_BELOW ${TREE_BELOW}           // a tree's cells stand within these of the rock's top under them
#define GVOL_TREE_ABOVE ${TREE_ABOVE}
#define GVOL_SALT_CELL ${SALT_CELL}u
#define GVOL_SALT_TREE ${SALT_TREE}u
#define GVOL_BYTE ${BYTE}u
#define GVOL_U16 ${U16}u
#define GVOL_TAU 6.28318530718
const int GVOL_TREE_SECTORS[GVOL_TREE_RINGS] = int[GVOL_TREE_RINGS](${TREE_SECTORS.join(', ')});   // sites per ring
uniform uint uSceneSeed;

// the rock's top at distance d from the summit (of a column's centre): the floor, and the cone over it
int gvolTopAt(float d) { return GVOL_FLOOR + int(floor(GVOL_H * pow(max(0.0, 1.0 - d / GVOL_R), GVOL_PROFILE) + 0.5)); }
// ...at world column c
int gvolTop(ivec2 c) { return gvolTopAt(length(vec2(c) + 0.5 - GVOL_CENTER)); }
// the conduit's radius at height y (the chamber's below GVOL_CHAMBER_TOP); 0 outside it
float gvolConduitR(int y) {
  if (y < GVOL_FLOOR || y >= GVOL_CONDUIT_TOP) return 0.0;
  if (y >= GVOL_CHAMBER_TOP) return GVOL_CONDUIT_R;
  return GVOL_DETAIL * (GVOL_CHAMBER_BULGE * (1.0 - float(y - GVOL_FLOOR) / (GVOL_DETAIL * GVOL_CHAMBER_FADE)) + GVOL_CHAMBER_NECK);
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
  int top = gvolTopAt(d);
  // the cone on the sea floor, the sea round it
  int id = w.y < top ? E_ROCK : w.y < GVOL_SEA ? E_WATER : E_EMPTY;
  // the magma chamber and the conduit, full of lava
  if (d < gvolConduitR(w.y)) id = E_LAVA;
  // An endless lava source on the summit. (A buried source would just seal
  // itself in: the cellular automaton has no magma pressure to push lava up.)
  if (all(greaterThanEqual(w, GVOL_CLONE_LO)) && all(lessThan(w, GVOL_CLONE_HI))) id = E_CLONE;
  // trees on the flanks
  ivec3 t = w.y >= top - GVOL_TREE_BELOW && w.y < top + GVOL_TREE_ABOVE ? gvolTree(o, d) : ivec3(0, 0, -1);
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
  size: VOLC_SIZE,
  view: {
    dir: [ISLAND_VIEW_XZ[0], Math.tan(VIEW_ELEVATION * DEG) * Math.hypot(...ISLAND_VIEW_XZ), ISLAND_VIEW_XZ[1]],
    dist: VIEW_DIST,
    lift: VIEW_LIFT,
  },
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
    const d = Math.hypot(cx + 0.5 - CENTER[0], cz + 0.5 - CENTER[1]);
    for (let y = Math.min(columnTop(topAt(d), d), WY - 1); y >= 0; y--) if (volcCell(cx, y, cz, P.seed) !== E.EMPTY) return y + 1;
    return 0;
  },
};
