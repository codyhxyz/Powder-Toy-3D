import { ELEMENTS, E } from '../elements.js';
import { PHYS } from '../physics.js';

// The console's view of the world (docs/console.md, "Reads and writes").
//
// The state lives on the GPU (sim.js: two RGBA32F textures), so a script can
// neither read nor write a cell directly without stalling the frame. Instead:
//
// Writes are queued here, one edit per cell (later edits to a cell merge into
// it), and applied in one small copy-through GPU pass (shaders/script.js) when
// the queue is flushed: before every simulation step, after every typed
// command and at the end of each frame. The edits go up sorted by cell, and
// each fragment of the pass binary-searches them.
//
// Reads come from a CPU cache of blocks of the state (the GPU backend's are
// supertiles, a 32×32-texel square of the state atlas each), overlaid with the
// edits still queued. A command typed at the console reads synchronously
// (exact, one stall per block it touches); an event handler (event.tick and
// friends) never stalls: a block it reads that isn't cached yet is requested
// and the read returns nil until it arrives, and the blocks handlers keep
// reading are refreshed asynchronously at a bounded rate. So a handler sees the
// world as it was a few steps ago, plus its own writes.
//
// The backend (console/gpu.js on the GPU; a CPU mock in scripts/check-console.mjs):
//   epoch()                     a string that changes when the grid or its window does
//   size()                      [nx, ny, nz]
//   blockCount, blockTexels     blocks in the grid, texels per block
//   locate(x, y, z)             [block, texel in the block]
//   readBlocks(blocks, sync)    Map(block → { a, b }) (Float32Array RGBA per texel,
//                               the fetchA/fetchB layout), or a Promise of one
//   applyEdits(chunk)           one pass over a packed chunk (packEdits)

// Edit mask bits (shaders/script.js has the same).
export const EDIT = {
  SPAWN: 1,         // a fresh cell of element v[0]: its default temperature and life, at rest (TPT's create_part)
  TYPE: 2,          // the element only, everything else kept (TPT's part_change_type)
  TEMP: 4, LIFE: 8, CTYPE: 16, VX: 32, VY: 64, VZ: 128, PRESSURE: 256,
  IF_EMPTY: 512,    // only where the cell holds air (TPT's partCreate(-1, ...))
  IF_MATTER: 1024,  // only where it holds matter (TPT's partProperty, partKill)
};
const COND = EDIT.IF_EMPTY | EDIT.IF_MATTER;
// Each field: its mask bit and its slot in an edit's values, [A.xyzw, B.xyzw]
// as in the state (sim.js: A = id, temperature, life, ctype + seed; B = velocity, pressure).
export const FIELDS = {
  type: { bit: EDIT.TYPE, slot: 0 },
  temp: { bit: EDIT.TEMP, slot: 1 },
  life: { bit: EDIT.LIFE, slot: 2 },
  ctype: { bit: EDIT.CTYPE, slot: 3 },
  vx: { bit: EDIT.VX, slot: 4 },
  vy: { bit: EDIT.VY, slot: 5 },
  vz: { bit: EDIT.VZ, slot: 6 },
  pressure: { bit: EDIT.PRESSURE, slot: 7 },
};
const FIELD_LIST = Object.values(FIELDS);
const FIELD_BITS = FIELD_LIST.reduce((m, f) => m | f.bit, 0);

// What a script may write: the ranges the sim itself keeps (physics.js).
export const LIMITS = {
  temp: [PHYS.CELL_TEMP_MIN, PHYS.CELL_TEMP_MAX],
  pressure: [PHYS.P_MIN, PHYS.P_MAX],
  v: [-PHYS.V_MAX, PHYS.V_MAX],
  ctype: [0, 255],   // ctype shares state A's w with the cell's seed (its fraction): small integers keep the seed's precision
};

