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
    // Keys of the owners that can still advance (not yet settled), by the tick
    // they last advanced at: a plan visits these, not every owner (fields.js).
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
  // A published batch's advanced owners. Their changed flags are this batch's
  // only: every plan starts from unchanged owners (WorldFields._plan).
  commit(updated) {
    for (const [key, owner] of updated) {
      const old = this.owners.get(key), keys = old && this.unsettled.get(old.lastTick);
      if (keys) { keys.delete(key); if (!keys.size) this.unsettled.delete(old.lastTick); }
      owner.changed = false;
      this.owners.set(key, owner);
      if (owner.age < FIELD_EMA_SETTLE) {
        if (!this.unsettled.has(owner.lastTick)) this.unsettled.set(owner.lastTick, new Set());
        this.unsettled.get(owner.lastTick).add(key);
      }
    }
  }
  // Old encoded commands must never target current-epoch pages. Keep old slabs
  // alive until dispose (caller retires this adapter after queue completion).
  reset(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) throw new Error('World field epoch must increase');
    this.epoch = epoch;
    this.owners.clear(); this.unsettled.clear();
    this.free = []; this.capacity = 0;
  }
  dispose() { for (const buffer of this.slabs) buffer.destroy(); this.slabs = []; this.free = []; this.quarantined.clear(); this.owners.clear(); this.unsettled.clear(); }
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
  // Closes the open run.
  end() {
    const run = this.run;
    if (!run) throw new Error('No field history copy run open');
    this.run = null;
    run.count = this.n - run.first;
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
  // Records a staged run's copies: one dispatch a slab it touches.
  record(frame, run) {
    if (!run.count) return;
    if (!this.buffer) throw new Error('Upload field history copies before recording them');
    const size = fold(run.count), gpu = this.history.gpu;
    for (const slab of run.slabs) {
      const group = this.groups[slab] ??= gpu.bindGroup(this.layout, [{ binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: { buffer: this.history.slabs[slab] } }, { binding: 2, resource: { buffer: this.ema } }], 'world field history');
      this.kernel.dispatch(frame, size, { bind: [group], params: { first: run.first, count: run.count, scatter: run.scatter, slab } });
    }
  }
}
