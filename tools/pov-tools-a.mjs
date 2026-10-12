// Check of the POV toolbelt (hotbar, shovel, bucket, exact transfer): the real
// toolbelt (createToolbelt) driven with a hand-built ctx on a 32³ world in the
// POV tools' harness page (tools/harness/pov-tools.js, stage toolbelt: no app
// to boot), the world stepped a frame at a time. Every phase's grid census
// plus every load is exactly what it was: the shovel's scoop and throw of
// sand, its rock dug into stone cell for cell, the bucket's scoop and pour of
// water, and 600 overlapping takes and puts in flight across steps. Also the
// hotbar's keys and wheel, WALL's refusal, and lava keeping its heat in the
// bucket. Two parts, each in a browser of its own: shovel, bucket.
// (The old check's 64³ app, at its 4 steps a 60 Hz frame: here 32³, the scene's
// heaps a cell smaller, 2 steps a 30 Hz frame. What it asserts is exactness:
// cells in = cells out across steps with transfers in flight, which no grid
// size or step rate changes; it costs a quarter of the steps and an eighth of
// the cells.)
// usage: node tools/pov-tools-a.mjs [--port N] [--only shovel,bucket]   (its own Vite: tools/vite-server.mjs)
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const parts = opt('only', 'shovel,bucket').split(',');
process.exit(await runStages(parts.map((p) => ['toolbelt', { parts: [p] }]), { page: TOOLS_PAGE }) ? 1 : 0);
