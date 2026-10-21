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
//   edgeSeaIndex(foot, h)              // the JS twin of the sky shader's lookup

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
