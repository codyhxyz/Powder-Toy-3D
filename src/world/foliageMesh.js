import { E } from '../elements.js';
import { LEAF_FINE, LEAF_COARSE, foliageFrame } from '../foliage.js';

const vector = (value, length, valid) => value?.length === length && Array.from(value).every(valid);

/**
 * Pure, synchronous voxel-owned leaf geometry. ids/mask: Uint8Array, x fastest,
 * then y, then z; a nonzero mask tags a tree leaf, but only PLANT is emitted.
 * size: positive integer [sx,sy,sz]; origin: integer world cell corner;
 * bounds: finite [loX,loY,loZ,hiX,hiY,hiZ], half-open WORLD cell ownership.
 * Bounds may extend outside the supplied volume; no halo is needed. Geometry
 * stays inside its cell, so neighbors and chunk boundaries never change it.
 * lod 0: three blades; lod 1: one blade. ids in the result are per vertex.
 * Positions use Float32 world coordinates, like the other CPU world meshes.
 */
export function buildFoliageMesh(ids, mask, { size, origin, bounds, lod = 0 } = {}) {
  if (!(ids instanceof Uint8Array) || !(mask instanceof Uint8Array) ||
      !vector(size, 3, v => Number.isSafeInteger(v) && v > 0) ||
      !vector(origin, 3, Number.isSafeInteger) || !vector(bounds, 6, Number.isFinite) ||
      ![0, 1].includes(lod) ||
      [0, 1, 2].some(a => bounds[a] >= bounds[a + 3] || !Number.isSafeInteger(origin[a] + size[a])) ||
      !Number.isSafeInteger(size[0] * size[1] * size[2]) ||
      ids.length !== size[0] * size[1] * size[2] || mask.length !== ids.length) {
    throw new RangeError('Invalid foliage mesh volume, bounds or lod');
  }
  const leaf = lod === 0 ? LEAF_FINE : LEAF_COARSE;
  const [sx, sy] = size;
  const lo = [0, 1, 2].map(a => Math.max(0, Math.min(size[a], Math.ceil(bounds[a] - origin[a]))));
  const hi = [0, 1, 2].map(a => Math.max(0, Math.min(size[a], Math.ceil(bounds[a + 3] - origin[a]))));
  let cells = 0;
  for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
    const i = x + sx * (y + sy * z);
    if (ids[i] === E.PLANT && mask[i]) cells++;
  }
  const perCell = leaf.positions.length / 3, vertices = cells * perCell;
  const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3);
  const materials = new Uint8Array(vertices);
  // 0xffff is WebGPU's reserved uint16 restart index, not a usable vertex.
  const indices = vertices <= 0xffff ? new Uint16Array(cells * leaf.indices.length) : new Uint32Array(cells * leaf.indices.length);
  let vertex = 0, index = 0;
  for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
    const i = x + sx * (y + sy * z);
    if (ids[i] !== E.PLANT || !mask[i]) continue;
    const cell = [origin[0] + x, origin[1] + y, origin[2] + z];
    const { yaw, tilt } = foliageFrame(cell);
    const cy = Math.cos(yaw), syaw = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
    // Y(yaw) * X(tilt), identically for positions and normals.
    for (const [source, target, translate] of [[leaf.positions, positions, true], [leaf.normals, normals, false]]) {
      for (let p = 0; p < source.length; p += 3) {
        const tx = source[p], ty = ct * source[p + 1] - st * source[p + 2];
        const tz = st * source[p + 1] + ct * source[p + 2];
        const out = vertex * 3 + p;
        target[out] = cy * tx + syaw * tz + (translate ? cell[0] + 0.5 : 0);
        target[out + 1] = ty + (translate ? cell[1] + 0.5 : 0);
        target[out + 2] = -syaw * tx + cy * tz + (translate ? cell[2] + 0.5 : 0);
      }
    }
    materials.fill(E.PLANT, vertex, vertex + perCell);
    for (const local of leaf.indices) indices[index++] = vertex + local;
    vertex += perCell;
  }
  return { positions, normals, ids: materials, indices };
}
