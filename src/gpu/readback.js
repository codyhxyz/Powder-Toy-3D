// Every GPU→CPU read (docs/webgpu.md B7, W6). There is no synchronous read in
// WebGPU, and this is the only way the port reads anything back.
//
//   const bytes = await gpu.readback.buffer(src, offset, size);            // ArrayBuffer (a copy)
//   const px = await gpu.readback.texture(tex, { origin, size });          // TypedArray, rows de-padded
//   const ring = gpu.readback.ring('actCounts', 16, 64);                   // results written inside passes
//   const slot = ring.next();  kernel.dispatch(f, …, { params: { slot } });
//   const counts = await ring.read(slot);
//
// A copy is recorded at the request, into the open encoder, so the bytes are
// the state at the call whatever is recorded after it. Results produced
// inside a pass go into a slot of a GPU-side ring (nothing can copy from
// inside a compute pass), and each ring's used range is copied once at the
// flush. Staging buffers (MAP_READ | COPY_DST) are pooled by size class and
// mapped once after the submit; the mapped range is copied out before
// resolving, since mapped memory can't be transferred to a worker and the
// staging buffer goes back to the pool. Callers keep their own staleness
// tokens (epoch, generation, sim.id); the service only rejects when graphics
// have stopped.

import { GraphicsFailure } from './errors.js';

/** Idle staging the pool keeps; the rest is destroyed after use. */
export const READBACK_POOL_BYTES = 64 * 1024 * 1024;

/** bytes per texel and the TypedArray a texture read returns, by format */
export const TEXEL = {
  r8unorm: [1, Uint8Array], r8uint: [1, Uint8Array], rg8unorm: [2, Uint8Array],
  rgba8unorm: [4, Uint8Array], 'rgba8unorm-srgb': [4, Uint8Array], rgba8uint: [4, Uint8Array], rgba8snorm: [4, Int8Array],
  bgra8unorm: [4, Uint8Array], 'bgra8unorm-srgb': [4, Uint8Array],
  r16float: [2, Uint16Array], rg16float: [4, Uint16Array], rgba16float: [8, Uint16Array],
  r16uint: [2, Uint16Array], rgba16uint: [8, Uint16Array], rgba16sint: [8, Int16Array],
  r32float: [4, Float32Array], rg32float: [8, Float32Array], rgba32float: [16, Float32Array],
  r32uint: [4, Uint32Array], rg32uint: [8, Uint32Array], rgba32uint: [16, Uint32Array],
  r32sint: [4, Int32Array], rgba32sint: [16, Int32Array],
  rgb10a2unorm: [4, Uint32Array], rg11b10ufloat: [4, Uint32Array], depth32float: [4, Float32Array],
};

const MiB = 1024 * 1024;
// a staging size class: powers of two from 256 B to 1 MiB, then whole MiB
const sizeClass = (n) => (n <= MiB ? Math.max(256, 2 ** Math.ceil(Math.log2(n))) : Math.ceil(n / MiB) * MiB);

/**
 * A half float's value (for rgba16float reads, which come back as raw bits).
 * @param {number} h 16-bit pattern
 */
export function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * Half-float bits to floats.
 * @param {Uint16Array} bits
 * @returns {Float32Array}
 */
export function halfsToFloats(bits) {
  const out = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = halfToFloat(bits[i]);
  return out;
}

/** The readback service: gpu.readback. */
export class Readback {
  /** @param {object} gpu */
  constructor(gpu) {
    this.gpu = gpu;
    this.pool = new Map();
    this.idleBytes = 0;
    this.pending = [];   // copies recorded into the open encoder
    this.mapping = new Set();
    this.rings = new Set();
  }

