// The render fields as camera-centred clipmaps in world cells (docs/seamless-world.md, "F — fields").
//
// What they are: the smooth-surface, media and thin fields of shaders/fields.js (the EMA, the
// normalised Gaussian blur, the thin-feature boost and its peak), derived from the world copy (W)
// instead of the physics window, and held around the camera at several resolutions: clipmaps
// (Losasso & Hoppe 2004, "Geometry Clipmaps"; Tanner et al. 1998, "The Clipmap"). Level 0 is a
// texel per cell; each level after it is half the resolution and twice the reach, with enough of
// them that the coarsest holds the whole map (fieldClipPlan).
//
// Storage. One 3D texture per field holds every level: all levels share the horizontal size
// FIELD_CLIP_TEXELS, so they stack along y, level k in a band of rows of its own. x and z address
// toroidally through the repeat sampler (wrapLinear): world texel X sits at X mod S, so a scroll
// writes only the slab that came in. y wraps by hand inside the band (fieldUV), with one guard row
// after it holding a copy of the band's row 0, so the hardware's linear filter across the wrap reads
// the right neighbour. A level whose band holds the world's whole height never wraps.
//   tFS  rgba16float  the surface φ, by channel (CH_*): every level
//   tFM  rgba8unorm   the media densities (in [0, 1], fieldBlurFrag's normalisation): every level
//   tFT  rgba8unorm   the thin mask, in [0, 1]: levels below FIELD_THIN_LEVELS (fieldTex reads 0 past them)
//
// Detail by footprint. The march sets gFieldLevel = fieldLevelFor(footprint) from its pixel's
// footprint in cells, which is trilinear mipmapping's λ = log2(texels per pixel) (any GPU; gfx/
// lodFade.js's mip rule). The blend into the next level runs over the top FIELD_LEVEL_BLEND of each
// octave only ("brilinear" filtering), so most samples read one level. A point outside a level's
// filled region reads the next level that holds it, and near a region's edge both levels blend over
// a transition band FIELD_TRANSITION of the clip wide (Losasso & Hoppe 2004 §2.4, transition regions
// w = n/10), so a level switch has no seam. Coarse levels are the prefiltered field: their texels
// average the cells they cover (gather), then the same per-channel blur runs at their own spacing,
// so a distant shore is calm, not blocky.
import { glf as f } from '../../glsl.js';
import { prelude } from '../common.js';
import { materialsGLSL } from '../../gfx/materials.js';
import { fieldTargetWGSL, BLUR_TAPS, BLUR_REACH } from '../fields.js';
import { uniformStruct } from '../../gpu/params.js';
import { CUBIC_ERR, CUBIC_ERR_PX_NONE, CUBIC_ERR_PX_FULL } from '../../gfx/detail.js';
import { WC_BRICK } from './cellWord.js';

// ---- the plan (shared by the WGSL, src/gfx/worldFields.js and tools/world-fields-cpu-check.mjs) ----
export const FIELD_CLIP_TEXELS = 128;   // texels a level spans along x and z (S): level 0 reaches ±64 cells (19 m)
export const FIELD_CLIP_ROWS = 128;     // most rows a level's band holds (the world's height, if less)
export const FIELD_MAX_LEVELS = 8;      // FieldClip's arrays (S · 2^7 = 16384 cells: past every map)
export const FIELD_THIN_LEVELS = 1;     // levels the thin mask has: a thin feature is sub-texel past level 0
export const FIELD_LEVEL_BLEND = 0.25;  // octave share over which a level blends into the next (brilinear)
export const FIELD_TRANSITION = 0.1;    // transition band, as a share of a level's clip (Losasso & Hoppe: n/10)
// Texels kept between a sampled point and the edge of what a level holds: the cubic reading reaches
// two texels (fieldCubic), the normal's differences NORMAL_STEP more.
export const FIELD_FILTER_MARGIN = 3;
export const FIELD_FAR = 1e9;           // a region face at the world's edge: never left through
// Levels past this gather every cell of a texel; finer ones (texels of 8³ cells and more) gather
// GATHER_SAMPLES per axis, evenly spaced (64 samples a texel), after an occupancy test of the texel
// (wcOccupied) that answers sky and solid ground at once.
export const GATHER_FULL_LEVELS = 3;
export const GATHER_SAMPLES = 4;
export const FIELD_FORMATS = Object.freeze({ tFS: 'rgba16float', tFM: 'rgba8unorm', tFT: 'rgba8unorm' });

const roundUp = (n, m) => Math.ceil(n / m) * m;
/**
 * The clipmap for a world: its levels and the textures' rows.
 * @param {number[]} world [x, y, z] in cells
 * @param {{ texels?: number, rows?: number, thinLevels?: number }} [opts]
 * @returns {{ texels: number, levels: { k: number, s: number, rows: number, band: number, worldTexels: number[],
 *   worldBricks: number[], clipBricks: number[] }[], rows: number, thinRows: number, n: number }}
 */
