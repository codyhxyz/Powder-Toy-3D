// Disabled phase-4 producer, not an application scheduler or frame gate.
import { worldSunWriter, worldSunWriterLayouts } from '../shaders/worldSunWriter.js';
import { worldSunCoarse, worldSunCoarseLayouts } from '../shaders/worldSunCoarse.js';
import { WorldSunParams, worldSunProjection, WORLD_SUN_PITCH } from '../world/worldSun.js';
import { SUN_TAN_RADIUS } from './sky.js';
const BU = {COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128};
const TU = {COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8};
const dot = (a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
const freeze = a=>Object.freeze(Array.from(a));
const equal = (a,b)=>a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
const deferredError = e=>({error:e instanceof Error?e:new Error(String(e))});

// Same physical matrix for changes AND receivers. Changes include the original
// cubic sampling support (2 cells); receivers include full-depth PCSS support.
// A projected dirty column covers ALL depths: offscreen roofs are not culled.
export function worldSunBoundsTiles(projection,bounds,margin=2+2*WORLD_SUN_PITCH) {
  const {u,v}=projection.basis, t=projection.tiles, out=new Set();
  for(const b of bounds) {
    if(!b?.min||!b?.max||b.min.length!==3||b.max.length!==3||b.min.some((n,i)=>!Number.isFinite(n)||!Number.isFinite(b.max[i])||n>b.max[i])) throw new RangeError('world bounds');
    const corners=Array.from({length:8},(_,k)=>b.min.map((n,i)=>((k>>i)&1?b.max[i]:n)+(((k>>i)&1)?margin:-margin)));
    const lo=[u,v].map(axis=>Math.floor(Math.min(...corners.map(p=>dot(p,axis)))/WORLD_SUN_PITCH/256));
    const hi=[u,v].map(axis=>Math.floor(Math.max(...corners.map(p=>dot(p,axis)))/WORLD_SUN_PITCH/256));
    for(let y=Math.max(t[1],lo[1]);y<=Math.min(t[1]+t[3]-1,hi[1]);y++) for(let x=Math.max(t[0],lo[0]);x<=Math.min(t[0]+t[2]-1,hi[0]);x++) out.add(x-t[0]+t[2]*(y-t[1]));
  }
  return [...out].sort((a,b)=>a-b);
}

/** Explicit borrowed-input protocol (see docs/world-sun-producer.md).
 * sourceFieldSnapshotProvider.acquire() -> PINNED published source+field view.
 * readerBindingProvider(snapshot) -> [G0 entries0..4, G1 entries0..5].
 * feedbackProvider.layout({snapshot,tileCount,sunTileCount}) -> explicit words.
 * feedbackProvider.reserve(frame) -> {submitted:Promise, record(frame,buffer)}.
 * submitted resolves ONLY after submission, rejects ONLY after encoder discard.
 * record records readback after all jobs and returns Promise<Uint32Array>.
 * No callback may submit via a private encoder or read back geometry.
 */
export function createWorldSunLighting(gpu, {g,sourceFieldSnapshotProvider,readerBindingProvider,feedbackProvider}={}) {
  const device=gpu.device??gpu, queue=device.queue;
  if(!g||![g.nx,g.ny,g.nz].every(n=>Number.isInteger(n)&&n>0)||!sourceFieldSnapshotProvider?.acquire||!sourceFieldSnapshotProvider.isCurrent||typeof readerBindingProvider!=='function'||!feedbackProvider?.layout||!feedbackProvider.reserve) throw new TypeError('explicit world metadata, pinned snapshot, bindings and feedback providers required');
  const grid=Object.freeze({...g}), size=[g.nx,g.ny,g.nz], descriptors=worldSunWriterLayouts();
  const layouts=descriptors.map((entries,i)=>device.createBindGroupLayout({label:`world sun ${i}`,entries}));
  const ready=device.createComputePipelineAsync({label:'full world optical sun',layout:device.createPipelineLayout({bindGroupLayouts:layouts}),compute:{module:device.createShaderModule({code:worldSunWriter(grid)}),entryPoint:'main'}});
  // Far tiles' coarse writer (world/worldSunRings.js): its own small module, so
  // the full writer's and the view's stay as they were. It shares the job and
  // feedback group layouts, so one job/feedback bind group serves either.
  const coarseLayouts=worldSunCoarseLayouts().map((entries,i)=>i>=2?layouts[i]:device.createBindGroupLayout({label:`world coarse sun ${i}`,entries}));
  const coarseReady=Promise.resolve(device.createComputePipelineAsync({label:'world coarse sun',layout:device.createPipelineLayout({bindGroupLayouts:coarseLayouts}),compute:{module:device.createShaderModule({code:worldSunCoarse(grid)}),entryPoint:'main'}}));
  coarseReady.catch(()=>{});
  // GPU copies of coarse heightfields (worldCoarseCasters), by identity.
  const coarseSources=new Map();let coarseSerial=0;
  const maxBuffer=Math.min(128*1024**2,device.limits?.maxStorageBufferBindingSize??128*1024**2);
  let dead=false, serial=0, publication=0, active=null;
  function coarseSource(casters) {
    let c=coarseSources.get(casters);
    if(c)return c;
    if(!(casters?.heights instanceof Float32Array)||!Array.isArray(casters.dims)||casters.heights.length!==casters.dims[0]*casters.dims[1]||!Number.isFinite(casters.maxTop))throw new TypeError('coarse casters: a heightfield of one f32 per brick column');
    const heights=buffer('coarse sun casters',casters.heights,BU.STORAGE|BU.COPY_DST);
    let info;try{info=buffer('coarse sun casters shape',new Float32Array([casters.dims[0],casters.dims[1],casters.maxTop,0]),BU.UNIFORM|BU.COPY_DST);}catch(e){heights.destroy();throw e;}
    c={id:++coarseSerial,heights,info,groups:[device.createBindGroup({layout:coarseLayouts[0],entries:[{binding:0,resource:{buffer:heights}}]}),device.createBindGroup({layout:coarseLayouts[1],entries:[{binding:0,resource:{buffer:info}}]})]};
    coarseSources.set(casters,c);return c;
  }
  const dropCoarse=()=>{for(const c of coarseSources.values()){c.heights.destroy();c.info.destroy();}coarseSources.clear();};
  const pending=new Set();
  const alive=()=>{if(dead)throw new Error('world sun disposed');};
  const buffer=(label,data,usage)=>{
    if(data.byteLength>maxBuffer)throw new RangeError(`${label} exceeds buffer limit`);
    const b=device.createBuffer({label,size:data.byteLength,usage});
    try {queue.writeBuffer(b,0,data);return b;} catch(e) {b.destroy();throw e;}
  };
  function drop(p) { if(p && --p.refs===0) {p.book.destroy();p.sun0.destroy();p.sun1.destroy();} }
  function handle(p) {
    if(!p) return null;
    p.refs++;let released=false;
    return Object.freeze({token:p.token,params:p.params,release(){if(!released){released=true;drop(p);}},
      // This handle owns a reference; each queued consumer must retain a handle
      // until ITS submission AND GPU completion, not merely until draw returns.
      textures(){if(released)throw new Error('released sun snapshot');return Object.freeze({sun0:p.sun0,sun1:p.sun1});},
      bindings(){if(released)throw new Error('released sun snapshot');return Object.freeze({params:p.params,book:p.book,sun0:p.view0,sun1:p.view1,token:p.token});}});
  }
  const snapshot=()=>{alive();return handle(active);};
  // coarseTiles: tiles of the request drawn from coarseCasters' heightfield
  // instead of their CELL casters (world/worldSunRings.js). A tile changes kind
  // only by being written again: a copy never turns coarse into full detail.
  async function prepare({direction,basisRevision,configVersion,sceneToken,receiverBounds=[],requestedTiles,changedWorldBounds,changeBaseToken,coarseTiles=[],coarseCasters=null}={}) {
    alive(); const id=++serial, owned=[], candidatesTextures=[];let input=null,old=null,recorded=false,finished=false,retained=false;
    const releaseInputs=()=>{input?.release();input=null;if(old){drop(old);old=null;}owned.splice(0).forEach(b=>b.destroy());};
    const destroyOutputs=()=>candidatesTextures.splice(0).forEach(t=>t.destroy());
    try {
      if(!Number.isInteger(basisRevision)||basisRevision<0||basisRevision>0xffffffff||configVersion===undefined||sceneToken===undefined||!Array.isArray(receiverBounds))throw new TypeError('basis/config/scene and explicit receiver coverage required');
      const projection=worldSunProjection(size,direction);
      const tileLimit=projection.tiles[2]*projection.tiles[3];
      if(requestedTiles!==undefined&&(!Array.isArray(requestedTiles)||requestedTiles.some(n=>!Number.isInteger(n)||n<0||n>=tileLimit)))throw new RangeError('requested virtual sun tile IDs');
      const wanted=[...new Set([...worldSunBoundsTiles(projection,receiverBounds,2+2*WORLD_SUN_PITCH+SUN_TAN_RADIUS*(projection.depth[0]-projection.depth[1])),...(requestedTiles??[])])].sort((a,b)=>a-b);
      if(!Array.isArray(coarseTiles)||coarseTiles.some(n=>!Number.isInteger(n)||n<0||n>=tileLimit))throw new RangeError('coarse virtual sun tile IDs');
      const coarse=new Set(coarseTiles.filter(n=>wanted.includes(n)));
      const coarseInput=coarse.size?coarseSource(coarseCasters):null;
      const kinds=new Map(wanted.map(i=>[i,coarse.has(i)?'coarse':'fine']));
      // Empty is an UNKNOWN book for offscreen feedback, not a fully-lit map.
      // The caller may clear/reuse its dirty accumulator as soon as prepare
      // returns a promise. Capture physical tile meaning before any await.
      const changedTiles=changedWorldBounds===undefined?null:new Set(worldSunBoundsTiles(projection,changedWorldBounds,8+2*WORLD_SUN_PITCH));
      input=await sourceFieldSnapshotProvider.acquire(); alive();
      if(id!==serial||!sourceFieldSnapshotProvider.isCurrent(input)) {releaseInputs();return Object.freeze({status:'stale'});}
      if(!input?.release||!Array.isArray(input.worldSize)||!equal(input.worldSize,size)||!Number.isInteger(input.epoch)||input.epoch<1||input.epoch>0xffffffff||input.source?.contentToken===undefined||input.source.sourceRevision===undefined||input.field?.publishedToken===undefined||input.field.complete!==true||input.field.sourceRevision!==input.source.sourceRevision||(!Number.isInteger(input.field.logicalFieldTick)||input.field.logicalFieldTick<0))throw new Error('complete consistent pinned source/field publication required');
      if(![input.dependencySetID,input.dependencyVersion].every(n=>Number.isInteger(n)&&n>=0&&n<=0xffffffff))throw new TypeError('explicit dependency closure reference/version required');
      const key=[sceneToken,input.epoch,basisRevision,configVersion,...projection.basis.sun];
      const content=[input.source.contentToken,input.field.publishedToken,input.field.sourceRevision,input.field.logicalFieldTick,input.dependencySetID,input.dependencyVersion];
      if(active&&equal(key,active.key)&&equal(content,active.content)&&equal(wanted,[...active.slots.keys()])&&wanted.every(i=>active.kinds.get(i)===kinds.get(i))&&(!coarseInput||coarseInput.id===active.coarseId)) {releaseInputs();return Object.freeze({status:'cached',snapshot:snapshot()});}
      const layers=Math.max(1,Math.ceil(wanted.length/64)), limit=device.limits?.maxTextureArrayLayers??256;
      if(layers>limit||(device.limits?.maxTextureDimension2D??8192)<2048)throw new RangeError('sun coverage exceeds legal physical array capacity; never lower texel density');
      const tileCount=projection.tiles[2]*projection.tiles[3];
      if(tileCount*32>maxBuffer)throw new RangeError('SunBook exceeds storage binding limit');
      const fb=feedbackProvider.layout({snapshot:input,tileCount:wanted.length,sunTileCount:tileCount});
      if(!Number.isInteger(fb?.wordCount)||fb.wordCount<1||fb.wordCount*4>maxBuffer||!Number.isInteger(fb.requestWordOffset)||fb.requestWordOffset<0||fb.requestWordOffset+Math.ceil(tileCount/32)>fb.wordCount||!Number.isInteger(fb.jobStatusWordOffset)||fb.jobStatusWordOffset<0||fb.jobStatusWordOffset+wanted.length>fb.wordCount||!(fb.jobStatusWordOffset+wanted.length<=fb.requestWordOffset||fb.jobStatusWordOffset>=fb.requestWordOffset+Math.ceil(tileCount/32))||typeof fb.decode!=='function')throw new TypeError('explicit non-overlapping feedback suffix/status layout required');
      const revision=++publication;
      if(revision>0xffffffff)throw new RangeError('sun publication version exhausted');
      const params=Object.freeze({worldToLight:freeze(projection.worldToLight),depth:freeze(projection.depth),tiles:freeze(projection.tiles),physical:freeze([256,8,64,layers]),version:freeze([input.epoch,basisRevision,revision,fb.requestWordOffset])});
      const paramsBytes=new ArrayBuffer(128);WorldSunParams.write(new DataView(paramsBytes),0,params);
      const ws=buffer('sun params',paramsBytes,BU.UNIFORM|BU.COPY_DST);owned.push(ws);
      const requests=buffer('sun query feedback',new Uint32Array(fb.wordCount),BU.STORAGE|BU.COPY_SRC|BU.COPY_DST);owned.push(requests);
      for(const format of ['rgba32float','r32float'])candidatesTextures.push(device.createTexture({label:`unpublished world sun ${revision} ${format}`,size:[2048,2048,layers],format,usage:TU.COPY_SRC|TU.COPY_DST|TU.TEXTURE_BINDING|TU.STORAGE_BINDING}));
      const [sun0,sun1]=candidatesTextures,view0=sun0.createView({dimension:'2d-array'}),view1=sun1.createView({dimension:'2d-array'});
      const borrowed=await readerBindingProvider(input); alive();
      if(!Array.isArray(borrowed)||borrowed.length!==2)throw new TypeError('writer subset bindings G0/G1 required');
      // Enforce the subset, not arbitrary full-reader bind groups with hidden
      // sampler/output aliases. Every input texture is source/field/aux only.
      borrowed.forEach((entries,i)=>{
        if(entries.length!==descriptors[i].length||entries.some(e=>!descriptors[i].some(d=>d.binding===e.binding)))throw new Error('writer input bindings must match dedicated subset');
        for(const e of entries)if(e.resource?.buffer?.size>maxBuffer)throw new RangeError('input buffer exceeds binding limit');
      });
      const group=(i,entries)=>device.createBindGroup({layout:layouts[i],entries});
      const first=borrowed.map((entries,i)=>group(i,entries));
      const feedbackGroup=group(3,[{binding:1,resource:{buffer:requests}}]);
      const slots=new Map(wanted.map((i,slot)=>[i,slot]));
      const dirty=changeBaseToken!==active?.token?null:changedTiles;
      // A supplied changed set is a complete semantic source AND field delta,
      // never an ownership/residency delta. New content without it rebuilds all.
      const reusable=active&&equal(key,active.key);
      if(reusable) {old=active;old.refs++;}
      const jobs=[], copies=[];
      for(const [index,slot] of slots) {
        const kind=kinds.get(index),same=reusable&&active.slots.has(index)&&active.kinds.get(index)===kind;
        // A coarse tile reads only the static heightfield: the same one copies.
        if(same&&(kind==='coarse'?active.coarseId===coarseInput.id:(equal(content,active.content)||(dirty&&!dirty.has(index))))) {copies.push({from:active.slots.get(index),to:slot,index});continue;}
        const bytes=new ArrayBuffer(32), v=new DataView(bytes);
        v.setInt32(0,projection.tiles[0]+index%projection.tiles[2],true);v.setInt32(4,projection.tiles[1]+Math.floor(index/projection.tiles[2]),true);
        v.setUint32(16,slot,true);v.setUint32(20,fb.jobStatusWordOffset+slot,true);v.setUint32(24,input.epoch,true);
        const job=buffer('sun tile job',bytes,BU.UNIFORM|BU.COPY_DST);owned.push(job);
        jobs.push({slot,index,coarse:kind==='coarse',group:group(2,[{binding:0,resource:{buffer:job}},{binding:1,resource:{buffer:ws}},{binding:2,resource:view0},{binding:3,resource:view1}])});
      }
      const pipe=await ready,coarsePipe=jobs.some(j=>j.coarse)?await coarseReady:null;alive();
      if(id!==serial||!sourceFieldSnapshotProvider.isCurrent(input)){releaseInputs();destroyOutputs();return Object.freeze({status:'stale'});}
      let status='prepared',completion=null;
      const candidate={params,tiles:freeze(wanted),coarse:freeze([...coarse].sort((a,b)=>a-b)),get status(){return status;},get completion(){return completion;},
        record(frame=gpu.frame) {
          alive();if(recorded||finished)throw new Error('sun candidate already consumed');
          if(id!==serial||!sourceFieldSnapshotProvider.isCurrent(input)) {
            candidate.cancel();status='stale';completion=Promise.resolve(Object.freeze({status,retry:true}));return completion;
          }
          // Reserve submission BEFORE any queued reference; lifetime covers
          // partial encoding errors too. Never infer completion before submit.
          const ticket=feedbackProvider.reserve(frame);
          if(!ticket?.submitted?.then||typeof ticket.record!=='function')throw new TypeError('submission/readback ticket required');
          recorded=true;status='pending';let feedback,encodingError;
          try {
            for(const c of copies) {
              const origin=s=>({x:(s%8)*256,y:(Math.floor(s/8)%8)*256,z:Math.floor(s/64)});
              const encoder=frame.direct();
              encoder.copyTextureToTexture({texture:old.sun0,origin:origin(c.from)},{texture:sun0,origin:origin(c.to)},[256,256,1]);
              encoder.copyTextureToTexture({texture:old.sun1,origin:origin(c.from)},{texture:sun1,origin:origin(c.to)},[256,256,1]);
            }
            for(const j of jobs) {
              const label=j.coarse?'world coarse sun':'world optical sun';
              frame._command();const pass=frame.compute(label,{dispatch:true});pass.setPipeline(j.coarse?coarsePipe:pipe);
              [...(j.coarse?coarseInput.groups:first),j.group,feedbackGroup].forEach((g,i)=>pass.setBindGroup(i,g));pass.dispatchWorkgroups(32,32,1);frame._commandDone(label);
            }
          } catch(e) { encodingError=e; }
          // Even a partial encoding must close the ticket's readback boundary;
          // its submitted promise then covers the final encoder or discard.
          try {feedback=Promise.resolve(ticket.record(frame,requests));}
          catch(e) {feedback=Promise.resolve(deferredError(e));}
          // Attach rejection handling immediately, even before submission.
          feedback=feedback.catch(deferredError);
          const submitted=Promise.resolve(ticket.submitted).then(()=>null,error=>({error}));
          completion=submitted.then(async submissionFailure=>{
            await queue.onSubmittedWorkDone();
            if(submissionFailure)throw submissionFailure.error;
            const words=await feedback;
            if(encodingError)throw encodingError;
            if(words?.error)throw words.error;
            if(!(words instanceof Uint32Array)||words.length!==fb.wordCount)throw new Error('complete sun feedback readback required');
            const decoded=fb.decode(words);
            const failures=jobs.filter(j=>words[fb.jobStatusWordOffset+j.slot]!==1).map(j=>j.index);
            if(decoded.incomplete||failures.length){status='incomplete';return Object.freeze({status,failedTiles:freeze(failures),feedback:decoded,retry:true});}
            if(dead||id!==serial||!sourceFieldSnapshotProvider.isCurrent(input)){status='stale';return Object.freeze({status,retry:true});}
            const bookWords=new Uint32Array(tileCount*8);
            for(const [index,slot] of slots)bookWords.set([slot,input.epoch,basisRevision,revision,input.dependencySetID,input.dependencyVersion,1,0],index*8);
            const book=buffer('immutable SunBook',bookWords,BU.STORAGE|BU.COPY_DST);
            const token=Object.freeze({epoch:input.epoch,basisRevision,publishRevision:revision,sceneToken,configVersion,sourceContentToken:input.source.contentToken,fieldPublishedToken:input.field.publishedToken,logicalFieldTick:input.field.logicalFieldTick});
            const next={refs:1,book,sun0,sun1,view0,view1,slots,kinds,coarseId:coarseInput?.id??active?.coarseId??0,params,token,key,content};
            const previous=active;active=next;retained=true;candidatesTextures.length=0;drop(previous);status='published';
            return Object.freeze({status,token});
          }).catch(e=>{status='failed';return Object.freeze({status,error:String(e.message??e),retry:true});}).finally(()=>{finished=true;pending.delete(candidate);releaseInputs();if(!retained)destroyOutputs();});
          return completion;
        },
        cancel(){if(recorded)throw new Error('queued sun candidate must complete, not cancel');if(!finished){finished=true;status='cancelled';pending.delete(candidate);releaseInputs();destroyOutputs();}},
      };
      pending.add(candidate);return Object.freeze(candidate);
    } catch(e) {releaseInputs();destroyOutputs();throw e;}
  }
  return Object.freeze({ready,prepare,snapshot,bindings(s){alive();if(!s?.bindings)throw new Error('pinned sun snapshot required');return s.bindings();},
    reset(){alive();serial++;drop(active);active=null;for(const c of [...pending])if(c.status==='prepared')c.cancel();},
    dispose(){if(dead)return;serial++;dead=true;drop(active);active=null;for(const c of [...pending])if(c.status==='prepared')c.cancel();dropCoarse();},
  });
}
