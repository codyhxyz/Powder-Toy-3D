import assert from 'node:assert/strict';
import test from 'node:test';
import { E } from '../../src/elements.js';
import { packCells, unpackCells } from '../../src/saves/format.js';
import { baseMaterial, deviceCell } from '../../src/industry/catalog.js';
import { GATE_OWNER_MARKER } from '../../src/industry/gates.js';
import { constructionWGSL, WGSL_CHECK } from '../../src/industry/construction.js';
import { deviceHeight } from '../../src/industry/validation.js';
import { hearthStructureCells } from '../../src/industry/hearth.js';
import { PUMP_BACKPLATE_TAG, pumpBackplateCells, pumpStructureCells } from '../../src/industry/pumpStructure.js';

const device = rotation => ({ id: 'pump-1', type: 'pump', x: 20, y: 8, z: 24, rotation });
const key = cell => cell.join(',');
const reservationCells = (d, height = deviceHeight(d)) => {
  const out = [];
  for (let y = 0; y < height; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++)
    out.push(deviceCell(d, x, y, z));
  return out;
};
const emptyWorld = d => new Map(reservationCells(d).map(cell => [key(cell),
  { id: E.EMPTY, temperature: 20, life: 0, marker: 0, seed: 0.375 }]));

// CPU ownership model mirrors the exact structure shape and material/tag checks
// emitted by the atomic construction kernel; Naga validates the real WGSL below.
function construct(world, d, mode) {
  if (mode === 1) {
    if (reservationCells(d).some(cell => world.get(key(cell))?.id !== E.EMPTY)) return false;
    for (const cell of pumpStructureCells(d)) {
      const backplate = pumpBackplateCells(d).some(at => key(at) === key(cell));
      world.set(key(cell), { id: E.TUNGSTEN, temperature: 20, life: 0,
        marker: backplate ? PUMP_BACKPLATE_TAG : 0, seed: world.get(key(cell)).seed });
    }
    return true;
  }
  if (mode === 2) {
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
      const cell = deviceCell(d, x, 0, z), value = world.get(key(cell));
      if (value?.id === E.TUNGSTEN) world.set(key(cell), { ...value, id: E.EMPTY, marker: 0 });
    }
    for (const cell of pumpBackplateCells(d)) {
      const value = world.get(key(cell));
      if (value?.id === E.TUNGSTEN && value.marker === PUMP_BACKPLATE_TAG)
        world.set(key(cell), { ...value, id: E.EMPTY, marker: 0 });
    }
    return true;
  }
  return true;
}

test('rotated pump structure contains 16 floor and 24 tagged backplate cells in its seven-high reservation', () => {
  assert.equal(PUMP_BACKPLATE_TAG, 1048572);
  assert.equal(new Float32Array([PUMP_BACKPLATE_TAG])[0], PUMP_BACKPLATE_TAG);
  assert.notEqual(PUMP_BACKPLATE_TAG, GATE_OWNER_MARKER);
  for (let rotation = 0; rotation < 4; rotation++) {
    const d = device(rotation), plate = pumpBackplateCells(d), structure = pumpStructureCells(d);
    const plateKeys = new Set(plate.map(key)), structureKeys = new Set(structure.map(key));
    assert.equal(plate.length, 24);
    assert.equal(plateKeys.size, 24);
    assert.equal(structure.length, 40);
    assert.equal(structureKeys.size, 40);
    assert.equal(structure.filter(c => c[1] === d.y).length, 16);
    for (const cell of structure) {
      assert(cell[0] >= d.x && cell[0] < d.x + 4);
      assert(cell[1] >= d.y && cell[1] < d.y + 7);
      assert(cell[2] >= d.z && cell[2] < d.z + 4);
    }
    const expectedPlate = [];
    for (let y = 1; y <= 6; y++) for (let x = 0; x < 4; x++) expectedPlate.push(deviceCell(d, x, y, 3));
    assert.deepEqual([...plateKeys].sort(), expectedPlate.map(key).sort(), `rotation ${rotation} is local z=3`);
    const floorKeys = new Set(structure.filter(c => c[1] === d.y).map(key));
    assert([...plateKeys].every(k => !floorKeys.has(k)), 'plate and original floor are disjoint');
  }
});

test('atomic pump construction writes tagged physical tungsten; obstruction anywhere in the full reservation writes nothing', () => {
  const d = device(1), world = emptyWorld(d);
  world.set(key(deviceCell(d, 2, 6, 1)), { id: E.SCRAP, temperature: 20, marker: 0, seed: 0.375 });
  const obstructedSnapshot = structuredClone([...world]);
  assert.equal(construct(world, d, 1), false);
  assert.deepEqual([...world], obstructedSnapshot,
    'failed 4×7×4 preflight performs no partial floor or backplate writes');

  world.set(key(deviceCell(d, 2, 6, 1)), { id: E.EMPTY, temperature: 20, life: 0, marker: 0, seed: 0.375 });
  assert.equal(construct(world, d, 1), true);
  assert.equal([...world.values()].filter(cell => cell.id === E.TUNGSTEN).length, 40);
  for (const cell of pumpBackplateCells(d)) {
    const value = world.get(key(cell));
    assert.equal(value.id, E.TUNGSTEN);
    assert.equal(value.marker, PUMP_BACKPLATE_TAG);
    assert.equal(value.seed, 0.375, 'construction preserves fractional cell seed');
  }
  for (const cell of pumpStructureCells(d).filter(cell => cell[1] === d.y))
    assert.equal(world.get(key(cell)).marker, 0, 'legacy deck marker semantics remain unchanged');
});

