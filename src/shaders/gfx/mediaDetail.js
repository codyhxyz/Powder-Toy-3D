// Close-up detail of smoke, steam and fire (gfx/detail.js switches). Spliced
// into shaders/gfx/media.js; every part compiles in only when its switch is on.
//
// DETAIL_MEDIA_FINE: finer octaves of the detail noise. The base noise's finest
// structure is NOISE_FINEST_CELLS cells (1.2 m) across, so a plume seen from a
// step away is a soft blob. Two further octaves read the same tileable noise scaled
// down (a whole number of times, so the clock wrap stays seamless), each faded
// in by the pixel footprint before it would alias. They are sized in metres
// (FILAMENT_*_M: 20 cm and 5 cm, what resolves inside a plume 1-3 m across). Real smoke up close is
// sheets and filaments (turbulence stretches it), so each octave redistributes
// the gas onto the ridges of the noise: with n uniform on [0, 1] (the noise is
// equalised), r = 1 - |2n - 1| is uniform too, and (k + 1) r^k has mean 1.
// The density is multiplied by a mix of 1 and that, so a cell's gas moves
// around inside it but its mean is unchanged. Octave 1 also curls octave 2's
// lookup (domain warp), so the filaments wind. Flames get the same octaves as
// wrinkles of their luminous edge.
//
// DETAIL_MEDIA_STEP: a finer march near the camera. The media lattice step
// grows with distance (geometric marching: a constant number of samples per
// doubling of distance), between MEDIA_STEP_MIN and MEDIA_STEP, so gas right
// in front of the eye is sampled finely enough to show the filaments.
//
// DETAIL_MEDIA_FLOW: the detail rides the simulation's velocity field (state
// B, cells/step: each particle's own velocity, read linearly over the
// lattice's tetrahedra, flowVel) instead of a fixed rise: wisps follow the
// actual flow, curl around obstacles and stall where the gas stalls. Texture
// advection (Neyret 2003; Portal 2's two-phase flow maps, Vlachos 2010): two
// copies of the noise, half a cycle apart, are each carried along the flow for
// FLOW_PERIOD steps and then restarted at a new place; each fades out before
// its restart. Their blend is rescaled to keep the noise's contrast (and so
// its mean 0.5 and spread). It has no distance fade: gfx/detail.js derives
// where it would end (fadeM) and that lies past any media the view marches. Only the base
// noise rides the flow, and always at the local velocity: blending toward any
// other velocity over space (by distance or transmittance), or advecting the
// fine octaves, shears the noise into rings and streaks.
//
// WGSL (the names are the GLSL version's, docs/webgpu.md W2). Each switch is
// a JS template switch (F2): detail is the defines object of gfx/detail.js.
// The GLSL's MEDIA_STEP_AT(t) macro is the function mediaStepAt(t) either
// way, and its FLOW_PERIOD here is MEDIA_FLOW_PERIOD: WGSL has one scope for
// both, and surface.js's flowing grains have their own FLOW_PERIOD (32).
import { MEDIA_NOISE_CELLS } from '../../gfx/materials.js';
import { NOISE_FINEST_PERIOD } from '../../gfx/mediaNoise.js';
import { CELL_M } from '../../scale.js';
import { glf as f } from '../../glsl.js';

// Fine filament sizes (m): what resolves when the eye is inside a plume 1-3 m
// across. Turned into whole-number scales of the noise tile.
const FILAMENT_1_M = 0.2, FILAMENT_2_M = 0.05;
const NOISE_FINEST_M = (MEDIA_NOISE_CELLS / NOISE_FINEST_PERIOD) * CELL_M;   // m, the base noise's finest structure
const FINE_SCALE_1 = Math.max(1, Math.round(NOISE_FINEST_M / FILAMENT_1_M));
const FINE_SCALE_2 = Math.max(1, Math.round(NOISE_FINEST_M / FILAMENT_2_M));
// Finest march step (m): finer than the octave-2 filaments.
const MEDIA_STEP_MIN_M = 0.04;
const STEP_MIN_CELLS = MEDIA_STEP_MIN_M / CELL_M;
// Flow advection (DETAIL_MEDIA_FLOW). gfx/detail.js's fadeM for it restates
// these two (it stays free of shader imports): keep them in step.
export const MEDIA_FLOW_PERIOD = 16;   // sim steps a noise copy rides the flow (whole, so it divides the clock wrap)
export const FLOW_MAX = 1;             // cells/step: the sim moves a particle at most one cell a step

