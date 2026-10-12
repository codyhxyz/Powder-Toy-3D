// The wands' world on WebGPU (src/pov/wands/world.js): every effect, the
// batch bound (64 commands, one edit), traces (128 segments in one probe, the
// floor, entry from outside, window shifts) and full-body clearance. Runs the
// POV harness page's wands stage (tools/harness/pov-check.js: a Simulation
// of its own device, no app); owns its Vite server and browser.
// node scripts/check-wand-world.mjs [--port N]
import { runStages } from '../tools/pov-gpu-check.mjs';

process.exit(await runStages(['wands']) ? 1 : 0);
