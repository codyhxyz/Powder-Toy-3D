import { gridDims, brickIdOf, LAYOUT } from '../shaders/common.js';
import { AGE, DIRTY, FIELD_EMA_SETTLE, dirtyLists } from '../shaders/fields.js';
import { fold } from '../gpu/kernels.js';
import { createFieldResources, createFieldLayouts, createFieldKernels, FieldDeriver, FIELD_TEXTURES } from '../gfx/fieldDeriver.js';
import { WorldFieldHistory, brickKey } from './fieldHistory.js';

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
const add = (a, b) => a.map((v, i) => v + b[i]);
const coreOfBrick = (b) => b.map((v) => Math.floor(v / 8) * 32);
function boxBricks(lo, hi, bounds) {
  const min = lo.map((v, i) => Math.max(v, bounds.min[i])), max = hi.map((v, i) => Math.min(v, bounds.max[i]));
  const out = [];
  if (min.some((v, i) => v >= max[i])) return out;
  for (let z = Math.floor(min[2] / 4); z < Math.ceil(max[2] / 4); z++) for (let y = Math.floor(min[1] / 4); y < Math.ceil(max[1] / 4); y++) {
    for (let x = Math.floor(min[0] / 4); x < Math.ceil(max[0] / 4); x++) out.push([x, y, z]);
  }
  return out;
}
// The keys of every 32-aligned core that a brick touches, the core grown by
// reach cells on each side (at most two cores a side): testing each core
// against every brick was O(cores x bricks) per plan, and a World load plans
// once per batch (2026-10-21).
function touchedCores(bricks, reach = 4) {
  const keys = new Set(), side = (v) => {
    const out = [];
    for (let c = Math.floor((v * 4 - 32 - reach) / 32) * 32; c < v * 4 + 4 + reach; c += 32) if (v * 4 < c + 32 + reach && v * 4 + 4 > c - reach) out.push(c);
    return out;
  };
  for (const b of bricks) { const [xs, ys, zs] = b.map(side); for (const z of zs) for (const y of ys) for (const x of xs) keys.add(brickKey([x, y, z])); }
  return keys;
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

// A plan's owners: the ones it changed or added, over history's (unchanged).
class FieldOwners {
  constructor(base, overlay) { this.base = base; this.overlay = overlay; }
  get(key) { return this.overlay.get(key) ?? this.base.get(key); }
  has(key) { return this.overlay.has(key) || this.base.has(key); }
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
  constructor(gpu, { worldBounds, tables, tablesLayout = gpu.layout('TABLES', LAYOUT.TABLES), stateLayout = gpu.layout('STATE_RO', LAYOUT.STATE_RO),
    publisher, history = new WorldFieldHistory(gpu) }) {
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
    this.ready = Promise.all(Object.values(this.kernels).map((k) => k.ready)).then(() => this);
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
  _plan({ fieldTick, sourceSnapshot, wantedCores = [], changedBricks = [], smoothing = 1, full = false }, preflight, prior = null) {
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
      publishedToken: this.publishedToken, publishedSize: this.published.size, lastSmoothing: this.smoothing };
    const reuse = prior?.inputs && Object.keys(inputs).every((k) => prior.inputs[k] === inputs[k]);
    const { owners, advancing, nearAdvancing, nearChanged, jobs, batches, regions } = reuse ? prior : this._owners(inputs);
    if (preflight) assertComplete(source, regions); // exact same demand calculation before population
    return { epoch, fieldTick, sourceRevision: source.sourceRevision, source, version: this.version, smoothing, inputs,
      owners, advancing, changedBricks, nearAdvancing, nearChanged, aerationActive, batches, jobs, regions };
  }
  // A plan's owners, advancing owners, spatial jobs and source regions.
  _owners({ wantedCores, changedBricks, fieldTick, smoothing, full, jetToggle }) {
    const cores = new Map();
    for (const core of wantedCores) {
      if (!Array.isArray(core) || core.length !== 3 || core.some((v) => !Number.isSafeInteger(v) || v % 32)) throw new Error('World field cores must be 32-cell aligned');
      if (boxBricks(core, core.map((v) => v + 32), this.bounds).length) cores.set(brickKey(core), [...core]);
    }
    // History owners are shared, never written: a plan keeps only the owners it
    // changes or adds (plan.owners reads them over history's). A copy of every
    // owner (one a brick) per plan was most of a batched World load's field
    // planning and its garbage (2026-10-21); a pass over every owner per plan
    // still grew a load's batches with all it had loaded: Island's last CELL
    // batches cost 2-3x its first (2026-10-22). Only owners that can advance
    // are visited: this plan's own, and history's unsettled ones of other ticks.
    const base = this.history.owners, overlay = new Map(), history = this.history;
    // An aeration toggle changes every owner: the one whole pass left, and rare.
    if (jetToggle) for (const [k, v] of base) overlay.set(k, { ...v, changed: true });
    const ensure = (brick, changed = false) => {
      const key = brickKey(brick), owner = overlay.get(key) ?? base.get(key);
      if (!owner) overlay.set(key, changed ? { brick, page: null, lastTick: null, age: 0, sourceVersion: null, changed: true, order: history.order++ } : { brick, page: null, lastTick: null, age: 0, sourceVersion: null, order: history.order++ });
      else if (changed && !owner.changed) overlay.set(key, { ...owner, changed: true });
    };
    // Include all required authoritative EMA halos, not only visible owners.
    for (const core of cores.values()) for (const b of boxBricks(core.map((v) => v - 4), core.map((v) => v + 36), this.bounds)) ensure(b);
    // Raw/aux dirty support: JOIN_REACH=4 precedes the spatial reach. B/flow/
    // decoration-only changes may conservatively enter this same list.
    for (const b of changedBricks) {
      if (!Array.isArray(b) || b.length !== 3 || b.some((v) => !Number.isSafeInteger(v))) throw new Error('Invalid changed world brick');
      for (const n of boxBricks(b.map((v) => v * 4 - 4), b.map((v) => v * 4 + 8), this.bounds)) ensure(n, true);
    }
    const owners = new FieldOwners(base, overlay), candidates = [...overlay.values()];
    if (!jetToggle) for (const [tick, keys] of history.unsettled) if (tick !== fieldTick) for (const key of keys) if (!overlay.has(key)) candidates.push(base.get(key));
    // In history's order, then new owners in the order they were asked for: the
    // order a pass over every owner visited them.
    candidates.sort((a, b) => a.order - b.order);
    const advancing = [];
    for (const owner of candidates) {
      if (owner.lastTick === fieldTick) {
        if (jetToggle) throw new Error('Aeration changed within a committed field tick');
        continue;
      }
      if (owner.page && owner.age < FIELD_EMA_SETTLE && fieldTick !== owner.lastTick + 1) throw new Error('Missing dynamic field ticks; replay pinned snapshots first');
      if (!owner.page || owner.changed || owner.age < FIELD_EMA_SETTLE) advancing.push(owner);
    }
    const nearAdvancing = touchedCores(advancing.map((o) => o.brick)), nearChanged = touchedCores(changedBricks, 8);
    const jobs = [...cores.values()].filter((core) => full || this.smoothing !== smoothing || !this.published.has(brickKey(core)) ||
      nearAdvancing.has(brickKey(core)) || nearChanged.has(brickKey(core)));
    const batches = new Map();
    for (const owner of advancing) {
      const core = coreOfBrick(owner.brick), key = brickKey(core);
      if (!batches.has(key)) batches.set(key, { core, owners: [] });
      batches.get(key).owners.push(owner);
    }
    const regions = [...batches.values(), ...jobs.map((core) => ({ core }))].map(({ core }) => {
      const origin = core.map((v) => v - 16);
      return { origin, lo: origin.map((v, i) => Math.max(v, this.bounds.min[i])), hi: origin.map((v, i) => Math.min(v + 64, this.bounds.max[i])) };
    });
    return { owners, advancing, nearAdvancing, nearChanged, jobs, batches: [...batches.values()], regions };
  }
  record(frame, plan) {
    if (plan.epoch !== this.history.epoch || plan.version !== this.version || plan.source.isCurrent() !== true) throw new Error('Stale world field plan');
    if (Object.values(this.kernels).some((k) => k.state !== 'ready')) throw new Error('World field kernels not ready');
    assertComplete(plan.source, plan.regions);
    const r = this.scratch, uploads = [], allocated = [], outputs = [], replaced = [];
    // Shared owners again: an advancing one is copied before it changes, and
    // history takes the copies only once the batch is published.
    const updated = new Map(), ownerOf = (key) => updated.get(key) ?? plan.owners.get(key);
    const header = { src: 0, dst: 0, origin: [0, 0, 0] };
    const domain = (origin, interval) => ({ worldMin: this.bounds.min, worldMax: this.bounds.max, scratchOrigin: origin, ...interval });
    const gatherRaw = (origin) => synchronous(plan.source.recordGatherRaw(frame, { resources: { A: r.A, B: r.B, aeration: r.aeration },
      g: this.g, scratchOrigin: origin, worldBounds: this.bounds, sourceRevision: plan.sourceRevision, stateCopy: 0, aerationCopy: 0 }), 'recordGatherRaw');
    let committed = false;
    this.deriver.setAeration({ buffer: r.aeration, copy: 0, active: plan.aerationActive });
    try {
      // Global EMA phase. Each ownership brick appears in exactly one list.
      for (const batch of plan.batches) {
        const origin = batch.core.map((v) => v - 16), ids = [], ages = new Uint32Array(this.g.nbricks);
        gatherRaw(origin);
        for (const planned of batch.owners) {
          const owner = ownerOf(brickKey(planned.brick));
          const local = owner.brick.map((v, i) => v - origin[i] / 4), id = brickIdOf(this.g, ...local);
          ids.push(id);
          if (owner.page) this.history.copy(frame, r, origin, owner.brick, owner.page);
          else ages[id] = AGE.FRESH;
        }
        const lists = upload(this.gpu, 'world owned EMA list', this._lists(ids)), age = upload(this.gpu, 'world owned EMA ages', ages);
        uploads.push(lists, age);
        frame.copy(lists, 0, r.dlist, 0, lists.size);
        frame.copy(age, 0, r.age, 0, age.size);
        this.deriver.recordEMA(frame, { sourceGroup: this.sourceGroup, header,
          size: fold(ids.length), domain: domain(origin, { lo: [16, 16, 16], hi: [48, 48, 48] }) });
        for (const planned of batch.owners) {
          const key = brickKey(planned.brick), owner = { ...ownerOf(key) }; updated.set(key, owner);
          const page = this.history.allocate(); allocated.push(page);
          this.history.copy(frame, r, origin, owner.brick, page, true);
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
          owner.page = page;
          owner.age = fresh ? FIELD_EMA_SETTLE : owner.changed ? 0 : Math.min(FIELD_EMA_SETTLE, owner.age + 1);
          owner.lastTick = plan.fieldTick;
          owner.sourceVersion = plan.sourceRevision;
        }
      }
      // ALL owned scatters precede ANY spatial halo gather. No EMA in this loop.
      for (const core of plan.jobs) {
        const origin = core.map((v) => v - 16);
        gatherRaw(origin);
        const interval = fieldInterval('ema');
        for (const brick of boxBricks(add(origin, interval.lo), add(origin, interval.hi), this.bounds)) {
          const owner = ownerOf(brickKey(brick));
          if (!owner?.page) throw new Error('Missing authoritative world EMA neighbor');
          this.history.copy(frame, r, origin, brick, owner.page);
        }
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
      this.history.commit(updated);
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
    const keys = new Set();
    for (const near of [plan.nearAdvancing, plan.nearChanged]) for (const key of near) if (this.published.has(key)) keys.add(key);
    return [...keys].sort((a, b) => this.publishedAt.get(a) - this.publishedAt.get(b));
  }
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
  }
  // Caller must finish its own queued work before disposal.
  dispose() {
    this.history.dispose(); this.allLists.destroy();
    for (const [name, resource] of Object.entries(this.scratch)) if (name !== 'g' && name !== 'views') resource.destroy();
  }
}
