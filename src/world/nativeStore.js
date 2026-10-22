import { validateMaterialCore } from '../v2/materialValidation.js';
import { BrickStore, decodeBrick, BRICK_FLOATS } from './store.js';
import { v2Rows, V2, FULL, T_OFFSET } from '../shaders/v2.js';
import { SEED_MAX } from '../shaders/common.js';
import { lifeScale } from '../v2/layout.js';
import { PHASE_NORMAL_MAX } from '../v2/phase.js';
import { setFall } from '../v2/fall.js';
import { V1_STEP_MS } from '../v2/gravity.js';
import { PHYS } from '../physics.js';
import { ELEMENTS } from '../elements.js';

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
// ---- V1's stored bricks, natively: a World save V1 made keeps no native store (wire/saves.js), only
// V1's bricks (store.js: 64 cells of state A and B, PackBits). V2 took one back through V1's restore
// edit and then imported the cells it wrote; legacyBrickToNative is what that made of the brick,
// decoded straight into V2 cells: each cell is V2's import of a V1 cell (shaders/v2.js importA, and
// v2import's powder fall from B.y), f32 op for op, its bank 0 (the import's). V1's brick and the
// native one list their cells in the same order (store.js's slab order, x fastest, is the native
// brick's: shaders/v2/window.js slabSlot), so a V2 window restores it exact (WorldWindow.restore).
// Assumes the native core format of v2/layout.js MATERIAL_VERSION 2 (the ¼ K temperature code,
// 16-bit payloads, shaders/v2/state.js withLife/withSpark). Every bank is 0, so a cell's energy is
// its code's alone: no heat-capacity unit enters, and a units migration of stored banks has nothing
// here to convert. Air's pressure and wind (B.xzw) are not cells' under V2, as the import drops them.
const f32 = Math.fround;
// WGSL's round(): half to even
const roundEven = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
const clampTo = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const IMPORT_ROWS = v2Rows();
const IMPORT_LIFE_SCALE = ELEMENTS.map(e => f32(lifeScale(e.id)));
const IMPORT_CONDUCTS = ELEMENTS.map(e => e.elec > 0);
const PAYLOAD_MAX = 65535;   // a 16-bit life/fuel payload (v2/layout.js withPayload)
const SPARK_MASK = 4095;     // a conductor's 12-bit spark code (shaders/v2/state.js withSpark)
const SEED_SCALE = 65536;    // importA's colour seed: the fraction of A.w over SEED_MAX, in 16 bits
function withLife(c, v, liquid) {
  const payload = clampTo(roundEven(f32(f32(v) * IMPORT_LIFE_SCALE[c[0] & 255])), 0, PAYLOAD_MAX);
  if (liquid) c[3] = (c[3] & 0xffff) | (payload << 16); else c[1] = (c[1] & 0xffff0000) | payload;
}
function withSpark(c, code, liquid) {
  if (liquid) c[3] = (c[3] & 0xf000ffff) | ((code & SPARK_MASK) << 16); else c[3] = (c[3] & 0xfffff000) | (code & SPARK_MASK);
}
/** V2's import of V1's cell (state A a, its B.y the fall V1 gave it): the core shaders/v2.js importA and v2import make. */
export function legacyCellCore(a, vy = 0) {
  const id = clampTo(Math.floor(f32(f32(a[0]) + 0.5)), 0, ELEMENTS.length - 1), k = IMPORT_ROWS[id].cls;
  const tq = clampTo(roundEven(f32(f32(f32(a[1]) + f32(T_OFFSET)) * 4)), 0, PHASE_NORMAL_MAX);
  const w = f32(a[3]), legacy = Math.max(Math.floor(w), 0) >>> 0;
  const ct = IMPORT_CONDUCTS[id] ? 0 : legacy & 255;
  const seed = Math.trunc(clampTo(f32(f32(f32(w - Math.floor(w)) / f32(SEED_MAX)) * SEED_SCALE), 0, PAYLOAD_MAX));
  let c = new Uint32Array([id | (tq << 8), 0, 0, 0]);
  if (k === V2.LIQUID) {
    c[1] = FULL | (ct << 24);
    withLife(c, a[2], true);
  } else if (k !== V2.AIR) {
    let life = f32(a[2]);
    if (k === V2.GAS && IMPORT_ROWS[id].fade > 0 && life <= 0) life = 1;
    c[1] = ct << 16;
    withLife(c, life, false);
    c[3] = seed << 16;
  }
  if (IMPORT_CONDUCTS[id]) withSpark(c, legacy, k === V2.LIQUID);
  if (k === V2.POWDER && f32(vy) < 0) c = setFall(c, f32(f32(Math.min(f32(-vy), f32(PHYS.V_MAX))) * f32(V1_STEP_MS)), 0);
  return c;
}
/** V1's stored brick (store.js encodeBrick's bytes) as a native one (NATIVE_BRICK_BYTES), every bank 0. */
export function legacyBrickToNative(bytes) {
  const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
  decodeBrick(bytes, A, 0, B, 0);
  const core = new Uint32Array(BRICK_FLOATS);
  for (let l = 0; l < BRICK_FLOATS / 4; l++) core.set(legacyCellCore(A.subarray(l * 4, l * 4 + 4), B[l * 4 + 1]), l * 4);
  return encodeNativeBrick(core, new Int32Array(BRICK_FLOATS / 4));
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
