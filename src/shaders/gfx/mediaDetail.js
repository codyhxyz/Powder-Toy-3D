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
// wrinkles of their luminous edge. This is the detail-noise texture approach
// of Horizon Zero Dawn's clouds (Schneider 2015: a small tileable 3D noise
// read finer than the base shape, eroding thin gas more than dense cores),
// not ALU noise: two 3D texture reads a sample. The octaves' strengths follow
// Kolmogorov's inertial range, as wavelet turbulence's do (Kim et al. 2008).
//
// Where it fades (gfx/detail.js MEDIA_FINE_FADE_M). Each sample fades each
// octave by its own pixel footprint (footprint(p): the cone widens along the
// ray, so the far side of a plume loses its filaments first), by the material
// rule lodFade: full up to 0.5 cycles per pixel (Nyquist), gone at 1. That
// rule holds for a medium too: TAA jitters the pixel across its own width, so
// what it converges to is the box-filtered radiance, whose response to a
// frequency of f cycles per pixel is sinc(f): 0.64 at Nyquist, 0 at 1. The
// medium differs in two ways, and neither moves the cut-off. Along the ray the
// pixel integrates the gas over its visible depth L, which averages an
// octave of frequency F down to (F L)^-1/2 of its contrast, but at every
// distance alike. And a march step longer than the octave (MEDIA_STEP = 30 cm)
// samples it along the ray as a jittered Monte Carlo estimate, unbiased, whose
// noise TAA averages away over its history. The frequency is one cycle per
// finest lattice cell (the ridge doubles the noise's own ~0.5 cycle per
// cell), so octave 1 (20 cm) is gone at 0.2 m per pixel and full to 0.1;
// octave 2 (5 cm) at 0.05 and 0.025: at 1080p and a 75° vertical FOV
// (1.42 mrad per pixel), filaments to 70 m, gone by 141 m; the 5 cm ones to
// 18 m, gone by 35 m.
//
// DETAIL_MEDIA_STEP: a finer march near the camera. The media lattice step
// grows with distance (geometric marching: a constant number of samples per
// doubling of distance), between MEDIA_STEP_MIN and MEDIA_STEP, so gas right
// in front of the eye is sampled finely enough to show the filaments.
//
// DETAIL_MEDIA_FLOW: the detail rides the simulation's velocity field (tB,
// cells/step, trilinearly read) instead of a fixed rise: wisps follow the
// actual flow, curl around obstacles and stall where the gas stalls. Texture
// advection (Neyret 2003): two copies of the noise, half a cycle apart, are
// each carried along the flow for FLOW_PERIOD steps and then restarted at a
// new place; each fades out before its restart. Their blend is rescaled to
// keep the noise's contrast (and so its mean 0.5 and spread). Only the base
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
/** m: the octaves' actual finest structure (their lattice cell, after rounding the scales), for gfx/detail.js's fade */
export const FINE_1_M = NOISE_FINEST_M / FINE_SCALE_1, FINE_2_M = NOISE_FINEST_M / FINE_SCALE_2;
// Octave 2's strength relative to octave 1: in turbulence's inertial range a
// passive scalar (smoke) has the Obukhov-Corrsin spectrum E(k) ~ k^-5/3, so a
// band of fixed ratio around k holds variance ~ k^-2/3 and its rms goes as
// k^-1/3: the 2/3 law, a scalar's difference across a gap l grows as l^1/3
// (Kolmogorov 1941; Obukhov 1949, Corrsin 1951).
const FINE_AMT_2 = (FINE_2_M / FINE_1_M) ** (1 / 3);
// Filament sharpness: gas gathers on the noise's ridges as r^FIL_EXP (a whole
// number, written out as products: Metal's pow is exp2(log2) per call).
const FIL_EXP = 3;
const powN = (x, n) => Array(n).fill(x).join(' * ');
// Finest march step (m): finer than the octave-2 filaments.
const MEDIA_STEP_MIN_M = 0.04;
const STEP_MIN_CELLS = MEDIA_STEP_MIN_M / CELL_M;

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
const MEDIA_FLOW_PERIOD: f32 = 16.0;   // sim steps each noise copy rides the flow before restarting (divides the clock wrap);
                                       // short, so per-particle velocity jitter shears the noise less
const FLOW_MAX: f32 = 1.0;             // cells/step: the sim moves a particle at most one cell a step
const FLOW_PHASES: i32 = 2;            // noise copies, evenly staggered over the cycle
// tile offset per cycle, so a restarted copy shows new detail (fractions of a tile, mutually irrational-ish)
const FLOW_CYCLE_OFFSET: vec3f = vec3f(0.3183, 0.5772, 0.6931);
var<private> gFlowV: vec3f = vec3f(0.0);   // flow velocity at the current media sample (cells/step), set by gasDensity

