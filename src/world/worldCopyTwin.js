// The world copy's JS twins (shaders/world/copy.js): the cell word of a decoded cell and of a V2 core, a
// brick's own info, the dilation, the occupancy, and a CPU world copy (WorldCopyTwin) whose commit and
// allocator follow the GPU's (a free-list pop, else a bump; a brick that turns uniform gives its slot back).
// The GPU build uses wcWordOfCore for saved bricks; tools/world-copy-cpu-check.mjs runs the rest against
// dense worlds, and sparse ones (copy.js wcLayout's columns: Descent's ring). Pure JS: no WebGPU.
import { wcWord, wcUnword, wcTempOf, WC_MIXED, WC_BRICK, WC_BRICK_CELLS, WC_AUX_MAX } from '../shaders/world/cellWord.js';
import { BRICK_INFO, AIR } from '../shaders/bindings.js';
import { WC_OWN, WC_OWN_ONLY, WC_AIR_SNAP, WC_GAS_IDS, WC_NODE1, WC_NODE2, WC_DILATE, WC_HF, wcLayout, wcLifeFull, wcGpuLayout } from '../shaders/world/copy.js';
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
  if (ch < 0 && LOOK[id].media < 0) own |= WC_OWN.CRISP;
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
  // THIN: a liquid cell with no liquid on both sides along an axis, inside the brick (copy.js wcGather)
  const liq = (i) => LOOK[words[i] & 255].ch === CH_LIQUID;
  const at = (x, y, z) => x + 4 * (y + 4 * z);
  let thin = false;
  for (let i = 0; i < WC_BRICK_CELLS && !thin; i++) {
    if (!liq(i)) continue;
    const l = [i & 3, (i >> 2) & 3, i >> 4];
    for (let ax = 0; ax < 3 && !thin; ax++) {
      const a = [...l], b = [...l];
      a[ax]--; b[ax]++;
      if (a[ax] >= 0 && b[ax] <= 3 && !liq(at(...a)) && !liq(at(...b))) thin = true;
    }
  }
  if (thin) low |= BRICK_INFO.THIN;
  return ((low & WC_OWN_ONLY) | own) >>> 0;
}

