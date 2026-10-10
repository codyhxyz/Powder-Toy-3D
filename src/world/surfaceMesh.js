import { ELEMENTS, K, R } from '../elements.js';

const opaque = Uint8Array.from({ length: 256 }, (_, id) =>
  +(id !== 0 && !!ELEMENTS[id] && ELEMENTS[id].kind !== K.GAS && ELEMENTS[id].render !== R.LIQUID));
const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, i >> 2]);
// The same body diagonal in every cube gives matching diagonals on shared faces.
const tetrahedra = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7],
  [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];
const cross = (a, b, c) => [
  (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
  (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
];

// Binary crossings are always edge midpoints: cache topology and fallback face normals.
const triangles = Array.from({ length: 256 }, (_, mask) => {
  const result = [];
  for (const tet of tetrahedra) {
    const inside = tet.filter(i => mask & (1 << i));
    const outside = tet.filter(i => !(mask & (1 << i)));
    if (!inside.length || !outside.length) continue;
    const midpoint = (a, b) => corners[a].map((v, axis) => (v + corners[b][axis]) / 2);
    let faces;
    if (inside.length === 2) {
      const [a, b] = inside, [c, d] = outside;
      const ac = midpoint(a, c), ad = midpoint(a, d), bc = midpoint(b, c), bd = midpoint(b, d);
      faces = [[ac, ad, bc], [ad, bd, bc]];
    } else {
      const lone = inside.length === 1 ? inside : outside;
      const others = inside.length === 1 ? outside : inside;
      faces = [others.map(i => midpoint(lone[0], i))];
    }
    const direction = corners[outside[0]].map((v, axis) => v - corners[inside[0]][axis]);
    for (const points of faces) {
      let normal = cross(...points);
      if (normal.reduce((sum, v, axis) => sum + v * direction[axis], 0) < 0) {
        [points[1], points[2]] = [points[2], points[1]];
        normal = normal.map(v => -v);
      }
      const length = Math.hypot(...normal);
      result.push({ points, normal: normal.map(v => v / length), materialCorner: inside[0] });
    }
  }
  return result;
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
          const t = (plane - a[axis]) / (b[axis] - a[axis]);
          const p = a.map((v, k) => v + t * (b[k] - v));
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
 * Binary marching tetrahedra over cell-centred opaque occupancy.
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
  for (let z = 1; z < nz - 2; z++) for (let y = 1; y < ny - 2; y++) for (let x = 1; x < nx - 2; x++) {
    const index = x + nx * (y + ny * z);
    let mask = 0;
    for (let i = 0; i < 8; i++) if (samples[index + offsets[i]]) mask |= 1 << i;
    if (!mask || mask === 255) continue;
    const base = start.map((v, a) => v + ([x, y, z][a] + 0.5) * step);
    for (const { points, normal, materialCorner } of triangles[mask]) {
      let polygon = points.map(p => p.map((v, a) => base[a] + v * step));
      if (polygon.some(p => p.some((v, a) => v < bounds[a] || v >= bounds[a + 3]))) {
        polygon = clip(polygon, bounds);
      }
      for (let i = 1; i + 1 < polygon.length; i++) {
        const face = [polygon[0], polygon[i], polygon[i + 1]];
        if (Math.hypot(...cross(...face)) === 0) continue;
        for (const p of face) {
          positions.push(...p);
          // Trilinear sampling also covers diagonals and clipped vertices; the
          // same world point sees the same gradient in neighbouring chunks.
          const t = p.map((v, a) => (v - base[a]) / step);
          const gradient = [0, 0, 0];
          for (let c = 0; c < 8; c++) {
            const weight = corners[c].reduce((w, v, a) => w * (v ? t[a] : 1 - t[a]), 1);
            for (let a = 0; a < 3; a++) gradient[a] += weight * gradients[(index + offsets[c]) * 3 + a];
          }
          const length = Math.hypot(...gradient);
          normals.push(...(length > 1e-12 ? gradient.map(v => v / length) : normal));
          materials.push(samples[index + offsets[materialCorner]]);
        }
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), ids: new Uint8Array(materials) };
}
