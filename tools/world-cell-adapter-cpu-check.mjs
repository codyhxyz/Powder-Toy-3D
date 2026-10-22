// CPU/fake native command evidence; no GPU execution/performance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { execFileSync } from 'node:child_process';
import { CellTestGPU } from './cell-adapter-test-gpu.mjs';
import { WorldCellAtlasAdapter, CELL_BATCH_WRITES } from '../src/world/cellAtlasAdapter.js';
import { WorldFieldHistory } from '../src/world/fieldHistory.js';
import { WorldRenderSource, SOURCE_GRID, snapshotSource } from '../src/world/renderSource.js';
import { RawWorldSourceProducer } from '../src/world/renderSourceProducer.js';
import { WorldRenderAtlas, READY, auxTexel, bookPage, pageTexel, worldSlotCell, assertWorldLayout } from '../src/world/renderAtlas.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { gridDims, brickIdOf, cellSlot } from '../src/shaders/common.js';
import { brickFrag } from '../src/shaders/passes.js';
import { worldCellClassifierWGSL, worldCellPackWGSL, WORLD_CELL_PACK_LAYOUTS, worldFieldPackWGSL, WORLD_FIELD_PACK_LAYOUT, copyCapturedFieldPage } from '../src/shaders/worldCellAdapter.js';
import { setAeration, aerationForSource, isProducerBoundedAeration } from '../src/gfx/foam.js';
const u32=b=>new Uint32Array(b.bytes), f32=b=>new Float32Array(b.bytes);
// The Box brickFrag the world classifier matches: 9cdee27b's plus only V2's liquid-interior
// certificate bit (7c893f14), as merged into main from 7f9b2f1c.
const BOX_BRICK_FRAG_AT='7f9b2f1c';
class FieldShaderExec extends WgslExec {
  _dispatchWorkgroup(fn,id,context){
    // wgsl_reflect1.6.0 parses a single workgroup size as a string, then
    // dispatches its digits as dimensions. Normalize AST metadata, not WGSL.
    for(const a of fn.node.attributes??[])if(a.name==='workgroup_size'&&typeof a.value==='string')a.value=[a.value];
    return super._dispatchWorkgroup(fn,id,context);
  }
}
function fixture(){
  const gpu=new CellTestGPU(),g=gridDims({nx:32,ny:32,nz:32}),buffer=n=>gpu.createBuffer({size:n});
  const sim={g,gpu,cur:0,version:0,origin:{x:0,y:0,z:0},L:{TABLES:gpu.layout('TABLES',[])},tables:{},marks:buffer(16),state:{A:buffer(g.slots*32),B:buffer(g.slots*32),F:buffer(g.slots*8)},flow:buffer(g.slots*8),decoPlane:{buffer:buffer(g.slots*4),offset:0},
    _retire:b=>gpu.retire(b),header(){return {src:this.cur,dst:this.cur,origin:[this.origin.x,0,this.origin.z]};},onShift(){return ()=>{};},attachAeration(a){this.aeration=a;},wake(){}};
  for(let s=0;s<g.slots*2;s++){f32(sim.state.A).set([2,20,.5,.125],s*4);u32(sim.state.B).set([0x80000000,0x7fc12345,s,0x12345678],s*4);}
  for(let i=0;i<u32(sim.flow).length;i++)u32(sim.flow)[i]=(0x80000000+i*7919)>>>0;
  for(let i=0;i<u32(sim.decoPlane.buffer).length;i++)u32(sim.decoPlane.buffer)[i]=(0x7fc12345+i)>>>0;
  const size=[96,8,8],wb=size.map(v=>v/4),win={sim,gpu,size,wb,epoch:1,scene:{key:'fixture',glsl:()=>''},loaded:true,planted:new Uint8Array(wb[0]*wb[2]),candidates:new Map(),store:new BrickStore(wb),gen:{ready:Promise.resolve(),res:{layout:[],entries:()=>[],prepassFor(){}}}};
  const source=new WorldRenderSource(win);win.renderSource=source;sim.worldRenderSource=source;
  const producer=new RawWorldSourceProducer(win,source),atlas=new WorldRenderAtlas(gpu,{worldSize:size,initialCapacity:4});
  const adapter=new WorldCellAtlasAdapter({gpu,source,producer,atlas,tables:sim.tables,worldBounds:{min:[0,0,0],max:size}});
  // 64 pages a submission, so these 96-page fixtures cross a batch edge (the app packs CELL_BATCH_WRITES)
  adapter.batchWrites=128;
  return {gpu,sim,win,source,producer,atlas,adapter};
}
const req=[{brick:[7,1,1],channels:READY.CELL},{brick:[8,1,1],channels:READY.CELL}];
function lookupSnapshot(snapshot,brick){const p=u32(snapshot.params),i=brick[0]+p[4]*(brick[1]+p[5]*brick[2]),v=u32(snapshot.book)[i];return {physicalPageID:bookPage(v),incomplete:!v};}
function fieldWords(snapshot,name,brick,s){const p=lookupSnapshot(snapshot,brick).physicalPageID,pos=pageTexel(p,s,snapshot.layout),t=snapshot.views[name].texture,d=t.size;return [...new Uint16Array(t.bytes,(pos[0]+d[0]*(pos[1]+d[1]*pos[2]))*8,4)];}
function auxWords(snapshot,brick,record){const p=lookupSnapshot(snapshot,brick).physicalPageID,pos=auxTexel(p,record,snapshot.layout),t=snapshot.views.aux.texture,d=t.size;return [...new Uint32Array(t.bytes,(pos[0]+d[0]*(pos[1]+d[1]*pos[2]))*16,4)];}
async function cleanup(f){f.gpu.finish();await Promise.resolve();f.adapter.dispose();f.producer.dispose();f.atlas.dispose();f.source.dispose();f.gpu.finish();await Promise.resolve();}
function assertFieldRows(f,snapshot,brick,capture){
  const local=brick.map((v,i)=>v-capture.core[i]/4);
  for(let c=0;c<3;c++){
    const texture=f.gpu.createTexture({size:[8,8,1],format:'rgba16float'});
    copyCapturedFieldPage(f.gpu.frame.direct(),capture.buffers[c],local,{texture,origin:[0,0,0]});f.gpu.finish();
    const expected=new Uint16Array(texture.bytes);
    for(let s=0;s<64;s++)assert.deepEqual(fieldWords(snapshot,'field'+c,brick,s),[...expected.subarray(s*4,s*4+4)]);
    texture.destroy();
  }
}

