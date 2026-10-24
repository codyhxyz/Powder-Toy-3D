// The world copy's JS twins (shaders/world/copy.js): the cell word of a decoded cell and of a V2 core, a
// brick's own info, the dilation, the occupancy, and a CPU world copy (WorldCopyTwin) whose commit and
// allocator follow the GPU's (a free-list pop, else a bump; a brick that turns uniform gives its slot back).
// The GPU build uses wcWordOfCore for saved bricks; tools/world-copy-cpu-check.mjs runs the rest against
// dense worlds. Pure JS: no WebGPU.
import { wcWord, wcUnword, wcTempOf, WC_MIXED, WC_BRICK, WC_BRICK_CELLS, WC_AUX_MAX } from '../shaders/world/cellWord.js';
import { BRICK_INFO, AIR } from '../shaders/bindings.js';
import { WC_OWN, WC_OWN_ONLY, WC_AIR_SNAP, WC_GAS_IDS, WC_NODE1, WC_NODE2, WC_DILATE, wcLayout, wcLifeFull } from '../shaders/world/copy.js';
import { ELEMENTS, K, R, E } from '../elements.js';
import { LOOK, CHANNELS } from '../gfx/materials.js';
import { lifeScale, cTq, isLiquid, isConductor } from '../v2/layout.js';
import { PHYS } from '../physics.js';

const CH_LIQUID = CHANNELS.findIndex((c) => c.key === 'LIQUID');
const GAS = new Set(WC_GAS_IDS);
const FULL_Q = 65536;
const kindOf = (id) => ELEMENTS[id]?.kind ?? K.EMPTY;

/** shaders/world/copy.js wcWordOf: a cell's word from (id, °C, life, ctype, fill 0..1); airT the scene's ambient. */
export function wcWordOf(id, T, life, ctype, fill, airT = PHYS.AMBIENT) {
  const k = kindOf(id);
  const a = Math.max(0, Math.min(WC_AUX_MAX, Math.round(Math.fround(fill * WC_AUX_MAX))));
  if (id === E.EMPTY || k === K.EMPTY || (k === K.LIQUID && a < 1)) return wcWord(0, 0, Math.abs(T - airT) <= WC_AIR_SNAP ? airT : T, 0);
  if (k === K.LIQUID) return wcWord(id, ctype, T, a / WC_AUX_MAX);
  return wcWord(id, ctype, T, life / wcLifeFull(id));
}

/** The cell word of a V2 core (4 u32: shaders/compact.js's decode; copy.js wcCoreWord). */
export function wcWordOfCore(c, airT = PHYS.AMBIENT) {
  const id = c[0] & 255, T = cTq(c) * 0.25 - 273.25, cond = isConductor(id);
  if (isLiquid(id)) {
    const mask = (ELEMENTS[id]?.burnRate ?? 0) > 0 ? 127 : 255;
    const ct = cond ? (c[3] >>> 16) & 4095 : (c[1] >>> 24) & mask;
    return wcWordOf(id, T, 0, ct & 255, Math.min((c[1] & 0xffffff) / FULL_Q, 1), airT);
  }
  const ct = cond ? c[3] & 4095 : (c[1] >>> 16) & 255;
  return wcWordOf(id, T, (c[1] & 65535) / lifeScale(id), ct & 255, 1, airT);
}

/** copy.js wcCellOwn: [low bits, own bits] of one cell word. */
export function wcCellOwn(w, airT = PHYS.AMBIENT) {
  const id = w & 255;
  let low = 0, own = 0;
  if (id === E.EMPTY) {
    if (Math.abs(wcTempOf((w >>> 16) & 255) - airT) > WC_AIR_SNAP) low |= AIR.HOT << BRICK_INFO.AIR_SHIFT;
    return [low, own];
  }
  own |= WC_OWN.MATTER;
  const ch = LOOK[id].ch, r = ELEMENTS[id].render, gasLike = kindOf(id) === K.GAS;
  if (ch >= 0) own |= WC_OWN.SURF;
  if (ch >= 0 && ch !== CH_LIQUID) own |= WC_OWN.OPAQUE_SURF;
  if (LOOK[id].media >= 0) own |= WC_OWN.MEDIA;
  if (!gasLike && r !== R.LIQUID && r !== R.GLASS) own |= WC_OWN.OPAQUE;
  if (ch === CH_LIQUID && ((w >>> 24) & 127) === WC_AUX_MAX && !(own & WC_OWN.OPAQUE)) own |= WC_OWN.LIQ_WHOLE;
  if (GAS.has(id)) low |= 1 << BRICK_INFO.GAS_SHIFT;
  return [low, own];
}

