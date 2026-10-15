// Predictions only: these tests do not place or settle native matter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { E } from '../../src/elements.js';
import { validateDevices } from '../../src/industry/validation.js';
import { hearthStructureCells } from '../../src/industry/hearth.js';
import { ballRadius, cellsNear, outsideBody, faceNormal } from '../../src/pov/tools/transfer.js';
import { firstOccupiedRayHit } from '../../tools/fixtures/industry-operator.js';
import { CHARGE_POSE, FUEL_POSE, loadingDeviceLayout } from '../../tools/fixtures/industry-loading.js';

const devices = validateDevices(loadingDeviceLayout(), [128, 128, 128]);
const hearth = devices.find(d => d.type === 'hearth');
const shell = new Map(hearthStructureCells(hearth).map(at => [at.join(','), E.TUNGSTEN]));
for (let z = 16; z <= 19; z++) for (let x = 20; x <= 23; x++) shell.set(`${x},15,${z}`, E.TUNGSTEN);
async function prediction(pose, n, occupied) {
  const feet = new Vector3(...pose.feet), eye = feet.clone().add(new Vector3(0, 5, 0));
  const sim = { g: { nx: 128, ny: 128, nz: 128 },
    readCell: async (x, y, z) => [[occupied.get(`${x},${y},${z}`) ?? E.EMPTY, 20, 0, 0]] };
  const direction = new Vector3(...pose.target).addScalar(0.5).sub(eye).normalize();
  const hit = await firstOccupiedRayHit({ sim, eye, direction, deadline: Date.now() + 1000 });
  const normal = faceNormal(hit.face), r = ballRadius(n), clear = outsideBody(feet, 0.3);
  const center = hit.cell.clone().addScalar(0.5).addScaledVector(normal, 0.5 + r);
  const candidates = cellsNear(center, ballRadius(n * 2.5), sim.g,
    (x, y, z) => (x - hit.cell.x) * normal.x + (y - hit.cell.y) * normal.y
      + (z - hit.cell.z) * normal.z >= 1 && clear(x, y, z));
  return { hit, firstEmpty: candidates.filter(at => !occupied.has(at.join(','))).slice(0, n) };
}
test('charge-first layout and external actor platform are buildable', () => {
  assert.equal(devices.length, 89);
  for (const pose of [CHARGE_POSE, FUEL_POSE]) {
    const [x, y, z] = pose.feet.map(Math.floor);
    assert.equal(shell.get(`${x},${y - 1},${z}`), E.TUNGSTEN);
    assert(!shell.has(`${x},${y},${z}`));
  }
});
test('real four-cell side-face throw initially offers four chamber placements', async () => {
  const { hit, firstEmpty } = await prediction(CHARGE_POSE, 4, shell);
  assert.deepEqual(hit.cell.toArray(), [16, 14, 18]);
  assert.equal(hit.face, 0);
  assert.deepEqual(firstEmpty, [[17, 14, 18], [18, 14, 18], [17, 14, 17], [17, 13, 18]]);
});
test('six-cell fuel prediction requires an observed four-cell scrap bed', async () => {
  const occupied = new Map(shell);
  for (const x of [17, 18]) for (const z of [17, 18]) occupied.set(`${x},13,${z}`, E.SCRAP);
  const { hit, firstEmpty } = await prediction(FUEL_POSE, 6, occupied);
  assert.deepEqual(hit.cell.toArray(), [16, 14, 17]);
  assert.equal(hit.face, 0);
  assert.deepEqual(firstEmpty, [[18, 14, 17], [17, 14, 17], [18, 15, 17],
    [18, 14, 18], [17, 15, 17], [17, 14, 18]]);
});
