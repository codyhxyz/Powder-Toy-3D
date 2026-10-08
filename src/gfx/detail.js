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
  // Smoke, steam and fire up close (shaders/gfx/mediaDetail.js). Measured on a
  // shared, heavily contended GPU (bench base 27-86 ms instead of ~13, noise
  // +-6 ms per camera), so tiers come from a smoke-filled close-up scene too
  // (eye inside / beside plumes, 9 A/B rounds), where these features matter:
  //   mediaFine  bench worst 3.3 ms (lab eyeSandClose, ~noise); plumes +14-25 ms
  //              on a ~90 ms contended frame (~20%): high
  //   mediaStep  bench worst 4.8 ms (volcano eyeFlank, noise: other runs 0.0, 0.7);
  //              plumes +0.2-6 ms (one 17.6 outlier): medium
  //   mediaFlow  bench worst 7.1 ms (lab eyeTank; other runs 0.7, 1.7); plumes
  //              +7-15 ms: high
  { key: 'mediaFine', define: 'DETAIL_MEDIA_FINE', label: 'Smoke filaments',
    desc: 'Fine wisps and filaments (20 cm and 5 cm) in smoke, steam and flames when you are close to them', cost: 'high' },
  { key: 'mediaStep', define: 'DETAIL_MEDIA_STEP', label: 'Fine smoke sampling',
    desc: 'Samples smoke, steam and fire more finely near the camera: crisper wisps, less grain', cost: 'medium' },
  { key: 'mediaFlow', define: 'DETAIL_MEDIA_FLOW', label: 'Smoke follows the flow',
    desc: 'Wisps of smoke, steam and fire ride the simulated flow instead of a steady rise', cost: 'high' },
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
