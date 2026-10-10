import { prelude, BRICK } from './common.js';
import { materialsGLSL, CHANNELS, MEDIA } from '../gfx/materials.js';
import { blendFixedFrames } from '../gfx/pacing.js';

// Render fields: continuous versions of the blocky state, rebuilt once per
// frame for the renderer only (the simulation never reads them).
//
// 1. EMA pass: per cell, one-hot occupancy of each smooth-surface channel,
//    media densities and flame temperature, blended toward the previous frame's values
//    (temporal smoothing, so cells swapping every sim step don't shimmer).
// 2. Three separable 5-tap Gaussian passes (x, y, z) with a per-channel
//    radius. The last pass normalises by the blurred "non-crisp" weight, so
//    walls, the floor and the box sides count neither way: a liquid film one
//    cell deep keeps its height, and surfaces meet walls at a clean angle.
//
// 3. Thin-feature boost: six separable passes over the 3-cell neighbourhood.
//    The first three (x, y, z) smooth the cubic channels (liquids) with the
//    B-spline's lattice weights, which is what the tracer's cubic sample reads
//    at a cell centre (other channels pass through), and find whether the
//    channel holds any of the 3³ cells right now. The last three find each
//    channel's local peak of that. Next to current matter, a feature whose
//    peak is under the channel's bulk peak (gfx/materials.js bulkPeak,
//    bulkPeakCubic) is scaled up so its surface sits THIN_RADIUS from the cell
//    centre instead of blurring away: lone grains and droplets, one-cell
//    trunks, films, streams. Ghosts of cells that moved on hold no matter now,
//    so they still fade with the EMA.
//
// Attachments (RGBA): 0 = surface channels (liquid, molten, granular,
// organic), 1 = media (smoke, steam, fire, flame temperature), 2 = non-crisp weight, one
// copy per surface channel since each channel has its own blur radius (the
// media share the liquid kernel and its weight).
// Final output: 0 = surface φ (0.5 is the surface), 1 = media densities,
// 2 = thin mask, rising from 0 to 1 with a channel's boost (THIN_MASK_LO..HI).
// Only cubic channels need it: the tracer reads them cubic only there (bulk
// surfaces read the same either way, and trilinear is 8x cheaper).

export const fieldEmaFrag = (g) => /* glsl */ `
${prelude(g)}
${materialsGLSL()}
// Rubble (STONE) is a heap of chips up to ~11 cm, so its surface is lumpy at
// the cell's scale, not smooth like sand: each cell fills its channel by a
// share of its own (from its seed, so it moves with the cell), and the blurred
// surface bulges over the full cells and dips over the sparse ones.
#define RUBBLE_LUMP 0.45        // most a rubble cell's occupancy falls short of 1
#define RUBBLE_LUMP_HASH 7.13   // spreads the seed (a.w) into a fresh uniform
uniform sampler2D tP0;
uniform sampler2D tP1;
uniform vec4 uEmaS;
uniform vec4 uEmaM;
// grid cells the window moved since the last update (docs/scaling.md D11): a
// cell's history is at p + uShift; cells shifted in from outside start over
uniform ivec3 uShift;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec3 p = fieldCellFromFrag(f);
  if (!inGrid(p)) { o0 = o1 = o2 = vec4(0.0); return; }
  vec4 a = fetchA(p);
  int id = eid(a);
  vec4 s = vec4(0.0), m = vec4(0.0);
  int ch = SURFCH[id], md = MEDIACH[id];
  bool crisp = id != E_EMPTY && ch < 0 && md < 0;
  if (ch >= 0) s[ch] = id == E_STONE ? 1.0 - RUBBLE_LUMP * fract(fract(a.w) * RUBBLE_LUMP_HASH) : 1.0;
  if (md == MD_SMOKE) m.x = clamp(a.z, 0.0, 1.0);
  else if (md == MD_STEAM) m.y = HAZE[id];   // droplets 1, a clear gas a faint haze (gfx/materials.js)
  else if (md == MD_FIRE) {
    m.z = mix(FIRE_BASE, 1.0, clamp(a.z, 0.0, 1.0));
    // flame temperature, weighted by density (see MEDIA in gfx/materials.js)
    m.w = m.z * clamp((a.y - AMBIENT) / HEAT_RANGE, 0.0, 1.0);
  }
  ivec3 q = p + uShift;
  ivec2 h = fieldAtlas(q);
  bool hist = inGrid(q);
  o0 = hist ? mix(texelFetch(tP0, h, 0), s, uEmaS) : s;
  o1 = hist ? mix(texelFetch(tP1, h, 0), m, uEmaM) : m;
  o2 = vec4(crisp ? 0.0 : 1.0);
}
`;

