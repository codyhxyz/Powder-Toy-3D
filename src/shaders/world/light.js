// Lighting in world cells over the world copy (docs/seamless-world.md, "L — lighting").
//
// Every reader takes points in world cells (the world's corner at 0, y up) and asks the world copy
// (W: wcCell, wcA, wcInfo, wcOccupied, WC) and the field clipmaps (F: surfField, surfSample,
// mediaField) what is there. Nothing here knows the physics window. The light is held in three
// camera-centred, world-anchored structures, each updated under a fixed per-frame budget
// (src/gfx/worldLight.js) and each addressed toroidally, so a camera move writes only what came
// into range and a physics move writes nothing:
//
//   sun shadow cascades  SHADOW.CASCADES orthographic maps across the sun, SHADOW.RES² texels each,
//                        in the one storage buffer (lcBuf, binding 15, as vec4u: bitcast). The texel format is the old
//                        map's (shaders/gfx/shadowOptics.js): opaque depth, translucent start and
//                        end, tint id · SHADOW_TINT_ID_SCALE + optical depth, so the colour through
//                        glass, water and smoke, the caustics' pool test and PCSS read as before.
//                        Cascades 0 and 1 scroll with the camera by tiles (SHADOW.TILE² texels);
//                        the last covers the whole world and never scrolls. Why a cached map and
//                        not a ray per pixel: a pixel's sun ray on a big map crosses hundreds of
//                        cells (the hierarchy skips air, not the grazing terrain it runs along),
//                        PCSS would need several, and every pixel of every frame pays; a texel is
//                        traced once and serves every pixel and frame under it until a brick its
//                        ray crossed changes, or the sun turns past SHADOW.TURN_RAD. A sun turn
//                        retraces one cascade at a time into a spare slot (SHADOW.SLOTS =
//                        CASCADES + 1), swapped in when complete, so the picture never mixes two
//                        suns in one cascade. Shadow maps that scroll by whole texels are the
//                        clipmap idea (Losasso & Hoppe 2004) in sun space; Halo 3 and TF2 filter
//                        theirs the same way.
//   bounce-light probes  PROBE.LEVELS cascades of PROBE.N³ L1-SH probes, PROBE.SPACING cells apart,
//                        DDGI's "infinite scrolling volumes" (Majercik et al. 2019; RTXGI): the
//                        probes that came into range update first, then PROBE.ROTATE_CHUNKS others a
//                        frame. Four rgba16float 3D textures (tGI0..3, bindings 8-11), the levels
//                        side by side along x with a guard texel each way (a copy of the wrapped
//                        first row), so one hardware trilinear sample a band serves a toroidal level.
//   glow                 GLOW.LEVELS clips of per-brick blurred emission (lava, fire, hot metal,
//                        luminous crystal, live wires, lit lamps), the old tLight's, in tGlow
//                        (binding 12), the same layout as the probes.
// Validity: a tag per shadow tile and per probe or glow chunk (in lcBuf past the texels, TAGS) names the lattice
// tile or chunk its texels hold; a reader whose tile is stale (just scrolled in, not yet traced)
// falls through to the next coarser level. Nothing is cleared on a scroll.
//
// What this module needs from the march's assembly (M), besides W and F: group 0 (FU, the element
// tables), materialsGLSL (ALBEDO, SIGMA, RCLASS, SURFCH, MEDIACH, cellEmission, sparkEmit, SHED,
// luminous, lampLit, INCAND_T0, LAMP_ROOM_GAIN), common's eid/isGasLike/blackbody/LUMA_709/E_*,
// noise.js (vnoise, ign, ignR, hash33, stbn2, stbnT, R1_G), glslMod, and core.js's private
// gFragCoord (the pixel, for the PCSS rotation and the lamps' jitter). It brings sky, the clouds'
// deck and the beacon itself. Lamp, wand-light and beacon positions in FU are world cells
// (H.origin is 0 for every render kernel).
import { skyGLSL, skyViewGLSL, SUN_TAN_RADIUS } from '../../gfx/sky.js';
import { cloudDeckGLSL } from '../gfx/clouds.js';
import { LAMP_UNIT, LAMP_FIXED_PAD } from '../../gfx/lamps.js';
import { LIGHTHOUSE } from '../../gfx/lighthouseMath.js';
import { WAND_LIGHTS, BRICK_INFO } from '../bindings.js';
import { SH_Y0, SH_Y1, SKYVIS_OPEN_DC, GI_OFFSET_CELLS, SHADOW_TINT_ID_SCALE, VOLUME_SHADOW_BIAS, meanSigmaWGSL } from '../gfx/lighting.js';
import { uniformStruct } from '../../gpu/params.js';
import { STAGE } from '../common.js';
import { glf } from '../../glsl.js';

// ---- the budgets and sizes (every number named; src/gfx/worldLight.js spends them) ----
export const SHADOW = Object.freeze({
  CASCADES: 3,
  SLOTS: 4,                 // CASCADES + the spare a sun turn retraces into
  RES: 512,                 // texels a side, every cascade
  TILE: 8,                  // texels a side of a tile: the unit of tracing, scrolling and tags
  TEXEL: [0.5, 2],          // cells a texel, scrolling cascades (the old 128³ window's map: 0.44)
  SNAP_TILES: 1,            // a scrolling cascade's origin moves by whole tiles
  MARGIN: 8,                // texels a reader keeps from a scrolling cascade's edge (PCSS's reach)
  TILES_PER_FRAME: 160,     // tiles traced a frame, everything together (10,240 rays)
  TURN_RAD: 0.5 * Math.PI / 180,   // the sun turns this far, and the cascades retrace for it
  PAD: 2,                   // cells the world cascade's disc reaches past the world's bounding sphere
  MAX_STEPS: 2048,          // hierarchy steps a texel's ray may take
});
export const PROBE = Object.freeze({
  LEVELS: 3,
  N: 32,                    // probes a side, every level
  SPACING: [4, 16, 64],     // cells between probes (level 0: one a brick, as the old volume)
  CHUNK: 4,                 // probes a side of a chunk: the unit of updating and tags
  RAYS: 32,                 // rays a probe update traces (a workgroup)
  RANGE: [32, 128],         // cells a ray of levels 0, 1 marches before it asks the next level
  MAX_STEPS: 192,           // hierarchy steps a probe ray may take
  NEW_CHUNKS_MAX: 16,       // chunks that came into range (or changed) updated a frame (1,024 probes)
  ROTATE_CHUNKS: 4,         // ... plus this many others, round robin (256 probes): 40,960 rays a frame at most
  BLEND: 0.15,              // share of a new update in a probe's history (hysteresis 0.85)
  EDGE_BLEND: 2,            // probes over which a level hands over to the next one at its edge
});
export const GLOW = Object.freeze({
  LEVELS: 2,
  N: 64,                    // texels a side
  SPACING: [4, 16],         // cells a texel (level 0: a brick, as the old tLight)
  CHUNK: 8,                 // texels a side of a chunk: one update job
  REACH: 4,                 // texels the blur reaches each way: two 5-tap passes an axis
  JOBS_PER_FRAME: 6,        // chunks a frame (each reads its 16³ seeds: ≤ 1.6 M cell reads)
  SAMPLES: 2,               // cells a side a level-1 texel's bricks are sampled at (2³ a brick)
});
// Where the tags live past lcBuf's texels (u32 words): shadow tiles a slot, then probe chunks, glow chunks.
const shadowTilesSide = SHADOW.RES / SHADOW.TILE;
const probeChunksSide = PROBE.N / PROBE.CHUNK;
const glowChunksSide = GLOW.N / GLOW.CHUNK;
export const TAGS = Object.freeze({
  SHADOW: 0,
  PROBE: SHADOW.SLOTS * shadowTilesSide ** 2,
  GLOW: SHADOW.SLOTS * shadowTilesSide ** 2 + PROBE.LEVELS * probeChunksSide ** 3,
  WORDS: SHADOW.SLOTS * shadowTilesSide ** 2 + PROBE.LEVELS * probeChunksSide ** 3 + GLOW.LEVELS * glowChunksSide ** 3,
});
export const TAG_VALID = 0x80000000;
// lcBuf (binding 15, vec4u): the shadow slots' texels, then the tags, four to a vec4u.
export const SHADOW_TEXELS = SHADOW.SLOTS * SHADOW.RES ** 2;
export const LC_BUF_VEC4S = SHADOW_TEXELS + Math.ceil(TAGS.WORDS / 4);
export const TAG_MASK = 1023;
/** A tag: the valid bit and three 10-bit lattice coordinates (an epoch in the third for shadow tiles). */
export const lcTag = (x, y, z) => (TAG_VALID | (x & TAG_MASK) | ((y & TAG_MASK) << 10) | ((z & TAG_MASK) << 20)) >>> 0;
/** The probe and glow textures' size: levels side by side along x, a guard texel past each level's end. */
export const clipTexSize = (levels, n) => [levels * (n + 1), n + 1, n + 1];

