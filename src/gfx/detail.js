// Close-up detail: renderer features that add geometry or texture only where a
// pixel covers a small patch of the world (zoomed in, or standing in POV mode).
// Each feature is pure appearance: it is a function of the simulation state
// and each cell's seed, and never shows motion or matter the sim didn't make.
//
// Every feature costs GPU time, so every feature is a user switch in Settings
// (section "Detail up close"). Its default follows its measured cost tier:
// cheap ones start on, expensive ones start off. Cost is measured by
// tools/detail-bench.mjs: extra GPU time per frame at BENCH_W×BENCH_H, the
// worse of the god view and an eye-level close-up (the close-up is the worst
// case, since there detail covers the whole screen).
//
// A feature compiles in only when on: the view's WGSL is generated with it
// (shaders/render.js volumeFrag(g, { detail }), a JS template switch where the
// GLSL had `#define <define> 1`), so a switched-off feature costs nothing.

import { CELL_M } from '../scale.js';
import { DETAIL_FADE_LO, DETAIL_FADE_HI, GEOM_ERR_PX_NONE, GEOM_ERR_PX_FULL } from './lodFade.js';
import { FINE_1_M, FLOW_MAX, MEDIA_FLOW_PERIOD } from '../shaders/gfx/mediaDetail.js';
import { CAP_LAMBDA_MAX_M } from '../shaders/gfx/liquidDetail.js';
import { CLOD_LUMP_R, PEB_RELIEF_SHARE, PEB_ERR_PX_NONE } from '../shaders/gfx/grains.js';

export const BENCH_W = 1280, BENCH_H = 800;   // px, the benchmark viewport

// Material texture LOD: 0.5–1 cycles per pixel, the mipmapping rule (gfx/lodFade.js).
export { DETAIL_FADE_LO, DETAIL_FADE_HI };

// Cost tiers, by extra GPU ms per frame (measured as above).
export const COST_LOW_MS = 0.5;       // below this: low
export const COST_MEDIUM_MS = 2;      // below this: medium; above it: high
export const COST = {
  low: { label: 'Low cost', on: true },
  medium: { label: 'Medium cost', on: true },
  high: { label: 'High cost', on: false },
};
export const costTier = (ms) => (ms < COST_LOW_MS ? 'low' : ms < COST_MEDIUM_MS ? 'medium' : 'high');