test('real Source/Producer/Fields/Atlas: two-core queued captures precede scratch reuse and native CELL consumers follow explicit flush',async()=>{
  const f=fixture();await f.adapter.ready;f.atlas.require(req);
  const demand=f.adapter.sourceDemand({fieldTick:0,requirements:req});assert(demand.columns.some(c=>c[0]===32));assert.equal(f.gpu.flushes,0);
  const mutable=req.map(r=>({brick:[...r.brick],channels:r.channels}));
  const before=f.gpu.nativeSubmits,batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:mutable});
  mutable[0].brick[0]=20;mutable[1].channels=READY.LIGHT;
  assert.deepEqual(f.adapter.pending.options.requirements,req,'recording freezes validated demand before caller mutation');
  assert.equal(f.gpu.nativeSubmits,before,'no Atlas consumer before explicit source flush');assert.equal(f.gpu.flushes,0,'producer/store never force a flush');
  assert(Object.isFrozen(batch));assert.deepEqual(Object.keys(batch),[]);assert.equal(f.adapter.pending.captures.length,2);assert.throws(()=>f.adapter.commitAfterSourceFlush(batch),/Flush/);
  const captures=f.gpu.trace.filter(t=>t.name==='capture');assert.equal(captures.length,6);
  const secondClassifier=f.gpu.trace.findIndex((t,i,a)=>t.name==='world owned classifier'&&a.slice(0,i).some(x=>x.name==='world owned classifier'));
  assert(f.gpu.trace.indexOf(captures[2])<secondClassifier);
  f.gpu.flush();const packBefore=f.gpu.nativeSubmits,publication=f.adapter.commitAfterSourceFlush(batch);
  assert.equal(f.gpu.nativeSubmits-packBefore,2,"both raw/field pages share one native submission; the other is the commit's book copy");
  const dispatches=f.gpu.trace.filter(t=>t.name==='field CELL dispatch'),copies=f.gpu.trace.filter(t=>t.name==='native half copy');
  assert.equal(dispatches.length,2,'one job list/dispatch per capture, not per channel');
  // three copies per run of up to four consecutive pages; every page's tile is in one
  assert.equal(copies.reduce((n,c)=>n+c.extent[0]/8,0),req.length*3);assert(copies.length<=req.length*3);
  assert(dispatches.every(d=>f.gpu.trace.indexOf(d)<f.gpu.trace.indexOf(copies[0])),'all capture dispatches precede first packed copy');
  for(const d of dispatches){assert.equal(d.groups[0].entries.length,5);for(const e of d.groups[0].entries.slice(0,3))assert(e.resource.buffer.usage&128);}
  for(const c of copies){assert([8,16,24,32].includes(c.extent[0])&&c.extent[1]===8&&c.extent[2]===1);assert.equal(c.bytesPerRow,256);assert.equal(c.rowsPerImage,8);assert.equal(c.offset%2048,0);}
  assert.equal(f.adapter.fields.lastTick,0);f.gpu.finish();await Promise.resolve();
  const snap=f.atlas.snapshot();
  for(const r of req){
    const core=r.brick.map(v=>Math.floor(v/8)*32),c=f.adapter.cache.get(core.join(',')),local=r.brick.map((v,i)=>v-core[i]/4),bi=brickIdOf(SOURCE_GRID,...local);
    assertFieldRows(f,snap,r.brick,c);
    assert.deepEqual(auxWords(snap,r.brick,0),[READY.CELL,1,0,0]);assert.deepEqual(auxWords(snap,r.brick,1),[brickIdOf(f.adapter.fields.g,...r.brick.map((v,i)=>v-(core[i]-16)/4))+1,0x7fc12345,0x80000000,0x01020304]);
    assert.deepEqual(auxWords(snap,r.brick,2),[0xffffffff,0xffffffff,0,0]);assert.deepEqual(auxWords(snap,r.brick,3),[0,0,0,0]);
    for(let s=0;s<64;s++){
      const p=worldSlotCell(s).map((v,i)=>v+local[i]*4),offset=(p[0]+32*(p[1]+32*p[2]))*4;
      for(let j=0;j<3;j++)assert.deepEqual(fieldWords(snap,'field'+j,r.brick,s),[...new Uint16Array(c.buffers[j].bytes).subarray(offset,offset+4)]);
      const pid=lookupSnapshot(snap,r.brick).physicalPageID,a=pageTexel(pid,s,snap.layout);
      for(const name of ['stateA','stateB']){const texture=snap.views[name].texture,d=texture.size,to=(a[0]+d[0]*(a[1]+d[1]*a[2]))*4;const src=f.source.chunks.get(core.join(','))[name==='stateA'?'A':'B'];assert.deepEqual([...u32(texture).subarray(to,to+4)],[...u32(src).subarray((bi*64+s)*4,(bi*64+s+1)*4)]);}
      if(core[0]===0){assert.deepEqual(auxWords(snap,r.brick,4+2*s).slice(0,2),[...u32(f.source.chunks.get(core.join(',')).flow).subarray((bi*64+s)*2,(bi*64+s)*2+2)]);assert.equal(auxWords(snap,r.brick,5+2*s)[0],u32(f.source.chunks.get(core.join(',')).deco.buffer)[bi*64+s]);}
    }
  }
  const pinned=f.adapter.acquire();assert(f.adapter.isCurrent(pinned));assert.equal(pinned.field.complete,true);pinned.release();assert(!f.adapter.isCurrent(pinned));snap.release();publication.previousLightingSnapshot.release();await cleanup(f);
});

