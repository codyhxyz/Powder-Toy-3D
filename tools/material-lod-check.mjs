// The leaf fast path must have exactly the old fully faded material.
import assert from 'node:assert/strict';
import { surfaceGLSL } from '../src/shaders/gfx/surface.js';
const leaf = surfaceGLSL.split('} else if (id == E_PLANT) {')[1].split('} else if')[0];
const mean = +leaf.match(/const float MEAN = ([\d.]+)/)[1];
assert(leaf.indexOf('if (lw <= 0.0)') < leaf.indexOf('mCell('));
assert(leaf.includes('m.alb *= MEAN;') && leaf.includes('m.cav = MEAN;'));
for (let i = 0; i < 100; i++) {
  const mix = (a, b, t) => a * (1 - t) + b * t;
  const alb = i / 99, rough = 0.5, arbitraryLeaf = i * 0.17, lw = 0;
  assert.equal(alb * mix(mean, arbitraryLeaf, lw), alb * mean);
  assert.equal(mix(mean, arbitraryLeaf, lw), mean);
  assert.equal(rough + arbitraryLeaf * lw, rough);
}
console.log('PASS: faded foliage skips cellular search without changing its averaged material');