// The light's uniform (binding 14), written once a frame (src/gfx/worldLight.js):
//   shU[k]  cascade k's axis u across the sun (xyz), its texel in cells (w)
//   shV[k]  its axis v (xyz), the slot its texels are in (w)
//   shS[k]  the sun it was traced toward (xyz, unit), its epoch (w, the tags' third coordinate)
//   shO[k]  its texel lattice origin (xy), 1 if it holds anything (z)
//   centre  the world's centre (xyz) and the depth reference Rw (w): a texel's ray starts Rw
//           cells from the centre toward the sun, and depth d = Rw - dot(p - centre, sun)
//   prO[k]  probe level k's lattice origin (xyz, probes) and spacing (w, cells)
//   glO[k]  glow level k's (texels, cells)
//   size    the world's size in cells (xyz)
export const LightUniforms = uniformStruct('LightUniforms', {
  shU: ['vec4f', SHADOW.CASCADES], shV: ['vec4f', SHADOW.CASCADES], shS: ['vec4f', SHADOW.CASCADES],
  shO: ['vec4i', SHADOW.CASCADES], centre: 'vec4f',
  prO: ['vec4i', PROBE.LEVELS], glO: ['vec4i', GLOW.LEVELS], size: 'vec4f',
});

const READERS = STAGE.FRAGMENT | STAGE.COMPUTE;
const float3d = { visibility: READERS, texture: { sampleType: 'float', viewDimension: '3d' } };
const readBuffer = { visibility: READERS, buffer: { type: 'read-only-storage' } };
/** Group 2 entries the readers bind (docs/seamless-world.md): [binding, name, WGSL type, layout body]. */
export const LIGHT_BINDINGS = Object.freeze([
  [8, 'tGI0', 'texture_3d<f32>', float3d],          // probes, L1 SH band 0 (rgb radiance, a sky visibility)
  [9, 'tGI1', 'texture_3d<f32>', float3d],          // band 1 x
  [10, 'tGI2', 'texture_3d<f32>', float3d],         // band 1 y
  [11, 'tGI3', 'texture_3d<f32>', float3d],         // band 1 z
  [12, 'tGlow', 'texture_3d<f32>', float3d],        // the glow clips
  [14, 'LC', 'LightUniforms', { visibility: STAGE.VERTEX | READERS, buffer: { type: 'uniform' } }],
  [15, 'lcBuf', 'array<vec4u>', readBuffer],       // the shadow cascades' texels (bitcast), SHADOW.SLOTS × RES², then the tags (TAGS)
]);
const declare = ([n, name, type, body]) => (body.buffer?.type === 'uniform'
  ? `@group(2) @binding(${n}) var<uniform> ${name}: ${type};`
  : body.buffer ? `@group(2) @binding(${n}) var<storage, read> ${name}: ${type};`
    : `@group(2) @binding(${n}) var ${name}: ${type};`);
/** WGSL declarations of the readers' bindings, for the writers here (the march's come from its group 2:
 * shaders/world/bindings.js); skip leaves out those a writer binds writable. */
export const lightDeclsWGSL = ({ skip = [] } = {}) => LIGHT_BINDINGS.filter(([n]) => !skip.includes(n)).map(declare).join('\n');

const PCSS_TAPS = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const vogel = (n) => Array.from({ length: n }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / n), a = i * GOLDEN_ANGLE;
  return `vec2f(${(r * Math.cos(a)).toFixed(5)}, ${(r * Math.sin(a)).toFixed(5)})`;
}).join(', ');

// ---- the world copy's march: the hierarchy W provides, then cells ----
// lcMarch walks a ray from t0 to tLim through the world: a 64³, 16³ or 4³ block the occupancy
// says is empty is skipped whole (sparse brick maps' empty-space skipping, as Teardown's and
// GigaVoxels' mip hierarchy), cells of an occupied brick one by one. Shared by every ray here.
export const marchWGSL = /* wgsl */ `
const LC_EPS: f32 = 1e-3;          // cells a step goes past a face, so the next lookup is the next cell
const LC_DIR_MIN: f32 = 1e-6;      // a direction component this small counts as this, keeping 1/rd finite
fn lcSafeDir(d: vec3f) -> vec3f { return select(d, sign(d + vec3f(1e-30)) * LC_DIR_MIN, abs(d) < vec3f(LC_DIR_MIN)); }
fn lcInWorld(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(vec3f(c) < LC.size.xyz); }
// Ray (ro, rd) against the world's box: (tNear, tFar); a miss has tFar <= tNear.
fn lcWorldHit(ro: vec3f, inv: vec3f) -> vec2f {
  let a = (vec3f(0.0) - ro) * inv;
  let b = (LC.size.xyz - ro) * inv;
  let lo = min(a, b);
  let hi = max(a, b);
  return vec2f(max(lo.x, max(lo.y, lo.z)), min(hi.x, min(hi.y, hi.z)));
}
// Where the ray leaves the S-cell block (S a power of two) holding cell c: (t, the axis it leaves by).
fn lcExit(ro: vec3f, inv: vec3f, c: vec3i, S: i32) -> vec2f {
  let lo = vec3f(c & vec3i(~(S - 1)));
  let t0 = (lo - ro) * inv;
  let t1 = (lo + f32(S) - ro) * inv;
  let tf = max(t0, t1);
  if (tf.x <= tf.y && tf.x <= tf.z) { return vec2f(tf.x, 0.0); }
  if (tf.y <= tf.z) { return vec2f(tf.y, 1.0); }
  return vec2f(tf.z, 2.0);
}
// The march's state: the cell it stands in, where it entered it, the face it came through.
struct LcWalk { c: vec3i, t: f32, tOut: f32, ax: i32, w: u32, ok: bool }
// The next cell the ray enters that holds matter (anything but empty air), from t, before tLim:
// its word in w, its span [t, tOut], ax the axis of the face it entered by (-1: it started there).
// fieldAir: empty cells of a brick a smooth-surface or media field reaches into count too (their
// field may be inside: the writers' walk through the fields). ok false: none (out of the world,
// past tLim or out of steps; *steps counts them down).
const LC_FIELD_BITS: u32 = ${BRICK_INFO.SURF | BRICK_INFO.MEDIA}u;
fn lcNext(ro: vec3f, rd: vec3f, inv: vec3f, t0: f32, tLim: f32, fieldAir: bool, steps: ptr<function, i32>) -> LcWalk {
  var t = t0;
  var ax = -1;
  var lastB = vec3i(-2147483647);
  var bOcc = false;
  var bField = false;
  loop {
    if (*steps <= 0 || t > tLim) { break; }
    *steps -= 1;
    let c = vec3i(floor(ro + rd * (t + LC_EPS)));
    if (!lcInWorld(c)) { break; }
    let b = c >> vec3u(2u);
    if (any(b != lastB)) {
      lastB = b;
      if (!wcOccupied(2u, c)) { let e = lcExit(ro, inv, c, 64); t = e.x; ax = i32(e.y); lastB = vec3i(-2147483647); continue; }
      if (!wcOccupied(1u, c)) { let e = lcExit(ro, inv, c, 16); t = e.x; ax = i32(e.y); lastB = vec3i(-2147483647); continue; }
      bOcc = wcOccupied(0u, c);
      bField = fieldAir && bOcc && (wcInfo(b) & LC_FIELD_BITS) != 0u;
    }
    let e1 = lcExit(ro, inv, c, 1);
    if (!bOcc) { let e = lcExit(ro, inv, c, 4); t = e.x; ax = i32(e.y); continue; }
    let w = wcCell(c);
    if (wcId(w) != E_EMPTY || bField) { return LcWalk(c, t, min(e1.x, tLim), ax, w, true); }
    t = e1.x;
    ax = i32(e1.y);
  }
  return LcWalk(vec3i(0), t, t, ax, 0u, false);
}
// The face normal of a walk's entry: against the ray along the axis it came in by.
fn lcEntryNormal(rd: vec3f, ax: i32) -> vec3f {
  var n = vec3f(0.0);
  if (ax >= 0) { n[ax] = -sign(rd[ax]); }
  return n;
}
`;

