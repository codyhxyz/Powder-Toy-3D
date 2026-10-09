import { prelude, BRICK } from './common.js';
import { generatorGLSL, layersGLSL } from './generate.js';
import { lib } from './render.js';
import { surfaceGLSL } from './gfx/surface.js';
import { liquidGLSL } from './gfx/liquid.js';
import { CELL_M } from '../scale.js';

// The far field (docs/scaling.md D11, "Far field"; phase W4): everything of a
// massive world outside the simulated window, at brick resolution.
//
// The far grid. One RGBA8 texel per 4³ world brick, in a 2D atlas of
// horizontal brick slices (farTexel, like the render fields' Y-slices), so a
// region of it is rewritten in one draw and its channels filter bilinearly
// inside a slice (farSample finishes the trilinear lerp between two slices):
//   r  opaque value: the share of the cube of FAR.CUBE cells centred on the
//      brick that stops light (solids, powders, lava, glass), boosted for
//      thin matter (farValue)
//   g  liquid value: the same for transparent liquids (water, oil, acid)
//   b  ids (texelFetch only), of the brick's own cells: its dominant opaque
//      element, a cell open above counting FAR.SURFACE_W times (a brick reads
//      as its surface: grass on rock reads as grass), plus FAR.LIQ_STRIDE × its
//      liquid's kind, plus FAR.OPEN if it holds open opaque cells (the view
//      reads a surface's element from such a brick)
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
// Thin matter. Matter filling under half the cube with nothing at the surface
// level under it (a trunk, a wall up to three cells thick, a roof, a falling
// stream) would never reach FAR.ISO and vanish, so it reads as FAR.THIN_V: an
// isolated brick then draws as a blob ~1.6 cells across, a line of them as a
// rod ~2.3 cells thick, a sheet as a slab one brick thick. Over the ground (the
// brick below at least FAR.SUPPORT) a brick keeps its share: that is what puts
// the ground's surface where it is. Scattered matter under FAR.THIN_MIN keeps
// its share too (a few loose grains draw nothing).
//
export const FAR = {
  ISO: 0.5,            // the field's surface level
  CUBE: 8,             // cells: the edge of the cube centred on a brick whose share it holds (twice the brick)
  SUPPORT: 0.45,       // a brick whose brick below holds at least this keeps its share (the ground's top, a slope)...
  THIN_MIN: 1 / 16,    // ...else matter filling at least this share of its cube reads as THIN_V...
  THIN_V: 1.0,         // ...so it stands as a blob, rod or slab instead of vanishing
  SURFACE_W: 8,        // a cell open above counts this many times toward the dominant element
  LIQ_STRIDE: 32,      // the id channel: opaque id + LIQ_STRIDE × liquid kind (element ids stay below it)...
  OPEN: 128,           // ...+ OPEN if the brick holds opaque cells open above (liquid kinds stay below OPEN / LIQ_STRIDE)
  ID_SCALE: 255,       // an id channel value in an 8-bit channel
  GLOW_SPAN: 2000,     // °C the glow channel spans above the incandescence table's first knot
};
// Liquid kinds of the id channel (index → element key).
export const FAR_LIQUIDS = ['WATER', 'OIL', 'ACID'];

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