test('CELL write batches process every page across pool growth and preserve packed field words',async()=>{
  const f=fixture();await f.adapter.ready;const requirements=[];
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<24;x++)requirements.push({brick:[x,y,z],channels:READY.CELL});
  const sizes=[],write=f.atlas.recordPageWrites.bind(f.atlas);
  f.atlas.recordPageWrites=writes=>{sizes.push(writes.length);return write(writes);};
  const batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements});f.gpu.flush();
  const publication=f.adapter.commitAfterSourceFlush(batch);f.gpu.finish();
  assert.deepEqual(sizes,[128,64]);assert(requirements.every(r=>!f.atlas.lookup(r.brick,READY.CELL).incomplete));
  const snap=f.atlas.snapshot();
  const copies=f.gpu.trace.filter(t=>t.name==='native half copy');
  assert.equal(copies.reduce((n,t)=>n+t.extent[0]/8,0),96*3,'every page tile in exactly one native FIELD copy per channel');
  assert.equal(copies.length,24*3,'96 fresh consecutive pages: runs of four, three copies each');
  assert(copies.every(t=>t.bytesPerRow===256&&t.rowsPerImage===8&&t.offset%256===0&&t.extent[0]<=32&&t.extent[1]===8&&t.extent[2]===1));
  const dispatches=f.gpu.trace.filter(t=>t.name==='field CELL dispatch');
  assert.equal(dispatches.reduce((n,t)=>n+t.count,0),96,'all pages packed once');
  assert.equal(new Set(dispatches.map(t=>t.groups[0].entries[4].resource.buffer)).size,2,'one packed buffer per existing submission');
  for(let index=0;index<requirements.length;index++){
    const brick=requirements[index].brick,core=brick.map(v=>Math.floor(v/8)*32),capture=f.adapter.cache.get(core.join(','));
    assertFieldRows(f,snap,brick,capture);
    const local=brick.map((v,i)=>v-core[i]/4);
    assert.deepEqual(auxWords(snap,brick,0),[READY.CELL,1,0,0]);
    for(let s=0;s<64;s++){
      const p=worldSlotCell(s).map((v,i)=>v+local[i]*4),offset=(p[0]+32*(p[1]+32*p[2]))*4;
      for(let j=0;j<3;j++)assert.deepEqual(fieldWords(snap,'field'+j,brick,s),[...new Uint16Array(capture.buffers[j].bytes).subarray(offset,offset+4)]);
    }
  }
  snap.release();publication.previousLightingSnapshot.release();await cleanup(f);
});
test('raw CELL pages of a batch share one job list, one version block and one pass, each bound at its own dynamic offset',async()=>{
  const f=fixture();f.adapter.batchWrites=CELL_BATCH_WRITES;await f.adapter.ready;const requirements=[];
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<24;x++)requirements.push({brick:[x,y,z],channels:READY.CELL});
  const batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements});f.gpu.flush();
  const sizes=[],write=f.atlas.recordPageWrites.bind(f.atlas);
  f.atlas.recordPageWrites=writes=>{sizes.push(writes.length);return write(writes);};
  const inputs=[],bind=f.gpu.device.createBindGroup;f.gpu.device.createBindGroup=d=>{if(d.layout===f.adapter.packLayouts[0])inputs.push(d);return bind(d);};
  const publication=f.adapter.commitAfterSourceFlush(batch);
  assert.deepEqual(sizes,[192],'96 pages: one page-write submission at the app bound (pool growth adds its own copies)');
  assert.equal(inputs.length,3,'one input bind group per source core (24x2x2 bricks: three), each page at its own dynamic offset');
  const raw=f.gpu.trace.filter(t=>t.name==='raw CELL dispatch');assert.equal(raw.length,96);
  const window=(d,binding)=>d.groups[0].entries.find(e=>e.binding===binding).resource;
  for(const binding of [6,7]){
    assert.equal(new Set(raw.map(d=>window(d,binding).buffer)).size,1,`binding ${binding}: one buffer for the batch`);
    const offsets=raw.map(d=>window(d,binding).offset);assert.equal(new Set(offsets).size,96);assert(offsets.every(o=>o%256===0));
  }
  assert(raw.every(d=>window(d,6).size===272&&window(d,7).size===48));
  const ids=new Map(),id=o=>{if(!ids.has(o))ids.set(o,ids.size);return ids.get(o);};
  const views=new Set(raw.map(d=>d.groups[1].entries.map(e=>`${e.binding}:${id(e.resource)}`).join()));
  assert.equal(new Set(raw.map(d=>d.groups[1])).size,views.size,'one output bind group per pool resource set (this pool grows from 4 pages)');
  assert(views.size<raw.length/4);
  f.gpu.finish();await Promise.resolve();
  const snap=f.atlas.snapshot();
  for(const r of requirements){
    const core=r.brick.map(v=>Math.floor(v/8)*32),local=r.brick.map((v,i)=>v-core[i]/4),bi=brickIdOf(SOURCE_GRID,...local),pid=lookupSnapshot(snap,r.brick).physicalPageID;
    assert.deepEqual(auxWords(snap,r.brick,0),[READY.CELL,1,0,0]);
    for(const s of [0,37,63]){
      const a=pageTexel(pid,s,snap.layout),texture=snap.views.stateA.texture,d=texture.size,to=(a[0]+d[0]*(a[1]+d[1]*a[2]))*4;
      assert.deepEqual([...u32(texture).subarray(to,to+4)],[...u32(f.source.chunks.get(core.join(',')).A).subarray((bi*64+s)*4,(bi*64+s+1)*4)]);
    }
  }
  snap.release();publication.previousLightingSnapshot.release();await cleanup(f);
});
for(const failure of ['recording','submission'])test(`second field batch ${failure} failure fences submitted64-page prefix and retries without EMA`,async()=>{
  const f=fixture();await f.adapter.ready;const requirements=[];
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<24;x++)requirements.push({brick:[x,y,z],channels:READY.CELL});
  const batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements});f.gpu.flush();
  const version=f.adapter.fields.version,tick=f.adapter.fields.lastTick,submit=f.gpu.queue.submit,write=f.atlas.recordPageWrites.bind(f.atlas),attempted=[];
  let batches=0,submits=0,pageSubmits=0,packing=false;
  f.gpu.queue.submit=encoders=>{if(packing){submits++;if(failure==='submission'&&submits===2)throw new Error('second submission failed');pageSubmits++;}return submit(encoders);};
  f.atlas.recordPageWrites=writes=>{
    batches++;attempted.push(writes.map(w=>f.atlas.cell.pages.get(w.job.physicalPageID)));
    packing=true;try{
      if(failure==='recording'&&batches===2)return write(writes.map((w,i)=>i===writes.length-1?{...w,record(){throw new Error('second recording failed');}}:w));
      return write(writes);
    }finally{packing=false;}
  };
  assert.throws(()=>f.adapter.commitAfterSourceFlush(batch),new RegExp(`second ${failure} failed`));
  assert.equal(pageSubmits,1,'64-page prefix really submitted');assert.equal(batches,2);
  assert(attempted[0].every(p=>p.written.has('field0')));assert(attempted[1].every(p=>!p.written.has('field0')),'failed batch never ready');
  assert.equal(f.adapter.publication,null,'growth may publish new resource layouts, never incomplete CELL pages');assert(requirements.every(r=>f.atlas.lookup(r.brick,READY.CELL).incomplete));assert.equal(f.adapter.pending.handle,batch);
  for(const channel of [READY.RAW,READY.FIELD,READY.AUX])assert(requirements.every(r=>f.atlas.lookup(r.brick,channel).incomplete),'no partial-channel admission');
  const temporary=new Set(f.gpu.trace.filter(t=>t.name==='field CELL dispatch').flatMap(t=>t.groups[0].entries.slice(3).map(e=>e.resource.buffer)));
  assert(temporary.size>=4);assert([...temporary].every(b=>!b.destroyed),'buffers retained before completion fence');
  f.gpu.finish();await Promise.resolve();assert([...temporary].every(b=>b.destroyed),'both successful-prefix and failed-suffix buffers retired after fence');
  f.gpu.queue.submit=submit;f.atlas.recordPageWrites=write;
  const publication=f.adapter.commitAfterSourceFlush(batch);assert.equal(f.adapter.fields.version,version);assert.equal(f.adapter.fields.lastTick,tick);f.gpu.finish();
  const snapshot=f.atlas.snapshot();for(const index of [0,63,64,95]){const brick=requirements[index].brick;assertFieldRows(f,snapshot,brick,f.adapter.cache.get(brickKeyForTest(brick)));}
  assert(requirements.every(r=>!f.atlas.lookup(r.brick,READY.CELL).incomplete));snapshot.release();publication.previousLightingSnapshot.release();await cleanup(f);
});
function brickKeyForTest(brick){return brick.map(v=>Math.floor(v/8)*32).join(',');}