export function fieldClipPlan(world, { texels = FIELD_CLIP_TEXELS, rows = FIELD_CLIP_ROWS, thinLevels = FIELD_THIN_LEVELS } = {}) {
  if (texels % WC_BRICK || rows % WC_BRICK) throw new Error('fieldClipPlan: the clip is whole bricks');
  let n = 1;
  while (texels * 2 ** (n - 1) < Math.max(world[0], world[2]) || rows * 2 ** (n - 1) < world[1]) n++;
  if (n > FIELD_MAX_LEVELS) throw new Error(`fieldClipPlan: ${world} needs ${n} levels (FIELD_MAX_LEVELS ${FIELD_MAX_LEVELS})`);
  const levels = [];
  let band = 0, thinRows = 0;
  for (let k = 0; k < n; k++) {
    const s = 2 ** k, worldTexels = world.map((v) => Math.ceil(v / s));
    const r = Math.min(rows, roundUp(worldTexels[1], WC_BRICK));
    levels.push({ k, s, rows: r, band, worldTexels, worldBricks: worldTexels.map((v) => Math.ceil(v / WC_BRICK)),
      clipBricks: [texels / WC_BRICK, r / WC_BRICK, texels / WC_BRICK] });
    band += r + 1;   // (the guard row)
    if (k < thinLevels) thinRows = band;
  }
  return { texels, levels, rows: band, thinRows, n };
}

/** A level's clip origin (level bricks) for the camera at world cell `cam`: centred, clamped into the world. */
export function clipOrigin(level, cam) {
  return [0, 1, 2].map((i) => {
    const cb = level.clipBricks[i], wb = level.worldBricks[i];
    if (cb >= wb) return 0;
    const centre = Math.floor(cam[i] / level.s / WC_BRICK);
    return Math.max(0, Math.min(wb - cb, centre - Math.floor(cb / 2)));
  });
}

// ---- the uniform the march reads (group 2, binding 7) ----
//   world  xyz the world's size in cells, w the level count
//   band   per level: its first row, its rows (without the guard), cells per texel, 0
//   lo, hi per level: the box (world cells) its samples may come from: what it holds, less
//          FIELD_FILTER_MARGIN texels on faces inside the world (±FIELD_FAR at the world's edge);
//          lo.w the transition band's width (cells). An empty level has lo > hi.
export const FieldClip = uniformStruct('FieldClip', {
  world: 'vec4i', band: ['vec4i', FIELD_MAX_LEVELS], lo: ['vec4f', FIELD_MAX_LEVELS], hi: ['vec4f', FIELD_MAX_LEVELS],
});

// ---- group 2 of render kernels (docs/seamless-world.md, bind groups): [binding, name, wgslType, layoutBody] ----
const sampled = { texture: { sampleType: 'float', viewDimension: '3d' } };
export const FIELDS_BINDINGS = Object.freeze([
  [0, 'tFS', 'texture_3d<f32>', sampled],   // the surface φ, every level
  [1, 'tFM', 'texture_3d<f32>', sampled],   // the media, every level
  [2, 'tFT', 'texture_3d<f32>', sampled],   // the thin mask, FIELD_THIN_LEVELS levels
  [6, 'wrapLinear', 'sampler', { sampler: { type: 'filtering' } }],   // linear, repeat on every axis
  [7, 'FC', 'FieldClip', { buffer: { type: 'uniform' } }],
]);
/** The group-2 declarations of FIELDS_BINDINGS (for a module that doesn't assemble group 2 itself: the checks). */
export const fieldsBindingsWGSL = (group = 2) => FIELDS_BINDINGS.map(([b, name, type, body]) =>
  `@group(${group}) @binding(${b}) var${body.buffer ? '<uniform>' : ''} ${name}: ${type};`).join('\n');

