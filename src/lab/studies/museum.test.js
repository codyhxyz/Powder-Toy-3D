import assert from 'node:assert/strict';
import test from 'node:test';
import { E, ELEMENTS, K } from '../../elements.js';
import { buildMuseum } from './museum.js';

const SIZE = [76, 64, 92];
const index = (x, y, z) => (y * SIZE[2] + z) * SIZE[0] + x;
const cells = new Uint16Array(SIZE[0] * SIZE[1] * SIZE[2]);
const at = (x, y, z) => cells[index(x, y, z)];
const solid = (id) => ELEMENTS[id].kind === K.SOLID;
function checkCell(cell) {
  cell.forEach((v, axis) => assert.ok(Number.isInteger(v) && v >= 0 && v < SIZE[axis]));
}
function set(x, y, z, id) {
  checkCell([x, y, z]);
  assert.ok(Number.isInteger(id) && ELEMENTS[id], `valid element ${id}`);
  cells[index(x, y, z)] = id;
}
const result = buildMuseum({ set, box(x0, y0, z0, x1, y1, z1, id) {
  checkCell([x0, y0, z0]);
  [x1, y1, z1].forEach((v, axis) => {
    assert.ok(Number.isInteger(v) && v <= SIZE[axis] && v > [x0, y0, z0][axis]);
  });
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) set(x, y, z, id);
  }
} });

test('all writes are integer, half-open, local and use defined elements', () => {
  assert.ok(cells.some((id) => id === E.SAND));
  assert.ok(cells.some((id) => id === E.WATER));
  assert.ok(cells.some((id) => id === E.CO2));
});

test('continuous floor, full roof, enclosed walls and clear foyer entry', () => {
  for (let x = 0; x < 76; x++) for (let z = 0; z < 92; z++) {
    for (let y = 0; y < 2; y++) assert.equal(at(x, y, z), E.WALL);
    for (let y = 38; y < 40; y++) assert.ok(solid(at(x, y, z)));
  }
  for (let y = 2; y < 38; y++) {
    for (let z = 0; z < 92; z++) {
      assert.equal(at(0, y, z), E.WALL);
      assert.equal(at(75, y, z), E.WALL);
    }
    for (let x = 0; x < 76; x++) {
      assert.equal(at(x, y, 91), E.WALL);
      for (let z = 0; z < 2; z++) {
        assert.equal(at(x, y, z), x >= 32 && x < 44 && y < 14 ? E.EMPTY : E.WALL);
      }
    }
  }
  for (let x = 32; x < 44; x++) for (let y = 2; y < 14; y++) {
    for (let z = 0; z < 8; z++) assert.equal(at(x, y, z), E.EMPTY);
  }
});

test('plaques have exposed solid anchors; landmarks have support and headroom', () => {
  assert.ok(result.plaques.length <= 10);
  for (const { cell, normal, text, elementKey } of result.plaques) {
    checkCell(cell);
    assert.ok(text.length > 0 && text.length <= 80);
    assert.ok(solid(at(...cell)), `anchor for ${text}`);
    assert.equal(normal.reduce((sum, v) => sum + Math.abs(v), 0), 1);
    const face = cell.map((v, axis) => v + normal[axis]);
    checkCell(face);
    assert.equal(at(...face), E.EMPTY, `exposed face for ${text}`);
    if (elementKey) assert.ok(Number.isInteger(E[elementKey]));
  }
  for (const [name, cell] of Object.entries(result.landmarks)) {
    checkCell(cell);
    const [x, y, z] = cell;
    assert.ok(solid(at(x, y - 1, z)), `${name} support`);
    for (let dy = 0; dy < 6; dy++) assert.ok(!solid(at(x, y + dy, z)), `${name} headroom`);
  }
});

test('samples are supported and each dry/gas cell is sealed on all six faces', () => {
  const enclosures = [
    { bounds: [6, 6, 14, 24, 22, 30], sample: [12, 6, 20] },
    { bounds: [6, 6, 38, 24, 22, 54], sample: [12, 6, 44] },
    { bounds: [6, 6, 62, 24, 22, 78], sample: [12, 6, 68] },
    { bounds: [52, 6, 14, 64, 22, 30], sample: [54, 6, 20] },
  ];
  for (const { bounds: [x0, y0, z0, x1, y1, z1], sample } of enclosures) {
    assert.ok(solid(at(sample[0], sample[1] - 1, sample[2])));
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
      assert.ok(solid(at(x0 - 1, y, z)));
      assert.ok(solid(at(x1, y, z)));
    }
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) {
      assert.ok(solid(at(x, y, z0 - 1)));
      assert.ok(solid(at(x, y, z1)));
    }
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      assert.ok(solid(at(x, y0 - 1, z)));
      assert.ok(solid(at(x, y1, z)));
    }
  }
});

test('broad pool approach and submerged exit climb one cell per two-cell tread', () => {
  const top = (x, z) => {
    for (let y = 15; y >= 0; y--) if (solid(at(x, y, z))) return y + 1;
    assert.fail('missing stair support');
  };
  for (let x = 50; x < 58; x++) {
    for (let z = 36; z < 58; z++) {
      const expected = z < 40 ? 2 : z < 46 ? 3 + Math.floor((z - 40) / 2)
        : z < 52 ? 6 : z < 56 ? 5 - Math.floor((z - 52) / 2) : 3;
      assert.equal(top(x, z), expected);
      for (let dy = 0; dy < 8; dy++) assert.ok(!solid(at(x, expected + dy, z)));
    }
  }
  for (let x = 66; x < 74; x++) for (let z = 2; z < 90; z++) {
    for (let y = 2; y < 8; y++) assert.equal(at(x, y, z), E.EMPTY);
  }
  // Both poolside decks are eight cells wide, including beneath the rib.
  for (const [left, right] of [[42, 50], [58, 66]]) {
    for (let x = left; x < right; x++) for (let z = 50; z < 68; z++) {
      assert.equal(at(x, 5, z), E.WALL);
      for (let y = 6; y < 14; y++) assert.equal(at(x, y, z), E.EMPTY);
    }
  }
});
