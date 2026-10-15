import { BRICK, cellSlot, slotCell, gridDims } from '../shaders/common.js';
import { decodeBrick, BRICK_FLOATS } from './store.js';
import { aerationForSource } from '../gfx/foam.js';

export const SOURCE_CORE = 32;
export const SOURCE_BRICK = BRICK;
export const SOURCE_RANK = Object.freeze({ unknown: 0, generated: 1, saved: 2, captured: 3, live: 4 });
export const SOURCE_GRID = Object.freeze(gridDims({ nx: 32, ny: 32, nz: 32 }));
const USAGE = 0x80 | 0x08 | 0x04;
const MAX_BINDING = 128 * 1024 * 1024;
const originOf = (o) => Array.isArray(o) ? [...o] : [o.x, o.y, o.z];
export const sourceBounds = (sim, origin = sim.origin) => {
  const lo = originOf(origin);
  return { lo, hi: lo.map((v, i) => v + [sim.g.nx, sim.g.ny, sim.g.nz][i]) };
};
export function intersectBounds(a, b) {
  const lo = a.lo.map((v, i) => Math.max(v, b.lo[i])), hi = a.hi.map((v, i) => Math.min(v, b.hi[i]));
  return lo.every((v, i) => v < hi[i]) ? { lo, hi } : null;
}
export function snapshotSource(sim, origin = sim.origin) {
  // Never retain sim.header(), sim.origin, state.cur's getter or another
  // mutable descriptor across a shift. Copies encode immutable byte offsets.
  const aer = aerationForSource(sim);
  return Object.freeze({ g: Object.freeze({ ...sim.g }), origin: Object.freeze(originOf(origin)), copy: sim.cur,
    A: sim.state.A, B: sim.state.B, flow: sim.flow,
    aeration: aer?.buffer ?? null, aerCopy: aer?.cur ?? 0, aerGeneration: aer?.generation ?? 0,
    deco: sim.decoPlane ? Object.freeze({ ...sim.decoPlane }) : null });
}

// Exact native-copy plans. Both ends use the original brick/tile layout.
// Coalesce within a 4³ brick; partial edges are cell exact, never widened.
export function planSourceCopies(src, dst, bounds, accept = () => true) {
  for (const d of [src, dst]) {
    if (d.origin.some((v) => !Number.isInteger(v) || v % BRICK) || gridDims(d.g).slots !== d.g.slots) throw new Error('raw source copy requires original supertile layout and brick-aligned origin');
  }
  const clip = intersectBounds(bounds, { lo: src.origin, hi: src.origin.map((v, i) => v + [src.g.nx, src.g.ny, src.g.nz][i]) });
  if (!clip) return [];
  const box = intersectBounds(clip, { lo: dst.origin, hi: dst.origin.map((v, i) => v + [dst.g.nx, dst.g.ny, dst.g.nz][i]) });
  if (!box) return [];
  const runs = [];
  // Slot order lets whole aligned bricks collapse to one native buffer copy.
  for (let bz = Math.floor(box.lo[2] / BRICK) * BRICK; bz < box.hi[2]; bz += BRICK)
    for (let by = Math.floor(box.lo[1] / BRICK) * BRICK; by < box.hi[1]; by += BRICK)
      for (let bx = Math.floor(box.lo[0] / BRICK) * BRICK; bx < box.hi[0]; bx += BRICK) {
        let run = null;
        for (let t = 0; t < 64; t++) {
          const p = [bx + (t & 3), by + ((t >> 2 & 1) + (t >> 5) * 2), bz + (t >> 3 & 3)];
          if (p.some((v, i) => v < box.lo[i] || v >= box.hi[i])) { run = null; continue; }
          const s = cellSlot(src.g, ...p.map((v, i) => v - src.origin[i]));
          const d = cellSlot(dst.g, ...p.map((v, i) => v - dst.origin[i]));
          if (!accept(d, p)) { run = null; continue; }
          if (run && run.src + run.cells === s && run.dst + run.cells === d) run.cells++;
          else { run = { src: s, dst: d, cells: 1 }; runs.push(run); }
        }
      }
  runs.sort((a, b) => a.src - b.src);
  const merged = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && last.src + last.cells === r.src && last.dst + last.cells === r.dst) last.cells += r.cells;
    else merged.push(r);
  }
  return merged;
}
export function recordSourceCopies(frame, src, dst, runs, { aux = true } = {}) {
  const native = (a, ao, b, bo, n) => {
    if (ao < 0 || bo < 0 || ao + n > a.size || bo + n > b.size || [ao, bo, n].some(v => v % 4)) throw new Error('raw source copy exceeds its original buffer layout');
    frame.copy(a, ao, b, bo, n);
  };
  for (const r of runs) {
    for (const name of ['A', 'B']) native(src[name], ((src.copy ?? 0) * src.g.slots + r.src) * 16,
      dst[name], ((dst.copy ?? 0) * dst.g.slots + r.dst) * 16, r.cells * 16);
    if (!aux) continue;
    if (src.flow && dst.flow) native(src.flow, r.src * 8, dst.flow, r.dst * 8, r.cells * 8);
    if (src.aeration && dst.aeration) native(src.aeration, ((src.aerCopy ?? 0) * src.g.slots + r.src) * 8,
      dst.aeration, ((dst.aerCopy ?? 0) * dst.g.slots + r.dst) * 8, r.cells * 8);
    if (src.deco && dst.deco) native(src.deco.buffer, src.deco.offset + r.src * 4,
      dst.deco.buffer, dst.deco.offset + r.dst * 4, r.cells * 4);
  }
}

