// Actual owner + Source/Cut/Fields/CELL/Atlas/history/GI/Sun/Glow/records.
// Delayed native transport. Lighting kernel MATH is intentionally mocked;
// WGSL leaf arithmetic remains covered by the existing union checks.
import test from 'node:test';
import { Matrix4, Vector3 } from 'three';
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { fixture, drain } from './world-lighting-records-fixture.mjs';
import { installWorldRender, worldClassifyBatches } from '../src/wire/worldRender.js';
import { READY, bookPage } from '../src/world/renderAtlas.js';
import { tableLayout } from '../src/shaders/common.js';
import { worldGISource, worldGIBirthWGSL } from '../src/shaders/worldGI.js';
import { selectWorldGI } from '../src/world/worldLightingHistory.js';
const words=b=>new Uint32Array(b.bytes),bytes=b=>new Uint8Array(b.bytes);
class Exec extends WgslExec {_dispatchWorkgroup(fn,id,c){for(const a of fn.node.attributes??[])if(a.name==='workgroup_size'&&typeof a.value==='string')a.value=[a.value];return super._dispatchWorkgroup(fn,id,c);}}
const tick=()=>new Promise(r=>setTimeout(r,0));
// Execute the actual SOURCE early exits and self-read leaf. Classification,
// packing and lighting math remain synthetic; no native shader execution.
const sourceCode=worldGISource({nx:16,ny:8,nz:8});
function body(code,name){const start=code.indexOf(`fn ${name}(`);let end=code.indexOf('{',start),depth=1;while(depth&&++end<code.length){if(code[end]==='{')depth++;if(code[end]==='}')depth--;}return code.slice(start,end+1);}
function selfMiss(kind,flags){
  const air=sourceCode.slice(sourceCode.indexOf('  if (!brickMatter(brickOcc(bc)))'),sourceCode.indexOf('  let l = vec3i'));
  const media=sourceCode.slice(sourceCode.indexOf('  let m = vec2u(head'),sourceCode.indexOf('  var rad = vec3f'));
  assert(air&&media,'production SOURCE classification leaves');
  const code=`${worldGIBirthWGSL}
struct Probe{a:vec4f,b:vec4f,c:vec4f,d:vec4f}
const WORLD_GI:u32=16u;const tGI0:u32=0u;const tGI1:u32=1u;const tGI2:u32=2u;const tGI3:u32=3u;
const BS:i32=4;const BRICK_CELLS:u32=64u;const FACE_CELLS:u32=16u;
@group(0)@binding(0)var<storage,read>worldGIJobs:array<vec4u>;
@group(0)@binding(1)var<storage,read_write>worldGISources:array<vec4u>;
@group(0)@binding(2)var<storage,read_write>miss:array<u32>;
fn worldProbeLoad(band:u32,bc:vec3i,channel:u32)->vec4f{miss[0]=channel;return vec4f(0.0);}
fn brickOcc(bc:vec3i)->u32{return ${kind==='air'?'0':'1'}u;}
fn brickMatter(occ:u32)->bool{return occ!=0u;}
fn giSrcPack(a:vec3f,b:vec3f,c:vec3f)->vec4u{return vec4u(0u);}
fn worldGIReport(job:u32){}
${body(sourceCode,'worldGIPreviousProbe')}
@compute@workgroup_size(1)fn main(){let job=0u;let li=0u;let bc=vec3i(0);${air}
let head=array<u32,7>(${kind==='opaque'?'1':'0'}u,0u,0u,0u,0u,0u,${kind==='crystal'?'1':'0'}u);${media}}
`;
  const miss=new Uint32Array(1);
  new Exec(new WgslParser().parse(code)).dispatchWorkgroups('main',1,{0:{0:new Uint32Array([0,flags,0,0]),1:new Uint32Array(4),2:miss}});
  return miss[0]===READY.GI;
}
async function settle(gpu,promise){let done=false,error,result;promise.then(r=>{done=true;result=r;},e=>{done=true;error=e;});for(let i=0;i<2000&&!done;i++){gpu.finish();await tick();}assert(done,'native final boundary failed to settle');if(error)throw error;return result;}
export async function setup({size=[16,8,8],feedback=true,sourceKinds=null,ground=null,ownerOptions={}}={}) {
  const f=await fixture({size}),gpu=f.gpu,events=[],sources=[],histories=[],tablesUsed=[],giJobs=[];
  const tableBuffer=gpu.createBuffer({label:'real fixture tables',size:tableLayout().Tables.size,usage:128|4|8});
  const tableGroup=gpu.bindGroup(f.sim.L.TABLES,[{binding:0,resource:{buffer:tableBuffer}}],'fixture TABLES');
  f.sim.tables=tableGroup;gpu._simTables={buffer:tableBuffer,group:tableGroup};
  gpu.onDispatch=(_kernel,options)=>assert(options.bind?.[0]?.entries?.[0]?.resource.buffer.bytes instanceof ArrayBuffer,'normal kernels require TABLES bind group');
  const makeGroup=gpu.device.createBindGroup;
  gpu.device.createBindGroup=d=>{
    for(const entry of d.entries)if(entry.resource?.buffer)assert(entry.resource.buffer.bytes instanceof ArrayBuffer,'native binding requires a GPUBuffer, never a GPUBindGroup');
    return makeGroup(d);
  };
  gpu.device.createSampler=d=>d;
  gpu.device.createBuffer=d=>{const b=gpu.createBuffer(d);b.mapAsync=()=>gpu.queue.onSubmittedWorkDone();return b;};
  const original=gpu.encoder.bind(gpu);let owner;
  function dispatch(pipe,groups,n,push){
    const label=pipe.label??'',buf=(g,b)=>groups[g].entries.find(e=>e.binding===b).resource.buffer;
    if(['world GI source','world GI gather','full world optical sun'].includes(label))tablesUsed.push(buf(0,0));
    if(label.startsWith('world lighting delta'))return push(()=>new Exec(new WgslParser().parse(pipe.compute.module.code)).dispatchWorkgroups('main',[n,1,1],{0:Object.fromEntries(groups[0].entries.map(e=>[e.binding,e.resource.buffer.bytes]))}));
    if(label==='world CELL raw/AUX pack')return push(()=>gpu._pack(groups));
    if(label==='world CELL field pack')return push(()=>gpu._packFields(groups,n));
    if(label==='world GI source'||label==='world GI gather')return push(()=>{
      if(label==='world GI gather'){
        assert.deepEqual(groups[3].entries.map(e=>e.binding).sort((a,b)=>a-b),[0,1,2,3,4,5,6,7,8,9,10]);
        assert.doesNotMatch(pipe.compute.module.code,/worldGI[0-3]Out/);
      }
      if(sourceKinds&&label==='world GI gather')assert.match(pipe.compute.module.code,/const GI_RAYS: i32 = 32;/);
      events.push(label);const p=words(buf(3,7)),jobs=words(buf(3,8)),out=words(buf(3,9)),fb=words(buf(3,1)),sun=words(buf(3,5)),book=words(buf(0,5));
      const start=label==='world GI source'?0:p[0],count=label==='world GI source'?p[0]:p[1];
      let missing=false;
      if(feedback&&label==='world GI source'&&!sun[6]){fb[owner.atlas.bookLayout.sunWord]|=1;missing=true;events.push('unknown Sun');}
      if(feedback&&label==='world GI gather'&&!book[1]){const plane=owner.atlas.bookLayout.requestBytes/4/6;fb[plane*3]|=2;missing=true;events.push('unknown SOURCE');}
      for(let i=0;i<count;i++){
        const job=start+i,id=jobs[4*job],flags=jobs[4*job+1];let selfMissing=false;
        if(label==='world GI source'&&sourceKinds&&selfMiss(sourceKinds[id]??'air',flags)){
          const plane=owner.atlas.bookLayout.requestBytes/4/6;
          fb[plane*4+(id>>>5)]|=1<<(id&31);selfMissing=true;events.push('typed GI self-miss');
        }
        giJobs.push({phase:label,index:id,flags,tick:p[3]});
        fb[p[2]+job]=missing||selfMissing?3:1;if(label==='world GI source')out.set([id,p[3],101,202],i*4);
      }
      if(label==='world GI source')sources.push([...out]);else{const h=words(buf(3,10));histories.push([...h]);for(let i=0;i<h.length;i++)h[i]++;}
    });
    if(label==='full world optical sun')return push(()=>{
      events.push(label);const fb=words(buf(3,1)),job=words(buf(2,0)),book=words(buf(0,4));let missing=false;
      if(feedback&&!book[3]){fb[0]|=8;missing=true;events.push('unknown CELL');}fb[job[5]]=missing?3:1;
    });
    if(label==='world glow float'||label==='world glow half')return push(()=>{
      events.push(label);const p=words(buf(0,0));words(buf(0,3))[p[20]]=1;
      // Lighting math is synthetic, but final storage matches the real shader:
      // Five f32 intermediates; the final pass writes only outGlow.
      const values=label==='world glow float'?new Float32Array(buf(0,2).bytes):null;
      const half=label==='world glow half'?new Uint16Array(groups[0].entries.find(e=>e.binding===4).resource.texture.bytes):null;
      for(let i=0;i<p[15];i++){values?.set([0,0,0,1],i*4);half?.set([0,0,0,0x3c00],i*4);}
    });
    throw new Error(`unmocked native pipeline ${label}`);
  }
  gpu.encoder=(label,frame=false)=>{const e=original(label,frame),push=fn=>frame?gpu._push(fn):e.ops.push(fn);e.clearBuffer=(b,o=0,n=b.size-o)=>push(()=>bytes(b).fill(0,o,o+n));e.beginComputePass=()=>{let pipe;const groups=[];return {setPipeline:p=>pipe=p,setBindGroup:(i,g)=>groups[i]=g,dispatchWorkgroups:n=>dispatch(pipe,[...groups],n,push),end(){}};};return e;};
  gpu.frame._command=()=>{};gpu.frame._commandDone=()=>{};
  gpu.frame.compute=()=>{let pipe;const groups=[];return {setPipeline:p=>pipe=p,setBindGroup:(i,g)=>groups[i]=g,dispatchWorkgroups:n=>dispatch(pipe,groups,n,fn=>gpu._push(fn))};};
  // A ground twin (world/scenes/index.js ground) turns on the sun-caster forecast.
  if(ground)f.win.scene.ground=ground;
  owner=installWorldRender(f.win,ownerOptions);
  const frame={sceneVersion:'scene',schemaVersion:1,configVersion:1,values:{cam:[0,0,0]},physicsOrigin:[0,0,0],globalKey:[1],sun:{direction:[1,1,1],basisRevision:1},external:Object.fromEntries(['mediaNoise','packedMesh','sourceAppearance'].map(name=>[name,{name}]))};
  return {...f,owner,events,sources,histories,tablesUsed,giJobs,frame,async close(){await settle(gpu,owner.dispose());await f.finish();}};
}
const complete={incomplete:false,requirements:[],sun:[]};
function post(candidate,confirmation=Promise.resolve(true)){const feedbackIdentity={};return {feedbackIdentity,postTicket:{identity:candidate.identity,publication:candidate,feedbackIdentity,status:'committed',confirmation},feedback:complete};}

