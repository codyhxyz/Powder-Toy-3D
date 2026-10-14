// The v2 save section owns the compact engine, not the legacy projection.
// Version 2 replaces prototype limiter/half-life packing with persistent payloads.
// Arrays are little-endian raw u32 words; no float conversion may touch them.
import { validatePhaseCore } from './phase.js';
import { ELEMENTS } from '../elements.js';
import { MATERIAL_VERSION, FULL, MAX_FILL, FUEL_Q, isLiquid, isConductor } from './layout.js';
import { gridDims } from '../shaders/common.js';
import { v2ActLayout, ARGS2 } from '../shaders/v2.js';

export const V2_STATE_VERSION = MATERIAL_VERSION;
const MAGIC = 0x32545054; // TPT2
const PREFIX = 12;
const MAX_META = 4096;

const fail = (message) => { throw new Error(`v2 state: ${message}`); };
export function stateLengths(dims, hasAux = false, version = V2_STATE_VERSION) {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some(n => !Number.isSafeInteger(n) || n <= 0 || n > 4096)) fail('invalid dimensions');
  const g = gridDims({ nx: dims[0], ny: dims[1], nz: dims[2] });
  if (!Number.isSafeInteger(g.slots) || g.slots > 2 ** 28) fail('grid too large');
  return { cells: g.slots * 4, activity: v2ActLayout(g).words - (version === 1 ? g.nbricks : 0), args: ARGS2.words, ...(hasAux ? { aux: g.slots } : {}) };
}

function validateMeta(meta, dims, version = V2_STATE_VERSION) {
  if (!meta || meta.version !== version) fail('unsupported version');
  if (meta.hasAux !== undefined && typeof meta.hasAux !== 'boolean') fail('invalid aux descriptor');
  const lengths = stateLengths(meta.dims, meta.hasAux, version);
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
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== V2_STATE_VERSION) fail('unsupported version');
  const n = view.getUint32(8, true);
  if (n > MAX_META || n > bytes.length - PREFIX) fail('invalid metadata length');
  let meta;
  try { meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREFIX, PREFIX + n))); }
  catch { fail('malformed metadata'); }
  const lengths = validateMeta(meta, dims, version);
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
  if (version === 1) migratePrototype(state);
  for (let i = 0; i < state.cells.length; i += 4) {
    try { validatePhaseCore(state.cells.subarray(i, i + 4)); }
    catch (error) { fail(error.message); }
  }
  return state;
}

function halfFloat(bits) {
  const sign = bits & 32768 ? -1 : 1, exp = (bits >>> 10) & 31, mantissa = bits & 1023;
  return sign * (exp === 0 ? mantissa * 2 ** -24 : exp === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exp - 15));
}
// Prototype aux had no defined energy unit. Do not silently reinterpret opaque banks.
function migratePrototype(state) {
  if (state.aux.some(x => x !== 0)) fail('version 1 has opaque auxiliary energy; explicit legacy projection required');
  for (let s = 0; s < state.cells.length; s += 4) {
    const c = state.cells, id = c[s] & 255, element = ELEMENTS[id];
    if (!element) fail('invalid prototype element');
    if (((c[s] >>> 8) & 65535) > 41093) fail('prototype temperature exceeds supported 10000 C; explicit conversion required');
    if (isLiquid(id)) {
      const fill = c[s + 1] & 0xffffff;
      if (fill > MAX_FILL) fail('prototype fill exceeds native compression limit');
      // Old upper word3 and age are limiter/remainder, never fuel/foam.
      c[s] &= 0xffffff;
      const payload = isConductor(id) ? (c[s + 1] >>> 24) : Math.round((element.life ?? 0) * FUEL_Q * fill / FULL);
      if (payload > 65535) fail('prototype liquid life overflow');
      c[s + 3] = (c[s + 3] & 65535) | (payload << 16);
      if (isConductor(id)) c[s + 1] &= 0xffffff;
    } else {
      const life = halfFloat(c[s + 1] & 65535);
      if (!Number.isFinite(life) || life < 0 || life * FUEL_Q > 65535) fail('invalid prototype life');
      if (isConductor(id)) {
        c[s + 3] = (c[s + 3] & 0xffff0000) | ((c[s + 1] >>> 16) & 255);
        c[s + 1] &= 0xff00ffff;
      }
      c[s + 1] = (c[s + 1] & 0xffff0000) | Math.round(life * FUEL_Q);
    }
  }
  state.version = V2_STATE_VERSION;
  state.migratedFrom = 1;
  // Changed physics packing is not an exact continuation of prototype dynamics.
  state.certified = false; state.writtenSinceTick = true;
  const g = gridDims({ nx: state.dims[0], ny: state.dims[1], nz: state.dims[2] }), a = v2ActLayout(g);
  const activity = new Uint32Array(a.words); activity.set(state.activity); state.activity = activity;
  state.activity.fill(1, a.state, a.state + g.nbricks);
  state.activity.fill(1, a.busy0, a.busy0 + g.nbricks);
  state.activity.fill(1, a.busy1, a.busy1 + g.nbricks);
}
