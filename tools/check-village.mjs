import assert from 'node:assert/strict';
import { initialState, validState, change, placementError, loadState, ITEMS, carryTarget, bounds, overlaps } from '../src/pov/village/state.js';
import { character, furniture, dispose } from '../src/pov/village/models.js';

let state = initialState();
const ids = s => [...s.placed, ...s.pockets, ...s.storage].map(i => i.id).sort();
const original = ids(state), home = { home: true, dresser: true, player: { x: 0, z: -4 } };
const apply = action => {
  const result = change(state, action, home);
  assert.ok(!result.error, result.error);
  state = result.state;
  assert.ok(validState(state)); assert.deepEqual(ids(state), original, 'items conserved');
};
assert.ok(validState(state));
for (const kind of ['plant', 'sofa', 'bed']) for (let rotation = 0; rotation < 4; rotation++) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
  const player = { x: 3.5, z: 0 }, target = carryTarget({ id: kind, kind, rotation }, player, yaw);
  assert.ok(Number.isInteger(target.x) && Number.isInteger(target.z), 'carry preview snaps to the saved world grid');
  assert.equal(overlaps(bounds(target), { x: player.x - 1, z: player.z - 1, w: 2, d: 2 }), false, 'carrying keeps the piece in front of the player');
}
assert.ok(change(state, { type: 'place', id: 'plant', x: 6, z: 0, rotation: 0 }).error, 'cannot place outside home');
assert.ok(change(state, { type: 'store', id: 'plant' }, { home: true }).error, 'dresser proximity required');
assert.ok(change(state, { type: 'withdraw', id: 'chair2' }, { dresser: true }).error, 'neighbor storage inaccessible');
for (const [x, z, rotation] of [[0, 0, 0], [0, -8, 0], [20, 0, 0], [-6, 5, 0], [6, 6, 0], [6, 0, 4], [NaN, 0, 0]])
  assert.ok(placementError(state, { id: 'sofa', kind: 'sofa', x, z, rotation }), 'bad positions rejected');
assert.ok(placementError(state, { id: 'plant', kind: 'plant', x: 6, z: 0, rotation: 0 }, { x: 6, z: 0 }), 'cannot place on player');
apply({ type: 'place', id: 'sofa', x: 6, z: 0, rotation: 0 });
apply({ type: 'place', id: 'sofa', x: 6, z: 0, rotation: 1 });
apply({ type: 'take', id: 'sofa' });
apply({ type: 'store', id: 'sofa' });
apply({ type: 'withdraw', id: 'sofa' });
apply({ type: 'store', id: 'plant' });
apply({ type: 'withdraw', id: 'plant' });
apply({ type: 'place', id: 'plant', x: 6, z: 0, rotation: 0 });
const untouched = JSON.stringify(state);
assert.ok(change(state, { type: 'place', id: 'plant', x: 0, z: 0, rotation: 0 }, home).error);
assert.equal(JSON.stringify(state), untouched, 'failed action leaves original untouched');
for (const mutation of [s => s.version++, s => s.pockets.push(s.placed[0]), s => s.placed[0].kind = 'unknown', s => s.storage.pop(), s => s.placed[0].x = 0]) {
  const s = structuredClone(state); mutation(s); assert.equal(validState(s), false);
}
assert.equal(loadState({ getItem: () => null }, 'test').writable, true);
assert.deepEqual(loadState({ getItem: () => JSON.stringify(state) }, 'test').state, state);
for (const raw of ['bad JSON', '{"version":2}', '{"version":1,"placed":[],"pockets":[],"storage":[]}']) {
  const s = loadState({ getItem: () => raw }, 'test'); assert.equal(s.writable, false); assert.ok(s.warning);
}
assert.equal(loadState({ getItem: () => { throw new Error('denied'); } }, 'test').writable, false);
for (const kind of Object.keys(ITEMS)) {
  const model = furniture(kind); assert.ok(model.children.length); dispose(model);
}
for (const species of ['human', 'cat', 'rabbit', 'bear']) {
  const model = character({ species }); model.animate(1, 3); assert.ok(model.root.children.length); dispose(model.root);
}
for (const persona of ['boy', 'girl']) {
  const model = character({ persona });
  assert.equal(model.root.userData.persona, persona);
  const hand = model.hand;
  for (const args of [[1, 3], [1.1, 0, true], [1.2, 2, false, true], [1.3, 8, false, false, 1],
    [1.4, 0, false, false, 0, 0.5], [1.5, 3, false, false, 0, 0, true, true]]) {
    model.animate(...args);
    model.root.updateMatrixWorld(true);
    model.root.traverse(o => assert.ok(o.matrixWorld.elements.every(Number.isFinite)));
  }
  assert.equal(model.hand, hand, 'persona keeps a stable tool attachment');
  model.reset(); dispose(model.root);
}
console.log('PASS village placement, collision bounds, ownership, rotation, conservation, save validation, and all procedural models');