test('mode2 keeps SOURCE/data dependencies without invented probes; typed air GI still births',async()=>{
  const f=await setup({feedback:false,sourceKinds:{0:'air',1:'liquid'}});
  const pending=f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE},{brick:[1,0,0],channels:READY.GI_SOURCE},{brick:[2,0,0],channels:READY.CELL}]);
  const progress=f.owner.progress;
  assert(Object.isFrozen(progress));assert.equal(progress.stage,'initializing');assert.equal(progress.requirements,3);
  let c=await settle(f.gpu,pending);
  assert.equal(f.owner.progress.stage,'probe-ready');assert.equal(progress.stage,'initializing');
  assert.equal(f.giJobs.filter(j=>j.phase==='world GI gather').length,0);
  assert(f.giJobs.some(j=>j.index===0&&j.phase==='world GI source'));
  assert(f.giJobs.some(j=>j.index===1&&j.phase==='world GI source'));
  assert(f.owner.cells.acquireClassification({bricks:[[2,0,0]]}).release()===undefined);
  assert.equal(f.owner.atlas.lookup([0,0,0],READY.GI_SOURCE).known,true);
  assert.equal(f.owner.atlas.lookup([0,0,0],READY.GI).known,false);
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();assert.equal(f.owner.progress,null);
  const at=f.giJobs.length;
  c=await settle(f.gpu,f.owner.request({...f.frame,advance:false},[{brick:[0,0,0],channels:READY.GI}]));
  const gathers=f.giJobs.slice(at).filter(j=>j.phase==='world GI gather');
  assert.deepEqual(gathers.map(j=>j.index),[0]);assert(gathers.every(j=>(j.flags&2)!==0));
  assert(f.histories.at(-1).every(n=>n===0),'authenticated birth previous is packed zero');
  await settle(f.gpu,f.owner.accept(c,post(c)));assert.equal(f.owner.metadata.derivedTick,0);
  c.release();await f.close();
});