/** copy.js wcGather + wcOwnInfo: a brick's info word before the dilation, from its 64 words. */
export function wcOwnInfo(words, airT = PHYS.AMBIENT) {
  let low = 0, own = 0, whole = true, hi = 0, lo = 0;
  const NE = ELEMENTS.length;
  for (let i = 0; i < WC_BRICK_CELLS; i++) {
    const [l, o] = wcCellOwn(words[i], airT);
    low += l & (127 << BRICK_INFO.GAS_SHIFT);
    low |= l & ~(127 << BRICK_INFO.GAS_SHIFT);
    own |= o & ~WC_OWN.LIQ_WHOLE;
    if (!(o & WC_OWN.LIQ_WHOLE)) whole = false;
    const id = words[i] & 255;
    if (LOOK[id].ch === CH_LIQUID) { hi = Math.max(hi, id + 1); lo = Math.max(lo, NE - id); }
  }
  if (whole) own |= WC_OWN.LIQ_WHOLE;
  if (hi !== 0 && hi - 1 !== NE - lo) low |= BRICK_INFO.MIXED;
  if (hi !== 0 && !(own & WC_OWN.LIQ_WHOLE)) low |= BRICK_INFO.THIN;
  return ((low & WC_OWN_ONLY) | own) >>> 0;
}

/** copy.js wcDilateFrag for brick b of info (a Uint32Array over the world's bricks), from own bits only. */
export function wcDilated(info, L, b, dilate = WC_DILATE) {
  const [BX, BY, BZ] = L.bricks, bi = b[0] + BX * (b[1] + BY * b[2]), me = info[bi];
  let near = 0, whole = (me & WC_OWN.LIQ_WHOLE) !== 0;
  for (let dz = -dilate; dz <= dilate; dz++) for (let dy = -dilate; dy <= dilate; dy++) for (let dx = -dilate; dx <= dilate; dx++) {
    const x = b[0] + dx, y = b[1] + dy, z = b[2] + dz;
    if (x < 0 || y < 0 || z < 0 || x >= BX || y >= BY || z >= BZ) continue;
    const o = info[x + BX * (y + BY * z)];
    near |= o;
    if (!(o & WC_OWN.LIQ_WHOLE)) whole = false;
  }
  let low = me & WC_OWN_ONLY;
  const surf = (near & WC_OWN.SURF) !== 0, media = (near & WC_OWN.MEDIA) !== 0;
  if (surf) low |= BRICK_INFO.SURF;
  if (media) low |= BRICK_INFO.MEDIA;
  if ((me & WC_OWN.OPAQUE) || (near & WC_OWN.OPAQUE_SURF)) low |= BRICK_INFO.OPAQUE;
  if (whole) low |= BRICK_INFO.LIQUID_INTERIOR;
  if ((me & WC_OWN.MATTER) || surf || media) low |= BRICK_INFO.MATTER;
  else low &= 7 << BRICK_INFO.AIR_SHIFT;
  return ((me & ~0x00ffffff) | low) >>> 0;
}

/**
 * A CPU world copy: the table, a pool that grows by reallocating (never dropping), the free list, the info
 * and the occupancy, committed a brick at a time as the GPU's kernels do.
 */
