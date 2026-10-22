import { BRICK, cellSlot, slotCell, gridDims } from '../shaders/common.js';
import { decodeBrick, BRICK_FLOATS } from './store.js';
import { recordWorldSourceCut } from './sourceCut.js';
import { nativePackWGSL, NATIVE_PACK_LAYOUT, NativePackParams } from '../shaders/renderSource.js';
import { fold } from '../gpu/kernels.js';

export const SOURCE_CORE = 32;
export const SOURCE_BRICK = BRICK;
export const SOURCE_RANK = Object.freeze({ unknown: 0, generated: 1, saved: 2, captured: 3, live: 4 });
const RANK_NAMES = Object.freeze(Object.keys(SOURCE_RANK).reduce((names, k) => { names[SOURCE_RANK[k]] ??= k; return names; }, []));
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
// Physics V2 running the window: World's source reads V2's cells natively. Its live and leaving
// copies (and the tree producer's read of the live cells) pack the window's cores, with the air and
// foam the Box's draw reads beside them, straight into the source's targets through the read group
// (v2/physics.js readGroup: format 2, the cells and dynamics' current coarse air), by the decoders
// Box's format-2 draw reads them with (shaders/renderSource.js nativePackWGSL: compactA, viewRead.js
// nativeMotionB, fetchNativeAeration). Nothing is exported to V1's state for it: before, every V2
// tick exported V2's cells into V1's A (v2/physics.js exportLegacy), wrote the air and the foam
// into two more window-sized buffers, and copied the three into the source. Different code, the
// same words, so the same picture (CLAUDE.md "Same features in every world"; the GPU pixel
// comparison in the v2f/worldnative report). V1's copies below are V1's alone.
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

