import { deswizzle, columnTops } from './deswizzle.js';

// The world model's de-swizzle off the main thread (ai/world.js). It keeps the
// last capture's cells to tell what changed, and answers each capture with its
// bytes (back to the readback's ring) and the cells copied into `out` (the
// main thread's spare buffer: the cells it queries stay untouched until this
// arrives). Message: { rows?, stands?, dims, bytes, out } (rows and stands when
// the grid changed), answer: { bytes, out, dims, diff, tops } (deswizzle.js:
// diff's bits say what changed; tops, each column's stand height, only when
// something did, else null: the last ones still hold). idChanges marks bricks
// whose material IDs changed; world.js keeps their revisions across captures.

let rows = null, stands = null, cells = null;

self.onmessage = ({ data: m }) => {
  if (m.rows) rows = m.rows;
  if (m.stands) stands = m.stands;
  const n = (m.dims[0] * m.dims[1] * m.dims[2]) / 2;
  const fresh = !!m.rows || cells?.length !== n;   // a new grid: everything changed
  if (fresh) cells = new Uint32Array(n);
  const idChanges = new Uint8Array(rows.table.length);
  const diff = deswizzle(new Uint32Array(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength >> 2), rows, m.dims, cells, idChanges);
  m.out.set(cells);
  let tops = null;
  if (fresh || diff) {
    const cols = m.dims[0] * m.dims[2];
    tops = columnTops(new Uint16Array(cells.buffer), m.dims, stands, new Uint16Array(cols));
  }
  const transfer = [m.bytes.buffer, m.out.buffer, idChanges.buffer];
  if (tops) transfer.push(tops.buffer);
  self.postMessage({ bytes: m.bytes, out: m.out, dims: m.dims, diff: fresh ? ~0 : diff, tops, idChanges }, transfer);
};
