// Kernels, render pipelines, bind group layouts and cold start (docs/webgpu.md B5).
//
//   const react = gpu.kernel({ name: 'react', code: reactFrag(g),
//     layouts: [L.TABLES, L.STATE_RW, L.REACT, L.PARAMS], params: ReactParams, workgroupSize: [64, 1, 1] });
//   await react.ready;
//   react.dispatch(f, { indirect: sim.args, offset: ARGS.REACT }, { bind, header, params });
//
// Every pipeline is created with create*PipelineAsync and an explicit layout
// (W18): layouts are named GPUBindGroupLayouts (gpu.L, made by gpu.layout), so
// bind groups are shared across pipelines and made once per grid. Shader
// modules are cached by source text and pipelines by module, entry points,
// layouts, constants and targets, so a rebuilt grid of the same size reuses
// every pipeline. Unless explicitly optional, a failed pipeline stops graphics
// with `GPU shader failed: <name>.` and the compiler's messages (B9).

import { shaderFailure, GraphicsFailure } from './errors.js';

/** An explicitly optional shader failed without stopping the shared GPU. */
export class OptionalShaderFailure extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = 'OptionalShaderFailure';
  }
}

/** GPUShaderStage's bits, importable where there is no WebGPU (Node tools, generators). */
export const STAGE = Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
/** A kernel must build on the test device (SwiftShader) within this many ms, or be split (W23). */
export const PIPELINE_BUDGET_MS = 30000;
/** The fewest native pipeline compilations running at once (B5): a weak machine's, and every machine's before 2026-10-20. */
export const PIPELINE_CONCURRENCY_MIN = 2;
/**
 * The most. Past four at once each compile slows sharply (an M5, four performance cores of ten, one
 * cold v2block each: +6% two at once, +13% four, +50% six, +86% eight), and that stretches the longest
 * pipeline, the World's volume (~24 s cold), which is a World load's floor and has a 30 s deadline.
 */
export const PIPELINE_CONCURRENCY_MAX = 4;
/**
 * The bound's slots a World view pipeline's build takes while it compiles (outside), the longest
 * single build of a big map's load, its first frame's floor. Metal compiles a pipeline on one core,
 * and Chrome's copy of it (Tint's MSL, 8.8 s alone on an M5, 2026-10-22) slows with the compiles
 * beside it: 9.9 s three at once, 11.0 s four, 14.2 s six. A boot's main thread and the GPU
 * process take cores too (the user's cold Island: 20.2 s beside the boot's builds), so the
 * view's build leaves one slot more free: three compiles at once with it on a four-slot machine.
 */
export const OUTSIDE_VIEW_SLOTS = 2;
/** Cores left to the page's main thread, the browser's GPU process and the compositor while shaders compile. */
export const PIPELINE_SPARE_CORES = 4;
/**
 * Native pipeline compilations running at once, including foreground builds (B5), from the CPU's
 * logical cores. Metal compiles a pipeline on one core and separate builds scale almost linearly up
 * to the performance cores (an M5, the 139 V2 kernels: 10.6 s two at a time, 6.2 s four).
 * Intentional (user request, 2026-10-20: "MAKE IT LOAD FAST"): speed on a cold start, after every
 * deploy, over the two-build bound's lighter load; a machine with few cores keeps two.
 * @param {number} [cores] navigator.hardwareConcurrency
 * @returns {number}
 */
