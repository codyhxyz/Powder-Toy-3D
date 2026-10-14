import { prelude, STATE_OPTS, LAYOUT, BRICK } from './common.js';
import { lib, libLayouts } from './gfx/lib.js';
import { RENDER_LAYOUT } from './bindings.js';
import { surfaceGLSL } from './gfx/surface.js';
import { liquidGLSL } from './gfx/liquid.js';
import { cloudsGLSL } from './gfx/clouds.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE, fold } from '../gpu/kernels.js';
import { CELL_M } from '../scale.js';
import { SUN_DISC, SUN_DISC_EDGE } from '../gfx/sky.js';
import { TREE, MID_TREES, HIGH_TREES } from '../world/generator.js';
import { scaleFor } from '../constructions/runtime.js';
import { sceneLayout, SCENE_BINDING } from '../world/scenes/sceneGpu.js';
import { WORLD_SCENES } from '../world/scenes/index.js';
import { presentationWGSL } from '../gfx/presentationMath.js';
// The parts the window's own pipelines read (the layout, haze, casters and GI)
// live in farShared.js (docs/webgpu.md G1, J3); re-exported for their importers.
import {
  FAR, FAR_NODE, WORLD_SIZE, farLayout, farLayoutGLSL, FAR_SHADOW_SOFT, FAR_SHADOW_BIAS, FAR_HAZE, farHazeFor, farSkyGLSL, FAR_SKY,
} from './farShared.js';
import { glf } from '../glsl.js';
export {
  FAR, FAR_NODE, WORLD_SIZE, farLayout, farLayoutGLSL, FAR_SHADOW_SOFT, FAR_SHADOW_BIAS, FAR_HAZE, farHazeGLSL,
  FAR_CASTER_STEPS, farCastersGLSL, FAR_GI_STEPS, FAR_GI_STEP0, farGIGLSL, FAR_SKY, farSkyGLSL, farHazeFor,
} from './farShared.js';

// The far field (docs/scaling.md D11, "Far field"; phase W4; docs/webgpu.md
// G1): everything of a massive world outside the simulated window, at brick
// resolution. WGSL; the names are the GLSL passes' (docs/webgpu.md W2), each
// a compute kernel now (a "Frag" is its module), but for the view, a
// fragment pass in our scene pass before the volume.
//
// The far grid. One rgba16uint texel per 4³ world brick, a 3D texture of the
// world's bricks (farShared.js farLayoutGLSL: farUnpack, farPackTexel), each
// channel holding exact integers in 8-bit fields:
//   r  opaque share, in FAR.LEVELS steps: the share of the cube of FAR.CUBE
//      cells centred on the brick that stops light (solids, powders, lava, glass)
//   g  liquid share: the same for transparent liquids (farLiquid: water, oil, acid...)
//   b  the dominant opaque element of the brick's own cells, a cell open above
//      counting FAR.SURFACE_W times (a brick reads as its surface: grass on
//      rock reads as grass)
//   a  glow, in FAR.LEVELS steps: how hot its open opaque cells are, from the
//      incandescence's first knot up over FAR.GLOW_SPAN °C
// and above them r's 256 whether it holds open opaque cells (the view reads a
// surface's element from such a brick), a's high byte the dominant
// transparent liquid of its own cells (E_EMPTY: none).
// (The shares and glow keep the 8-bit steps of the RGBA8 grid this was, so
// the field and the view are what they were.)
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
// FAR.THIN_V (farBoostFrag, into a second, filtered 3D texture the view
// samples, rgba8unorm): an isolated brick then draws as a blob ~1.6 cells
// across, a line of them as a rod ~2.3 cells thick, a sheet as a slab one
// brick thick. Next to a brick at the surface level a brick keeps its share:
// that is what puts the ground's surface, a crown's or a cliff's, where it is.
// Scattered matter under FAR.THIN_MIN (less than a line of cells through the
// cube) keeps its share too: a few loose grains draw nothing.
//
// Occupancy. Two coarser levels say where the surface can be at all: an L1
// node (4³ bricks, 16³ cells) is set when some brick in it or next to it
// reaches FAR.ISO (opaque + liquid), an L2 node (4³ L1 nodes, 64³ cells) when
// one of its L1 nodes is. The trilinear field can only reach FAR.ISO between
// brick centres one of which does, so a ray skips every unset node whole.
// (One buffer, a word a node: occupancyWords.)
//
// Shadows: per brick column, the top of its opaque matter (farTopFrag), and
// from those the height below which the sun is blocked (farShadowFrag): a
// shadow height field, the max over the columns toward the sun of their top
// less the sun ray's drop on the way. Along a sun ray the height above it
// can only fall, so a point is lit or not by one lookup, and the window's own
// shadow map finds where its texel rays first go under it by bisection
// (farShared.js farCastersGLSL).
//
// Every kernel takes the region it writes in its params; a pass over a region
// of the grid is a thread per brick of it, x fastest, then y, then z (its
// regions span the world's height), folded (gpu/kernels.js fold).
export const FAR_FORMATS = { grid: 'rgba16uint', field: 'rgba8unorm', top: 'rgba16float', shadow: 'rgba16float' };
const C = STAGE.COMPUTE;
const store = (binding, format, viewDimension = '3d') => ({ binding, visibility: C, storageTexture: { access: 'write-only', format, viewDimension } });
const sampled = (binding, sampleType, viewDimension = '3d') => ({ binding, visibility: C, texture: { sampleType, viewDimension } });
const buf = (binding, type = 'read-only-storage') => ({ binding, visibility: C, buffer: { type } });

// A region of world bricks [lo, lo + size) (x and z; size.y the world's
// height in bricks): the params of every region kernel.
export const RegionParams = uniformStruct('RegionParams', {
  lo: 'vec3i',
  size: 'vec3i',
  chunkLo: 'vec2i',   // farScene's: world cell (x, z) of its scene cells' column (0, 0)
});
const regionMain = (body) => /* wgsl */ `
${RegionParams.wgsl}
@group(3) @binding(1) var<uniform> P: RegionParams;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldId(wg, nwg) * 64u + li;
  let s = vec3u(P.size);
  if (i >= s.x * s.y * s.z) { return; }
  let b = P.lo + vec3i(vec3u(i % s.x, (i / s.x) % s.y, i / (s.x * s.y)));
${body}
}`;
/** A region kernel's dispatch over world bricks [lo, lo + size) (size along x, y, z). */
export const regionDispatch = (size) => fold(Math.ceil(size[0] * size[1] * size[2] / 64));

// Counting a brick's cells into its texel (both summaries: the generator's and the window's).
const countGLSL = /* wgsl */ `
// what stops light in the far field, and what is a transparent liquid
fn farOpaque(id: i32) -> bool { return !isGasLike(id) && RCLASS(id) != R_LIQUID; }
fn farLiquid(id: i32) -> bool { return RCLASS(id) == R_LIQUID; }
struct FarCount {
  w: array<f32, NE>,   // weights of the brick's own cells by element: opaque (their dominant one) and liquid
  open: f32,           // its open opaque cells...
  heat: f32,           // ...and their degrees above the glow's start
  s: f32,              // opaque and liquid cells of its cube
  l: f32,
}
// one of the brick's own cells: id at temperature T, with id 'above' over it
fn farCell(c: ptr<function, FarCount>, id: i32, above: i32, T: f32) {
  if (farOpaque(id)) {
    let open = !farOpaque(above);
    (*c).w[id] += select(1.0, FAR_SURFACE_W, open);
    if (open) { (*c).open += 1.0; (*c).heat += max(T - INCAND_T0, 0.0); }
  } else if (farLiquid(id)) {
    (*c).w[id] += 1.0;
  }
}
// a share or the glow in FAR_LEVELS steps, rounded as the 8-bit channel it was (half up)
fn farLevel(x: f32) -> i32 { return i32(floor(clamp(x, 0.0, 1.0) * FAR_LEVELS + 0.5)); }
fn farPack(c: ptr<function, FarCount>) -> vec4u {
  let n = f32(FAR_CUBE * FAR_CUBE * FAR_CUBE);
  var best = E_EMPTY;     // the dominant opaque element and liquid (ties: the lower id)
  var liquid = E_EMPTY;
  for (var i = 1; i < NE; i++) {
    if (farOpaque(i)) { if ((*c).w[i] > (*c).w[best]) { best = i; } }
    else if (farLiquid(i) && (*c).w[i] > (*c).w[liquid]) { liquid = i; }
  }
  var f: FarTexel;
  f.s = farLevel((*c).s / n);
  f.l = farLevel((*c).l / n);
  f.id = best;
  f.glow = farLevel(select(0.0, (*c).heat / (*c).open / FAR_GLOW_SPAN, (*c).open > 0.0));
  f.liquid = liquid;
  f.open = (*c).open > 0.0;
  return farPackTexel(f);
}
`;

