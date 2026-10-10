import { ELEMENTS, K, R } from '../elements.js';

const opaque = Uint8Array.from({ length: 256 }, (_, id) =>
  +(id !== 0 && !!ELEMENTS[id] && ELEMENTS[id].kind !== K.GAS && ELEMENTS[id].render !== R.LIQUID));
const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, i >> 2]);
const cross = (a, b, c) => [
  (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
  (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
];

// Surface nets: one vertex per mixed cube, the mean of its crossed edge midpoints.
// Binary occupancy makes these 256 positions independent of the input volume.
const vertices = Array.from({ length: 256 }, (_, mask) => {
  const point = [0, 0, 0];
  let crossings = 0;
  for (let i = 0; i < 8; i++) for (let axis = 0; axis < 3; axis++) {
    const j = i ^ (1 << axis);
    if (i > j || !!(mask & (1 << i)) === !!(mask & (1 << j))) continue;
    for (let a = 0; a < 3; a++) point[a] += (corners[i][a] + corners[j][a]) / 2;
    crossings++;
  }
  return crossings ? point.map(v => v / crossings) : null;
});

function clip(points, bounds) {
  for (let axis = 0; axis < 3; axis++) {
    for (let side = 0; side < 2; side++) {
      const plane = bounds[axis + side * 3];
      // Keep shared edge vertices, but do not own a face lying on the high plane.
      if (side && points.every(p => p[axis] === plane)) return [];
      const output = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const aIn = side ? a[axis] <= plane : a[axis] >= plane;
        const bIn = side ? b[axis] <= plane : b[axis] >= plane;
        if (aIn) output.push(a);
        if (aIn !== bIn) {
          // Identical arithmetic on either traversal of a shared triangle edge.
          const [lo, hi] = a[axis] < b[axis] ? [a, b] : [b, a];
          const t = (plane - lo[axis]) / (hi[axis] - lo[axis]);
          const p = lo.map((v, k) => v + t * (hi[k] - v));
          p[axis] = plane;
          output.push(p);
        }
      }
      points = output;
      if (points.length < 3) return [];
    }
  }
  return points;
}

/**
 * Binary surface nets over cell-centred opaque occupancy.
 * ids: Uint8Array, x fastest, then y, then z. origin: integer world cell corner.
 * size: positive integer [sx,sy,sz]; bounds: finite [loX,loY,loZ,hiX,hiY,hiZ].
 * step: 1 (default), 2 or 4. Coarse blocks are aligned to WORLD multiples of step;
 * any opaque cell keeps a block occupied, with its first x-fast opaque ID as material.
 * Supply complete blocks from (floor((lo-step/2)/step)-1)*step through
 * (ceil((hi-step/2)/step)+2)*step EXCLUSIVE on each axis (or more padding).
 * The extra block on each side supplies central-difference occupancy gradients.
 * Missing padding throws, rather than creating artificial chunk-border surfaces.
 *
 * Returns NONINDEXED {positions: Float32Array, normals: Float32Array, ids: Uint8Array}.
 * Positions are world coordinates; normals are outward unit occupancy gradients
 * (face normals where the gradient vanishes); ids has
 * one unnormalized material ID per vertex, constant across each triangle.
 * Geometry is clipped to half-open ownership bounds (shared boundary vertices are
 * retained; faces entirely on a high boundary are excluded). Same-step chunks with
 * identical halo data meet exactly. Mixed-step seams need caller-side transitions.
 * One vertex per mixed cube preserves thin features, but ambiguous diagonal
 * contacts may be non-manifold (several sheets sharing a vertex or edge).
 * Pure synchronous builder: caller owns mesh caching and invalidation.
 */
export function buildSurfaceMesh(ids, { size, origin, bounds, step = 1 }) {
  if (!(ids instanceof Uint8Array) || size?.length !== 3 || origin?.length !== 3 ||
      bounds?.length !== 6 || ![1, 2, 4].includes(step) ||
      !size.every(v => Number.isSafeInteger(v) && v > 0) ||
      !origin.every(Number.isSafeInteger) || !bounds.every(Number.isFinite) ||
      size.some((_, a) => bounds[a] >= bounds[a + 3]) ||
      ids.length !== size[0] * size[1] * size[2]) {
    throw new RangeError('Invalid surface mesh volume, bounds or step');
  }
  const start = origin.map((_, a) => (Math.floor((bounds[a] - step / 2) / step) - 1) * step);
  const count = start.map((v, a) => Math.ceil((bounds[a + 3] - step / 2) / step) - v / step + 2);
  if (start.some((v, a) => v < origin[a] || v + count[a] * step > origin[a] + size[a])) {
    throw new RangeError('Surface mesh volume needs complete padded sample blocks');
  }
  const [nx, ny, nz] = count, [sx, sy] = size;
  const samples = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const bx = start[0] - origin[0] + x * step;
    const by = start[1] - origin[1] + y * step;
    const bz = start[2] - origin[2] + z * step;
    let material = 0;
    for (let dz = 0; dz < step && !material; dz++) {
      for (let dy = 0; dy < step && !material; dy++) {
        const offset = bx + sx * (by + dy + sy * (bz + dz));
        for (let dx = 0; dx < step; dx++) {
          const id = ids[offset + dx];
          if (opaque[id]) { material = id; break; }
        }
      }
    }
    samples[x + nx * (y + ny * z)] = material;
  }
  // Negative occupancy gradient points from solid to empty. Leave it unnormalized
  // until interpolation, so empty/flat samples don't bias the direction.
  const gradients = new Int8Array(samples.length * 3);
  const strides = [1, nx, nx * ny];
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const index = x + nx * (y + ny * z);
    for (let a = 0; a < 3; a++) {
      gradients[index * 3 + a] = +!!samples[index - strides[a]] - +!!samples[index + strides[a]];
    }
  }
  const positions = [], normals = [], materials = [];
  const offsets = corners.map(([x, y, z]) => x + nx * (y + ny * z));
  const points = new Array(samples.length);
  // The outer cubes supply the other side of quads crossing ownership bounds.
  // Their gradients are not needed: normals are sampled only after clipping.
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const index = x + nx * (y + ny * z);
    let mask = 0;
    for (let i = 0; i < 8; i++) if (samples[index + offsets[i]]) mask |= 1 << i;
    const point = vertices[mask];
    if (point) points[index] = point.map((v, a) => (start[a] / step + [x, y, z][a] + 0.5 + v) * step);
  }
  function emit(face, material) {
    const normal = cross(...face);
    const length = Math.hypot(...normal);
    if (!length) return;
    for (let a = 0; a < 3; a++) normal[a] /= length;
    let polygon = face;
    if (face.some(p => p.some((v, a) => v < bounds[a] || v >= bounds[a + 3]))) polygon = clip(face, bounds);
    // Cull triangles that collapse in the public Float32 representation, too.
    polygon = polygon.map(p => p.map(Math.fround));
    for (let i = 1; i + 1 < polygon.length; i++) {
      const triangle = [polygon[0], polygon[i], polygon[i + 1]];
      if (Math.hypot(...cross(...triangle)) === 0) continue;
      for (const p of triangle) {
        positions.push(...p);
        // Sample the WORLD-aligned gradient field, not the quad's originating
        // cube: a net triangle spans several cubes, as can its clipped vertices.
        const cell = p.map(v => Math.floor(v / step - 0.5));
        const t = p.map((v, a) => v / step - 0.5 - cell[a]);
        const index = cell.reduce((sum, v, a) => sum + (v - start[a] / step) * strides[a], 0);
        const gradient = [0, 0, 0];
        for (let c = 0; c < 8; c++) {
          const weight = corners[c].reduce((w, v, a) => w * (v ? t[a] : 1 - t[a]), 1);
          for (let a = 0; a < 3; a++) gradient[a] += weight * gradients[(index + offsets[c]) * 3 + a];
        }
        const length = Math.hypot(...gradient);
        normals.push(...(length > 1e-12 ? gradient.map(v => v / length) : normal));
        materials.push(material);
      }
    }
  }
  // Each sign-changing sample edge owns a quad of its four incident cube vertices.
  // Cyclic perpendicular axes give +axis winding; solid at the far end reverses it.
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const index = x + nx * (y + ny * z);
    for (let a = 0; a < 3; a++) {
      const near = samples[index], far = samples[index + strides[a]];
      if (!!near === !!far) continue;
      const b = strides[(a + 1) % 3], c = strides[(a + 2) % 3];
      const quad = [points[index - b - c], points[index - c], points[index], points[index - b]];
      if (!near) [quad[1], quad[3]] = [quad[3], quad[1]];
      emit([quad[0], quad[1], quad[2]], near || far);
      emit([quad[0], quad[2], quad[3]], near || far);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), ids: new Uint8Array(materials) };
}
