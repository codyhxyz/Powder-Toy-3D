// Pure CPU numerical checks: no browser, renderer, GPU, or server imports.
import assert from 'node:assert/strict';
import { E } from '../src/elements.js';
import { FOLIAGE_CTYPE, isFoliageCell, foliageHash, foliageFrame, LEAF_FINE, LEAF_COARSE } from '../src/foliage.js';
import { buildFoliageMesh } from '../src/world/foliageMesh.js';

let passed = 0;
function check(name, run) { run(); console.log(`PASS ${name}`); passed++; }
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const options = { size: [5, 3, 4], origin: [-3, -2, -1], bounds: [-3, -2, -1, 2, 1, 3] };
const ids = new Uint8Array(60).fill(E.PLANT), mask = new Uint8Array(60).fill(1);
const build = (overrides = {}) => buildFoliageMesh(ids, mask, { ...options, ...overrides });
function triangles(mesh) {
  const result = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [];
    for (let j = 0; j < 3; j++) {
      const v = mesh.indices[i + j];
      tri.push([...mesh.positions.slice(v * 3, v * 3 + 3), ...mesh.normals.slice(v * 3, v * 3 + 3), mesh.ids[v]]);
    }
    result.push(JSON.stringify(tri));
  }
  return result.sort();
}
function validate(mesh) {
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.normals instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array);
  assert.equal(mesh.positions.length, mesh.normals.length);
  if (mesh.ids) {
    assert.ok(mesh.ids instanceof Uint8Array);
    assert.equal(mesh.ids.length, mesh.positions.length / 3);
    assert.ok(mesh.ids.every(id => id === E.PLANT));
  }
  assert.ok(mesh.positions.every(Number.isFinite));
  assert.ok(mesh.normals.every(Number.isFinite));
  for (let i = 0; i < mesh.normals.length; i += 3) near(Math.hypot(...mesh.normals.subarray(i, i + 3)), 1);
  for (const index of mesh.indices) {
    assert.ok(index < mesh.positions.length / 3);
    assert.notEqual(index, mesh.indices instanceof Uint16Array ? 0xffff : 0xffffffff);
  }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(t, t + 3), i => mesh.positions.subarray(i * 3, i * 3 + 3));
    const u = b.map((v, i) => v - a[i]), v = c.map((p, i) => p - a[i]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(Math.hypot(...cross) > 1e-6, 'nondegenerate triangle');
    const normal = mesh.normals.subarray(mesh.indices[t] * 3, mesh.indices[t] * 3 + 3);
    assert.ok(cross.reduce((sum, n, i) => sum + n * normal[i], 0) > 0, 'normal follows winding');
  }
}

check('tag predicate excludes untagged ground PLANT and other materials', () => {
  assert.equal(FOLIAGE_CTYPE, E.PLANT);
  for (const ctype of [FOLIAGE_CTYPE, FOLIAGE_CTYPE + 0.9]) assert.equal(isFoliageCell(E.PLANT, ctype), true);
  for (const ctype of [0, -1, FOLIAGE_CTYPE - 0.01, FOLIAGE_CTYPE + 1, NaN, Infinity]) assert.equal(isFoliageCell(E.PLANT, ctype), false);
  assert.equal(isFoliageCell(E.WOOD, FOLIAGE_CTYPE), false);
});

check('PCG and frame match unsigned integer reference, including negative coordinates', () => {
  const uint = n => BigInt.asUintN(32, n);
  const pcg = value => {
    const s = uint(BigInt(value >>> 0) * 747796405n + 2891336453n);
    const w = uint(((s >> ((s >> 28n) + 4n)) ^ s) * 277803737n);
    return Number(uint((w >> 22n) ^ w));
  };
  for (const cell of [[0, 0, 0], [1, 2, 3], [-1, -2, -3], [-2147483648, 2147483647, -17], [4294967295, 8, -9]]) {
    const [x, y, z] = cell;
    const expected = pcg((x >>> 0) ^ pcg((y >>> 0) ^ pcg(z >>> 0)));
    assert.equal(foliageHash(cell), expected);
    assert.ok(expected >= 0 && expected <= 0xffffffff);
    assert.deepEqual(foliageFrame(cell), { yaw: (expected & 65535) / 65536 * 2 * Math.PI, tilt: ((expected >>> 16) / 65536 - 0.5) * 1.4 });
  }
  assert.equal(foliageHash([-1, 0, 0]), foliageHash([4294967295, 0, 0]));
});

