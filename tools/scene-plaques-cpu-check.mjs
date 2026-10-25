import assert from 'node:assert/strict';
import test from 'node:test';
import { ScenePlaques, nearbyPlaques, SCENE_PLAQUE_LIMIT, decodeScenePlaques } from '../src/lab/scenePlaques.js';

const records = Array.from({ length: 120 }, (_, i) => ({
  cell: [i * 2, 2, 20], normal: [0, 0, -1], elementKey: `MAT_${i}`, text: `Material ${i}`,
}));
const fakeSigns = () => ({
  list: [],
  add(record) { const sign = { ...record }; this.list.push(sign); return sign; },
  remove(sign) { const i = this.list.indexOf(sign); if (i >= 0) this.list.splice(i, 1); },
});
test('catalog labels select nearby plates rather than filling the global sign cap', () => {
  assert.equal(nearbyPlaques(records, [20, 7, 20]).length, SCENE_PLAQUE_LIMIT);
  assert.equal(nearbyPlaques(records, [20, 40, 20]).length, 0, 'archive labels leak onto the story floor');
  const signs = fakeSigns(), owner = new ScenePlaques(signs);
  owner.set(records); owner.update([20, 7, 20]);
  assert.equal(signs.list.length, 32);
  assert(signs.list.some(p => p.elementKey === 'MAT_10'));
  owner.update([210, 7, 20]);
  assert.equal(signs.list.length, 32);
  assert(signs.list.some(p => p.elementKey === 'MAT_105'));
});
test('manual signs retain their slots and generated plates survive a saved reload without duplicates', () => {
  const signs = fakeSigns(), owner = new ScenePlaques(signs);
  for (let i = 0; i < 50; i++) signs.add({ text: `Manual ${i}` });
  owner.set(records); owner.update([20, 7, 20]);
  assert.equal(signs.list.length, 64);
  const manual = signs.list.filter(s => !s.sceneKey);
  signs.list = structuredClone(signs.list); // Signs.fromJSON creates new instances.
  owner.update([30, 7, 20]);
  assert.equal(signs.list.length, 64);
  assert.equal(signs.list.filter(s => !s.sceneKey).length, manual.length);
  assert.equal(new Set(signs.list.filter(s => s.sceneKey).map(s => s.sceneKey)).size, 14);
  owner.set([]); owner.update([30, 7, 20]);
  assert.equal(signs.list.length, 50);
});
test('full saved manifests keep old case positions and reject invalid records before restore', () => {
  const saved = [{ cell: [12, 2, 16], normal: [0, 0, -1], text: 'Sand', elementKey: 'SAND' }];
  const decoded = decodeScenePlaques(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(decoded, saved);
  assert.notEqual(decoded[0].cell, saved[0].cell);
  for (const value of [null, {}, Array(1025).fill(saved[0]), [{ ...saved[0], cell: [NaN, 2, 3] }],
    [{ ...saved[0], normal: [1, 1, 0] }], [{ ...saved[0], elementKey: 'UNKNOWN' }]]) {
    assert.throws(() => decodeScenePlaques(value), /Invalid scene plaque/);
  }
});
