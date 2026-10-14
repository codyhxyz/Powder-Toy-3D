import { validateMaterialCore } from '../v2/materialValidation.js';
import { BrickStore } from './store.js';

export const NATIVE_BRICK_BYTES = 64 * 20;
export function encodeNativeBrick(core, bank, brick = 0) {
  for (let i = brick * 256; i < (brick + 1) * 256; i += 4) validateMaterialCore(core.subarray(i, i + 4));
  const out = new Uint8Array(NATIVE_BRICK_BYTES);
  out.set(new Uint8Array(core.buffer, core.byteOffset + brick * 1024, 1024));
  out.set(new Uint8Array(bank.buffer, bank.byteOffset + brick * 256, 256), 1024);
  return out;
}
export function decodeNativeBrick(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== NATIVE_BRICK_BYTES) throw new Error('native brick: invalid length');
  const copy = bytes.slice();
  const core = new Uint32Array(copy.buffer, 0, 256);
  for (let i = 0; i < core.length; i += 4) validateMaterialCore(core.subarray(i, i + 4));
  return { core, bank: new Int32Array(copy.buffer, 1024, 64) };
}
// Separate tagged save section: never feed native bits to the legacy PackBits
// decoder. Validate the complete store before mutating either the world or map.
export class NativeBrickStore extends BrickStore {
  put(key, bytes) {
    const max = this.bricks.reduce((a, b) => a * b, 1);
    if (!Number.isSafeInteger(key) || key < 0 || key >= max || !(bytes instanceof Uint8Array) || bytes.length !== NATIVE_BRICK_BYTES) throw new Error('Invalid native world brick');
    decodeNativeBrick(bytes);
    super.put(key, bytes);
  }
  fromBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 4) throw new Error('Invalid native world store');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), n = view.getUint32(0, true);
    if (bytes.length !== 4 + n * (8 + NATIVE_BRICK_BYTES)) throw new Error('Invalid native world store length');
    const next = new NativeBrickStore(this.bricks);
    for (let i = 0, at = 4; i < n; i++, at += 8 + NATIVE_BRICK_BYTES) {
      const key = view.getUint32(at, true), len = view.getUint32(at + 4, true);
      if (next.has(key) || len !== NATIVE_BRICK_BYTES) throw new Error('Invalid native world store entry');
      next.put(key, bytes.slice(at + 8, at + 8 + len));
    }
    this.map = next.map; this.bytes = next.bytes;
  }
}
export function validateNativeWorldStore(bytes, world) {
  if (bytes === undefined) return;
  if (!Array.isArray(world?.size) || world.size.length !== 3 || world.size.some(n => !Number.isSafeInteger(n) || n <= 0 || n % 4)) throw new Error('Native store requires a world');
  new NativeBrickStore(world.size.map(n => n / 4)).fromBytes(bytes);
}
