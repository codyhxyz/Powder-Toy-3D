// Checks of hardness and breaking (POV engine work) on WebGPU: impact
// breaking, impact heat, blast breaking and mass conservation, the old
// check's scenes built on the CPU on a 64³ world in the POV tools' harness
// page (tools/harness/pov-tools.js, stage engine: no app to boot) and stepped
// by hand, their numbers printed. A case that follows a few cells reads just
// those each step; one that follows matter anywhere reads the whole state
// (slugs and keg every step, sandDrop every 4). A blast wakes the whole box,
// which costs SwiftShader most of a second a step, so the cases run in parts,
// each in a browser of its own: as many cases as fit in pov-gpu-check.mjs's
// BUDGET_MS, then the rest in the next (runStages).
// By default each scene runs its first case: 443 s here, in parts of 126 to 178 s.
// --all runs every case of every scene, the old check's 87 (its 4 keg ranges ×
// 7 offsets too): a case takes 40 s to 3 minutes here (the 9³ pile lit at a
// corner, 183 s), so that's hours, and docs/webgpu.md I4's cross-build run on
// a real GPU is where it belongs. The check asserts nothing: its numbers are
// for that comparison, and each scene's first case shows here that it builds,
// runs and prints.
// usage: node tools/pov-engine-check.mjs [--port N] [--all] [scene ...]   (its own Vite: tools/vite-server.mjs)
//   scenes: blastProfile paneLoad slugs keg blast sandDrop debris (default: all)
import { runStages, TOOLS_PAGE, BUDGET_MS } from './pov-gpu-check.mjs';

const SCENES = ['blastProfile', 'paneLoad', 'slugs', 'keg', 'blast', 'sandDrop', 'debris'];
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
opt('port', null);   // (out of the scene list: startVite takes --port N from the command line itself)
const all = args.includes('--all');
const only = args.filter((a) => !a.startsWith('--'));
const bad = only.filter((s) => !SCENES.includes(s));
if (bad.length) { console.log(`no scene ${bad.join(', ')} (scenes: ${SCENES.join(' ')})`); process.exit(1); }
const scenes = only.length ? only : SCENES;
process.exit(await runStages([['engine', { scenes, perScene: all ? null : 1, budgetMs: BUDGET_MS }]], { page: TOOLS_PAGE }) ? 1 : 0);