test('dismantling removes only tungsten with the exact marker at registered rotated plate cells', () => {
  const d = device(3), world = emptyWorld(d);
  assert.equal(construct(world, d, 1), true);
  const plate = pumpBackplateCells(d), [owned, untagged, otherId, loose] = plate;
  world.set(key(untagged), { id: E.TUNGSTEN, temperature: 20, marker: 0, seed: 0.25 });
  world.set(key(otherId), { id: E.WALL, temperature: 20, marker: PUMP_BACKPLATE_TAG, seed: 0.5 });
  world.set(key(loose), { id: E.WATER, temperature: 20, marker: 0, seed: 0.75 });
  const outside = deviceCell(d, 1, 5, 2);
  world.set(key(outside), { id: E.TUNGSTEN, temperature: 20, marker: PUMP_BACKPLATE_TAG, seed: 0.125 });
  const interior = deviceCell(d, 1, 4, 1);
  world.set(key(interior), { id: E.TUNGSTEN, temperature: 20, marker: PUMP_BACKPLATE_TAG, seed: 0.625 });
  const legacyFloor = pumpStructureCells(d).slice(0, 16);
  for (const cell of legacyFloor) world.set(key(cell), { id: E.TUNGSTEN, temperature: 20, marker: 0, seed: 0.375 });

  assert.equal(construct(world, d, 2), true);
  assert.equal(world.get(key(owned)).id, E.EMPTY, 'owned, tagged tungsten is removed');
  assert.equal(world.get(key(untagged)).id, E.TUNGSTEN, 'same-ID untagged legacy matter is preserved');
  assert.equal(world.get(key(otherId)).id, E.WALL, 'other material with a copied tag is preserved');
  assert.equal(world.get(key(loose)).id, E.WATER, 'loose fluid is preserved');
  assert.equal(world.get(key(outside)).id, E.TUNGSTEN, 'matching tag outside the registered 24 coordinates is preserved');
  assert.equal(world.get(key(interior)).id, E.TUNGSTEN, 'same-ID interior matter is outside the plate');
  assert(legacyFloor.every(cell => world.get(key(cell)).id === E.EMPTY), 'floor retains its original material-only removal rule');
});

test('old pump registrations are not healed and existing non-pump structures keep their geometry', () => {
  const old = device(2), world = emptyWorld(old), floor = pumpStructureCells(old).slice(0, 16);
  for (const cell of floor) world.set(key(cell), { id: E.TUNGSTEN, temperature: 20, marker: 0, seed: 0.375 });
  assert.equal(world.get(key(pumpBackplateCells(old)[0])).id, E.EMPTY, 'legacy registration has no implicit plate');
  // An explicit operation may dismantle its old floor, but no load/registration path constructs a plate.
  assert.equal(construct(world, old, 2), true);
  assert(pumpBackplateCells(old).every(cell => world.get(key(cell)).id === E.EMPTY));
  assert.equal(hearthStructureCells({ ...old, type: 'hearth' }).length, 48, 'hearth shell stays unchanged');
  for (const type of ['foundation', 'belt', 'heater', 'gate', 'lift', 'miner', 'separator', 'ship']) {
    const d = { ...old, type };
    const floor = Array.from({ length: 16 }, (_, i) => deviceCell(d, i % 4, 0, Math.floor(i / 4)));
    assert.equal(floor.length, 16, `${type} remains the original floor geometry`);
    assert(floor.every(cell => cell[1] === d.y));
  }

  const source = constructionWGSL({ nx: 128, ny: 128, nz: 128 });
  assert.match(source, /P\.pump != 0u/);
  assert.match(source, /P\.mode == 1u/);
  assert.match(source, /let owned = eid\(a\) == E_TUNGSTEN && a\.z == INDUSTRY_PUMP_BACKPLATE_TAG/);
  assert.match(source, /INDUSTRY_PUMP_BACKPLATE_TAG: f32 = 1048572\.0/);
  assert.equal(WGSL_CHECK[0].name, 'industryConstruction');
  assert.match(source, /clear && P\.mode == 1u/);
  assert.match(source, /P\.mode == 2u && eid\(a\) != P\.material/,
    'legacy floor still removes only its preexisting matching material');
});

test('exact f32 owner marker survives the existing lossless terrain save codec', () => {
  const a = new Float32Array([E.TUNGSTEN, 20.25, PUMP_BACKPLATE_TAG, 0.375]);
  const b = new Float32Array([0, 0, 0, 0]);
  const packed = packCells([1, 1, 1], () => 0, [a, b]);
  const restoredA = new Float32Array(4), restoredB = new Float32Array(4);
  unpackCells([1, 1, 1], () => 0, packed, [restoredA, restoredB]);
  assert.deepEqual(restoredA, a, 'A.z ownership tag and fractional seed round-trip exactly');
  assert.deepEqual(restoredB, b);
});
