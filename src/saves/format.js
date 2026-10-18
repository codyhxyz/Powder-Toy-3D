// The save file (.tpt3d): a small JSON header, then compressed binary sections.
//
//   bytes 0..7   SAVE_MAGIC, ASCII
//   u32 LE       the format version (SAVE_VERSION when written)
//   u32 LE       the header's length in bytes
//   header       UTF-8 JSON: version, name, created, map, size, dims, thumbnail,
//                world, and `sections`: [{ key, type, size, raw }] in file order
//   sections     each one's body, deflated (deflate-raw), back to back
//
// The Powder Toy's own saves are the model: a short fixed header ('OPS1',
// version, block size), then a compressed body of named fields (bzip2'd BSON
// keys: parts, pressMap, signs, gravityEnable... src/client/GameSave.cpp). A
// reader skips the fields it doesn't know and defaults the ones a save
// doesn't have, so old saves keep loading as features are added. Here a
// section is one named field, and features add theirs (sections.js).
//
// A section is JSON or a typed array. A typed array keeps its type ('f32',
// 'u8', ...), so it comes back as the same kind of array.
//
// This file is plain (no three.js, no app): the start menu reads headers with
// it before the game loads, and node runs it in tests
// (tools/saves-check.mjs).

export const SAVE_MAGIC = 'TPT3DSAV';
export const SAVE_VERSION = 1;
export const SAVE_EXT = '.tpt3d';
export const SAVE_MIME = 'application/x-tpt3d';
const U32 = 4;
const PRELUDE = SAVE_MAGIC.length + 2 * U32;   // magic, version, header length
// deflate without a zlib wrapper, as the multiplayer stream's frames (net/codec.js COMPRESSION)
const COMPRESSION = 'deflate-raw';

// typed arrays by the tag a section's type holds
const TYPED = {
  u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array,
  u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array,
};
const JSON_TYPE = 'json';
const typeOf = (data) => {
  if (data instanceof ArrayBuffer) return 'u8';
  if (ArrayBuffer.isView(data)) {
    const tag = Object.keys(TYPED).find((k) => data instanceof TYPED[k]);
    if (tag) return tag;
  }
  return JSON_TYPE;
};
const bytesOf = (data) => (data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
export const deflate = (bytes) => pipe(bytes, new CompressionStream(COMPRESSION));
export const inflate = (bytes) => pipe(bytes, new DecompressionStream(COMPRESSION));

// header: everything but `sections` (filled here); sections: [{ key, data }],
// data JSON-able or a typed array. Returns the file's bytes.
export async function encodeSave(header, sections) {
  const bodies = [], list = [];
  for (const { key, data } of sections) {
    if (data === undefined) continue;
    const type = typeOf(data);
    const raw = type === JSON_TYPE ? new TextEncoder().encode(JSON.stringify(data)) : bytesOf(data);
    const body = await deflate(raw);
    bodies.push(body);
    list.push({ key, type, size: body.length, raw: raw.length });
  }
  const head = new TextEncoder().encode(JSON.stringify({ ...header, version: SAVE_VERSION, sections: list }));
  const out = new Uint8Array(PRELUDE + head.length + bodies.reduce((n, b) => n + b.length, 0));
  for (let i = 0; i < SAVE_MAGIC.length; i++) out[i] = SAVE_MAGIC.charCodeAt(i);
  const view = new DataView(out.buffer);
  view.setUint32(SAVE_MAGIC.length, SAVE_VERSION, true);
  view.setUint32(SAVE_MAGIC.length + U32, head.length, true);
  out.set(head, PRELUDE);
  let at = PRELUDE + head.length;
  for (const b of bodies) { out.set(b, at); at += b.length; }
  return out;
}

const asBytes = (buf) => (buf instanceof ArrayBuffer ? new Uint8Array(buf) : ArrayBuffer.isView(buf)
  ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf));

// The header alone (no sections inflated): for lists and file pickers. Throws
// on anything that isn't a save.
export function readSaveHeader(buf) {
  const bytes = asBytes(buf);
  if (bytes.length < PRELUDE || String.fromCharCode(...bytes.subarray(0, SAVE_MAGIC.length)) !== SAVE_MAGIC) {
    throw new Error('not a Powder Toy 3D save');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(SAVE_MAGIC.length, true);
  const length = view.getUint32(SAVE_MAGIC.length + U32, true);
  if (PRELUDE + length > bytes.length) throw new Error('save is cut short');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(PRELUDE, PRELUDE + length)));
  return { ...header, version, bodyAt: PRELUDE + length };
}

