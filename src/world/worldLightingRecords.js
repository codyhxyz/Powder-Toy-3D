// Persistent CPU lighting metadata. Internal trusted-caller API, NOT a sandbox.
// Only tiny submitted classifier records + native word-delta flags cross to CPU.
import { AGE } from '../shaders/fields.js';
import { BRICK_INFO } from '../shaders/bindings.js';
import { brickIdOf } from '../shaders/common.js';
import { SOURCE_GRID } from './renderSource.js';
import { READY } from './renderAtlas.js';
import { validateWorldSourceCut } from './sourceCut.js';
import { BU, uint, frozenArray, worldLightingIndex, createLightingResources, completeLightingBatch } from '../gfx/worldLightingBatch.js';
import { createWorldFeedbackProvider } from '../gfx/worldLightingInputs.js';
import { worldLightingDeltaWGSL, worldLightingDeltaLayouts } from '../shaders/worldLightingDelta.js';
export const WORLD_LIGHTING_RECORD_LAYOUT=Object.freeze({metadataWords:4,changeWords:1,emission:'f32 xyz /64 (original bit words retained)',info:'u32 original BrickInfo',order:'classification.records order; metadata first, then one u32 change per brick'});
// worldLightingRecords stale()'s rule, over its committed rows (index -> row),
// their cores (core -> capture buffer -> indices) and the cut's delta since
// the baseline: the rows to read again, but those overlay already holds.
export function worldLightingStale({dims,committed,cores,delta,captureOf,overlay=null}) {
  const cdims=dims.map(n=>Math.ceil(n/8)),out=new Set(),add=i=>{if(!overlay?.has(i))out.add(i);};
  if(delta.global){for(const i of committed.keys())add(i);return out;}
  for(const b of delta.changedBricks){const i=b[0]+dims[0]*(b[1]+dims[1]*b[2]);if(committed.has(i))add(i);}
  for(const [k,byBuffer] of cores){const now=captureOf([(k%cdims[0])*8,(Math.floor(k/cdims[0])%cdims[1])*8,Math.floor(k/(cdims[0]*cdims[1]))*8]);for(const [buffer,set] of byBuffer)if(buffer!==now)for(const i of set)add(i);}
  return out;
}
export function createWorldLightingRecords(gpu,{worldSize,sourceOwner,submissionProvider=createWorldFeedbackProvider(gpu,{})}={}){
  if(!Array.isArray(worldSize)||worldSize.length!==3||worldSize.some((n,k)=>!uint(n)||!n||n%4||n!==sourceOwner?.win.size[k])||sourceOwner?.gpu!==gpu)throw new TypeError('world size and actual Source owner required');
  const size=frozenArray(worldSize),dims=size.map(n=>n/4),device=gpu.device,queue=device.queue,{buffer}=createLightingResources(device);
  const layouts=[false,true].map(aux=>device.createBindGroupLayout({entries:worldLightingDeltaLayouts(aux)})),pipes=[];
  let readyState=false,dead=false,generation=0,pending=null,committed=new Map(),baseline=null,clock=-1;
  // The committed rows by 32-cell core (8^3 bricks) and the classification
  // capture each was read from (its buffer: a capture's classification is
  // written once, by its classifier dispatch, and only read after; a new
  // capture is a new buffer, cellAtlasAdapter.js recordOwnedFields). A row
  // whose capture is still its core's and whose brick no cut since changed
  // reads back the same words, so a new transaction records only the rest
  // (stale): every row of all 450k-680k bricks a tick was most of a big
  // map's metadata stage (2026-10-22).
  const cdims=dims.map(n=>Math.ceil(n/8)),cores=new Map();
  const coreOf=i=>{const x=i%dims[0],y=Math.floor(i/dims[0])%dims[1],z=Math.floor(i/(dims[0]*dims[1]));return (x>>3)+cdims[0]*((y>>3)+cdims[1]*(z>>3));};
  const coreAdd=(i,buffer)=>{const k=coreOf(i);let byBuffer=cores.get(k);if(!byBuffer)cores.set(k,byBuffer=new Map());let set=byBuffer.get(buffer);if(!set)byBuffer.set(buffer,set=new Set());set.add(i);};
  const coreDelete=(i,buffer)=>{const k=coreOf(i),byBuffer=cores.get(k),set=byBuffer?.get(buffer);if(!set)return;set.delete(i);if(!set.size){byBuffer.delete(buffer);if(!byBuffer.size)cores.delete(k);}};
  // A batch's rows over the committed ones, without a copy of every committed row.
  const view=next=>({has:i=>next.has(i)||committed.has(i),get:i=>next.get(i)??committed.get(i)});
  // A completed, unadopted batch's rows, for the next record() of the same cut,
  // clock and baseline to carry (a restarted load attempt): its rows are what a
  // new record() would read back again. Island's metadata stage re-recorded
  // 449k rows for 2.3-2.5 s on every restart (2026-10-22).
  const carries=new WeakMap();
  const ready=Promise.all(layouts.map((l,i)=>device.createComputePipelineAsync({label:`world lighting delta ${i?'aux':'raw'}`,layout:device.createPipelineLayout({bindGroupLayouts:[l]}),compute:{module:device.createShaderModule({code:worldLightingDeltaWGSL(!!i)}),entryPoint:'main'}}).then(p=>{pipes[i]=p;}))).then(()=>{readyState=true;});ready.catch(()=>{});
  const alive=()=>{if(dead)throw new Error('world lighting records disposed');};
  const brick=i=>[i%dims[0],Math.floor(i/dims[0])%dims[1],Math.floor(i/(dims[0]*dims[1]))];
  const index=i=>{if(!uint(i)||i>=dims[0]*dims[1]*dims[2])throw new RangeError('world lighting record index');return i;};
  const requirements=indices=>{const e=new Error('Submitted world lighting metadata required');e.requirements=indices.map(i=>Object.freeze({index:i,brick:frozenArray(brick(i)),channels:READY.CELL}));return e;};
  function read(map,indices,derivedTick){
    if(!uint(derivedTick)||derivedTick<clock)throw new Error('derived logical tick regression');
    const ids=Array.from(indices,index),missing=ids.filter(i=>!map.has(i));if(missing.length)throw requirements(missing);
    return frozenArray(ids.map(i=>{const r=map.get(i);if(derivedTick<r.changedTick)throw new Error('record predates actual change');return Object.freeze({brick:r.brick,age:Math.min(AGE.MAX,derivedTick-r.changedTick),matter:!!(r.info&BRICK_INFO.MATTER),near:false});}));
  }
  // The indices a completed pending batch holds, if record() may carry it for
  // this cut and clock; otherwise null.
  function carryable(batch,{cut,derivedTick}={}){
    const c=carries.get(batch);
    return c&&pending===batch&&batch.status==='pending-acceptance'&&c.generation===generation&&c.cutIdentity===cut?.identity&&c.derivedTick===derivedTick&&c.baseline===baseline?c.indices:null;
  }
  // The committed rows a record() at cut must read again (captureOf(brick):
  // the classification buffer a lease would read the brick's core from now,
  // cellAtlasAdapter.js classificationBuffer): every one when there is no
  // baseline delta (none committed, or a global change); else each one whose
  // brick the delta since the baseline lists (its words may differ: the native
  // delta compares them) and each one read from a capture its core no longer
  // has. Any other row reads back what it holds: the same capture's words,
  // and no change word (a row the delta does not list records none, and its
  // source is known: ranks fall to unknown only by a global change,
  // renderSource.js invalidateGenerated). Rows a carried batch (carryable)
  // already read at this cut are not listed. Bounded by the delta and the
  // cores, not by the rows committed.
  function stale(cut,{captureOf,carry=null}={}){
    alive();if(typeof captureOf!=='function')throw new TypeError('classification capture lookup required');
    if(!baseline||!committed.size)return new Set();
    return worldLightingStale({dims,committed,cores,delta:cut.source.changesSince(baseline.contentToken),captureOf,overlay:carry?carries.get(carry)?.next:null});
  }
  // captureOf (stale): rows of committed bricks may be left out where they
  // read back what they hold; without it every committed row is recorded.
  function record(frame,{cut,previousCut=null,classification,derivedTick,carry=null,captureOf=null}={}){
    const carried=carry&&carryable(carry,{cut,derivedTick});
    if(carry&&!carried)throw new Error('carried records require the pending batch of this cut, clock and baseline');
    alive();if(!readyState||frame!==gpu.frame||pending&&pending!==carry)throw new Error('ready normal Frame and no pending records transaction required');
    if(!uint(derivedTick)||derivedTick<clock||derivedTick>clock+1&&clock!==-1)throw new Error('derived logical tick must advance once or retry same clock');
    validateWorldSourceCut(cut,{sourceOwner,epoch:sourceOwner.epoch,configuration:sourceOwner.cutConfiguration});
    if(baseline&&baseline.configuration!==cut.configuration)throw new Error('reset records on Source schema/configuration change');
    if(previousCut&&(!baseline||previousCut.identity!==baseline.identity))throw new Error('previous cut must name committed immutable backing');
    const pub=classification?.publication,pc=pub?.ownedCut;
    validateWorldSourceCut(pc,{sourceOwner,epoch:cut.identity.epoch,configuration:cut.configuration});
    if(pub.isReleased()||pc.identity!==cut.identity||pub.source.sourceRevision!==cut.contentToken.sourceRevision||pub.source.contentToken.epoch!==cut.identity.epoch||pub.worldSize.some((n,k)=>n!==size[k]))throw new Error('classification publication does not match owned cut');
    if(!Array.isArray(classification.records)||!classification.records.length||typeof classification.recordMetadata!=='function')throw new TypeError('real submitted classification lease required');
    const rows=classification.records,seen=new Set();
    for(const r of rows){if(worldLightingIndex(size,r.brick)!==r.index||seen.has(r.index)||carried?.has(r.index)||r.byteOffset!==brickIdOf(SOURCE_GRID,...r.brick.map(n=>n%8))*16||r.buffer.size<r.byteOffset+16)throw new Error('classification record layout/index mismatch');seen.add(r.index);}
    if(captureOf){const missing=[];for(const i of stale(cut,{captureOf,carry:carried?carry:null}))if(!seen.has(i))missing.push(i);if(missing.length)throw requirements(missing);}
    else{const missing=[...committed.keys()].filter(i=>!seen.has(i)&&!carried?.has(i));if(missing.length&&baseline?.identity!==cut.identity)throw requirements(missing);}
    // No original frozen MARK_DERIVED/ACT_CHANGED map is exposed by Source.
    // Bounds only nominate cores; compare actual words, never their revisions.
    // Compare every supplied known record (bounded by 32³ core), so broad
    // Source journals and origin-only ownership transfers cannot reset ages.
    const groups=new Map(),births=new Set();
    const delta=baseline?cut.source.changesSince(baseline.contentToken):null;
    for(let slot=0;slot<rows.length;slot++){
      const r=rows[slot],p=r.brick.map(n=>n*4),box={lo:p,hi:p.map(n=>n+4)};cut.source.assertComplete([box]);
      const b=cut.source.getSource(p),a=baseline?.source.getSource(p);
      if(!committed.has(r.index)||!a||a.kind==='unknown'){births.add(slot);continue;}
      // (membership in the delta's boxes: no set of its bricks, no key per row)
      if(!delta.global&&!delta.includes(r.brick))continue;
      baseline.source.assertComplete([box]);
      const key=b.chunk.key;let g=groups.get(key);if(!g){g={a:a.chunk,b:b.chunk,jobs:[]};groups.set(key,g);}
      const j=new Uint32Array(132);j.set([a.slot,b.slot,rows.length*4+slot,0]);
      for(let s=0;s<64;s++)j.set([a.chunk.aux[a.slot+s],b.chunk.aux[b.slot+s]],4+2*s);g.jobs.push(j);
    }
    const prior=carried?carries.get(carry):null;if(carried)carry.discard();
    const owned=[],held=cut.retain(),old=baseline?.retain(),atGeneration=generation;let consumed=false,complete=false,result=null,outcome='recorded',readback=null;
    const valid=()=>!dead&&generation===atGeneration&&!consumed;
    const cleanup=()=>{owned.forEach(b=>b.destroy());held.release();old?.release();classification.release();};
    const batch={layout:WORLD_LIGHTING_RECORD_LAYOUT,indices:frozenArray([...(prior?.indices??[]),...rows.map(r=>r.index)]),wordCount:rows.length*5,metadataWordOffset:0,changeWordOffset:rows.length*4,
      get status(){return consumed?outcome:complete?'pending-acceptance':'recorded';},get completion(){return result;},
      get readback(){if(!complete||!valid())throw new Error('metadata readback not complete/live');return readback;},
      records(indices,{derivedTick:at=derivedTick}={}){alive();if(!complete||!valid())throw new Error('metadata transaction not complete/live');return read(view(next),indices,at);},
      discard(){if(!consumed){outcome='discarded';consumed=true;if(pending===batch)pending=null;}},
      get changes(){if(!complete||!valid())throw new Error('metadata readback not complete/live');return changes;}
    };
    let next,changes;pending=batch;
    try{
      // reserve precedes all encoding; even a partial failed prefix stays pinned.
      result=completeLightingBatch({frame,queue,feedbackBuffer:null,wordCount:batch.wordCount,submissionProvider:{reserve(f){const ticket=submissionProvider.reserve(f);return {submitted:ticket.submitted,record(target,_unused,count){return ticket.record(target,batch.buffer,count);}};}},encode(){
        const metadata=classification.recordMetadata(frame);
        if(metadata.size!==Math.max(16,rows.length*16))throw new Error('entire submitted metadata layout required');
        const data=buffer('world lighting tiny metadata+delta',batch.wordCount*4,BU.STORAGE|BU.COPY_SRC|BU.COPY_DST);owned.push(data);batch.buffer=data;
        frame.copy(metadata,0,data,0,rows.length*16);frame.clear(data,rows.length*16,rows.length*4);
        if(births.size){const bits=new Uint32Array(rows.length);for(const s of births)bits[s]=1;const upload=buffer('lighting births',bits.byteLength,BU.COPY_SRC,bits);owned.push(upload);frame.copy(upload,0,data,rows.length*16,bits.byteLength);}
        if(groups.size){const zero=buffer('absent source auxiliary',SOURCE_GRID.slots*8,BU.STORAGE);owned.push(zero);
          for(const g of groups.values()){
            const jobs=buffer('immutable paired slot/presence jobs',g.jobs.length*132*4,BU.STORAGE,Uint32Array.from(g.jobs.flatMap(j=>Array.from(j))));owned.push(jobs);
            const inputs=[[g.a.A,g.b.A,g.a.B,g.b.B,data,jobs],[g.a.flow??zero,g.b.flow??zero,g.a.aeration??zero,g.b.aeration??zero,g.a.deco?.buffer??zero,g.b.deco?.buffer??zero,data,jobs]];
            for(let k=0;k<2;k++){const group=device.createBindGroup({layout:layouts[k],entries:inputs[k].map((buffer,binding)=>({binding,resource:{buffer}}))});const pass=frame.direct().beginComputePass({label:'world lighting exact delta'});pass.setPipeline(pipes[k]);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(g.jobs.length/64));pass.end();}
          }
        }
      },finish(words){
        if(!valid()||!held.isValid())throw new Error('discarded/stale world lighting metadata');
        // Carried: the prior batch is consumed, so its map and lists extend in place.
        // next: this transaction's rows only, read over the committed ones (view).
        readback=frozenArray(words);next=prior?.next??new Map();const changed=prior?.changed??[],emission=prior?.emission??[];
        rows.forEach((r,s)=>{const prior=committed.get(r.index),b=frozenArray(r.brick),emit=frozenArray(words.subarray(4*s,4*s+3)),info=words[4*s+3],actual=!!words[rows.length*4+s];if(actual)changed.push(b);if(!prior||emit.some((w,k)=>w!==prior.emit[k]))emission.push(b);next.set(r.index,{brick:b,info,emit,changedTick:actual?derivedTick:prior.changedTick,buffer:r.buffer});});
        // Each emission change's 9x9x9 brick halo, from the distinct brick x of each
        // (y,z) row it reaches: a load's every brick emits anew, and 729 set adds
        // each took 1.2 s on Descent (2026-10-21). Built when first read: no load
        // stage reads it, and 81 row adds for each of 449k bricks were most of an
        // Island restart's metadata stall (2026-10-22).
        let halo=null;
        const glowHalo=()=>{if(halo)return halo;const haloRows=new Map();for(const b of emission)for(let z=Math.max(0,b[2]-4);z<=Math.min(dims[2]-1,b[2]+4);z++)for(let y=Math.max(0,b[1]-4);y<=Math.min(dims[1]-1,b[1]+4);y++){const row=y+dims[1]*z,xs=haloRows.get(row);if(xs)xs.add(b[0]);else haloRows.set(row,new Set([b[0]]));}
          const out=[];for(const row of Float64Array.from(haloRows.keys()).sort()){let end=-1;for(const x of Int32Array.from(haloRows.get(row)).sort()){for(let i=Math.max(0,x-4,end+1);i<=Math.min(dims[0]-1,x+4);i++)out.push(i+dims[0]*row);end=Math.max(end,Math.min(dims[0]-1,x+4));}}
          return halo=frozenArray(out);};
        const changedBricks=frozenArray(changed),emissionChangedBricks=frozenArray(emission);
        changes=Object.freeze({derivedTick,changedBricks,emissionChangedBricks,get glowDirtyIndices(){return glowHalo();}});
        carries.set(batch,{next,changed,emission,indices:new Set(batch.indices),cutIdentity:cut.identity,derivedTick,generation:atGeneration,baseline});
        complete=true;return batch;
      }}).catch(e=>{batch.discard();throw e;}).finally(cleanup);
      // Completion cleanup releases native inputs, but acceptance still needs
      // its own real cut pin. Release it only on commit/discard/reset.
      const acceptance=held.retain(),discard=batch.discard;
      batch.discard=()=>{discard();acceptance.release();};
      // held is released on completion: use acceptance for post-readback commit.
      batch.commit=()=>{alive();if(!complete||!valid()||!acceptance.isValid())throw new Error('metadata transaction not complete/live');const pin=acceptance.retain();baseline?.release();baseline=pin;for(const [i,r] of next){const old=committed.get(i);if(old)coreDelete(i,old.buffer);committed.set(i,r);coreAdd(i,r.buffer);}clock=derivedTick;outcome='committed';consumed=true;pending=null;acceptance.release();return changes;};
      result.catch(()=>{});return Object.freeze(batch);
    }catch(error){batch.discard();cleanup();throw error;}
  }
  return Object.freeze({ready,record,carryable,stale,records(indices,{derivedTick=clock}={}){alive();return read(committed,indices,derivedTick);},get indices(){alive();return frozenArray(committed.keys());},
    has(i){alive();return committed.has(i);},get size(){return committed.size;},
    // Drops the rows of indices (world/worldResidency.js: bricks the view has
    // not used lately). A forgotten brick's next record is a birth, as a new one's.
    forget(indices){alive();if(pending)throw new Error('forget world lighting rows with a records transaction pending');for(const i of indices){const r=committed.get(i);if(r){committed.delete(i);coreDelete(i,r.buffer);}}},
    get pending(){return !!pending;},
    // The committed indices without a copy (a frozen array of a big map's 450k was a tick's first O(N) cost).
    keys(){alive();return committed.keys();},get derivedTick(){return clock;},reset(){alive();generation++;pending?.discard();pending=null;baseline?.release();baseline=null;committed=new Map();cores.clear();clock=-1;},dispose(){if(!dead){generation++;pending?.discard();pending=null;baseline?.release();baseline=null;committed.clear();cores.clear();dead=true;}}});
}
