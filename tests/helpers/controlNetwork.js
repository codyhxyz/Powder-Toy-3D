import { registerHooks } from 'node:module';

// Replace transport, DOM and GPU boundaries, not the production control,
// interaction, multiplayer or wire implementations under test.
export const state = { sockets: [], buttons: [], writes: [], unpackJobs: [], autoCommit: true, now: 100, frames: 0, keys: [] };
export const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const node = () => ({
  classList: { add() {}, remove() {}, toggle() {} }, listeners: {}, append() {},
  addEventListener(t, f) { this.listeners[t] = f; }, setAttribute() {}, replaceChildren() {}, contains() { return false; },
});
export function install() {
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => state.now } });
  globalThis.document = {
    createElement(t) { const n = node(); if (t === 'button') state.buttons.push(n); return n; },
    querySelector: () => null, body: node(), addEventListener() {},
  };
  globalThis.location = { hostname: 'cpu', href: 'http://cpu/', search: '', pathname: '/' };
  globalThis.history = { replaceState() {} };
  globalThis.addEventListener = (type, fn) => { if (type === 'keydown') state.keys.push(fn); };
  globalThis.removeEventListener = () => {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.bufferedAmount = 0; this.messages = []; state.sockets.push(this); }
    send(data) {
      this.messages.push(data);
      if (typeof data !== 'string') state.frames++;
      if (this.peer?.onmessage) {
        const msg = typeof data === 'string' ? JSON.stringify({ ...JSON.parse(data), from: this.id }) : data;
        this.peer.onmessage({ data: msg });
      }
    }
    receive(m) { this.onmessage({ data: JSON.stringify(m) }); }
    close() { this.readyState = 3; }
  };
}
export const h = () => node();
export const createRemoteCursors = () => ({ clear() {}, remove() {}, set() {}, update() {} });
export const createRemotePlayers = () => ({ clear() {}, remove() {}, set() {}, update() {} });
export const createChat = () => ({ say() {}, notice() {}, clear() {}, open() {} });
export const MAX_CHAT_CHARS = 1024;
export const sessionToken = () => null;
export const createFactoryControlParts = ({ isCurrent }) => ({
  activate: async spec => { if (!isCurrent()) return { ok: false }; state.writes.push(spec); return { ok: true }; },
  reset() {}, dispose() {},
});
export const applyGuestStrokes = () => {};
export const PROP_FIELDS = [];
export const propRangeError = () => null;
export const runFill = async () => {};
export const world = { godFocus: () => [64, 96] };
export default world;
export const SMALL_MAP = { streamed: false, guestPlaysOn: true };
export const FRAME_KEY = 0, FRAME_DELTA = 1, FRAME_NATIVE_KEY = 2, FRAME_NATIVE_DELTA = 3, OUTDATED_SEQ = 0xffffffff;
export const KEY_FRAMES = [0, 2], DELTA_FRAMES = [1, 3], TEXEL_BYTES = 4;
export const nativeSection = x => x;
export const sameSection = (a, b) => a === b;
export const outdatedFrame = async () => ({ seq: OUTDATED_SEQ });
export const encodeFrame = async (kind, seq, dims, body, meta) => ({ kind, seq, dims, body: body.slice(), meta });
export const decodeFrame = async frame => frame;
export function xorInto(out, a, b) {
  let changed = false;
  for (let i = 0; i < a.length; i++) { out[i] = a[i] ^ b[i]; changed ||= !!out[i]; }
  return changed;
}
export const createPacker = () => ({
  native: () => false,
  pack(sim, metadata) {
    if (sim.capturePending) return null;
    const captured = { bytes: sim.bytes.slice(), dims: [sim.g.nx, sim.g.ny, sim.g.nz], meta: metadata(), release() {} };
    if (sim.delayCapture) {
      sim.capturePending = true;
      return new Promise(resolve => { sim.releaseCapture = () => { sim.capturePending = false; resolve(captured); }; });
    }
    return Promise.resolve(captured);
  },
});
export const createUnpacker = () => ({
  unpack(sim, bytes, options) {
    const apply = () => { if (options.valid()) { options.commit(); sim.appliedBytes = bytes.slice(); } return true; };
    if (state.autoCommit) return Promise.resolve().then(apply);
    return new Promise(resolve => state.unpackJobs.push(() => resolve(apply())));
  },
});

export async function loadControlWires() {
  const url = p => new URL(p, new URL('../../', import.meta.url)).href;
  const parents = new Set(['src/net/multiplayer.js', 'src/wire/mp.js', 'src/wire/electronics.js'].map(url));
  const mocked = new Set([
    'src/net/codec.js', 'src/net/edits.js', 'src/editing.js', 'src/net/players.js',
    'src/net/cursors.js', 'src/net/chat.js', 'src/account.js', 'src/ui/dom.js',
    'src/mapKind.js', 'src/wire/world.js', 'src/industry/controlParts.js',
  ].map(url));
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      return parents.has(context.parentURL) && mocked.has(result.url)
        ? { url: import.meta.url, shortCircuit: true } : result;
    },
    load(file, context, next) {
      if (file.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      const result = next(file, context);
      if (file !== url('src/net/multiplayer.js')) return result;
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
      return { ...result, source: source.replaceAll('import.meta.env.VITE_RELAY_URL', "'ws://cpu'").replaceAll('import.meta.env.DEV', 'false') };
    },
  });
  try {
    const [electronics, mp] = await Promise.all([import('../../src/wire/electronics.js'), import('../../src/wire/mp.js')]);
    return { electronics: electronics.default, mp: mp.default };
  } finally { hooks.deregister(); }
}
