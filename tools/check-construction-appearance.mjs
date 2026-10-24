// CPU-only: labels must not change geometry, physics or quarter-turn baking.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { E, ELEMENTS, K } from '../src/elements.js';
import { Appearance as A, appearanceOf, physicalCtype } from '../src/appearance.js';
import { BUILTINS, TREES } from '../src/constructions/builtins.js';
import { runGenerator, bake, turnPoint } from '../src/constructions/runtime.js';

const specs = [
  ...Object.keys(TREES).map(v => ['TREE', v]),
  ...['cottage', 'cabin', 'brick', 'greenhouse'].map(v => ['HOUSE', v]),
  ...['lit', 'unlit'].map(v => ['CAMPFIRE', v]),
  ...['keg', 'drum'].map(v => ['BARREL', v]),
  ...['pier', 'hut'].map(v => ['DOCK', v]),
  ...['watch', 'lighthouse', 'ruin'].map(v => ['TOWER', v]),
  ['WELL'], ['MINE'], ['WRECK'],
  ...['short', 'long'].map(v => ['BRIDGE', v]),
];
const build = (key, variant, size = 5, seed = 1) => runGenerator(BUILTINS[key], { size, seed, variant });
const role = (c, i) => appearanceOf(c.id[i], c.ctype[i]);
const rolesFor = (c, id) => new Set(Array.from({ length: c.n }, (_, i) => i).filter(i => c.id[i] === id).map(i => role(c, i)));
function at(c, x, y, z, id, appearance) {
  const i = Array.from({ length: c.n }, (_, i) => i).find(i => c.x[i] === x && c.y[i] === y && c.z[i] === z);
  assert.notEqual(i, undefined, `missing (${x},${y},${z})`);
  assert.equal(c.id[i], id, `physical id at (${x},${y},${z})`);
  assert.equal(role(c, i), appearance, `role at (${x},${y},${z})`);
}
// Independent of the production rotation helper.
function expectedTurn(a, q) {
  if (q % 2 === 0) return a;
  return new Map([[A.LOG_X, A.LOG_Z], [A.LOG_Z, A.LOG_X], [A.PLANK_X, A.PLANK_Z], [A.PLANK_Z, A.PLANK_X]]).get(a) ?? a;
}
function checkBake(c) {
  for (let q = 0; q < 4; q++) {
    const { w, h, base, data } = bake(c, q);
    const min = [-base.x, -base.y, -base.z];
    for (let i = 0; i < c.n; i++) {
      const [x, z] = turnPoint(c.x[i], c.z[i], q);
      const j = ((z - min[2]) * h + c.y[i] - min[1]) * w + x - min[0];
      assert.equal(data[j * 4], c.id[i] + 1);
      assert.equal(data[j * 4 + 1], c.temp[i]);
      assert.equal(appearanceOf(c.id[i], data[j * 4 + 2]), expectedTurn(role(c, i), q));
      assert.equal(physicalCtype(c.id[i], data[j * 4 + 2]), physicalCtype(c.id[i], c.ctype[i]));
      assert.equal(data[j * 4 + 3], c.foot && c.y[i] === 0 && ELEMENTS[c.id[i]].kind === K.SOLID ? 1 : 0);
    }
  }
}

// Frozen physical output from 15e18b1, before labels, including order and RNG.
// PLANKS hashes as WOOD: splitting sawn timber off the tree (elements.js
// TIMBER) moved no cell and changed no physics, only which of the two it is.
const timber = (id) => (id === E.PLANKS ? E.WOOD : id);
const hash = createHash('sha256');
let checked = 0;
for (const [key, variant] of specs) for (const size of [1, 5, 10]) for (const seed of [1, 0xdeadbeef]) {
  const c = build(key, variant, size, seed);
  hash.update(JSON.stringify([key, variant, size, seed, c.n, c.foot]));
  for (let i = 0; i < c.n; i++) {
    hash.update(JSON.stringify([c.x[i], c.y[i], c.z[i], timber(c.id[i]), c.temp[i], physicalCtype(c.id[i], c.ctype[i])]));
    // sawn timber is PLANKS, a tree's wood (logs, bark, a coconut, a rope) WOOD
    const plank = [A.PLANK_X, A.PLANK_Y, A.PLANK_Z].includes(role(c, i));
    if (c.id[i] === E.WOOD || c.id[i] === E.PLANKS) assert.equal(c.id[i], plank ? E.PLANKS : E.WOOD, `${key}/${variant}: ${plank ? 'sawn' : 'natural'} timber`);
    if (c.id[i] === E.WOOD || c.id[i] === E.PLANKS || c.id[i] === E.PLANT) {
      assert.notEqual(role(c, i), A.NONE, `${key}/${variant}/${size}/${seed}: unlabelled authored cell`);
      if (key === 'TREE' && c.id[i] === E.PLANT) assert.equal(role(c, i), A.LEAVES);
      if (key === 'HOUSE' && c.id[i] === E.PLANT) assert.equal(role(c, i), variant === 'greenhouse' ? A.LEAVES : A.PLAIN);
      if (['DOCK', 'TOWER', 'WELL', 'MINE', 'WRECK', 'BRIDGE', 'BARREL'].includes(key)) {
        assert.ok([A.PLANK_X, A.PLANK_Y, A.PLANK_Z, ...(key === 'WELL' ? [A.PLAIN] : [])].includes(role(c, i)), `${key}: not manufactured timber`);
      }
    } else assert.equal(role(c, i), A.NONE, `${key}: changed unrelated material`);
  }
  checkBake(c);
  checked += c.n;
}
assert.equal(hash.digest('hex'), '1f37db6203dd75b90990306b2e977ec21de1e641c00ad5e85282a0061c8213f8');

