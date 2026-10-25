import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS, K } from '../src/elements.js';
import { MAPS } from '../src/maps.js';
import { buildLabStudies, LAB_STUDIES_SIZE, LAB_STUDIES_SPAWN, LAB_STUDIES_HALLS } from '../src/lab/studies/index.js';
import { BODY_HEIGHT, HAND_REACH } from '../src/pov/constants.js';
import { buildPreset } from '../src/presets.js';

const [nx, ny, nz] = LAB_STUDIES_SIZE;
const ids = new Uint8Array(nx * ny * nz);
const index = (x, y, z) => (y * nz + z) * nx + x;
const inside = (x, y, z) => x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz;
const at = (x, y, z) => inside(x, y, z) ? ids[index(x, y, z)] : E.WALL;
const set = (x, y, z, id) => {
  assert([x, y, z, id].every(Number.isInteger));
  assert(inside(x, y, z), `out-of-bounds voxel ${[x, y, z]}`);
  assert(ELEMENTS[id], `invalid element ${id}`);
  ids[index(x, y, z)] = id;
};
const box = (x0, y0, z0, x1, y1, z1, id) => {
  assert([x0, y0, z0, x1, y1, z1].every(Number.isInteger));
  assert(x0 < x1 && y0 < y1 && z0 < z1, `empty/reversed box ${[x0, y0, z0, x1, y1, z1]}`);
  assert(inside(x0, y0, z0) && inside(x1 - 1, y1 - 1, z1 - 1), 'out-of-bounds box');
  assert(ELEMENTS[id]);
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) ids.fill(id, index(x0, y, z), index(x1 - 1, y, z) + 1);
  }
};
const built = buildLabStudies({ box, set });
const solid = (x, y, z) => ELEMENTS[at(x, y, z)].kind === K.SOLID;

// A conservative 3-cell-wide clearance check around a 1.6-cell body.
// This is static geometry evidence, not a replacement for player collision tests.
const walkable = (x, y, z) => {
  if (!inside(x, y + Math.ceil(BODY_HEIGHT), z)) return false;
  let supported = false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    supported ||= solid(x + dx, y - 1, z + dz);
    for (let dy = 0; dy < Math.ceil(BODY_HEIGHT); dy++) if (solid(x + dx, y + dy, z + dz)) return false;
  }
  // On a stair edge, part of the 1.6-cell footprint reaches the next tread
  // before its center does. Requiring center-only support forbids all steps.
  return supported;
};
const visited = new Uint8Array(ids.length), reached = [];
const enqueue = (x, y, z) => {
  if (!walkable(x, y, z)) return;
  const i = index(x, y, z);
  if (visited[i]) return;
  visited[i] = 1;
  reached.push([x, y, z]);
};
enqueue(...LAB_STUDIES_SPAWN);
for (let cursor = 0; cursor < reached.length; cursor++) {
  const [x, y, z] = reached[cursor];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, 1, -1]) enqueue(x + dx, y + dy, z + dz);
  }
}

test('registered map uses the authored grid and keeps the original labs', () => {
  const map = MAPS.find(m => m.key === 'labStudies');
  assert.equal(map.preset, 'labStudies');
  assert.deepEqual(map.dims, LAB_STUDIES_SIZE);
  assert(MAPS.some(m => m.key === 'lab') && MAPS.some(m => m.key === 'labWorld'));
});

test('wrong-size direct preset loads are refused before allocating or clipping', () => {
  for (const n of [64, 128]) assert.throws(() => buildPreset('labStudies', {
    g: { nx: n, ny: n, nz: n },
    blankState() { throw new Error('should not allocate a wrong-size scene'); },
  }), /Lab Studies requires a 256×96×128 grid/);
});

test('three distinct hand-authored halls connect to the foyer with body clearance', () => {
  assert.equal(built.halls.length, 3);
  assert(walkable(...LAB_STUDIES_SPAWN));
  for (const hall of LAB_STUDIES_HALLS) {
    const [x, , z] = hall.origin;
    assert(visited[index(x + 38, 2, z + 5)], `${hall.key} entry is unreachable`);
  }
  assert(reached.some(([, y]) => y >= 10), 'no reachable elevated catwalk');
});

test('every reachable walking position has an indoor roof', () => {
  for (const [x, y, z] of reached) {
    let roof = false;
    for (let h = y + Math.ceil(BODY_HEIGHT); h < ny; h++) if (solid(x, h, z)) { roof = true; break; }
    assert(roof, `open sky above walking position ${[x, y, z]}`);
  }
  for (const { origin: [ox, , oz] } of LAB_STUDIES_HALLS) {
    for (let x = ox + 2; x < ox + 74; x++) for (let z = oz + 2; z < oz + 90; z++) {
      let roof = false;
      for (let y = 20; y < 64; y++) if (solid(x, y, z)) { roof = true; break; }
      assert(roof, `missing roof over hall column ${[x, z]}`);
    }
  }
});

test('specimen plaques are short, anchored, inspectable and readable from the walkways', () => {
  assert(built.plaques.length > 12 && built.plaques.length < 64);
  for (const plaque of built.plaques) {
    assert(plaque.text.length <= 80, `sign too long: ${plaque.text}`);
    assert(solid(...plaque.cell), `sign has no solid anchor: ${plaque.text} at ${plaque.cell}`);
    assert.equal(plaque.normal.reduce((n, v) => n + Math.abs(v), 0), 1);
    assert(!solid(...plaque.cell.map((n, i) => n + plaque.normal[i])), `buried sign face: ${plaque.text}`);
    if (!plaque.elementKey) continue;
    assert(Object.hasOwn(E, plaque.elementKey), `unknown specimen ${plaque.elementKey}`);
    const distance = Math.min(...reached.map(([x, y, z]) => Math.hypot(x - plaque.cell[0], y + 5 - plaque.cell[1], z - plaque.cell[2])));
    assert(distance <= HAND_REACH, `specimen label out of viewing reach (${distance.toFixed(1)}): ${plaque.text}`);
  }
});

test('samples are real materials, but dangerous exotics are plaque-only', () => {
  const present = new Set(ids);
  for (const key of ['SAND', 'WATER', 'OIL', 'CO2', 'ACID', 'ICE']) assert(present.has(E[key]), `missing representative sample ${key}`);
  for (const key of ['SINGULARITY', 'ANTIMATTER', 'PLUTONIUM']) assert(!present.has(E[key]), `unexpected live destructive specimen ${key}`);
  assert(built.plaques.some(p => p.elementKey === 'SINGULARITY'));
});
