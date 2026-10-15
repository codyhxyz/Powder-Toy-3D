// Actual Source/SceneGpu/Producer/CELL classes with delayed native commands.
// Synthetic generator/field execution is transport evidence, NOT GPU parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CellTestGPU } from './cell-adapter-test-gpu.mjs';
import { WorldRenderSource, SOURCE_GRID, SOURCE_RANK } from '../src/world/renderSource.js';
import { RawWorldSourceProducer, sourceTrees } from '../src/world/renderSourceProducer.js';
import { SceneGpu } from '../src/world/gpu.js';
import { sceneStruct, sceneHeadWGSL } from '../src/world/scenes/sceneGpu.js';
import { SharedUniforms } from '../src/gpu/params.js';
import { WorldCellAtlasAdapter } from '../src/world/cellAtlasAdapter.js';
import { WorldRenderAtlas, READY } from '../src/world/renderAtlas.js';
import { gridDims, cellSlot } from '../src/shaders/common.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { setAeration, aerationForSource } from '../src/gfx/foam.js';
import { worldParams, treesIn } from '../src/world/generator.js';
const u32=b=>new Uint32Array(b.bytes),f32=b=>new Float32Array(b.bytes);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function drain(gpu){for(let i=0;i<3;i++){gpu.finish();await tick();}}
async function fixture({size=[96,8,8],pre=false,trees=false}={}) {
  const gpu=new CellTestGPU();
  globalThis.GPUBufferUsage={STORAGE:128,COPY_SRC:4,COPY_DST:8,UNIFORM:64,INDIRECT:256};
  gpu.stats={bytesUploaded:0,writeFlushes:0};
  gpu.uniforms=(s,label)=>new SharedUniforms(gpu,s,label);
  gpu.write=(b,o,v)=>{gpu.flush();gpu.queue.writeBuffer(b,o,v);};
  const g=gridDims({nx:32,ny:32,nz:32}),buffer=n=>gpu.createBuffer({size:n,usage:128|4|8});
  const sim={g,gpu,cur:0,version:0,origin:{x:0,y:0,z:0},L:{TABLES:gpu.layout('TABLES',[])},tables:{},marks:buffer(16),state:{A:buffer(g.slots*32),B:buffer(g.slots*32),F:buffer(g.slots*8)},flow:buffer(g.slots*8),decoPlane:{buffer:buffer(g.slots*4),offset:0},deco:{store:new Map()},
    _retire:b=>gpu.retire(b),header(){return {src:this.cur,dst:this.cur,origin:[this.origin.x,0,this.origin.z]};},onShift(){return ()=>{};},attachAeration(a){this.aeration=a;},wake(){}};
  for(let s=0;s<g.slots*2;s++){f32(sim.state.A).set([2,20,.5,.125],s*4);u32(sim.state.B).set([0x80000000,0x7fc12345,s,0x11223344],s*4);}
  for(let i=0;i<u32(sim.flow).length;i++)u32(sim.flow)[i]=(0x80000000+i*7919)>>>0;
  for(let i=0;i<u32(sim.decoPlane.buffer).length;i++)u32(sim.decoPlane.buffer)[i]=(0x7fc12345+i)>>>0;
  const listeners=new Set(),S=sceneStruct(pre?{uPreAt:'u32'}:{}),scene={key:'cut-fixture',uniformStruct:S,uniforms:()=>({uSceneSeed:13}),data:()=>({at:0,words:new Uint32Array([17,18,19,20])}),
    subscribeData(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    glsl:()=>sceneHeadWGSL(S,{data:true})+'fn sceneCell(p:vec3i)->SceneCell { return SceneCell(vec4f(2.0,20.0,0.5,f32(sdWord(0u))),vec4f(0.0)); }',
    ...(trees?{trees:{treesIn}}:{}),...(pre?{pre:{code:()=>'',margin:()=>[1,1,1]}}:{})};
  const wb=size.map(v=>v/4),P=trees?worldParams({size,seed:20261008}):{seed:13,size:[...size]},win={sim,gpu,size,wb,P,epoch:1,scene,loaded:true,planted:new Uint8Array(wb[0]*wb[2]),candidates:new Map(),store:new BrickStore(wb)};
  const resources=new SceneGpu(sim,scene,P,{regions:[[64,size[1],64]]});win.gen={res:resources,ready:resources.ready};await resources.ready;
  const source=new WorldRenderSource(win);win.renderSource=source;sim.worldRenderSource=source;
  const producer=win.sourceProducer=new RawWorldSourceProducer(win,source);await producer.ready;
  // Execute generation from its actual selected native SceneGpu buffer. The
  // source CellTestGPU's constant field is intentionally not shader execution.
  gpu._generate=({bind})=>{
    const data=bind[2].entries.find(e=>e.binding===1).resource.buffer,seed=u32(data)[0];
    const A=bind[1].entries.find(e=>e.binding===0).resource.buffer,B=bind[1].entries.find(e=>e.binding===1).resource.buffer;
    for(let s=0;s<A.size/16;s++){f32(A).set([2,20,.5,seed],s*4);u32(B).set([0x80000000,0x7fc12345,s,seed],s*4);}
  };
  const editScene=value=>{for(const fn of [...listeners])fn(0,new Uint32Array([value]));};
  const finish=async()=>{await drain(gpu);producer.dispose();source.dispose();resources.dispose();await drain(gpu);};
  return {gpu,sim,win,source,producer,resources,scene,editScene,finish};
}
const cut=f=>f.source.recordCut(f.gpu.frame,{sceneVersion:'scene',configVersion:1});
function put(f,brick,value){const A=new Float32Array(256),B=new Float32Array(256);for(let s=0;s<64;s++){A.set([2,20,.5,value],s*4);new Uint32Array(B.buffer).set([0x80000000,0x7fc12345,s,value],s*4);}f.win.store.put(f.win.store.key(...brick),encodeBrick(A,0,B,0));}
function read(source,p,name='A'){const c=source.getSource(p);return [...u32(c.chunk[name]).subarray(c.slot*4,c.slot*4+4)];}

test('owned native cut preserves old live/full auxiliary words while current physics changes and late feedback resolves OLD saved/generator input',async()=>{
  const f=await fixture();setAeration(f.sim,true);const aer=aerationForSource(f.sim);aer.cur=1;
  for(let i=0;i<u32(aer.buffer).length;i++)u32(aer.buffer)[i]=(0x7fc12345+i*31)>>>0;
  u32(f.sim.state.A)[3]=0x80000000;u32(f.sim.state.A)[7]=0x7fc12345;
  const deco=f.gpu.createBuffer({size:f.sim.g.slots*4+16,usage:128|4|8});for(let i=0;i<u32(deco).length;i++)u32(deco)[i]=(0x7fc12345+i)>>>0;
  f.sim.decoPlane={buffer:deco,offset:16};
  const expected={A:u32(f.sim.state.A).slice(),B:u32(f.sim.state.B).slice(),flow:u32(f.sim.flow).slice(),aer:u32(aer.buffer).slice(),deco:u32(deco).slice()};
  put(f,[20,0,0],45);const old=cut(f),oldSnapshot=old.snapshotForFields({jetValidity:'producer-bounded-v1'}),oldChunk=old.source.chunks.get('0,0,0');
  // These execute AFTER cut copies. Do not mutate fake GPU backing bytes early.
  f.gpu._push(()=>{u32(f.sim.state.A).fill(0x12345678);u32(f.sim.state.B).fill(0xffffffff);u32(f.sim.flow).fill(0);u32(aer.buffer).fill(0);u32(f.sim.decoPlane.buffer).fill(0);});
  f.sim.version++;f.source.noteContentChange();f.source.recordLiveCopy(f.gpu.frame);
  put(f,[20,0,0],99);f.editScene(88);f.win.planted.fill(1);f.win.P.seed=999;
  assert(old.isValid());assert(!old.isLatest());assert(oldSnapshot.isCurrent());
  assert.equal(old.source.getSource([80,0,0]).kind,'unknown'); // future dependency, not captured early
  old.producer.record(f.gpu.frame,[64,0]);
  await drain(f.gpu);
  assert.equal(u32(oldChunk.A)[3],0x80000000);assert.equal(u32(oldChunk.A)[7],0x7fc12345);
  assert.equal(u32(oldChunk.B)[1],0x7fc12345);assert.equal(u32(oldChunk.flow)[1],(0x80000000+7919)>>>0);
  assert.equal(u32(oldChunk.aeration)[0],(0x7fc12345+SOURCE_GRID.slots*2*31)>>>0);
  assert.equal(u32(oldChunk.deco.buffer)[0],0x7fc12349);assert(oldChunk.wakeTrusted.every(Boolean));
  for(let z=0;z<8;z++)for(let y=0;y<8;y++)for(let x=0;x<32;x++){
    const s=cellSlot(SOURCE_GRID,x,y,z);
    for(const name of ['A','B'])assert.deepEqual(u32(oldChunk[name]).subarray(s*4,s*4+4),expected[name].subarray(s*4,s*4+4));
    assert.deepEqual(u32(oldChunk.flow).subarray(s*2,s*2+2),expected.flow.subarray(s*2,s*2+2));
    assert.deepEqual(u32(oldChunk.aeration).subarray(s*2,s*2+2),expected.aer.subarray((SOURCE_GRID.slots+s)*2,(SOURCE_GRID.slots+s)*2+2));
    assert.equal(u32(oldChunk.deco.buffer)[s],expected.deco[s+4]);
  }
  assert.equal(new Float32Array(Uint32Array.from(read(old.source,[80,0,0])).buffer)[3],45);
  assert.equal(new Float32Array(Uint32Array.from(read(old.source,[68,0,0])).buffer)[3],17);
  assert.equal(old.source.context.P.seed,13);assert(old.source.context.planted.every(v=>v===0));
  oldSnapshot.assertComplete([{lo:[64,0,0],hi:[96,8,8]}]);
  old.release();await f.finish();
});

test('unchanged semantic cores share native versions, lazy population COW and changed cores keep older bytes pinned',async()=>{
  const f=await fixture(),a=cut(f);await drain(f.gpu);const initial=a.source.chunks.get('0,0,0');
  // An authority-only outgoing transfer must not manufacture a semantic revision.
  f.source.recordLeavingCopy(f.gpu.frame,f.sim,{lo:[0,0,0],hi:[32,8,8]});
  const b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});
  assert.equal(b.source.chunks.get('0,0,0'),initial);assert.deepEqual(b.source.changesSince(a.contentToken).changedBricks,[]);
  // Producing an overlapping new column cannot overwrite the other cut's owner.
  b.producer.record(f.gpu.frame,[0,0]);assert.notEqual(b.source.chunks.get('0,0,0'),initial);
  f.gpu._push(()=>{f32(f.sim.state.A)[3]=.75;});f.sim.version++;f.source.noteContentChange({lo:[0,0,0],hi:[4,4,4]});
  const c=f.source.recordCut(f.gpu.frame,{previousCut:b,sceneVersion:'scene',configVersion:1});
  assert.notEqual(c.source.chunks.get('0,0,0'),b.source.chunks.get('0,0,0'));
  await drain(f.gpu);assert.equal(f32(initial.A)[3],.125);assert.equal(f32(c.source.chunks.get('0,0,0').A)[3],.75);
  a.release();await drain(f.gpu);assert(initial.A.destroyed);assert(!b.source.chunks.get('0,0,0').A.destroyed);
  b.release();c.release();await f.finish();
});

