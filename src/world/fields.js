import { gridDims, brickIdOf, LAYOUT } from '../shaders/common.js';
import { AGE, DIRTY, FIELD_EMA_SETTLE, dirtyLists } from '../shaders/fields.js';
import { fold } from '../gpu/kernels.js';
import { createFieldResources, createFieldLayouts, createFieldKernels, FieldDeriver, FIELD_TEXTURES } from '../gfx/fieldDeriver.js';
import { WorldFieldHistory, brickKey, coreKeyOf, ownerSlot, unsettledLive, CORE_SLOTS } from './fieldHistory.js';
import { fieldHistoryWGSL, FieldHistoryParams, FIELD_HISTORY_LAYOUT } from '../shaders/fieldHistory.js';

export const WORLD_FIELD_CORE = 32, WORLD_FIELD_HALO = 16, WORLD_FIELD_SCRATCH = 64;
// Backward demand, not Box COVER. Each reused scratch job recomputes all of it.
export const FIELD_DEMAND = Object.freeze({ peak: [0, 0, 0], boost2: [1, 1, 1], boost1: [1, 1, 2], boost0: [1, 2, 2],
  blur2: [2, 2, 2], blur1: [2, 2, 4], blur0: [2, 4, 4], ema: [4, 4, 4], raw: [8, 8, 8] });
export function fieldInterval(stage, guard = 0) {
  if (!Number.isInteger(guard) || guard < 0 || guard > 3) throw new Error('Unsupported field query guard');
  const r = FIELD_DEMAND[stage];
  if (!r) throw new Error(`Unknown field stage ${stage}`);
  return { lo: r.map((n) => 16 - guard - n), hi: r.map((n) => 48 + guard + n) };
}
function boxBricks(lo, hi, bounds) {
  const min = lo.map((v, i) => Math.max(v, bounds.min[i])), max = hi.map((v, i) => Math.min(v, bounds.max[i]));
  const out = [];
  if (min.some((v, i) => v >= max[i])) return out;
  for (let z = Math.floor(min[2] / 4); z < Math.ceil(max[2] / 4); z++) for (let y = Math.floor(min[1] / 4); y < Math.ceil(max[1] / 4); y++) {
    for (let x = Math.floor(min[0] / 4); x < Math.ceil(max[0] / 4); x++) out.push([x, y, z]);
  }
  return out;
}
// The cores (32-aligned, in cells) along one axis that brick coordinate v
// touches, the core grown by reach cells on each side: at most two.
function sideRange(v, reach, out, at) {
  let lo = 1, hi = 0;
  for (let c = Math.floor((v * 4 - 32 - reach) / 32) * 32; c < v * 4 + 4 + reach; c += 32) if (v * 4 < c + 32 + reach && v * 4 + 4 > c - reach) { if (lo > hi) lo = c; hi = c; }
  out[at] = lo; out[at + 1] = hi;
}
// A plan's change dilated over a dense box: at most this many cells a changed
// brick (and at least DILATE_MIN in all), else brick by brick (sparse changes).
const DILATE_SHARE = 8, DILATE_MIN = 1 << 15;
// Brick coordinates past the world a changed brick may have and still reach it.
const SIDE_MARGIN = 8;
// Scratch of a plan's dilation (module level: a plan builds synchronously).
let dilateFirst = new Int32Array(0), dilateA = new Uint8Array(0), dilateB = new Uint8Array(0);

// ---- the per-tick field GPU budget ----
// A field tick (wire/worldRender.js worldAdvanceFields) records at most this
// many workgroups of field work: its cores' EMA batches (history gathers, the
// EMA, history scatters: one workgroup a brick each) and the spatial jobs
// their invalidation sends to the CELL stage (worldClassify re-derives every
// invalidated core it demands: the EMA halo's gathers, seven stage dispatches
// over the whole 64^3 scratch, the classifier). V2 noted its whole window
// changed every tick, and one Descent tick's field work held the GPU, and every
// frame queued behind it, for about 10 s (real Chrome, 2026-10-22: one
// submission of `world field history` x80460 and `fieldEma` x180118
// workgroups, `fieldBlur` passes of 145k-500k).
//
// The rate: the field passes' full rebuild at 128^3 on the user's M5 (headless
// Chrome, ANGLE Metal; docs/scaling.md "D9, incremental derived passes": about
// 2.4 ms) is 32768 bricks through the eight per-brick field passes (the EMA, the
// three blurs, the three boost stages and the peak), a workgroup a brick and
// pass here: 262144 workgroups in 2.4 ms.
export const FIELD_WORKGROUPS_PER_MS = Math.round((128 / 4) ** 3 * 8 / 2.4);
// The share of a 60 Hz frame (16.7 ms) a tick's field work may hold the GPU:
// a quarter, the rest the frame's own draw and the lighting stages.
export const FIELD_TICK_MS = 4;
export const WORLD_FIELD_TICK_WORKGROUPS = FIELD_WORKGROUPS_PER_MS * FIELD_TICK_MS;
// Seven stage dispatches a spatial job (FieldDeriver.recordSpatial: three
// blurs, three boost stages, the peak), each over every scratch brick.
const SPATIAL_STAGES = 7;
// Owners by brick: history's, then a plan's new ones, by core and slot. A
// one-core cache: bricks visited in x runs share their core 8 at a time.
class OwnerFinder {
  constructor(history) { this.history = history; this.createdCores = new Map(); this.key = null; this.cx = NaN; this.cy = NaN; this.cz = NaN; this.a = null; this.b = null; }
  at(x, y, z) {
    const cx = Math.floor(x / 8), cy = Math.floor(y / 8), cz = Math.floor(z / 8);
    if (cx !== this.cx || cy !== this.cy || cz !== this.cz) {
      this.cx = cx; this.cy = cy; this.cz = cz; this.key = coreKeyOf(x, y, z);
      this.a = this.history.cores.get(this.key); this.b = this.createdCores.get(this.key);
    }
    const slot = ownerSlot(x, y, z);
    return (this.a && this.a[slot]) || (this.b && this.b[slot]);
  }
  add(owner) {
    const [x, y, z] = owner.brick, key = coreKeyOf(x, y, z);
    let slots = this.createdCores.get(key);
    if (!slots) { this.createdCores.set(key, (slots = new Array(CORE_SLOTS))); if (key === this.key) this.b = slots; }
    slots[ownerSlot(x, y, z)] = owner;
  }
}
function synchronous(result, label) {
  if (result && typeof result.then === 'function') throw new Error(`${label} must be a synchronous GPU recorder`);
  return result;
}
function assertComplete(source, regions) {
  if (synchronous(source.assertComplete(regions), 'assertComplete') === false) throw new Error('Incomplete in-world source halo');
}
function upload(gpu, label, data) {
  const buffer = gpu.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer.unmap();
  return buffer;
}

// A plan's owners by key ('x,y,z'): history's, then the ones it added.
class FieldOwners {
  constructor(base, find) { this.base = base; this.find = find; }
  get(key) { return this.base.get(key) ?? (/^-?\d+,-?\d+,-?\d+$/.test(key) ? this.find.at(...key.split(',').map(Number)) : undefined); }
  has(key) { return this.get(key) !== undefined; }
}

/**
 * Phase-2 numerical writer only: no draws, local-field proxies, or physics.
 *
 * sourceSnapshot is a pinned, immutable authority descriptor:
 *   { epoch, sourceRevision, jetValidity: 'producer-bounded-v1',
 *     aerationActive: true, assertComplete(regions), isCurrent(),
 *     recordGatherRaw(frame, request) }
 * assertComplete must throw for ANY unavailable in-world A/B/aeration neighbor.
 * recordGatherRaw copies full bit patterns GPU-to-GPU into explicit scratch
 * A/B/aeration (single copy, src=0/aer=1), including live/outgoing authority.
 * It fills the complete requested scratch/world intersection, never CPU reads.
 * jetValidity attests finite producer wake components |x,z,w| <= 1 after half
 * storage. Arbitrary high-speed/invalid wake imports must be rejected upstream.
 * changedBricks must include every raw/aux change since the last committed
 * tick (B/flow/deco-only changes may conservatively be included). Callbacks
 * are synchronous recorders; the caller pins source allocations through queue
 * completion and retires upload handles only after submission/completion.
 * No physics-origin parameter is accepted: shifting it cannot change history.
 *
 * publisher.recordOwnedFields must copy owned textures before scratch reuse and
 * return an opaque handle. publish sees only the complete generation. Neither
 * callback may enqueue deferred reads of borrowed scratch textures. publish
 * atomically applies the complete batch of changed owned cores to its retained
 * world snapshot; unchanged cores keep their prior numerically valid fields.
 */
