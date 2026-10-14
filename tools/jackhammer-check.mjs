// Real toolbelt + mining on the existing 64³ hand-tool fixture, manual mode.
// Uses browser.mjs via runStages; own strictPort server, closed in finally.
// node tools/jackhammer-check.mjs --port 19483
import { runStages, TOOLS_PAGE } from './pov-gpu-check.mjs';
process.exitCode = await runStages(['jackhammer'], { page: TOOLS_PAGE }) ? 1 : 0;
