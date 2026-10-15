import assert from 'node:assert/strict';
import { validateDevices } from '../src/industry/validation.js';
import { purelineDeviceLayout } from './fixtures/industry-line.js';

const devices = validateDevices(purelineDeviceLayout(), [128, 128, 128]);
assert.equal(devices.length, 41, 'the line has 41 unique, non-overlapping devices');
assert.equal(devices.filter(d => d.type === 'foundation').length, 36);
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
console.log(`CPU layout valid: ${devices.length} devices in 128³ (36 foundations, hearth, ship, pump, gate, miner); no overlaps or out-of-bounds placements.`);
