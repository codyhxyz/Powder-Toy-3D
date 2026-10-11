// The world model's de-swizzle (ai/world.js), on the main thread or in its
// worker (world-worker.js): a capture of the packed state (net/codec.js
// packFrag: per texel the element id, the temperature code, then two bytes the
// model doesn't read, in the state's brick-major atlas layout, sim.js
// cellTexel) into the model's cells, row-major (y, z, x), two cells per 32-bit
// word: a cell is 16 bits, id | temperature code << 8. Little-endian (every
// platform WebGL2 runs on), so a Uint16Array over the same buffer reads cell i
// at [i] and a texel's low 16 bits are its id and temperature code.
//
// It runs a brick row at a time: the 4 cells of a brick that share y and z are
// 4 consecutive texels (shaders/common.js: x is the tile's fastest axis), so a
// row is 2 words read, compared and written, unrolled (a loop over the row is
// ~50% slower in V8). On Dam Valley's 256×96×128 grid it takes ~5 ms (a
// 2.8 GHz Xeon in node); the per-brick loop it replaced took ~20 ms.

export const ID_BITS = 0x00ff00ff;      // a word's two ids
export const TEMP_BITS = 0xff00ff00 | 0;   // its two temperature codes
const BRICK = 4;                        // shaders/common.js BRICK, which this loop is unrolled for

// src: Uint32Array, one word per texel. rows: atlasRows() (world.js), the
// atlas's brick table for these dims. cells: Uint32Array(nx·ny·nz / 2), the
// last capture's cells, overwritten with this one's. → the OR of every word's
// change (old ^ new): 0 when nothing changed; & ID_BITS: some id changed.
export function deswizzle(src, rows, [nx, ny, nz], cells) {
  const { brick, table, rowOff } = rows;
  if (brick !== BRICK) throw new Error(`deswizzle is unrolled for ${BRICK}-cell bricks, not ${brick}`);
  const bx = nx >> 2, bz = nz >> 2;
  let diff = 0, o = 0;
  for (let y = 0; y < ny; y++) {
    const layer = (y >> 2) * bz, ly = (y & 3) << 2;
    for (let z = 0; z < nz; z++) {
      const off = rowOff[ly | (z & 3)], first = (layer + (z >> 2)) * bx;
      for (let b = 0; b < bx; b++, o += 2) {
        const t = table[first + b] + off;
        const w0 = (src[t] & 0xffff) | (src[t + 1] << 16), w1 = (src[t + 2] & 0xffff) | (src[t + 3] << 16);
        diff |= (cells[o] ^ w0) | (cells[o + 1] ^ w1);
        cells[o] = w0;
        cells[o + 1] = w1;
      }
    }
  }
  return diff;
}

// Each column's stand height (world.js standAt with no y): 1 + the highest cell
// of the column that a body stands on (`stands[id]`: not air, not a gas), or 0
// when there's none. cells: Uint16Array over deswizzle's output (cell i at [i]).
// tops: Uint16Array(nx·nz), column z·nx + x. Done once per capture that changed
// something, in the worker: ~4 ms on a world-shaped Dam Valley in node, where
// nav's walk scanned the same columns through standAt's id() calls on the main
// thread (~6.6 ms) every time it rebuilt.
export function columnTops(cells, [nx, ny, nz], stands, tops) {
  const n = nx * nz;
  for (let c = 0; c < n; c++) {
    let top = 0;
    for (let i = (ny - 1) * n + c, y = ny; y > 0; y--, i -= n) if (stands[cells[i] & 0xff]) { top = y; break; }
    tops[c] = top;
  }
  return tops;
}
