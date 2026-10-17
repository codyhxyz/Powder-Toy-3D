// Real history + GI factories, delayed fake native transport. Not GPU parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorldLightingHistory,validateWorldGIInitialization} from '../src/world/worldLightingHistory.js';
import {createWorldGI} from '../src/gfx/worldGI.js';
import {lightingFixture} from './world-gi-glow-fixture.mjs';
const M=[1,1,1],B=[2,1,1],C=[3,1,1];
const record=brick=>({brick,age:0,matter:true,near:false});
const id=b=>b[0]+16*(b[1]+32*b[2]);
const closed={incomplete:false,requirements:[],sun:[]};
async function fixture(){
  const f=lightingFixture(),h=createWorldLightingHistory({worldSize:[64,128,64],epoch:1});
  let plan;const acquire=f.snapshotProvider.acquire;
  const provider={isCurrent:f.snapshotProvider.isCurrent,async acquire(args){
    const p=await acquire(args),previous=plan.capturePrevious({indices:args.probeIndices});
    return {...p,previous,initialization:args.initialization,sourcePhaseToken:plan.initialization?.sourcePhaseToken,
      release(){previous.release();p.release();}};
  }};
  const gi=createWorldGI(f.gpu,{g:f.g,snapshotProvider:provider,readerBindingProvider:f.readerBindingProvider,feedbackProvider:f.feedbackProvider});
  async function produce({sourceBricks=plan.sourceBricks,gatherBricks=plan.gatherBricks,complete=true}={}){
    const c=await gi.prepare({lightingTick:plan.lightingTick,reset:plan.lightingTick===0,configVersion:1,sourceBricks,gatherBricks,initialization:plan.initialization});
    assert.equal(c.status,'prepared');const done=c.record();
    if(!complete)return {c,done};
    await f.complete();assert.equal((await done).status,'published');return gi.snapshot();
  }
  plan=h.begin({lightingTick:0,globalKey:[1],records:[record(M)],mode:2,initialization:{cutToken:1,sourceBricks:[M],probeBricks:[M],records:[record(M)]}});
  const first=await produce();first.bindings().history.words.fill(0x44004400); // synthetic bright packed-half transport fixture
  plan.stage(first).seal({cutToken:1,feedback:closed}).commit();first.release();
  return {...f,h,gi,produce,setPlan(p){plan=p;},get plan(){return plan;},dispose(){h.dispose();gi.dispose();}};
}
function packed(f,brick){const p=f.h.capture({lightingTick:f.h.lightingTick,indices:[id(brick)]}),dst=f.device.createBuffer({size:32});p.recordHistory(f.frame,{indices:[id(brick)],destination:dst,format:'band-major-4x-vec2u'});p.release();return [...dst.words];}

test('same-clock explicit birth preserves bright known history and retained sources; normal clock then advances once',async()=>{
  const f=await fixture(),before=packed(f,M),oldSources=f.h.captureSources({indices:[id(M)]}),old=oldSources.bindingsFor(id(M));
  const p=f.h.beginBirth({cutToken:1,sourceBricks:[B],probeBricks:[B],records:[record(B)]});f.setPlan(p);
  const source=await f.produce({gatherBricks:[]});p.stage(source);source.release();
  assert.equal(p.sourcesComplete,true);
  const gather=await f.produce({sourceBricks:[]});p.stage(gather);gather.release();
  p.seal({cutToken:1,feedback:closed}).commit();
  assert.equal(f.h.lightingTick,0);assert.equal(f.h.birth(id(B)).birthTick,0);assert.deepEqual(packed(f,M),before);
  const now=f.h.captureSources({indices:[id(M)]});assert.equal(now.bindingsFor(id(M)).buffer,old.buffer);assert.equal(now.bindingsFor(id(M)).token,old.token);now.release();oldSources.release();
  assert.throws(()=>f.h.beginBirth({cutToken:1,sourceBricks:[M]}),/recompute retained/);
  assert.throws(()=>f.h.beginBirth({cutToken:2,sourceBricks:[C]}),/committed cut/);
  const next=f.h.begin({lightingTick:1,globalKey:[1],records:[record(M),record(B)]});f.setPlan(next);
  const output=await f.produce();next.commit(output);output.release();assert.equal(f.h.lightingTick,1);
  assert.throws(()=>f.h.begin({lightingTick:1,globalKey:[1],records:[record(M),record(B)]}),/advance exactly once/);
  f.dispose();
});