// The features. key: settings key suffix; define: the switch's name in the
// defines object the shaders take (the GLSL's macro); label: the
// setting's name; desc: tooltip; cost: tier from tools/detail-bench.mjs
// (put the measured ms in a comment next to it); fadeM: pixel footprint
// (metres per pixel) above which the feature draws nothing, so the view
// shader leaves it out (gfx/detailGate.js). Infinity = always in.
// Solid surface detail uses the material's normal and cavity shading at every
// level, not an additional displacement/self-shadow march.
// Pebbles (shaders/gfx/grains.js) start where the textured stand-in, which
// has no relief, misses the pebbles' half-height (PEB_RELIEF_SHARE of
// PEBBLE_M = 5 cm: 2.5 cm) by PEB_ERR_PX_NONE pixels: 6.25 mm per pixel,
// 4.4 m away at 1080p and a 75° vertical field of view (1 px = 1.42 mrad),
// all geometry by 2.2 m. The rule that hides the switch is 1 pixel (17.6 m):
// see grains.js for that trade.
const GRAINS_FADE_M = PEB_RELIEF_SHARE * 0.05 / PEB_ERR_PX_NONE;   // m per pixel (0.05: PEBBLE_M, gfx/surface.js)
// Clods start where their lumps can be seen: a lump and the crease to the next
// (2 · CLOD_LUMP_R = 0.34 cells ≈ 10 cm) are one cycle of the clod's shape, which
// the mip rule above averages away by DETAIL_FADE_HI cycles per pixel (a lump
// 1 px across, ~72 m away at 1080p and 75° vertical field of view) and keeps
// whole up to DETAIL_FADE_LO (2 px, ~36 m). Its noise octaves fade before
// that by the same rule (grains.js clodOctaves).
const CLODS_FADE_M = DETAIL_FADE_HI * 2 * CLOD_LUMP_R * CELL_M;   // m per pixel
// Smooth up close (shaders/gfx/core.js cubicClose): sand's and liquids' smooth
// surfaces read their fields cubic wherever the trilinear reading's shape
// error would show, by the screen-space geometric error rule of terrain and
// mesh LOD: a coarse surface may stand in for the exact one while its error,
// projected to the screen, stays under τ pixels. Lindstrom et al. 1996
// ("Real-Time, Continuous Level of Detail Rendering of Height Fields", §6)
// single out τ = 1 px as "small enough that virtually no popping can be seen";
// Nanite's cluster LOD keeps its projected error under a pixel too. The cubic
// share is 0 while the error is under CUBIC_ERR_PX_NONE pixels and 1 from
// CUBIC_ERR_PX_FULL, one octave on: the shared geometry hand-off and its cost
// trade (gfx/lodFade.js GEOM_ERR_PX_*; at 1-2 px the drawn error would peak
// at 1.08 px across the blend).
// CUBIC_ERR is the error: the largest deviation in shape of the far reading
// (trilinear, blended toward cubic by the thin mask) from the cubic one,
// measured over 11 canonical clumps of 1-27 cells (lone, pair, line, L,
// square, diagonals, plus, 2³, 3³, a 5-cell-wide ball) for both cubic
// channels at their blur, boosted and masked as shaders/fields.js does, 600
// directions each (2026-10-17). The worst is a powder plus sign (sigma 0.75),
// whose trilinear arms stick out 0.23 cells; lone grains and drops, pairs,
// lines and Ls are boosted and read cubic anyway (error 0). Not counted: the
// B-spline's extra blur sits the cubic surface up to 0.25 cells further in all
// round, an offset rather than a shard, which the blend morphs over its octave
// (Hoppe's geomorphs, Progressive Meshes 1996, hide LOD pops the same way).
export const CUBIC_ERR = 0.23;            // cells
export const CUBIC_ERR_PX_NONE = GEOM_ERR_PX_NONE, CUBIC_ERR_PX_FULL = GEOM_ERR_PX_FULL;   // px
// = 17 mm/px: 12 m away at 1080p and 75° vertical field of view
// (2·tan(37.5°)/1080 = 1.42 mrad per pixel), all of it nearer than 6 m
const CUBIC_FADE_M = CUBIC_ERR * CELL_M / CUBIC_ERR_PX_NONE;   // m per pixel
// Smoke filaments start once their coarser octave (FINE_1_M = 20 cm, one
// cycle per lattice cell) passes the material LOD's fade-out (lodFade:
// DETAIL_FADE_HI cycles per pixel), which holds for a medium too: TAA
// converges to the pixel's box filter, zero at 1 cycle per pixel, and the
// along-ray averaging dims an octave at every distance alike (derivation in
// shaders/gfx/mediaDetail.js). At 1080p and 75° vertical FOV: 141 m. The
// finer media sampling and flow-following apply at any distance (no fadeM:
// always in).
const MEDIA_FINE_FADE_M = DETAIL_FADE_HI * FINE_1_M;   // m per pixel
// Smoke follows the flow (shaders/gfx/mediaDetail.js flowNoise) moves the base
// detail noise, so it shows while both of these hold, and is gone only once
// both fail:
// - the moved pattern is resolved. Its octaves (gfx/mediaNoise.js) are
//   MEDIA_NOISE_CELLS / {16, 8, 4} = 4, 8 and 16 cells (1.2, 2.4, 4.8 m) across;
//   by the material LOD rule the coarsest, which carries ~3/4 of the
//   variance (octave weights 0.57, 0.29, 0.14, squared), is averaged away at
//   DETAIL_FADE_HI cycles per pixel: 4.8 m per pixel.
// - the motion is resolved. A copy rides the flow for one cycle, then is
//   restarted; within it the pattern moves |v| · MEDIA_FLOW_PERIOD cells, at
//   most FLOW_MAX · MEDIA_FLOW_PERIOD = 16 cells = 4.8 m. Motion under a pixel
//   per cycle is not drawn (the restarts crossfade it, TAA averages it).
// Both end at 4.8 m per pixel: 3.4 km at 1080p and 75° vertical field of view
// (a pixel spans 2 tan(37.5°) / 1080 = 1.42 mrad). Typical smoke and steam
// (rise 0.0625 cells/step, gfx/materials.js MEDIA) travel 1 cell a cycle,
// under a pixel past 0.3 m per pixel (211 m). Both lie past every media sample
// the views march (gas lives in the sim's grid: a box, or the World's window
// around the player), so the feature has no runtime fade, and as fadeM is above
// detailGate's GATE_ALWAYS_M the Box view keeps it in its base variant.
const FLOW_TRAVEL_CELLS = FLOW_MAX * MEDIA_FLOW_PERIOD;
const NOISE_COARSEST_CELLS = 64 / 4;         // MEDIA_NOISE_CELLS / BILLOW_PERIODS[0] (gfx/mediaNoise.js)
const MEDIA_FLOW_FADE_M = DETAIL_FADE_HI * Math.max(FLOW_TRAVEL_CELLS, NOISE_COARSEST_CELLS) * CELL_M;   // m per pixel
// Liquid ripples (shaders/gfx/liquidDetail.js): each octave of wavelength λ is
// drawn as normals while a pixel spans up to DETAIL_FADE_LO·λ (Nyquist) and is
// gone by DETAIL_FADE_HI·λ (the material LOD above), so the normals end once the
// longest octave (CAP_LAMBDA_MAX_M, 24.5 cm) passes the fade-out: 24.5 cm per
// pixel, ~172 m away at 1080p and a 75° vertical field of view (2·tan 37.5° /
// 1080 = 1.42 mrad per pixel); the finest (1.7 cm) is fully drawn to 6 m and
// gone by 12 m. Past its fade an octave's slope variance is the glint's
// roughness (specular anti-aliasing), so in the box the feature shows at any
// distance: fadeM Infinity. Whitewater follows speed at any
// distance (no fadeM).
export const RIPPLE_FADE_M = DETAIL_FADE_HI * CAP_LAMBDA_MAX_M;   // m per pixel: the ripples' normals end
// The meniscus (liquidDetail.js liquidMeniscus) rises h0·exp(-x/lc) over the
// capillary length lc = √(σ/ρg): a low-pass whose wavelength is λm = 2π·lc,
// 1.7 cm for water (σ 0.072 N/m, ρ 1000 kg/m³), the widest of the liquids it
// models (MENISCUS_LAMBDA_MAX_M there; tools/volume-id-cpu-check.mjs holds the
// two equal). The shader fades it with lodFade at 1/λm: whole while a pixel
// spans up to DETAIL_FADE_LO of λm, gone at DETAIL_FADE_HI. At 1080p and a 75°
// vertical FOV (1.42 mrad per pixel) that is whole to 6 m and gone by 12 m.
const MENISCUS_LAMBDA_M = 2 * Math.PI * Math.sqrt(0.072 / (1000 * 9.81));   // m
const MENISCUS_FADE_M = DETAIL_FADE_HI * MENISCUS_LAMBDA_M;   // m per pixel

