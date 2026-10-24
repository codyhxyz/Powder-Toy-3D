// Actual owner + Source/Cut/Fields/CELL/Atlas/history/GI/Sun/Glow/records.
// Delayed native transport. Lighting kernel MATH is intentionally mocked;
// WGSL leaf arithmetic remains covered by the existing union checks.
// (The fixture: tools/world-render-owner-fixture.mjs.)
import test from 'node:test';
import { Matrix4, Vector3 } from 'three';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './world-lighting-records-fixture.mjs';
import { setup, settle, post, complete, words, tick } from './world-render-owner-fixture.mjs';
// (other checks import the fixture from here: world-main-route*, world-still)
export { setup };
import { installWorldRender, worldClassifyBatches } from '../src/wire/worldRender.js';
import { READY, bookPage } from '../src/world/renderAtlas.js';
import { tableLayout } from '../src/shaders/common.js';
import { selectWorldGI } from '../src/world/worldLightingHistory.js';
import { GI_SETTLE } from '../src/shaders/gi.js';

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

// At the original reset every previous probe is the ledger's zero seed, read as
// a birth (gfx/worldGI.js): a SOURCE asks for no probe of its own, which was a
// chain (each such probe's gather asked for more SOURCES). Past the reset the
// self-read still requires a full birth before admission.
for(const kind of ['opaque','crystal'])test(`${kind} SOURCE actual self-read: none at the reset, full birth before admission after it`,async()=>{
  const f=await setup({feedback:false,sourceKinds:{0:kind}});
  let c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE}]));
  assert(!f.events.includes('typed GI self-miss'));
  assert(f.giJobs.filter(j=>j.phase==='world GI source').every(j=>j.flags&2),'reset SOURCE jobs read the zero seed as births');
  assert.deepEqual(f.giJobs.filter(j=>j.phase==='world GI gather'),[]);
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
  f.giJobs.length=0;f.events.length=0;
  c=await settle(f.gpu,f.owner.request(f.frame,[{brick:[0,0,0],channels:READY.GI_SOURCE}]));
  assert(f.events.includes('typed GI self-miss'));
  const gathers=f.giJobs.filter(j=>j.phase==='world GI gather');assert.deepEqual([...new Set(gathers.map(j=>j.index))],[0]);
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
    // Past the reset: at it every previous probe is the zero seed, read as a
    // birth (gfx/worldGI.js), so its SOURCE jobs ask for none.
    const c0=await settle(f.gpu,f.owner.request(f.frame,cores.map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE}))));
    await settle(f.gpu,f.owner.accept(c0,post(c0)));c0.release();f.giJobs.length=0;
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

// A big map's second tick packed every resident brick again on top of its old
// page (Island 400k, Descent 650k past the page cap, 2026-10-22): a tick packs
// only the CELL pages its changes reach (tools/world-tick-repack-cpu-check.mjs at scale).
test('a field tick alone packs no CELL page; a far change packs none of the near core, whose page pairs with this revision\'s LIGHT',async()=>{
  const f=await setup({size:[64,8,8],feedback:false}),atlas=f.owner.atlas,demand=[{brick:[0,0,0],channels:READY.GI_SOURCE|READY.GI}];
  let c=await settle(f.gpu,f.owner.request(f.frame,demand));await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
  const packed=[],allocate=atlas.allocate.bind(atlas);atlas.allocate=(b,v)=>{packed.push(b);return allocate(b,v);};
  const pages=new Map(atlas.live.cell);assert(pages.size>0);
  f.sim.version++;c=await settle(f.gpu,f.owner.request(f.frame,demand));
  assert.equal(c.logicalFieldTick,1);assert.deepEqual(packed,[],'a field tick with no change packed CELL pages again');
  assert([...atlas.live.cell].every(([i,p])=>pages.get(i)===p),'every CELL page is the load\'s');
  await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
  // the far core (x >= 32 cells): past the near core's 8-cell field reach
  f.source.noteContentChange({lo:[56,0,0],hi:[64,8,8]});
  c=await settle(f.gpu,f.owner.request(f.frame,demand));
  assert(packed.every(b=>b[0]*4>=32),'a far change packed a near-core CELL page');
  const cell=atlas.live.cell.get(0),light=atlas.light.pages.get(bookPage(atlas.lightEntries[0]));
  assert.equal(cell,pages.get(0));assert(cell.sourceRevision<c.cut.sourceRevision);assert.equal(light.sourceRevision,c.cut.sourceRevision);
  atlas.allocate=allocate;await settle(f.gpu,f.owner.accept(c,post(c)));c.release();await f.close();
});

