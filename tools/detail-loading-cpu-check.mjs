// Exact-geometry loading benchmark. No browser, GPU, or reduced-detail meshes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildSurfaceMesh, meshPadding } from '../src/world/surfaceMesh.js';
import { E } from '../src/elements.js';

const pad = meshPadding(), height = 96, side = 32 + 2 * pad;
const options = { size: [side, height + 2 * pad, side], origin: [-pad, -pad, -pad], bounds: [0, 0, 0, 32, height, 32] };
const fields = {
  rock: (x, y, z) => y < 64 && !(x > 8 && x < 24 && y > 12 && y < 40) ? E.ROCK : E.EMPTY,
  brick: (x, y, z) => y < 64 && !(z > 8 && z < 24 && y > 12 && y < 40) ? E.BRICK : E.EMPTY,
  sand: (x, y, z) => y < 30 + x / 4 + z / 6 ? E.SAND : E.EMPTY,
  mixed: (x, y, z) => y < 30 + x / 4 ? (z < 16 ? E.ROCK : E.SAND) : E.EMPTY,
};
// Captured from production 2c5cb27d before removing unused smoothing work.
const expected = {
  rock: '41c535ffb1df3e71f59e4e4b08ba250335ba6fbb73ac590748f90cabc816b9c1',
  brick: 'f9626f0c7d2fbb51033add6d84430f7a065e801f9ba1ef5d9fd23e48640307ae',
  sand: '77215c69ba7e5c63f1c0c201d69abfd7e222c96d10b649672e6f87d0138b4c74',
  mixed: 'b5b3900a222be09ac854dc5c781397c06508f25d3eab5fb51062cab206527853',
};
for (const [name, field] of Object.entries(fields)) {
  const [sx, sy, sz] = options.size, ids = new Uint8Array(sx * sy * sz);
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++)
    ids[x + sx * (y + sy * z)] = field(x - pad, y - pad, z - pad);
  const times = [];
  let mesh;
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    mesh = buildSurfaceMesh(ids, options);
    if (i > 1) times.push(performance.now() - start);
  }
  const hash = createHash('sha256');
  for (const data of Object.values(mesh)) hash.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  const digest = hash.digest('hex');
  assert.equal(digest, expected[name], `${name}: geometry, normals and materials must stay byte-identical`);
  assert(mesh.indices.length > 0);
  assert(mesh.normals.every(Number.isFinite));
  console.log(`${name}: ${times.sort((a, b) => a - b)[2].toFixed(2)} ms; ${digest}`);
}
