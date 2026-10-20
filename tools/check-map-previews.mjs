// CPU-only: every menu map, including source imports, needs a square preview.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAPS, mapPreviewUrl, mapLoadingUrl } from '../src/maps.js';
import { installLocalCrueltyMaps } from '../src/world/import/localMap.js';
import { CRUELTY_PROFILES } from '../src/world/import/crueltyProfiles.js';
import { E } from '../src/elements.js';
import { trace, renderDescent } from './descent-thumb.mjs';
import { geometry, shader } from './willow-cozy-thumb.mjs';
import { cozySurfaceWGSL, cozyWaterWGSL } from '../src/shaders/gfx/cozy.js';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';

assert.equal(mapPreviewUrl('willowCove'), '/maps/willowCove.webp?v=2', 'replace the four-hour cached legacy preview');
assert.equal(mapPreviewUrl('tinkerCreek'), mapPreviewUrl('willowCove'), 'aliases use the current canonical preview');
assert.equal(mapPreviewUrl('island'), '/maps/island.webp', 'unrelated previews keep their URLs');
assert.equal(mapPreviewUrl('descent'), '/maps/descent.webp?v=6', 'the ring that fits the WORLD renderer replaces the 270-degree preview');
assert.equal(mapLoadingUrl('island'), mapPreviewUrl('island'), 'maps without loading art retain a thumbnail fallback');
assert.equal(mapLoadingUrl('tinkerCreek'), mapPreviewUrl('willowCove'), 'loading fallback resolves aliases too');
const crossing = geometry(32), cozy = shader(32);
assert.equal(crossing.hits.length, 32 * 32 * 12);
assert(crossing.hits.every(Number.isFinite));
assert(crossing.materials.has(E.WOOD) && crossing.materials.has(E.BRICK) && crossing.materials.has(E.WATER));
assert(cozy.includes(cozySurfaceWGSL) && cozy.includes(cozyWaterWGSL), 'use current production Cozy artwork, never plain palette colours');
assert.equal(new WgslReflect(cozy).entry.compute[0].name, 'main');

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

function imageSize(b, label) {
  assert.equal(b.toString('ascii', 0, 4), 'RIFF', label);
  assert.equal(b.toString('ascii', 8, 12), 'WEBP', label);
  const kind = b.toString('ascii', 12, 16);
  let width, height;
  if (kind === 'VP8 ') {
    assert.equal(b.toString('hex', 23, 26), '9d012a', label);
    width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
  } else if (kind === 'VP8X') {
    width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1;
  } else {
    assert.equal(kind, 'VP8L', label);
    assert.equal(b[20], 0x2f, label);
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
  }
  return [width, height];
}
for (const map of MAPS) {
  const b = readFileSync(new URL(`../public/maps/${map.key}.webp`, import.meta.url));
  const [width, height] = imageSize(b, map.key);
  assert.equal(width, height, `${map.key}: square preview`);
  assert.ok(width >= 400 && b.length > 100, `${map.key}: real full-resolution image`);
  if (map.loadingArtVersion) {
    assert.equal(mapLoadingUrl(map.key), `/maps/${map.key}-loading.webp?v=${map.loadingArtVersion}`);
    const art = readFileSync(new URL(`../public/maps/${map.key}-loading.webp`, import.meta.url));
    assert.deepEqual(imageSize(art, map.key), [2560, 1600], `${map.key}: native fullscreen artwork`);
    assert.ok(art.length > b.length, `${map.key}: loading artwork carries more detail than the card`);
  }
}

const cell = (x, y, z) => x === 1 && y === 1 && z === 1 ? E.ROCK : E.EMPTY;
assert.equal(trace([-1, 1.5, 1.5], [1, 0, 0], [3, 3, 3], cell).id, E.ROCK);
assert.deepEqual(trace([2.5, 1.5, 1.5], [-1, 0, 0], [3, 3, 3], cell).normal, [1, 0, 0]);
assert.equal(trace([0.5, 0.5, 0.5], [-1, 0, 0], [3, 3, 3], cell), null);
assert.equal(trace([-1, 1, 1], [0, 1, 0], [3, 3, 3], cell), null);
const sample = renderDescent(32);
assert.ok(sample.materials.has(E.WOOD) && sample.materials.has(E.ROCK), 'actual source-derived Coal Pits geometry, not the legacy Mines');
assert.ok(new Set(sample.rgb).size > 32, 'shaded scene has image detail');
console.log(`PASS ${MAPS.length} square map previews; current Crossing geometry, production Cozy WGSL, cache revisions and CPU Descent render.`);
