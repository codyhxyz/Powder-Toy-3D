// The bench's 16×16 pattern tiles, made procedurally at load (v2's are
// hand-made pixel art, an art-pass deliverable: docs/v2.md 3.3, 3.9). What
// matters here is their shape in memory and in the shader: one rgba8unorm
// texture_2d_array with mips, R luminance, G pseudo-bump, B sparkle mask,
// A emissive mask. Minecraft's density: 16 texels a block face.

export const TILE = 16;

// a stable hash of integers to [0, 1)
function hash(...v) {
  let h = 2166136261;
  for (const x of v) { h ^= x & 0xffff; h = Math.imul(h, 16777619); h ^= x >>> 16; h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
// value noise on a wrapping grid of `cells` per tile
function noise(x, y, cells, seed) {
  const s = TILE / cells, fx = x / s, fy = y / s;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const v = (i, j) => hash(((x0 + i) % cells + cells) % cells, ((y0 + j) % cells + cells) % cells, seed);
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  return (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy;
}

// texel (x, y) of each pattern: [luminance, bump, sparkle, emissive], each 0..1
const MAKERS = {
  grain: (x, y) => { const r = hash(x, y, 1); return [0.35 + 0.35 * r, 0.5 + 0.4 * (r - 0.5), hash(x, y, 2) > 0.93 ? 1 : 0, 1]; },
  rock: (x, y) => {
    const n = 0.6 * noise(x, y, 4, 3) + 0.4 * noise(x, y, 8, 4);
    const crack = Math.abs(noise(x, y, 4, 5) - 0.5) < 0.04 ? 0.25 : 1;
    return [(0.3 + 0.45 * n) * crack, n, 0, 1];
  },
  planks: (x, y) => {
    const seam = y % 4 === 0 ? 0.55 : 1, board = Math.floor(y / 4), grain = noise(x * 0.25 + board * 3, y, 8, 6);
    const end = (x + board * 5) % 16 === 0 ? 0.6 : 1;
    return [(0.45 + 0.25 * grain) * seam * end, 0.5 + 0.3 * (grain - 0.5), 0, 1];
  },
  plate: (x, y) => {
    const edge = x === 0 || y === 0 ? 1.15 : x === 15 || y === 15 ? 0.7 : 1;
    const rivet = (x === 2 || x === 13) && (y === 2 || y === 13) ? 1.3 : 1;
    return [0.55 * edge * rivet + 0.05 * hash(x, y, 7), 0.5, hash(x, y, 8) > 0.9 ? 0.6 : 0, 1];
  },
  snow: (x, y) => [0.82 + 0.12 * noise(x, y, 8, 9), 0.5, hash(x, y, 10) > 0.88 ? 1 : 0, 1],
  crust: (x, y) => {
    const n = noise(x, y, 4, 11), crack = Math.abs(n - 0.5) < 0.09;
    return crack ? [0.9, 0.3, 0, 1] : [0.18 + 0.15 * noise(x, y, 8, 12), 0.7, 0, 0.05];
  },
  leaves: (x, y) => { const n = noise(x, y, 8, 13); return [n > 0.62 ? 0.15 : 0.35 + 0.4 * n, n, 0, 1]; },
  brick: (x, y) => {
    const row = Math.floor(y / 4), mortar = y % 4 === 3 || (x + (row & 1) * 4) % 8 === 7;
    return mortar ? [0.75, 0.3, 0, 1] : [0.4 + 0.2 * hash(Math.floor((x + (row & 1) * 4) / 8), row, 14) + 0.08 * hash(x, y, 15), 0.6, 0, 1];
  },
  smooth: () => [0.6, 0.5, 0, 1],
  grass: (x, y) => { const n = noise(x, y, 8, 16); return [0.35 + 0.35 * n * hash(x, y, 17), n, 0, 1]; },
};

/**
 * Builds the tiles named by the bake's `patterns` list into RGBA8 mip chains.
 * @returns {{ layers: number, levels: Uint8Array[][] }} levels[mip][layer], each size² × 4 bytes
 */
export function makePatterns(names) {
  const mips = Math.log2(TILE) + 1;
  const levels = Array.from({ length: mips }, () => []);
  for (const name of names) {
    const make = MAKERS[name] ?? MAKERS.smooth;
    let size = TILE, img = new Uint8Array(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const t = make(x, y);
        for (let c = 0; c < 4; c++) img[(y * TILE + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, t[c])) * 255);
      }
    levels[0].push(img);
    // box-filtered mips: patterns resolve to their average tone with distance (docs/v2.md 3.3)
    for (let m = 1; m < mips; m++) {
      const s = size >> 1, next = new Uint8Array(s * s * 4);
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++)
          for (let c = 0; c < 4; c++) {
            const p = (yy, xx) => img[(yy * size + xx) * 4 + c];
            next[(y * s + x) * 4 + c] = (p(2 * y, 2 * x) + p(2 * y, 2 * x + 1) + p(2 * y + 1, 2 * x) + p(2 * y + 1, 2 * x + 1) + 2) >> 2;
          }
      levels[m].push(next);
      img = next; size = s;
    }
  }
  return { layers: names.length, levels };
}
