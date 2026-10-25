// CPU check of a save's native words across ring addressing (src/world/ringSave.js): V2's banks (and
// cores) and the dynamics' per-brick air re-laid from one ring to another land where cellSlot / brickIdOf
// put the same window cell under the new ring; a zero delta changes nothing; the activity starts over.
// usage: node tools/ring-save-cpu-check.mjs
import assert from 'node:assert/strict';
import { gridLayout } from '../src/sim.js';
import { cellSlot, brickIdOf, ringOf } from '../src/shaders/common.js';
import { encodeV2State, decodeV2State, stateLengths } from '../src/v2/state.js';
import { v2ActLayout, LEGACY_WORD } from '../src/shaders/v2.js';
import { ringDelta, relayoutV2State, relayoutDynamics, rotateBricks } from '../src/world/ringSave.js';

const dims = [64, 16, 32], g0 = gridLayout(...dims), g1 = gridLayout(...dims), nb = g0.nbricks;
const origin = { x: 48, y: 0, z: 32 };
Object.defineProperty(g1, 'ring', { get: () => ringOf(g1, origin) });   // the loading grid, ringed
const L = stateLengths(dims, true);
let k = 1;
const aux = new Uint32Array(L.aux).map(() => (k = (Math.imul(k, 1103515245) + 12345) >>> 0));
const activity = new Uint32Array(L.activity).fill(7);
const bytes = encodeV2State({ dims, tick: 5, frame: 9, paints: 2, acc: 0.25, certified: false, writtenSinceTick: true, mode: 'v2',
  cells: new Uint32Array(L.cells), activity, args: new Uint32Array(L.args), aux });
const delta = ringDelta({ slotRing: undefined }, g1);
assert.equal(delta, ringOf(g1, origin) % nb);
assert.ok(delta !== 0, 'the test origin must give a ring');
assert.equal(relayoutV2State(bytes, dims, 0), bytes, 'zero delta: the same bytes');
const out = decodeV2State(relayoutV2State(bytes, dims, delta), dims);
let cells = 0;
for (let x = 0; x < dims[0]; x++) for (let y = 0; y < dims[1]; y++) for (let z = 0; z < dims[2]; z++) {
  assert.equal(out.aux[cellSlot(g1, x, y, z)], aux[cellSlot(g0, x, y, z)], `bank of ${x},${y},${z}`); cells++;
}
const a = v2ActLayout(g0);
assert.ok(out.activity.subarray(a.busy0, a.busy0 + 2 * nb).every((v) => v === 1), 'every brick busy');
assert.ok(out.activity.subarray(a.legacy, a.legacy + nb).every((v) => v === LEGACY_WORD.STALE), 'every projection stale');
assert.equal(out.tick, 5); assert.equal(out.acc, 0.25);
// the dynamics' per-brick words, and back again
const air = new Uint32Array(nb * 8).map((_, i) => i), shocks = new Uint32Array(nb).map((_, i) => i * 3);
const moved = relayoutDynamics({ air, shocks, particles: new Uint32Array(4) }, nb, delta);
for (let bx = 0; bx < g0.bx; bx++) for (let by = 0; by < g0.by; by++) for (let bz = 0; bz < g0.bz; bz++) {
  const from = brickIdOf(g0, bx, by, bz), to = brickIdOf(g1, bx, by, bz);
  assert.equal(moved.shocks[to], shocks[from]);
  for (let w = 0; w < 8; w++) assert.equal(moved.air[to * 8 + w], air[from * 8 + w]);
}
assert.deepEqual(rotateBricks(rotateBricks(air, 8, nb, delta), 8, nb, -delta), air, 'rotation inverts');
console.log(`ring-save-cpu-check: ok (${cells} banks and ${nb} bricks' air re-laid by ${delta} bricks land on their cells; the activity starts over)`);
