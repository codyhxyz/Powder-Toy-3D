import { BRICK } from './common.js';
import { E } from '../elements.js';
import { CELL_M } from '../scale.js';
import { libChecks } from './gfx/lib.js';
import { glf } from '../glsl.js';
import { tauAir } from '../gfx/sky.js';
import { DataUtils } from 'three';
import { Appearance, appearanceOf, materialWord, materialId, materialAppearance } from '../appearance.js';

// The far field's shared parts (docs/webgpu.md G1, J3): what the window's own
// pipelines read of a massive world's far field, moved here from shaders/far.js
// (the far field itself: its passes, the view and their design notes), which
// imports and re-exports them. WGSL; the snippet names are the GLSL versions'
// (docs/webgpu.md W2).
//   FAR, FAR_NODE, WORLD_SIZE, farLayout(size)   the far grid's constants and layout (JS)
//   farLayoutGLSL(L)    its WGSL consts, the far grid's texel record (FarTexel,
//                       farUnpack, farPackTexel) and the far shadow heights' constants
//   FAR_SKY, farSkyGLSL the sky over the far field: farSkyOpen(p), none under the ground
//   farHazeGLSL         aerial perspective (the far view's; volumeHazeGLSL the volume's on
//                       every map, farAirWGSL the sky pass's sea past a world's edge),
//                       its in-scatter taken by the air's sky share (farHazeFor picks the reader)
//   farCastersGLSL(L)   far casters in the window's sun shadow map
//   farGIGLSL(L)        what a GI probe's ray sees past the window
// The sky, casters and GI read the far textures of the lighting group
// (shaders/bindings.js L.LIGHTING 11-13: tFarGrid, tFarTop, tFarShadow; lib()
// declares them with far: true); in a box they are dummies and the callers'
// branches on FrameUniforms.far keep them unread, so a box and a world share
// every pipeline (docs/webgpu.md E: "GI far branch").

// The far field's numbers (shaders/far.js has what they mean in full).
export const FAR = {
  ISO: 0.5,            // the field's surface level
  CUBE: 8,             // cells: the edge of the cube centred on a brick whose share it holds (twice the brick)
  THIN_MIN: 1 / 80,    // matter filling at least this share of its cube (a line of cells through it, a single-cell
                       // trunk: 8/512, safely over it in 8 bits), with no brick next to it at ISO, reads as THIN_V...
  THIN_V: 1.0,         // ...so it stands as a blob, rod or slab instead of vanishing
  SURFACE_W: 8,        // a cell open above counts this many times toward the dominant element
  // The WebGL grid's half-float encoding, read by shaders/far.js's GLSL farPack
  // until U10 ports it (the WGSL grid is rgba16uint: farPackTexel below):
  HALF_EXACT: 2048,    // a half float holds every whole number below this exactly (an 11-bit significand)...
  PAYLOAD: 256,        // ...so a channel holds a value below PAYLOAD (a level, an element id)...
  SPARE: 8,            // ...and this many values above it (HALF_EXACT / PAYLOAD)
  LEVELS: 255,         // steps of the shares and the glow (an 8-bit channel's)
  GLOW_SPAN: 2000,     // °C the glow channel spans above the incandescence table's first knot
};
// Every element id, opaque or liquid, must fit the grid texel's 8-bit id
// fields (farPackTexel): past FAR.PAYLOAD the far view misreads ids, so say so at once.
if (Object.keys(E).length > FAR.PAYLOAD) {
  throw new Error(`farShared.js: ${Object.keys(E).length} elements, but the far grid holds element ids below FAR.PAYLOAD (${FAR.PAYLOAD})`);
}

// Children per node edge at each occupancy level: an L1 node is 4³ bricks, an L2 node 4³ L1 nodes.
export const FAR_NODE = 4;
const FAR_ATLAS_MAX = 8192;   // texels: the widest atlas row the WebGL far grid used

// Slices per atlas row for n slices of w × h texels: the smallest divisor of n
// from the near-square count up (so no slot is empty), else that count.
function sliceCols(n, w, h) {
  const root = Math.max(1, Math.ceil(Math.sqrt((n * h) / w)));
  for (let c = root; c <= n && c * w <= FAR_ATLAS_MAX; c++) if (n % c === 0) return c;
  return root;
}