// Edits per GPU pass: the pass binary-searches them, EDIT_SEARCH_STEPS probes
// each (log2 of this, plus one).
export const EDIT_CHUNK = 65536;
export const EDIT_SEARCH_STEPS = Math.ceil(Math.log2(EDIT_CHUNK)) + 1;
// Width of the edit texture: a chunk's edits run row by row, in three blocks of
// rows (keys and masks, then state A values, then state B values).
export const EDIT_TEX_W = 1024;
// The queue is flushed by itself once it holds this many cells (a loop over a
// big box), so it never grows without bound.
const MAX_PENDING_EDITS = 4 * EDIT_CHUNK;
// Cell keys are carried as floats in the edit texture: exact below 2^24.
const KEY_LIMIT = 2 ** 24;

// The read cache: blocks a handler keeps reading are re-read every
// REFRESH_MS; one nobody read for EVICT_MS is dropped; at most
// MAX_CACHED_BLOCKS are kept (least recently read first out). Asynchronous
// reads are bounded per frame (pump) and in flight, so a script reading the
// whole grid refreshes it over a few frames instead of all at once.
const REFRESH_MS = 100;
const EVICT_MS = 5000;
const MAX_CACHED_BLOCKS = 8192;
const MAX_READ_BLOCKS_PER_FRAME = 64;
const MAX_INFLIGHT_READS = 4;

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

// A cell as scripts see it (read returns this object, reused).
const blankCell = () => ({ id: 0, temp: 0, life: 0, ctype: 0, vx: 0, vy: 0, vz: 0, pressure: 0 });
const SLOT_NAMES = ['id', 'temp', 'life', 'ctype', 'vx', 'vy', 'vz', 'pressure'];

// An edit applied to a cell on the CPU, as the GPU pass applies it to the
// state: the read overlay and the cache's write-through. Returns false if its
// condition left the cell alone.
export function applyEdit(c, e) {
  const empty = c.id === E.EMPTY;
  if ((e.mask & EDIT.IF_EMPTY) && !empty) return false;
  if ((e.mask & EDIT.IF_MATTER) && empty) return false;
  const v = e.v;
  if (e.mask & EDIT.SPAWN) {
    const el = ELEMENTS[v[0]];
    c.id = v[0];
    c.temp = el.id === E.EMPTY ? PHYS.AMBIENT : el.temp;
    c.life = el.id === E.EMPTY ? 0 : el.life;
    c.ctype = el.id === E.LAVA ? E.STONE : 0;   // the brush's lava remembers stone (shaders/passes.js paintFrag)
    c.vx = c.vy = c.vz = 0;
  }
  for (let s = 0; s < FIELD_LIST.length; s++) if (e.mask & FIELD_LIST[s].bit) c[SLOT_NAMES[s]] = v[s];
  return true;
}

// Two edits to one cell as one, if they can be: the merged edit, REJECT (the
// second one can't apply, whatever the cell holds: TPT's partCreate(-1, ...)
// on a cell this batch already filled), or FLUSH (their conditions depend on
// the cell in different ways: apply the first, then queue the second).
const REJECT = 'reject', FLUSH = 'flush';
const overlay = (a, b) => {
  const v = a.v.slice();
  for (const f of FIELD_LIST) if (b.mask & f.bit) v[f.slot] = b.v[f.slot];
  return { mask: a.mask | (b.mask & FIELD_BITS), v };
};
const strip = (e) => ({ mask: e.mask & ~COND, v: e.v });
function merge(prev, next) {
  const pc = prev.mask & COND, nc = next.mask & COND;
  const spawned = (prev.mask & EDIT.SPAWN) !== 0;
  const pid = prev.v[0];
  if (next.mask & EDIT.SPAWN) {
    if (!nc) return next;
    if (spawned && !pc) {   // the cell's element after prev is known
      const empty = pid === E.EMPTY;
      if (nc === EDIT.IF_EMPTY) return empty ? strip(next) : REJECT;
      return empty ? prev : strip(next);
    }
    // killed if it held matter: air either way
    if (spawned && pc === EDIT.IF_MATTER && pid === E.EMPTY && nc === EDIT.IF_EMPTY) return strip(next);
    // filled if it held air: matter either way
    if (spawned && pc === EDIT.IF_EMPTY && pid !== E.EMPTY && nc === EDIT.IF_EMPTY) return REJECT;
    return FLUSH;
  }
  if (spawned && !pc) {
    if (nc === EDIT.IF_EMPTY) return pid === E.EMPTY ? overlay(prev, next) : prev;
    if (nc === EDIT.IF_MATTER) return pid === E.EMPTY ? prev : overlay(prev, next);
    return overlay(prev, next);
  }
  if (!spawned && pc === nc) return overlay(prev, next);
  return FLUSH;
}

