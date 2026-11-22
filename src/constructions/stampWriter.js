import { MAX_FOOT } from './runtime.js';

// Upload and stamp in command order. The next upload flushes any commands
// reading this buffer, so it can be reused across a batch of baked shapes.
export function writeBakedStamp(sim, kernel, storage, s, at, seed) {
  const gpu = sim.gpu, bytes = s.data.byteLength;
  let old = null;
  if (!storage.stampBuf || storage.stampBuf.size < bytes || storage.stampGpu !== gpu) {
    old = storage.stampGpu === gpu ? storage.stampBuf : null;
    const size = Math.max(64 * 1024, 2 ** Math.ceil(Math.log2(bytes)));
    storage.stampBuf = gpu.createBuffer({ label: 'construction stamp', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    storage.stampGpu = gpu;
  }
  // When the buffer grows the next upload targets a different buffer, so
  // retire the old one after its last recorded commands are submitted.
  if (old) sim._retire(old);
  gpu.write(storage.stampBuf, 0, s.data);
  const foot = Math.min(s.foot, MAX_FOOT);
  return kernel.write({ lo: [at[0], at[1] - foot, at[2]], hi: [at[0] + s.w - 1, at[1] + s.h - 1, at[2] + s.d - 1] },
    { at, foot, size: [s.w, s.h, s.d], seed }, storage.stampBuf);
}
