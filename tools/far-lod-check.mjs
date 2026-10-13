// The far view's predicates, run from its generated WGSL (shaders/far.js
// farFrag), not a second implementation: when the open sea beyond the world
// shows, with and without the detail meshes' distances in front (the depth
// prepass, world/detail.js depth: a dry pit dug below sea level in a meshed
// chunk isn't flooded by the coarse sea), when the view leaves a pixel to the
// mesh, the field a ray stops at in a meshed chunk, and the march's bound for
// a taller world.
// usage: node tools/far-lod-check.mjs
import assert from 'node:assert/strict';
import { gridLayout } from '../src/sim.js';
import { farFrag, farLayout, farDetailDepthFrag } from '../src/shaders/far.js';

const g = gridLayout(128, 128, 128);
const shader = farFrag(g, farLayout([1024, 384, 1024]));
// WGSL's boolean expressions are JS's
const ocean = new Function('tSea', 'tHit', 'cached', 'seaOut', 'seaWin', 'NO_HIT',
  `return ${shader.match(/let ocean = ([\s\S]*?);/)[1]};`);
const noHit = 1e9;
assert(ocean(17.89, noHit, 0, true, false, noHit), 'the sea past the world shows');
assert(!ocean(60, 40, 0, true, false, noHit), 'a far surface in front of the sea hides it');
assert(ocean(17.89, noHit, 0, false, false, noHit), 'a ray that met nothing inside the world meets the sea');
assert(!ocean(17.89, noHit, 0, false, true, noHit), 'the live window owns its water');
assert(!ocean(noHit, noHit, 0, true, false, noHit), 'no sea crossing, no sea');
assert(ocean(17.89, noHit, 53.67, true, false, noHit), 'near exterior water hides a meshed bed behind it');
assert(!ocean(60, noHit, 53.67, true, false, noHit), 'water behind a mesh is hidden');
assert(!ocean(17.89, noHit, 53.67, false, false, noHit), 'a dry interior edit in a meshed chunk is not flooded');
const discards = new Function('cached', 'tHit', 'ocean', 'NO_HIT',
  `return ${shader.match(/if \((cached > 0\.0 && tHit == NO_HIT && !ocean)\) \{ discard; \}/)[1]};`);
assert(discards(53.67, noHit, false, noHit), 'nothing of the field in front of a mesh: the pixel is the mesh\'s');
assert(!discards(53.67, 40, false, noHit), 'the field in front of a mesh draws');
assert(!discards(53.67, noHit, true, noHit), 'the sea in front of a mesh draws');
assert(!discards(0, noHit, false, noHit), 'no mesh: the sky draws');
assert(/if \(cached > 0\.0\) \{ t1 = min\(t1, cached\); \}/.test(shader), 'the march stops at the meshes\' distance');
// The field a ray stops at (farTraceMatter's body as JS: let → const, u32 literals as numbers)
const body = shader.match(/fn farTraceMatter\(p: vec3f\) -> f32 \{([\s\S]*?)\n\}/)[1];
const trace = new Function('detailAt', 'farSample', 'p', body.replace(/\blet\b/g, 'const').replace(/(\d)u\b/g, '$1'));
assert.equal(trace(() => 2, () => ({ r: 0.3, g: 0.4 })), 0.7, 'mixed shallow water in a meshed chunk still crosses .5');
assert.equal(trace(() => 1, () => ({ r: 0.7, g: 0 })), 0, 'a meshed chunk\'s opaque geometry replaces the coarse solid');
assert.equal(trace(() => 0, () => ({ r: 0.7, g: 0 })), 0.7, 'unmeshed opaque remains');
// the prepass writes what the view compares: the distance from the eye (P.eye, the view's ro) along the ray
const depth = farDetailDepthFrag(g);
assert(depth.includes('return vec4f(length(v.world - P.eye), 0.0, 0.0, 1.0);'), 'the prepass writes the eye distance');
assert(/if \(all\(v\.world\.xz >= winLo\.xz\) && all\(v\.world\.xz < winLo\.xz \+ GRID_XZ\)\) \{ discard; \}/.test(depth), 'the prepass leaves the window\'s columns to the volume');
assert(shader.includes('const FAR_MAX_STEPS: i32 = 624;'), 'the march bound follows the taller world');
assert(shader.indexOf('let ocean =') < shader.indexOf('if (ocean)'), 'the sea is decided before it is drawn');
assert(shader.indexOf('let ocean =') < shader.indexOf('tHit == NO_HIT && !ocean) { discard; }'), 'the sea is decided before the mesh is left its pixel');
console.log('PASS: exterior sea, far surfaces and meshes in front, dry edits in meshed chunks, live water, mixed liquid, the prepass\'s distance, the march bound for a taller world');