// Sorted edits packed for the GPU pass, EDIT_CHUNK at a time: a Float32Array
// RGBA texture EDIT_TEX_W wide and 3 × rows tall (rows [0, rows): key, mask;
// [rows, 2 rows): state A values; [2 rows, 3 rows): state B values), with the
// box of cells they touch (inclusive).
export function packEdits(keys, edits, size) {
  const [nx, ny] = size;
  const chunks = [];
  for (let c0 = 0; c0 < keys.length; c0 += EDIT_CHUNK) {
    const n = Math.min(EDIT_CHUNK, keys.length - c0);
    const rows = Math.ceil(n / EDIT_TEX_W);
    const data = new Float32Array(EDIT_TEX_W * rows * 3 * 4);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const ids = new Set();   // elements it puts in cells (the particle layer wakes for emitters)
    const block = EDIT_TEX_W * rows * 4;
    for (let j = 0; j < n; j++) {
      const k = keys[c0 + j], e = edits.get(k);
      const x = k % nx, y = Math.floor(k / nx) % ny, z = Math.floor(k / (nx * ny));
      const p = [x, y, z];
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
      data[j * 4] = k;
      data[j * 4 + 1] = e.mask;
      if (e.mask & (EDIT.SPAWN | EDIT.TYPE)) ids.add(e.v[0]);
      for (let s = 0; s < 4; s++) {
        data[block + j * 4 + s] = e.v[s];
        data[2 * block + j * 4 + s] = e.v[4 + s];
      }
    }
    chunks.push({ count: n, rows, data, lo, hi, ids });
  }
  return chunks;
}

export class ScriptWorld {
  constructor(backend, { now = () => performance.now() } = {}) {
    this.backend = backend;
    this.now = now;
    this.edits = new Map();     // cell key → { mask, v: Float32Array(8) }
    this.blocks = new Map();    // block → { a, b, readAt, usedAt, wroteSeq }
    this.wanted = new Set();    // blocks a handler read that aren't cached
    this.inflight = 0;
    this.seq = 0;               // write-through counter (a read issued before a write is stale)
    this.stamp = 0;             // a typed command's reads: each block is read fresh once per stamp
    this.epoch = backend.epoch();
    this.cell = blankCell();
    this.passes = 0;            // GPU passes run (tests, the status line)
    this.onEdit = null;         // called before each edit is queued
  }

  get size() { return this.backend.size(); }
  get pending() { return this.edits.size; }

  inBounds(x, y, z) {
    const [nx, ny, nz] = this.size;
    return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;
  }
  key(x, y, z) { const [nx, ny] = this.size; return (z * ny + y) * nx + x; }
  cellOf(k) {
    const [nx, ny] = this.size;
    return [k % nx, Math.floor(k / nx) % ny, Math.floor(k / (nx * ny))];
  }

  // The grid or its window changed (a new map, World's window moved): what we
  // hold is about other cells now.
  checkEpoch() {
    const e = this.backend.epoch();
    if (e === this.epoch) return;
    this.epoch = e;
    this.blocks.clear();
    this.wanted.clear();
    this.edits.clear();
  }

  // ---------------------------------------------------------------- writes

