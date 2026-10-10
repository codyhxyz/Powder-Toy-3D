import { prelude, BRICK } from './common.js';
import { generatorGLSL, layersGLSL } from './generate.js';
import { lib } from './render.js';
import { surfaceGLSL } from './gfx/surface.js';
import { liquidGLSL } from './gfx/liquid.js';
import { CELL_M } from '../scale.js';
import { TREE, MID_TREES, HIGH_TREES } from '../world/generator.js';
import { scaleFor } from '../constructions/runtime.js';
import { E } from '../elements.js';

// The far field (docs/scaling.md D11, "Far field"; phase W4): everything of a
// massive world outside the simulated window, at brick resolution.
//
// The far grid. One RGBA8 texel per 4³ world brick, in a 2D atlas of
// horizontal brick slices (farTexel, like the render fields' Y-slices), so a
// region of it is rewritten in one draw and its channels filter bilinearly
// inside a slice (farSample finishes the trilinear lerp between two slices):
//   r  opaque share: the share of the cube of FAR.CUBE cells centred on the
//      brick that stops light (solids, powders, lava, glass)
//   g  liquid share: the same for transparent liquids (water, oil, acid)
//   b  ids (texelFetch only), of the brick's own cells: its dominant opaque
//      element, a cell open above counting FAR.SURFACE_W times (a brick reads
//      as its surface: grass on rock reads as grass), plus FAR.LIQ_STRIDE × its
//      liquid's kind (FAR_LIQUIDS; one past them: none), plus FAR.OPEN if it
//      holds open opaque cells (the view reads a surface's element from such
//      a brick)
//   a  glow: how hot its open opaque cells are, from the incandescence's first
//      knot up over FAR.GLOW_SPAN °C
// Values sit at brick centres. The drawn surface is where the trilinear field
// crosses FAR.ISO, as for the window's smooth surfaces. The cube is twice the
// brick: a box filter as wide as two sample spacings makes the field linear in
// the ground's height between the two centres around it (0.5 + (h - y) / 8),
// so the surface sits exactly on a height field and slopes shade evenly. (A
// filter one brick wide, the brick's own share, puts it up to a third of a
// cell off, with a period of a brick: terraces.)
//
// The field. Thin matter, filling under half its cube with no brick next to
// it at the surface level (a trunk, a wall up to three cells thick, a roof, a
// falling stream), would never reach FAR.ISO and vanish, so it reads as
// FAR.THIN_V (farBoostFrag, into a second, filtered target the view samples):
// an isolated brick then draws as a blob ~1.6 cells across, a line of them as
// a rod ~2.3 cells thick, a sheet as a slab one brick thick. Next to a brick at
// the surface level a brick keeps its share: that is what puts the ground's
// surface, a crown's or a cliff's, where it is. Scattered matter under
// FAR.THIN_MIN (less than a line of cells through the cube) keeps its share
// too: a few loose grains draw nothing.
//
// Occupancy. Two coarser levels say where the surface can be at all: an L1
// node (4³ bricks, 16³ cells) is set when some brick in it or next to it
// reaches FAR.ISO (opaque + liquid), an L2 node (4³ L1 nodes, 64³ cells) when
// one of its L1 nodes is. The trilinear field can only reach FAR.ISO between
// brick centres one of which does, so a ray skips every unset node whole.
//
// Shadows: per brick column, the top of its opaque matter (farTopFrag), and
// from those the height below which the sun is blocked (farShadowFrag): a
// shadow height field, the max over the columns toward the sun of their top
// less the sun ray's drop on the way. Along a sun ray the height above it
// can only fall, so a point is lit or not by one lookup, and the window's own
// shadow map finds where its texel rays first go under it by bisection.
export const FAR = {
  ISO: 0.5,            // the field's surface level
  CUBE: 8,             // cells: the edge of the cube centred on a brick whose share it holds (twice the brick)
  THIN_MIN: 1 / 80,    // matter filling at least this share of its cube (a line of cells through it, a single-cell
                       // trunk: 8/512, safely over it in 8 bits), with no brick next to it at ISO, reads as THIN_V...
  THIN_V: 1.0,         // ...so it stands as a blob, rod or slab instead of vanishing
  SURFACE_W: 8,        // a cell open above counts this many times toward the dominant element
  LIQ_STRIDE: 32,      // the id channel: opaque id + LIQ_STRIDE × liquid kind (element ids stay below it)...
  OPEN: 128,           // ...+ OPEN if the brick holds opaque cells open above (liquid kinds stay below OPEN / LIQ_STRIDE)
  ID_SCALE: 255,       // an id channel value in an 8-bit channel
  GLOW_SPAN: 2000,     // °C the glow channel spans above the incandescence table's first knot
};
// Liquid kinds of the id channel (index → element key; the first is the
// default); one more says the brick's own cells hold none.
export const FAR_LIQUIDS = ['WATER', 'OIL', 'ACID'];
const liquidKindGLSL = () => /* glsl */ `
#define FAR_KINDS ${FAR_LIQUIDS.length}
#define FAR_KIND_NONE ${FAR_LIQUIDS.length}
int farLiquidKind(int id) { ${FAR_LIQUIDS.slice(1).map((k, i) => `if (id == E_${k}) return ${i + 1};`).join(' ')} return 0; }
int farLiquidId(int kind) { ${FAR_LIQUIDS.slice(1).map((k, i) => `if (kind == ${i + 1}) return E_${k};`).join(' ')} return E_${FAR_LIQUIDS[0]}; }
`;

// Children per node edge at each occupancy level: an L1 node is 4³ bricks, an L2 node 4³ L1 nodes.
export const FAR_NODE = 4;
const FAR_ATLAS_MAX = 8192;   // texels: the widest atlas row the far grid may use

// Slices per atlas row for n slices of w × h texels: the smallest divisor of n
// from the near-square count up (so no slot is empty), else that count.
function sliceCols(n, w, h) {
  const root = Math.max(1, Math.ceil(Math.sqrt((n * h) / w)));
  for (let c = root; c <= n && c * w <= FAR_ATLAS_MAX; c++) if (n % c === 0) return c;
  return root;
}

// The one world size (app.js WORLDS). Its far layout is compiled into the
// box's view, shadow and GI programs too, their far parts off (uFar): a box and
// a world then share every big program, so switching to a world compiles none.
export const WORLD_SIZE = [1024, 128, 1024];

// The far grid's layout for a world of `size` cells: bricks, the atlas, the
// occupancy levels and the brick-column maps.
export function farLayout(size) {
  const [wx, wy, wz] = size;
  if ([wx, wy, wz].some((n) => n % BRICK)) throw new Error(`far field: world ${size} must be whole ${BRICK}-cell bricks`);
  // (occupancy nodes round up: the last ones along an axis may stick out of the world)
  const level = (div) => {
    const n = [wx, wy, wz].map((v) => Math.ceil(v / div));
    const cols = sliceCols(n[1], n[0], n[2]);
    return { n, cols, width: cols * n[0], height: Math.ceil(n[1] / cols) * n[2] };
  };
  return {
    size: [wx, wy, wz],
    bricks: level(BRICK),
    l1: level(BRICK * FAR_NODE),
    l2: level(BRICK * FAR_NODE * FAR_NODE),
  };
}

const glf = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// Layout defines and atlas addressing, shared by every far pass.
export const farLayoutGLSL = (L) => /* glsl */ `
#define WORLD_X ${L.size[0]}
#define WORLD_Y ${L.size[1]}
#define WORLD_Z ${L.size[2]}
#define WBX ${L.bricks.n[0]}         // world bricks along x, y, z
#define WBY ${L.bricks.n[1]}
#define WBZ ${L.bricks.n[2]}
#define FAR_COLS ${L.bricks.cols}       // brick slices per atlas row
#define FAR_W ${L.bricks.width}
#define FAR_H ${L.bricks.height}
#define F1X ${L.l1.n[0]}         // L1 nodes
#define F1Y ${L.l1.n[1]}
#define F1Z ${L.l1.n[2]}
#define F1_COLS ${L.l1.cols}
#define F2X ${L.l2.n[0]}         // L2 nodes
#define F2Y ${L.l2.n[1]}
#define F2Z ${L.l2.n[2]}
#define F2_COLS ${L.l2.cols}
#define FAR_BRICK ${BRICK}            // cells per brick edge (the prelude's BS, for passes without it)
#define FAR_NODE ${FAR_NODE}
#define FAR_L1_CELLS ${BRICK * FAR_NODE}
#define FAR_L2_CELLS ${BRICK * FAR_NODE * FAR_NODE}
#define FAR_ISO ${glf(FAR.ISO)}
#define FAR_CUBE ${FAR.CUBE}
#define FAR_CUBE_LO ${(FAR.CUBE - BRICK) / 2}          // cells the cube reaches past the brick on each side
#define FAR_THIN_MIN ${glf(FAR.THIN_MIN)}
#define FAR_THIN_V ${glf(FAR.THIN_V)}
#define FAR_SURFACE_W ${glf(FAR.SURFACE_W)}
#define FAR_LIQ_STRIDE ${FAR.LIQ_STRIDE}
#define FAR_OPEN ${FAR.OPEN}
#define FAR_ID_SCALE ${glf(FAR.ID_SCALE)}
#define FAR_GLOW_SPAN ${glf(FAR.GLOW_SPAN)}
const ivec3 WORLD = ivec3(WORLD_X, WORLD_Y, WORLD_Z);
const ivec3 WB = ivec3(WBX, WBY, WBZ);
ivec2 farTexel(ivec3 b) { return ivec2((b.y % FAR_COLS) * WBX + b.x, (b.y / FAR_COLS) * WBZ + b.z); }
ivec3 farBrickFromFrag(ivec2 f) {
  int tx = f.x / WBX, ty = f.y / WBZ;
  return ivec3(f.x - tx * WBX, ty * FAR_COLS + tx, f.y - ty * WBZ);
}
ivec2 far1Texel(ivec3 n) { return ivec2((n.y % F1_COLS) * F1X + n.x, (n.y / F1_COLS) * F1Z + n.z); }
ivec3 far1FromFrag(ivec2 f) {
  int tx = f.x / F1X, ty = f.y / F1Z;
  return ivec3(f.x - tx * F1X, ty * F1_COLS + tx, f.y - ty * F1Z);
}
ivec2 far2Texel(ivec3 n) { return ivec2((n.y % F2_COLS) * F2X + n.x, (n.y / F2_COLS) * F2Z + n.z); }
ivec3 far2FromFrag(ivec2 f) {
  int tx = f.x / F2X, ty = f.y / F2Z;
  return ivec3(f.x - tx * F2X, ty * F2_COLS + tx, f.y - ty * F2Z);
}
`;

