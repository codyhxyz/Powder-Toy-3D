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
// A feature compiles in only when on: the shaders see `#define <define> 1`
// (three.js material defines), so a switched-off feature costs nothing.

import { CELL_M } from '../scale.js';

export const BENCH_W = 1280, BENCH_H = 800;   // px, the benchmark viewport

// Cost tiers, by extra GPU ms per frame (measured as above).
export const COST_LOW_MS = 0.5;       // below this: low
export const COST_MEDIUM_MS = 2;      // below this: medium; above it: high
export const COST = {
  low: { label: 'Low cost', on: true },
  medium: { label: 'Medium cost', on: true },
  high: { label: 'High cost', on: false },
};
export const costTier = (ms) => (ms < COST_LOW_MS ? 'low' : ms < COST_MEDIUM_MS ? 'medium' : 'high');

// The features. key: settings key suffix; define: GLSL macro; label: the
// setting's name; desc: tooltip; cost: tier from tools/detail-bench.mjs
// (put the measured ms in a comment next to it); fadeM: pixel footprint
// (metres per pixel) above which the feature draws nothing, so the view
// shader leaves it out (gfx/detailGate.js). Infinity = always in.
// Relief (shaders/gfx/relief.js) starts once its tallest feature, rock crags
// (top ≈ 17.5 mm), spans RELIEF_PX_LO = 1 pixel.
const RELIEF_FADE_M = 0.0175;   // m per pixel
// Grains (shaders/gfx/grains.js) start where a pebble (PEBBLE_M = 5 cm) or a
// clod's lump (2 · CLOD_LUMP_R = 0.34 cells ≈ 10 cm) spans 8 pixels (*_PX_NONE).
const GRAINS_FADE_M = 0.05 / 8;           // m per pixel
const CLODS_FADE_M = 0.34 * CELL_M / 8;   // m per pixel
// Smoke filaments start once their coarser octave (FILAMENT_1_M = 20 cm)
// passes the material LOD's fade-out (lodFade: DETAIL_FADE_HI = 0.4 cycles per
// pixel). The finer media sampling and flow-following apply at any distance
// (no fadeM: always in).
const MEDIA_FINE_FADE_M = 0.4 * 0.2;   // m per pixel
// Liquid ripples (shaders/gfx/liquidDetail.js) start as their longest new
// octave (24.5 cm) passes the same fade-out; the meniscus, over the capillary
// length (2.7 mm for water), is averaged away once a pixel spans more than
// MENISCUS_PX of them. Whitewater follows speed at any distance (no fadeM).
const RIPPLE_FADE_M = 0.4 * 0.245;      // m per pixel
const MENISCUS_PX = 4;                  // capillary lengths per pixel
const MENISCUS_FADE_M = MENISCUS_PX * 0.0027;   // m per pixel

export const DETAIL = [
  // relief: extra ms, worst camera: lab ~6-12 (eyeSandClose), volcano ~6 (eyeFlank). Measured on
  // a shared GPU (identical shaders varied by up to ±8 ms), so high until re-measured quiet.
  { key: 'relief', define: 'DETAIL_RELIEF', label: 'Surface relief up close', cost: 'high', fadeM: RELIEF_FADE_M,
    desc: 'Sand, snow, ash, gunpowder, rock and wood get real relief when you are close: crags, clumps and bark furrows with true outlines and parallax' },
  { key: 'grains', define: 'DETAIL_GRAINS', label: 'Pebbles and grains up close', fadeM: GRAINS_FADE_M,
    desc: 'Up close, gravel is a pile of real pebbles (~5 cm): outlines, gaps and contact shadows instead of a texture',
    cost: 'high' },   // worst +30 ms (volcano eyeSummit, 11 rounds; god view +4.6 ms: shader size)
  { key: 'grainClusters', define: 'DETAIL_GRAIN_CLUSTERS', label: 'Loose clumps up close', fadeM: CLODS_FADE_M,
    desc: 'Up close, a lone cell of sand, snow, powder or ash is a lumpy 30 cm clod instead of a round blob',
    cost: 'high' },   // worst +15.5 ms (volcano eyeFlank; god view +7 ms: shader size, see gfx/grains.js)
  // Smoke, steam and fire up close (shaders/gfx/mediaDetail.js). Measured on a
  // shared, heavily contended GPU (bench base 27-86 ms instead of ~13, noise
  // +-6 ms per camera), so tiers come from a smoke-filled close-up scene too
  // (eye inside / beside plumes, 9 A/B rounds), where these features matter:
  //   mediaFine  bench worst 3.3 ms (lab eyeSandClose, ~noise); plumes +14-25 ms
  //              on a ~90 ms contended frame (~20%): high
  //   mediaStep  bench worst 4.8 ms (volcano eyeFlank, noise: other runs 0.0, 0.7);
  //              plumes +0.2-6 ms (one 17.6 outlier): medium
  //   mediaFlow  bench worst 7.1 ms (lab eyeTank; other runs 0.7, 1.7); plumes
  //              +7-15 ms, measured with the transmittance gate it no longer
  //              has (the gate drew rings), so somewhat more now: high
  { key: 'mediaFine', define: 'DETAIL_MEDIA_FINE', label: 'Smoke filaments', fadeM: MEDIA_FINE_FADE_M,
    desc: 'Fine wisps and filaments (20 cm and 5 cm) in smoke, steam and flames when you are close to them', cost: 'high' },
  { key: 'mediaStep', define: 'DETAIL_MEDIA_STEP', label: 'Fine smoke sampling',
    desc: 'Samples smoke, steam and fire more finely near the camera: crisper wisps, less grain', cost: 'medium' },
  { key: 'mediaFlow', define: 'DETAIL_MEDIA_FLOW', label: 'Smoke follows the flow',
    desc: 'Wisps of smoke, steam and fire ride the simulated flow instead of a steady rise', cost: 'high' },
  { key: 'liquidRipples', define: 'DETAIL_LIQ_RIPPLES', label: 'Liquid ripples', fadeM: RIPPLE_FADE_M,
    desc: 'Centimetre capillary ripples on open liquid, fading in as you get close.', cost: 'low' },   // ~0 ms (−0.3 eyeTank, 25 rounds; within noise)
  { key: 'liquidMeniscus', define: 'DETAIL_LIQ_MENISCUS', label: 'Liquid meniscus', fadeM: MENISCUS_FADE_M,
    desc: 'Liquid climbing walls and glass over its last few millimetres.', cost: 'low' },   // ~0 ms (−1.7 eyeTank, 25 rounds; within noise)
  { key: 'liquidFoam', define: 'DETAIL_LIQ_FOAM', label: 'Whitewater',
    desc: 'Falling and splashing liquid roughens and foams where it moves fast.', cost: 'medium' },   // 1.4 ms eyeTank (25 rounds), 1.2–2.4 in 7-round runs; GPU shared with other benches
];

export const settingKey = (f) => `detail_${f.key}`;

// settings defaults for every feature, by cost tier
export const detailDefaults = () => Object.fromEntries(DETAIL.map((f) => [settingKey(f), COST[f.cost].on]));

// three.js `defines` for the features switched on in `settings`
export const detailDefines = (settings) =>
  Object.fromEntries(DETAIL.filter((f) => settings[settingKey(f)]).map((f) => [f.define, 1]));

// every feature on (tools/check-shaders.mjs compiles this variant too)
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