  // Queue an edit of cell (x, y, z): mask bits (EDIT) and values by field name
  // ({ type, temp, ... }; SPAWN takes the element from type). Values are
  // clamped to what the sim keeps (LIMITS). Returns false if it can't apply
  // (out of the grid, or a create on a cell this batch already filled).
  edit(x, y, z, mask, values = {}) {
    this.checkEpoch();
    if (!this.inBounds(x, y, z)) return false;
    const [nx, ny, nz] = this.size;
    if (nx * ny * nz > KEY_LIMIT) throw new Error('This grid is too big for console edits');
    const v = new Float32Array(8);
    for (const [name, f] of Object.entries(FIELDS)) if (name in values) v[f.slot] = values[name];
    if (mask & EDIT.TEMP) v[1] = clamp(v[1], LIMITS.temp);
    if (mask & EDIT.CTYPE) v[3] = Math.round(clamp(v[3], LIMITS.ctype));
    for (const [bit, s] of [[EDIT.VX, 4], [EDIT.VY, 5], [EDIT.VZ, 6]]) if (mask & bit) v[s] = clamp(v[s], LIMITS.v);
    if (mask & EDIT.PRESSURE) v[7] = clamp(v[7], LIMITS.pressure);
    const next = { mask, v };
    this.onEdit?.();   // (console/index.js: a typed command's first write takes an undo snapshot)
    const k = this.key(x, y, z);
    const prev = this.edits.get(k);
    let e = next;
    if (prev) {
      e = merge(prev, next);
      if (e === REJECT) return false;
      if (e === FLUSH) { this.flush(); e = next; }
    }
    this.edits.set(k, e);
    if (this.edits.size >= MAX_PENDING_EDITS) this.flush();
    return true;
  }

  // Apply every queued edit: one GPU pass per EDIT_CHUNK cells, and the same
  // edits to the cached blocks, so reads see them before the cache refreshes.
  flush() {
    this.checkEpoch();
    if (!this.edits.size) return 0;
    const keys = [...this.edits.keys()].sort((a, b) => a - b);
    const size = this.size;
    for (const chunk of packEdits(keys, this.edits, size)) {
      this.backend.applyEdits(chunk);
      this.passes++;
    }
    this.seq++;
    const c = blankCell();
    for (const k of keys) {
      const [x, y, z] = this.cellOf(k);
      const [block, t] = this.backend.locate(x, y, z);
      const b = this.blocks.get(block);
      if (!b) continue;
      decode(b, t, c);
      if (applyEdit(c, this.edits.get(k))) encode(b, t, c);
      b.wroteSeq = this.seq;
    }
    const n = keys.length;
    this.edits.clear();
    return n;
  }

  // ---------------------------------------------------------------- reads

  // A typed command starts: its first read of each block is a fresh,
  // synchronous one (later reads in the command reuse it).
  beginCommand() { this.stamp++; }
  // The state moved on under the cache (sim.step from a command).
  invalidate() { this.stamp++; for (const b of this.blocks.values()) b.readAt = 0; }

  // Cell (x, y, z) as scripts see it ({ id, temp, life, ctype, vx, vy, vz,
  // pressure }, reused by the next read), or null: outside the grid, or (not
  // sync) its block isn't cached yet (and is requested, unless !request).
  read(x, y, z, sync, request = true) {
    this.checkEpoch();
    if (!this.inBounds(x, y, z)) return null;
    const [block, t] = this.backend.locate(x, y, z);
    const b = this.block(block, sync, request);
    const c = this.cell;
    const e = this.edits.get(this.key(x, y, z));
    if (!b) {
      // an unconditional new cell is known without reading
      if (e && (e.mask & EDIT.SPAWN) && !(e.mask & COND)) { Object.assign(c, blankCell()); applyEdit(c, e); return c; }
      return null;
    }
    decode(b, t, c);
    if (e) applyEdit(c, e);
    return c;
  }

  // The cached block, read now (sync) or requested (null until it arrives).
  block(block, sync, request = true) {
    let b = this.blocks.get(block);
    const now = this.now();
    // a command reads exactly; a handler takes what's cached
    if (sync && (!b || b.stamp !== this.stamp)) {
      this.store(this.backend.readBlocks([block], true), now, this.seq);
      b = this.blocks.get(block);
    }
    if (!b) { if (request) this.wanted.add(block); return null; }
    b.usedAt = now;
    return b;
  }