for (const v of ['oak', 'pine', 'birch', 'willow', 'dead']) assert.ok(rolesFor(build('TREE', v), E.WOOD).has(A.LOG_Y), `${v}: upright trunk`);
for (const v of ['oak', 'birch', 'palm', 'willow', 'dead']) assert.ok(rolesFor(build('TREE', v), E.WOOD).has(A.BARK), `${v}: irregular wood`);
assert.ok(rolesFor(build('TREE', 'palm'), E.WOOD).has(A.PLAIN), 'coconuts must not be logs');
at(build('TREE', 'oak'), 0, 0, 0, E.WOOD, A.BARK);
at(build('TREE', 'willow'), 0, 0, 0, E.WOOD, A.BARK);
for (const v of ['lit', 'unlit']) assert.deepEqual(rolesFor(build('CAMPFIRE', v), E.WOOD), new Set([A.LOG_Y]));

const cabin = build('HOUSE', 'cabin');
const slab = Array.from({ length: cabin.n }, (_, i) => i).filter(i => cabin.y[i] === 0);
const hw = Math.max(...slab.map(i => cabin.x[i])) - 1, hd = Math.max(...slab.map(i => cabin.z[i])) - 1;
at(cabin, hw - 2, 1, hd, E.WOOD, A.LOG_X);
at(cabin, -hw, 1, 0, E.WOOD, A.LOG_Z);
at(cabin, hw + 1, 1, -hd, E.WOOD, A.LOG_X);
at(cabin, hw, 2, -hd - 1, E.WOOD, A.LOG_Z);
at(cabin, hw, 1, -hd, E.WOOD, A.LOG_X);
at(cabin, hw, 2, -hd, E.WOOD, A.LOG_Z);
at(cabin, hw, 1, -Math.round(hd * 0.35), E.WOOD, A.LOG_Z);
at(cabin, -hw + 2, 2, -hd + 1, E.PLANT, A.PLAIN);
at(build('DOCK', 'pier'), 0, 1, 4, E.PLANKS, A.PLANK_X);
at(build('DOCK', 'pier'), -2, 0, 4, E.PLANKS, A.PLANK_Y);
at(build('WELL'), -3, 4, 0, E.PLANKS, A.PLANK_Y);
at(build('WELL'), 1, 8, 0, E.PLANKS, A.PLANK_X);
at(build('WELL'), 0, 5, 0, E.WOOD, A.PLAIN);
at(build('MINE'), 0, 0, -2, E.PLANKS, A.PLANK_X);
at(build('MINE'), 3, 2, -4, E.PLANKS, A.PLANK_Y);
at(build('MINE'), 2, 8, -4, E.PLANKS, A.PLANK_X);
at(build('BRIDGE', 'short'), 0, 1, 0, E.PLANKS, A.PLANK_X);
at(build('BRIDGE', 'short'), 3, 4, 0, E.PLANKS, A.PLANK_Z);
at(build('BRIDGE', 'short'), 3, 3, -10, E.PLANKS, A.PLANK_Y);

const legacy = runGenerator(({ put }) => { put(0, 0, 0, 'WOOD'); put(1, 0, 0, 'PLANT'); }, { size: 5, seed: 1 });
assert.deepEqual(Array.from(legacy.ctype), [0, 0]);
checkBake(legacy);
console.log(`construction appearance: ${checked} physical cells, all variants and quarter turns OK`);
