// CPU-only: cached terrain remains resident but offscreen chunks draw neither
// color nor depth. Curved presentation uses conservative warped bounds.
import assert from 'node:assert/strict';
import { Box3, Frustum, Matrix4, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from 'three/webgpu';
import { WorldDetail } from '../src/world/detail.js';
import { effectParameters, warp, warpBox } from '../src/gfx/presentationMath.js';

const camera = new PerspectiveCamera(60, 1, 0.1, 100);
camera.coordinateSystem = WebGPUCoordinateSystem;
camera.updateProjectionMatrix();
camera.updateMatrixWorld();
const params = () => ({
  warpK: 0,
  warpAnchor: [0, 0],
  warpDir: [0, 1],
  worldToClip: new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
});
const entry = (name, lo, hi, count = 3) => ({
  name, count, format: 'uint16', buffers: [name, null, null, name],
  bounds: new Box3(new Vector3(...lo), new Vector3(...hi)),
});
const entries = new Map([
  ['front', entry('front', [-1, -1, -11], [1, 1, -9])],
  ['side', entry('side', [99, -1, -11], [101, 1, -9])],
  ['behind', entry('behind', [-1, -1, 9], [1, 1, 11])],
  ['far', entry('far', [-1, -1, -201], [1, 1, -199])],
  ['near', entry('near', [-0.01, -0.01, -0.08], [0.01, 0.01, -0.02])],
  ['crossing', entry('crossing', [-0.01, -0.01, -0.2], [0.01, 0.01, 0.1])],
  ['empty', entry('empty', [-1, -1, -11], [1, 1, -9], 0)],
]);
const color = [], depth = [];
let ended = 0, passes = 0;
const detail = Object.assign(Object.create(WorldDetail.prototype), {
  entries, visible: true, sim: { cur: 0, readHeader: () => ({ src: 0, dst: 0, format: 2 }) }, _m: { frustum: new Frustum(), box: new Box3() },
  pipe: { state: 'ready', draw: (_, o) => { assert.equal(o.header.format,2); color.push(o.vertexBuffers[0]); } },
  depthPipe: { state: 'ready', draw: (_, o) => depth.push(o.vertexBuffers[0]) },
  depthTex: { width: 64, height: 64 }, depthView: {},
  depthZ: { createView: () => ({}) },
  gpu: { frame: { render: () => { passes++; return { end: () => ended++ }; } } },
});
function check(p, expected) {
  color.length = depth.length = 0;
  assert.equal(detail.draw({}, p, []), expected.length, color.join(','));
  assert.equal(detail.depth({ width: 64, height: 64 }, p), true);
  assert.deepEqual(color, expected);
  assert.deepEqual(depth, expected);
  assert.equal(entries.size, 7, 'culling must not evict cached meshes');
  assert.equal(ended, passes, 'depth pass must close even when no meshes are visible');
}
check(params(), ['front', 'crossing']);
check({ ...params(), warpK: 0.001 }, ['front', 'crossing']);
camera.position.x = 100;
camera.updateMatrixWorld();
check(params(), ['side']);
camera.position.x = 1000;
camera.updateMatrixWorld();
check(params(), []);

// A changed projection (including jitter) must not reuse the wanted-list
// frustum. Move an edge box outside with a large view offset.
camera.position.x = 0;
camera.updateMatrixWorld();
camera.setViewOffset(100, 100, 100, 0, 100, 100);
check(params(), ['crossing']); // a near-plane-straddling box is conservatively retained
camera.clearViewOffset();
check(params(), ['front', 'crossing']);

// A curved box must bound interior peaks, not just its transformed corners.
for (const dir of [[1, 0], [0, 1], [1, 1], [-2, 1]]) {
  const effect = effectParameters(0.1, [0.3, -0.2], dir);
  const source = new Box3(new Vector3(-3, 1, -4), new Vector3(5, 7, 6));
  const before = source.clone(), shown = warpBox(source, effect, new Box3());
  assert(source.equals(before), 'culling must not change resident mesh bounds');
  for (let x = 0; x <= 10; x++) for (let y = 0; y <= 2; y++) for (let z = 0; z <= 10; z++) {
    const p = [source.min.x + x * .8, source.min.y + y * 3, source.min.z + z];
    const q = new Vector3(...warp(p, effect));
    assert(q.x >= shown.min.x - 1e-10 && q.x <= shown.max.x + 1e-10 &&
      q.y >= shown.min.y - 1e-10 && q.y <= shown.max.y + 1e-10 &&
      q.z >= shown.min.z - 1e-10 && q.z <= shown.max.z + 1e-10, 'warped AABB must conservatively contain every sample');
  }
}
const peak = new Box3(new Vector3(-2, 0, -2), new Vector3(2, 1, 2));
assert.equal(warpBox(peak, effectParameters(.1, [0, 0], [1, 0]), new Box3()).max.y, 1, 'interior peak survives culling');
const bentOnly = entry('bent-only', [-1, 12, -11], [1, 14, -9]);
detail.entries.set('bent-only', bentOnly);
assert(![...detail.visibleDrawEntries(params())].includes(bentOnly));
assert([...detail.visibleDrawEntries({ ...params(), warpK: .1 })].includes(bentOnly), 'a flat-offscreen mesh can bend into view');
detail.entries.delete('bent-only');

// Publication derives bounds from actual mesh vertices, not chunk estimates.
const published = Object.assign(Object.create(WorldDetail.prototype), {
  pending: new Map(), workers: [], wanted: [{ key: 0, distance: 1 }], entries: new Map(), bytes: 0,
  mask: new Uint32Array(1), gpu: { createBuffer: () => ({}), write() {} },
  valid: () => true, makeRoom: () => true, drop() {},
});
published.accept({
  token: { key: 0, step: 1, version: 0 },
  positions: Float32Array.from([-2, -3, -4, 5, 6, 7, 0, 0, 0]),
  normals: new Float32Array(9), ids: new Uint8Array(3), indices: Uint16Array.from([0, 1, 2]), liquid: false,
});
const bounds = published.entries.get(0).bounds;
assert.deepEqual(bounds.min.toArray(), [-2, -3, -4]);
assert.deepEqual(bounds.max.toArray(), [5, 6, 7]);
assert.equal(published.mask[0], 1, 'ownership remains published with the mesh');
console.log('PASS: terrain color/depth culling, WebGPU near/far planes, camera/projection changes, conservative curved bounds, cache residency and publication bounds');
