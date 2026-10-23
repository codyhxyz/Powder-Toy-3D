import { FIELD_EMA_SETTLE } from '../shaders/fields.js';
import { FIELD_HISTORY_JOB_WORDS, FIELD_HISTORY_PLANE_WORDS, FIELD_HISTORY_PLANES } from '../shaders/fieldHistory.js';
import { fold } from '../gpu/kernels.js';

export const HISTORY_BRICK = 4;
export const HISTORY_WORDS = FIELD_HISTORY_PLANES * FIELD_HISTORY_PLANE_WORDS;
const PAGE_BYTES = HISTORY_WORDS * 4;
// A slab is one pool buffer, bound whole by a copy dispatch: the most a binding
// may be on every device (WebGPU's default maxStorageBufferBindingSize).
const SLAB_BYTES_MAX = 128 * 1024 ** 2;
// The most pages a slab holds: 48 MiB. Slabs double from the first one up to
// it, so a pool spends at most this much more than it needs, and a copy run
// spans few slabs: 400k owners (Island) fit in 14 slabs, not 782 of 512 pages.
export const HISTORY_SLAB_MAX_PAGES = 1 << 16;
// The job list's first size, in jobs; it doubles as a recording needs.
const COPY_JOBS_MIN = 1024;
// The same text as p.join(','), several times faster: a World load makes ~20
// million of these (every field halo brick, 2026-10-22).
export const brickKey = (p) => `${p[0]},${p[1]},${p[2]}`;
// Bricks a 32-cell core holds a side, and in all.
export const CORE_BRICKS = 8, CORE_SLOTS = CORE_BRICKS ** 3;
// The key of the core holding brick [x, y, z] (brickKey of its cell origin),
// and the brick's slot in it.
export const coreKeyOf = (x, y, z) => `${Math.floor(x / CORE_BRICKS) * 32},${Math.floor(y / CORE_BRICKS) * 32},${Math.floor(z / CORE_BRICKS) * 32}`;
export const ownerSlot = (x, y, z) => (x & 7) + 8 * ((y & 7) + 8 * (z & 7));
// Whether an entry of history.unsettled's list for tick still counts.
export const unsettledLive = (owner, tick) => owner.lastTick === tick && owner.age < FIELD_EMA_SETTLE;

