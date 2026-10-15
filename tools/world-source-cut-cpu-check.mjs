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
import { gridDims, atlasDims, cellSlot, brickIdOf } from '../src/shaders/common.js';
import { BrickStore, encodeBrick } from '../src/world/store.js';
import { setAeration, aerationForSource } from '../src/gfx/foam.js';
import { worldParams, treesIn } from '../src/world/generator.js';
import { createUnpacker } from '../src/net/codec.js';
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

test('actual replica unpack captures the old origin before overwrite and claims full new state after flow/wake reset',async()=>{
  const f=await fixture();f.sim.cur=1;setAeration(f.sim,true);
  Object.assign(f.sim.g,atlasDims(f.sim.g));
  const aer=aerationForSource(f.sim);u32(aer.buffer).fill(0x12345678);
  const events=[],unpack=createUnpacker(),bytes=new Uint8Array(f.sim.g.width*f.sim.g.height*4);bytes[0]=99;
  let claims=0,old;const claim=f.source.recordLiveCopy.bind(f.source);f.source.recordLiveCopy=(...args)=>{claims++;return claim(...args);};
  f.sim.bindRW={};f.sim.L.STATE_RW=f.gpu.layout('STATE_RW',[]);
  f.sim.noteWrite=()=>{events.push('write');f.sim.version++;f.sim.worldRenderSource?.noteContentChange();};
  f.sim.stillFlow=()=>{events.push('still');f.gpu._push(()=>{u32(f.sim.flow).fill(0);u32(aer.buffer).fill(0);});f.sim.worldRenderSource?.noteContentChange();};
  const execute=f.gpu.onExecute;
  f.gpu.onExecute=(kernel,options)=>{
    execute?.(kernel,options);
    if(kernel.name!=='unpack')return;
    const marker=new Uint8Array(options.bind[2].entries[0].resource.buffer.bytes)[0],start=f.sim.cur*f.sim.g.slots;
    for(let s=start;s<start+f.sim.g.slots;s++){f32(f.sim.state.A).set([2,30,.25,marker],s*4);u32(f.sim.state.B).set([0x80000000,0x7fc54321,s,0x55667788],s*4);}
  };
  assert.equal(await unpack.unpack(f.sim,bytes,{valid:()=>false,commit(){throw new Error('must not commit');}}),false);
  assert.equal(f.source.chunks.size,0);assert.equal(f.sim.version,0);
  assert.equal(await unpack.unpack(f.sim,bytes,{commit(){old=cut(f);events.push('origin');f.sim.origin.x=16;}}),true);
  await drain(f.gpu);
  const original=[2,20,.5,.125],bits=[...new Uint32Array(new Float32Array(original).buffer)];
  assert.equal(f32(f.sim.state.A)[f.sim.cur*f.sim.g.slots*4+3],99,'synthetic unpack writes the actual current native copy');
  assert.deepEqual(read(old.source,[20,0,0]),bits);assert.deepEqual(read(f.source,[0,0,0]),bits);
  assert.equal(new Float32Array(new Uint32Array(read(f.source,[20,0,0])).buffer)[3],99,`overlap words ${read(f.source,[20,0,0])}`);
  assert.equal(new Float32Array(new Uint32Array(read(f.source,[40,0,0])).buffer)[3],99);
  assert.deepEqual(read(f.source,[40,0,0],'B').slice(0,2),[0x80000000,0x7fc54321]);
  const leaving=f.source.getSource([0,0,0]),incoming=f.source.getSource([40,0,0]);
  assert.notEqual(u32(leaving.chunk.flow)[leaving.slot*2+1],0);
  assert.deepEqual([...u32(incoming.chunk.flow).subarray(incoming.slot*2,incoming.slot*2+2)],[0,0]);
  assert.equal(u32(leaving.chunk.aeration)[leaving.slot*2],0x12345678);assert.equal(u32(incoming.chunk.aeration)[incoming.slot*2],0);
  assert.deepEqual(events,['origin','write','still']);assert.equal(old.isValid(),true);assert.equal(old.isLatest(),false);
  assert.equal(claims,2); // Initial outgoing capture, then complete incoming claim.
  bytes[0]=101;
  assert.equal(await unpack.unpack(f.sim,bytes,{commit(){f.sim.origin.x=32;}}),true);await drain(f.gpu);
  assert.equal(claims,3,'an already claimed outgoing version needs no duplicate copy');
  assert.equal(new Float32Array(new Uint32Array(read(f.source,[20,0,0])).buffer)[3],99);
  assert.equal(new Float32Array(new Uint32Array(read(f.source,[40,0,0])).buffer)[3],101);
  assert.deepEqual(read(old.source,[20,0,0]),bits);
  const replacement=new WorldRenderSource({...f.win,epoch:2});
  bytes[0]=103;
  assert.equal(await unpack.unpack(f.sim,bytes,{commit(){f.source.dispose();f.sim.worldRenderSource=replacement;}}),true);await drain(f.gpu);
  assert.equal(new Float32Array(new Uint32Array(read(replacement,[40,0,0])).buffer)[3],103);
  assert.equal(old.isValid(),false,'replaced scene ownership invalidates old cuts, unlike an origin shift');
  assert.equal(claims,3,'replacement is claimed through the current simulation owner');
  replacement.dispose();f.sim.worldRenderSource=null;bytes[0]=104;
  assert.equal(await unpack.unpack(f.sim,bytes),true);await drain(f.gpu);
  assert.equal(f32(f.sim.state.A)[f.sim.cur*f.sim.g.slots*4+3],104,'BOX/no-Source retains its existing unpack path');
  old.release();await f.finish();
});

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
test('configuration-only cut binding invalidates spatial publications without resetting or advancing EMA history',async()=>{
  const f=await fixture(),atlas=new WorldRenderAtlas(f.gpu,{worldSize:f.win.size,initialCapacity:4});
  const adapter=new WorldCellAtlasAdapter({gpu:f.gpu,source:f.source,producer:f.producer,atlas,tables:f.sim.tables,worldBounds:{min:[0,0,0],max:f.win.size}});await adapter.ready;
  const a=cut(f),fields=adapter.fields,requirement={brick:[7,1,1],channels:READY.CELL};adapter.bindCut(a);
  const publish=async requirements=>{
    const batch=adapter.record(f.gpu.frame,{fieldTick:0,requirements});f.gpu.flush();
    adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();await drain(f.gpu);
  };
  await publish([requirement]);assert(atlas.lookup(requirement.brick).known);
  const owners=()=>[...fields.history.owners].map(([key,o])=>[key,o.page,o.age,o.lastTick]);
  const before=owners(),token=adapter.lastSourceToken;
  const b=f.source.recordCut(f.gpu.frame,{sceneVersion:'scene',configVersion:2});adapter.bindCut(b);
  assert.equal(adapter.fields,fields);assert.equal(adapter.cache.size,0);assert.equal(fields.published.size,0);
  assert(adapter.unpublishedInvalidations.has('0,0,0'));assert.equal(adapter.lastSourceToken,token);assert.deepEqual(owners(),before);
  await publish([]);assert.equal(atlas.lookup(requirement.brick).known,false,'idle publication must clear old CELL mappings');
  await publish([requirement]);assert(atlas.lookup(requirement.brick).known);assert.equal(adapter.cache.size,1);
  assert.deepEqual(owners(),before,'same-clock re-derivation does not restart or advance EMA');
  a.release();b.release();adapter.dispose();atlas.dispose();await f.finish();
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
test('discarded final cut-consumer submission keeps its pin until earlier prefix completion',async()=>{
  const f=await fixture(),a=cut(f),snapshot=a.snapshotForFields();f.gpu.flush();
  let reject;const submitted=new Promise((_resolve,no)=>{reject=no;});
  const done=a.retainUntilSubmitted(submitted);let settled=false;done.catch(()=>{settled=true;});
  a.release();reject(new Error('final consumer encoder discarded'));
  await tick();assert.equal(settled,false);assert(snapshot.isCurrent(),'queued prefix must still own the cut');
  f.gpu.finish();await assert.rejects(done,/discarded/);await drain(f.gpu);assert(!snapshot.isCurrent());
  await f.finish();
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
test('submitted classification lease preserves original f32 emission/UINT info and native XYZ Glow halo through replacement and queue completion',async()=>{
  const f=await fixture({size:[32,8,8]}),atlas=new WorldRenderAtlas(f.gpu,{worldSize:f.win.size,initialCapacity:4});
  const adapter=new WorldCellAtlasAdapter({gpu:f.gpu,source:f.source,producer:f.producer,atlas,tables:f.sim.tables,worldBounds:{min:[0,0,0],max:f.win.size}});await adapter.ready;
  const a=cut(f);adapter.bindCut(a);
  const bricks=[];for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<8;x++)bricks.push([x,y,z]);
  const batch=adapter.record(f.gpu.frame,{fieldTick:0,requirements:bricks});f.gpu.flush();adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();await drain(f.gpu);
  const capture=adapter.cache.get('0,0,0');
  for(const b of bricks){const i=brickIdOf(SOURCE_GRID,...b);f32(capture.classification).set([b[0]+.25,b[1]+.5,b[2]+.75,0],i*4);u32(capture.classification)[i*4+3]=0x8000;}
  const lease=adapter.acquireClassification({bricks}),metadata=lease.recordMetadata(f.gpu.frame);
  assert.throws(()=>lease.recordEmission(f.gpu.frame,{min:[0,0,0],size:[8,2,3]}),/region/);
  const emission=lease.recordEmission(f.gpu.frame,{min:[0,0,0],size:[8,2,2]});
  f.gpu.flush();await drain(f.gpu);
  for(let i=0;i<bricks.length;i++){
    assert.equal(u32(metadata)[i*4+3],0x8000);
    assert.deepEqual([...f32(emission.buffer).slice(i*4,i*4+4)],[bricks[i][0]+.25,bricks[i][1]+.5,bricks[i][2]+.75,0]);
  }
  const incomplete=adapter.acquireClassification({bricks:[[0,0,0]]});
  assert.throws(()=>incomplete.recordEmission(f.gpu.frame,{min:[0,0,0],size:[2,1,1]}),e=>e.requirements[0].index===1);incomplete.release();await drain(f.gpu);
  // Configuration replacement clears cache, but a queued lease owns its bytes
  // until final normal boundary and completion (not an earlier prefix).
  f.gpu.frame.copy(capture.classification,0,metadata,0,16);f.gpu.flush();
  f.gpu.frame.copy(capture.classification,16,metadata,16,16);
  const b=f.source.recordCut(f.gpu.frame,{sceneVersion:'scene',configVersion:2});adapter.bindCut(b);
  lease.release();await tick();assert(!capture.classification.destroyed);assert(!metadata.destroyed);
  assert.throws(()=>lease.recordMetadata(),/Released/);
  f.gpu.flush();await drain(f.gpu);await drain(f.gpu);
  assert(capture.classification.destroyed);assert(metadata.destroyed);a.release();b.release();adapter.dispose();atlas.dispose();await f.finish();
});
test('classification leases use the submitted manifest, never queued or aborted next-tick captures',async()=>{
  const f=await fixture({size:[32,8,8]}),atlas=new WorldRenderAtlas(f.gpu,{worldSize:f.win.size,initialCapacity:4});
  const adapter=new WorldCellAtlasAdapter({gpu:f.gpu,source:f.source,producer:f.producer,atlas,tables:f.sim.tables,worldBounds:{min:[0,0,0],max:f.win.size}});await adapter.ready;
  const a=cut(f);adapter.bindCut(a);const requirements=[[0,0,0]];
  const first=adapter.record(f.gpu.frame,{fieldTick:0,requirements});f.gpu.flush();adapter.commitAfterSourceFlush(first).previousLightingSnapshot.release();await drain(f.gpu);
  const installed=adapter.cache.get('0,0,0');u32(installed.classification).set([0x3f800000,0x40000000,0x40400000,0x8000]);
  const identity=adapter.publication.identity,expected=[...u32(installed.classification).slice(0,4)];
  const next=adapter.record(f.gpu.frame,{fieldTick:1,requirements}),queued=adapter.cache.get('0,0,0');assert.notEqual(queued,installed);
  const lease=adapter.acquireClassification({bricks:requirements});assert.equal(lease.publication.identity,identity);
  assert.equal(lease.records[0].buffer,installed.classification);assert.notEqual(lease.records[0].buffer,queued.classification);
  const metadata=lease.recordMetadata(f.gpu.frame);f.gpu.flush();adapter.abort(next);await drain(f.gpu);
  assert.deepEqual([...u32(metadata).slice(0,4)],expected);
  assert.throws(()=>adapter.acquireClassification({bricks:requirements}),e=>e.requirements?.[0].channels===READY.CELL);
  const retry=adapter.record(f.gpu.frame,{fieldTick:1,requirements});f.gpu.flush();adapter.commitAfterSourceFlush(retry).previousLightingSnapshot.release();await drain(f.gpu);
  const current=adapter.acquireClassification({bricks:requirements});assert.equal(current.records[0].buffer,adapter.cache.get('0,0,0').classification);
  current.release();lease.release();await drain(f.gpu);a.release();adapter.dispose();atlas.dispose();await f.finish();
});
test('a compatible unchanged capture stays available after its original Source cut closes',async()=>{
  const f=await fixture({size:[32,8,8]}),atlas=new WorldRenderAtlas(f.gpu,{worldSize:f.win.size,initialCapacity:4});
  const adapter=new WorldCellAtlasAdapter({gpu:f.gpu,source:f.source,producer:f.producer,atlas,tables:f.sim.tables,worldBounds:{min:[0,0,0],max:f.win.size}});await adapter.ready;
  const a=cut(f);adapter.bindCut(a);const requirements=[[0,0,0]];
  const first=adapter.record(f.gpu.frame,{fieldTick:0,requirements});f.gpu.flush();adapter.commitAfterSourceFlush(first).previousLightingSnapshot.release();await drain(f.gpu);
  const capture=adapter.cache.get('0,0,0'),b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});
  adapter.bindCut(b);a.release();assert.equal(capture.source.isCurrent(),false);
  const next=adapter.record(f.gpu.frame,{fieldTick:0,requirements});f.gpu.flush();adapter.commitAfterSourceFlush(next).previousLightingSnapshot.release();await drain(f.gpu);
  assert.equal(adapter.cache.get('0,0,0'),capture);assert(!capture.classification.destroyed);
  const lease=adapter.acquireClassification({bricks:requirements});assert.equal(lease.records[0].buffer,capture.classification);
  assert.equal(lease.publication.ownedCut.isValid(),true);lease.release();await drain(f.gpu);
  b.release();adapter.dispose();atlas.dispose();await f.finish();
});

// Retained-channel seam: real cuts, ledger, GI output handles and Atlas. The
// native fake below emulates ONLY existing transport stores, not lighting math.
import { createWorldLightingHistory, validateWorldLightingRestore } from '../src/world/worldLightingHistory.js';
import { createLightingTransport } from '../src/gfx/worldLightingBatch.js';
import { createWorldGI } from '../src/gfx/worldGI.js';
import { lightingFixture } from './world-gi-glow-fixture.mjs';
async function restoreFixture(){
  const f=await fixture({size:[64,128,64]}),l=lightingFixture(),M=[1,0,0],N=[2,0,0],records=[M,N].map(brick=>({brick,age:0,matter:true,near:false}));
  let current=cut(f),plan;
  const h=createWorldLightingHistory({worldSize:f.win.size,epoch:1,sourceOwner:f.source,configuration:current.configuration});
  const gi=createWorldGI(l.gpu,{g:l.g,feedbackProvider:l.feedbackProvider,readerBindingProvider:l.readerBindingProvider,snapshotProvider:{isCurrent:()=>current.isValid(),async acquire(args){
    const p=await l.snapshotProvider.acquire(args),previous=plan.capturePrevious({indices:args.probeIndices});
    return {...p,source:{sourceRevision:current.contentToken.sourceRevision,contentToken:current.contentToken},field:{...p.field,sourceRevision:current.contentToken.sourceRevision},previous,initialization:args.initialization,release(){previous.release();p.release();}};
  }}});
  async function produce(sourceBricks=plan.sourceBricks,gatherBricks=plan.gatherBricks){
    const c=await gi.prepare({lightingTick:plan.lightingTick,reset:plan.lightingTick===0,configVersion:plan.lightingTick+1,initialization:plan.initialization,sourceBricks,gatherBricks});
    const done=c.record();await l.complete();assert.equal((await done).status,'published');return gi.snapshot();
  }
  plan=h.begin({lightingTick:0,globalKey:[1],records,mode:2,initialization:{cutToken:current.contentToken,sourceBricks:[M,N],probeBricks:[M,N],records}});
  const initial=await produce();initial.bindings().source.words.set([11,12,13,14,21,22,23,24]);initial.bindings().history.words.set(Array.from({length:16},(_,i)=>0x34003400+i));
  plan.stage(initial).seal({cutToken:current.contentToken,feedback:{incomplete:false,requirements:[],sun:[]}}).commit();
  const atlas=new WorldRenderAtlas(f.gpu.device,{worldSize:f.win.size,initialCapacity:2,initialLightCapacity:4,initialProbeCapacity:4,epoch:1,retire:fn=>fn()});
  const transport=createLightingTransport(f.gpu.device,['source','gi']);await transport.ready;
  f.gpu._pack=groups=>{
    const input=b=>groups[0].entries.find(e=>e.binding===b).resource.buffer,p=u32(input(0)),data=new Uint8Array(input(1).bytes),out=groups[1].entries.map(e=>e.resource.texture);
    if(out.length===1)new Uint8Array(out[0].bytes).set(data.subarray(0,16),p[12]*16);
    else out.forEach((t,k)=>new Uint8Array(t.bytes).set(data.subarray(k*8,k*8+8),p[0]*8));
  };
  const advance=()=>{f.source.noteContentChange();const old=current;current=cut(f);old.release();return current;};
  const job=(bundle,b=M)=>{const s=bundle.leases.find(x=>x.kind==='source'&&x.index===b[0]),g=bundle.leases.find(x=>x.kind==='gi'&&x.index===b[0]);return atlas.allocateLight(b,{publication:bundle.publication,sourceRevision:current.contentToken.sourceRevision,sourceTick:s.token.lightingTick,giTick:g.token.lightingTick,readyBits:READY.GI_SOURCE|READY.GI,dependencies:{source:{id:s.token.dependencySetID,version:s.token.dependencyVersion},gi:{id:g.token.dependencySetID,version:g.token.dependencyVersion}}});};
  const write=async(bundle,jobs)=>{let settled=false,error;const promise=transport.restore(f.gpu,atlas,jobs.flatMap(job=>bundle.leases.filter(x=>x.index===job.brick[0]).map(lease=>({job,lease})))).then(()=>{settled=true;},e=>{settled=true;error=e;});for(let i=0;i<30&&!settled;i++){f.gpu.finish();await tick();}await promise;if(error)throw error;await drain(f.gpu);};
  return {...f,l,h,gi,atlas,transport,M,N,records,initial,produce,advance,job,write,get current(){return current;},set plan(p){plan=p;},get plan(){return plan;},async close(){initial.release();gi.dispose();h.dispose();atlas.dispose();current.release();await f.finish();}};
}

test('ledger restores R into R+1 without recomputation, then mixed compute generations with exact native ranges',async()=>{
  const f=await restoreFixture();try{
    const original=f.initial.token;f.advance();
    const bundle=f.h.captureRestore({cut:f.current,configVersion:2,sourceIndices:[1],probeIndices:[1]});
    const job=f.job(bundle);await drain(f.gpu);const flushes=f.gpu.flushes;
    f.source.noteContentChange();assert.equal(f.current.isValid(),true);assert.equal(f.current.isLatest(),false);
    await f.write(bundle,[job]);assert.equal(f.gpu.flushes,flushes+1);
    const sourceBinding=f.atlas.writerBindings(job,'source');
    assert.deepEqual([...new Uint32Array(sourceBinding.outputs[0].resource.texture.bytes,sourceBinding.params[12]*16,4)],[11,12,13,14]);
    assert.equal(f.initial.token,original);assert.equal(f.h.lightingTick,0);
    f.atlas.publish({lightJobs:[job],dependencyToken:{version:1,sets:[{id:7,version:1}]}});
    const first=f.atlas.snapshot(),manifest=first.lightingProvenance(f.M);
    assert.equal(manifest.source.computeToken,original);assert.equal(manifest.gi.computeToken,original);assert(Object.isFrozen(manifest.source));assert.equal(manifest.source.publication.meaning,'current-cut-validation');
    assert.equal(job.sourceTick,0);assert.equal(job.sourceRevision,bundle.publication.sourceRevision);
    bundle.release();
    // Ordinary changing-light config2 retains mature GI from config1, while
    // SOURCE is selected at tick1. This is temporal input, not incompatible schema.
    f.advance();f.plan=f.h.begin({lightingTick:1,globalKey:[2],records:f.records});
    f.l.state.current=2;const output=await f.produce();f.plan.commit(output);output.release();
    const mixed=f.h.captureRestore({cut:f.current,configVersion:3,sourceIndices:[1],probeIndices:[1]});
    const next=f.job(mixed);assert.equal(next.sourceTick,1);assert.equal(next.giTick,0);
    const gi=mixed.leases.find(x=>x.kind==='gi');assert.deepEqual(gi.bindings().ranges.map(x=>x.from),[0,16,32,48]);
    const expected=gi.bindings().ranges.flatMap(x=>[...new Uint8Array(gi.bindings().buffer.bytes).slice(x.from,x.from+x.size)]);
    await f.write(mixed,[next]);
    const params=f.atlas.writerBindings(next,'gi').params,views=f.atlas.writerBindings(next,'gi').outputs;
    assert.deepEqual(views.flatMap(e=>[...new Uint8Array(e.resource.texture.bytes).slice(params[0]*8,params[0]*8+8)]),expected);
    f.atlas.publish({lightJobs:[next],dependencyToken:{version:2,sets:[{id:7,version:2}]}});const now=f.atlas.snapshot();
    assert.equal(now.lightingProvenance(f.M).source.computeToken.lightingTick,1);assert.equal(now.lightingProvenance(f.M).gi.computeToken,original);
    assert.equal(first.lightingProvenance(f.M),manifest);now.release();first.release();mixed.release();
    await assert.rejects(f.initial.writeAtlas(f.atlas,next,'source'),/provenance mismatch/);
  }finally{await f.close();}
});

test('authentic cut/lease rejection, private staged SOURCE plus previous GI, failed transport never adopts',async()=>{
  const f=await restoreFixture();try{
    f.advance();
    const args={cut:f.current,configVersion:2,sourceIndices:[1,2],probeIndices:[1,2]};
    assert.throws(()=>f.h.captureRestore({...args,cut:{...f.current}}),/owned Source cut/);
    const foreign=await fixture({size:[64,128,64]}),foreignCut=cut(foreign);
    assert.throws(()=>f.h.captureRestore({...args,cut:foreignCut}),/owned Source cut/);foreignCut.release();await foreign.finish();
    const released=f.current.retain();released.release();assert.throws(()=>f.h.captureRestore({...args,cut:released}),/owned Source cut/);
    const bundle=f.h.captureRestore(args),lease=bundle.leases[0];
    assert.throws(()=>validateWorldLightingRestore({...lease}),/restore lease/);
    const bad=f.atlas.allocateLight(f.M,{publication:bundle.publication,sourceRevision:args.cut.contentToken.sourceRevision,sourceTick:lease.token.lightingTick,readyBits:READY.GI,dependencies:{source:{id:lease.token.dependencySetID,version:lease.token.dependencyVersion}}});
    assert.throws(()=>validateWorldLightingRestore(lease,{job:{...bad,publication:{...bundle.publication}}}),/provenance mismatch/);
    await assert.rejects(f.transport.restore(f.gpu,f.atlas,[{job:bad,lease}]),/provenance mismatch|readiness/);f.atlas.cancel(bad);
    bundle.release();assert.throws(()=>validateWorldLightingRestore(lease),/restore lease/);
    f.plan=f.h.begin({lightingTick:1,globalKey:[2],records:f.records});
    const source=await f.produce(f.plan.sourceBricks,[]);f.plan.stage(source);source.release();
    const staged=f.plan.captureRestore({...args,sourcePhase:true});
    const jobs=[f.job(staged,f.M),f.job(staged,f.N)],old=f.atlas.snapshot(),generation=f.atlas.generation;
    await f.write(staged,jobs);
    assert.throws(()=>f.atlas.prepareProducerSnapshot({lightJobs:[jobs[0]],sourcePhaseToken:staged.publication.sourcePhaseToken}),/omits/);
    const privateBook=f.atlas.prepareProducerSnapshot({lightJobs:jobs,sourcePhaseToken:staged.publication.sourcePhaseToken});
    assert.equal(f.atlas.generation,generation);assert.equal(f.h.lightingTick,0);assert.equal(privateBook.lightingProvenance(f.M).source.computeToken.lightingTick,1);assert.equal(privateBook.lightingProvenance(f.M).gi.computeToken.lightingTick,0);
    assert.throws(()=>privateBook.bindings(),/producer-only/);
    assert.throws(()=>f.atlas.publish({lightJobs:jobs}),/private SOURCE/);
    const fb=f.gpu.createBuffer({size:f.atlas.feedbackBytes});assert.equal(f.atlas.producerBindings(old,privateBook,Object.fromEntries(['sunDepth','sunOptical','mediaNoise','sourceAppearance','packedMesh'].map(k=>[k,{}])),fb)[0][2].resource.buffer,privateBook.lightBook);
    privateBook.release();old.release();jobs.forEach(j=>f.atlas.cancel(j));staged.release();f.plan.abort();
    const retained=f.h.captureRestore(args),pending=f.job(retained),snapshot=f.atlas.snapshot();let count=0;
    const record=f.atlas.recordLightWrite.bind(f.atlas);f.atlas.recordLightWrite=(...a)=>{if(++count===2)throw new Error('partial restore');return record(...a);};
    await assert.rejects(f.write(retained,[pending]),/partial restore/);
    assert.throws(()=>f.atlas.publish({lightJobs:[pending]}),/partial page/);assert.equal(f.h.lightingTick,0);assert.equal(f.atlas.generation,generation);assert.equal(snapshot.generation,generation);
    f.atlas.cancel(pending);snapshot.release();retained.release();
    const wrong=f.source.recordCut(f.gpu.frame,{sceneVersion:'scene',configVersion:99});assert.throws(()=>f.h.captureRestore({...args,cut:wrong}),/owned Source cut/);wrong.release();
    assert.throws(()=>f.h.captureRestore(args),/owned Source cut/);
  }finally{await f.close();}
});

test('wrong epoch/reset proofs reject and failed recordable suffix retains native pins until final queue closure',async()=>{
  const f=await restoreFixture();try{
    f.advance();
    const args={cut:f.current,configVersion:2,sourceIndices:[1],probeIndices:[1]};
    const other=createWorldLightingHistory({worldSize:f.win.size,epoch:2,sourceOwner:f.source,configuration:f.current.configuration});
    assert.throws(()=>other.captureRestore(args),/owned Source cut/);other.dispose();
    const bundle=f.h.captureRestore(args),job=f.job(bundle),native=f.initial.bindings().source;
    await drain(f.gpu);
    const flush=f.gpu.flush.bind(f.gpu);f.gpu.flush=()=>{throw new Error('recordable suffix failure');};
    await assert.rejects(f.transport.restore(f.gpu,f.atlas,bundle.leases.map(lease=>({job,lease}))),/recordable suffix failure/);
    assert.equal(f.gpu.frame.open,true);assert.equal(f.h.lightingTick,0);assert.throws(()=>f.atlas.publish({lightJobs:[job]}),/partial page/);
    f.source.reset();assert.throws(()=>validateWorldLightingRestore(bundle.leases[0]),/owned Source cut/);
    bundle.release();f.initial.release();f.h.dispose();f.gi.dispose();
    assert.equal(native.dead,false,'in-flight native source remains pinned after ledger/output disposal');
    f.gpu.flush=flush;await drain(f.gpu);await tick();
    assert.equal(native.dead,true,'pins retire only after recordable suffix and final queue close');f.atlas.cancel(job);
  }finally{await f.close();}
});
