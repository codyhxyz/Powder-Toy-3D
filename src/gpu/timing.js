// Observe the shared device, not a list of rendering clients. Three, our
// frame wrapper and future clients all pass through the same encoder hooks.
// Queries belong to an encoder until its command buffer is submitted and
// read back: independent encoders may finish and submit in a different order.
export const MAX_TIMED_PASSES = 512;
// Query pools (a timestamp query set and its two buffers), made once when timing first
// turns on and reused: an encoder that finds none free goes untimed. Made per encoder
// as needed before, the profiler on through a big map's load ran Metal out of counter
// sample buffers ("Cannot allocate sample buffer"), and that error stopped graphics
// (2026-10-24).
export const QUERY_POOLS = 8;

export class GpuTiming {
  constructor(gpu) {
    this.gpu = gpu;
    this.supported = gpu.device.features.has('timestamp-query');
    this.split = false;
    this.scope = ''; // optional human-readable name; never required for coverage
    this.onPass = null;
    this.onFrame = null;
    this.passCount = 0;
    this.last = {};
    this.lastPasses = [];
    this.lastCoverage = null;
    this.lastFrame = -1;
    this.frameMs = null;
    this._enabled = false;
    this._epoch = 0;
    this._parts = [];
    this._pendingFrames = new Set();
    this._idle = [];        // pools ready and free
    this._pools = null;     // every pool made (QUERY_POOLS), once timing first turns on
    this.onUnavailable = null;   // (message): the device couldn't make the query pools; timing is off for good
    // Listeners for every landed frame (addFrameListener), beside the one-owner onFrame:
    // the profiler samples on landing, so a frame nothing follows (a parked test's
    // renderOnce) is still sampled.
    this._frameListeners = new Set();
    const commands = new WeakMap();
    const device = gpu.device;
    // Pipelines made on the device, ours and three's alike, counted at the device boundary
    // (no list of clients): the profiler marks a capture untrusted while any is compiling.
    this.pipelines = { created: 0, compiling: 0 };
    for (const method of ['createComputePipeline', 'createRenderPipeline', 'createComputePipelineAsync', 'createRenderPipelineAsync']) {
      if (typeof device[method] !== 'function') continue;
      const make = device[method].bind(device);
      const async = method.endsWith('Async');
      device[method] = (...args) => {
        this.pipelines.created++;
        if (!async) return make(...args);
        this.pipelines.compiling++;
        const done = () => { this.pipelines.compiling--; };
        const p = make(...args);
        p.then(done, done);
        return p;
      };
    }
    const createEncoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (...args) => {
      const enc = createEncoder(...args);
      let record = null;
      for (const [method, kind] of [['beginRenderPass', 'render'], ['beginComputePass', 'compute']]) {
        const begin = enc[method].bind(enc);
        enc[method] = (descriptor = {}) => {
          this.passCount++;
          if (!this.enabled) return begin(descriptor);
          record ??= { epoch: this._epoch, recordedAt: performance.now(), passes: [], pool: null, used: 0 };
          const name = this.scope || descriptor.label || `(unlabelled ${kind})`;
          const pass = { name, kind, phase: 'other', epoch: this._epoch, error: null, index: null };
          this.onPass?.(pass);
          record.passes.push(pass);
          // Do not overwrite another query owner or pretend an overflow is zero ms.
          if (descriptor.timestampWrites) pass.error = 'foreign timestamp owner';
          else if (record.used >= MAX_TIMED_PASSES) pass.error = 'query capacity exceeded';
          else if (record.epoch !== this._epoch) pass.error = 'capture changed during encoder';
          else if (!(record.pool ??= this._idle.pop() ?? null)) pass.error = 'no query pool free';
          else {
            pass.index = record.used++;
            return begin({ ...descriptor, timestampWrites: {
              querySet: record.pool.queries,
              beginningOfPassWriteIndex: pass.index * 2,
              endOfPassWriteIndex: pass.index * 2 + 1,
            } });
          }
          return begin(descriptor);
        };
      }
      const finish = enc.finish.bind(enc);
      enc.finish = (...rest) => {
        if (record?.used) {
          const { pool, used } = record;
          enc.resolveQuerySet(pool.queries, 0, used * 2, pool.resolve, 0);
          enc.copyBufferToBuffer(pool.resolve, 0, pool.staging, 0, used * 16);
        }
        const buffer = finish(...rest);
        if (record) commands.set(buffer, record);
        return buffer;
      };
      return enc;
    };
    const submit = gpu.queue.submit.bind(gpu.queue);
    gpu.queue.submit = (buffers) => {
      const list = Array.isArray(buffers) ? buffers : Array.from(buffers);
      const result = submit(list);
      for (const buffer of list) {
        const record = commands.get(buffer);
        if (!record) continue;
        commands.delete(buffer);
        // Only map this submission's copies. The app's readback service can
        // also hold copies from encoders that have not been submitted yet.
        const part = this._read(record);
        if (record.passes.some(p => p.epoch === this._epoch)) this._parts.push(part);
      }
      return result;
    };
  }

  get enabled() { return this._enabled; }
  set enabled(value) {
    const on = Boolean(value) && this.supported;
    if (on === this._enabled) return;
    this._enabled = on;
    this._epoch++;
    this._parts = [];
    if (!on) return; // Keep completed results inspectable after stopping a capture.
    this._makePools();
    this.last = {};
    this.lastPasses = [];
    this.lastCoverage = null;
    this.lastFrame = -1;
    this.frameMs = null;
  }

