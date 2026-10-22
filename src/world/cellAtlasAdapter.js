// Source -> shared Fields -> classified CELL pages. No application switch.
import { WorldFields } from './fields.js';
import { brickKey } from './fieldHistory.js';
import { SOURCE_GRID } from './renderSource.js';
import { gridDims, brickIdOf, LAYOUT } from '../shaders/common.js';
// One classified brick's metadata row: four u32 (shaders/worldCellAdapter.js).
const CLASSIFICATION_RECORD_BYTES = 16;
import { FIELD_TEXTURES } from '../gfx/fieldDeriver.js';
import { fold } from '../gpu/kernels.js';
import { READY, bookPage, worldBrickIndex } from './renderAtlas.js';
import { worldCellClassifierWGSL, WorldBrickParams, WORLD_CLASSIFIER_LAYOUT, worldCellPackWGSL, WORLD_CELL_PACK_LAYOUTS, worldFieldPackWGSL, WORLD_FIELD_PACK_LAYOUT } from '../shaders/worldCellAdapter.js';
const BU = { COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128 };
const same = (a,b) => a?.epoch === b?.epoch && a?.sourceRevision === b?.sourceRevision;
const coreFor = b => b.map(v => Math.floor(v/8)*32);
export const CELL_BATCH_WRITES = 1024;   // a raw and a fields write per page
let dependencyID = 1;

