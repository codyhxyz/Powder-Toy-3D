import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E, ELEMENTS, K, elementRow } from '../src/elements.js';
import { MAPS, mapByKey } from '../src/maps.js';
import { buildPreservation, PRESERVATION_SIZE, PRESERVATION_SPAWN, PRESERVATION_GATES } from '../src/lab/preservation/index.js';
import { createExhibitCatalog } from '../src/lab/catalog.js';
import { buildPreset } from '../src/presets.js';
import { renderPreservation } from './preservation-thumb.mjs';

const [nx, ny, nz] = PRESERVATION_SIZE;
const ids = new Uint8Array(nx * ny * nz);
const index = (x, y, z) => (y * nz + z) * nx + x;
const inside = (x, y, z) => x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz;
const at = (x, y, z) => inside(x, y, z) ? ids[index(x, y, z)] : E.WALL;
const solid = (x, y, z) => [K.SOLID, K.POWDER].includes(ELEMENTS[at(x, y, z)].kind);
const set = (x, y, z, id) => {
  assert([x, y, z, id].every(Number.isInteger) && inside(x, y, z), `invalid voxel ${[x, y, z, id]}`);
  assert(ELEMENTS[id]);
  ids[index(x, y, z)] = id;
};
const box = (x0, y0, z0, x1, y1, z1, id) => {
  assert([x0, y0, z0, x1, y1, z1].every(Number.isInteger), 'noninteger box');
  assert(x0 < x1 && y0 < y1 && z0 < z1, `empty box ${[x0, y0, z0, x1, y1, z1]}`);
  assert(inside(x0, y0, z0) && inside(x1 - 1, y1 - 1, z1 - 1), `out-of-bounds box ${[x0, y0, z0, x1, y1, z1]}`);
  assert(ELEMENTS[id]);
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) ids.fill(id, index(x0, y, z), index(x1 - 1, y, z) + 1);
};
const built = buildPreservation({ box, set });

// Conservative 3-cell footprint / 6-cell headroom. Partial footprint support
// permits the player's real one-cell step, rather than forbidding every stair.
const walkable = (x, y, z) => {
  if (!inside(x, y + 6, z)) return false;
  let support = false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    support ||= solid(x + dx, y - 1, z + dz);
    for (let dy = 0; dy < 6; dy++) if (solid(x + dx, y + dy, z + dz)) return false;
  }
  return support;
};
function flood(start) {
  const seen = new Uint8Array(ids.length), points = [];
  function visit(x, y, z) {
    if (!walkable(x, y, z) || seen[index(x, y, z)]) return;
    seen[index(x, y, z)] = 1; points.push([x, y, z]);
  }
  visit(...start);
  for (let cursor = 0; cursor < points.length; cursor++) {
    const [x, y, z] = points[cursor];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) visit(x + dx, y + dy, z + dz);
  }
  return { seen, points };
}
const reached = flood(PRESERVATION_SPAWN);

test('Preservation replaces the comparison map and has a first-person entrance', () => {
  assert(!MAPS.some(m => m.key === 'labStudies'));
  assert.equal(mapByKey('labStudies').key, 'preservationLab');
  assert(mapByKey('preservationLab').startInPov);
  assert.deepEqual(mapByKey('preservationLab').dims, PRESERVATION_SIZE);
  for (const n of [64, 128]) assert.throws(() => buildPreset('preservationLab', { g: { nx: n, ny: n, nz: n } }), /requires a 256×96×128/);
});

test('every material and named effect has exactly one primary exhibit', () => {
  const keys = built.plaques.filter(p => p.elementKey).map(p => p.elementKey);
  assert.equal(keys.length, createExhibitCatalog().length);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys.slice().sort(), createExhibitCatalog().map(e => e.key).sort());
  for (const key of ['SAND', 'GLASS', 'WATER', 'OIL', 'CO2', 'ICE', 'SINGULARITY']) {
    assert(!built.stocks.some(entry => entry.key === key), `${key} is redundantly archived`);
  }
});