// The header and every section: { header, sections: Map(key → data) }. A
// section of a type this build doesn't know is skipped.
export async function decodeSave(buf) {
  const bytes = asBytes(buf);
  const header = readSaveHeader(bytes);
  if (header.version > SAVE_VERSION) throw new Error('this save was made by a newer version of the game');
  if (header.version !== SAVE_VERSION || !Array.isArray(header.sections)) throw new Error('invalid save version or sections');
  const sections = new Map(), keys = new Set();
  let at = header.bodyAt;
  for (const s of header.sections) {
    if (!s || typeof s.key !== 'string' || !s.key || keys.has(s.key) || typeof s.type !== 'string'
        || !Number.isSafeInteger(s.size) || s.size < 0 || !Number.isSafeInteger(s.raw) || s.raw < 0) throw new Error('invalid save section descriptor');
    keys.add(s.key);
    const body = bytes.subarray(at, at + s.size);
    at += s.size;
    if (body.length !== s.size) throw new Error(`save is cut short in section '${s.key}'`);
    if (s.type !== JSON_TYPE && !Object.hasOwn(TYPED, s.type)) continue;
    const raw = await inflate(body);
    if (raw.length !== s.raw) throw new Error(`section '${s.key}' inflates to ${raw.length} bytes, not ${s.raw}`);
    if (s.type === JSON_TYPE) sections.set(s.key, JSON.parse(new TextDecoder().decode(raw)));
    else {
      const T = TYPED[s.type];
      if (raw.length % T.BYTES_PER_ELEMENT) throw new Error(`section '${s.key}' has invalid typed-array length`);
      // (a fresh buffer: a typed array needs its offset aligned to its element size)
      sections.set(s.key, new T(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
    }
  }
  if (at !== bytes.length) throw new Error('save has trailing data');
  return { header, sections };
}

// ---- cells: the state's atlas texels in a fixed order, shuffled into byte planes ----
//
// The GPU keeps cells brick-major in an atlas whose layout belongs to the
// renderer (sim.js gridLayout, cellTexel). A save keeps them in plain grid
// order instead, cell n = x + nx·(z + nz·y): horizontal layers from the
// bottom up, so a later atlas layout still reads old saves.
//
// Each texel is RGBA of some type (state A and B: four floats). The bytes are
// shuffled into planes before deflating, HDF5's shuffle filter: plane
// (source, channel, byte) holds that byte of that channel for every cell. A
// channel that is the same everywhere (air's id, ambient temperature, zero
// velocity) becomes runs of one byte, which deflate all but erases; the
// random per-cell seeds and decaying pressures stay near raw. Bits are copied
// exactly (NaNs and -0 included): a save is lossless.

const CHANNELS = 4;   // RGBA per texel

// sources: typed arrays laid out as the atlas (CHANNELS values per texel);
// texelOf(x, y, z): the texel index of a cell (sim.js cellTexel). Returns the planes.
export function packCells(dims, texelOf, sources) {
  const [nx, ny, nz] = dims, n = nx * ny * nz;
  const texels = cellTexels(dims, texelOf);
  const size = sources.reduce((s, a) => s + CHANNELS * a.BYTES_PER_ELEMENT, 0) * n;
  const out = new Uint8Array(size);
  let plane = 0;
  for (const src of sources) {
    const w = src.BYTES_PER_ELEMENT, b8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength), stride = CHANNELS * w;
    for (let c = 0; c < CHANNELS; c++)
      for (let k = 0; k < w; k++, plane++) {
        const base = plane * n, off = c * w + k;
        for (let i = 0; i < n; i++) out[base + i] = b8[texels[i] * stride + off];
      }
  }
  return out;
}

// packCells back: fills `targets` (typed arrays laid out as the atlas, the
// same types and order as the sources were) from the planes. Texels that
// hold no cell are left as they are.
export function unpackCells(dims, texelOf, planes, targets) {
  const [nx, ny, nz] = dims, n = nx * ny * nz;
  const size = targets.reduce((s, a) => s + CHANNELS * a.BYTES_PER_ELEMENT, 0) * n;
  if (planes.length !== size) throw new Error(`cells: ${planes.length} bytes for a ${dims.join('×')} grid that takes ${size}`);
  const texels = cellTexels(dims, texelOf);
  let plane = 0;
  for (const dst of targets) {
    const w = dst.BYTES_PER_ELEMENT, b8 = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength), stride = CHANNELS * w;
    for (let c = 0; c < CHANNELS; c++)
      for (let k = 0; k < w; k++, plane++) {
        const base = plane * n, off = c * w + k;
        for (let i = 0; i < n; i++) b8[texels[i] * stride + off] = planes[base + i];
      }
  }
}

// every cell's texel, in save order
function cellTexels([nx, ny, nz], texelOf) {
  const t = new Uint32Array(nx * ny * nz);
  let i = 0;
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) t[i++] = texelOf(x, y, z);
  return t;
}
