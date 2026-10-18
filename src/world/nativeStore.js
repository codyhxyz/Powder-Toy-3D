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
const NATIVE_CORE_BYTES = 64 * 16;   // a brick's 64 cores (4 u32 each), then its 64 i32 banks
const NATIVE_BANKS = 64;
/** Any of the brick's energy banks nonzero (an import from the generator leaves every one 0: shaders/v2.js v2import). */
export function nativeBrickBanked(bytes) {
  const banks = bytes.byteOffset % 4 ? new Int32Array(bytes.slice(NATIVE_CORE_BYTES).buffer)
    : new Int32Array(bytes.buffer, bytes.byteOffset + NATIVE_CORE_BYTES, NATIVE_BANKS);
  return banks.some(v => v !== 0);
}
export function decodeNativeBrick(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== NATIVE_BRICK_BYTES) throw new Error('native brick: invalid length');
  const copy = bytes.slice();
  const core = new Uint32Array(copy.buffer, 0, 256);
  for (let i = 0; i < core.length; i += 4) validateMaterialCore(core.subarray(i, i + 4));
  return { core, bank: new Int32Array(copy.buffer, 1024, 64) };
}
// A native store keeps the bricks that leave the window differing from what the
// generator makes there, imported (V1's store rule: shaders/v2/leave.js), plus
// any whose native diff wasn't built yet; V1's projection never decides what
// to retain. Many kept bricks are uniform: 64 identical cells, identical banks. Stored bytes are never written
// after put, so equal uniform payloads share one array (Minecraft's palette
// idea, at brick scale). The count of distinct payloads shared is bounded.
export const UNIFORM_SHARED_MAX = 4096;   // distinct uniform brick payloads kept for sharing
const uniformShared = new Map();
function uniformKey(bytes) {
  if (bytes.byteOffset % 4) return null;
  const w = new Uint32Array(bytes.buffer, bytes.byteOffset, NATIVE_BRICK_BYTES / 4);
  for (let i = 4; i < 256; i++) if (w[i] !== w[i & 3]) return null;
  for (let i = 257; i < 320; i++) if (w[i] !== w[256]) return null;
  return `${w[0]},${w[1]},${w[2]},${w[3]},${w[256]}`;
}
export function shareUniformBrick(bytes) {
  const key = uniformKey(bytes);
  if (key === null) return bytes;
  const shared = uniformShared.get(key);
  if (shared) return shared;
  if (uniformShared.size >= UNIFORM_SHARED_MAX) uniformShared.clear();
  uniformShared.set(key, bytes);
  return bytes;
}
// Separate tagged save section: never feed native bits to the legacy PackBits
// decoder. Validate the complete store before mutating either the world or map.
export class NativeBrickStore extends BrickStore {
  put(key, bytes) {
    const max = this.bricks.reduce((a, b) => a * b, 1);
    if (!Number.isSafeInteger(key) || key < 0 || key >= max || !(bytes instanceof Uint8Array) || bytes.length !== NATIVE_BRICK_BYTES) throw new Error('Invalid native world brick');
    decodeNativeBrick(bytes);
    super.put(key, shareUniformBrick(bytes));
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
