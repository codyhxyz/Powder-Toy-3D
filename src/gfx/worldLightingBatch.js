// Lifetime and exact transport shared by the disabled world GI/glow producers.
// No private queue submission: producer uses gpu.frame; transport explicitly
// delegates to the existing Atlas recordLightWrite endpoint (which owns submit).
import { worldPageWriterWGSL } from '../shaders/worldAccess.js';
import { worldWriterLayouts } from '../world/renderAtlas.js';
import { validateWorldLightingRestore } from '../world/worldLightingRestore.js';
export const BU = Object.freeze({ COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
export const TU = Object.freeze({ COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
export const uint = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
export const frozenArray = a => Object.freeze(Array.from(a));
export function worldLightingIndex(size, b) {
  if (!Array.isArray(b) || b.length !== 3 || b.some((v, k) => !Number.isInteger(v) || v < 0 || v >= size[k] / 4)) throw new RangeError('global lighting brick');
  return b[0] + size[0] / 4 * (b[1] + size[1] / 4 * b[2]);
}
export function validateLightingInput(input, size) {
  if (!input || !uint(input.epoch) || input.epoch === 0 || !input.worldSize || input.worldSize.length !== 3 || input.worldSize.some((n, k) => n !== size[k]) ||
    !uint(input.source?.sourceRevision) || input.source.contentToken == null || input.field?.complete !== true || input.field.publishedToken == null ||
    input.field.sourceRevision !== input.source.sourceRevision || !uint(input.field.logicalFieldTick) ||
    !uint(input.dependencySetID) || !uint(input.dependencyVersion) || typeof input.release !== 'function') throw new TypeError('pinned complete source/field/dependency publication required');
}
export function sameLightingProvenance(token, input) {
  return token?.epoch === input.epoch &&
    token.sourceRevision === input.source.sourceRevision &&
    token.sourceContentToken === input.source.contentToken &&
    token.fieldPublishedToken === input.field.publishedToken &&
    token.logicalFieldTick === input.field.logicalFieldTick &&
    token.dependencySetID === input.dependencySetID &&
    token.dependencyVersion === input.dependencyVersion;
}
export function createLightingResources(device) {
  const limit = Math.min(128 * 1024 ** 2, device.limits?.maxStorageBufferBindingSize ?? 128 * 1024 ** 2);
  function buffer(label, size, usage, data) {
    size = Math.max(16, Math.ceil(size / 4) * 4);
    if (!Number.isSafeInteger(size) || size > limit) throw new RangeError(`${label} exceeds bounded storage limit`);
    const b = device.createBuffer({ label, size, usage, mappedAtCreation: true });
    try { if (data) new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); b.unmap(); return b; }
    catch (e) { b.destroy(); throw e; }
  }
  return { buffer, limit };
}
// Reserve BEFORE any command. A read resolving early does not release inputs.
// On partial encoding error record() still closes the final readback boundary.
export function completeLightingBatch({ frame, queue, feedbackBuffer, wordCount, submissionProvider, encode, finish }) {
  const ticket = submissionProvider.reserve(frame);
  if (!ticket?.submitted?.then || typeof ticket.record !== 'function') throw new TypeError('final submission/readback ticket required');
  let encodingError, read;
  try { encode(); } catch (e) { encodingError = e; }
  try { read = Promise.resolve(ticket.record(frame, feedbackBuffer, wordCount)); }
  catch (e) { read = Promise.reject(e); }
  // Eager rejection handler; completion waits for the final submitted use first.
  read = read.then(words => ({ words }), error => ({ error }));
  return Promise.resolve(ticket.submitted).then(async () => {
    await queue.onSubmittedWorkDone();
    const result = await read;
    if (encodingError) throw encodingError;
    if (result.error) throw result.error;
    if (!(result.words instanceof Uint32Array) || result.words.length !== wordCount) throw new TypeError('entire lighting feedback readback required');
    return finish(result.words);
  }, async error => {
    // Discard of the final encoder does not undo earlier automatic submits.
    // Keep every input/output pinned until that prefix also finishes.
    await queue.onSubmittedWorkDone();
    throw error;
  });
}

// GI history is packed vec2u per band, exactly what giBlend stored. Transport
// unpacks those finite/saturated half values, not the pre-rounded f32 blend.
const packedGIWriter = /* wgsl */ `
struct WriterParams { page: vec4u, aux: vec4u, probes: vec4u, reserved: vec4u }
@group(0) @binding(0) var<uniform> WP: WriterParams;
@group(0) @binding(1) var<storage, read> words: array<vec2u>;
@group(1) @binding(0) var o0: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(1) var o1: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(2) var o2: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(3) var o3: texture_storage_2d_array<rgba16float, write>;
fn band(k: u32) -> vec4f { let h = words[k]; return vec4f(unpack2x16float(h.x), unpack2x16float(h.y)); }
@compute @workgroup_size(1) fn main() {
  let p = WP.page.x;
  let a = vec3i(i32(p % WP.probes.x), i32((p / WP.probes.x) % WP.probes.y), i32(p / (WP.probes.x * WP.probes.y)));
  textureStore(o0,a.xy,a.z,band(0u)); textureStore(o1,a.xy,a.z,band(1u));
  textureStore(o2,a.xy,a.z,band(2u)); textureStore(o3,a.xy,a.z,band(3u));
}`;
export function worldLightingTransportSpec(kind) {
  if (kind === 'gi') return { code: packedGIWriter, groups: [
    [{ binding: 0, visibility: 4, buffer: { type: 'uniform', minBindingSize: 64 } }, { binding: 1, visibility: 4, buffer: { type: 'read-only-storage', minBindingSize: 32 } }],
    Array.from({ length: 4 }, (_, binding) => ({ binding, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } })),
  ] };
  if (!['source', 'glow'].includes(kind)) throw new TypeError('lighting transport kind');
  return { code: worldPageWriterWGSL(kind), groups: worldWriterLayouts(kind) };
}
export function createLightingTransport(device, kinds) {
  const { buffer } = createLightingResources(device), pipelines = new Map();
  const ready = Promise.all(kinds.map(async kind => {
    const spec = worldLightingTransportSpec(kind);
    const layouts = spec.groups.map((entries, i) => device.createBindGroupLayout({ label: `world ${kind} transport ${i}`, entries }));
    const pipe = await device.createComputePipelineAsync({ label: `world ${kind} transport`, layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      compute: { module: device.createShaderModule({ code: spec.code }), entryPoint: 'main' } });
    pipelines.set(kind, { layouts, pipe });
  }));
  async function write({ atlas, job, kind, token, source, copies, retain }) {
    const held = retain(); const owned = [];
    try {
      await ready;
      const tick = kind === 'source' ? 'sourceTick' : kind === 'gi' ? 'giTick' : 'glowTick';
      const dependency = job?.dependencies?.[kind];
      if (job?.kind !== 'light' || job.epoch !== token.epoch || job.sourceRevision !== token.sourceRevision || job[tick] !== token.lightingTick ||
        dependency?.id !== token.dependencySetID || dependency?.version !== token.dependencyVersion) throw new Error('lighting Atlas job provenance mismatch');
      const scratch = buffer(`world ${kind} exact transport`, kind === 'gi' ? 32 : 16, BU.STORAGE | BU.COPY_DST); owned.push(scratch);
      const { layouts, pipe } = pipelines.get(kind);
      atlas.recordLightWrite(job, kind, { record(encoder, bindings) {
        const params = buffer('world lighting transport params', 64, BU.UNIFORM, bindings.params); owned.push(params);
        for (const c of copies) encoder.copyBufferToBuffer(source, c.from, scratch, c.to, c.size);
        const inputs = device.createBindGroup({ layout: layouts[0], entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: scratch } }] });
        const outputs = device.createBindGroup({ layout: layouts[1], entries: bindings.outputs });
        const pass = encoder.beginComputePass({ label: 'world lighting Atlas transport' });
        pass.setPipeline(pipe); pass.setBindGroup(0, inputs); pass.setBindGroup(1, outputs); pass.dispatchWorkgroups(1, 1, 1); pass.end();
      } });
      // recordLightWrite has submitted; this is not a source-side hidden submit.
      await device.queue.onSubmittedWorkDone();
    } finally { owned.forEach(b => b.destroy()); held.release(); }
  }
  // Copies for the whole closure share one normal Frame boundary. Atlas owns
  // the subsequent texture-writer submits; no per-brick source flush/readback.
  async function restore(gpu,atlas,entries) {
    await ready;
    const held=[],owned=[],prepared=[];
    const retire=()=>{
      if(gpu.failure||gpu.pipelines?.failure)return; // uncertain suffix: retain
      if(gpu.frame.open){setTimeout(retire,0);return;}
      const drop=()=>{owned.forEach(b=>b.destroy());held.forEach(l=>l.release());};
      Promise.resolve(device.queue.onSubmittedWorkDone()).then(drop,drop);
    };
    try {
      for(const {job,lease}of entries){
        validateWorldLightingRestore(lease,{job});
        if(!['source','gi'].includes(lease.kind))throw new Error('only SOURCE/GI can be restored');
        // Validate readiness before any native copy or partial write.
        atlas.writerBindings(job,lease.kind);
        const pin=lease.retain();held.push(pin);
        const scratch=buffer('world retained exact transport',lease.kind==='gi'?32:16,BU.STORAGE|BU.COPY_DST);owned.push(scratch);
        prepared.push({job,lease,pin,scratch});
      }
      for(const {pin,scratch}of prepared){const {buffer:source,ranges}=pin.bindings();for(const c of ranges)gpu.frame.direct().copyBufferToBuffer(source,c.from,scratch,c.to,c.size);}
      gpu.flush('world retained lighting closure');
      for(const {job,lease,scratch}of prepared){
        validateWorldLightingRestore(lease,{job});
        const {layouts,pipe}=pipelines.get(lease.kind);
        atlas.recordLightWrite(job,lease.kind,{restoreDeclaration:lease,record(encoder,bindings){
          const params=buffer('world retained transport params',64,BU.UNIFORM,bindings.params);owned.push(params);
          const inputs=device.createBindGroup({layout:layouts[0],entries:[{binding:0,resource:{buffer:params}},{binding:1,resource:{buffer:scratch}}]});
          const outputs=device.createBindGroup({layout:layouts[1],entries:bindings.outputs});
          const pass=encoder.beginComputePass({label:'world retained Atlas transport'});
          pass.setPipeline(pipe);pass.setBindGroup(0,inputs);pass.setBindGroup(1,outputs);pass.dispatchWorkgroups(1,1,1);pass.end();
        }});
      }
      await device.queue.onSubmittedWorkDone();
    } finally {retire();}
  }
  return { ready, write, restore };
}
export const WGSL_CHECK = () => ['source', 'gi', 'glow'].map(kind => {
  const spec = worldLightingTransportSpec(kind);
  return { name: `worldLightingTransport.${kind}`, kind: 'compute', grids: false, warm: false,
    code: () => spec.code, layouts: () => spec.groups, workgroupSize: [kind === 'gi' ? 1 : 64, 1, 1], dispatch: () => [1, 1, 1] };
});