export class WorldFields {
  // budget: workgroups a field tick may record (WORLD_FIELD_TICK_WORKGROUPS);
  // Infinity records every tick whole, as before the budget.
  constructor(gpu, { worldBounds, tables, tablesLayout = gpu.layout('TABLES', LAYOUT.TABLES), stateLayout = gpu.layout('STATE_RO', LAYOUT.STATE_RO),
    publisher, history = new WorldFieldHistory(gpu), budget = WORLD_FIELD_TICK_WORKGROUPS }) {
    if (!(budget > 0)) throw new Error('A field budget is a positive number of workgroups');
    if (!worldBounds || ['min', 'max'].some((k) => !Array.isArray(worldBounds[k]) || worldBounds[k].length !== 3) ||
      worldBounds.min.some((v, i) => !Number.isSafeInteger(v) || !Number.isSafeInteger(worldBounds.max[i]) || v >= worldBounds.max[i])) {
      throw new Error('Field world bounds must be nonempty integer cell intervals');
    }
    if (!publisher?.recordOwnedFields || !publisher?.publish) throw new Error('World fields require an owned-field publisher');
    Object.assign(this, { gpu, tables, publisher, history });
    this.bounds = { min: [...worldBounds.min], max: [...worldBounds.max] };
    this.g = gridDims({ nx: 64, ny: 64, nz: 64 });
    const g = this.g, U = GPUBufferUsage;
    const buffer = (label, size) => gpu.createBuffer({ label, size, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST });
    this.scratch = { ...createFieldResources(gpu, g, { label: (s) => `world ${s}`, normalizedCopySrc: true }), g,
      A: buffer('world raw A', g.slots * 16), B: buffer('world raw B', g.slots * 16), aeration: buffer('world raw aeration', g.slots * 8),
      age: buffer('world field ages', g.nbricks * 4), dlist: buffer('world field lists', dirtyLists(g).words * 4) };
    this.sourceGroup = gpu.bindGroup(stateLayout, [this.scratch.A, this.scratch.B].map((buffer, binding) => ({ binding, resource: { buffer } })), 'world field state');
    this.layouts = createFieldLayouts(gpu, 'WORLD_FIELD');
    this.kernels = createFieldKernels(gpu, g, { tablesLayout, stateLayout, layouts: this.layouts, domain: 'world' });
    this.deriver = new FieldDeriver(gpu, { g, resources: this.scratch, layouts: this.layouts, kernels: this.kernels, tables });
    this.deriver.setAeration({ buffer: this.scratch.aeration, active: true, copy: 0 });
    this.allLists = upload(gpu, 'world full field lists', this._lists(Array.from({ length: g.nbricks }, (_, i) => i)));
    // History pages <-> scratch EMA: one dispatch a copy run and slab (fieldHistory.js HistoryCopies).
    const copyLayout = gpu.layout('WORLD_FIELD_HISTORY', FIELD_HISTORY_LAYOUT);
    this.historyCopy = { layout: copyLayout, ema: this.scratch.ema,
      kernel: gpu.kernel({ name: 'world field history', code: fieldHistoryWGSL(g), layouts: [copyLayout], params: FieldHistoryParams }) };
    this.ready = Promise.all([...Object.values(this.kernels), this.historyCopy.kernel].map((k) => k.ready)).then(() => this);
    this.version = 0;
    this.generation = 0;
    this.lastTick = null;
    this.tickSource = null;
    this.smoothing = null;
    this.aerationActive = null;
    this.published = new Set();
    // When each published core was added, for invalidation in published order
    // without a pass over every published core per batch (record).
    this.publishedAt = new Map(); this.publishedSeq = 0;
    this.publishedToken = null;
    // The budget's backlog (_admit). pending: owners a field tick deferred,
    // each with whether it changed since it last advanced; they advance, whole
    // core by whole core, on a later tick, as if that tick were theirs.
    // waiting: the cores whose owners are pending, by the first tick they
    // waited. lagging: published cores whose invalidation is withheld, by the
    // first tick withheld: their EMA halo still holds a pending owner (or a
    // CELL batch changed it), so they keep their last whole publication (its
    // capture, and the CELL pages packed from it, of an earlier tick) and are
    // invalidated once no owner of the halo is pending. A core is never
    // derived from a halo with a pending owner.
    this.budget = budget;
    this.pending = new Map(); this.waiting = new Map(); this.lagging = new Map();
    this._planner();
  }
  // A plan's integer scratch (_owners): the world's cores, two past each side,
  // as stamps (touched cores, batches); each axis's sideRange for both reaches
  // a plan asks; and stamps by owner order (candidates, sort hint, recording).
  _planner() {
    const { min, max } = this.bounds;
    const pad = SIDE_MARGIN / 8 + 1, lo = min.map((v) => Math.floor(v / 32) - pad), dims = max.map((v, i) => Math.ceil(v / 32) + pad - lo[i]), cores = dims[0] * dims[1] * dims[2];
    this.coreGrid = { lo, dims, stamp: new Int32Array(cores), batch: new Int32Array(cores), mask: new Int32Array(cores), seen: new Int32Array(cores) };
    // Each axis's sideRange as where a brick sits in its own core: bit 0 when
    // it touches the core before, bit 1 the core after (both reaches touch at
    // most those); and the 27 cores around a core (bit (x+1) + 3 (y+1) + 9 (z+1))
    // each combination of the three axes' touches.
    this.sides = {};
    for (const reach of [4, 8]) this.sides[reach] = min.map((m, i) => {
      const v0 = Math.floor(m / 4) - SIDE_MARGIN, n = Math.ceil(max[i] / 4) + SIDE_MARGIN - v0, t = new Int32Array(2), c = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const v = v0 + k, own = Math.floor(v / 8) * 32;
        sideRange(v, reach, t, 0);
        if (t[0] < own - 32 || t[0] > own || t[1] < own || t[1] > own + 32) throw new Error('Field reach past a neighbouring core');
        c[k] = (t[0] < own ? 1 : 0) | (t[1] > own ? 2 : 0);
      }
      return { v0, n, c };
    });
    this.sideMasks = new Int32Array(64);
    for (let code = 0; code < 64; code++) for (let bit = 0; bit < 27; bit++) {
      const o = [bit % 3 - 1, Math.floor(bit / 3) % 3 - 1, Math.floor(bit / 9) - 1], c = [code & 3, (code >> 2) & 3, code >> 4];
      if (o.every((v, k) => v === 0 || (v < 0 ? c[k] & 1 : c[k] & 2))) this.sideMasks[code] |= 1 << bit;
    }
    this.serial = 0;
    this.byOrder = { seen: new Int32Array(0), index: new Int32Array(0), hint: new Int32Array(0), d: new Int32Array(0), slotSerial: new Int32Array(0), slot: new Int32Array(0) };
    this.sortHint = null; this.changeCache = null; this.batchCache = null;
  }
  // Stamps by owner order, for every order below n.
  _orders(n) {
    const o = this.byOrder;
    if (o.seen.length >= n) return o;
    const size = Math.max(n, 2 * o.seen.length, 1024);
    for (const k of Object.keys(o)) { const t = new Int32Array(size); t.set(o[k]); o[k] = t; }
    return o;
  }
  // The keys of every 32-aligned core that a brick of list touches, the core
  // grown by reach cells on each side (at most two cores a side): a brick's
  // own core and, by where it sits in it, which of the 26 around it (a mask a
  // brick into its core's stamp, then a string a touched core), not small
  // arrays and a set of strings a brick. Bricks past the side tables (a change
  // outside the world) take sideRange.
  _touched(list, reach) {
    const keys = [], extra = new Set(), { lo, dims, stamp, mask, seen } = this.coreGrid, serial = ++this.serial, sides = this.sides[reach], masks = this.sideMasks;
    const [s0, s1, s2] = sides, touched = [], r = new Int32Array(6), X = dims[0], XY = dims[0] * dims[1];
    const key = (x, y, z) => {
      const gx = x / 32 - lo[0], gy = y / 32 - lo[1], gz = z / 32 - lo[2];
      if (gx >= 0 && gx < dims[0] && gy >= 0 && gy < dims[1] && gz >= 0 && gz < dims[2]) {
        const at = gx + X * gy + XY * gz;
        if (seen[at] !== serial) { seen[at] = serial; keys.push(`${x},${y},${z}`); }
      } else { const k = `${x},${y},${z}`; if (!extra.has(k)) { extra.add(k); keys.push(k); } }
    };
    for (let i = 0; i < list.length; i++) {
      const b = list[i], ax = b[0] - s0.v0, ay = b[1] - s1.v0, az = b[2] - s2.v0;
      if (ax >= 0 && ax < s0.n && ay >= 0 && ay < s1.n && az >= 0 && az < s2.n) {
        const at = (Math.floor(b[0] / 8) - lo[0]) + X * (Math.floor(b[1] / 8) - lo[1]) + XY * (Math.floor(b[2] / 8) - lo[2]);
        if (stamp[at] !== serial) { stamp[at] = serial; mask[at] = 0; touched.push(at); }
        mask[at] |= masks[s0.c[ax] | s1.c[ay] << 2 | s2.c[az] << 4];
        continue;
      }
      for (let k = 0; k < 3; k++) sideRange(b[k], reach, r, 2 * k);
      for (let z = r[4]; z <= r[5]; z += 32) for (let y = r[2]; y <= r[3]; y += 32) for (let x = r[0]; x <= r[1]; x += 32) key(x, y, z);
    }
    for (const at of touched) {
      const m = mask[at], gx = at % X, gy = Math.floor(at / X) % dims[1], gz = Math.floor(at / XY);
      for (let bit = 0; bit < 27; bit++) if (m & (1 << bit)) key((gx + lo[0] + bit % 3 - 1) * 32, (gy + lo[1] + Math.floor(bit / 3) % 3 - 1) * 32, (gz + lo[2] + Math.floor(bit / 9) - 1) * 32);
    }
    return new Set(keys);
  }
  _lists(ids) {
    const d = dirtyLists(this.g), words = new Uint32Array(d.words);
    for (const list of [DIRTY.EMA, DIRTY.FIELDS, DIRTY.WORK]) {
      words.set(ids, list * this.g.nbricks);
      words[d.last + list] = ids.length;
    }
    return words;
  }
  // prior: the source plan (sourcePlan) of these same options, from before the
  // source was completed for it. Its owners and jobs do not depend on source
  // data, so plan() reuses them while nothing it read has changed: planning
  // each CELL batch twice was a sixth of a World load's CELL JS (2026-10-22).
  plan(options, prior = null) { return this._plan(options, true, prior); }
  sourcePlan(options) { return this._plan(options, false); }
  requiredSourceRegions(options) { return this.sourcePlan(options).regions; }
  // eye: the view's position in cells, or null: a budgeted field tick
  // records the cores nearest it first (_admit).
  _plan({ fieldTick, sourceSnapshot, wantedCores = [], changedBricks = [], smoothing = 1, full = false, eye = null }, preflight, prior = null) {
    const source = sourceSnapshot, epoch = this.history.epoch;
    if (!Number.isSafeInteger(fieldTick) || fieldTick < 0 || (this.lastTick !== null && fieldTick < this.lastTick)) throw new Error('Stale field tick');
    if (!Number.isFinite(smoothing) || smoothing < 0) throw new Error('Invalid field smoothing');
    if (!source || source.epoch !== epoch || source.sourceRevision == null || (preflight && source.jetValidity !== 'producer-bounded-v1') ||
      source.isCurrent?.() !== true || !source.assertComplete || !source.recordGatherRaw) throw new Error('Incomplete/stale/unsupported world field source');
    if (fieldTick === this.lastTick && source.sourceRevision !== this.tickSource) throw new Error('Source changed within a committed field tick');
    const aerationActive = source.aerationActive !== false;
    const jetToggle = this.aerationActive !== null && aerationActive !== this.aerationActive;
    // Everything the source-independent part reads: the options, and fields
    // state that only a commit, reset or cut switch changes.
    const inputs = { wantedCores, changedBricks, fieldTick, smoothing, full, jetToggle, epoch, version: this.version,
      publishedToken: this.publishedToken, publishedSize: this.published.size, lastSmoothing: this.smoothing, eye };
    const reuse = prior?.inputs && Object.keys(inputs).every((k) => prior.inputs[k] === inputs[k]);
    const { owners, find, advancing, nearAdvancing, nearChanged, jobs, batches, regions, changeCache, budget } = reuse ? prior : this._owners(inputs);
    if (preflight) assertComplete(source, regions); // exact same demand calculation before population
    return { epoch, fieldTick, sourceRevision: source.sourceRevision, source, version: this.version, smoothing, inputs,
      owners, find, advancing, changedBricks, nearAdvancing, nearChanged, aerationActive, batches, jobs, regions, changeCache, budget };
  }
  // A plan's owners, advancing owners, spatial jobs and source regions.
  //
  // The cost is the change's, not the window's: V2 notes its whole window every
  // step (renderSource.js changesSince), so changedBricks is every brick of it
  // each tick. Visiting each changed brick's 27 neighbours by string key was 2.2
  // million lookups a tick on Descent (2026-10-22). Here a dense change is
  // dilated over its box by integer stamps, owners are found by core and slot
  // (fieldHistory.js cores), and the candidates are put in history's order by
  // merging with the last plan's (sortHint), which they mostly repeat. Only a
  // new owner takes a string key. The plan is the one the pass over each
  // changed brick's neighbours made: the same owners, flags, order (a new
  // owner's order is the pass's first visit) and batches
  // (tools/world-field-owners-cpu-check.mjs compares them).
  _owners({ wantedCores, changedBricks, fieldTick, smoothing, full, jetToggle, eye }) {
    const cores = new Map(), { min, max } = this.bounds;
    for (const core of wantedCores) {
      if (!Array.isArray(core) || core.length !== 3 || core.some((v) => !Number.isSafeInteger(v) || v % 32)) throw new Error('World field cores must be 32-cell aligned');
      if (core.every((v, i) => v < max[i] && v + 32 > min[i])) cores.set(brickKey(core), [...core]);
    }
    // The last plan's change, when this one is the same bricks (V2's window
    // again, a new list a tick) and nothing it found has gone: its dilated
    // owners and touched cores again.
    const history = this.history, last = this.changeCache;
    let same = !!last && !last.pending && last.epoch === history.epoch && last.list.length === changedBricks.length;
    // (the very list again, frozen: checked when it was first planned)
    if (!(same && last.list === changedBricks && Object.isFrozen(changedBricks))) for (let i = 0; i < changedBricks.length; i++) {
      const b = changedBricks[i];
      if (!Array.isArray(b) || b.length !== 3 || !Number.isSafeInteger(b[0]) || !Number.isSafeInteger(b[1]) || !Number.isSafeInteger(b[2])) throw new Error('Invalid changed world brick');
      if (same) { const c = last.list[i]; same = c === b || (c[0] === b[0] && c[1] === b[1] && c[2] === b[2]); }
    }
    // History owners are shared and change only at a commit (history.commit):
    // a plan keeps the owners it adds, and flags the ones it changes.
    const find = new OwnerFinder(history), serial = ++this.serial, born = history.order;
    const cand = [], flags = [];
    let orders = this._orders(history.order + 1);
    const add = (owner, changed) => {
      const k = owner.order;
      if (orders.seen[k] !== serial) { orders.seen[k] = serial; orders.index[k] = cand.length; cand.push(owner); flags.push(changed ? 1 : 0); }
      else if (changed) flags[orders.index[k]] = 1;
    };
    const create = (x, y, z) => {
      const owner = { brick: [x, y, z], page: null, lastTick: null, age: 0, sourceVersion: null, order: history.order++ };
      if (owner.order >= orders.seen.length) orders = this._orders(owner.order + 1);
      find.add(owner);
      return owner;
    };
    // An aeration toggle changes every owner: the one whole pass left, and rare.
    if (jetToggle) for (const owner of history.owners.values()) add(owner, true);
    // Include all required authoritative EMA halos, not only visible owners.
    for (const core of cores.values()) {
      const a = core.map((v, i) => Math.max(v - 4, min[i])), b = core.map((v, i) => Math.min(v + 36, max[i]));
      if (a.some((v, i) => v >= b[i])) continue;
      for (let z = Math.floor(a[2] / 4); z < Math.ceil(b[2] / 4); z++) for (let y = Math.floor(a[1] / 4); y < Math.ceil(b[1] / 4); y++)
        for (let x = Math.floor(a[0] / 4); x < Math.ceil(b[0] / 4); x++) if (!find.at(x, y, z)) add(create(x, y, z), false);
    }
    // Raw/aux dirty support: JOIN_REACH=4 precedes the spatial reach. B/flow/
    // decoration-only changes may conservatively enter this same list.
    // The same change on a field tick (no wanted cores, no toggle): its
    // owners are already in history's order (sorted, all changed), so only
    // the unsettled owners outside it join them.
    let dilated = null;
    // (not with a backlog: its owners join with their own changed flags)
    const fast = same && !jetToggle && !cores.size && !!last.sorted && !this.pending.size;
    if (fast) { dilated = last.owners; for (const owner of last.sorted) orders.seen[owner.order] = serial; }
    else if (same) for (const owner of (dilated = last.owners)) add(owner, true);
    else if (changedBricks.length) { dilated = []; this._dilate(changedBricks, find, (owner) => { dilated.push(owner); orders.d[owner.order] = serial; add(owner, true); }, create); }
    // The owners a budgeted field tick deferred advance as if their tick were this one.
    for (const [owner, changed] of this.pending) if (owner.lastTick !== fieldTick) add(owner, changed);
    const extras = [];
    if (!jetToggle) for (const [tick, list] of history.unsettled) {
      if (tick === fieldTick) continue;
      let live = 0;
      for (const owner of list) if (unsettledLive(owner, tick)) {
        live++;
        if (orders.seen[owner.order] === serial) continue;
        if (fast) { orders.seen[owner.order] = serial; extras.push(owner); } else add(owner, false);
      }
      // Dead entries (advanced again, or settled) go on this visit.
      if (!live) history.unsettled.delete(tick);
      else if (live < list.length) { let n = 0; for (const owner of list) if (unsettledLive(owner, tick)) list[n++] = owner; list.length = n; }
    }
    // In history's order, then new owners in the order they were asked for: the
    // order a pass over every owner visited them.
    const sorted = fast ? this._withExtras(last, extras) : this._sorted(cand, flags, serial);
    // Which advance: when all do (a tick of the same change), the sorted list
    // itself, so the next check finds the last plan's batches by identity.
    let advancing = sorted.owners, changedFlags = sorted.flags, all = true;
    for (let i = 0; i < sorted.owners.length; i++) {
      const owner = sorted.owners[i];
      if (owner.lastTick === fieldTick) {
        if (jetToggle) throw new Error('Aeration changed within a committed field tick');
        all = false; continue;
      }
      // (a pending owner's next advance is the one the budget deferred: its tick, late)
      if (owner.page && owner.age < FIELD_EMA_SETTLE && fieldTick !== owner.lastTick + 1 && !this.pending.has(owner)) throw new Error('Missing dynamic field ticks; replay pinned snapshots first');
      if (!(!owner.page || sorted.flags[i] || owner.age < FIELD_EMA_SETTLE)) all = false;
    }
    if (!all) {
      advancing = []; changedFlags = [];
      for (let i = 0; i < sorted.owners.length; i++) {
        const owner = sorted.owners[i], changed = sorted.flags[i];
        if (owner.lastTick !== fieldTick && (!owner.page || changed || owner.age < FIELD_EMA_SETTLE)) { advancing.push(owner); changedFlags.push(changed); }
      }
    }
    const nearChanged = same ? last.nearChanged : this._touched(changedBricks, 8);
    // Kept while every owner it found is history's: at once from a plan that
    // made none, else once this plan commits (record), which makes them all
    // history's (a new owner always advances).
    const changeCache = same ? last : dilated ? { epoch: history.epoch, list: changedBricks, owners: dilated, nearChanged, pending: history.order !== born } : null;
    this.changeCache = changeCache;
    // Its owners in history's order, for a tick of the same change (fast above).
    if (changeCache && !changeCache.sorted && !jetToggle && !same) {
      changeCache.sorted = sorted.owners.filter((o) => orders.d[o.order] === serial);
      changeCache.ones = new Uint8Array(changeCache.sorted.length).fill(1);
    }
    // The last plan's batches and touched cores, when it advanced the same
    // owners with the same flags (a tick of the same change): grouped once.
    const was = this.batchCache;
    let again = !!was && was.epoch === history.epoch && was.advancing.length === advancing.length;
    if (again && !(was.advancing === advancing && was.flags === changedFlags)) for (let i = 0; again && i < advancing.length; i++) again = was.advancing[i] === advancing[i] && was.flags[i] === changedFlags[i];
    if (again) {
      const { batches, nearAdvancing } = was;
      return this._planOf({ cores, full, smoothing, history, find, advancing, nearAdvancing, nearChanged, batches, changeCache, fieldTick, eye });
    }
    const nearAdvancing = this._touched(advancing.map((o) => o.brick), 4);
    // Batches by core, in their first owner's order: a stamp a core.
    const batches = [], { lo, dims, stamp, batch: slot } = this.coreGrid, batchSerial = ++this.serial;
    for (let i = 0; i < advancing.length; i++) {
      const b = advancing[i].brick, cx = Math.floor(b[0] / 8), cy = Math.floor(b[1] / 8), cz = Math.floor(b[2] / 8);
      const at = (cx - lo[0]) + dims[0] * ((cy - lo[1]) + dims[1] * (cz - lo[2]));
      if (stamp[at] !== batchSerial) { stamp[at] = batchSerial; slot[at] = batches.length; batches.push({ core: [cx * 32, cy * 32, cz * 32], owners: [], changed: [] }); }
      const into = batches[slot[at]];
      into.owners.push(advancing[i]); into.changed.push(changedFlags[i]);
    }
    this.batchCache = { epoch: history.epoch, advancing, flags: changedFlags, batches, nearAdvancing };
    return this._planOf({ cores, full, smoothing, history, find, advancing, nearAdvancing, nearChanged, batches, changeCache, fieldTick, eye });
  }
  _planOf({ cores, full, smoothing, history, find, advancing, nearAdvancing, nearChanged, batches, changeCache, fieldTick, eye }) {
    let budget = null;
    if (Number.isFinite(this.budget)) ({ batches, advancing, nearAdvancing, budget } = this._admit({ cores, smoothing, batches, advancing, nearAdvancing, nearChanged, fieldTick, eye }));
    const lagging = budget ? this.lagging : null;
    // (a lagging core a CELL batch asks for is derived again: its capture is an earlier tick's)
    const jobs = [...cores.values()].filter((core) => full || this.smoothing !== smoothing || !this.published.has(brickKey(core)) ||
      nearAdvancing.has(brickKey(core)) || nearChanged.has(brickKey(core)) || !!lagging?.has(brickKey(core)));
    const regions = [...batches, ...jobs.map((core) => ({ core }))].map(({ core }) => {
      const origin = core.map((v) => v - 16);
      return { origin, lo: origin.map((v, i) => Math.max(v, this.bounds.min[i])), hi: origin.map((v, i) => Math.min(v + 64, this.bounds.max[i])) };
    });
    return { owners: new FieldOwners(history.owners, find), find, advancing, nearAdvancing, nearChanged, jobs, batches, regions, changeCache, budget };
  }
  // A batch's workgroups (record): its gathers (an owner with a page each), the
  // EMA and its scatters (one an owner each).
  _batchWorkgroups(batch) {
    let paged = 0;
    for (const owner of batch.owners) if (owner.page) paged++;
    return 2 * batch.owners.length + paged;
  }
  // A spatial job's workgroups at core (record's jobs): its EMA halo's gathers
  // (an in-world brick of the halo each), the stage dispatches over every
  // scratch brick, the classifier (an in-world brick of the core each).
  _jobWorkgroups(core) {
    const { min, max } = this.bounds, interval = fieldInterval('ema');
    const bricks = (lo, hi) => lo.reduce((n, v, i) => n * Math.max(0, Math.ceil(Math.min(hi[i], max[i]) / 4) - Math.floor(Math.max(v, min[i]) / 4)), 1);
    const origin = core.map((v) => v - 16);
    return bricks(origin.map((v, i) => v + interval.lo[i]), origin.map((v, i) => v + interval.hi[i])) + SPATIAL_STAGES * this.g.nbricks +
      bricks(core, core.map((v) => v + 32));
  }
  // The batches a budgeted plan records now, and the rest deferred, whole core
  // by whole core.
  //
  // A field tick (no wanted cores) takes, in order, the oldest waiting first,
  // then the nearest the eye, then history's order: each core's batch, with the
  // published cores it leaves no pending owner near (their CELL stage jobs),
  // or a lagging core no pending owner is near any more; each that fits what
  // is left of the budget (and always the first one, so the backlog drains:
  // a skipped item is older on the next tick). A
  // published core near an advancing owner, or near a change, is invalidated
  // only once no owner of its EMA halo is pending, else withheld (lagging).
  // Its invalidation's jobs are the CELL stage's (worldClassify), counted here.
  //
  // A CELL batch (wanted cores) records what it needs: every batch with an
  // owner the backlog does not hold (new halos, which are born settled), and a
  // pending core's whole batch when an owner of it is in a wanted core's EMA
  // halo (that job reads it), late in its tick but in it. Its own changes to
  // published cores are withheld (lagging): the field tick has already judged
  // which CELL pages are current, and the stage packs only those it lacks.
  //
  // A smoothing change re-derives every published core (_invalidated): such a
  // tick is recorded whole.
  _admit({ cores, smoothing, batches, advancing: all, nearAdvancing, nearChanged, fieldTick, eye }) {
    const pending = this.pending, published = this.published, admitted = [], deferred = [];
    const invalidate = new Set(), withhold = new Set();
    const touchOf = (batch) => this._touched(batch.owners.map((o) => o.brick), 4);
    let workgroups = 0;
    if (cores.size || (this.smoothing !== null && this.smoothing !== smoothing)) {
      for (const batch of batches) {
        let needed = !cores.size || batch.owners.some((o) => !pending.has(o));
        if (!needed) for (const key of touchOf(batch)) if (cores.has(key)) { needed = true; break; }
        if (needed) { admitted.push(batch); workgroups += this._batchWorkgroups(batch); } else deferred.push(batch);
      }
      const touched = admitted.length ? this._touched(admitted.flatMap((b) => b.owners.map((o) => o.brick)), 4) : new Set();
      if (cores.size) for (const near of [touched, nearChanged]) for (const key of near) if (published.has(key)) withhold.add(key);
      return this._admitted(batches, all, admitted, deferred, touched, { invalidate, withhold, workgroups, deferredWorkgroups: 0, firstWorkgroups: 0 });
    }
    // No backlog, and the whole tick within the budget: all of it, as unbudgeted
    // (the plan's own touched cores; no batch's own).
    if (!pending.size && !this.lagging.size) {
      for (const batch of batches) workgroups += this._batchWorkgroups(batch);
      const near = new Set();
      for (const set of [nearAdvancing, nearChanged]) for (const key of set) if (published.has(key) && !near.has(key)) { near.add(key); workgroups += this._jobWorkgroups(key.split(',').map(Number)); }
      if (workgroups <= this.budget) return this._admitted(batches, all, batches, [], nearAdvancing, { invalidate: near, withhold, workgroups, deferredWorkgroups: 0, firstWorkgroups: workgroups });
      workgroups = 0;
    }
    // Each batch's touched cores; and how many batches touch each core.
    const touch = batches.map(touchOf), blockers = new Map(), targets = new Set();
    for (const t of touch) for (const key of t) { blockers.set(key, (blockers.get(key) ?? 0) + 1); if (published.has(key)) targets.add(key); }
    for (const key of nearChanged) if (published.has(key)) targets.add(key);
    for (const key of this.lagging.keys()) if (published.has(key)) targets.add(key);
    const items = [], coreOf = (key) => key.split(',').map(Number);
    batches.forEach((batch, i) => items.push({ i, key: brickKey(batch.core), core: batch.core }));
    for (const key of targets) if (!blockers.get(key)) items.push({ i: -1, key, core: coreOf(key) });
    const at = new Map(items.map((it, k) => [it, k])), since = (it) => (it.i < 0 ? this.lagging.get(it.key) : this.waiting.get(it.key)) ?? fieldTick;
    const distance = (core) => (eye ? Math.hypot(...core.map((v, k) => v + 16 - eye[k])) : 0);
    for (const it of items) { it.since = since(it); it.distance = distance(it.core); }
    items.sort((a, b) => a.since - b.since || a.distance - b.distance || at.get(a) - at.get(b));
    const taken = new Set(), skipped = [];
    let firstWorkgroups = 0, k = 0;
    // First fit in that order: an item over what is left waits (it is older
    // next tick, so it goes first then: the first item is always taken). A
    // published core a taken batch leaves no pending owner near is a job of
    // its own, tried at once: one that does not fit stays lagging (its last
    // whole publication, of an earlier tick) and waits for a later one.
    const take = (it, cost) => {
      if (k++ && workgroups + cost > this.budget) return false;
      if (k === 1) firstWorkgroups = cost;
      workgroups += cost;
      return true;
    };
    for (const it of items) {
      if (it.i < 0) { if (take(it, this._jobWorkgroups(it.core))) invalidate.add(it.key); else skipped.push(it); continue; }
      if (!take(it, this._batchWorkgroups(batches[it.i]))) { skipped.push(it); continue; }
      taken.add(it.i);
      for (const key of touch[it.i]) {
        const left = blockers.get(key) - 1;
        blockers.set(key, left);
        if (!left && targets.has(key) && !take(null, this._jobWorkgroups(coreOf(key)))) continue;
        if (!left && targets.has(key)) invalidate.add(key);
      }
    }
    let deferredWorkgroups = 0;
    for (const it of skipped) deferredWorkgroups += it.i < 0 ? this._jobWorkgroups(it.core) : this._batchWorkgroups(batches[it.i]);
    for (const key of targets) if (!invalidate.has(key)) withhold.add(key);
    batches.forEach((batch, i) => (taken.has(i) ? admitted : deferred).push(batch));
    const touched = new Set();
    for (const i of taken) for (const key of touch[i]) touched.add(key);
    return this._admitted(batches, all, admitted, deferred, touched, { invalidate, withhold, workgroups, deferredWorkgroups, firstWorkgroups });
  }
  // (all admitted: the plan's own advancing list, in history's order)
  _admitted(batches, all, admitted, deferred, nearAdvancing, budget) {
    const advancing = admitted.length === batches.length ? all : admitted.flatMap((b) => b.owners);
    return { batches: admitted, advancing, nearAdvancing, budget: { ...budget, deferred } };
  }
  // Every brick within one brick of a changed one (the cells JOIN_REACH 4
  // reaches, in bounds) changes: each owner is flagged, and an absent one is
  // made, in the order a pass over each changed brick's neighbours (z, y, x)
  // first visited it.
  _dilate(list, find, add, create) {
    const { min, max } = this.bounds, bmin = min.map((v) => Math.floor(v / 4)), bmax = max.map((v) => Math.ceil(v / 4));
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const b of list) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); z0 = Math.min(z0, b[2]); x1 = Math.max(x1, b[0]); y1 = Math.max(y1, b[1]); z1 = Math.max(z1, b[2]); }
    const g0 = [x0 - 1, y0 - 1, z0 - 1], w = x1 - x0 + 3, h = y1 - y0 + 3, d = z1 - z0 + 3, volume = w * h * d;
    if (!(volume <= Math.max(DILATE_MIN, DILATE_SHARE * list.length))) {
      // Sparse: the changed bricks one by one, their neighbours each once.
      const visited = new Set();
      for (const b of list) {
        const a = b.map((v, i) => Math.max(v * 4 - 4, min[i])), c = b.map((v, i) => Math.min(v * 4 + 8, max[i]));
        if (a.some((v, i) => v >= c[i])) continue;
        for (let z = Math.floor(a[2] / 4); z < Math.ceil(c[2] / 4); z++) for (let y = Math.floor(a[1] / 4); y < Math.ceil(c[1] / 4); y++) for (let x = Math.floor(a[0] / 4); x < Math.ceil(c[0] / 4); x++) {
          const key = `${x},${y},${z}`;
          if (visited.has(key)) continue;
          visited.add(key);
          add(find.at(x, y, z) ?? create(x, y, z), true);
        }
      }
      return;
    }
    if (dilateFirst.length < volume) { dilateFirst = new Int32Array(volume); dilateA = new Uint8Array(volume); dilateB = new Uint8Array(volume); }
    const first = dilateFirst, A = dilateA, B = dilateB, wh = w * h;
    first.fill(0, 0, volume);
    // Each changed brick's first place in the list, from 1.
    for (let i = 0; i < list.length; i++) { const b = list[i], at = (b[0] - g0[0]) + w * ((b[1] - g0[1]) + h * (b[2] - g0[2])); if (!first[at]) first[at] = i + 1; }
    // Grown by one brick along x, then y, then z. The box has a free brick each
    // side, so its edges only lose neighbours outside it, which hold nothing.
    for (let row = 0; row < volume; row += w) {
      A[row] = first[row] !== 0 || first[row + 1] !== 0 ? 1 : 0;
      for (let i = row + 1, end = row + w - 1; i < end; i++) A[i] = first[i - 1] !== 0 || first[i] !== 0 || first[i + 1] !== 0 ? 1 : 0;
      A[row + w - 1] = first[row + w - 2] !== 0 || first[row + w - 1] !== 0 ? 1 : 0;
    }
    for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) {
      const row = w * (y + h * z), below = y > 0 ? row - w : -1, above = y < h - 1 ? row + w : -1;
      for (let x = 0; x < w; x++) B[row + x] = A[row + x] | (below >= 0 ? A[below + x] : 0) | (above >= 0 ? A[above + x] : 0);
    }
    for (let z = 0; z < d; z++) {
      const plane = wh * z, back = z > 0 ? plane - wh : -1, front = z < d - 1 ? plane + wh : -1;
      for (let i = 0; i < wh; i++) A[plane + i] = B[plane + i] | (back >= 0 ? B[back + i] : 0) | (front >= 0 ? B[front + i] : 0);
    }
    const lo = g0.map((v, i) => Math.max(v, bmin[i])), hi = [w, h, d].map((n, i) => Math.min(g0[i] + n, bmax[i]));
    const absent = [];
    // Row by row, a core's run of a row at a time: its slots looked up once.
    const cores = this.history.cores, created = find.createdCores;
    for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) {
      const row = w * ((y - g0[1]) + h * (z - g0[2])) - g0[0], cy = Math.floor(y / 8) * 32, cz = Math.floor(z / 8) * 32, rowSlot = ownerSlot(0, y, z);
      for (let x = lo[0]; x < hi[0];) {
        const cx = Math.floor(x / 8), end = Math.min(hi[0], cx * 8 + 8);
        let a = null, b = null, looked = false;
        for (; x < end; x++) {
          if (!A[row + x]) continue;
          if (!looked) { const key = `${cx * 32},${cy},${cz}`; a = cores.get(key); b = created.get(key); looked = true; }
          const slot = rowSlot + (x & 7), owner = (a && a[slot]) || (b && b[slot]);
          if (owner) add(owner, true); else absent.push(x, y, z);
        }
      }
    }
    if (!absent.length) return;
    // An absent brick's first visit: the first changed brick next to it, and
    // its place in that brick's neighbour box (z, y, x, clipped to bounds).
    // Sorted as one number a brick, first visit then place (exact below 2^53),
    // else as pairs.
    const PLACE = 2 ** 21, typed = absent.length / 3 < PLACE && list.length * 27 < 2 ** 31;
    const visits = typed ? new Float64Array(absent.length / 3) : new Array(absent.length / 3);
    for (let k = 0; k < absent.length; k += 3) {
      const x = absent[k], y = absent[k + 1], z = absent[k + 2];
      let best = Infinity;
      for (let cz = z - 1; cz <= z + 1; cz++) for (let cy = y - 1; cy <= y + 1; cy++) for (let cx = x - 1; cx <= x + 1; cx++) {
        const gx = cx - g0[0], gy = cy - g0[1], gz = cz - g0[2];
        if (gx < 0 || gy < 0 || gz < 0 || gx >= w || gy >= h || gz >= d) continue;
        const at = first[gx + w * (gy + h * gz)];
        if (!at) continue;
        const lx = Math.max(cx - 1, bmin[0]), ly = Math.max(cy - 1, bmin[1]), lz = Math.max(cz - 1, bmin[2]);
        const nx = Math.min(cx + 2, bmax[0]) - lx, ny = Math.min(cy + 2, bmax[1]) - ly;
        best = Math.min(best, (at - 1) * 27 + ((z - lz) * ny + (y - ly)) * nx + (x - lx));
      }
      visits[k / 3] = typed ? best * PLACE + k / 3 : [best, k];
    }
    if (typed) visits.sort(); else visits.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < visits.length; i++) { const k = typed ? 3 * (visits[i] % PLACE) : visits[i][1]; add(create(absent[k], absent[k + 1], absent[k + 2]), true); }
  }
  // A change's sorted owners (all changed) with extras (unchanged, unsorted)
  // merged in.
  _withExtras(cache, extras) {
    if (!extras.length) { this.sortHint = cache.sorted; return { owners: cache.sorted, flags: cache.ones }; }
    extras.sort((a, b) => a.order - b.order);
    const d = cache.sorted, owners = new Array(d.length + extras.length), flags = new Uint8Array(owners.length);
    let i = 0, j = 0, n = 0;
    while (i < d.length || j < extras.length) {
      if (j >= extras.length || (i < d.length && d[i].order < extras[j].order)) { owners[n] = d[i++]; flags[n++] = 1; }
      else { owners[n] = extras[j++]; flags[n++] = 0; }
    }
    this.sortHint = owners;
    return { owners, flags };
  }
  // cand (with flags) in owner order: the last plan's sorted candidates that
  // are candidates again, merged with the rest sorted (a typed sort of order
  // and place): a whole sort of ~90k owners a tick on Descent cost more than
  // the rest of the plan.
  _sorted(cand, flags, serial) {
    const orders = this._orders(this.history.order + 1), hinted = [];
    if (this.sortHint) for (const owner of this.sortHint) {
      const k = owner.order;
      if (k < orders.seen.length && orders.seen[k] === serial && orders.hint[k] !== serial) { orders.hint[k] = serial; hinted.push(owner); }
    }
    let rest = [];
    for (let i = 0; i < cand.length; i++) if (orders.hint[cand[i].order] !== serial) rest.push(i);
    if (rest.length > 1) {
      const PLACE = 2 ** 21;
      if (rest.length < PLACE && this.history.order < 2 ** 31) {
        const keys = new Float64Array(rest.length);
        for (let i = 0; i < rest.length; i++) keys[i] = cand[rest[i]].order * PLACE + i;
        keys.sort();
        const was = rest; rest = new Array(was.length);
        for (let i = 0; i < keys.length; i++) rest[i] = was[keys[i] % PLACE];
      } else rest.sort((a, b) => cand[a].order - cand[b].order);
    }
    const out = new Uint8Array(cand.length);
    if (!rest.length) {
      for (let k = 0; k < hinted.length; k++) out[k] = flags[orders.index[hinted[k].order]];
      this.sortHint = hinted;
      return { owners: hinted, flags: out };
    }
    const owners = new Array(cand.length);
    let i = 0, j = 0, n = 0;
    while (i < hinted.length || j < rest.length) {
      const a = hinted[i], b = j < rest.length ? cand[rest[j]] : null;
      const owner = a && (!b || a.order < b.order) ? (i++, a) : (j++, b);
      owners[n] = owner; out[n++] = flags[orders.index[owner.order]];
    }
    this.sortHint = owners;
    return { owners, flags: out };
  }
  record(frame, plan) {
    if (plan.epoch !== this.history.epoch || plan.version !== this.version || plan.source.isCurrent() !== true) throw new Error('Stale world field plan');
    if (Object.values(this.kernels).some((k) => k.state !== 'ready') || this.historyCopy.kernel.state !== 'ready') throw new Error('World field kernels not ready');
    assertComplete(plan.source, plan.regions);
    const r = this.scratch, uploads = [], allocated = [], outputs = [], replaced = [];
    // Shared owners again: an advancing one changes only at the commit below
    // (history.commit); until then its next page is advanced's (by order).
    const advanced = [], pages = [], ages = [], at = ++this.serial;
    let orders = this._orders(this.history.order);
    const header = { src: 0, dst: 0, origin: [0, 0, 0] };
    const domain = (origin, interval) => ({ worldMin: this.bounds.min, worldMax: this.bounds.max, scratchOrigin: origin, ...interval });
    const gatherRaw = (origin) => synchronous(plan.source.recordGatherRaw(frame, { resources: { A: r.A, B: r.B, aeration: r.aeration },
      g: this.g, scratchOrigin: origin, worldBounds: this.bounds, sourceRevision: plan.sourceRevision, stateCopy: 0, aerationCopy: 0 }), 'recordGatherRaw');
    let committed = false;
    this.deriver.setAeration({ buffer: r.aeration, copy: 0, active: plan.aerationActive });
    try {
      // Every history copy is staged before any is recorded, into one job list
      // (fieldHistory.js HistoryCopies): the owners a batch advances, the pages
      // it allocates and each job's halo pages are the ones recording them in
      // turn would see, and the list is uploaded before its first dispatch.
      const copies = this.history.copies(this.historyCopy), batches = [], jobs = [], g = this.g;
      // A batch's scratch is its core grown by 16 cells: a brick's id there is its slot's.
      const ids0 = this.slotIds ??= Int32Array.from({ length: CORE_SLOTS }, (_, k) => brickIdOf(g, (k & 7) + 4, ((k >> 3) & 7) + 4, (k >> 6) + 4));
      for (const batch of plan.batches) {
        const origin = batch.core.map((v) => v - 16);
        const ids = [], gather = copies.begin(false), owners = batch.owners;
        let ages0 = null;   // only a batch with a fresh brick has an age that is not 0
        for (let k = 0; k < owners.length; k++) {
          const owner = owners[k], b = owner.brick, id = ids0[ownerSlot(b[0], b[1], b[2])];
          ids.push(id);
          if (owner.page) copies.add(id, owner.page);
          else (ages0 ??= new Uint32Array(g.nbricks))[id] = AGE.FRESH;
        }
        copies.end();
        const scatter = copies.begin(true);
        for (let k = 0; k < owners.length; k++) {
          const owner = owners[k], page = this.history.allocate(); allocated.push(page);
          copies.add(ids[k], page);
          // A brick with no history starts over at its target (AGE.FRESH above),
          // and that is the blend's 8-bit fixed point: blending toward the same
          // target rounds back to it, for every channel's weight
          // (tools/world-tick-repack-cpu-check.mjs proves it). So it is born settled,
          // as an owner FIELD_EMA_SETTLE ticks past its last change is: only a
          // change makes it advance again. Born unsettled, every brick of a big
          // map's load advanced for FIELD_EMA_SETTLE more ticks, the same bytes
          // each time, and every core of it was derived and packed again
          // (Island's second tick: 400k owners, a 9.75 s stall, 2026-10-22).
          const fresh = !owner.page;
          if (owner.page) replaced.push(owner.page);
          if (owner.order >= orders.slot.length) orders = this._orders(owner.order + 1);
          orders.slotSerial[owner.order] = at; orders.slot[owner.order] = advanced.length;
          advanced.push(owner); pages.push(page);
          ages.push(fresh ? FIELD_EMA_SETTLE : batch.changed[k] ? 0 : Math.min(FIELD_EMA_SETTLE, owner.age + 1));
        }
        copies.end();
        batches.push({ origin, ids, ages: ages0, gather, scatter });
      }
      // A job's EMA halo, every owner's page after the batches above.
      const interval = fieldInterval('ema'), { min, max } = this.bounds;
      for (const core of plan.jobs) {
        const origin = core.map((v) => v - 16), [ox, oy, oz] = origin.map((v) => v / 4), gather = copies.begin(false);
        // boxBricks' bricks, in its order, without an array a brick.
        const a = origin.map((v, i) => Math.max(v + interval.lo[i], min[i])), b = origin.map((v, i) => Math.min(v + interval.hi[i], max[i]));
        const lo = a.map((v) => Math.floor(v / 4)), hi = a.some((v, i) => v >= b[i]) ? lo : b.map((v) => Math.ceil(v / 4));
        for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
          const owner = plan.find.at(x, y, z), k = owner?.order;
          const page = owner && (k < orders.slot.length && orders.slotSerial[k] === at ? pages[orders.slot[k]] : owner.page);
          if (!page) throw new Error('Missing authoritative world EMA neighbor');
          copies.add(brickIdOf(g, x - ox, y - oy, z - oz), page);
        }
        copies.end();
        jobs.push({ core, origin, gather });
      }
      const list = copies.upload();
      if (list) uploads.push(list);
      // Every batch's EMA list in one upload: its ids, then the three lists'
      // counts. A batch clears the scratch lists and ages and copies its own in,
      // the bytes a whole upload of each made (zero but for those, and a fresh
      // brick's age): two mapped buffers of 64 KiB a batch, 720 a Descent tick
      // (2026-10-22), were most of a recording's JS and its garbage.
      const d = dirtyLists(g), counts = d.last + DIRTY.EMA;
      if ([DIRTY.FIELDS, DIRTY.WORK].some((list, k) => list !== DIRTY.EMA + k + 1)) throw new Error('EMA list counts must be adjacent');
      let listWords = 0;
      for (const batch of batches) { batch.at = listWords; listWords += batch.ids.length + 3; }
      const words = new Uint32Array(Math.max(1, listWords));
      for (const { at, ids } of batches) { words.set(ids, at); words.fill(ids.length, at + ids.length, at + ids.length + 3); }
      const lists = batches.length ? upload(this.gpu, 'world owned EMA lists', words) : null;
      if (lists) uploads.push(lists);
      // Global EMA phase. Each ownership brick appears in exactly one list.
      for (const { origin, ids, ages, gather, scatter, at } of batches) {
        gatherRaw(origin);
        copies.record(frame, gather);
        frame.clear(r.dlist, 0, r.dlist.size);
        for (const list of [DIRTY.EMA, DIRTY.FIELDS, DIRTY.WORK]) if (ids.length) frame.copy(lists, at * 4, r.dlist, list * g.nbricks * 4, ids.length * 4);
        frame.copy(lists, (at + ids.length) * 4, r.dlist, counts * 4, 12);
        if (ages) { const age = upload(this.gpu, 'world owned EMA ages', ages); uploads.push(age); frame.copy(age, 0, r.age, 0, age.size); }
        else frame.clear(r.age, 0, r.age.size);
        this.deriver.recordEMA(frame, { sourceGroup: this.sourceGroup, header,
          size: fold(ids.length), domain: domain(origin, { lo: [16, 16, 16], hi: [48, 48, 48] }) });
        copies.record(frame, scatter);
      }
      // ALL owned scatters precede ANY spatial halo gather. No EMA in this loop.
      for (const { core, origin, gather } of jobs) {
        gatherRaw(origin);
        copies.record(frame, gather);
        frame.copy(this.allLists, 0, r.dlist, 0, this.allLists.size);
        this.deriver.recordSpatial(frame, { sourceGroup: this.sourceGroup, header, smoothing: plan.smoothing,
          sizeFor: () => fold(this.g.nbricks), domainFor: (stage) => domain(origin, fieldInterval(stage)) });
        outputs.push(synchronous(this.publisher.recordOwnedFields(frame, { token: this._token(plan), scratchOrigin: origin,
          ownedWorldBricks: boxBricks(core, core.map((v) => v + 32), this.bounds), validBounds: domain(origin, fieldInterval('peak')),
          textures: Object.fromEntries(FIELD_TEXTURES.map((name) => [name, r[name]])), raw: { A: r.A, B: r.B, g: this.g }, sourceSnapshot: plan.source }), 'recordOwnedFields'));
      }
      // Publication may reject the batch. Keep the old authoritative history
      // and its pages intact until the publisher accepts the complete batch.
      // A throwing publisher must leave its retained snapshot unchanged.
      if (plan.epoch !== this.history.epoch || plan.version !== this.version || plan.source.isCurrent() !== true) throw new Error('World field source/epoch changed during recording');
      const token = this._token(plan);
      const invalidatedCoreKeys = this._invalidated(plan);
      synchronous(this.publisher.publish({ token, outputs, invalidatedCoreKeys }), 'publish');
      if (plan.epoch !== this.history.epoch || plan.version !== this.version || plan.source.isCurrent() !== true) throw new Error('World field source/epoch changed during publication');
      this.history.commit({ owners: advanced, pages, ages, tick: plan.fieldTick, source: plan.sourceRevision });
      if (plan.budget) this._commitBacklog(plan, advanced, invalidatedCoreKeys);
      if (plan.changeCache?.pending && this.changeCache === plan.changeCache) plan.changeCache.pending = false;
      // One push per page, not push(...replaced): a big map's second field tick
      // replaces every owner (~400k on Island), past V8's argument limit
      // ("Maximum call stack size exceeded", 2026-10-22).
      for (const page of replaced) this.history.free.push(page);
      this.lastTick = plan.fieldTick;
      this.tickSource = plan.sourceRevision;
      this.version++;
      this.aerationActive = plan.aerationActive;
      // Invalid cached publications must not survive unseen settling/edits.
      // History remains resident; only spatial validity is invalidated.
      for (const key of invalidatedCoreKeys) this.published.delete(key);
      committed = true;
      this.publishedToken = token;
      this.publishedSource = plan.source;
      this.smoothing = plan.smoothing;
      for (const core of plan.jobs) { const key = brickKey(core); if (!this.published.has(key)) { this.published.add(key); this.publishedAt.set(key, this.publishedSeq++); } }
      this.generation++;
      // Caller retires uploads ONLY after frame submission + queue completion.
      return { token, outputs, retire: () => { for (const b of uploads) b.destroy(); } };
    } catch (error) {
      // Frame may already have submitted a prefix. Never recycle COW pages
      // until the caller flushes the orphan suffix and waits for completion.
      const releaseQuarantine = !committed ? this.history.quarantine(allocated, plan.epoch) : () => {};
      if (this.publishedToken?.historyVersion === plan.version + 1 && this.publishedToken.epoch === plan.epoch) this.publishedToken = null;
      // Even partial copies can reference uploads until the queue completes.
      error.retireWorldFieldUploads = () => { for (const b of uploads) b.destroy(); releaseQuarantine(); };
      throw error;
    }
  }
  // The published cores a plan invalidates, in the order they were published:
  // every one after a smoothing change, else those near its advancing owners or
  // changed bricks. Filtering every published core per batch grew a load's
  // batches with what it had loaded (2026-10-22).
  _invalidated(plan) {
    if (this.smoothing !== plan.smoothing) return [...this.published];
    // (budgeted: the cores no pending owner is near any more, _admit)
    if (plan.budget) return [...plan.budget.invalidate].filter((key) => this.published.has(key)).sort((a, b) => this.publishedAt.get(a) - this.publishedAt.get(b));
    const keys = new Set();
    for (const near of [plan.nearAdvancing, plan.nearChanged]) for (const key of near) if (this.published.has(key)) keys.add(key);
    return [...keys].sort((a, b) => this.publishedAt.get(a) - this.publishedAt.get(b));
  }
  // A budgeted plan's backlog, at its commit: the owners it deferred join the
  // pending ones (changed if either was), a deferred new owner joins history
  // without a page (so no plan makes another for its brick), and the cores it
  // withheld are lagging until a field tick invalidates them.
  _commitBacklog(plan, advanced, invalidated) {
    const { pending, waiting, lagging } = this, tick = plan.fieldTick;
    // (a field tick's: its least, the first core it took, for the bound's check)
    if (!plan.inputs.wantedCores.length) this.lastFirstWorkgroups = plan.budget.firstWorkgroups;
    if (pending.size) for (const owner of advanced) pending.delete(owner);
    if (waiting.size) for (const batch of plan.batches) waiting.delete(brickKey(batch.core));
    for (const batch of plan.budget.deferred) {
      batch.owners.forEach((owner, k) => {
        pending.set(owner, (pending.get(owner) ?? 0) | (batch.changed[k] ? 1 : 0));
        if (!owner.page && !this.history.owners.has(brickKey(owner.brick))) this.history._insert(owner);
      });
      if (!waiting.has(brickKey(batch.core))) waiting.set(brickKey(batch.core), tick);
    }
    if (lagging.size) for (const key of invalidated) lagging.delete(key);
    for (const key of plan.budget.withhold) if (!lagging.has(key)) lagging.set(key, tick);
    if (lagging.size) { const jobs = new Set(plan.jobs.map(brickKey)); for (const key of lagging.keys()) if (!this.published.has(key) && !jobs.has(key)) lagging.delete(key); }
  }
  // The budget's backlog: owners still to advance, and published cores still to invalidate.
  get backlog() { return { owners: this.pending.size, cores: this.waiting.size, lagging: this.lagging.size }; }
  _token(plan) { return Object.freeze({ epoch: plan.epoch, fieldTick: plan.fieldTick, sourceRevision: plan.sourceRevision,
    historyVersion: plan.version + 1, smoothing: plan.smoothing, generation: this.generation }); }
  isCurrent(token) {
    return Boolean(token && this.publishedToken && token.epoch === this.history.epoch &&
      token.historyVersion === this.version && token.generation === this.publishedToken.generation && token.sourceRevision === this.publishedToken.sourceRevision &&
      this.publishedSource.isCurrent() === true);
  }
  reset(epoch) {
    this.history.reset(epoch);
    this.publishedToken = null; this.publishedSource = null;
    this.version++;
    this.lastTick = null; this.tickSource = null; this.smoothing = null; this.aerationActive = null; this.published.clear(); this.publishedAt.clear(); this.generation++;
    this.sortHint = null; this.changeCache = null; this.batchCache = null;
    this.pending.clear(); this.waiting.clear(); this.lagging.clear();
  }
  // Caller must finish its own queued work before disposal.
  dispose() {
    this.history.dispose(); this.allLists.destroy();
    for (const [name, resource] of Object.entries(this.scratch)) if (name !== 'g' && name !== 'views') resource.destroy();
  }
}
