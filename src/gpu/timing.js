// GPU timing (docs/webgpu.md B8). With `timestamp-query`, `gpu.timing.enabled
// = true` adds timestampWrites to every pass of ours and resolves them through
// the readback service; the results land 1–3 frames late in gpu.timing.last
// ({ passName: ms }, passes of one name summed over the frame). Split mode
// (the in-app profiler) gives every dispatch its own compute pass, named after
// its kernel, so each gets its own timestamps; it costs passes and is off by
// default. Chrome quantizes timestamps to 100 µs unless WebGPU developer
// features are on (the test launcher turns them on, I3).
//
// gpu.fence() (device.js) is the real fence that replaces every sync 1×1 read.

/** Passes timed per flush; later passes of a longer flush go untimed. */
export const MAX_TIMED_PASSES = 512;

/** gpu.timing */
export class GpuTiming {
  /** @param {object} gpu */
  constructor(gpu) {
    this.gpu = gpu;
    /** whether the device has timestamp-query */
    this.supported = gpu.device.features.has('timestamp-query');
    /** one compute pass per dispatch while timing (the profiler) */
    this.split = false;
    /** @type {Record<string, number>} ms per pass name, of the latest frame whose results landed */
    this.last = {};
    /** the frame number `last` belongs to (-1: none yet) */
    this.lastFrame = -1;
    /** the sum of `last` */
    this.frameMs = 0;
    this._enabled = false;
    this._used = 0;
    this._names = [];
    this._parts = [];
    this.querySet = null;
    this.resolveBuffer = null;
  }

  /** Timestamps on every pass of ours; ignored without timestamp-query. */
  get enabled() { return this._enabled; }
  set enabled(on) {
    on = Boolean(on) && this.supported;
    if (on && !this.querySet) {
      const count = 2 * MAX_TIMED_PASSES;
      this.querySet = this.gpu.device.createQuerySet({ label: 'timing', type: 'timestamp', count });
      this.resolveBuffer = this.gpu.createBuffer({
        label: 'timing resolve', size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
    }
    this._enabled = on;
  }

  // a pass's timestampWrites, or undefined (timing off, or the flush is full)
  _writes(name) {
    if (!this._enabled || this._used + 2 > 2 * MAX_TIMED_PASSES) return undefined;
    const i = this._used;
    this._used += 2;
    this._names.push(name);
    return { querySet: this.querySet, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 };
  }

  // flush: resolve this flush's queries and read them back
  _beforeSubmit(enc) {
    if (!this._used) return;
    const n = this._used, names = this._names;
    this._used = 0;
    this._names = [];
    enc.resolveQuerySet(this.querySet, 0, n, this.resolveBuffer, 0);
    const part = this.gpu.readback._copy(enc, this.resolveBuffer, 0, n * 8).then((bytes) => {
      const t = new BigUint64Array(bytes);
      const out = {};
      names.forEach((name, i) => {
        const ms = Math.max(0, Number(t[2 * i + 1] - t[2 * i]) / 1e6);
        out[name] = (out[name] ?? 0) + ms;
      });
      return out;
    });
    part.catch(() => {});
    this._parts.push(part);
  }

  // endFrame: once every flush of the frame has landed, it becomes `last`
  _endFrame(frameNo) {
    const parts = this._parts;
    this._parts = [];
    if (!parts.length) return;
    Promise.all(parts).then((maps) => {
      if (frameNo < this.lastFrame) return;
      const merged = {};
      for (const m of maps) for (const [k, v] of Object.entries(m)) merged[k] = (merged[k] ?? 0) + v;
      this.last = merged;
      this.lastFrame = frameNo;
      this.frameMs = Object.values(merged).reduce((a, b) => a + b, 0);
    }, () => {});
  }
}
