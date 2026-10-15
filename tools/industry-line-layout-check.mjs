import assert from 'node:assert/strict';
import { validateDevices } from '../src/industry/validation.js';
import { purelineDeviceLayout } from './fixtures/industry-line.js';
import { deviceCell } from '../src/industry/catalog.js';
import { hearthStructureCells } from '../src/industry/hearth.js';
import { gateGeometry } from '../src/industry/gates.js';

const devices = validateDevices(purelineDeviceLayout(), [128, 128, 128]);
assert.equal(devices.length, 63, 'the line has 63 unique, non-overlapping devices');
assert.equal(devices.filter(d => d.type === 'foundation').length, 58);
assert.equal(devices.filter(d => d.type === 'hearth').length, 1);
assert.equal(devices.filter(d => d.type === 'ship').length, 1);
assert.equal(devices.filter(d => d.type === 'pump').length, 1);
assert.equal(devices.filter(d => d.type === 'gate').length, 1);
assert.equal(devices.filter(d => d.type === 'miner').length, 1);
assert.equal(new Set(devices.map(d => d.id)).size, devices.length);
const gate = devices.find(d => d.id === 'line-coolant-gate');
assert.deepEqual([gate.x, gate.y, gate.z, gate.rotation], [56, 12, 52, 1]);
assert.deepEqual([devices.find(d => d.id === 'line-hearth').x, devices.find(d => d.id === 'line-hearth').y,
  devices.find(d => d.id === 'line-hearth').z], [16, 12, 16]);
// Count actual matter, not machine reservations: empty work volumes cannot
// seal the diagonal path between two perpendicular walls.
const solid = new Set();
for (const d of devices) {
  if (d.type === 'hearth') for (const p of hearthStructureCells(d)) solid.add(p.join(','));
  else for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) solid.add(deviceCell(d, x, 0, z).join(','));
}
for (const p of gateGeometry(gate, { nx: 128, ny: 128, nz: 128 }).aperture) solid.add(p.join(','));
for (const [x, z, minY, maxY] of [
  [60, 51, 13, 15], [60, 56, 13, 15],
  [51, 51, 13, 16], [51, 56, 13, 16],
  [43, 51, 15, 18], [43, 56, 15, 18],
  [48, 51, 15, 18], [48, 56, 15, 18],
]) for (let y = minY; y <= maxY; y++) {
  assert.ok(solid.has([x, y, z].join(',')), `diagonal escape column ${x},${y},${z} must contain real foundation matter`);
}
console.log(`CPU layout valid: ${devices.length} devices in 128³ (58 foundations, hearth, ship, pump, gate, miner); no overlaps, bounds violations, or open tank/catch corner columns.`);
