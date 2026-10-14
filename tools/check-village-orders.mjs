import assert from 'node:assert/strict';
import { initialState, validState, change, loadState, POCKETS } from '../src/pov/village/state.js';

const home = { home: true, dresser: true };
let state = initialState();
assert.ok(change(state, { type: 'order', kind: 'chair' }).error, 'catalogue orders require own home');
for (const kind of ['missing', '__proto__', 'dresser'])
  assert.ok(change(state, { type: 'order', kind }, home).error);
const original = structuredClone(state);
for (let n = state.pockets.length; n < POCKETS; n++) {
  const result = change(state, { type: 'order', kind: 'chair' }, home);
  assert.ok(!result.error, result.error);
  state = result.state;
  assert.ok(validState(state));
}
assert.deepEqual(state.placed, original.placed, 'orders never rearrange the room');
assert.deepEqual(state.storage, original.storage, 'orders preserve storage');
assert.ok(change(state, { type: 'order', kind: 'chair' }, home).error, 'pockets cannot overflow');
assert.equal(new Set(state.pockets.map(i => i.id)).size, POCKETS);
const ordered = state.pockets.find(i => i.id.startsWith('order-'));
state = change(state, { type: 'store', id: ordered.id }, home).state;
state = change(state, { type: 'order', kind: 'plant' }, home).state;
assert.ok(validState(state), 'IDs are unique across storage and pockets');
assert.deepEqual(loadState({ getItem: () => JSON.stringify(state) }, 'test').state, state);
const corrupt = structuredClone(state);
corrupt.placed.shift();
assert.equal(validState(corrupt), false, 'new orders must not mask missing original items');
const renamed = structuredClone(state);
renamed.pockets.find(i => i.id.startsWith('order-')).id = 'untrusted-id';
assert.equal(validState(renamed), false);
assert.deepEqual(loadState({ getItem: () => JSON.stringify(original) }, 'test').state, original, 'old saves remain valid without migration');
console.log('PASS catalogue orders, capacity, unique IDs, corruption rejection and v1 save preservation');