export class WorldCopyTwin {
  constructor(size, { capacity = 64, airT = PHYS.AMBIENT } = {}) {
    this.L = wcLayout(size);
    this.airT = airT;
    this.air = wcWordOf(E.EMPTY, airT, 0, 0, 0, airT);
    this.table = new Uint32Array(this.L.nBricks).fill(this.air);
    this.info = new Uint32Array(this.L.nBricks);
    this.occ = new Uint32Array(this.L.occWords);
    this.pool = new Uint32Array(capacity * WC_BRICK_CELLS);
    this.capacity = capacity;
    this.free = [];
    this.bump = 0;
    this.grows = 0;
  }
  bi(b) { return b[0] + this.L.bricks[0] * (b[1] + this.L.bricks[1] * b[2]); }
  get used() { return this.bump - this.free.length; }
  grow(need) {
    const cap = Math.max(need, Math.ceil(this.capacity * 1.5));
    const pool = new Uint32Array(cap * WC_BRICK_CELLS);
    pool.set(this.pool);
    this.pool = pool;
    this.capacity = cap;
    this.grows++;
  }
  alloc() {
    if (this.free.length) return this.free.pop();
    if (this.bump >= this.capacity) this.grow(this.bump + 1);
    return this.bump++;
  }
  /** Commit brick b's 64 words (x + 4 (y + 4 z)): the build's and the writeback's pass. */
  commit(b, words) {
    const bi = this.bi(b), old = this.table[bi];
    this.info[bi] = wcOwnInfo(words, this.airT);
    const uniform = words.every((w) => w === words[0]);
    if (uniform) {
      this.table[bi] = words[0];
      if (old & WC_MIXED) this.free.push((old & ~WC_MIXED) >>> 0);
      return;
    }
    const slot = old & WC_MIXED ? (old & ~WC_MIXED) >>> 0 : this.alloc();
    this.table[bi] = (WC_MIXED | slot) >>> 0;
    this.pool.set(words, slot * WC_BRICK_CELLS);
  }
  cell(x, y, z) {
    const [X, Y, Z] = this.L.size;
    if (x < 0 || y < 0 || z < 0 || x >= X || y >= Y || z >= Z) return this.air;
    const e = this.table[this.bi([x >> 2, y >> 2, z >> 2])];
    if (!(e & WC_MIXED)) return e;
    return this.pool[((e & ~WC_MIXED) >>> 0) * WC_BRICK_CELLS + ((x & 3) + WC_BRICK * ((y & 3) + WC_BRICK * (z & 3)))];
  }
  dilate(bricks) { for (const b of bricks) { const i = this.bi(b); this.info[i] = wcDilated(this.info, this.L, b); } }
  dilateAll() { const [X, Y, Z] = this.L.bricks; for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) this.dilate([[x, y, z]]); }
  // the occupancy levels from the info, everywhere (copy.js wcOccFrag)
  occupancy() {
    const L = this.L, occ = this.occ.fill(0), [BX, BY, BZ] = L.bricks, [AX, AY] = L.n1, [CX, CY] = L.n2;
    for (let z = 0; z < BZ; z++) for (let y = 0; y < BY; y++) for (let x = 0; x < BX; x++) {
      if (!(this.info[x + BX * (y + BY * z)] & BRICK_INFO.MATTER)) continue;
      const n1 = (x >> 2) + AX * ((y >> 2) + AY * (z >> 2));
      occ[n1 >> 5] |= 1 << (n1 & 31);
      const n2 = L.occ2At * 32 + (x >> 4) + CX * ((y >> 4) + CY * (z >> 4));
      occ[n2 >> 5] |= 1 << (n2 & 31);
    }
    return occ;
  }
  occupied(level, x, y, z) {
    const L = this.L, [X, Y, Z] = L.size;
    if (x < 0 || y < 0 || z < 0 || x >= X || y >= Y || z >= Z) return false;
    if (level === 0) return (this.info[this.bi([x >> 2, y >> 2, z >> 2])] & BRICK_INFO.MATTER) !== 0;
    const s = level === 1 ? 4 : 6, n = level === 1 ? L.n1 : L.n2;
    const i = (level === 1 ? 0 : L.occ2At * 32) + (x >> s) + n[0] * ((y >> s) + n[1] * (z >> s));
    return ((this.occ[i >> 5] >>> (i & 31)) & 1) !== 0;
  }
  /** Bytes the GPU copy of this would hold: table, pool at capacity, info, occupancy, free list. */
  bytes(capacity = this.capacity) { return 4 * (2 * this.L.nBricks + this.L.occWords) + capacity * (WC_BRICK_CELLS + 1) * 4; }
}
export { wcUnword };