test('reflective self misses expand a persistent cohort, while raw/field/Sun dependencies never become zero',async()=>{
  const f=await fixture(),p=f.h.beginBirth({cutToken:1,sourceBricks:[B]});f.setPlan(p);
  const oldManifest=p.initialization;
  const missing=p.expandFeedback({incomplete:true,requirements:[{index:id(B),channels:16},{index:id(C),channels:8|7}],sun:[9]});
  assert.deepEqual(missing.requirements,[{index:id(C),channels:15}]);assert(p.initialization.indices.includes(id(B)));assert(!p.initialization.indices.includes(id(C)),'source-only air/liquid paths have no invented probe owner');
  assert.throws(()=>validateWorldGIInitialization(oldManifest,{epoch:1,lightingTick:0,previousToken:oldManifest.previousToken,cutToken:1}),/stale/);
  p.expand({records:[record(B)]});
  assert.throws(()=>p.seal({cutToken:1,feedback:closed}),/complete source\/gather/);
  const source=await f.produce({gatherBricks:[]});p.stage(source);source.release();
  assert.throws(()=>p.seal({cutToken:1,feedback:closed}),/complete source\/gather/,'a zero seed/source result does not adopt a probe');
  const gather=await f.produce({sourceBricks:[]});p.stage(gather);gather.release();
  assert.throws(()=>p.seal({cutToken:1,feedback:{...closed,sun:[9]}}),/dependency closure/);
  p.seal({cutToken:1,feedback:closed}).commit();assert(f.h.birth(id(B)));assert.equal(f.h.birth(id(C)),null);f.dispose();
});

test('two private source slabs precede every gather slab, and adoption is atomic across all slabs',async()=>{
  const f=await fixture(),before=packed(f,M),p=f.h.beginBirth({cutToken:1,sourceBricks:[B,C],probeBricks:[B,C],records:[record(B),record(C)]});f.setPlan(p);
  const a=await f.produce({sourceBricks:[B],gatherBricks:[]});p.stage(a);a.release();
  await assert.rejects(f.gi.prepare({lightingTick:0,reset:true,configVersion:1,sourceBricks:[],gatherBricks:[B],initialization:p.initialization}),/SOURCE phase/);
  assert.equal(f.h.birth(id(B)),null);
  const b=await f.produce({sourceBricks:[C],gatherBricks:[]});p.stage(b);b.release();
  const lease=p.captureStagedSources();assert.equal(lease.outputs.length,2);assert.equal(lease.token,p.initialization.sourcePhaseToken);
  const nativeSources=lease.outputs.map(o=>o.bindings().source);
  const c=await f.produce({sourceBricks:[],gatherBricks:[B]});p.stage(c);c.release();
  assert.throws(()=>p.seal({cutToken:1,feedback:closed}),/complete source\/gather/);assert.deepEqual(packed(f,M),before);
  const d=await f.produce({sourceBricks:[],gatherBricks:[C]});p.stage(d);d.release();
  const phases=f.events.filter(e=>e.startsWith('dispatch:world GI ')).slice(-4);
  assert.deepEqual(phases,['dispatch:world GI source','dispatch:world GI source','dispatch:world GI gather','dispatch:world GI gather']);
  p.seal({cutToken:1,feedback:closed}).commit();assert(f.h.birth(id(B)));assert(f.h.birth(id(C)));assert.deepEqual(packed(f,M),before);f.dispose();
  assert(nativeSources.every(b=>!b.dead));lease.release();assert(nativeSources.every(b=>b.dead));
});

