import assert from 'node:assert/strict';
import { gridLayout } from '../src/sim.js';
import { farFrag, farLayout } from '../src/shaders/far.js';
const shader = farFrag(gridLayout(128, 128, 128), farLayout([1024, 384, 1024]));
// Execute the generated shader's scalar predicates, not a second implementation.
const ocean = new Function('tSea', 'tHit', 'cached', 'seaOut', 'seaWin', 'NO_HIT',
  `return ${shader.match(/bool ocean = ([\s\S]*?);/)[1]};`);
const noHit = 1e30;
assert(ocean(17.89, noHit, 53.67, true, false, noHit), 'near exterior water hides cached bed');
assert(!ocean(60, noHit, 53.67, true, false, noHit), 'water behind mesh is hidden');
assert(!ocean(17.89, noHit, 53.67, false, false, noHit), 'dry interior edit is not flooded');
assert(ocean(17.89, noHit, 0, false, false, noHit), 'uncached interior fallback remains');
assert(!ocean(17.89, noHit, 0, false, true, noHit), 'live window owns its water');
const trace = new Function('detailAt', 'v', 'p',
  `return ${shader.match(/float farTraceMatter[\s\S]*?return ([^;]+);/)[1]};`);
assert.equal(trace(() => 2, { r: .3, g: .4 }), .7, 'mixed shallow water still crosses .5');
assert.equal(trace(() => 1, { r: .7, g: 0 }), 0, 'cached opaque geometry replaces coarse solid');
assert.equal(trace(() => 0, { r: .7, g: 0 }), .7, 'uncached opaque remains');
assert(shader.includes('#define FAR_MAX_STEPS 624'), 'march bound follows taller world');
assert(shader.indexOf('bool ocean =') < shader.indexOf('tHit == NO_HIT && !ocean) discard'));
console.log('PASS: exterior occlusion, dry edits, live water, mixed liquid, dynamic world march bound');
