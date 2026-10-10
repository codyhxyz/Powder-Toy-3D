#!/usr/bin/env node
// The World's build-time bake (src/world/bake.js): the default world's
// expensive CPU work, done in node with the client's own modules (the island
// scene's params: its landform sites and start; the structures layer's
// placement), printed as JSON for the Vite plugin (scripts/world-bake-plugin.mjs)
// to ship as a virtual module.
//
// Its key: the world's size and seed and a hash of every source file the
// island scene and the structures layer import, transitively (the generator,
// the island hooks, the twin's helpers, the constructions, the element table,
// ...). Any edit to any of them changes the key, and the client uses a bake
// only when its key is the key of the sources it was built from.
//
//   node scripts/world-bake.mjs            the bake, as JSON (--seed N: another world's)
//   node scripts/world-bake.mjs --key      { key, files } only (fast: no generation)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// What the bake runs: everything it depends on is in these modules' import closure.
export const BAKE_ENTRIES = ['src/world/scenes/island.js', 'src/world/structures.js'];
export const BAKE_SIZE = [1024, 128, 1024];   // the World (app.js WORLDS.world.size)
const IMPORT_RE = /\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\bexport\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;

// Every source file reachable from the entries by relative imports (packages excluded), sorted.
export function sourceClosure(entries = BAKE_ENTRIES) {
  const seen = new Set(), todo = entries.map((e) => path.join(ROOT, e));
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = (m[1] ?? m[2] ?? m[3]).split('?')[0];
      if (spec.startsWith('.')) todo.push(path.resolve(path.dirname(file), spec));
    }
  }
  return [...seen].sort();
}

// The bake's key for a world of `size` and `seed`: those, and every closure file's path and text.
export function bakeKey(size = BAKE_SIZE, seed, files = sourceClosure()) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ size, seed }));
  for (const f of files) h.update(`\0${path.relative(ROOT, f)}\0`).update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 32);
}

// The bake itself: { key, size, seed, landforms, start, records }.
export async function bakeWorld(size = BAKE_SIZE, seedArg = null) {
  const files = sourceClosure();
  const { WORLD_SEED } = await import(pathToFileURL(path.join(ROOT, 'src/world/generator.js')).href);
  const { island } = await import(pathToFileURL(path.join(ROOT, 'src/world/scenes/island.js')).href);
  const { structuresOf, structureRecord } = await import(pathToFileURL(path.join(ROOT, 'src/world/structures.js')).href);
  const seed = (seedArg ?? WORLD_SEED) >>> 0;
  const P = island.params({ size, seed });
  return {
    key: bakeKey(size, seed, files), size, seed,
    landforms: P.landforms, start: P.structures.start,
    records: structuresOf(P).map(structureRecord),
    files: files.map((f) => path.relative(ROOT, f)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--key')) {
    const files = sourceClosure();
    process.stdout.write(JSON.stringify({ key: bakeKey(BAKE_SIZE, undefined, files), files: files.map((f) => path.relative(ROOT, f)) }));
  } else {
    const i = process.argv.indexOf('--seed');   // (tools: another world's bake, to compare)
    process.stdout.write(JSON.stringify(await bakeWorld(BAKE_SIZE, i > 0 ? Number(process.argv[i + 1]) : null)));
  }
}
