// Check of the first-person body (src/pov/player.js) on WebGPU: small scenes
// on a 64³ world in the POV tools' harness page (tools/harness/pov-tools.js,
// stage player: no app to boot), the body's frames and the world's steps run
// by hand (a 20 fps app's frames: BODY_DT of body time, 4 steps each), and
// its numbers printed: falls, a sand pile, ledges, a wall, water and oil,
// drowning, lava, a blast, a fire, and how a wading body pushes water (the
// old floor test is `falls`: a test named like Math.floor trips
// check-async-reads). Two
// browsers by default, each well under 3 minutes here.
// usage: node tools/pov-player-check.mjs [--port N] [--only name,name]   (its own Vite: tools/vite-server.mjs)
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', '')?.split(',').filter(Boolean);
const GROUPS = [['falls', 'sandPile', 'stepUp', 'wall', 'blast', 'fire'], ['water', 'oil', 'drown', 'lava', 'coupling']];
const runs = only.length ? [['player', { only }]] : GROUPS.map((g) => ['player', { only: g }]);
process.exit(await runStages(runs, { page: TOOLS_PAGE }) ? 1 : 0);