/** Whether any media detail switch is on (the GLSL's MEDIA_DETAIL_ON). */
export const MEDIA_DETAIL_ON = (detail = {}) => !!(detail.DETAIL_MEDIA_FINE || detail.DETAIL_MEDIA_STEP || detail.DETAIL_MEDIA_FLOW);

export const mediaDetailGLSL = (detail = {}) => {
  const fine = !!detail.DETAIL_MEDIA_FINE;
  const stepOn = !!detail.DETAIL_MEDIA_STEP;
  const flow = !!detail.DETAIL_MEDIA_FLOW;
  return /* wgsl */ `
const NOISE_FINEST_CELLS: f32 = ${f(MEDIA_NOISE_CELLS / NOISE_FINEST_PERIOD)};   // cells across the base noise's finest lattice cell
${MEDIA_DETAIL_ON(detail) ? `
// Detail behind gas that is already mostly opaque barely shows (it is seen
// through the transmittance in front of it), so every feature fades out, or
// switches off, as the ray's visibility drops: dense plumes cost little more.
const DETAIL_VIS_LO: f32 = 0.05;      // ray transmittance below which detail is off...
const DETAIL_VIS_HI: f32 = 0.2;       // ...and above which it is fully on
var<private> gMediaVis: f32 = 1.0;    // the ray's transmittance at the current media sample (set by mediaSegment)
// how much detail the current sample gets. Smooth: a hard switch would draw
// the iso-transmittance shell around the eye, and HDR flames behind it show
// even a few percent
fn detailVis() -> f32 { return smoothstep(DETAIL_VIS_LO, DETAIL_VIS_HI, gMediaVis); }` : ''}

// ---- march step ----${stepOn ? `
const MEDIA_STEP_PER_DIST: f32 = 0.125;   // step (cells) per cell of distance from the eye: 8 samples per e-fold of distance
const MEDIA_STEP_MIN: f32 = ${f(STEP_MIN_CELLS)};   // finest step (cells), right at the eye: MEDIA_STEP_MIN_M
// lattice samples in one cell segment: sqrt(3) / MEDIA_STEP_MIN rounded up
const MEDIA_SEG_SAMPLES: i32 = ${Math.ceil(Math.sqrt(3) / STEP_MIN_CELLS)};
fn mediaStepAt(t: f32) -> f32 {
  return mix(MEDIA_STEP, clamp(t * MEDIA_STEP_PER_DIST, MEDIA_STEP_MIN, MEDIA_STEP), detailVis());
}` : `
const MEDIA_SEG_SAMPLES: i32 = MEDIA_MAX_PER_SEG;
fn mediaStepAt(t: f32) -> f32 { return MEDIA_STEP; }`}
${flow ? `
// ---- advection by the flow ----
const MEDIA_FLOW_PERIOD: f32 = ${f(MEDIA_FLOW_PERIOD)};   // sim steps each noise copy rides the flow before restarting (divides the clock wrap);
                                       // short, so per-particle velocity jitter shears the noise less
const FLOW_MAX: f32 = ${f(FLOW_MAX)};             // cells/step: the sim moves a particle at most one cell a step
const FLOW_PHASES: i32 = 2;            // noise copies, evenly staggered over the cycle
// tile offset per cycle, so a restarted copy shows new detail (fractions of a tile, mutually irrational-ish)
const FLOW_CYCLE_OFFSET: vec3f = vec3f(0.3183, 0.5772, 0.6931);
var<private> gFlowV: vec3f = vec3f(0.0);   // flow velocity at the current media sample (cells/step), set by gasDensity

// Sim velocity at p (cells/step), clamped to FLOW_MAX: linear over the Kuhn
// (Freudenthal) tetrahedron of the cell-centre lattice that holds p, the
// tetrahedral interpolation of 3D colour lookup tables (Kasson, Nin, Plouffe
// and Hafner 1995, J. Electronic Imaging 4(3)).
// Like trilinear it is continuous everywhere and exact for a linear field, but
// it reads 4 cells instead of 8: half the velocity loads per media sample,
// and in the World half the inlined page lookups (worldFetchB), which were
// most of this feature's Metal compile time. The tetrahedron runs from the
// lower corner along the axis of the largest fraction, then the middle one,
// to the upper corner; its weights are the gaps between the sorted fractions.
// On a tie the corner it can't decide has weight 0, so either choice is the same.
fn flowVel(p: vec3f) -> vec3f {
  let q = clamp(p, vec3f(0.5), vec3f(GRID) - 0.5) - 0.5;
  let i0 = vec3i(floor(q));
  let fr = q - vec3f(i0);
  let hi = max(fr.x, max(fr.y, fr.z));
  let lo = min(fr.x, min(fr.y, fr.z));
  let mid = fr.x + fr.y + fr.z - hi - lo;
  let eHi = select(select(vec3i(0, 0, 1), vec3i(0, 1, 0), fr.y == hi), vec3i(1, 0, 0), fr.x == hi);
  let eLo = select(select(vec3i(0, 0, 1), vec3i(0, 1, 0), fr.y == lo), vec3i(1, 0, 0), fr.x == lo);
  let top = GRID - 1;
  let v = fetchB(i0).xyz * (1.0 - hi)
        + fetchB(min(i0 + eHi, top)).xyz * (hi - mid)
        + fetchB(min(i0 + vec3i(1) - eLo, top)).xyz * (mid - lo)
        + fetchB(min(i0 + vec3i(1), top)).xyz * lo;
  // |v| <= FLOW_MAX scales by 1, faster by FLOW_MAX / |v| (one exit, no 1/0)
  return v * (FLOW_MAX * inverseSqrt(max(dot(v, v), FLOW_MAX * FLOW_MAX)));
}

// The detail noise at p (scale: tiles per MEDIA_NOISE_CELLS, off: tile offset),
// carried along gFlowV, stretched along y. Each copy is pushed back along the
// flow by its time from mid-cycle, not from its restart (as Portal 2's flow
// maps do, and surface.js's flowing grains): it is undistorted when it weighs
// most, and strays at most half a cycle's travel, so where the velocity varies
// it shears half as far.
fn flowNoise(p: vec3f, scale: f32, off: vec3f, stretch: f32) -> vec4f {
  let c = FU.simClock / MEDIA_FLOW_PERIOD;
  var n = vec4f(0.0);
  var w2 = 0.0;
  for (var i = 0; i < FLOW_PHASES; i++) {
    let ph = c + f32(i) / f32(FLOW_PHASES);
    let cyc = floor(ph);
    let fr = ph - cyc;
    var q = worldPos(p) - gFlowV * ((fr - 0.5) * MEDIA_FLOW_PERIOD);   // anchored in the world (the noise tiles)
    q.y /= stretch;
    let w = 1.0 - abs(2.0 * fr - 1.0);   // 0 at the restart, 1 mid-cycle; the copies' weights sum to 1
    n += w * textureSampleLevel(tMediaNoise, linearRepeat, q * (scale / MEDIA_NOISE_CELLS) + off + fract(cyc * FLOW_CYCLE_OFFSET), 0.0);
    w2 += w * w;
  }
  // a blend of independent noises has less spread than each: rescale it to
  // the same spread (variance-preserving blending: Heitz & Neyret 2018)
  return clamp(NOISE_MEAN + (n - NOISE_MEAN) * inverseSqrt(w2), vec4f(0.0), vec4f(1.0));
}` : ''}

// The detail noise at p, read 'scale' times finer and offset by 'off' tiles,
// drifting up at 'rise' cells/step and stretched along y. Only the base noise
// rides the flow (gasNoise): the fine octaves are many times smaller, so the
// same velocity differences over a cycle would shear them into streaks.
fn detailNoise(p0: vec3f, scale: f32, off: vec3f, rise: f32, stretch: f32) -> vec4f {
  var p = worldPos(p0);   // anchored in the world (the noise tiles)
  p.y = (p.y - glslMod(FU.simClock * rise, MEDIA_NOISE_CELLS * stretch)) / stretch;
  return textureSampleLevel(tMediaNoise, linearRepeat, p * (scale / MEDIA_NOISE_CELLS) + off, 0.0);
}
${fine ? `
// ---- fine octaves ----
// Each octave reads the noise tile FINE_SCALE_* times smaller (whole numbers,
// so the clock wrap stays seamless): its finest filaments are about
// FILAMENT_*_M across (sized in metres, see src/scale.js).
const FINE_SCALE_1: f32 = ${f(FINE_SCALE_1)};
const FINE_SCALE_2: f32 = ${f(FINE_SCALE_2)};
// tile offsets of the octaves (fractions of a tile): uncorrelated with the base
const FINE_OFF_1: vec3f = vec3f(0.4142, 0.7321, 0.2361);
const FINE_OFF_2: vec3f = vec3f(0.6180, 0.1547, 0.8284);
const FIL_EXP: f32 = 3.0;            // filament sharpness: gas gathers on the noise's ridges as r^FIL_EXP
const FINE_EDGE: f32 = 0.9;          // filament strength in thin gas (0-1; 1 empties the gaps)...
const FINE_CORE: f32 = 0.35;         // ...and in dense gas, which keeps its body
const FINE_AMT_2: f32 = 0.7;         // octave 2's strength relative to octave 1
const FINE_WARP_M: f32 = 0.15;       // m: octave 1 curls octave 2's lookup this far
const FLAME_FINE: f32 = 0.2;         // fire-density units: fine wrinkles of the flame edge
const FLAME_FINE_2: f32 = 0.5;       // octave 2's share of them

// weight of each octave at p: fades in as the pixel footprint resolves it
// (and out behind mostly opaque gas)
fn fineWeights(p: vec3f) -> vec2f {
  let fp = footprint(p);
  const F1: f32 = FINE_SCALE_1 / NOISE_FINEST_CELLS;   // cycles per cell
  const F2: f32 = FINE_SCALE_2 / NOISE_FINEST_CELLS;
  return vec2f(lodFade(F1, fp), lodFade(F2, fp)) * detailVis();
}
// mean-1 redistribution of uniform noise n onto its ridges
fn filament(n: f32) -> f32 { return (FIL_EXP + 1.0) * pow(1.0 - abs(2.0 * n - 1.0), FIL_EXP); }

// The fine octaves at p (weights fw; an octave weighted 0 isn't read and
// stays at the noise mean). Smoke, steam and flames share the reads.
fn fineNoise(p: vec3f, fw: vec2f, n1: ptr<function, vec4f>, n2: ptr<function, vec4f>) {
  let a = detailNoise(p, FINE_SCALE_1, FINE_OFF_1, MD_RISE.y, 1.0);
  *n1 = a;
  *n2 = vec4f(NOISE_MEAN);
  if (fw.y > 0.0) {
    let q = p + (FINE_WARP_M / CELL_M * fw.x) * (2.0 * a.gba - 1.0);
    *n2 = detailNoise(q, FINE_SCALE_2, FINE_OFF_2, MD_RISE.y, 1.0);
  }
}

// Smoke and steam densities d with the fine octaves n1, n2 (weights fw).
fn gasFine(d: vec2f, fw: vec2f, n1: vec4f, n2: vec4f) -> vec2f {
  let amt = mix(vec2f(FINE_EDGE), vec2f(FINE_CORE), smoothstep(vec2f(0.0), vec2f(BILLOW_CORE_D), d));
  let k = (1.0 + fw.x * (filament(n1.g) - 1.0)) * (1.0 + (FINE_AMT_2 * fw.y) * (filament(n2.g) - 1.0));
  return d * (1.0 + amt * (k - 1.0));
}

// Fine wrinkles of the flame edge (fire density units, mean 0).
fn flameFine(fw: vec2f, n1: vec4f, n2: vec4f) -> f32 {
  return FLAME_FINE * (fw.x * (n1.b - NOISE_MEAN) + FLAME_FINE_2 * fw.y * (n2.b - NOISE_MEAN));
}` : ''}
`;
};

