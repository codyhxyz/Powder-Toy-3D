// The raster bench's scene: a baked preset (tools/v2/bake-bench-scene.mjs)
// read back into element ids, and the faces v2 would draw from it, found on
// the CPU at load (v2's mesher runs on the GPU, docs/v2.md 3.2; here only its
// output matters, and its count is checked against the bake's).

export const CLS = { AIR: 0, OPAQUE: 1, LIQUID: 2, TRANSLUCENT: 3, GAS: 4, EMISSIVE: 5 };

/**
 * Fetches and inflates public/bench/<name>.bin.
 * @returns {Promise<{ header: object, dims: number[], ids: Uint8Array, bytes: number, fetchMs: number, decodeMs: number }>}
 *   ids x fastest, then y, then z (the 3D textures' order; the file holds x, z, y)
 */
export async function loadScene(url) {
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const packed = await res.arrayBuffer();
  const t1 = performance.now();
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser has no DecompressionStream (Safari 16.4+, Chrome 80+)');
  const raw = new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const magic = String.fromCharCode(...raw.subarray(0, 4));
  if (magic !== 'TPB1') throw new Error(`${url}: not a bench scene (magic ${JSON.stringify(magic)})`);
  const headerBytes = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerBytes)));
  const [nx, ny, nz] = header.dims;
  const file = new Uint8Array(nx * ny * nz);
  let i = 0;
  for (let p = 8 + headerBytes; p < raw.length;) {
    const id = raw[p++];
    let n = 0, shift = 0, b;
    do { b = raw[p++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    file.fill(id, i, i + n);
    i += n;
  }
  if (i !== file.length) throw new Error(`${url}: ${i} cells decoded, ${file.length} expected`);
  const ids = new Uint8Array(file.length);
  for (let y = 0, s = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, s++) ids[x + nx * (y + ny * z)] = file[s];
  return { header, dims: [nx, ny, nz], ids, bytes: packed.byteLength, fetchMs: t1 - t0, decodeMs: performance.now() - t1 };
}

// Direction d: 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z (as the shaders decode it).
// The face's quad spans its two tangent axes u, v with u × v = the normal,
// u = axis + 1 and v = axis + 2 (mod 3) on a positive face, swapped on a
// negative one, so the quad (0,0) (1,0) (1,1) (0,1) winds counter-clockwise
// seen from outside.
const AXIS_UNIT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const DIRS = [0, 1, 2, 3, 4, 5].map((d) => {
  const axis = d >> 1, neg = d & 1;
  const n = AXIS_UNIT[axis].map((v) => (neg ? -v : v));
  const u = AXIS_UNIT[(axis + (neg ? 2 : 1)) % 3], v = AXIS_UNIT[(axis + (neg ? 1 : 2)) % 3];
  return { n, u, v };
});
// corner k of the quad: (0,0) (1,0) (1,1) (0,1)
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

/**
 * Exposed faces by tools/v2/crisp/faces.mjs's rules, each 8 B (2 u32), v2's
 * draw-list entry size (docs/v2.md 3.2):
 *   word 0: x | y << 8 | z << 16 | direction << 24
 *   word 1: element id | corner AO << 8 (4 corners × 2 bits, Lysenko's
 *           3-neighbour rule, 0fps.net 2013: 3 = open, 0 = fully occluded)
 * Opaque faces in one list; liquid then glass faces in the other (the
 * translucent pass draws liquids first, so glass blends over them).
 */
export function extractFaces(scene) {
  const t0 = performance.now();
  const { ids, dims: [nx, ny, nz], header } = scene;
  const cls = new Uint8Array(256);
  header.elements.forEach((e, i) => { cls[i] = e.cls === CLS.EMISSIVE ? CLS.OPAQUE : e.cls; });
  const C = new Uint8Array(ids.length);
  for (let i = 0; i < ids.length; i++) C[i] = cls[ids[i]];
  const at = (x, y, z) => x + nx * (y + ny * z);
  // the box floor counts as opaque, its open sides and top as air
  const get = (x, y, z) => (y < 0 ? CLS.OPAQUE : x < 0 || z < 0 || x >= nx || z >= nz || y >= ny ? CLS.AIR : C[at(x, y, z)]);
  const solid = (x, y, z) => (get(x, y, z) === CLS.OPAQUE ? 1 : 0);
  const opaque = [], liquid = [], glass = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const c = C[at(x, y, z)];
    if (c === CLS.AIR || c === CLS.GAS) continue;
    for (let d = 0; d < 6; d++) {
      const { n, u, v } = DIRS[d];
      const o = get(x + n[0], y + n[1], z + n[2]);
      let list = null;
      if (c === CLS.OPAQUE) { if (o !== CLS.OPAQUE) list = opaque; }
      else if (c === CLS.LIQUID) { if (o === CLS.AIR || o === CLS.GAS || o === CLS.TRANSLUCENT) list = liquid; }
      else if (c === CLS.TRANSLUCENT) { if (o !== CLS.TRANSLUCENT && o !== CLS.OPAQUE) list = glass; }
      if (!list) continue;
      let ao = 0xff;
      if (list === opaque) {
        ao = 0;
        const lx = x + n[0], ly = y + n[1], lz = z + n[2];
        for (let k = 0; k < 4; k++) {
          const su = CORNERS[k][0] ? 1 : -1, sv = CORNERS[k][1] ? 1 : -1;
          const s1 = solid(lx + su * u[0], ly + su * u[1], lz + su * u[2]);
          const s2 = solid(lx + sv * v[0], ly + sv * v[1], lz + sv * v[2]);
          const cc = solid(lx + su * u[0] + sv * v[0], ly + su * u[1] + sv * v[1], lz + su * u[2] + sv * v[2]);
          ao |= (s1 && s2 ? 0 : 3 - (s1 + s2 + cc)) << (2 * k);
        }
      }
      list.push(x | (y << 8) | (z << 16) | (d << 24), ids[at(x, y, z)] | (ao << 8));
    }
  }
  const counts = { opaque: opaque.length / 2, liquid: liquid.length / 2, glass: glass.length / 2 };
  return {
    opaque: Uint32Array.from(opaque),
    translucent: Uint32Array.from([...liquid, ...glass]),
    counts,
    ms: performance.now() - t0,
  };
}

/** Per column (x, z): one above the highest opaque cell, 0 if none (the sky light's sources start there). */
export function columnHeights(scene) {
  const { ids, dims: [nx, ny, nz], header } = scene;
  const opaque = header.elements.map((e) => e.cls === CLS.OPAQUE || e.cls === CLS.EMISSIVE);
  const h = new Uint32Array(nx * nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++)
      for (let y = ny - 1; y >= 0; y--)
        if (opaque[ids[x + nx * (y + ny * z)]]) { h[x + nx * z] = y + 1; break; }
  return h;
}
