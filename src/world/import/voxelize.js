// Conservative voxelization of authored triangle surfaces, not a new map.
// A cell is occupied iff its unit cube intersects a source triangle. Interiors
// are NOT invented/flood-filled: disconnected/open Qodot surfaces stay open.
export const IMPORT_BRICK = 8;
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function triangleIntersectsCell(triangle, cell) {
  const t = triangle.map((p) => p.map((v, k) => v - cell[k] - 0.5));
  const edges = [sub(t[1], t[0]), sub(t[2], t[1]), sub(t[0], t[2])];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const separating = (axis) => {
    const r = 0.5 * axis.reduce((n, v) => n + Math.abs(v), 0);
    const p = t.map((v) => dot(v, axis));
    return Math.min(...p) > r + 1e-8 || Math.max(...p) < -r - 1e-8;
  };
  if (axes.some(separating) || separating(cross(edges[0], edges[1]))) return false;
  return !edges.some((edge) => axes.some((axis) => separating(cross(edge, axis))));
}
export function voxelizeMeshes(meshes, mapping, { cellMeters = 0.3, padding = 16, alignment = 8, maxCandidates = 100000000, ownerForMesh = null } = {}) {
  if (!(cellMeters > 0) || !Number.isFinite(cellMeters) || !Number.isInteger(padding) || padding < 1 || !Number.isInteger(alignment) || alignment < 8 || alignment % 8) throw new Error('Invalid voxel scale/bounds');
  const ownerNames = [...new Set(meshes.map(m => ownerForMesh?.(m)).filter(Boolean))];
  const surfaces = meshes.flatMap((m) => m.surfaces.map(s => ({ ...s, owner: ownerNames.indexOf(ownerForMesh?.(m)) + 1 })));
  if (!surfaces.length) throw new Error('No source surfaces');
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const s of surfaces) {
    if (!Object.hasOwn(mapping, s.materialPath)) throw new Error(`Unmapped source material: ${s.materialPath}`);
    const id = mapping[s.materialPath];
    if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error(`Invalid mapped element: ${s.materialPath}`);
    for (let i = 0; i < s.positions.length; i++) {
      const k = i % 3, v = s.positions[i] / cellMeters;
      if (!Number.isFinite(v)) throw new Error('Nonfinite geometry');
      lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v);
    }
  }
  const origin = lo.map((v) => Math.floor(v) - padding);
  const size = hi.map((v, k) => Math.ceil((Math.ceil(v) - origin[k] + padding + 1) / alignment) * alignment);
  const brickDims = size.map((n) => n / IMPORT_BRICK);
  const tableSize = brickDims.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(tableSize) || tableSize > 16000000) throw new Error('Source bounds exceed import budget');
  const bricks = new Map(), owners = new Map(); let candidates = 0, cells = 0, triangles = 0;
  const put = (p, id, owner) => {
    if (p.some((n, k) => n < 0 || n >= size[k])) throw new Error('Voxel outside bounds');
    const b = p.map((v) => Math.floor(v / IMPORT_BRICK));
    const key = b[0] + brickDims[0] * (b[1] + brickDims[1] * b[2]);
    let data = bricks.get(key);
    if (!data) { data = new Uint8Array(512); bricks.set(key, data); }
    const i = (p[0] % 8) + 8 * ((p[1] % 8) + 8 * (p[2] % 8));
    if (!data[i]) cells++;
    if (ownerForMesh) {
      let own = owners.get(key);
      if (!own) { own = new Uint16Array(512); owners.set(key, own); }
      // ANY static surface or another mover disqualifies ownership, even if
      // hidden under this surface by source-order material precedence.
      const tag = owner || 65535;
      own[i] = !own[i] || own[i] === tag ? tag : 65535;
    }
    // Source node/surface/index order is the stable overlap precedence.
    data[i] = id;
  };
  for (const s of surfaces) {
    const id = mapping[s.materialPath];
    if (!id) continue; // An explicit EMPTY mapping (triggers, not a fallback).
    for (let i = 0; i < s.indices.length; i += 3) {
      triangles++;
      const t = [0, 1, 2].map((j) => [0, 1, 2].map((k) => s.positions[s.indices[i + j] * 3 + k] / cellMeters - origin[k]));
      const normal = cross(sub(t[1], t[0]), sub(t[2], t[0]));
      const dominant = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
      if (Math.abs(normal[dominant]) < 1e-10) continue;
      const u = (dominant + 1) % 3, v = (dominant + 2) % 3;
      const min = [0, 1, 2].map((k) => Math.floor(Math.min(...t.map((p) => p[k])) - 1e-8));
      const max = [0, 1, 2].map((k) => Math.floor(Math.max(...t.map((p) => p[k])) + 1e-8));
      const constant = dot(normal, t[0]);
      for (let a = min[u]; a <= max[u]; a++) for (let b = min[v]; b <= max[v]; b++) {
        const heights = [0, 1, 2, 3].map((j) => (constant - normal[u] * (a + (j & 1)) - normal[v] * (b + (j >> 1))) / normal[dominant]);
        const from = Math.max(min[dominant], Math.floor(Math.min(...heights) - 1e-8));
        const to = Math.min(max[dominant], Math.floor(Math.max(...heights) + 1e-8));
        for (let c = from; c <= to; c++) {
          if (++candidates > maxCandidates) throw new Error('Voxel candidate budget exceeded');
          const p = []; p[u] = a; p[v] = b; p[dominant] = c;
          if (triangleIntersectsCell(t, p)) put(p, id, s.owner);
        }
      }
    }
  }
  // SD table: 0 = empty brick, otherwise absolute word offset of its 128
  // little-endian packed-u8 words. X fastest, then Y, then Z throughout.
  const dataAt = Math.ceil(tableSize / 4) * 4;
  const words = new Uint32Array(dataAt + bricks.size * 128);
  let at = dataAt;
  for (const [key, data] of [...bricks].sort(([a], [b]) => a - b)) {
    words[key] = at;
    for (let i = 0; i < 128; i++) words[at + i] = (data[i * 4] | data[i * 4 + 1] << 8 | data[i * 4 + 2] << 16 | data[i * 4 + 3] << 24) >>> 0;
    at += 128;
  }
  const ownedCells = Object.fromEntries(ownerNames.map(name => [name, []]));
  for (const [key, own] of owners) {
    const b = [key % brickDims[0], Math.floor(key / brickDims[0]) % brickDims[1], Math.floor(key / (brickDims[0] * brickDims[1]))];
    const data = bricks.get(key);
    for (let i = 0; i < 512; i++) if (own[i] && own[i] !== 65535) {
      const p = [b[0] * 8 + i % 8, b[1] * 8 + Math.floor(i / 8) % 8, b[2] * 8 + Math.floor(i / 64)];
      ownedCells[ownerNames[own[i] - 1]].push(p[0] + size[0] * (p[1] + size[1] * p[2]), data[i]);
    }
  }
  return { ...(ownerForMesh ? { ownedCells } : {}), version: 1, encoding: 'sparse-brick-u8-v1', cellMeters, origin, size, brickDims, words, stats: { triangles, candidates, cells, bricks: bricks.size, bytes: words.byteLength } };
}
export function importedCell(map, words, x, y, z) {
  const p = [x, y, z];
  if (p.some((n, k) => !Number.isInteger(n) || n < 0 || n >= map.size[k])) return 0;
  const b = p.map((n) => Math.floor(n / 8)), d = map.brickDims;
  const at = words[b[0] + d[0] * (b[1] + d[1] * b[2])];
  if (!at) return 0;
  const i = x % 8 + 8 * (y % 8 + 8 * (z % 8));
  return (words[at + (i >> 2)] >>> ((i & 3) * 8)) & 255;
}
export function sourceToCells(map, position) { return position.map((v, k) => v / map.cellMeters - map.origin[k]); }
