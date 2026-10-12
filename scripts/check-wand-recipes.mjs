// Every preset wand cast on a small world (64×32×32), its effects checked in
// the cells: the POV harness page's recipes stage (tools/harness/pov-check.js:
// a Simulation of its own device, no app). CPU timings include scheduling and
// GPU submission, not GPU execution or full-game rendering. Owns its Vite
// server and browser.
// node scripts/check-wand-recipes.mjs [--port N]
import { runStages } from '../tools/pov-gpu-check.mjs';

process.exit(await runStages(['recipes']) ? 1 : 0);
