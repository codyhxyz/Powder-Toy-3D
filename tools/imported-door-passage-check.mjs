// Real published voxels and normal body/controller; GPU readback alone is mocked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { triangleIntersectsCell } from '../src/world/import/voxelize.js';
import { actorBodyClear } from '../src/world/import/crueltyMission.js';
import { createPlayer } from '../src/pov/player.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';

const clockwiseCeiling = [[0, 8, 0], [0, 8, 2], [2, 8, 0]];
assert.ok(triangleIntersectsCell(clockwiseCeiling, [0, 8, 0]), 'ceiling occupies its authored solid side');
assert.ok(!triangleIntersectsCell(clockwiseCeiling, [0, 7, 0]), 'no phantom lower ceiling layer');
assert.ok(triangleIntersectsCell([...clockwiseCeiling].reverse(), [0, 7, 0]), 'floor uses the opposite authored solid side');
assert.ok(!triangleIntersectsCell([[1.5, 8, 0], [1.5, 8, 2], [1.5, 10, 0]], [1, 7, 0]), 'a jamb edge merely touching the cell above cannot lower the doorway');

const flush = () => new Promise(resolve => setImmediate(resolve));
for (const [id, path] of [['pharmakokinetiks', 'entity_6_Door'], ['paradise', 'entity_14_Door'],
  ['androgenAssault', 'entity_40_Door'], ['apartmentAtrocity', 'entity_7_Door']]) {
  const map = JSON.parse(readFileSync(new URL(`../public/local-maps/${id}.json`, import.meta.url)));
  const bytes = gunzipSync(readFileSync(new URL(`../public/local-maps/${map.dataFile}`, import.meta.url)));
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const scene = createImportedMapScene(map, words);
  const door = map.interactions.doors.find(d => d.sourcePath === `QodotMap/${path}`);
  const { min, max } = door.bounds;
  const axis = max[0] - min[0] < max[2] - min[2] ? 0 : 2;
  const at = min.map((n, k) => k === 1 ? n + 1 : (n + max[k]) / 2);
  assert.equal(actorBodyClear(map, words, at), false, `${id}: closed leaf blocks normal body`);
  scene.interactionState.open(door, Array(door.cells.length / 2).fill(1));
  assert.ok(actorBodyClear(map, words, at), `${id}: open aperture clears full normal body, not only its feet`);
  const sim = { g: { nx: map.size[0], ny: map.size[1], nz: map.size[2] }, frame: 0,
    gravity: 0.025, touchCentres: () => [], paint() {} };
  setPovGpu(sim, { ready: true, edit: () => true, transfer: () => null,
    probe(_name, { boxLo: lo }) {
      const data = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        data[i] = scene.cell(lo[0] + x, lo[1] + y, lo[2] + z); data[i + 1] = 20;
      }
      return Promise.resolve(data.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
  const frame = async input => { sim.frame++; body.update(1 / 60, input); await flush(); };
  try {
    const start = [...at]; start[axis] = min[axis] - 2;
    body.spawn(new THREE.Vector3(...start));
    for (let i = 0; i < 5; i++) await frame({});
    for (let i = 0; i < 30 && body.pos.getComponent(axis) < max[axis] + 1; i++) {
      await frame({ cruelty: true, move: { x: axis === 0 ? 1 : 0, z: axis === 2 ? 1 : 0 } });
    }
    assert.ok(body.pos.getComponent(axis) >= max[axis] + 1, `${id}: actual standing controller crosses doorway`);
    scene.interactionState.close(door, Array(door.cells.length / 2).fill(1));
    assert.equal(actorBodyClear(map, words, at), false, `${id}: closing restores obstruction`);
    scene.reset();
    console.log(`PASS ${id}: source aperture, standing body passage, close and reset`);
  } finally { body.dispose(); }
}