test('zero-output unseen settling invalidates retained required CELL pages atomically, preserving previous pins',async()=>{
  const f=fixture();await f.adapter.ready;f.atlas.require(req);
  const b=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:req});f.gpu.flush();f.adapter.commitAfterSourceFlush(b).previousLightingSnapshot.release();f.gpu.finish();
  const old=f.atlas.snapshot(),required=new Set(f.atlas.required);
  const next=f.adapter.record(f.gpu.frame,{fieldTick:1,requirements:[]});assert.equal(f.adapter.pending.result.outputs.length,0);assert.equal(f.adapter.pending.invalidated.length,2);assert.equal(f.adapter.cache.size,0);
  f.gpu.flush();f.adapter.commitAfterSourceFlush(next).previousLightingSnapshot.release();f.gpu.finish();assert.deepEqual(f.atlas.required,required);
  assert(f.atlas.lookup(req[0].brick).incomplete);assert(!lookupSnapshot(old,req[0].brick).incomplete);old.release();await cleanup(f);
});
test('aborted settling retains CELL/LIGHT/Sun invalidations until successful Atlas publication, even after fields become idle',async()=>{
  const f=fixture();await f.adapter.ready;const r=[req[0]],lightBrick=[20,0,0];
  let batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:r});f.gpu.flush();f.adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();f.gpu.finish();
  const light=f.atlas.allocateLight(lightBrick,{sourceRevision:0,readyBits:READY.GI_SOURCE});
  f.atlas.updateLight(light,{source:new Uint32Array([123,456,789,0x1ff7fdff])});
  f.atlas.publish({lightJobs:[light],sunManifest:{epoch:1,basisRevision:1,publishRevision:1,dependencySetID:0,dependencyVersion:0,book:{},sun0:{},sun1:{},
    params:{worldToLight:Array(16).fill(0),depth:[1,0,1,1],tiles:[0,0,1,1],physical:[256,8,64,1],version:[1,1,1,f.atlas.bookLayout.sunWord]}}});f.gpu.finish();
  const old=f.atlas.snapshot();
  for(let tick=1;tick<=13;tick++){
    batch=f.adapter.record(f.gpu.frame,{fieldTick:tick,requirements:[]});f.gpu.flush();f.adapter.abort(batch);f.gpu.finish();await Promise.resolve();
  }
  batch=f.adapter.record(f.gpu.frame,{fieldTick:14,requirements:[]});
  assert.equal(f.adapter.pending.plan.advancing.length,0);assert.equal(f.adapter.pending.invalidated.length,0);
  assert(f.adapter.unpublishedInvalidations.has('0,0,0'));assert(f.adapter.lightingDirty);f.gpu.flush();
  const publish=f.atlas.publish.bind(f.atlas);f.atlas.publish=()=>{throw new Error('Atlas patch rejected');};
  assert.throws(()=>f.adapter.commitAfterSourceFlush(batch),/Atlas patch rejected/);
  assert(f.adapter.unpublishedInvalidations.has('0,0,0'));assert(f.adapter.lightingDirty);
  assert(!f.atlas.lookup(r[0].brick).incomplete);assert(!f.atlas.lookup(lightBrick,READY.GI_SOURCE).incomplete);
  f.atlas.publish=publish;f.adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();f.gpu.finish();
  assert(f.atlas.lookup(r[0].brick).incomplete);assert(f.atlas.lookup(lightBrick,READY.GI_SOURCE).incomplete);
  const now=f.atlas.snapshot();assert.equal(now.sunManifest,null);now.release();
  assert(!lookupSnapshot(old,r[0].brick).incomplete);assert(old.sunManifest);
  assert.equal(f.adapter.unpublishedInvalidations.size,0);assert.equal(f.adapter.lightingDirty,false);
  old.release();await cleanup(f);
});
test('source changes consumed by an aborted Fields record remain in the eventual publication delta',async()=>{
  const f=fixture();await f.adapter.ready;
  let b=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:[req[0]]});f.gpu.flush();f.adapter.commitAfterSourceFlush(b).previousLightingSnapshot.release();f.gpu.finish();
  f.source.noteContentChange({lo:[0,0,0],hi:[1,1,1]});
  b=f.adapter.record(f.gpu.frame,{fieldTick:1,requirements:[]});f.gpu.flush();f.adapter.abort(b);f.gpu.finish();
  b=f.adapter.record(f.gpu.frame,{fieldTick:2,requirements:[]});assert.equal(f.adapter.pending.options.changedBricks.length,0);
  f.gpu.flush();f.adapter.commitAfterSourceFlush(b).previousLightingSnapshot.release();f.gpu.finish();
  const publication=f.adapter.acquire();assert(publication.changedBricks.some(b=>b.join(',')==='0,0,0'));
  assert(Object.isFrozen(publication.changedBricks));publication.release();await cleanup(f);
});