export function pipelineConcurrency(cores = globalThis.navigator?.hardwareConcurrency) {
  if (!Number.isFinite(cores) || cores < 1) return PIPELINE_CONCURRENCY_MIN;
  return Math.max(PIPELINE_CONCURRENCY_MIN, Math.min(PIPELINE_CONCURRENCY_MAX, Math.floor(cores) - PIPELINE_SPARE_CORES));
}
/** This machine's (pipelineConcurrency); each PipelineCache starts with it as its `concurrency`. */
export const PIPELINE_CONCURRENCY = pipelineConcurrency();
/**
 * The order queued native builds start in (B5): a lower rank first, in arrival order within a rank.
 *   FIRST       a long pole the first frame waits for (`first: true`: v2block, v2runs, v2pairs, the drawn
 *               volume), started before the short builds it would otherwise queue behind: with
 *               PIPELINE_CONCURRENCY slots the longest build last decides the wait (list scheduling)
 *   NOW         every other build something waits for (`build: 'now'`, or a build() asked for)
 *   LATER       a `later` build: started at once, but behind every build asked for now (a big map's
 *               simulation step kernels: its World load and first frame's builds go first,
 *               2026-10-22); a `first` one ahead of the other later builds; a demand moves it up
 *   BACKGROUND  an `idle` build: started as soon as a slot is free and nothing above is queued (never
 *               on the page's idle time), never ahead of a build something waits for, whenever it
 *               arrived; a later demand (build()) moves it up
 * Intentional (user request, 2026-10-21: "MAKE IT LOAD FAST"): V2's 101 boot kernels.
 */
export const BUILD_RANK = Object.freeze({ FIRST: 0, NOW: 1, LATER: 2, BACKGROUND: 3 });
/** A Pipe's `build` options. */
const BUILD_WHEN = Object.freeze(['now', 'later', 'idle', 'manual']);
/** The spec's maxComputeWorkgroupsPerDimension: fold() keeps every dimension within it. */
export const MAX_WORKGROUPS = 65535;
// test mode keeps at most this many recent indirect dispatches in gpu.indirectLog
const INDIRECT_LOG_MAX = 8192;

/**
 * A 1-D count of workgroups as a dispatch size every device accepts:
 * [ceil(n / y), y, 1] with y = ceil(n / 65535), so fewer than y workgroups are
 * spare. The kernel's index is `wg.x + wg.y * num_workgroups.x` and it returns
 * past the end (B5).
 * @param {number} n workgroups
 * @returns {[number, number, number]}
 */
export function fold(n) {
  if (!(n >= 0) || !Number.isInteger(n)) throw new RangeError(`fold(${n}): a workgroup count is a non-negative integer`);
  const y = Math.max(1, Math.ceil(n / MAX_WORKGROUPS));
  return [Math.ceil(n / y), y, 1];
}

/**
 * A layout entry with its default visibility filled in: compute and fragment,
 * plus vertex for everything a vertex shader may bind (uniforms, read-only
 * storage, sampled and read-only storage textures, samplers).
 * @param {GPUBindGroupLayoutEntry} e
 * @returns {GPUBindGroupLayoutEntry}
 */
export function withVisibility(e) {
  if (e.visibility !== undefined) return e;
  const writable = e.buffer?.type === 'storage' || (e.storageTexture && e.storageTexture.access !== 'read-only');
  return { ...e, visibility: STAGE.COMPUTE | STAGE.FRAGMENT | (writable ? 0 : STAGE.VERTEX) };
}

const ids = new WeakMap();
let nextId = 1;
const idOf = (o) => { let id = ids.get(o); if (!id) ids.set(o, id = nextId++); return id; };

// Values sorted by key, so equal descriptors make equal cache keys.
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/**
 * Shader modules, pipeline layouts and pipelines for one device, the
 * background build queue, and the counts gpu.stats reports.
 */
export class PipelineCache {
  /** @param {object} gpu */
  constructor(gpu) {
    this.gpu = gpu;
    this.modules = new Map();
    // Keep the default module() API/cache intact, but never share failure policy.
    this.optionalModules = new Map();
    this.moduleValidations = new WeakMap();
    this.layouts = new Map();
    this.pipelines = new Map();
    this.pending = new Set();
    this.queue = [];          // jobs not started yet, by rank (BUILD_RANK), then arrival
    this.queued = new Map();  // full key → its job, while queued (promote)
    this.active = new Set();
    this.running = 0;
    this.failure = null;
    this.pipes = new Set();
    this.idleQueue = [];      // idle builds not started yet (idle(): started as slots free up)
    this.idleJobs = new Map();  // (kept empty: idle builds no longer wait on idle callbacks)
    this.pumping = false;
    /** native compilations at once, foreground and idle builds alike (pipelineConcurrency) */
    this.concurrency = PIPELINE_CONCURRENCY;
    /** native builds made outside this cache and still compiling (outside()) */
    this.outsideBuilds = 0;
    /** @type {Map<string, number>} ms each named pipeline took to create */
    this.times = new Map();
  }

