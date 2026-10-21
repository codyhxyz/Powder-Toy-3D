// The sea past a world's edge (the user, 2026-10-20: "water should be shown
// in the edge if water goes all the way to the edge"). The sky pass
// (gfx/overlays.js drawSky) continues the sea out to the horizon from each
// stretch of a world's edge that its sea reaches. Where land meets the edge,
// the open ground beyond is drawn as before. Until 2026-10-15 the far field
// drew a sea past the whole edge (shaders/farShared.js farSea); this draws it
// only where the world's own water meets it.
//
// Which stretches those are comes from the scene's CPU twin of its ground
// (world/scenes/index.js ground: the top of the topmost solid or liquid).
// At an edge column, that top sits at the sea level where the sea reaches the
// edge and above it where land does. A wet beach exactly at the waterline
// counts as sea, and the sea beyond it looks the same.
//
//   const m = edgeSeaMask(scene, P);   // null: no sea at the edge
//   m.words                            // EDGE_SEA_VEC4 × [u32 × 4], SkyParams.mask
//   edgeSeaParams(sceneEdgeSea(scene, P), P.size, origin)   // drawSky's sea, the grid's cells
//   edgeSeaIndex(foot, h)              // the JS twin of the sky shader's lookup
//
// The small maps (one box) do the same past the box's walls (boxEdgeSea).
// They have no scene to ask, so their ground is their cells as built or
// loaded. The Islet is the island scene on a box, so it asks that scene's twin.
//   const s = boxEdgeSea((x, y, z) => id, [nx, ny, nz]);   // null: no water at the edge
//   s.words, s.count                    // as edgeSeaMask's
//   s.sea                               // the water's surface, cells (the sky's seaY)
import { E, K, ELEMENTS } from '../elements.js';

// Samples along each side: one every 1/1024 of it (a cell on a 1024-wide
// world, three on Tinker Creek's 3072), 32 to a u32, 4 u32 to a vec4u (a
// uniform array's 16-byte stride).
export const EDGE_SEA_SAMPLES = 1024;
export const EDGE_SEA_SIDES = 4;   // z = 0, x = max, z = max, x = 0
const BITS = 32, LANES = 4;
export const EDGE_SEA_VEC4 = EDGE_SEA_SIDES * EDGE_SEA_SAMPLES / (BITS * LANES);
const EDGE_COLUMN = 0.5;   // cells in from the edge: the edge column's centre

// The world column (x, z) of sample i (0..EDGE_SEA_SAMPLES-1) on a side, world cells.
function sampleColumn(side, i, sx, sz) {
  const u = (i + 0.5) / EDGE_SEA_SAMPLES;
  if (side === 0) return [u * sx, EDGE_COLUMN];
  if (side === 1) return [sx - EDGE_COLUMN, u * sz];
  if (side === 2) return [u * sx, sz - EDGE_COLUMN];
  return [EDGE_COLUMN, u * sz];
}

/**
 * The stretches of world P's edge that its sea reaches, as the sky pass's
 * bit mask, or null where none does (no sea, or land all round).
 * @param {{ ground: (x: number, z: number, P: object) => number }} scene
 * @param {{ size: number[], sea?: number }} P
 */
export function edgeSeaMask(scene, P) {
  const sea = P?.sea ?? 0;
  if (!(sea > 0) || typeof scene?.ground !== 'function') return null;
  const [sx, , sz] = P.size, level = Math.ceil(sea);
  const words = Array.from({ length: EDGE_SEA_VEC4 }, () => [0, 0, 0, 0]);
  let count = 0;
  for (let side = 0; side < EDGE_SEA_SIDES; side++) {
    for (let i = 0; i < EDGE_SEA_SAMPLES; i++) {
      if (scene.ground(...sampleColumn(side, i, sx, sz), P) > level) continue;
      const bit = side * EDGE_SEA_SAMPLES + i, w = bit >>> 5;
      words[w >>> 2][w & 3] = (words[w >>> 2][w & 3] | (1 << (bit & 31))) >>> 0;
      count++;
    }
  }
  return count ? { words, count } : null;
}

/**
 * edgeSeaMask's mask with the sea's level, as boxEdgeSea gives a box's: a
 * scene's sea is its P.sea.
 */
