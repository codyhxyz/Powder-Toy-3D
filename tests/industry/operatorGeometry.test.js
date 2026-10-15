// Geometry/protocol checks only. These do not execute tools or native physics.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { E } from '../../src/elements.js';
import { HAND_REACH } from '../../src/pov/constants.js';
import { validateDevices } from '../../src/industry/validation.js';
import { purelineDeviceLayout, isColdLineMinedCoal } from '../../tools/fixtures/industry-line.js';
import { firstOccupiedRayHit } from '../../tools/fixtures/industry-operator.js';

function scene(occupied) {
  const reads = [];
  return { reads, g: { nx: 128, ny: 128, nz: 128 },
    async readCell(x, y, z) {
      reads.push([x, y, z]);
      return [new Float32Array([occupied(x, y, z), 20, 0, 0.375])];
    } };
}
const cast = (sim, eye, direction, extra = {}) => firstOccupiedRayHit({
  sim, eye: new Vector3(...eye), direction: new Vector3(...direction),
  deadline: Date.now() + 1000, ...extra,
});

test('operator rays return the first real obstruction, entry face and distance', async () => {
  const sim = scene((x, y, z) => x === 2 && z === 2 && y <= 5 ? E.TUNGSTEN : E.EMPTY);
  const hit = await cast(sim, [2.5, 7.5, 2.5], [0, -1, 0]);
  assert.equal(hit.id, E.TUNGSTEN);
  assert.deepEqual(hit.cell.toArray(), [2, 5, 2]);
  assert.equal(hit.face, 2);
  assert.equal(hit.dist, 1.5);
  assert(!sim.reads.some(([, y]) => y < 5), 'cannot target material behind the first occupied voxel');
});

test('operator rays derive opposite horizontal entry faces', async () => {
  for (const [eye, direction, wallX, face] of [
    [[1.5, 2.5, 2.5], [1, 0, 0], 3, 1],
    [[7.5, 2.5, 2.5], [-1, 0, 0], 5, 0],
  ]) {
    const hit = await cast(scene(x => x === wallX ? E.WALL : E.EMPTY), eye, direction);
    assert.equal(hit.face, face);
    assert.equal(hit.dist, 1.5);
  }
});

test('operator refuses a pose inside matter rather than inventing an entry face', async () => {
  assert.equal(await cast(scene(() => E.WALL), [2.5, 2.5, 2.5], [0, -1, 0]), null);
});

test('operator rays ignore fire and other gas exactly as the player picker does', async () => {
  const sim = scene((x, y, z) => y === 6 ? E.FIRE : y === 5 ? E.SMOKE : y === 4 ? E.LAVA : E.EMPTY);
  const hit = await cast(sim, [2.5, 7.5, 2.5], [0, -1, 0]);
  assert.equal(hit.id, E.LAVA);
  assert.deepEqual(hit.cell.toArray(), [2, 4, 2]);
  assert.equal(hit.face, 2);
  assert.equal(hit.dist, 2.5);
});

test('operator ray probes are limited by real hand reach and the deadline', async () => {
  const farX = Math.floor(10.5 + HAND_REACH) + 2;
  const sim = scene(x => x === farX ? E.SCRAP : E.EMPTY);
  assert.equal(await cast(sim, [10.5, 64.5, 64.5], [1, 0, 0]), null);
  assert(sim.reads.every(([x]) => x <= Math.floor(10.5 + HAND_REACH)));
  const expired = scene(() => E.EMPTY);
  await assert.rejects(cast(expired, [2.5, 2.5, 2.5], [0, -1, 0], { deadline: Date.now() - 1 }), /deadline/);
  assert.equal(expired.reads.length, 0);
});

test('operator observes read and fence failures without orphaned rejections', async () => {
  const sim = { g: { nx: 128, ny: 128, nz: 128 }, readCell: () => Promise.reject(new Error('read failed')) };
  await assert.rejects(cast(sim, [2.5, 2.5, 2.5], [0, -1, 0], {
    flush: () => Promise.reject(new Error('fence failed')),
  }), /read failed|fence failed/);
});

test('only tool mode adds a buildable apron supporting every source neighbour', () => {
  assert.equal(purelineDeviceLayout().length, 83);
  const devices = validateDevices(purelineDeviceLayout({ operatorMode: 'tools' }), [128, 128, 128]);
  assert.equal(devices.length, 89);
  const support = new Set();
  for (const d of devices) if (d.y === 29)
    for (let z = d.z; z < d.z + 4; z++) for (let x = d.x; x < d.x + 4; x++) support.add(`${x},${z}`);
  for (const [maxX, firstZ] of [[98, 96], [97, 100]])
    for (let z = firstZ; z <= firstZ + 1; z++) for (let x = 96; x <= maxX; x++)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
        assert(support.has(`${x + dx},${z + dz}`), 'source grains cannot topple off an unsupported edge');
});

test('cold mined payload permits native friction heating, not hot or spent fuel', () => {
  assert(isColdLineMinedCoal([E.BROKENCOAL, 20.15653, 1, 0.375]));
  assert(!isColdLineMinedCoal([E.BROKENCOAL, 550, 1, 0.375]));
  assert(!isColdLineMinedCoal([E.BROKENCOAL, 20, 0.99, 0.375]));
  assert(!isColdLineMinedCoal([E.COAL, 20, 1, 0.375]));
  assert(!isColdLineMinedCoal([E.BROKENCOAL, NaN, 1, 0.375]));
});
