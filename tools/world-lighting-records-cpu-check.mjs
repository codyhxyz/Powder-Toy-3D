// CPU-only: actual Source cuts/CELL captures, delayed native commands, and
// production delta WGSL interpreter + Naga. NOT GPU parity/performance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { fixture, cut, drain } from './world-lighting-records-fixture.mjs';
import { WorldCellAtlasAdapter } from '../src/world/cellAtlasAdapter.js';
import { WorldRenderAtlas, READY } from '../src/world/renderAtlas.js';
import { createWorldLightingRecords } from '../src/world/worldLightingRecords.js';
import { worldLightingDeltaWGSL, worldLightingDeltaLayouts } from '../src/shaders/worldLightingDelta.js';
import { AGE } from '../src/shaders/fields.js';
import { BRICK_INFO } from '../src/shaders/bindings.js';
import { cellSlot, brickIdOf } from '../src/shaders/common.js';
import { SOURCE_GRID } from '../src/world/renderSource.js';
import { worldLightingNear } from '../src/gfx/worldLightingBatch.js';
import { nagaSpawn } from './naga.mjs';
test('indexed change neighborhoods exactly match clipped Chebyshev selection',()=>{
 const size=[32,20,28],changed=[[0,0,0],[7,4,6],[2,3,1],[2,3,1]];
 for(const points of [[],changed])for(const radius of [0,1,2,4]){
   const near=worldLightingNear(size,points,radius);
   for(let z=0;z<7;z++)for(let y=0;y<5;y++)for(let x=0;x<8;x++){
     const b=[x,y,z],expected=points.some(c=>c.every((n,k)=>Math.abs(n-b[k])<=radius));
     assert.equal(near(b),expected,`${b} radius ${radius}`);
   }
 }
 const near=worldLightingNear(size,changed,0);changed[0][0]=4;
 assert(near([0,0,0]),'change coordinates are captured, not caller-aliased');
 assert.throws(()=>near([-1,0,0]),/global lighting brick/);
});
test('large initial change cohorts do not scan the entire cohort per record',()=>{
 const points=Array.from({length:20000},(_,i)=>[i%64,Math.floor(i/64)%32,Math.floor(i/2048)]);
 const near=worldLightingNear([256,128,256],points,2);
 assert(points.every(near));assert(!near([63,31,63]));
});
const u32=b=>new Uint32Array(b.bytes);
class Exec extends WgslExec {
  _dispatchWorkgroup(fn,id,context){for(const a of fn.node.attributes??[])if(a.name==='workgroup_size'&&typeof a.value==='string')a.value=[a.value];return super._dispatchWorkgroup(fn,id,context);}
}
function execute(code,buffers,count=1){new Exec(new WgslParser().parse(code)).dispatchWorkgroups('main',[count,1,1],{0:Object.fromEntries(buffers.map((b,i)=>[i,b.bytes??b]))});}
function nativeDelta(gpu){const original=gpu.encoder.bind(gpu);gpu.encoder=(label,frame=false)=>{const encoder=original(label,frame),begin=encoder.beginComputePass;encoder.beginComputePass=()=>{let pipe,group,count;const groups=[];return {setPipeline(p){pipe=p;},setBindGroup(i,g){groups[i]=g;group=g;},dispatchWorkgroups(n){count=n;},end(){if(pipe.label?.startsWith('world lighting delta')){gpu._push(()=>execute(pipe.compute.module.code,group.entries.map(e=>e.resource.buffer),count),{name:pipe.label});}else{const p=begin();p.setPipeline(pipe);groups.forEach((g,i)=>p.setBindGroup(i,g));p.dispatchWorkgroups(count);p.end();}}};};return encoder;};}
function provider(gpu){let rejectNext=false;return {reject(){rejectNext=true;},reserve(frame){let resolve,reject;const submitted=new Promise((a,b)=>{resolve=a;reject=b;});submitted.catch(()=>{});return {submitted,record(f,b,n){assert.equal(f,frame);gpu.flush();if(rejectNext){rejectNext=false;reject(new Error('final suffix rejected'));return Promise.reject(new Error('discarded'));}resolve();return gpu.queue.onSubmittedWorkDone().then(()=>u32(b).slice(0,n));}};}};}
async function setup({size=[64,8,8],cur=0}={}){
  const f=await fixture({size});f.sim.cur=cur;nativeDelta(f.gpu);
  const atlas=new WorldRenderAtlas(f.gpu,{worldSize:size,initialCapacity:8}),adapter=new WorldCellAtlasAdapter({gpu:f.gpu,source:f.source,producer:f.producer,atlas,tables:f.sim.tables,worldBounds:{min:[0,0,0],max:size}});await adapter.ready;
  const submissionProvider=provider(f.gpu),records=createWorldLightingRecords(f.gpu,{worldSize:size,sourceOwner:f.source,submissionProvider});await records.ready;
  const bricks=[[0,0,0],[7,1,1],[8,0,0],[15,1,1]].filter(b=>b.every((v,k)=>v<size[k]/4));
  async function publish(c,t=0,bs=bricks){adapter.bindCut(c);const batch=adapter.record(f.gpu.frame,{fieldTick:t,requirements:bs.map(brick=>({brick,channels:READY.CELL}))});f.gpu.flush();adapter.commitAfterSourceFlush(batch).previousLightingSnapshot.release();await drain(f.gpu);return adapter.acquireClassification({bricks:bs});}
  async function sample(c,t,{bs=bricks,commit=true}={}){const classification=await publish(c,t,bs),b=records.record(f.gpu.frame,{cut:c,classification,derivedTick:t});await drain(f.gpu);await b.completion;if(commit)b.commit();return b;}
  async function close(){records.dispose();await drain(f.gpu);adapter.dispose();atlas.dispose();await f.finish();}
  return {...f,atlas,adapter,records,submissionProvider,bricks,publish,sample,close};
}