  // Every block of the grid cached (sync: read now); false while a handler's
  // whole-grid read is still filling in (the blocks are requested).
  readAll(sync) {
    this.checkEpoch();
    const missing = [];
    const now = this.now();
    for (let i = 0; i < this.backend.blockCount; i++) {
      const b = this.blocks.get(i);
      if (!b || (sync && b.stamp !== this.stamp)) missing.push(i);
      else b.usedAt = now;
    }
    if (!missing.length) return true;
    if (!sync) { for (const i of missing) this.wanted.add(i); return false; }
    this.store(this.backend.readBlocks(missing, true), now, this.seq);
    return true;
  }

  // Every cached cell holding matter (after readAll): fn(x, y, z, cell). The
  // queued edits are overlaid.
  forEachMatter(fn) {
    const [nx, ny, nz] = this.size;
    const c = this.cell;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const r = this.read(x, y, z, false);
          if (r && r.id !== E.EMPTY) { if (fn(x, y, z, c) === false) return; }
        }
  }

  store(map, now, seq) {
    for (const [i, d] of map) this.blocks.set(i, { a: d.a, b: d.b, readAt: now, usedAt: now, wroteSeq: seq, stamp: this.stamp });
    if (this.blocks.size > MAX_CACHED_BLOCKS) {
      const old = [...this.blocks].sort((p, q) => p[1].usedAt - q[1].usedAt);
      for (const [i] of old.slice(0, this.blocks.size - MAX_CACHED_BLOCKS)) this.blocks.delete(i);
    }
  }

  // Once a frame: request the blocks handlers wanted and refresh the ones they
  // keep reading (oldest first, at most MAX_READ_BLOCKS_PER_FRAME), and drop
  // the ones nobody read for a while.
  pump() {
    this.checkEpoch();
    const now = this.now();
    for (const [i, b] of this.blocks) if (now - b.usedAt > EVICT_MS) this.blocks.delete(i);
    if (this.inflight >= MAX_INFLIGHT_READS) return;
    const list = [...this.wanted].slice(0, MAX_READ_BLOCKS_PER_FRAME);
    if (list.length < MAX_READ_BLOCKS_PER_FRAME) {
      const stale = [...this.blocks].filter(([, b]) => now - b.readAt > REFRESH_MS && now - b.usedAt < REFRESH_MS * 2)
        .sort((p, q) => p[1].readAt - q[1].readAt).slice(0, MAX_READ_BLOCKS_PER_FRAME - list.length);
      for (const [i] of stale) list.push(i);
    }
    if (!list.length) return;
    for (const i of list) this.wanted.delete(i);
    const epoch = this.epoch, seq = this.seq;
    this.inflight++;
    Promise.resolve(this.backend.readBlocks(list, false)).then((map) => {
      if (epoch !== this.epoch) return;
      // a block written since the read was issued: the read missed the write, read it again
      for (const [i] of map) {
        const b = this.blocks.get(i);
        if (b && b.wroteSeq > seq) { map.delete(i); b.readAt = 0; }
      }
      this.store(map, this.now(), seq);
    }).catch(() => { /* a failed read only leaves the cache as it was */ })
      .finally(() => { this.inflight--; });
  }
}

function decode(b, t, c) {
  const o = t * 4;
  c.id = Math.round(b.a[o]);
  c.temp = b.a[o + 1];
  c.life = b.a[o + 2];
  c.ctype = Math.floor(b.a[o + 3]);
  c.vx = b.b[o]; c.vy = b.b[o + 1]; c.vz = b.b[o + 2];
  c.pressure = b.b[o + 3];
}
function encode(b, t, c) {
  const o = t * 4;
  b.a[o] = c.id; b.a[o + 1] = c.temp; b.a[o + 2] = c.life; b.a[o + 3] = c.ctype + (b.a[o + 3] % 1);
  b.b[o] = c.vx; b.b[o + 1] = c.vy; b.b[o + 2] = c.vz; b.b[o + 3] = c.pressure;
}