  check() {
    if (this.failure || this.gpu.failure) throw this.failure || this.gpu.failure;
  }

  track(pipe) {
    if (this.failure) pipe.cancel(this.failure);
    else this.pipes.add(pipe);
  }

  // Diagnostics must not delay settling a failure: getCompilationInfo can hang,
  // too. Enrich the same failure object if the browser eventually answers.
  shaderFailed(name, module, error, optional = false) {
    if (this.failure || this.gpu.failure) return this.failure || this.gpu.failure;
    const Failure = optional ? OptionalShaderFailure : GraphicsFailure;
    const failure = new Failure(`GPU shader failed: ${name}.\n${error?.message ?? String(error)}`, { cause: error });
    if (!optional) this.gpu.fail(failure);
    shaderFailure(name, module, error).then((detail) => { failure.message = detail.message; }, () => {});
    return this.failure || this.gpu.failure || failure;
  }

  /** The module for this source text (cached separately by failure policy). */
  module(code, label, optional = false) {
    this.check();
    const modules = optional ? this.optionalModules : this.modules;
    let m = modules.get(code);
    if (!m) {
      const device = this.gpu.device;
      let scoped = false, validation;
      try {
        device.pushErrorScope('validation');
        scoped = true;
        m = device.createShaderModule({ label, code });
        scoped = false;
        validation = device.popErrorScope();
      } catch (error) {
        // Always balance the scope, even if a fake/lost device throws.
        if (scoped) {
          try { Promise.resolve(device.popErrorScope()).catch(() => {}); } catch { /* already lost */ }
        }
        throw this.shaderFailed(label, m, error, optional);
      }
      const module = m;
      const checked = Promise.resolve(validation).then((error) => {
        this.check();
        if (error) throw error;
      }).catch((error) => { throw this.shaderFailed(label, module, error, optional); });
      // Direct module() callers still receive a GPUShaderModule, not a promise.
      checked.catch(() => {
        if (optional && modules.get(code) === module) modules.delete(code);
      });
      this.moduleValidations.set(m, checked);
      modules.set(code, m);
    }
    return m;
  }

  // Explicit layouts preserve the bind-group ABI. The active job's deadline
  // includes this scope: some drivers never answer popErrorScope().
  async pipelineLayout(name, groups, optional = false, module) {
    this.check();
    const key = `${optional}|${groups.map(idOf).join(',')}`;
    let p = this.layouts.get(key);
    if (!p) {
      p = (async () => {
        const device = this.gpu.device;
        let scoped = false;
        try {
          device.pushErrorScope('validation');
          scoped = true;
          const layout = device.createPipelineLayout({ label: `${name} layout`, bindGroupLayouts: groups });
          scoped = false;
          const error = await device.popErrorScope();
          this.check();
          if (error) {
            if (optional) throw error;
            throw new GraphicsFailure(`GPU shader failed: ${name}.\nPipeline layout: ${error.message}`, { cause: error });
          }
          return layout;
        } catch (error) {
          if (scoped) {
            try { Promise.resolve(device.popErrorScope()).catch(() => {}); } catch { /* already lost */ }
          }
          if (!optional && error instanceof GraphicsFailure) throw error;
          throw this.shaderFailed(name, module, error, optional);
        }
      })();
      this.layouts.set(key, p);
      if (optional) p.catch(() => {
        if (this.layouts.get(key) === p) this.layouts.delete(key);
      });
    }
    return p;
  }