// The one world size (app.js WORLDS). Its far layout is compiled into the
// box's view, shadow and GI pipelines too, their far parts off (FrameUniforms.far):
// a box and a world then share every big pipeline, so switching to a world
// compiles none.
export const WORLD_SIZE = [1024, 128, 1024];

// The far grid's layout for a world of `size` cells: bricks (n: per axis), the
// occupancy levels l1 and l2 (n: nodes per axis). (cols, width and height are
// the WebGL far grid's 2D atlas, which world/far.js sizes its targets by until
// U10 makes the grid a 3D texture; the WGSL here doesn't use them.)
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

// The far shadow heights: a point's shadow test is soft over this half-width
// (cells), after lifting the point this far (column tops are coarse).
export const FAR_SHADOW_SOFT = 1.5;
export const FAR_SHADOW_BIAS = 1.0;

// The far grid's texel (docs/webgpu.md G1): one rgba16uint texel per world
// brick, exact integers in 8-bit fields:
//   r  opaque share (FAR.LEVELS steps) | 256 if the brick holds opaque cells open above
//   g  liquid share
//   b  opaque physical ID in low 8, authored appearance in high 8
//   a  glow (FAR.LEVELS steps) | the dominant transparent liquid (E_EMPTY: none) << 8
// shaders/far.js has what each value means. JS twin of farPackTexel, for
// tools and CPU-side writers: [r, g, b, a].
export const packFarTexel = ({ s, l, glow, id, appearance = Appearance.NONE, liquid, open }) => [s | (open ? 256 : 0), l, id | (appearance << 8), glow | (liquid << 8)];
export const unpackFarTexel = ([r, g, b, a]) => ({ s: r & 255, l: g & 255, id: b & 255, appearance: b >> 8, glow: a & 255, liquid: a >> 8, open: (r >> 8) !== 0 });

// Transient readback format, not saved bricks: exact low-16 material word
// and the existing temperature half in high 16.
export const packFarSceneCell = (id, temperature, ctype = 0) =>
  (materialWord(id, appearanceOf(id, ctype)) | (DataUtils.toHalfFloat(temperature) << 16)) >>> 0;
export const unpackFarSceneCell = word => ({
  id: materialId(word & 0xffff), appearance: materialAppearance(word & 0xffff),
  temperature: DataUtils.fromHalfFloat(word >>> 16),
});

// Physical IDs vote first: splitting wood into roles must not let grass win.
// Opaque cells: {id, appearance, weight}; ties use lower ID/appearance.
export function dominantFarMaterial(cells) {
  const weights = new Map(), roles = new Map();
  for (const { id, appearance = Appearance.NONE, weight = 1 } of cells) {
    weights.set(id, (weights.get(id) ?? 0) + weight);
    const word = materialWord(id, appearance);
    roles.set(word, (roles.get(word) ?? 0) + weight);
  }
  let id = E.EMPTY, weight = 0;
  for (const [candidate, w] of weights) if (w > weight || (w === weight && candidate < id)) { id = candidate; weight = w; }
  let appearance = Appearance.NONE, roleWeight = 0;
  for (const [word, w] of roles) if (materialId(word) === id) {
    const a = materialAppearance(word);
    if (w > roleWeight || (w === roleWeight && a < appearance)) { appearance = a; roleWeight = w; }
  }
  return materialWord(id, appearance);
}

/**
 * WGSL consts of the far layout L (farLayout) and the grid texel's record:
 * world size in cells (WORLD) and bricks (WB), the occupancy levels (F1*,
 * F2*), the field's numbers (FAR_*), the far shadow heights' FAR_SHADOW_SOFT
 * and FAR_SHADOW_BIAS, and
 *   farInWorld(xz) -> bool              world column xz is inside the world
 *   farShadowLit(y, s) -> f32           sunlight at height y under shadow height s
 *   farUnpack(t: vec4u) -> FarTexel     a grid texel (textureLoad of tFarGrid)
 *   farPackTexel(f: FarTexel) -> vec4u  its inverse, for the passes that write the grid
 * World brick b is the grid's texel b; L1 and L2 node n covers bricks
 * n·FAR_NODE and n·FAR_NODE² onward. Needs no bindings.
 * @param {ReturnType<typeof farLayout>} L
 */