// ---- the sampling functions (the names and signatures shaders/gfx/core.js gives the march) ----
// opts.detail: gfx/detail.js's defines (DETAIL_CUBIC_CLOSE), as coreGLSL takes them.
// Declares: FieldClip, gFieldLevel, gFieldBlend, fieldLevelFor, fieldTex, surfField, mediaField,
// fieldCubic, fieldCubicGrad, cubicClose, cubicShare, surfSample, surfChannel, surfNormal, CUBIC_LO,
// CUBIC_HI, gCubicEye, gCubicPixAng, NORMAL_STEP (and their helpers, prefixed field*). Not SURF_ISO,
// gThin, surfRoot, surfCross: the march's.
export const worldFieldsWGSL = ({ detail = {} } = {}) => /* wgsl */ `
${FieldClip.wgsl}
const FIELD_CLIP_TEXELS: f32 = ${f(FIELD_CLIP_TEXELS)};
const FIELD_LEVEL_BLEND: f32 = ${f(FIELD_LEVEL_BLEND)};
const FIELD_FP_MIN: f32 = 1e-6;   // (log2 of a footprint)
// The level the march's pixel footprint picks (fieldLevelFor), and the share of the next one it
// blends in. Points outside a level's region read a coarser one regardless (fieldPick).
var<private> gFieldLevel: u32 = 0u;
var<private> gFieldBlend: f32 = 0.0;
// Trilinear mipmapping's choice (λ = log2 of texels per pixel; level k's texel is 2^k cells), with the
// blend into the next level over the top FIELD_LEVEL_BLEND of the octave ("brilinear"). It notes that
// blend in gFieldBlend for the level it returns: gFieldLevel = fieldLevelFor(fp) sets both.
fn fieldLevelFor(footprintCells: f32) -> u32 {
  let lam = log2(max(footprintCells, FIELD_FP_MIN));
  let top = f32(FC.world.w - 1);
  let l = clamp(floor(lam), 0.0, top);
  gFieldBlend = select(smoothstep(1.0 - FIELD_LEVEL_BLEND, 1.0, lam - l), 0.0, lam < 0.0 || l >= top);
  return u32(l);
}
// How far p is inside level L's region (cells; <= 0 outside it).
fn fieldIn(L: u32, p: vec3f) -> f32 {
  let d = min(p - FC.lo[L].xyz, FC.hi[L].xyz - p);
  return min(min(d.x, d.y), d.z);
}
// The level p reads and the share of the next one blended in: gFieldLevel, or the first coarser
// level that holds p; blending toward the next one over the footprint's octave (gFieldBlend) or the
// region's transition band, whichever is more, and only into a level that holds p too.
fn fieldPick(p: vec3f) -> vec2f {
  let n = u32(FC.world.w);
  var L = min(gFieldLevel, n - 1u);
  var a = select(0.0, gFieldBlend, L == gFieldLevel);
  for (; L + 1u < n; L++) {
    let d = fieldIn(L, p);
    if (d > 0.0) {
      a = max(a, 1.0 - clamp(d / FC.lo[L].w, 0.0, 1.0));
      if (a > 0.0 && fieldIn(L + 1u, p) <= 0.0) { a = 0.0; }
      return vec2f(f32(L), a);
    }
    a = 0.0;
  }
  return vec2f(f32(L), 0.0);
}
// Level L's texel coordinates of world point p, held to the world's edge texel centres (the world
// extends by its edge, as fieldTex held the window's).
fn fieldQ(p: vec3f, L: u32) -> vec3f {
  let s = f32(FC.band[L].z);
  return clamp(p / s, vec3f(0.5), ceil(vec3f(FC.world.xyz) / s) - 0.5);
}
fn fieldLo(L: u32) -> vec3f { return vec3f(0.5); }
fn fieldHi(L: u32) -> vec3f { return ceil(vec3f(FC.world.xyz) / f32(FC.band[L].z)) - 0.5; }
// Texel coordinates (level L's, any texel) to the texture's: x and z wrap in the sampler, y in L's band.
fn fieldUV(q: vec3f, L: u32, dims: vec3f) -> vec3f {
  let b = FC.band[L];
  let r = f32(b.y);
  let y = q.y - 0.5;
  return vec3f(q.x, y - floor(y / r) * r + 0.5 + f32(b.x), q.z) / dims;
}
// t has level L's band (tFT stops at FIELD_THIN_LEVELS)
fn fieldHas(t: texture_3d<f32>, L: u32) -> bool { return u32(FC.band[L].x + FC.band[L].y) < textureDimensions(t).y; }
fn fieldTexL(t: texture_3d<f32>, p: vec3f, L: u32) -> vec4f {
  if (!fieldHas(t, L)) { return vec4f(0.0); }
  return textureSampleLevel(t, wrapLinear, fieldUV(fieldQ(p, L), L, vec3f(textureDimensions(t))), 0.0);
}
// Field t at world point p, hardware trilinear, at the level fieldPick gives.
fn fieldTex(t: texture_3d<f32>, p: vec3f) -> vec4f {
  let k = fieldPick(p);
  let L = u32(k.x);
  let v = fieldTexL(t, p, L);
  if (k.y <= 0.0) { return v; }
  return mix(v, fieldTexL(t, p, L + 1u), k.y);
}
fn surfField(p: vec3f) -> vec4f { return fieldTex(tFS, p); }    // the smooth-surface fields, by channel (CH_*)
fn mediaField(p: vec3f) -> vec4f { return fieldTex(tFM, p); }   // the media fields

// The cubic B-spline reading (shaders/gfx/core.js fieldCubic: Sigg & Hadwiger 2005, GPU Gems 2
// ch. 20, eight linear fetches), in level L's texels.
fn fieldFetch8(t: texture_3d<f32>, L: u32, dims: vec3f, a0: vec3f, b0: vec3f, ga: vec3f, gb: vec3f) -> vec4f {
  let a = fieldUV(a0, L, dims);
  let b = fieldUV(b0, L, dims);
  let za = ga.y * (ga.x * textureSampleLevel(t, wrapLinear, vec3f(a.x, a.y, a.z), 0.0)
                 + gb.x * textureSampleLevel(t, wrapLinear, vec3f(b.x, a.y, a.z), 0.0))
         + gb.y * (ga.x * textureSampleLevel(t, wrapLinear, vec3f(a.x, b.y, a.z), 0.0)
                 + gb.x * textureSampleLevel(t, wrapLinear, vec3f(b.x, b.y, a.z), 0.0));
  let zb = ga.y * (ga.x * textureSampleLevel(t, wrapLinear, vec3f(a.x, a.y, b.z), 0.0)
                 + gb.x * textureSampleLevel(t, wrapLinear, vec3f(b.x, a.y, b.z), 0.0))
         + gb.y * (ga.x * textureSampleLevel(t, wrapLinear, vec3f(a.x, b.y, b.z), 0.0)
                 + gb.x * textureSampleLevel(t, wrapLinear, vec3f(b.x, b.y, b.z), 0.0));
  return ga.z * za + gb.z * zb;
}
fn fieldCubicL(t: texture_3d<f32>, p: vec3f, L: u32) -> vec4f {
  if (!fieldHas(t, L)) { return vec4f(0.0); }
  let dims = vec3f(textureDimensions(t));
  let c = fieldQ(p, L) - 0.5;
  let i = floor(c);
  let fr = c - i;
  let f2 = fr * fr;
  let f3 = f2 * fr;
  let w0 = (1.0 - 3.0 * fr + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * fr + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let a = clamp(i - 0.5 + w1 / g0, fieldLo(L), fieldHi(L));
  let b = clamp(i + 1.5 + w3 / g1, fieldLo(L), fieldHi(L));
  return fieldFetch8(t, L, dims, a, b, g0, g1);
}
fn fieldCubic(t: texture_3d<f32>, p: vec3f) -> vec4f {
  let k = fieldPick(p);
  let L = u32(k.x);
  let v = fieldCubicL(t, p, L);
  if (k.y <= 0.0) { return v; }
  return mix(v, fieldCubicL(t, p, L + 1u), k.y);
}
// The B-spline's analytic gradient (core.js fieldCubicGrad), per world cell: level L's per texel
// over its cells per texel.
fn fieldCubicGradL(t: texture_3d<f32>, p: vec3f, ch: i32, L: u32) -> vec3f {
  if (!fieldHas(t, L)) { return vec3f(0.0); }
  let dims = vec3f(textureDimensions(t));
  let c = fieldQ(p, L) - 0.5;
  let i = floor(c);
  let fr = c - i;
  let f2 = fr * fr;
  let f3 = f2 * fr;
  let w0 = (1.0 - 3.0 * fr + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * fr + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let d1 = 1.5 * f2 - 2.0 * fr;
  let d3 = 0.5 * f2;
  let dg = f2 - fr - 0.5;
  let lo = fieldLo(L);
  let hi = fieldHi(L);
  let a = clamp(i - 0.5 + w1 / g0, lo, hi);
  let b = clamp(i + 1.5 + w3 / g1, lo, hi);
  let da = clamp(i - 0.5 + d1 / dg, lo, hi);
  let db = clamp(i + 1.5 - d3 / dg, lo, hi);
  let gx = fieldFetch8(t, L, dims, vec3f(da.x, a.yz), vec3f(db.x, b.yz), vec3f(dg.x, g0.yz), vec3f(-dg.x, g1.yz));
  let gy = fieldFetch8(t, L, dims, vec3f(a.x, da.y, a.z), vec3f(b.x, db.y, b.z), vec3f(g0.x, dg.y, g0.z), vec3f(g1.x, -dg.y, g1.z));
  let gz = fieldFetch8(t, L, dims, vec3f(a.xy, da.z), vec3f(b.xy, db.z), vec3f(g0.xy, dg.z), vec3f(g1.xy, -dg.z));
  return vec3f(gx[ch], gy[ch], gz[ch]) / f32(FC.band[L].z);
}
fn fieldCubicGrad(t: texture_3d<f32>, p: vec3f, ch: i32) -> vec3f {
  let k = fieldPick(p);
  let L = u32(k.x);
  let v = fieldCubicGradL(t, p, ch, L);
  if (k.y <= 0.0) { return v; }
  return mix(v, fieldCubicGradL(t, p, ch, L + 1u), k.y);
}

// The cubic channels' share (core.js: the thin mask, or being close), and the readings built on it,
// as core.js has them.
const CUBIC_LO: f32 = 0.3;
const CUBIC_HI: f32 = 0.85;
var<private> gCubicEye: vec3f = vec3f(0.0);
var<private> gCubicPixAng: f32 = 0.0;
${detail.DETAIL_CUBIC_CLOSE ? `
const CUBIC_FP_NONE: f32 = ${f(CUBIC_ERR)} / ${f(CUBIC_ERR_PX_NONE)};
const CUBIC_FP_FULL: f32 = ${f(CUBIC_ERR)} / ${f(CUBIC_ERR_PX_FULL)};
fn cubicClose(p: vec3f) -> f32 {
  if (gCubicPixAng > 0.0) { return 1.0 - smoothstep(CUBIC_FP_FULL, CUBIC_FP_NONE, distance(p, gCubicEye) * gCubicPixAng); }
  return 0.0;
}` : `
fn cubicClose(p: vec3f) -> f32 { return 0.0; }`}
fn cubicShare(p: vec3f, ch: i32) -> f32 {
  if (CH_CUBIC[ch] <= 0.0) { return 0.0; }
  let close = cubicClose(p);
  if (close == 1.0) { return 1.0; }
  let t = fieldTex(tFT, p)[ch];
  return max(t, close);
}
fn surfSample(p: vec3f) -> vec4f {
  let s = surfField(p);
  let band = CH_CUBIC * select(vec4f(0.0), vec4f(1.0), s > vec4f(CUBIC_LO)) * select(vec4f(0.0), vec4f(1.0), s < vec4f(CUBIC_HI));
  if (all(band == vec4f(0.0))) { return s; }
  let close = cubicClose(p);
  var w = band * close;
  if (close < 1.0) { w = band * max(fieldTex(tFT, p), vec4f(close)); }
  if (all(w == vec4f(0.0))) { return s; }
  return mix(s, fieldCubic(tFS, p), w);
}
fn surfChannel(p: vec3f, ch: i32) -> f32 {
  let w = cubicShare(p, ch);
  var v = 0.0;
  if (w < 1.0) { v = surfField(p)[ch]; }
  var c = v;
  if (w > 0.0) { c = fieldCubic(tFS, p)[ch]; }
  return mix(v, c, w);
}
// Outward normal (core.js surfNormal). The differences' step grows with the level's texel, so a
// coarse level's lattice creases are ironed out the same way level 0's are (a step under a texel
// would read the trilinear field's facets).
const NORMAL_STEP: f32 = 0.55;
const NORMAL_DIFF_SCALE: f32 = 1.0 / (4.0 * NORMAL_STEP);
fn surfNormal(p: vec3f, ch: i32, fallback: vec3f) -> vec3f {
  let w = cubicShare(p, ch);
  var gr = vec3f(0.0);
  if (w < 1.0) {
    let s = f32(FC.band[u32(fieldPick(p).x)].z);
    let h = NORMAL_STEP * s;
    if (ch == CH_LIQUID) {
      let e = vec2f(1.0, 0.0);
      gr = 2.0 * vec3f(surfField(p + e.xyy * h)[ch] - surfField(p - e.xyy * h)[ch],
                       surfField(p + e.yxy * h)[ch] - surfField(p - e.yxy * h)[ch],
                       surfField(p + e.yyx * h)[ch] - surfField(p - e.yyx * h)[ch]);
    } else {
      let k = vec2f(1.0, -1.0);
      gr = k.xyy * surfField(p + k.xyy * h)[ch] + k.yyx * surfField(p + k.yyx * h)[ch]
         + k.yxy * surfField(p + k.yxy * h)[ch] + k.xxx * surfField(p + k.xxx * h)[ch];
    }
    gr *= NORMAL_DIFF_SCALE / s;
  }
  if (w > 0.0) { gr = mix(gr, fieldCubicGrad(tFS, p, ch), w); }
  let l = length(gr);
  if (l > 1e-5) { return -gr / l; }
  return fallback;
}
`;