export function sceneEdgeSea(scene, P) {
  const m = edgeSeaMask(scene, P);
  return m && { ...m, sea: P.sea };
}

/**
 * The sky pass's sea (gfx/overlays.js drawSky, SkyParams), in the cells of the
 * grid that draws it, or null: s is a mask with its level ({ words, sea }:
 * sceneEdgeSea, boxEdgeSea) of a map size [x, y, z] cells, the grid's origin
 * o in it ({ x, y, z }: a World's window; a box's is 0, its grid the map).
 */
export function edgeSeaParams(s, size, o) {
  if (!s) return null;
  return { foot: [-o.x, -o.z, size[0] - o.x, size[2] - o.z], seaY: s.sea - o.y, mask: s.words };
}

/**
 * The JS twin of the sky shader's edgeSea lookup (gfx/overlays.js). It gives
 * the mask bit of the edge point nearest grid point h = [x, z], which lies
 * outside the footprint foot = [x0, z0, x1, z1].
 */
export function edgeSeaIndex(foot, h) {
  const [x0, z0, x1, z1] = foot;
  const ox = Math.max(x0 - h[0], h[0] - x1), oz = Math.max(z0 - h[1], h[1] - z1);
  let side, u;
  if (oz >= ox) { side = h[1] < z0 ? 0 : 2; u = (h[0] - x0) / (x1 - x0); }
  else { side = h[0] < x0 ? 3 : 1; u = (h[1] - z0) / (z1 - z0); }
  return side * EDGE_SEA_SAMPLES + Math.min(Math.floor(Math.min(Math.max(u, 0), 1) * EDGE_SEA_SAMPLES), EDGE_SEA_SAMPLES - 1);
}

// What a box's sea is made of: the water the sky's sea looks like (seaColor
// takes water's look), fresh or salt. And what stands as ground: solid,
// powder or liquid, not air or gas (a scene's ground twin, above).
const SEA_WATER = new Set([E.WATER, E.SALTWATER]);
const GROUND_KINDS = new Set([K.SOLID, K.POWDER, K.LIQUID]);

/**
 * The stretches of a box's edge that its water reaches, as edgeSeaMask's
 * mask, and that water's surface, or null where none does. idAt(x, y, z) is
 * the element id of a cell of the box [nx, ny, nz], as it was built or loaded
 * (app.js: a map's preset, a save, the Clear). The sea's level is the top of
 * the water the edge columns hold topmost: the commonest top where they
 * differ, the highest of equals. Then, as on a big map, an edge column whose
 * ground is no higher than that is sea: a wet beach, or lower water such as a
 * river, is drawn on at the sea's level. Water that drains, or ground dug at
 * the edge later, leaves the mask as it was at the load.
 * @param {(x: number, y: number, z: number) => number} idAt
 * @param {number[]} size
 */
export function boxEdgeSea(idAt, size) {
  const [nx, ny, nz] = size;
  // column (x, z)'s top: the cell over its topmost ground, and what that is
  const tops = new Map();
  const top = (x, z) => {
    const key = z * nx + x;
    let t = tops.get(key);
    if (!t) {
      t = { y: 0, id: E.EMPTY };
      for (let y = ny - 1; y >= 0; y--) {
        const id = idAt(x, y, z);
        if (GROUND_KINDS.has(ELEMENTS[id]?.kind)) { t = { y: y + 1, id }; break; }
      }
      tops.set(key, t);
    }
    return t;
  };
  // each edge column once: the water tops, counted
  const votes = new Map();
  const vote = (x, z) => { const t = top(x, z); if (SEA_WATER.has(t.id)) votes.set(t.y, (votes.get(t.y) ?? 0) + 1); };
  for (let x = 0; x < nx; x++) { vote(x, 0); vote(x, nz - 1); }
  for (let z = 1; z < nz - 1; z++) { vote(0, z); vote(nx - 1, z); }
  let sea = 0, most = 0;
  for (const [y, n] of votes) if (n > most || (n === most && y > sea)) { sea = y; most = n; }
  if (!most) return null;
  const m = edgeSeaMask({ ground: (x, z) => top(Math.floor(x), Math.floor(z)).y }, { size, sea });
  return m && { ...m, sea };
}
