// CPU only. --wgsl additionally validates generated shaders with the Naga CLI.
// This never opens a browser, requests a GPU device, or starts the game.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Matrix4, Ray, Vector3 } from 'three';
import { E } from '../src/elements.js';
import { BUILTINS } from '../src/constructions/builtins.js';
import { runGenerator } from '../src/constructions/runtime.js';
import { foliageFrame, isFoliageCell, LEAF_FINE } from '../src/foliage.js';
import { buildFoliageMesh } from '../src/world/foliageMesh.js';
import { foliageGLSL } from '../src/shaders/gfx/foliage.js';
import { gridLayout } from '../src/sim.js';
import { WGSL_CHECK as renderChecks } from '../src/shaders/render.js';
import { WGSL_CHECK as giChecks } from '../src/shaders/gi.js';
import { WGSL_CHECK as farChecks } from '../src/shaders/far.js';
import { fieldEmaFrag, fieldBoostFrag, fieldPeakFrag } from '../src/shaders/fields.js';

// Captured from pre-foliage 32a654bb, not from the implementation under test.
// x/y/z/id/temp bytes: tagging must not redraw the tree or change its material.
const baseline = {
  oak: '2f3f35b30892c528f5d1fb12dcd4a66b6323013ce49891bf34fc22f10736c4cd',
  pine: '668c2c5c67db2a15980ad53c1a2607438f8a960b23b1fa924bd60346ebc519e2',
  birch: '2bc7df93d3f01527d6df70ff050695d097d60086b9acc3cfa4da44000a1db9f9',
  palm: '5e0686e3583611a8dc4d8a2ea10221c129069d99145acf0655eb0a6efe0f9a91',
  willow: '026978085758e39d8d6ce3679171a520096efdb48191e3596865c8d8d4139e6a',
  dead: '4f3e6e863603c44d8fc6f65586e3b5c27d14e05b0509f2f8296607853ff6c231',
};
for (const [variant, expected] of Object.entries(baseline)) {
  const c = runGenerator(BUILTINS.TREE, { size: 6, seed: 12345, variant });
  const hash = createHash('sha256');
  for (const key of ['x', 'y', 'z', 'id', 'temp']) hash.update(new Uint8Array(c[key].buffer));
  assert.equal(hash.digest('hex'), expected, variant);
  for (let i = 0; i < c.n; i++) assert.equal(isFoliageCell(c.id[i], c.ctype[i]), c.id[i] === E.PLANT, variant);
}
console.log('PASS all six TREE variants preserve baseline geometry/materials/temperatures; only crown PLANT gets the tag');

// The shader embeds the very same Float32 triangles as the far mesh.
assert.deepEqual([...LEAF_FINE.indices], [...LEAF_FINE.indices.keys()]);
const numbers = foliageGLSL.split('const FOLIAGE_NORMALS')[0].matchAll(/vec3f\(([^)]+)\)/g);
const embedded = Float32Array.from([...numbers].flatMap(m => m[1].split(',').map(Number)));
assert.deepEqual(embedded, LEAF_FINE.positions);
assert(foliageGLSL.includes('cell + H.origin'), 'window moves must not reseed the leaves');