// ---- the derivation (src/gfx/worldFields.js records it) ----
// A job is a list of level bricks (4³ texels of one level), in the book's first JOB_CAP words, each
// a word: x in bits 0-9, y in 10-17, z in 18-27 (level bricks), and the flags below. Every pass is a
// workgroup per entry, a thread per texel; the entry's scratch slot is its place in this frame's
// run (P.base + e). The slot map (the book's words after JOB_CAP, a word per brick of the level's
// clip, toroidally) finds a neighbour's slot: P.stamp << 16 | slot, for this job's entries only.
// Every pass computes all 64 texels of every entry; the planner lists the bricks within one brick
// of those the job finishes (FINAL), which is the whole chain's reach (shaders/fields.js
// FIELD_REACH = 4 cells: the gather is read at most a brick from a FINAL texel, every later stage
// less), so a FINAL texel reads only texels this job computed. A tap that finds no slot is outside
// that reach: it is skipped, as one outside the world is.
export const FE = Object.freeze({ EMA: 1 << 28, FRESH: 1 << 29, FINAL: 1 << 30 });
export const packEntry = (b, flags = 0) => ((b[0] & 1023) | ((b[1] & 255) << 10) | ((b[2] & 1023) << 18) | flags) >>> 0;
export const unpackEntry = (w) => ({ b: [w & 1023, (w >>> 10) & 255, (w >>> 18) & 1023], flags: w & (FE.EMA | FE.FRESH | FE.FINAL) });
export const NO_SLOT = 0xffffffff;