// ---- shadow cascades: the frame every writer and reader shares ----
const shadowFrameWGSL = /* wgsl */ `
const SH_CASCADES: u32 = ${SHADOW.CASCADES}u;
const SH_RES: i32 = ${SHADOW.RES};
const SH_TILE: i32 = ${SHADOW.TILE};
const SH_TILES: i32 = ${shadowTilesSide};   // tiles a side
const SH_MARGIN: i32 = ${SHADOW.MARGIN};
const TAG_SHADOW: u32 = ${TAGS.SHADOW}u;
const TAG_PROBE: u32 = ${TAGS.PROBE}u;
const TAG_GLOW: u32 = ${TAGS.GLOW}u;
const TAG_VALID: u32 = 0x80000000u;
const LC_TAGS_AT: u32 = ${SHADOW_TEXELS}u;   // lcBuf's first tag vec4u
fn lcTag(c: vec3i) -> u32 {
  let m = vec3u(c) & vec3u(${TAG_MASK}u);
  return TAG_VALID | m.x | (m.y << 10u) | (m.z << 20u);
}
fn lcWrap(a: vec3i, n: i32) -> vec3i { return ((a % n) + n) % n; }
fn lcWrap2(a: vec2i, n: i32) -> vec2i { return ((a % n) + n) % n; }
// Point p's place in cascade k: lattice coordinates (texels, continuous: texel i spans [i, i + 1)) and depth.
fn shPlace(k: u32, p: vec3f, d: ptr<function, f32>) -> vec2f {
  let q = p - LC.centre.xyz;
  *d = LC.centre.w - dot(q, LC.shS[k].xyz);
  return vec2f(dot(q, LC.shU[k].xyz), dot(q, LC.shV[k].xyz)) / LC.shU[k].w;
}
// Texel ij (lattice) of cascade k's slot: its vec4u in lcBuf.
fn shIndex(k: u32, ij: vec2i) -> u32 {
  let w = lcWrap2(ij, SH_RES);
  return u32(LC.shV[k].w) * u32(SH_RES * SH_RES) + u32(w.x + SH_RES * w.y);
}
fn shTagIndex(slot: u32, tile: vec2i) -> u32 {
  let w = lcWrap2(tile, SH_TILES);
  return TAG_SHADOW + slot * u32(SH_TILES * SH_TILES) + u32(w.x + SH_TILES * w.y);
}
// A texel's ray, for its writer: from Rw toward the sun of the centre, through texel ij's centre.
fn shRayOrigin(k: u32, ij: vec2i) -> vec3f {
  let a = (vec2f(ij) + 0.5) * LC.shU[k].w;
  return LC.centre.xyz + LC.shS[k].xyz * LC.centre.w + LC.shU[k].xyz * a.x + LC.shV[k].xyz * a.y;
}`;

/**
 * The readers (docs/seamless-world.md, the names the march calls today, now in world cells).
 * opts: shadow / probes / glow: leave out the readers of what a writer pipeline writes (a writer
 * binds that resource writable); fields: smooth surfaces and media from F (false: read as cells,
 * the CPU twin's model); caustics: the ripples' focusing in the sun lookups (the probe writer
 * leaves them out, as the old GI did).
 */
export function worldLightWGSL({ shadow = true, probes = true, glow = true, fields = true, caustics = true, writerFrame = false,
  sky = true, repeatSampler = 'wrapLinear' } = {}) {
  const frame = writerFrame ? '0.0' : 'f32(FU.frame)';
  const time = writerFrame ? '0.0' : 'FU.time';
  const causticsOn = caustics && !writerFrame ? 'FU.caustics != 0u' : 'false';
  return /* wgsl */ `
${LightUniforms.wgsl}
const PI_L: f32 = 3.14159265;
${sky ? /* wgsl */ `${skyGLSL()}
// the clouds' deck samples the media noise (16) with the repeating sampler: F's wrapLinear in the
// march (shaders/world/march.js renames linearRepeat so too), the writers' own
${cloudDeckGLSL.replace(/\blinearRepeat\b/g, repeatSampler)}
${skyViewGLSL({ source: false }).replace(/\blinearRepeat\b/g, repeatSampler)}
fn hgPhase2(mu: f32, gBack: f32, gFwd: f32, wFwd: f32) -> f32 { return mix(hgPhase(mu, gBack), hgPhase(mu, gFwd), wFwd); }` : '// (no sky: a writer that never looks at it)'}
fn skyAmbient(n: vec3f) -> vec3f {
  let up = 0.5 + 0.5 * n.y;
  return up * FU.skyUp + (1.0 - up) * FU.ground;
}
${marchWGSL}
${shadowFrameWGSL}
${shadow || probes || glow ? '// tag word w (TAGS), four to a vec4u past the texels\nfn lcTagAt(w: u32) -> u32 { return lcBuf[LC_TAGS_AT + (w >> 2u)][w & 3u]; }' : ''}
// Smooth fields where F holds them (fields), else the cell's own class.
const LC_SURF_ISO: f32 = 0.5;      // shaders/gfx/core.js SURF_ISO: inside > it > outside
fn lcIsCrisp(id: i32) -> bool { return id != E_EMPTY && SURFCH(id) < 0 && MEDIACH(id) < 0; }
fn lcSmoothOpaqueAt(p: vec3f, id: i32) -> bool {${fields ? `
  let s = surfField(p);
  return max(s.y, max(s.z, s.w)) >= LC_SURF_ISO;` : `
  return RCLASS(id) == R_OPAQUE;`}
}
// What the world holds at p for the light (no field): its element (-1 the floor below the world).
fn lcIdAt(c: vec3i) -> i32 {
  if (c.y < 0) { return -1; }
  if (!lcInWorld(c)) { return E_EMPTY; }
  return wcId(wcCell(c));
}

// ---- caustics: sunlight focused by the ripples on open liquid (gfx/lighting.js, unchanged) ----
const SHADOW_TINT_ID_SCALE: f32 = ${glf(SHADOW_TINT_ID_SCALE)};
const RIPPLE_FREQ: f32 = 0.3;
const RIPPLE_DRIFT: f32 = 0.6;
const RIPPLE_OCT2: f32 = 2.1;
const RIPPLE_OCT2_AMP: f32 = 0.5;
const RIPPLE_OCT2_DRIFT: f32 = 1.3;
const RIPPLE_OCT2_SHIFT: f32 = 7.3;
fn rippleH(q: vec2f, t: f32) -> f32 {
  return vnoise(vec3f(q, t)) + RIPPLE_OCT2_AMP * vnoise(vec3f(q * RIPPLE_OCT2 + RIPPLE_OCT2_SHIFT, t * RIPPLE_OCT2_DRIFT));
}
const CAUSTIC_BEND: f32 = 0.25;
const CAUSTIC_SLOPE: f32 = 0.18;
const CAUSTIC_EPS: f32 = 0.35;
const CAUSTIC_BED_GAP: f32 = 2.0;
const CAUSTIC_FILL: f32 = 0.7;
const CAUSTIC_MAX: f32 = 4.0;
const CAUSTIC_MIN: f32 = 0.3;
const SUN_TAN_RADIUS: f32 = ${SUN_TAN_RADIUS};
${meanSigmaWGSL}
fn underPool(sm: vec4f, d: f32, tid: i32) -> bool {
  if (RCLASS(tid) != R_LIQUID || d <= sm.y || d >= sm.z + CAUSTIC_BED_GAP) { return false; }
  let lenL = (sm.w - f32(tid) * SHADOW_TINT_ID_SCALE) / max(meanSigma(tid), 1e-4);
  return lenL >= CAUSTIC_FILL * (min(d, sm.z) - sm.y);
}
const CAUSTIC_TAPS: u32 = 5u;
fn causticTaps() -> u32 { return min(CAUSTIC_TAPS, CAUSTIC_TAPS * FU.caustics); }
fn causticGain(p: vec3f, D: f32) -> f32 {
  let s = p + FU.sun * D;
  let q = s.xz * RIPPLE_FREQ;   // world cells: the ripples are anchored in the world
  let t = ${time} * RIPPLE_DRIFT;
  var h0 = 0.0;
  var around = 0.0;
  for (var k = 0u; k < causticTaps(); k++) {
    var qk = q;
    if (k == 1u) { qk = q + vec2f(CAUSTIC_EPS, 0.0); }
    else if (k == 2u) { qk = q - vec2f(CAUSTIC_EPS, 0.0); }
    else if (k == 3u) { qk = q + vec2f(0.0, CAUSTIC_EPS); }
    else if (k == 4u) { qk = q - vec2f(0.0, CAUSTIC_EPS); }
    let h = rippleH(qk, t);
    if (k == 0u) { h0 = h; } else if (k == 1u) { around = h; } else { around += h; }
  }
  let lapQ = (around - 4.0 * h0) / (CAUSTIC_EPS * CAUSTIC_EPS);
  let lap = CAUSTIC_SLOPE * RIPPLE_FREQ * lapQ;
  let I = clamp(1.0 / max(1.0 + D * CAUSTIC_BEND * lap, 1e-3), CAUSTIC_MIN, CAUSTIC_MAX);
  let blur = D * SUN_TAN_RADIUS * RIPPLE_FREQ * 2.0 * PI_L;
  return mix(1.0, I, exp(-0.5 * blur * blur));
}

// 1 if the ray from ro toward the sun gets tLim cells without entering opaque matter (the march).
const SUN_RAY_SMOOTH_SKIP: f32 = 0.5;
const SUN_RAY_STEPS: i32 = ${SHADOW.MAX_STEPS};
fn smoothOpaque(p: vec3f) -> f32 {${fields ? `
  let s = surfField(p);
  return max(s.y, max(s.z, s.w));` : `
  return select(0.0, 1.0, RCLASS(lcIdAt(vec3i(floor(p)))) == R_OPAQUE);`}
}
fn sunRayClear(ro: vec3f, tLim: f32) -> f32 {
  var hc: vec3i;
  var hn: vec3f;
  return select(1.0, 0.0, traceNearSteps(ro, FU.sun, tLim, true, SUN_RAY_SMOOTH_SKIP, SUN_RAY_STEPS, &hc, &hn) >= 0.0);
}
fn wk0(o: vec2i, w: vec2f) -> f32 {
  return select(1.0 - w.x, w.x, o.x == 1) * select(1.0 - w.y, w.y, o.y == 1);
}
${shadow ? shadowReadersWGSL({ frame, causticsOn }) : '// (no shadow readers: this pipeline writes the cascades)'}

// ---- bounce light: the probe cascades ----
const SH_Y0: f32 = ${SH_Y0.toFixed(6)};
const SH_Y1: f32 = ${SH_Y1.toFixed(6)};
const SH_COS1: f32 = 2.0 / 3.0;
const GI_OFFSET: f32 = ${GI_OFFSET_CELLS.toFixed(1)};
const SKYVIS_MIN: f32 = 0.05;
const SKYVIS_OPEN_DC: f32 = ${SKYVIS_OPEN_DC.toFixed(6)};
const PR_LEVELS: u32 = ${PROBE.LEVELS}u;
const PR_N: i32 = ${PROBE.N};
const PR_CHUNK: i32 = ${PROBE.CHUNK};
const PR_CHUNKS: i32 = ${probeChunksSide};
const PR_EDGE: f32 = ${glf(PROBE.EDGE_BLEND)};
const PR_TEX: vec3f = vec3f(${clipTexSize(PROBE.LEVELS, PROBE.N).map(glf).join(', ')});
struct Probe { c0: vec4f, cx: vec4f, cy: vec4f, cz: vec4f }
// The open environment as a probe (no occlusion): giIrradiance gives skyAmbient, giSkyVis 1.
fn lcOpenProbe() -> Probe {
  let k1 = 0.5 / (SH_COS1 * SH_Y1);
  return Probe(vec4f(0.5 * (FU.skyUp + FU.ground) / SH_Y0, SKYVIS_OPEN_DC / SH_Y0), vec4f(0.0),
               vec4f(0.5 * (FU.skyUp - FU.ground) * k1, k1), vec4f(0.0));
}
${probes ? probeReadersWGSL() : '// (no probe readers: this pipeline writes the bands)'}
fn giIrradiance(g: Probe, n: vec3f) -> vec3f {
  return max(SH_Y0 * g.c0.rgb + SH_COS1 * SH_Y1 * (g.cx.rgb * n.x + g.cy.rgb * n.y + g.cz.rgb * n.z), vec3f(0.0)) + ${writerFrame ? 'vec3f(0.0)' : 'FU.caveAmbient'};
}
fn giRadiance(g: Probe, d: vec3f, blur: f32) -> vec3f {
  let k1 = SH_Y1 * mix(1.0, SH_COS1, blur);
  return max(SH_Y0 * g.c0.rgb + k1 * (g.cx.rgb * d.x + g.cy.rgb * d.y + g.cz.rgb * d.z), vec3f(0.0)) + ${writerFrame ? 'vec3f(0.0)' : 'FU.caveAmbient'};
}
fn giSkyVis(g: Probe, n: vec3f) -> f32 {
  let v = SH_Y0 * g.c0.a + SH_COS1 * SH_Y1 * (g.cx.a * n.x + g.cy.a * n.y + g.cz.a * n.z);
  return clamp(v / max(0.5 + 0.5 * n.y, SKYVIS_MIN), 0.0, 1.0);
}

// ---- glow and the wand lights ----
const GL_LEVELS: u32 = ${GLOW.LEVELS}u;
const GL_N: i32 = ${GLOW.N};
const GL_CHUNK: i32 = ${GLOW.CHUNK};
const GL_CHUNKS: i32 = ${glowChunksSide};
const GL_TEX: vec3f = vec3f(${clipTexSize(GLOW.LEVELS, GLOW.N).map(glf).join(', ')});
fn wandLight(p: vec3f) -> vec3f {
  if (FU.wandLightCount == 0) { return vec3f(0.0); }
  var light = vec3f(0.0);
  for (var i = 0; i < ${WAND_LIGHTS}; i++) {
    if (i >= FU.wandLightCount) { break; }
    let pr = FU.wandLightPosition[i];
    let ci = FU.wandLightColor[i];
    let d = p - pr.xyz;
    let falloff = max(1.0 - dot(d, d) / (pr.w * pr.w), 0.0);
    light += ci.rgb * ci.w * falloff * falloff;
  }
  return light;
}
${glow ? glowReadersWGSL() : '// (no glow readers: this pipeline writes the glow)'}

${nearWGSL({ frame, shadow, probes, glow })}
`;
}