// ---------------------------------------------------------------- trees
// A scene with trees (scene.trees, world/scenes/index.js: the island's) has the
// window plant them (its treesIn) as the TREE constructions
// (constructions/builtins.js TREES) when their columns are first visited. The
// far field places the same trees when it builds, on the GPU: a candidate per
// brick column (farTreeCandFrag: the scene's sceneTreeCandidate), thinned by
// treesIn's rule (farTreeThinFrag), each drawn into the far grid as its
// construction's shape at brick scale (farSceneFrag's trees). The
// constructions draw from mulberry32 (runtime.js makeRng), whose i-th draw is
// a function of the seed and i alone, and every draw before a shape that
// consumes draws per cell (ball, a frayed disc) is a known count in: so each
// tree's height, an oak's crowns, a pine's tiers and a palm's lean are its
// construction's own; what comes after (crown sizes, birch clusters, fronds)
// takes the range's middle. Keep the numbers below in step with
// constructions/builtins.js.
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
// treeTrunkCells(variant, size): a trunk's cross-section in cells (trunkCells), as code
const treeTrunkCellsGLSL = () => {
  const arms = TREE_VARIANTS.map((v) => {
    const c = Array.from({ length: TREE_SIZES }, (_, k) => glf(trunkCells(v, k)));
    const body = c.every((x) => x === c[0]) ? `return ${c[0]};`
      : `${c.slice(0, -1).map((x, k) => `if (size == ${k}) { return ${x}; }`).join(' ')} return ${c.at(-1)};`;
    return `  if (v == TV_${v.toUpperCase()}) { ${body} }`;
  });
  return `fn treeTrunkCells(v: i32, size: i32) -> f32 {\n${arms.join('\n')}\n  return 1.0;\n}`;
};
// treeCandidate's choice of kind, generated from the zone tables
const zoneGLSL = (zone) => zone.map(([v, w]) => `if (pick < ${glf(w)}) { return TV_${v.toUpperCase()}; }`).join(' ');
const treeGLSL = () => /* wgsl */ `
const TREE_CHANCE: f32 = ${glf(TREE.CHANCE)};
const TREE_SPACING: f32 = ${glf(TREE.SPACING)};
const TREE_THIN_R: i32 = ${Math.ceil(TREE.SPACING / BRICK)};      // brick columns a candidate's rivals stand within
const TREE_REACH_B: i32 = ${Math.ceil(TREE.REACH / BRICK)};       // brick columns a crown reaches from its trunk
const TREE_SIZES: i32 = ${TREE_SIZES};
const TREE_UNIT16: f32 = 1.0 / 65536.0;   // a 16-bit hash field to [0, 1)
const TREE_NONE_LO: f32 = 1e4;            // band of a column with no tree in reach: empty
const TREE_NONE_HI: f32 = -1e4;
const TREE_VARIANTS: i32 = ${TREE_VARIANTS.length};
${TREE_VARIANTS.map((v, i) => `const TV_${v.toUpperCase()}: i32 = ${i};`).join('\n')}
// (tables indexed at run time: small ones as private arrays, the trunks' as a function; docs/webgpu.md C6, H1.16)
var<private> TREE_T: array<f32, ${TREE_SIZES}> = array<f32, ${TREE_SIZES}>(${Array.from({ length: TREE_SIZES }, (_, k) => glf(+treeT(k).toFixed(4))).join(', ')});
${treeTrunkCellsGLSL()}
${Object.entries(TREE_SHAPE).filter(([k]) => k !== 'REACH').map(([k, v]) => (Array.isArray(v)
    ? `const TS_${k}_LO: f32 = ${glf(v[0])};\nconst TS_${k}_HI: f32 = ${glf(v[1])};`
    : `const TS_${k}: f32 = ${glf(v)};`)).join('\n')}
var<private> TS_REACH: array<f32, ${TREE_VARIANTS.length}> = array<f32, ${TREE_VARIANTS.length}>(${TREE_SHAPE.REACH.map(glf).join(', ')});
const TREE_TAU: f32 = 6.28318530718;
fn treeVariant(coast: bool, high: bool, pick: f32) -> i32 {
  if (coast) { return TV_PALM; }
  if (high) { ${zoneGLSL(HIGH_TREES)} return TV_DEAD; }
  ${zoneGLSL(MID_TREES)} return TV_DEAD;
}
// mulberry32 (constructions/runtime.js makeRng): draw i (from 0) of seed s, and its range helpers
const MB_STEP: u32 = 0x6d2b79f5u;
fn mbDraw(s: u32, i: i32) -> f32 {
  var t = s + u32(i + 1) * MB_STEP;
  t = (t ^ (t >> 15u)) * (t | 1u);
  t ^= t + (t ^ (t >> 7u)) * (t | 61u);
  return u32ToF32(t ^ (t >> 14u)) * UINT_TO_UNIT;
}
fn mbRange(s: u32, i: i32, lo: f32, hi: f32) -> f32 { return lo + (hi - lo) * mbDraw(s, i); }
fn mbInt(s: u32, i: i32, lo: i32, hi: i32) -> i32 { return lo + i32(floor(f32(hi - lo + 1) * mbDraw(s, i))); }
fn jsRound(x: f32) -> f32 { return floor(x + 0.5); }   // Math.round (half up)

// A tree map entry: x = 1 + offset x + BS · offset z + BS² · (variant + TREE_VARIANTS · size) (0: none),
// y = its ground (the trunk's base cell), z, w = the low and high 16 bits of its key (sceneTreeKey).
struct Tree { base: vec3f, variant: i32, size: i32, T: f32, H: f32, seed: u32, quarter: i32 }
fn treeOf(t: vec4f, bc: vec2i) -> Tree {
  let k = i32(t.x + 0.5) - 1;
  let rest = k / (BS * BS);
  var r: Tree;
  r.base = vec3f(f32(bc.x * BS + k % BS), t.y, f32(bc.y * BS + (k / BS) % BS)) + 0.5;   // the base cell's centre
  r.variant = rest % TREE_VARIANTS;
  r.size = rest / TREE_VARIANTS;
  r.T = TREE_T[r.size];
  let key = u32(t.z + 0.5) | (u32(t.w + 0.5) << 16u);
  r.seed = pcg(key);                    // its construction seed (world/generator.js treeCandidate)
  r.quarter = i32((key >> 20u) & 3u);   // which way it faces (runtime.js bake)
  var hr = vec2f(TS_DEAD_H_LO, TS_DEAD_H_HI);
  if (r.variant == TV_OAK) { hr = vec2f(TS_OAK_H_LO, TS_OAK_H_HI); }
  else if (r.variant == TV_BIRCH) { hr = vec2f(TS_BIRCH_H_LO, TS_BIRCH_H_HI); }
  else if (r.variant == TV_PINE) { hr = vec2f(TS_PINE_H_LO, TS_PINE_H_HI); }
  else if (r.variant == TV_PALM) { hr = vec2f(TS_PALM_H_LO, TS_PALM_H_HI); }
  r.H = jsRound(mbRange(r.seed, 0, hr.x, hr.y) * r.T);   // draw 0: every kind's height
  return r;
}
// a world offset turned back into the construction's frame (the inverse of runtime.js TURN[quarter])
fn treeUnturn(v: vec2f, q: i32) -> vec2f {
  if (q == 0) { return v; }
  if (q == 1) { return vec2f(-v.y, v.x); }
  if (q == 2) { return -v; }
  return vec2f(v.y, -v.x);
}
`;

// What a tree fills of the cube of FAR.CUBE cells centred at a point (the far
// grid's opaque share; a wide shape's share ramps over the cube across its
// surface, a trunk's is its cells in the cube), and of the brick there (its
// element's vote: leaves (PLANT) 0 or 1, its trunk's cells (WOOD)).
export const TREE_OWN_REACH = 2;   // cells: a brick whose centre is this close to a crown (or inside it) holds leaves (half its width)
const treeShapeGLSL = /* wgsl */ `
const TREE_OWN_REACH: f32 = ${glf(TREE_OWN_REACH)};
fn treeRamp(d: f32) -> f32 { return clamp(0.5 - d / f32(FAR_CUBE), 0.0, 1.0); }
// an ellipsoid's distance (approximate: exact for a sphere) at q, centre c, radii r
fn treeEllipsoid(q: vec3f, c: vec3f, r: vec3f) -> f32 { return (length((q - c) / r) - 1.0) * min(r.x, r.y); }
// a vertical trunk of n cells' cross-section from y0 to y1 on the base's axis: its cells in the cube at q
fn treeTrunk(q: vec3f, y0: f32, y1: f32, n: f32) -> f32 {
  let h = 0.5 * f32(FAR_CUBE);
  if (abs(q.x) > h || abs(q.z) > h) { return 0.0; }
  return n * clamp(min(q.y + h, y1) - max(q.y - h, y0), 0.0, f32(FAR_CUBE)) / f32(FAR_CUBE * FAR_CUBE * FAR_CUBE);
}
// t: the tree, p: the cube's centre (world cells). Returns (cube share, leaves here, trunk cells here).
fn treeFill(t: Tree, p: vec3f) -> vec3f {
  var q = p - t.base;
  let qt = treeUnturn(q.xz, t.quarter);
  q = vec3f(qt.x, q.y, qt.y);
  let H = t.H;
  let T = t.T;
  var crown = 1e9;
  var trunkTop = 0.0;
  let cells = treeTrunkCells(t.variant, t.size);
  if (t.variant == TV_OAK) {
    let th = jsRound(H * mbRange(t.seed, 1, TS_OAK_TRUNK_LO, TS_OAK_TRUNK_HI));
    let tr = max(0.5, TS_OAK_TR * T);
    let R = i32(ceil(tr + TS_OAK_FLARE + 1.0));   // the root flare's disc: one draw per cell of its square
    let i0 = 2 + (2 * R + 1) * (2 * R + 1);
    let n = mbInt(t.seed, i0, i32(TS_OAK_BRANCHES_LO), i32(TS_OAK_BRANCHES_HI));
    let a0 = mbDraw(t.seed, i0 + 1) * TREE_TAU;
    let rad = vec3f(1.0, TS_OAK_CROWN_SY, 1.0) * TS_OAK_CROWN_R * H;
    crown = treeEllipsoid(q, vec3f(0.0, th + TS_OAK_CROWN_Y * H, 0.0), rad);
    for (var i = 0; i < i32(TS_OAK_BRANCHES_HI); i++) {
      if (i >= n) { break; }
      let k = i0 + 2 + 4 * i;
      let az = a0 + f32(i) / f32(n) * TREE_TAU + mbRange(t.seed, k, -TS_OAK_AZ_JITTER, TS_OAK_AZ_JITTER);
      let el = mbRange(t.seed, k + 1, TS_OAK_EL_LO, TS_OAK_EL_HI);
      let y = th - f32(mbInt(t.seed, k + 2, i32(TS_OAK_DROP_LO), i32(TS_OAK_DROP_HI)));
      let len = H * mbRange(t.seed, k + 3, TS_OAK_LEN_LO, TS_OAK_LEN_HI);
      let b = vec3f(0.0, y, 0.0) + vec3f(cos(az) * cos(el), sin(el), sin(az) * cos(el)) * len;
      crown = min(crown, treeEllipsoid(q, b, rad));
    }
    trunkTop = th;
  } else if (t.variant == TV_PINE) {
    let y0 = jsRound(H * mbRange(t.seed, 1, TS_PINE_Y0_LO, TS_PINE_Y0_HI));
    let R = H * mbRange(t.seed, 2, TS_PINE_R_LO, TS_PINE_R_HI);
    let tiers = max(TS_PINE_TIERS_MIN, jsRound(mbRange(t.seed, 3, TS_PINE_TIERS_LO, TS_PINE_TIERS_HI) * sqrt(T)));
    let u = (clamp(q.y, y0, H) - y0) / max(H - y0, 1.0);
    let r = R * pow(1.0 - u, TS_PINE_TAPER) * (1.0 - TS_PINE_FLARE * fract(u * tiers)) + TS_PINE_TIP;
    crown = max(length(q.xz) - r, max(y0 - q.y, q.y - H));
    trunkTop = H;
  } else if (t.variant == TV_BIRCH) {
    crown = treeEllipsoid(q, vec3f(0.0, TS_BIRCH_CROWN_Y * H, 0.0), vec3f(TS_BIRCH_CROWN_R, TS_BIRCH_CROWN_RV, TS_BIRCH_CROWN_R) * H);
    trunkTop = H;
  } else if (t.variant == TV_PALM) {
    let az = mbDraw(t.seed, 1) * TREE_TAU;
    let lean = H * mbRange(t.seed, 2, TS_PALM_LEAN_LO, TS_PALM_LEAN_HI);
    let L = TS_PALM_FROND * H;
    let top = vec3f(cos(az) * lean, H, sin(az) * lean);
    crown = treeEllipsoid(q, top - vec3f(0.0, TS_PALM_CROWN_DROP * L, 0.0), vec3f(TS_PALM_CROWN_R, TS_PALM_CROWN_RV, TS_PALM_CROWN_R) * L);
    trunkTop = H;
  } else {
    trunkTop = TS_DEAD_TRUNK * H;
  }
  let share = max(select(0.0, treeRamp(crown), crown < 1e8), treeTrunk(q, 0.0, trunkTop, cells));
  let h = 0.5 * f32(BS);
  var rows = 0.0;
  if (abs(q.x) < h && abs(q.z) < h) { rows = clamp(min(q.y + h, trunkTop) - max(q.y - h, 0.0), 0.0, f32(BS)); }
  return vec3f(share, select(0.0, 1.0, crown < TREE_OWN_REACH), cells * rows);
}
`;

// The tree passes' buffers, a vec4f (the tree map's: treeOf) or vec2f (the
// bands) per world brick column, x fastest.
// Tree candidates, per brick column: the scene's sceneTreeCandidate (its
// tree hook's WGSL, treesIn's candidates' twin). x: the packed tree
// (treeOf), y: its ground, z: its priority.
export const TREE_CAND_BINDING = SCENE_BINDING.next;   // (after the scene's own, group 2)
const columnMain = (body) => /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldId(wg, nwg) * 64u + li;
  if (i >= u32(WBX * WBZ)) { return; }
  let bc = vec2i(i32(i) % WBX, i32(i) / WBX);