test('actual CELL adapter binds a cut without replacing Fields/history and old submitted providers do not starve on new physics',async()=>{
  const f=await fixture(),atlas=new WorldRenderAtlas(f.gpu,{worldSize:f.win.size,initialCapacity:4}),adapter=new WorldCellAtlasAdapter({gpu:f.gpu,source:f.source,producer:f.producer,atlas,tables:f.sim.tables,worldBounds:{min:[0,0,0],max:f.win.size}});await adapter.ready;
  const a=cut(f),fields=adapter.fields;adapter.bindCut(a);const options={fieldTick:0,requirements:[{brick:[7,1,1],channels:READY.CELL}]};
  const batch=adapter.record(f.gpu.frame,options);assert.throws(()=>adapter.bindCut(a),/pending/);f.gpu.flush();adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();await drain(f.gpu);
  const pub=adapter.sourceFieldSnapshotProvider.acquire(),oldRaw=a.source.chunks.get('0,0,0').A;
  f.source.noteContentChange();f.sim.version++;f.gpu._push(()=>{f32(f.sim.state.A)[3]=.9;});
  // A future dependency is served by the SAME older cut, after current physics
  // has advanced. Its logical field tick must not need a paused simulation.
  const feedback=adapter.record(f.gpu.frame,{fieldTick:0,requirements:[{brick:[20,0,0],channels:READY.CELL}]});
  f.gpu.flush();adapter.commitAfterSourceFlush(feedback).previousLightingSnapshot.release();await drain(f.gpu);
  assert.equal(f32(a.source.chunks.get('64,0,0').A)[3],17);assert(adapter.isCurrent(pub));
  const b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});adapter.bindCut(b);
  assert.equal(adapter.fields,fields);assert(adapter.sourceFieldSnapshotProvider.isCurrent(pub));
  a.release();await drain(f.gpu);assert(!oldRaw.destroyed,'old provider owns its cut through asynchronous readers');
  pub.release();assert(!adapter.isCurrent(pub));b.release();await drain(f.gpu);adapter.dispose();atlas.dispose();await f.finish();
});

