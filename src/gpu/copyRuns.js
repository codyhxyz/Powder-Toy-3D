// Many small buffer-to-buffer copies as one compute dispatch. Each
// copyBufferToBuffer is one command Chrome's GPU process validates and encodes
// on its own CPU; the big-map render source recorded ~37,000 a second of a few
// cells each (renderSource.js recordSourceCopies, Island in first person,
// 2026-10-23), so the GPU sat half idle behind its own command stream. The
// same fix the field history got (world/fieldHistory.js): a job list and one
// workgroup a job.

// Fewer runs than this go as plain copies: a dispatch, a bind group and a job
// upload cost more than a handful of commands.
export const COPY_RUNS_BATCH_MIN = 8;
const WG = 64;
const MAX_GROUPS_X = 65535;
const JOB_WORDS = 4;   // (src word, dst word, words, unused)
const STORAGE = 0x80;      // GPUBufferUsage.STORAGE (a literal: CPU checks load this without WebGPU)

const WGSL = /* wgsl */ `
struct Job { src: u32, dst: u32, n: u32, unused: u32 }
@group(0) @binding(0) var<storage, read> srcW: array<u32>;
@group(0) @binding(1) var<storage, read_write> dstW: array<u32>;
@group(0) @binding(2) var<storage, read> jobs: array<Job>;
@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let j = wg.x + wg.y * nwg.x;
  if (j >= arrayLength(&jobs)) { return; }
  let job = jobs[j];
  for (var k = li; k < job.n; k += ${WG}u) { dstW[job.dst + k] = srcW[job.src + k]; }
}`;

const pipelines = new WeakMap();
function pipelineOf(device) {
  let p = pipelines.get(device);
  if (!p) {
    const module = device.createShaderModule({ label: 'copy runs', code: WGSL });
    p = device.createComputePipeline({ label: 'copy runs', layout: 'auto', compute: { module, entryPoint: 'main' } });
    pipelines.set(device, p);
  }
  return p;
}

// Whether src -> dst can go through the kernel: both storage, distinct, bindable whole.
function batchable(device, src, dst) {
  const max = device?.limits?.maxStorageBufferBindingSize;
  return !!max && src !== dst && !!(src.usage & STORAGE) && !!(dst.usage & STORAGE) && src.size <= max && dst.size <= max;
}

/**
 * Records byte runs [srcOffset, dstOffset, bytes] (all multiples of 4) from src to dst into frame:
 * one dispatch when there are many and both buffers allow it, else copyBufferToBuffer each.
 * @param {import('./frame.js').GpuFrame} frame
 */
export function copyRuns(frame, src, dst, runs) {
  if (!runs.length) return;
  const device = frame.gpu?.device;
  if (runs.length < COPY_RUNS_BATCH_MIN || !batchable(device, src, dst)) {
    for (const [a, b, n] of runs) frame.copy(src, a, dst, b, n);
    return;
  }
  const jobs = device.createBuffer({ label: 'copy runs jobs', size: runs.length * JOB_WORDS * 4, usage: STORAGE, mappedAtCreation: true });
  const w = new Uint32Array(jobs.getMappedRange());
  runs.forEach(([a, b, n], i) => { w[i * JOB_WORDS] = a / 4; w[i * JOB_WORDS + 1] = b / 4; w[i * JOB_WORDS + 2] = n / 4; });
  jobs.unmap();
  const pipeline = pipelineOf(device);
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } }, { binding: 2, resource: { buffer: jobs } }] });
  const pass = frame.direct().beginComputePass({ label: 'copy runs' });
  pass.setPipeline(pipeline); pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.min(runs.length, MAX_GROUPS_X), Math.ceil(runs.length / MAX_GROUPS_X));
  pass.end();
}