export const WorldFieldParams = uniformStruct('WorldFieldParams', {
  w: [`vec4f`, BLUR_TAPS], emaS: 'vec4f', emaM: 'vec4f', bulk: 'vec4f', sm: 'vec4f',
  world: 'vec4i',   // the world's size in cells
  band: 'vec4i',    // the level's first row, rows, cells per texel, level
  count: 'u32', base: 'u32', stamp: 'u32', axis: 'u32', reset: 'u32',
});

/**
 * The derivation's buffer layout (u32 words): the book (job entries, then the slot map) and the
 * work buffer (level 0's EMA history, 2 planes over its clip's cells, toroidally; then the scratch
 * A, B (3 planes each) and C (4 planes: the normalised blur, half floats), a plane of JOB_CAP · 64
 * words each).
 */
export function fieldWorkLayout(plan, cap) {
  const l0 = plan.levels[0], S = plan.texels;
  const cb = S / WC_BRICK, rbMax = Math.max(...plan.levels.map((l) => l.clipBricks[1]));
  const slotMap = cb * rbMax * cb, emaCells = S * l0.rows * S, sc = cap * 64;
  return {
    cap, cb, rbMax, slotMap, emaCells, sc,
    book: { map: cap, words: cap + slotMap },
    work: { ema: 0, a: 2 * emaCells, b: 2 * emaCells + 3 * sc, c: 2 * emaCells + 6 * sc, words: 2 * emaCells + 10 * sc },
  };
}

// The group-2 layout of the derivation kernels (src/gfx/worldFields.js makes it).
export const DERIVE_LAYOUT = [
  { binding: 0, visibility: 4, buffer: { type: 'storage' } },   // the book
  { binding: 1, visibility: 4, buffer: { type: 'storage' } },   // the work buffer
  { binding: 2, visibility: 4, storageTexture: { access: 'write-only', format: FIELD_FORMATS.tFS, viewDimension: '3d' } },
  { binding: 3, visibility: 4, storageTexture: { access: 'write-only', format: FIELD_FORMATS.tFM, viewDimension: '3d' } },
  { binding: 4, visibility: 4, storageTexture: { access: 'write-only', format: FIELD_FORMATS.tFT, viewDimension: '3d' } },
];

