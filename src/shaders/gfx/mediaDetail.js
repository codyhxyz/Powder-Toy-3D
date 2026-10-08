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
// DETAIL_MEDIA_FLOW: the detail rides the simulation's velocity field (tB,
// cells/step, trilinearly read) instead of a fixed rise: wisps follow the
// actual flow, curl around obstacles and stall where the gas stalls. Texture
// advection (Neyret 2003): two copies of the noise, half a cycle apart, are
// each carried along the flow for FLOW_PERIOD steps and then restarted at a
// new place; each fades out before its restart. Their blend is rescaled to
// keep the noise's contrast (and so its mean 0.5 and spread).
import { MEDIA_NOISE_CELLS } from '../../gfx/materials.js';
import { NOISE_FINEST_PERIOD } from '../../gfx/mediaNoise.js';
import { CELL_M } from '../../scale.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
// Fine filament sizes (m): what resolves when the eye is inside a plume 1-3 m
// across. Turned into whole-number scales of the noise tile.
const FILAMENT_1_M = 0.2, FILAMENT_2_M = 0.05;
const NOISE_FINEST_M = (MEDIA_NOISE_CELLS / NOISE_FINEST_PERIOD) * CELL_M;   // m, the base noise's finest structure
const FINE_SCALE_1 = Math.max(1, Math.round(NOISE_FINEST_M / FILAMENT_1_M));
const FINE_SCALE_2 = Math.max(1, Math.round(NOISE_FINEST_M / FILAMENT_2_M));
// Finest march step (m): finer than the octave-2 filaments.
const MEDIA_STEP_MIN_M = 0.04;
const STEP_MIN_CELLS = MEDIA_STEP_MIN_M / CELL_M;

