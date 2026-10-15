import assert from 'node:assert/strict';
import { LINE_FOUNDATION_COLUMNS, LINE_WATER_SOURCE_BOUNDS, lineWaterSourceCells, purelineDeviceLayout } from './fixtures/industry-line.js';
import { deviceCell } from '../src/industry/catalog.js';
import { hearthStructureCells } from '../src/industry/hearth.js';
import { pumpStructureCells } from '../src/industry/pumpStructure.js';
import { gateGeometry } from '../src/industry/gates.js';
import { machinePorts } from '../src/industry/physics.js';
import { deviceHeight, overlaps, validateDevices } from '../src/industry/validation.js';

const devices = validateDevices(purelineDeviceLayout(), [128, 128, 128]);
const foundationCount = LINE_FOUNDATION_COLUMNS.reduce((count, [, , , firstY, lastY]) => count + lastY - firstY + 1, 0);
const machineCount = 5;
assert.equal(foundationCount, 78);
assert.equal(devices.length, 83);
assert.equal(devices.length, foundationCount + machineCount, 'all real foundations and five machines are uniquely laid out');
assert.equal(devices.filter(d => d.type === 'foundation').length, foundationCount);
for (const type of ['hearth', 'ship', 'pump', 'gate', 'miner']) assert.equal(devices.filter(d => d.type === type).length, 1);
assert.equal(new Set(devices.map(d => d.id)).size, devices.length);
const gate = devices.find(d => d.id === 'line-coolant-gate');
assert.deepEqual([gate.x, gate.y, gate.z, gate.rotation], [56, 12, 52, 1]);
const hearth = devices.find(d => d.id === 'line-hearth');
assert.deepEqual([hearth.x, hearth.y, hearth.z], [16, 12, 16]);
const ship = devices.find(d => d.id === 'line-ship');
const pump = devices.find(d => d.id === 'line-pump');
assert.deepEqual([ship.x, ship.y, ship.z, ship.rotation], [44, 15, 52, 0]);
assert.equal(deviceHeight(pump), 7, 'tank foundations must avoid the complete pump reservation');
assert(devices.filter(d => d.type === 'foundation').every(d => !overlaps(d, pump)),
  'ordinary tank/catch foundations do not overlap the seven-cell-high pump reservation');

// Source extent and all probe/seed cells come from the same inclusive bounds.
const waterSource = lineWaterSourceCells();
const waterSourceVolume = Object.values(LINE_WATER_SOURCE_BOUNDS)
  .reduce((volume, [lo, hi]) => volume * (hi - lo + 1), 1);
assert.equal(waterSource.length, waterSourceVolume);
assert.equal(new Set(waterSource.map(p => p.join(','))).size, waterSource.length);
assert.deepEqual([LINE_WATER_SOURCE_BOUNDS.x, LINE_WATER_SOURCE_BOUNDS.y, LINE_WATER_SOURCE_BOUNDS.z],
  [[58, 67], [13, 15], [52, 55]], 'finite cold-water source is 10×3×4 cells (120), behind the closed gate');

// Count actual matter, not machine reservations: empty work volumes cannot
// seal the diagonal path between two perpendicular walls.
const solid = new Set();
for (const d of devices) {
  if (d.type === 'hearth') for (const p of hearthStructureCells(d)) solid.add(p.join(','));
  else for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) solid.add(deviceCell(d, x, 0, z).join(','));
}
const gateLeaf = gateGeometry(gate, { nx: 128, ny: 128, nz: 128 }).aperture;
for (const p of gateLeaf) solid.add(p.join(','));
for (const p of pumpStructureCells(pump)) solid.add(p.join(','));
for (const z of [51, 56]) for (let y = 16; y <= 18; y++)
  assert(solid.has([52, y, z].join(',')), 'real outside columns close the raised spout corners');
assert(waterSource.every(p => !solid.has(p.join(','))), 'finite reservoir occupies clear volume behind actual walls');
const closedGatePlaneX = Math.max(...gateLeaf.map(([x]) => x));
assert(waterSource.every(([x]) => x > closedGatePlaneX)
  && machinePorts(pump).inlet.every(([x]) => x < closedGatePlaneX),
'closed gate separates all finite source cells from the pump inlet');

// A real spout carries pump outlet material to the original ship mouth; the
// route stays bounded and supported instead of claiming a direct port overlap.
const spout = LINE_FOUNDATION_COLUMNS.find(([prefix]) => prefix === 'spout-tower');
assert(spout, 'ordinary support tower is part of the construction recipe');
const [, spoutX, spoutZ, , roofY] = spout;
const outlet = machinePorts(pump).outlet;
assert.equal(outlet.length, 8);
assert(outlet.every(([x, y, z]) => x >= spoutX && x < spoutX + 4 && z >= spoutZ && z < spoutZ + 4
  && y > roofY && y <= roofY + 2), 'all pump outlet cells sit over the actual spout support');
const route = [];
for (let x = ship.x + 4; x <= pump.x - 1; x++) for (let y = roofY + 1; y <= roofY + 2; y++)
  for (let z = spoutZ; z < spoutZ + 4; z++) route.push([x, y, z]);
assert(route.every(p => !solid.has(p.join(','))), 'the short spout-to-shipping-mouth flow path remains open');
for (let x = spoutX; x < spoutX + 4; x++) for (let z = spoutZ; z < spoutZ + 4; z++)
  assert(solid.has([x, roofY, z].join(',')), 'the spout tower has real foundation support below its outlet');

// These actual ordinary foundations close the diagonal tank/catch corners.
const requiredCorners = new Map([
  ['tank-rear-north-corner', [68, 48, 13, 15]],
  ['tank-rear-south-corner', [68, 56, 13, 15]],
  ['tank-front-north-corner', [48, 48, 13, 16]],
  ['tank-front-south-corner', [48, 56, 13, 16]],
  ['catch-left-rear-corner', [40, 48, 15, 18]],
  ['catch-left-front-corner', [40, 56, 15, 18]],
]);
for (const [name, [x, z, first, last]] of requiredCorners) {
  const column = LINE_FOUNDATION_COLUMNS.find(([prefix]) => prefix === name);
  assert(column, `${name} must use an ordinary foundation`);
  assert.deepEqual(column.slice(1), [x, z, first, last]);
  for (let y = first; y <= last; y++) assert(solid.has([x, y, z].join(',')),
    `actual foundation matter closes ${name} at ${x},${y},${z}`);
}
for (const [name, prefix, x, z] of [
  ['tank-north middle extension', 'tank-north-middle', 60, 48], ['tank-north east extension', 'tank-north-east-extension', 64, 48],
  ['tank-south middle extension', 'tank-south-middle', 60, 56], ['tank-south east extension', 'tank-south-east-extension', 64, 56],
]) {
  const column = LINE_FOUNDATION_COLUMNS.find(([id]) => id === prefix);
  assert(column, `${name} is an ordinary foundation`);
  for (let y = 13; y <= 15; y++) assert(solid.has([x, y, z].join(',')), `${name} is real matter at y=${y}`);
}
for (const [name, x] of [['source west floor', 60], ['source east floor', 64]])
  assert(solid.has([x, 12, 52].join(',')), `${name} is real foundation material`);
console.log(`CPU layout valid: ${devices.length} devices (${foundationCount} foundations) in 128³; `
  + `${waterSource.length} finite source cells, original supported spout route, closed tank/catch corners, and seven-cell pump clearance.`);
