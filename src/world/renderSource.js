import { copyRuns } from '../gpu/copyRuns.js';
import { BRICK, cellSlot, slotCell, gridDims } from '../shaders/common.js';
import { decodeBrick, BRICK_FLOATS } from './store.js';
import { nativePackWGSL, NATIVE_PACK_LAYOUT, NativePackParams } from '../shaders/renderSource.js';
import { fold } from '../gpu/kernels.js';

export const SOURCE_RANK = Object.freeze({ unknown: 0, generated: 1, saved: 2, captured: 3, live: 4 });
export const SOURCE_GRID = Object.freeze(gridDims({ nx: 32, ny: 32, nz: 32 }));
const USAGE = 0x80 | 0x08 | 0x04;
const MAX_BINDING = 128 * 1024 * 1024;
const ACCEPT_ALL = () => true;
const originOf = (o) => Array.isArray(o) ? [...o] : [o.x, o.y, o.z];
export const sourceBounds = (sim, origin = sim.origin) => {
  const lo = originOf(origin);
  return { lo, hi: lo.map((v, i) => v + [sim.g.nx, sim.g.ny, sim.g.nz][i]) };
};
export function intersectBounds(a, b) {
  const lo = a.lo.map((v, i) => Math.max(v, b.lo[i])), hi = a.hi.map((v, i) => Math.min(v, b.hi[i]));
  return lo.every((v, i) => v < hi[i]) ? { lo, hi } : null;
}
// Physics V2 running the window: the source reads V2's cells natively. Its leaving copies (and the
// tree producer's read of the live cells) pack the window's cores straight into the source's
// targets through the read group (v2/physics.js readGroup: format 2), by the decoders the volume's
// format-2 draw reads them with (shaders/renderSource.js nativePackWGSL). The source keeps a big
// map's cells past the window (store, captured slabs, generated trees) for the window's moves and
// the tree producer; the live window is not copied into it (nothing reads it there since the
// big-map renderer went, 2026-10-24). V1's copies below are V1's alone.
const NATIVE_FOAM = Object.freeze({ label: 'V2 foam (packed by the native source pack)' });   // a native source's aeration: packed, never copied
const nativePacks = new WeakMap();   // sim → { kernel, layout, groups, dummy }
/** Whether the source reads sim's cells natively: V2 runs it (sim.compact, built). */
export const isNativeSource = (sim) => !!(sim?.compact?.isReady && !sim.compact.disposed && !sim.disposed);
/** The native source pack of sim (made on first call while a V2 owner exists; its kernel builds in the background). */
export function nativePackOf(sim) {
  if (!sim?.compactOwner || sim.disposed || sim.gpu?.failure) return null;
  let pack = nativePacks.get(sim);
  if (!pack) {
    const gpu = sim.gpu, layout = gpu.layout('WORLD_NATIVE_PACK', NATIVE_PACK_LAYOUT);
    pack = { layout, groups: new WeakMap(), dummy: null,
      kernel: gpu.kernel({ name: 'worldNativePack', code: nativePackWGSL(sim.g), layouts: [sim.L.TABLES, sim.L.STATE_RO, layout], params: NativePackParams }) };
    nativePacks.set(sim, pack);
  }
  return pack;
}
/** Whether a native source can record now (its pack built). Moves and copies wait for it (world/window.js). */
export const nativeSourceReady = (sim) => nativePackOf(sim)?.kernel.state === 'ready';
/** Free the native pack's scratch (the window lets go of its sim: WorldWindow.dispose). */
export function dropNativeWorldSource(sim) {
  const pack = nativePacks.get(sim);
  if (!pack) return;
  nativePacks.delete(sim);
  if (pack.dummy) (sim.disposed || !sim._retire ? pack.dummy.destroy() : sim._retire(pack.dummy));
}
const SUPER_TILES = (g) => [g.nx / 16, g.nz / 8];   // a target's supertiles along x and z (common.js SUPER_CELLS)
// Packs a native source's cells in box (world cells, inside src's window and dst's extent) into dst
// (a source core: its A, B and aeration; the raw scratch: its A and B at dst.copy).
function recordNativePack(frame, src, dst, box) {
  const sim = src.nativeSim, owner = sim.compact, pack = nativePackOf(sim);
  if (!pack || pack.kernel.state !== 'ready' || owner !== src.nativeOwner) throw new Error('native world source pack is not ready');
  const aer = !src.edit && !!dst.aeration;
  let group = pack.groups.get(dst.A);
  if (!group || group.aer !== (aer ? dst.aeration : null)) {
    pack.dummy ??= sim.gpu.createBuffer({ label: 'world native pack (no aeration)', size: 16, usage: USAGE });
    group = { aer: aer ? dst.aeration : null, group: sim.gpu.bindGroup(pack.layout,
      [dst.A, dst.B, aer ? dst.aeration : pack.dummy].map((buffer, binding) => ({ binding, resource: { buffer } })), 'world native pack') };
    pack.groups.set(dst.A, group);
  }
  owner.sync();
  const d = owner.dynamics, air = !!(d?.isReady && d.air && !d.disposed);
  const base = box.lo.map((v) => Math.floor(v / BRICK) * BRICK), nb = box.hi.map((v, i) => Math.ceil((v - base[i]) / BRICK));
  pack.kernel.dispatch(frame, fold(nb[0] * nb[1] * nb[2]), {
    bind: [sim.tables, owner.readGroup(), group.group], header: { ...sim.header(), origin: [...src.origin], format: 2 },
    params: { lo: box.lo, hi: box.hi, edit: src.edit ? 1 : 0, air: air ? 1 : 0, aer: aer ? 1 : 0,
      dstOrigin: dst.origin, dstBase: (dst.copy ?? 0) * dst.g.slots, dstTiles: SUPER_TILES(dst.g) },
  });
  sim.onPass?.('worldNativePack', { kind: 'compute', gpuMs: null });
}
const extentOf = (d) => ({ lo: d.origin, hi: d.origin.map((v, i) => v + [d.g.nx, d.g.ny, d.g.nz][i]) });

