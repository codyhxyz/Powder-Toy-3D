import { decodeV2State } from './state.js';
import { gridDims } from '../shaders/common.js';
import { validateDynamicState } from './dynamics.js';
import { PARTICLE_CAP, AIR } from './dynamics-reference.js';
import { RAY_REQUEST_CAP } from '../shaders/v2/blasts.js';

const MAGIC = 0x44545054, VERSION = 1, PREFIX = 16, MAX_META = 64 * 1024 * 1024;
const fail = message => { throw new Error(`native dynamics state: ${message}`); };
function grid(dims) {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some(n => !Number.isSafeInteger(n) || n <= 0 || n > 4096)) fail('invalid dimensions');
  const g = gridDims({ nx: dims[0], ny: dims[1], nz: dims[2] });
  if (g.slots > 2 ** 28) fail('grid too large');
  return g;
}
export function validateDynamicSnapshot(snapshot, { dims = snapshot?.dims, origin } = {}) {
  const g = grid(dims);
  validateDynamicState(snapshot, g);
  if (origin && (!Array.isArray(origin) || origin.length !== 3 || origin.some((v, i) => v !== snapshot.origin[i]))) fail('origin does not match core world window');
  return snapshot;
}

// Metadata retains every owner extension; nested Uint32Arrays (including archived
// air and future controller membership) are raw LE words, never JSON float data.
export function encodeDynamicState(snapshot) {
  validateDynamicSnapshot(snapshot);
  const arrays = [];
  function pack(value, depth = 0) {
    if (depth > 64) fail('metadata nesting');
    if (value instanceof Uint32Array) { const i = arrays.push(value) - 1; return { $nativeWords: i }; }
    if (Array.isArray(value)) return value.map(v => pack(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pack(v, depth + 1)]));
    return value;
  }
  const json = new TextEncoder().encode(JSON.stringify({ state: pack(snapshot), lengths: arrays.map(a => a.length) }));
  if (json.length > MAX_META) fail('metadata too large');
  const at = Math.ceil((PREFIX + json.length) / 4) * 4;
  const out = new Uint8Array(at + arrays.reduce((n, a) => n + a.byteLength, 0)), view = new DataView(out.buffer);
  [MAGIC, VERSION, json.length, arrays.length].forEach((v, i) => view.setUint32(i * 4, v, true));
  out.set(json, PREFIX);
  let pos = at;
  for (const a of arrays) for (const word of a) { view.setUint32(pos, word, true); pos += 4; }
  return out;
}
export function decodeDynamicState(bytes, expected = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < PREFIX) fail('invalid section');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) fail('unsupported version');
  const len = view.getUint32(8, true), count = view.getUint32(12, true), at = Math.ceil((PREFIX + len) / 4) * 4;
  if (len > MAX_META || at > bytes.length) fail('truncated metadata');
  let meta;
  try { meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREFIX, PREFIX + len))); }
  catch { fail('malformed metadata'); }
  if (!Array.isArray(meta.lengths) || meta.lengths.length !== count || meta.lengths.some(n => !Number.isSafeInteger(n) || n < 0)) fail('invalid word descriptors');
  if (at + meta.lengths.reduce((n, x) => n + x * 4, 0) !== bytes.length) fail('invalid section length');
  let pos = at;
  const arrays = meta.lengths.map(n => { const a = new Uint32Array(n); for (let i = 0; i < n; i++, pos += 4) a[i] = view.getUint32(pos, true); return a; });
  function unpack(value, depth = 0) {
    if (depth > 64) fail('metadata nesting');
    if (Array.isArray(value)) return value.map(v => unpack(v, depth + 1));
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value, '$nativeWords')) {
        const i = value.$nativeWords;
        if (Object.keys(value).length !== 1 || !Number.isInteger(i) || i < 0 || i >= arrays.length) fail('invalid word reference');
        return arrays[i];
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v, depth + 1)]));
    }
    return value;
  }
  return validateDynamicSnapshot(unpack(meta.state), expected);
}

// No await before BOTH owners enqueue their GPU copies. Used by save sections
// and available to parent driver hooks without changing PhysicsV2's core codec.
export function captureNativeSnapshot(owner, mode) {
  if (owner.sim?.nativeTransition || owner.sim?.nativeTransitionError) throw new Error('Native transition prevents a consistent snapshot');
  const core = owner.captureState(mode);
  const dynamic = owner.dynamics?.snapshotDynamicState();
  return Promise.all([core, dynamic]).then(([core, dynamic]) => ({ core, dynamic }));
}
export function emptyDynamicState(dims, origin = [0, 0, 0]) {
  const g = grid(dims), air = new Uint32Array(g.nbricks * 8), floats = new Float32Array(air.buffer);
  for (let b = 0; b < g.nbricks; b++) floats[b * 8 + 6] = AIR.quietTicks;
  return { version: 1, dims: [...dims], origin: [...origin], sequence: 0, blastBatch: 8, isIdle: true,
    particles: new Uint32Array(PARTICLE_CAP * 12), air, control: new Uint32Array(32), held: new Uint32Array(PARTICLE_CAP),
    shocks: new Uint32Array(g.nbricks), rayRemaining: new Uint32Array(RAY_REQUEST_CAP), requests: [], pendingEvents: [], airArchive: [] };
}

// Preflight BOTH owners before either mutates; callers have already selected
// the engine and positioned the world. Never accept a different origin here.
export function restoreNativeSnapshot(owner, snapshot) {
  const sim = owner.sim, dims = [sim.g.nx, sim.g.ny, sim.g.nz];
  decodeV2State(snapshot.core, dims);
  if (snapshot.dynamic) {
    validateDynamicSnapshot(snapshot.dynamic, { dims, origin: [sim.origin.x, sim.origin.y, sim.origin.z] });
    if (!owner.dynamics?.isReady) fail('restore owner unavailable');
  }
  owner.restoreState(snapshot.core);
  if (snapshot.dynamic) owner.dynamics.restoreDynamicState(snapshot.dynamic);
  sim.version++; owner.seenVersion = sim.version;
  sim.wake();
}

export function resetNativeDynamics(owner) {
  const d = owner?.dynamics, sim = owner?.sim;
  if (!d) return;
  if (sim.nativeTransitionKind === 'shift') throw new Error('Cannot replace a world during its native shift');
  const token = owner.dynamicResetToken = {};
  const snapshot = emptyDynamicState([sim.g.nx, sim.g.ny, sim.g.nz], [sim.origin.x, sim.origin.y, sim.origin.z]);
  const apply = () => {
    if (!owner.disposed && sim.compactOwner === owner && owner.dynamicResetToken === token) d.restoreDynamicState(snapshot);
  };
  if (d.isReady) { apply(); return; }
  const pending = d.ready.then(apply).catch(error => { sim.nativeTransitionError = error; throw error; }).finally(() => {
    if (sim.nativeTransition === pending) sim.nativeTransition = null;
    sim.wake();
  });
  sim.nativeTransition = pending;
  pending.catch(() => {});
  return pending;
}