  /**
   * Creates (or reuses) a pipeline; every native build goes through pump().
   * @param {number} [rank] BUILD_RANK: where it queues (a reused one still queued moves up to it)
   * @param {boolean} [first] a long pole: ahead of the other builds of its rank
   */
  pipeline(kind, name, key, groups, module, descriptor, optional = false, rank = BUILD_RANK.NOW, first = false) {
    if (this.failure || this.gpu.failure) return this.rejected(this.failure || this.gpu.failure);
    const full = `${optional}|${kind}|${idOf(module)}|${groups.map(idOf).join(',')}|${key}`;
    const cached = this.pipelines.get(full);
    if (cached) { this.promote(full, rank); return cached; }
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    let settle;
    // Public failure cannot cancel a native compilation already in the driver.
    p.settled = new Promise(resolve => { settle = resolve; });
    p.key = full;
    const job = { kind, name, full, groups, module, descriptor, optional, p, resolve, reject, settle, work: null, done: false, timer: null, rank, first };
    this.gpu.stats.pipelinesPending++;
    this.pending.add(p);
    this.pipelines.set(full, p);
    p.catch(() => {}); // awaiting callers still see optional and fatal failures
    this.enqueue(job);
    this.pump();
    return p;
  }

  // Behind every queued job of its rank or a lower one, ahead of every higher rank's; a long pole
  // (`first`) ahead of the other jobs of its rank.
  enqueue(job) {
    const at = this.queue.findIndex((j) => j.rank > job.rank || (job.first && j.rank === job.rank && !j.first));
    if (at < 0) this.queue.push(job); else this.queue.splice(at, 0, job);
    this.queued.set(job.full, job);
  }

  /**
   * A queued build asked for at a lower rank (an idle or later build something now waits for) moves up
   * to it; one already started, or at that rank or lower, stays where it is.
   * @param {string} full a pipeline's key (its promise's `key`) @param {number} rank BUILD_RANK
   */
  promote(full, rank) {
    const job = this.queued.get(full);
    if (!job || job.rank <= rank) return;
    this.queue.splice(this.queue.indexOf(job), 1);
    job.rank = rank;
    this.enqueue(job);
  }

  rejected(error) {
    const p = Promise.reject(error);
    p.catch(() => {});
    return p;
  }

  finish(job, error, pipeline) {
    if (job.done) return;
    job.done = true;
    if (!job.work) job.settle(); // canceled before native work could start
    if (job.timer !== null) clearTimeout(job.timer);
    this.active.delete(job);
    this.running = this.active.size;
    this.pending.delete(job.p);
    this.gpu.stats.pipelinesPending--;
    if (error) {
      this.pipelines.delete(job.full);
      job.reject(error);
    } else {
      this.gpu.stats.pipelinesCreated++;
      this.times.set(job.name, performance.now() - job.t0);
      job.resolve(pipeline);
    }
  }

  /**
   * The cache's slots now: its bound less the builds made outside it (the World's volume:
   * src/gfx/worldVolume.js), so the compiles at once stay within the bound; never under the floor.
   */
  get slots() { return Math.max(PIPELINE_CONCURRENCY_MIN, this.concurrency - this.outsideBuilds); }

  /**
   * Counts a native build made outside this cache against its bound while it compiles (a World
   * volume's ~24 s cold build would otherwise share the performance cores with a full bound's).
   * `slots`: the bound's slots it takes (OUTSIDE_VIEW_SLOTS for a World view's).
   * @template T @param {Promise<T>} promise @param {number} [slots] @returns {Promise<T>} the same promise
   */
  outside(promise, slots = 1) {
    this.outsideBuilds += slots;
    const done = () => { this.outsideBuilds -= slots; this.pump(); };
    Promise.resolve(promise).then(done, done);
    return promise;
  }

  pump() {
    // (a build an idle job starts below queues itself and pumps again: this loop starts it)
    if (this.pumping) return;
    this.pumping = true;
    try { this._pump(); } finally { this.pumping = false; }
  }

