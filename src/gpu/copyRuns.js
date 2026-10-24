// Many small buffer-to-buffer copies as one compute dispatch. Each
// copyBufferToBuffer is one command Chrome's GPU process validates and encodes
// on its own CPU; the big-map render source recorded ~37,000 a second of a few
// cells each (renderSource.js recordSourceCopies, Island in first person,
// 2026-10-23), so the GPU sat half idle behind its own command stream. The
// same fix the field history got (world/fieldHistory.js): a job list and one
// workgroup a job.
//
// The call itself runs 600-900 times a second, so it creates nothing per call:
// job lists are suballocated from per-frame ring buffers (written with
// queue.writeBuffer, bound at a dynamic offset), bind groups are cached per
// (src, dst, ring), and dispatches go into the frame's open compute pass.
//
// A ring region is never overwritten before the GPU has read it: offsets only
// advance within a ring; a full ring is retired, and goes back to the free list
// only after queue.onSubmittedWorkDone() resolves for a call made once the
// frame has submitted the encoder holding its last dispatch (frame._flushNo has
// moved past the flush it was used in).

// Fewer runs than this go as plain copies: a dispatch and a job upload cost
// more than a handful of commands.
export const COPY_RUNS_BATCH_MIN = 8;
const WG = 64;
const JOB_WORDS = 4;           // (src word, dst word, words, unused)
const HEADER_BYTES = 16;       // (job count, 3 unused)
const BIND_BYTES = 64 * 1024;  // the job binding's fixed size: a header and up to CHUNK_JOBS jobs
const CHUNK_JOBS = (BIND_BYTES - HEADER_BYTES) / (JOB_WORDS * 4);
const RING_BYTES = 1024 * 1024; // offsets a ring hands out; its buffer is BIND_BYTES longer so any offset binds
const STORAGE = 0x80;          // GPUBufferUsage.STORAGE (a literal: CPU checks load this without WebGPU)
const COPY_DST = 0x08;         // GPUBufferUsage.COPY_DST
const COMPUTE = 0x4;           // GPUShaderStage.COMPUTE

const WGSL = /* wgsl */ `
struct Job { src: u32, dst: u32, n: u32, unused: u32 }
struct Jobs { count: u32, u0: u32, u1: u32, u2: u32, job: array<Job> }
@group(0) @binding(0) var<storage, read> srcW: array<u32>;
@group(0) @binding(1) var<storage, read_write> dstW: array<u32>;
@group(0) @binding(2) var<storage, read> jobs: Jobs;
@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let j = wg.x;
  if (j >= jobs.count) { return; }
  let job = jobs.job[j];
  for (var k = li; k < job.n; k += ${WG}u) { dstW[job.dst + k] = srcW[job.src + k]; }
}`;

// Per device: the pipeline, its layout and the bind group cache.
const devices = new WeakMap();
function deviceState(device) {
  let s = devices.get(device);
  if (!s) {
    const layout = device.createBindGroupLayout({ label: 'copy runs', entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: COMPUTE, buffer: { type: 'read-only-storage', hasDynamicOffset: true, minBindingSize: HEADER_BYTES + JOB_WORDS * 4 } }] });
    const module = device.createShaderModule({ label: 'copy runs', code: WGSL });
    const pipeline = device.createComputePipeline({ label: 'copy runs',
      layout: device.createPipelineLayout({ label: 'copy runs', bindGroupLayouts: [layout] }), compute: { module, entryPoint: 'main' } });
    s = { layout, pipeline, groups: new WeakMap(), align: device.limits?.minStorageBufferOffsetAlignment ?? 256 };
    devices.set(device, s);
  }
  return s;
}