${body}
}`;
/** A brick-column kernel's dispatch over the world's brick columns. */
export const columnDispatch = (L) => fold(Math.ceil(L.bricks.n[0] * L.bricks.n[2] / 64));
export const farTreeCandFrag = (g, L, sceneGLSL, treesGLSL) => /* wgsl */ `
${prelude(g, { state: false })}
${treesGLSL}
${farLayoutGLSL(L)}
${treeGLSL()}
@group(2) @binding(${TREE_CAND_BINDING}) var<storage, read_write> cand: array<vec4f>;
${columnMain('  cand[i] = sceneTreeCandidate(bc);')}
`;

// Thinning (treesIn): a candidate with a rival within TREE.SPACING that has a
// higher priority (ties: the lower brick index) is dropped. Out: the tree map
// (treeOf), with the candidate's key (sceneTreeKey) for the shapes.
export const farTreeThinFrag = (g, L, sceneGLSL, treesGLSL) => /* wgsl */ `
${prelude(g, { state: false })}
${treesGLSL}
${farLayoutGLSL(L)}
${treeGLSL()}
@group(2) @binding(${TREE_CAND_BINDING}) var<storage, read> cand: array<vec4f>;
@group(2) @binding(${TREE_CAND_BINDING + 1}) var<storage, read_write> trees: array<vec4f>;
fn trunkXZ(bc: vec2i, c: vec4f) -> vec2f { let k = i32(c.x + 0.5) - 1; return vec2f(bc * BS + vec2i(k % BS, (k / BS) % BS)); }
fn thin(bc: vec2i, c: vec4f) -> vec4f {
  if (c.x == 0.0) { return vec4f(0.0); }
  let pc = trunkXZ(bc, c);
  for (var dz = -TREE_THIN_R; dz <= TREE_THIN_R; dz++) {
    for (var dx = -TREE_THIN_R; dx <= TREE_THIN_R; dx++) {
      if (dx == 0 && dz == 0) { continue; }
      let nb = bc + vec2i(dx, dz);
      if (any(nb < vec2i(0)) || any(nb >= WB.xz)) { continue; }   // past the world: deep sea, no trees
      let o = cand[nb.x + WBX * nb.y];
      if (o.x == 0.0 || distance(trunkXZ(nb, o), pc) >= TREE_SPACING) { continue; }
      if (o.z > c.z || (o.z == c.z && (dz < 0 || (dz == 0 && dx < 0)))) { return vec4f(0.0); }
    }
  }
  // kept: its key, in 16-bit halves
  let key = sceneTreeKey(bc);
  return vec4f(c.x, c.y, f32(key & 0xffffu), f32(key >> 16u));
}
${columnMain('  trees[i] = thin(bc, cand[i]);')}
`;

// Tree bands, per brick column: the lowest base and highest top (cells) of the
// trees in reach of it (TREE_NONE_* if none): farSceneFrag looks for trees only
// in bricks inside the band.
export const FAR_TREE_BAND_LAYOUT = [buf(0), buf(1, 'storage')];
export const farTreeBandFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
${treeGLSL()}
@group(2) @binding(0) var<storage, read> trees: array<vec4f>;
@group(2) @binding(1) var<storage, read_write> band: array<vec2f>;
fn bandOf(bc: vec2i) -> vec2f {
  var lo = TREE_NONE_LO;
  var hi = TREE_NONE_HI;
  for (var dz = -TREE_REACH_B; dz <= TREE_REACH_B; dz++) {
    for (var dx = -TREE_REACH_B; dx <= TREE_REACH_B; dx++) {
      let nb = bc + vec2i(dx, dz);
      if (any(nb < vec2i(0)) || any(nb >= WB.xz)) { continue; }
      let t = trees[nb.x + WBX * nb.y];
      if (t.x == 0.0) { continue; }
      let tr = treeOf(t, nb);
      lo = min(lo, t.y);
      hi = max(hi, t.y + TS_TOP * tr.H);
    }
  }
  return vec2f(lo, hi);
}
${columnMain('  band[i] = bandOf(bc);')}
`;

// The trees in reach of a brick, where its cube meets their band, joined to
// what its cells hold: the union of their shares with the cells', their leaves
// or trunk voting for the brick's element (farSceneFrag, for a scene with trees).
export const FAR_TREE_W = 512;   // dominant-element weight of a crown in a brick (a brick's 64 cells, open: over the ground's)
const farTreesGLSL = /* wgsl */ `
${treeGLSL()}
${treeShapeGLSL}
@group(2) @binding(3) var<storage, read> trees: array<vec4f>;   // the tree map (farTreeThinFrag)
@group(2) @binding(4) var<storage, read> band: array<vec2f>;    // per brick column, the trees' band in reach (farTreeBandFrag)
const FAR_TREE_W: f32 = ${glf(FAR_TREE_W)};
const FAR_TREE_PAD: f32 = ${glf(Math.SQRT2 * FAR.CUBE / 2)};   // cells: a cube's half diagonal across, past a tree's reach
// b: the brick; o its low corner, y0 its cube's bottom (cells)
fn farTrees(c: ptr<function, FarCount>, b: vec3i, o: vec3i, y0: i32) {
  let bd = band[b.x + WBX * b.z];
  if (f32(y0) >= bd.y || f32(y0 + FAR_CUBE) <= bd.x) { return; }
  let pc = vec3f(o) + 0.5 * f32(BS);   // the brick's (and its cube's) centre
  var ts = 0.0;
  var leaves = 0.0;
  var trunk = 0.0;
  for (var dz = -TREE_REACH_B; dz <= TREE_REACH_B; dz++) {
    for (var dx = -TREE_REACH_B; dx <= TREE_REACH_B; dx++) {
      let nb = b.xz + vec2i(dx, dz);
      if (any(nb < vec2i(0)) || any(nb >= WB.xz)) { continue; }
      let t = trees[nb.x + WBX * nb.y];
      if (t.x == 0.0) { continue; }
      let tr = treeOf(t, nb);
      // too far from its trunk, above its top or under its base for the cube
      if (length(pc.xz - tr.base.xz) > TS_REACH[tr.variant] * tr.H + FAR_TREE_PAD
          || f32(y0) > tr.base.y + TS_TOP * tr.H || f32(y0 + FAR_CUBE) < tr.base.y) { continue; }
      let f = treeFill(tr, pc);
      ts = max(ts, f.x);
      leaves = max(leaves, f.y);
      trunk += f.z;
    }
  }
  (*c).s = max((*c).s, ts * f32(FAR_CUBE * FAR_CUBE * FAR_CUBE));
  // their cells vote as open ones (FAR.SURFACE_W): a crown's outweigh the ground's, a thin trunk's don't
  if (leaves > 0.0) { (*c).w[E_PLANT] += FAR_TREE_W; (*c).open += 1.0; }
  else if (trunk > 0.0) { (*c).w[E_WOOD] += trunk * FAR_SURFACE_W; (*c).open += 1.0; }
}
`;

// Window → far grid: the window's own state, brick by brick, for the region
// being drawn (world bricks; H.origin the window's). Below the world counts as
// rock, above it as air; a cube reaching past the window's sides repeats them.
// Group 2: the grid, written.
export const FAR_WIN_LAYOUT = [store(0, FAR_FORMATS.grid)];
export const farWinFrag = (g, L) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${farLayoutGLSL(L)}
${countGLSL}
@group(2) @binding(0) var farOut: texture_storage_3d<rgba16uint, write>;
${regionMain(/* wgsl */ `
  let gb = b - H.origin / BS;   // the grid's brick
  if (any(gb < vec3i(0)) || any(gb >= vec3i(BX, BY, BZ))) { return; }
  var c: FarCount;
  let o = gb * BS;
  for (var dz = -FAR_CUBE_LO; dz < BS + FAR_CUBE_LO; dz++) {
    for (var dx = -FAR_CUBE_LO; dx < BS + FAR_CUBE_LO; dx++) {
      let col = clamp(o.xz + vec2i(dx, dz), vec2i(0), vec2i(NX, NZ) - 1);
      let own = dx >= 0 && dz >= 0 && dx < BS && dz < BS;
      var above = E_EMPTY;
      // top down through the cube [-lo, BS + lo)
      for (var dy = BS + FAR_CUBE_LO - 1; dy >= -FAR_CUBE_LO; dy--) {
        let y = o.y + dy;
        var a = vec4f(f32(E_EMPTY), AMBIENT, 0.0, 0.0);
        if (y < 0) { a = vec4f(f32(E_ROCK), AMBIENT, 0.0, 0.0); }
        else if (y < NY) { a = fetchA(vec3i(col.x, y, col.y)); }
        let id = eid(a);
        if (farOpaque(id)) { c.s += 1.0; }
        else if (farLiquid(id)) { c.l += 1.0; }
        if (own && dy >= 0 && dy < BS) { farCell(&c, id, above, a.y); }
        above = id;
      }
    }
  }
  textureStore(farOut, b, farPack(&c));`)}
`;

// ---------------------------------------------------------------- scenes
// A world scene's far grid (world/scenes/index.js) is summarized from its
// sceneCell, a chunk of FAR_SCENE.CHUNK² brick columns at a time
// (world/far.js spreads the chunks over frames, nearest the window first):
//   - farSceneCellsFrag evaluates sceneCell once per cell of the chunk's
//     columns and the FAR_CUBE_LO columns around them that its bricks' cubes
//     reach (past the world's edge the edge repeats), every height, into a
//     buffer of (id, °C) as two halves (pack2x16float: the half-float target
//     they were), its scene cells;
//   - farSceneFrag summarizes the chunk's bricks from those cells exactly as
//     farWinFrag does from the window's state (below the world rock, above it
//     air), and for a scene with trees joins the trees in reach (farTrees),
//     leaving out the brick columns the window has already summarized: the
//     window's state wins wherever it has been (the window mask, a bit per
//     world brick column).
// Each cell is evaluated once rather than once per cube that holds it (8×).
export const FAR_SCENE = {
  CHUNK: 16,   // brick columns along a chunk's edge (64 cells: 256 chunks over the world, each a small dispatch)
};
// The scene cells of a chunk: its columns with their margin, side × side,
// every height of the world: cell (x, y, z) at x + side · (z + side · y).
export function farSceneLayout(L, side = FAR_SCENE.CHUNK * BRICK + FAR.CUBE - BRICK) {
  return { side, cells: side * side * L.size[1] };
}
const sceneCellsLayoutGLSL = (L, S = farSceneLayout(L)) => /* wgsl */ `
const FSC_SIDE: i32 = ${S.side};      // cells along the chunk's columns, margin included
const FSC_WORLD_X: i32 = ${L.size[0]};
const FSC_WORLD_Y: i32 = ${L.size[1]};
const FSC_WORLD_Z: i32 = ${L.size[2]};
fn fscIndex(c: vec3i) -> u32 { return u32(c.x + FSC_SIDE * (c.z + FSC_SIDE * c.y)); }
`;
export const SceneCellsParams = uniformStruct('SceneCellsParams', { chunkLo: 'vec2i' });
/** The scene cells' dispatch for layout S (farSceneLayout). */
export const sceneCellsDispatch = (S) => fold(Math.ceil(S.cells / 64));
// sceneGLSL: the scene's glsl(g) (its group 2 from binding 0; the cells after
// it). Only the prelude comes before it, so its names can't meet the far field's.
export const SCENE_CELLS_BINDING = SCENE_BINDING.next;
export const farSceneCellsFrag = (g, L, sceneGLSL, S, live = false) => /* wgsl */ `
${prelude(g, live ? STATE_OPTS.STATE_RO : { state: false })}
${sceneGLSL}
${sceneCellsLayoutGLSL(L, S)}
${SceneCellsParams.wgsl}
@group(3) @binding(1) var<uniform> P: SceneCellsParams;
@group(2) @binding(${SCENE_CELLS_BINDING}) var<storage, read_write> cells: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldId(wg, nwg) * 64u + li;
  let side = u32(FSC_SIDE);
  if (i >= side * side * u32(FSC_WORLD_Y)) { return; }
  let c = vec3i(vec3u(i % side, i / (side * side), (i / side) % side));
  let col = clamp(P.chunkLo + c.xz, vec2i(0), vec2i(FSC_WORLD_X, FSC_WORLD_Z) - 1);
  var A = sceneCell(vec3i(col.x, c.y, col.y)).A;${live ? `
  let local = vec3i(col.x, c.y, col.y) - H.origin;
  if (inGrid(local)) { A = fetchA(local); }` : ''}
  cells[i] = pack2x16float(A.xy);
}
`;
// The summary's group 2: the grid (written), the scene cells, the window
// mask, and with trees the tree map and bands (FAR_SCENE_LAYOUT(trees)).
export const FAR_SCENE_LAYOUT = (trees) => [store(0, FAR_FORMATS.grid), buf(1), buf(2), ...(trees ? [buf(3), buf(4)] : [])];
// trees: the scene has trees (scene.trees): their tree map and bands join in.
export const farSceneFrag = (g, L, trees = false) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
${countGLSL}
${sceneCellsLayoutGLSL(L)}
${trees ? farTreesGLSL : ''}
@group(2) @binding(0) var farOut: texture_storage_3d<rgba16uint, write>;
@group(2) @binding(1) var<storage, read> cells: array<u32>;     // the chunk's scene cells (farSceneCellsFrag): id, °C
@group(2) @binding(2) var<storage, read> winMask: array<u32>;   // a bit per world brick column: the window's state has been summarized
${regionMain(/* wgsl */ `
  let m = u32(b.x + WBX * b.z);
  if (((winMask[m >> 5u] >> (m & 31u)) & 1u) != 0u) { return; }
  var c: FarCount;
  let o = b * BS;
  let lo = o.xz - P.chunkLo;   // the brick's first column among the chunk's
  for (var dz = -FAR_CUBE_LO; dz < BS + FAR_CUBE_LO; dz++) {
    for (var dx = -FAR_CUBE_LO; dx < BS + FAR_CUBE_LO; dx++) {
      let col = lo + vec2i(dx, dz);
      let own = dx >= 0 && dz >= 0 && dx < BS && dz < BS;
      var above = E_EMPTY;
      // top down through the cube [-lo, BS + lo)
      for (var dy = BS + FAR_CUBE_LO - 1; dy >= -FAR_CUBE_LO; dy--) {
        let y = o.y + dy;
        var a = vec2f(f32(E_EMPTY), AMBIENT);
        if (y < 0) { a = vec2f(f32(E_ROCK), AMBIENT); }
        else if (y < FSC_WORLD_Y) { a = unpack2x16float(cells[fscIndex(vec3i(col.x, y, col.y))]); }
        let id = eid(vec4f(a, 0.0, 0.0));
        if (farOpaque(id)) { c.s += 1.0; }
        else if (farLiquid(id)) { c.l += 1.0; }
        if (own && dy >= 0 && dy < BS) { farCell(&c, id, above, a.y); }
        above = id;
      }
    }
  }${trees ? `
  farTrees(&c, b, o, o.y - FAR_CUBE_LO);` : ''}
  textureStore(farOut, b, farPack(&c));`)}
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
// Group 2: the grid (read), the field (written).
export const FAR_BOOST_LAYOUT = [sampled(0, 'uint'), store(1, FAR_FORMATS.field)];
export const farBoostFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
@group(2) @binding(0) var tFar: texture_3d<u32>;
@group(2) @binding(1) var farField: texture_storage_3d<rgba8unorm, write>;
// a brick's shares (farUnpack)
fn farShares(f: FarTexel) -> vec2f { return vec2f(f32(f.s), f32(f.l)) / FAR_LEVELS; }
${regionMain(/* wgsl */ `
  let f = farUnpack(textureLoad(tFar, b, 0));
  let raw = farShares(f);
  let ownS = f.id != E_EMPTY;
  let ownL = f.liquid != E_EMPTY;
  var ns = raw.r;            // the most opaque, and most matter, here and next to it
  var nm = raw.r + raw.g;
  if (b.y == 0) { ns = 1.0; nm = 1.0; }
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let q = b + vec3i(dx, dy, dz);
        if (any(q < vec3i(0)) || any(q >= WB)) { continue; }
        let v = farShares(farUnpack(textureLoad(tFar, q, 0)));
        ns = max(ns, v.r);
        nm = max(nm, v.r + v.g);
      }
    }
  }
  textureStore(farField, b, vec4f(select(FAR_THIN_V, raw.r, ns >= FAR_ISO || raw.r < FAR_THIN_MIN || !ownS),
                                  select(FAR_THIN_V, raw.g, nm >= FAR_ISO || raw.g < FAR_THIN_MIN || !ownL),
                                  select(0.0, 1.0, nm >= FAR_THIN_MIN), 1.0));`)}
`;