// Sparse world-identity ownership. No physics-origin/atlas residency clock.
// Pages are copied whole, bit for bit, preserving the three packed planes and
// their slot order (shaders/fieldHistory.js has the layout).
export class WorldFieldHistory {
  constructor(gpu, { pagesPerSlab = 512, maxPagesPerSlab = Math.max(pagesPerSlab, HISTORY_SLAB_MAX_PAGES) } = {}) {
    const valid = (n) => Number.isInteger(n) && n >= 1 && n * PAGE_BYTES <= SLAB_BYTES_MAX;
    if (!valid(pagesPerSlab) || !valid(maxPagesPerSlab) || maxPagesPerSlab < pagesPerSlab) throw new Error('Invalid field history slab size');
    Object.assign(this, { gpu, pagesPerSlab, maxPagesPerSlab });
    this.epoch = 0;
    this.owners = new Map();
    // The same owners by 32-cell core (its brickKey) and brick within it
    // (ownerSlot): a plan and a recording find a brick's owner with integer
    // arithmetic, not a string key a brick (fields.js).
    this.cores = new Map();
    // The owners that can still advance (not yet settled), by the tick they
    // last advanced at: a plan visits these, not every owner (fields.js). An
    // entry is live while its owner's lastTick is still that tick and it has
    // not settled (unsettledLive); later ticks leave dead entries behind, and
    // a plan's visit drops them: one push an advance, no keyed delete.
    this.unsettled = new Map();
    // Owners in the order they were first asked for (WorldFields._plan ensure).
    this.order = 0;
    this.slabs = [];
    // Pages this epoch's slabs hold: the next slab holds as many again.
    this.capacity = 0;
    this.free = [];
    this.quarantined = new Set();
  }
  quarantine(pages, epoch = this.epoch) {
    for (const page of pages) this.quarantined.add(page);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const page of pages) {
        this.quarantined.delete(page);
        if (epoch === this.epoch) this.free.push(page);
      }
    };
  }
  // A page: { buffer, offset } in bytes, its slab's index and its first word.
  allocate() {
    if (!this.free.length) {
      const pages = Math.min(this.maxPagesPerSlab, Math.max(this.pagesPerSlab, this.capacity));
      const buffer = this.gpu.createBuffer({ label: `world EMA epoch ${this.epoch}`, size: pages * PAGE_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const slab = this.slabs.push(buffer) - 1;
      this.capacity += pages;
      for (let page = pages - 1; page >= 0; page--) this.free.push({ buffer, offset: page * PAGE_BYTES, slab, word: page * HISTORY_WORDS });
    }
    return this.free.pop();
  }
  /**
   * A recording's page copies (HistoryCopies), dispatched by `kernel`
   * (shaders/fieldHistory.js) between this pool and `ema`, the scratch EMA.
   * @param {{ kernel: object, layout: object, ema: object }} target
   */
  copies(target) { return new HistoryCopies(this, target); }
  // The owner of brick [x, y, z], or undefined.
  ownerAt(x, y, z) {
    const slots = this.cores.get(coreKeyOf(x, y, z));
    return slots && slots[ownerSlot(x, y, z)];
  }
  // A published batch's advanced owners (fields.js record), applied in place:
  // owners[i] takes pages[i] and ages[i] at tick, from source. One that had no
  // page is new, and joins the owners.
  commit({ owners, pages, ages, tick, source }) {
    const settle = FIELD_EMA_SETTLE;
    let list = null;
    for (let i = 0; i < owners.length; i++) {
      const owner = owners[i], fresh = !owner.page;
      owner.page = pages[i]; owner.age = ages[i]; owner.lastTick = tick; owner.sourceVersion = source;
      if (fresh) this._insert(owner);
      if (owner.age < settle) {
        list ??= this.unsettled.get(tick) ?? this.unsettled.set(tick, []).get(tick);
        list.push(owner);
      }
    }
  }
  _insert(owner) {
    const [x, y, z] = owner.brick, key = coreKeyOf(x, y, z);
    this.owners.set(brickKey(owner.brick), owner);
    let slots = this.cores.get(key);
    if (!slots) this.cores.set(key, (slots = new Array(CORE_SLOTS)));
    slots[ownerSlot(x, y, z)] = owner;
  }
  // How many owners can still advance.
  unsettledCount() {
    let n = 0;
    for (const [tick, list] of this.unsettled) for (const owner of list) if (unsettledLive(owner, tick)) n++;
    return n;
  }
  // Old encoded commands must never target current-epoch pages. Keep old slabs
  // alive until dispose (caller retires this adapter after queue completion).
  reset(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) throw new Error('World field epoch must increase');
    this.epoch = epoch;
    this.owners.clear(); this.cores.clear(); this.unsettled.clear();
    this.free = []; this.capacity = 0;
  }
  dispose() { for (const buffer of this.slabs) buffer.destroy(); this.slabs = []; this.free = []; this.quarantined.clear(); this.owners.clear(); this.cores.clear(); this.unsettled.clear(); }
}

/**
 * One recording's field-history copies (WorldFields.record). A run is a phase's
 * copies, all one way: a batch's gathers (pages into the scratch) before its
 * EMA, its scatters (the scratch into new pages) after it, a spatial job's
 * gathers. Every run is staged first, into one job list uploaded once, then
 * recorded in order, one dispatch per slab a run touches: a few commands a
 * run, whatever its owners. A native copy per plane and owner (3 a page, both
 * ways) was 2.8 s of copyBufferToBuffer in 20 s of Island (2026-10-22).
 *
 * A run's copies each write a different word (distinct owners, distinct
 * pages), so its dispatches commute; runs keep the recording's order, and
 * WebGPU orders a pass's dispatches. A run's jobs stay in the order they were
 * added: each dispatch copies those of its slab (shaders/fieldHistory.js).
 */