// Costs below: extra GPU ms per frame at 1280×800 on the M-series laptop
// (tools/detail-bench.mjs, 2026-10-08, after all features were merged and
// distance-gated), worst camera of lab / volcano / plume. The GPU was still
// shared with other sessions (identical shaders varied by ~±3 ms), so small
// figures are the features' own 25-round runs. God view: ~0 for every gated
// feature.
export const DETAIL = [
  // high: volcano eyeSummit +17, eyeFlank +12 ms
  { key: 'grains', define: 'DETAIL_GRAINS', label: 'Pebbles and grains up close', cost: 'high', fadeM: GRAINS_FADE_M,
    desc: 'Up close, rubble is a pile of real broken-rock chips (~5 cm): faces, edges, gaps and contact shadows instead of a texture' },
  // high: volcano eyeFlank +14, lab +9 ms
  { key: 'grainClusters', define: 'DETAIL_GRAIN_CLUSTERS', label: 'Loose clumps up close', cost: 'high', fadeM: CLODS_FADE_M,
    desc: 'Up close, a lone cell of sand, snow, powder or ash is a lumpy 30 cm clod instead of a round blob' },
  // high: plume fireNear +16, smokeIn / steamNear +9 ms (shaders/gfx/mediaDetail.js)
  { key: 'mediaFine', define: 'DETAIL_MEDIA_FINE', label: 'Smoke filaments', cost: 'high', fadeM: MEDIA_FINE_FADE_M,
    desc: 'Fine wisps and filaments (20 cm and 5 cm) in smoke, steam and flames when you are close to them' },
  // medium: plume smokeIn / steamNear +1.9 ms (the old rule: step = distance / 8, every sample lit).
  // Since 2026-10-17 the step is 40 pixel footprints (shaders/gfx/mediaDetail.js MEDIA_STEP_PX) and
  // only the density is sampled finely, light stays at the base rate: about the old cost at 1080p,
  // a quarter less at 1280×800 (static estimate; re-measure). No fadeM: the rule itself reaches the
  // base step from MEDIA_STEP_BASE_M (7.5 mm per pixel) on, so a far view gets nothing to gate, and
  // its compile cost is small (cold Metal, 2026-10-17: World 16.3 s vs 19.6 s without, as its
  // per-segment loop stays rolled where the 2-sample one unrolls; Box 5.3 s vs 4.6 s). Kept a switch: the Off
  // level (phones, MOBILE_DEFAULTS) opts out of its near-gas cost.
  { key: 'mediaStep', define: 'DETAIL_MEDIA_STEP', label: 'Fine smoke sampling', cost: 'medium',
    desc: 'Samples smoke, steam and fire more finely near the camera: crisper wisps, less grain' },
  // high: plume fireNear +5.9, smokeIn / steamNear +3-4 ms
  { key: 'mediaFlow', define: 'DETAIL_MEDIA_FLOW', label: 'Smoke follows the flow', cost: 'high', fadeM: MEDIA_FLOW_FADE_M,
    desc: 'Wisps of smoke, steam and fire ride the simulated flow instead of a steady rise' },
  // medium (estimated): lab eyeSandClose (standing on the pile) +5 to +24 % of the view in three
  // runs, eyeTank and volcano eyeFlank within noise, 2026-10-11. The GPU was saturated by other
  // sessions (the god view, where the gate leaves it out, read +3 ms), so re-measure on a quiet one.
  // Re-measure anyway: since 2026-10-17 the fade (CUBIC_ERR) reaches ~4x further, the god view
  // included, while a cubic hit costs 10-38 % fewer fetches (analytic normals, one call site each).
  { key: 'smoothClose', define: 'DETAIL_CUBIC_CLOSE', label: 'Smooth sand and water up close', cost: 'medium', fadeM: CUBIC_FADE_M,
    desc: 'Clumps of falling sand, snow and powder and splashes of liquid stay round right in front of you, instead of turning into flat-faced shards' },
  // low: ~0 ms (25 rounds at eyeTank: -0.3; within noise) (shaders/gfx/liquidDetail.js)
  { key: 'liquidRipples', define: 'DETAIL_LIQ_RIPPLES', label: 'Liquid ripples', cost: 'low', fadeM: Infinity,
    desc: 'Centimetre capillary ripples on open liquid, fading in as you get close' },
  // low: ~0 ms (25 rounds at eyeTank; within noise)
  { key: 'liquidMeniscus', define: 'DETAIL_LIQ_MENISCUS', label: 'Liquid meniscus', cost: 'low', fadeM: MENISCUS_FADE_M,
    desc: 'Liquid climbing walls and glass over its last few millimetres' },
  // medium: 1.4 ms at eyeTank (25 rounds), before the aeration field. Its
  // per-step pass (gfx/foam.js) added ~0.4 ms a step on a 128³ grid with a
  // pool over the whole floor (7 interleaved rounds, 2026-10-10), ~1.6 ms a
  // frame at 4 steps, while it ran over every brick holding liquid; it now
  // runs only where records may change (near drawn liquid, or foam still
  // bursting), so a settled pool costs its list kernel alone (re-measure:
  // the pour / pourAfter presets of tools/detail-bench.mjs add the step cost
  // to the tier). No fadeM: its coverage is a low-frequency albedo change
  // that reads from any distance (whitecap coverage is measured from orbit:
  // Anguelova & Webster 2006, satellite microwave radiometry), so
  // it never fades; only its texture does, per noise by lodFade (the raft's
  // 12 cm patches by 84 m, its 4 cm clusters by 28 m, the 15 cm churn by
  // 106 m at 1080p and 75° vertical), its mean kept in the albedo
  // (shaders/gfx/liquidDetail.js liquidFoam).
  { key: 'liquidFoam', define: 'DETAIL_LIQ_FOAM', label: 'Whitewater', cost: 'medium',
    desc: 'Liquid that plunges or lands hard turns white with foam that drifts on the flow and bursts over a few seconds; long falls tear into spray' },
];

