// The far view's predicates, run from its generated WGSL (shaders/far.js
// farFrag), not a second implementation: when the open sea beyond the world
// shows, and the march's bound for a taller world. (The detail meshes' cached
// depth and mask aren't drawn on WebGPU yet: world/detail.js.)
// usage: node tools/far-lod-check.mjs
import assert from 'node:assert/strict';
import { gridLayout } from '../src/sim.js';
import { farFrag, farLayout } from '../src/shaders/far.js';

const shader = farFrag(gridLayout(128, 128, 128), farLayout([1024, 384, 1024]));
// WGSL's boolean expression is JS's
const ocean = new Function('tSea', 'tHit', 'seaOut', 'seaWin', 'NO_HIT',
  `return ${shader.match(/let ocean = ([\s\S]*?);/)[1]};`);
const noHit = 1e9;
assert(ocean(17.89, noHit, true, false, noHit), 'the sea past the world shows');
assert(!ocean(60, 40, true, false, noHit), 'a far surface in front of the sea hides it');
assert(ocean(17.89, noHit, false, false, noHit), 'a ray that met nothing inside the world meets the sea');
assert(!ocean(17.89, noHit, false, true, noHit), 'the live window owns its water');
assert(!ocean(noHit, noHit, true, false, noHit), 'no sea crossing, no sea');
assert(shader.includes('const FAR_MAX_STEPS: i32 = 624;'), 'the march bound follows the taller world');
assert(shader.indexOf('let ocean =') < shader.indexOf('if (ocean)'), 'the sea is decided before it is drawn');
console.log('PASS: exterior sea, far surfaces in front, live water, the march bound for a taller world');
