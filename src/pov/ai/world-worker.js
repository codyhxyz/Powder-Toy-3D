import { deswizzle } from './deswizzle.js';

// The world model's de-swizzle off the main thread (ai/world.js). It keeps the
// last capture's cells to tell what changed, and answers each capture with its
// bytes (back to the readback's ring) and the cells copied into `out` (the
// main thread's spare buffer: the cells it queries stay untouched until this
// arrives). Message: { rows?, dims, bytes, out } (rows when the grid changed),
// answer: { bytes, out, dims, diff } (deswizzle.js: diff's bits say what changed).

let rows = null, cells = null;

self.onmessage = ({ data: m }) => {
  if (m.rows) rows = m.rows;
  const n = (m.dims[0] * m.dims[1] * m.dims[2]) / 2;
  const fresh = !!m.rows || cells?.length !== n;   // a new grid: everything changed
  if (fresh) cells = new Uint32Array(n);
  const diff = deswizzle(new Uint32Array(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength >> 2), rows, m.dims, cells);
  m.out.set(cells);
  self.postMessage({ bytes: m.bytes, out: m.out, dims: m.dims, diff: fresh ? ~0 : diff }, [m.bytes.buffer, m.out.buffer]);
};
