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
function touches(core, owner, reach = 4) {
  return core.every((v, i) => owner[i] * 4 < v + 32 + reach && owner[i] * 4 + 4 > v - reach);
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
  plan({ fieldTick, sourceSnapshot, wantedCores = [], changedBricks = [], smoothing = 1, full = false }) {
    const source = sourceSnapshot, epoch = this.history.epoch;
    if (!Number.isSafeInteger(fieldTick) || fieldTick < 0 || (this.lastTick !== null && fieldTick < this.lastTick)) throw new Error('Stale field tick');
    if (!Number.isFinite(smoothing) || smoothing < 0) throw new Error('Invalid field smoothing');
    if (!source || source.epoch !== epoch || source.sourceRevision == null || source.jetValidity !== 'producer-bounded-v1' ||
      source.isCurrent?.() !== true || !source.assertComplete || !source.recordGatherRaw) throw new Error('Incomplete/stale/unsupported world field source');
    if (fieldTick === this.lastTick && source.sourceRevision !== this.tickSource) throw new Error('Source changed within a committed field tick');
    const aerationActive = source.aerationActive !== false;
    const jetToggle = this.aerationActive !== null && aerationActive !== this.aerationActive;
    const cores = new Map();
    for (const core of wantedCores) {
      if (!Array.isArray(core) || core.length !== 3 || core.some((v) => !Number.isSafeInteger(v) || v % 32)) throw new Error('World field cores must be 32-cell aligned');
      if (boxBricks(core, core.map((v) => v + 32), this.bounds).length) cores.set(brickKey(core), [...core]);
    }
    const owners = new Map([...this.history.owners].map(([k, v]) => [k, { ...v, changed: jetToggle }]));
    const ensure = (brick, changed = false) => {
      const key = brickKey(brick);
      if (!owners.has(key)) owners.set(key, { brick, page: null, lastTick: null, age: 0, sourceVersion: null });
      if (changed) owners.get(key).changed = true;
    };
    // Include all required authoritative EMA halos, not only visible owners.
    for (const core of cores.values()) for (const b of boxBricks(core.map((v) => v - 4), core.map((v) => v + 36), this.bounds)) ensure(b);
    // Raw/aux dirty support: JOIN_REACH=4 precedes the spatial reach. B/flow/
    // decoration-only changes may conservatively enter this same list.
    for (const b of changedBricks) {
      if (!Array.isArray(b) || b.length !== 3 || b.some((v) => !Number.isSafeInteger(v))) throw new Error('Invalid changed world brick');
      for (const n of boxBricks(b.map((v) => v * 4 - 4), b.map((v) => v * 4 + 8), this.bounds)) ensure(n, true);
    }
    const advancing = [];
    for (const owner of owners.values()) {
      if (owner.lastTick === fieldTick) {
        if (jetToggle) throw new Error('Aeration changed within a committed field tick');
        continue;
      }
      if (owner.page && owner.age < FIELD_EMA_SETTLE && fieldTick !== owner.lastTick + 1) throw new Error('Missing dynamic field ticks; replay pinned snapshots first');
      if (!owner.page || owner.changed || owner.age < FIELD_EMA_SETTLE) advancing.push(owner);
    }
    const jobs = [...cores.values()].filter((core) => full || this.smoothing !== smoothing || !this.published.has(brickKey(core)) ||
      advancing.some((o) => touches(core, o.brick)) || changedBricks.some((b) => touches(core, b, 8)));
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
    assertComplete(source, regions); // all preflight before any GPU encoding/allocation
    return { epoch, fieldTick, sourceRevision: source.sourceRevision, source, version: this.version, smoothing,
      owners, advancing, changedBricks, aerationActive, batches: [...batches.values()], jobs, regions };
  }
  record(frame, plan) {
    if (plan.epoch !== this.history.epoch || plan.version !== this.version || plan.source.isCurrent() !== true) throw new Error('Stale world field plan');
    if (Object.values(this.kernels).some((k) => k.state !== 'ready')) throw new Error('World field kernels not ready');
    assertComplete(plan.source, plan.regions);
    const r = this.scratch, uploads = [], allocated = [], outputs = [], replaced = [];
    const owners = new Map([...plan.owners].map(([key, owner]) => [key, { ...owner }]));
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
          const owner = owners.get(brickKey(planned.brick));
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
          const owner = owners.get(brickKey(planned.brick));
          const page = this.history.allocate(); allocated.push(page);
          this.history.copy(frame, r, origin, owner.brick, page, true);
          if (owner.page) replaced.push(owner.page);
          owner.page = page;
          owner.age = owner.changed || owner.lastTick === null ? 0 : Math.min(FIELD_EMA_SETTLE, owner.age + 1);
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
          const owner = owners.get(brickKey(brick));
          if (!owner?.page) throw new Error('Missing authoritative world EMA neighbor');
          this.history.copy(frame, r, origin, brick, owner.page);
        }
        frame.copy(this.allLists, 0, r.dlist, 0, this.allLists.size);
        this.deriver.recordSpatial(frame, { sourceGroup: this.sourceGroup, header, smoothing: plan.smoothing,
          sizeFor: () => fold(this.g.nbricks), domainFor: (stage) => domain(origin, fieldInterval(stage)) });
        outputs.push(synchronous(this.publisher.recordOwnedFields(frame, { token: this._token(plan), scratchOrigin: origin,
          ownedWorldBricks: boxBricks(core, core.map((v) => v + 32), this.bounds), validBounds: domain(origin, fieldInterval('peak')),
          textures: Object.fromEntries(FIELD_TEXTURES.map((name) => [name, r[name]])), sourceSnapshot: plan.source }), 'recordOwnedFields'));
      }
      // Copy-on-write pages mean a recording failure/retry never advances the
      // old authoritative EMA. Metadata commit follows complete recording.
      if (plan.epoch !== this.history.epoch || plan.version !== this.version || plan.source.isCurrent() !== true) throw new Error('World field source/epoch changed during recording');
      this.history.owners = owners;
      this.history.free.push(...replaced);
      this.lastTick = plan.fieldTick;
      this.tickSource = plan.sourceRevision;
      this.version++;
      this.aerationActive = plan.aerationActive;
      // Invalid cached publications must not survive unseen settling/edits.
      // History remains resident; only spatial validity is invalidated.
      for (const key of this.published) {
        const core = key.split(',').map(Number);
        if (this.smoothing !== plan.smoothing || plan.advancing.some((o) => touches(core, o.brick)) ||
          plan.changedBricks.some((b) => touches(core, b, 8))) this.published.delete(key);
      }
      committed = true;
      const token = this._token(plan);
      this.publishedToken = token;
      this.publishedSource = plan.source;
      synchronous(this.publisher.publish({ token, outputs }), 'publish');
      if (plan.epoch !== this.history.epoch || this.version !== plan.version + 1) throw new Error('World field epoch changed during publication');
      this.smoothing = plan.smoothing;
      for (const core of plan.jobs) this.published.add(brickKey(core));
      this.generation++;
      // Caller retires uploads ONLY after frame submission + queue completion.
      return { token, outputs, retire: () => { for (const b of uploads) b.destroy(); } };
    } catch (error) {
      if (!committed && plan.epoch === this.history.epoch) this.history.free.push(...allocated);
      if (this.publishedToken?.historyVersion === plan.version + 1 && this.publishedToken.epoch === plan.epoch) this.publishedToken = null;
      // Even partial copies can reference uploads until the queue completes.
      error.retireWorldFieldUploads = () => { for (const b of uploads) b.destroy(); };
      throw error;
    }
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
    this.lastTick = null; this.tickSource = null; this.smoothing = null; this.aerationActive = null; this.published.clear(); this.generation++;
  }
  // Caller must finish its own queued work before disposal.
  dispose() {
    this.history.dispose(); this.allLists.destroy();
    for (const [name, resource] of Object.entries(this.scratch)) if (name !== 'g' && name !== 'views') resource.destroy();
  }
}