  _pump() {
    while (!this.failure && !this.gpu.failure && this.running < this.slots) {
      // A free slot with nothing queued that something waits for starts the next idle build, at
      // once: idle builds wait only for the builds ahead of them, never for the page's idle time
      // (a 60 fps frame loop leaves little: one idle callback per few builds held the dynamics for
      // up to ~18 s after the first frame, tools/pipeline-safety-cpu-check.mjs). Its module is made
      // only now, so a deferred set costs nothing until it starts.
      if (!this.queue.length) {
        const idle = this.idleQueue.shift();
        if (!idle) break;
        try { idle.build(BUILD_RANK.BACKGROUND); } catch { /* (its own failure: Pipe.build cancels it) */ }
        continue;
      }
      const job = this.queue.shift();
      this.queued.delete(job.full);
      this.active.add(job);
      this.running = this.active.size;
      job.t0 = performance.now();
      // This limits our wait, not driver work: WebGPU cannot cancel an active
      // compilation. Do not release a timed-out slot and start more work.
      job.timer = setTimeout(() => {
        if (!job.done) this.gpu.fail(new GraphicsFailure(
          `GPU shader failed: ${job.name}.\nPipeline compilation exceeded ${PIPELINE_BUDGET_MS} ms.`));
      }, PIPELINE_BUDGET_MS);
      job.work = Promise.resolve().then(async () => {
        this.check();
        await this.moduleValidations.get(job.module);
        this.check();
        const layout = await this.pipelineLayout(job.name, job.groups, job.optional, job.module);
        this.check();
        const d = { label: job.name, layout, ...job.descriptor(layout) };
        this.check();
        try {
          return await (job.kind === 'compute' ? this.gpu.device.createComputePipelineAsync(d) : this.gpu.device.createRenderPipelineAsync(d));
        } catch (error) {
          if (!job.optional && error instanceof GraphicsFailure) throw error;
          throw this.shaderFailed(job.name, job.module, error, job.optional);
        }
      }).then((pipeline) => {
        if (job.done || this.failure) return;
        this.finish(job, null, pipeline);
        this.pump();
      }, (error) => {
        if (job.done || this.failure) return;
        if (error instanceof OptionalShaderFailure && job.optional && !this.gpu.failure) {
          this.finish(job, error);
          this.pump();
        } else if (job.optional || error instanceof GraphicsFailure) this.gpu.fail(error);
        else this.shaderFailed(job.name, job.module, error);
      });
      job.work.then(job.settle, job.settle);
    }
  }

  /** Cancel every waiter, including manual pipes and already scheduled idle callbacks. */
  stop(error) {
    if (this.failure) return this.failure;
    this.failure = GraphicsFailure.from(error);
    const jobs = [...this.active, ...this.queue];
    this.queue.length = 0;
    this.queued.clear();
    for (const job of jobs) this.finish(job, this.failure);
    this.idleJobs.clear();
    this.idleQueue.length = 0;
    for (const pipe of this.pipes) pipe.cancel(this.failure);
    this.pipes.clear();
    return this.failure;
  }

  /**
   * An idle build (BUILD_RANK.BACKGROUND): started (job.build(rank)) by pump() as soon as a slot is
   * free and nothing that something waits for is queued, so a deferred set is ready in its compile
   * time, whatever the page's idle time.
   * @param {{ build: (rank: number) => Promise<unknown>, cancel?: (error: GraphicsFailure) => void, desc?: { first?: boolean } }} job
   */
  idle(job) {
    if (this.failure) { job.cancel?.(this.failure); return; }
    // a long pole of its own (`first`) ahead of the other idle builds, in arrival order among them
    const at = job.desc?.first ? this.idleQueue.findIndex((j) => !j.desc?.first) : -1;
    if (at < 0) this.idleQueue.push(job); else this.idleQueue.splice(at, 0, job);
    this.pump();
  }

  /** Resolves when every build started or queued so far has settled. */
  async settled() {
    while (this.pending.size || this.idleQueue.length) {
      await Promise.allSettled([...this.pending]);
      if (!this.pending.size && this.idleQueue.length) await new Promise((r) => setTimeout(r, 16));
    }
  }
}