export class HistoryCopies {
  constructor(history, { kernel, layout, ema }) {
    Object.assign(this, { history, kernel, layout, ema });
    this.jobs = new Uint32Array(COPY_JOBS_MIN * FIELD_HISTORY_JOB_WORDS);
    this.n = 0;
    this.run = null;
    // Runs begun (the open one's number, from 1), and the last run that saw each slab: a run's slab list.
    this.runs = 0;
    this.seen = new Uint32Array(Math.max(1, history.slabs.length));
    this.buffer = null;
    this.groups = [];
  }
  // Starts a run: scatter false copies pages into the scratch, true the scratch into pages.
  begin(scatter) {
    if (this.run) throw new Error('Field history copy run still open');
    if (this.buffer) throw new Error('Field history copies already uploaded');
    this.run = { scatter: Boolean(scatter), first: this.n, count: 0, slabs: [] };
    this.runs++;
    return this.run;
  }
  // One copy of the open run: the brick (its scratch brick id) and its page.
  add(brickId, page) {
    const n = this.n, slab = page.slab, at = n * FIELD_HISTORY_JOB_WORDS;
    let jobs = this.jobs;
    if (at === jobs.length) { jobs = new Uint32Array(jobs.length * 2); jobs.set(this.jobs); this.jobs = jobs; }
    jobs[at] = brickId * FIELD_HISTORY_PLANE_WORDS;
    jobs[at + 1] = page.word;
    jobs[at + 2] = slab;
    this.n = n + 1;
    if (this.seen[slab] !== this.runs) {
      if (slab >= this.seen.length) { const seen = new Uint32Array(this.history.slabs.length); seen.set(this.seen); this.seen = seen; }
      this.seen[slab] = this.runs; this.run.slabs.push(slab);
    }
  }
  // Closes the open run. A run over several slabs has its jobs grouped by
  // slab (in the order the slabs were first touched, each group in the order
  // added), so each slab's dispatch covers only its own: a run's workgroups
  // are its jobs, not its jobs times its slabs (fields.js counts them against
  // the tick's field budget). Its copies commute (distinct words), so the
  // grouping moves the same bits.
  end() {
    const run = this.run;
    if (!run) throw new Error('No field history copy run open');
    this.run = null;
    run.count = this.n - run.first;
    if (run.slabs.length < 2) { run.ranges = run.slabs.map((slab) => ({ slab, first: run.first, count: run.count })); return run; }
    // (a slab's place in run.slabs by an array, not a Map lookup a job)
    const J = FIELD_HISTORY_JOB_WORDS, at = this.slabAt = this.slabAt?.length >= this.seen.length ? this.slabAt : new Int32Array(this.seen.length), counts = new Array(run.slabs.length).fill(0);
    run.slabs.forEach((slab, k) => { at[slab] = k; });
    for (let j = run.first; j < this.n; j++) counts[at[this.jobs[j * J + 2]]]++;
    run.ranges = [];
    let next = run.first;
    for (let k = 0; k < counts.length; k++) { run.ranges.push({ slab: run.slabs[k], first: next, count: counts[k] }); next += counts[k]; }
    const was = this.jobs.slice(run.first * J, this.n * J), fill = run.ranges.map((r) => r.first);
    for (let j = 0; j < run.count; j++) { const to = fill[at[was[j * J + 2]]]++ * J; this.jobs[to] = was[j * J]; this.jobs[to + 1] = was[j * J + 1]; this.jobs[to + 2] = was[j * J + 2]; }
    return run;
  }
  // The job list, uploaded once every run is staged (null when there is none);
  // the caller retires it after the queue completes, as its other uploads.
  upload() {
    if (this.run) throw new Error('Field history copy run still open');
    if (this.buffer || !this.n) return this.buffer;
    const words = this.n * FIELD_HISTORY_JOB_WORDS;
    this.buffer = this.history.gpu.createBuffer({ label: 'world field history copies', size: words * 4, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Uint32Array(this.buffer.getMappedRange()).set(this.jobs.subarray(0, words));
    this.buffer.unmap();
    return this.buffer;
  }
  // Records a staged run's copies: one dispatch a slab it touches, over that slab's jobs.
  record(frame, run) {
    if (!run.count) return;
    if (!this.buffer) throw new Error('Upload field history copies before recording them');
    const gpu = this.history.gpu;
    for (const { slab, first, count } of run.ranges) {
      const group = this.groups[slab] ??= gpu.bindGroup(this.layout, [{ binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: { buffer: this.history.slabs[slab] } }, { binding: 2, resource: { buffer: this.ema } }], 'world field history');
      this.kernel.dispatch(frame, fold(count), { bind: [group], params: { first, count, scatter: run.scatter, slab } });
    }
  }
}