// Taps of the separable Gaussian (gfx/materials.js gauss5), centred: each pass
// reads BLUR_REACH cells to either side along its axis.
export const BLUR_TAPS = 5;
export const BLUR_REACH = (BLUR_TAPS - 1) / 2;
export const fieldBlurFrag = (g, final) => /* glsl */ `
${prelude(g)}
#define BLUR_TAPS ${BLUR_TAPS}
#define BLUR_REACH ${BLUR_REACH}
uniform sampler2D t0;
uniform sampler2D t1;
uniform sampler2D t2;
uniform int uAxis;
uniform vec4 uW[BLUR_TAPS];   // per-tap weights, one per surface channel (media use .x)
// below this blurred non-crisp weight (deep inside crisp solids) there is nothing to normalise by
#define NORM_FLOOR 0.02
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
${final ? '' : 'layout(location = 2) out vec4 o2;'}
void main() {
  ivec3 p = fieldCellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { o0 = o1 = vec4(0.0); ${final ? '' : 'o2 = vec4(0.0);'} return; }
  ivec3 dir = uAxis == 0 ? ivec3(1, 0, 0) : (uAxis == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1));
  vec4 s = vec4(0.0), m = vec4(0.0), d = vec4(0.0);
  for (int i = 0; i < BLUR_TAPS; i++) {
    ivec3 q = p + dir * (i - BLUR_REACH);
    if (!inGrid(q)) continue;   // outside the box = crisp
    ivec2 t = fieldAtlas(q);
    vec4 w = uW[i];
    s += w * texelFetch(t0, t, 0);
    m += w.x * texelFetch(t1, t, 0);
    d += w * texelFetch(t2, t, 0);
  }
${final ? `
  // normalise; deep inside crisp solids there is nothing to normalise by
  vec4 ok = step(vec4(NORM_FLOOR), d);
  o0 = ok * s / max(d, vec4(NORM_FLOOR));
  o1 = ok.x * m / max(d.x, NORM_FLOOR);
` : `
  o0 = s; o1 = m; o2 = d;
`}
}
`;

// Stages 0-2 (x, y, z): lattice smoothing of φ (stage 0 reads φ and the
// state, later stages their predecessor) and the occupancy, dilated.
// Stages 3-5 (x, y, z): local peak of the smoothed field, occupancy passed
// along; stage 5 applies the boost to φ, passes the media through and writes
// the thin mask.
export const BOOST_STAGES = 6;
const LAST = BOOST_STAGES - 1;
// The dirty sets of the incremental passes (docs/scaling.md D9; built by
// shaders/passes.js dirtyFrag): the channel of the dirty map, the region map
// and the share that holds each.
export const DIRTY = { EMA: 0, FIELDS: 1, WORK: 2 };
const AXES = 3;
// Cells each boost stage reads to either side along its axis, and so the whole
// boost along each axis (two stages per axis).
const BOOST_STAGE_REACH = 1;
export const BOOST_REACH = (BOOST_STAGES / AXES) * BOOST_STAGE_REACH;
export const fieldBoostFrag = (g, stage) => /* glsl */ `
${prelude(g)}
${materialsGLSL()}
uniform sampler2D t0;   // stage 0: φ, else the previous stage's field
${stage > 0 ? 'uniform sampler2D t1;   // the occupancy so far (stage 0 reads the state instead)' : ''}
${stage < 3 ? 'uniform vec4 uS;      // per-channel centre weight of the lattice smoothing (1 = none)' : ''}
${stage === LAST ? `uniform sampler2D tPhi;
uniform sampler2D tMed;
uniform vec4 uBulk;     // per-channel bulk peak
uniform sampler2D tDirty;   // dirty sets, per brick` : ''}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;   // ${stage < LAST ? 'the scratch targets have three attachments: unused' : 'thin mask'}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec3 p = fieldCellFromFrag(f);
  o2 = vec4(0.0);
  if (!inGrid(p)) { o0 = o1 = vec4(0.0); return; }
${stage === LAST ? `  // Only bricks whose fields may change are written. The regions drawn reach
  // past them, to cells whose inputs this frame's passes didn't all compute.
  if (texelFetch(tDirty, brickAtlas(p / BS), 0)[${DIRTY.FIELDS}] < 0.5) discard;` : ''}
  const ivec3 dir = ivec3(${['1, 0, 0', '0, 1, 0', '0, 0, 1'][stage % 3]});
  vec4 acc = vec4(0.0), occ = vec4(0.0);
  for (int i = -1; i <= 1; i++) {
${stage < 3 ? `    // clamped to the edge, like the tracer's cubic sample
    ivec3 q = clamp(p + dir * i, ivec3(0), ivec3(NX, NY, NZ) - 1);
    ivec2 t = fieldAtlas(q);
    acc += (i == 0 ? uS : 0.5 * (1.0 - uS)) * texelFetch(t0, t, 0);
${stage === 0 ? `    int ch = SURFCH[eid(fetchA(q))];
    if (ch >= 0) occ[ch] = 1.0;` : '    occ = max(occ, texelFetch(t1, t, 0));'}` : `    ivec3 q = p + dir * i;
    if (inGrid(q)) acc = max(acc, texelFetch(t0, fieldAtlas(q), 0));`}
  }