for(const kind of ['opaque','crystal'])test(`${kind} SOURCE actual self-read feedback requires full birth before admission`,async()=>{
  const f=await setup({feedback:false,sourceKinds:{0:kind}});
  const c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE}]));
  assert(f.events.includes('typed GI self-miss'));
  const gathers=f.giJobs.filter(j=>j.phase==='world GI gather');assert.deepEqual(gathers.map(j=>j.index),[0]);
  assert.equal(gathers[0].flags&2,2);assert.equal(f.owner.atlas.lookup([0,0,0],READY.GI).known,true);
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();await f.close();
});

test('same-clock SOURCE-only augmentation retains exact bytes/tokens and native previous generation; mature offscreen owner never rebirths',async()=>{
  const f=await setup({feedback:false,sourceKinds:{0:'air',1:'liquid',2:'air'}});
  let c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]));
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
  f.source.noteContentChange();
  c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[1,0,0],channels:READY.GI_SOURCE}]));
  await settle(f.gpu,f.owner.accept(c,post(c)));
  c.release();
  c=await settle(f.gpu,f.owner.request({...f.frame,advance:false},[{brick:[1,0,0],channels:READY.CELL}]));
  await settle(f.gpu,f.owner.accept(c,post(c)));
  const known=c.snapshot.lightingProvenance([0,0,0]),source=known.source;
  const before=[...words(source.nativeBuffer).subarray(source.ranges[0].from/4,source.ranges[0].from/4+4)];
  const at=f.giJobs.length;
  const augmented=await settle(f.gpu,f.owner.request({...f.frame,advance:false},[{brick:[2,0,0],channels:READY.GI_SOURCE}]));
  const retained=augmented.snapshot.lightingProvenance([0,0,0]).source;
  assert.equal(retained.computeToken,source.computeToken);
  assert.deepEqual([...words(retained.nativeBuffer).subarray(retained.ranges[0].from/4,retained.ranges[0].from/4+4)],before);
  assert(f.giJobs.slice(at).every(j=>j.phase==='world GI source'&&(j.flags&2)===0));
  assert.equal(augmented.lightingTick,1);assert.equal(f.owner.metadata.records([0])[0].age,1);
  await settle(f.gpu,f.owner.accept(augmented,post(augmented)));c.release();augmented.release();
  const retainedNew=await settle(f.gpu,f.owner.request({...f.frame,advance:false},[{brick:[2,0,0],channels:READY.CELL}]));
  const newSource=retainedNew.snapshot.lightingProvenance([2,0,0]).source;
  assert.equal(newSource.previousHistoryToken,source.previousHistoryToken);
  assert.equal(newSource.computeToken.previousToken.lightingTick,0);
  await settle(f.gpu,f.owner.accept(retainedNew,post(retainedNew)));retainedNew.release();
  f.source.noteContentChange();const nextAt=f.giJobs.length;
  const next=await settle(f.gpu,f.owner.request(f.frame,[{brick:[2,0,0],channels:READY.CELL}]));
  assert(f.giJobs.slice(nextAt).filter(j=>j.index===0).every(j=>(j.flags&2)===0));
  assert.equal(next.snapshot.lightingProvenance([0,0,0]).gi.computeToken,known.gi.computeToken);
  assert.equal(f.owner.metadata.records([0])[0].age,1,'pending records are not adopted early');
  await settle(f.gpu,f.owner.accept(next,post(next)));assert.equal(f.owner.metadata.records([0])[0].age,2);
  next.release();await f.close();
});