// The far grid's layout for a world of `size` cells: bricks, the atlas, the
// occupancy levels and the brick-column maps.
export function farLayout(size) {
  const [wx, wy, wz] = size;
  if ([wx, wy, wz].some((n) => n % (BRICK * FAR_NODE * FAR_NODE))) {
    throw new Error(`far field: world ${size} must be whole ${BRICK * FAR_NODE * FAR_NODE}-cell L2 nodes`);
  }
  const level = (div) => {
    const n = [wx / div, wy / div, wz / div];
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
#define FAR_SUPPORT ${glf(FAR.SUPPORT)}
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
int farLiquidKind(int id) { return id == E_OIL ? 1 : (id == E_ACID ? 2 : 0); }
#define FAR_KINDS 3
struct FarCount {
  float w[NE];           // dominant-element weights (the brick's opaque cells)
  float wl[FAR_KINDS];   // its liquid cells by kind
  float open, heat;      // its open opaque cells, and their degrees above the glow's start
  float s, l;            // opaque and liquid cells of its cube
  float sb, lb;          // ...of the cube of the brick below
};
FarCount farCountInit() {
  FarCount c;
  for (int i = 0; i < NE; i++) c.w[i] = 0.0;
  for (int i = 0; i < FAR_KINDS; i++) c.wl[i] = 0.0;
  c.open = c.heat = c.s = c.l = c.sb = c.lb = 0.0;
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
// A brick's value from its cube's share f and the brick below's (see the top of shaders/far.js).
float farValue(float f, float below) {
  return f >= FAR_ISO || below >= FAR_SUPPORT || f < FAR_THIN_MIN ? f : FAR_THIN_V;
}
vec4 farPack(FarCount c) {
  float n = float(FAR_CUBE * FAR_CUBE * FAR_CUBE);
  int best = E_EMPTY;
  for (int i = 1; i < NE; i++) if (c.w[i] > c.w[best]) best = i;
  int lk = 0;
  for (int i = 1; i < FAR_KINDS; i++) if (c.wl[i] > c.wl[lk]) lk = i;
  float glow = c.open > 0.0 ? c.heat / c.open / FAR_GLOW_SPAN : 0.0;
  int open = c.open > 0.0 ? FAR_OPEN : 0;
  return vec4(farValue(c.s / n, c.sb / n), farValue(c.l / n, (c.lb + c.sb) / n),
              float(best + FAR_LIQ_STRIDE * lk + open) / FAR_ID_SCALE, clamp(glow, 0.0, 1.0));
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
// column from its ground and the sea). Columns past the world's edge repeat
// its edge. The trees aren't in it; the window adds the ones it plants as
// slabs leave.
export const farGenFrag = (g, L) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${farLayoutGLSL(L)}
${countGLSL}
uniform sampler2D tLayers;   // world column (x, z): ground, sand, snow, plant (farLayersFrag)
out vec4 oC;
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
  int y0 = o.y - FAR_CUBE_LO, yb = y0 - BS;   // the cube's bottom, and the brick below's
  for (int dz = -FAR_CUBE_LO; dz < BS + FAR_CUBE_LO; dz++)
  for (int dx = -FAR_CUBE_LO; dx < BS + FAR_CUBE_LO; dx++) {
    GenLayers L = worldLayers(o.xz + ivec2(dx, dz));
    c.s += groundIn(L, y0);
    c.sb += groundIn(L, yb);
    c.l += seaIn(L, y0, sea);
    c.lb += seaIn(L, yb, sea);
    if (dx < 0 || dz < 0 || dx >= BS || dz >= BS) continue;
    int above = genId(L, o.y + BS);   // (genId: rock below the world, air above it)
    for (int y = BS - 1; y >= 0; y--) {
      int id = genId(L, o.y + y);
      farCell(c, id, above, AMBIENT);
      above = id;
    }
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
    // top down through the cube [-lo, BS + lo) and the brick below's [-lo - BS, lo)
    for (int dy = BS + FAR_CUBE_LO - 1; dy >= -FAR_CUBE_LO - BS; dy--) {
      int y = o.y + dy;
      vec4 a = y >= NY ? vec4(float(E_EMPTY), AMBIENT, 0.0, 0.0)
             : (y < 0 ? vec4(float(E_ROCK), AMBIENT, 0.0, 0.0) : fetchA(ivec3(col.x, y, col.y)));
      int id = eid(a);
      float op = farOpaque(id) ? 1.0 : 0.0, lq = farLiquid(id) ? 1.0 : 0.0;
      if (dy >= -FAR_CUBE_LO) { c.s += op; c.l += lq; }
      if (dy < FAR_CUBE_LO) { c.sb += op; c.lb += lq; }
      if (own && dy >= 0 && dy < BS) farCell(c, id, above, a.y);
      above = id;
    }
  }
  oC = farPack(c);
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
    if (m.y < F1Y && texelFetch(tFar1, far1Texel(m), 0).r > 0.5) { oC = vec4(1.0); return; }
  }
}
`;

// Brick-column tops: the height (cells) of the top of each column's opaque
// matter, from its highest brick holding some (FAR.THIN_MIN: loose grains
// don't count): 4·y + 4·value, exact for the ground's top brick; 0 for none.
export const farTopFrag = (L) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${farLayoutGLSL(L)}
uniform sampler2D tFar;
out vec4 oC;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float h = 0.0;
  for (int y = WBY - 1; y >= 0; y--) {
    float v = texelFetch(tFar, farTexel(ivec3(c.x, y, c.y)), 0).r;
    if (v >= FAR_THIN_MIN) { h = float(y * FAR_BRICK) + float(FAR_BRICK) * min(v, 1.0); break; }
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
uniform sampler2D tFar;
uniform sampler2D tFar1;
uniform sampler2D tFar2;
uniform sampler2D tFarShadow;
#define FAR_SHADOW_SOFT ${glf(FAR_SHADOW_SOFT)}
#define FAR_SHADOW_BIAS ${glf(FAR_SHADOW_BIAS)}
// The far grid's filtered channels at world point p (cells): r, g and a
// trilinear (b is meaningless filtered: farIds).
vec4 farSample(vec3 p) {
  vec3 q = clamp(p * (1.0 / float(BS)), vec3(0.5), vec3(WB) - 0.5);   // bricks, held to the edge bricks' centres
  float fy = q.y - 0.5;
  int y0 = int(fy);
  int y1 = min(y0 + 1, WBY - 1);
  vec2 inv = 1.0 / vec2(FAR_W, FAR_H);
  vec2 o0 = vec2(float((y0 % FAR_COLS) * WBX), float((y0 / FAR_COLS) * WBZ));
  vec2 o1 = vec2(float((y1 % FAR_COLS) * WBX), float((y1 / FAR_COLS) * WBZ));
  return mix(texture(tFar, (o0 + q.xz) * inv), texture(tFar, (o1 + q.xz) * inv), fy - float(y0));
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
bool farOcc1(ivec3 n) { return texelFetch(tFar1, far1Texel(n), 0).r > 0.5; }
bool farOcc2(ivec3 n) { return texelFetch(tFar2, far2Texel(n), 0).r > 0.5; }
// Sun visibility at world point p from the shadow heights: ch 0 every caster, 1 those outside the window.
float farSunVis(vec3 p, int ch) {
  float s = texture(tFarShadow, p.xz / vec2(WORLD.xz))[ch];
  return smoothstep(-FAR_SHADOW_SOFT, FAR_SHADOW_SOFT, p.y + FAR_SHADOW_BIAS - s);
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
  NUDGE: 0.01,             // a ray restarts this far past a node's exit
  NEAR: 0.2,               // a brick segment whose ends both read below this gets no middle sample
  ROOT_STEPS: 4,           // regula falsi steps on a crossing
  NORMAL_STEP: 2.0,        // the normal's difference step (half a brick)
  ID_INSET: 0.6,           // the element is read this far inside the surface (in the top cell)...
  ID_JITTER: 5.0,          // ...at a point moved along it up to half this far by world noise (borders don't follow bricks)
  ID_JITTER_F: 0.21,       // that noise's frequency, per cell
  ID_DEEPER: 3.0,          // ...or this far inside, if that brick holds no open cells
  AO_D1: 4.0, AO_D2: 10.0, // AO samples out along the normal...
  AO_K: 0.7,               // ...darkening per unit of field found there...
  AO_MIN: 0.35,            // ...down to this
  WATER_STEP: 4.0,         // the refracted ray's steps under water, looking for the bed...
  WATER_STEPS: 8,          // ...this many at most (deeper reads as open water)
  SUN_DISC: 40.0,          // the sun's disc radiance, × the sunlight at the ground (the real ratio blooms the whole sky)
  SUN_DISC_EDGE: 0.15,     // its soft edge, share of its radius
  HAZE: KOSCHMIEDER / (FAR_HAZE_VISIBILITY_M / CELL_M),   // extinction per cell of the air, green (blue and red follow the sky's)
  OCEAN_ROCK: 'ROCK',      // the open sea's bed beyond the world (the generator's floor)
};

export const farFrag = (g, L) => /* glsl */ `
${lib(g)}
${surfaceGLSL}
${liquidGLSL}
${farLayoutGLSL(L)}
${farSampleGLSL}
uniform mat4 projectionMatrix;
uniform mat4 uWorldToScene;   // world cells → scene units
uniform mat4 uSceneToWorld;
uniform ivec3 uWinLo;         // the window's low corner (world cells): the volume draws [uWinLo, uWinLo + GRID)
uniform float uSea;           // sea level (cells): the open sea beyond the world
uniform float uFloor;         // the sea floor beyond the world (cells)
in vec4 vFar;

#define FAR_MAX_STEPS ${FAR_VIEW.MAX_STEPS}
#define FAR_NUDGE ${glf(FAR_VIEW.NUDGE)}
#define FAR_NEAR ${glf(FAR_VIEW.NEAR)}
#define FAR_ROOT_STEPS ${FAR_VIEW.ROOT_STEPS}
#define FAR_NORMAL_STEP ${glf(FAR_VIEW.NORMAL_STEP)}
#define FAR_ID_INSET ${glf(FAR_VIEW.ID_INSET)}
#define FAR_ID_JITTER ${glf(FAR_VIEW.ID_JITTER)}
#define FAR_ID_JITTER_F ${glf(FAR_VIEW.ID_JITTER_F)}
#define FAR_ID_DEEPER ${glf(FAR_VIEW.ID_DEEPER)}
#define FAR_AO_D1 ${glf(FAR_VIEW.AO_D1)}
#define FAR_AO_D2 ${glf(FAR_VIEW.AO_D2)}
#define FAR_AO_K ${glf(FAR_VIEW.AO_K)}
#define FAR_AO_MIN ${glf(FAR_VIEW.AO_MIN)}
#define FAR_WATER_STEP ${glf(FAR_VIEW.WATER_STEP)}
#define FAR_WATER_STEPS ${FAR_VIEW.WATER_STEPS}
#define FAR_SUN_DISC ${glf(FAR_VIEW.SUN_DISC)}
#define FAR_SUN_DISC_EDGE ${glf(FAR_VIEW.SUN_DISC_EDGE)}
#define FAR_HAZE ${FAR_VIEW.HAZE.toExponential(4)}
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
// Unset L2 and L1 nodes are crossed whole; a set one is walked brick by brick,
// the field sampled at each brick segment's ends (and its middle when either
// end is near the level).
float farMarch(vec3 ro, vec3 rd, float t0, float t1, float w0, float w1) {
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
    float te = min(farExit(ro, inv, vec3(c / BS * BS), float(BS)), t1);
    if (t < w0 && te > w0) te = w0;   // the window starts inside this brick
    if (f < 0.0) {
      f = farMatter(p);
      if (f >= FAR_ISO) return t;      // (starts inside matter: a jump landed in it, or the window's side cut it)
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
                 vnoise(p * FAR_ID_JITTER_F + FAR_ID_SALT_Z)) - 0.5) * FAR_ID_JITTER;
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
  Mat m = matOf(id, p, n, farGlowT(p, n), 0.0, footprint(p));
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
  int lid = lk == 1 ? E_OIL : (lk == 2 ? E_ACID : E_WATER);
  vec3 n = liquidRipple(p, vec3(0.0, 1.0, 0.0));
  float F = fresnelSchlick(max(dot(-rd, n), 0.0), IOR[lid]);
  vec3 refl = envReflect(p, reflect(rd, n), vec3(sunVis));
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
// Aerial perspective over d cells along rd: the air's extinction (the sky's
// spectral shape, scaled to the haze's visibility) and its in-scatter, the
// sky's own radiance near the horizon toward rd, so distance fades into the sky.
const vec3 FAR_HAZE_RGB = FAR_HAZE * TAU_AIR / TAU_AIR.g;
vec3 farHaze(vec3 col, vec3 rd, float d) {
  vec3 T = exp(-FAR_HAZE_RGB * d);
  return col * T + skyRadiance(normalize(vec3(rd.x, max(rd.y, 0.0), rd.z))) * (1.0 - T);
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
  float tHit = t0 < t1 ? farMarch(ro, rd, t0, t1, tw.x, tw.y) : NO_HIT;

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
    vec4 v = farSample(p);
    float sunVis = farSunVis(p, 0);
    if (v.g > v.r) col = farLiquid(p, rd, farIds(p - vec3(0.0, FAR_ID_INSET, 0.0)).y, sunVis, -1.0);
    else col = farShadeOpaque(p, farNormal(p, 0), rd, sunVis);
    col = farHaze(col, rd, tHit);
    depth = farDepth(p);
  } else {
    col = farSky(rd);
  }
  gl_FragColor = vec4(col, 1.0);
  gl_FragDepth = depth;
}
`;
