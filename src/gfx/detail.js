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
// (ROCK_CRAG_H · RELIEF_CRAG_TOP ≈ 5.6 mm), spans RELIEF_PX_LO = 1 pixel.
const RELIEF_FADE_M = 0.0056;   // m per pixel
// Grains (shaders/gfx/grains.js) start where a pebble (PEBBLE_M = 5 cm) or a
// clod's lump (2 · CLOD_LUMP_R = 0.34 cells ≈ 10 cm) spans 8 pixels (*_PX_NONE).
const GRAINS_FADE_M = 0.05 / 8;           // m per pixel
const CLODS_FADE_M = 0.34 * CELL_M / 8;   // m per pixel

export const DETAIL = [
  // relief: extra ms, worst camera: lab ~6-12 (eyeSandClose), volcano ~6 (eyeFlank). Measured on
  // a shared GPU (identical shaders varied by up to ±8 ms), so high until re-measured quiet.
  { key: 'relief', define: 'DETAIL_RELIEF', label: 'Surface relief up close', cost: 'high', fadeM: RELIEF_FADE_M,
    desc: 'Sand, snow, ash, gunpowder, rock and wood get real relief when you are close: crags, clumps and bark furrows with true outlines and parallax' },
  // reliefShadow: relief + shadow vs off (bench --all): lab ~5, volcano ~20-26 ms; same caveat.
  { key: 'reliefShadow', define: 'DETAIL_RELIEF_SHADOW', label: 'Relief self-shadowing', cost: 'high', fadeM: RELIEF_FADE_M,
    desc: 'The close-up relief casts sunlight shadows on itself (needs Surface relief up close)' },
  { key: 'grains', define: 'DETAIL_GRAINS', label: 'Pebbles and grains up close', fadeM: GRAINS_FADE_M,
    desc: 'Up close, gravel is a pile of real pebbles (~5 cm): outlines, gaps and contact shadows instead of a texture',
    cost: 'high' },   // worst +30 ms (volcano eyeSummit, 11 rounds; god view +4.6 ms: shader size)
  { key: 'grainClusters', define: 'DETAIL_GRAIN_CLUSTERS', label: 'Loose clumps up close', fadeM: CLODS_FADE_M,
    desc: 'Up close, a lone cell of sand, snow, powder or ash is a lumpy 30 cm clod instead of a round blob',
    cost: 'high' },   // worst +15.5 ms (volcano eyeFlank; god view +7 ms: shader size, see gfx/grains.js)
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