export class WorldCellAtlasAdapter {
  constructor({gpu,source,producer,atlas,tables,worldBounds}={}) {
    if (!gpu || !source || !producer || !atlas || !tables || !worldBounds) throw new TypeError('Concrete Source/Producer/Atlas/tables/bounds required');
    if (worldBounds.min.some(v=>v!==0) || worldBounds.max.some((v,i)=>v!==source.win.size[i] || v!==atlas.bookLayout.worldSize[i])) throw new Error('CELL source/atlas/world bounds mismatch');
    Object.assign(this,{gpu,source,producer,atlas,tables});
    this.mutableSource=source;this.boundCut=null;
    this.bounds={min:[...worldBounds.min],max:[...worldBounds.max]};
    this.cache=new Map(); this.capturePins=new WeakMap();
    // Captures a commit installed (the current publication's), and those
    // published to the cache since the last commit: a publication reads the
    // cache as it was at its commit (_installed), never a copy of it per batch.
    this.installed=new WeakSet(); this.uninstalled=new Set(); this.retiredCaptures=new WeakSet(); this.pending=null; this.dead=false; this.publication=null; this.lastSourceToken=null; this.dependencyID=dependencyID++;
    // Fields may commit while its Atlas publication is aborted or retried.
    // Keep that publication debt until a successful atomic Atlas patch.
    this.unpublishedInvalidations=new Set();this.unpublishedLists=[];this.lightingDirty=false;this.prepared=null;
    this.batchWrites=CELL_BATCH_WRITES;
    this.fields=new WorldFields(gpu,{worldBounds,tables,publisher:this});
    if(this.fields.history.epoch<source.epoch)this.fields.reset(source.epoch);
    const layout=gpu.layout('world owned classifier',WORLD_CLASSIFIER_LAYOUT);
    this.classifierLayout=layout;
    this.classifier=gpu.kernel({name:'world owned classifier',code:worldCellClassifierWGSL(gridDims({nx:64,ny:64,nz:64})),layouts:[gpu.layout('TABLES',LAYOUT.TABLES),gpu.layout('STATE_RO',LAYOUT.STATE_RO),layout],params:WorldBrickParams});
    // Use the same actual TABLES and STATE_RO layouts as the field kernels.
    // Native raw packing has its own seven-buffer, three-image layout.
    const device=gpu.device;
    this.packLayouts=WORLD_CELL_PACK_LAYOUTS.map((entries,i)=>device.createBindGroupLayout({label:`world CELL pack ${i}`,entries}));
    const nativeReady=device.createComputePipelineAsync({label:'world CELL raw/AUX pack',layout:device.createPipelineLayout({bindGroupLayouts:this.packLayouts}),compute:{module:device.createShaderModule({code:worldCellPackWGSL}),entryPoint:'main'}}).then(p=>{this.packPipeline=p;});
    this.fieldPackLayout=device.createBindGroupLayout({label:'world CELL field pack',entries:WORLD_FIELD_PACK_LAYOUT});
    const fieldReady=device.createComputePipelineAsync({label:'world CELL field pack',layout:device.createPipelineLayout({bindGroupLayouts:[this.fieldPackLayout]}),compute:{module:device.createShaderModule({code:worldFieldPackWGSL}),entryPoint:'main'}}).then(p=>{this.fieldPackPipeline=p;});
    this.zero=this._buffer('absent CELL auxiliary',SOURCE_GRID.slots*8,BU.STORAGE|BU.COPY_DST);
    this.ready=Promise.all([this.fields.ready,producer.ready,this.classifier.ready,nativeReady,fieldReady]).then(()=>{this.readyState=true;return this;});
    this.ready.catch(()=>{});
  }
  _alive(){if(this.dead)throw new Error('CELL adapter disposed');}
  _buffer(label,size,usage){return this.gpu.createBuffer({label,size,usage});}
  _upload(label,data,usage=BU.COPY_SRC){
    const b=this.gpu.createBuffer({label,size:data.byteLength,usage,mappedAtCreation:true});
    new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));b.unmap();return b;
  }
  _retire(b){this.source._retire(b);}
  bindCut(cut){
    this._alive();if(this.pending)throw new Error('Cannot switch a pending CELL cut');
    if(!cut?.isValid()||!cut.belongsTo(this.mutableSource))throw new Error('Invalid CELL Source cut');
    const held=cut.retain(),old=this.boundCut;
    if(old&&old.configuration!==held.configuration){
      for(const key of this.fields.published)this.unpublishedInvalidations.add(key);
      this.fields.published.clear();this.fields.publishedToken=null;
      for(const c of this.cache.values())this._dropCapture(c);this.cache.clear();
      this.publication=null;this.lightingDirty=true;
      // Keep the semantic source token and EMA owners. A configuration-only
      // change invalidates spatial publications, not the numerical history.
    }
    this.boundCut=held;this.source=held.source;this.producer=held.producer;
    if(held.tables) {
      this.tables=held.tables.group;
      this.fields.tables=this.fields.deriver.tables=this.tables;
    }
    old?.release();return this;
  }
  _destroyCapture(c){for(const b of [...c.buffers,c.classification,...c.uploads].filter(Boolean))this._retire(b);}
  _dropCapture(c){if(this.retiredCaptures.has(c))return;this.retiredCaptures.add(c);if(!this.capturePins.get(c))this._destroyCapture(c);}
  // Submitted classification only: no raw geometry readback. Captures are
  // selected synchronously and pinned independently of later cache replacement.
  acquireClassification({bricks}={}){
    this._alive();const publication=this.acquire(),captures=new Set(),records=[];
    try{
      for(const brick of bricks){
        const index=worldBrickIndex(this.atlas.bookLayout,brick),core=coreFor(brick),c=this._installed(brickKey(core));
        // Installation proves retained numerical compatibility with this
        // publication. Its original input cut may since have been released.
        if(!c||this.retiredCaptures.has(c)){
          const error=new Error('Unknown world classification dependency');error.requirements=[{brick:[...brick],index,channels:READY.CELL}];throw error;
        }
        const local=brick.map((n,k)=>n-core[k]/4);
        records.push(Object.freeze({brick:Object.freeze([...brick]),index,buffer:c.classification,byteOffset:brickIdOf(SOURCE_GRID,...local)*16}));captures.add(c);
      }
      for(const c of captures)this.capturePins.set(c,(this.capturePins.get(c)??0)+1);
      // Rows in capture order, then slot order, so recordMetadata copies each run of
      // neighbouring records once: a copy per 16-byte record was ~40k GPU copies a
      // lighting tick on Island (real Chrome, 2026-10-22: 5.6 s of every 20). Every
      // reader finds a row by its index (worldLightingRecords, recordEmission).
      const order=new Map();for(const r of records)if(!order.has(r.buffer))order.set(r.buffer,order.size);
      records.sort((a,b)=>order.get(a.buffer)-order.get(b.buffer)||a.byteOffset-b.byteOffset);
    }catch(error){publication.release();throw error;}
    let released=false;const owned=[];
    const retire=()=>{
      // A suffix rejection cannot undo automatic prefix submissions. Close
      // admission immediately, but retain capture/Source/Atlas pins until the
      // normal Frame has no suffix, then fence all submitted work either way.
      if(this.gpu.failure||this.gpu.pipelines?.failure)return;
      if(this.gpu.frame.open){setTimeout(retire,0);return;}
      const drop=()=>{for(const c of captures){const refs=this.capturePins.get(c)-1;this.capturePins.set(c,refs);if(!refs&&this.retiredCaptures.has(c))this._destroyCapture(c);}for(const b of owned)this._retire(b);publication.release();};
      Promise.resolve((this.gpu.queue??this.gpu.device.queue).onSubmittedWorkDone()).then(drop,drop);
    };
    const live=()=>{if(released||!this.isCurrent(publication))throw new Error('Released/stale world classification lease');};
    const make=(label,size)=>{const b=this._buffer(label,size,BU.STORAGE|BU.COPY_SRC|BU.COPY_DST);owned.push(b);return b;};
    return Object.freeze({publication,records:Object.freeze(records),
      recordMetadata:(frame=this.gpu.frame)=>{
        live();if(frame!==this.gpu.frame)throw new Error('Normal Frame required');
        const buffer=make('submitted world classification metadata',Math.max(16,records.length*16));
        for(let i=0;i<records.length;){
          let j=i+1;while(j<records.length&&records[j].buffer===records[i].buffer&&records[j].byteOffset===records[i].byteOffset+(j-i)*CLASSIFICATION_RECORD_BYTES)j++;
          frame.copy(records[i].buffer,records[i].byteOffset,buffer,i*CLASSIFICATION_RECORD_BYTES,(j-i)*CLASSIFICATION_RECORD_BYTES);i=j;
        }
        return buffer;
      },
      recordEmission:(frame,{min,size})=>{
        live();if(frame!==this.gpu.frame||min?.length!==3||size?.length!==3||size.some((n,k)=>!Number.isInteger(n)||n<1||!Number.isInteger(min[k])||min[k]<0||min[k]+n>this.bounds.max[k]/4))throw new RangeError('Exact in-world Glow emission region');
        const byIndex=new Map(records.map(r=>[r.index,r])),selected=[];
        for(let z=0;z<size[2];z++)for(let y=0;y<size[1];y++)for(let x=0;x<size[0];x++){
          const brick=[min[0]+x,min[1]+y,min[2]+z],index=worldBrickIndex(this.atlas.bookLayout,brick),r=byIndex.get(index);
          if(!r){const error=new Error('Unknown world Glow emission halo');error.requirements=[{brick,index,channels:READY.CELL}];throw error;}selected.push(r);
        }
        const buffer=make('original world emission div64',selected.length*16);
        // Original classifier xyz are f32 emission /64; w is UINT info, not
        // an emission component or half packing. Copy only xyz, clear padding.
        selected.forEach((r,i)=>{frame.copy(r.buffer,r.byteOffset,buffer,i*16,12);frame.clear(buffer,i*16+12,4);});
        return Object.freeze({complete:true,buffer,format:'xyz-linear-f32-vec4-emission-div64',min:Object.freeze([...min]),size:Object.freeze([...size]),byteLength:buffer.size,byteOffset:0});
      },
      release:()=>{if(!released){released=true;queueMicrotask(retire);}}
    });
  }
  _options({fieldTick,requirements=[],changedBricks=[],smoothing=1,full=false}){
    const cores=new Map(), normalized=[];
    for(const r of requirements){
      const brick=Array.isArray(r)?r:r.brick, channels=Array.isArray(r)?READY.CELL:r.channels;
      worldBrickIndex(this.atlas.bookLayout,brick);
      if(!Number.isInteger(channels)||channels<1||channels>READY.ALL)throw new Error('Invalid CELL demand channels');
      normalized.push(Object.freeze({brick:Object.freeze([...brick]),channels}));
      if(channels&READY.CELL){const core=coreFor(brick);cores.set(brickKey(core),core);}
    }
    const delta=this.source.changesSince(this.lastSourceToken);
    // The source's own frozen list as it stands when nothing joins it: a V2 step
    // changes the whole window, every brick of it keyed and copied per demand.
    if(!delta.global&&!changedBricks.length)return Object.freeze({fieldTick,requirements:Object.freeze(normalized),wantedCores:Object.freeze([...cores.values()].map(c=>Object.freeze(c))),changedBricks:delta.changedBricks,smoothing,full});
    const changed=new Map(changedBricks.map(b=>[brickKey(b),[...b]]));
    if(delta.global){
      for(const owner of this.fields.history.owners.values())changed.set(brickKey(owner.brick),owner.brick);
      for(const core of cores.values())for(let z=core[2]/4;z<Math.min((core[2]+32)/4,this.bounds.max[2]/4);z++)for(let y=core[1]/4;y<Math.min((core[1]+32)/4,this.bounds.max[1]/4);y++)for(let x=core[0]/4;x<Math.min((core[0]+32)/4,this.bounds.max[0]/4);x++)changed.set(`${x},${y},${z}`,[x,y,z]);
    }else for(const b of delta.changedBricks)changed.set(brickKey(b),b);
    return Object.freeze({fieldTick,requirements:Object.freeze(normalized),wantedCores:Object.freeze([...cores.values()].map(c=>Object.freeze(c))),changedBricks:Object.freeze([...changed.values()].map(b=>Object.freeze([...b]))),smoothing,full});
  }
  // The changed bricks of records not yet in a publication, kept as their
  // lists (_options makes each frozen and without repeats). One list, a
  // tick's change, is published as it is; several are merged by key, each
  // brick at its first place, as one map of every brick was: keying each
  // brick of V2's whole window per record cost the window a tick (2026-10-22).
  _noteChanges(list){if(list.length&&this.unpublishedLists.at(-1)!==list)this.unpublishedLists.push(list);}
  _unpublishedChanges(){
    const lists=this.unpublishedLists;
    if(lists.length===1&&Object.isFrozen(lists[0])&&lists[0].every(Object.isFrozen))return lists[0];
    const changes=new Map();
    for(const list of lists)for(const brick of list)changes.set(brickKey(brick),Object.isFrozen(brick)?brick:Object.freeze([...brick]));
    return Object.freeze([...changes.values()]);
  }
  sourceDemand(options){
    this._alive();
    const planned=this._options(options), snapshot=this.source.snapshotForFields({refreshLive:false});
    const fieldPlan=this.fields.sourcePlan({...planned,sourceSnapshot:snapshot}),regions=fieldPlan.regions;
    const columns=new Map();
    for(const region of regions)for(const core of this.source._cores(region)){
      const bounds={lo:core.map((v,i)=>Math.max(v,region.lo[i])),hi:core.map((v,i)=>Math.min(v+32,region.hi[i]))};
      try{this.source.assertComplete([bounds]);}catch{columns.set(`${core[0]},${core[2]}`,[core[0],core[2]]);}
    }
    return {regions,columns:[...columns.values()],options:planned,fieldPlan,contentToken:snapshot,authorityToken:this.source.token()};
  }
  _recordable(frame){
    this._alive();if(!this.readyState)throw new Error('Await CELL adapter.ready before recording');
    if(frame!==this.gpu.frame)throw new Error('CELL work must use the normal GPU Frame');
    if(this.pending)throw new Error('Commit or abort the pending CELL batch first');
    if(this.source.epoch!==this.fields.history.epoch||this.source.epoch!==this.atlas.epoch||this.source.epoch===0)throw new Error('Reset CELL adapter/Atlas after source epoch change');
    if(this.source.needsLiveCopy())this.source.recordLiveCopy(frame);
  }
  // At most limit of the source columns record(options) would produce, the
  // same calls in the same order; how many it recorded. A caller that flushes
  // and yields after each nonzero call bounds each task: a load's first CELL
  // batches each produced ~100 columns before packing, 0.2-0.5 s of JS
  // (Island, 2026-10-22). record() then finds them produced, and reuses the
  // last call's demand while nothing it read has changed.
  recordSourceColumns(frame,options,limit){
    this._recordable(frame);this.prepared=null;
    if(!Number.isSafeInteger(limit)||limit<1)throw new RangeError('Source column limit must be a positive integer');
    const demand=this.sourceDemand(options),authority=this.source.token(),columns=demand.columns.slice(0,limit);
    for(const column of columns)if(!this.producer.record(frame,column,authority))throw new Error('Source producer authority overtaken');
    if(!columns.length)this.prepared={options,demand,authority,state:this._demandState()};
    return columns.length;
  }
  // Whether the bound cut's changes and fieldTick's owners are still to reach
  // the fields and the book (wire/worldRender.js advanceFields): until a record
  // at fieldTick commits, a page the book holds may be one this tick changes.
  behind(fieldTick){
    this._alive();
    return !this.publication||!same(this.publication.source,this.source.contentToken())||this.fields.lastTick!==fieldTick||this.unpublishedInvalidations.size>0;
  }
  // What a demand read besides the source's authority token.
  _demandState(){const f=this.fields;return [this.source,this.lastSourceToken,f.version,f.history.epoch,f.publishedToken,f.published.size];}
  _demand(options){
    const p=this.prepared,now=this.source.token(),state=this._demandState();this.prepared=null;
    const current=p&&p.options===options&&p.state.every((v,i)=>v===state[i])&&['epoch','revision','contentRevision'].every(k=>p.authority[k]===now[k]);
    return current?p.demand:this.sourceDemand(options);
  }
  record(frame,options){
    this._recordable(frame);
    const demand=this._demand(options), batch={handle:Object.freeze({}),state:'recording',captures:[],options:demand.options,atlasJobs:[],invalidated:[],undo:new Map()};
    this.pending=batch;
    try{
      const authority=this.source.token();
      for(const column of demand.columns)if(!this.producer.record(frame,column,authority))throw new Error('Source producer authority overtaken');
      this.source.assertComplete(demand.regions);this.source.assertBoundedWake(demand.regions);
      const source=this.source.snapshotForFields({jetValidity:'producer-bounded-v1',refreshLive:false});
      const plan=this.fields.plan({...demand.options,sourceSnapshot:source},demand.fieldPlan);
      batch.source=source;batch.contentToken=this.source.contentToken();batch.plan=plan;
      batch.result=this.fields.record(frame,plan);batch.state='captured';this.lastSourceToken=batch.contentToken;
      for(const key of batch.invalidated)this.unpublishedInvalidations.add(key);
      this._noteChanges(batch.options.changedBricks);
      this.lightingDirty ||= !same(this.publication?.source,batch.contentToken) || plan.advancing.length>0 || batch.result.outputs.length>0 || batch.invalidated.length>0;
      return batch.handle;
    }catch(error){
      this._undo(batch);
      // A prefix may already be submitted. Flush only through the normal Frame,
      // then release failed COW pages/captures AFTER the final orphan submission.
      try{this.gpu.flush('failed world CELL orphan');}catch(flushError){error.orphanFlushError=flushError;throw error;}
      const done=this.gpu.queue??this.gpu.device.queue;
      Promise.resolve(done.onSubmittedWorkDone()).then(()=>{error.retireWorldFieldUploads?.();for(const c of batch.captures)this._dropCapture(c);},()=>{error.retireWorldFieldUploads?.();for(const c of batch.captures)this._dropCapture(c);});
      this.pending=null;batch.state='failed';throw error;
    }
  }
  recordOwnedFields(frame,payload){
    const batch=this.pending;if(!batch||batch.state!=='recording')throw new Error('Unowned field capture');
    const core=payload.scratchOrigin.map(v=>v+16), jobs=new Uint32Array(payload.ownedWorldBricks.length*2);
    payload.ownedWorldBricks.forEach((brick,i)=>{
      jobs[i*2]=brickIdOf(payload.raw.g,...brick.map((v,k)=>v-payload.scratchOrigin[k]/4));
      jobs[i*2+1]=brickIdOf(SOURCE_GRID,...brick.map((v,k)=>v-core[k]/4));
    });
    const c={core,key:brickKey(core),token:payload.token,source:payload.sourceSnapshot,buffers:[],uploads:[]};
    batch.captures.push(c);
    c.classification=this._buffer('owned CELL classification',512*16,BU.STORAGE|BU.COPY_SRC|BU.COPY_DST);
    const list=this._upload('owned CELL classifier jobs',jobs,BU.STORAGE);c.uploads.push(list);
    const group=this.gpu.bindGroup(this.classifierLayout,[{binding:0,resource:{buffer:list}},...[1,2,3].map((binding,i)=>({binding,resource:payload.textures[FIELD_TEXTURES[i]].createView({dimension:'3d'})})),{binding:4,resource:{buffer:c.classification}}],'owned CELL classifier');
    this.classifier.dispatch(frame,fold(payload.ownedWorldBricks.length),{bind:[this.tables,this.fields.sourceGroup,group],header:{src:0,dst:0,origin:[0,0,0]},params:{scratchOrigin:payload.scratchOrigin,worldMin:this.bounds.min,worldMax:this.bounds.max,count:payload.ownedWorldBricks.length}});
    for(const name of FIELD_TEXTURES){
      const buffer=this._buffer(`owned ${name}`,32**3*8,BU.COPY_SRC|BU.COPY_DST|BU.STORAGE);c.buffers.push(buffer);
      frame.direct().copyTextureToBuffer({texture:payload.textures[name],origin:[16,16,16]},{buffer,bytesPerRow:256,rowsPerImage:32},[32,32,32]);
    }
    Object.freeze(c.core);Object.freeze(c.buffers);Object.freeze(c.uploads);return Object.freeze(c);
  }
  publish({token,outputs,invalidatedCoreKeys}){
    const batch=this.pending;if(!batch||batch.state!=='recording'||outputs.some(c=>!batch.captures.includes(c)||this.retiredCaptures.has(c)||c.token.historyVersion!==token.historyVersion||!c.source.isCurrent()))throw new Error('Invalid CELL capture publication');
    for(const key of invalidatedCoreKeys)if(typeof key!=='string')throw new Error('Invalid field invalidation');
    // The cache changes in place, each key's old capture kept for _undo: a copy
    // of every core's per batch grew a load's batches with what it had loaded.
    const keep=key=>{if(!batch.undo.has(key))batch.undo.set(key,this.cache.get(key));};
    for(const key of invalidatedCoreKeys){keep(key);this.cache.delete(key);}
    for(const c of outputs){keep(c.key);this.cache.set(c.key,c);this.uninstalled.add(c);}
    // No GPU submission or irreversible Atlas mutation in this callback.
    batch.invalidated=[...invalidatedCoreKeys];batch.fieldToken=token;
  }
  // previousLighting: false when the caller has no use for the snapshot of
  // the book before this commit (wire/worldRender.js recordCells): held
  // through the publish, it kept the atlas from patching its CELL book in
  // place, a new 8 MiB book and its copy per Island classify batch
  // (renderAtlas.js _books, 2026-10-22).
  commitAfterSourceFlush(handle,{lightJobs=[],invalidations=[],dependencyToken,sunManifest,previousLighting:keepPrevious=true}={}){
    this._alive();const batch=this.pending;if(!batch||handle!==batch.handle||batch.state!=='captured')throw new Error('Invalid CELL batch');
    if(this.gpu.frame.open)throw new Error('Flush Source/Fields captures before CELL Atlas packing');
    if(!batch.source.isCurrent()||batch.plan.epoch!==this.fields.history.epoch)throw new Error('Stale CELL source/field batch');
    const jobs=[], clears=[...invalidations], device=this.gpu.device, ephemeral=[], writes=[];
    let fieldBatch={pages:[]}, rawBatch=[];
    // A batch's raw pages share one job list, one version block and one pass,
    // each page bound at its own aligned dynamic offset (the pack reads exactly
    // its 68 job words and 48 version bytes), and the pages of one source core
    // share one bind group. A buffer, a mapping and a pass per page (35k pages
    // on a World load's first frame, twice that many buffers) held Chrome's GPU
    // process until its watchdog killed it, and a bind group per page still
    // cost a Descent load a second (2026-10-21).
    const align=(n,a)=>Math.ceil(n/a)*a, limits=device.limits??{};
    const jobStride=align(68*4,limits.minStorageBufferOffsetAlignment??256), versionStride=align(48,limits.minUniformBufferOffsetAlignment??256);
    const packRaw=raws=>{
      const jobWords=new Uint32Array(raws.length*jobStride/4),versionWords=new Uint32Array(raws.length*versionStride/4);
      raws.forEach(({job,words},i)=>{
        // (no allocation between here and recordPageWrites: the layout each page's writer reads)
        const l=this.atlas.cell.pages.get(job.physicalPageID).resources.layout;
        jobWords.set(words,i*jobStride/4);
        versionWords.set([job.physicalPageID,l.cells.x,l.cells.y,l.aux.width,l.aux.height,0,0,0,READY.CELL,job.epoch,job.sourceRevision,job.fieldTick],i*versionStride/4);
      });
      const list=this._upload('CELL page immutable jobs',jobWords,BU.STORAGE),params=this._upload('CELL page versions',versionWords,BU.UNIFORM);ephemeral.push(list,params);
      let seen=0;
      const record=(encoder,raw,outputs)=>{
        raw.outputs=outputs;if(++seen<raws.length)return;
        const pass=encoder.beginComputePass();pass.setPipeline(this.packPipeline);
        let shared=null,output=null;const inputs=new Map();
        raws.forEach(({source,capture,outputs},i)=>{
          const buffers=[source.A,source.B,source.flow??this.zero,source.aeration??this.zero,source.deco?.buffer??this.zero,capture.classification];
          let input=inputs.get(capture);
          if(!input||input.buffers.some((b,k)=>b!==buffers[k])){
            input={buffers,group:device.createBindGroup({layout:this.packLayouts[0],entries:[...buffers.map((buffer,binding)=>({binding,resource:{buffer}})),
              {binding:6,resource:{buffer:list,offset:0,size:68*4}},{binding:7,resource:{buffer:params,offset:0,size:48}}]})};inputs.set(capture,input);
          }
          if(!shared||shared.length!==outputs.length||shared.some((o,k)=>o.binding!==outputs[k].binding||o.resource!==outputs[k].resource)){
            output=device.createBindGroup({layout:this.packLayouts[1],entries:outputs});shared=outputs;
          }
          pass.setBindGroup(0,input.group,[i*jobStride,i*versionStride]);pass.setBindGroup(1,output);pass.dispatchWorkgroups(1);
        });
        pass.end();
      };
      for(const raw of raws)raw.record=record;
    };
    const flushWrites=()=>{
      if(!writes.length)return;
      if(rawBatch.length)packRaw(rawBatch);
      const transport=fieldBatch,groups=new Map(),runs=[];
      // Up to four pages with consecutive IDs in one tile row share each 256-byte
      // buffer row, so one native copy per channel writes all their tiles: a copy
      // per page and channel was ~100k calls of a Descent load (2026-10-21). A
      // run's tiles are pages of this one page-write batch, written together.
      let run=null;
      for(const page of transport.pages){
        const p=this.atlas.cell.pages.get(page.job.physicalPageID),gx=p.resources.layout.cells.x;
        if(run&&run.count<4&&p.id===run.last+1&&p.id%gx!==0&&p.resources===run.resources)run.count++;
        else{run={index:runs.length,count:1,resources:p.resources,destinations:null};runs.push(run);}
        run.last=p.id;page.run=run;page.slot=run.count-1;
      }
      transport.buffer=this._buffer('CELL packed field batch',runs.length*3*2048,BU.STORAGE|BU.COPY_SRC);ephemeral.push(transport.buffer);
      // The pack's job.w: the page's first texel, in 8-byte words.
      transport.pages.forEach(({capture,local,run,slot})=>{if(!groups.has(capture))groups.set(capture,[]);groups.get(capture).push(...local,run.index*768+slot*8);});
      const dispatches=[];
      for(const [capture,words] of groups){
        const list=this._upload('CELL field batch jobs',new Uint32Array(words),BU.STORAGE);ephemeral.push(list);
        const buffers=[...capture.buffers,list,transport.buffer];
        dispatches.push({count:words.length/4,group:device.createBindGroup({layout:this.fieldPackLayout,entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))})});
      }
      let encoded=false;
      transport.record=encoder=>{
        if(encoded)return;
        const pass=encoder.beginComputePass();pass.setPipeline(this.fieldPackPipeline);
        for(const {count,group} of dispatches){pass.setBindGroup(0,group);pass.dispatchWorkgroups(count);}
        pass.end();encoded=true;
      };
      transport.copy=(encoder,index,destinations)=>{
        const {run,slot}=transport.pages[index];
        if(slot===0)run.destinations=destinations;
        if(slot<run.count-1)return;
        run.destinations.forEach((destination,i)=>encoder.copyBufferToTexture({buffer:transport.buffer,offset:(run.index*3+i)*2048,bytesPerRow:256,rowsPerImage:8},destination,[8*run.count,8,1]));
      };
      this.atlas.recordPageWrites(writes);writes.length=0;fieldBatch={pages:[]};rawBatch=[];
    };
    const previousLighting=keepPrevious?this.atlas.snapshot():null;
    try{
      const derivedChanged = this.lightingDirty;
      // Without a proven lighting dependency closure, no old channel may be
      // relabelled as newly computed. Preserve it only in the pinned snapshot;
      // the lighting owner can supply explicit compatible replacements below.
      // The books' own pages, not a scan of 33M entries each on Descent (2026-10-21).
      if(derivedChanged)for(const p of this.atlas.bookPages('light'))clears.push({brick:[...p.brick],channels:READY.LIGHT});
      // The invalidated cores' pages, in book order as a pass over every page
      // found them: the pages of one core are at most its 512 bricks, and that
      // pass sorted all of a big map's (650k on Descent) per commit, every
      // tick something changed (2026-10-22).
      if(this.unpublishedInvalidations.size){
        const book=this.atlas.bookLayout,live=this.atlas.live.cell,dims=this.bounds.max.map(v=>v/4),cleared=[];
        for(const key of this.unpublishedInvalidations){
          const core=key.split(',').map(Number),lo=core.map(v=>v/4),hi=lo.map((v,k)=>Math.min(v+8,dims[k]));
          for(let z=lo[2];z<hi[2];z++)for(let y=lo[1];y<hi[1];y++)for(let x=lo[0];x<hi[0];x++){const i=worldBrickIndex(book,[x,y,z]);if(live.has(i))cleared.push(i);}
        }
        cleared.sort((a,b)=>a-b);
        for(const i of cleared)clears.push({brick:[...live.get(i).brick],channels:READY.CELL});
      }
      const cellKeys=new Set();for(const r of batch.options.requirements)if((Array.isArray(r)?READY.CELL:r.channels)&READY.CELL)cellKeys.add(brickKey(Array.isArray(r)?r:r.brick));
      this.atlas.reserve('cell',cellKeys.size);
      const seen=new Set();
      for(const r of batch.options.requirements){
        const brick=Array.isArray(r)?r:r.brick,channels=Array.isArray(r)?READY.CELL:r.channels;
        if(!(channels&READY.CELL))continue;const key=brickKey(brick);if(seen.has(key))continue;seen.add(key);
        const core=coreFor(brick),capture=this.cache.get(brickKey(core));
        if(!capture||this.retiredCaptures.has(capture))throw new Error('Missing valid owned CELL fields');
        const source=this.source.chunks.get(brickKey(core));if(!source)throw new Error('Missing CELL source core');
        const local=brick.map((v,i)=>v-core[i]/4),bi=brickIdOf(SOURCE_GRID,...local),start=bi*64;
        const job=this.atlas.allocate(brick,{sourceRevision:batch.source.sourceRevision,fieldTick:batch.fieldToken.fieldTick,readyBits:READY.CELL});jobs.push(job);
        const lightEntry=this.atlas.lightEntries[worldBrickIndex(this.atlas.bookLayout,brick)];
        if(lightEntry&&this.atlas.light.pages.get(bookPage(lightEntry)).sourceRevision!==batch.source.sourceRevision)clears.push({brick,channels:READY.LIGHT});
        const words=new Uint32Array(68);words.set([start,bi,0,0]);words.set(source.aux.subarray(start,start+64),4);
        const raw={job,words,source,capture,record:null};rawBatch.push(raw);
        writes.push({job,kind:'raw',auxMetadata:[READY.CELL,job.epoch,job.sourceRevision,job.fieldTick],record:(encoder,bindings)=>raw.record(encoder,raw,bindings.outputs)});
        const transport=fieldBatch,pageIndex=transport.pages.length;transport.pages.push({capture,local,job});
        writes.push({job,kind:'fields',record:(encoder,bindings)=>{transport.record(encoder);transport.copy(encoder,pageIndex,bindings.destinations);}});
        // Bound command-buffer size, not work: every requested page is packed.
        // 512 pages a submission: a 35k-page first frame is ~70 submissions, not 550.
        if(writes.length>=this.batchWrites)flushWrites();
      }
      flushWrites();
      if(!batch.source.isCurrent()||batch.plan.epoch!==this.fields.history.epoch)throw new Error('CELL source changed while packing');
      // Every page this commit leaves in the book is what a pack at this
      // revision would write: a change to a brick's cells or its core's fields
      // invalidated the core (fields.js), whose pages it just cleared.
      const publication=this.atlas.publish({cellJobs:jobs,lightJobs,invalidations:clears,cellRevision:batch.source.sourceRevision,...(dependencyToken?{dependencyToken}:{}),...(sunManifest!==undefined?{sunManifest}:derivedChanged?{sunManifest:null}:{})});
      batch.state='published';this.pending=null;
      const old=this.publication;
      this.publication=Object.freeze({identity:Object.freeze({generation:publication}),source:batch.contentToken,fieldToken:batch.fieldToken,fieldTick:batch.fieldToken.fieldTick,changedBricks:this._unpublishedChanges(),invalidatedCoreKeys:Object.freeze([...this.unpublishedInvalidations]),dependencySetID:this.dependencyID,dependencyVersion:publication});
      for(const c of this.uninstalled)if(this.cache.get(c.key)===c)this.installed.add(c);this.uninstalled.clear();
      this.unpublishedInvalidations.clear();this.unpublishedLists.length=0;this.lightingDirty=false;
      this._dropReplaced(batch);
      const queue=this.gpu.queue??device.queue;
      Promise.resolve(queue.onSubmittedWorkDone()).then(()=>batch.result.retire(),()=>batch.result.retire());
      for(const b of ephemeral)this._retire(b);
      // Caller owns this real old snapshot if it needs previous temporal probes.
      return {generation:publication,token:this.publication.identity,previousLightingSnapshot:previousLighting,previousPublication:old};
    }catch(error){
      for(const job of jobs)try{this.atlas.cancel(job);}catch{}
      previousLighting?.release();for(const b of ephemeral)this._retire(b);
      // Keep captures and Fields tick: packing retries do not advance EMA.
      throw error;
    }
  }
  abort(handle){
    this._alive();const batch=this.pending;if(!batch||handle!==batch.handle||batch.state!=='captured')throw new Error('Invalid CELL abort');
    if(this.gpu.frame.open)throw new Error('Flush pending CELL captures before abort');
    this.pending=null;batch.state='aborted';
    const queue=this.gpu.queue??this.gpu.device.queue;Promise.resolve(queue.onSubmittedWorkDone()).then(()=>batch.result.retire(),()=>batch.result.retire());
    this._dropReplaced(batch);
  }
  // The captures a batch replaced or removed, once it is settled either way.
  _dropReplaced(batch){for(const [key,c] of batch.undo)if(c&&this.cache.get(key)!==c)this._dropCapture(c);}
  // A failed record puts the cache back as it was before the batch.
  _undo(batch){
    for(const [key,c] of batch.undo)if(c)this.cache.set(key,c);else this.cache.delete(key);
    for(const c of batch.captures)this.uninstalled.delete(c);
    batch.undo.clear();
  }
  // The capture the current publication installed for a core, as a copy of the
  // cache made at its commit held it: a pending batch's replaced one, and none
  // that no commit installed (an aborted batch's).
  _installed(key){
    const undo=this.pending?.undo,c=undo?.has(key)?undo.get(key):this.cache.get(key);
    return c&&this.installed.has(c)?c:undefined;
  }
  acquire(){
    this._alive();if((this.boundCut&&!this.boundCut.isValid())||!this.publication||!same(this.publication.source,this.source.contentToken()))throw new Error('No current submitted CELL publication');
    const p=this.publication,atlas=this.atlas.snapshot(),ownedCut=this.boundCut?.retain();let released=false;
    return Object.freeze({identity:p.identity,worldSize:Object.freeze([...this.bounds.max]),epoch:this.source.epoch,
      source:Object.freeze({contentToken:p.source,sourceRevision:p.source.sourceRevision}),field:Object.freeze({publishedToken:p.fieldToken,complete:true,sourceRevision:p.source.sourceRevision,logicalFieldTick:p.fieldTick}),
      atlas,ownedCut,changedBricks:p.changedBricks,invalidatedCoreKeys:p.invalidatedCoreKeys,dependencySetID:p.dependencySetID,dependencyVersion:p.dependencyVersion,
      release(){if(!released){released=true;atlas.release();ownedCut?.release();}},isReleased:()=>released});
  }
  isCurrent(snapshot){
    if(this.dead||!snapshot||snapshot.isReleased?.())return false;
    if(snapshot.ownedCut)return snapshot.ownedCut.belongsTo(this.mutableSource)&&snapshot.ownedCut.isValid()&&snapshot.epoch===this.mutableSource.epoch;
    return snapshot.identity===this.publication?.identity&&snapshot.epoch===this.source.epoch&&same(this.publication.source,this.source.contentToken());
  }
  reset(){
    this._alive();if(this.pending)throw new Error('Finish pending CELL work before reset');
    if(this.source.epoch<=this.fields.history.epoch)throw new Error('Source epoch must advance before CELL reset');
    if(this.atlas.epoch!==this.source.epoch){if(this.atlas.epoch+1!==this.source.epoch)throw new Error('Source/Atlas epoch mismatch');this.atlas.reset();}
    for(const c of this.cache.values())this._dropCapture(c);this.cache=new Map();this.publication=null;this.lastSourceToken=null;
    this.unpublishedInvalidations.clear();this.unpublishedLists.length=0;this.lightingDirty=false;
    this.fields.reset(this.source.epoch);
  }
  dispose(){
    this._alive();if(this.pending||this.gpu.frame.open)throw new Error('Finish/flush pending CELL work before dispose');
    for(const c of this.cache.values())this._dropCapture(c);this.cache.clear();this._retire(this.zero);this.dead=true;this.publication=null;
    this.boundCut?.release();this.boundCut=null;
    const queue=this.gpu.queue??this.gpu.device.queue;Promise.resolve(queue.onSubmittedWorkDone()).then(()=>this.fields.dispose(),()=>this.fields.dispose());
  }
}
