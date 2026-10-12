// Check of the first-person body (src/pov/player.js) on WebGPU: small scenes
// on a 64³ world in the POV tools' harness page (tools/harness/pov-tools.js,
// stage player: no app to boot), the body's frames and the world's steps run
// by hand (a 20 fps app's frames: BODY_DT of body time, 4 steps each), and
// its numbers printed: falls, a sand pile, ledges, a wall, water and oil,
// drowning, lava, a blast, a fire, and how a wading body pushes water (the
// old floor test is `falls`: a test named like Math.floor trips
// check-async-reads). The tests run in parts, each in a browser of its own: as
// many as fit in pov-gpu-check.mjs's BUDGET_MS, then the rest in the next
// (runStages).
// By default only the tests that fit a part here run: falls, sandPile, stepUp,
// wall (two parts, 143 s and 35 s). The others (water, oil, drown, lava,
// blast, fire, coupling) keep the 64³ box awake for their whole run (a pool's
// waves, a blast, a fire), which costs SwiftShader most of a second a step:
// oil alone took 106 to 168 s, each of the rest alone ran past 4 minutes,
// water past 9, so they run when named (--only) or with --all. Their
// witnesses in the container: pov-body-cpu-check (the body itself in water,
// oil, lava, drowning, a blast and hot gas, over a mock probe), pov-gpu-check's
// probes stage (the probe reads cells, temperature and pressure exactly) and
// its edits stage's povCouple (the body pushes the water it stands in).
// usage: node tools/pov-player-check.mjs [--port N] [--only name,name | --all]   (its own Vite: tools/vite-server.mjs)
import { runStages, TOOLS_PAGE, BUDGET_MS } from './pov-gpu-check.mjs';

const DEFAULT = ['falls', 'sandPile', 'stepUp', 'wall'];
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const named = opt('only', '')?.split(',').filter(Boolean);
const only = named.length ? named : args.includes('--all') ? null : DEFAULT;
process.exit(await runStages([['player', { only, budgetMs: BUDGET_MS }]], { page: TOOLS_PAGE }) ? 1 : 0);
