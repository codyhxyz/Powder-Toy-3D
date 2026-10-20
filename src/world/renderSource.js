import { BRICK, cellSlot, slotCell, gridDims } from '../shaders/common.js';
import { decodeBrick, BRICK_FLOATS } from './store.js';
import { aerationForSource, isProducerBoundedAeration } from '../gfx/foam.js';
import { recordWorldSourceCut } from './sourceCut.js';
import { nativeAuxWGSL, NATIVE_AUX_LAYOUT } from '../shaders/renderSource.js';
import { fold } from '../gpu/kernels.js';

export const SOURCE_CORE = 32;
export const SOURCE_BRICK = BRICK;
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
// The V2 aux export. Physics V2 keeps its air per 4³ brick and its foam byte in
// its own cells (docs/v2.md §4.3), and its legacy projection (src/v2/physics.js
// exportLegacy) carries neither: B = 0, no aeration. So while V2 runs a World
// window, the drawn source takes B and the aeration lane from these two
// per-slot buffers instead (one copy each: bCopy, aerCopy 0), which the
// World's own live and leaving copies rewrite from V2's state just before they
// copy (liveSource's aux; shaders/renderSource.js nativeAuxWGSL). Not a
// deviation: the World then draws the air and foam the Box draws under V2,
// read from its atlas instead of V2's buffers. The edit projection (native)
// keeps the legacy lanes: it is written back into physics.
const nativeAux = new WeakMap();   // sim → { kernel, group, B, aeration }
function nativeAuxOf(sim, create = false) {
  const owner = sim.compact;
  if (!owner?.isReady || !owner.dynamics?.isReady || sim.disposed || sim.gpu?.failure) return null;
  let aux = nativeAux.get(sim);
  if (!aux && create) {
    const { gpu, g } = sim, usage = USAGE;   // (STORAGE | COPY_DST | COPY_SRC)
    const layout = gpu.layout('WORLD_NATIVE_AUX', NATIVE_AUX_LAYOUT);
    const B = gpu.createBuffer({ label: 'world V2 air (B)', size: g.slots * 16, usage });
    const aeration = gpu.createBuffer({ label: 'world V2 foam (aeration)', size: g.slots * 8, usage });
    aux = { B, aeration, kernel: gpu.kernel({ name: 'worldNativeAux', code: nativeAuxWGSL(g), layouts: [sim.L.TABLES, sim.L.STATE_RO, layout] }),
      group: gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: B } }, { binding: 1, resource: { buffer: aeration } }], 'world V2 aux') };
    nativeAux.set(sim, aux);
  }
  return aux?.kernel.state === 'ready' ? aux : null;
}
/** Free the V2 aux export's buffers (the window lets go of its sim: WorldWindow.dispose). */
export function dropNativeWorldAux(sim) {
  const aux = nativeAux.get(sim);
  if (!aux) return;
  nativeAux.delete(sim);
  for (const b of [aux.B, aux.aeration]) (sim.disposed || !sim._retire ? b.destroy() : sim._retire(b));
}
// Rewrite the V2 aux export from V2's current cells and air, if V2 runs the window.
function recordNativeAux(sim) {
  const aux = nativeAuxOf(sim, true), state = aux && sim.bindPhysicalRO;
  if (!state) return;
  sim._dispatch(aux.kernel, fold(Math.ceil(sim.g.slots / 64)), { bind: [sim.tables, state, aux.group], header: sim.readHeader({ physical: true }) });
}
export function snapshotSource(sim, origin = sim.origin, { native = false } = {}) {
  // Never retain sim.header(), sim.origin, state.cur's getter or another
  // mutable descriptor across a shift. Copies encode immutable byte offsets.
  const aer = aerationForSource(sim), v2 = native ? null : nativeAuxOf(sim);
  return Object.freeze({ g: Object.freeze({ ...sim.g }), origin: Object.freeze(originOf(origin)), copy: sim.cur,
    A: sim.state.A, B: v2?.B ?? sim.state.B, ...(v2 ? { bCopy: 0 } : {}), flow: sim.flow,
    aeration: v2?.aeration ?? aer?.buffer ?? null, aerCopy: v2 ? 0 : aer?.cur ?? 0, aerGeneration: v2 ? 0 : aer?.generation ?? 0,
    // (V2's export holds no wakes at all: its records' y is 0 or 1)
    boundedWake: !!v2 || !aer || isProducerBoundedAeration(aer),
    deco: sim.decoPlane ? Object.freeze({ ...sim.decoPlane }) : null });
}
// A raw read of the live cells. Physics V2 owns its cells and keeps A/B as a
// lazy projection (src/v2/physics.js exportLegacy): bring it up to date first.
// The export converts only the bricks whose projection changed since the last
// one, or all of them after a whole-grid write or a switch of projection.
// The drawn projection by default; native: the edit projection, for a read
// that is written back into physics. Without V2 (sim.compact unset) a no-op.
// aux: also bring the V2 aux export (above) up to date, for a copy that keeps
// B and the aeration lane (the World's live and leaving copies).
export function liveSource(sim, origin = sim.origin, { native = false, aux = false } = {}) {
  sim.legacyState?.(native);
  if (aux && !native) recordNativeAux(sim);
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
export function recordSourceCopies(frame, src, dst, runs, { aux = true } = {}) {
  const native = (a, ao, b, bo, n) => {
    if (ao < 0 || bo < 0 || ao + n > a.size || bo + n > b.size || [ao, bo, n].some(v => v % 4)) throw new Error('raw source copy exceeds its original buffer layout');
    frame.copy(a, ao, b, bo, n);
  };
  // (B's copy is A's, but for the V2 aux export's single copy: bCopy)
  const copyOf = (d, name) => (name === 'B' ? d.bCopy ?? d.copy : d.copy) ?? 0;
  for (const r of runs) {
    for (const name of ['A', 'B']) native(src[name], (copyOf(src, name) * src.g.slots + r.src) * 16,
      dst[name], (copyOf(dst, name) * dst.g.slots + r.dst) * 16, r.cells * 16);
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
  constructor(win, { context = null } = {}) {
    this.win = win; this.context = context ?? win; this.ownedContext = context;
    this.sim = win.sim; this.gpu = win.gpu;
    this.chunks = new Map(); this.epoch = win.epoch; this.revision = 0; this.contentRevision = 0;
    this.disposed = false; this.liveVersion = -1; this.minimumStaticRevision = 0;
    this.unsubscribeData = !context && win.scene.subscribeData?.(() => this.invalidateGenerated());
    this.auxContract = Object.freeze({ flow: 'original vec2u/slot', aeration: 'original vec2u/slot; captured current copy',
      deco: 'original RGBA8 u32/slot', persistence: 'A/B only; aux remains GPU-owned after store commit',
      histories: 'EMA/GI are renderer-owned; phase 2 must supply persistent world ownership',
      sourceStyle: 'scene importManifest/appearanceWords remain scene-owned; SourceStyle is view policy, not residency'  });
  }
  token() { return Object.freeze({ epoch: this.epoch, revision: this.revision, contentRevision: this.contentRevision }); }
  nextRevision() { return ++this.revision; }
  // Semantic writes, never ownership transfers. Advance authority too so a
  // producer awaiting readiness cannot publish over an intervening user edit.
  noteContentChange(change = sourceBounds(this.sim)) {
    if (this.ownedContext) throw new Error('An owned Source cut cannot accept current writes');
    if (this.disposed) return;
    this.contentRevision++;
    this.nextRevision();
    // Engine writers without a smaller box write only the live simulation.
    // Scene/global writers must explicitly declare global, never origin moves.
    const lo = change && !change.global && (change.lo || change.min);
    const hi = change && (change.lo ? change.hi : change.max);
    const bounded = Array.isArray(lo) && Array.isArray(hi) && lo.length === 3 && hi.length === 3 &&
      Number.isFinite(lo[0]) && Number.isFinite(lo[1]) && Number.isFinite(lo[2]) &&
      Number.isFinite(hi[0]) && Number.isFinite(hi[1]) && Number.isFinite(hi[2]) &&
      lo[0] <= hi[0] && lo[1] <= hi[1] && lo[2] <= hi[2];
    this.changeJournal ??= [];
    // Flat primitive records need one freeze, own no caller arrays, and can be
    // shared by cuts that copy only journal membership.
    this.changeJournal.push(Object.freeze(bounded ? { revision: this.contentRevision, global: false,
      loX: lo[0], loY: lo[1], loZ: lo[2], hiX: hi[0], hiY: hi[1], hiZ: hi[2] } :
      { revision: this.contentRevision, global: true }));
  }
  changesSince(token) {
    const current = this.contentToken();
    if (!token || token.epoch !== this.epoch || token.sourceRevision > this.contentRevision) return { token: current, global: true, changedBricks: [] };
    const changed = new Map(), size = this.context.size;
    for (const entry of this.changeJournal ?? []) if (entry.revision > token.sourceRevision) {
      if (entry.global) return { token: current, global: true, changedBricks: [] };
      const loX = Math.max(0, entry.loX), loY = Math.max(0, entry.loY), loZ = Math.max(0, entry.loZ);
      const hiX = Math.min(size[0], entry.hiX), hiY = Math.min(size[1], entry.hiY), hiZ = Math.min(size[2], entry.hiZ);
      if (loX < hiX && loY < hiY && loZ < hiZ) for (let z = Math.floor(loZ / 4); z < Math.ceil(hiZ / 4); z++)
        for (let y = Math.floor(loY / 4); y < Math.ceil(hiY / 4); y++)
          for (let x = Math.floor(loX / 4); x < Math.ceil(hiX / 4); x++) changed.set(`${x},${y},${z}`, [x, y, z]);
    }
    return { token: current, global: false, changedBricks: [...changed.values()] };
  }
  recordUpload(frame, target, offset, data) {
    const buffer = this.gpu.createBuffer({ label: 'immutable world source upload', size: data.byteLength, usage: 4, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    try { frame.copy(buffer, 0, target, offset, data.byteLength); }
    finally { this._retire(buffer); }
  }
  assertBoundedWake(regions) {
    for (const c of this.chunks.values()) {
      const allTrusted = !c.wakeTrusted.includes(0);
      for (const region of regions) {
        const box = intersectBounds(region, { lo: c.origin, hi: c.origin.map(v => v + 32) });
        if (!box || allTrusted) continue;
        for (let z = box.lo[2]; z < box.hi[2]; z++) for (let y = box.lo[1]; y < box.hi[1]; y++) for (let x = box.lo[0]; x < box.hi[0]; x++) {
          const slot = cellSlot(c.g, x - c.origin[0], y - c.origin[1], z - c.origin[2]);
          if ((c.aux[slot] & 2) && !c.wakeTrusted[slot]) throw new Error('Untrusted world aeration producer');
        }
      }
    }
  }
  contentToken() { return Object.freeze({ epoch: this.epoch, sourceRevision: this.contentRevision }); }
  recordCut(frame, options) {
    if (this.ownedContext) throw new Error('Capture cuts from the authoritative mutable Source');
    return recordWorldSourceCut(this, frame, options);
  }
  _retire(buffer) { return this.ownedContext ? this.ownedContext.retire(buffer) : this.sim._retire(buffer); }
  // Provider adapter contract. jetValidity must be attested by the adapter
  // after checking wake provenance; raw storage alone cannot prove bounded jets.
  snapshotForFields({ jetValidity, refreshLive = true } = {}) {
    if (refreshLive && this.needsLiveCopy()) this.recordLiveCopy(this.gpu.frame);
    const token = this.contentToken();
    const isCurrent = () => !this.disposed && (this.ownedContext ? this.ownedContext.isValid() : token.epoch === this.epoch && token.sourceRevision === this.contentRevision);
    const assertCurrent = () => { if (!isCurrent()) throw new Error('Stale world content snapshot'); };
    // World auxiliary ownership is not the local simulation's enable switch:
    // captured outside foam remains authoritative, absent cells gather zero.
    return Object.freeze({ ...token, jetValidity, aerationActive: true,
      scene: this.context.scene, appearanceWords: this.context.scene.appearanceWords ?? null,
      importManifest: this.context.scene.importManifest ?? null, auxContract: this.auxContract,
      isCurrent,
      assertComplete: (regions) => { assertCurrent(); return this.assertComplete(regions); },
      recordGatherRaw: (frame, request) => {
        assertCurrent();
        if (request.sourceRevision !== token.sourceRevision) throw new Error('Mismatched world content revision');
        return this.recordGatherRaw(frame, request);
      } });
  }
  assertComplete(regions) {
    if(this.ownedContext&&!this.ownedContext.isValid())throw new Error('Invalid owned Source cut');
    for (const region of regions) {
      const box = intersectBounds(region, { lo: [0, 0, 0], hi: this.context.size });
      if (!box) continue;
      // Ownership is stable during this synchronous preflight. Check the cut
      // once above, then scan the exact per-cell ranks without lookup objects.
      for(const origin of this._cores(box)){
        const c=this.chunks.get(origin.join(','));
        if(!c)throw new Error('Incomplete in-world raw source');
        const lo=box.lo.map((n,k)=>Math.max(0,n-origin[k]));
        const hi=box.hi.map((n,k)=>Math.min(SOURCE_CORE,n-origin[k]));
        if(lo.every(n=>n===0)&&hi.every(n=>n===SOURCE_CORE)){
          if(c.rank.includes(SOURCE_RANK.unknown))throw new Error('Incomplete in-world raw source');
        }else if(lo.every(n=>n%BRICK===0)&&hi.every(n=>n%BRICK===0)){
          // Field halos cut cores at brick boundaries: scan all 64 exact ranks,
          // not a cell address calculation per rank. No completeness cache.
          for(let z=lo[2];z<hi[2];z+=BRICK)for(let y=lo[1];y<hi[1];y+=BRICK)for(let x=lo[0];x<hi[0];x+=BRICK){
            const slot=cellSlot(c.g,x,y,z);
            if(c.rank.subarray(slot,slot+64).includes(SOURCE_RANK.unknown))throw new Error('Incomplete in-world raw source');
          }
        }else for(let z=lo[2];z<hi[2];z++)for(let y=lo[1];y<hi[1];y++)for(let x=lo[0];x<hi[0];x++){
          if(c.rank[cellSlot(c.g,x,y,z)]===SOURCE_RANK.unknown)throw new Error('Incomplete in-world raw source');
        }
      }
    }
    return true;
  }
  recordGatherRaw(frame, { resources, g, scratchOrigin, sourceRevision, stateCopy = 0, aerationCopy = 0 }) {
    if(this.ownedContext&&!this.ownedContext.isValid())throw new Error('Invalid owned Source cut');
    if (sourceRevision !== this.contentRevision) throw new Error('Stale world content gather');
    const bounds = { lo: scratchOrigin, hi: scratchOrigin.map((v, i) => v + [g.nx, g.ny, g.nz][i]) };
    this.assertComplete([bounds]); // preflight before encoding ANY work
    const dst = { ...resources, g, origin: [...scratchOrigin], copy: stateCopy, aerCopy: aerationCopy };
    // Outside-world scratch and explicitly absent aux are zero, not stale data.
    for (const name of ['A', 'B']) frame.clear(resources[name], stateCopy * g.slots * 16, g.slots * 16);
    if (resources.aeration) frame.clear(resources.aeration, aerationCopy * g.slots * 8, g.slots * 8);
    for (const c of this.chunks.values()) {
      const runs = planSourceCopies(c, dst, bounds, (_d, p) => c.rank[cellSlot(c.g, ...p.map((v, i) => v - c.origin[i]))] !== SOURCE_RANK.unknown, (_d,p)=>{
        const slot=cellSlot(c.g,p[0]-c.origin[0],p[1]-c.origin[1],p[2]-c.origin[2]);
        const ranks=c.rank.subarray(slot,slot+64);
        return !ranks.includes(SOURCE_RANK.unknown)?true:ranks.some(n=>n!==SOURCE_RANK.unknown)?null:false;
      });
      recordSourceCopies(frame, c, dst, runs);
    }
  }
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
        if (c.liveCopyPlan?.key !== key) c.liveCopyPlan = { key, runs: planSourceCopies(src, c, box) };
        livePlan = c.liveCopyPlan.runs;
      }
      const runs = freshLive ? livePlan : planSourceCopies(src, c, box, (d) => {
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
      if (freshLive) for (const r of runs) setRange(r.dst, r.cells);
      if (runs.length) c.highestRevision = Math.max(c.highestRevision, revision);
      recordSourceCopies(frame, src, c, runs);
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
  recordLiveCopy(frame, sim = this.sim, bounds = sourceBounds(sim)) {
    if (this.ownedContext) throw new Error('A Source cut cannot read newer live state');
    const revision = this.nextRevision(), src = liveSource(sim, sim.origin, { aux: true });
    this._record(frame, src, bounds, SOURCE_RANK.live, revision);
    this.liveVersion = sim.version; this.liveContentRevision = this.contentRevision; this.liveSnapshot = src;
    return revision;
  }
  needsLiveCopy(sim = this.sim) {
    if (this.ownedContext) return false;
    const a = this.liveSnapshot, b = snapshotSource(sim);
    return this.liveContentRevision !== this.contentRevision || this.liveVersion !== sim.version || !a || a.A !== b.A || a.B !== b.B || a.copy !== b.copy || a.bCopy !== b.bCopy ||
      a.origin.some((v, i) => v !== b.origin[i]) || a.flow !== b.flow || a.aeration !== b.aeration ||
      a.aerCopy !== b.aerCopy || a.aerGeneration !== b.aerGeneration || a.deco?.buffer !== b.deco?.buffer || a.deco?.offset !== b.deco?.offset;
  }
  recordLeavingCopy(frame, sim, bounds, oldOrigin = sim.origin) {
    if (this.ownedContext) throw new Error('A Source cut cannot transfer current authority');
    const revision = this.nextRevision(), src = liveSource(sim, oldOrigin, { aux: true });
    // Leaving live cells transfer ownership to captured; they are not stale
    // static data and must be allowed to replace the previous live revision.
    for (const c of this.chunks.values()) planSourceCopies(src, c, bounds,
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
    this.noteContentChange({ global: true });
    this.minimumStaticRevision = this.revision;
    for (const c of this.chunks.values()) {
      for (let i = 0; i < c.rank.length; i++) if (c.rank[i] === SOURCE_RANK.generated) {
        c.rank[i] = SOURCE_RANK.unknown; c.revisions[i] = this.revision;
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
  getSource(cell) {
    if(this.ownedContext&&!this.ownedContext.isValid())throw new Error('Invalid owned Source cut');
    const c = this.chunks.get(cell.map((v) => Math.floor(v / 32) * 32).join(','));
    if (!c) return { kind: 'unknown', epoch: this.epoch };
    const slot = cellSlot(c.g, ...cell.map((v, i) => v - c.origin[i])), rank = c.rank[slot];
    return { kind: Object.keys(SOURCE_RANK).find((k) => SOURCE_RANK[k] === rank), chunk: c, slot, revision: c.revisions[slot],
      pending: !!c.pending[slot], aux: c.aux[slot], epoch: this.epoch };
  }
  get bindings() { return { epoch: this.epoch, revision: this.revision, contentRevision: this.contentRevision, chunks: this.chunks, auxContract: this.auxContract,
    importManifest: this.context.scene.importManifest ?? null, appearanceWords: this.context.scene.appearanceWords ?? null, scene: this.context.scene }; }
  // Restore captured cells (including already committed exact source) AFTER
  // fill/store and BEFORE publishing live authority. No CPU readback.
  restoreCaptured(frame, sim, bounds) {
    if(this.ownedContext)throw new Error('An owned Source cut cannot restore current physics');
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
    if (count) sim.freshFlags({ residency: true });
    return count;
  }
  reset(epoch = this.epoch + 1) {
    if (this.ownedContext) throw new Error('Release the owning Source cut instead of resetting it');
    for (const c of this.chunks.values()) for (const b of [c.A, c.B, c.flow, c.aeration, c.deco?.buffer]) if (b) this._retire(b);
    this.chunks.clear(); this.changeJournal = []; this.epoch = epoch; this.revision = 0; this.contentRevision = 0; this.liveVersion = -1; this.liveSnapshot = null; this.minimumStaticRevision = 0;
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
