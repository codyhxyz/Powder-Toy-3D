// The v2 save section owns the compact engine, not the legacy projection.
// Version 1 fixes the brick4 slot/activity layouts as well as the cell words.
// Arrays are little-endian raw u32 words; no float conversion may touch them.
import { gridDims } from '../shaders/common.js';
import { v2ActLayout, ARGS2 } from '../shaders/v2.js';

export const V2_STATE_VERSION = 1;
const MAGIC = 0x32545054; // TPT2
const PREFIX = 12;
const MAX_META = 4096;

const fail = (message) => { throw new Error(`v2 state: ${message}`); };
export function stateLengths(dims, hasAux = false) {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some(n => !Number.isSafeInteger(n) || n <= 0 || n > 4096)) fail('invalid dimensions');
  const g = gridDims({ nx: dims[0], ny: dims[1], nz: dims[2] });
  if (!Number.isSafeInteger(g.slots) || g.slots > 2 ** 28) fail('grid too large');
  return { cells: g.slots * 4, activity: v2ActLayout(g).words, args: ARGS2.words, ...(hasAux ? { aux: g.slots } : {}) };
}

function validateMeta(meta, dims) {
  if (!meta || meta.version !== V2_STATE_VERSION) fail('unsupported version');
  if (meta.hasAux !== undefined && typeof meta.hasAux !== 'boolean') fail('invalid aux descriptor');
  const lengths = stateLengths(meta.dims, meta.hasAux);
  if (dims && (dims.length !== 3 || dims.some((n, i) => n !== meta.dims[i]))) fail('dimensions do not match save');
  for (const key of ['tick', 'frame', 'paints']) if (!Number.isSafeInteger(meta[key]) || meta[key] < 0) fail(`invalid ${key}`);
  if (!Number.isFinite(meta.acc) || meta.acc < 0 || meta.acc >= 1) fail('invalid accumulator');
  if (typeof meta.certified !== 'boolean' || typeof meta.writtenSinceTick !== 'boolean') fail('invalid activity state');
  if (meta.mode !== 'v1' && meta.mode !== 'v2') fail('invalid mode');
  return lengths;
}

export function encodeV2State(state) {
  const { cells, activity, args, aux, ...meta } = state;
  meta.hasAux = aux !== undefined;
  meta.version = V2_STATE_VERSION;
  const lengths = validateMeta(meta);
  const arrays = { cells, activity, args, aux };
  for (const [key, length] of Object.entries(lengths)) if (!(arrays[key] instanceof Uint32Array) || arrays[key].length !== length) fail(`invalid ${key} length/type`);
  const json = new TextEncoder().encode(JSON.stringify(meta));
  if (json.length > MAX_META) fail('metadata too large');
  const out = new Uint8Array(PREFIX + json.length + Object.values(lengths).reduce((n, x) => n + x * 4, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, V2_STATE_VERSION, true);
  view.setUint32(8, json.length, true);
  out.set(json, PREFIX);
  let at = PREFIX + json.length;
  for (const key of Object.keys(lengths)) for (const word of arrays[key]) { view.setUint32(at, word, true); at += 4; }
  return out;
}

export function decodeV2State(bytes, dims) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PREFIX) fail('truncated or invalid payload');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) fail('invalid magic');
  if (view.getUint32(4, true) !== V2_STATE_VERSION) fail('unsupported version');
  const n = view.getUint32(8, true);
  if (n > MAX_META || n > bytes.length - PREFIX) fail('invalid metadata length');
  let meta;
  try { meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREFIX, PREFIX + n))); }
  catch { fail('malformed metadata'); }
  const lengths = validateMeta(meta, dims);
  const size = PREFIX + n + Object.values(lengths).reduce((sum, x) => sum + x * 4, 0);
  if (size !== bytes.length) fail('invalid payload length');
  let at = PREFIX + n;
  const state = { ...meta };
  for (const [key, length] of Object.entries(lengths)) {
    const out = state[key] = new Uint32Array(length);
    for (let i = 0; i < length; i++, at += 4) out[i] = view.getUint32(at, true);
  }
  // Before the auxiliary owner existed, its state was the all-zero initial state.
  state.aux ??= new Uint32Array(lengths.cells / 4);
  return state;
}