// Independent world-triangle vs folded-template rays, both sides of each
// blade, with negative coordinates. This is geometry math, not GPU execution.
const firstHit = (positions, ray, min = 0, max = Infinity) => {
  let best = max, found = false;
  for (let i = 0; i < positions.length; i += 9) {
    const p = ray.intersectTriangle(
      new Vector3().fromArray(positions, i), new Vector3().fromArray(positions, i + 3),
      new Vector3().fromArray(positions, i + 6), false, new Vector3());
    if (!p) continue;
    const t = p.clone().sub(ray.origin).dot(ray.direction);
    if (t >= min && t <= best) { found = true; best = t; }
  }
  return found ? best : null;
};
for (const cell of [[0, 0, 0], [-15, 3, 17], [127, 33, -64]]) {
  const mesh = buildFoliageMesh(new Uint8Array([E.PLANT]), new Uint8Array([1]),
    { size: [1, 1, 1], origin: cell, bounds: [...cell, ...cell.map(v => v + 1)] });
  const { yaw, tilt } = foliageFrame(cell);
  const frame = new Matrix4().makeRotationY(yaw).multiply(new Matrix4().makeRotationX(tilt));
  frame.setPosition(...cell.map(v => v + 0.5));
  const inverse = frame.clone().invert();
  for (let i = 0; i < LEAF_FINE.positions.length; i += 9) for (const side of [-1, 1]) {
    const centre = new Vector3();
    for (let j = 0; j < 9; j += 3) centre.add(new Vector3().fromArray(LEAF_FINE.positions, i + j));
    centre.multiplyScalar(1 / 3);
    const n = new Vector3().fromArray(LEAF_FINE.normals, i).multiplyScalar(side);
    const localRay = new Ray(centre.clone().add(n), n.clone().negate());
    const worldRay = localRay.clone().applyMatrix4(frame);
    const folded = worldRay.clone().applyMatrix4(inverse);
    const a = firstHit(mesh.positions, worldRay), b = firstHit(LEAF_FINE.positions, folded);
    assert(a !== null && b !== null, 'both sides are visible');
    assert(Math.abs(a - b) < 1e-4, `${cell}: ${a} vs ${b}`);
    assert.equal(firstHit(LEAF_FINE.positions, folded, 0, b - 1e-4), null, 'a nearer cut/surface wins');
  }
  // A ray through an owner-cell corner must miss: an occupied voxel is NOT a shell.
  const gap = new Ray(new Vector3(0.49, 1, 0.49), new Vector3(0, -1, 0));
  assert.equal(firstHit(LEAF_FINE.positions, gap), null);
}
console.log('PASS near template and far triangles agree; double-sided hits, real gaps, clipping and stable world placement');

const fields = readFileSync(new URL('../src/shaders/fields.js', import.meta.url), 'utf8');
assert(fields.includes('select(SURFCH(id), -1, isFoliage(a))'));
assert(fields.includes('select(SURFCH(eid(a)), -1, isFoliage(a))'));
const surface = readFileSync(new URL('../src/shaders/gfx/surface.js', import.meta.url), 'utf8');
assert.equal(surface.match(/SURFCH\(id\) != ch \|\| isFoliage\(a\)/g)?.length, 2);
console.log('PASS field occupancy, thin-feature boost and both material gathers exclude tree leaves, not the entire organic channel');

// grainEvent can retain an alternate surface/depth before suppressing it.
// A foreground leaf must prevent that side effect; a suppressed foreground
// grain must still reveal a leaf behind it. Check both order and outcomes.
const grainCode = renderChecks().find(c => c.name === 'volume.realistic.grainClusters').code(gridLayout(32, 32, 32));
const event = grainCode.slice(grainCode.indexOf('var leafA ='), grainCode.indexOf('// Do not end the ray at cell entry'));
const compare = 'if (leafT <= tEv)';
assert(event.indexOf(compare) < event.indexOf('grainEvent('));
assert(event.lastIndexOf(compare) > event.indexOf('grainEvent('));
const resolve = (leafT, grainT, cut = 1) => {
  let t = Math.min(grainT, cut), kind = grainT < cut ? 'grain' : 'cut', alternate = null;
  const leaf = () => { if (leafT <= cut && leafT <= t) { t = leafT; kind = 'leaf'; } };
  leaf();
  if (kind === 'grain') { alternate = t; t = cut; kind = 'none'; }
  leaf();
  return { t, kind, alternate };
};
assert.deepEqual(resolve(0.3, 0.7), { t: 0.3, kind: 'leaf', alternate: null });
assert.deepEqual(resolve(0.7, 0.3), { t: 0.7, kind: 'leaf', alternate: 0.3 });
assert.deepEqual(resolve(0.3, 0.7, 0.2), { t: 0.2, kind: 'cut', alternate: null });
console.log('PASS foreground leaves block hidden grain alternates; suppressed foreground grains reveal leaves; mesh cuts still win');

if (process.argv.includes('--wgsl')) {
  const checks = [
    ...renderChecks(), ...giChecks(),
    ...farChecks().filter(c => /detail|farScene/.test(c.name)),
    { name: 'foliage.ema', code: fieldEmaFrag },
    { name: 'foliage.boost', code: g => fieldBoostFrag(g, 0) },
    { name: 'foliage.peak', code: fieldPeakFrag },
  ];
  for (const c of checks) {
    const g = gridLayout(32, c.name.startsWith('giantVolcano') ? 384 : 32, 32);
    execFileSync('naga', ['--stdin-file-path', `${c.name}.wgsl`], { input: c.code(g), encoding: 'utf8', maxBuffer: 10e6 });
  }
  console.log(`PASS ${checks.length} generated WGSL modules validated by Naga (CPU only; not a GPU pipeline/runtime test)`);
}