// Features whose realistic module SwiftShader (the software adapter: the test
// container, ?software=1) builds within budget but can't draw: its GPU
// process crashes (SIGSEGV, exit code 11) compiling the shader at the first
// draw, ~15 s in, and the device is lost (Chromium 141, 2026-10-11; each of
// these alone does it, every other feature draws). On a fallback adapter the
// volume leaves them out (gfx/volume.js), and shaders/render.js lists the
// variants holding them on WGSL_MAC_ONLY; a real GPU draws them.
export const SOFTWARE_UNDRAWABLE = ['DETAIL_GRAINS', 'DETAIL_GRAIN_CLUSTERS'];
/** A defines object as a device draws it: on a software adapter (fallback) without SOFTWARE_UNDRAWABLE. */
export const drawableDetail = (detail, fallback) =>
  (fallback ? Object.fromEntries(Object.entries(detail).filter(([k]) => !SOFTWARE_UNDRAWABLE.includes(k))) : detail);

export const settingKey = (f) => `detail_${f.key}`;

// settings defaults for every feature, by cost tier
export const detailDefaults = () => Object.fromEntries(DETAIL.map((f) => [settingKey(f), COST[f.cost].on]));

// the defines object (shaders/render.js volumeFrag's detail) for the features switched on in `settings`
export const detailDefines = (settings) =>
  Object.fromEntries(DETAIL.filter((f) => settings[settingKey(f)]).map((f) => [f.define, 1]));

