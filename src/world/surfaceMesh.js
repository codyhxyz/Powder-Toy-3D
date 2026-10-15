import { ELEMENTS, E, K, R } from '../elements.js';
import { materialWord, materialId, materialAppearance } from '../appearance.js';

const opaque = Uint8Array.from({ length: 256 }, (_, id) =>
  +(id !== 0 && !!ELEMENTS[id] && ELEMENTS[id].kind !== K.GAS && ELEMENTS[id].render !== R.LIQUID));
// Loose ground: what the shovel digs (elements.js tool), powders and the soils on them.
const loose = Uint8Array.from({ length: 256 }, (_, id) => +(opaque[id] && ELEMENTS[id].tool === 'shovel'));
const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, i >> 2]);
// (b - a) × (c - a) of the points at offsets a, b, c of p, into out.
function cross(out, p, a, b, c) {
  out[0] = (p[b + 1] - p[a + 1]) * (p[c + 2] - p[a + 2]) - (p[b + 2] - p[a + 2]) * (p[c + 1] - p[a + 1]);
  out[1] = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
  out[2] = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
}

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

// three's mergeVertices hash of one attribute value, at its default 1e-4 tolerance.
const bucket = v => Math.trunc(v * 1e4 + 0.5);

// Each ownership plane can at most double a polygon (a kept corner and a crossing
// per edge), so a clipped triangle always fits. A convex one gains one per plane.
const RING = 3 << 6;

