// CPU-only: independent old serial oracle vs the three-stage pool model,
// plus production driver recording with strict, real uniform packing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { NativeJets } from '../../src/v2/jets.js';
import { PARTICLE_CAP as CAP, NEUTRON_TAG } from '../../src/v2/dynamics-reference.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { CONTROL } from '../../src/shaders/v2/particles.js';
import { ALLOCATION_CHUNKS, ALLOCATION_STAGES, allocationScratchBase, controlWords,
  externalMaskBase, externalMaskWords, blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { jetsWGSL } from '../../src/shaders/v2/jets.js';
const NONE=0xffffffff, WORDS=12;
const fresh=()=>({freeList:new Uint32Array(CAP).fill(0xdeadbeef),childPrefixes:new Uint32Array(CAP),control4:0});
function serialPool(records) {
  const out=fresh();let children=0;
  for(let i=0;i<CAP;i++) {
    const p=i*WORDS;
    if(records[p+3]===0) out.freeList[out.control4++]=i;
    out.childPrefixes[i]=NONE;
    if(records[p+3]!==0 && records[p+7]===NEUTRON_TAG && records[p+10]>0) {
      out.childPrefixes[i]=children;children=(children+records[p+10])>>>0;
    }
  }
  return out;
}
function bits(x) { let n=0;while(x) {x=(x&(x-1))>>>0;n++;}return n; }
function chunkPool(records) {
  const out=fresh(),tail=new Uint32Array(2048);
  // Workgroups are deliberately visited in reverse order in count/scatter.
  for(let chunk=1023;chunk>=0;chunk--) {
    const masks=new Uint32Array(2);let children=0;
    for(let lane=0;lane<64;lane++) {
      const p=(chunk*64+lane)*WORDS;
      if(records[p+3]===0) masks[lane>>>5]|=1<<(lane&31);
      if(records[p+3]!==0 && records[p+7]===NEUTRON_TAG && records[p+10]>0) children=(children+records[p+10])>>>0;
    }
    tail[2*chunk]=bits(masks[0])+bits(masks[1]);tail[2*chunk+1]=children;
  }
  let total=0,children=0;
  for(let chunk=0;chunk<1024;chunk++) {
    const f=tail[2*chunk],c=tail[2*chunk+1];
    tail[2*chunk]=total;tail[2*chunk+1]=children;
    total=(total+f)>>>0;children=(children+c)>>>0;
  }
  out.control4=total;
  const bases=tail.slice(),freeWrites=new Uint8Array(CAP),prefixWrites=new Uint8Array(CAP);
  for(let chunk=1023;chunk>=0;chunk--) {
    const masks=new Uint32Array(2),counts=new Uint32Array(64);
    for(let lane=0;lane<64;lane++) {
      const p=(chunk*64+lane)*WORDS;
      if(records[p+3]===0) masks[lane>>>5]|=1<<(lane&31);
      if(records[p+3]!==0 && records[p+7]===NEUTRON_TAG && records[p+10]>0) counts[lane]=records[p+10];
    }
    for(let lane=63;lane>=0;lane--) {
      const slot=chunk*64+lane;
      if(records[slot*WORDS+3]===0) {
        const before=((1<<(lane&31))-1)>>>0;
        const rank=bits(masks[lane>>>5]&before)+(lane>=32?bits(masks[0]):0);
        const dest=tail[2*chunk]+rank;
        out.freeList[dest]=slot;freeWrites[dest]++;
      }
      let prefix=NONE;
      if(counts[lane]>0) {
        prefix=tail[2*chunk+1];
        for(let previous=0;previous<lane;previous++) prefix=(prefix+counts[previous])>>>0;
      }
      out.childPrefixes[slot]=prefix;prefixWrites[slot]++;
    }
  }
  assert.deepEqual(tail,bases,'scatter never overwrites chunk bases');
  assert.ok(prefixWrites.every(n=>n===1));
  assert.ok(freeWrites.every((n,i)=>n===(i<total?1:0)),'free scatter writes disjoint contiguous ranks');
  return out;
}
function fixture(kind) {
  const records=new Uint32Array(CAP*WORDS);
  for(let slot=0;slot<CAP;slot++) {
    const p=slot*WORDS;
    for(let w=0;w<WORDS;w++) records[p+w]=(slot*1664525+w*1013904223)>>>0;
    records[p+3]=kind==='empty'?0:kind==='full'?slot+1:kind==='alternating'?(slot%2?slot+1:0):kind==='sparse'?(slot%997===0?slot+1:0):(slot%3?slot+1:0);
    records[p+7]=slot%7===0?NEUTRON_TAG|0x100:NEUTRON_TAG;
    records[p+10]=kind==='wrap'?[NONE,1,2,0,0xfffffffe][slot%5]:(slot%5);
  }
  return records;
}
for(const kind of ['empty','full','alternating','sparse','children','wrap']) test(`all 65536 records: ${kind} canonical free/child prefixes match serial u32 oracle`,()=>{
  const records=fixture(kind),before=records.slice();
  assert.deepEqual(chunkPool(records),serialPool(records));
  assert.deepEqual(records,before,'preparation must not mutate any particle word');
});

test('u32 child overflow and NONE sentinel cross both mask halves and chunk boundaries exactly',()=>{
  const records=new Uint32Array(CAP*WORDS);
  for(const [slot,count] of [[31,NONE],[32,1],[63,NONE],[64,2],[65535,NONE]]) {
    records[slot*WORDS+3]=slot+1;records[slot*WORDS+7]=NEUTRON_TAG;records[slot*WORDS+10]=count;
  }
  const result=chunkPool(records);assert.deepEqual(result,serialPool(records));
  assert.deepEqual([31,32,63,64,65535].map(i=>result.childPrefixes[i]),[0,NONE,0,NONE,1]);
  assert.equal(result.control4,CAP-5);
});

// Allocation consumers are unchanged. Compare outcomes using independently
// prepared pools, including state transitions across repeated service/retries.
function service(records,pool,requested,held,{external=false,token=0}={}) {
  if(external && requested>pool.control4) return {accepted:[],remaining:requested,done:false};
  const accepted=[];let rank=0;
  for(;rank<requested && rank<pool.control4;rank++) {
    const slot=pool.freeList[rank];records[slot*WORDS+3]=100000+rank;held[slot]=token;accepted.push(slot);
  }
  if(!external) for(let parent=0;parent<CAP;parent++) {
    const prefix=pool.childPrefixes[parent];if(prefix===NONE) continue;
    let count=records[parent*WORDS+10];
    for(let child=0;child<count;child++) {
      const childRank=(requested+prefix+child)>>>0;if(childRank>=pool.control4) break;
      const slot=pool.freeList[childRank];records[slot*WORDS+3]=200000+parent;held[slot]=0;accepted.push(slot);
    }
    records[parent*WORDS+10]=Math.max(0,count-Math.max(0,Math.min(count,pool.control4-((requested+prefix)>>>0))));
  }
  return {accepted,remaining:requested-rank,done:rank===requested};
}
test('backpressure, grid-before-children, held clearing and immutable external retry retain canonical outcomes',()=>{
  const a=fixture('children'),b=a.slice(),ha=new Uint32Array(CAP).fill(77),hb=ha.slice();
  const run=(requested,options)=>{
    const x=service(a,serialPool(a),requested,ha,options),y=service(b,chunkPool(b),requested,hb,options);
    assert.deepEqual(y,x);assert.deepEqual(b,a);assert.deepEqual(hb,ha);return y;
  };
  const before=a.slice();assert.equal(run(CAP,{external:true}).done,false);assert.deepEqual(a,before);
  const ext=run(4,{external:true});assert.deepEqual(ext.accepted,[0,3,6,9]);
  assert.equal(run(5,{token:123}).accepted[0],12);assert.equal(ha[12],123);
  // With the pool exhausted, pending work remains unchanged until a slot is freed.
  const failed=run(50,{external:true});assert.equal(failed.done,false);
  for(const slot of [1,32,63,64,65535]) {a[slot*WORDS+3]=0;b[slot*WORDS+3]=0;}
  assert.deepEqual(run(5,{external:true}).accepted,[1,32,63,64,65535]);
  assert.equal(ha[1],0,'reused slots clear old held ownership');
});

function recorder(gate=()=>Promise.resolve()) {
  globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,INDIRECT:8};
  const calls=[],descriptors=[];
  const copy=(b,offset,src)=>new Uint8Array(b.bytes).set(new Uint8Array(src.buffer??src,src.byteOffset??0,src.byteLength),offset);
  const gpu={
    createBuffer(d){return {...d,bytes:new ArrayBuffer(d.size),destroy(){}};},
    queue:{writeBuffer:copy},write:copy,layout:(name,entries)=>({name,entries}),
    bindGroup:(layout,entries)=>({layout,entries}),
    kernel(d){descriptors.push(d);return {...d,ready:gate(d.name),dispatch(frame,size,data){
      d.params.pack(data.params);calls.push({name:d.name,size,...data});
    }};},
    frame:{clear(){},copy(){}},readback:{buffer:(b,o,n)=>Promise.resolve(b.bytes.slice(o,o+n))},
  };
  const g=gridLayout(16,8,8),owner={gpu,g,tick:3,epoch:0,sim:{origin:[0,0,0],header:()=>({})},
    nativeDynamics:{head:nativeDynamicsHead,layout:{entries:V2_DYNAMICS_LAYOUT},group:{}},wake(){},_params:()=>({busyIn:1,busyOut:2})};
  owner.events=gpu.createBuffer({size:g.slots*4});
  const d=owner.dynamics=new NativeDynamics(owner,{blastBatch:2});
  return {owner,d,calls,descriptors};
}
function assertPrepared(calls,expected) {
  const allocations=calls.map((c,i)=>({c,i})).filter(({c})=>['v2blasts_allocate','v2jets_allocate'].includes(c.name));
  assert.equal(allocations.length,expected);
  for(const {c,i} of allocations) {
    const prep=calls.slice(i-3,i);
    assert.deepEqual(prep.map(p=>p.name),ALLOCATION_STAGES.map(s=>`v2blasts_${s}`));
    assert.deepEqual(prep.map(p=>p.size),[[1024,1,1],[1,1,1],[1024,1,1]]);
    for(const p of prep) assert.deepEqual(p.params,c.params,'preparation receives exactly the allocator uniforms');
  }
}
test('all real allocation paths prepare immediately, including empty indirect batches and external replay',async()=>{
  const {owner,d,calls}=recorder();await d.ready;
  const check=(fn,allocations)=>{calls.length=0;fn();assertPrepared(calls,allocations);};
  check(()=>d.consumeMaterialEvents(3),2);
  assert.equal(calls.find(c=>c.name==='v2blasts_allocate').size.indirect,d.dispatchArgs);
  check(()=>d.advanceAir(3),1);
  check(()=>assert.equal(d.applyToolImpulse({kind:'impulse',position:[2,2,2],strength:2}).status,'queued'),1);
  check(()=>assert.equal(d.applyBodyCoupling({lo:[1,1,1],hi:[3,3,3],velocity:[1,0,0]}).status,'queued'),1);
  check(()=>assert.equal(d.applyPhysgun({mode:'hold',position:[2,2,2]}).status,'queued'),1);
  d.releasePhysgun();
  check(()=>d.applyPhysgun({mode:'punt',position:[2,2,2]}),1);
  check(()=>assert.equal(d.applyExternalBlast({position:[2,2,2],energy:100,radius:2}).status,'queued'),1);
  assert.ok(calls.findIndex(c=>c.name==='v2blasts_allocate')<calls.findIndex(c=>c.name==='v2blasts_externalGate'));
  check(()=>d.consumeMaterialEvents(4),3); // unacknowledged immutable request replays first
  const snapshot=await d.snapshotDynamicState();assert.equal(snapshot.control.length,32);
  assert.equal(snapshot.externalBlasts.length,1);d.restoreDynamicState(snapshot);
  check(()=>d.consumeMaterialEvents(5),3);
  for(const kind of ['photon','neutron']) {
    d.applyToolImpulse({kind,position:[2,2,2],count:5});calls.length=0;
    d.advanceParticles(6);d.advanceAir(6);assertPrepared(calls,1);
    assert.ok(calls.findIndex(c=>c.name==='v2blasts_rayEmit')<calls.findIndex(c=>c.name==='v2blasts_freeCount'));
  }
  owner.liquidScratch={};owner.jetMask={};const jets=owner.jets=new NativeJets(owner);await jets.ready;
  check(()=>jets.advance(7,2),1);
  assert.deepEqual(calls.map(c=>c.name),['v2jets_candidate','v2jets_count',...ALLOCATION_STAGES.map(s=>`v2blasts_${s}`),'v2jets_allocate','v2jets_spawn']);
  jets.dispose();d.dispose();
});
test('preparation kernels build idle and every new stage is awaited; no optional missing-pipeline skip',async()=>{
  for(const stage of ALLOCATION_STAGES) {
    let resolve;const gate=new Promise(r=>resolve=r);
    const {d,descriptors}=recorder(name=>name===`v2blasts_${stage}`?gate:Promise.resolve());
    await Promise.resolve();assert.equal(d.isReady,false);assert.throws(()=>d._prepareAllocation(0),/not ready/);
    for(const s of ALLOCATION_STAGES) {
      const k=descriptors.find(k=>k.name===`v2blasts_${s}`);assert.equal(k.build,'idle');
      assert.deepEqual(k.workgroupSize,s==='freeScan'?[1,1,1]:[64,1,1]);
    }
    resolve();await d.ready;assert.equal(d.isReady,true);
    delete d.kernels['blasts/freeCount'];assert.throws(()=>d._prepareAllocation(0));d.dispose();
  }
  const {d}=recorder(name=>name==='v2blasts_freeScan'?Promise.reject(new Error('scan compile failed')):Promise.resolve());
  await assert.rejects(d.ready,/scan compile failed/);assert.equal(d.isReady,false);d.dispose();
});
test('scratch is exactly 8KiB after old external-mask end, without changed prefix/binding/save ABI',()=>{
  assert.equal(ALLOCATION_CHUNKS,1024);
  assert.equal(CONTROL.FREE_LIST,32);assert.equal(CONTROL.PREFIX,32+CAP);
  for(const dims of [[16,8,8],[128,128,128],[48,16,32]]) {
    const g=gridLayout(...dims),base=externalMaskBase(g)+externalMaskWords(g);
    assert.equal(allocationScratchBase(g),base);assert.equal((controlWords(g)-base)*4,8192);
    for(const stage of ALLOCATION_STAGES) {
      const code=blastsWGSL(g,nativeDynamicsHead,stage);
      assert.equal([...code.matchAll(/var<storage,/g)].length,8);
      assert.doesNotMatch(code.slice(code.lastIndexOf('@compute')),/particles\[[^\]]+\]\s*=/);
      assert.doesNotMatch(code,/array<[^>]*,\s*1024>/,'scan uses tail storage, not a large private array');
    }
    for(const code of [blastsWGSL(g,nativeDynamicsHead,'allocate'),jetsWGSL(g,'allocate')]) {
      const body=code.slice(code.lastIndexOf('@compute'));
      assert.doesNotMatch(body,/D_CAP|particles\[/,'allocation only scans per-brick demand');
    }
  }
});
