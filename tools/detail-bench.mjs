// Cost of each close-up detail feature (src/gfx/detail.js), for its cost tier.
// Builds a scene on the volume's harness page (tools/harness/volume.html:
// the app's presets, or the plume and pour scenes painted while the
// simulation runs), then for each camera (the god view and eye-level
// close-ups, the POV-mode worst case) times the realistic view's scene pass
// with the feature off and on (every other feature off), alternating A/B
// rounds, in GPU ms from timestamp queries (docs/webgpu.md B8), and prints the
// median extra GPU ms per frame and the tier that gives. The two variants are
// separate pipelines (shaders/render.js volumeFrag(g, { detail })), each built
// before it is timed. Features with per-step work (Whitewater's aeration
// field) also pay per simulation step: that is timed with the world stepping,
// times the app's default steps per frame, and added to the worst camera's
// figure (it needs the aeration attached: src/wire/foam.js, U12).
// The figures that set the tiers come from the Mac (BENCH_W×BENCH_H, 128³);
// SwiftShader runs the view on the CPU, so in the container use a small
// viewport and grid to see it run: --size 64 --viewport 160x100 --cams god --rounds 1.
// usage: node tools/detail-bench.mjs [--port 5606] [--preset lab|volcano|plume|pour|pourAfter|test] [--cams eyeSand,god]
//        [--features relief,grains] [--shots outDir] [--size 128] [--viewport 1280x800] [--rounds 7] [--frames 20] [--steps 900]
// Noise: identical shaders differ by up to ~0.4 ms per camera; rerun a tier
// that sits near a COST_*_MS boundary.
//        --all  also times every feature on at once against all off
import { mkdirSync, writeFileSync } from 'fs';
import { launchBrowser } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { BENCH_W, BENCH_H, DETAIL, costTier } from '../src/gfx/detail.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const shots = opt('shots', '');
const only = opt('features', '');
const features = DETAIL.filter((f) => !only || only.split(',').includes(f.key));
if (shots) mkdirSync(shots, { recursive: true });

const SIM_STEPS = Number(opt('steps', '900'));   // the lab sand has landed and piled
const ROUNDS = Number(opt('rounds', '7'));       // A/B rounds per feature and camera (median taken)
const FRAMES = Number(opt('frames', '20'));      // renders per timing sample (median)
const SIZE = Number(opt('size', '128'));         // the grid (the cameras below are the 128³ layout's)
const VIEWPORT = (opt('viewport', `${BENCH_W}x${BENCH_H}`)).split('x').map(Number);
// Cameras (128³ layout, grid cells). null = the home (god) view. Eye
// cameras stand a POV-height body on whatever is under `feet` = [x, z]
// (the top non-gas cell) and look at the ground under `look` = [x, z],
// LOOK_DROP cells below eye height there.
const EYE_H = 5;       // cells from the ground to the eye (POV body ≈ 5.5 cells tall)
const LOOK_DROP = 3;   // cells
const CAMS = {
  lab: {
    god: null,
    eyeSand: { feet: [80, 66], look: [86, 38] },    // the sand pile that falls in the lab
    eyeSandClose: { feet: [86, 52], look: [86, 40] }, // standing on the pile, looking down its slope
    eyeTank: { feet: [70, 82], look: [60, 64] },    // glass tank of water, oil on top
    eyeWood: { feet: [45, 105], look: [27, 87] },   // the wooden tower
  },
  volcano: {
    god: null,
    eyeFlank: { feet: [104, 64], look: [84, 64] },  // on the rock flank looking up: trees, snow
    eyeSummit: { feet: [72, 72], look: [64, 64] },  // at the vent: lava, stone
  },
  // The lab with plumes painted in (PLUME below): media close up. Fixed
  // [eye, target] cameras, in and beside the plumes.
  plume: {
    god: null,
    smokeIn: [[42, 16, 105], [50, 20, 116]],
    steamNear: [[73, 14, 103], [66, 18, 114]],
    fireNear: [[57, 8, 79], [57, 9, 88]],
  },
};
// The plume scene: on the freshly loaded lab, a wood fire burns for
// PLUME_FIRE_STEPS while smoke and steam columns are painted for PLUME_STEPS.
const PLUME = {
  base: 'lab', steps: 90, fireSteps: 30,
  wood: { at: [57, 2, 88], r: 4 }, fire: { at: [57, 7, 88], r: 4 },
  smoke: { x: 48, z: 112, r: 3 }, steam: { x: 66, z: 112, r: 3 }, columnYs: [4, 14, 24],
};
// The pour scene: a jet of water falls ~10 m from POUR.at into the volcano's
// sea (8 cells deep at that corner) for POUR.steps; pourAfter then lets the
// world run POUR.after more steps with the jet off (lingering foam).
const POUR = { base: 'volcano', at: [14, 40, 14], r: 3, steps: 150, after: 90 };
CAMS.pour = {
  god: null,
  pourSide: [[34, 14, 32], [14, 12, 14]],    // the falling jet and where it plunges, from ~7 m
  plunge: [[24, 11, 22], [14, 7, 14]],       // the plunge pool from ~3.5 m
};
CAMS.pourAfter = { pourSide: CAMS.pour.pourSide, plunge: CAMS.pour.plunge };
const STEP_FRAMES = 30;     // simulation steps per step-cost sample
const APP_STEPS = 4;        // the app's default steps per frame (src/app.js DEFAULTS.steps)
const preset = opt('preset', 'lab');
const isPour = preset === 'pour' || preset === 'pourAfter';
const loadName = preset === 'plume' ? PLUME.base : isPour ? POUR.base : preset;
const camSel = opt('cams', '');
const cams = Object.fromEntries(Object.entries(CAMS[preset] ?? { god: null }).filter(([k]) => !camSel || camSel.split(',').includes(k)));