// A native source's cells over runs (planSourceCopies' plan from src into dst over box): the pack
// writes every cell of box ∩ src ∩ dst, so the plan must hold all of them (a live or leaving copy's
// does: nothing outranks it); then the aux the pack doesn't write (flow, decoration) by copy.
export function recordNativeRuns(frame, src, dst, box, runs, { aux = true } = {}) {
  const clip = intersectBounds(box, extentOf(src)), cut = clip && intersectBounds(clip, extentOf(dst));
  const cells = runs.reduce((n, r) => n + r.cells, 0);
  if (!cut) { if (cells) throw new Error('native world source plan outside its box'); return; }
  if (cells !== cut.hi.reduce((n, v, i) => n * (v - cut.lo[i]), 1)) throw new Error('native world source pack must cover its whole box');
  recordNativePack(frame, src, dst, cut);
  recordSourceCopies(frame, src, dst, runs, { aux });
}
export function snapshotSource(sim, origin = sim.origin, { native = false } = {}) {
  // Never retain sim.header(), sim.origin, state.cur's getter or another
  // mutable descriptor across a shift. Copies encode immutable byte offsets.
  // While V2 runs the box: its cells, packed when a copy records (above), the drawn projection, or
  // the edit projection (native: a read written back into physics, the tree producer's support);
  // its foam is in its cores, packed with them (an edit read carries none). Its flow and
  // decoration are its own buffers, copied as V1's are.
  if (isNativeSource(sim)) {
    const owner = sim.compact;
    return Object.freeze({ g: Object.freeze({ ...sim.g }), origin: Object.freeze(originOf(origin)), copy: 0, A: null, B: null,
      nativeSim: sim, nativeOwner: owner, edit: !!native, flow: sim.flow,
      aeration: native ? null : NATIVE_FOAM, aerCopy: 0, aerGeneration: owner.tick, boundedWake: true,
      deco: sim.decoPlane ? Object.freeze({ ...sim.decoPlane }) : null });
  }
  // (V1's cells, before the native owner is ready: no foam of their own, as V1 whitewater went with V1)
  return Object.freeze({ g: Object.freeze({ ...sim.g }), origin: Object.freeze(originOf(origin)), copy: sim.cur,
    A: sim.state.A, B: sim.state.B, flow: sim.flow,
    aeration: null, aerCopy: 0, aerGeneration: 0, boundedWake: true,
    deco: sim.decoPlane ? Object.freeze({ ...sim.decoPlane }) : null });
}
// A raw read of the live cells: V1's state as it is, or V2's cells natively (snapshotSource).
// native: a read that is written back into physics (V2: the edit projection).
export function liveSource(sim, origin = sim.origin, { native = false } = {}) {
  return snapshotSource(sim, origin, { native });
}

