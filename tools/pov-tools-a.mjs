// Check of the POV toolbelt (hotbar, shovel, bucket, exact transfer): the real
// toolbelt (createToolbelt) driven with a hand-built ctx on a 64³ world in the
// POV tools' harness page (tools/harness/pov-tools.js, stage toolbelt: no app
// to boot, one browser, well under 3 minutes on SwiftShader), the world
// stepped a frame at a time. Every phase's grid census plus every load is
// exactly what it was: the shovel's scoop and throw of sand, its rock dug into
// stone cell for cell, the bucket's scoop and pour of water, and 600
// overlapping takes and puts in flight across steps. Also the hotbar's keys
// and wheel, WALL's refusal, and lava keeping its heat in the bucket.
// usage: node tools/pov-tools-a.mjs [--port N]   (its own Vite: tools/vite-server.mjs)
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';

process.exit(await runStages(['toolbelt'], { page: TOOLS_PAGE }) ? 1 : 0);
