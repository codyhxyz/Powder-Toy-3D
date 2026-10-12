// Check of the POV axe and physgun (src/pov/tools/): each tool's real code
// driven with a hand-built ctx on a 32³ world in the POV tools' harness page
// (tools/harness/pov-tools.js, stage hand: no app to boot), the world stepped
// a frame at a time. The axe breaks wood, glass, ice and plant into their
// debris cell for cell and leaves rock and metal, nothing made or lost; the
// physgun lifts a block of sand and of water to a hold point 12 cells up,
// flings it along the aim, and conserves it. One browser for the axe and one
// for each of the physgun's materials, each within a few minutes here. The
// gun's rounds are tools/gp-gun.mjs's and pov-gpu-check's (probes, edits).
// usage: node tools/pov-tools-b.mjs [--port N] [--only axe,phys] [--mats SAND,WATER]   (its own Vite: tools/vite-server.mjs)
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', 'axe,phys').split(',');
const mats = opt('mats', 'SAND,WATER').split(',');
const runs = [];
if (only.includes('axe')) runs.push(['hand', { only: ['axe'] }]);
if (only.includes('phys')) for (const m of mats) runs.push(['hand', { only: ['phys'], mats: [m] }]);
process.exit(await runStages(runs, { page: TOOLS_PAGE }) ? 1 : 0);