test('optional probe eligibility changes only gathers across reset, settling and ordinary cadence',()=>{
  const records=[{brick:[0,0,0],age:40,matter:true,near:false},{brick:[1,0,0],age:0,matter:false,near:true}];
  for(const mode of [0,1,2])for(const settle of [0,1])for(let lightingTick=0;lightingTick<8;lightingTick++){
    const options={records,mode,settle,lightingTick},original=selectWorldGI(options);
    const filtered=selectWorldGI({...options,records:records.map((r,i)=>({...r,probeEligible:i===0}))});
    assert.deepEqual(filtered.sourceBricks,original.sourceBricks);
    assert.deepEqual(filtered.gatherBricks,original.gatherBricks.filter(r=>r.brick[0]===0));
  }
});

test('actual boot resolves UNKNOWN Sun, actual CELL and source closure; acceptance adopts metadata once',async()=>{
  const f=await setup();const demand=[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}];
  const initial=await settle(f.gpu,f.owner.request(f.frame,demand));
  const candidate=await settle(f.gpu,f.owner.extend(initial,{incomplete:true,requirements:[{brick:[0,0,0],channels:READY.GLOW}],sun:[]}));initial.release();
  assert.equal(f.owner.state,'probe-ready');assert.equal(f.owner.current(),null);assert.equal(f.owner.metadata.derivedTick,-1);
  assert(f.events.includes('unknown Sun'));assert(f.events.includes('unknown CELL'));assert(f.events.includes('unknown SOURCE'));
  assert(candidate.tables);assert.notEqual(candidate.tables.buffer,f.gpu._simTables.buffer);
  assert(f.tablesUsed.length);assert(f.tablesUsed.every(b=>b===candidate.tables.buffer));
  assert.equal(f.owner.cells.tables,candidate.tables.group);
  assert.equal(candidate.sunTextures.sun0,candidate.lighting.sun0.texture);
  assert.equal(candidate.sunTextures.sun1,candidate.lighting.sun1.texture);
  assert.equal(candidate.cut.sourceRevision,f.source.contentToken().sourceRevision);
  assert(f.events.filter(x=>x.startsWith('world glow ')).length===6,'actual six passes');
  assert(await settle(f.gpu,f.owner.accept(candidate,post(candidate))));
  assert.equal(f.owner.metadata.derivedTick,0);assert(f.owner.metadata.indices.includes(3));
  await assert.rejects(f.owner.accept(candidate,post(candidate)),/exact complete/);
  const current=f.owner.current();assert.equal(current.identity,candidate.identity);current.release();candidate.release();await f.close();
});

