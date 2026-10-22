// Lifetime and exact transport shared by the disabled world GI/glow producers.
// No private queue submission: producer uses gpu.frame; transport explicitly
// delegates to the existing Atlas recordLightWrite endpoint (which owns submit).
import { validateWorldLightingRestore } from '../world/worldLightingRestore.js';
export const BU = Object.freeze({ COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
export const TU = Object.freeze({ COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
export const uint = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
export const frozenArray = a => Object.freeze(Array.from(a));
export function worldLightingIndex(size, b) {
  const ok = (k) => Number.isInteger(b[k]) && b[k] >= 0 && b[k] < size[k] / 4;
  if (!Array.isArray(b) || b.length !== 3 || !ok(0) || !ok(1) || !ok(2)) throw new RangeError('global lighting brick');
  return b[0] + size[0] / 4 * (b[1] + size[1] / 4 * b[2]);
}
// Exact Chebyshev neighborhood, without scanning every change for every record.
export function worldLightingNear(size, bricks, radius) {
  if(!uint(radius))throw new RangeError('lighting neighborhood radius');
  const [nx,ny,nz]=size.map(n=>n/4);
  const changed=new Set(Array.from(bricks,b=>worldLightingIndex(size,b)));
  return b=>{
    if(changed.has(worldLightingIndex(size,b)))return true;
    if(!changed.size)return false;
    for(let z=Math.max(0,b[2]-radius);z<=Math.min(nz-1,b[2]+radius);z++)
      for(let y=Math.max(0,b[1]-radius);y<=Math.min(ny-1,b[1]+radius);y++)
        for(let x=Math.max(0,b[0]-radius);x<=Math.min(nx-1,b[0]+radius);x++)
          if(changed.has(x+nx*(y+ny*z)))return true;
    return false;
  };
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

// All outputs are already native texels; transport only records scoped copies.
export function createLightingTransport(device) {
  // One page's copy, checked against its Atlas job's provenance.
  function writer({ job, kind, token, source, copies, origin }) {
    if (!['source', 'gi', 'glow'].includes(kind)) throw new TypeError('lighting transport kind');
    const tick = kind === 'source' ? 'sourceTick' : kind === 'gi' ? 'giTick' : 'glowTick';
    const dependency = job?.dependencies?.[kind];
    if (job?.kind !== 'light' || job.epoch !== token.epoch || job.sourceRevision !== token.sourceRevision || job[tick] !== token.lightingTick ||
      dependency?.id !== token.dependencySetID || dependency?.version !== token.dependencyVersion) throw new Error('lighting Atlas job provenance mismatch');
    if (kind === 'glow') return { job, kind, record(encoder, bindings) {
      encoder.copyTextureToTexture({ texture: source, origin }, bindings.destinations[0], [1, 1, 1]);
    } };
    const stride = kind === 'gi' ? 8 : 16;
    if (copies.length !== (kind === 'gi' ? 4 : 1) || copies.some((c, i) => c.to !== i * stride || c.size !== stride)) throw new Error('exact packed lighting ranges required');
    return { job, kind, record(encoder, bindings) {
      copies.forEach((c, i) => encoder.copyBufferToTexture({ buffer: source, offset: c.from }, bindings.destinations[i], [1, 1, 1]));
    } };
  }
  async function write({ atlas, job, kind, token, source, copies, origin, retain }) {
    const held = retain();
    try {
      const w = writer({ job, kind, token, source, copies, origin });
      atlas.recordLightWrite(w.job, w.kind, { record: w.record });
      // recordLightWrite has submitted; this is not a source-side hidden submit.
      await device.queue.onSubmittedWorkDone();
    } finally { held.release(); }
  }
  // Many pages' copies (outputs' atlasWrite entries) in one Atlas submission
  // and one wait: none is recorded unless all check out.
  async function writeAll(atlas, entries) {
    const held = [];
    try {
      for (const e of entries) held.push(e.retain());
      const writes = entries.map(writer);
      if (writes.length) atlas.recordLightWrites(writes);
      await device.queue.onSubmittedWorkDone();
    } finally { held.forEach(h => h.release()); }
  }
  // Retained outputs are immutable, completed producer publications. Close
  // the normal Frame once before Atlas copies; no staging or per-brick flush.
  async function restore(gpu,atlas,entries) {
    const held=[],prepared=[];
    const retire=()=>{
      if(gpu.failure||gpu.pipelines?.failure)return; // uncertain suffix: retain
      if(gpu.frame.open){setTimeout(retire,0);return;}
      const drop=()=>held.forEach(l=>l.release());
      Promise.resolve(device.queue.onSubmittedWorkDone()).then(drop,drop);
    };
    try {
      for(const {job,lease}of entries){
        validateWorldLightingRestore(lease,{job});
        if(!['source','gi'].includes(lease.kind))throw new Error('only SOURCE/GI can be restored');
        // Validate readiness before any native copy or partial write.
        atlas.writerBindings(job,lease.kind);
        const pin=lease.retain();held.push(pin);
        prepared.push({job,lease,pin});
      }
      gpu.flush('world retained lighting closure');
      for(const {job,lease,pin}of prepared){
        validateWorldLightingRestore(lease,{job});
        const {buffer:source,ranges}=pin.bindings();
        atlas.recordLightWrite(job,lease.kind,{restoreDeclaration:lease,record(encoder,bindings){
          ranges.forEach((c,i)=>encoder.copyBufferToTexture({buffer:source,offset:c.from},bindings.destinations[i],[1,1,1]));
        }});
      }
      await device.queue.onSubmittedWorkDone();
    } finally {retire();}
  }
  return { write, writeAll, restore };
}