// The cascades' readers: sunMapShadow / sunMapShadowAt / sunShadow / sunShadowAt, as before.
const shadowReadersWGSL = ({ frame, causticsOn }) => /* wgsl */ `
const SHADOW_NORMAL_OFFSET: f32 = 0.002;
const SHADOW_BIAS_MIN: f32 = 0.8;
const SHADOW_BIAS_NS_MIN: f32 = 0.25;
const SHADOW_BIAS_PAD: f32 = 0.1;
const VOLUME_SHADOW_BIAS: f32 = ${glf(VOLUME_SHADOW_BIAS)};
const PCSS_TAPS: i32 = ${PCSS_TAPS};
const PCSS_HARD_TEXELS: f32 = 1.0;
const PCSS_NS_MIN: f32 = 0.2;
const PCSS_BIAS: f32 = 0.35;
// The blocker search reaches at most this many cells: the depth reference is the world's top now,
// far above most receivers, so SUN_TAN_RADIUS * d alone would search tens of cells for nothing.
const PCSS_SEARCH_MAX: f32 = 6.0;
var<private> VOGEL: array<vec2f, ${PCSS_TAPS}> = array<vec2f, ${PCSS_TAPS}>(${vogel(PCSS_TAPS)});
// The finest cascade that holds p with its 2×2 taps and PCSS's reach (the last holds the world:
// no margin), its tiles traced: SH_CASCADES if none.
fn shCascadeFor(p: vec3f) -> u32 {
  for (var k = 0u; k < SH_CASCADES; k++) {
    if (LC.shO[k].z == 0) { continue; }
    var d: f32;
    let f = shPlace(k, p, &d) - 0.5;
    let i0 = vec2i(floor(f));
    let o = LC.shO[k].xy;
    let m = select(SH_MARGIN, 0, k + 1u == SH_CASCADES);
    if (any(i0 < o + m) || any(i0 + 1 > o + SH_RES - 1 - m)) { continue; }
    let slot = u32(LC.shV[k].w);
    let t0 = i0 >> vec2u(${Math.log2(SHADOW.TILE)}u);
    let t1 = (i0 + 1) >> vec2u(${Math.log2(SHADOW.TILE)}u);
    let ep = i32(LC.shS[k].w);
    if (lcTagAt(shTagIndex(slot, t0)) != lcTag(vec3i(t0, ep)) || lcTagAt(shTagIndex(slot, t1)) != lcTag(vec3i(t1, ep))) { continue; }
    return k;
  }
  return SH_CASCADES;
}
fn shTexel(k: u32, ij: vec2i) -> vec4f {
  let o = LC.shO[k].xy;
  return bitcast<vec4f>(lcBuf[shIndex(k, clamp(ij, o, o + SH_RES - 1))]);
}
fn shadowTexelAtt(sm: vec4f, d: f32) -> vec3f {
  var att = vec3f(1.0);
  let tid = i32(sm.w / SHADOW_TINT_ID_SCALE);
  if (tid > 0 && d > sm.y) {
    let tau = sm.w - f32(tid) * SHADOW_TINT_ID_SCALE;
    let frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
    let tint = SIGMA(tid) / max(meanSigma(tid), 1e-4);
    att = exp(-tint * tau * frac);
  }
  return att;
}
fn sunMapShadow(hp: vec3f, n: vec3f) -> vec3f {
  let p = hp + n * SHADOW_NORMAL_OFFSET;
  let k = shCascadeFor(p);
  if (k >= SH_CASCADES) { return vec3f(1.0); }   // nothing traced here yet: lit (a frame or two after a jump)
  let u = LC.shU[k].xyz;
  let v = LC.shV[k].xyz;
  let sun = LC.shS[k].xyz;
  let T = LC.shU[k].w;
  var d: f32;
  let f = shPlace(k, p, &d) - 0.5;
  let i0 = vec2i(floor(f));
  let w = f - vec2f(i0);
  let bias = max(SHADOW_BIAS_MIN, T * (abs(dot(n, u)) + abs(dot(n, v))) / max(dot(n, sun), SHADOW_BIAS_NS_MIN) + SHADOW_BIAS_PAD);
  var acc = vec3f(0.0);
  var tr = vec3f(0.0);
  var nLit = 0.0;
  var cD = 0.0;
  var cW = 0.0;
  for (var j = 0; j < 4; j++) {
    let o = vec2i(j & 1, j >> 1u);
    let sm = shTexel(k, i0 + o);
    let lit = select(0.0, 1.0, d < sm.x + bias);
    let att = shadowTexelAtt(sm, d);
    let tid = i32(sm.w / SHADOW_TINT_ID_SCALE);
    let wk = wk0(o, w);
    if (tid > 0 && underPool(sm, d, tid)) { cD += (d - sm.y) * wk; cW += wk; }
    acc += lit * att * wk;
    tr += att * wk;
    nLit += lit;
  }
  if (${causticsOn} && cW > 0.0) {
    let cg = mix(1.0, causticGain(p, cD / cW), cW);
    acc *= cg;
    tr *= cg;
  }
  if (nLit == 4.0) { return acc; }
  let ns = max(dot(n, sun), PCSS_NS_MIN);
  let slope = vec2f(dot(n, u), dot(n, v)) / ns;
  let ft = f + 0.5;
  let rot = 2.0 * PI_L * ign(gFragCoord, ${frame});
  let R2 = mat2x2f(cos(rot), sin(rot), -sin(rot), cos(rot));
  let rs = min(SUN_TAN_RADIUS * d, PCSS_SEARCH_MAX);
  var bSum = 0.0;
  var bN = 0.0;
  for (var i = 0; i < PCSS_TAPS; i++) {
    let o = R2 * VOGEL[i] * rs;
    let sm = shTexel(k, vec2i(floor(ft + o / T))).x;
    if (sm + PCSS_BIAS < d + dot(o, slope)) { bSum += sm; bN += 1.0; }
  }
  var pen = 0.0;
  if (bN > 0.0) { pen = min(SUN_TAN_RADIUS * (d - bSum / bN), PCSS_SEARCH_MAX); }
  if (pen < PCSS_HARD_TEXELS * T) { return acc; }
  var lit = 0.0;
  for (var i = 0; i < PCSS_TAPS; i++) {
    let o = R2 * VOGEL[i] * pen;
    let sm = shTexel(k, vec2i(floor(ft + o / T))).x;
    if (sm + PCSS_BIAS >= d + dot(o, slope)) { lit += 1.0; }
  }
  return tr * min(2.0 * lit / f32(PCSS_TAPS), 1.0);
}
fn sunMapShadowAt(p: vec3f) -> vec3f {
  let k = shCascadeFor(p);
  if (k >= SH_CASCADES) { return vec3f(1.0); }
  var d: f32;
  let f = shPlace(k, p, &d) - 0.5;
  let i0 = vec2i(floor(f));
  let w = f - vec2f(i0);
  var acc = vec3f(0.0);
  var cD = 0.0;
  var cW = 0.0;
  for (var j = 0; j < 4; j++) {
    let o = vec2i(j & 1, j >> 1u);
    let sm = shTexel(k, i0 + o);
    let lit = select(vec3f(0.0), vec3f(1.0), d < sm.x + VOLUME_SHADOW_BIAS) * shadowTexelAtt(sm, d);
    let tid = i32(sm.w / SHADOW_TINT_ID_SCALE);
    let wk = wk0(o, w);
    if (tid > 0 && underPool(sm, d, tid)) { cD += (d - sm.y) * wk; cW += wk; }
    acc += lit * wk;
  }
  if (${causticsOn} && cW > 0.0) { acc *= mix(1.0, causticGain(p, cD / cW), cW); }
  return acc;
}
// The clouds' shadow (world cells: H.origin is 0, so worldPos(p) is p), then the cascades.
fn sunShadow(hp: vec3f, n: vec3f) -> vec3f {
  let c = cloudShadow(hp);
  if (c > CLOUD_SHADOW_SKIP) { return c * sunMapShadow(hp, n); }
  return vec3f(0.0);
}
fn sunShadowAt(p: vec3f) -> vec3f {
  let c = cloudShadow(p);
  if (c > CLOUD_SHADOW_SKIP) { return c * sunMapShadowAt(p); }
  return vec3f(0.0);
}`;

