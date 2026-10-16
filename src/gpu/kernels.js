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
// every pipeline. A pipeline that fails stops graphics with
// `GPU shader failed: <name>.` and the compiler's messages (B9).

import { shaderFailure, GraphicsFailure } from './errors.js';

/** GPUShaderStage's bits, importable where there is no WebGPU (Node tools, generators). */
export const STAGE = Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
/** A kernel must build on the test device (SwiftShader) within this many ms, or be split (W23). */
export const PIPELINE_BUDGET_MS = 30000;
/** Native pipeline compilations running at once, including foreground builds (B5). */
export const PIPELINE_CONCURRENCY = 2;
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
    this.layouts = new Map();
    this.pipelines = new Map();
    this.pending = new Set();
    this.queue = [];
    this.active = new Set();
    this.running = 0;
    this.failure = null;
    this.pipes = new Set();
    this.idleQueue = [];
    this.idleJobs = new Map();
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

  // Diagnostics must not delay stopping graphics: getCompilationInfo can hang,
  // too. Enrich the same failure object if the browser eventually answers.
  shaderFailed(name, module, error) {
    if (this.failure) return this.failure;
    const failure = new GraphicsFailure(`GPU shader failed: ${name}.\n${error?.message ?? String(error)}`, { cause: error });
    this.gpu.fail(failure);
    shaderFailure(name, module, error).then((detail) => { failure.message = detail.message; }, () => {});
    return this.failure || failure;
  }

  /** The module for this source text (cached). */
  module(code, label) {
    this.check();
    let m = this.modules.get(code);
    if (!m) {
      const device = this.gpu.device;
      device.pushErrorScope('validation');
      try {
        m = device.createShaderModule({ label, code });
      } catch (error) {
        // Always balance the scope, even if a fake/lost device throws.
        Promise.resolve(device.popErrorScope()).catch(() => {});
        throw this.shaderFailed(label, m, error);
      }
      const module = m;
      Promise.resolve(device.popErrorScope()).then((error) => {
        if (error && !this.failure) this.shaderFailed(label, module, error);
      }, (error) => { if (!this.failure) this.shaderFailed(label, module, error); });
      this.modules.set(code, m);
    }
    return m;
  }

  // Explicit layouts preserve the bind-group ABI. The active job's deadline
  // includes this scope: some drivers never answer popErrorScope().
  async pipelineLayout(name, groups) {
    this.check();
    const key = groups.map(idOf).join(',');
    let p = this.layouts.get(key);
    if (!p) {
      const device = this.gpu.device;
      device.pushErrorScope('validation');
      let layout;
      try {
        layout = device.createPipelineLayout({ label: `${name} layout`, bindGroupLayouts: groups });
      } catch (error) {
        Promise.resolve(device.popErrorScope()).catch(() => {});
        throw error;
      }
      p = Promise.resolve(device.popErrorScope()).then((error) => {
        this.check();
        if (error) throw new GraphicsFailure(`GPU shader failed: ${name}.\nPipeline layout: ${error.message}`);
        return layout;
      });
      this.layouts.set(key, p);
    }
    return p;
  }

  /** Creates (or reuses) a pipeline; every native build goes through pump(). */
  pipeline(kind, name, key, groups, module, descriptor) {
    if (this.failure) return this.rejected(this.failure);
    const full = `${kind}|${idOf(module)}|${groups.map(idOf).join(',')}|${key}`;
    const cached = this.pipelines.get(full);
    if (cached) return cached;
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    let settle;
    // Public failure cannot cancel a native compilation already in the driver.
    p.settled = new Promise(resolve => { settle = resolve; });
    const job = { kind, name, full, groups, module, descriptor, p, resolve, reject, settle, work: null, done: false, timer: null };
    this.gpu.stats.pipelinesPending++;
    this.pending.add(p);
    this.pipelines.set(full, p);
    p.catch(() => {}); // gpu.fail reports it; awaiting callers still see it
    this.queue.push(job);
    this.pump();
    return p;
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

  pump() {
    while (!this.failure && this.running < PIPELINE_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
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
        const layout = await this.pipelineLayout(job.name, job.groups);
        this.check();
        const d = { label: job.name, layout, ...job.descriptor(layout) };
        this.check();
        return job.kind === 'compute' ? this.gpu.device.createComputePipelineAsync(d) : this.gpu.device.createRenderPipelineAsync(d);
      }).then((pipeline) => {
        if (job.done || this.failure) return;
        this.finish(job, null, pipeline);
        this.pump();
      }, (error) => {
        if (job.done || this.failure) return;
        if (error instanceof GraphicsFailure) this.gpu.fail(error);
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
    for (const job of jobs) this.finish(job, this.failure);
    for (const cancel of this.idleJobs.values()) cancel?.();
    this.idleJobs.clear();
    this.idleQueue.length = 0;
    for (const pipe of this.pipes) pipe.cancel(this.failure);
    this.pipes.clear();
    return this.failure;
  }

  /**
   * Idle scheduling is separate from the central native compilation semaphore.
   * @param {{ build: () => Promise<unknown>, cancel?: (error: GraphicsFailure) => void }} job
   */
  idle(job) {
    if (this.failure) { job.cancel?.(this.failure); return; }
    this.idleQueue.push(job);
    this.pumpIdle();
  }

  pumpIdle() {
    while (!this.failure && this.idleJobs.size < PIPELINE_CONCURRENCY && this.idleQueue.length) {
      const job = this.idleQueue.shift();
      this.idleJobs.set(job, idleCallback(() => {
        if (this.failure || !this.idleJobs.has(job)) return;
        this.idleJobs.set(job, null);
        Promise.resolve().then(() => { this.check(); return job.build(); }).catch(() => {}).finally(() => {
          this.idleJobs.delete(job);
          this.pumpIdle();
        });
      }));
    }
  }

  /** Resolves when every build started or queued so far has settled. */
  async settled() {
    while (this.pending.size || this.idleQueue.length || this.idleJobs.size) {
      await Promise.allSettled([...this.pending]);
      if (!this.pending.size && (this.idleQueue.length || this.idleJobs.size)) await new Promise((r) => setTimeout(r, 16));
    }
  }
}

/** requestIdleCallback where available, else setTimeout. Returns a cancellation function. */
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
    if (typeof desc.code !== 'string') throw new Error(`${desc.name}: code must be a WGSL string`);
    this.gpu = gpu;
    this.kind = kind;
    this.name = desc.name;
    this.desc = desc;
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
    if (!['now', 'idle', 'manual'].includes(this.when)) throw new Error(`${desc.name}: build is 'now', 'idle' or 'manual'`);
    gpu.pipelines.track(this);
  }

  // called at the end of each subclass constructor, once key() can run
  schedule() {
    if (this.when === 'now') this.build();
    else if (this.when === 'idle') this.gpu.pipelines.idle(this);
    return this;
  }

  /** Starts creating the pipeline (once); returns `ready`. */
  build() {
    if (this._started || this.state === 'failed') return this.ready;
    try {
      this.gpu.pipelines.check();
      this.state = 'pending';
      const module = this.gpu.pipelines.module(this.desc.code, this.name);
      const compilation = this.gpu.pipelines.pipeline(this.kind, this.name, this.key(), this.groups, module, () => this.descriptor(module));
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
      this.cancel(this.gpu.fail(e));
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
   *   constants?: Record<string, number>, workgroupSize?: number[], build?: 'now' | 'idle' | 'manual' }} desc
   *   build: 'now' starts at once (boot and a mode just entered), 'idle' queues it
   *   behind PIPELINE_CONCURRENCY, 'manual' waits for build()
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
   *   constants?: Record<string, number>, build?: 'now' | 'idle' | 'manual' }} desc
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