test('native table buffers and normal kernel TABLES groups are distinct required inputs',async()=>{
 const f=await fixture();try{
  const buffer=f.gpu.createBuffer({size:tableLayout().Tables.size,usage:128});
  f.sim.tables=f.gpu.bindGroup(f.sim.L.TABLES,[{binding:0,resource:{buffer}}],'TABLES');
  assert.throws(()=>installWorldRender(f.win,{tableBuffer:f.sim.tables}),/distinct TABLES/);
  assert.throws(()=>installWorldRender(f.win,{tables:buffer,tableBuffer:buffer}),/distinct TABLES/);
  assert.throws(()=>installWorldRender(f.win),/distinct TABLES/);
  assert.equal(f.win.render,undefined);
 }finally{await f.finish();}
});

test('concurrent discard cannot clear the replacement queued cut or leak its external pin',async()=>{
 const f=await setup({feedback:false});let pins=0;
 const pin={retain(){pins++;return {release(){pins--;}};}};
 const demand=[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}];
 const first=await settle(f.gpu,f.owner.request(f.frame,demand));
 const queued=f.owner.request({...f.frame,pins:[pin]},demand);
 const retiring=f.owner.discard(first);
 const duplicate=assert.rejects(f.owner.discard(first),/foreign WORLD discard/);
 await settle(f.gpu,retiring);await duplicate;
 const next=await settle(f.gpu,queued);
 assert(next);assert.equal(f.owner.state,'probe-ready');assert.equal(pins,1);
 await settle(f.gpu,f.owner.discard(next));next.release();first.release();
 await f.close();assert.equal(pins,0);
});

test('retry reserves its transition before awaiting native prefix completion',async()=>{
 const f=await setup({feedback:false}),flush=f.gpu.flush.bind(f.gpu);let reject=true;
 f.gpu.flush=label=>{flush();if(reject&&label==='world final feedback boundary'){reject=false;throw new Error('closed suffix');}};
 await assert.rejects(settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}])),/closed suffix/);
 const retry=f.owner.retry();
 const duplicate=assert.rejects(f.owner.retry(),/only definitively rejected/);
 const c=await settle(f.gpu,retry);await duplicate;
 assert.equal(f.owner.state,'probe-ready');assert.equal(f.owner.failure,null);
 await settle(f.gpu,f.owner.discard(c));c.release();await f.close();
});

test('ordinary newer physics coalesces, rejected submitted image preserves accepted bundle and exact previous packed GI',async()=>{
  const f=await setup({feedback:false});let first=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]));
  await settle(f.gpu,f.owner.accept(first,post(first)));const previous=f.owner.current();
  f.source.noteContentChange();f.sim.version++;
  const nextPromise=f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]);
  f.source.noteContentChange();f.sim.version++;
  const queued=f.owner.request(f.frame,[{brick:[1,0,0],channels:READY.GI_SOURCE|READY.GI}]);
  const next=await settle(f.gpu,nextPromise);assert(next.cut.sourceRevision<f.source.contentToken().sourceRevision,'frozen older cut survives newer ordinary physics');
  assert(f.histories.some(a=>a.some(n=>n===1)),'known exact packed previous bands copied, not reset');
  assert.equal(await f.owner.accept(next,post(next,Promise.resolve(false))),false);
  let current=f.owner.current();assert.equal(current.identity,previous.identity);current.release();
  await settle(f.gpu,f.owner.discard(next));const queuedCandidate=await settle(f.gpu,queued);assert(queuedCandidate.cut.sourceRevision>next.cut.sourceRevision);assert.equal(next.logicalFieldTick,1);assert.equal(queuedCandidate.logicalFieldTick,2);assert.equal(queuedCandidate.lightingTick,1);assert([...f.owner.cells.fields.history.owners.values()].every(o=>o.lastTick===2),'all offscreen unsettled EMA owners advance without skipping');
  await settle(f.gpu,f.owner.discard(queuedCandidate));queuedCandidate.release();next.release();previous.release();first.release();await f.close();
});

