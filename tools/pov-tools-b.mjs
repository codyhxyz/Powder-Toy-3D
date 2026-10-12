// Check of the POV axe and physgun (src/pov/tools/): each tool's real code
// driven with a hand-built ctx in the POV tools' harness page
// (tools/harness/pov-tools.js, stage hand: no app to boot), the world stepped
// a frame at a time. The axe breaks wood, glass, ice and plant into their
// debris cell for cell and leaves rock and metal, nothing made or lost (the
// old check's slabs, on 64³: half a minute here). The physgun lifts a block
// of sand and of water to a hold point 12 cells up, flings it along the aim,
// and conserves it (on 32³ at the app's frame and step rate, the old check's
// 330 frames, 1,320 steps), one browser a material, only when asked for
// (--only phys, or --all): the beam keeps half the 32³ box awake, which costs
// SwiftShader about 290 s a material (seconds on a real GPU: docs/webgpu.md
// I4's Mac list has it). Here pov-gpu-check stands in for it: its probes
// stage reads the physgun's centre of mass against the state, its edits stage
// runs the physgun's edit (one dispatch, nothing changed outside its box).
// The gun's rounds are tools/gp-gun.mjs's and pov-gpu-check's (probes, edits).
// usage: node tools/pov-tools-b.mjs [--port N] [--only axe,phys | --all] [--mats SAND,WATER]   (its own Vite: tools/vite-server.mjs)
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', args.includes('--all') ? 'axe,phys' : 'axe').split(',');
const mats = opt('mats', 'SAND,WATER').split(',');
const runs = [];
if (only.includes('axe')) runs.push(['hand', { only: ['axe'] }]);
if (only.includes('phys')) for (const m of mats) runs.push(['hand', { only: ['phys'], mats: [m] }]);
process.exit(await runStages(runs, { page: TOOLS_PAGE }) ? 1 : 0);