test('publisher rejection after partial auto-submit quarantines COW pages, preserves both manifests and retries exact SAME plan',async()=>{
  const f=fixture();await f.adapter.ready;f.gpu.autoFlush=10;
  const normal=f.adapter.publish.bind(f.adapter);let firstPlan;
  const plan=f.adapter.fields.plan.bind(f.adapter.fields);f.adapter.fields.plan=options=>firstPlan??=(plan(options));
  f.adapter.publish=()=>{throw new Error('rejected publication');};
  assert.throws(()=>f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:req}),/rejected/);
  assert.equal(f.adapter.cache.size,0);assert.equal(f.adapter.fields.history.owners.size,0);assert.equal(f.adapter.fields.version,1);
  assert(f.gpu.flushes>0);assert(f.adapter.fields.history.quarantined.size>0);
  const quarantined=[...f.adapter.fields.history.quarantined];assert(quarantined.every(p=>!f.adapter.fields.history.free.includes(p)));
  f.gpu.finish();await Promise.resolve();assert.equal(f.adapter.fields.history.quarantined.size,0);
  f.adapter.publish=normal;
  const batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:req});assert.equal(f.adapter.pending.plan,firstPlan);f.gpu.flush();f.adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();f.gpu.finish();
  assert.equal(f.adapter.fields.lastTick,0);assert.equal(f.adapter.cache.size,2);
  const control=fixture();await control.adapter.ready;const cb=control.adapter.record(control.gpu.frame,{fieldTick:0,requirements:req});control.gpu.flush();control.adapter.commitAfterSourceFlush(cb).previousLightingSnapshot.release();control.gpu.finish();
  for(const [key,owner] of f.adapter.fields.history.owners){const expected=control.adapter.fields.history.owners.get(key);assert.deepEqual([...new Uint32Array(owner.page.buffer.bytes,owner.page.offset,192)],[...new Uint32Array(expected.page.buffer.bytes,expected.page.offset,192)],'retry history differs from no-failure control');}
  await cleanup(control);await cleanup(f);
});

test('Atlas packing retry preserves successful field batch without a second EMA advance; source edits reject stale batches',async()=>{
  const f=fixture();await f.adapter.ready;const batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:req});f.gpu.flush();
  const write=f.atlas.recordPageWrites.bind(f.atlas);let fail=true;
  f.atlas.recordPageWrites=writes=>write(writes.map(w=>({...w,record(...args){if(w.kind==='fields'&&fail){fail=false;throw new Error('packing failed');}return w.record(...args);}})));
  assert.throws(()=>f.adapter.commitAfterSourceFlush(batch),/packing failed/);assert.equal(f.adapter.pending.handle,batch);const v=f.adapter.fields.version;
  f.adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();assert.equal(f.adapter.fields.version,v);f.gpu.finish();
  const next=f.adapter.record(f.gpu.frame,{fieldTick:1,requirements:req});f.gpu.flush();f.source.noteContentChange({lo:[0,0,0],hi:[1,1,1]});assert.throws(()=>f.adapter.commitAfterSourceFlush(next),/Stale/);f.adapter.abort(next);await cleanup(f);
});

test('retained valid numerical capture survives unrelated semantic revision, while origin transfer does not change source token/journal',async()=>{
  const f=fixture();await f.adapter.ready;
  let b=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:[req[0]]});f.gpu.flush();f.adapter.commitAfterSourceFlush(b).previousLightingSnapshot.release();f.gpu.finish();
  for(const owner of f.adapter.fields.history.owners.values())owner.age=32;
  const old=f.adapter.cache.get('0,0,0'),token=f.source.contentToken();
  f.source.recordLeavingCopy(f.gpu.frame,f.sim,{lo:[0,0,0],hi:[32,8,8]});assert.deepEqual(f.source.contentToken(),token);assert.deepEqual(f.source.changesSince(token).changedBricks,[]);
  f.source.noteContentChange({lo:[80,0,0],hi:[81,1,1]});assert.deepEqual(f.source.changesSince(token).changedBricks,[[20,0,0]]);
  b=f.adapter.record(f.gpu.frame,{fieldTick:1,requirements:[req[0]]});assert.equal(f.adapter.pending.result.outputs.length,0);assert.equal(f.adapter.cache.get('0,0,0'),old);assert(!old.source.isCurrent(),'retained validity is not old generation currentness');
  f.gpu.flush();f.adapter.commitAfterSourceFlush(b).previousLightingSnapshot.release();f.gpu.finish();assert.equal(f.adapter.cache.get('0,0,0'),old);await cleanup(f);
});