export const farLayoutGLSL = (L) => /* wgsl */ `
const WORLD_X: i32 = ${L.size[0]};
const WORLD_Y: i32 = ${L.size[1]};
const WORLD_Z: i32 = ${L.size[2]};
const WBX: i32 = ${L.bricks.n[0]};          // world bricks along x, y, z
const WBY: i32 = ${L.bricks.n[1]};
const WBZ: i32 = ${L.bricks.n[2]};
const F1X: i32 = ${L.l1.n[0]};          // L1 nodes
const F1Y: i32 = ${L.l1.n[1]};
const F1Z: i32 = ${L.l1.n[2]};
const F2X: i32 = ${L.l2.n[0]};          // L2 nodes
const F2Y: i32 = ${L.l2.n[1]};
const F2Z: i32 = ${L.l2.n[2]};
const FAR_BRICK: i32 = ${BRICK};            // cells per brick edge (the prelude's BS, for passes without it)
const FAR_NODE: i32 = ${FAR_NODE};
const FAR_L1_CELLS: i32 = ${BRICK * FAR_NODE};
const FAR_L2_CELLS: i32 = ${BRICK * FAR_NODE * FAR_NODE};
const FAR_ISO: f32 = ${glf(FAR.ISO)};
const FAR_CUBE: i32 = ${FAR.CUBE};
const FAR_CUBE_LO: i32 = ${(FAR.CUBE - BRICK) / 2};          // cells the cube reaches past the brick on each side
const FAR_THIN_MIN: f32 = ${glf(FAR.THIN_MIN)};
const FAR_THIN_V: f32 = ${glf(FAR.THIN_V)};
const FAR_SURFACE_W: f32 = ${glf(FAR.SURFACE_W)};
const FAR_LEVELS: f32 = ${glf(FAR.LEVELS)};
const FAR_GLOW_SPAN: f32 = ${glf(FAR.GLOW_SPAN)};
const FAR_SHADOW_SOFT: f32 = ${glf(FAR_SHADOW_SOFT)};   // cells: half the width of a far shadow's edge
const FAR_SHADOW_BIAS: f32 = ${glf(FAR_SHADOW_BIAS)};   // cells a point is lifted before its shadow-height test
const WORLD: vec3i = vec3i(WORLD_X, WORLD_Y, WORLD_Z);
const WB: vec3i = vec3i(WBX, WBY, WBZ);
// Whether world column xz (cells) is one of the world's: past its edge the far
// textures hold nothing (read clamped, an edge wall's shadow ran to the horizon).
fn farInWorld(xz: vec2f) -> bool { return all(xz >= vec2f(0.0)) && all(xz < vec2f(WORLD.xz)); }
// Sunlight at height y of a column whose shadow height (tFarShadow) is s:
// soft over FAR_SHADOW_SOFT either side, the point lifted FAR_SHADOW_BIAS.
fn farShadowLit(y: f32, s: f32) -> f32 { return smoothstep(-FAR_SHADOW_SOFT, FAR_SHADOW_SOFT, y + FAR_SHADOW_BIAS - s); }
// A far grid texel: its shares and glow (levels), its opaque and liquid
// elements (E_EMPTY: none) and whether it holds open opaque cells.
struct FarTexel { s: i32, l: i32, glow: i32, id: i32, liquid: i32, open: bool, appearance: i32 }
fn farUnpack(t: vec4u) -> FarTexel {
  var f: FarTexel;
  f.s = i32(t.r & 255u);
  f.l = i32(t.g & 255u);
  f.id = i32(t.b & 255u);
  f.appearance = i32(t.b >> 8u);
  f.glow = i32(t.a & 255u);
  f.liquid = i32(t.a >> 8u);
  f.open = (t.r >> 8u) != 0u;
  return f;
}
fn farPackTexel(f: FarTexel) -> vec4u {
  return vec4u(u32(f.s) | select(0u, 256u, f.open), u32(f.l), u32(f.id) | (u32(f.appearance) << 8u), u32(f.glow) | (u32(f.liquid) << 8u));
}
`;

