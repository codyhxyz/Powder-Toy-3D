// CPU-only: cached terrain remains resident but offscreen chunks draw neither
// color nor depth. Curved presentation keeps its conservative all-mesh path.
import assert from 'node:assert/strict';
import { Box3, Frustum, Matrix4, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from 'three/webgpu';
import { WorldDetail } from '../src/world/detail.js';

const camera = new PerspectiveCamera(60, 1, 0.1, 100);
camera.coordinateSystem = WebGPUCoordinateSystem;
camera.updateProjectionMatrix();
camera.updateMatrixWorld();
const params = () => ({
  warpK: 0,
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
  entries, visible: true, sim: { cur: 0 }, _m: { frustum: new Frustum() },
  pipe: { state: 'ready', draw: (_, o) => color.push(o.vertexBuffers[0]) },
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
check({ ...params(), warpK: 0.001 }, ['front', 'side', 'behind', 'far', 'near', 'crossing']);
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

// Publication derives bounds from actual mesh vertices, not chunk estimates.
const published = Object.assign(Object.create(WorldDetail.prototype), {
  pending: {}, wanted: [{ key: 0, distance: 1 }], entries: new Map(), bytes: 0,
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
console.log('PASS: terrain color/depth culling, WebGPU near/far planes, camera/projection changes, curved fallback, cache residency and publication bounds');
