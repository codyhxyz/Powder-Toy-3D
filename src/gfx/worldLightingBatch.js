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
// Exact Chebyshev neighborhood: is a brick within radius of any changed brick.
// The changes are dilated once, into merged x-intervals per (y,z) row, so a
// query is one row lookup and a binary search. A scan of the (2r+1)^3 bricks
// around every queried record was 1.4 s of every 20 on Island and Descent
// (real Chrome, 2026-10-22): two such tests ran over every record each tick.
export function worldLightingNear(size, bricks, radius) {
  if(!uint(radius))throw new RangeError('lighting neighborhood radius');
  const [nx,ny,nz]=size.map(n=>n/4);
  // each changed brick's x, by its row y + ny*z
  const source=new Map();
  for(const b of Array.from(bricks)){worldLightingIndex(size,b);const row=b[1]+ny*b[2],xs=source.get(row);if(xs)xs.push(b[0]);else source.set(row,[b[0]]);}
  if(!source.size)return b=>{worldLightingIndex(size,b);return false;};
  // every row within radius in y and z gets the row's x-intervals [x-r,x+r]
  const target=new Map();
  for(const [row,xs] of source){
    xs.sort((a,b)=>a-b);
    const spans=[];
    for(const x of xs){const lo=Math.max(0,x-radius),hi=Math.min(nx-1,x+radius);if(spans.length&&lo<=spans[spans.length-1]+1)spans[spans.length-1]=Math.max(spans[spans.length-1],hi);else spans.push(lo,hi);}
    const y=row%ny,z=(row-y)/ny;
    for(let tz=Math.max(0,z-radius);tz<=Math.min(nz-1,z+radius);tz++)for(let ty=Math.max(0,y-radius);ty<=Math.min(ny-1,y+radius);ty++){
      const key=ty+ny*tz,list=target.get(key);if(list)list.push(spans);else target.set(key,[spans]);
    }
  }
  // each target row's intervals merged: sorted, disjoint [lo,hi] pairs
  const rows=new Map();
  for(const [key,lists] of target){
    let pairs;
    if(lists.length===1)pairs=lists[0];
    else{
      const all=[];for(const l of lists)for(let k=0;k<l.length;k+=2)all.push([l[k],l[k+1]]);
      all.sort((a,b)=>a[0]-b[0]);pairs=[];
      for(const [lo,hi] of all){if(pairs.length&&lo<=pairs[pairs.length-1]+1)pairs[pairs.length-1]=Math.max(pairs[pairs.length-1],hi);else pairs.push(lo,hi);}
    }
    rows.set(key,Int32Array.from(pairs));
  }
  return b=>{
    worldLightingIndex(size,b);
    const pairs=rows.get(b[1]+ny*b[2]);if(!pairs)return false;
    const x=b[0];let lo=0,hi=pairs.length/2-1;
    while(lo<=hi){const m=(lo+hi)>>1;if(pairs[2*m+1]<x)lo=m+1;else if(pairs[2*m]>x)hi=m-1;else return true;}
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

// One texel from buffer to the scoped destination: the Atlas's batched
// copyTexel (one dispatch a buffer and texture, gpu/copyTexels.js) when it
// offers one, else a native copy.
function copyTexel(encoder, bindings, buffer, offset, destination) {
  if (bindings.copyTexel) bindings.copyTexel(buffer, offset, destination);
  else encoder.copyBufferToTexture({ buffer, offset }, destination, [1, 1, 1]);
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
      copies.forEach((c, i) => copyTexel(encoder, bindings, source, c.from, bindings.destinations[i]));
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
      // Every lease's copies in one Atlas submission (recordLightWrites), not a
      // command encoder and a submission per lease: a restore is every owned
      // SOURCE and probe, 90k-115k leases a big map's tick (2026-10-22).
      const writes=prepared.map(({job,lease,pin})=>{
        validateWorldLightingRestore(lease,{job});
        const {buffer:source,ranges}=pin.bindings();
        return {job,kind:lease.kind,restoreDeclaration:lease,record(encoder,bindings){
          ranges.forEach((c,i)=>copyTexel(encoder,bindings,source,c.from,bindings.destinations[i]));
        }};
      });
      if(writes.length)atlas.recordLightWrites(writes);
      await device.queue.onSubmittedWorkDone();
    } finally {retire();}
  }
  return { write, writeAll, restore };
}