// ---------------------------------------------------------------- sky
// The sky over the far field, as Minecraft's sky light (sun and sky are one
// light, whole over a column's ground and gone under it): the ground's surface
// seen from above (farTop's y: shaders/far.js farTopFrag), and how far under
// it the sky still reaches. Ground is matter wide enough to be the land: at
// FAR.ISO and REACH bricks out each way too (7 bricks, 28 cells: wider than any
// crown, ~24 cells for an oak's cluster, constructions/builtins.js TREES). A
// crown, a trunk, a wall, a bridge or a house's roof is narrower and leaves the
// sky over what is under it (and casts no pillar into the shadow heights); the
// rock over a cave or a tunnel doesn't. Narrowing the land by REACH errs open:
// on a slope the surface reads as low as the lowest ground within REACH, so
// only what lies deeper loses it.
export const FAR_SKY = {
  REACH: 3,       // bricks: matter counts as ground when it reaches this far along ±x and ±z
  OPEN: 1,        // bricks under the ground's surface the sky starts fading...
  SHUT: 2,        // ...and is gone (a Descent tunnel's ceiling is 2 or more under it)
  LIFT: 1,        // bricks out along its normal a far surface reads its sky (past its own brick's matter)
};
/**
 * The sky's share at a world point (after farLayoutGLSL(L), with the far
 * textures declared: lib(g, { far: true })):
 *   farSkyOpen(p) -> f32   1 over the ground, 0 under it (p in world cells)
 * Its own column's, read exact (textureLoad, not filtered: a cliff's top
 * would bury its foot); past the world's edge, open.
 */
export const farSkyGLSL = /* wgsl */ `
const FAR_SKY_OPEN: f32 = ${glf(FAR_SKY.OPEN * BRICK)};
const FAR_SKY_SHUT: f32 = ${glf(FAR_SKY.SHUT * BRICK)};
const FAR_SKY_LIFT: f32 = ${glf(FAR_SKY.LIFT * BRICK)};
fn farSkyOpen(p: vec3f) -> f32 {
  if (!farInWorld(p.xz)) { return 1.0; }
  let hs = textureLoad(tFarTop, vec2i(p.xz) / FAR_BRICK, 0).y;
  return smoothstep(hs - FAR_SKY_SHUT, hs - FAR_SKY_OPEN, p.y);
}
`;

// ---------------------------------------------------------------- haze
const FAR_HAZE_VISIBILITY_M = 12000;   // m: meteorological range of the air (a clear day with some haze)
const KOSCHMIEDER = 3.912;             // ln(1/0.02): the 2 % contrast threshold of the visibility definition
// extinction per cell of the air, green (blue and red follow the sky's): shaders/far.js FAR_VIEW.HAZE
export const FAR_HAZE = KOSCHMIEDER / (FAR_HAZE_VISIBILITY_M / CELL_M);
// ...per channel: the sky's spectral shape, scaled to green's (a literal, so
// every WGSL reader, reflection parsers included, takes it as it is)
const FAR_HAZE_RGB = tauAir.map((t) => FAR_HAZE * t / tauAir[1]);

/**
 * The air itself, after skyGLSL's TAU_AIR and skyViewGLSL's skyRadiance (no
 * probes, no source artwork): what farHazeFor builds on, and the sky pass's
 * sea past a world's edge (gfx/overlays.js), which fades into the horizon as
 * the land does.
 *   farAir(rd) -> vec3f                     the air's light toward unit rd
 *   farHazeAir(col, rd, d, lit) -> vec3f    col seen through d cells of air
 *                                           whose sky share is lit
 */
