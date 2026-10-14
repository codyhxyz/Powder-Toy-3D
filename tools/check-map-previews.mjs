// CPU-only: every menu map, including source imports, needs a square preview.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAPS } from '../src/maps.js';
import { installLocalCrueltyMaps } from '../src/world/import/localMap.js';
import { CRUELTY_PROFILES } from '../src/world/import/crueltyProfiles.js';
import { E } from '../src/elements.js';
import { trace, renderDescent } from './descent-thumb.mjs';

// Use the same registration as main.js; only replace its network transport.
const fetch = globalThis.fetch;
try {
  globalThis.fetch = async input => {
    const url = new URL(input, 'https://map-previews.test');
    assert.equal(url.origin, 'https://map-previews.test');
    assert.match(url.pathname, /^\/local-maps\/[a-zA-Z0-9_-]+\.json$/);
    const bytes = readFileSync(new URL(`../public${url.pathname}`, import.meta.url));
    const response = new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  const installed = await installLocalCrueltyMaps();
  assert.deepEqual(installed.map(m => m.key).sort(),
    CRUELTY_PROFILES.filter(p => !p.blocked).map(p => p.id).sort(),
    'every published source map registers before checking its preview');
  assert.ok(installed.every(m => MAPS.includes(m)), 'source maps enter the actual menu catalogue');
} finally {
  globalThis.fetch = fetch;
}

for (const map of MAPS) {
  const b = readFileSync(new URL(`../public/maps/${map.key}.webp`, import.meta.url));
  assert.equal(b.toString('ascii', 0, 4), 'RIFF', map.key);
  assert.equal(b.toString('ascii', 8, 12), 'WEBP', map.key);
  const kind = b.toString('ascii', 12, 16);
  let width, height;
  if (kind === 'VP8 ') {
    assert.equal(b.toString('hex', 23, 26), '9d012a', map.key);
    width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
  } else if (kind === 'VP8X') {
    width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1;
  } else {
    assert.equal(kind, 'VP8L', map.key);
    assert.equal(b[20], 0x2f, map.key);
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
  }
  assert.equal(width, height, `${map.key}: square preview`);
  assert.ok(width >= 400 && b.length > 100, `${map.key}: real full-resolution image`);
}

const cell = (x, y, z) => x === 1 && y === 1 && z === 1 ? E.ROCK : E.EMPTY;
assert.equal(trace([-1, 1.5, 1.5], [1, 0, 0], [3, 3, 3], cell).id, E.ROCK);
assert.deepEqual(trace([2.5, 1.5, 1.5], [-1, 0, 0], [3, 3, 3], cell).normal, [1, 0, 0]);
assert.equal(trace([0.5, 0.5, 0.5], [-1, 0, 0], [3, 3, 3], cell), null);
assert.equal(trace([-1, 1, 1], [0, 1, 0], [3, 3, 3], cell), null);
const sample = renderDescent(32);
assert.ok(sample.materials.has(E.SNOW) && sample.materials.has(E.ROCK) && sample.materials.has(E.PLANT), 'real Mines terrain, not a placeholder');
assert.ok(new Set(sample.rgb).size > 32, 'shaded scene has image detail');
console.log(`PASS ${MAPS.length} square map previews; CPU Descent voxel traversal and scene render.`);