test('scene feedback extends the same cut/clock, out-of-order identities reject; camera-only birth does not age known records',async()=>{
  const f=await setup({feedback:false});let c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]));
  // the restart packs only the CELL pages it lacks, not the ones this cut and clock just published
  const before=new Set(f.owner.atlas.bookPages('cell').map(p=>p.brick.join(','))),allocated=[],allocate=f.owner.atlas.allocate.bind(f.owner.atlas);
  f.owner.atlas.allocate=(b,v)=>{allocated.push(b.join(','));return allocate(b,v);};
  const cut=c.cut;const extended=await settle(f.gpu,f.owner.extend(c,{incomplete:true,requirements:[{index:1,brick:[1,0,0],channels:READY.GI_SOURCE|READY.GI}],sun:[]}));
  f.owner.atlas.allocate=allocate;assert(before.size>0);assert(allocated.every(k=>!before.has(k)),'a restart re-packed a current CELL page');
  assert.equal(extended.cut,cut);assert.equal(extended.logicalFieldTick,c.logicalFieldTick);assert.notEqual(extended.identity,c.identity);await assert.rejects(f.owner.extend(c,complete),/out-of-order/);
  await settle(f.gpu,f.owner.accept(extended,post(extended)));assert.equal(f.owner.metadata.derivedTick,0);
  const birth=await settle(f.gpu,f.owner.request({...f.frame,advance:false},[{brick:[2,0,0],channels:READY.GI_SOURCE|READY.GI}]));assert.equal(birth.cut,cut);assert.equal(birth.logicalFieldTick,extended.logicalFieldTick);
  await settle(f.gpu,f.owner.accept(birth,post(birth)));assert.equal(f.owner.metadata.derivedTick,0);assert.equal(f.owner.metadata.records([0])[0].age,0);
  c.release();extended.release();birth.release();await f.close();
});

test('closed final-prefix rejection retries original cut and clock; reset rejects late Post without adopting records',async()=>{
  const f=await setup({feedback:false}),original=f.gpu.flush.bind(f.gpu);let reject=true;
  f.gpu.flush=label=>{original();if(reject&&label==='world final feedback boundary'){reject=false;throw new Error('definite final suffix rejection');}};
  await assert.rejects(settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}])),/definite final suffix/);
  assert.equal(f.owner.state,'rejected');assert.equal(f.owner.metadata.derivedTick,-1);
  f.gpu.flush=original;const c=await settle(f.gpu,f.owner.retry());assert.equal(c.logicalFieldTick,0);assert.equal(c.lightingTick,0);
  let confirm;const pending=new Promise(r=>confirm=r),accepting=f.owner.accept(c,post(c,pending));assert.equal(f.owner.state,'accepting');
  await assert.rejects(f.owner.extend(c,complete),/out-of-order/);
  f.source.reset();await settle(f.gpu,f.owner.reset({sceneVersion:'scene',schemaVersion:1}));confirm(true);assert.equal(await accepting,false);
  assert.equal(f.owner.metadata.derivedTick,-1);assert.equal(f.owner.current(),null);
  c.release();const next=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]));assert.equal(next.identity.epoch,2);assert.equal(next.logicalFieldTick,0);await settle(f.gpu,f.owner.discard(next));next.release();await f.close();
});

test('actual owner captures original 384-height boundary and pins external resources until last image handle',async()=>{
  const f=await setup({size:[16,384,8],feedback:false});let pins=0;
  const pin={retain(){pins++;let live=true;return {release(){if(live){live=false;pins--;}}};}};
  const c=await settle(f.gpu,f.owner.request({...f.frame,pins:[pin]},[{brick:[0,95,0],channels:READY.GI_SOURCE|READY.GI}]));
  assert.equal(c.snapshot.producerOnly,false);assert.equal(f.owner.metadata.derivedTick,-1);assert(f.owner.cells.acquireClassification({bricks:[[0,95,0]]}).release()===undefined);
  await settle(f.gpu,f.owner.accept(c,post(c)));assert.equal(pins,1);assert(f.owner.metadata.indices.includes(380));
  await settle(f.gpu,f.owner.dispose());assert.equal(pins,1,'retained last image handle owns native external pins');c.release();assert.equal(pins,0);await f.finish();
});

