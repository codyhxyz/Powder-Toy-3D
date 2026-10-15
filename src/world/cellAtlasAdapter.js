// Source -> shared Fields -> classified CELL pages. No application switch.
import { WorldFields } from './fields.js';
import { brickKey } from './fieldHistory.js';
import { SOURCE_GRID } from './renderSource.js';
import { gridDims, brickIdOf, LAYOUT } from '../shaders/common.js';
import { FIELD_TEXTURES } from '../gfx/fieldDeriver.js';
import { fold } from '../gpu/kernels.js';
import { READY, worldBrickIndex } from './renderAtlas.js';
import { worldCellClassifierWGSL, WorldBrickParams, WORLD_CLASSIFIER_LAYOUT, worldCellPackWGSL, WORLD_CELL_PACK_LAYOUTS, copyCapturedFieldPage } from '../shaders/worldCellAdapter.js';
const BU = { COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128 };
const same = (a,b) => a?.epoch === b?.epoch && a?.sourceRevision === b?.sourceRevision;
const coreFor = b => b.map(v => Math.floor(v/8)*32);
let dependencyID = 1;

export class WorldCellAtlasAdapter {
  constructor({gpu,source,producer,fields=null,atlas,tables,worldBounds}={}) {
    if (!gpu || !source || !producer || !atlas || !tables || !worldBounds) throw new TypeError('Concrete Source/Producer/Atlas/tables/bounds required');
    if (worldBounds.min.some(v=>v!==0) || worldBounds.max.some((v,i)=>v!==source.win.size[i] || v!==atlas.bookLayout.worldSize[i])) throw new Error('CELL source/atlas/world bounds mismatch');
    Object.assign(this,{gpu,source,producer,atlas,tables});
    this.bounds={min:[...worldBounds.min],max:[...worldBounds.max]};
    this.cache=new Map(); this.retiredCaptures=new WeakSet(); this.pending=null; this.dead=false; this.publication=null; this.lastSourceToken=null; this.dependencyID=dependencyID++;
    if (fields && (fields.publishedToken || fields.history.owners.size)) throw new Error('Cannot replace an active Fields publisher');
    this.ownsFields=!fields;
    this.fields=fields??new WorldFields(gpu,{worldBounds,tables,publisher:this});
    this.fields.publisher=this;
    if(this.fields.history.epoch<source.epoch)this.fields.reset(source.epoch);
    const layout=gpu.layout('world owned classifier',WORLD_CLASSIFIER_LAYOUT);
    this.classifierLayout=layout;
    this.classifier=gpu.kernel({name:'world owned classifier',code:worldCellClassifierWGSL(gridDims({nx:64,ny:64,nz:64})),layouts:[gpu.layout('TABLES',LAYOUT.TABLES),gpu.layout('STATE_RO',LAYOUT.STATE_RO),layout],params:WorldBrickParams});
    // Use the same actual TABLES and STATE_RO layouts as the field kernels.
    // Native raw packing has its own seven-buffer, three-image layout.
    const device=gpu.device;
    this.packLayouts=WORLD_CELL_PACK_LAYOUTS.map((entries,i)=>device.createBindGroupLayout({label:`world CELL pack ${i}`,entries}));
    const nativeReady=device.createComputePipelineAsync({label:'world CELL raw/AUX pack',layout:device.createPipelineLayout({bindGroupLayouts:this.packLayouts}),compute:{module:device.createShaderModule({code:worldCellPackWGSL}),entryPoint:'main'}}).then(p=>{this.packPipeline=p;});
    this.zero=this._buffer('absent CELL auxiliary',SOURCE_GRID.slots*8,BU.STORAGE|BU.COPY_DST);
    this.ready=Promise.all([this.fields.ready,producer.ready,this.classifier.ready,nativeReady]).then(()=>{this.readyState=true;return this;});
    this.ready.catch(()=>{});
    this.sourceFieldSnapshotProvider=Object.freeze({acquire:()=>this.acquire(),isCurrent:s=>this.isCurrent(s)});
  }
  _alive(){if(this.dead)throw new Error('CELL adapter disposed');}
  _buffer(label,size,usage){return this.gpu.createBuffer({label,size,usage});}
  _upload(label,data,usage=BU.COPY_SRC){
    const b=this.gpu.createBuffer({label,size:data.byteLength,usage,mappedAtCreation:true});
    new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));b.unmap();return b;
  }
  _retire(b){this.source.sim._retire(b);}
  _dropCapture(c){if(this.retiredCaptures.has(c))return;this.retiredCaptures.add(c);for(const b of [...c.buffers,c.classification,...c.uploads].filter(Boolean))this._retire(b);}
  _options({fieldTick,requirements=[],changedBricks=[],smoothing=1,full=false}){
    const cores=new Map(), normalized=[];
    for(const r of requirements){
      const brick=Array.isArray(r)?r:r.brick, channels=Array.isArray(r)?READY.CELL:r.channels;
      worldBrickIndex(this.atlas.bookLayout,brick);
      if(!Number.isInteger(channels)||channels<1||channels>READY.ALL)throw new Error('Invalid CELL demand channels');
      normalized.push(Object.freeze({brick:Object.freeze([...brick]),channels}));
      if(channels&READY.CELL){const core=coreFor(brick);cores.set(brickKey(core),core);}
    }
    const delta=this.source.changesSince(this.lastSourceToken), changed=new Map(changedBricks.map(b=>[brickKey(b),[...b]]));
    if(delta.global){
      for(const owner of this.fields.history.owners.values())changed.set(brickKey(owner.brick),owner.brick);
      for(const core of cores.values())for(let z=core[2]/4;z<Math.min((core[2]+32)/4,this.bounds.max[2]/4);z++)for(let y=core[1]/4;y<Math.min((core[1]+32)/4,this.bounds.max[1]/4);y++)for(let x=core[0]/4;x<Math.min((core[0]+32)/4,this.bounds.max[0]/4);x++)changed.set(`${x},${y},${z}`,[x,y,z]);
    }else for(const b of delta.changedBricks)changed.set(brickKey(b),b);
    return Object.freeze({fieldTick,requirements:Object.freeze(normalized),wantedCores:Object.freeze([...cores.values()].map(c=>Object.freeze(c))),changedBricks:Object.freeze([...changed.values()].map(b=>Object.freeze([...b]))),smoothing,full});
  }
  sourceDemand(options){
    this._alive();
    const planned=this._options(options), snapshot=this.source.snapshotForFields({refreshLive:false});
    const regions=this.fields.requiredSourceRegions({...planned,sourceSnapshot:snapshot});
    const columns=new Map();
    for(const region of regions)for(const core of this.source._cores(region)){
      const bounds={lo:core.map((v,i)=>Math.max(v,region.lo[i])),hi:core.map((v,i)=>Math.min(v+32,region.hi[i]))};
      try{this.source.assertComplete([bounds]);}catch{columns.set(`${core[0]},${core[2]}`,[core[0],core[2]]);}
    }
    return {regions,columns:[...columns.values()],options:planned,contentToken:snapshot,authorityToken:this.source.token()};
  }
  record(frame,options){
    this._alive();if(!this.readyState)throw new Error('Await CELL adapter.ready before recording');
    if(frame!==this.gpu.frame)throw new Error('CELL work must use the normal GPU Frame');
    if(this.pending)throw new Error('Commit or abort the pending CELL batch first');
    if(this.source.epoch!==this.fields.history.epoch||this.source.epoch!==this.atlas.epoch||this.source.epoch===0)throw new Error('Reset CELL adapter/Atlas after source epoch change');
    if(this.source.needsLiveCopy())this.source.recordLiveCopy(frame);
    const demand=this.sourceDemand(options), batch={handle:Object.freeze({}),state:'recording',captures:[],options:demand.options,atlasJobs:[],invalidated:[],before:new Map(this.cache)};
    this.pending=batch;
    try{
      const authority=this.source.token();
      for(const column of demand.columns)if(!this.producer.record(frame,column,authority))throw new Error('Source producer authority overtaken');
      this.source.assertComplete(demand.regions);this.source.assertBoundedWake(demand.regions);
      const source=this.source.snapshotForFields({jetValidity:'producer-bounded-v1',refreshLive:false});
      const plan=this.fields.plan({...demand.options,sourceSnapshot:source});
      batch.source=source;batch.contentToken=this.source.contentToken();batch.plan=plan;
      batch.result=this.fields.record(frame,plan);batch.state='captured';this.lastSourceToken=batch.contentToken;
      return batch.handle;
    }catch(error){
      this.cache=batch.before;
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
      const buffer=this._buffer(`owned ${name}`,32**3*8,BU.COPY_SRC|BU.COPY_DST);c.buffers.push(buffer);
      frame.direct().copyTextureToBuffer({texture:payload.textures[name],origin:[16,16,16]},{buffer,bytesPerRow:256,rowsPerImage:32},[32,32,32]);
    }
    Object.freeze(c.core);Object.freeze(c.buffers);Object.freeze(c.uploads);return Object.freeze(c);
  }
  publish({token,outputs,invalidatedCoreKeys}){
    const batch=this.pending;if(!batch||batch.state!=='recording'||outputs.some(c=>!batch.captures.includes(c)||this.retiredCaptures.has(c)||c.token.historyVersion!==token.historyVersion||!c.source.isCurrent()))throw new Error('Invalid CELL capture publication');
    const next=new Map(this.cache);
    for(const key of invalidatedCoreKeys){if(typeof key!=='string')throw new Error('Invalid field invalidation');next.delete(key);}
    for(const c of outputs)next.set(c.key,c);
    // No GPU submission or irreversible Atlas mutation in this callback.
    batch.invalidated=[...invalidatedCoreKeys];batch.fieldToken=token;this.cache=next;
  }
  commitAfterSourceFlush(handle,{lightJobs=[],invalidations=[],dependencyToken,sunManifest}={}){
    this._alive();const batch=this.pending;if(!batch||handle!==batch.handle||batch.state!=='captured')throw new Error('Invalid CELL batch');
    if(this.gpu.frame.open)throw new Error('Flush Source/Fields captures before CELL Atlas packing');
    if(!batch.source.isCurrent()||batch.plan.epoch!==this.fields.history.epoch)throw new Error('Stale CELL source/field batch');
    const jobs=[], clears=[...invalidations], device=this.gpu.device, ephemeral=[];
    const previousLighting=this.atlas.snapshot();
    try{
      const derivedChanged = !same(this.publication?.source,batch.contentToken) || batch.plan.advancing.length > 0 || batch.result.outputs.length > 0 || batch.invalidated.length > 0;
      // Without a proven lighting dependency closure, no old channel may be
      // relabelled as newly computed. Preserve it only in the pinned snapshot;
      // the lighting owner can supply explicit compatible replacements below.
      if(derivedChanged)for(const [index,entry] of this.atlas.lightEntries.entries())if(entry){
        const n=this.atlas.bookLayout.bricks;
        clears.push({brick:[index%n[0],Math.floor(index/n[0])%n[1],Math.floor(index/(n[0]*n[1]))],channels:READY.LIGHT});
      }
      for(const [index,entry] of this.atlas.entries.entries())if(entry){
        const b=[index%this.atlas.bookLayout.bricks[0],Math.floor(index/this.atlas.bookLayout.bricks[0])%this.atlas.bookLayout.bricks[1],Math.floor(index/(this.atlas.bookLayout.bricks[0]*this.atlas.bookLayout.bricks[1]))];
        if(batch.invalidated.includes(brickKey(coreFor(b))))clears.push({brick:b,channels:READY.CELL});
      }
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
        if(lightEntry&&this.atlas.light.pages.get(lightEntry-1).sourceRevision!==batch.source.sourceRevision)clears.push({brick,channels:READY.LIGHT});
        const words=new Uint32Array(68);words.set([start,bi,0,0]);words.set(source.aux.subarray(start,start+64),4);
        const list=this._upload('CELL page immutable job',words,BU.STORAGE);ephemeral.push(list);
        this.atlas.recordPageWrite(job,'raw',{auxMetadata:[READY.CELL,job.epoch,job.sourceRevision,job.fieldTick],record:(encoder,bindings)=>{
          const l=this.atlas.cell.pages.get(job.physicalPageID).resources.layout;
          const params=this._upload('CELL page version',new Uint32Array([job.physicalPageID,l.cells.x,l.cells.y,l.aux.width,l.aux.height,0,0,0,READY.CELL,job.epoch,job.sourceRevision,job.fieldTick]),BU.UNIFORM);ephemeral.push(params);
          const buffers=[source.A,source.B,source.flow??this.zero,source.aeration??this.zero,source.deco?.buffer??this.zero,capture.classification,list];
          const input=device.createBindGroup({layout:this.packLayouts[0],entries:[...buffers.map((buffer,binding)=>({binding,resource:{buffer}})),{binding:7,resource:{buffer:params}}]});
          const output=device.createBindGroup({layout:this.packLayouts[1],entries:bindings.outputs});
          const pass=encoder.beginComputePass();pass.setPipeline(this.packPipeline);pass.setBindGroup(0,input);pass.setBindGroup(1,output);pass.dispatchWorkgroups(1);pass.end();
        }});
        this.atlas.recordPageWrite(job,'fields',{record:(encoder,bindings)=>capture.buffers.forEach((buffer,i)=>copyCapturedFieldPage(encoder,buffer,local,bindings.destinations[i]))});
      }
      if(!batch.source.isCurrent()||batch.plan.epoch!==this.fields.history.epoch)throw new Error('CELL source changed while packing');
      const publication=this.atlas.publish({cellJobs:jobs,lightJobs,invalidations:clears,...(dependencyToken?{dependencyToken}:{}),...(sunManifest!==undefined?{sunManifest}:derivedChanged?{sunManifest:null}:{})});
      batch.state='published';this.pending=null;
      const old=this.publication;
      this.publication=Object.freeze({identity:Object.freeze({generation:publication}),source:batch.contentToken,fieldToken:batch.fieldToken,fieldTick:batch.fieldToken.fieldTick,changedBricks:batch.options.changedBricks.map(b=>Object.freeze([...b])),invalidatedCoreKeys:Object.freeze([...batch.invalidated]),dependencySetID:this.dependencyID,dependencyVersion:publication});
      for(const [key,c] of batch.before)if(this.cache.get(key)!==c)this._dropCapture(c);
      const queue=this.gpu.queue??device.queue;
      Promise.resolve(queue.onSubmittedWorkDone()).then(()=>batch.result.retire(),()=>batch.result.retire());
      for(const b of ephemeral)this._retire(b);
      // Caller owns this real old snapshot if it needs previous temporal probes.
      return {generation:publication,token:this.publication.identity,previousLightingSnapshot:previousLighting,previousPublication:old};
    }catch(error){
      for(const job of jobs)try{this.atlas.cancel(job);}catch{}
      previousLighting.release();for(const b of ephemeral)this._retire(b);
      // Keep captures and Fields tick: packing retries do not advance EMA.
      throw error;
    }
  }
  abort(handle){
    this._alive();const batch=this.pending;if(!batch||handle!==batch.handle||batch.state!=='captured')throw new Error('Invalid CELL abort');
    if(this.gpu.frame.open)throw new Error('Flush pending CELL captures before abort');
    this.pending=null;batch.state='aborted';
    const queue=this.gpu.queue??this.gpu.device.queue;Promise.resolve(queue.onSubmittedWorkDone()).then(()=>batch.result.retire(),()=>batch.result.retire());
    for(const [key,c] of batch.before)if(this.cache.get(key)!==c)this._dropCapture(c);
  }
  acquire(){
    this._alive();if(!this.publication||!same(this.publication.source,this.source.contentToken()))throw new Error('No current submitted CELL publication');
    const p=this.publication,atlas=this.atlas.snapshot();let released=false;
    return Object.freeze({identity:p.identity,worldSize:Object.freeze([...this.bounds.max]),epoch:this.source.epoch,
      source:Object.freeze({contentToken:p.source,sourceRevision:p.source.sourceRevision}),field:Object.freeze({publishedToken:p.fieldToken,complete:true,sourceRevision:p.source.sourceRevision,logicalFieldTick:p.fieldTick}),
      atlas,changedBricks:p.changedBricks,invalidatedCoreKeys:p.invalidatedCoreKeys,dependencySetID:p.dependencySetID,dependencyVersion:p.dependencyVersion,
      release(){if(!released){released=true;atlas.release();}},isReleased:()=>released});
  }
  isCurrent(snapshot){return !this.dead&&!snapshot?.isReleased?.()&&snapshot?.identity===this.publication?.identity&&snapshot.epoch===this.source.epoch&&same(this.publication.source,this.source.contentToken());}
  reset(){
    this._alive();if(this.pending)throw new Error('Finish pending CELL work before reset');
    if(this.source.epoch<=this.fields.history.epoch)throw new Error('Source epoch must advance before CELL reset');
    if(this.atlas.epoch!==this.source.epoch){if(this.atlas.epoch+1!==this.source.epoch)throw new Error('Source/Atlas epoch mismatch');this.atlas.reset();}
    for(const c of this.cache.values())this._dropCapture(c);this.cache=new Map();this.publication=null;this.lastSourceToken=null;
    this.fields.reset(this.source.epoch);
  }
  dispose(){
    this._alive();if(this.pending||this.gpu.frame.open)throw new Error('Finish/flush pending CELL work before dispose');
    for(const c of this.cache.values())this._dropCapture(c);this.cache.clear();this._retire(this.zero);this.dead=true;this.publication=null;
    if(this.ownsFields){const queue=this.gpu.queue??this.gpu.device.queue;Promise.resolve(queue.onSubmittedWorkDone()).then(()=>this.fields.dispose(),()=>this.fields.dispose());}
  }
}