check('canonical folded templates: centred, coherent shared root, radius <= 0.48, coarse smaller', () => {
  for (const leaf of [LEAF_FINE, LEAF_COARSE]) {
    validate(leaf);
    assert.ok(leaf.indices instanceof Uint16Array);
    for (let i = 0; i < leaf.positions.length; i += 3) assert.ok(Math.hypot(...leaf.positions.subarray(i, i + 3)) <= 0.48);
    for (let a = 0; a < 3; a++) {
      const values = Array.from(leaf.positions).filter((_, i) => i % 3 === a);
      near(Math.min(...values) + Math.max(...values), 0);
    }
    assert.ok(new Set(Array.from(leaf.normals)).size > 3, 'folded, not flat');
  }
  assert.equal(LEAF_FINE.indices.length, 36);
  assert.equal(LEAF_COARSE.indices.length, 12);
  assert.ok(LEAF_COARSE.positions.length < LEAF_FINE.positions.length);
  for (let blade = 1; blade < 3; blade++) assert.deepEqual(LEAF_FINE.positions.slice(blade * 36, blade * 36 + 3), LEAF_FINE.positions.slice(0, 3));
});

check('deterministic finite unit-normal mesh with immutable inputs, both LODs', () => {
  const beforeIds = ids.slice(), beforeMask = mask.slice(), beforeOptions = structuredClone(options);
  for (const lod of [0, 1]) { const mesh = build({ lod }); validate(mesh); assert.deepEqual(mesh, build({ lod })); }
  assert.deepEqual(ids, beforeIds); assert.deepEqual(mask, beforeMask); assert.deepEqual(options, beforeOptions);
  assert.ok(build({ lod: 1 }).indices.length < build().indices.length);
});

check('world centre + Y(yaw)*X(tilt), all rotated vertices strictly inside owner voxels', () => {
  for (const lod of [0, 1]) {
    const leaf = lod ? LEAF_COARSE : LEAF_FINE, mesh = build({ lod });
    for (let cellIndex = 0; cellIndex < ids.length; cellIndex++) {
      const cell = [cellIndex % 5 - 3, Math.floor(cellIndex / 5) % 3 - 2, Math.floor(cellIndex / 15) - 1];
      const { yaw, tilt } = foliageFrame(cell);
      for (let p = 0; p < leaf.positions.length; p += 3) {
        const [x, y, z] = leaf.positions.subarray(p, p + 3);
        const ty = Math.cos(tilt) * y - Math.sin(tilt) * z, tz = Math.sin(tilt) * y + Math.cos(tilt) * z;
        const expected = [Math.cos(yaw) * x + Math.sin(yaw) * tz, ty, -Math.sin(yaw) * x + Math.cos(yaw) * tz];
        for (let a = 0; a < 3; a++) {
          const actual = mesh.positions[cellIndex * leaf.positions.length + p + a];
          near(actual, cell[a] + 0.5 + expected[a]);
          assert.ok(actual > cell[a] && actual < cell[a] + 1);
        }
      }
    }
  }
});

check('whole mesh equals adjacent independent chunks by ownership on all axes, both LODs', () => {
  for (const lod of [0, 1]) for (let axis = 0; axis < 3; axis++) {
    const joined = [];
    for (const [start, end] of [[0, 2], [2, options.size[axis]]]) {
      const size = [...options.size], origin = [...options.origin];
      size[axis] = end - start; origin[axis] += start;
      const chunkIds = new Uint8Array(size[0] * size[1] * size[2]).fill(E.PLANT);
      const chunkMask = new Uint8Array(chunkIds.length).fill(1);
      const bounds = [...origin, ...origin.map((v, a) => v + size[a])];
      const chunk = buildFoliageMesh(chunkIds, chunkMask, { size, origin, bounds, lod });
      joined.push(...triangles(chunk));
      assert.deepEqual(triangles(chunk), triangles(build({ bounds, lod })));
    }
    assert.deepEqual(joined.sort(), triangles(build({ lod })));
  }
});