test('story landmarks, reservoir exits, final dais and archive are reachable indoors', () => {
  assert(walkable(...PRESERVATION_SPAWN));
  const unreachable = [];
  for (const chapter of built.chapters) for (const [key, p] of Object.entries(chapter.landmarks)) {
    if (!reached.seen[index(...p)]) unreachable.push(`${chapter.key}.${key} at ${p}`);
  }
  assert.deepEqual(unreachable, []);
  assert(reached.seen[index(96, 2, 112)], 'archive stair does not connect');
  for (const [x, y, z] of reached.points) {
    let roof = false;
    for (let h = y + 6; h < ny; h++) if (solid(x, h, z)) { roof = true; break; }
    assert(roof, `open sky over ${[x, y, z]}`);
  }
});

test('public to service to restricted is one sequence, not three doors from a lobby', () => {
  for (let i = 0; i < PRESERVATION_GATES.length; i++) {
    const gate = PRESERVATION_GATES[i], saved = ids.slice();
    box(...gate, E.WALL);
    const closed = flood(PRESERVATION_SPAWN);
    const destination = built.chapters[i + 1].landmarks.entry;
    assert(!closed.seen[index(...destination)], `gate ${i} can be bypassed`);
    ids.set(saved);
  }
});

test('all plaques have exposed anchors and nearby reachable inspection space', () => {
  for (const plaque of built.plaques) {
    assert(plaque.text.length <= 80 && !/[\r\n]/.test(plaque.text), `invalid sign ${plaque.text}`);
    assert(solid(...plaque.cell), `unanchored ${plaque.text} at ${plaque.cell}`);
    assert.equal(plaque.normal.reduce((sum, n) => sum + Math.abs(n), 0), 1);
    assert(!solid(...plaque.cell.map((n, i) => n + plaque.normal[i])), `buried ${plaque.text}`);
    const near = reached.points.some(([x, y, z]) => Math.hypot(x - plaque.cell[0], y + 5 - plaque.cell[1], z - plaque.cell[2]) <= 15);
    assert(near, `unreadable ${plaque.text}`);
  }
});

test('stocks follow catalog admission; impossible specimens are not faked', () => {
  for (const stock of built.stocks) {
    const [x0, y0, z0, x1, y1, z1] = stock.bounds;
    let found = false;
    for (let y = y0 + 1; y < y1 - 1; y++) for (let z = z0 + 1; z < z1 - 1; z++) for (let x = x0 + 1; x < x1 - 1; x++) {
      if (at(x, y, z) === stock.elementId) found = true;
    }
    if (stock.status === 'candidate' && stock.type === 'material') assert(found, `missing ${stock.key}`);
    else if (stock.elementId != null) assert(!found, `unsupported live ${stock.key}`);
  }
  assert(!ids.includes(E.SINGULARITY) && !ids.includes(E.ANTIMATTER) && !ids.includes(E.PLUTONIUM));
});

test('an appended element is stocked without editing a chapter or map list', () => {
  const extra = elementRow({ key: 'NEW_STOCK', name: 'New stock', kind: K.POWDER, dens: 12 }, ELEMENTS.length);
  const added = buildPreservation({ box() {}, set() {}, elements: [...ELEMENTS, extra] });
  assert.equal(added.plaques.filter(p => p.elementKey === 'NEW_STOCK').length, 1);
  assert(added.stocks.some(entry => entry.key === 'NEW_STOCK' && entry.category === 'powder'));
});

test('software preview traces the real public and empty-chamber geometry without GPU use', () => {
  for (const pose of ['arrival', 'final']) {
    const { rgb, materials } = renderPreservation(32, pose);
    assert.equal(rgb.length, 32 * 32 * 3);
    assert(materials.has(E.CERAMIC) && materials.has(E.METAL));
    assert(new Set(rgb).size > 10);
  }
});