// Probe and glow lookups share the clip layout: level k's texel w (wrapped) at texture x k·(N+1) + w.
const clipSampleWGSL = (name, tex, N, size) => /* wgsl */ `
fn ${name}(t: texture_3d<f32>, level: u32, q: vec3f) -> vec4f {
  let lo = floor(q);
  let w = vec3f(lcWrap(vec3i(lo), ${N})) + (q - lo) + 0.5;
  let x = vec3f(f32(level) * f32(${N} + 1), 0.0, 0.0) + w;
  return textureSampleLevel(t, linearClamp, x / ${size}, 0.0);
}`;
const probeReadersWGSL = () => /* wgsl */ `
fn prChunkTag(level: u32, chunk: vec3i) -> u32 {
  let w = lcWrap(chunk, PR_CHUNKS);
  return lcTagAt(TAG_PROBE + level * u32(PR_CHUNKS * PR_CHUNKS * PR_CHUNKS) + u32(w.x + PR_CHUNKS * (w.y + PR_CHUNKS * w.z)));
}
${clipSampleWGSL('prTex', 'tGI0', 'PR_N', 'PR_TEX')}
// How far inside level k's traced probes p is (probes; <= 0: not usable), q its lattice point.
fn prInside(k: u32, p: vec3f, q: ptr<function, vec3f>) -> f32 {
  let S = f32(LC.prO[k].w);
  *q = p / S - 0.5;
  let o = vec3f(LC.prO[k].xyz);
  let lo = floor(*q);
  let ci0 = vec3i(lo) >> vec3u(${Math.log2(PROBE.CHUNK)}u);
  let ci1 = (vec3i(lo) + 1) >> vec3u(${Math.log2(PROBE.CHUNK)}u);
  if (prChunkTag(k, ci0) != lcTag(ci0) || prChunkTag(k, ci1) != lcTag(ci1)) { return 0.0; }
  let e = min(*q - o, o + f32(PR_N - 1) - *q);
  return min(e.x, min(e.y, e.z));
}
fn prAt(k: u32, q: vec3f) -> Probe {
  return Probe(prTex(tGI0, k, q), prTex(tGI1, k, q), prTex(tGI2, k, q), prTex(tGI3, k, q));
}
fn prMix(a: Probe, b: Probe, t: f32) -> Probe {
  return Probe(mix(a.c0, b.c0, t), mix(a.cx, b.cx, t), mix(a.cy, b.cy, t), mix(a.cz, b.cz, t));
}
// The probe at world point p: the finest level holding it, handed over to the next across its
// last PR_EDGE probes (DDGI's cascades blend so), the open environment past the coarsest.
fn probeAt(p: vec3f) -> Probe {
  for (var k = 0u; k < PR_LEVELS; k++) {
    var q: vec3f;
    let e = prInside(k, p, &q);
    if (e <= 0.0) { continue; }
    let g = prAt(k, q);
    if (e >= PR_EDGE) { return g; }
    var next = lcOpenProbe();
    for (var j = k + 1u; j < PR_LEVELS; j++) {
      var q2: vec3f;
      if (prInside(j, p, &q2) > 0.0) { next = prAt(j, q2); break; }
    }
    return prMix(next, g, e / PR_EDGE);
  }
  return lcOpenProbe();
}
fn surfProbe(p: vec3f, n: vec3f) -> Probe { return probeAt(p + n * GI_OFFSET); }
fn giAirSkyVis(p: vec3f) -> f32 { return clamp(SH_Y0 * probeAt(p).c0.a / SKYVIS_OPEN_DC, 0.0, 1.0); }
// Every probe of a resident world is "held": the weight is 1 (shaders/farShared.js hazeAirLit).
fn giAirSkyHeld(p: vec3f) -> vec2f { return vec2f(giAirSkyVis(p), 1.0); }`;

const glowReadersWGSL = () => /* wgsl */ `
fn glChunkTag(level: u32, chunk: vec3i) -> u32 {
  let w = lcWrap(chunk, GL_CHUNKS);
  return lcTagAt(TAG_GLOW + level * u32(GL_CHUNKS * GL_CHUNKS * GL_CHUNKS) + u32(w.x + GL_CHUNKS * (w.y + GL_CHUNKS * w.z)));
}
${clipSampleWGSL('glTex', 'tGlow', 'GL_N', 'GL_TEX')}
// The glow at world point p: the finest level whose chunks hold it, else none.
fn glowAt(p: vec3f) -> vec3f {
  for (var k = 0u; k < GL_LEVELS; k++) {
    let q = p / f32(LC.glO[k].w) - 0.5;
    let o = vec3f(LC.glO[k].xyz);
    if (any(q < o) || any(q > o + f32(GL_N - 1))) { continue; }
    let lo = vec3i(floor(q));
    let c0 = lo >> vec3u(${Math.log2(GLOW.CHUNK)}u);
    let c1 = (lo + 1) >> vec3u(${Math.log2(GLOW.CHUNK)}u);
    if (glChunkTag(k, c0) != lcTag(c0) || glChunkTag(k, c1) != lcTag(c1)) { continue; }
    return glTex(tGlow, k, q).rgb;
  }
  return vec3f(0.0);
}
fn sampleLight(gp: vec3f) -> vec3f { return glowAt(gp) + wandLight(gp); }
fn glowLum(gp: vec3f) -> f32 { return dot(glowAt(gp), LUMA_709); }`;