export const farAirWGSL = /* wgsl */ `
const FAR_HAZE: f32 = ${FAR_HAZE.toExponential(4)};
const FAR_HAZE_RGB: vec3f = vec3f(${FAR_HAZE_RGB.map((x) => x.toExponential(6)).join(', ')});
fn farAir(rd: vec3f) -> vec3f {
  if (rd.y > 0.0) { return skyRadiance(rd); }
  var h = vec3f(rd.x, 0.0, rd.z);
  if (dot(h, h) > 1e-8) { h = normalize(h); } else { h = vec3f(1.0, 0.0, 0.0); }
  return skyRadiance(h);
}
fn farHazeAir(col: vec3f, rd: vec3f, d: f32, lit: f32) -> vec3f {
  let T = exp(-FAR_HAZE_RGB * d);
  return col * T + lit * farAir(rd) * (1.0 - T);
}
`;
/**
 * Aerial perspective, for the volume on every map (volumeHazeGLSL) and the far field:
 * over d cells along rd, the air's extinction (the sky's spectral shape,
 * scaled to the haze's visibility) and its in-scatter, the sky's own radiance
 * toward rd, held at the horizon for rays going down, so distance fades into
 * the sky. The in-scatter is the sky's light on the air, so it takes the share
 * of the open sky the air on the way sees (the GI probes': farAirLit): a
 * cave's air, which no sky reaches, adds none, and the eyes adjusting to the
 * dark don't raise it into a blue fog. After lib() (skyRadiance, TAU_AIR,
 * GI_OFFSET and the sky reader).
 *   farAir, farHazeAir                            farAirWGSL's
 *   farAirLit(a, b) -> f32                        share of the open sky's light on
 *                                                 the air from a to b (window cells)
 *   farHaze(col, rd, d, lit) -> vec3f             farHazeAir, or the source artwork's fog
 *   farHazeSeen(col, alpha, eye, p, lit) -> vec3f premultiplied col at p seen from eye
 *                                                 through air whose sky share is lit
 *   farHazePremul(col, alpha, eye, p) -> vec3f    farHazeSeen with farAirLit
 * farHazeFor(airSky) names the function that reads the air's sky share at a
 * window point (the GLSL's FAR_AIR_SKY): giAirSkyVis, the probes (farHazeGLSL),
 * or the far view's own reader, which takes the far field's sky
 * past the window. null leaves out farAirLit and farHazePremul, for a pipeline
 * that doesn't sample the probes (GI gather writes them): the rest need
 * neither.
 * @param {string | null} [airSky]
 */
export const farHazeFor = (airSky = 'giAirSkyVis') => /* wgsl */ `${farAirWGSL}
fn farHaze(col: vec3f, rd: vec3f, d: f32, lit: f32) -> vec3f {
  if (sourceEnabled()) { return sourceFog(col, d); }
  return farHazeAir(col, rd, d, lit);
}
// Premultiplied col at p seen from eye through air whose sky share is lit:
// the share alpha covers takes the air's light.
fn farHazeSeen(col: vec3f, alpha: f32, eye: vec3f, p: vec3f, lit: f32) -> vec3f {
  if (sourceEnabled()) { return sourceFog(col / max(alpha, 0.0001), distance(eye, p)) * alpha; }
  let v = p - eye;
  let d = length(v);
  return farHazeAir(col, v / max(d, 1e-6), d, alpha * lit);
}${airSky ? `
// The air's sky share from a to b: ${airSky} at its ends and middle, by
// Simpson's rule, the far end GI_OFFSET back out of the matter it lies on
// (whose brick's probe is buried).
fn farAirLit(a: vec3f, b: vec3f) -> f32 {
  let v = b - a;
  let d = length(v);
  let bo = b - v * (min(GI_OFFSET, d) / max(d, 1e-6));
  return (${airSky}(a) + 4.0 * ${airSky}(0.5 * (a + bo)) + ${airSky}(bo)) / 6.0;
}
fn farHazePremul(col: vec3f, alpha: f32, eye: vec3f, p: vec3f) -> vec3f {
  return farHazeSeen(col, alpha, eye, p, farAirLit(eye, p));
}` : ''}
`;
/** The haze with the probes' sky reader (giAirSkyVis). */
export const farHazeGLSL = farHazeFor();

/**
 * The volume's haze, on every map (shaders/render.js, the material views):
 * the air between the eye and what a pixel shows, as farHazePremul, with
 * the air's sky share from the probes at the ray's two ends alone:
 *   hazeAirLit(a, b) -> f32                   share of the open sky's light on
 *                                             the air from a to b (grid cells)
 *   volumeHaze(col, alpha, eye, p) -> vec3f   premultiplied col at p, seen from eye
 * The ends: the eye, and the far end GI_OFFSET back out of the matter it lies
 * on, beside the probe that matter's own shading reads. farAirLit's middle is
 * a brick of open air that on a big map nothing else reads: asking for it
 * would make the world light empty air behind every pixel, bricks that move
 * with the eye. So the haze asks for nothing: only what the probes already
 * hold counts (giAirSkyHeld; a box's window holds all of them), and with
 * neither end held the air is open, as past the probes (giAirSkyVis).
 */
