// The dock tiles run a CPU port of the engine (src/ui/tiles/engine.js) and draw
// it with src/ui/tiles/render.js. Plain elements need nothing there, but an
// element with its own special case in the GPU passes needs the same case in
// the port. This lists any element the passes name that the port doesn't.
//   node scripts/check-tile-engine.mjs
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const gpu = ['shaders/react.js', 'shaders/move.js', 'shaders/passes.js'].map(read).join('\n');
const port = ['ui/tiles/engine.js', 'ui/tiles/render.js'].map(read).join('\n');
const named = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));
const inGpu = named(gpu, /\bE_([A-Z]+)\b/g);
const inPort = named(port, /\bE\.([A-Z]+)\b/g);
const missing = [...inGpu].filter((k) => !inPort.has(k));
if (missing.length) {
  console.error(`tile engine port is missing special cases for: ${missing.join(', ')} (see src/ui/tiles/)`);
  process.exit(1);
}
console.log(`tile engine port covers every element the GPU passes special-case (${inGpu.size})`);