test('source journal global invalidation and immutable store uploads do not force per-core writes/flushes',async()=>{
  const f=fixture();await f.adapter.ready;const before=f.source.contentToken(),a=new Float32Array(256),b=new Float32Array(256);a.fill(20);b.fill(-0);new Uint32Array(b.buffer)[3]=0x7fc12345;
  f.win.store.put(f.win.store.key(20,0,0),encodeBrick(a,0,b,0));
  const batch=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:[{brick:[20,0,0],channels:READY.CELL}]});assert.equal(f.gpu.flushes,0);assert.equal(f.gpu.writes,0);assert.deepEqual(f.source.contentToken(),before);
  f.gpu.flush();f.adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();f.gpu.finish();
  const out=f.source.getSource([80,0,0]);assert.equal(u32(out.chunk.B)[out.slot*4+3],0x7fc12345);
  f.source.invalidateGenerated();assert.equal(f.source.changesSince(before).global,true);await cleanup(f);
});

test('known bounded producer ownership survives capture/reset; present untrusted wakes reject before Fields recording',async()=>{
  const f=fixture();await f.adapter.ready;
  f.sim.aeration={buffer:f.gpu.createBuffer({size:f.sim.g.slots*16}),cur:0};f.source.recordLiveCopy(f.gpu.frame);
  assert.throws(()=>f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:[req[0]]}),/Untrusted/);f.gpu.finish();
  f.sim.aeration=null;setAeration(f.sim,true);const aer=aerationForSource(f.sim);assert(isProducerBoundedAeration(aer));
  f.source.recordLiveCopy(f.gpu.frame);f.source.recordLeavingCopy(f.gpu.frame,f.sim,{lo:[0,0,0],hi:[32,8,8]});assert.doesNotThrow(()=>f.source.assertBoundedWake([{lo:[0,0,0],hi:[32,8,8]}]));
  const old=f.source.contentToken();f.source.reset();assert.equal(f.source.changesSince(old).global,true);assert.equal(f.source.chunks.size,0);f.adapter.reset();f.gpu.finish();await cleanup(f);
});

test('late quarantine completion cannot return old-epoch pages into the new history allocator',()=>{
  const gpu=new CellTestGPU(),history=new WorldFieldHistory(gpu,{pagesPerSlab:2});history.reset(1);
  const old=history.allocate(),release=history.quarantine([old]);history.reset(2);const current=history.allocate();release();release();
  assert.notEqual(current.buffer,old.buffer);assert(!history.free.includes(old));assert.equal(history.quarantined.size,0);history.dispose();
});

test('actual raw-u32 field WGSL preserves all half patterns, all channels and boundary pages against old native rows',()=>{
  const gpu=new CellTestGPU(),buffers=Array.from({length:3},()=>gpu.createBuffer({size:32**3*8}));
  for(let c=0;c<3;c++){const half=new Uint16Array(buffers[c].bytes);for(let i=0;i<half.length;i++)half[i]=(i+c*997)&65535;assert.equal(new Set(half).size,65536);}
  // Includes both signs of NaN payloads/infinities/zero/subnormals, as raw words.
  for(const pattern of [0,0x8000,1,0x8001,0x7c00,0xfc00,0x7c01,0x7e55,0xfc01,0xfe55])assert(new Uint16Array(buffers[0].bytes).includes(pattern));
  const jobs=new Uint32Array(512*4),packed=new Uint32Array(512*3*2048/4);packed.fill(0xdededede);
  // job.w: the page's first packed texel; one page alone in its rows here
  for(let i=0;i<512;i++)jobs.set([i&7,(i>>3)&7,i>>6,(511-i)*768],i*4);
  new FieldShaderExec(new WgslParser().parse(worldFieldPackWGSL)).dispatchWorkgroups('main',512,{0:{0:u32(buffers[0]),1:u32(buffers[1]),2:u32(buffers[2]),3:jobs,4:packed}});
  const layout={capacity:512,cells:{x:8,y:8}},actual=[],expected=[];
  for(let c=0;c<3;c++){actual.push(gpu.createTexture({size:[64,64,8],format:'rgba16float'}));expected.push(gpu.createTexture({size:[64,64,8],format:'rgba16float'}));}
  for(let i=0;i<512;i++)for(let c=0;c<3;c++){
    const origin=pageTexel(511-i,0,layout);
    gpu.frame.direct().copyBufferToTexture({buffer:{bytes:packed.buffer},offset:((511-i)*3+c)*2048,bytesPerRow:256,rowsPerImage:8},{texture:actual[c],origin},[8,8,1]);
    copyCapturedFieldPage(gpu.frame.direct(),buffers[c],[i&7,(i>>3)&7,i>>6],{texture:expected[c],origin});
  }
  assert.equal(gpu.trace.filter(t=>t.name==='native half copy'&&actual.includes(t.dst)).length,512*3);
  gpu.finish();for(let c=0;c<3;c++)assert.deepEqual(new Uint8Array(actual[c].bytes),new Uint8Array(expected[c].bytes));
  for(let row=0;row<512*3*8;row++)for(let word=16;word<64;word++)assert.equal(packed[row*64+word],0xdededede,'row padding untouched');
  // four consecutive pages of a tile row share each 256-byte row: one [32,8,1] copy per run and channel
  const runJobs=new Uint32Array(512*4),runPacked=new Uint32Array(128*3*2048/4);
  for(let i=0;i<512;i++){const pid=511-i;runJobs.set([i&7,(i>>3)&7,i>>6,(pid>>2)*768+(pid&3)*8],i*4);}
  new FieldShaderExec(new WgslParser().parse(worldFieldPackWGSL)).dispatchWorkgroups('main',512,{0:{0:u32(buffers[0]),1:u32(buffers[1]),2:u32(buffers[2]),3:runJobs,4:runPacked}});
  const runActual=Array.from({length:3},()=>gpu.createTexture({size:[64,64,8],format:'rgba16float'}));
  for(let r=0;r<128;r++)for(let c=0;c<3;c++)gpu.frame.direct().copyBufferToTexture({buffer:{bytes:runPacked.buffer},offset:(r*3+c)*2048,bytesPerRow:256,rowsPerImage:8},{texture:runActual[c],origin:pageTexel(r*4,0,layout)},[32,8,1]);
  gpu.finish();for(let c=0;c<3;c++)assert.deepEqual(new Uint8Array(runActual[c].bytes),new Uint8Array(expected[c].bytes),'runs of four pages land as single pages do');
  assertWorldLayout([WORLD_FIELD_PACK_LAYOUT]);assert.equal(WORLD_FIELD_PACK_LAYOUT.length,5);assert.equal(WORLD_FIELD_PACK_LAYOUT.filter(e=>e.buffer?.type==='read-only-storage').length,4);
});