export const volumeHazeGLSL = /* wgsl */ `${farHazeGLSL}
fn hazeAirLit(a: vec3f, b: vec3f) -> f32 {
  let v = b - a;
  let d = length(v);
  let s = giAirSkyHeld(a) + giAirSkyHeld(b - v * (min(GI_OFFSET, d) / max(d, 1e-6)));
  return select(1.0, s.x / max(s.y, 1e-6), s.y > 0.0);
}
fn volumeHaze(col: vec3f, alpha: f32, eye: vec3f, p: vec3f) -> vec3f {
  return farHazeSeen(col, alpha, eye, p, hazeAirLit(eye, p));
}
`;

// ---------------------------------------------------------------- casters
// Far casters in the window's sun shadow map (the shadow kernel): where
// along a texel's ray (grid cells, [t0, t1]: its stretch through the box) it
// first goes under the shadow height of the columns outside the window
// (tFarShadow's y). Along a sun ray the height above it can only fall (see
// shaders/far.js), so one read at the ray's end says whether it ever does,
// and bisection finds where. A column casts from the higher of its ground seen
// from below and from above (FAR_SKY): the rock over a cave casts, so the sun
// doesn't shine down the caves and tunnels under it (farShadowFrag).
export const FAR_CASTER_STEPS = 10;   // bisection steps (a box diagonal of ~220 cells to ~0.2 cells)
const castersWGSL = /* wgsl */ `
const FAR_CASTER_STEPS: i32 = ${FAR_CASTER_STEPS};
// Whether grid point p lies below the far casters' shadow height.
fn farUnder(p: vec3f) -> bool {
  let w = p + vec3f(H.origin);
  // past the world's edge nothing casts (the heights hold only its columns: clamped, an edge wall's shade ran on forever)
  if (!farInWorld(w.xz)) { return false; }
  return w.y + FAR_SHADOW_BIAS < textureSampleLevel(tFarShadow, linearClamp, w.xz / vec2f(WORLD.xz), 0.0).y;
}
// The first t in [t0, t1] where ray (ro, rd) is under it, or NO_HIT.
fn farCasterDepth(ro: vec3f, rd: vec3f, t0: f32, t1: f32) -> f32 {
  if (!farUnder(ro + rd * t1)) { return NO_HIT; }
  if (farUnder(ro + rd * t0)) { return t0; }
  var a = t0;
  var b = t1;
  for (var i = 0; i < FAR_CASTER_STEPS; i++) {
    let m = 0.5 * (a + b);
    if (farUnder(ro + rd * m)) { b = m; } else { a = m; }
  }
  return b;
}
`;
/**
 * The casters' WGSL (after lib()); with the layout (farLayoutGLSL(L)) unless
 * layout is false (a module that pastes the layout itself, or farGIGLSL too).
 * @param {ReturnType<typeof farLayout>} L
 * @param {{ layout?: boolean }} [opts]
 */
export const farCastersGLSL = (L, { layout = true } = {}) => `${layout ? farLayoutGLSL(L) : ''}${castersWGSL}`;