export const mediaDetailGLSL = /* glsl */ `
#define NOISE_FINEST_CELLS ${f(MEDIA_NOISE_CELLS / NOISE_FINEST_PERIOD)}   // cells across the base noise's finest lattice cell

// Detail behind gas that is already mostly opaque barely shows (it is seen
// through the transmittance in front of it), so every feature fades out, or
// switches off, as the ray's visibility drops: dense plumes cost little more.
#if defined(DETAIL_MEDIA_FINE) || defined(DETAIL_MEDIA_STEP) || defined(DETAIL_MEDIA_FLOW)
#define MEDIA_DETAIL_ON 1
#define DETAIL_VIS_LO 0.05      // ray transmittance below which detail is off...
#define DETAIL_VIS_HI 0.2       // ...and above which it is fully on
float gMediaVis = 1.0;          // the ray's transmittance at the current media sample (set by mediaSegment)
// how much detail the current sample gets. Smooth: a hard switch would draw
// the iso-transmittance shell around the eye, and HDR flames behind it show
// even a few percent
float detailVis() { return smoothstep(DETAIL_VIS_LO, DETAIL_VIS_HI, gMediaVis); }
#endif

// ---- march step ----
#ifdef DETAIL_MEDIA_STEP
#define MEDIA_STEP_PER_DIST 0.125   // step (cells) per cell of distance from the eye: 8 samples per e-fold of distance
#define MEDIA_STEP_MIN ${f(STEP_MIN_CELLS)}   // finest step (cells), right at the eye: MEDIA_STEP_MIN_M
// lattice samples in one cell segment: sqrt(3) / MEDIA_STEP_MIN rounded up
#define MEDIA_SEG_SAMPLES ${Math.ceil(Math.sqrt(3) / STEP_MIN_CELLS)}
float mediaStepAt(float t) {
  return mix(MEDIA_STEP, clamp(t * MEDIA_STEP_PER_DIST, MEDIA_STEP_MIN, MEDIA_STEP), detailVis());
}
#define MEDIA_STEP_AT(t) mediaStepAt(t)
#else
#define MEDIA_SEG_SAMPLES MEDIA_MAX_PER_SEG
#define MEDIA_STEP_AT(t) MEDIA_STEP
#endif

// ---- advection by the flow ----
#ifdef DETAIL_MEDIA_FLOW
#define FLOW_PERIOD 16.0     // sim steps each noise copy rides the flow before restarting (divides the clock wrap);
                             // short, so per-particle velocity jitter shears the noise less
#define FLOW_MAX 1.0         // cells/step: the sim moves a particle at most one cell a step
#define FLOW_PHASES 2        // noise copies, evenly staggered over the cycle
// tile offset per cycle, so a restarted copy shows new detail (fractions of a tile, mutually irrational-ish)
const vec3 FLOW_CYCLE_OFFSET = vec3(0.3183, 0.5772, 0.6931);
vec3 gFlowV = vec3(0.0);     // flow velocity at the current media sample (cells/step), set by gasDensity

// sim velocity at p (cells/step), trilinear between cell centres, clamped to FLOW_MAX
vec3 flowVel(vec3 p) {
  vec3 q = clamp(p, vec3(0.5), vec3(GRID) - 0.5) - 0.5;
  ivec3 i0 = ivec3(floor(q));
  vec3 fr = q - vec3(i0), v = vec3(0.0);
  for (int c = 0; c < 8; c++) {
    ivec3 o = ivec3(c & 1, (c >> 1) & 1, c >> 2);
    vec3 w = mix(1.0 - fr, fr, vec3(o));
    v += texelFetch(tB, atlas(min(i0 + o, GRID - 1)), 0).xyz * (w.x * w.y * w.z);
  }
  float s = length(v);
  return s > FLOW_MAX ? v * (FLOW_MAX / s) : v;
}

// The detail noise at p (scale: tiles per MEDIA_NOISE_CELLS, off: tile offset),
// carried along gFlowV, stretched along y.
vec4 flowNoise(vec3 p, float scale, vec3 off, float stretch) {
  float c = uSimClock / FLOW_PERIOD;
  vec4 n = vec4(0.0);
  float w2 = 0.0;
  for (int i = 0; i < FLOW_PHASES; i++) {
    float ph = c + float(i) / float(FLOW_PHASES), cyc = floor(ph), fr = ph - cyc;
    vec3 q = p - gFlowV * (fr * FLOW_PERIOD);
    q.y /= stretch;
    float w = 1.0 - abs(2.0 * fr - 1.0);   // 0 at the restart, 1 mid-cycle; the copies' weights sum to 1
    n += w * texture(tMediaNoise, q * (scale / MEDIA_NOISE_CELLS) + off + fract(cyc * FLOW_CYCLE_OFFSET));
    w2 += w * w;
  }
  // a blend of independent noises has less spread than each: rescale it
  return clamp(NOISE_MEAN + (n - NOISE_MEAN) * inversesqrt(w2), 0.0, 1.0);
}
#endif

// The detail noise at p, read 'scale' times finer and offset by 'off' tiles,
// drifting up at 'rise' cells/step (or riding the flow) and stretched along y.
vec4 detailNoise(vec3 p, float scale, vec3 off, float rise, float stretch) {
#ifdef DETAIL_MEDIA_FLOW
  return flowNoise(p, scale, off, stretch);
#else
  p.y = (p.y - mod(uSimClock * rise, MEDIA_NOISE_CELLS * stretch)) / stretch;
  return texture(tMediaNoise, p * (scale / MEDIA_NOISE_CELLS) + off);
#endif
}

// ---- fine octaves ----
#ifdef DETAIL_MEDIA_FINE
// Each octave reads the noise tile FINE_SCALE_* times smaller (whole numbers,
// so the clock wrap stays seamless): its finest filaments are about
// FILAMENT_*_M across (sized in metres, see src/scale.js).
#define FINE_SCALE_1 ${f(FINE_SCALE_1)}
#define FINE_SCALE_2 ${f(FINE_SCALE_2)}
// tile offsets of the octaves (fractions of a tile): uncorrelated with the base
const vec3 FINE_OFF_1 = vec3(0.4142, 0.7321, 0.2361);
const vec3 FINE_OFF_2 = vec3(0.6180, 0.1547, 0.8284);
#define FIL_EXP 3.0          // filament sharpness: gas gathers on the noise's ridges as r^FIL_EXP
#define FINE_EDGE 0.9        // filament strength in thin gas (0-1; 1 empties the gaps)...
#define FINE_CORE 0.35       // ...and in dense gas, which keeps its body
#define FINE_AMT_2 0.7       // octave 2's strength relative to octave 1
#define FINE_WARP_M 0.15     // m: octave 1 curls octave 2's lookup this far
#define FLAME_FINE 0.2       // fire-density units: fine wrinkles of the flame edge
#define FLAME_FINE_2 0.5     // octave 2's share of them

// weight of each octave at p: fades in as the pixel footprint resolves it
// (and out behind mostly opaque gas)
vec2 fineWeights(vec3 p) {
  float fp = footprint(p);
  const float F1 = FINE_SCALE_1 / NOISE_FINEST_CELLS, F2 = FINE_SCALE_2 / NOISE_FINEST_CELLS;   // cycles per cell
  return vec2(lodFade(F1, fp), lodFade(F2, fp)) * detailVis();
}
// mean-1 redistribution of uniform noise n onto its ridges
float filament(float n) { return (FIL_EXP + 1.0) * pow(1.0 - abs(2.0 * n - 1.0), FIL_EXP); }

// The fine octaves at p (weights fw; an octave weighted 0 isn't read and
// stays at the noise mean). Smoke, steam and flames share the reads.
void fineNoise(vec3 p, vec2 fw, out vec4 n1, out vec4 n2) {
  n1 = detailNoise(p, FINE_SCALE_1, FINE_OFF_1, MD_RISE.y, 1.0);
  n2 = vec4(NOISE_MEAN);
  if (fw.y > 0.0) {
    vec3 q = p + (FINE_WARP_M / CELL_M * fw.x) * (2.0 * n1.gba - 1.0);
    n2 = detailNoise(q, FINE_SCALE_2, FINE_OFF_2, MD_RISE.y, 1.0);
  }
}

// Smoke and steam densities d with the fine octaves n1, n2 (weights fw).
vec2 gasFine(vec2 d, vec2 fw, vec4 n1, vec4 n2) {
  vec2 amt = mix(vec2(FINE_EDGE), vec2(FINE_CORE), smoothstep(vec2(0.0), vec2(BILLOW_CORE_D), d));
  float k = (1.0 + fw.x * (filament(n1.g) - 1.0)) * (1.0 + (FINE_AMT_2 * fw.y) * (filament(n2.g) - 1.0));
  return d * (1.0 + amt * (k - 1.0));
}

// Fine wrinkles of the flame edge (fire density units, mean 0).
float flameFine(vec2 fw, vec4 n1, vec4 n2) {
  return FLAME_FINE * (fw.x * (n1.b - NOISE_MEAN) + FLAME_FINE_2 * fw.y * (n2.b - NOISE_MEAN));
}
#endif
`;