// A content delta (WorldRenderSource.changesSince): the bricks the journal's entries since a token
// cover, in the order the first entry that reached each one reached it (journal order, then z, y, x
// in its box). V2 journals its whole window every step (v2/physics.js _ran), so a span is mostly one
// box many times over: expanding every entry into a string-keyed Map was the World renderer's top
// JS cost after load, 2.6 s of 20 s on Island and 3.9 s on Descent (2026-10-22). Here a span is its
// distinct boxes (an entry inside an earlier one adds nothing), and changedBricks is built from them
// once, when first read: membership (includes) and the 32-cell cores (coreKeys) read the boxes.
const DELTA_BOXES_TESTED = 64;   // earlier boxes an entry is tested against for containment (bounds the scan; the stamp keeps the result exact)
const DELTA_BOXES_SCANNED = 16;  // boxes includes() scans directly; past this many it indexes the bricks once
const CORE_BRICKS = SOURCE_CORE / BRICK;
let deltaSeen = new Uint8Array(0);   // a span's bricks already listed (module scratch: a delta builds synchronously, then clears it)
export const changesSinceStats = { calls: 0, built: 0, entries: 0, boxes: 0, bricksVisited: 0, bricksListed: 0 };   // CPU check counters
function contentDelta(token, global, boxes) {
  let bricks = null, index = null;
  const list = () => {
    if (bricks) return bricks;
    const out = [];
    if (boxes.length === 1) {
      const [x0, y0, z0, x1, y1, z1] = boxes[0];
      for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(Object.freeze([x, y, z]));
      changesSinceStats.bricksVisited += out.length;
    } else if (boxes.length) {
      // Overlapping boxes: stamp each brick of their bounding box the first time a box reaches it.
      const lo = boxes[0].slice(0, 3), hi = boxes[0].slice(3);
      for (const b of boxes) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[k]); hi[k] = Math.max(hi[k], b[k + 3]); }
      const w = hi[0] - lo[0], h = hi[1] - lo[1], volume = w * h * (hi[2] - lo[2]);
      if (deltaSeen.length < volume) deltaSeen = new Uint8Array(volume);
      const seen = deltaSeen;
      for (const [x0, y0, z0, x1, y1, z1] of boxes) {
        for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) {
          const row = w * ((y - lo[1]) + h * (z - lo[2])) - lo[0];
          for (let x = x0; x < x1; x++) if (!seen[row + x]) { seen[row + x] = 1; out.push(Object.freeze([x, y, z])); }
        }
        changesSinceStats.bricksVisited += (x1 - x0) * (y1 - y0) * (z1 - z0);
      }
      seen.fill(0, 0, volume);
    }
    changesSinceStats.bricksListed += out.length;
    return (bricks = Object.freeze(out));
  };
  const inBox = (b, x, y, z) => x >= b[0] && x < b[3] && y >= b[1] && y < b[4] && z >= b[2] && z < b[5];
  const delta = { token, global };
  Object.defineProperty(delta, 'changedBricks', { enumerable: true, get: list });
  // Non-enumerable: a delta still compares equal to {token, global, changedBricks}.
  Object.defineProperties(delta, {
    // Whether brick [x, y, z] is one of changedBricks (a global delta lists none).
    includes: { value: (brick) => {
      const x = brick[0], y = brick[1], z = brick[2];
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
      if (boxes.length <= DELTA_BOXES_SCANNED) { for (let i = 0; i < boxes.length; i++) if (inBox(boxes[i], x, y, z)) return true; return false; }
      index ??= new Set(list().map(brickKeyOf));
      return index.has(`${x},${y},${z}`);
    } },
    // The keys ('x,y,z' of their cell origins) of the 32-cell cores changedBricks touch.
    coreKeys: { value: () => {
      const keys = new Set(), c = (v) => Math.floor(v / CORE_BRICKS);
      for (const [x0, y0, z0, x1, y1, z1] of boxes)
        for (let z = c(z0); z <= c(z1 - 1); z++) for (let y = c(y0); y <= c(y1 - 1); y++) for (let x = c(x0); x <= c(x1 - 1); x++)
          keys.add(`${x * SOURCE_CORE},${y * SOURCE_CORE},${z * SOURCE_CORE}`);
      return keys;
    } },
  });
  return Object.freeze(delta);
}
const brickKeyOf = (b) => `${b[0]},${b[1]},${b[2]}`;
// The span's distinct brick boxes [x0, y0, z0, x1, y1, z1] (journal order), or null when an entry is global.
function journalBoxes(journal, from, size) {
  // Revisions rise along the journal (noteContentChange): the span starts at the first one past from.
  let lo = 0, hi = journal.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (journal[mid].revision > from) hi = mid; else lo = mid + 1; }
  const boxes = [];
  changesSinceStats.entries += journal.length - lo;
  for (let i = lo; i < journal.length; i++) {
    const entry = journal[i];
    if (entry.global) return null;
    const loX = Math.max(0, entry.loX), loY = Math.max(0, entry.loY), loZ = Math.max(0, entry.loZ);
    const hiX = Math.min(size[0], entry.hiX), hiY = Math.min(size[1], entry.hiY), hiZ = Math.min(size[2], entry.hiZ);
    if (!(loX < hiX && loY < hiY && loZ < hiZ)) continue;
    const box = [Math.floor(loX / BRICK), Math.floor(loY / BRICK), Math.floor(loZ / BRICK), Math.ceil(hiX / BRICK), Math.ceil(hiY / BRICK), Math.ceil(hiZ / BRICK)];
    // (the first and the latest boxes: the window's, and where it walked to)
    let inside = false;
    const n = boxes.length, half = DELTA_BOXES_TESTED / 2;
    for (let k = 0; k < n && !inside; k = k + 1 === half && n > DELTA_BOXES_TESTED ? n - half : k + 1) {
      const b = boxes[k];
      inside = box[0] >= b[0] && box[1] >= b[1] && box[2] >= b[2] && box[3] <= b[3] && box[4] <= b[4] && box[5] <= b[5];
    }
    if (!inside) boxes.push(Object.freeze(box));
  }
  changesSinceStats.boxes += boxes.length;
  return Object.freeze(boxes);
}
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
// Copy plans of whole cores (no unknown rank) by their geometry relative to
// the destination: runs are slot offsets, the same at any common translation.
// A field scratch (fields.js, 64 cells at a core - 16) meets 27 offsets; other
// geometry is bounded by forgetting them all past this many.
const WHOLE_PLANS_KEPT = 1024;
const wholePlans = new Map();
function wholeCopies(src, dst, bounds) {
  const rel = (v) => v.map((n, i) => n - dst.origin[i]);
  const key = `${src.g.nx},${src.g.ny},${src.g.nz};${dst.g.nx},${dst.g.ny},${dst.g.nz};${rel(src.origin)};${rel(bounds.lo)};${rel(bounds.hi)}`;
  let runs = wholePlans.get(key);
  if (!runs) {
    if (wholePlans.size >= WHOLE_PLANS_KEPT) wholePlans.clear();
    wholePlans.set(key, runs = Object.freeze(planSourceCopies(src, dst, bounds).map(Object.freeze)));
  }
  return runs;
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
  const native = (a, ao, b, bo, n) => {
    if (ao < 0 || bo < 0 || ao + n > a.size || bo + n > b.size || [ao, bo, n].some(v => v % 4)) throw new Error('raw source copy exceeds its original buffer layout');
    frame.copy(a, ao, b, bo, n);
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
    const journal = this.changeJournal ??= [];
    // Flat primitive records need one freeze, own no caller arrays, and can be
    // shared by cuts that copy only journal membership.
    const entry = Object.freeze(bounded ? { revision: this.contentRevision, global: false,
      loX: lo[0], loY: lo[1], loZ: lo[2], hiX: hi[0], hiY: hi[1], hiZ: hi[2] } :
      { revision: this.contentRevision, global: true });
    // The same box as the latest entry replaces it: a span holds both or the
    // newer alone, so it reaches the same bricks in the same place in journal
    // order. V2 notes its whole window every step, and the journal grew by one
    // entry a step for as long as a World ran (cuts that copied it keep theirs).
    const last = journal.at(-1);
    if (bounded && last && !last.global && last.revision === entry.revision - 1 && last.loX === entry.loX && last.loY === entry.loY && last.loZ === entry.loZ &&
        last.hiX === entry.hiX && last.hiY === entry.hiY && last.hiZ === entry.hiZ) journal[journal.length - 1] = entry;
    else journal.push(entry);
  }
  // The bricks changed since token (contentToken), or global. Every caller in a
  // transaction may ask for the same span: the latest answer is kept until the
  // journal or the token moves (the delta is frozen; its bricks are shared).
  changesSince(token) {
    changesSinceStats.calls++;
    if (!token || token.epoch !== this.epoch || token.sourceRevision > this.contentRevision) return contentDelta(this.contentToken(), true, []);
    const journal = this.changeJournal ?? [], size = this.context.size, m = this._changesSinceMemo;
    if (m && m.journal === journal && m.length === journal.length && m.last === journal.at(-1) && m.from === token.sourceRevision &&
        m.epoch === this.epoch && m.contentRevision === this.contentRevision && m.size[0] === size[0] && m.size[1] === size[1] && m.size[2] === size[2]) return m.delta;
    changesSinceStats.built++;
    const boxes = journalBoxes(journal, token.sourceRevision, size);
    const delta = contentDelta(this.contentToken(), !boxes, boxes ?? []);
    this._changesSinceMemo = { journal, length: journal.length, last: journal.at(-1), from: token.sourceRevision, epoch: this.epoch,
      contentRevision: this.contentRevision, size: [...size], delta };
    return delta;
  }
  recordUpload(frame, target, offset, data) {
    const buffer = this.gpu.createBuffer({ label: 'immutable world source upload', size: data.byteLength, usage: 4, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    try { frame.copy(buffer, 0, target, offset, data.byteLength); }
    finally { this._retire(buffer); }
  }
  assertBoundedWake(regions) {
    // The cores each region touches, not every cached chunk per region (a
    // batched World load checks once per batch, 2026-10-21).
    // A core's whole-trust scan once per check, not once per region: a batch's
    // ~50 field regions overlap the same cores (Island, 2026-10-22). Never kept
    // between checks: trust is read as it is now.
    const trusted = new Map();
    for (const region of regions) for (const c of this._chunksIn(region)) {
      let all = trusted.get(c);
      if (all === undefined) trusted.set(c, all = !c.wakeTrusted.includes(0));
      if (all) continue;
      const box = intersectBounds(region, { lo: c.origin, hi: c.origin.map(v => v + 32) });
      if (!box) continue;
      for (let z = box.lo[2]; z < box.hi[2]; z++) for (let y = box.lo[1]; y < box.hi[1]; y++) for (let x = box.lo[0]; x < box.hi[0]; x++) {
        const slot = cellSlot(c.g, x - c.origin[0], y - c.origin[1], z - c.origin[2]);
        if ((c.aux[slot] & 2) && !c.wakeTrusted[slot]) throw new Error('Untrusted world aeration producer');
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
        // A core without one unknown rank holds every box in it. A rank turns
        // unknown only at the core's birth and in invalidateGenerated, which
        // clears c.whole, so a core found whole stays whole: scanning every
        // core per check took 1.7 s of a Descent load (2026-10-21).
        if(c.whole||!c.rank.includes(SOURCE_RANK.unknown)){c.whole=true;continue;}
        const lo=box.lo.map((n,k)=>Math.max(0,n-origin[k]));
        const hi=box.hi.map((n,k)=>Math.min(SOURCE_CORE,n-origin[k]));
        if(lo.every(n=>n===0)&&hi.every(n=>n===SOURCE_CORE)){
          throw new Error('Incomplete in-world raw source');
        }else if(lo.every(n=>n%BRICK===0)&&hi.every(n=>n%BRICK===0)){
          // Field halos cut cores at brick boundaries: scan all 64 exact ranks,
          // not a cell address calculation per rank.
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
    for (const c of this._chunksIn(bounds)) {
      // A core with no unknown rank copies every cell the box holds: its plan
      // is the box's geometry alone, shared by every gather at that offset.
      // Planning each anew was a fifth of a World load's CELL JS (2026-10-22).
      const runs = c.whole ? wholeCopies(c, dst, bounds) : planSourceCopies(c, dst, bounds, (_d, p) => c.rank[cellSlot(c.g, ...p.map((v, i) => v - c.origin[i]))] !== SOURCE_RANK.unknown, (_d,p)=>{
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
  recordLiveCopy(frame, sim = this.sim, bounds = sourceBounds(sim)) {
    if (this.ownedContext) throw new Error('A Source cut cannot read newer live state');
    // (V2: until its pack is built nothing is copied, and the copy stays wanted: needsLiveCopy)
    if (isNativeSource(sim) && !nativeSourceReady(sim)) return 0;
    const revision = this.nextRevision(), src = liveSource(sim, sim.origin);
    this._record(frame, src, bounds, SOURCE_RANK.live, revision);
    this.liveVersion = sim.version; this.liveContentRevision = this.contentRevision; this.liveSnapshot = src;
    return revision;
  }
  needsLiveCopy(sim = this.sim) {
    if (this.ownedContext) return false;
    const a = this.liveSnapshot, b = snapshotSource(sim);
    return this.liveContentRevision !== this.contentRevision || this.liveVersion !== sim.version || !a || a.A !== b.A || a.B !== b.B || a.copy !== b.copy ||
      a.nativeOwner !== b.nativeOwner ||
      a.origin.some((v, i) => v !== b.origin[i]) || a.flow !== b.flow || a.aeration !== b.aeration ||
      a.aerCopy !== b.aerCopy || a.aerGeneration !== b.aerGeneration || a.deco?.buffer !== b.deco?.buffer || a.deco?.offset !== b.deco?.offset;
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
    this.noteContentChange({ global: true });
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
  getSource(cell) {
    if(this.ownedContext&&!this.ownedContext.isValid())throw new Error('Invalid owned Source cut');
    // (a lighting record reads two a row: no arrays, joins or key search per read)
    const x = cell[0], y = cell[1], z = cell[2];
    const c = this.chunks.get(`${Math.floor(x / 32) * 32},${Math.floor(y / 32) * 32},${Math.floor(z / 32) * 32}`);
    if (!c) return { kind: 'unknown', epoch: this.epoch };
    const slot = cellSlot(c.g, x - c.origin[0], y - c.origin[1], z - c.origin[2]), rank = c.rank[slot];
    return { kind: RANK_NAMES[rank], chunk: c, slot, revision: c.revisions[slot],
      pending: !!c.pending[slot], aux: c.aux[slot], epoch: this.epoch };
  }
  get bindings() { return { epoch: this.epoch, revision: this.revision, contentRevision: this.contentRevision, chunks: this.chunks, auxContract: this.auxContract,
    importManifest: this.context.scene.importManifest ?? null, appearanceWords: this.context.scene.appearanceWords ?? null, scene: this.context.scene }; }
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
    if (count) sim.freshFlags({ residency: true });
    return count;
  }
  reset(epoch = this.epoch + 1) {
    if (this.ownedContext) throw new Error('Release the owning Source cut instead of resetting it');
    for (const c of this.chunks.values()) for (const b of [c.A, c.B, c.flow, c.aeration, c.deco?.buffer]) if (b) this._retire(b);
    this.chunks.clear(); this.changeJournal = []; this._changesSinceMemo = null; this.epoch = epoch; this.revision = 0; this.contentRevision = 0; this.liveVersion = -1; this.liveSnapshot = null; this.minimumStaticRevision = 0;
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
