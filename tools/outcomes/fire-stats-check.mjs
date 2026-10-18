// CPU only: reporting/criterion checks, not a combustion simulation.
import assert from 'node:assert/strict';
import { woodStats, woodBurns } from './tests/fire.js';
import { E } from '../../src/elements.js';
const e = { id: key => E[key] };
function grid() {
  return { nx: 16, ny: 16, nz: 16, id: new Int32Array(4096),
    T: new Float32Array(4096).fill(20), burning: new Uint8Array(4096), particles: [] };
}
const packet = (overrides = {}) => ({ id: E.WOOD, mass: 1, x: 7.75, T: 400, burning: 0, ...overrides });
const mixed = grid();
mixed.id[0] = E.WOOD;
mixed.particles = [packet({ mass: 3.5, burning: 1 }), packet({ x: 8.25 }),
  packet({ x: -20 }), packet({ id: E.SMOKE, mass: 0.5 })];
assert.equal(woodStats(mixed, e).wood, 6.5, 'include all live wood, including out-of-window packets');
assert.equal(woodStats(mixed, e).burning, 3.5, 'use actual material amount, not packet count');
assert.equal(woodStats(mixed, e).maxT, 400);
assert.equal(woodStats(mixed, e).smoke, 0.5);
assert.equal(woodStats(mixed, e, 0, 7).wood, 4.5, 'last-column cell centres stay in the bay');
assert.equal(woodStats(mixed, e, 8, 15).wood, 1);
for (const mass of [undefined, NaN, -1, 0]) {
  const bad = grid(); bad.particles = [packet({ mass })];
  assert.throws(() => woodStats(bad, e), /invalid fire material packet/);
}
async function outcome(particles) {
  const before = grid(); before.id.fill(E.WOOD, 0, 64);
  const after = grid(); after.particles = particles;
  let reads = 0;
  return woodBurns.run({ ...e, time: 0, box() {},
    async read() { return reads++ ? after : before; },
    async advance(dt) { this.time += dt; } });
}
const lofted = Array.from({ length: 64 }, () => packet());
assert.equal((await outcome(lofted)).criteria[0].ok, false, 'lofting all wood must not pass as burning/conversion');
assert.equal((await outcome([packet({ burning: 1 }), ...lofted.slice(1)])).criteria[0].ok, true);
assert.equal((await outcome([packet({ id: E.ASH }), ...lofted.slice(1)])).criteria[0].ok, true);
console.log('Fire census CPU: resident + in-flight amounts, bay indices, outside-window wood, and actual positive-control criterion passed');