// Exact native-copy plans. Both ends use the original brick/tile layout.
// Coalesce within a 4³ brick; partial edges are cell exact, never widened.
export function planSourceCopies(src, dst, bounds, accept = ACCEPT_ALL, acceptBrick = null) {
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
        if (bx >= box.lo[0] && by >= box.lo[1] && bz >= box.lo[2] &&
            bx + BRICK <= box.hi[0] && by + BRICK <= box.hi[1] && bz + BRICK <= box.hi[2] &&
            (accept === ACCEPT_ALL || acceptBrick)) {
          const s = cellSlot(src.g, bx - src.origin[0], by - src.origin[1], bz - src.origin[2]);
          const d = cellSlot(dst.g, bx - dst.origin[0], by - dst.origin[1], bz - dst.origin[2]);
          // true/false accepts/rejects the complete contiguous brick. null
          // requests cell-exact fallback for mixed authority or partial data.
          const take = accept === ACCEPT_ALL ? true : acceptBrick(d, [bx, by, bz]);
          if (take === true) { runs.push({ src: s, dst: d, cells: 64 }); continue; }
          if (take === false) continue;
        }
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
function destinationSpans(runs) {
  const out = [];
  for (const r of [...runs].sort((a, b) => a.dst - b.dst)) {
    const last = out.at(-1);
    if (last && last.dst + last.cells === r.dst) last.cells += r.cells; else out.push({ dst: r.dst, cells: r.cells });
  }
  return out;
}
export function recordSourceCopies(frame, src, dst, runs, { aux = true } = {}) {
  // Every run's copies, by buffer pair, recorded together (gpu/copyRuns.js): a copy a run and a
  // buffer was ~37,000 commands a second on Island, choking Chrome's GPU process.
  const pairs = new Map();
  const native = (a, ao, b, bo, n) => {
    if (ao < 0 || bo < 0 || ao + n > a.size || bo + n > b.size || [ao, bo, n].some(v => v % 4)) throw new Error('raw source copy exceeds its original buffer layout');
    let to = pairs.get(a); if (!to) pairs.set(a, to = new Map());
    let list = to.get(b); if (!list) to.set(b, list = []);
    list.push([ao, bo, n]);
  };
  const copyOf = (d) => d.copy ?? 0;
  // (a native source's A, B and aeration are packed, not copied: recordNativeRuns)
  const words = src.nativeSim ? [] : ['A', 'B'];
  for (const r of runs) {
    for (const name of words) native(src[name], (copyOf(src) * src.g.slots + r.src) * 16,
      dst[name], (copyOf(dst) * dst.g.slots + r.dst) * 16, r.cells * 16);
    if (!aux) continue;
    if (src.flow && dst.flow) native(src.flow, r.src * 8, dst.flow, r.dst * 8, r.cells * 8);
    if (src.aeration && dst.aeration && !src.nativeSim) native(src.aeration, ((src.aerCopy ?? 0) * src.g.slots + r.src) * 8,
      dst.aeration, ((dst.aerCopy ?? 0) * dst.g.slots + r.dst) * 8, r.cells * 8);
    if (src.deco && dst.deco) native(src.deco.buffer, src.deco.offset + r.src * 4,
      dst.deco.buffer, dst.deco.offset + r.dst * 4, r.cells * 4);
  }
  for (const [a, to] of pairs) for (const [b, list] of to) copyRuns(frame, a, b, list);
}

// Data/construction ownership only. No optical draw domains, field histories,
// force buffers, page table, eviction budget, or renderer bind-group additions.
export class WorldRenderSource {
  constructor(win, { context = null } = {}) {
    this.win = win; this.context = context ?? win; this.ownedContext = context;
    this.sim = win.sim; this.gpu = win.gpu;
    this.chunks = new Map(); this.epoch = win.epoch; this.revision = 0;
    this.disposed = false; this.minimumStaticRevision = 0;
    this.unsubscribeData = !context && win.scene.subscribeData?.(() => this.invalidateGenerated());
    this.auxContract = Object.freeze({ flow: 'original vec2u/slot', aeration: 'original vec2u/slot; captured current copy',
      deco: 'original RGBA8 u32/slot', persistence: 'A/B only; aux remains GPU-owned after store commit',
      histories: 'EMA/GI are renderer-owned; phase 2 must supply persistent world ownership',
      sourceStyle: 'scene importManifest/appearanceWords remain scene-owned; SourceStyle is view policy, not residency'  });
  }
  token() { return Object.freeze({ epoch: this.epoch, revision: this.revision }); }
  nextRevision() { return ++this.revision; }
  recordUpload(frame, target, offset, data) {
    const buffer = this.gpu.createBuffer({ label: 'immutable world source upload', size: data.byteLength, usage: 4, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    try { frame.copy(buffer, 0, target, offset, data.byteLength); }
    finally { this._retire(buffer); }
  }
  _retire(buffer) { return this.ownedContext ? this.ownedContext.retire(buffer) : this.sim._retire(buffer); }
  _buffer(label, bytes) {
    if (bytes > Math.min(MAX_BINDING, this.gpu.device?.limits?.maxStorageBufferBindingSize ?? MAX_BINDING)) throw new Error('raw source buffer exceeds default storage binding limit');
    return this.gpu.createBuffer({ label: `world source ${label}`, size: bytes, usage: USAGE });
  }
  _chunk(origin) {
    if(this.ownedContext&&!this.ownedContext.isValid())throw new Error('Invalid owned Source cut');
    const key = origin.join(','); let c = this.chunks.get(key);
    if (c && this.ownedContext) {
      c = this.ownedContext.writableChunk(c);
      this.chunks.set(key, c);
    }
    if (!c) {
      c = { key, origin: [...origin], g: SOURCE_GRID, copy: 0, highestRevision: 0,
        A: this._buffer(`${key} A`, SOURCE_GRID.slots * 16), B: this._buffer(`${key} B`, SOURCE_GRID.slots * 16),
        rank: new Uint8Array(SOURCE_GRID.slots), revisions: new Float64Array(SOURCE_GRID.slots),
        pending: new Float64Array(SOURCE_GRID.slots), aux: new Uint8Array(SOURCE_GRID.slots), wakeTrusted: new Uint8Array(SOURCE_GRID.slots).fill(1), flow: null, aeration: null, deco: null };
      this.chunks.set(key, c);
      this.ownedContext?.adoptChunk(c);
    }
    return c;
  }
  // The cached cores a box touches, not every cached chunk: a Descent load
  // caches thousands, and each gather planned against all of them (2026-10-21).
  // Cores are disjoint, so their copies land the same in any order.
  *_chunksIn(bounds) { for (const origin of this._cores(bounds)) { const c = this.chunks.get(origin.join(',')); if (c) yield c; } }
  *_cores(bounds) {
    const box = intersectBounds(bounds, { lo: [0, 0, 0], hi: this.context.size });
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
    const box = intersectBounds(bounds, { lo: [0, 0, 0], hi: this.context.size });
    if (!box) return 0;
    let cells = 0;
    for (const origin of this._cores(box)) {
      const c = this._chunk(origin); this._aux(c, src);
      const setRange = (d, length) => {
        c.rank.fill(rank, d, d + length); c.revisions.fill(revision, d, d + length);
        c.pending.fill(rank === SOURCE_RANK.captured ? revision : 0, d, d + length);
        c.aux.fill((src.flow ? 1 : 0) | (src.aeration ? 2 : 0) | (src.deco ? 4 : 0), d, d + length);
        c.wakeTrusted.fill(!src.aeration || (rank >= SOURCE_RANK.captured && src.boundedWake === true) ? 1 : 0, d, d + length);
        cells += length;
      };
      // Fresh LIVE is the highest authority. Its contiguous copy runs can
      // update metadata in bulk without rechecking every unchanged cell.
      const freshLive = rank === SOURCE_RANK.live && revision >= c.highestRevision;
      let livePlan;
      if (freshLive) {
        // Copy offsets within a state copy depend on layout/origin/bounds,
        // not state.cur, bytes, or semantic revision. Retain only this core's
        // latest geometry plan; native offsets still use the new snapshot.
        const key = `${src.g.nx},${src.g.ny},${src.g.nz},${src.g.slots};${src.origin};${box.lo};${box.hi}`;
        // Its metadata spans merge by destination alone: one fill per span, not
        // five per brick (0.5 s of a Descent load, 2026-10-21).
        if (c.liveCopyPlan?.key !== key) { const runs = planSourceCopies(src, c, box); c.liveCopyPlan = { key, runs, spans: destinationSpans(runs) }; }
        livePlan = c.liveCopyPlan;
      }
      const runs = freshLive ? livePlan.runs : planSourceCopies(src, c, box, (d) => {
        // A late static result cannot widen over a partial live/captured edge.
        if (rank < c.rank[d] || revision < c.revisions[d]) return false;
        c.rank[d] = rank; c.revisions[d] = revision;
        c.pending[d] = rank === SOURCE_RANK.captured ? revision : 0;
        c.aux[d] = (src.flow ? 1 : 0) | (src.aeration ? 2 : 0) | (src.deco ? 4 : 0);
        c.wakeTrusted[d] = !src.aeration || (rank >= SOURCE_RANK.captured && src.boundedWake === true) ? 1 : 0;
        cells++; return true;
      }, (d) => {
        for (let i = d; i < d + 64; i++) if (rank < c.rank[i] || revision < c.revisions[i]) return null;
        setRange(d, 64); return true;
      });
      if (freshLive) for (const r of livePlan.spans) setRange(r.dst, r.cells);
      if (runs.length) c.highestRevision = Math.max(c.highestRevision, revision);
      if (src.nativeSim) recordNativeRuns(frame, src, c, box, runs);
      else recordSourceCopies(frame, src, c, runs);
      // Absence is explicit zero, not permission to resurrect a previously
      // allocated auxiliary buffer. Disabled-but-kept aeration is discovered
      // by aerationForSource and therefore is NOT cleared here.
      for (const r of runs) {
        if (!src.flow && c.flow) frame.clear(c.flow, r.dst * 8, r.cells * 8);
        if (!src.aeration && c.aeration) frame.clear(c.aeration, r.dst * 8, r.cells * 8);
        if (!src.deco && c.deco) frame.clear(c.deco.buffer, r.dst * 4, r.cells * 4);
      }
    }
    return cells;
  }
  recordLeavingCopy(frame, sim, bounds, oldOrigin = sim.origin) {
    if (this.ownedContext) throw new Error('A Source cut cannot transfer current authority');
    if (isNativeSource(sim) && !nativeSourceReady(sim)) throw new Error('native world source pack is not ready');
    const revision = this.nextRevision(), src = liveSource(sim, oldOrigin);
    // Leaving live cells transfer ownership to captured; they are not stale
    // static data and must be allowed to replace the previous live revision.
    for (const c of this._chunksIn(bounds)) planSourceCopies(src, c, bounds,
      (d) => { c.rank[d] = Math.min(c.rank[d], SOURCE_RANK.captured); return false; },
      (d) => { for (let i = d; i < d + 64; i++) c.rank[i] = Math.min(c.rank[i], SOURCE_RANK.captured); return false; });
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
    if (this.ownedContext) throw new Error('A Source cut freezes pending persistence');
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
    if (this.ownedContext) throw new Error('A Source cut freezes generator inputs');
    if (this.disposed) return;
    this.nextRevision();
    this.minimumStaticRevision = this.revision;
    for (const c of this.chunks.values()) {
      for (let i = 0; i < c.rank.length; i++) if (c.rank[i] === SOURCE_RANK.generated) {
        c.rank[i] = SOURCE_RANK.unknown; c.revisions[i] = this.revision; c.whole = false;
      }
      c.highestRevision = Math.max(c.highestRevision, this.revision);
    }
  }
  recordStore(bounds, token = this.token()) {
    if (this.disposed || token.epoch !== this.epoch) return;
    const wb = this.context.wb;
    for (const [key, bytes] of this.context.store.map) {
      const origin = [key % wb[0] * 4, Math.floor(key / wb[0]) % wb[1] * 4, Math.floor(key / (wb[0] * wb[1])) * 4];
      const box = intersectBounds(bounds, { lo: origin, hi: origin.map((v) => v + 4) });
      if (!box) continue;
      const c = this._chunk(origin.map((v) => Math.floor(v / 32) * 32)), words = decodeSourceBrick(bytes);
      const src = { g: SOURCE_GRID, origin };
      const runs = planSourceCopies(src, c, box, (d) => {
        if (c.rank[d] > SOURCE_RANK.saved || c.revisions[d] > token.revision) return false;
        c.rank[d] = SOURCE_RANK.saved; c.revisions[d] = token.revision; return true;
      });
      if (runs.length) c.highestRevision = Math.max(c.highestRevision, token.revision);
      // Uploaded immutable store bytes only. Live state never reaches the CPU.
      for (const r of runs) for (const name of ['A', 'B']) this.recordUpload(this.gpu.frame, c[name], r.dst * 16, words[name].subarray(r.src * 4, (r.src + r.cells) * 4));
    }
    for (const [key, bytes] of this.ownedContext ? this.context.decoStore : this.sim.deco?.store ?? []) {
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
      for (const r of runs) this.recordUpload(this.gpu.frame, c.deco.buffer, r.dst * 4, words.subarray(r.src, r.src + r.cells));
    }
  }
  // Restore captured cells (including already committed exact source) AFTER
  // fill/store and BEFORE publishing live authority. No CPU readback.
  restoreCaptured(frame, sim, bounds) {
    if(this.ownedContext)throw new Error('An owned Source cut cannot restore current physics');
    const dst = snapshotSource(sim); let count = 0;
    for (const c of this._chunksIn(bounds)) {
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
    if (this.ownedContext) throw new Error('Release the owning Source cut instead of resetting it');
    for (const c of this.chunks.values()) for (const b of [c.A, c.B, c.flow, c.aeration, c.deco?.buffer]) if (b) this._retire(b);
    this.chunks.clear(); this.epoch = epoch; this.revision = 0; this.minimumStaticRevision = 0;
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
