// CPU integration of generation, real tree stamps, live state and stored edits.
// node tools/detail-worker-check.mjs
import assert from 'node:assert/strict';
import { packFarSceneCell } from '../src/shaders/farShared.js';
import { E } from '../src/elements.js';
import { encodeBrick, BRICK_FLOATS } from '../src/world/store.js';
import { DETAIL_CHUNK, DETAIL_PAD, farSceneLayout, farLayout } from '../src/shaders/far.js';
let result;
globalThis.self = { postMessage: data => { result = data; } };
await import('../src/world/detail-worker.js');
const height = 128, pad = DETAIL_PAD, side = DETAIL_CHUNK + 2 * pad;
const layout = farSceneLayout(farLayout([32, height, 32]), side);
const base = () => ({
  token: { step: 1 }, layout, origin: [-pad, -pad, -pad], pad, height,
  bounds: [0, 0, 0, 32, 128, 32], live: [100, 0, 100, 128, 128, 128],
  planted: new Uint8Array(8 * 8), wb: [8, 32, 8],
  trees: [{ x: 16, y: 8, z: 16, seed: 12345, size: 12, variant: 'pine', quarter: 0 }],
  edits: [], raw: new Uint32Array(layout.cells),
});
function cell(d, x, y, z, id) {
  x -= d.origin[0]; z -= d.origin[2];
  d.raw[x + side * (z + side * y)] = packFarSceneCell(id, 20, 0);
}
function run(d) {
  self.onmessage({ data: d });
  assert(!result.error, result.error);
  return result;
}
let d = base(), mesh = run(d);
assert(mesh.ids.includes(E.PLANT));
assert(mesh.ids.includes(E.WOOD));
assert(!mesh.ids.includes(E.PLANT + 1), 'baked id+1 must be decoded');
d = base(); d.planted.fill(1);
assert(!run(d).ids.includes(E.PLANT), 'visited trees must not regenerate');
const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
for (let i = 0; i < 64; i++) A[i * 4] = E.GOLD;
d.edits = [{ at: [12, 20, 12], bytes: encodeBrick(A, 0, B, 0) }];
assert(run(d).ids.includes(E.GOLD), 'stored edits replace generation');
d.live = [0, 0, 0, 32, 128, 32];
cell(d, 12, 20, 12, E.BRICK);
mesh = run(d);
assert(mesh.ids.includes(E.BRICK));
assert(!mesh.ids.includes(E.GOLD), 'live cells win over stale store');
d = base(); cell(d, 1, 4, 1, E.WATER);
assert.equal(run(d).liquid, true, 'wet chunks must keep the existing volume path');
console.log('PASS: real tree IDs, planted columns, stored edits, live precedence, liquid tagging');