test('forged/duplicate/known-owner initialization and stale manifest cache hits reject without changing authoritative history',async()=>{
  const f=await fixture(),before=packed(f,M),p=f.h.beginBirth({cutToken:1,sourceBricks:[B],probeBricks:[B],records:[record(B)]});f.setPlan(p);
  assert.throws(()=>validateWorldGIInitialization({...p.initialization},{epoch:1,lightingTick:0,previousToken:p.initialization.previousToken,cutToken:1}),/invalid/);
  assert.throws(()=>p.expand({probeBricks:[B]}),/duplicate/);assert.throws(()=>p.expand({probeBricks:[M]}),/existing/);
  const old=p.initialization,s=await f.produce({gatherBricks:[]});p.stage(s);s.release();
  p.expand({sourceBricks:[C]});
  await assert.rejects(f.gi.prepare({lightingTick:0,reset:true,configVersion:1,sourceBricks:[B],gatherBricks:[],initialization:old}),/manifest/);
  const next=await f.produce({sourceBricks:[B],gatherBricks:[]});assert.notEqual(next.token.initialization,old);next.release();
  p.abort();assert.deepEqual(packed(f,M),before);assert.equal(f.h.birth(id(B)),null);f.dispose();
});
test('a failed cohort expansion preserves its manifest, worklists, birth flags and completed private source ownership',async()=>{
  const f=await fixture(),p=f.h.beginBirth({cutToken:1,sourceBricks:[B],probeBricks:[B],records:[record(B)]});f.setPlan(p);
  const source=await f.produce({gatherBricks:[]});p.stage(source);const native=source.bindings().source;source.release();
  const manifest=p.initialization;
  assert.throws(()=>p.expand({sourceBricks:[C],probeBricks:[C],records:[record(C),{...record(C),age:-1}]}),/age\/matter\/near/);
  assert.equal(p.initialization,manifest);assert.equal(p.sourcesComplete,true);assert.equal(native.dead,false);
  assert.deepEqual(p.sourceBricks,[B]);assert.deepEqual(p.gatherBricks.map(r=>r.brick),[B]);assert.deepEqual(manifest.indices,[id(B)]);
  assert.throws(()=>validateWorldGIInitialization(manifest,{epoch:1,lightingTick:0,sourceIndices:[id(C)],previousToken:manifest.previousToken,cutToken:1}),/outside/);
  const gather=await f.produce({sourceBricks:[]});p.stage(gather);gather.release();p.seal({cutToken:1,feedback:closed}).commit();
  assert(f.h.birth(id(B)));assert.equal(f.h.birth(id(C)),null);f.dispose();
});
test('mixed mature and born previous slots preserve native half words when only the born ranges are cleared',async()=>{
  const f=await fixture(),before=packed(f,M);
  const p=f.h.begin({lightingTick:1,globalKey:[1],records:[record(M),record(B)],initialization:{cutToken:1,sourceBricks:[B],probeBricks:[B],records:[record(B)]}});f.setPlan(p);
  const previous=p.capturePrevious({indices:[id(M),id(B)]}),dst=f.device.createBuffer({size:64});
  dst.words.fill(0xffffffff);previous.recordHistory(f.frame,{indices:[id(M),id(B)],destination:dst,format:'band-major-4x-vec2u'});
  for(let k=0;k<4;k++){
    assert.deepEqual([...dst.words.subarray(k*4,k*4+2)],before.slice(k*2,k*2+2));
    assert.deepEqual([...dst.words.subarray(k*4+2,k*4+4)],[0,0]);
  }
  previous.release();p.abort();dst.destroy();f.dispose();
});