// A fresh build starts from an empty grid and field (the world before it was
// built: what the view draws there is the plain or sea beyond).
// Group 2: the grid and the field, written.
export const FAR_CLEAR_LAYOUT = [store(0, FAR_FORMATS.grid), store(1, FAR_FORMATS.field)];
export const farClearFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
@group(2) @binding(0) var farOut: texture_storage_3d<rgba16uint, write>;
@group(2) @binding(1) var farField: texture_storage_3d<rgba8unorm, write>;
${regionMain(`  textureStore(farOut, b, vec4u(0u));
  textureStore(farField, b, vec4f(0.0));`)}
`;

// A node kernel's thread per node of an occupancy level (n nodes per axis).
const nodeMain = (n, body) => /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldId(wg, nwg) * 64u + li;
  if (i >= ${n[0] * n[1] * n[2]}u) { return; }
  let n = vec3i(vec3u(i % ${n[0]}u, (i / ${n[0]}u) % ${n[1]}u, i / ${n[0] * n[1]}u));
${body}
}`;
/** An occupancy level's dispatch (level: L.l1 or L.l2). */
export const nodeDispatch = (level) => fold(Math.ceil(level.n[0] * level.n[1] * level.n[2] / 64));
// The occupancy levels live in one buffer, a word a node (1: set), L1's
// nodes then L2's, each x fastest, then y, then z (a buffer: the view's
// fragment stage has no sampled texture left for them, W14's 16).
/** Words of the occupancy buffer for layout L (the levels, then the detail mask: detailMaskAt). */
export const occupancyWords = (L) => detailMaskAt(L) + detailChunks(L)[0] * detailChunks(L)[1];
// The detail meshes' chunks (world/detail.js): DETAIL_CHUNK² world columns,
// every height, a word of the occupancy buffer each after the levels: 0 none,
// 1 a dry mesh drawn there, 2 one with liquids. The view leaves a meshed
// chunk's opaque field to its mesh (and crosses a dry one whole).
export const DETAIL_CHUNK = 32;
export const DETAIL_PAD = 4;   // cells of the chunk's neighbours its cells take in (the mesh's normals and seams)
export const detailChunks = (L) => [Math.ceil(L.size[0] / DETAIL_CHUNK), Math.ceil(L.size[2] / DETAIL_CHUNK)];
/** The detail mask's first word in the occupancy buffer. */
export const detailMaskAt = (L) => L.l1.n[0] * L.l1.n[1] * L.l1.n[2] + L.l2.n[0] * L.l2.n[1] * L.l2.n[2];
const occupancyGLSL = (access) => /* wgsl */ `
@group(${access === 'read' ? 0 : 2}) @binding(${access === 'read' ? 3 : 1}) var<storage, ${access}> farOcc: array<u32>;
const FAR_OCC2_AT: i32 = F1X * F1Y * F1Z;   // L2's first word
const FAR_DETAIL_AT: i32 = FAR_OCC2_AT + F2X * F2Y * F2Z;   // the detail mask's
const DETAIL_CHUNK: i32 = ${DETAIL_CHUNK};
const DETAIL_NX: i32 = (WORLD_X + DETAIL_CHUNK - 1) / DETAIL_CHUNK;
fn farOcc1At(n: vec3i) -> i32 { return n.x + F1X * (n.y + F1Y * n.z); }
fn farOcc2At(n: vec3i) -> i32 { return FAR_OCC2_AT + n.x + F2X * (n.y + F2Y * n.z); }`;

// L1 occupancy: is FAR.ISO reached by a brick in the node or next to it?
// Group 2: the field (read), the occupancy buffer (written).
export const FAR_MIP1_LAYOUT = [sampled(0, 'float'), buf(1, 'storage')];
export const farMip1Frag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
@group(2) @binding(0) var tFar: texture_3d<f32>;
${occupancyGLSL('read_write')}
fn occupied(n: vec3i) -> bool {
  let lo = max(n * FAR_NODE - 1, vec3i(0));
  let hi = min(n * FAR_NODE + FAR_NODE + 1, WB);
  for (var z = lo.z; z < hi.z; z++) {
    for (var y = lo.y; y < hi.y; y++) {
      for (var x = lo.x; x < hi.x; x++) {
        let v = textureLoad(tFar, vec3i(x, y, z), 0);
        if (v.r + v.g >= FAR_ISO) { return true; }
      }
    }
  }
  return false;
}
${nodeMain(L.l1.n, '  farOcc[farOcc1At(n)] = select(0u, 1u, occupied(n));')}
`;

// L2 occupancy: is any of its L1 nodes set? (They carry the dilation.)
// Group 2: the occupancy buffer (L1 read, L2 written).
export const FAR_MIP2_LAYOUT = [buf(1, 'storage')];
export const farMip2Frag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
${occupancyGLSL('read_write')}
fn occupied(n: vec3i) -> bool {
  for (var z = 0; z < FAR_NODE; z++) {
    for (var y = 0; y < FAR_NODE; y++) {
      for (var x = 0; x < FAR_NODE; x++) {
        let m = n * FAR_NODE + vec3i(x, y, z);
        if (all(m < vec3i(F1X, F1Y, F1Z)) && farOcc[farOcc1At(m)] != 0u) { return true; }
      }
    }
  }
  return false;
}
${nodeMain(L.l2.n, '  farOcc[farOcc2At(n)] = select(0u, 1u, occupied(n));')}
`;

// Brick-column tops: the height (cells) of each column's ground, seen from
// below: where the opaque field first falls through FAR.ISO going up from the
// bottom, between the centres of the last brick at or over it and the next
// (exact for the ground: the field is 0.5 + (h - y) / 8 there). What floats
// above that (a crown, a roof) isn't a column: it would shade the ground under
// it from every side, as a pillar. y: the ground's surface seen from above
// (FAR_SKY): the top of the highest brick at FAR.ISO whose neighbours REACH
// bricks out along ±x and ±z are too, crossed the same way.
// Group 2: the field (read), the tops (written).
export const FAR_TOP_LAYOUT = [sampled(0, 'float'), store(1, FAR_FORMATS.top, '2d')];
export const farTopFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
@group(2) @binding(0) var tFar: texture_3d<f32>;
@group(2) @binding(1) var farTopOut: texture_storage_2d<rgba16float, write>;
const FAR_TOP_EPS: f32 = 1e-3;   // value steps below this count as none
const FAR_SKY_REACH: i32 = ${FAR_SKY.REACH};
fn farTopAt(b: vec3i) -> f32 { return textureLoad(tFar, clamp(b, vec3i(0), WB - 1), 0).r; }
// ground: at FAR_ISO, and so are its neighbours FAR_SKY_REACH bricks out each way
fn farGroundAt(b: vec3i) -> bool {
  if (farTopAt(b) < FAR_ISO) { return false; }
  for (var k = 1; k <= FAR_SKY_REACH; k++) {
    if (min(min(farTopAt(b + vec3i(k, 0, 0)), farTopAt(b - vec3i(k, 0, 0))),
            min(farTopAt(b + vec3i(0, 0, k)), farTopAt(b - vec3i(0, 0, k)))) < FAR_ISO) { return false; }
  }
  return true;
}
${columnMain(/* wgsl */ `
  var below = farTopAt(vec3i(bc.x, 0, bc.y));
  var h = 0.0;
  if (below >= FAR_ISO) {
    h = f32(WBY * FAR_BRICK);
    for (var y = 1; y < WBY; y++) {
      let v = farTopAt(vec3i(bc.x, y, bc.y));
      if (v < FAR_ISO) {
        h = (f32(y) - 0.5 + (below - FAR_ISO) / max(below - v, FAR_TOP_EPS)) * f32(FAR_BRICK);
        break;
      }
      below = v;
    }
  }
  var hs = 0.0;
  for (var y = WBY - 1; y >= 0; y--) {
    let b = vec3i(bc.x, y, bc.y);
    if (!farGroundAt(b)) { continue; }
    let v = farTopAt(b);
    let a = select(0.0, farTopAt(b + vec3i(0, 1, 0)), y + 1 < WBY);
    hs = (f32(y) + 0.5 + clamp((v - FAR_ISO) / max(v - a, FAR_TOP_EPS), 0.0, 1.0)) * f32(FAR_BRICK);
    break;
  }
  textureStore(farTopOut, bc, vec4f(h, hs, 0.0, 1.0));`)}
`;

// Shadow heights, per brick column: below this height (cells) the sun is
// blocked, by the columns toward it: max over them of their top less the sun
// ray's drop from there, the tops read bilinearly along the sun's ray (read
// per column they alias into streaks). x: every column; y: columns outside the
// window only (winCols: its brick columns [x0, z0) .. [x1, z1)), which the
// window's shadow map adds to its own (farCastersGLSL). Starts a column away (a
// column's own top is its surface). A column's top is the higher of its ground
// seen from below and from above (FAR_SKY): the rock over a cave casts, so the
// sun doesn't shine down the caves and tunnels under it.
export const FAR_SHADOW_STEPS = 512;     // most columns marched toward the sun
export const FAR_SHADOW_NONE = -1e4;     // cells: a height no point is below (nothing blocks the sun)
export const ShadowParams = uniformStruct('FarShadowParams', { sun: 'vec3f', winCols: 'vec4i' });
// Group 2: the tops (read, filtered), a linear clamp sampler, the shadow heights (written).
export const FAR_SHADOW_LAYOUT = [sampled(0, 'float', '2d'), { binding: 1, visibility: C, sampler: { type: 'filtering' } }, store(2, FAR_FORMATS.shadow, '2d')];
export const farShadowFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${farLayoutGLSL(L)}
@group(2) @binding(0) var tTop: texture_2d<f32>;
@group(2) @binding(1) var topSampler: sampler;
@group(2) @binding(2) var farShadowOut: texture_storage_2d<rgba16float, write>;
${ShadowParams.wgsl}
@group(3) @binding(1) var<uniform> P: FarShadowParams;
const FAR_SHADOW_STEPS: i32 = ${FAR_SHADOW_STEPS};
const FAR_SHADOW_NONE: f32 = ${glf(FAR_SHADOW_NONE)};
const FAR_SUN_FLAT: f32 = 1e-4;   // the sun's horizontal share below which it counts as overhead (no cast shadows)
fn heights(bc: vec2i) -> vec2f {
  let lh = length(P.sun.xz);
  if (lh < FAR_SUN_FLAT) { return vec2f(FAR_SHADOW_NONE); }
  let u = P.sun.xz / lh;                           // toward the sun, horizontally
  let drop = f32(FAR_BRICK) * P.sun.y / lh;        // cells the sun ray falls per brick column
  let p = vec2f(bc) + 0.5;
  var sAll = FAR_SHADOW_NONE;
  var sOut = FAR_SHADOW_NONE;
  for (var i = 1; i < FAR_SHADOW_STEPS; i++) {
    let d = f32(i);
    let q = p + u * d;
    if (any(q < vec2f(0.0)) || any(q >= vec2f(WB.xz))) { break; }
    let fall = d * drop;
    if (f32(WORLD_Y) - fall <= max(sOut, 0.0)) { break; }   // nothing farther can rise above what is found (or the floor)
    let t = textureSampleLevel(tTop, topSampler, q / vec2f(WB.xz), 0.0).xy;
    let h = max(t.x, t.y) - fall;
    sAll = max(sAll, h);
    let qc = vec2i(floor(q));
    let inWin = all(qc >= P.winCols.xy) && all(qc < P.winCols.zw);
    if (!inWin) { sOut = max(sOut, h); }
  }
  return vec2f(sAll, sOut);
}
${columnMain('  textureStore(farShadowOut, bc, vec4f(heights(bc), 0.0, 1.0));')}
`;