${stage >= 3 ? '  occ = texelFetch(t1, f, 0);' : ''}
${stage === LAST ? `  vec4 k = max(vec4(1.0), uBulk / max(acc, vec4(THIN_MIN_PEAK)));
  vec4 boosted = step(0.5, occ);
  o0 = texelFetch(tPhi, f, 0) * mix(vec4(1.0), k, boosted);
  o1 = texelFetch(tMed, f, 0);
  o2 = boosted * smoothstep(vec4(THIN_MASK_LO), vec4(THIN_MASK_HI), k);` : `  o0 = acc;
  o1 = occ;`}
}
`;

// ---- incremental updates (docs/scaling.md D9) ----
// The passes above run only over the bricks that may have changed (sim.js
// updateBricks; the dirty sets are built by shaders/passes.js dirtyFrag).
//
// Frames a cell's EMA keeps changing after its state last did: the slowest
// channel's blend reaches its 8-bit fixed point by then (gfx/pacing.js
// blendFixedFrames; 13 for the liquid's 0.35), and the EMA pass may skip it.
export const FIELD_EMA_SETTLE = Math.max(...[...new Set([...CHANNELS, ...MEDIA].map((c) => c.ema))].map(blendFixedFrames));
// Cells a change in the EMA (or the state) reaches into the final fields
// along each axis: the blur's taps, then the boost's stages.
export const FIELD_REACH = BLUR_REACH + BOOST_REACH;
// The passes between the EMA and the final fields share scratch targets, which
// outside this frame's regions hold some other pass's output: each must cover
// every cell the passes after it read. The first blur's output (x) is read
// farthest from a final field cell: along y (or z) by one more blur and the
// boost's stages.
export const FIELD_SCRATCH_REACH = BLUR_REACH + BOOST_REACH;

// The field atlas in regions (gfx/regions.js): a region is FIELD_REGION_BRICKS
// bricks square in x and z, in one Y-slice; instance i is region
// (i % rx, (i / rx) % rz) of slice i / (rx · rz). Its flag is the region map's
// texel (rx + RX · rz, brick layer) (shaders/passes.js fieldRegionMapFrag).
// Measured (M5, 128³, per-pass p10 while running): 4- and 8-brick regions
// cost the same within noise and 16 a little more; 2 lost (32k instances a
// pass, and a slow share pass). 8 matches the hardware tile and draws a
// quarter of 4's instances.
export const FIELD_REGION_BRICKS = 8;   // 32 cells: one hardware tile of a slice
// Share of regions flagged above which one full-screen quad is drawn instead.
// Regions still beat it at the highest share measured (92%, volcano: 2.0 ms
// for the field passes against 2.3), and cost about as much at 100%.
export const FIELD_FULL_SHARE = 0.95;
const glslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export function fieldRegions(g) {
  const side = FIELD_REGION_BRICKS;
  const rx = Math.ceil(g.nx / BRICK / side), rz = Math.ceil(g.nz / BRICK / side);
  return { side, rx, rz, count: rx * rz * g.ny, mapWidth: rx * rz, mapHeight: g.ny / BRICK };
}
// regionVert's GLSL for a field pass over dirty set `set` (shaders/passes.js DIRTY).
export function fieldRegionsGLSL(g, set) {
  const { side, rx, rz, count } = fieldRegions(g);
  const fty = Math.round(g.fheight / g.nz);
  return /* glsl */ `
#define REGION_COUNT ${count}
#define NX ${g.nx}
#define NZ ${g.nz}
#define BS ${BRICK}
#define FTX ${g.ftx}          // field atlas: Y-slices per row
#define FTY ${fty}          // …and rows
#define RX ${rx}          // regions per slice along x, z
#define RZ ${rz}
#define REGION_CELLS ${side * BRICK}   // region side (cells = texels)
#define SET ${set}            // dirty set (channel of the region map and the share)
#define FULL_SHARE ${glslFloat(FIELD_FULL_SHARE)}
uniform sampler2D tRegion;   // region flags, per dirty set
uniform sampler2D tShare;    // share of regions flagged, per dirty set
vec2 regionTarget() { return vec2(FTX * NX, FTY * NZ); }
bool regionsFull() { return texelFetch(tShare, ivec2(0), 0)[SET] > FULL_SHARE; }
bool regionOn(int i) {
  int y = i / (RX * RZ), r = i - y * (RX * RZ);
  return texelFetch(tRegion, ivec2(r, y / BS), 0)[SET] > 0.5;
}
vec4 regionRect(int i) {
  int y = i / (RX * RZ), r = i - y * (RX * RZ);
  ivec2 slice = ivec2((y % FTX) * NX, (y / FTX) * NZ);
  ivec2 lo = slice + ivec2(r % RX, r / RX) * REGION_CELLS;
  return vec4(lo, min(lo + REGION_CELLS, slice + ivec2(NX, NZ)));
}
`;
}

// Copy of the EMA (three attachments) from the pass's output into the
// persistent EMA target, over the regions the EMA pass drew.
export const fieldCopyFrag = () => /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D t0;
uniform sampler2D t1;
uniform sampler2D t2;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  o0 = texelFetch(t0, f, 0);
  o1 = texelFetch(t1, f, 0);
  o2 = texelFetch(t2, f, 0);
}
`;
