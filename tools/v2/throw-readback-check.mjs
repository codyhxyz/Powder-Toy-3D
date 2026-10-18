// Execute the actual outcome's setup and landing checks without a GPU.
// The flight stub only reaches setup; it is not a trajectory oracle.
import assert from 'node:assert/strict';
import { throwLump } from '../outcomes/tests/solids.js';

const SAND = 7, reached = new Error('reached unchanged advance');
const grid = (resident, particles) => {
  const id = new Uint16Array(32 ** 3);
  id.fill(SAND, 0, resident);
  return { nx: 32, ny: 32, nz: 32, id, particles };
};
const packets = (count, mass = 1, id = SAND) =>
  Array.from({ length: count }, (_, i) => ({ id, mass, x: 2.5 + i % 2, y: 24.5, z: 15.5 }));
const engine = (initial, final) => {
  let reads = 0;
  return {
    info: { stepsPerSecond: 60, cellM: 0.3 },
    flight: (_id, [vx], t) => [vx * t, -0.5 * (19.6 / 0.3) * t * t],
    id: () => SAND,
    box(lo, hi, name, { v }) {
      assert.deepEqual(lo, [2, 24, 15]);
      assert.deepEqual(hi, [3, 25, 16]);
      assert.equal(name, 'SAND');
      assert.ok(v[0] > 0 && v.every(Number.isFinite));
    },
    read: async () => reads++ ? final : initial,
    advance: async () => { if (!final) throw reached; },
  };
};

for (const start of [grid(8), grid(0, packets(8)), grid(4, packets(4))])
  await assert.rejects(() => throwLump.run(engine(start)), error => error === reached);
for (const start of [grid(0, packets(7)), grid(0, packets(8, 0.5)), grid(0, packets(8, 1, SAND + 1))])
  await assert.rejects(() => throwLump.run(engine(start)), /start: 8 grains/);

// Airborne/stopped packets must not be mistaken for eight landed resident grains.
const result = await throwLump.run(engine(grid(0, packets(8)), grid(0, packets(8))));
assert.equal(result.criteria.find(c => c.name === 'grains kept').ok, false);
assert.equal(result.criteria.find(c => c.name === 'grains kept').measured, 0);
console.log('Throw readback CPU: resident/packet/mixed setup, invalid mass/count/ID rejection, unchanged resident landing requirement pass');
