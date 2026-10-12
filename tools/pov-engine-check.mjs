// Checks of hardness and breaking (POV engine work) on WebGPU: impact
// breaking, impact heat, blast breaking and mass conservation, each scene
// built on the CPU on a 64³ world in the POV tools' harness page
// (tools/harness/pov-tools.js, stage engine: no app to boot) and stepped by
// hand, one browser a scene, its numbers printed. A scene that follows a few
// cells reads just those each step; one that follows matter anywhere reads
// the whole state (slugs and keg every step, sandDrop every 4). Each scene
// takes minutes on SwiftShader (blastProfile 5 on a loaded host), slugs and
// keg the most; keg runs 2 ranges × 3 offsets unless --full (the old check's
// 4 × 7).
// usage: node tools/pov-engine-check.mjs [--port N] [--full] [scene ...]   (its own Vite: tools/vite-server.mjs)
//   scenes: blastProfile paneLoad slugs keg blast sandDrop debris (default: all)
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';

const SCENES = ['blastProfile', 'paneLoad', 'slugs', 'keg', 'blast', 'sandDrop', 'debris'];
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
opt('port', null);   // (out of the scene list: startVite takes --port N from the command line itself)
const full = args.includes('--full');
const only = args.filter((a) => !a.startsWith('--'));
const scenes = only.length ? only : SCENES;
process.exit(await runStages(scenes.map((scene) => ['engine', { scene, full }]), { page: TOOLS_PAGE }) ? 1 : 0);
