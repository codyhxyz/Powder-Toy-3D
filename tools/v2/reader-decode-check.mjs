// CPU only: prove the exact argument supplied to the unchanged decoder.
import assert from 'node:assert/strict';
import { ELEMENTS, K } from '../../src/elements.js';
import { compactDecodeWGSL } from '../../src/shaders/compact.js';
import { prelude } from '../../src/shaders/common.js';
import { gridLayout } from '../../src/sim.js';

const start = compactDecodeWGSL.indexOf('fn compactProbeCore(');
const end = compactDecodeWGSL.indexOf('fn compactProbeA(', start);
const wgsl = compactDecodeWGSL.slice(start, end);
assert.match(wgsl, /var core = c;/);
// Execute this small production integer helper, not a parallel implementation.
const js = wgsl.replace('fn compactProbeCore(c: vec4u) -> vec4u', 'function normalize(c)')
  .replace('var core = c;', 'let core = { ...c };')
  .replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1');
const normalize = new Function('KIND', 'K_LIQUID', 'max', 'i32', `${js};return normalize;`)(
  id => ELEMENTS[id]?.kind ?? K.EMPTY, K.LIQUID, Math.max, x => x | 0);
const words = c => [c.x, c.y, c.z, c.w].map(x => x >>> 0);
function prior(c) {
  if (ELEMENTS[c.x & 255]?.kind === K.LIQUID && (c.y & 0xffffff) !== 0)
    return { ...c, y: ((c.y & 0xff000000) | Math.max(65536, c.y & 0xffffff)) >>> 0 };
  return c;
}
let cases = 0, seed = 0x731b39a7;
const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
function check(c) {
  const before = words(c), actual = words(normalize(c));
  assert.deepEqual(actual, words(prior(c)));
  assert.deepEqual(words(c), before, 'read-only input must remain unchanged');
  cases++;
}
for (let id = 0; id < 256; id++) for (let high = 0; high < 256; high++)
  for (const fill of [0, 1, 65535, 65536, 65537, 1048576, 0xffffff])
    check({ x: (random() & 0xffffff00) | id, y: ((high << 24) | fill) >>> 0, z: random(), w: random() });
for (let i = 0; i < 10000; i++) check({ x: random(), y: random(), z: random(), w: random() });

const header = prelude(gridLayout(16, 16, 16), { state: 'read' });
const fetch = header.slice(header.indexOf('fn fetchAs('), header.indexOf('fn fetchA(', header.indexOf('fn fetchAs(')));
assert.equal((fetch.match(/\bcompactA\(/g) ?? []).length, 1);
assert.match(fetch, /H\.format == 2u \|\| H\.format == 3u/);
assert.match(fetch, /if \(H\.format == 3u\) \{ core = compactProbeCore\(core\); \}/);
assert.match(fetch, /return bitcast<vec4f>\(A\[H\.src \* SLOTS \+ s\]\);/);
assert.match(compactDecodeWGSL, /fn compactProbeA\(p: vec3i, c: vec4u\) -> vec4f/);
console.log(`Reader decode: ${cases} exact argument/opaque-bit checks; visual/physical/legacy ABI retained, one compactA call per fetch; CPU only`);
