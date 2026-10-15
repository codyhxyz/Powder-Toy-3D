import assert from 'node:assert/strict';
import test from 'node:test';
import { E } from '../../src/elements.js';
import { baseMaterial, deviceCell } from '../../src/industry/catalog.js';
import { hearthRegions, hearthStructureCells } from '../../src/industry/hearth.js';
import { deviceHeight } from '../../src/industry/validation.js';

const device = rotation => ({ type: 'hearth', x: 12, y: 8, z: 20, rotation });
const key = cell => cell.join(',');
const localVolume = (d, height = 4) => {
  const cells = [];
  for (let y = 0; y < height; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++)
    cells.push(deviceCell(d, x, y, z));
  return cells;
};
const buildCells = d => d.type === 'hearth'
  ? hearthStructureCells(d)
  : Array.from({ length: 16 }, (_, i) => deviceCell(d, i % 4, 0, Math.floor(i / 4)));

// CPU mock of the construction dispatch contract: test every reserved cell
// before its first write; removal visits only the selected construction cells.
function mockConstruction(world, d, mode) {
  if (mode === 1) {
    const reservation = localVolume(d, deviceHeight(d));
    if (reservation.some(c => !world.has(key(c)) || world.get(key(c)).id !== E.EMPTY)) return false;
    for (const c of buildCells(d)) world.set(key(c), { id: baseMaterial(d.type) });
    return true;
  }
  if (mode === 2) {
    for (const c of buildCells(d)) {
      const k = key(c), cell = world.get(k);
      if (cell?.id === baseMaterial(d.type)) world.set(k, { id: E.EMPTY });
    }
    return true;
  }
  return true;
}

function emptyWorld(d, height = 4) {
  return new Map(localVolume(d, height).map(c => [key(c), { id: E.EMPTY }]));
}

test('48-cell refractory shell, rotated, fits its reservation and leaves all working regions open', () => {
  for (let rotation = 0; rotation < 4; rotation++) {
    const d = device(rotation), regions = hearthRegions(d), shell = hearthStructureCells(d);
    const shellSet = new Set(shell.map(key));
    assert.equal(shell.length, 48);
    assert.equal(shellSet.size, 48);
    assert.deepEqual([regions.fuel.length, regions.charge.length, regions.outlet.length], [6, 6, 4]);
    const working = [...regions.fuel, ...regions.charge, ...regions.outlet];
    assert.equal(new Set(working.map(key)).size, 16);
    for (const c of [...shell, ...working]) {
      assert(c[0] >= d.x && c[0] < d.x + 4);
      assert(c[1] >= d.y && c[1] < d.y + 4);
      assert(c[2] >= d.z && c[2] < d.z + 4);
    }
    assert(working.every(c => !shellSet.has(key(c))), 'fuel, charge, and outlet remain interior/open cells');

    const expected = [];
    for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++)
      if (y === 0 || (y >= 1 && (x === 0 || x === 3 || z === 0 || (z === 3 && y === 1))))
        expected.push(deviceCell(d, x, y, z));
    assert.deepEqual(shell.map(key).sort(), expected.map(key).sort(), `rotation ${rotation} matches the approved floor, walls, and lip`);
  }
});

test('hearth placement preflights all 64 cells atomically before writing the 48-cell shell', () => {
  const d = device(0), world = emptyWorld(d);
  const obstructed = deviceCell(d, 1, 3, 2); // an unshelled working cell is still in the reservation
  world.set(key(obstructed), { id: E.SCRAP });
  assert.equal(mockConstruction(world, d, 1), false);
  assert.equal([...world.values()].filter(c => c.id === E.TUNGSTEN).length, 0, 'failed preflight writes nothing');

  world.set(key(obstructed), { id: E.EMPTY });
  assert.equal(mockConstruction(world, d, 1), true);
  assert.equal([...world.values()].filter(c => c.id === E.TUNGSTEN).length, 48);
  assert(hearthStructureCells(d).every(c => world.get(key(c)).id === E.TUNGSTEN));
});

test('hearth dismantling removes only expected tungsten shell cells, preserving interior and foreign matter', () => {
  const d = device(2), world = emptyWorld(d);
  assert.equal(mockConstruction(world, d, 1), true);
  const shell = hearthStructureCells(d), shellForeign = shell[0];
  world.set(key(shellForeign), { id: E.SCRAP });
  const regions = hearthRegions(d), fuel = regions.fuel[0], charge = regions.charge[0], outlet = regions.outlet[0];
  const interiorTungsten = regions.fuel[1];
  world.set(key(fuel), { id: E.BROKENCOAL });
  world.set(key(charge), { id: E.SCRAP });
  world.set(key(outlet), { id: E.WATER });
  world.set(key(interiorTungsten), { id: E.TUNGSTEN });

  assert.equal(mockConstruction(world, d, 2), true);
  assert.equal(world.get(key(shellForeign)).id, E.SCRAP, 'foreign shell material is not erased');
  assert.equal(world.get(key(fuel)).id, E.BROKENCOAL);
  assert.equal(world.get(key(charge)).id, E.SCRAP);
  assert.equal(world.get(key(outlet)).id, E.WATER);
  assert.equal(world.get(key(interiorTungsten)).id, E.TUNGSTEN, 'same-ID interior matter is outside the dismantle shape');
  assert.equal(shell.filter(c => c !== shellForeign && world.get(key(c)).id === E.EMPTY).length, 47);
});

test('non-hearth legacy machines keep their original 16-cell y=0 deck', () => {
  for (const type of ['foundation', 'belt', 'heater', 'pump', 'gate']) {
    const d = { ...device(3), type };
    assert.equal(buildCells(d).length, 16, `${type} still builds only its deck`);
    assert(buildCells(d).every(c => c[1] === d.y));
    const world = emptyWorld(d, deviceHeight(d));
    assert.equal(mockConstruction(world, d, 1), true, `${type} placement remains valid`);
    assert.equal([...world.values()].filter(c => c.id === baseMaterial(type)).length, 16);
  }
});
