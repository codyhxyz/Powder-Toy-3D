// Actual owner + Source/Cut/Fields/CELL/Atlas/history/GI/Sun/Glow/records.
// Delayed native transport. Lighting kernel MATH is intentionally mocked;
// WGSL leaf arithmetic remains covered by the existing union checks.
import test from 'node:test';
import { Matrix4, Vector3 } from 'three';
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { fixture, drain } from './world-lighting-records-fixture.mjs';
import { installWorldRender } from '../src/wire/worldRender.js';
import { READY } from '../src/world/renderAtlas.js';
import { tableLayout } from '../src/shaders/common.js';
const words=b=>new Uint32Array(b.bytes),bytes=b=>new Uint8Array(b.bytes);
class Exec extends WgslExec {_dispatchWorkgroup(fn,id,c){for(const a of fn.node.attributes??[])if(a.name==='workgroup_size'&&typeof a.value==='string')a.value=[a.value];return super._dispatchWorkgroup(fn,id,c);}}
const tick=()=>new Promise(r=>setTimeout(r,0));
async function settle(gpu,promise){let done=false,error,result;promise.then(r=>{done=true;result=r;},e=>{done=true;error=e;});for(let i=0;i<2000&&!done;i++){gpu.finish();await tick();}assert(done,'native final boundary failed to settle');if(error)throw error;return result;}
export async function setup({size=[16,8,8],feedback=true}={}) {
  const f=await fixture({size}),gpu=f.gpu,events=[],sources=[],histories=[],tablesUsed=[];
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
    if(label==='world GI source'||label==='world GI gather')return push(()=>{
      events.push(label);const p=words(buf(3,7)),jobs=words(buf(3,8)),out=words(buf(3,9)),fb=words(buf(3,1)),sun=words(buf(3,5)),book=words(buf(0,5));
      const start=label==='world GI source'?0:p[0],count=label==='world GI source'?p[0]:p[1];
      let missing=false;
      if(feedback&&label==='world GI source'&&!sun[6]){fb[owner.atlas.bookLayout.sunWord]|=1;missing=true;events.push('unknown Sun');}
      if(feedback&&label==='world GI gather'&&!book[1]){const plane=owner.atlas.bookLayout.requestBytes/4/6;fb[plane*3]|=2;missing=true;events.push('unknown SOURCE');}
      for(let i=0;i<count;i++){fb[p[2]+start+i]=missing?3:1;if(label==='world GI source')out.set([jobs[4*i],p[3],101,202],i*4);}
      if(label==='world GI source')sources.push([...out]);else{const h=words(buf(3,10));histories.push([...h]);for(let i=0;i<h.length;i++)h[i]++;}
    });
    if(label==='full world optical sun')return push(()=>{
      events.push(label);const fb=words(buf(3,1)),job=words(buf(2,0)),book=words(buf(0,4));let missing=false;
      if(feedback&&!book[3]){fb[0]|=8;missing=true;events.push('unknown CELL');}fb[job[5]]=missing?3:1;
    });
    if(label==='world glow float'||label==='world glow half')return push(()=>{events.push(label);const p=words(buf(0,0));words(buf(0,3))[p[20]]=1;});
    if(label.startsWith('world ')&&label.endsWith(' transport'))return push(()=>{
      const p=words(buf(0,0)),data=bytes(buf(0,1)),out=groups[1].entries.map(e=>e.resource.texture);
      if(label==='world source transport')bytes(out[0]).set(data.subarray(0,16),p[12]*16);
      else if(label==='world gi transport')out.forEach((t,k)=>bytes(t).set(data.subarray(k*8,k*8+8),p[0]*8));
      else bytes(out[0]).set(data.subarray(0,8),p[0]*8);
    });
    throw new Error(`unmocked native pipeline ${label}`);
  }
  gpu.encoder=(label,frame=false)=>{const e=original(label,frame),push=fn=>frame?gpu._push(fn):e.ops.push(fn);e.clearBuffer=(b,o=0,n=b.size-o)=>push(()=>bytes(b).fill(0,o,o+n));e.beginComputePass=()=>{let pipe,n;const groups=[];return {setPipeline:p=>pipe=p,setBindGroup:(i,g)=>groups[i]=g,dispatchWorkgroups:x=>n=x,end:()=>dispatch(pipe,groups,n,push)};};return e;};
  gpu.frame._command=()=>{};gpu.frame._commandDone=()=>{};
  gpu.frame.compute=()=>{let pipe;const groups=[];return {setPipeline:p=>pipe=p,setBindGroup:(i,g)=>groups[i]=g,dispatchWorkgroups:n=>dispatch(pipe,groups,n,fn=>gpu._push(fn))};};
  owner=installWorldRender(f.win);
  const frame={sceneVersion:'scene',schemaVersion:1,configVersion:1,values:{cam:[0,0,0]},physicsOrigin:[0,0,0],globalKey:[1],sun:{direction:[1,1,1],basisRevision:1},external:Object.fromEntries(['mediaNoise','packedMesh','sourceAppearance'].map(name=>[name,{name}]))};
  return {...f,owner,events,sources,histories,tablesUsed,frame,async close(){await settle(gpu,owner.dispose());await f.finish();}};
}
const complete={incomplete:false,requirements:[],sun:[]};
function post(candidate,confirmation=Promise.resolve(true)){const feedbackIdentity={};return {feedbackIdentity,postTicket:{identity:candidate.identity,publication:candidate,feedbackIdentity,status:'committed',confirmation},feedback:complete};}

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
  const cut=c.cut;const extended=await settle(f.gpu,f.owner.extend(c,{incomplete:true,requirements:[{index:1,brick:[1,0,0],channels:READY.GI_SOURCE|READY.GI}],sun:[]}));
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
  const f=await setup({size:[48,8,8],feedback:false});const demand=[0,8].map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE|READY.GI}));
  let c=await settle(f.gpu,f.owner.request(f.frame,demand));
  const phases=f.events.filter(x=>x==='world GI source'||x==='world GI gather');assert.deepEqual(phases,['world GI source','world GI source','world GI gather','world GI gather']);
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
  for(let i=1;i<=2;i++){f.source.noteContentChange();c=await settle(f.gpu,f.owner.request(f.frame,demand));await settle(f.gpu,f.owner.accept(c,post(c)));if(i===1)c.release();}
  const proof=c.snapshot.lightingProvenance([0,0,0]).gi;assert.equal(proof.computeToken.lightingTick,1);assert(proof.computeToken.sourceRevision<c.cut.sourceRevision);assert.equal(proof.publication.sourceRevision,c.cut.sourceRevision);
  const pid=f.owner.atlas.lightEntries[0]-1,page=f.owner.atlas.light.pages.get(pid);assert.equal(page.sourceTick,2);assert.equal(page.giTick,1);assert(f.owner.metadata.indices.includes(8),'offscreen ownership retained across cuts');
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