// ---------------------------------------------------------------- the view
// Constants of the view (cells unless said otherwise).
export const FAR_VIEW = {
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
  SUN_DISC,                // the sun's disc radiance, × the sunlight at the ground (gfx/sky.js: the box's backdrop draws it too)
  SUN_DISC_EDGE,           // its soft edge, share of its radius
  HAZE: FAR_HAZE,          // extinction per cell of the air, green (farShared.js)
  OCEAN_ROCK: 'ROCK',      // the open sea's bed beyond the world (the generator's floor)
};

// Sampling the far grid and its shadow heights. The grid, tops and shadow
// heights are the lighting group's (shaders/bindings.js 11-13: tFarGrid,
// tFarTop, tFarShadow); the field and the occupancy buffer the view's own
// (its group 0, after FrameUniforms: FAR_VIEW_LAYOUTS).
const farSampleGLSL = /* wgsl */ `
@group(0) @binding(2) var tFarField: texture_3d<f32>;   // the field: opaque, liquid (filtered), near
// The far field at world point p (cells), trilinear: r opaque, g liquid.
fn farSample(p: vec3f) -> vec4f {
  let q = clamp(p * (1.0 / f32(BS)), vec3f(0.5), vec3f(WB) - 0.5);   // bricks, held to the edge bricks' centres
  return textureSampleLevel(tFarField, linearClamp, q / vec3f(WB), 0.0);
}
// everything a ray stops at or enters (opaque + liquid)
fn farMatter(p: vec3f) -> f32 { let v = farSample(p); return v.r + v.g; }
fn farBrickOf(p: vec3f) -> vec3i { return clamp(vec3i(floor(p * (1.0 / f32(BS)))), vec3i(0), WB - 1); }
// the ids of the brick holding p: x = dominant opaque element, y = dominant
// liquid (E_EMPTY: none), z = 1 if it holds opaque cells open above
fn farIds(p: vec3f) -> vec3i {
  let f = farUnpack(textureLoad(tFarGrid, farBrickOf(p), 0));
  return vec3i(f.id, f.liquid, select(0, 1, f.open));
}
// the liquid a far liquid surface is drawn as: the brick's own, else (only
// its neighbours' reaches into its cube) water
fn farLiquidOf(liquid: i32) -> i32 { return select(liquid, E_WATER, liquid == E_EMPTY); }
fn farGlow(p: vec3f) -> f32 { return f32(farUnpack(textureLoad(tFarGrid, farBrickOf(p), 0)).glow) / FAR_LEVELS; }
fn farNear(b: vec3i) -> bool { return textureLoad(tFarField, b, 0).b > 0.5; }
fn farOcc1(n: vec3i) -> bool { return farOcc[farOcc1At(n)] != 0u; }
fn farOcc2(n: vec3i) -> bool { return farOcc[farOcc2At(n)] != 0u; }
// Sun visibility at world point p from the shadow heights: ch 0 every caster, 1 those outside the window.
// Past the world's edge it's lit (farInWorld).
fn farSunVis(p: vec3f, ch: i32) -> f32 {
  if (!farInWorld(p.xz)) { return 1.0; }
  return farShadowLit(p.y, textureSampleLevel(tFarShadow, linearClamp, p.xz / vec2f(WORLD.xz), 0.0)[ch]);
}
`;

// The view's params: the ray's world frame and the world beyond.
export const FarViewParams = uniformStruct('FarViewParams', {
  clipToWorld: 'mat4x4f',   // clip → world cells (the jittered camera's, FrameUniforms.viewProj's inverse through the window)
  worldToClip: 'mat4x4f',   // world cells → clip: the depth written
  eye: 'vec3f',             // the camera in world cells
  sea: 'f32',               // sea level (cells): the open sea beyond the world (0: none, a plain instead)
  winLo: 'vec3i',           // the window's low corner (world cells): the volume draws [winLo, winLo + GRID)
  floor: 'f32',             // the sea floor beyond the world, or the plain (cells)
  detailDepth: 'u32',       // 1: the detail meshes' depth (tDetailDepth) was drawn for this frame and target
  // the rolling log (gfx/presentation.js parameters: world cells; k 0: flat): the view's curved variant and the meshes read it
  warpK: 'f32',
  warpAnchor: 'vec2f',
  warpDir: 'vec2f',
});