/**
 * requestIdleCallback where available, else setTimeout. Returns a cancellation function. (Not the
 * pipeline cache's: its idle builds start as slots free up, PipelineCache.idle.)
 */
export function idleCallback(fn) {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => fn(), { timeout: 1000 });
    return () => globalThis.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
}

// Group layouts for a pipeline: as given, then group 3 is always L.PARAMS
// (B4) and any gap is L.EMPTY.
function groupsFor(gpu, layouts = []) {
  const groups = [...layouts];
  while (groups.length < 4) groups.push(undefined);
  if (groups.length > 4) throw new Error('a pipeline has at most 4 bind groups (maxBindGroups)');
  groups[3] ??= gpu.L.PARAMS;
  if (groups[3] !== gpu.L.PARAMS) throw new Error('group 3 is always L.PARAMS (docs/webgpu.md B4)');
  for (let i = 0; i < 3; i++) groups[i] ??= gpu.L.EMPTY;
  return groups;
}

class Pipe {
  constructor(gpu, desc, kind) {
    if (!desc?.name) throw new Error(`gpu.${kind === 'compute' ? 'kernel' : 'renderPipeline'}: a name is required`);
    if (desc.optional !== undefined && typeof desc.optional !== 'boolean') throw new TypeError(`${desc.name}: optional must be a boolean`);
    if (typeof desc.code !== 'string') throw new Error(`${desc.name}: code must be a WGSL string`);
    this.gpu = gpu;
    this.kind = kind;
    this.name = desc.name;
    this.desc = desc;
    this.optional = desc.optional === true;
    this.params = desc.params ?? null;
    this.groups = groupsFor(gpu, desc.layouts);
    this.pipeline = null;
    /** 'idle' (not started), 'pending', 'ready' or 'failed' */
    this.state = 'idle';
    this._started = null;
    let resolve, reject;
    this.ready = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.ready.catch(() => {});
    this._settle = { resolve, reject };
    this.when = desc.build ?? 'now';
    if (!BUILD_WHEN.includes(this.when)) throw new Error(`${desc.name}: build is 'now', 'later', 'idle' or 'manual'`);
    gpu.pipelines.track(this);
  }

  // called at the end of each subclass constructor, once key() can run
  schedule() {
    if (this.when === 'now') this.build();
    else if (this.when === 'later') this.build(BUILD_RANK.LATER);
    else if (this.when === 'idle') this.gpu.pipelines.idle(this);
    return this;
  }

  /**
   * Starts creating the pipeline (once); returns `ready`. A build asked for again while it is still
   * queued moves up to the asking rank (an idle build something now waits for: BUILD_RANK).
   * @param {number} [rank] BUILD_RANK; by default FIRST for a `first` pipe, else NOW
   */
  build(rank = this.desc.first ? BUILD_RANK.FIRST : BUILD_RANK.NOW) {
    if (this.state === 'pending' && this._key) this.gpu.pipelines.promote?.(this._key, rank);
    if (this._started || this.state === 'failed') return this.ready;
    try {
      this.gpu.pipelines.check();
      this.state = 'pending';
      const module = this.gpu.pipelines.module(this.desc.code, this.name, this.optional);
      const compilation = this.gpu.pipelines.pipeline(this.kind, this.name, this.key(), this.groups, module, () => this.descriptor(module), this.optional, rank, !!this.desc.first);
      this._key = compilation.key;
      this._compilationSettled = compilation.settled;
      this._started = compilation
        .then((p) => {
          if (this.state === 'failed') return;
          this.gpu.pipelines.check();
          this.pipeline = p;
          this.state = 'ready';
          this.gpu.pipelines.pipes.delete(this);
          this._settle.resolve(this);
        }).catch((e) => this.cancel(e));
    } catch (e) {
      this.cancel(this.optional && e instanceof OptionalShaderFailure ? e : this.gpu.fail(e));
    }
    return this.ready;
  }

  cancel(error) {
    if (this.state === 'ready' || this.state === 'failed') return;
    this.state = 'failed';
    this.gpu.pipelines.pipes.delete(this);
    this._settle.reject(error);
  }