// A restart re-ran every SOURCE job of the load: Island's scene round restarted
// a probe-ready load twice with ~78k SOURCES each time, then took 20-28 s to
// publish them (2026-10-22). Same cut, field tick, clock, config and sun: a
// restart carries them (gfx/worldGI.js carry), byte for byte what it computed.
const sourceRuns=f=>f.giJobs.filter(j=>j.phase==='world GI source');
// a SOURCE's published bytes, read back through the history a camera-only load restores
async function sourceBytes(f,bricks){
  const c=await settle(f.gpu,f.owner.request({...f.frame,advance:false},[{brick:bricks[0],channels:READY.CELL}]));
  const out=bricks.map(b=>{const s=c.snapshot.lightingProvenance(b).source;return [...words(s.nativeBuffer).subarray(s.ranges[0].from/4,s.ranges[0].from/4+4)];});
  await settle(f.gpu,f.owner.discard(c));c.release();return out;
}
test('a restart with unchanged inputs runs no SOURCE job again, and publishes the same SOURCE bytes',async()=>{
  const demand=[0,1,2].map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE|READY.GI})),bricks=demand.map(r=>r.brick);
  const f=await setup({feedback:false});
  const c=await settle(f.gpu,f.owner.request(f.frame,demand));
  const first=sourceRuns(f).length;assert.equal(first,3);
  // the scene asks for a glow (as its round does): the same SOURCES, nothing they read changed
  const extended=await settle(f.gpu,f.owner.extend(c,{incomplete:true,requirements:[{brick:[0,0,0],channels:READY.GLOW}],sun:[]}));c.release();
  const p=f.owner.progress;assert.equal(p.attempts,2);
  assert.equal(sourceRuns(f).length-first,0,'the restart ran SOURCE jobs again');
  assert.equal(p.carriedSources,3);assert.equal(p.sourceJobs,3);
  await settle(f.gpu,f.owner.accept(extended,post(extended)));extended.release();
  const carried=await sourceBytes(f,bricks);await f.close();
  // what a load that asked for the glow up front publishes
  const g=await setup({feedback:false});
  const fresh=await settle(g.gpu,g.owner.request(g.frame,[...demand,{brick:[0,0,0],channels:READY.GLOW}]));
  assert.equal(g.owner.progress.carriedSources,0);
  await settle(g.gpu,g.owner.accept(fresh,post(fresh)));fresh.release();
  assert.deepEqual(carried,await sourceBytes(g,bricks));await g.close();
});
// A SOURCE job's light depends on none of its slab's other jobs: a pass whose
// slab had one job ask for its own probe (a birth, past the reset) keeps the
// jobs that completed, and the next pass runs only the birth again.
test('a SOURCE pass after births runs again only the jobs that asked for something, with the same result',async()=>{
  const cores=[0,8,16],run=async kinds=>{
    const f=await setup({size:[96,8,8],feedback:false,sourceKinds:kinds});
    const c0=await settle(f.gpu,f.owner.request(f.frame,cores.map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE}))));
    await settle(f.gpu,f.owner.accept(c0,post(c0)));c0.release();f.giJobs.length=0;
    const c=await settle(f.gpu,f.owner.request(f.frame,cores.map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE}))));
    const p=f.owner.progress,jobs=sourceRuns(f).map(j=>j.index);
    await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
    const bytes=await sourceBytes(f,cores.map(x=>[x,0,0]));await f.close();
    return {p,jobs,bytes};
  };
  const r=await run({0:'opaque',8:'air',16:'air'});
  assert.equal(r.p.attempts,1);assert.equal(r.p.sourcePasses,1);
  assert.deepEqual(r.jobs,[0,8,16,0],'the second pass ran a completed job again');
  assert.equal(r.p.carriedSources,2);
  // each carried job's own bytes (the fixture's SOURCE writes its index and clock), none moved to another slot
  assert.deepEqual(r.bytes,cores.map(x=>[x,1,101,202]));
});
// A load's final publish writes every SOURCE, probe and glow page in one
// submission with one wait: a wait per page was 20-28 s on Island (2026-10-22).
test('the final publish writes all of its light pages in one Atlas submission',async()=>{
  const f=await setup({feedback:false}),calls=[],batch=f.owner.atlas.recordLightWrites.bind(f.owner.atlas);
  // (a restore's copies are one submission too: worldLightingBatch.js restore)
  f.owner.atlas.recordLightWrites=writes=>{if(!writes.some(w=>w.restoreDeclaration))calls.push(writes.map(w=>w.kind));return batch(writes);};
  const c=await settle(f.gpu,f.owner.request(f.frame,[0,1,2].map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE|READY.GI}))));
  const final=calls.at(-1);
  assert.equal(final.filter(k=>k==='source').length,3);assert.equal(final.filter(k=>k==='gi').length,3);
  assert.equal(calls.filter(k=>k.length>1).length,1,'one batched publish');
  await settle(f.gpu,f.owner.discard(c));c.release();await f.close();
});
// A tick's final publish allocates no page its own restore already made
// resident with the same retained SOURCE and probe: a big map restored every
// owned one twice a tick, 90k-115k pages (2026-10-22). The published book
// holds the same readiness and bytes as when every page is allocated again.
test('a final publish keeps the pages its restore made resident; the book is the same',async()=>{
  const demand=[0,1,2,8].map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE|READY.GI})),bricks=demand.map(r=>r.brick);
  const run=async keepResident=>{
    const f=await setup({size:[64,8,8],feedback:false,ownerOptions:{keepResident}}),out=[];
    // past the load's settle ticks (every SOURCE recomputed), and a field tick of a change
    for(let k=0;k<GI_SETTLE+4;k++){
      if(k===GI_SETTLE+2)f.sim.version++;
      const c=await settle(f.gpu,f.owner.request(f.frame,demand)),p=f.owner.progress;
      const book=bricks.map(b=>{const l=c.snapshot.lightingProvenance(b),look=f.owner.atlas.lookup(b,READY.GI_SOURCE|READY.GI);
        const read=x=>x?[...words(x.nativeBuffer).subarray(x.ranges[0].from/4,x.ranges[0].from/4+x.ranges[0].size/4)]:null;
        return {known:look.known,source:read(l?.source),gi:read(l?.gi)};});
      out.push({kept:p.residentKept,book});
      await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
    }
    await f.close();return out;
  };
  const kept=await run(true),again=await run(false);
  assert(kept.slice(GI_SETTLE+1).every(r=>r.kept>0),`ticks after the settle keep resident pages (${kept.map(r=>r.kept)})`);
  assert(again.every(r=>r.kept===0));
  assert.deepEqual(kept.map(r=>r.book),again.map(r=>r.book),'the same book, tick after tick');
});
// An attempt clears only the light pages its restore would not write the same: a restart in
// one transaction kept none of them before, and restored every owned SOURCE and probe again
// (~78k pages on Island, each attempt). The book each attempt reads and publishes is the same.
test('a restart keeps the light pages its earlier restore wrote; the book is the same',async()=>{
  const demand=[0,1,2,8].map(x=>({brick:[x,0,0],channels:READY.GI_SOURCE|READY.GI})),bricks=demand.map(r=>r.brick);
  const run=async keepResident=>{
    const f=await setup({size:[64,8,8],feedback:false,ownerOptions:{keepResident}}),out=[];
    for(let k=0;k<GI_SETTLE+4;k++){
      if(k===GI_SETTLE+2)f.sim.version++;
      let c=await settle(f.gpu,f.owner.request(f.frame,demand));
      // the scene asks for a glow, then for nothing new: the same transaction's attempts
      for(const requirements of [[{brick:[0,0,0],channels:READY.GLOW}],[{brick:[1,0,0],channels:READY.GLOW}]]){
        const next=await settle(f.gpu,f.owner.extend(c,{incomplete:true,requirements,sun:[]}));c.release();c=next;
      }
      const p=f.owner.progress,book=bricks.map(b=>{const l=c.snapshot.lightingProvenance(b),look=f.owner.atlas.lookup(b,READY.GI_SOURCE|READY.GI);
        const read=x=>x?[...words(x.nativeBuffer).subarray(x.ranges[0].from/4,x.ranges[0].from/4+x.ranges[0].size/4)]:null;
        return {known:look.known,source:read(l?.source),gi:read(l?.gi)};});
      out.push({attempts:p.attempts,light:p.lightKept,book});
      await settle(f.gpu,f.owner.accept(c,post(c)));c.release();
    }
    await f.close();return out;
  };
  const kept=await run(true),again=await run(false);
  assert(kept.every(r=>r.attempts===3));
  // (past the load's settle ticks: before them every tick computes every SOURCE and probe anew)
  assert(kept.slice(GI_SETTLE+1).every(r=>r.light>0),`restarts keep light pages (${kept.map(r=>r.light)})`);
  assert(again.every(r=>r.light===0));
  assert.deepEqual(kept.map(r=>r.book),again.map(r=>r.book),'the same book, tick after tick');
});
// Only the bricks a gather reads at full detail are SOURCES: the eye's ring
// and every probe's (world/worldGIRing.js worldGIReach). A brick the view asked
// for past them was a SOURCE before (Island: ~78k a restart, 2026-10-22).
test('SOURCE jobs are only bricks within a gather\'s reach: a far brick the view asked for is no SOURCE',async()=>{
  const {worldGIReach,WORLD_GI_NEAR_RADIUS}=await import('../src/world/worldGIRing.js');
  const f=await setup({size:[192,8,8],feedback:false,ground:()=>2});
  const far=[40,0,0],probe=[0,0,0];
  const c=await settle(f.gpu,f.owner.request(f.frame,[{brick:probe,channels:READY.GI},{brick:far,channels:READY.CELL},{brick:[2,0,0],channels:READY.CELL}]));
  const reach=worldGIReach(f.frame.values.cam,[probe],WORLD_GI_NEAR_RADIUS),dims=[48,2,2];
  const at=j=>[j.index%dims[0],Math.floor(j.index/dims[0])%dims[1],Math.floor(j.index/dims[0]/dims[1])];
  const sources=sourceRuns(f).map(at);
  assert(sources.some(b=>b[0]===2),'a brick inside the reach the view asked for is a SOURCE');
  assert(sources.every(b=>reach(b)),`SOURCE jobs past every gather's reach: ${JSON.stringify(sources.filter(b=>!reach(b)))}`);
  assert(f.owner.atlas.lookup(far,READY.CELL).known,'the far brick is still loaded for the view');
  await settle(f.gpu,f.owner.discard(c));c.release();await f.close();
});