// every feature on (shaders/render.js WGSL_CHECK builds this variant too)
export const allDetailDefines = () => Object.fromEntries(DETAIL.map((f) => [f.define, 1]));

// Levels for the one visible control: none, the cost-tier defaults, every feature.
export const DETAIL_LEVELS = { off: () => false, balanced: (f) => COST[f.cost].on, full: () => true };
const LEVEL_LABELS = [['off', 'Off'], ['balanced', 'Balanced'], ['full', 'Full']];
// the level the switches match, or 'custom'
export function detailLevelOf(settings) {
  for (const [k, on] of Object.entries(DETAIL_LEVELS)) if (DETAIL.every((f) => !!settings[settingKey(f)] === on(f))) return k;
  return 'custom';
}
export function setDetailLevel(settings, level) {
  for (const f of DETAIL) settings[settingKey(f)] = DETAIL_LEVELS[level](f);
}

// Settings rows (ui/settings.js): the level, then under "Customize" one switch
// per feature, cheapest first, each labelled with its cost tier.
const TIER_ORDER = ['low', 'medium', 'high'];
export const detailRows = (settings, onChange) => [
  { type: 'seg', key: 'detailLevel', value: () => detailLevelOf(settings), options: LEVEL_LABELS,
    onChange: (v) => { setDetailLevel(settings, v); onChange(); } },
  { type: 'more', label: 'Customize', rows: [...DETAIL]
    .sort((a, b) => TIER_ORDER.indexOf(a.cost) - TIER_ORDER.indexOf(b.cost))
    .map((f) => ({ type: 'switch', key: settingKey(f), label: f.label, desc: f.desc, badge: COST[f.cost].label, tier: f.cost, onChange })) },
];