// AO, the near field, traced rays, the glow's direction, GGX, the hand lamps and the beacon:
// gfx/lighting.js's, reading the world copy where they read the window's state.
const nearWGSL = ({ frame, shadow, probes, glow }) => /* wgsl */ `
// ---- ambient occlusion ----
fn occluder(c: vec3i) -> bool {
  if (c.y < 0) { return true; }
  if (!lcInWorld(c)) { return false; }
  return !isGasLike(wcId(wcCell(c)));
}
const FACE_AO_MIN: f32 = 0.25;
fn faceAO(cell: vec3i, n: vec3i, hp: vec3f) -> f32 {
  let u = select(vec3i(1, 0, 0), vec3i(0, 1, 0), n.x != 0);
  let w = select(vec3i(0, 0, 1), vec3i(0, 1, 0), n.z != 0);
  let b = cell + n;
  let s1 = f32(occluder(b + u));
  let s2 = f32(occluder(b - u));
  let s3 = f32(occluder(b + w));
  let s4 = f32(occluder(b - w));
  let c1 = f32(occluder(b + u + w));
  let c2 = f32(occluder(b + u - w));
  let c3 = f32(occluder(b - u + w));
  let c4 = f32(occluder(b - u - w));
  let aPP = select(3.0 - (s1 + s3 + c1), 0.0, s1 * s3 > 0.0);
  let aPM = select(3.0 - (s1 + s4 + c2), 0.0, s1 * s4 > 0.0);
  let aMP = select(3.0 - (s2 + s3 + c3), 0.0, s2 * s3 > 0.0);
  let aMM = select(3.0 - (s2 + s4 + c4), 0.0, s2 * s4 > 0.0);
  let fu = fract(dot(hp, vec3f(u)));
  let fw = fract(dot(hp, vec3f(w)));
  let ao = mix(mix(aMM, aPM, fu), mix(aMP, aPP, fu), fw) / 3.0;
  return FACE_AO_MIN + (1.0 - FACE_AO_MIN) * ao;
}
const AO_LIQUID_SOLIDITY: f32 = 0.6;
fn solidity(p: vec3f) -> f32 {
  if (p.y < 0.0) { return 1.0; }
  let s = surfField(p);
  var o = max(max(s.y, s.z), max(s.w, s.x * AO_LIQUID_SOLIDITY));
  if (lcIsCrisp(lcIdAt(vec3i(floor(p))))) { o = 1.0; }
  return clamp(o, 0.0, 1.0);
}
const FIELD_AO_D1: f32 = 1.5;
const FIELD_AO_D2: f32 = 3.0;
const FIELD_AO_D3: f32 = 5.0;
const FIELD_AO_W1: f32 = 0.45;
const FIELD_AO_W2: f32 = 0.3;
const FIELD_AO_W3: f32 = 0.2;
const FIELD_AO_MIN: f32 = 0.2;
fn fieldAO(p: vec3f, n: vec3f) -> f32 {
  let occ = FIELD_AO_W1 * solidity(p + n * FIELD_AO_D1) + FIELD_AO_W2 * solidity(p + n * FIELD_AO_D2)
          + FIELD_AO_W3 * solidity(p + n * FIELD_AO_D3);
  return clamp(1.0 - occ, FIELD_AO_MIN, 1.0);
}

// ---- traced rays over the world copy (the lamps', the beacon's, sunRayClear) ----
const NEAR_MAX_STEPS: i32 = 48;
fn nearSmoothIn(p: vec3f, opaqueOnly: bool) -> bool {
  let s = surfField(p);
  return max(max(s.y, s.z), max(s.w, select(s.x, 0.0, opaqueOnly))) >= LC_SURF_ISO;
}
// First matter the ray from ro along rd0 enters within tLim cells (opaqueOnly: only matter that
// blocks light outright), smooth surfaces as drawn and only from selfSkip out, the floor too: its
// distance (or -1), the cell in *hc and the entry face's normal in *hn. maxSteps counts the
// hierarchy's steps (a skipped block is one).
fn traceNearSteps(ro: vec3f, rd0: vec3f, tLim: f32, opaqueOnly: bool, selfSkip: f32, maxSteps: i32,
                  hc: ptr<function, vec3i>, hn: ptr<function, vec3f>) -> f32 {
  let rd = lcSafeDir(normalize(rd0));
  let inv = 1.0 / rd;
  *hc = vec3i(floor(ro));
  *hn = vec3f(0.0);
  let wh = lcWorldHit(ro, inv);
  var t = max(wh.x, 0.0);
  let tEnd = min(tLim, wh.y);
  var steps = maxSteps;
  loop {
    if (t > tEnd) { break; }
    let hit = lcNext(ro, rd, inv, t, tEnd, false, &steps);
    if (!hit.ok) { break; }
    let id = wcId(hit.w);
    if (!isGasLike(id) && (!opaqueOnly || RCLASS(id) == R_OPAQUE)) {
      if (lcIsCrisp(id)) { *hc = hit.c; *hn = lcEntryNormal(rd, hit.ax); return hit.t; }
      let tm = clamp(dot(vec3f(hit.c) + 0.5 - ro, rd), hit.t, hit.tOut);
      if (hit.t > selfSkip && nearSmoothIn(ro + rd * tm, opaqueOnly)) { *hc = hit.c; *hn = lcEntryNormal(rd, hit.ax); return hit.t; }
    }
    t = hit.tOut;
  }
  // the floor below the world
  if (rd.y < 0.0) {
    let tf = -ro.y / rd.y;
    if (tf >= 0.0 && tf <= tLim && steps > 0) { *hc = vec3i(floor(ro + rd * tf)) - vec3i(0, 1, 0); *hn = vec3f(0.0, 1.0, 0.0); return tf; }
  }
  return -1.0;
}
fn traceNear(ro: vec3f, rd: vec3f, tLim: f32, opaqueOnly: bool, selfSkip: f32,
             hc: ptr<function, vec3i>, hn: ptr<function, vec3f>) -> f32 {
  return traceNearSteps(ro, rd, tLim, opaqueOnly, selfSkip, NEAR_MAX_STEPS, hc, hn);
}
const LAMP_STREAM: i32 = 0;
const NEAR_RAND_STREAMS: i32 = LAMP_STREAM + LAMP_MAX;
fn pixRand3(k: i32) -> vec3f { return hash33(vec3f(gFragCoord, ${frame} * f32(NEAR_RAND_STREAMS) + f32(k))); }
fn pixRand(k: i32) -> vec2f { return pixRand3(k).xy; }
fn lampRand(i: i32) -> vec3f {
  return vec3f(stbn2(gFragCoord, ${frame}, f32(LAMP_STREAM + i)), fract(ignR(gFragCoord) + R1_G * stbnT(${frame}, f32(i))));
}

// ---- hand lamps and wall torches ----
const LAMP_UNIT: f32 = ${LAMP_UNIT.toFixed(1)};
fn lampFall(d2: f32, R: f32, r: f32) -> f32 {
  let x2 = d2 / (R * R);
  let fade = max(1.0 - x2 * x2, 0.0);
  return (LAMP_UNIT * LAMP_UNIT + r * r) / (d2 + r * r) * fade * fade;
}
fn lampNearest(i: i32, p: vec3f) -> vec3f {
  let c = FU.lampPos[i].xyz;
  let h = 0.5 * FU.lampShape[i].y;
  return vec3f(c.x, clamp(p.y, c.y - h, c.y + h), c.z);
}
// A wall torch is lit while its cell in the world copy is still a torch.
fn lampLive(i: i32) -> bool {
  if (FU.lampCol[i].w < 0.5) { return true; }
  return lcIdAt(vec3i(floor(FU.lampPos[i].xyz))) == E_WALL_TORCH;
}
fn lampSeen(p: vec3f, n: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0; i < LAMP_MAX; i++) {
    if (i >= FU.lampCount) { break; }
    let dv = lampNearest(i, p) - p;
    let d2 = dot(dv, dv);
    let R = FU.lampPos[i].w;
    if (d2 >= R * R || !lampLive(i)) { continue; }
    sum += FU.lampCol[i].rgb * max(dot(n, dv) * inverseSqrt(max(d2, 1e-8)), 0.0) * lampFall(d2, R, FU.lampShape[i].x);
  }
  return sum;
}

// ---- the near field (gfx/lighting.js nearField, over the world copy) ----
const NEAR_TAPS: i32 = 6;
const NEAR_START: f32 = 0.55;
const NEAR_VIS_MIN: f32 = 0.15;
const NEAR_ISO: vec2f = vec2f(0.35, 0.65);
const NEAR_LIQUID: f32 = 0.6;
const NEAR_REP_D: f32 = 1.0;
const NEAR_FRAME_A: vec3f = vec3f(0.4319, 0.2903, 0.8540);
var<private> NEAR_KERNEL: array<vec4f, NEAR_TAPS> = array<vec4f, NEAR_TAPS>(
  vec4f(0.0, 0.0, 1.0, 2.2),
  vec4f(0.7196, 0.2627, 0.6428, 1.5),
  vec4f(-0.0274, 0.7656, 0.6428, 2.5),
  vec4f(-0.7366, 0.2105, 0.6428, 1.8),
  vec4f(-0.4278, -0.6355, 0.6428, 2.6),
  vec4f(0.4722, -0.6032, 0.6428, 2.0),
);
fn nearSolid(q: vec3f, hid: ptr<function, i32>, ha: ptr<function, vec4f>) -> f32 {
  *hid = E_EMPTY;
  *ha = vec4f(0.0);
  if (q.y < 0.0) { *hid = -1; return 1.0; }
  let c = vec3i(floor(q));
  if (!lcInWorld(c)) { return 0.0; }
  let sf = surfField(q);
  var o = max(smoothstep(NEAR_ISO.x, NEAR_ISO.y, max(sf.y, max(sf.z, sf.w))), NEAR_LIQUID * smoothstep(NEAR_ISO.x, NEAR_ISO.y, sf.x));
  let a = wcA(c);
  let id = eid(a);
  if (!isGasLike(id)) {
    *hid = id;
    *ha = a;
    if (lcIsCrisp(id)) { o = 1.0; }
  }
  return o;
}
${shadow && probes && glow ? /* wgsl */ `
fn hitLight(p: vec3f, n: vec3f, alb: vec3f, emit: vec3f) -> vec3f {
  let ndl = max(dot(n, FU.sun), 0.0);
  var sun = vec3f(0.0);
  if (ndl > 0.0) {
    var shade = vec3f(1.0);
    if (FU.shadows != 0u) { shade = sunShadowAt(p); }
    sun = FU.sunCol * ndl * shade;
  }
  var lamp = vec3f(0.0);
  if (FU.lampCount > 0) { lamp = lampSeen(p, n); }
  return alb * (sun + lamp + giIrradiance(probeAt(p + n * GI_OFFSET), n) + sampleLight(p) * FU.lightGain) + emit;
}
fn nearField(p: vec3f, ng: vec3f, n: vec3f, irr: vec3f, vis: ptr<function, f32>) -> vec3f {
  let t1 = normalize(NEAR_FRAME_A - n * dot(NEAR_FRAME_A, n) + vec3f(1e-4, 0.0, 0.0));
  let t2 = cross(n, t1);
  let ro = p + ng * NEAR_START;
  var wSum = 0.0;
  var occ = 0.0;
  var dirC = vec3f(0.0);
  var alb = vec3f(0.0);
  var albW = 0.0;
  var emit = vec3f(0.0);
  for (var i = 0; i < NEAR_TAPS; i++) {
    let k = NEAR_KERNEL[i];
    var d = t1 * k.x + t2 * k.y + n * k.z;
    if (dot(d, ng) < 0.0) { d = reflect(d, ng); }
    var hid: i32;
    var ha: vec4f;
    let o = nearSolid(ro + d * k.w, &hid, &ha) * k.z;
    wSum += k.z;
    if (o <= 0.0) { continue; }
    occ += o;
    dirC += o * d;
    if (hid < 0) { alb += o * GROUND_ALB; albW += o; }
    else if (hid != E_EMPTY) {
      alb += o * ALBEDO(hid);
      albW += o;
      emit += o * (cellEmission(hid, ha.y, floor(ha.w)) + sparkEmit(hid, floor(ha.w)));
    }
  }
  *vis = max(1.0 - occ / wSum, NEAR_VIS_MIN);
  if (occ <= 0.0) { return irr; }
  if (albW < occ) {
    let oid = lcIdAt(vec3i(floor(p - ng * 0.5)));
    var own = GROUND_ALB;
    if (oid > E_EMPTY) { own = ALBEDO(oid); }
    alb += (occ - albW) * own;
  }
  let dc = dirC / max(length(dirC), 1e-6);
  let Lhit = hitLight(ro + dc * NEAR_REP_D, -dc, alb / occ, emit / occ);
  return mix(irr, Lhit, occ / wSum);
}` : '// (no nearField here: it reads the cascades, the probes and the glow)'}
${glow ? /* wgsl */ `
// ---- lava and fire as lights: the glow's direction and its blockers (gfx/lighting.js) ----
const GLOW_START: f32 = 0.55;
const GLOW_EMIT_MIN: f32 = 1e-4;
const GLOW_GRAD_H: f32 = 2.0;
const GLOW_DIR_LEN: f32 = 8.0;
const GLOW_TAPS: i32 = 3;
const GLOW_TAP_D: vec3f = vec3f(1.0, 2.5, 5.0);
const GLOW_REACH: f32 = 0.75;
const GLOW_ISO: vec2f = vec2f(0.4, 0.7);
const GLOW_REL_MIN: f32 = 0.05;
fn glowWorthIt(local: vec3f, irr: vec3f) -> bool {
  return FU.glowLights != 0u && dot(local, LUMA_709) > GLOW_REL_MIN * dot(irr, LUMA_709);
}
fn glowLightScale(p: vec3f, ng: vec3f, n: vec3f) -> f32 {
  let ro = p + ng * GLOW_START;
  let e0 = glowLum(ro);
  if (e0 < GLOW_EMIT_MIN) { return 1.0; }
  let h = vec2f(GLOW_GRAD_H, 0.0);
  let g = vec3f(glowLum(ro + h.xyy) - glowLum(ro - h.xyy), glowLum(ro + h.yxy) - glowLum(ro - h.yxy),
                glowLum(ro + h.yyx) - glowLum(ro - h.yyx)) / (2.0 * GLOW_GRAD_H);
  let gl = length(g);
  if (gl < 1e-8) { return 1.0; }
  let L = g / gl;
  let D = clamp(gl * GLOW_DIR_LEN / e0, 0.0, 1.0);
  let reach = GLOW_REACH * 2.0 * e0 / gl;
  var vis = 1.0;
  let tapD = GLOW_TAP_D;
  for (var i = 0; i < GLOW_TAPS; i++) {
    if (tapD[i] > reach) { break; }
    let q = ro + L * tapD[i];
    let c = vec3i(floor(q));
    if (q.y < 0.0 || !lcInWorld(c)) { break; }
    let sf = surfField(q);
    var o = smoothstep(GLOW_ISO.x, GLOW_ISO.y, max(sf.z, sf.w));
    let a = wcA(c);
    let id = eid(a);
    if (lcIsCrisp(id) && RCLASS(id) == R_OPAQUE && dot(cellEmission(id, a.y, floor(a.w)) + sparkEmit(id, floor(a.w)), LUMA_709) < GLOW_EMIT_MIN) { o = 1.0; }
    vis *= 1.0 - o;
  }
  return vis * mix(1.0, 2.0 * max(dot(n, L), 0.0), D);
}` : ''}

// ---- specular: GGX (gfx/lighting.js, unchanged) ----
const GGX_ALPHA_MIN: f32 = 2e-3;
fn smithV(nl: f32, nv: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  let gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
fn ggxSpecA(n: vec3f, v: vec3f, l: vec3f, rough: f32, F0: vec3f, t0: vec3f, aniso: f32) -> vec3f {
  let nl = dot(n, l);
  if (nl <= 0.0) { return vec3f(0.0); }
  let h = normalize(v + l);
  let nv = max(dot(n, v), 1e-4);
  let nh = max(dot(n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  var a = max(rough * rough, GGX_ALPHA_MIN);
  var D: f32;
  if (aniso > 0.0) {
    let b = normalize(cross(n, t0));
    let t = cross(b, n);
    let at = max(a * (1.0 - aniso), GGX_ALPHA_MIN);
    let ab = max(a * (1.0 + aniso), GGX_ALPHA_MIN);
    let th = dot(t, h) / at;
    let bh = dot(b, h) / ab;
    let d = th * th + bh * bh + nh * nh;
    D = 1.0 / (PI_L * at * ab * d * d);
    a = sqrt(at * ab);
  } else {
    let a2 = a * a;
    let d = nh * nh * (a2 - 1.0) + 1.0;
    D = a2 / (PI_L * d * d);
  }
  let F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return D * smithV(nl, nv, a) * F * nl;
}
fn ggxSpec(n: vec3f, v: vec3f, l: vec3f, rough: f32, F0: vec3f) -> vec3f {
  return ggxSpecA(n, v, l, rough, F0, vec3f(1.0, 0.0, 0.0), 0.0);
}
const LAMP_SPEC_WIDEN: f32 = 1.0 / 3.0;
const LAMP_SPEC_EPS: f32 = 1e-6;
struct LampSpecIn { v: vec3f, rough: f32, F0: vec3f, tang: vec3f, aniso: f32, on: bool }
struct LampLit { diff: vec3f, spec: vec3f }
fn lampSpec(i: i32, p: vec3f, n: vec3f, view: LampSpecIn) -> vec3f {
  let rr = reflect(-view.v, n);
  let len = FU.lampShape[i].y;
  let rad = FU.lampShape[i].x;
  let L0 = FU.lampPos[i].xyz - p - vec3f(0.0, 0.5 * len, 0.0);
  let Ld = vec3f(0.0, len, 0.0);
  let rLd = dot(rr, Ld);
  let den = dot(Ld, Ld) - rLd * rLd;
  var t = 0.5;
  if (den > LAMP_SPEC_EPS) { t = (dot(rr, L0) * rLd - dot(L0, Ld)) / den; }
  let Lc = L0 + Ld * clamp(t, 0.0, 1.0);
  let toRay = dot(Lc, rr) * rr - Lc;
  let Lp = Lc + toRay * clamp(rad / max(length(toRay), LAMP_SPEC_EPS), 0.0, 1.0);
  let d = max(length(Lc), LAMP_SPEC_EPS);
  let a = max(view.rough * view.rough, GGX_ALPHA_MIN);
  let aS = a / clamp(a + LAMP_SPEC_WIDEN * rad / d, 0.0, 1.0);
  let aL = a / clamp(a + LAMP_SPEC_WIDEN * 0.5 * len / d, 0.0, 1.0);
  return PI_L * ggxSpecA(n, view.v, normalize(Lp), view.rough, view.F0, view.tang, view.aniso) * (aS * aS * aL);
}
fn lampSpecSeen(p: vec3f, n: vec3f, view: LampSpecIn) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0; i < LAMP_MAX; i++) {
    if (i >= FU.lampCount) { break; }
    let dv = lampNearest(i, p) - p;
    let d2 = dot(dv, dv);
    let R = FU.lampPos[i].w;
    if (d2 >= R * R || dot(n, dv) <= 0.0 || !lampLive(i)) { continue; }
    sum += FU.lampCol[i].rgb * lampFall(d2, R, FU.lampShape[i].x) * lampSpec(i, p, n, view);
  }
  return sum;
}
const LAMP_START: f32 = 0.55;
const LAMP_SELF_SKIP: f32 = 1.0;
const LAMP_PAD: f32 = 0.3;
const LAMP_FIXED_PAD: f32 = ${LAMP_FIXED_PAD.toFixed(2)};
const LAMP_FIXED_SELF: f32 = 0.6;

// ---- the lighthouse beacon (shaders/gfx/lighthouse.js, in world cells) ----
// Its ray marches the world copy's hierarchy, so it crosses the whole map in BEACON_MAX_STEPS.
const BEACON_MAX_STEPS: i32 = ${SHADOW.MAX_STEPS};
fn beaconPosition() -> vec3f { return FU.beacon.xyz; }
fn beaconPower(p: vec3f) -> vec3f {
  if (FU.beaconDir.w <= 0.0 || FU.beacon.w <= 0.0) { return vec3f(0.0); }
  let dv = p - beaconPosition();
  let d2 = dot(dv, dv);
  if (d2 >= FU.beacon.w * FU.beacon.w || d2 < 4.0) { return vec3f(0.0); }
  let cone = smoothstep(${glf(LIGHTHOUSE.outer)}, ${glf(LIGHTHOUSE.inner)}, dot(dv * inverseSqrt(d2), FU.beaconDir.xyz));
  if (cone <= 0.0) { return vec3f(0.0); }
  let id = lcIdAt(vec3i(FU.beaconCell.xyz));
  if (id != E_EMPTY && id != E_CRYSTAL) { return vec3f(0.0); }
  return vec3f(${LIGHTHOUSE.color.map(glf).join(', ')}) * (${glf(LIGHTHOUSE.intensity)} * FU.beaconDir.w * cone * lampFall(d2, FU.beacon.w, ${glf(LIGHTHOUSE.radius)}));
}
struct BeaconRay { o: vec3f, d: vec3f, len: f32, trace: bool }
fn beaconMaxSteps() -> i32 { return BEACON_MAX_STEPS; }
fn beaconRay(p: vec3f) -> BeaconRay {
  let dv = beaconPosition() - p;
  let d = length(dv);
  let rd = lcSafeDir(dv / max(d, 1e-4));
  let end = max(d - 2.0, 0.0);
  return BeaconRay(p + rd * 0.001, rd, end - 0.002, end > 0.002);
}
fn beaconVisible(p: vec3f) -> bool {
  let r = beaconRay(p);
  var hc: vec3i;
  var hn: vec3f;
  return !r.trace || !(traceNearSteps(r.o, r.d, r.len, true, LAMP_SELF_SKIP, beaconMaxSteps(), &hc, &hn) >= 0.0);
}
fn beaconIrradiance(p: vec3f) -> vec3f {
  let power = beaconPower(p);
  if (max(power.r, max(power.g, power.b)) <= 0.0) { return vec3f(0.0); }
  if (!beaconVisible(p)) { return vec3f(0.0); }
  return power;
}
fn beaconDiffuse(p: vec3f, ng: vec3f, n: vec3f) -> vec3f {
  let ro = p + ng * LAMP_START;
  let dv = beaconPosition() - ro;
  let nl = max(dot(n, dv) * inverseSqrt(max(dot(dv, dv), 1e-8)), 0.0);
  if (nl <= 0.0) { return vec3f(0.0); }
  return beaconIrradiance(ro) * nl;
}
// The lamps' light at p, each shadowed by a traced ray (soft: aimed at a random point of the
// light's body, TAA averaging the penumbra), the beacon's as the loop's last trip (one
// traceNearSteps call site: Metal inlines every call, gfx/lighting.js).
fn lampLights(p: vec3f, ng: vec3f, n: vec3f, soft: bool, view: LampSpecIn, beamOn: bool) -> LampLit {
  var sum = vec3f(0.0);
  var spec = vec3f(0.0);
  let lamps = min(FU.lampCount, LAMP_MAX);
  for (var i = 0; i <= LAMP_MAX; i++) {
    let beam = i == lamps;
    if (i > lamps || (beam && !(beamOn && FU.beaconDir.w > 0.0))) { break; }
    let ro = p + ng * LAMP_START;
    var o = ro;
    var rd = vec3f(0.0);
    var len = 0.0;
    var steps = NEAR_MAX_STEPS;
    var nl = 0.0;
    var d2 = 0.0;
    var R = 0.0;
    var r = 0.0;
    var trace = true;
    var power = vec3f(0.0);
    if (beam) {
      let dv = beaconPosition() - ro;
      nl = max(dot(n, dv) * inverseSqrt(max(dot(dv, dv), 1e-8)), 0.0);
      if (nl <= 0.0) { break; }
      power = beaconPower(ro);
      if (max(power.r, max(power.g, power.b)) <= 0.0) { break; }
      let ray = beaconRay(ro);
      o = ray.o; rd = ray.d; len = ray.len; steps = beaconMaxSteps(); trace = ray.trace;
    } else {
      let near = lampNearest(i, ro);
      let dv = near - ro;
      d2 = dot(dv, dv);
      R = FU.lampPos[i].w;
      if (d2 >= R * R) { continue; }
      let fixedLamp = FU.lampCol[i].w > 0.5;
      if (!lampLive(i)) { continue; }
      if (fixedLamp && all(abs(p - FU.lampPos[i].xyz) < vec3f(LAMP_FIXED_SELF))) { continue; }
      let d = sqrt(d2);
      let l = dv / max(d, 1e-4);
      nl = dot(n, l);
      if (nl <= 0.0) { continue; }
      r = FU.lampShape[i].x;
      var aim = near;
      if (soft) {
        let u = lampRand(i);
        let t1 = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(l.y) < 0.9), l));
        let t2 = cross(l, t1);
        let a = 2.0 * PI_L * u.y;
        aim = FU.lampPos[i].xyz + vec3f(0.0, (u.z - 0.5) * FU.lampShape[i].y, 0.0) + (t1 * cos(a) + t2 * sin(a)) * (r * sqrt(u.x));
      }
      let sv = aim - ro;
      let sd = length(sv);
      let pad = select(LAMP_PAD, LAMP_FIXED_PAD, fixedLamp) + distance(aim, near);
      rd = sv / max(sd, 1e-4);
      len = max(sd - pad, 0.0);
    }
    var hc: vec3i;
    var hn: vec3f;
    if (trace && traceNearSteps(o, rd, len, true, LAMP_SELF_SKIP, steps, &hc, &hn) >= 0.0) { continue; }
    if (beam) {
      sum += power * nl;
      break;
    }
    let E = FU.lampCol[i].rgb * lampFall(d2, R, r);
    sum += E * nl;
    if (view.on) { spec += E * lampSpec(i, p, n, view); }
  }
  return LampLit(sum, spec);
}
fn lampShade(p: vec3f, ng: vec3f, n: vec3f, soft: bool, view: LampSpecIn) -> LampLit {
  return lampLights(p, ng, n, soft, view, true);
}
fn lampSum(p: vec3f, ng: vec3f, n: vec3f, soft: bool) -> vec3f {
  return lampShade(p, ng, n, soft, LampSpecIn(vec3f(0.0), 1.0, vec3f(0.0), vec3f(1.0, 0.0, 0.0), 0.0, false)).diff;
}
fn lampLight(p: vec3f, ng: vec3f, n: vec3f) -> vec3f { return lampSum(p, ng, n, true); }
`;