// Over the GPU page budget the view reads dropped bricks as air; a frame whose only misses are
// such bricks is settled as complete instead of extend() refusing it every frame (Descent,
// real Chrome 2026-10-22: "WORLD scene feedback made no dependency progress").
test('feedback missing only budget-dropped bricks settles as complete; any other miss stays',async()=>{
  const {worldSettleFeedback}=await import('../src/wire/worldRender.js');
  const dropped=new Set([5,9]),sunTiles=new Set([2]),index=r=>r.index,miss=(req,sun=[])=>({incomplete:true,requirements:req.map(i=>({index:i,channels:1})),sun});
  const settled=worldSettleFeedback(miss([5,9],[2]),{dropped,sunTiles,index});
  assert.equal(settled.incomplete,false);assert.deepEqual([...settled.requirements],[]);assert.deepEqual([...settled.sun],[]);
  for(const f of [miss([5,7]),miss([5],[3]),miss([]),{incomplete:false,requirements:[],sun:[]}])assert.equal(worldSettleFeedback(f,{dropped,sunTiles,index}),f);
  assert.equal(worldSettleFeedback(miss([5]),{dropped:new Set(),sunTiles,index}).incomplete,true,'nothing dropped: nothing settles');
});
// Misses that ask for nothing new (pages already required, gone since; an unresolved sign) rerun the
// attempt WORLD_IDLE_EXTENDS times, then settle: extend() threw "WORLD scene feedback made no dependency
// progress" and the big map stopped drawing (Island, live 2026-10-23).
test('feedback asking for nothing new settles once idle; a new page, channel or Sun tile never does',async()=>{
  const {worldSettleFeedback,WORLD_IDLE_EXTENDS}=await import('../src/wire/worldRender.js');
  assert(WORLD_IDLE_EXTENDS>=1);
  const dropped=new Set([5]),sunTiles=new Set([2]),requirements=new Map([[7,3],[8,1]]),index=r=>r.index;
  const miss=(req,sun=[])=>({incomplete:true,requirements:req.map(([i,c])=>({index:i,channels:c})),sun});
  const at=(f,idle)=>worldSettleFeedback(f,{dropped,sunTiles,index,requirements,idle});
  for(const f of [miss([[7,1],[8,1],[5,2]],[2]),miss([[7,3]]),miss([])])
    {assert.equal(at(f,false),f,'not idle yet: unchanged');assert.equal(at(f,true).incomplete,false,'idle: settled');}
  for(const f of [miss([[9,1]]),miss([[8,2]]),miss([[7,1]],[4])])assert.equal(at(f,true),f,'something new: never settled');
  const done={incomplete:false,requirements:[],sun:[]};assert.equal(at(done,true),done);
});
// The owner's extend() reruns instead of throwing for feedback asking for nothing new, at most WORLD_IDLE_EXTENDS times.
test('extend reruns an attempt for feedback that asks for nothing new, a bounded number of times',()=>{
  const src=readFileSync(new URL('../src/wire/worldRender.js',import.meta.url),'utf8');
  assert.match(src,/if\(!add\(t,feedback\.requirements,feedback\.sun,false,false,true\)\)\{if\(\(t\.idleExtends\?\?0\)>=WORLD_IDLE_EXTENDS\)throw [^;]*;t\.idleExtends=\(t\.idleExtends\?\?0\)\+1;\}t\.state='building';t\.work=runRetry\(t\);/);
  assert.match(src,/idle:\(t\.idleExtends\?\?0\)>=WORLD_IDLE_EXTENDS/);
  // (and an attempt's own unresolved asks that add nothing: runRetry runs it again, as many times)
  assert.equal(src.match(/\(t\.idleAttempts=\(t\.idleAttempts\?\?0\)\+1\)>WORLD_IDLE_EXTENDS\)throw new Error\('WORLD unresolved feedback made no dependency progress'\)/g)?.length,2,'the first run and every retry');
});