// Data/construction ownership only. No optical draw domains, field histories,
// force buffers, page table, eviction budget, or renderer bind-group additions.
export class WorldRenderSource {
  constructor(win) {
    this.win = win; this.sim = win.sim; this.gpu = win.gpu;
    this.chunks = new Map(); this.epoch = win.epoch; this.revision = 0;
    this.disposed = false; this.liveVersion = -1; this.minimumStaticRevision = 0;
    this.unsubscribeData = win.scene.subscribeData?.(() => this.invalidateGenerated());
    this.auxContract = Object.freeze({ flow: 'original vec2u/slot', aeration: 'original vec2u/slot; captured current copy',
      deco: 'original RGBA8 u32/slot', persistence: 'A/B only; aux remains GPU-owned after store commit',
      histories: 'EMA/GI are renderer-owned; phase 2 must supply persistent world ownership',
      sourceStyle: 'scene importManifest/appearanceWords remain scene-owned; SourceStyle is view policy, not residency'  });
  }
  token() { return Object.freeze({ epoch: this.epoch, revision: this.revision }); }
  nextRevision() { return ++this.revision; }
  _buffer(label, bytes) {
    if (bytes > Math.min(MAX_BINDING, this.gpu.device?.limits?.maxStorageBufferBindingSize ?? MAX_BINDING)) throw new Error('raw source buffer exceeds default storage binding limit');
    return this.gpu.createBuffer({ label: `world source ${label}`, size: bytes, usage: USAGE });
  }
  _chunk(origin) {
    const key = origin.join(','); let c = this.chunks.get(key);
    if (!c) {
      c = { key, origin: [...origin], g: SOURCE_GRID, copy: 0,
        A: this._buffer(`${key} A`, SOURCE_GRID.slots * 16), B: this._buffer(`${key} B`, SOURCE_GRID.slots * 16),
        rank: new Uint8Array(SOURCE_GRID.slots), revisions: new Float64Array(SOURCE_GRID.slots),
        pending: new Float64Array(SOURCE_GRID.slots), aux: new Uint8Array(SOURCE_GRID.slots), flow: null, aeration: null, deco: null };
      this.chunks.set(key, c);
    }
    return c;
  }
  *_cores(bounds) {
    const box = intersectBounds(bounds, { lo: [0, 0, 0], hi: this.win.size });
    if (!box) return;
    for (let z = Math.floor(box.lo[2] / 32) * 32; z < box.hi[2]; z += 32)
      for (let y = Math.floor(box.lo[1] / 32) * 32; y < box.hi[1]; y += 32)
        for (let x = Math.floor(box.lo[0] / 32) * 32; x < box.hi[0]; x += 32) yield [x, y, z];
  }
  _aux(c, src) {
    if (src.flow && !c.flow) c.flow = this._buffer(`${c.key} flow`, SOURCE_GRID.slots * 8);
    if (src.aeration && !c.aeration) c.aeration = this._buffer(`${c.key} aeration`, SOURCE_GRID.slots * 8);
    if (src.deco && !c.deco) c.deco = { buffer: this._buffer(`${c.key} deco`, SOURCE_GRID.slots * 4), offset: 0 };
  }
  _record(frame, src, bounds, rank, revision, epoch = this.epoch) {
    if (this.disposed || epoch !== this.epoch) return 0;
    const box = intersectBounds(bounds, { lo: [0, 0, 0], hi: this.win.size });
    if (!box) return 0;
    let cells = 0;
    for (const origin of this._cores(box)) {
      const c = this._chunk(origin); this._aux(c, src);
      const runs = planSourceCopies(src, c, box, (d) => {
        // A late static result cannot widen over a partial live/captured edge.
        if (rank < c.rank[d] || revision < c.revisions[d]) return false;
        c.rank[d] = rank; c.revisions[d] = revision;
        c.pending[d] = rank === SOURCE_RANK.captured ? revision : 0;
        if (rank >= SOURCE_RANK.captured) c.aux[d] = (src.flow ? 1 : 0) | (src.aeration ? 2 : 0) | (src.deco ? 4 : 0);
        cells++; return true;
      });
      recordSourceCopies(frame, src, c, runs);
      // Absence is explicit zero, not permission to resurrect a previously
      // allocated auxiliary buffer. Disabled-but-kept aeration is discovered
      // by aerationForSource and therefore is NOT cleared here.
      for (const r of rank >= SOURCE_RANK.captured ? runs : []) {
        if (!src.flow && c.flow) frame.clear(c.flow, r.dst * 8, r.cells * 8);
        if (!src.aeration && c.aeration) frame.clear(c.aeration, r.dst * 8, r.cells * 8);
        if (!src.deco && c.deco) frame.clear(c.deco.buffer, r.dst * 4, r.cells * 4);
      }
    }
    return cells;
  }
  recordLiveCopy(frame, sim = this.sim, bounds = sourceBounds(sim)) {
    const revision = this.nextRevision(), src = snapshotSource(sim);
    this._record(frame, src, bounds, SOURCE_RANK.live, revision);
    this.liveVersion = sim.version; this.liveSnapshot = src;
    return revision;
  }
  needsLiveCopy(sim = this.sim) {
    const a = this.liveSnapshot, b = snapshotSource(sim);
    return this.liveVersion !== sim.version || !a || a.A !== b.A || a.B !== b.B || a.copy !== b.copy ||
      a.origin.some((v, i) => v !== b.origin[i]) || a.flow !== b.flow || a.aeration !== b.aeration ||
      a.aerCopy !== b.aerCopy || a.aerGeneration !== b.aerGeneration || a.deco?.buffer !== b.deco?.buffer || a.deco?.offset !== b.deco?.offset;
  }
  recordLeavingCopy(frame, sim, bounds, oldOrigin = sim.origin) {
    const revision = this.nextRevision(), src = snapshotSource(sim, oldOrigin);
    // Leaving live cells transfer ownership to captured; they are not stale
    // static data and must be allowed to replace the previous live revision.
    for (const c of this.chunks.values()) planSourceCopies(src, c, bounds, (d) => { c.rank[d] = Math.min(c.rank[d], SOURCE_RANK.captured); return false; });
    this._record(frame, src, bounds, SOURCE_RANK.captured, revision);
    return Object.freeze({ epoch: this.epoch, revision, bounds: { lo: [...bounds.lo], hi: [...bounds.hi] } });
  }
  // Refinement: chunk is a raw GPU descriptor {g,origin,A,B,copy,bounds?,kind?,epoch?};
  // revision is a token captured BEFORE any asynchronous producer begins.
  recordPopulate(frame, chunk, revision = this.token()) {
    if (revision.revision < this.minimumStaticRevision) return 0;
    if (!['generated', 'saved'].includes(chunk.kind ?? 'generated')) throw new Error('static source producer must declare generated or saved');
    return this._record(frame, chunk, chunk.bounds ?? { lo: chunk.origin, hi: chunk.origin.map((v, i) => v + [chunk.g.nx, chunk.g.ny, chunk.g.nz][i]) },
      SOURCE_RANK[chunk.kind ?? 'generated'], revision.revision, revision.epoch);
  }
  commitStoreRevision(keys, revision) {
    if (this.disposed || revision.epoch !== this.epoch) return;
    const wanted = new Set(keys);
    for (const c of this.chunks.values()) for (let d = 0; d < c.g.slots; d++) {
      if (!c.pending[d] || c.pending[d] > revision.revision) continue;
      // key from actual cell coordinates, not the local supertile number.
      const p = slotWorld(c, d);
      if (!wanted.has(this.win.store.key(...p.map((v) => Math.floor(v / BRICK))))) continue;
      c.pending[d] = 0;
      if (c.rank[d] === SOURCE_RANK.captured) c.rank[d] = SOURCE_RANK.saved;
      // Aux has NOT been persisted by BrickStore. It retains its own owner.
    }
  }
  invalidateGenerated() {
    if (this.disposed) return;
    this.minimumStaticRevision = this.nextRevision();
    for (const c of this.chunks.values()) for (let i = 0; i < c.rank.length; i++) if (c.rank[i] === SOURCE_RANK.generated) {
      c.rank[i] = SOURCE_RANK.unknown; c.revisions[i] = this.revision;
    }
  }
  recordStore(bounds, token = this.token()) {
    if (this.disposed || token.epoch !== this.epoch) return;
    const wb = this.win.wb;
    for (const [key, bytes] of this.win.store.map) {
      const origin = [key % wb[0] * 4, Math.floor(key / wb[0]) % wb[1] * 4, Math.floor(key / (wb[0] * wb[1])) * 4];
      const box = intersectBounds(bounds, { lo: origin, hi: origin.map((v) => v + 4) });
      if (!box) continue;
      const c = this._chunk(origin.map((v) => Math.floor(v / 32) * 32)), words = decodeSourceBrick(bytes);
      const src = { g: SOURCE_GRID, origin };
      const runs = planSourceCopies(src, c, box, (d) => {
        if (c.rank[d] > SOURCE_RANK.saved || c.revisions[d] > token.revision) return false;
        c.rank[d] = SOURCE_RANK.saved; c.revisions[d] = token.revision; return true;
      });
      // Uploaded immutable store bytes only. Live state never reaches the CPU.
      for (const r of runs) for (const name of ['A', 'B']) this.gpu.write(c[name], r.dst * 16, words[name].subarray(r.src * 4, (r.src + r.cells) * 4));
    }
    for (const [key, bytes] of this.sim.deco?.store ?? []) {
      const origin = [key % wb[0] * 4, Math.floor(key / wb[0]) % wb[1] * 4, Math.floor(key / (wb[0] * wb[1])) * 4];
      const box = intersectBounds(bounds, { lo: origin, hi: origin.map((v) => v + 4) });
      if (!box) continue;
      const c = this._chunk(origin.map((v) => Math.floor(v / 32) * 32));
      if (!c.deco) c.deco = { buffer: this._buffer(`${c.key} deco`, SOURCE_GRID.slots * 4), offset: 0 };
      const slab = new Uint32Array(bytes.slice().buffer), words = new Uint32Array(64);
      for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) words[cellSlot(SOURCE_GRID, x, y, z)] = slab[x + 4 * (y + 4 * z)];
      const runs = planSourceCopies({ g: SOURCE_GRID, origin }, c, box, (d) => {
        if (c.aux[d] & 4 || c.rank[d] > SOURCE_RANK.saved) return false;
        c.aux[d] |= 4; return true;
      });
      for (const r of runs) this.gpu.write(c.deco.buffer, r.dst * 4, words.subarray(r.src, r.src + r.cells));
    }
  }
  getSource(cell) {
    const c = this.chunks.get(cell.map((v) => Math.floor(v / 32) * 32).join(','));
    if (!c) return { kind: 'unknown', epoch: this.epoch };
    const slot = cellSlot(c.g, ...cell.map((v, i) => v - c.origin[i])), rank = c.rank[slot];
    return { kind: Object.keys(SOURCE_RANK).find((k) => SOURCE_RANK[k] === rank), chunk: c, slot, revision: c.revisions[slot],
      pending: !!c.pending[slot], aux: c.aux[slot], epoch: this.epoch };
  }
  get bindings() { return { epoch: this.epoch, revision: this.revision, chunks: this.chunks, auxContract: this.auxContract,
    importManifest: this.win.scene.importManifest ?? null, appearanceWords: this.win.scene.appearanceWords ?? null, scene: this.win.scene }; }
  // Restore captured cells (including already committed exact source) AFTER
  // fill/store and BEFORE publishing live authority. No CPU readback.
  restoreCaptured(frame, sim, bounds) {
    const dst = snapshotSource(sim); let count = 0;
    for (const c of this.chunks.values()) {
      const runs = planSourceCopies(c, dst, bounds, (_d, p) => {
        const s = cellSlot(c.g, ...p.map((v, i) => v - c.origin[i]));
        return c.rank[s] >= SOURCE_RANK.saved && c.rank[s] < SOURCE_RANK.live;
      });
      recordSourceCopies(frame, c, dst, runs); count += runs.reduce((n, r) => n + r.cells, 0);
    }
    // Native A/B restore bypasses edit writers' F updates. Reclassify with
    // the existing prewarmed fresh pass; stale generated flags must not make
    // captured live matter inert on its next physical step.
    if (count) sim.freshFlags();
    return count;
  }
  reset(epoch = this.epoch + 1) {
    for (const c of this.chunks.values()) for (const b of [c.A, c.B, c.flow, c.aeration, c.deco?.buffer]) if (b) this.sim._retire(b);
    this.chunks.clear(); this.epoch = epoch; this.revision = 0; this.liveVersion = -1; this.liveSnapshot = null; this.minimumStaticRevision = 0;
  }
  dispose() { if (this.disposed) return; this.unsubscribeData?.(); this.reset(); this.disposed = true; }
}

// Store's linear x/y/z cell order -> original tiled source slot order.
export function decodeSourceBrick(bytes) {
  const a = new Float32Array(BRICK_FLOATS), b = new Float32Array(BRICK_FLOATS);
  decodeBrick(bytes, a, 0, b, 0);
  const A = new Uint32Array(BRICK_FLOATS), B = new Uint32Array(BRICK_FLOATS);
  const au = new Uint32Array(a.buffer), bu = new Uint32Array(b.buffer);
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const src = (x + 4 * (y + 4 * z)) * 4, dst = cellSlot(SOURCE_GRID, x, y, z) * 4;
    A.set(au.subarray(src, src + 4), dst); B.set(bu.subarray(src, src + 4), dst);
  }
  return { A, B };
}
function slotWorld(c, s) {
  return slotCell(c.g, s).map((v, i) => v + c.origin[i]);
}