test('actual delta modules validate Naga, <=8 storage; production execution preserves NaN/signed-zero and absent aux',()=>{
  for(const aux of [false,true]){const code=worldLightingDeltaWGSL(aux),p=nagaSpawn(code, 'worldLightingDelta.wgsl', {encoding:'utf8'});assert.equal(p.status,0,p.stderr);assert.equal(worldLightingDeltaLayouts(aux).length,aux?8:6);
    const data=Array.from({length:aux?6:4},()=>new Uint32Array(256));for(const d of data){d[0]=0x7fc12345;d[1]=0x80000000;}
    const delta=new Uint32Array(1),jobs=new Uint32Array(132);jobs[2]=0;
    execute(code,[...data,delta,jobs]);assert.equal(delta[0],0,'stable words including NaN and signed zero');
    data[1][1]=0;execute(code,[...data,delta,jobs]);assert.equal(delta[0],aux?0:1,'absent aux is ignored');
    if(aux){for(const bit of [1,2,4]){delta[0]=0;jobs[4]=bit;execute(code,[...data,delta,jobs]);assert.equal(delta[0],1,'presence provenance changes');jobs[5]=bit;data[bit===1?1:bit===2?3:5][0]^=1;delta[0]=0;execute(code,[...data,delta,jobs]);assert.equal(delta[0],1,'one present aux word changes');jobs[4]=jobs[5]=0;}}
  }
});