test('unknown inputs and reversed failed outputs cannot adopt births; disposal keeps queued pins through rejected final submission and completion',async()=>{
  const f=await fixture(),before=packed(f,M),p=f.h.beginBirth({cutToken:1,sourceBricks:[B],probeBricks:[B],records:[record(B)]});f.setPlan(p);
  f.state.missing=true;
  const c=await f.gi.prepare({lightingTick:0,reset:true,configVersion:1,sourceBricks:[B],gatherBricks:[B],initialization:p.initialization});
  const done=c.record();await f.complete();assert.equal((await done).status,'incomplete');assert.equal(f.h.birth(id(B)),null);assert.deepEqual(packed(f,M),before);
  f.state.missing=false;const queued=await f.produce({gatherBricks:[],complete:false});
  const t=f.tickets.at(-1);f.h.dispose();assert.equal(f.state.pins,1);t.submitted.reject(new Error('final discarded'));
  await Promise.resolve();await Promise.resolve();assert.equal(f.state.pins,1);
  t.done.resolve();assert.equal((await queued.done).status,'failed');assert.equal(f.state.pins,0);f.gi.dispose();
});

test('new ordinary tick can initialize never-owned probes without resetting mature neighbors',async()=>{
  const f=await fixture(),before=packed(f,M);
  const p=f.h.begin({lightingTick:1,globalKey:[1],records:[record(M),record(B)],initialization:{cutToken:1,sourceBricks:[B],probeBricks:[B],records:[record(B)]}});f.setPlan(p);
  const output=await f.produce();p.stage(output);output.release();
  p.seal({cutToken:1,feedback:closed}).commit();assert.equal(f.h.lightingTick,1);assert.equal(f.h.birth(id(B)).birthTick,1);
  // M has opposite checkerboard parity at tick1; its original native bits persist.
  assert.deepEqual(packed(f,M),before);f.dispose();
});

test('reversed failed source slabs preserve staged native data and allow same-seed retry',async()=>{
  const f=await fixture(),before=packed(f,M),p=f.h.beginBirth({cutToken:1,sourceBricks:[B,C],probeBricks:[B,C],records:[record(B),record(C)]});f.setPlan(p);
  const prepare=sourceBricks=>f.gi.prepare({lightingTick:0,reset:true,configVersion:1,sourceBricks,gatherBricks:[],initialization:p.initialization});
  const a=await prepare([B]),ad=a.record(),ta=f.tickets.at(-1);
  const b=await prepare([C]),bd=b.record();await f.complete();assert.equal((await bd).status,'published');
  const retained=f.gi.snapshot();p.stage(retained);retained.release();
  ta.submitted.reject(new Error('older source final encoder discarded'));assert.equal((await ad).status,'failed');
  assert.equal(p.sourcesComplete,false);assert.deepEqual(packed(f,M),before);assert.equal(f.h.birth(id(C)),null);
  const retry=await f.produce({sourceBricks:[B],gatherBricks:[]});p.stage(retry);retry.release();
  const gather=await f.produce({sourceBricks:[]});p.stage(gather);gather.release();
  p.seal({cutToken:1,feedback:closed}).commit();assert(f.h.birth(id(B)));assert(f.h.birth(id(C)));f.dispose();
});

test('reset and epoch changes cannot adopt queued initialization or authorize old manifests',async()=>{
  const f=await fixture(),before=packed(f,M),p=f.h.beginBirth({cutToken:1,sourceBricks:[B],probeBricks:[B],records:[record(B)]});f.setPlan(p);
  const queued=await f.produce({gatherBricks:[],complete:false});f.gi.reset();assert.equal(f.state.pins,1);
  await f.complete();assert.equal((await queued.done).status,'stale');assert.equal(f.state.pins,0);assert.equal(f.h.birth(id(B)),null);assert.deepEqual(packed(f,M),before);
  f.state.epoch=2;
  await assert.rejects(f.gi.prepare({lightingTick:0,reset:true,configVersion:1,sourceBricks:[B],gatherBricks:[],initialization:p.initialization}),/birth manifest/);
  assert.throws(()=>validateWorldGIInitialization(p.initialization,{epoch:2,lightingTick:0,previousToken:p.initialization.previousToken,cutToken:1}),/birth manifest/);
  p.abort();f.dispose();
});