// sim velocity at p (cells/step), trilinear between cell centres, clamped to FLOW_MAX
fn flowVel(p: vec3f) -> vec3f {
  let q = clamp(p, vec3f(0.5), vec3f(GRID) - 0.5) - 0.5;
  let i0 = vec3i(floor(q));
  let fr = q - vec3f(i0);
  var v = vec3f(0.0);
  for (var c = 0; c < 8; c++) {
    let o = vec3i(c & 1, (c >> 1u) & 1, c >> 2u);
    let w = mix(1.0 - fr, fr, vec3f(o));
    v += fetchB(min(i0 + o, GRID - 1)).xyz * (w.x * w.y * w.z);
  }
  let s = length(v);
  if (s > FLOW_MAX) { return v * (FLOW_MAX / s); }
  return v;
}

// The detail noise at p (scale: tiles per MEDIA_NOISE_CELLS, off: tile offset),
// carried along gFlowV, stretched along y.
fn flowNoise(p: vec3f, scale: f32, off: vec3f, stretch: f32) -> vec4f {
  let c = FU.simClock / MEDIA_FLOW_PERIOD;
  var n = vec4f(0.0);
  var w2 = 0.0;
  for (var i = 0; i < FLOW_PHASES; i++) {
    let ph = c + f32(i) / f32(FLOW_PHASES);
    let cyc = floor(ph);
    let fr = ph - cyc;
    var q = worldPos(p) - gFlowV * (fr * MEDIA_FLOW_PERIOD);   // anchored in the world (the noise tiles)
    q.y /= stretch;
    let w = 1.0 - abs(2.0 * fr - 1.0);   // 0 at the restart, 1 mid-cycle; the copies' weights sum to 1
    n += w * textureSampleLevel(tMediaNoise, linearRepeat, q * (scale / MEDIA_NOISE_CELLS) + off + fract(cyc * FLOW_CYCLE_OFFSET), 0.0);
    w2 += w * w;
  }
  // a blend of independent noises has less spread than each: rescale it
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
// the octaves' frequencies (cycles per cell): one cycle per finest lattice cell
const FINE_F: vec2f = vec2f(FINE_SCALE_1, FINE_SCALE_2) / NOISE_FINEST_CELLS;
const FIL_NORM: f32 = ${f(FIL_EXP + 1)};   // (FIL_EXP + 1): r^FIL_EXP of uniform r has mean 1 / (FIL_EXP + 1)
const FINE_EDGE: f32 = 0.9;          // filament strength in thin gas (0-1; 1 empties the gaps)...
const FINE_CORE: f32 = 0.35;         // ...and in dense gas, which keeps its body
const FINE_AMT_2: f32 = ${f(FINE_AMT_2)};   // octave 2's strength relative to octave 1: (FINE_2_M / FINE_1_M)^1/3
const FINE_WARP_M: f32 = 0.15;       // m: octave 1 curls octave 2's lookup this far
const FLAME_FINE: f32 = 0.2;         // fire-density units: fine wrinkles of the flame edge
const FLAME_FINE_2: f32 = 0.5;       // octave 2's share of them

// The fine octaves at p on the detailed densities d (smoke, steam, fire):
// smoke and steam come back redistributed onto the filaments (xy), and z is
// the fire's wrinkle, to add to the flame's level (fire density units, mean
// 0). Each octave is weighted by how well the pixel footprint resolves it
// (lodFade) and how much of the ray's light still gets through (detailVis);
// an octave weighted 0 isn't read. The reads depend on p alone, not on d, so
// they go out alongside the warped field read (gasDensity skips empty space
// before either, as Nubis skips detail where the base shape is empty). One
// exit and plain values: nothing kept across the flame's block but z.
fn gasFine(p: vec3f, d: vec3f) -> vec3f {
  let fw = (1.0 - smoothstep(vec2f(DETAIL_FADE_LO), vec2f(DETAIL_FADE_HI), FINE_F * footprint(p))) * detailVis();
  var r = vec3f(d.xy, 0.0);
  if (fw.x > 0.0) {
    let a = detailNoise(p, FINE_SCALE_1, FINE_OFF_1, MD_RISE.y, 1.0);
    var n = a.gb;   // octave 1's wisps (filaments) and tongues (flame wrinkles)...
    var m = vec2f(NOISE_MEAN);   // ...and octave 2's, at the mean while unread
    if (fw.y > 0.0) {
      let q = p + (FINE_WARP_M / CELL_M * fw.x) * (2.0 * a.gba - 1.0);
      m = detailNoise(q, FINE_SCALE_2, FINE_OFF_2, MD_RISE.y, 1.0).gb;
    }
    let s = fw * vec2f(1.0, FINE_AMT_2);
    // mean-1 redistribution of each octave's uniform wisp noise onto its ridges
    let ridge = 1.0 - abs(2.0 * vec2f(n.x, m.x) - 1.0);
    let k2 = 1.0 + s * (FIL_NORM * ${powN('ridge', FIL_EXP)} - 1.0);
    let amt = mix(vec2f(FINE_EDGE), vec2f(FINE_CORE), smoothstep(vec2f(0.0), vec2f(BILLOW_CORE_D), d.xy));
    r = vec3f(d.xy * (1.0 + amt * (k2.x * k2.y - 1.0)),
              FLAME_FINE * dot(fw * vec2f(1.0, FLAME_FINE_2), vec2f(n.y, m.y) - NOISE_MEAN));
  }
  return r;
}` : ''}
`;
};