// The view (docs/webgpu.md G1): a full-screen triangle in our scene pass,
// drawn before the volume (its wire's order), depth test less-equal against
// the opaque meshes three drew first (Sync log S1), frag_depth written, so the
// window's volume and the meshes composite with it. Sky, the open sea beyond
// the world and the far grid, marched past the window's box, which the volume
// draws. Everything here is in world cells: its header's origin is 0, so the
// looks' worldPos() is the identity, and what reads the window (the GI probes'
// sky share and light) takes p - winLo.
//
// The rolling log (gfx/presentation.js): curved, the view is a variant of its
// own (a template switch, as the volume's: docs/webgpu.md F2), whose rays are
// the displayed rays' parabolas in the flat world (gFarRay) and whose window
// and world are their spans (gFarWindow, gFarWorld); x and z stay linear
// along them, so the chunk and slab crossings of x and z are the flat ones.
// The detail meshes bend in their vertex stage and shade along the displayed
// ray, switched by P.warpK (a few lines, both variants of the mesh pass).
export const farFrag = (g, L, mesh = false, { curved = false } = {}) => {
  return /* wgsl */ `
// far view${curved ? ', curved' : ''}
${lib(g, { variant: 'LIGHTING', far: true, aeration: false })}
${presentationWGSL}${curved ? `
var<private> gFarRay: WarpRay;
var<private> gFarWindow: vec4f;
var<private> gFarWorld: vec4f;
// The first downward crossing of height level along r, or WARP_INF.
fn farPlaneHit(r: WarpRay, level: f32) -> f32 {
  let roots = warpPlane(r, 1, level);
  for (var i = 0; i < 2; i++) {
    if (roots[i] >= 0.0 && roots[i] < WARP_INF && warpSlope(r, roots[i]).y < 0.0) { return roots[i]; }
  }
  return WARP_INF;
}` : ''}
// The march's point at t (curved: on the displayed ray's parabola) and its direction there.
fn farPath(ro: vec3f, rd: vec3f, t: f32) -> vec3f { return ${curved ? 'warpAt(gFarRay, t)' : 'ro + rd * t'}; }
fn farDirection(rd: vec3f, t: f32) -> vec3f { return ${curved ? 'normalize(warpSlope(gFarRay, t))' : 'rd'}; }
${FAR_STANDINS}
${surfaceGLSL({})}
${liquidGLSL}
${farLayoutGLSL(L)}
${farSampleGLSL}
${occupancyGLSL('read')}
${farSkyGLSL}
${FarViewParams.wgsl}
@group(3) @binding(1) var<uniform> P: FarViewParams;
${mesh ? '' : `// the detail meshes' rasterized depth at each pixel (0: none), drawn before the scene pass (farDetailDepthFrag)
@group(0) @binding(4) var tDetailDepth: texture_2d<f32>;`}
// the air's sky share at window point q: the probes in the window, the far field's sky past it
fn farAirSky(q: vec3f) -> f32 {
  if (all(q >= vec3f(0.0)) && all(q < vec3f(GRID))) { return giAirSkyVis(q); }
  return farSkyOpen(q + vec3f(P.winLo));
}
${farHazeFor('farAirSky')}
${cloudsGLSL}
// the detail mesh state of the chunk holding world point p (0: none, 1: dry, 2: with liquids)
fn detailAt(p: vec3f) -> u32 {
  if (!farInWorld(p.xz)) { return 0u; }
  let c = vec2i(p.xz) / DETAIL_CHUNK;
  return farOcc[FAR_DETAIL_AT + c.x + DETAIL_NX * c.y];
}
// The field a ray stops at: a meshed chunk's opaque matter is its mesh's
// (drawn first, in front); its liquid surface, shallow water included
// (opaque .3 + liquid .4), stays the field's.
fn farTraceMatter(p: vec3f) -> f32 {
  let v = farSample(p);
  if (detailAt(p) > 0u && v.r >= v.g) { return 0.0; }
  return v.r + v.g;
}

const FAR_MAX_STEPS: i32 = ${L.size.reduce((n, side) => n + side / BRICK, 16)};
const FAR_NUDGE: f32 = ${glf(FAR_VIEW.NUDGE)};
const FAR_NEAR: f32 = ${glf(FAR_VIEW.NEAR)};
const FAR_ROOT_STEPS: i32 = ${FAR_VIEW.ROOT_STEPS};
const FAR_NORMAL_STEP: f32 = ${glf(FAR_VIEW.NORMAL_STEP)};
const FAR_ID_INSET: f32 = ${glf(FAR_VIEW.ID_INSET)};
const FAR_ID_JITTER: f32 = ${glf(FAR_VIEW.ID_JITTER)};
const FAR_ID_JITTER_F: f32 = ${glf(FAR_VIEW.ID_JITTER_F)};
const FAR_ID_DITHER: f32 = ${glf(FAR_VIEW.ID_DITHER)};
const FAR_ID_DEEPER: f32 = ${glf(FAR_VIEW.ID_DEEPER)};
const FAR_SUN_RAY_N: i32 = ${FAR_VIEW.SUN_RAY.length};
var<private> FAR_SUN_RAY: array<f32, ${FAR_VIEW.SUN_RAY.length}> = array<f32, ${FAR_VIEW.SUN_RAY.length}>(${FAR_VIEW.SUN_RAY.map(glf).join(', ')});
const FAR_SUN_RAY_LIFT: f32 = ${glf(FAR_VIEW.SUN_RAY_LIFT)};
const FAR_SUN_RAY_LO: f32 = ${glf(FAR_VIEW.SUN_RAY_EDGE[0])};
const FAR_SUN_RAY_HI: f32 = ${glf(FAR_VIEW.SUN_RAY_EDGE[1])};
const FAR_AO_D1: f32 = ${glf(FAR_VIEW.AO_D1)};
const FAR_AO_D2: f32 = ${glf(FAR_VIEW.AO_D2)};
const FAR_AO_K: f32 = ${glf(FAR_VIEW.AO_K)};
const FAR_AO_MIN: f32 = ${glf(FAR_VIEW.AO_MIN)};
const FAR_WATER_STEP: f32 = ${glf(FAR_VIEW.WATER_STEP)};
const FAR_WATER_STEPS: i32 = ${FAR_VIEW.WATER_STEPS};
const FAR_SUN_DISC: f32 = ${glf(FAR_VIEW.SUN_DISC)};
const FAR_SUN_DISC_EDGE: f32 = ${glf(FAR_VIEW.SUN_DISC_EDGE)};
const FAR_OCEAN_BED: i32 = E_${FAR_VIEW.OCEAN_ROCK};
const FAR_ROOT_SPLIT_LO: f32 = 0.15;   // regula falsi splits kept off the bracket's ends (as SURF_ROOT_SPLIT_*)
const FAR_ROOT_SPLIT_HI: f32 = 0.85;
const FAR_FLAT_EPS: f32 = 1e-5;        // field differences below this count as flat
const FAR_SUN_Y_MIN: f32 = 0.2;        // sun elevation sine floor for light fading down through liquid (LIQ_SUN_Y_MIN in render.js)

// Sunlight at world point p: the shadow heights (ch: farSunVis), under the clouds.
fn farSunLit(p: vec3f, ch: i32) -> f32 { return farSunVis(p, ch) * cloudShadow(p); }

// (tNear, tFar) of the ray through the box [lo, hi); tNear > tFar: a miss
fn farSlab(ro: vec3f, inv: vec3f, lo: vec3f, hi: vec3f) -> vec2f {
  let t0 = (lo - ro) * inv;
  let t1 = (hi - ro) * inv;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  return vec2f(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}
// t at which the ray leaves the cube [lo, lo + size) (curved: the parabola, from t on)
fn farExit(ro: vec3f, inv: vec3f, lo: vec3f, size: f32, t: f32) -> f32 {${curved ? `
  return warpExit(gFarRay, lo, lo + size, t).x;` : `
  let tf = (lo + step(vec3f(0.0), inv) * size - ro) * inv;
  return min(tf.x, min(tf.y, tf.z));`}
}

// Where the ray meets the plane y = level going down (never: NO_HIT, curved WARP_INF), its
// point *ps there and whether that lies past the world's columns (*past).
fn farSeaHit(ro: vec3f, rd: vec3f, level: f32, ps: ptr<function, vec3f>, past: ptr<function, bool>) -> f32 {
  var t = NO_HIT;${curved ? `
  t = farPlaneHit(gFarRay, level);` : `
  if (rd.y < 0.0 && ro.y > level) { t = (level - ro.y) / rd.y; }`}
  *ps = farPath(ro, rd, t);
  *past = any((*ps).xz < vec2f(0.0)) || any((*ps).xz > vec2f(WORLD.xz));
  return t;
}

// Root of the matter field crossing FAR_ISO in [ta, tb] (fa below it, fb at or above).
fn farRoot(ro: vec3f, rd: vec3f, ta0: f32, tb0: f32, fa0: f32, fb0: f32) -> f32 {
  var ta = ta0;
  var tb = tb0;
  var fa = fa0;
  var fb = fb0;
  for (var k = 0; k < FAR_ROOT_STEPS; k++) {
    let tm = mix(ta, tb, clamp((FAR_ISO - fa) / max(fb - fa, FAR_FLAT_EPS), FAR_ROOT_SPLIT_LO, FAR_ROOT_SPLIT_HI));
    let fm = farTraceMatter(farPath(ro, rd, tm));
    if (fm < FAR_ISO) { ta = tm; fa = fm; } else { tb = tm; fb = fm; }
  }
  return mix(ta, tb, clamp((FAR_ISO - fa) / max(fb - fa, FAR_FLAT_EPS), 0.0, 1.0));
}

// The first point along ro + rd t, t in [t0, t1], where the matter field
// reaches FAR_ISO, the window's stretch (w0, w1) left out; NO_HIT if none.
// Unset L2 and L1 nodes are crossed whole; a set one is walked brick by brick
// with the field sampled at each segment's ends (and its middle when either
// end is near the level); a brick with no matter around it (farNear) is
// crossed in one step. cut: the ray was already inside matter where it came
// out of the window (it went through the window's ground, which the volume
// draws in front: the far field only fills in behind it).
fn farMarch(ro: vec3f, rd: vec3f, t0: f32, t1: f32, w0: f32, w1: f32, cut: ptr<function, bool>) -> f32 {
  *cut = false;
  let inv = 1.0 / rd;
  var t = t0;
  var f = -1.0;   // the field at t (-1: not read since the last jump)
  var n2Last = vec3i(-1);
  var n1Last = vec3i(-1);
  var o2 = false;
  var o1 = false;
  var lastDetail = 0xffffffffu;
  for (var i = 0; i < FAR_MAX_STEPS; i++) {${curved ? `
    // past the world's first span, its second (the parabola can come back down
    // into it); the window's second span is the volume's, as its first is
    let next = warpResume(t, gFarWorld);
    if (next != t) { f = -1.0; }
    t = next;
    if (t >= gFarWindow.z && t < gFarWindow.w) { t = gFarWindow.w + FAR_NUDGE; f = -1.0; continue; }` : ''}
    if (t >= t1) { break; }
    if (t >= w0 && t < w1) { t = w1 + FAR_NUDGE; f = -1.0; continue; }
    let p = farPath(ro, rd, t);
    // a dry meshed chunk is the mesh's: crossed whole
    let detail = detailAt(p);
    if (detail != lastDetail) { f = -1.0; lastDetail = detail; }
    if (detail == 1u) {
      let lo = floor(p.xz / f32(DETAIL_CHUNK)) * f32(DETAIL_CHUNK);
      let tf = (lo + step(vec2f(0.0), inv.xz) * f32(DETAIL_CHUNK) - ro.xz) * inv.xz;
      t = min(tf.x, tf.y) + FAR_NUDGE;
      f = -1.0;
      continue;
    }
    let c = clamp(vec3i(floor(p)), vec3i(0), WORLD - 1);
    let n2 = c / FAR_L2_CELLS;
    if (any(n2 != n2Last)) { n2Last = n2; o2 = farOcc2(n2); }
    if (!o2) { t = farExit(ro, inv, vec3f(n2 * FAR_L2_CELLS), f32(FAR_L2_CELLS), t) + FAR_NUDGE; f = -1.0; continue; }
    let n1 = c / FAR_L1_CELLS;
    if (any(n1 != n1Last)) { n1Last = n1; o1 = farOcc1(n1); }
    if (!o1) { t = farExit(ro, inv, vec3f(n1 * FAR_L1_CELLS), f32(FAR_L1_CELLS), t) + FAR_NUDGE; f = -1.0; continue; }
    if (!farNear(c / BS)) { t = farExit(ro, inv, vec3f(c / BS * BS), f32(BS), t) + FAR_NUDGE; f = -1.0; continue; }
    var te = min(farExit(ro, inv, vec3f(c / BS * BS), f32(BS), t), t1);${curved ? `
    if (t < gFarWindow.z) { te = min(te, gFarWindow.z); }
    if (t < gFarWorld.y) { te = min(te, gFarWorld.y); }` : ''}
    if (t < w0 && te > w0) { te = w0; }   // the window starts inside this brick
    if (f < 0.0) {
      f = farTraceMatter(p);
      if (f >= FAR_ISO) { *cut = true; return t; }   // (started inside matter: past the window, or at the camera)
    }
    let fe = farTraceMatter(farPath(ro, rd, max(t, te - FAR_NUDGE)));
    if (max(f, fe) > FAR_NEAR) {
      let tm = 0.5 * (t + te);
      let fm = farTraceMatter(farPath(ro, rd, tm));
      if (fm >= FAR_ISO) { return farRoot(ro, rd, t, tm, f, fm); }
      if (fe >= FAR_ISO) { return farRoot(ro, rd, tm, te, fm, fe); }
    }
    f = fe;
    t = te + FAR_NUDGE;
  }
  return NO_HIT;
}

// Outward normal of the opaque (ch 0) or matter (ch 1) field: tetrahedral differences.
fn farChannel(p: vec3f, ch: i32) -> f32 { let v = farSample(p); return select(v.r + v.g, v.r, ch == 0); }
fn farNormal(p: vec3f, ch: i32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  let h = FAR_NORMAL_STEP;
  let gr = k.xyy * farChannel(p + k.xyy * h, ch) + k.yyx * farChannel(p + k.yyx * h, ch)
         + k.yxy * farChannel(p + k.yxy * h, ch) + k.xxx * farChannel(p + k.xxx * h, ch);
  let l = length(gr);
  return select(vec3f(0.0, 1.0, 0.0), -gr / max(l, FAR_FLAT_EPS), l > FAR_FLAT_EPS);
}

// Sunlight past what's near (crowns, the ground's bumps): a short coarse ray
// toward the sun through the field, which the height field's shadows (the
// ground, from far) multiply.
fn farSunRay(p: vec3f, n: vec3f) -> f32 {
  let o = p + n * FAR_SUN_RAY_LIFT;
  var vis = 1.0;
  for (var i = 0; i < FAR_SUN_RAY_N; i++) {
    vis *= 1.0 - smoothstep(FAR_SUN_RAY_LO, FAR_SUN_RAY_HI, farMatter(o + FU.sun * FAR_SUN_RAY[i]));
  }
  return vis;
}

// Open sky around the surface: two field samples out along the normal.
fn farAO(p: vec3f, n: vec3f) -> f32 {
  let o = farSample(p + n * FAR_AO_D1).r + farSample(p + n * FAR_AO_D2).r;
  return clamp(1.0 - FAR_AO_K * o, FAR_AO_MIN, 1.0);
}

// The opaque element at surface point p (normal n): the brick holding the
// cells just under the surface, read at a point moved along the surface by
// world noise so borders between materials meander instead of following
// bricks. The surface is within a fraction of a cell of the matter's top, but
// that top can be in the brick above or below: the first of the brick just
// inside, the one outside and the one deeper that holds open cells (its
// element is the surface's, not what lies buried under it).
const FAR_ID_SALT_Y: f32 = 17.0;   // decorrelate the jitter noise's axes
const FAR_ID_SALT_Z: f32 = 31.0;
fn farElement(p: vec3f, n: vec3f) -> i32 {
  let j = (vec3f(vnoise(p * FAR_ID_JITTER_F), vnoise(p * FAR_ID_JITTER_F + FAR_ID_SALT_Y),
                 vnoise(p * FAR_ID_JITTER_F + FAR_ID_SALT_Z)) - 0.5) * FAR_ID_JITTER
        + (stbn3(gFragCoord, f32(FU.frame)) - 0.5) * FAR_ID_DITHER;   // spatiotemporal dither (noise.js stbn3)
  let q = p + j - n * dot(n, j);
  var a = farIds(q - n * FAR_ID_INSET);
  if (a.z == 0) {
    let b = farIds(q + n * FAR_ID_INSET);
    if (b.z == 1 && b.x != E_EMPTY) { return b.x; }
    let c = farIds(q - n * FAR_ID_DEEPER);
    if (c.z == 1 || a.x == E_EMPTY) { a = c; }
  }
  return select(a.x, E_ROCK, a.x == E_EMPTY);
}
fn farGlowT(p: vec3f, n: vec3f) -> f32 {
  let a = farGlow(p - n * FAR_ID_INSET);
  return select(AMBIENT, INCAND_T0 + a * FAR_GLOW_SPAN, a > 0.0);
}

// A lit opaque far surface: its material (matOf, at the pixel's footprint, so
// texture fades to its far look), the sun through the shadow heights, the sky
// over its open share (none under the ground: FAR_SKY), its own glow.
fn farShadeMaterial(p: vec3f, n: vec3f, rd: vec3f, sunVis: f32, id: i32) -> vec3f {
  let fp = footprint(p);
  var m = matOf(id, p, n, farGlowT(p, n), 0.0, fp);   // (foliage keeps its clumps: matOf's leafClumps)
  // the material's bump tilts the normal (applyMat), kept facing the eye (shadeSurf)
  let v = -rd;
  let ns = faceView(bumpNormal(n, m.g), v);
  let nv = clamp(dot(ns, v), 1e-4, 1.0);
  let nl = dot(ns, FU.sun);
  let rough = clamp(aaRough(clamp(m.rough, MAT_ROUGH_MIN, 1.0), m.slopeVar), MAT_ROUGH_MIN, 1.0);   // (specular AA)
  let F0 = mix(vec3f(m.f0), m.alb, m.metal);
  let kD = m.alb * (1.0 - m.metal);
  let dSun = sunDiffuse(kD, nl, nv, dot(FU.sun, v), rough, m.sss, m.sssCol);
  let cav = clamp(m.cav, 0.0, 1.0);
  let c = sunTerm(vec3f(sunVis), dSun, cav, ggxSpec(ns, v, FU.sun, rough, F0));
  let ambient = skyAmbient(ns) * ${mesh ? '1.0' : 'farAO(p, n)'} * cav * farSkyOpen(p + n * FAR_SKY_LIFT);
  return c + kD * ambient + m.emit;
}

// Light scattered toward the eye inside liquid lid, per unit (1 - transmittance) (interiorScatter, without the glow volume);
// sky: the share of the sky over it (farSkyOpen).
fn farInScatter(lid: i32, sunVis: f32, sky: f32) -> vec3f {
  return SCATALB(lid) * liquidAmbientLight(sky, vec3f(sunVis));
}
// The bed under liquid lid at p (normal n, depth below the surface): lit by
// sun and sky through the liquid above.
fn farShadeBed(id: i32, p: vec3f, n: vec3f, depth: f32, lid: i32, sunVis: f32, sky: f32) -> vec3f {
  let alb = matOf(id, p, n, AMBIENT, 0.0, footprint(p)).alb;
  let down = exp(-SIGMA(lid) * depth / max(FU.sun.y, FAR_SUN_Y_MIN));
  return alb * (FU.sunCol * sunVis * max(dot(n, FU.sun), 0.0) * down + skyAmbient(n) * sky * exp(-SIGMA(lid) * depth));
}
// Liquid lid's body seen from p along rt, under its surface: down to the bed
// (the opaque field along rt when bedY < 0, else the plane y = bedY), dimmed
// by the liquid on the way, plus the light it scatters toward the eye.
fn farBody(p: vec3f, rt: vec3f, lid: i32, sunVis: f32, sky: f32, bedY: f32) -> vec3f {${curved ? `
  // the ray, displayed straight: a parabola under the surface too
  let transmitted = warpRay(warpPoint(p), normalize(warpVector(p, rt)));` : ''}
  var s = -1.0;
  var bed = vec3f(0.0);
  if (bedY >= 0.0) {
    s = ${curved ? 'farPlaneHit(transmitted, bedY)' : '(p.y - bedY) / max(-rt.y, FAR_FLAT_EPS)'};
    let q = ${curved ? 'warpAt(transmitted, s)' : 'p + rt * s'};
    bed = farShadeBed(FAR_OCEAN_BED, q, vec3f(0.0, 1.0, 0.0), p.y - q.y, lid, sunVis, sky);
  } else {
    var ta = 0.0;
    var fa = farSample(p).r;
    for (var i = 1; i <= FAR_WATER_STEPS; i++) {
      let tb = f32(i) * FAR_WATER_STEP;
      let fb = farSample(${curved ? 'warpAt(transmitted, tb)' : 'p + rt * tb'}).r;
      if (fb >= FAR_ISO) {
        s = mix(ta, tb, clamp((FAR_ISO - fa) / max(fb - fa, FAR_FLAT_EPS), 0.0, 1.0));
        let q = ${curved ? 'warpAt(transmitted, s)' : 'p + rt * s'};
        let nq = farNormal(q, 0);
        bed = farShadeBed(farElement(q, nq), q, nq, p.y - q.y, lid, sunVis * farSunLit(q, 0), sky);
        break;
      }
      ta = tb;
      fa = fb;
    }
  }
${curved ? `  // optical distance is in flat material space, not display-ray t
  if (s >= 0.0 && s < WARP_INF) { s = warpArc(transmitted, 0.0, s); }
` : ''}  let att = select(vec3f(0.0), exp(-SIGMA(lid) * s), s >= 0.0);
  return bed * att + (1.0 - att) * farInScatter(lid, sunVis, sky);
}
// A liquid surface at p (liquid lid, an element) seen along rd: the sky and
// the sun's glint off it (Fresnel), and through it the liquid's body down to
// the bed: the opaque field along the refracted ray (bedY < 0), else the plane y = bedY.
// Under the ground (a lake in a cave) the sky neither lights nor shows in it (FAR_SKY).
fn farLiquid(p: vec3f, rd: vec3f, lid: i32, sunVis: f32, bedY: f32) -> vec3f {
  let sky = farSkyOpen(p + vec3f(0.0, FAR_SKY_LIFT, 0.0));
  // the ripples, as the window's water has them (liquid.js), so its sea carries on past the window
  let n = liquidRipple(p, vec3f(0.0, 1.0, 0.0));
  let F = fresnelSchlick(max(dot(-rd, n), 0.0), IOR(lid));
  var r = reflect(rd, n);
  r.y = abs(r.y);   // a ripple tilted past a grazing view shows the sky above, not the ground (dark specks)
  let refl = (skyColor(r) + sunGlint(n, -rd, ROUGH(lid), vec3f(sunVis))) * sky;
  var rt = refract(rd, n, 1.0 / IOR(lid));
  if (dot(rt, rt) < 1e-6) { rt = vec3f(0.0, -1.0, 0.0); }
  let body = farBody(p, rt, lid, sunVis, sky, bedY);
  return F * refl + (1.0 - F) * body;
}

// The sky toward rd from ro, with the key light's disc (sun, or the moon at
// night: FU.sunCol carries its colour), behind the cumulus deck (gfx/clouds.js).
fn farSky(ro: vec3f, rd: vec3f) -> vec3f {
  let c = skyRadiance(normalize(vec3f(rd.x, max(rd.y, 0.0), rd.z)));
  let r = SUN_TAN_RADIUS;
  let mu = dot(rd, FU.sun);
  let disc = smoothstep(cos(r * (1.0 + FAR_SUN_DISC_EDGE)), cos(r * (1.0 - FAR_SUN_DISC_EDGE)), mu);
  let cl = cloudLayer(ro, rd);
  return (c + disc * FU.sunCol * FAR_SUN_DISC) * cl.a + cl.rgb;
}

fn farDepth(p: vec3f) -> f32 {
  return clipDepth(P.worldToClip * vec4f(${curved ? 'warpPoint(p)' : 'p'}, 1.0));   // (curved: where it is displayed)
}

${mesh ? FAR_MESH_ENTRY : `struct FarVarying {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> FarVarying {
  // (-1, -1), (3, -1), (-1, 3): one triangle covering the screen
  let ndc = vec2f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1));
  var o: FarVarying;
  o.position = vec4f(ndc, 0.0, 1.0);
  o.ndc = ndc;
  return o;
}
struct FarOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs(v: FarVarying) -> FarOut {
  gFragCoord = v.position.xy;
  let far = P.clipToWorld * vec4f(v.ndc, 1.0, 1.0);   // the pixel's ray as the world point it meets on the far plane
  let ro = P.eye;
  let rd = safeDir(normalize(far.xyz / far.w - ro));
  surfView(ro, rd);   // pixel footprint for material LOD (uniform control flow)${curved ? `
  warpUse(P.warpK, P.warpAnchor, P.warpDir);
  gFarRay = warpRay(ro, rd);` : ''}
  let inv = 1.0 / rd;
  let winLo = vec3f(P.winLo);
  var tw = farSlab(ro, inv, winLo, winLo + vec3f(GRID));
  if (tw.x > tw.y || tw.y < 0.0) { tw = vec2f(NO_HIT); }
  let tb = farSlab(ro, inv, vec3f(0.0), vec3f(WORLD));
  var t0 = max(tb.x, 0.0);
  var t1 = tb.y;${curved ? `
  // the parabola's spans in the window (the volume's) and in the world (up to two each)
  gFarWindow = warpSpans(gFarRay, winLo, winLo + vec3f(GRID), 0.0, WARP_INF);
  gFarWorld = warpSpans(gFarRay, vec3f(0.0), vec3f(WORLD), 0.0, WARP_INF);
  tw = gFarWindow.xy;
  t0 = gFarWorld.x;
  t1 = select(gFarWorld.y, gFarWorld.w, gFarWorld.z < WARP_INF);` : ''}
  // the detail meshes in front (world/detail.js): the march stops at them, so
  // the coarse field (and the sea below) doesn't show through a meshed chunk.
  // Their depth is the rasterized one (bent with the view when it is): its
  // point through the inverse projection, at its distance along this ray.
  var cached = 0.0;
  if (P.detailDepth != 0u) {
    cached = textureLoad(tDetailDepth, vec2i(v.position.xy), 0).r;
    if (cached > 0.0) {
      let uv = v.position.xy / vec2f(textureDimensions(tDetailDepth));
      let q = P.clipToWorld * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, cached, 1.0);
      cached = length(q.xyz / q.w - ro);
      t1 = min(t1, cached);
    }
  }
  var cut = false;
  var tHit = NO_HIT;
  if (t0 < t1) { tHit = farMarch(ro, rd, t0, t1, tw.x, tw.y, &cut); }
  // the open sea beyond the world (and a march that ran out of steps over it).
  // A world without one (sea 0: world/scenes) has an open plain beyond it at
  // floor, and inside it a ray that met nothing reaches the world's bottom
  // (rock below it: the summaries' floor), not a sea.
  let plain = P.sea <= 0.0;
  let level = select(P.sea, P.floor, plain);
  var ps: vec3f;
  var seaOut: bool;
  var tSea = farSeaHit(ro, rd, level, &ps, &seaOut);
  if (plain && !seaOut) { tSea = farSeaHit(ro, rd, 0.0, &ps, &seaOut); }
  let seaWin = ${curved ? 'warpInside(tSea, gFarWindow)' : 'tSea >= tw.x && tSea <= tw.y'};
  let ocean = tSea < NO_HIT && tSea < tHit && (cached <= 0.0 || tSea < cached)
    && (seaOut || (cached <= 0.0 && tHit == NO_HIT && !seaWin));
  // A nearer exterior ocean or plain still hides a meshed chunk; inside one, a
  // dry pit below sea level isn't flooded by the coarse sea: the mesh shows.
  if (cached > 0.0 && tHit == NO_HIT && !ocean) { discard; }

  var col: vec3f;
  var o: FarOut;
  o.depth = 1.0;
  if (ocean) {
    if (plain) { col = farShadeBed(FAR_OCEAN_BED, ps, vec3f(0.0, 1.0, 0.0), 0.0, E_WATER, farSunLit(ps, 0), 1.0); }
    else { col = farLiquid(ps, farDirection(rd, tSea), E_WATER, farSunLit(ps, 0), select(-1.0, P.floor, seaOut)); }
    col = farHaze(col, rd, tSea, farAirLit(ro - winLo, ps - winLo));
    o.depth = farDepth(ps);
  } else if (tHit < NO_HIT) {
    let p = farPath(ro, rd, tHit);
    let localRd = farDirection(rd, tHit);   // (curved: the parabola's direction where it hits)
    let v = farSample(p);
    if (cut) {
      // came out of the window inside matter. Behind the window's ground: hidden
      // (but for a dug-out side or a tunnel the window cuts), so flat, unlit by
      // the sun, in the probes' light just inside the window (none in a cave).
      // In its water, which the volume draws see-through: that water's body past
      // the wall, so the window's water carries on past its side.
      if (v.r >= v.g) { col = ALBEDO(farIds(p).x) * giIrradiance(probeAt(p - winLo - rd * GI_OFFSET), -rd); }
      else {
        // the ray carries on through that water to whatever bed lies past the
        // wall, as the open sea's body beside it does (farLiquid): bottomless
        // in-scatter alone showed as a bright band along the window's far sides
        col = farBody(p, localRd, farLiquidOf(farIds(p).y), farSunLit(p, 0), farSkyOpen(p), -1.0);
      }
    } else {
      let sunVis = farSunLit(p, 0);
      if (v.g > v.r) { col = farLiquid(p, localRd, farLiquidOf(farIds(p - vec3f(0.0, FAR_ID_INSET, 0.0)).y), sunVis, -1.0); }
      else {
        let n = farNormal(p, 0);
        var sv = sunVis;
        if (sunVis > 0.0 && dot(n, FU.sun) > 0.0) { sv *= farSunRay(p, n); }
        col = farShadeMaterial(p, n, localRd, sv, farElement(p, n));
      }
    }
    col = farHaze(col, rd, tHit, farAirLit(ro - winLo, p - winLo));
    o.depth = farDepth(p);
  } else {
    col = farSky(ro, rd);
  }
  o.color = vec4f(col, 1.0);
  return o;
}`}
`;
};

// The detail meshes (world/detail.js): a chunk's surface, world cells, shaded
// as the far view shades its surfaces (no field AO, no foliage clumps: the
// mesh has the real cells), hazed, its depth the rasterized one. Inside the
// window's columns the volume draws instead.
const FAR_MESH_ENTRY = /* wgsl */ `
struct MeshVarying {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) element: u32,
}
@vertex fn vs(@location(0) pos: vec3f, @location(1) nor: vec3f, @location(2) element: u32) -> MeshVarying {
  var o: MeshVarying;
  warpUse(P.warpK, P.warpAnchor, P.warpDir);
  o.position = P.worldToClip * vec4f(warpPoint(pos), 1.0);   // (bent with the view: the rolling log; k 0, flat)
  o.world = pos;
  o.normal = nor;
  o.element = element;
  return o;
}
@fragment fn fs(v: MeshVarying) -> @location(0) vec4f {
  gFragCoord = v.position.xy;
  let p = v.world;
  let ro = P.eye;
  var rd = safeDir(normalize(p - ro));
  // bent (the rolling log): the eye sees p along the displayed ray, which
  // arrives along its parabola's direction there
  var displayRd = rd;
  var displayDist = length(p - ro);
  if (P.warpK != 0.0) {
    warpUse(P.warpK, P.warpAnchor, P.warpDir);
    let shown = warpPoint(p);
    displayDist = length(shown - ro);
    displayRd = (shown - ro) / max(displayDist, 1e-8);
    rd = normalize(warpSlope(warpRay(ro, displayRd), displayDist));
  }
  surfView(ro, displayRd);   // pixel footprint for material LOD (uniform control flow)
  let winLo = vec3f(P.winLo);
  if (all(p.xz >= winLo.xz) && all(p.xz < winLo.xz + vec2f(GRID.xz))) { discard; }
  let n = normalize(v.normal);
  // the coarse crown's density is not this leaf's shadow: sampling it here
  // would turn detailed branches black inside the old, inflated silhouette
  let col = farShadeMaterial(p, n, rd, farSunLit(p, 0), i32(v.element));
  return vec4f(farHaze(col, displayRd, displayDist, farAirLit(ro - winLo, p - winLo)), 1.0);
}`;

// What the view's materials need of the tracer's (shaders/render.js), which
// the far view doesn't paste: none of it runs here (no grid state is read).
const FAR_STANDINS = /* wgsl */ `
const EV_NONE: i32 = 0;
const EV_OPAQUE: i32 = 1;
const EV_ENTER: i32 = 2;
const EV_EXIT: i32 = 3;
`;

// The view's bind group layouts, groups 0-3: the render library's, group 0
// with the far field's own textures (its field and occupancy levels).
export const FAR_VIEW_FRAME = [
  ...RENDER_LAYOUT.FRAME,
  { binding: 2, visibility: STAGE.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
  { binding: 3, visibility: STAGE.FRAGMENT, buffer: { type: 'read-only-storage' } },
  // the detail meshes' depth (r32float: textureLoad only); the view's 16th sampled texture, the stage's limit (B2)
  { binding: 4, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
];
export const FAR_VIEW_LAYOUTS = () => {
  const [, state, lighting, params] = libLayouts('LIGHTING');
  return [FAR_VIEW_FRAME, state, lighting, params];
};
/** The view's render pipeline description: the scene target's formats, depth less-equal, frag_depth written, opaque. */
export const farViewPipeline = () => ({
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: 'rgba16float' }] },
  primitive: { topology: 'triangle-list' },
  depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
});

/** The detail meshes' pipeline (farFrag's mesh variant): positions, normals (float32x3) and element (uint32) buffers. */
export const farMeshPipeline = () => ({
  vertex: {
    entry: 'vs',
    buffers: [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
      { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'uint32' }] },
    ],
  },
  fragment: { entry: 'fs', targets: [{ format: 'rgba16float' }] },
  primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
});

// The detail meshes' depth (docs/webgpu.md G1: their depth prepass, our
// own depth-only pass, as the WebGL build's nested render was): each mesh's
// rasterized depth, bent with the view as the meshes are (the rolling log),
// into an r32float target the size of the scene target, the nearest kept by a
// depth test, 0 where there is none, the window's columns left out (the
// volume draws there). The view reconstructs its point through the inverse
// projection, and its march stops there (farFrag: tDetailDepth). Its own
// small module: positions only, no lighting, so it builds in a moment beside
// the meshes' pipeline.
export const FAR_DETAIL_DEPTH_FORMAT = 'r32float';
export const farDetailDepthFrag = (g) => /* wgsl */ `
// far detail depth
${FarViewParams.wgsl}
@group(3) @binding(1) var<uniform> P: FarViewParams;
${presentationWGSL}
const GRID_XZ: vec2f = vec2f(${glf(g.nx)}, ${glf(g.nz)});
struct DepthVarying {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
}
@vertex fn vs(@location(0) pos: vec3f) -> DepthVarying {
  var o: DepthVarying;
  warpUse(P.warpK, P.warpAnchor, P.warpDir);
  o.position = P.worldToClip * vec4f(warpPoint(pos), 1.0);
  o.world = pos;
  return o;
}
@fragment fn fs(v: DepthVarying) -> @location(0) vec4f {
  let winLo = vec3f(P.winLo);
  if (all(v.world.xz >= winLo.xz) && all(v.world.xz < winLo.xz + GRID_XZ)) { discard; }
  return vec4f(v.position.z, 0.0, 0.0, 1.0);
}`;
/** The detail depth pass's pipeline: the meshes' positions (float32x3), r32float out, its own depth32float (less, written). */
export const farDetailDepthPipeline = () => ({
  vertex: { entry: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
  fragment: { entry: 'fs', targets: [{ format: FAR_DETAIL_DEPTH_FORMAT }] },
  primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
});

// WEBGPU-STUB (docs/webgpu.md J3): the WebGL region quads, full-screen pass
// and the meshes' vertex stage; the far passes are compute kernels now, and
// the view's and meshes' vertex stages are in farFrag's module
export const farRegionVert = null;
export const farVert = null;
export const farMeshVert = null;

// ---------------------------------------------------------------- check-wgsl
// Every far pass for the one world size (WORLD_SIZE), the scene cells and
// trees for each scene, the view: on entering a world (its first build), so
// the menu's warm-up leaves them out (warm: false). The view is the size of
// the volume's realistic pipeline (B5: built in the background; the far
// field shows once it is ready).
const Lw = farLayout(WORLD_SIZE);
const DETAIL_S = (L) => farSceneLayout(L, DETAIL_CHUNK + 2 * DETAIL_PAD);
const CHECK_LAYOUTS = (g2, state = 'EMPTY') => () => [LAYOUT.TABLES, state === 'EMPTY' ? 'EMPTY' : LAYOUT[state], g2];
const SCENE_CELLS_LAYOUT = (s) => [...sceneLayout({ data: !!s.data }), buf(SCENE_CELLS_BINDING, 'storage')];
export const SCENE_CELLS_LAYOUT_OF = SCENE_CELLS_LAYOUT;
export const TREE_CAND_LAYOUT = (s) => [...sceneLayout({ data: !!s.data }), buf(TREE_CAND_BINDING, 'storage')];
export const TREE_THIN_LAYOUT = (s) => [...sceneLayout({ data: !!s.data }), buf(TREE_CAND_BINDING), buf(TREE_CAND_BINDING + 1, 'storage')];
export const WGSL_CHECK = () => [
  {
    name: 'farWin', kind: 'compute', grids: ['64', '128'], warm: false, code: (g) => farWinFrag(g, Lw),
    layouts: CHECK_LAYOUTS(FAR_WIN_LAYOUT, 'STATE_RO'), params: RegionParams, dispatch: () => regionDispatch([4, Lw.bricks.n[1], 32]),
  },
  ...[false, true].map((trees) => ({
    name: `farScene${trees ? ' trees' : ''}`, kind: 'compute', grids: ['128'], warm: false, code: (g) => farSceneFrag(g, Lw, trees),
    layouts: CHECK_LAYOUTS(FAR_SCENE_LAYOUT(trees)), params: RegionParams, dispatch: () => regionDispatch([16, Lw.bricks.n[1], 16]),
  })),
  { name: 'farClear', kind: 'compute', grids: ['128'], warm: false, code: (g) => farClearFrag(g, Lw), layouts: CHECK_LAYOUTS(FAR_CLEAR_LAYOUT), params: RegionParams, dispatch: () => regionDispatch(Lw.bricks.n) },
  { name: 'farBoost', kind: 'compute', grids: ['128'], warm: false, code: (g) => farBoostFrag(g, Lw), layouts: CHECK_LAYOUTS(FAR_BOOST_LAYOUT), params: RegionParams, dispatch: () => regionDispatch([18, Lw.bricks.n[1], 18]) },
  { name: 'farMip1', kind: 'compute', grids: ['128'], warm: false, code: (g) => farMip1Frag(g, Lw), layouts: CHECK_LAYOUTS(FAR_MIP1_LAYOUT), dispatch: () => nodeDispatch(Lw.l1) },
  { name: 'farMip2', kind: 'compute', grids: ['128'], warm: false, code: (g) => farMip2Frag(g, Lw), layouts: CHECK_LAYOUTS(FAR_MIP2_LAYOUT), dispatch: () => nodeDispatch(Lw.l2) },
  { name: 'farTop', kind: 'compute', grids: ['128'], warm: false, code: (g) => farTopFrag(g, Lw), layouts: CHECK_LAYOUTS(FAR_TOP_LAYOUT), dispatch: () => columnDispatch(Lw) },
  { name: 'farShadow', kind: 'compute', grids: ['128'], warm: false, code: (g) => farShadowFrag(g, Lw), layouts: CHECK_LAYOUTS(FAR_SHADOW_LAYOUT), params: ShadowParams, dispatch: () => columnDispatch(Lw) },
  { name: 'farTreeBand', kind: 'compute', grids: ['128'], warm: false, code: (g) => farTreeBandFrag(g, Lw), layouts: CHECK_LAYOUTS(FAR_TREE_BAND_LAYOUT), dispatch: () => columnDispatch(Lw) },
  ...WORLD_SCENES.flatMap((s) => {
    const L = farLayout(s.key === 'giantVolcano' ? [WORLD_SIZE[0], 384, WORLD_SIZE[2]] : WORLD_SIZE), S = farSceneLayout(L);
    const grids = s.key === 'giantVolcano' ? ['giant'] : ['128'];
    return [
      {
        name: `${s.key} farSceneCells`, kind: 'compute', grids, warm: false, code: (g) => farSceneCellsFrag(g, L, s.glsl(g), S),
        layouts: CHECK_LAYOUTS(SCENE_CELLS_LAYOUT(s)), params: SceneCellsParams, dispatch: () => sceneCellsDispatch(S),
      },
      {
        // the detail meshes' cells (world/detail.js): the live window's state where it is
        name: `${s.key} detailCells`, kind: 'compute', grids, warm: false, code: (g) => farSceneCellsFrag(g, L, s.glsl(g), DETAIL_S(L), true),
        layouts: CHECK_LAYOUTS(SCENE_CELLS_LAYOUT(s), 'STATE_RO'), params: SceneCellsParams, dispatch: () => sceneCellsDispatch(DETAIL_S(L)),
      },
      ...(s.trees ? [
        { name: `${s.key} farTreeCand`, kind: 'compute', grids, warm: false, code: (g) => farTreeCandFrag(g, L, null, s.trees.glsl()), layouts: CHECK_LAYOUTS(TREE_CAND_LAYOUT(s)), dispatch: () => columnDispatch(L) },
        { name: `${s.key} farTreeThin`, kind: 'compute', grids, warm: false, code: (g) => farTreeThinFrag(g, L, null, s.trees.glsl()), layouts: CHECK_LAYOUTS(TREE_THIN_LAYOUT(s)), dispatch: () => columnDispatch(L) },
      ] : []),
    ];
  }),
  {
    name: 'far view', kind: 'render', grids: ['64', '128'], warm: false, code: (g) => farFrag(g, Lw),
    layouts: () => FAR_VIEW_LAYOUTS(), params: FarViewParams, ...farViewPipeline(),
  },
  {
    // the rolling log's (gfx/presentation.js): built when a gamemode's effect bends a world's view
    name: 'far view curved', kind: 'render', grids: ['64', '128'], warm: false, code: (g) => farFrag(g, Lw, false, { curved: true }),
    layouts: () => FAR_VIEW_LAYOUTS(), params: FarViewParams, ...farViewPipeline(),
  },
  {
    name: 'far detail', kind: 'render', grids: ['64'], warm: false, code: (g) => farFrag(g, Lw, true),
    layouts: () => FAR_VIEW_LAYOUTS(), params: FarViewParams, ...farMeshPipeline(),
  },
  {
    name: 'far detail depth', kind: 'render', grids: ['64', '128'], warm: false, code: (g) => farDetailDepthFrag(g),
    layouts: () => [], params: FarViewParams, ...farDetailDepthPipeline(),
  },
];