test('real submitted captures: birth, broad newer revisions unchanged, precise raw/aux deltas, clock >22 and complete Glow halo',async()=>{
  const f=await setup({cur:1});let a=cut(f);const birth=await f.sample(a,0);assert.equal(f.records.records(f.records.indices,{derivedTick:0})[0].age,0);assert.throws(()=>birth.commit(),/complete\/live/);
  // Original classifier info is UINT, xyz preserved as WORDS (including NaN).
  assert.equal(f.records.records(f.records.indices,{derivedTick:0})[0].matter,!!(0x01020304&BRICK_INFO.MATTER));
  for(let t=1;t<=24;t++){f.source.noteContentChange();const b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});const pending=await f.sample(b,t,{commit:false});assert.equal(pending.changes.changedBricks.length,0);assert.equal(pending.changes.emissionChangedBricks.length,0);pending.commit();a.release();a=b;}
  assert.equal(f.records.records(f.records.indices,{derivedTick:24})[0].age,24);assert.equal(f.records.records(f.records.indices,{derivedTick:999})[0].age,AGE.MAX);
  const slot=cellSlot(f.sim.g,0,0,0),offset=f.sim.cur*f.sim.g.slots*4+slot*4;u32(f.sim.state.B)[offset]^=1;f.sim.version++;f.source.noteContentChange();let b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});let p=await f.sample(b,25,{commit:false});assert.deepEqual(p.changes.changedBricks,[[0,0,0]]);assert.equal(p.records(f.records.indices,{derivedTick:25})[0].age,0);p.commit();a.release();a=b;
  // Emit changes are exact classifier xyz words, not raw/domain revisions.
  const lease=await f.publish(a,25);const r=lease.records[0];u32(r.buffer)[r.byteOffset/4]^=1;
  p=f.records.record(f.gpu.frame,{cut:a,classification:lease,derivedTick:25});await drain(f.gpu);await p.completion;assert.equal(p.changes.changedBricks.length,0);assert.equal(p.changes.emissionChangedBricks.length,1);assert.equal(p.changes.glowDirtyIndices.length,5*2*2);p.commit();assert.equal(f.records.records(f.records.indices,{derivedTick:25})[1].age,25,'same-clock camera work cannot age twice');
  u32(f.sim.flow)[2*slot]^=1;f.sim.version++;f.source.noteContentChange();b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});p=await f.sample(b,26,{commit:false});assert.deepEqual(p.changes.changedBricks,[[0,0,0]]);p.commit();a.release();b.release();await f.close();
});

test('real lease admission, typed unknown/offscreen demands, retry/discard/reset and final-reject prefix pinning',async()=>{
  const f=await setup();const a=cut(f),lease=await f.publish(a);const unknown=1;assert.throws(()=>f.records.records([unknown],{derivedTick:0}),e=>e.requirements[0].channels===READY.CELL);
  const batch=f.records.record(f.gpu.frame,{cut:a,classification:lease,derivedTick:0});assert.throws(()=>batch.records([0]),/not complete/);assert.throws(()=>f.records.records([0],{derivedTick:0}),/metadata required/);await drain(f.gpu);await batch.completion;batch.discard();assert.deepEqual(f.records.indices,[]);await f.sample(a,0);
  const previousRaw=a.source.chunks.get('0,0,0').A;a.release();await drain(f.gpu);assert(!previousRaw.destroyed,'committed baseline owns immutable old input');
  f.source.noteContentChange();const b=cut(f);const fewer=await f.publish(b,1,[f.bricks[0]]);assert.throws(()=>f.records.record(f.gpu.frame,{cut:b,classification:fewer,derivedTick:1}),e=>e.requirements.length===f.bricks.length-1);fewer.release();
  const mismatch=await f.publish(b,1);assert.throws(()=>f.records.record(f.gpu.frame,{cut:a,classification:mismatch,derivedTick:1}),/invalid owned/);mismatch.release();
  const rejected=await f.publish(b,1);f.submissionProvider.reject();const failed=f.records.record(f.gpu.frame,{cut:b,classification:rejected,derivedTick:1});assert(!previousRaw.destroyed);await drain(f.gpu);await assert.rejects(failed.completion,/suffix rejected/);assert.equal(f.records.derivedTick,0);await f.sample(b,1);
  const resetLease=await f.publish(b,2),pending=f.records.record(f.gpu.frame,{cut:b,classification:resetLease,derivedTick:2});f.records.reset();assert.deepEqual(f.records.indices,[]);await drain(f.gpu);await assert.rejects(pending.completion,/discarded\/stale/);assert.equal(f.records.derivedTick,-1);
  b.release();await f.close();
});

test('original source-grid slot order spans 4/32/world edges, not xyz-linear reinterpretation',async()=>{
  const f=await setup({size:[36,8,8]}),a=cut(f);await f.sample(a,0);const b=f.bricks.at(-1),p=b.map(n=>n*4),r=a.source.getSource(p);assert.equal(r.slot,brickIdOf(SOURCE_GRID,...b.map(n=>n%8))*64);assert(f.records.records(f.records.indices,{derivedTick:0}).every(r=>r.near===false));a.release();await f.close();
});