check('half-open bounds use integer WORLD cell coordinate, not centre or local coordinate', () => {
  const bounds = [-1, -1, 0, 0, 0, 1];
  const one = build({ bounds });
  assert.equal(one.indices.length, LEAF_FINE.indices.length);
  assert.deepEqual(one, build({ bounds: [-1.1, -1.1, -0.1, -0.1, -0.1, 0.9] }));
  assert.equal(build({ bounds: [-0.9, -0.9, 0.1, -0.1, -0.1, 0.9] }).indices.length, 0);
  assert.equal(build({ bounds: [10, 10, 10, 11, 11, 11] }).indices.length, 0);
  assert.deepEqual(build({ bounds: [-100, -100, -100, 100, 100, 100] }), build());
});

check('removal, material replacement, or untagging removes only the owning cell geometry', () => {
  for (const lod of [0, 1]) {
    const leaf = lod ? LEAF_COARSE : LEAF_FINE, original = build({ lod });
    const cellIndex = 22, first = cellIndex * leaf.indices.length;
    const expected = triangles({ ...original, indices: new Uint16Array([...original.indices.slice(0, first), ...original.indices.slice(first + leaf.indices.length)]) });
    for (const change of ['remove', 'replace', 'untag']) {
      const nextIds = ids.slice(), nextMask = mask.slice();
      if (change === 'untag') nextMask[cellIndex] = 0;
      else nextIds[cellIndex] = change === 'remove' ? 0 : E.WOOD;
      const mesh = buildFoliageMesh(nextIds, nextMask, { ...options, lod });
      assert.deepEqual(triangles(mesh), expected);
    }
  }
});

check('untagged ground PLANT absent, nonzero tags accepted, tagged non-PLANT absent', () => {
  const ground = ids.slice(), untagged = new Uint8Array(mask.length);
  const empty = buildFoliageMesh(ground, untagged, options);
  validate(empty);
  for (const array of Object.values(empty)) assert.equal(array.length, 0);
  assert.ok(empty.indices instanceof Uint16Array);
  assert.deepEqual(ground, ids);
  assert.deepEqual(buildFoliageMesh(ids, new Uint8Array(mask.length).fill(255), options), build());
  assert.equal(buildFoliageMesh(new Uint8Array(ids.length).fill(E.WOOD), mask, options).indices.length, 0);
});

check('uint16 restart limit upgrades to uint32 safely at both LOD thresholds', () => {
  for (const lod of [0, 1]) {
    const leaf = lod ? LEAF_COARSE : LEAF_FINE, perCell = leaf.positions.length / 3;
    const limit = Math.floor(0xffff / perCell);
    for (const count of [limit, limit + 1]) {
      const mesh = buildFoliageMesh(new Uint8Array(count).fill(E.PLANT), new Uint8Array(count).fill(1), {
        size: [count, 1, 1], origin: [-count, 0, 0], bounds: [-count, 0, 0, 0, 1, 1], lod,
      });
      assert.ok(count === limit ? mesh.indices instanceof Uint16Array : mesh.indices instanceof Uint32Array);
      assert.equal(mesh.indices.at(-1), count * perCell - 1);
      assert.equal(mesh.indices.length, count * leaf.indices.length);
      validate(mesh);
    }
  }
});

check('invalid buffers, dimensions, origins, bounds and LOD rejected', () => {
  for (const bad of [undefined, {}, [], new Float32Array(60), new Uint8Array(59)]) {
    assert.throws(() => buildFoliageMesh(bad, mask, options), RangeError);
    assert.throws(() => buildFoliageMesh(ids, bad, options), RangeError);
  }
  for (const size of [undefined, [], [5, 3], [5, 3, 0], [5, -3, 4], [5.5, 3, 4], [Infinity, 3, 4], [Number.MAX_SAFE_INTEGER, 3, 4], new Array(3)]) assert.throws(() => build({ size }), RangeError);
  for (const origin of [undefined, [], [0, 0, NaN], [0.1, 0, 0], [Number.MAX_SAFE_INTEGER, 0, 0], new Array(3)]) assert.throws(() => build({ origin }), RangeError);
  for (const bounds of [undefined, [], [0, 0, 0, 0, 1, 1], [1, 0, 0, 0, 1, 1], [0, 0, 0, Infinity, 1, 1], [0, 0, NaN, 1, 1, 1], new Array(6)]) assert.throws(() => build({ bounds }), RangeError);
  for (const lod of [-1, 2, 0.5, NaN, '0', null]) assert.throws(() => build({ lod }), RangeError);
  assert.throws(() => buildFoliageMesh(ids, mask), RangeError);
});

console.log(`foliage-node-check: ${passed} CPU checks passed`);