test('two actual SOURCE core slabs precede ANY gather; retained GI crosses R+1 with original mixed compute tokens',async()=>{
  // A one-job bound: each core is its own slab (WORLD_GI_SLAB_JOBS packs both into one).
  const f=await setup({size:[48,8,8],feedback:false,ownerOptions:{giSlabJobs:1}});const demand=[0,8].map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE|READY.GI}));
  let c=await settle(f.gpu,f.owner.request(f.frame,demand));
  const phases=f.events.filter(x=>x==='world GI source'||x==='world GI gather');assert.deepEqual(phases,['world GI source','world GI source','world GI gather','world GI gather']);
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
  for(let i=1;i<=2;i++){f.source.noteContentChange();c=await settle(f.gpu,f.owner.request(f.frame,demand));await settle(f.gpu,f.owner.accept(c,post(c)));if(i===1)c.release();}
  const proof=c.snapshot.lightingProvenance([0,0,0]).gi;assert.equal(proof.computeToken.lightingTick,1);assert(proof.computeToken.sourceRevision<c.cut.sourceRevision);assert.equal(proof.publication.sourceRevision,c.cut.sourceRevision);
  const pid=bookPage(f.owner.atlas.lightEntries[0]),page=f.owner.atlas.light.pages.get(pid);assert.equal(page.sourceTick,2);assert.equal(page.giTick,1);assert(f.owner.metadata.indices.includes(8),'offscreen ownership retained across cuts');
  c.release();await f.close();
});

test('unknown recordable metadata suffix blocks owner admission and never advertises false retirement',async()=>{
  const f=await setup({feedback:false}),original=f.gpu.flush.bind(f.gpu);let blocked=false;
  f.gpu.flush=label=>{if(label==='world final feedback boundary'){blocked=true;throw new Error('unknown recordable suffix');}original();};
  const work=f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]);let settled=false;work.then(()=>settled=true,()=>settled=true);
  for(let i=0;i<100&&!blocked;i++){f.gpu.finish();await tick();}
  assert(blocked);assert.equal(f.owner.state,'blocked');assert.equal(settled,false);assert.equal(f.owner.metadata.derivedTick,-1);assert.match(f.owner.failure.message,/recordable suffix/);
  assert.throws(()=>f.owner.request(f.frame,[]),/recordable suffix/);await assert.rejects(f.owner.retry(),/recordable suffix/);
  // Fake-device teardown ONLY: close its orphan. The real provider deliberately
  // stays unresolved: no reset, retry, history adoption or claimed cleanup.
  f.gpu.flush=original;f.gpu.finish();await tick();assert.equal(settled,false);
  f.gpu.failure=new Error('test terminal fake device');
});

test('appearance words and camera freeze with the real cut, independently of mutable scene artwork',async()=>{
  const f=await setup({feedback:false});const artwork=new Uint32Array(64);artwork.set([11,22,33,44]);f.scene.appearanceWords=artwork;
  f.frame.values={...f.frame.values,cam:new Vector3(),model:new Matrix4(),viewProj:new Matrix4()};
  const work=f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}]);artwork[0]=99;f.frame.values.cam.x=77;f.frame.values.model.elements[0]=99;
  const c=await settle(f.gpu,work);assert.equal(c.frame.values.cam[0],0);assert.equal(c.frame.values.model[0],1);assert.equal(words(c.appearance.texture)[0],11);assert.equal(c.frame.external.sourceAppearance,c.appearance.view);assert.notEqual(c.appearance.texture,f.frame.external.sourceAppearance);
  await settle(f.gpu,f.owner.discard(c));c.release();await f.close();
});
test('a load classifies in batches of whole cores, each brick once, none past the bound but a lone core',()=>{
  const bricks=[];for(let z=0;z<24;z++)for(let y=0;y<4;y++)for(let x=0;x<40;x++)if((x*7+y*3+z*5)%4)bricks.push([x,y,z]);
  const batches=worldClassifyBatches(bricks,300),seen=new Set(),core=b=>b.map(n=>Math.floor(n/8)).join(',');
  assert(batches.length>1);
  for(const batch of batches){assert(batch.length<=300||new Set(batch.map(r=>core(r.brick))).size===1);for(const r of batch){assert.equal(r.channels,READY.CELL);seen.add(r.brick.join(','));}}
  assert.equal(seen.size,bricks.length);assert.equal(batches.flat().length,bricks.length);
  const owner=new Map();batches.forEach((batch,k)=>{for(const r of batch){const c=core(r.brick);assert(!owner.has(c)||owner.get(c)===k,'a core never splits across batches');owner.set(c,k);}});
  assert.deepEqual(worldClassifyBatches([[1,2,3]]),[[{brick:[1,2,3],channels:READY.CELL}]]);
});