// Loose ground shades by a wider view of itself. On cells that are full or
// empty a gentle slope is a staircase, and the gradient one cell wide turns at
// every step, flat on a tread and 45° at a riser, so each step catches the sun
// as a band: the stripes across lawns and down beaches. Gibson ("Using
// Distance Maps for Accurate Surface Representation in Sampled Volumes", IEEE
// Volume Visualization 1998) shows binary volumes shade in these terraces and
// takes the normal from a smooth field instead. Ours is the occupancy blurred
// by a Gaussian: near a gently curved surface it reads Φ(distance / σ), so its
// gradient is the distance map's. The vertices stay where they are.
// Only loose ground takes it: sand, soil, gravel, snow and the plants on them
// lie in slopes. Walls, wood, rock and metal keep the cell-wide normal: the
// blur would round a wall's or a trunk's foot into the ground and every
// feature under ~3σ into a blob. So does foliage: a crown is lobes, not a
// hill, while a plant cell resting on soil is ground cover. And on the ground it applies where
// the blurred surface runs through the vertex, as over a staircase; the lip
// of a one-cell layer, an edge or a corner reads well off 0.5 there and keeps
// its edge.
export const SMOOTH = {
  SIGMA: 2,   // samples: a Gaussian keeps exp(−2π²σ²/N²) of a staircase's ripple of period N: under 1 % of a 1:4 slope's, 11 % of a 1:6 slope's (the user's lawn and beach stripes measured 4–6 cells apart, 2026-10-13)
  TRUNC: 3,   // σ: where the kernel is cut (99.7 % of its weight inside)
};
const SMOOTH_R = Math.ceil(SMOOTH.TRUNC * SMOOTH.SIGMA);   // samples the smoothing reads past the sample grid
const KERNEL = (() => {
  const w = Array.from({ length: 2 * SMOOTH_R + 1 }, (_, i) => Math.exp(-((i - SMOOTH_R) ** 2) / (2 * SMOOTH.SIGMA ** 2)));
  const sum = w.reduce((a, b) => a + b);
  return Float64Array.from(w, v => v / sum);
})();
// The band over which the cell-wide normal takes over, in |blurred − 0.5| at
// the vertex. A staircase's vertex is within half a sample of the blurred
// surface, where the field moves by the centre weight per sample, so it reads
// at most w0 / 2 off. A one-sample sheet's face reads (w0 + w1) / 2, which is
// 0.5 − (w0 + w1) / 2 off. Edges and thicker features fall in between.
const SMOOTH_LO = KERNEL[SMOOTH_R] / 2;
const SMOOTH_HI = 0.5 - (KERNEL[SMOOTH_R] + KERNEL[SMOOTH_R + 1]) / 2;
/** Cells of padding past the bounds a volume needs at a step: the sample grid's two blocks and the smoothing's reach. */
export const meshPadding = (step = 1) => (2 + SMOOTH_R) * step;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Binary surface nets over cell-centred opaque occupancy.
 * ids: Uint8Array, x fastest, then y, then z. origin: integer world cell corner.
 * size: positive integer [sx,sy,sz]; bounds: finite [loX,loY,loZ,hiX,hiY,hiZ].
 * step: 1 (default), 2 or 4. Coarse blocks are aligned to WORLD multiples of step;
 * any opaque cell keeps a block occupied, with its first x-fast opaque ID as material.
 * Supply complete blocks from (floor((lo-step/2)/step)-1-r)*step through
 * (ceil((hi-step/2)/step)+2+r)*step EXCLUSIVE on each axis (or more padding),
 * r the smoothing's reach in blocks (meshPadding covers it for whole bounds).
 * The extra block on each side supplies central-difference occupancy gradients.
 * Missing padding throws, rather than creating artificial chunk-border surfaces.
 *
 * Returns INDEXED {positions: Float32Array, normals: Float32Array, ids: Uint8Array,
 * indices: Uint16Array, or Uint32Array past 65535 vertices (as three's setIndex)}.
 * Positions are world coordinates; normals are outward unit occupancy gradients,
 * turned toward the smoothed occupancy's on ground (SMOOTH), (face normals
 * where the gradient vanishes); ids has one unnormalized material
 * ID per vertex. Vertices are unique (position, normal, ID) tuples: a net vertex
 * is split per material of the faces around it, and per face where its gradient
 * vanishes, so each triangle keeps one material and its face normal fallback.
 * Geometry is clipped to half-open ownership bounds (shared boundary vertices are
 * retained; faces entirely on a high boundary are excluded). Same-step chunks with
 * identical halo data meet exactly. Mixed-step seams need caller-side transitions.
 * One vertex per mixed cube preserves thin features, but ambiguous diagonal
 * contacts may be non-manifold (several sheets sharing a vertex or edge).
 * Pure synchronous builder: caller owns mesh caching and invalidation.
 */
export function buildSurfaceMesh(ids, { size, origin, bounds, step = 1, appearances = null }) {
  if (!(ids instanceof Uint8Array) || size?.length !== 3 || origin?.length !== 3 ||
      bounds?.length !== 6 || ![1, 2, 4].includes(step) ||
      !size.every(v => Number.isSafeInteger(v) && v > 0) ||
      !origin.every(Number.isSafeInteger) || !bounds.every(Number.isFinite) ||
      size.some((_, a) => bounds[a] >= bounds[a + 3]) ||
      ids.length !== size[0] * size[1] * size[2] ||
      (appearances !== null && (!(appearances instanceof Uint8Array) || appearances.length !== ids.length))) {
    throw new RangeError('Invalid surface mesh volume, bounds or step');
  }
  const start = origin.map((_, a) => (Math.floor((bounds[a] - step / 2) / step) - 1) * step);
  const count = start.map((v, a) => Math.ceil((bounds[a + 3] - step / 2) / step) - v / step + 2);
  const reach = SMOOTH_R;
  if (start.some((v, a) => v - reach * step < origin[a] || v + (count[a] + reach) * step > origin[a] + size[a])) {
    throw new RangeError('Surface mesh volume needs complete padded sample blocks');
  }
  const [nx, ny, nz] = count, [sx, sy] = size;
  // Each sample's material over the grid and the smoothing's reach past it
  // (wide), then the grid's own (samples).
  const [ex, ey, ez] = count.map(n => n + 2 * reach);
  const wide = new Uint8Array(ex * ey * ez);
  const wideAppearances = new Uint8Array(wide.length);
  if (step === 1) for (let z = 0; z < ez; z++) for (let y = 0; y < ey; y++) {
    // (a sample is a cell: a row of cells is a row of samples)
    const from = start[0] - reach - origin[0] + sx * (start[1] - reach - origin[1] + y + sy * (start[2] - reach - origin[2] + z));
    const out = ex * (y + ey * z);
    for (let x = 0; x < ex; x++) {
      const id = ids[from + x];
      wide[out + x] = opaque[id] ? id : 0;
      if (opaque[id]) wideAppearances[out + x] = appearances?.[from + x] ?? 0;
    }
  }
  else for (let z = 0; z < ez; z++) for (let y = 0; y < ey; y++) for (let x = 0; x < ex; x++) {
    const bx = start[0] - origin[0] + (x - reach) * step;
    const by = start[1] - origin[1] + (y - reach) * step;
    const bz = start[2] - origin[2] + (z - reach) * step;
    let material = 0, appearance = 0;
    for (let dz = 0; dz < step && !material; dz++) {
      for (let dy = 0; dy < step && !material; dy++) {
        const offset = bx + sx * (by + dy + sy * (bz + dz));
        for (let dx = 0; dx < step; dx++) {
          const id = ids[offset + dx];
          if (opaque[id]) { material = id; appearance = appearances?.[offset + dx] ?? 0; break; }
        }
      }
    }
    wide[x + ex * (y + ey * z)] = material;
    wideAppearances[x + ex * (y + ey * z)] = appearance;
  }
  const samples = new Uint8Array(nx * ny * nz);
  const sampleAppearances = new Uint8Array(samples.length);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const from = reach + ex * (y + reach + ey * (z + reach));
    samples.set(wide.subarray(from, from + nx), nx * (y + ny * z));
    sampleAppearances.set(wideAppearances.subarray(from, from + nx), nx * (y + ny * z));
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
  // Net vertex of each mixed cube, in float64 world coordinates: slots[cube]
  // numbers the mixed cubes x-fast, and points holds theirs in that order.
  const grow = (array, length) => { const out = new array.constructor(length); out.set(array); return out; };
  const offsets = corners.map(([x, y, z]) => x + nx * (y + ny * z));
  const first = start.map(v => v / step);
  const slots = new Int32Array(samples.length);
  let points = new Float64Array(3 << 12), mixed = 0, lowest = ny, highest = -1;
  // The outer cubes supply the other side of quads crossing ownership bounds.
  // Their gradients are not needed: normals are sampled only after clipping.
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const index = x + nx * (y + ny * z);
    let mask = 0;
    for (let i = 0; i < 8; i++) if (samples[index + offsets[i]]) mask |= 1 << i;
    const point = vertices[mask];
    if (!point) continue;
    if (mixed * 3 === points.length) points = grow(points, points.length * 2);
    points[mixed * 3] = (first[0] + x + 0.5 + point[0]) * step;
    points[mixed * 3 + 1] = (first[1] + y + 0.5 + point[1]) * step;
    points[mixed * 3 + 2] = (first[2] + z + 0.5 + point[2]) * step;
    slots[index] = mixed++;
    lowest = Math.min(lowest, y);
    highest = Math.max(highest, y);
  }

  // The smoothed occupancy (SMOOTH) at the grid's samples, over the heights
  // the normals read: a vertex of cube y reads samples y..y + 2 and their
  // neighbours, y - 1..y + 3. Three separable passes of the kernel; a
  // sample's value doesn't depend on the range, so chunks agree on it.
  const smooth = new Float32Array(nx * ny * nz);
  if (mixed) {
    const y0 = Math.max(0, lowest - 1), y1 = Math.min(ny - 1, highest + 3);
    const h = y1 - y0 + 1, hy = h + 2 * reach, taps = 2 * reach + 1;
    // along x: wide rows y0 - reach..y1 + reach of the grid, every z
    const alongX = new Float32Array(nx * hy * ez);
    for (let z = 0; z < ez; z++) for (let y = 0; y < hy; y++) {
      const row = ex * (y0 + y + ey * z), out = nx * (y + hy * z);
      for (let x = 0; x < nx; x++) {
        let sum = 0;
        for (let j = 0; j < taps; j++) if (wide[row + x + j]) sum += KERNEL[j];
        alongX[out + x] = sum;
      }
    }
    // along y: rows y0..y1, every z
    const alongY = new Float32Array(nx * h * ez);
    for (let z = 0; z < ez; z++) for (let y = 0; y < h; y++) for (let x = 0; x < nx; x++) {
      let sum = 0;
      for (let j = 0; j < taps; j++) sum += KERNEL[j] * alongX[x + nx * (y + j + hy * z)];
      alongY[x + nx * (y + h * z)] = sum;
    }
    // along z: the grid's own z
    for (let z = 0; z < nz; z++) for (let y = 0; y < h; y++) for (let x = 0; x < nx; x++) {
      let sum = 0;
      for (let j = 0; j < taps; j++) sum += KERNEL[j] * alongY[x + nx * (y + h * (z + j))];
      smooth[x + nx * (y0 + y + ny * z)] = sum;
    }
  }

  // Indexed output, grown geometrically. A vertex is a (position, material,
  // normal) as three's mergeVertices told them apart: a net vertex splits per
  // material of the faces around it, and per face normal where its gradient
  // vanishes (flat[v]). The vertices at one position chain from heads[slot], or
  // boundary[position] on ownership planes: 1 + the newest, then next[v] is 1 +
  // the one before it (0 ends the chain).
  let capacity = Math.max(64, mixed), vertexCount = 0, indexCount = 0;
  let positions = new Float32Array(capacity * 3), normals = new Float32Array(capacity * 3);
  let materials = new Uint16Array(capacity), next = new Int32Array(capacity), flat = new Uint8Array(capacity);
  let grounds = new Uint8Array(capacity);
  let indices = new Uint32Array(capacity * 6);
  const heads = new Int32Array(mixed), boundary = new Map(), planes = bounds.map(Math.fround);
  // Face scratch: polygon corners and their cube slots (-1: clipped), clipping into spare.
  let ring = new Float64Array(RING * 3), ringSlot = new Int32Array(RING);
  let spare = new Float64Array(RING * 3), spareSlot = new Int32Array(RING);
  const normal = new Float64Array(3), product = new Float64Array(3);
  const sampled = new Float64Array(3), fraction = new Float64Array(3);

  // Clip the ring's n corners to the ownership bounds, plane by plane through
  // spare. Returns the corners left in the ring, 0 when the face isn't owned.
  function clip(n) {
    for (let axis = 0; axis < 3; axis++) {
      for (let side = 0; side < 2; side++) {
        const plane = bounds[axis + side * 3];
        // Keep shared edge vertices, but do not own a face lying on the high plane.
        if (side) {
          let on = true;
          for (let i = 0; i < n && on; i++) on = ring[i * 3 + axis] === plane;
          if (on) return 0;
        }
        let m = 0;
        for (let i = 0; i < n; i++) {
          const a = i * 3, b = (i + 1) % n * 3;
          const aIn = side ? ring[a + axis] <= plane : ring[a + axis] >= plane;
          const bIn = side ? ring[b + axis] <= plane : ring[b + axis] >= plane;
          if (aIn) {
            for (let k = 0; k < 3; k++) spare[m * 3 + k] = ring[a + k];
            spareSlot[m++] = ringSlot[i];
          }
          if (aIn !== bIn) {
            // Identical arithmetic on either traversal of a shared triangle edge.
            const lo = ring[a + axis] < ring[b + axis] ? a : b, hi = lo === a ? b : a;
            const t = (plane - ring[lo + axis]) / (ring[hi + axis] - ring[lo + axis]);
            for (let k = 0; k < 3; k++) spare[m * 3 + k] = ring[lo + k] + t * (ring[hi + k] - ring[lo + k]);
            spare[m * 3 + axis] = plane;
            spareSlot[m++] = -1;
          }
        }
        const done = ring, doneSlot = ringSlot;
        ring = spare; ringSlot = spareSlot; spare = done; spareSlot = doneSlot;
        n = m;
        if (n < 3) return 0;
      }
    }
    return n;
  }
  // The outward normal at the ring corner at offset at, into sampled: the
  // WORLD-aligned gradient field, not the quad's originating cube (a net triangle
  // spans several cubes, as can its clipped vertices), turned toward the
  // smoothed field's on loose ground where its surface runs through here
  // (SMOOTH), or the face normal where the gradient vanishes. Returns 1 for that fallback.
  function normalAt(at, ground) {
    let index = 0;
    for (let a = 0; a < 3; a++) {
      const p = ring[at + a], cell = Math.floor(p / step - 0.5);
      fraction[a] = p / step - 0.5 - cell;
      index += (cell - first[a]) * strides[a];
    }
    let gx = 0, gy = 0, gz = 0, wx = 0, wy = 0, wz = 0, level = 0;
    for (let c = 0; c < 8; c++) {
      const corner = corners[c], i = index + offsets[c], g = i * 3;
      const weight = (corner[0] ? fraction[0] : 1 - fraction[0]) *
        (corner[1] ? fraction[1] : 1 - fraction[1]) * (corner[2] ? fraction[2] : 1 - fraction[2]);
      gx += weight * gradients[g];
      gy += weight * gradients[g + 1];
      gz += weight * gradients[g + 2];
      level += weight * smooth[i];
      wx += weight * (smooth[i - strides[0]] - smooth[i + strides[0]]);
      wy += weight * (smooth[i - strides[1]] - smooth[i + strides[1]]);
      wz += weight * (smooth[i - strides[2]] - smooth[i + strides[2]]);
    }
    const length = Math.hypot(gx, gy, gz);
    if (length > 1e-12) {
      gx /= length; gy /= length; gz /= length;
      const span = Math.hypot(wx, wy, wz);
      const t = !ground || span <= 1e-12 ? 0 : 1 - smoothstep(SMOOTH_LO, SMOOTH_HI, Math.abs(level - 0.5));
      const mx = gx + t * (wx / span - gx), my = gy + t * (wy / span - gy), mz = gz + t * (wz / span - gz);
      const m = Math.hypot(mx, my, mz);
      if (m > 1e-12) { gx = mx / m; gy = my / m; gz = mz / m; }
      sampled[0] = gx;
      sampled[1] = gy;
      sampled[2] = gz;
      return 0;
    }
    sampled.set(normal);
    return 1;
  }
  // The vertex for ring corner r: an existing one with the same material and
  // normal, else a new one. A cube vertex has one position, so one gradient
  // normal per ground flag: only face normal fallbacks are compared. A corner
  // on an ownership plane is found by position: every clipped corner lies on one, a cube vertex
  // lying on one comes back from clipping as a copy of itself, and one on two
  // planes can be off the second by roundoff (0 against -3e-17), so these merge
  // in mergeVertices' buckets and compare normals too.
  function vertex(r, material, ground) {
    const at = r * 3, slot = ringSlot[r];
    let key = null;
    for (let a = 0; a < 3 && key === null; a++) {
      if (ring[at + a] === planes[a] || ring[at + a] === planes[a + 3]) {
        key = `${bucket(ring[at])},${bucket(ring[at + 1])},${bucket(ring[at + 2])}`;
      }
    }
    const head = key === null ? heads[slot] : boundary.get(key) ?? 0;
    let shared = -1;
    if (key === null && head > 0 && !flat[head - 1]) {
      for (let v = head - 1; v >= 0 && shared < 0; v = next[v] - 1) if (grounds[v] === ground) shared = v;
    }
    const fallback = shared >= 0 ? 0 : normalAt(at, ground);
    if (shared >= 0) for (let a = 0; a < 3; a++) sampled[a] = normals[shared * 3 + a];
    for (let v = head - 1; v >= 0; v = next[v] - 1) {
      if (materials[v] === material && sameNormal(v)) return v;
    }
    if (vertexCount === capacity) {
      capacity *= 2;
      positions = grow(positions, capacity * 3);
      normals = grow(normals, capacity * 3);
      materials = grow(materials, capacity);
      next = grow(next, capacity);
      flat = grow(flat, capacity);
      grounds = grow(grounds, capacity);
    }
    const v = vertexCount++;
    for (let a = 0; a < 3; a++) {
      positions[v * 3 + a] = ring[at + a];
      normals[v * 3 + a] = sampled[a];
    }
    flat[v] = fallback;
    grounds[v] = ground;
    materials[v] = material;
    next[v] = head;
    if (key === null) heads[slot] = v + 1;
    else boundary.set(key, v + 1);
    return v;
  }
  // Normals match in mergeVertices' buckets of their Float32 values: coplanar
  // faces' fallback normals differ by roundoff (0 against 6e-16).
  function sameNormal(v) {
    for (let a = 0; a < 3; a++) if (bucket(normals[v * 3 + a]) !== bucket(Math.fround(sampled[a]))) return false;
    return true;
  }
  function emit(q0, q1, q2, material, ground) {
    cross(normal, points, q0 * 3, q1 * 3, q2 * 3);
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (!length) return;
    for (let a = 0; a < 3; a++) normal[a] /= length;
    let n = 3, outside = false;
    ringSlot[0] = q0; ringSlot[1] = q1; ringSlot[2] = q2;
    for (let i = 0; i < 3; i++) for (let a = 0; a < 3; a++) {
      const v = ring[i * 3 + a] = points[ringSlot[i] * 3 + a];
      outside ||= v < bounds[a] || v >= bounds[a + 3];
    }
    if (outside) n = clip(n);
    // Cull triangles that collapse in the public Float32 representation, too.
    for (let i = 0; i < n * 3; i++) ring[i] = Math.fround(ring[i]);
    for (let i = 1; i + 1 < n; i++) {
      cross(product, ring, 0, i * 3, (i + 1) * 3);
      if (Math.hypot(product[0], product[1], product[2]) === 0) continue;
      if (indexCount + 3 > indices.length) indices = grow(indices, indices.length * 2);
      indices[indexCount++] = vertex(0, material, ground);
      indices[indexCount++] = vertex(i, material, ground);
      indices[indexCount++] = vertex(i + 1, material, ground);
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
      // Quad of cubes index - b - c, index - c, index, index - b (1 and 3 swap if near is empty).
      const zero = slots[index - b - c], two = slots[index];
      const one = slots[near ? index - c : index - b], three = slots[near ? index - b : index - c];
      // Loose ground takes the smoothed normal (SMOOTH); a plant sample not resting on soil is foliage.
      const solid = near ? index : index + strides[a], material = samples[solid], below = samples[solid - nx];
      const ground = loose[material] & +(material !== E.PLANT || (!!below && below !== E.PLANT && below !== E.WOOD));
      const word = materialWord(material, sampleAppearances[solid]);
      emit(zero, one, two, word, ground);
      emit(zero, two, three, word, ground);
    }
  }
  return {
    positions: positions.slice(0, vertexCount * 3),
    normals: normals.slice(0, vertexCount * 3),
    ids: Uint8Array.from(materials.subarray(0, vertexCount), materialId),
    appearances: Uint8Array.from(materials.subarray(0, vertexCount), materialAppearance),
    // 0xFFFF is WebGL's primitive restart index, so Uint16 holds 65535 vertices.
    indices: vertexCount > 0xffff ? indices.slice(0, indexCount) : Uint16Array.from(indices.subarray(0, indexCount)),
  };
}