test('final submission pins cover unsubmitted suffixes, reset/config invalidation and independent handle release',async()=>{
  const f=await fixture(),a=cut(f),native=a.source.chunks.get('0,0,0').A;
  f.gpu.flush();f.gpu.frame.clear(f.sim.flow);let submit;
  const submitted=new Promise(resolve=>{submit=resolve;}),done=a.retainUntilSubmitted(submitted),other=a.retain();a.release();
  f.gpu.finish();await tick();assert(!native.destroyed);
  const b=f.source.recordCut(f.gpu.frame,{sceneVersion:'scene',configVersion:2});assert(!other.isValid());assert.throws(()=>other.snapshotForFields(),/Invalid/);
  other.release();await drain(f.gpu);assert(!native.destroyed,'final consumer has not submitted');
  submit();await tick();f.gpu.finish();await done;await drain(f.gpu);assert(native.destroyed);
  const snapshot=b.snapshotForFields();f.source.reset();assert(!b.isValid());assert(!snapshot.isCurrent());assert.equal(b.producer.record(f.gpu.frame,[64,0]),null);b.release();await f.finish();
});

test('partial auto-submit capture failure retires only after normal final orphan closure/completion',async()=>{
  const f=await fixture();f.source.recordLiveCopy(f.gpu.frame);await drain(f.gpu);
  const copy=f.gpu.frame.copy;let n=0;f.gpu.autoFlush=2;f.gpu.frame.copy=(...args)=>{copy(...args);if(++n===5)throw new Error('cut copy injected');};
  assert.throws(()=>cut(f),/injected/);const allocated=f.gpu.resources.filter(b=>b.label?.startsWith('world source cut '));assert(allocated.length>0);assert(allocated.every(b=>!b.destroyed));
  while(f.gpu.submitted.length)f.gpu.submitted.shift()();for(const resolve of f.gpu.waiters.splice(0))resolve();
  await tick();assert(f.gpu.frame.open);assert(allocated.every(b=>!b.destroyed),'completed auto-prefix is not the final suffix fence');
  f.gpu.frame.copy=copy;await drain(f.gpu);assert(allocated.every(b=>b.destroyed));
  const retry=cut(f);assert(retry.isValid());retry.release();await f.finish();
});

