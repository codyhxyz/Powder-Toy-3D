import { BrickStore } from './store.js';
import { NativeBrickStore } from './nativeStore.js';

// Pure save preflight. Decode every retained container into temporary owners;
// no live world, origin, epoch or GPU state changes until all have succeeded.
export function decodeWorldState(world, dims, storeBytes, planted, nativeBytes) {
  const size = world?.size, origin = world?.origin;
  if (!Array.isArray(size) || size.length !== 3 || size.some(n => !Number.isSafeInteger(n) || n <= 0 || n % 4) ||
      !Array.isArray(origin) || origin.length !== 3 || origin.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n + dims[i] > size[i] || (i === 1 ? n !== 0 : n % 16 !== 0)) || size[1] !== dims[1]) {
    throw new Error('Invalid native/legacy world dimensions or origin');
  }
  // Window origins use WorldWindow's16-cell streaming step; the store itself
  // uses4-cell bricks. Persisted planted columns are boolean byte flags.
  const bricks = size.map(n => n / 4);
  if (!(planted instanceof Uint8Array) || planted.length !== bricks[0] * bricks[2] || planted.some(n => n > 1)) throw new Error('Invalid world planted columns');
  const store = new BrickStore(bricks), nativeStore = new NativeBrickStore(bricks);
  store.fromBytes(storeBytes);
  if (nativeBytes !== undefined && nativeBytes !== null) nativeStore.fromBytes(nativeBytes);
  return { store, nativeStore, planted: planted.slice(), origin: [...origin] };
}

export function validateDecorationState(sections, header) {
  const plane = sections.get('deco'), bytes = sections.get('decoStore');
  for (const key of ['deco', 'decoStore']) if (header.sections?.some(s => s.key === key) && !sections.has(key)) throw new Error(`Missing or unsupported ${key} section`);
  if (plane !== undefined && (!(plane instanceof Uint8Array) || plane.length !== header.dims.reduce((a, n) => a * n, 4))) throw new Error('Invalid decoration plane');
  if (bytes === undefined) return;
  const size = header.world?.size;
  if (!size || !(bytes instanceof Uint8Array) || bytes.length % 260) throw new Error('Invalid decoration world store');
  const max = size.reduce((a, n) => a * (n / 4), 1), keys = new Set();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; at += 260) {
    const key = view.getUint32(at, true);
    if (key >= max || keys.has(key)) throw new Error('Invalid decoration world brick');
    keys.add(key);
  }
}
