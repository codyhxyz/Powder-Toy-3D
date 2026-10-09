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
// (put the measured ms in a comment next to it).
export const DETAIL = [
  // relief: extra ms, worst camera: lab ~6-12 (eyeSandClose), volcano ~6 (eyeFlank). Measured on
  // a shared GPU (identical shaders varied by up to ±8 ms), so high until re-measured quiet.
  { key: 'relief', define: 'DETAIL_RELIEF', label: 'Surface relief up close', cost: 'high',
    desc: 'Sand, snow, ash, gunpowder, rock and wood get real relief when you are close: crags, clumps and bark furrows with true outlines and parallax' },
];

export const settingKey = (f) => `detail_${f.key}`;

// settings defaults for every feature, by cost tier
export const detailDefaults = () => Object.fromEntries(DETAIL.map((f) => [settingKey(f), COST[f.cost].on]));

// three.js `defines` for the features switched on in `settings`
export const detailDefines = (settings) =>
  Object.fromEntries(DETAIL.filter((f) => settings[settingKey(f)]).map((f) => [f.define, 1]));

// every feature on (tools/check-shaders.mjs compiles this variant too)
export const allDetailDefines = () => Object.fromEntries(DETAIL.map((f) => [f.define, 1]));

// Settings rows (ui/settings.js switch rows), one per feature, cheapest first.
const TIER_ORDER = ['low', 'medium', 'high'];
export const detailRows = (onChange) => [...DETAIL]
  .sort((a, b) => TIER_ORDER.indexOf(a.cost) - TIER_ORDER.indexOf(b.cost))
  .map((f) => ({ type: 'switch', key: settingKey(f), label: f.label, desc: f.desc, badge: COST[f.cost].label, tier: f.cost, onChange }));