  _staging(size) {
    const cls = sizeClass(size);
    const list = this.pool.get(cls);
    if (list?.length) { this.idleBytes -= cls; return list.pop(); }
    this.gpu.stats.bytesAllocated += cls;
    return this.gpu.device.createBuffer({ label: `readback ${cls}`, size: cls, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  _release(buffer) {
    if (this.gpu.failure || this.idleBytes + buffer.size > READBACK_POOL_BYTES) {
      this.gpu.stats.bytesAllocated -= buffer.size;
      buffer.destroy();
      return;
    }
    let list = this.pool.get(buffer.size);
    if (!list) this.pool.set(buffer.size, list = []);
    list.push(buffer);
    this.idleBytes += buffer.size;
  }

  // Records a buffer copy into `enc` (open, no pass) and returns the promise
  // of `post(mappedRange)`, resolved after the flush that submits `enc`.
  _copy(enc, src, offset, size, post = (r) => r.slice(0)) {
    const staging = this._staging(size);
    enc.copyBufferToBuffer(src, offset, staging, 0, size);
    return new Promise((resolve, reject) => this.pending.push({ staging, size, post, resolve, reject }));
  }

  /**
   * The bytes of a buffer range as they are at this call.
   * @param {GPUBuffer} src a buffer with COPY_SRC
   * @param {number} [offset] bytes, a multiple of 4
   * @param {number} [size] bytes, a multiple of 4
   * @param {{ into?: ArrayBuffer }} [opts] copy into this buffer instead of a new one
   * @returns {Promise<ArrayBuffer>}
   */
  buffer(src, offset = 0, size = src.size - offset, { into } = {}) {
    try {
      if (offset % 4 || size % 4) throw new RangeError(`readback.buffer: offset ${offset} and size ${size} must be multiples of 4`);
      const enc = this.gpu.frame.direct();
      return this._copy(enc, src, offset, size, (range) => {
        if (!into) return range.slice(0);
        new Uint8Array(into, 0, size).set(new Uint8Array(range));
        return into;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * A texture region as it is at this call, rows de-padded (copies use
   * 256-byte bytesPerRow). rgba16float comes back as half-float bits
   * (halfsToFloats converts); bgra8unorm keeps its B, G, R, A order.
   * @param {GPUTexture} tex a texture with COPY_SRC
   * @param {{ origin?: number[], size?: number[], format?: string, mipLevel?: number, aspect?: GPUTextureAspect }} [opts]
   * @returns {Promise<ArrayBufferView>}
   */
  texture(tex, { origin = [0, 0, 0], size, format = tex.format, mipLevel = 0, aspect } = {}) {
    try {
      const t = TEXEL[format];
      if (!t) throw new Error(`readback.texture: no texel size for ${format}`);
      const [bpp, Ctor] = t;
      const [w, h = 1, d = 1] = size ?? [tex.width, tex.height, tex.depthOrArrayLayers];
      const row = w * bpp, bytesPerRow = Math.ceil(row / 256) * 256;
      const total = bytesPerRow * h * d;
      const enc = this.gpu.frame.direct();
      const staging = this._staging(total);
      enc.copyTextureToBuffer(
        { texture: tex, mipLevel, origin, aspect: aspect ?? (format.startsWith('depth') ? 'depth-only' : 'all') },
        { buffer: staging, bytesPerRow, rowsPerImage: h },
        [w, h, d],
      );
      return new Promise((resolve, reject) => this.pending.push({
        staging, size: total, resolve, reject,
        post: (range) => {
          const out = new Uint8Array(row * h * d), src = new Uint8Array(range);
          for (let r = 0; r < h * d; r++) out.set(src.subarray(r * bytesPerRow, r * bytesPerRow + row), r * row);
          return new Ctor(out.buffer);
        },
      }));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * A GPU-side result ring: `slots` slots of `slotBytes` that kernels write
   * results into inside a pass. Made once per name.
   * @param {string} name
   * @param {number} slotBytes a multiple of 4
   * @param {number} slots
   * @returns {ResultRing}
   */
  ring(name, slotBytes, slots) {
    for (const r of this.rings) {
      if (r.name !== name) continue;
      if (r.slotBytes !== slotBytes || r.slots !== slots) throw new Error(`readback ring ${name} already exists with ${r.slotBytes} B × ${r.slots}`);
      return r;
    }
    const r = new ResultRing(this, name, slotBytes, slots);
    this.rings.add(r);
    return r;
  }

  // flush: copy every ring's used range (before finish)
  _beforeSubmit(enc) {
    for (const r of this.rings) r._collect(enc);
  }

  // flush: map every staging buffer the submitted encoder filled
  _afterSubmit() {
    const list = this.pending;
    this.pending = [];
    const stats = this.gpu.stats;
    for (const p of list) {
      const job = p.staging.mapAsync(GPUMapMode.READ, 0, p.size).then(() => {
        let out;
        try {
          out = p.post(p.staging.getMappedRange(0, p.size));
        } finally {
          p.staging.unmap();
        }
        stats.bytesReadBack += p.size;
        this._release(p.staging);
        p.resolve(out);
      }).catch((e) => {
        p.reject(this.gpu.failure ?? GraphicsFailure.from(e));
      }).finally(() => this.mapping.delete(job));
      this.mapping.add(job);
    }
  }

  // graphics stopped: nothing recorded will ever map
  _failAll(failure) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) p.reject(failure);
    for (const r of this.rings) r._fail(failure);
  }

  /** Resolves when every mapping started so far has finished. */
  async idle() {
    while (this.mapping.size) await Promise.allSettled([...this.mapping]);
  }
}

/**
 * A ring of result slots in a storage buffer (STORAGE | COPY_SRC | COPY_DST).
 * The CPU picks a slot with next() and passes it in the dispatch's params;
 * the kernel writes its result at `slot * slotBytes`; read(slot) resolves
 * after the flush that copies it. A slot's index is the token that says
 * which request a value belongs to.
 */
export class ResultRing {
  constructor(readback, name, slotBytes, slots) {
    if (slotBytes % 4 || slotBytes <= 0) throw new RangeError(`ring ${name}: slotBytes must be a positive multiple of 4`);
    this.readback = readback;
    this.name = name;
    this.slotBytes = slotBytes;
    this.slots = slots;
    this.buffer = readback.gpu.createBuffer({
      label: `ring ${name}`, size: slotBytes * slots,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.counter = 0;
    this.used = new Map();      // slot → deferred, written in the open encoder
    this.inflight = new Map();  // slot → promise, submitted, not yet mapped
    this.last = new Map();      // slot → its latest bytes
  }

  /**
   * The next slot, marked used in the open encoder. A slot reused before the
   * flush that copies it would lose a result, so that flushes first.
   * @returns {number}
   */
  next() {
    const slot = this.counter++ % this.slots;
    if (this.used.has(slot)) this.readback.gpu.flush(`ring ${this.name} wrapped`);
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    this.used.set(slot, { promise, resolve, reject });
    return slot;
  }

  /** @param {number} slot @returns {number} the slot's byte offset */
  offset(slot) { return slot * this.slotBytes; }

  /**
   * The slot's bytes from its latest use.
   * @param {number} slot
   * @returns {Promise<ArrayBuffer>}
   */
  read(slot) {
    const d = this.used.get(slot);
    if (d) return d.promise;
    const p = this.inflight.get(slot);
    if (p) return p;
    const last = this.last.get(slot);
    if (last) return Promise.resolve(last.slice(0));
    return Promise.reject(new Error(`ring ${this.name}: slot ${slot} has no result`));
  }

  _collect(enc) {
    if (!this.used.size) return;
    const slots = [...this.used.keys()];
    const lo = Math.min(...slots), hi = Math.max(...slots);
    const sb = this.slotBytes;
    const deferreds = new Map(this.used);
    this.used.clear();
    const all = this.readback._copy(enc, this.buffer, lo * sb, (hi - lo + 1) * sb, (range) => {
      for (const [s, d] of deferreds) {
        const bytes = range.slice((s - lo) * sb, (s - lo + 1) * sb);
        this.last.set(s, bytes);
        if (this.inflight.get(s) === d.promise) this.inflight.delete(s);
        d.resolve(bytes.slice(0));
      }
    });
    all.catch((e) => { for (const d of deferreds.values()) d.reject(e); });
    for (const [s, d] of deferreds) this.inflight.set(s, d.promise);
  }

  _fail(failure) {
    for (const d of this.used.values()) d.reject(failure);
    this.used.clear();
  }
}