test('origin-only same-cut work, present deco/presence bits, released leases and disposal never publish phantom stamps',async()=>{
  const f=await setup(),a=cut(f);await f.sample(a,0);f.sim.origin.x=32;
  const same=await f.sample(a,1,{commit:false});assert.deepEqual(same.changes.changedBricks,[]);same.commit();assert.equal(f.records.records([0],{derivedTick:1})[0].age,1);f.sim.origin.x=0;
  u32(f.sim.decoPlane.buffer)[0]^=1;f.sim.version++;f.source.noteContentChange();const b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});const deco=await f.sample(b,2,{commit:false});assert.deepEqual(deco.changes.changedBricks,[[0,0,0]]);deco.commit();
  // Presence is CPU provenance, frozen into immutable native jobs, not stale data.
  f.sim.version++;f.source.noteContentChange();const c=f.source.recordCut(f.gpu.frame,{previousCut:b,sceneVersion:'scene',configVersion:1});const lease=await f.publish(c,3);c.source.getSource([0,0,0]).chunk.aux[0]^=4;
  const presence=f.records.record(f.gpu.frame,{cut:c,classification:lease,derivedTick:3});await drain(f.gpu);await presence.completion;assert.deepEqual(presence.changes.changedBricks,[[0,0,0]]);presence.commit();
  const released=await f.publish(c,4);released.release();const invalid=f.records.record(f.gpu.frame,{cut:c,classification:released,derivedTick:4});await drain(f.gpu);await assert.rejects(invalid.completion,/Released\/stale/);
  const live=await f.publish(c,4),pending=f.records.record(f.gpu.frame,{cut:c,classification:live,derivedTick:4});f.records.dispose();a.release();b.release();c.release();await drain(f.gpu);await assert.rejects(pending.completion,/discarded\/stale/);assert.throws(()=>f.records.records([0],{derivedTick:4}),/disposed/);await f.close();
});

// A restarted load attempt records only the bricks its last attempt's records
// lacked, and reads back exactly what one record() of all of them reads: Island
// re-recorded 449k rows, 2.3-2.5 s a restart, with nothing new (2026-10-22).
test('a restart\'s metadata cost is proportional to new bricks; carried records stay exact',async()=>{
  const f=await setup({cur:1}),all=f.bricks,first=[all[0],all[2]],rest=[all[1],all[3]];
  let a=cut(f);await f.sample(a,0,{bs:first});
  const slot=cellSlot(f.sim.g,0,0,0),offset=f.sim.cur*f.sim.g.slots*4+slot*4;u32(f.sim.state.B)[offset]^=1;f.sim.version++;f.source.noteContentChange();
  const b=f.source.recordCut(f.gpu.frame,{previousCut:a,sceneVersion:'scene',configVersion:1});
  const ids=all.map(x=>x[0]+16*(x[1]+2*x[2])),sorted=l=>[...l].map(String).sort();
  const full=await f.sample(b,1,{bs:all,commit:false});
  const reference={records:full.records(ids),changed:sorted(full.changes.changedBricks),emission:sorted(full.changes.emissionChangedBricks),halo:[...full.changes.glowDirtyIndices]};
  assert(reference.changed.length>0,'the edit changes a carried brick');
  full.discard();
  const one=await f.sample(b,1,{bs:first,commit:false});
  assert.deepEqual(f.records.carryable(one,{cut:b,derivedTick:1}),new Set(first.map(x=>x[0]+16*(x[1]+2*x[2]))));
  assert.equal(f.records.carryable(one,{cut:b,derivedTick:2}),null,'another clock never carries');
  const classification=await f.publish(b,1,rest),two=f.records.record(f.gpu.frame,{cut:b,classification,derivedTick:1,carry:one});
  await drain(f.gpu);await two.completion;
  assert.equal(two.wordCount,rest.length*5,'only the new bricks are recorded');
  assert.throws(()=>one.records(ids),/not complete\/live/,'a carried batch is consumed');
  assert.deepEqual(two.records(ids),reference.records);
  assert.deepEqual(sorted(two.changes.changedBricks),reference.changed);
  assert.deepEqual(sorted(two.changes.emissionChangedBricks),reference.emission);
  assert.deepEqual([...two.changes.glowDirtyIndices],reference.halo);
  assert.deepEqual(sorted(two.indices),sorted(ids));
  two.commit();assert.deepEqual(f.records.records(ids,{derivedTick:1}),reference.records);
  a.release();b.release();await f.close();
});
