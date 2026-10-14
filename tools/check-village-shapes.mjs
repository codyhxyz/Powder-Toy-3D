import assert from 'node:assert/strict';
import * as THREE from 'three';
import { character, dispose } from '../src/pov/village/models.js';
import { RESIDENTS } from '../src/pov/village/residents.js';
import { TIM_CROOK } from '../src/pov/village/crook.js';

const ray = (from, direction, meshes) =>
  new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...direction)).intersectObjects(meshes)[0]?.object;
for (const spec of [{ persona: 'boy' }, { persona: 'girl' }, ...RESIDENTS, TIM_CROOK]) {
  const model = character(spec), root = model.root;
  root.updateMatrixWorld(true);
  const hair = root.getObjectByName('village-hair'), skull = root.getObjectByName('village-skull');
  let meshes = 0, triangles = 0, textures = 0, disposedTextures = 0;
  root.traverse(o => {
    if (!o.isMesh) return;
    meshes++; triangles += o.geometry.index.count / 3;
    for (const name of ['position', 'normal', 'color'])
      assert.ok(o.geometry.attributes[name].array.every(Number.isFinite), `${name} must be finite`);
    if (o.material.map) {
      textures++;
      o.material.map.addEventListener('dispose', () => disposedTextures++);
      assert.ok(o.geometry.attributes.uv, 'painted geometry has UVs');
    }
  });
  if (spec.persona) {
    assert.equal(root.getObjectsByProperty('name', 'village-hair').length, 1, 'one continuous hairstyle');
    assert.equal(hair.geometry.type, 'BufferGeometry', 'hair is not sphere primitives');
    for (const y of [3.35, 3.7, 4.2, 4.7, 5.2]) for (const x of [-0.45, 0, 0.45])
      assert.equal(ray([x, y, 5], [0, 0, -1], [hair, skull]), hair, 'hair covers the rear skull down to the nape');
    assert.equal(ray([5, 4.15, 0], [-1, 0, 0], [hair, skull]), hair, 'cut wraps around the temple');
    for (const x of [-0.55, 0.55])
      assert.equal(ray([x, 4.15, -5], [0, 0, 1], [hair, skull]), skull, 'bangs leave the eyes clear');
    // Connected topology: every hair vertex belongs to the crown-to-nape shell.
    const count = hair.geometry.attributes.position.count, adjacency = Array.from({ length: count }, () => []);
    const index = hair.geometry.index.array;
    for (let i = 0; i < index.length; i += 3) for (let j = 0; j < 3; j++) {
      const a = index[i + j], b = index[i + (j + 1) % 3]; adjacency[a].push(b); adjacency[b].push(a);
    }
    const seen = new Set([0]), queue = [0];
    while (queue.length) for (const next of adjacency[queue.pop()]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    assert.equal(seen.size, count, 'no disconnected hair clumps');
  }
  const clothing = root.getObjectByName(spec.persona === 'girl' ? 'village-dress' : 'village-shirt');
  assert.ok(clothing?.material.map?.isDataTexture, 'full-wrap painted garment');
  if (spec.persona !== 'girl' && spec.species !== 'tanuki')
    assert.ok(ray([0, 1.45, 5], [0, 0, -1], [clothing, root.getObjectByName('village-hips')]), 'no empty waist gap');
  assert.ok(triangles < 20000, 'new shapes stay below the old model triangle budget');
  const hand = model.hand;
  for (const args of [[1, 3], [1.1, 0, true], [1.2, 2, false, true], [1.3, 8, false, false, 1],
    [1.4, 0, false, false, 0, 0.5], [1.5, 3, false, false, 0, 0, true, true]]) {
    model.animate(...args); root.updateMatrixWorld(true);
    root.traverse(o => assert.ok(o.matrixWorld.elements.every(Number.isFinite)));
  }
  assert.equal(model.hand, hand);
  model.animate(2, 0, false, false, 0, 0, false, false, null, 0, { kind: 'sleep' });
  assert.equal(root.getObjectByName('village-eye').visible, false);
  assert.equal(root.getObjectByName('sleep-eye-left').visible, true);
  model.animate(2.1);
  assert.equal(root.getObjectByName('village-eye').visible, true);
  const bounds = new THREE.Box3().setFromObject(root);
  assert.ok(bounds.min.y >= -0.04 && bounds.max.y < 7, 'floor contact and existing clearance preserved');
  model.reset(); dispose(root);
  assert.equal(disposedTextures, textures, 'procedural clothing textures released');
  console.log(`PASS ${spec.name ?? spec.persona}: ${meshes} meshes, ${triangles} triangles; silhouettes, poses, textures`);
}