for(let channel=0;channel<3;channel++)test(`direct field${channel} copies preserve all65,536 half bit patterns and all512 pages (height384 stays global)`,()=>{
  const gpu=new CellTestGPU(),buffer=gpu.createBuffer({size:32**3*8}),data=new Uint16Array(buffer.bytes);for(let i=0;i<data.length;i++)data[i]=(i+channel*997)&65535;
  const texture=gpu.createTexture({size:[64,64,8],format:'rgba16float'}),layout={capacity:512,cells:{x:8,y:8}};
  for(let z=0;z<8;z++)for(let y=0;y<8;y++)for(let x=0;x<8;x++){const pid=x+8*(y+8*z),origin=pageTexel(pid,0,layout);copyCapturedFieldPage(gpu.frame.direct(),buffer,[x,y,z],{texture,origin});}
  gpu.finish();const seen=new Set(new Uint16Array(texture.bytes));assert.equal(seen.size,65536);
  for(let z=0;z<8;z++)for(let y=0;y<8;y++)for(let x=0;x<8;x++)for(let s=0;s<64;s++){
    const p=worldSlotCell(s),off=(x*4+p[0]+32*(y*4+p[1]+32*(z*4+p[2])))*4,a=pageTexel(x+8*(y+8*z),s,layout),to=(a[0]+64*(a[1]+64*a[2]))*4;
    assert.deepEqual([...new Uint16Array(texture.bytes).subarray(to,to+4)],[...data.subarray(off,off+4)]);
  }
  const atlas=new WorldRenderAtlas(gpu,{worldSize:[96,384,8]});assert.equal(atlas.bookLayout.bricks[1],96);atlas.dispose();gpu.finish();
});

test('atomic Atlas pool invalidations include wanted pages; validation failures preserve generation/old pins and replacements win',()=>{
  const gpu=new CellTestGPU(),atlas=new WorldRenderAtlas(gpu,{worldSize:[4,4,4]});const brick=[0,0,0];atlas.require([{brick,channels:READY.CELL}]);
  const upload=()=>{const j=atlas.allocate(brick,{sourceRevision:0});atlas.update(j,{stateA:new Uint32Array(256),stateB:new Uint32Array(256),field0:new Uint16Array(256),field1:new Uint16Array(256),field2:new Uint16Array(256),aux:(()=>{const a=new Uint32Array(528);a.set([7,1,0,0]);return a;})()});return j;};
  atlas.publish(upload());gpu.finish();const old=atlas.snapshot(),generation=atlas.generation;
  assert.throws(()=>atlas.publish({invalidations:[{brick,channels:READY.FIELD}]}),/complete pool/);assert.equal(atlas.generation,generation);
  atlas.publish({invalidations:[{brick,channels:READY.CELL}]});assert(atlas.lookup(brick).incomplete);assert(!lookupSnapshot(old,brick).incomplete);assert.equal(atlas.required.size,1);
  atlas.publish({cellJobs:[upload()],invalidations:[{brick,channels:READY.CELL}]});assert(!atlas.lookup(brick).incomplete);old.release();atlas.dispose();gpu.finish();
});

test('unknown offscreen LIGHT closures invalidate atomically, no-op preserves, owner replacement wins and old history stays pinned',async()=>{
  const f=fixture();await f.adapter.ready;
  let b=f.adapter.record(f.gpu.frame,{fieldTick:0,requirements:[req[0]]});f.gpu.flush();f.adapter.commitAfterSourceFlush(b).previousLightingSnapshot.release();f.gpu.finish();
  for(const o of f.adapter.fields.history.owners.values())o.age=32;
  const brick=[20,0,0],sourceWords=new Uint32Array([123,456,789,0x1ff7fdff]);
  const light=f.atlas.allocateLight(brick,{sourceRevision:0,readyBits:READY.GI_SOURCE});f.atlas.updateLight(light,{source:sourceWords});f.atlas.publish({lightJobs:[light]});f.gpu.finish();
  b=f.adapter.record(f.gpu.frame,{fieldTick:1,requirements:[req[0]]});assert.equal(f.adapter.pending.plan.advancing.length,0);f.gpu.flush();f.adapter.commitAfterSourceFlush(b).previousLightingSnapshot.release();f.gpu.finish();assert(!f.atlas.lookup(brick,READY.GI_SOURCE).incomplete);
  const old=f.atlas.snapshot();f.source.noteContentChange({lo:[80,0,0],hi:[81,1,1]});
  b=f.adapter.record(f.gpu.frame,{fieldTick:2,requirements:[req[0]]});f.gpu.flush();const result=f.adapter.commitAfterSourceFlush(b);f.gpu.finish();assert(f.atlas.lookup(brick,READY.GI_SOURCE).incomplete);
  const n=f.atlas.bookLayout.bricks,index=brick[0]+n[0]*(brick[1]+n[1]*brick[2]);assert(u32(old.lightBook)[index]>0);assert(!old.lightBook.destroyed);
  for(const o of f.adapter.fields.history.owners.values())o.age=32;
  f.source.noteContentChange({lo:[80,0,0],hi:[81,1,1]});b=f.adapter.record(f.gpu.frame,{fieldTick:3,requirements:[req[0]]});f.gpu.flush();
  const replacement=f.atlas.allocateLight(brick,{sourceRevision:f.source.contentRevision,sourceTick:3,readyBits:READY.GI_SOURCE});f.atlas.updateLight(replacement,{source:sourceWords});f.adapter.commitAfterSourceFlush(b,{lightJobs:[replacement]}).previousLightingSnapshot.release();f.gpu.finish();assert(!f.atlas.lookup(brick,READY.GI_SOURCE).incomplete);
  old.release();result.previousLightingSnapshot.release();await cleanup(f);
});