// ---------------------------------------------------------------- GI
// The far field in the window's GI (shaders/gi.js, the gather): a probe's ray
// that has marched its bricks without being stopped reads the far field past
// where it ended, at doubling distances: the brick-column tops (the window's
// own region included, from its summary), so distant hills block the low sky
// and send back the light of their ground (its element's albedo, the sun
// through the shadow heights, the sky over it); a ray going down past the
// coast meets the sea (the sky in it by Fresnel, and its body); else the sky.
// A column's top is the higher of its ground seen from below and from above
// (FAR_SKY: the rock over a cave). A ray that leaves the window under the
// ground (a tunnel or cave its side cuts) gets what the sky leaves there
// (farSkyOpen): none deep under it.
export const FAR_GI_STEPS = 6;       // reads along the ray past its end...
export const FAR_GI_STEP0 = 8;       // ...the first this many cells out, each next twice as far (~500 cells in all)
const giWGSL = /* wgsl */ `
const FAR_GI_STEPS: i32 = ${FAR_GI_STEPS};
const FAR_GI_STEP0: f32 = ${glf(FAR_GI_STEP0)};
const FAR_SEA_F0: f32 = 0.02;   // water's reflectance face on ((1.333 - 1) / (1.333 + 1))²
// The sunlit, sky-lit ground of the column at world point r whose top is top.
fn farGround(r: vec3f, top: f32) -> vec3f {
  let b = clamp(vec3i(floor(vec3f(r.x, top - 1.0, r.z) / f32(FAR_BRICK))), vec3i(0), WB - 1);   // the brick under the top
  let id = farUnpack(textureLoad(tFarGrid, b, 0)).id;
  let s = textureSampleLevel(tFarShadow, linearClamp, r.xz / vec2f(WORLD.xz), 0.0).x;
  let sun = farShadowLit(top, s) * cloudShadow(vec3f(r.x, top, r.z));
  return ALBEDO(select(id, E_ROCK, id == E_EMPTY)) * (FU.sunCol * max(FU.sun.y, 0.0) * sun + FU.skyUp);
}
// The open sea seen toward unit d (going down).
fn farSea(d: vec3f) -> vec3f {
  let F = FAR_SEA_F0 + (1.0 - FAR_SEA_F0) * pow(1.0 - clamp(-d.y, 0.0, 1.0), 5.0);
  return F * skyColor(reflect(d, vec3f(0.0, 1.0, 0.0))) + (1.0 - F) * SCATALB(E_WATER) * FU.skyUp;
}
// a world without a sea (FU.sea 0: world/scenes) has a rock plain past its edge (the far view's)
fn farPlain() -> vec3f { return ALBEDO(E_ROCK) * (FU.sunCol * max(FU.sun.y, 0.0) + FU.skyUp); }
// What a ray from world point w sees toward unit d past the window, under the
// open sky; *open becomes 0 where the far field blocks the sky that way.
fn farBeyondOpen(w: vec3f, d: vec3f, open: ptr<function, f32>) -> vec3f {
  var s = FAR_GI_STEP0;
  for (var i = 0; i < FAR_GI_STEPS; i++) {
    let r = w + d * s;
    if (!farInWorld(r.xz)) { break; }
    let t = textureSampleLevel(tFarTop, linearClamp, r.xz / vec2f(WORLD.xz), 0.0).xy;
    let top = max(t.x, t.y);   // the ground seen from below or above (the rock over a cave)
    if (r.y < max(top, FU.sea)) {
      *open = 0.0;
      if (top >= FU.sea) { return farGround(r, top); }
      return farSea(d);
    }
    s *= 2.0;
  }
  if (d.y >= 0.0) { return skyColor(d); }
  if (FU.sea > 0.0) { return farSea(d); }
  return farPlain();
}
// What a ray from grid point P that ended at Q sees past it toward unit d,
// scaled by the sky's share where it leaves (*open with it).
fn farBeyond(P: vec3f, Q: vec3f, d: vec3f, open: ptr<function, f32>) -> vec3f {
  let w = Q + vec3f(H.origin);
  let sky = farSkyOpen(w);
  *open *= sky;
  if (sky > 0.0) { return sky * farBeyondOpen(w, d, open); }
  return vec3f(0.0);
}
`;
/**
 * The GI's far WGSL (after lib(g, { variant: 'LIGHTING_GI' }) or any variant
 * with the far textures), with the sky (farSkyGLSL) as the GLSL had it; with
 * the layout unless layout is false, the sky unless sky is false (a module
 * that pastes farSkyGLSL itself).
 * @param {ReturnType<typeof farLayout>} L
 * @param {{ layout?: boolean, sky?: boolean }} [opts]
 */
export const farGIGLSL = (L, { layout = true, sky = true } = {}) => `${layout ? farLayoutGLSL(L) : ''}${sky ? farSkyGLSL : ''}${giWGSL}`;

/** tools/check-wgsl.mjs: a probe kernel calling every function above (shaders/gfx/lib.js libChecks) */
export const WGSL_CHECK = () => libChecks('farShared');