const vite = await startVite({ harness: true, port: Number(opt('port', '5606')) });
const b = await launchBrowser();
const errs = [];
const rows = [];
try {
  const p = await openHarness(b, vite, `/tools/harness/volume.html?size=${SIZE}`, { errors: errs, timeout: 180000, viewport: { width: VIEWPORT[0], height: VIEWPORT[1] } });
  const run = (name, arg) => p.evaluate(([n, a]) => window.__harness.run(n, a), [name, arg]);
  await run('benchScene', {
    scene: loadName, steps: preset === 'plume' || isPour ? 0 : SIM_STEPS,
    plume: preset === 'plume' ? PLUME : null, pour: isPour ? { ...POUR, after: preset === 'pourAfter' ? POUR.after : 0 } : null,
  });
  const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  const defines = (list) => Object.fromEntries(list.map((f) => [f.define, 1]));
  const timeView = async (detail, shot = null) => {
    const r = await run('gpuTime', { view: 'realistic', detail, frames: FRAMES, viewport: VIEWPORT, shot: !!shot });
    if (r.error) throw new Error(r.error);
    if (shot && r.shot) writeFileSync(shot, Buffer.from(r.shot, 'base64'));
    return r.median;
  };
  async function abCost(on, cam, name) {
    await run('benchCam', { cam, eyeH: EYE_H, lookDrop: LOOK_DROP });
    const base = [], with_ = [];
    for (let r = 0; r < ROUNDS; r++) {
      base.push(await timeView({}, shots && r === 0 ? `${shots}/${name}-off.png` : null));
      with_.push(await timeView(on, shots && r === 0 ? `${shots}/${name}-on.png` : null));
    }
    return { base: median(base), on: median(with_), extra: median(with_.map((v, i) => v - base[i])) };
  }
  // the per-step cost: only Whitewater has one, and only with its aeration attached (U12)
  const stepCost = async (f) => {
    if (f?.key !== 'liquidFoam') return null;
    const st = await run('stepTime', { steps: STEP_FRAMES });
    return { base: st.ms, on: null, extra: null };
  };

  const sets = features.map((f) => [f.key, defines([f]), f]);
  if (args.includes('--all')) sets.push(['ALL', defines(DETAIL), null]);
  for (const [key, on, f] of sets) {
    let worst = 0;
    for (const [camName, cam] of Object.entries(cams)) {
      const r = await abCost(on, cam, `${key}-${camName}`);
      worst = Math.max(worst, r.extra);
      rows.push({ feature: key, cam: camName, 'base ms': r.base.toFixed(2), 'on ms': r.on.toFixed(2), 'extra ms': r.extra.toFixed(2) });
    }
    const st = await stepCost(f);
    if (st) rows.push({ feature: key, cam: `steps ×${APP_STEPS}`, 'base ms': (st.base * APP_STEPS).toFixed(2), 'on ms': 'n/a (no aeration attached: U12)', 'extra ms': '' });
    rows.push({ feature: key, cam: 'WORST', 'extra ms': worst.toFixed(2), tier: costTier(worst), declared: f?.cost ?? '' });
  }
} finally {
  await b.close();
  await vite.close();
}
console.table(rows);
console.log(errs.length ? errs.join('\n') : 'no console errors');