// The kernels' stages: 'slots' (a thread per entry), then per entry 'gather0' (level 0: the EMA,
// shaders/fields.js fieldEmaFrag) or 'gather' (a coarse level: the mean of its texels' targets),
// 'blur' (axis 0, 1), 'blurFinal' (axis 2: normalised, fieldBlurFrag), level 0's 'boost0',
// 'boost' (axes 1, 2: fieldBoostFrag) and 'peak' (fieldPeakFrag), a coarse level's 'store'.
export const DERIVE_STAGES = ['slots', 'gather0', 'gather', 'blur', 'blurFinal', 'boost0', 'boost', 'peak', 'store'];

const PRELUDE_GRID = { nx: 128, ny: 128, nz: 128 };   // (the prelude's grid consts: no kernel here reads them)

/**
 * One derivation kernel's WGSL.
 * @param {string} stage one of DERIVE_STAGES
 * @param {{ plan: object, cap: number, copyWGSL: string }} opts copyWGSL: W's worldCopyWGSL (group 1:
 *   wcCell, wcA, wcOccupied, WC), or a stand-in with the same functions
 */
export function worldFieldKernelWGSL(stage, { plan, cap, copyWGSL }) {
  if (!DERIVE_STAGES.includes(stage)) throw new Error(`worldFieldKernelWGSL: no stage ${stage}`);
  const lay = fieldWorkLayout(plan, cap), S = plan.texels;
  const textures = stage === 'peak' || stage === 'store';
  const head = /* wgsl */ `
${prelude(PRELUDE_GRID, { state: false })}
${materialsGLSL()}
${fieldTargetWGSL}
${copyWGSL}
${WorldFieldParams.wgsl}
@group(3) @binding(1) var<uniform> P: WorldFieldParams;
@group(2) @binding(0) var<storage, read_write> book: array<u32>;
@group(2) @binding(1) var<storage, read_write> work: array<u32>;
${textures ? `@group(2) @binding(2) var fsOut: texture_storage_3d<${FIELD_FORMATS.tFS}, write>;
@group(2) @binding(3) var fmOut: texture_storage_3d<${FIELD_FORMATS.tFM}, write>;
@group(2) @binding(4) var ftOut: texture_storage_3d<${FIELD_FORMATS.tFT}, write>;` : ''}
const S_TEX: i32 = ${S};                // texels a level spans along x and z
const CB: i32 = ${lay.cb};              // ...in bricks
const RB_MAX: i32 = ${lay.rbMax};       // the slot map's rows of bricks
const SLOT_MAP: u32 = ${lay.book.map}u;
const EMA_CELLS: u32 = ${lay.emaCells}u;
const SC: u32 = ${lay.sc}u;             // words a scratch plane
const OFF_A: u32 = ${lay.work.a}u;
const OFF_B: u32 = ${lay.work.b}u;
const OFF_C: u32 = ${lay.work.c}u;
const NO_SLOT: u32 = 0xffffffffu;
const FE_EMA: u32 = ${FE.EMA}u;
const FE_FRESH: u32 = ${FE.FRESH}u;
const FE_FINAL: u32 = ${FE.FINAL}u;
const BLUR_TAPS: i32 = ${BLUR_TAPS};
const BLUR_REACH: i32 = ${BLUR_REACH};
const GATHER_FULL_LEVELS: i32 = ${GATHER_FULL_LEVELS};
const GATHER_SAMPLES: i32 = ${GATHER_SAMPLES};
fn entryBrick(w: u32) -> vec3i { return vec3i(i32(w & 1023u), i32((w >> 10u) & 255u), i32((w >> 18u) & 1023u)); }
// the level's world size in texels
fn worldTexels() -> vec3i { return (P.world.xyz + P.band.z - 1) / P.band.z; }
fn texelInWorld(q: vec3i) -> bool { return all(q >= vec3i(0)) && all(q < worldTexels()); }
// level brick b's word in the slot map (the level's clip, toroidally; b >= 0)
fn slotKey(b: vec3i) -> u32 {
  let rb = P.band.y / 4;
  return u32((b.x % CB) + CB * ((b.y % rb) + RB_MAX * (b.z % CB)));
}
fn texelLocal(l: vec3i) -> u32 { return u32(l.x + 4 * (l.y + 4 * l.z)); }
// texel q's scratch index (slot · 64 + its place), NO_SLOT if this job didn't compute it
fn slotAt(q: vec3i) -> u32 {
  let e = book[SLOT_MAP + slotKey(q >> vec3u(2u))];
  if ((e >> 16u) != P.stamp) { return NO_SLOT; }
  return (e & 65535u) * 64u + texelLocal(q & vec3i(3));
}
// level 0's EMA history of cell c (its clip's cells, toroidally)
fn emaIndex(c: vec3i) -> u32 {
  let r = P.band.y;
  return u32((c.x % S_TEX) + S_TEX * ((c.y % r) + r * (c.z % S_TEX)));
}
// texel q's place in the level's band (x, z wrap; y wraps in the band)
fn bandTexel(q: vec3i) -> vec3i { return vec3i(q.x % S_TEX, P.band.x + q.y % P.band.y, q.z % S_TEX); }
`;
  const main = /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let e = foldId(wg, nwg);
  if (e >= P.count) { return; }
  let w = book[P.base + e];
  let p = entryBrick(w) * 4 + vec3i(i32(li & 3u), i32((li >> 2u) & 3u), i32(li >> 4u));
  let s = (P.base + e) * 64u + li;`;
  const axisDir = `
  var dir = vec3i(0);
  dir[P.axis] = 1;`;
  const body = {
    slots: /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let e = foldThread(wg, nwg, li);
  if (e >= P.count) { return; }
  book[SLOT_MAP + slotKey(entryBrick(book[P.base + e]))] = (P.stamp << 16u) | (P.base + e);
}`,
    // level 0: fieldEmaFrag's EMA, in place in the history (bricks flagged EMA; FRESH ones start
    // at their targets, as a window shift's SHIFTED bricks do), into scratch B. Intentional (V2
    // design, docs/v2.md §4.3; src/derived.js _jet): no pours, the aeration input is off under V2.
    gather0: `${main}
  if (!texelInWorld(p)) {
    for (var k = 0u; k < 3u; k++) { work[OFF_B + k * SC + s] = 0u; }
    return;
  }
  let t = fieldTarget(wcA(p));
  let h = emaIndex(p);
  var ws = work[h];
  var wm = work[EMA_CELLS + h];
  if ((w & FE_EMA) != 0u) {
    var sv = t.sv;
    var m = t.m;
    if (P.reset == 0u && (w & FE_FRESH) == 0u) {
      sv = mix(unpack4x8unorm(ws), sv, P.emaS);
      m = mix(unpack4x8unorm(wm), m, P.emaM);
    }
    ws = pack4x8unorm(sv);
    wm = pack4x8unorm(m);
    work[h] = ws;
    work[EMA_CELLS + h] = wm;
  }
  work[OFF_B + s] = ws;
  work[OFF_B + SC + s] = wm;
  work[OFF_B + 2u * SC + s] = pack4x8unorm(t.weight);
}`,
    // a coarse level: the mean target of the texel's cells (in the world), every cell up to
    // GATHER_FULL_LEVELS, then GATHER_SAMPLES³ evenly spaced; a texel the occupancy says holds only
    // air is air (a target of no surface, no media, weight 1).
    gather: `${main}
  var sv = vec4f(0.0);
  var m = vec4f(0.0);
  var d = vec4f(0.0);
  let n = P.band.z;
  let c0 = p * n;
  var occ = true;
  if (n >= 4) {
    // the occupancy's coarsest level whose block fits in the texel (4, 16, 64 cells)
    var ol = 0u;
    var bs = 4;
    if (n >= 64) { ol = 2u; bs = 64; } else if (n >= 16) { ol = 1u; bs = 16; }
    occ = false;
    let nb = n / bs;
    for (var z = 0; z < nb && !occ; z++) {
      for (var y = 0; y < nb && !occ; y++) {
        for (var x = 0; x < nb && !occ; x++) { occ = wcOccupied(ol, c0 + vec3i(x, y, z) * bs); }
      }
    }
  }
  var count = 0.0;
  if (!texelInWorld(p)) {
    count = 0.0;
  } else if (!occ) {
    d = vec4f(1.0);
    count = 1.0;
  } else {
    var st = 1;
    var ns = n;
    if (P.band.w >= GATHER_FULL_LEVELS) { ns = GATHER_SAMPLES; st = n / GATHER_SAMPLES; }
    let off = st / 2;
    for (var z = 0; z < ns; z++) {
      for (var y = 0; y < ns; y++) {
        for (var x = 0; x < ns; x++) {
          let c = c0 + vec3i(x, y, z) * st + off;
          if (any(c >= P.world.xyz)) { continue; }
          let t = fieldTarget(wcA(c));
          sv += t.sv;
          m += t.m;
          d += t.weight;
          count += 1.0;
        }
      }
    }
  }
  let k = 1.0 / max(count, 1.0);
  work[OFF_B + s] = pack4x8unorm(sv * k);
  work[OFF_B + SC + s] = pack4x8unorm(m * k);
  work[OFF_B + 2u * SC + s] = pack4x8unorm(d * k);
}`,
    // fieldBlurFrag along P.axis: B -> A (x), A -> B (y); 'blurFinal' B -> C (z), normalised
    blur: `${main}${axisDir}
  let src = select(OFF_A, OFF_B, P.axis == 0u);
  let dst = select(OFF_B, OFF_A, P.axis == 0u);
  var sv = vec4f(0.0);
  var m = vec4f(0.0);
  var d = vec4f(0.0);
  for (var i = 0; i < BLUR_TAPS; i++) {
    let q = p + dir * (i - BLUR_REACH);
    if (!texelInWorld(q)) { continue; }
    let t = slotAt(q);
    if (t == NO_SLOT) { continue; }
    let wt = P.w[i];
    sv += wt * unpack4x8unorm(work[src + t]);
    m += wt.x * unpack4x8unorm(work[src + SC + t]);
    d += wt * unpack4x8unorm(work[src + 2u * SC + t]);
  }
  work[dst + s] = pack4x8unorm(sv);
  work[dst + SC + s] = pack4x8unorm(m);
  work[dst + 2u * SC + s] = pack4x8unorm(d);
}`,
    blurFinal: `${main}${axisDir}
  var sv = vec4f(0.0);
  var m = vec4f(0.0);
  var d = vec4f(0.0);
  for (var i = 0; i < BLUR_TAPS; i++) {
    let q = p + dir * (i - BLUR_REACH);
    if (!texelInWorld(q)) { continue; }
    let t = slotAt(q);
    if (t == NO_SLOT) { continue; }
    let wt = P.w[i];
    sv += wt * unpack4x8unorm(work[OFF_B + t]);
    m += wt.x * unpack4x8unorm(work[OFF_B + SC + t]);
    d += wt * unpack4x8unorm(work[OFF_B + 2u * SC + t]);
  }
  let ok = step(vec4f(NORM_FLOOR), d);
  let o0 = ok * sv / max(d, vec4f(NORM_FLOOR));
  let o1 = ok.x * m / max(d.x, NORM_FLOOR);
  work[OFF_C + s] = pack2x16float(o0.xy);
  work[OFF_C + SC + s] = pack2x16float(o0.zw);
  work[OFF_C + 2u * SC + s] = pack2x16float(o1.xy);
  work[OFF_C + 3u * SC + s] = pack2x16float(o1.zw);
}`,
    // fieldBoostFrag stage 0 (x): C and the cells' channels -> A; taps clamped to the world
    boost0: `${main}${axisDir}
  var acc = vec4f(0.0);
  var occ = vec4f(0.0);
  for (var i = -1; i <= 1; i++) {
    let q = clamp(p + dir * i, vec3i(0), P.world.xyz - 1);
    let t = slotAt(q);
    if (t == NO_SLOT) { continue; }
    var wt = 0.5 * (1.0 - P.sm);
    if (i == 0) { wt = P.sm; }
    acc += wt * vec4f(unpack2x16float(work[OFF_C + t]), unpack2x16float(work[OFF_C + SC + t]));
    let ch = SURFCH(eid(wcA(q)));
    if (ch >= 0) { occ[ch] = 1.0; }
  }
  work[OFF_A + s] = pack4x8unorm(acc);
  work[OFF_A + SC + s] = pack4x8unorm(occ);
}`,
    // stages 1 (y: A -> B) and 2 (z: B -> A)
    boost: `${main}${axisDir}
  let src = select(OFF_B, OFF_A, P.axis == 1u);
  let dst = select(OFF_A, OFF_B, P.axis == 1u);
  var acc = vec4f(0.0);
  var occ = vec4f(0.0);
  for (var i = -1; i <= 1; i++) {
    let q = clamp(p + dir * i, vec3i(0), P.world.xyz - 1);
    let t = slotAt(q);
    if (t == NO_SLOT) { continue; }
    var wt = 0.5 * (1.0 - P.sm);
    if (i == 0) { wt = P.sm; }
    acc += wt * unpack4x8unorm(work[src + t]);
    occ = max(occ, unpack4x8unorm(work[src + SC + t]));
  }
  work[dst + s] = pack4x8unorm(acc);
  work[dst + SC + s] = pack4x8unorm(occ);
}`,
    // fieldPeakFrag over the FINAL entries, into the three textures (and the band's guard row)
    peak: `${main}
  if ((w & FE_FINAL) == 0u || !texelInWorld(p)) { return; }
  var acc = vec4f(0.0);
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = p + vec3i(x, y, z);
        if (!texelInWorld(q)) { continue; }
        let t = slotAt(q);
        if (t != NO_SLOT) { acc = max(acc, unpack4x8unorm(work[OFF_A + t])); }
      }
    }
  }
  let occ = unpack4x8unorm(work[OFF_A + SC + s]);
  let k = max(vec4f(1.0), P.bulk / max(acc, vec4f(THIN_MIN_PEAK)));
  let boosted = step(vec4f(0.5), occ);
  let phi = vec4f(unpack2x16float(work[OFF_C + s]), unpack2x16float(work[OFF_C + SC + s]));
  let med = vec4f(unpack2x16float(work[OFF_C + 2u * SC + s]), unpack2x16float(work[OFF_C + 3u * SC + s]));
  let surf = phi * mix(vec4f(1.0), k, boosted);
  let thin = boosted * smoothstep(vec4f(THIN_MASK_LO), vec4f(THIN_MASK_HI), k);
  let o = bandTexel(p);
  textureStore(fsOut, o, surf);
  textureStore(fmOut, o, med);
  textureStore(ftOut, o, thin);
  if ((p.y % P.band.y) == 0) {
    let g = vec3i(o.x, P.band.x + P.band.y, o.z);
    textureStore(fsOut, g, surf);
    textureStore(fmOut, g, med);
    textureStore(ftOut, g, thin);
  }
}`,
    // a coarse level: the normalised blur as it is (no boost: a thin feature is under its texel)
    store: `${main}
  if ((w & FE_FINAL) == 0u || !texelInWorld(p)) { return; }
  let phi = vec4f(unpack2x16float(work[OFF_C + s]), unpack2x16float(work[OFF_C + SC + s]));
  let med = vec4f(unpack2x16float(work[OFF_C + 2u * SC + s]), unpack2x16float(work[OFF_C + 3u * SC + s]));
  let o = bandTexel(p);
  textureStore(fsOut, o, phi);
  textureStore(fmOut, o, med);
  if ((p.y % P.band.y) == 0) {
    let g = vec3i(o.x, P.band.x + P.band.y, o.z);
    textureStore(fsOut, g, phi);
    textureStore(fmOut, g, med);
  }
}`,
  };
  return head + body[stage];
}