  get compilationSettled() { return this._compilationSettled ?? Promise.resolve(); }
  // the ms this pipeline took to create (null until it is ready)
  get buildMs() { return this.gpu.pipelines.times.get(this.name) ?? null; }

  check() {
    this.gpu._frameOrThrow();
    if (!this.pipeline) throw new Error(`${this.name} used before its pipeline was ready (await .ready first)`);
  }

  // Binds groups 0–2 and the params group on a pass encoder.
  bind(f, pass, bind, header, params) {
    const gpu = this.gpu;
    if (pass.__pipeline !== this.pipeline) { pass.setPipeline(this.pipeline); pass.__pipeline = this.pipeline; }
    for (let i = 0; i < 3; i++) {
      const g = bind[i] ?? (this.groups[i] === gpu.L.EMPTY ? gpu.emptyGroup : null);
      if (!g) throw new Error(`${this.name}: no bind group for group ${i}`);
      pass.setBindGroup(i, g);
      f._noteGroup(g);
      if (gpu._checkGroups) gpu._checkGroup(this, i, g);
    }
    const { group, offsets } = f._params(header ?? gpu.nullHeader, this.params, params, this.name);
    pass.setBindGroup(3, group, offsets);
  }
}

/** A compute pipeline of ours: gpu.kernel(desc). */
export class Kernel extends Pipe {
  /**
   * @param {object} gpu
   * @param {{ name: string, code: string, entry?: string, layouts?: GPUBindGroupLayout[], params?: object,
   *   constants?: Record<string, number>, workgroupSize?: number[], build?: 'now' | 'later' | 'idle' | 'manual', optional?: boolean, first?: boolean }} desc
   *   optional: true isolates attributed shader failures, not device loss or timeout.
   *   build: 'now' starts at once (boot and a mode just entered), 'later' at once behind every build
   *   something waits for (BUILD_RANK.LATER), 'idle' queues it behind every build something waits for,
   *   started as soon as a slot of the cache's concurrency (pipelineConcurrency) is free, 'manual'
   *   waits for build()
   *   first: a long pole, started ahead of the builds of its rank (BUILD_RANK.FIRST for 'now'; an idle one ahead of the idle queue)
   */
  constructor(gpu, desc) {
    super(gpu, desc, 'compute');
    this.entry = desc.entry ?? 'main';
    this.workgroupSize = desc.workgroupSize ?? [64, 1, 1];
    this.schedule();
  }

  key() { return `${this.entry}|${stable(this.desc.constants ?? {})}`; }

  descriptor(module) {
    return { compute: { module, entryPoint: this.entry, constants: this.desc.constants ?? {} } };
  }

  /**
   * Records one dispatch into the frame's compute pass.
   * @param {object} f gpu.frame
   * @param {number[] | { indirect: GPUBuffer, offset?: number }} size workgroups [x, y, z]
   *   (each ≤ maxComputeWorkgroupsPerDimension: use fold()), or indirect args
   * @param {{ bind?: GPUBindGroup[], header?: object, params?: object }} [opts] groups 0–2 (L.EMPTY
   *   groups may be left out), the header (gpu.nullHeader by default) and the params values
   */
  dispatch(f, size, { bind = [], header, params } = {}) {
    this.check();
    f._command();
    const pass = f.compute(this.name, { dispatch: true });
    this.bind(f, pass, bind, header, params);
    const stats = this.gpu.stats;
    if (Array.isArray(size)) {
      const limit = this.gpu.device.limits.maxComputeWorkgroupsPerDimension;
      const [x, y = 1, z = 1] = size;
      for (const n of [x, y, z]) {
        if (!Number.isInteger(n) || n < 0 || n > limit) throw new RangeError(`${this.name}: dispatch [${size}] is outside 0..${limit} per dimension (use fold())`);
      }
      pass.dispatchWorkgroups(x, y, z);
      stats.dispatches++;
      stats.workgroupsDirect += x * y * z;
    } else if (size?.indirect) {
      const offset = size.offset ?? 0;
      pass.dispatchWorkgroupsIndirect(size.indirect, offset);
      // Chrome validates each indirect dispatch with a dispatch of its own (B3)
      stats.dispatches += 2;
      stats.indirectDispatches++;
      const log = this.gpu.indirectLog;
      if (log) {
        log.push({ kernel: this.name, buffer: size.indirect, offset });
        if (log.length > INDIRECT_LOG_MAX) log.splice(0, log.length - INDIRECT_LOG_MAX / 2);
      }
    } else {
      throw new Error(`${this.name}: dispatch size is [x, y, z] or { indirect, offset }`);
    }
    f._commandDone(this.name);
  }
}

