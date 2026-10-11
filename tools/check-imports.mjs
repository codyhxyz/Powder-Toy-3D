// Every module under src/shaders/, src/gfx/ and src/gpu/ imports in Node, with
// no GPU and no DOM (docs/webgpu.md B1, J4): the shader generators are
// callable from Node tools (check-wgsl, tables-check), so nothing may touch
// navigator.gpu, window or document at import time.
//
// EXEMPT lists modules that can't, each with its reason. Fix one and delete
// it from the list; never add to it without a reason a reviewer accepts.
//
// usage: node tools/check-imports.mjs
import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src/shaders', 'src/gfx', 'src/gpu'];
/** @type {Record<string, string>} module → why it can't import in Node */
const EXEMPT = {};

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.js$/.test(n) ? [p] : [];
});

const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
const failed = [], fixed = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  try {
    await import(pathToFileURL(f));
    if (EXEMPT[rel]) fixed.push(rel);
  } catch (e) {
    if (!EXEMPT[rel]) failed.push(`${rel}: ${e.message.split('\n')[0]}`);
  }
}
for (const rel of fixed) console.log(`note: ${rel} imports in Node now; delete it from EXEMPT`);
for (const [rel, why] of Object.entries(EXEMPT)) if (!fixed.includes(rel)) console.log(`exempt ${rel}: ${why}`);
if (failed.length) {
  console.error(`These don't import in Node (no GPU, no DOM at import time):\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
console.log(`imports OK: ${files.length} modules under ${DIRS.join(', ')} import in Node`);
// three's WebGPU build and other imports may hold timers open; this check is done
process.exit(0);