// Region draws into the far grid: one quad per brick slice covering bricks
// [uFarLo, uFarLo + uFarSize) along x and z (every slice: regions span the
// world's height). position = (corner x, corner y, slice).
export const farRegionVert = (L) => /* glsl */ `
${farLayoutGLSL(L)}
in vec3 position;
uniform ivec3 uFarLo;
uniform ivec3 uFarSize;
void main() {
  int s = int(position.z);
  vec2 o = vec2(float((s % FAR_COLS) * WBX + uFarLo.x), float((s / FAR_COLS) * WBZ + uFarLo.z));
  vec2 t = o + position.xy * vec2(uFarSize.xz);
  gl_Position = vec4(t / vec2(FAR_W, FAR_H) * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Counting a brick's cells into its texel (both summaries: the generator's and the window's).
const countGLSL = /* glsl */ `
// what stops light in the far field, and what is a transparent liquid
bool farOpaque(int id) { return id != E_EMPTY && KIND[id] != K_GAS && RCLASS[id] != R_LIQUID; }
bool farLiquid(int id) { return RCLASS[id] == R_LIQUID; }
${liquidKindGLSL()}
struct FarCount {
  float w[NE];           // dominant-element weights (the brick's opaque cells)
  float wl[FAR_KINDS];   // its liquid cells by kind
  float open, heat;      // its open opaque cells, and their degrees above the glow's start
  float s, l;            // opaque and liquid cells of its cube
};
FarCount farCountInit() {
  FarCount c;
  for (int i = 0; i < NE; i++) c.w[i] = 0.0;
  for (int i = 0; i < FAR_KINDS; i++) c.wl[i] = 0.0;
  c.open = c.heat = c.s = c.l = 0.0;
  return c;
}
// one of the brick's own cells: id at temperature T, with id 'above' over it
void farCell(inout FarCount c, int id, int above, float T) {
  if (farOpaque(id)) {
    bool open = !farOpaque(above);
    c.w[id] += open ? FAR_SURFACE_W : 1.0;
    if (open) { c.open += 1.0; c.heat += max(T - INCAND_T0, 0.0); }
  } else if (farLiquid(id)) {
    c.wl[farLiquidKind(id)] += 1.0;
  }
}
vec4 farPack(FarCount c) {
  float n = float(FAR_CUBE * FAR_CUBE * FAR_CUBE);
  int best = E_EMPTY;
  for (int i = 1; i < NE; i++) if (c.w[i] > c.w[best]) best = i;
  int lk = 0;
  for (int i = 1; i < FAR_KINDS; i++) if (c.wl[i] > c.wl[lk]) lk = i;
  if (c.wl[lk] == 0.0) lk = FAR_KIND_NONE;
  float glow = c.open > 0.0 ? c.heat / c.open / FAR_GLOW_SPAN : 0.0;
  int open = c.open > 0.0 ? FAR_OPEN : 0;
  return vec4(c.s / n, c.l / n, float(best + FAR_LIQ_STRIDE * lk + open) / FAR_ID_SCALE, clamp(glow, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------- trees
// The window plants the generator's trees (world/generator.js treesIn) as the
// TREE constructions (constructions/builtins.js TREES) when their columns are
// first visited. The far field places the same trees at world load, on the
// GPU: a candidate per brick column (farTreeCandFrag, treeCandidate's twin),
// thinned by the same rule (farTreeThinFrag), each drawn into the far grid as
// its construction's shape at brick scale (farGenFrag). The constructions
// draw from mulberry32 (runtime.js makeRng), whose i-th draw is a function of
// the seed and i alone, and every draw before a shape that consumes draws per
// cell (ball, a frayed disc) is a known count in: so each tree's height, an
// oak's crowns, a pine's tiers and a palm's lean are its construction's own;
// what comes after (crown sizes, birch clusters, fronds) takes the range's
// middle. Keep the numbers below in step with constructions/builtins.js.
export const TREE_VARIANTS = ['oak', 'birch', 'pine', 'palm', 'dead'];
// Draw ranges and shares of a tree's height H, from constructions/builtins.js TREES.
export const TREE_SHAPE = {
  OAK_H: [21, 26],          // H = round(range(...) · T)
  OAK_TRUNK: [0.36, 0.44],  // trunk height, share of H (draw 1)
  OAK_TR: 1.1,              // trunk radius tr = max(0.5, OAK_TR · T), drawn tr + OAK_TR_PAD...
  OAK_TR_PAD: 0.4,
  OAK_FLARE: 1.6,           // ...and a root-flare disc of radius tr + OAK_FLARE (one draw per cell of its square)
  OAK_CROWN_Y: 0.3,         // the first crown: above the trunk by this share of H
  OAK_BRANCHES: [3, 5],     // branches (draws: count, then the first azimuth)
  OAK_AZ_JITTER: 0.3,       // per branch: azimuth jitter (radians)...
  OAK_EL: [0.5, 1.0],       // ...elevation (radians)...
  OAK_DROP: [0, 2],         // ...start this many cells below the trunk's top...
  OAK_LEN: [0.26, 0.36],    // ...length, share of H; a crown at its end
  OAK_CROWN_R: 0.23,        // crown radius, share of H (the middle of 0.2..0.26)...
  OAK_CROWN_SY: 0.75,       // ...squashed vertically
  PINE_H: [26, 32],
  PINE_Y0: [0.14, 0.22],    // lowest tier, share of H (draw 1)
  PINE_R: [0.22, 0.27],     // tier radius at the bottom, share of H (draw 2)
  PINE_TIERS: [4, 5.5],     // tiers · sqrt(T) (draw 3), at least PINE_TIERS_MIN
  PINE_TIERS_MIN: 3,
  PINE_TAPER: 0.9,          // a tier's radius: R (1 - u)^TAPER (1 - FLARE · phase) + TIP
  PINE_FLARE: 0.5,
  PINE_TIP: 0.6,
  BIRCH_H: [28, 34],
  BIRCH_CROWN_Y: 0.65,      // leaf clusters around the trunk from 0.4 H to 0.9 H: their middle...
  BIRCH_CROWN_R: 0.17,      // ...their reach from the trunk, share of H...
  BIRCH_CROWN_RV: 0.32,     // ...and half their height
  PALM_H: [20, 25],
  PALM_LEAN: [0.18, 0.32],  // the top leans this share of H toward a drawn azimuth (draws 1, 2)
  PALM_FROND: 0.41,         // frond length, share of H (the middle of 0.36..0.46)...
  PALM_CROWN_DROP: 0.12,    // ...the canopy's middle this share of a frond below the top...
  PALM_CROWN_R: 0.85,       // ...its radius and half height, shares of a frond
  PALM_CROWN_RV: 0.28,
  DEAD_H: [17, 22],
  DEAD_TRUNK: 0.42,         // the trunk: this share of H, radius max(0.5, T)
  TOP: 1.15,                // a tree's shape stays below this share of H above its base...
  REACH: [0.75, 0.3, 0.32, 0.85, 0.3],   // ...and within this share of H of its trunk, by kind (TREE_VARIANTS)
};
// A trunk's cross-section in cells: the lattice points a rod of radius r covers (runtime.js rod).
const rodCells = (r) => { let n = 0; for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (x * x + z * z <= r * r) n++; return n; };
const TREE_SIZES = TREE.SIZE_MAX - TREE.SIZE_MIN + 1;
const treeT = (k) => scaleFor(TREE.SIZE_MIN + k);
// trunk cross-sections per variant and size: oak tr + pad, dead max(0.5, T), the rest single cells (r 0.5 at T ≤ 1)
const trunkCells = (v, k) => {
  const T = treeT(k), S = TREE_SHAPE;
  if (v === 'oak') return rodCells(Math.max(0.5, S.OAK_TR * T) + S.OAK_TR_PAD);
  if (v === 'dead') return rodCells(Math.max(0.5, T));
  return 1;
};
// treeCandidate's choice of kind, generated from the zone tables
const zoneGLSL = (zone) => zone.map(([v, w]) => `if (pick < ${glf(w)}) return TV_${v.toUpperCase()};`).join(' ');
const treeGLSL = () => /* glsl */ `
#define TREE_CHANCE ${glf(TREE.CHANCE)}
#define TREE_SPACING ${glf(TREE.SPACING)}
#define TREE_THIN_R ${Math.ceil(TREE.SPACING / BRICK)}      // brick columns a candidate's rivals stand within
#define TREE_ABOVE_SEA ${glf(TREE.ABOVE_SEA)}
#define TREE_SLOPE_MAX ${glf(TREE.SLOPE_MAX)}
#define TREE_PALM_BELOW ${glf(TREE.PALM_BELOW)}
#define TREE_PINE_ABOVE ${glf(TREE.PINE_ABOVE)}
#define TREE_SNOW_GAP ${glf(TREE.SNOW_GAP)}
#define TREE_REACH_B ${Math.ceil(TREE.REACH / BRICK)}       // brick columns a crown reaches from its trunk
#define TREE_SIZES ${TREE_SIZES}
#define TREE_UNIT16 (1.0 / 65536.0)   // a 16-bit hash field to [0, 1)
#define TREE_NONE_LO 1e4              // band of a column with no tree in reach: empty
#define TREE_NONE_HI (-1e4)
#define TREE_VARIANTS ${TREE_VARIANTS.length}
${TREE_VARIANTS.map((v, i) => `#define TV_${v.toUpperCase()} ${i}`).join('\n')}
const float TREE_T[TREE_SIZES] = float[TREE_SIZES](${Array.from({ length: TREE_SIZES }, (_, k) => glf(+treeT(k).toFixed(4))).join(', ')});
const float TREE_TRUNK_CELLS[TREE_VARIANTS * TREE_SIZES] = float[TREE_VARIANTS * TREE_SIZES](${TREE_VARIANTS.flatMap((v) => Array.from({ length: TREE_SIZES }, (_, k) => glf(trunkCells(v, k)))).join(', ')});
${Object.entries(TREE_SHAPE).filter(([k]) => k !== 'REACH').map(([k, v]) => (Array.isArray(v)
    ? `#define TS_${k}_LO ${glf(v[0])}\n#define TS_${k}_HI ${glf(v[1])}`
    : `#define TS_${k} ${glf(v)}`)).join('\n')}
const float TS_REACH[TREE_VARIANTS] = float[TREE_VARIANTS](${TREE_SHAPE.REACH.map(glf).join(', ')});
#define TREE_TAU 6.28318530718
int treeVariant(bool coast, bool high, float pick) {
  if (coast) return TV_PALM;
  if (high) { ${zoneGLSL(HIGH_TREES)} return TV_DEAD; }
  ${zoneGLSL(MID_TREES)} return TV_DEAD;
}
// mulberry32 (constructions/runtime.js makeRng): draw i (from 0) of seed s, and its range helpers
#define MB_STEP 0x6d2b79f5u
float mbDraw(uint s, int i) {
  uint t = s + uint(i + 1) * MB_STEP;
  t = (t ^ (t >> 15u)) * (t | 1u);
  t ^= t + (t ^ (t >> 7u)) * (t | 61u);
  return float(t ^ (t >> 14u)) * UINT_TO_UNIT;
}
float mbRange(uint s, int i, float lo, float hi) { return lo + (hi - lo) * mbDraw(s, i); }
int mbInt(uint s, int i, int lo, int hi) { return lo + int(floor(float(hi - lo + 1) * mbDraw(s, i))); }
float jsRound(float x) { return floor(x + 0.5); }   // Math.round (half up)

// A tree map texel: x = 1 + offset x + BS · offset z + BS² · (variant + TREE_VARIANTS · size) (0: none),
// y = its ground (the trunk's base cell), z, w = the low and high 16 bits of h3 (treeCandidate's third hash).
struct Tree { vec3 base; int variant; int size; float T; float H; uint seed; int quarter; };
Tree treeOf(vec4 t, ivec2 bc) {
  int k = int(t.x + 0.5) - 1;
  int rest = k / (BS * BS);
  Tree r;
  r.base = vec3(float(bc.x * BS + k % BS), t.y, float(bc.y * BS + (k / BS) % BS)) + 0.5;   // the base cell's centre
  r.variant = rest % TREE_VARIANTS;
  r.size = rest / TREE_VARIANTS;
  r.T = TREE_T[r.size];
  uint h3 = uint(t.z + 0.5) | (uint(t.w + 0.5) << 16u);
  r.seed = pcg(h3);                    // its construction seed (treeCandidate)
  r.quarter = int((h3 >> 20u) & 3u);   // which way it faces (runtime.js bake)
  vec2 hr = r.variant == TV_OAK ? vec2(TS_OAK_H_LO, TS_OAK_H_HI) : r.variant == TV_BIRCH ? vec2(TS_BIRCH_H_LO, TS_BIRCH_H_HI)
          : r.variant == TV_PINE ? vec2(TS_PINE_H_LO, TS_PINE_H_HI) : r.variant == TV_PALM ? vec2(TS_PALM_H_LO, TS_PALM_H_HI)
          : vec2(TS_DEAD_H_LO, TS_DEAD_H_HI);
  r.H = jsRound(mbRange(r.seed, 0, hr.x, hr.y) * r.T);   // draw 0: every kind's height
  return r;
}
// a world offset turned back into the construction's frame (the inverse of runtime.js TURN[quarter])
vec2 treeUnturn(vec2 v, int q) {
  return q == 0 ? v : (q == 1 ? vec2(-v.y, v.x) : (q == 2 ? -v : vec2(v.y, -v.x)));
}
`;

// What a tree fills of the cube of FAR.CUBE cells centred at a point (the far
// grid's opaque share; a wide shape's share ramps over the cube across its
// surface, a trunk's is its cells in the cube), and of the brick there (its
// element's vote: leaves (PLANT) 0 or 1, its trunk's cells (WOOD)).
export const TREE_OWN_REACH = 2;   // cells: a brick whose centre is this close to a crown (or inside it) holds leaves (half its width)
const treeShapeGLSL = /* glsl */ `
#define TREE_OWN_REACH ${glf(TREE_OWN_REACH)}
float treeRamp(float d) { return clamp(0.5 - d / float(FAR_CUBE), 0.0, 1.0); }
// an ellipsoid's distance (approximate: exact for a sphere) at q, centre c, radii r
float treeEllipsoid(vec3 q, vec3 c, vec3 r) { return (length((q - c) / r) - 1.0) * min(r.x, r.y); }
// a vertical trunk of n cells' cross-section from y0 to y1 on the base's axis: its cells in the cube at q
float treeTrunk(vec3 q, float y0, float y1, float n) {
  float h = 0.5 * float(FAR_CUBE);
  if (abs(q.x) > h || abs(q.z) > h) return 0.0;
  return n * clamp(min(q.y + h, y1) - max(q.y - h, y0), 0.0, float(FAR_CUBE)) / float(FAR_CUBE * FAR_CUBE * FAR_CUBE);
}
// t: the tree, p: the cube's centre (world cells). Returns (cube share, leaves here, trunk cells here).
vec3 treeFill(Tree t, vec3 p) {
  vec3 q = p - t.base;
  q.xz = treeUnturn(q.xz, t.quarter);
  float H = t.H, T = t.T, crown = 1e9, trunkTop = 0.0;
  float cells = TREE_TRUNK_CELLS[t.variant * TREE_SIZES + t.size];
  if (t.variant == TV_OAK) {
    float th = jsRound(H * mbRange(t.seed, 1, TS_OAK_TRUNK_LO, TS_OAK_TRUNK_HI));
    float tr = max(0.5, TS_OAK_TR * T);
    int R = int(ceil(tr + TS_OAK_FLARE + 1.0));   // the root flare's disc: one draw per cell of its square
    int i0 = 2 + (2 * R + 1) * (2 * R + 1);
    int n = mbInt(t.seed, i0, int(TS_OAK_BRANCHES_LO), int(TS_OAK_BRANCHES_HI));
    float a0 = mbDraw(t.seed, i0 + 1) * TREE_TAU;
    vec3 rad = vec3(1.0, TS_OAK_CROWN_SY, 1.0) * TS_OAK_CROWN_R * H;
    crown = treeEllipsoid(q, vec3(0.0, th + TS_OAK_CROWN_Y * H, 0.0), rad);
    for (int i = 0; i < int(TS_OAK_BRANCHES_HI); i++) {
      if (i >= n) break;
      int k = i0 + 2 + 4 * i;
      float az = a0 + float(i) / float(n) * TREE_TAU + mbRange(t.seed, k, -TS_OAK_AZ_JITTER, TS_OAK_AZ_JITTER);
      float el = mbRange(t.seed, k + 1, TS_OAK_EL_LO, TS_OAK_EL_HI);
      float y = th - float(mbInt(t.seed, k + 2, int(TS_OAK_DROP_LO), int(TS_OAK_DROP_HI)));
      float len = H * mbRange(t.seed, k + 3, TS_OAK_LEN_LO, TS_OAK_LEN_HI);
      vec3 b = vec3(0.0, y, 0.0) + vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el)) * len;
      crown = min(crown, treeEllipsoid(q, b, rad));
    }
    trunkTop = th;
  } else if (t.variant == TV_PINE) {
    float y0 = jsRound(H * mbRange(t.seed, 1, TS_PINE_Y0_LO, TS_PINE_Y0_HI));
    float R = H * mbRange(t.seed, 2, TS_PINE_R_LO, TS_PINE_R_HI);
    float tiers = max(TS_PINE_TIERS_MIN, jsRound(mbRange(t.seed, 3, TS_PINE_TIERS_LO, TS_PINE_TIERS_HI) * sqrt(T)));
    float u = (clamp(q.y, y0, H) - y0) / max(H - y0, 1.0);
    float r = R * pow(1.0 - u, TS_PINE_TAPER) * (1.0 - TS_PINE_FLARE * fract(u * tiers)) + TS_PINE_TIP;
    crown = max(length(q.xz) - r, max(y0 - q.y, q.y - H));
    trunkTop = H;
  } else if (t.variant == TV_BIRCH) {
    crown = treeEllipsoid(q, vec3(0.0, TS_BIRCH_CROWN_Y * H, 0.0), vec3(TS_BIRCH_CROWN_R, TS_BIRCH_CROWN_RV, TS_BIRCH_CROWN_R) * H);
    trunkTop = H;
  } else if (t.variant == TV_PALM) {
    float az = mbDraw(t.seed, 1) * TREE_TAU;
    float lean = H * mbRange(t.seed, 2, TS_PALM_LEAN_LO, TS_PALM_LEAN_HI);
    float L = TS_PALM_FROND * H;
    vec3 top = vec3(cos(az) * lean, H, sin(az) * lean);
    crown = treeEllipsoid(q, top - vec3(0.0, TS_PALM_CROWN_DROP * L, 0.0), vec3(TS_PALM_CROWN_R, TS_PALM_CROWN_RV, TS_PALM_CROWN_R) * L);
    trunkTop = H;
  } else {
    trunkTop = TS_DEAD_TRUNK * H;
  }
  float share = max(crown < 1e8 ? treeRamp(crown) : 0.0, treeTrunk(q, 0.0, trunkTop, cells));
  float h = 0.5 * float(BS);
  float rows = abs(q.x) < h && abs(q.z) < h ? clamp(min(q.y + h, trunkTop) - max(q.y - h, 0.0), 0.0, float(BS)) : 0.0;
  return vec3(share, crown < TREE_OWN_REACH ? 1.0 : 0.0, cells * rows);
}
`;

// Tree candidates, per brick column (treeCandidate's twin): its trunk's
// column hashed from the brick column, kept on ground it may stand on (the
// world's columns: tCol, genColumn plus the margin; slope as layersAt has it).
export const farTreeCandFrag = (g, L) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${layersGLSL}
${farLayoutGLSL(L)}
${treeGLSL()}
out vec4 oC;
void main() {
  ivec2 bc = ivec2(gl_FragCoord.xy);
  oC = vec4(0.0);
  uint h = pcg(uint(bc.x) + pcg(uint(bc.y) + genStream(GEN_SALT_TREE)));
  if (float(h & 0xffffu) * TREE_UNIT16 >= TREE_CHANCE) return;
  uint h2 = pcg(h), h3 = pcg(h2);
  ivec2 o = ivec2(int(h2 & uint(BS - 1)), int((h2 >> 2u) & uint(BS - 1)));
  ivec2 col = bc * BS + o;
  GenLayers Lc = columnLayers(col);
  float slope = 0.5 * length(vec2(colHeight(col + ivec2(1, 0)) - colHeight(col - ivec2(1, 0)),
                                  colHeight(col + ivec2(0, 1)) - colHeight(col - ivec2(0, 1))));
  float above = float(Lc.ground) - uGenSea;
  bool sand = Lc.sand > 0;
  if (above < TREE_ABOVE_SEA || slope >= TREE_SLOPE_MAX || !(Lc.plant || sand)) return;
  if (float(Lc.ground) > genFrostLine() - TREE_SNOW_GAP) return;
  bool coast = sand && above <= TREE_PALM_BELOW;
  if (sand && !coast) return;
  int variant = treeVariant(coast, above >= TREE_PINE_ABOVE * uGenRelief, float(h3 & 0xffffu) * TREE_UNIT16);
  int size = int((h3 >> 16u) % uint(TREE_SIZES));
  // (x: the packed tree; y: its ground; z: its priority, h2's top 24 bits)
  oC = vec4(float(1 + o.x + BS * o.y + BS * BS * (variant + TREE_VARIANTS * size)), float(Lc.ground), float(h2 >> 8u), 0.0);
}
`;

// Thinning (treesIn): a candidate with a rival within TREE.SPACING that has a
// higher priority (ties: the lower brick index) is dropped. Out: the tree map
// (treeOf), with the candidate's h3 (hashed again from its brick column) for
// the shapes.
export const farTreeThinFrag = (g, L) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${farLayoutGLSL(L)}
${treeGLSL()}
uniform sampler2D tCand;
out vec4 oC;
vec2 trunkXZ(ivec2 bc, vec4 c) { int k = int(c.x + 0.5) - 1; return vec2(bc * BS + ivec2(k % BS, (k / BS) % BS)); }
void main() {
  ivec2 bc = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(tCand, bc, 0);
  oC = vec4(0.0);
  if (c.x == 0.0) return;
  vec2 pc = trunkXZ(bc, c);
  for (int dz = -TREE_THIN_R; dz <= TREE_THIN_R; dz++)
  for (int dx = -TREE_THIN_R; dx <= TREE_THIN_R; dx++) {
    if (dx == 0 && dz == 0) continue;
    ivec2 nb = bc + ivec2(dx, dz);
    if (any(lessThan(nb, ivec2(0))) || any(greaterThanEqual(nb, WB.xz))) continue;   // past the world: deep sea, no trees
    vec4 o = texelFetch(tCand, nb, 0);
    if (o.x == 0.0 || distance(trunkXZ(nb, o), pc) >= TREE_SPACING) continue;
    if (o.z > c.z || (o.z == c.z && (dz < 0 || (dz == 0 && dx < 0)))) return;
  }
  // kept: h3 from the brick column's hash chain (as the candidate pass), in 16-bit halves
  uint h = pcg(uint(bc.x) + pcg(uint(bc.y) + genStream(GEN_SALT_TREE)));
  uint h3 = pcg(pcg(h));
  oC = vec4(c.x, c.y, float(h3 & 0xffffu), float(h3 >> 16u));
}
`;

// Tree bands, per brick column: the lowest base and highest top (cells) of the
// trees in reach of it (TREE_NONE_* if none): farGenFrag looks for trees only
// in bricks inside the band.
export const farTreeBandFrag = (g, L) => /* glsl */ `
${prelude(g)}
${farLayoutGLSL(L)}
${treeGLSL()}
uniform sampler2D tTrees;
out vec4 oC;
void main() {
  ivec2 bc = ivec2(gl_FragCoord.xy);
  float lo = TREE_NONE_LO, hi = TREE_NONE_HI;
  for (int dz = -TREE_REACH_B; dz <= TREE_REACH_B; dz++)
  for (int dx = -TREE_REACH_B; dx <= TREE_REACH_B; dx++) {
    ivec2 nb = bc + ivec2(dx, dz);
    if (any(lessThan(nb, ivec2(0))) || any(greaterThanEqual(nb, WB.xz))) continue;
    vec4 t = texelFetch(tTrees, nb, 0);
    if (t.x == 0.0) continue;
    Tree tr = treeOf(t, nb);
    lo = min(lo, t.y);
    hi = max(hi, t.y + TS_TOP * tr.H);
  }
  oC = vec4(lo, hi, 0.0, 1.0);
}
`;

// Generator → layers, per world column: what genLayers says column (x, z)
// holds, as bytes (ground, sand, snow, plant). tCol: genColumn of the world's
// columns plus COLUMN_MARGIN (the column pass with uColOrigin = -margin).
export const LAYER_BYTE = 255;   // a byte in a normalised RGBA8 channel
export const farLayersFrag = (g) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${layersGLSL}
out vec4 oC;
#define LAYER_BYTE ${glf(LAYER_BYTE)}
void main() {
  GenLayers L = columnLayers(ivec2(gl_FragCoord.xy));
  oC = vec4(float(L.ground), float(L.sand), float(L.snow), L.plant ? 1.0 : 0.0) / LAYER_BYTE;
}
`;

// Generator → far grid, at world load: every brick from the world's layers
// (genId per cell, as the fill pass makes them; the cubes' shares counted per
// column from its ground and the sea), and the trees in reach (their shapes'
// shares joined to the ground's, their leaves or trunk the brick's element).
// Columns past the world's edge repeat its edge.
export const FAR_TREE_W = 512;   // dominant-element weight of a crown in a brick (a brick's 64 cells, open: over the ground's)
export const farGenFrag = (g, L) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${farLayoutGLSL(L)}
${countGLSL}
${treeGLSL()}
${treeShapeGLSL}
uniform sampler2D tLayers;     // world column (x, z): ground, sand, snow, plant (farLayersFrag)
uniform sampler2D tTrees;      // the tree map (farTreeThinFrag)
uniform sampler2D tTreeBand;   // per brick column, the trees' band in reach (farTreeBandFrag)
out vec4 oC;
#define FAR_TREE_W ${glf(FAR_TREE_W)}
#define FAR_TREE_PAD ${glf(Math.SQRT2 * FAR.CUBE / 2)}   // cells: a cube's half diagonal across, past a tree's reach
#define LAYER_BYTE ${glf(LAYER_BYTE)}
GenLayers worldLayers(ivec2 col) {
  ivec4 t = ivec4(texelFetch(tLayers, clamp(col, ivec2(0), WORLD.xz - 1), 0) * LAYER_BYTE + 0.5);
  GenLayers L;
  L.ground = t.x; L.sand = t.y; L.snow = t.z; L.plant = t.w > 0;
  return L;
}
// cells of [y0, y0 + FAR_CUBE) under the ground (opaque: genId's layers and the rock below the world), and of the sea
float groundIn(GenLayers L, int y0) { return float(clamp(L.ground - y0, 0, FAR_CUBE)); }
float seaIn(GenLayers L, int y0, int top) { return float(clamp(min(top, y0 + FAR_CUBE) - max(L.ground, y0), 0, FAR_CUBE)); }
void main() {
  ivec3 b = farBrickFromFrag(ivec2(gl_FragCoord.xy));
  FarCount c = farCountInit();
  ivec3 o = b * BS;
  int sea = int(ceil(uGenSea));   // genId: water in y < uGenSea
  int y0 = o.y - FAR_CUBE_LO;     // the cube's bottom
  for (int dz = -FAR_CUBE_LO; dz < BS + FAR_CUBE_LO; dz++)
  for (int dx = -FAR_CUBE_LO; dx < BS + FAR_CUBE_LO; dx++) {
    GenLayers L = worldLayers(o.xz + ivec2(dx, dz));
    c.s += groundIn(L, y0);
    c.l += seaIn(L, y0, sea);
    if (dx < 0 || dz < 0 || dx >= BS || dz >= BS) continue;
    int above = genId(L, o.y + BS);   // (genId: rock below the world, air above it)
    for (int y = BS - 1; y >= 0; y--) {
      int id = genId(L, o.y + y);
      farCell(c, id, above, AMBIENT);
      above = id;
    }
  }
  // the trees in reach, where the cube meets their band: the union of their shares with the ground's
  vec2 band = texelFetch(tTreeBand, b.xz, 0).xy;
  if (float(y0) < band.y && float(y0 + FAR_CUBE) > band.x) {
    vec3 pc = vec3(o) + 0.5 * float(BS);   // the brick's (and its cube's) centre
    float ts = 0.0, leaves = 0.0, trunk = 0.0;
    for (int dz = -TREE_REACH_B; dz <= TREE_REACH_B; dz++)
    for (int dx = -TREE_REACH_B; dx <= TREE_REACH_B; dx++) {
      ivec2 nb = b.xz + ivec2(dx, dz);
      if (any(lessThan(nb, ivec2(0))) || any(greaterThanEqual(nb, WB.xz))) continue;
      vec4 t = texelFetch(tTrees, nb, 0);
      if (t.x == 0.0) continue;
      Tree tr = treeOf(t, nb);
      // too far from its trunk, above its top or under its base for the cube
      if (length(pc.xz - tr.base.xz) > TS_REACH[tr.variant] * tr.H + FAR_TREE_PAD
          || float(y0) > tr.base.y + TS_TOP * tr.H || float(y0 + FAR_CUBE) < tr.base.y) continue;
      vec3 f = treeFill(tr, pc);
      ts = max(ts, f.x);
      leaves = max(leaves, f.y);
      trunk += f.z;
    }
    c.s = max(c.s, ts * float(FAR_CUBE * FAR_CUBE * FAR_CUBE));
    // their cells vote as open ones (FAR.SURFACE_W): a crown's outweigh the ground's, a thin trunk's don't
    if (leaves > 0.0) { c.w[E_PLANT] += FAR_TREE_W; c.open += 1.0; }
    else if (trunk > 0.0) { c.w[E_WOOD] += trunk * FAR_SURFACE_W; c.open += 1.0; }
  }
  oC = farPack(c);
}
`;

// Window → far grid: the window's own state, brick by brick, for the region
// being drawn (world bricks; uOrigin the window's). Below the world counts as
// rock, above it as air; a cube reaching past the window's sides repeats them.
export const farWinFrag = (g, L) => /* glsl */ `
${prelude(g)}
${farLayoutGLSL(L)}
${countGLSL}
out vec4 oC;
void main() {
  ivec3 gb = farBrickFromFrag(ivec2(gl_FragCoord.xy)) - uOrigin / BS;   // the grid's brick
  if (any(lessThan(gb, ivec3(0))) || any(greaterThanEqual(gb, ivec3(BX, BY, BZ)))) discard;
  FarCount c = farCountInit();
  ivec3 o = gb * BS;
  for (int dz = -FAR_CUBE_LO; dz < BS + FAR_CUBE_LO; dz++)
  for (int dx = -FAR_CUBE_LO; dx < BS + FAR_CUBE_LO; dx++) {
    ivec2 col = clamp(o.xz + ivec2(dx, dz), ivec2(0), ivec2(NX, NZ) - 1);
    bool own = dx >= 0 && dz >= 0 && dx < BS && dz < BS;
    int above = E_EMPTY;
    // top down through the cube [-lo, BS + lo)
    for (int dy = BS + FAR_CUBE_LO - 1; dy >= -FAR_CUBE_LO; dy--) {
      int y = o.y + dy;
      vec4 a = y >= NY ? vec4(float(E_EMPTY), AMBIENT, 0.0, 0.0)
             : (y < 0 ? vec4(float(E_ROCK), AMBIENT, 0.0, 0.0) : fetchA(ivec3(col.x, y, col.y)));
      int id = eid(a);
      if (farOpaque(id)) c.s += 1.0;
      else if (farLiquid(id)) c.l += 1.0;
      if (own && dy >= 0 && dy < BS) farCell(c, id, above, a.y);
      above = id;
    }
  }
  oC = farPack(c);
}
`;

// The field the view draws, per brick of the region being drawn, from the
// grid's raw shares: a brick keeps its share where it or one of its 26
// neighbours reaches FAR.ISO (opaque; for the liquid, opaque + liquid), where
// it holds less than FAR.THIN_MIN, or where its own cells hold none of it (the
// share is its neighbours' matter reaching into its cube: an element-less
// blob); else it is thin matter: FAR.THIN_V. Below the world counts as
// reaching it. b: 1 if it or a neighbour holds FAR.THIN_MIN of matter: the
// field can only reach FAR.ISO in a brick next to one at FAR.ISO, boosted or
// not, so a ray crosses a brick without it in one step.
export const farBoostFrag = (L) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${farLayoutGLSL(L)}
#define E_EMPTY ${E.EMPTY}
${liquidKindGLSL().split('\n').filter((l) => l.startsWith('#define')).join('\n')}
uniform sampler2D tFar;
out vec4 oC;
void main() {
  ivec3 b = farBrickFromFrag(ivec2(gl_FragCoord.xy));
  vec4 t = texelFetch(tFar, farTexel(b), 0);
  vec2 raw = t.rg;
  int ids = int(t.b * FAR_ID_SCALE + 0.5) % FAR_OPEN;
  bool ownS = ids % FAR_LIQ_STRIDE != E_EMPTY, ownL = ids / FAR_LIQ_STRIDE != FAR_KIND_NONE;
  float ns = raw.r, nm = raw.r + raw.g;   // the most opaque, and most matter, here and next to it
  if (b.y == 0) ns = nm = 1.0;
  for (int dz = -1; dz <= 1; dz++)
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++) {
    ivec3 q = b + ivec3(dx, dy, dz);
    if (any(lessThan(q, ivec3(0))) || any(greaterThanEqual(q, WB))) continue;
    vec2 v = texelFetch(tFar, farTexel(q), 0).rg;
    ns = max(ns, v.r);
    nm = max(nm, v.r + v.g);
  }
  oC = vec4(ns >= FAR_ISO || raw.r < FAR_THIN_MIN || !ownS ? raw.r : FAR_THIN_V,
            nm >= FAR_ISO || raw.g < FAR_THIN_MIN || !ownL ? raw.g : FAR_THIN_V,
            nm >= FAR_THIN_MIN ? 1.0 : 0.0, 1.0);
}
`;

// L1 occupancy: is FAR.ISO reached by a brick in the node or next to it?
export const farMip1Frag = (L) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${farLayoutGLSL(L)}
uniform sampler2D tFar;
out vec4 oC;
void main() {
  ivec3 n = far1FromFrag(ivec2(gl_FragCoord.xy));
  oC = vec4(0.0);
  if (n.y >= F1Y) return;
  ivec3 lo = max(n * FAR_NODE - 1, ivec3(0)), hi = min(n * FAR_NODE + FAR_NODE + 1, WB);
  for (int z = lo.z; z < hi.z; z++)
  for (int y = lo.y; y < hi.y; y++)
  for (int x = lo.x; x < hi.x; x++) {
    vec4 v = texelFetch(tFar, farTexel(ivec3(x, y, z)), 0);
    if (v.r + v.g >= FAR_ISO) { oC = vec4(1.0); return; }
  }
}
`;

// L2 occupancy: is any of its L1 nodes set? (They carry the dilation.)
export const farMip2Frag = (L) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${farLayoutGLSL(L)}
uniform sampler2D tFar1;
out vec4 oC;
void main() {
  ivec3 n = far2FromFrag(ivec2(gl_FragCoord.xy));
  oC = vec4(0.0);
  if (n.y >= F2Y) return;
  for (int z = 0; z < FAR_NODE; z++)
  for (int y = 0; y < FAR_NODE; y++)
  for (int x = 0; x < FAR_NODE; x++) {
    ivec3 m = n * FAR_NODE + ivec3(x, y, z);
    if (all(lessThan(m, ivec3(F1X, F1Y, F1Z))) && texelFetch(tFar1, far1Texel(m), 0).r > 0.5) { oC = vec4(1.0); return; }
  }
}
`;

// Brick-column tops: the height (cells) of each column's ground, seen from
// below: where the opaque field first falls through FAR.ISO going up from the
// bottom, between the centres of the last brick at or over it and the next
// (exact for the ground: the field is 0.5 + (h - y) / 8 there). What floats
// above that (a crown, a roof) isn't a column: it would shade the ground under
// it from every side, as a pillar.
export const farTopFrag = (L) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${farLayoutGLSL(L)}
uniform sampler2D tFar;
out vec4 oC;
#define FAR_TOP_EPS 1e-3   // value steps below this count as none
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float below = texelFetch(tFar, farTexel(ivec3(c.x, 0, c.y)), 0).r;
  float h = below >= FAR_ISO ? float(WBY * FAR_BRICK) : 0.0;
  if (below >= FAR_ISO)
    for (int y = 1; y < WBY; y++) {
      float v = texelFetch(tFar, farTexel(ivec3(c.x, y, c.y)), 0).r;
      if (v < FAR_ISO) {
        h = (float(y) - 0.5 + (below - FAR_ISO) / max(below - v, FAR_TOP_EPS)) * float(FAR_BRICK);
        break;
      }
      below = v;
    }
  oC = vec4(h, 0.0, 0.0, 1.0);
}
`;

// Shadow heights, per brick column: below this height (cells) the sun is
// blocked, by the columns toward it: max over them of their top less the sun
// ray's drop from there, the tops read bilinearly along the sun's ray (read
// per column they alias into streaks). x: every column; y: columns outside the
// window only (uWinCols: its brick columns [x0, z0) .. [x1, z1)), which the
// window's shadow map adds to its own (FAR_CASTERS). Starts a column away (a
// column's own top is its surface).
export const FAR_SHADOW_STEPS = 512;     // most columns marched toward the sun
export const FAR_SHADOW_NONE = -1e4;     // cells: a height no point is below (nothing blocks the sun)
export const farShadowFrag = (L) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${farLayoutGLSL(L)}
uniform sampler2D tTop;
uniform vec3 uSun;
uniform ivec4 uWinCols;
out vec4 oC;
#define FAR_SHADOW_STEPS ${FAR_SHADOW_STEPS}
#define FAR_SHADOW_NONE ${glf(FAR_SHADOW_NONE)}
#define FAR_SUN_FLAT 1e-4   // the sun's horizontal share below which it counts as overhead (no cast shadows)
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float lh = length(uSun.xz);
  oC = vec4(FAR_SHADOW_NONE, FAR_SHADOW_NONE, 0.0, 1.0);
  if (lh < FAR_SUN_FLAT) return;
  vec2 u = uSun.xz / lh;                       // toward the sun, horizontally
  float drop = float(FAR_BRICK) * uSun.y / lh;   // cells the sun ray falls per brick column
  vec2 p = vec2(c) + 0.5;
  float sAll = FAR_SHADOW_NONE, sOut = FAR_SHADOW_NONE;
  for (int i = 1; i < FAR_SHADOW_STEPS; i++) {
    float d = float(i);
    vec2 q = p + u * d;
    if (any(lessThan(q, vec2(0.0))) || any(greaterThanEqual(q, vec2(WB.xz)))) break;
    float fall = d * drop;
    if (float(WORLD_Y) - fall <= max(sOut, 0.0)) break;   // nothing farther can rise above what is found (or the floor)
    float h = texture(tTop, q / vec2(WB.xz)).x - fall;
    sAll = max(sAll, h);
    ivec2 qc = ivec2(floor(q));
    bool inWin = all(greaterThanEqual(qc, uWinCols.xy)) && all(lessThan(qc, uWinCols.zw));
    if (!inWin) sOut = max(sOut, h);
  }
  oC = vec4(sAll, sOut, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- the view
// Sampling the far grid and its shadow heights (the view, and the window's
// passes that look outside it).
export const FAR_SHADOW_SOFT = 1.5;    // cells: half the width of a far shadow's edge
export const FAR_SHADOW_BIAS = 1.0;    // cells a point is lifted before its shadow-height test (column tops are coarse)
const farSampleGLSL = /* glsl */ `
uniform sampler2D tFar;        // ids and glow (texelFetch)
uniform sampler2D tFarField;   // the field: opaque, liquid (filtered), near (texelFetch)
uniform sampler2D tFar1;
uniform sampler2D tFar2;
uniform sampler2D tFarShadow;
#define FAR_SHADOW_SOFT ${glf(FAR_SHADOW_SOFT)}
#define FAR_SHADOW_BIAS ${glf(FAR_SHADOW_BIAS)}
// The far field at world point p (cells), trilinear: r opaque, g liquid.
vec4 farSample(vec3 p) {
  vec3 q = clamp(p * (1.0 / float(BS)), vec3(0.5), vec3(WB) - 0.5);   // bricks, held to the edge bricks' centres
  float fy = q.y - 0.5;
  int y0 = int(fy);
  int y1 = min(y0 + 1, WBY - 1);
  vec2 inv = 1.0 / vec2(FAR_W, FAR_H);
  vec2 o0 = vec2(float((y0 % FAR_COLS) * WBX), float((y0 / FAR_COLS) * WBZ));
  vec2 o1 = vec2(float((y1 % FAR_COLS) * WBX), float((y1 / FAR_COLS) * WBZ));
  return mix(texture(tFarField, (o0 + q.xz) * inv), texture(tFarField, (o1 + q.xz) * inv), fy - float(y0));
}
// everything a ray stops at or enters (opaque + liquid)
float farMatter(vec3 p) { vec4 v = farSample(p); return v.r + v.g; }
// the ids of the brick holding p: x = dominant opaque element, y = liquid
// kind, z = 1 if it holds opaque cells open above
ivec3 farIds(vec3 p) {
  ivec3 b = clamp(ivec3(floor(p * (1.0 / float(BS)))), ivec3(0), WB - 1);
  int v = int(texelFetch(tFar, farTexel(b), 0).b * FAR_ID_SCALE + 0.5);
  int open = v / FAR_OPEN;
  v -= open * FAR_OPEN;
  return ivec3(v % FAR_LIQ_STRIDE, v / FAR_LIQ_STRIDE, open);
}
float farGlow(vec3 p) {
  ivec3 b = clamp(ivec3(floor(p * (1.0 / float(BS)))), ivec3(0), WB - 1);
  return texelFetch(tFar, farTexel(b), 0).a;
}
bool farNear(ivec3 b) { return texelFetch(tFarField, farTexel(b), 0).b > 0.5; }
bool farOcc1(ivec3 n) { return texelFetch(tFar1, far1Texel(n), 0).r > 0.5; }
bool farOcc2(ivec3 n) { return texelFetch(tFar2, far2Texel(n), 0).r > 0.5; }
// Sun visibility at world point p from the shadow heights: ch 0 every caster, 1 those outside the window.
float farSunVis(vec3 p, int ch) {
  float s = texture(tFarShadow, p.xz / vec2(WORLD.xz))[ch];
  return smoothstep(-FAR_SHADOW_SOFT, FAR_SHADOW_SOFT, p.y + FAR_SHADOW_BIAS - s);
}
`;

// Far casters in the window's sun shadow map (render.js shadowFrag): where
// along a texel's ray (grid cells, [t0, t1]: its stretch through the box) it
// first goes under the shadow height of the columns outside the window. Along
// a sun ray the height above it can only fall (see the top), so one read at
// the ray's end says whether it ever does, and bisection finds where.
export const FAR_CASTER_STEPS = 10;   // bisection steps (a box diagonal of ~220 cells to ~0.2 cells)
export const farCastersGLSL = (L) => /* glsl */ `
${farLayoutGLSL(L)}
uniform sampler2D tFarShadow;
#define FAR_CASTER_STEPS ${FAR_CASTER_STEPS}
#define FAR_SHADOW_BIAS ${glf(FAR_SHADOW_BIAS)}
bool farUnder(vec3 p) {
  vec3 w = p + vec3(uOrigin);
  return w.y + FAR_SHADOW_BIAS < texture(tFarShadow, w.xz / vec2(WORLD.xz)).y;
}
float farCasterDepth(vec3 ro, vec3 rd, float t0, float t1) {
  if (!farUnder(ro + rd * t1)) return NO_HIT;
  if (farUnder(ro + rd * t0)) return t0;
  float a = t0, b = t1;
  for (int i = 0; i < FAR_CASTER_STEPS; i++) {
    float m = 0.5 * (a + b);
    if (farUnder(ro + rd * m)) b = m; else a = m;
  }
  return b;
}
`;

// The far field in the window's GI (gi.js giGatherFrag's far): a probe's ray
// that has marched its bricks without being stopped reads the far field past
// where it ended, at doubling distances: the brick-column tops (the window's
// own region included, from its summary), so distant hills block the low sky
// and send back the light of their ground (its element's albedo, the sun
// through the shadow heights, the sky over it); a ray going down past the
// coast meets the sea (the sky in it by Fresnel, and its body); else the sky.
export const FAR_GI_STEPS = 6;       // reads along the ray past its end...
export const FAR_GI_STEP0 = 8;       // ...the first this many cells out, each next twice as far (~500 cells in all)
export const farGIGLSL = (L) => /* glsl */ `
${farLayoutGLSL(L)}
uniform sampler2D tFar;
uniform sampler2D tFarTop;
uniform sampler2D tFarShadow;
uniform float uSea;
#define FAR_GI_STEPS ${FAR_GI_STEPS}
#define FAR_GI_STEP0 ${glf(FAR_GI_STEP0)}
#define FAR_SHADOW_SOFT ${glf(FAR_SHADOW_SOFT)}
#define FAR_SHADOW_BIAS ${glf(FAR_SHADOW_BIAS)}
#define FAR_SEA_F0 0.02   // water's reflectance face on ((1.333 - 1) / (1.333 + 1))²
vec3 farGround(vec3 r, float top) {
  ivec3 b = clamp(ivec3(floor(vec3(r.x, top - 1.0, r.z) / float(FAR_BRICK))), ivec3(0), WB - 1);   // the brick under the top
  int v = int(texelFetch(tFar, farTexel(b), 0).b * FAR_ID_SCALE + 0.5);
  int id = (v % FAR_OPEN) % FAR_LIQ_STRIDE;
  float s = texture(tFarShadow, r.xz / vec2(WORLD.xz)).x;
  float sun = smoothstep(-FAR_SHADOW_SOFT, FAR_SHADOW_SOFT, top + FAR_SHADOW_BIAS - s);
  return ALBEDO[id == E_EMPTY ? E_ROCK : id] * (SUN_COL * max(uSun.y, 0.0) * sun + uSkyUp);
}
vec3 farSea(vec3 d) {
  float F = FAR_SEA_F0 + (1.0 - FAR_SEA_F0) * pow(1.0 - clamp(-d.y, 0.0, 1.0), 5.0);
  return F * skyColor(reflect(d, vec3(0.0, 1.0, 0.0))) + (1.0 - F) * SCATALB[E_WATER] * uSkyUp;
}
vec3 farBeyond(vec3 P, vec3 Q, vec3 d, inout float open) {
  vec3 w = Q + vec3(uOrigin);
  float s = FAR_GI_STEP0;
  for (int i = 0; i < FAR_GI_STEPS; i++) {
    vec3 r = w + d * s;
    if (any(lessThan(r.xz, vec2(0.0))) || any(greaterThanEqual(r.xz, vec2(WORLD.xz)))) break;
    float top = texture(tFarTop, r.xz / vec2(WORLD.xz)).x;
    if (r.y < max(top, uSea)) {
      open = 0.0;
      return top >= uSea ? farGround(r, top) : farSea(d);
    }
    s *= 2.0;
  }
  return d.y >= 0.0 ? skyColor(d) : farSea(d);
}
`;

// The full-screen pass: a triangle covering the screen, each pixel's ray as
// the homogeneous world point it meets on the far plane.
export const farVert = /* glsl */ `
uniform mat4 uWorldToScene;   // world cells → scene units
out vec4 vFar;
void main() {
  vFar = inverse(projectionMatrix * viewMatrix * uWorldToScene) * vec4(position.xy, 1.0, 1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Constants of the view (cells unless said otherwise).
const FAR_HAZE_VISIBILITY_M = 12000;   // m: meteorological range of the air (a clear day with some haze)
const KOSCHMIEDER = 3.912;             // ln(1/0.02): the 2 % contrast threshold of the visibility definition
export const FAR_VIEW = {
  MAX_STEPS: 400,          // march iterations per ray (node skips and brick segments)
  COARSE_T: 400,           // cells: past this a set node is walked two bricks at a time (a brick is a pixel or
                           // two there, and the field has no feature narrower than its cube but thin matter)
  NUDGE: 0.01,             // a ray restarts this far past a node's exit
  NEAR: 0.2,               // a brick segment whose ends both read below this gets no middle sample
  ROOT_STEPS: 4,           // regula falsi steps on a crossing
  NORMAL_STEP: 2.0,        // the normal's difference step (half a brick)
  ID_INSET: 0.6,           // the element is read this far inside the surface (in the top cell)...
  ID_JITTER: 5.0,          // ...at a point moved along it up to half this far by world noise (borders don't follow bricks)
  ID_JITTER_F: 0.21,       // that noise's frequency, per cell
  ID_DITHER: 2.0,          // ...plus up to half this per pixel and frame, which TAA blends into a soft border (LIQ_ID_DITHER)
  ID_DEEPER: 3.0,          // ...or this far inside, if that brick holds no open cells
  SUN_RAY: [2.5, 7.0, 15.0], // cells toward the sun of the short shadow ray's samples (crowns shading
                           // each other and the ground under them: the height field leaves crowns out)
  SUN_RAY_LIFT: 1.0,       // cells off the surface along its normal the short ray starts
  SUN_RAY_EDGE: [0.35, 0.65],   // field values over which a sample goes from clear to blocking
  AO_D1: 4.0, AO_D2: 10.0, // AO samples out along the normal...
  AO_K: 0.7,               // ...darkening per unit of field found there...
  AO_MIN: 0.35,            // ...down to this
  WATER_STEP: 4.0,         // the refracted ray's steps under water, looking for the bed...
  WATER_STEPS: 8,          // ...this many at most (deeper reads as open water)
  CLUMP_M: 0.6,            // m: clumps of foliage on a far crown (its leaves are below a pixel there)...
  CLUMP_H_M: 0.15,         // ...their relief (m), a bump...
  CLUMP_CAV: 0.9,          // ...and the shade in their hollows (cavity swing per unit of the clump noise)
  CLUMP_OCT: 2,            // fBm octaves of the clumps
  SUN_DISC: 40.0,          // the sun's disc radiance, × the sunlight at the ground (the real ratio blooms the whole sky)
  SUN_DISC_EDGE: 0.15,     // its soft edge, share of its radius
  HAZE: KOSCHMIEDER / (FAR_HAZE_VISIBILITY_M / CELL_M),   // extinction per cell of the air, green (blue and red follow the sky's)
  OCEAN_ROCK: 'ROCK',      // the open sea's bed beyond the world (the generator's floor)
};

// Aerial perspective, for the far field and (world mode) the window's volume:
// over d cells along rd, the air's extinction (the sky's spectral shape, scaled
// to the haze's visibility) and its in-scatter, the sky's own radiance toward
// rd, held at the horizon for rays going down, so distance fades into the sky.
export const farHazeGLSL = /* glsl */ `
#define FAR_HAZE ${FAR_VIEW.HAZE.toExponential(4)}
const vec3 FAR_HAZE_RGB = FAR_HAZE * TAU_AIR / TAU_AIR.g;
vec3 farAir(vec3 rd) {
  vec3 h = vec3(rd.x, 0.0, rd.z);
  h = dot(h, h) > 1e-8 ? normalize(h) : vec3(1.0, 0.0, 0.0);
  return skyRadiance(rd.y > 0.0 ? rd : h);
}
vec3 farHaze(vec3 col, vec3 rd, float d) {
  vec3 T = exp(-FAR_HAZE_RGB * d);
  return col * T + farAir(rd) * (1.0 - T);
}
// premultiplied colour (the volume's): the share alpha it covers takes the air's light
vec3 farHazePremul(vec3 col, float alpha, vec3 eye, vec3 p) {
  vec3 v = p - eye;
  float d = length(v);
  vec3 T = exp(-FAR_HAZE_RGB * d);
  return col * T + alpha * farAir(v / max(d, 1e-6)) * (1.0 - T);
}
`;

export const farFrag = (g, L) => /* glsl */ `
${lib(g)}
${surfaceGLSL}
${liquidGLSL}
${farLayoutGLSL(L)}
${farSampleGLSL}
${farHazeGLSL}
${liquidKindGLSL()}
uniform mat4 projectionMatrix;
uniform mat4 uWorldToScene;   // world cells → scene units
uniform mat4 uSceneToWorld;
uniform ivec3 uWinLo;         // the window's low corner (world cells): the volume draws [uWinLo, uWinLo + GRID)
uniform float uSea;           // sea level (cells): the open sea beyond the world
uniform float uFloor;         // the sea floor beyond the world (cells)
in vec4 vFar;

#define FAR_MAX_STEPS ${FAR_VIEW.MAX_STEPS}
#define FAR_COARSE_T ${glf(FAR_VIEW.COARSE_T)}
#define FAR_NUDGE ${glf(FAR_VIEW.NUDGE)}
#define FAR_NEAR ${glf(FAR_VIEW.NEAR)}
#define FAR_ROOT_STEPS ${FAR_VIEW.ROOT_STEPS}
#define FAR_NORMAL_STEP ${glf(FAR_VIEW.NORMAL_STEP)}
#define FAR_ID_INSET ${glf(FAR_VIEW.ID_INSET)}
#define FAR_ID_JITTER ${glf(FAR_VIEW.ID_JITTER)}
#define FAR_ID_JITTER_F ${glf(FAR_VIEW.ID_JITTER_F)}
#define FAR_ID_DITHER ${glf(FAR_VIEW.ID_DITHER)}
#define FAR_ID_DEEPER ${glf(FAR_VIEW.ID_DEEPER)}
#define FAR_SUN_RAY_N ${FAR_VIEW.SUN_RAY.length}
const float FAR_SUN_RAY[FAR_SUN_RAY_N] = float[FAR_SUN_RAY_N](${FAR_VIEW.SUN_RAY.map(glf).join(', ')});
#define FAR_SUN_RAY_LIFT ${glf(FAR_VIEW.SUN_RAY_LIFT)}
#define FAR_SUN_RAY_LO ${glf(FAR_VIEW.SUN_RAY_EDGE[0])}
#define FAR_SUN_RAY_HI ${glf(FAR_VIEW.SUN_RAY_EDGE[1])}
#define FAR_CLUMP_F ${glf(+(CELL_M / FAR_VIEW.CLUMP_M).toFixed(4))}   // per cell
#define FAR_CLUMP_H ${glf(+(FAR_VIEW.CLUMP_H_M / CELL_M).toFixed(4))}   // cells
#define FAR_CLUMP_CAV ${glf(FAR_VIEW.CLUMP_CAV)}
#define FAR_CLUMP_OCT ${FAR_VIEW.CLUMP_OCT}
#define FAR_AO_D1 ${glf(FAR_VIEW.AO_D1)}
#define FAR_AO_D2 ${glf(FAR_VIEW.AO_D2)}
#define FAR_AO_K ${glf(FAR_VIEW.AO_K)}
#define FAR_AO_MIN ${glf(FAR_VIEW.AO_MIN)}
#define FAR_WATER_STEP ${glf(FAR_VIEW.WATER_STEP)}
#define FAR_WATER_STEPS ${FAR_VIEW.WATER_STEPS}
#define FAR_SUN_DISC ${glf(FAR_VIEW.SUN_DISC)}
#define FAR_SUN_DISC_EDGE ${glf(FAR_VIEW.SUN_DISC_EDGE)}
#define FAR_OCEAN_BED E_${FAR_VIEW.OCEAN_ROCK}
#define FAR_ROOT_SPLIT_LO 0.15   // regula falsi splits kept off the bracket's ends (as SURF_ROOT_SPLIT_*)
#define FAR_ROOT_SPLIT_HI 0.85
#define FAR_FLAT_EPS 1e-5        // field differences below this count as flat
#define FAR_SUN_Y_MIN 0.2        // sun elevation sine floor for light fading down through liquid (LIQ_SUN_Y_MIN in render.js)

// (tNear, tFar) of the ray through the box [lo, hi); tNear > tFar: a miss
vec2 farSlab(vec3 ro, vec3 inv, vec3 lo, vec3 hi) {
  vec3 t0 = (lo - ro) * inv, t1 = (hi - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  return vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}
// t at which the ray leaves the cube [lo, lo + size)
float farExit(vec3 ro, vec3 inv, vec3 lo, float size) {
  vec3 tf = (lo + step(0.0, inv) * size - ro) * inv;
  return min(tf.x, min(tf.y, tf.z));
}

// Root of the matter field crossing FAR_ISO in [ta, tb] (fa below it, fb at or above).
float farRoot(vec3 ro, vec3 rd, float ta, float tb, float fa, float fb) {
  for (int k = 0; k < FAR_ROOT_STEPS; k++) {
    float tm = mix(ta, tb, clamp((FAR_ISO - fa) / max(fb - fa, FAR_FLAT_EPS), FAR_ROOT_SPLIT_LO, FAR_ROOT_SPLIT_HI));
    float fm = farMatter(ro + rd * tm);
    if (fm < FAR_ISO) { ta = tm; fa = fm; } else { tb = tm; fb = fm; }
  }
  return mix(ta, tb, clamp((FAR_ISO - fa) / max(fb - fa, FAR_FLAT_EPS), 0.0, 1.0));
}

// The first point along ro + rd t, t in [t0, t1], where the matter field
// reaches FAR_ISO, the window's stretch (w0, w1) left out; NO_HIT if none.
// Unset L2 and L1 nodes are crossed whole; a set one is walked brick by brick
// (two at a time past FAR_COARSE_T), the field sampled at each segment's ends
// (and its middle when either end is near the level); a brick with no matter
// around it (farNear) is crossed in one step. cut: the ray was already inside matter where it
// came out of the window (it went through the window's ground, which the
// volume draws in front: the far field only fills in behind it).
float farMarch(vec3 ro, vec3 rd, float t0, float t1, float w0, float w1, out bool cut) {
  cut = false;
  vec3 inv = 1.0 / rd;
  float t = t0, f = -1.0;   // f: the field at t (-1: not read since the last jump)
  ivec3 n2Last = ivec3(-1), n1Last = ivec3(-1);
  bool o2 = false, o1 = false;
  for (int i = 0; i < FAR_MAX_STEPS; i++) {
    if (t >= t1) break;
    if (t >= w0 && t < w1) { t = w1 + FAR_NUDGE; f = -1.0; continue; }
    vec3 p = ro + rd * t;
    ivec3 c = clamp(ivec3(floor(p)), ivec3(0), WORLD - 1);
    ivec3 n2 = c / FAR_L2_CELLS;
    if (n2 != n2Last) { n2Last = n2; o2 = farOcc2(n2); }
    if (!o2) { t = farExit(ro, inv, vec3(n2 * FAR_L2_CELLS), float(FAR_L2_CELLS)) + FAR_NUDGE; f = -1.0; continue; }
    ivec3 n1 = c / FAR_L1_CELLS;
    if (n1 != n1Last) { n1Last = n1; o1 = farOcc1(n1); }
    if (!o1) { t = farExit(ro, inv, vec3(n1 * FAR_L1_CELLS), float(FAR_L1_CELLS)) + FAR_NUDGE; f = -1.0; continue; }
    if (!farNear(c / BS)) { t = farExit(ro, inv, vec3(c / BS * BS), float(BS)) + FAR_NUDGE; f = -1.0; continue; }
    int seg = t > FAR_COARSE_T ? 2 * BS : BS;   // the segment: a brick, or a pair far off
    float te = min(farExit(ro, inv, vec3(c / seg * seg), float(seg)), t1);
    if (t < w0 && te > w0) te = w0;   // the window starts inside this brick
    if (f < 0.0) {
      f = farMatter(p);
      if (f >= FAR_ISO) { cut = true; return t; }   // (started inside matter: past the window, or at the camera)
    }
    float fe = farMatter(ro + rd * te);
    if (max(f, fe) > FAR_NEAR) {
      float tm = 0.5 * (t + te);
      float fm = farMatter(ro + rd * tm);
      if (fm >= FAR_ISO) return farRoot(ro, rd, t, tm, f, fm);
      if (fe >= FAR_ISO) return farRoot(ro, rd, tm, te, fm, fe);
    }
    f = fe;
    t = te + FAR_NUDGE;
  }
  return NO_HIT;
}

// Outward normal of the opaque (ch 0) or matter (ch 1) field: tetrahedral differences.
float farChannel(vec3 p, int ch) { vec4 v = farSample(p); return ch == 0 ? v.r : v.r + v.g; }
vec3 farNormal(vec3 p, int ch) {
  const vec2 k = vec2(1.0, -1.0);
  float h = FAR_NORMAL_STEP;
  vec3 gr = k.xyy * farChannel(p + k.xyy * h, ch) + k.yyx * farChannel(p + k.yyx * h, ch)
          + k.yxy * farChannel(p + k.yxy * h, ch) + k.xxx * farChannel(p + k.xxx * h, ch);
  float l = length(gr);
  return l > FAR_FLAT_EPS ? -gr / l : vec3(0.0, 1.0, 0.0);
}

// Sunlight past what's near (crowns, the ground's bumps): a short coarse ray
// toward the sun through the field, which the height field's shadows (the
// ground, from far) multiply.
float farSunRay(vec3 p, vec3 n) {
  vec3 o = p + n * FAR_SUN_RAY_LIFT;
  float vis = 1.0;
  for (int i = 0; i < FAR_SUN_RAY_N; i++) vis *= 1.0 - smoothstep(FAR_SUN_RAY_LO, FAR_SUN_RAY_HI, farMatter(o + uSun * FAR_SUN_RAY[i]));
  return vis;
}

// Open sky around the surface: two field samples out along the normal.
float farAO(vec3 p, vec3 n) {
  float o = farSample(p + n * FAR_AO_D1).r + farSample(p + n * FAR_AO_D2).r;
  return clamp(1.0 - FAR_AO_K * o, FAR_AO_MIN, 1.0);
}

// The opaque element at surface point p (normal n): the brick holding the
// cells just under the surface, read at a point moved along the surface by
// world noise so borders between materials meander instead of following
// bricks. The surface is within a fraction of a cell of the matter's top, but
// that top can be in the brick above or below: the first of the brick just
// inside, the one outside and the one deeper that holds open cells (its
// element is the surface's, not what lies buried under it).
#define FAR_ID_SALT_Y 17.0   // decorrelate the jitter noise's axes
#define FAR_ID_SALT_Z 31.0
int farElement(vec3 p, vec3 n) {
  vec3 j = (vec3(vnoise(p * FAR_ID_JITTER_F), vnoise(p * FAR_ID_JITTER_F + FAR_ID_SALT_Y),
                 vnoise(p * FAR_ID_JITTER_F + FAR_ID_SALT_Z)) - 0.5) * FAR_ID_JITTER
         + (hash33(vec3(gl_FragCoord.xy, float(uFrame))) - 0.5) * FAR_ID_DITHER;
  vec3 q = p + j - n * dot(n, j);
  ivec3 a = farIds(q - n * FAR_ID_INSET);
  if (a.z == 0) {
    ivec3 b = farIds(q + n * FAR_ID_INSET);
    if (b.z == 1 && b.x != E_EMPTY) return b.x;
    ivec3 c = farIds(q - n * FAR_ID_DEEPER);
    if (c.z == 1 || a.x == E_EMPTY) a = c;
  }
  return a.x == E_EMPTY ? E_ROCK : a.x;
}
float farGlowT(vec3 p, vec3 n) {
  float a = farGlow(p - n * FAR_ID_INSET);
  return a > 0.0 ? INCAND_T0 + a * FAR_GLOW_SPAN : AMBIENT;
}

// A lit opaque far surface: its material (matOf, at the pixel's footprint, so
// texture fades to its far look), the sun through the shadow heights, the sky
// over its open share, its own glow.
vec3 farShadeOpaque(vec3 p, vec3 n, vec3 rd, float sunVis) {
  int id = farElement(p, n);
  float fp = footprint(p);
  Mat m = matOf(id, p, n, farGlowT(p, n), 0.0, fp);
  if (id == E_PLANT) {
    // foliage: its leaves have faded into the far look; clumps of them still show (fading in turn)
    vec4 cl = mFbmD(p, FAR_CLUMP_F, FAR_CLUMP_OCT, fp);
    m.g += FAR_CLUMP_H * cl.yzw;
    m.cav *= 1.0 + FAR_CLUMP_CAV * cl.x;
  }
  // the material's bump tilts the normal (applyMat)
  vec3 gt = m.g - n * dot(n, m.g);
  float gl = length(gt);
  if (gl > BUMP_MAX_SLOPE) gt *= BUMP_MAX_SLOPE / gl;
  vec3 ns = normalize(n - gt);
  vec3 v = -rd;
  if (dot(ns, v) < SHADE_NV_MIN) ns = normalize(ns + v * (SHADE_NV_MIN - dot(ns, v)));
  float nv = clamp(dot(ns, v), 1e-4, 1.0), nl = dot(ns, uSun);
  float rough = clamp(m.rough, MAT_ROUGH_MIN, 1.0);
  vec3 F0 = mix(vec3(m.f0), m.alb, m.metal);
  vec3 kD = m.alb * (1.0 - m.metal);
  float wrap = max(nl + m.sss, 0.0) / ((1.0 + m.sss) * (1.0 + m.sss));
  float lam = orenNayar(nl, nv, dot(uSun, v), max(rough - ON_ROUGH_START, 0.0) * ON_SIGMA_RATE);
  vec3 dSun = kD * mix(vec3(lam), wrap * m.sssCol, m.sss);
  float cav = clamp(m.cav, 0.0, 1.0);
  vec3 c = SUN_COL * sunVis * (dSun * (SUN_CAV_MIN + SUN_CAV_GAIN * cav) + PI_S * ggxSpec(ns, v, uSun, rough, F0));
  vec3 ambient = skyAmbient(ns) * farAO(p, n) * cav;
  return c + kD * ambient + m.emit;
}

// Light scattered toward the eye inside liquid lid, per unit (1 - transmittance) (interiorScatter, without the glow volume).
vec3 farInScatter(int lid, float sunVis) {
  vec3 L = skyAmbient(vec3(0.0, 1.0, 0.0)) * mix(SKY_IN_FLOOR, 1.0, sunVis)
         + SUN_COL * sunVis * max(uSun.y, 0.0) * SUN_IN_GAIN;
  return SCATALB[lid] * L;
}
// The bed under liquid lid at p (normal n, depth below the surface): lit by
// sun and sky through the liquid above.
vec3 farShadeBed(int id, vec3 p, vec3 n, float depth, int lid, float sunVis) {
  vec3 alb = matOf(id, p, n, AMBIENT, 0.0, footprint(p)).alb;
  vec3 down = exp(-SIGMA[lid] * depth / max(uSun.y, FAR_SUN_Y_MIN));
  vec3 sky = exp(-SIGMA[lid] * depth);
  return alb * (SUN_COL * sunVis * max(dot(n, uSun), 0.0) * down + skyAmbient(n) * sky);
}
// A liquid surface at p (liquid kind lk) seen along rd: the sky and the sun's
// glint off it (Fresnel), and through it the liquid's body down to the bed:
// the opaque field along the refracted ray (bedY < 0), else the plane y = bedY.
vec3 farLiquid(vec3 p, vec3 rd, int lk, float sunVis, float bedY) {
  int lid = farLiquidId(lk);
  // the ripples, as the window's water has them (liquid.js), so its sea carries on past the window
  vec3 n = liquidRipple(p, vec3(0.0, 1.0, 0.0));
  float F = fresnelSchlick(max(dot(-rd, n), 0.0), IOR[lid]);
  vec3 r = reflect(rd, n);
  r.y = abs(r.y);   // a ripple tilted past a grazing view shows the sky above, not the ground (dark specks)
  vec3 refl = envReflect(p, r, vec3(sunVis));
  vec3 rt = refract(rd, n, 1.0 / IOR[lid]);
  if (dot(rt, rt) < 1e-6) rt = vec3(0.0, -1.0, 0.0);
  float s = -1.0;
  vec3 bed = vec3(0.0);
  if (bedY >= 0.0) {
    s = (p.y - bedY) / max(-rt.y, FAR_FLAT_EPS);
    vec3 q = p + rt * s;
    bed = farShadeBed(FAR_OCEAN_BED, q, vec3(0.0, 1.0, 0.0), p.y - q.y, lid, sunVis);
  } else {
    float ta = 0.0, fa = farSample(p).r;
    for (int i = 1; i <= FAR_WATER_STEPS; i++) {
      float tb = float(i) * FAR_WATER_STEP;
      float fb = farSample(p + rt * tb).r;
      if (fb >= FAR_ISO) {
        s = mix(ta, tb, clamp((FAR_ISO - fa) / max(fb - fa, FAR_FLAT_EPS), 0.0, 1.0));
        vec3 q = p + rt * s, nq = farNormal(q, 0);
        bed = farShadeBed(farElement(q, nq), q, nq, p.y - q.y, lid, sunVis * farSunVis(q, 0));
        break;
      }
      ta = tb; fa = fb;
    }
  }
  vec3 att = s >= 0.0 ? exp(-SIGMA[lid] * s) : vec3(0.0);
  vec3 body = bed * att + (1.0 - att) * farInScatter(lid, sunVis);
  return F * refl + (1.0 - F) * body;
}

// The clear sky toward rd, with the key light's disc (sun, or the moon at night: SUN_COL carries its colour).
vec3 farSky(vec3 rd) {
  vec3 c = skyRadiance(normalize(vec3(rd.x, max(rd.y, 0.0), rd.z)));
  float r = SUN_TAN_RADIUS;
  float mu = dot(rd, uSun);
  float disc = smoothstep(cos(r * (1.0 + FAR_SUN_DISC_EDGE)), cos(r * (1.0 - FAR_SUN_DISC_EDGE)), mu);
  return c + disc * SUN_COL * FAR_SUN_DISC;
}

float farDepth(vec3 p) {
  vec4 clip = projectionMatrix * viewMatrix * uWorldToScene * vec4(p, 1.0);
  return clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}

void main() {
  vec3 ro = (uSceneToWorld * vec4(cameraPosition, 1.0)).xyz;
  vec3 rd = safeDir(normalize(vFar.xyz / vFar.w - ro));
  surfView(ro, rd);   // pixel footprint for material LOD (uniform control flow)
  vec3 inv = 1.0 / rd;
  vec2 tw = farSlab(ro, inv, vec3(uWinLo), vec3(uWinLo + GRID));
  if (tw.x > tw.y || tw.y < 0.0) tw = vec2(NO_HIT);
  vec2 tb = farSlab(ro, inv, vec3(0.0), vec3(WORLD));
  float t0 = max(tb.x, 0.0), t1 = tb.y;
  bool cut = false;
  float tHit = t0 < t1 ? farMarch(ro, rd, t0, t1, tw.x, tw.y, cut) : NO_HIT;

  // the open sea beyond the world (and a march that ran out of steps over it)
  float tSea = rd.y < 0.0 && ro.y > uSea ? (uSea - ro.y) / rd.y : NO_HIT;
  vec3 ps = ro + rd * tSea;
  bool seaOut = any(lessThan(ps.xz, vec2(0.0))) || any(greaterThan(ps.xz, vec2(WORLD.xz)));
  bool seaWin = tSea >= tw.x && tSea <= tw.y;
  bool ocean = tSea < NO_HIT && tSea < tHit && (seaOut || (tHit == NO_HIT && !seaWin));

  vec3 col;
  float depth = 1.0;
  if (ocean) {
    col = farLiquid(ps, rd, 0, farSunVis(ps, 0), seaOut ? uFloor : -1.0);
    col = farHaze(col, rd, tSea);
    depth = farDepth(ps);
  } else if (tHit < NO_HIT) {
    vec3 p = ro + rd * tHit;
    if (cut) {
      // came out of the window inside matter. Behind the window's ground: hidden
      // (but for a dug-out side), so flat and unlit by the sun. In its water,
      // which the volume draws see-through: the water body's own light, as
      // deep water shows, so the window's water carries on past its side.
      vec4 v = farSample(p);
      col = v.r >= v.g ? ALBEDO[farIds(p).x] * skyAmbient(-rd) : farInScatter(farLiquidId(farIds(p).y), farSunVis(p, 0));
    } else {
      vec4 v = farSample(p);
      float sunVis = farSunVis(p, 0);
      if (v.g > v.r) col = farLiquid(p, rd, farIds(p - vec3(0.0, FAR_ID_INSET, 0.0)).y, sunVis, -1.0);
      else {
      vec3 n = farNormal(p, 0);
      col = farShadeOpaque(p, n, rd, sunVis * (sunVis > 0.0 && dot(n, uSun) > 0.0 ? farSunRay(p, n) : 1.0));
    }
    }
    col = farHaze(col, rd, tHit);
    depth = farDepth(p);
  } else {
    col = farSky(rd);
  }
  gl_FragColor = vec4(col, 1.0);
  gl_FragDepth = depth;
}
`;
