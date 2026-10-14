import assert from 'node:assert/strict';
import * as THREE from 'three';
import { character, dispose } from '../src/pov/village/models.js';
import { RESIDENTS } from '../src/pov/village/residents.js';
import { TIM_CROOK } from '../src/pov/village/crook.js';

const specs = [{ persona: 'boy' }, { persona: 'girl' }, ...RESIDENTS, TIM_CROOK];
for (const spec of specs) {
  const model = character(spec), root = model.root, hand = model.hand;
  let meshes = 0, triangles = 0;
  root.traverse(o => {
    if (!o.isMesh) return;
    meshes++; triangles += o.geometry.index.count / 3;
    for (const name of ['position', 'normal', 'color'])
      assert.ok(o.geometry.attributes[name].array.every(Number.isFinite), `${name} is finite`);
  });
  assert.ok(meshes < 85 && triangles < 50000, 'bounded procedural mesh cost');
  const bounds = new THREE.Box3().setFromObject(root);
  assert.ok(bounds.min.y >= 0 && bounds.max.y < 7, 'keeps existing floor contact / head clearance');
  const eye = root.getObjectByName('village-eye');
  const lid = root.getObjectByName('sleep-eye-left');
  const smile = root.getObjectByName('village-smile');
  const mouth = root.getObjectByName('village-talking-mouth');
  model.animate(1, 0, false);
  assert.ok(eye.visible && !lid.visible && smile.visible && !mouth.visible);
  model.animate(2, 0, true);
  assert.ok(mouth.visible && !smile.visible, 'speech changes mouth, not tool rig');
  const offset = spec.species ? spec.species === 'rabbit' ? 0.6 : 1.8 : spec.persona === 'girl' ? 1.1 : 0;
  model.animate(4.5 - offset);
  assert.ok(!eye.visible && lid.visible, 'offset blink closes the complete eye');
  model.animate(5);
  assert.ok(eye.visible && !lid.visible, 'blink reopens');
  model.animate(6, 0, true, false, 0, 0, false, false, null, 0, { kind: 'sleep' });
  assert.ok(!eye.visible && lid.visible && !mouth.visible && smile.visible, 'rest overrides speech and blinking');
  model.animate(7, 3);
  root.updateMatrixWorld(true);
  root.traverse(o => assert.ok(o.matrixWorld.elements.every(Number.isFinite)));
  assert.equal(model.hand, hand, 'outfit preserves stable tool attachment');
  assert.equal(root.getObjectsByProperty('name', 'village-tail').length, spec.species && spec.species !== 'tanuki' ? 1 : 0,
    'one tail per animal, not one per ear');
  if (spec.species === 'cat') assert.equal(root.getObjectByName('dress-skirt'), undefined);
  if (spec.species === 'rabbit' || spec.persona === 'girl') assert.ok(root.getObjectByName('dress-skirt'));
  const reducedMedia = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true });
    const reduced = character(spec);
    reduced.animate(4.5 - offset, 0, true);
    assert.ok(reduced.root.getObjectByName('village-eye').visible, 'reduced motion has no automatic blink');
    assert.equal(reduced.root.getObjectByName('village-head').position.y, 0);
    dispose(reduced.root);
  } finally {
    if (reducedMedia) globalThis.matchMedia = reducedMedia;
    else delete globalThis.matchMedia;
  }
  let disposed = 0;
  root.traverse(o => o.geometry?.addEventListener('dispose', () => disposed++));
  dispose(root); assert.equal(disposed, meshes);
  console.log(`PASS ${spec.name ?? spec.persona}: ${meshes} meshes, ${triangles} triangles; expressions, rig and disposal`);
}
