import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { E } from '../../src/elements.js';
import { hearthStructureCells } from '../../src/industry/hearth.js';
import { FUEL_POSE } from '../../tools/fixtures/industry-loading.js';
import { lineRefuelPoses } from '../../tools/fixtures/industry-line.js';
import { firstOccupiedRayHit } from '../../tools/fixtures/industry-operator.js';

const cells = new Map(hearthStructureCells({
  type: 'hearth', x: 16, y: 12, z: 16, rotation: 0,
}).map(at => [at.join(','), E.TUNGSTEN]));
for (let x = 20; x < 24; x++) for (let z = 16; z < 20; z++) cells.set(`${x},15,${z}`, E.TUNGSTEN);
for (const x of [17, 18]) for (const z of [17, 18]) cells.set(`${x},13,${z}`, E.SCRAP);
// The two real remaining ash cells from the failed four-cell native batch.
cells.set('18,14,17', E.ASH);
cells.set('18,15,17', E.ASH);
const sim = { g: { nx: 128, ny: 128, nz: 128 },
  readCell: async (x, y, z) => [[cells.get(`${x},${y},${z}`) ?? E.EMPTY, 20, 0, 0]] };
const hitFrom = pose => {
  const eye = new Vector3(...pose.feet).add(new Vector3(0, 5, 0));
  const direction = pose.direction ? new Vector3(...pose.direction)
    : new Vector3(...pose.target).addScalar(0.5).sub(eye);
  return firstOccupiedRayHit({ sim, eye, direction: direction.normalize(), deadline: Date.now() + 1000 });
};

test('the original fuel-centre ray is blocked by observed ash after exhaustion', async () => {
  const hit = await hitFrom(FUEL_POSE);
  assert.equal(hit.id, E.ASH);
});

test('bounded refuel poses stand on real supports and can see the intended side face', async () => {
  const candidates = lineRefuelPoses();
  for (const { pose } of candidates) {
    const at = pose.feet.map((v, i) => Math.floor(v - (i === 1 ? 0.001 : 0)));
    assert.equal(cells.get(at.join(',')), E.TUNGSTEN);
  }
  const hit = await hitFrom(candidates[0].pose);
  assert.equal(hit.id, E.TUNGSTEN);
  assert.deepEqual(hit.cell.toArray(), candidates[0].wall);
  assert.equal(hit.face, candidates[0].face);
});