/** A render pipeline of ours: gpu.renderPipeline(desc). */
export class RenderPipe extends Pipe {
  /**
   * @param {object} gpu
   * @param {{ name: string, code: string, layouts?: GPUBindGroupLayout[], params?: object,
   *   vertex?: { entry?: string, buffers?: GPUVertexBufferLayout[] },
   *   fragment?: { entry?: string, targets: GPUColorTargetState[] } | null,
   *   primitive?: GPUPrimitiveState, depthStencil?: GPUDepthStencilState, multisample?: GPUMultisampleState,
   *   constants?: Record<string, number>, build?: 'now' | 'later' | 'idle' | 'manual', optional?: boolean, first?: boolean }} desc
   *   optional: true isolates attributed shader failures, not device loss or timeout.
   *   first: a long pole (Kernel's)
   */
  constructor(gpu, desc) {
    super(gpu, desc, 'render');
    this.schedule();
  }

  key() {
    const { vertex = {}, fragment, primitive, depthStencil, multisample, constants } = this.desc;
    return stable({ vertex, fragment, primitive, depthStencil, multisample, constants });
  }

  descriptor(module) {
    const { vertex = {}, fragment, primitive, depthStencil, multisample, constants = {} } = this.desc;
    const d = {
      vertex: { module, entryPoint: vertex.entry ?? 'vs', buffers: vertex.buffers ?? [], constants },
      primitive: primitive ?? { topology: 'triangle-list' },
    };
    if (fragment !== null) d.fragment = { module, entryPoint: fragment?.entry ?? 'fs', targets: fragment?.targets ?? [], constants };
    if (depthStencil) d.depthStencil = depthStencil;
    if (multisample) d.multisample = multisample;
    return d;
  }

  /**
   * Records one draw into an open render pass of ours (from gpu.frame.render).
   * @param {GPURenderPassEncoder} rp
   * @param {{ bind?: GPUBindGroup[], header?: object, params?: object, count?: number, instances?: number,
   *   first?: number, firstInstance?: number, vertexBuffers?: GPUBuffer[], index?: { buffer: GPUBuffer, format?: GPUIndexFormat },
   *   indirect?: { buffer: GPUBuffer, offset?: number } }} [opts] count: vertices (or indices with `index`); 3 = the full-screen triangle
   */
  draw(rp, { bind = [], header, params, count = 3, instances = 1, first = 0, firstInstance = 0, vertexBuffers = [], index, indirect } = {}) {
    this.check();
    const f = rp.frame;
    if (!f || f._pass !== rp) throw new Error(`${this.name}: draw into a render pass that isn't open (gpu.frame.render)`);
    f._command();
    this.bind(f, rp, bind, header, params);
    vertexBuffers.forEach((b, i) => rp.setVertexBuffer(i, b));
    if (index) rp.setIndexBuffer(index.buffer, index.format ?? 'uint16');
    if (indirect) {
      if (index) rp.drawIndexedIndirect(indirect.buffer, indirect.offset ?? 0);
      else rp.drawIndirect(indirect.buffer, indirect.offset ?? 0);
    } else if (index) rp.drawIndexed(count, instances, first, 0, firstInstance);
    else rp.draw(count, instances, first, firstInstance);
    this.gpu.stats.draws++;
    f._commandDone(this.name);
  }
}
