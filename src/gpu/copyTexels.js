// Many single-texel buffer-to-texture copies as one compute dispatch per
// (source buffer, destination texture). Each copyBufferToTexture is one command
// Chrome's GPU process validates and encodes on its own CPU; big maps recorded
// ~5,000 a second of one texel each (world lighting SOURCE/GI writes and
// restores, gfx/worldLightingBatch.js through world/renderAtlas.js
// recordPageWrites, 2026-10-23), capping the frame rate with the GPU idle.
// The same fix as gpu/copyRuns.js for buffer-to-buffer runs.
//
// Exactness: rgba32uint texels are stored word for word. rgba16float texels
// have no uint view in WebGPU core, so each word is split with
// unpack2x16float (f16 -> f32 is exact) and textureStore converts back
// (f32 -> f16 of an f16-representable value is exact): bit-exact for every
// finite half and +-0 and +-inf. Not guaranteed by the spec: NaN payloads and
// f16 subnormals (|x| < 6.1e-5) on hardware that flushes them on store.

// Fewer jobs than this for a pair go as plain copies: a dispatch, a bind group
// and a job upload cost more than a handful of commands.
export const COPY_TEXELS_BATCH_MIN = 8;
const WG = 64;
const MAX_GROUPS_X = 65535;
const JOB_BYTES = 16;     // (src word, x, y, layer)
const STORAGE = 0x80;     // GPUBufferUsage.STORAGE (a literal: CPU checks load this without WebGPU)
const OFFSET_ALIGN = 256;  // minStorageBufferOffsetAlignment default
// Texel bytes and the store expression, by destination format.
const FORMATS = {
  rgba32uint: { bytes: 16, load: 'vec4u(src[w], src[w + 1u], src[w + 2u], src[w + 3u])' },
  rgba16float: { bytes: 8, load: 'vec4f(unpack2x16float(src[w]), unpack2x16float(src[w + 1u]))' },
};

const wgsl = format => /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read> jobs: array<vec4u>;
@group(0) @binding(2) var dst: texture_storage_2d_array<${format}, write>;
@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let j = (wg.x + wg.y * nwg.x) * ${WG}u + li;
  if (j >= arrayLength(&jobs)) { return; }
  let job = jobs[j];
  let w = job.x;
  textureStore(dst, job.yz, job.w, ${FORMATS[format].load});
}`;

const pipelines = new WeakMap();
function pipelineOf(device, format) {
  let byFormat = pipelines.get(device);
  if (!byFormat) pipelines.set(device, byFormat = new Map());
  let p = byFormat.get(format);
  if (!p) {
    const module = device.createShaderModule({ label: `copy texels ${format}`, code: wgsl(format) });
    p = device.createComputePipeline({ label: `copy texels ${format}`, layout: 'auto', compute: { module, entryPoint: 'main' } });
    byFormat.set(format, p);
  }
  return p;
}

function batchable(device, buffer, texture) {
  const max = device?.limits?.maxStorageBufferBindingSize;
  return !!max && !!FORMATS[texture?.format] && !!(buffer?.usage & STORAGE) && buffer.size <= max &&
    (texture.mipLevelCount ?? 1) === 1 && !!(texture.usage & 8);
}

/**
 * Collects single-texel copies { buffer, offset } -> { texture, origin:[x,y,layer] }
 * and records them all at flush(encoder). A texel written twice keeps its last
 * write, as sequential copies would; every texel is then written once, so the
 * order of the dispatches does not matter.
 */
export function createTexelCopies(device) {
  const latest = new Map(), textureIds = new Map();
  return {
    add(buffer, offset, destination) {
      const { texture, origin: [x, y, z] } = destination;
      let id = textureIds.get(texture);
      if (id == null) textureIds.set(texture, id = textureIds.size);
      const key = `${id}:${x},${y},${z}`;
      latest.delete(key);
      latest.set(key, { buffer, offset, destination });
    },
    flush(encoder) {
      if (!latest.size) return;
      const groups = new Map();
      for (const job of latest.values()) {
        let byTexture = groups.get(job.buffer);
        if (!byTexture) groups.set(job.buffer, byTexture = new Map());
        const list = byTexture.get(job.destination.texture);
        if (list) list.push(job); else byTexture.set(job.destination.texture, [job]);
      }
      latest.clear();
      const batched = [];
      for (const [buffer, byTexture] of groups) for (const [texture, list] of byTexture) {
        if (list.length < COPY_TEXELS_BATCH_MIN || !batchable(device, buffer, texture) || list.some(j => j.offset % FORMATS[texture.format].bytes)) {
          for (const j of list) encoder.copyBufferToTexture({ buffer, offset: j.offset }, j.destination, [1, 1, 1]);
        } else batched.push({ buffer, texture, list });
      }
      if (!batched.length) return;
      const align = Math.max(OFFSET_ALIGN, device.limits?.minStorageBufferOffsetAlignment ?? OFFSET_ALIGN);
      let size = 0;
      for (const g of batched) { g.at = size; size = Math.ceil((size + g.list.length * JOB_BYTES) / align) * align; }
      const jobs = device.createBuffer({ label: 'copy texels jobs', size, usage: STORAGE, mappedAtCreation: true });
      const words = new Uint32Array(jobs.getMappedRange());
      for (const g of batched) g.list.forEach((j, i) => {
        const [x, y, z] = j.destination.origin, k = g.at / 4 + i * 4;
        words[k] = j.offset / 4; words[k + 1] = x; words[k + 2] = y; words[k + 3] = z;
      });
      jobs.unmap();
      const pass = encoder.beginComputePass({ label: 'copy texels' });
      for (const g of batched) {
        const pipeline = pipelineOf(device, g.texture.format);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: g.buffer } },
          { binding: 1, resource: { buffer: jobs, offset: g.at, size: g.list.length * JOB_BYTES } },
          { binding: 2, resource: g.texture.createView({ dimension: '2d-array' }) }] }));
        const wgs = Math.ceil(g.list.length / WG);
        pass.dispatchWorkgroups(Math.min(wgs, MAX_GROUPS_X), Math.ceil(wgs / MAX_GROUPS_X));
      }
      pass.end();
      // The caller destroys this after queue.submit (submitted work keeps it alive).
      return jobs;
    },
  };
}