/** copy.js wcDilateFrag for brick b of info (a Uint32Array over the table's bricks: L.bi), from own bits only. */
export function wcDilated(info, L, b, dilate = WC_DILATE) {
  const [BX, BY, BZ] = L.bricks, bi = L.bi(b), me = info[bi];
  let near = 0, whole = (me & WC_OWN.LIQ_WHOLE) !== 0;
  for (let dz = -dilate; dz <= dilate; dz++) for (let dy = -dilate; dy <= dilate; dy++) for (let dx = -dilate; dx <= dilate; dx++) {
    const x = b[0] + dx, y = b[1] + dy, z = b[2] + dz;
    if (x < 0 || y < 0 || z < 0 || x >= BX || y >= BY || z >= BZ) continue;
    const o = info[L.bi([x, y, z])];
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
  /** columns: wcLayout's (a sparse table over them; a brick written off them is dropped, `lost` counting matter). */
  constructor(size, { capacity = 64, airT = PHYS.AMBIENT, columns = null } = {}) {
    this.L = wcLayout(size, { columns });
    this.lost = 0;
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
  bi(b) { return this.L.bi(b); }
  // a brick of a column the scene proved empty (a sparse table's air column): never written (copy.js wcTabled)
  _untabled(bi, words) {
    if (this.L.tabled(bi)) return false;
    if (words.some((w) => (w & 255) !== E.EMPTY)) this.lost++;
    return true;
  }
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
    if (this._untabled(bi, words)) return;
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
  dilate(bricks) { for (const b of bricks) { const i = this.bi(b); if (this.L.tabled(i)) this.info[i] = wcDilated(this.info, this.L, b); } }
  dilateAll() { const [X, Y, Z] = this.L.bricks; for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) this.dilate([[x, y, z]]); }
  // the occupancy levels from the info, everywhere (copy.js wcOccFrag)
  occupancy() {
    const L = this.L, occ = this.occ.fill(0), [BX, BY, BZ] = L.bricks, [AX, AY] = L.n1, [CX, CY] = L.n2;
    for (let z = 0; z < BZ; z++) for (let y = 0; y < BY; y++) for (let x = 0; x < BX; x++) {
      if (!(this.info[this.bi([x, y, z])] & BRICK_INFO.MATTER)) continue;
      const n1 = (x >> 2) + AX * ((y >> 2) + AY * (z >> 2));
      occ[n1 >> 5] |= 1 << (n1 & 31);
      const n2 = L.occ2Rel * 32 + (x >> 4) + CX * ((y >> 4) + CY * (z >> 4));
      occ[n2 >> 5] |= 1 << (n2 & 31);
    }
    return occ;
  }
  occupied(level, x, y, z) {
    const L = this.L, [X, Y, Z] = L.size;
    if (x < 0 || y < 0 || z < 0 || x >= X || y >= Y || z >= Z) return false;
    if (level === 0) return (this.info[this.bi([x >> 2, y >> 2, z >> 2])] & BRICK_INFO.MATTER) !== 0;
    const s = level === 1 ? 4 : 6, n = level === 1 ? L.n1 : L.n2;
    const i = (level === 1 ? 0 : L.occ2Rel * 32) + (x >> s) + n[0] * ((y >> s) + n[1] * (z >> s));
    return ((this.occ[i >> 5] >>> (i & 31)) & 1) !== 0;
  }
  /** Brick b's 64 words as the copy holds them. */
  words(b) {
    const e = this.table[this.bi(b)];
    if (!(e & WC_MIXED)) return new Uint32Array(64).fill(e);
    const s = ((e & ~WC_MIXED) >>> 0) * WC_BRICK_CELLS;
    return this.pool.slice(s, s + 64);
  }
  /**
   * The GPU-driven writeback (copy.js wcGatherFrag → decode → alloc → wcSeedFrag → dilate → occupancy) for a
   * window of grid g at world-cell origin O: cand, the window bricks V2's record names (any superset of what
   * changed), wordsOf(windowBrick) their 64 words now. Follows the kernels' lists and stamp marks over the
   * padded window (wcGpuLayout). Returns { changed: world bricks written, nodes: changed level-1 nodes (world
   * indices, the change list), seeds, dil, occ1, occ2 } (each list as the GPU's, deduped by its marks).
   */
  gpuWriteback(g, O, cand, wordsOf) {
    const G = (this._G?.g === g ? this._G : (this._G = { g, ...wcGpuLayout(g), marks: null })), L = this.L, D = WC_DILATE;
    G.marks ??= { dil: new Uint32Array(G.padB[0] * G.padB[1] * G.padB[2]), occ1: new Uint32Array(G.padN1[0] * G.padN1[1] * G.padN1[2]),
      occ2: new Uint32Array(G.padN2[0] * G.padN2[1] * G.padN2[2]), chg: new Uint32Array(G.chgN[0] * G.chgN[1] * G.chgN[2]) };
    const stamp = (this._stamp = (this._stamp ?? 0) + 1), ob = O.map((v) => v / WC_BRICK);
    const mark = (arr, i) => { if (i < 0 || i >= arr.length) throw new Error(`gpuWriteback: mark ${i} outside ${arr.length}`); const was = arr[i]; arr[i] = Math.max(was, stamp); return was !== stamp; };
    const idx = (r, n) => { if (r.some((v, k) => v < 0 || v >= n[k])) throw new Error(`gpuWriteback: ${r} outside ${n}`); return r[0] + n[0] * (r[1] + n[1] * r[2]); };
    const OWN_BITS = Object.values(WC_OWN).reduce((a, b) => a | b, 0) >>> 0;
    const out = { changed: [], nodes: [], seeds: [], dil: [], occ1: [], occ2: [] };
    // decode + alloc
    for (const wb of cand) {
      const b = wb.map((v, k) => v + ob[k]), bi = this.bi(b), w = wordsOf(wb), was = this.words(b);
      if (this._untabled(bi, w)) continue;
      if (w.every((v, i) => v === was[i])) continue;
      const own = wcOwnInfo(w, this.airT), prev = this.info[bi];
      if (((prev ^ own) & OWN_BITS) === 0) this.info[bi] = ((prev & ~WC_OWN_ONLY) | (own & WC_OWN_ONLY)) >>> 0;
      else { this.info[bi] = own; out.seeds.push(wb); }
      out.changed.push(b);
      const n = b.map((v) => v >> 2), r = n.map((v, k) => v - (ob[k] >> 2));
      if (mark(G.marks.chg, idx(r, G.chgN))) out.nodes.push(n[0] + L.n1[0] * (n[1] + L.n1[1] * n[2]));
      // the table and pool as commit's (the info above instead of its own)
      const old = this.table[bi];
      if (w.every((v) => v === w[0])) { this.table[bi] = w[0]; if (old & WC_MIXED) this.free.push((old & ~WC_MIXED) >>> 0); continue; }
      const slot = old & WC_MIXED ? (old & ~WC_MIXED) >>> 0 : this.alloc();
      this.table[bi] = (WC_MIXED | slot) >>> 0;
      this.pool.set(w, slot * WC_BRICK_CELLS);
    }
    // seeds: the dilation's bricks and nodes
    const lo = ob.map((v) => v - D);
    for (const wb of out.seeds) for (let dz = -D; dz <= D; dz++) for (let dy = -D; dy <= D; dy++) for (let dx = -D; dx <= D; dx++) {
      const q = [wb[0] + ob[0] + dx, wb[1] + ob[1] + dy, wb[2] + ob[2] + dz];
      if (q.some((v, k) => v < 0 || v >= L.bricks[k])) continue;
      if (L.tabled(this.bi(q)) && mark(G.marks.dil, idx(q.map((v, k) => v - lo[k]), G.padB))) out.dil.push(q);
      const n1 = q.map((v) => v >> 2), n2 = q.map((v) => v >> 4);
      if (mark(G.marks.occ1, idx(n1.map((v, k) => v - (lo[k] >> 2)), G.padN1))) out.occ1.push(n1);
      if (mark(G.marks.occ2, idx(n2.map((v, k) => v - (lo[k] >> 4)), G.padN2))) out.occ2.push(n2);
    }
    // the dilation (reads own bits only: any order), then the occupancy, level 1 before level 2
    const dilated = out.dil.map((q) => wcDilated(this.info, L, q));
    out.dil.forEach((q, i) => { this.info[this.bi(q)] = dilated[i]; });
    const setBit = (i, on) => { if (on) this.occ[i >> 5] |= 1 << (i & 31); else this.occ[i >> 5] &= ~(1 << (i & 31)); };
    for (const n of out.occ1) {
      let on = false;
      for (let z = n[2] * 4; z < Math.min(n[2] * 4 + 4, L.bricks[2]); z++) for (let y = n[1] * 4; y < Math.min(n[1] * 4 + 4, L.bricks[1]); y++) for (let x = n[0] * 4; x < Math.min(n[0] * 4 + 4, L.bricks[0]); x++)
        if (this.info[this.bi([x, y, z])] & BRICK_INFO.MATTER) on = true;
      setBit(n[0] + L.n1[0] * (n[1] + L.n1[1] * n[2]), on);
    }
    for (const n of out.occ2) {
      let on = false;
      for (let z = n[2] * 4; z < Math.min(n[2] * 4 + 4, L.n1[2]); z++) for (let y = n[1] * 4; y < Math.min(n[1] * 4 + 4, L.n1[1]); y++) for (let x = n[0] * 4; x < Math.min(n[0] * 4 + 4, L.n1[0]); x++) {
        const i = x + L.n1[0] * (y + L.n1[1] * z);
        if ((this.occ[i >> 5] >>> (i & 31)) & 1) on = true;
      }
      setBit(L.occ2Rel * 32 + n[0] + L.n2[0] * (n[1] + L.n2[1] * n[2]), on);
    }
    return out;
  }
  // ---- the heightfield (copy.js WC_HF, wcHfColsFrag / wcHfUpFrag) ----
  /** A column's top: its highest non-air cell's height plus one, 0 for an empty column (copy.js wcColumnTop). */
  columnTop(x, z) {
    for (let y = this.L.size[1] - 1; y >= 0; y--) if ((this.cell(x, y, z) & 255) !== E.EMPTY) return y + 1;
    return 0;
  }
  _hf() {
    return (this.hf ??= this.L.hfDims.map(([x, z]) => new Uint16Array(x * z)));
  }
  // level 1 at brick column c: the highest top within HPAD cells of its columns, plus VPAD (0: none)
  _hfL1(c) {
    const hf = this._hf(), [n0x, n0z] = this.L.hfDims[0], [n1x, n1z] = this.L.hfDims[1];
    if (c[0] < 0 || c[1] < 0 || c[0] >= n1x || c[1] >= n1z) return;
    let m = 0;
    for (let z = Math.max(0, c[1] * 4 - WC_HF.HPAD); z < Math.min(n0z, c[1] * 4 + 4 + WC_HF.HPAD); z++)
      for (let x = Math.max(0, c[0] * 4 - WC_HF.HPAD); x < Math.min(n0x, c[0] * 4 + 4 + WC_HF.HPAD); x++) m = Math.max(m, hf[0][x + n0x * z]);
    hf[1][c[0] + n1x * c[1]] = m ? Math.min(0xffff, m + WC_HF.VPAD) : 0;
  }
  // levels 2 and 3: each entry the maximum of its 16 children, every entry
  _hfUp() {
    const hf = this._hf();
    for (let k = 2; k < WC_HF.LEVELS; k++) {
      const [nx, nz] = this.L.hfDims[k], [cx, cz] = this.L.hfDims[k - 1];
      for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        let m = 0;
        for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) { const qx = x * 4 + dx, qz = z * 4 + dz; if (qx < cx && qz < cz) m = Math.max(m, hf[k - 1][qx + cx * qz]); }
        hf[k][x + nx * z] = m;
      }
    }
  }
  /** The whole heightfield, as the build makes it (every brick column, level 1, levels 2 and 3). */
  hfAll() {
    const hf = this._hf(), [n0x, n0z] = this.L.hfDims[0], [BX, , BZ] = this.L.bricks;
    for (let z = 0; z < n0z; z++) for (let x = 0; x < n0x; x++) hf[0][x + n0x * z] = this.columnTop(x, z);
    for (let bz = 0; bz < BZ; bz++) for (let bx = 0; bx < BX; bx++) this._hfL1([bx, bz]);
    this._hfUp();
    return hf;
  }
  /** As a writeback keeps it: the changed bricks' columns, the level-1 values around them, levels 2 and 3. */
  hfUpdate(bricks) {
    const hf = this._hf(), [n0x, n0z] = this.L.hfDims[0];
    for (const b of bricks) for (let i = 0; i < 16; i++) {
      const x = b[0] * 4 + (i & 3), z = b[2] * 4 + (i >> 2);
      if (x < n0x && z < n0z) hf[0][x + n0x * z] = this.columnTop(x, z);
    }
    for (const b of bricks) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this._hfL1([b[0] + dx, b[2] + dz]);
    this._hfUp();
    return hf;
  }
  /** The value level k holds for the column region holding cell column (x, z). */
  hfTop(k, x, z) { const [nx] = this.L.hfDims[k]; return this._hf()[k][(x >> (2 * k)) + nx * (z >> (2 * k))]; }

  /** Bytes the GPU copy of this would hold: table, pool at capacity, info, occupancy, free list. */
  bytes(capacity = this.capacity) { return 4 * (this.L.tableWords + this.L.metaWords) + capacity * (WC_BRICK_CELLS + 1) * 4; }
}
export { wcUnword };