// The sun-caster forecast (world/worldSunForecast.js): the eye probe's sun tile
// and its casters are in the first attempt, so neither the GI source's
// unknown Sun nor the sun pass's unknown CELL caster restarts it. Without a
// ground twin the same load takes three attempts (2026-10-21).
for(const forecast of [false,true])test(`sun casters ${forecast?'forecast from the ground twin: one attempt':'found by feedback: three attempts'}`,async()=>{
  const f=await setup({ground:forecast?()=>2:null});
  const c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.CELL}]));
  const p=f.owner.progress;
  assert.equal(p.stage,'probe-ready');
  assert.equal(p.attempts,forecast?1:3,`attempts ${p.attempts}`);
  assert.equal(f.events.includes('unknown Sun'),!forecast);
  assert.equal(f.events.includes('unknown CELL'),!forecast);
  // The eye at the world's corner sits on a tile corner: its probe's four
  // bilinear taps read four tiles (the mock GI source asks for the first only).
  assert.equal(p.sunTiles,forecast?4:1);
  if(forecast)assert(p.forecastBricks>0&&f.owner.atlas.lookup([3,0,0],READY.CELL).known,'caster brick forecast and resident');
  else assert.equal(p.forecastBricks,0);
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();await f.close();
});

// GI demand that the SOURCE phase discovers (each opaque SOURCE job reads its own
// brick's previous probe) resolves inside the attempt: every slab runs and the
// births join the same plan. An Island load restarted once per 32-cell core,
// ~64 probes a time, for 19+ attempts of ~3.5 s from its SOURCE stage (2026-10-22).
for(const giSlabJobs of [1,undefined])test(`GI gather demand resolves without restarting the attempt (${giSlabJobs?'a slab per core':'packed slabs'})`,async()=>{
  const cores=[0,8,16],kinds=Object.fromEntries(cores.map(x=>[x,'opaque']));
  const run=async channels=>{
    const f=await setup({size:[96,8,8],feedback:false,sourceKinds:kinds,ownerOptions:giSlabJobs?{giSlabJobs}:{}});
    const c=await settle(f.gpu,f.owner.request(f.frame,cores.map(x=>({brick:[x,0,0],channels}))));
    const p=f.owner.progress,last=new Map();
    for(const j of f.giJobs)last.set(`${j.phase} ${j.index}`,j.flags);
    const gi=cores.map(x=>f.owner.atlas.lookup([x,0,0],READY.GI).known);
    await settle(f.gpu,f.owner.discard(c));c.release();await f.close();
    return {p,last,gi};
  };
  const found=await run(READY.GI_SOURCE),declared=await run(READY.GI_SOURCE|READY.GI);
  assert.equal(found.p.attempts,1,`attempts ${found.p.attempts}`);
  assert.equal(found.p.sourcePasses,1,'one SOURCE pass found every core\'s births');
  assert.equal(found.p.gathers,cores.length);
  // Exact: the same jobs, birth flags and probes as a load that asked for them.
  assert.equal(declared.p.attempts,1);assert.equal(declared.p.sourcePasses,0);
  assert.deepEqual([...found.last].sort(),[...declared.last].sort());
  assert.deepEqual(found.gi,cores.map(()=>true));assert.deepEqual(declared.gi,found.gi);
});

// Each restart records metadata for the bricks it adds, not for the whole
// demand again (Island: 2.3-2.5 s of every restart at 449k bricks, 2026-10-22).
test('a restart\'s metadata cost is proportional to new bricks',async()=>{
  const f=await setup(),counts=[],acquire=f.owner.cells.acquireClassification.bind(f.owner.cells);
  f.owner.cells.acquireClassification=o=>{counts.push(o.bricks.map(b=>b.join(',')));return acquire(o);};
  const c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.CELL}]));
  const p=f.owner.progress;assert.equal(p.attempts,3);
  const once=counts.flat();assert.equal(new Set(once).size,once.length,'every brick\'s metadata is recorded once');
  assert.equal(once.length,p.requirements,'and every required brick\'s');
  assert.equal(p.metadataBricks,counts.at(-1)?.length??0);
  await settle(f.gpu,f.owner.accept(c,post(c)));
  assert.deepEqual(new Set(f.owner.metadata.indices.map(String)),new Set([...f.owner.atlas.bookPages('cell')].map(pg=>String(pg.brick[0]+4*(pg.brick[1]+2*pg.brick[2])))));
  c.release();await f.close();
});