test('scene prepass uses private native buffers and unknown generator ownership fails closed',async()=>{
  const f=await fixture({pre:true}),a=cut(f);f.editScene(71);a.producer.record(f.gpu.frame,[64,0]);
  const original=f.resources.data,pre=f.gpu.trace.find(e=>e.name==='cut-fixture pre'&&e.opts?.bind?.[2]?.name==='cut scene prepass');
  assert(pre);assert.notEqual(pre.opts.bind[2].entries.find(e=>e.binding===1).resource.buffer,original);
  await drain(f.gpu);assert.equal(new Float32Array(Uint32Array.from(read(a.source,[68,0,0])).buffer)[3],17);
  f.win.scene.trees={treesIn:()=>[]};assert.throws(()=>cut(f),/Unsupported mutable CPU tree/);f.win.scene.trees=null;
  const data=f.resources.uniforms.data;f.resources.uniforms.data=null;assert.throws(()=>cut(f),/not ready/);f.resources.uniforms.data=data;
  a.release();await f.finish();
});

test('frozen original world tree placement and planted target masks ignore later parameters and origin transfers',async()=>{
  const f=await fixture({size:[512,128,512],trees:true}),a=cut(f),origin=[192,0,192],g=a.producer.g;
  const before=sourceTrees(a.source.context,origin,g).map(t=>({at:t.at,seed:t.seed,words:[...new Uint32Array(t.s.data.buffer,t.s.data.byteOffset,t.s.data.length)]}));
  assert(before.length>0,'fixture must contain original baked tree support');
  f.win.P.seed=1;f.win.P.center.fill(0);f.win.planted.fill(1);f.sim.origin.x=16;f.source.recordLiveCopy(f.gpu.frame);
  const after=sourceTrees(a.source.context,origin,g).map(t=>({at:t.at,seed:t.seed,words:[...new Uint32Array(t.s.data.buffer,t.s.data.byteOffset,t.s.data.length)]}));
  assert.deepEqual(after,before);assert(a.isValid());assert(a.source.context.planted.every(v=>!v));assert.deepEqual(a.source.changesSince(a.contentToken).changedBricks,[]);
  a.release();await f.finish();
});

test('departing pending-save authority stays owned across newer store acknowledgement and late producer population',async()=>{
  const f=await fixture();f.source.recordLiveCopy(f.gpu.frame);
  const leaving=f.source.recordLeavingCopy(f.gpu.frame,f.sim,{lo:[0,0,0],hi:[32,8,8]});
  f.sim.origin.x=32;const a=cut(f),core=a.source.chunks.get('0,0,0'),s=cellSlot(core.g,0,0,0);
  assert.equal(core.rank[s],SOURCE_RANK.captured);assert.equal(core.pending[s],leaving.revision);
  put(f,[0,0,0],99);f.source.commitStoreRevision([f.win.store.key(0,0,0)],leaving);
  assert.equal(core.rank[s],SOURCE_RANK.captured);assert.equal(core.pending[s],leaving.revision);
  a.producer.record(f.gpu.frame,[0,0]);await drain(f.gpu);
  assert.equal(f32(a.source.getSource([0,0,0]).chunk.A)[s*4+3],.125);
  assert.equal(a.source.getSource([0,0,0]).kind,'captured');a.release();await f.finish();
});