test('actual shared classifier Box emission unchanged at32/64/128; world classifier/raw pack Naga and exact seven-buffer layouts',()=>{
  for(const n of [32,64,128]){
    const path='src/shaders/passes.js',text=execFileSync('git',['show',`${BOX_BRICK_FRAG_AT}:${path}`],{encoding:'utf8'});
    // Import the historical module alongside its unchanged dependencies through
    // a data URL whose relative imports are resolved to the actual module URLs.
    const rewritten=text.replace(/from '([^']+)'/g,(_m,p)=>`from '${new URL(p,new URL('../src/shaders/passes.js',import.meta.url)).href}'`);
    // The async golden import is covered by full backend gate below; source
    // literal invariants are checked here, actual modules in the next async test.
    assert(rewritten.includes('export const brickFrag'));assert(brickFrag(gridDims({nx:n,ny:n,nz:n})).includes('wgEm[li] += wgEm[li + w]'));
  }
  assertWorldLayout(WORLD_CELL_PACK_LAYOUTS);assert.equal(WORLD_CELL_PACK_LAYOUTS[0].filter(e=>e.buffer?.type==='read-only-storage').length,7);
  for(const [name,code] of [['classifier',worldCellClassifierWGSL(gridDims({nx:64,ny:64,nz:64}))],['raw',worldCellPackWGSL],['fields',worldFieldPackWGSL]])execFileSync('naga',['--stdin-file-path',name+'.wgsl'],{input:code,stdio:['pipe','pipe','pipe'],timeout:10000});
});

test('actual historical Box brickFrag text remains byte-identical, not merely equivalent arithmetic',async()=>{
  const text=execFileSync('git',['show',`${BOX_BRICK_FRAG_AT}:src/shaders/passes.js`],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_m,p)=>`from '${new URL(p,new URL('../src/shaders/passes.js',import.meta.url)).href}'`);
  const historical=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
  for(const n of [32,64,128]){const g=gridDims({nx:n,ny:n,nz:n});assert.equal(brickFrag(g),historical.brickFrag(g));}
});

test('executed actual classifier openFaces: true world floor/side/top vs internal core boundaries, buried/opaque/crystal neighbors',()=>{
  const factory=worldCellClassifierWGSL(gridDims({nx:64,ny:64,nz:64}));
  const start=factory.indexOf('fn openFaces(');let end=factory.indexOf('{',start),depth=1;
  while(depth&&++end<factory.length){if(factory[end]==='{')depth++;else if(factory[end]==='}')depth--;}
  const leaf=factory.slice(start,end+1),cases=[];
  for(const origin of [[-16,-16,-16],[16,16,16],[48,336,-16]])for(const p of [[16,16,16],[47,47,47],[16,47,16]])for(const ids of [[0,0,0,0,0,0],[1,1,1,1,1,1],[2,2,2,2,2,2],[0,1,2,3,1,0]])cases.push({origin,p,ids});
  const input=new Int32Array(cases.flatMap(c=>[...c.origin,0,0,0,0,0,96,384,96,0,...c.p,0,...c.ids,0,0]));
  const output=new Float32Array(cases.length);
  const code=`struct Params {scratchOrigin:vec3i,worldMin:vec3i,worldMax:vec3i}
@group(0) @binding(0) var<storage,read> input:array<vec4i>;
@group(0) @binding(1) var<storage,read_write> output:array<f32>;
var<private> P:Params;var<private> C:vec3i;var<private> ids:array<i32,6>;
const R_OPAQUE:i32=1;const E_CRYSTAL:i32=2;
fn RCLASS(id:i32)->i32{return select(0,1,id==1);}
fn eid(a:vec4f)->i32{return i32(floor(a.x+0.5));}
fn fetchA(q:vec3i)->vec4f{var k=0;if(q.x!=C.x){k=select(0,1,q.x>C.x);}else if(q.y!=C.y){k=select(2,3,q.y>C.y);}else{k=select(4,5,q.z>C.z);}return vec4f(f32(ids[k]),0.0,0.0,0.0);}
${leaf}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid:vec3u){let i=gid.x*6u;P.scratchOrigin=input[i].xyz;P.worldMin=input[i+1u].xyz;P.worldMax=input[i+2u].xyz;C=input[i+3u].xyz;ids[0]=input[i+4u].x;ids[1]=input[i+4u].y;ids[2]=input[i+4u].z;ids[3]=input[i+4u].w;ids[4]=input[i+5u].x;ids[5]=input[i+5u].y;output[gid.x]=openFaces(C);}`;
  execFileSync('naga',['--stdin-file-path','leaf.wgsl'],{input:code,stdio:['pipe','pipe','pipe'],timeout:10000});
  new WgslExec(new WgslParser().parse(code)).dispatchWorkgroups('main',cases.length,{0:{0:input,1:output}});
  cases.forEach((c,i)=>{let expected=0;for(let k=0;k<6;k++){const q=c.p.map((v,a)=>v+c.origin[a]);q[k>>1]+=k&1?1:-1;if(q[1]<0)continue;if(q.some((v,a)=>v<0||v>=[96,384,96][a])||![1,2].includes(c.ids[k]))expected++;}assert.equal(output[i],expected);});
  // Exact unchanged shared reduction/air/liquid/film/emission paths are proven
  // by the complete Box text golden above; this executes the ONLY changed math.
  assert.match(factory,/wgEm\[li\] \+= wgEm\[li \+ w\]/);assert.match(factory,/all\(l >= vec3i\(1\)\) && all\(l <= vec3i\(2\)\)/);
});