// The bind group for src -> dst reading jobs from ring, made once.
function groupOf(device, s, src, dst, ring) {
  let bySrc = s.groups.get(src); if (!bySrc) s.groups.set(src, bySrc = new WeakMap());
  let byDst = bySrc.get(dst); if (!byDst) bySrc.set(dst, byDst = new Map());
  let g = byDst.get(ring);
  if (!g) {
    g = device.createBindGroup({ label: 'copy runs', layout: s.layout, entries: [
      { binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } },
      { binding: 2, resource: { buffer: ring, offset: 0, size: BIND_BYTES } }] });
    byDst.set(ring, g);
  }
  return g;
}

// Per frame: the ring being filled, retired rings waiting on their submit, free rings.
const frames = new WeakMap();
function ringsOf(frame) {
  let r = frames.get(frame);
  if (!r) frames.set(frame, r = { cur: null, used: 0, flush: -1, retiring: [], free: [] });
  return r;
}

// Rings retired before a submit that has since happened: free once the queue has done that work.
function sweep(frame, r) {
  if (!r.retiring.length) return;
  const queue = frame.gpu.device.queue;
  r.retiring = r.retiring.filter(({ ring, flush }) => {
    if (flush >= frame._flushNo) return true;
    queue.onSubmittedWorkDone().then(() => r.free.push(ring), () => {});
    return false;
  });
}

// A region of `bytes` (<= BIND_BYTES) for this frame's next dispatch: [ring, offset].
function alloc(frame, r, s, bytes) {
  const size = Math.ceil(bytes / s.align) * s.align;
  if (!r.cur || r.used + size > RING_BYTES) {
    if (r.cur) r.retiring.push({ ring: r.cur, flush: r.flush });
    r.cur = r.free.pop() ?? frame.gpu.device.createBuffer({ label: 'copy runs jobs', size: RING_BYTES + BIND_BYTES, usage: STORAGE | COPY_DST });
    r.used = 0;
  }
  const at = r.used;
  r.used += size;
  r.flush = frame._flushNo;
  return [r.cur, at];
}

// Whether src -> dst can go through the kernel: both storage, distinct, bindable whole.
function batchable(device, src, dst) {
  const max = device?.limits?.maxStorageBufferBindingSize;
  return !!max && src !== dst && !!(src.usage & STORAGE) && !!(dst.usage & STORAGE) && src.size <= max && dst.size <= max;
}

/**
 * Records byte runs [srcOffset, dstOffset, bytes] (all multiples of 4) from src to dst into frame:
 * dispatches in the frame's compute pass when there are many and both buffers allow it, else
 * copyBufferToBuffer each.
 * @param {import('./frame.js').GpuFrame} frame
 */
export function copyRuns(frame, src, dst, runs) {
  if (!runs.length) return;
  const device = frame.gpu?.device;
  if (runs.length < COPY_RUNS_BATCH_MIN || !batchable(device, src, dst)) {
    for (const [a, b, n] of runs) frame.copy(src, a, dst, b, n);
    return;
  }
  const s = deviceState(device), r = ringsOf(frame);
  sweep(frame, r);
  for (let i0 = 0; i0 < runs.length; i0 += CHUNK_JOBS) {
    const count = Math.min(CHUNK_JOBS, runs.length - i0);
    const w = new Uint32Array(HEADER_BYTES / 4 + count * JOB_WORDS);
    w[0] = count;
    for (let i = 0; i < count; i++) {
      const [a, b, n] = runs[i0 + i], k = HEADER_BYTES / 4 + i * JOB_WORDS;
      w[k] = a / 4; w[k + 1] = b / 4; w[k + 2] = n / 4;
    }
    frame._command();   // may flush: the region below is stamped with the encoder the dispatch lands in
    const [ring, at] = alloc(frame, r, s, w.byteLength);
    device.queue.writeBuffer(ring, at, w);
    const pass = frame.compute('copy runs');
    pass.setPipeline(s.pipeline);
    pass.setBindGroup(0, groupOf(device, s, src, dst, ring), [at]);
    pass.dispatchWorkgroups(count);
    frame._commandDone('copy runs');
  }
}
