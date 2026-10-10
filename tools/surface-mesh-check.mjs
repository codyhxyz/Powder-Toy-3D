// Isolated CPU contract checks: node tools/surface-mesh-check.mjs
import assert from 'node:assert/strict';
import { buildSurfaceMesh } from '../src/world/surfaceMesh.js';
import { ELEMENTS, E, K, R } from '../src/elements.js';

function volume(bounds, at, step = 1) {
  // Deliberately different origins for neighbouring chunks: alignment must be global.
  const origin = bounds.slice(0, 3).map(v => (Math.floor((v - step / 2) / step) - 1) * step);
  const size = origin.map((v, a) => (Math.ceil((bounds[a + 3] - step / 2) / step) + 2) * step - v);
  const ids = new Uint8Array(size[0] * size[1] * size[2]);
  for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
    ids[x + size[0] * (y + size[1] * z)] = at(x + origin[0], y + origin[1], z + origin[2]);
  }
  return { ids, options: { size, origin, bounds, step } };
}
function mesh(bounds, at, step = 1) {
  const v = volume(bounds, at, step);
  const m = buildSurfaceMesh(v.ids, v.options);
  assert(m.positions instanceof Float32Array);
  assert(m.normals instanceof Float32Array);
  assert(m.ids instanceof Uint8Array);
  assert.equal(m.positions.length, m.normals.length);
  assert.equal(m.positions.length, m.ids.length * 3);
  assert.equal(m.positions.length % 9, 0);
  for (let i = 0; i < m.positions.length; i += 9) {
    const p = Array.from({ length: 3 }, (_, j) => Array.from(m.positions.slice(i + 3 * j, i + 3 * j + 3)));
    const u = p[1].map((v, a) => v - p[0][a]), v = p[2].map((v, a) => v - p[0][a]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert(Math.hypot(...cross) > 0, 'no degenerate triangles');
    assert([0, 1, 2].every(a => p.some(point => point[a] < bounds[a + 3])), 'no high-boundary-only face');
    for (let j = 0; j < 3; j++) {
      const n = Array.from(m.normals.slice(i + 3 * j, i + 3 * j + 3));
      assert(n.every(Number.isFinite), 'finite normals');
      assert(Math.abs(Math.hypot(...n) - 1) < 1e-6, 'unit normals');
      assert.equal(m.ids[i / 3 + j], m.ids[i / 3]);
      assert.notEqual(m.ids[i / 3 + j], 0);
      p[j].forEach((n, a) => assert(Number.isFinite(n) && n >= bounds[a] && n <= bounds[a + 3]));
    }
  }
  return m;
}
const key = p => p.join(',');
function vertexNormals(m, include = () => true) {
  const normals = new Map();
  for (let i = 0; i < m.positions.length; i += 3) {
    const p = Array.from(m.positions.slice(i, i + 3));
    if (!include(p)) continue;
    const k = key(p), n = Array.from(m.normals.slice(i, i + 3));
    if (normals.has(k)) assert.deepEqual(n, normals.get(k), 'shared vertices have smooth normals');
    normals.set(k, n);
  }
  return normals;
}
function faces(m) {
  return Array.from({ length: m.positions.length / 9 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => Array.from(m.positions.slice(9 * i + 3 * j, 9 * i + 3 * j + 3))));
}
function edges(m) {
  const counts = new Map();
  for (const face of faces(m)) for (let i = 0; i < 3; i++) {
    const a = key(face[i]), b = key(face[(i + 1) % 3]);
    const edge = [a, b].sort().join('|');
    const entry = counts.get(edge) ?? { count: 0, winding: 0, points: [face[i], face[(i + 1) % 3]] };
    entry.count++;
    entry.winding += a < b ? 1 : -1;
    counts.set(edge, entry);
  }
  return counts;
}
function closed(m) {
  assert(m.positions.length > 0);
  for (const e of edges(m).values()) {
    assert.equal(e.count, 2, 'closed manifold edge');
    assert.equal(e.winding, 0, 'opposite shared-edge winding');
  }
}
function area(m) {
  let sum = 0;
  for (const [a, b, c] of faces(m)) {
    const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
    sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return sum;
}
function adjacent(at, step = 1, split = 0, axis = 0) {
  const bounds = [-4, -4, -4, 4, 4, 4];
  const leftBounds = bounds.slice(), rightBounds = bounds.slice();
  leftBounds[axis + 3] = rightBounds[axis] = split;
  const left = mesh(leftBounds, at, step);
  const right = mesh(rightBounds, at, step);
  const whole = mesh(bounds, at, step);
  const seam = m => [...edges(m)].filter(([, e]) => e.count === 1 && e.points.every(p => p[axis] === split) &&
    ![0, 1, 2].some(a => a !== axis && [bounds[a], bounds[a + 3]].some(v => e.points.every(p => p[a] === v)))).map(([k]) => k).sort();
  assert.deepEqual(seam(left), seam(right), 'exact boundary edges from different halos');
  const leftNormals = vertexNormals(left, p => p[axis] === split);
  const rightNormals = vertexNormals(right, p => p[axis] === split);
  for (const [p, n] of leftNormals) {
    assert.deepEqual(rightNormals.get(p), n, 'exact shared-boundary normals from different halos');
  }
  if (seam(left).length) assert(leftNormals.size > 0, 'seam normal check is nonempty');
  assert(Math.abs(area(left) + area(right) - area(whole)) < 1e-6, 'no missing/overlapping owned area');
  const faceKeys = [...faces(left), ...faces(right)].map(f => f.map(key).sort().join('|'));
  assert.equal(new Set(faceKeys).size, faceKeys.length, 'no duplicate triangles');
  return [left, right];
}

const box = [-2, -2, -2, 3, 3, 3];
const single = (x, y, z) => x === 0 && y === 0 && z === 0 ? E.ROCK : 0;
const isolated = mesh(box, single);
closed(isolated);
assert(vertexNormals(isolated).size < isolated.ids.length, 'smooth normals checked at duplicate vertices');
assert(isolated.normals.some((v, i) => i >= 3 && i < 9 && v !== isolated.normals[i % 3]), 'normals vary within a triangle');
for (let i = 0; i < isolated.positions.length; i += 3) {
  const dot = [0, 1, 2].reduce((sum, a) => sum + (isolated.positions[i + a] - 0.5) * isolated.normals[i + a], 0);
  assert(dot > 0, 'isolated cell normals point away from its centre');
}

// Every element, including glass/special materials, follows the source tables.
for (const e of ELEMENTS) {
  const m = mesh(box, (x, y, z) => single(x, y, z) ? e.id : 0);
  const solid = e.id !== 0 && e.kind !== K.GAS && e.render !== R.LIQUID;
  assert.equal(m.ids.length > 0, solid, e.key);
  if (solid) assert(m.ids.every(id => id === e.id), `${e.key}: full byte material ID`);
}
assert(ELEMENTS.some(e => e.id > 32 && e.kind !== K.GAS && e.render !== R.LIQUID));
assert.equal(mesh(box, () => E.ROCK).positions.length, 0, 'no artificial halo walls');

const branch = mesh([-2, -2, -2, 10, 3, 3], (x, y, z) => x >= 0 && x < 8 && y === 0 && z === 0 ? E.WOOD : 0);
closed(branch);
for (let x = 0; x < 8; x++) assert(faces(branch).some(f => f.some(p => p[0] >= x && p[0] <= x + 1)), `thin branch cell ${x} retained`);

const [plane] = adjacent((x, y) => y < 0 ? E.ROCK : 0);
assert(plane.positions.every((v, i) => i % 3 !== 1 || v === 0), 'flat plane at voxel boundary');
assert(plane.normals.every((v, i) => Math.abs(v - (i % 3 === 1 ? 1 : 0)) < 1e-6));
adjacent((x, y, z) => y < x + z ? E.ROCK : 0);
const [unowned, owned] = adjacent(x => x < 0 ? E.ROCK : 0);
assert.equal(unowned.positions.length, 0, 'face on high plane not owned');
assert(owned.positions.length > 0, 'face on low plane owned');
adjacent((x, y, z) => y < x + z ? E.ROCK : 0, 2, -1);
adjacent((x, y, z) => y < x + z ? E.ROCK : 0, 4, -1);
for (const step of [1, 2, 4]) for (const axis of [0, 1, 2]) {
  // Fractional ownership planes create clipped vertices, not just crossings.
  adjacent((x, y, z) => y < x + z ? E.ROCK : 0, step, 0.25, axis);
}
const crown = mesh([-5, -5, -5, 5, 5, 5], (x, y, z) => x * x + y * y + z * z < 12 ? E.WOOD : 0);
closed(crown);
vertexNormals(crown);

// A checkerboard has zero central differences everywhere: retain face fallback.
const fallback = mesh(box, (x, y, z) => (x + y + z) & 1 ? E.ROCK : 0);
for (const [i, [a, b, c]] of faces(fallback).entries()) {
  const u = b.map((v, k) => v - a[k]), v = c.map((v, k) => v - a[k]);
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...cross);
  for (let j = 0; j < 9; j++) assert(Math.abs(fallback.normals[i * 9 + j] - cross[j % 3] / length) < 1e-6, 'degenerate gradients use outward face normal');
}

// Sparse features in a block survive even when they miss the coarse sample centre.
for (const step of [2, 4]) {
  const m = mesh([-8, -8, -8, 8, 8, 8], (x, y, z) => x === -1 && y === 1 && z === 1 ? E.GOLD : E.WATER, step);
  closed(m);
  assert(m.ids.every(id => id === E.GOLD), 'coarse representative is occupied, not liquid/air');
}
const mixed = mesh(box, (x, y, z) => y === 0 && z === 0 && (x === 0 || x === 1) ? (x ? E.WOOD : E.GOLD) : 0);
assert(mixed.ids.includes(E.WOOD) && mixed.ids.includes(E.GOLD), 'both triangle materials preserved');
closed(mixed);

// Exercise all tetrahedral sign configurations through complete closed volumes.
for (let mask = 1; mask < 256; mask++) {
  closed(mesh([-2, -2, -2, 4, 4, 4], (x, y, z) =>
    x >= 0 && x < 2 && y >= 0 && y < 2 && z >= 0 && z < 2 && (mask & (1 << (x + 2 * y + 4 * z))) ? E.ROCK : 0));
}
const input = volume(box, single), before = input.ids.slice();
buildSurfaceMesh(input.ids, input.options);
assert.deepEqual(input.ids, before, 'input is not mutated');
assert.throws(() => buildSurfaceMesh(input.ids, { ...input.options, step: 3 }), RangeError);
assert.throws(() => buildSurfaceMesh(input.ids.subarray(1), input.options), RangeError);
assert.throws(() => buildSurfaceMesh(new Uint8Array(8), { size: [2, 2, 2], origin: [0, 0, 0], bounds: [0, 0, 0, 2, 2, 2] }), /padded/);
// Topology-only padding is insufficient for chunk-independent gradients.
assert.throws(() => buildSurfaceMesh(new Uint8Array(27), { size: [3, 3, 3], origin: [-1, -1, -1], bounds: [0, 0, 0, 1, 1, 1] }), /padded/);
console.log('surface-mesh-check: PASS (smooth/finite/unit/outward normals, gradient fallback, normal/geometry seams, isolated/manifold/winding, all elements/high IDs, thin branch, steps 1/2/4, 255 sign cases, validation)');