  // The pools, each inside error scopes: one the device can't make (out of memory) turns
  // timing off instead of stopping graphics, and a pool is used only once its scopes came
  // back clean (a failed query set in a pass would be a validation error of its own).
  _makePools() {
    if (this._pools) return;
    const device = this.gpu.device, size = MAX_TIMED_PASSES * 16;
    this._pools = [];
    for (let i = 0; i < QUERY_POOLS; i++) {
      const scoped = typeof device.pushErrorScope === 'function';
      if (scoped) { device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation'); }
      const pool = {
        queries: device.createQuerySet({ label: 'profile queries', type: 'timestamp', count: MAX_TIMED_PASSES * 2 }),
        // Keep scratch buffers out of the app's strong resource registry.
        // Abandoned encoders/command buffers must remain garbage-collectable.
        resolve: device.createBuffer({ label: 'profile resolve', size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        staging: device.createBuffer({ label: 'profile readback', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      };
      this._pools.push(pool);
      if (!scoped) { this._idle.push(pool); continue; }   // (a device without error scopes: nothing to wait for)
      Promise.all([device.popErrorScope(), device.popErrorScope()]).then(([validation, memory]) => {
        const error = validation ?? memory;
        if (error) this._unavailable(error.message);
        else if (this.supported) this._idle.push(pool);
      }, (e) => this._unavailable(String(e?.message ?? e)));
    }
  }

  _unavailable(message) {
    if (!this.supported) return;
    this.supported = false;
    this.enabled = false;
    for (const p of this._idle.splice(0)) this._destroy(p);
    console.warn(`GPU timing unavailable: ${message}`);
    this.onUnavailable?.(message);
  }

  _destroy(pool) { pool.queries.destroy(); pool.resolve.destroy(); pool.staging.destroy(); }

  async _read(record) {
    const { pool, passes, used } = record;
    const result = { passes, recordedAt: record.recordedAt };
    if (!pool) return result;
    try {
      await pool.staging.mapAsync(GPUMapMode.READ, 0, used * 16);
      const times = new BigUint64Array(pool.staging.getMappedRange(0, used * 16));
      const elapsed = performance.now() - record.recordedAt;
      for (const pass of passes) {
        if (pass.index === null) continue;
        pass.begin = times[pass.index * 2];
        pass.end = times[pass.index * 2 + 1];
        if (pass.end < pass.begin) pass.error = 'invalid timestamps';
        else if (Number(pass.end - pass.begin) / 1e6 > elapsed + 2) pass.error = 'timestamp duration exceeds capture wall time';
      }
    } catch {
      for (const pass of passes) if (pass.index !== null) pass.error = 'timestamp readback failed';
    } finally {
      pool.staging.unmap();
      if (!this.gpu.lost && this.supported) this._idle.push(pool);
      else this._destroy(pool);
    }
    return result;
  }

  _endFrame(frameNo) {
    const parts = this._parts, epoch = this._epoch;
    this._parts = [];
    if (!parts.length) return;
    const done = Promise.all(parts).then((groups) => {
      if (epoch !== this._epoch) return;
      const records = groups.flatMap(g => g.passes).filter(p => p.epoch === epoch);
      const timed = records.filter(p => !p.error);
      const first = timed.reduce((v, p) => v === null || p.begin < v ? p.begin : v, null);
      const passes = records.map(p => ({
        name: p.name, kind: p.kind, phase: p.phase, error: p.error,
        start: p.error ? null : Number(p.begin - first) / 1e6,
        gpu: p.error ? null : Number(p.end - p.begin) / 1e6,
      }));
      const merged = {};
      for (const p of passes) if (p.gpu !== null) merged[p.name] = (merged[p.name] ?? 0) + p.gpu;
      const span = Math.max(0, ...passes.filter(p => p.gpu !== null).map(p => p.start + p.gpu));
      // Driver timestamp origins can jump between submissions (observed on
      // Metal). No GPU interval can exceed recording→readback wall time.
      // Allow 2 ms for clock precision; retain durations, reject fake gaps.
      const elapsed = performance.now() - Math.min(...groups.map(g => g.recordedAt));
      const timelineComplete = timed.length === records.length && span <= elapsed + 2;
      if (!timelineComplete) for (const p of passes) p.start = null;
      const coverage = {
        complete: timed.length === records.length,
        observed: records.length, timed: timed.length,
        missing: passes.filter(p => p.error).map(({ name, error }) => ({ name, error })),
        unlabelled: passes.filter(p => p.name.startsWith('(unlabelled')).length,
        timelineComplete,
        spanMs: timelineComplete ? span : null,
      };
      const frameMs = coverage.complete ? Object.values(merged).reduce((a, b) => a + b, 0) : null;
      if (frameNo >= this.lastFrame) {
        this.last = merged;
        this.lastPasses = passes;
        this.lastCoverage = coverage;
        this.lastFrame = frameNo;
        this.frameMs = frameMs;
      }
      const landed = { frame: frameNo, passes, coverage, gpu: frameMs };
      this.onFrame?.(landed);
      for (const fn of this._frameListeners) fn(landed);
    });
    this._pendingFrames.add(done);
    done.then(() => this._pendingFrames.delete(done), () => this._pendingFrames.delete(done));
    return done;
  }

  /** fn(frame) for every landed frame ({ frame, passes, coverage, gpu }); returns the unsubscribe. */
  addFrameListener(fn) { this._frameListeners.add(fn); return () => this._frameListeners.delete(fn); }

  // Park the app before awaiting this to drain a bounded profiling capture.
  async settled() { await Promise.all([...this._pendingFrames]); }
}
