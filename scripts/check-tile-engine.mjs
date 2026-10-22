// The dock tiles run a CPU port of V1's rules (src/ui/tiles/engine.js) and draw
// it with src/ui/tiles/render.js. Plain elements need nothing there, but an
// element with its own special case in the GPU passes needs the same case in
// the port. This lists any element the passes name that the port doesn't.
// (V1's react.js and move.js went with V1, the v1-oracle tag; the shared passes still name theirs.)
//   node scripts/check-tile-engine.mjs
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const gpu = ['shaders/passes.js', 'electricity.js'].map(read).join('\n');
const port = ['ui/tiles/engine.js', 'ui/tiles/render.js', 'electricity.js'].map(read).join('\n');
const named = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));
const inGpu = named(gpu, /\bE_([A-Z0-9_]+)\b/g);
const inPort = named(port, /\bE\.([A-Z0-9_]+)\b/g);
const missing = [...inGpu].filter((k) => !inPort.has(k));
if (missing.length) {
  console.error(`tile engine port is missing special cases for: ${missing.join(', ')} (see src/ui/tiles/)`);
  process.exit(1);
}
console.log(`tile engine port covers every element the GPU passes special-case (${inGpu.size})`);
