// CPU-only: independent old serial oracle vs the three-stage pool model,
// plus production driver recording with strict, real uniform packing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { PARTICLE_CAP as CAP, NEUTRON_TAG } from '../../src/v2/dynamics-reference.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { CONTROL } from '../../src/shaders/v2/particles.js';
import { assertNaga } from './wgsl-grouping.mjs';
import { ALLOCATION_CHUNKS, ALLOCATION_STAGES, allocationScratchBase, controlWords,
  externalMaskBase, externalMaskWords, blastsWGSL, SPAWN_PREFIX, COUPLE_ARGS, COUPLE_MODE, DISPATCH_ARGS_BYTES, LIST_ARGS, listsStageWGSL } from '../../src/shaders/v2/blasts.js';
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

// Execute only the generated workArgs straight-line integer subset on the CPU.
// The predicate and all three stored dispatch dimensions come from production WGSL.
// They now write the dispatch args themselves (the lists layout): run both buffers.
const mainBody=source=>{ const s=source.trimEnd(); return s.slice(s.lastIndexOf('fn main() {')+'fn main() {'.length,-1).replace(/\b(0x[\da-f]+|\d+)u\b/gi,'$1'); };
function executeWorkArgs(source,control,args,P) {
  Function('control','args','P','D_NONE','select',mainBody(source))(control,args,P,NONE,(no,yes,condition)=>condition?yes:no);
}
// The couple gate is integer code with one constant-bound loop: run it as JS too.
function executeCoupleGate(source,control,args) {
  Function('control','args','select',mainBody(source))(control,args,(no,yes,condition)=>condition?yes:no);
}
const listBuffers=data=>data.bind[1].entries.map(e=>new Uint32Array(e.resource.buffer.bytes));
function recorder(gate=()=>Promise.resolve()) {
  globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,INDIRECT:8};
  const calls=[],descriptors=[],copies=[];
  const copy=(b,offset,src)=>new Uint8Array(b.bytes).set(new Uint8Array(src.buffer??src,src.byteOffset??0,src.byteLength),offset);
  const gpu={
    createBuffer(d){return {...d,bytes:new ArrayBuffer(d.size),destroy(){}};},
    queue:{writeBuffer:copy},write:copy,layout:(name,entries)=>({name,entries}),
    bindGroup:(layout,entries)=>({layout,entries}),
    kernel(d){descriptors.push(d);return {...d,ready:gate(d.name),dispatch(frame,size,data){
      d.params.pack(data.params);
      if(d.name==='v2lists_workArgs') executeWorkArgs(d.code,...listBuffers(data),data.params);
      if(d.name==='v2lists_coupleGate') executeCoupleGate(d.code,...listBuffers(data));
      const args=size?.indirect?Array.from(new Uint32Array(size.indirect.bytes,size.offset??0,3)):size;
      calls.push({name:d.name,size,args,...data});
    }};},
    frame:{clear(){},copy(src,so,dst,dof,n){
      new Uint8Array(dst.bytes,dof,n).set(new Uint8Array(src.bytes,so,n));copies.push({src,so,dst,dof,n});
    }},readback:{buffer:(b,o,n)=>Promise.resolve(b.bytes.slice(o,o+n))},
  };
  const g=gridLayout(16,8,8),owner={gpu,g,tick:3,epoch:0,sim:{origin:[0,0,0],header:()=>({})},
    nativeDynamics:{head:nativeDynamicsHead,layout:{entries:V2_DYNAMICS_LAYOUT},group:{}},wake(){},_params:()=>({busyIn:1,busyOut:2})};
  owner.events=gpu.createBuffer({size:g.slots*4});
  const d=owner.dynamics=new NativeDynamics(owner,{blastBatch:2});
  return {owner,d,calls,descriptors,copies};
}
function assertPrepared(calls,expected) {
  const allocations=calls.map((c,i)=>({c,i})).filter(({c})=>['v2blasts_allocate'].includes(c.name));
  assert.equal(allocations.length,expected);
  for(const {c,i} of allocations) {
    const prep=calls.slice(i-3,i);
    assert.deepEqual(prep.map(p=>p.name),ALLOCATION_STAGES.map(s=>`v2blasts_${s}`));
    const indirect=!Array.isArray(c.size) && c.size?.indirect;
    assert.deepEqual(prep.map(p=>p.size),indirect?
      [{indirect:c.size.indirect,offset:c.size.offset+16},c.size,{indirect:c.size.indirect,offset:c.size.offset+16}]:
      [[1024,1,1],[1,1,1],[1024,1,1]]);
    for(const p of prep) assert.deepEqual(p.params,c.params,'preparation receives exactly the allocator uniforms');
  }
}
test('all real allocation paths prepare immediately, including empty indirect batches and external replay',async()=>{
  const {owner,d,calls}=recorder();await d.ready;
  const check=(fn,allocations)=>{calls.length=0;fn();assertPrepared(calls,allocations);};
  check(()=>d.consumeMaterialEvents(3),1); // one batch a tick
  assert.equal(calls.find(c=>c.name==='v2blasts_allocate').size.indirect,d.dispatchArgs);
  check(()=>d.advanceAir(3),1);
  check(()=>assert.equal(d.applyToolImpulse({kind:'impulse',position:[2,2,2],strength:2}).status,'queued'),1);
  check(()=>assert.equal(d.applyBodyCoupling({lo:[1,1,1],hi:[3,3,3],velocity:[1,0,0]}).status,'queued'),1);
  check(()=>assert.equal(d.applyPhysgun({mode:'hold',position:[2,2,2]}).status,'queued'),1);
  d.releasePhysgun();
  check(()=>d.applyPhysgun({mode:'punt',position:[2,2,2]}),1);
  check(()=>assert.equal(d.applyExternalBlast({position:[2,2,2],energy:100,radius:2}).status,'queued'),1);
  assert.ok(calls.findIndex(c=>c.name==='v2blasts_allocate')<calls.findIndex(c=>c.name==='v2blasts_externalGate'));
  check(()=>d.consumeMaterialEvents(4),2); // unacknowledged immutable request replays first
  const snapshot=await d.snapshotDynamicState();assert.equal(snapshot.control.length,32);
  assert.equal(snapshot.externalBlasts.length,1);d.restoreDynamicState(snapshot);
  check(()=>d.consumeMaterialEvents(5),2);
  for(const kind of ['photon','neutron']) {
    d.applyToolImpulse({kind,position:[2,2,2],count:5});calls.length=0;
    d.advanceParticles(6);d.advanceAir(6);assertPrepared(calls,1);
    assert.ok(calls.findIndex(c=>c.name==='v2blasts_rayEmit')<calls.findIndex(c=>c.name==='v2blasts_freeCount'));
  }
  d.dispose();
});
test('the couple gate skips pool preparation exactly when nothing is requested and no particle is live',async()=>{
  const {d,calls}=recorder();await d.ready;
  const control=new Uint32Array(d.control.bytes),g=d.g,counts=SPAWN_PREFIX+g.nbricks,groups=Math.ceil(g.nbricks/64);
  // With an empty pool the serial oracle frees every slot and finds no parent: what the gate writes.
  const empty=serialPool(new Uint32Array(CAP*WORDS));
  assert.equal(empty.control4,CAP);assert.ok(empty.childPrefixes.every(x=>x===NONE));
  for(const [live,demand,work] of [[0,0,false],[1,0,true],[0,3,true],[7,1,true]]) {
    control.fill(0);control[0]=live;control[4]=0xabc;control[5]=0xdef;
    calls.length=0;d.advanceAir(5);
    // count ran before the gate; seed its group sums the way count would have
    calls.length=0;control.fill(0,counts,counts+groups);control[counts+groups-1]=demand;control[0]=live;control[4]=0xabc;control[5]=0xdef;
    d._coupleAllocate(5);
    const names=calls.map(c=>c.name);
    assert.deepEqual(names,['v2blasts_count','v2lists_coupleGate',...ALLOCATION_STAGES.map(s=>`v2blasts_${s}`),'v2blasts_allocate','v2blasts_apply','v2blasts_children']);
    assert.ok(calls.every(c=>c.params.mode===COUPLE_MODE));
    const args=Object.fromEntries(calls.filter(c=>c.size?.indirect && c.name!=='v2blasts_apply').map(c=>[c.name,c.args]));
    const w=work?1:0;
    assert.deepEqual(args,{v2blasts_freeCount:[w,1024,1],v2blasts_freeScan:[w,1,1],v2blasts_freeScatter:[w,1024,1],v2blasts_allocate:[w,1,1],v2blasts_children:[w,1024,1]});
    assert.equal(calls.find(c=>c.name==='v2blasts_apply').size.offset,LIST_ARGS.windCells,'apply runs over the wind list, not behind the gate: fractures need no allocation');
    // skipped: the totals the skipped stages would have written; working: untouched by the gate
    assert.deepEqual([control[4],control[5]],work?[0xabc,0xdef]:[CAP,0]);
  }
  // red: a gate that ignored live particles would skip a pool with neutron parents
  const code=listsStageWGSL(g,'coupleGate');
  assert.match(code,/demand>0u \|\| control\[0\]>0u/);
  const red=new Uint32Array(control.length),redArgs=new Uint32Array(DISPATCH_ARGS_BYTES/4);red[0]=1;executeCoupleGate(code.replace('|| control[0]>0u',''),red,redArgs);
  assert.equal(red[4],CAP,'a gate without the live test would wrongly declare a live pool free');
  d.dispose();
});
test('preparation kernels build idle and every new stage is awaited; no optional missing-pipeline skip',async()=>{
  for(const stage of ALLOCATION_STAGES) {
    let resolve;const gate=new Promise(r=>resolve=r);
    const {d,descriptors,copies}=recorder(name=>name===`v2blasts_${stage}`?gate:Promise.resolve());
    await Promise.resolve();assert.equal(d.isReady,false);assert.throws(()=>d._prepareAllocation(0),/not ready/);
    assert.throws(()=>d._prepareAllocation(0,{}, {indirect:d.dispatchArgs,offset:32}),/not ready/);
    assert.equal(copies.length,0,'no indirect-argument copy before required pipelines are ready');
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
test('scratch is exactly 8KiB after old mask end, with unchanged existing offsets/bindings/save ABI',()=>{
  assert.equal(ALLOCATION_CHUNKS,1024);
  assert.equal(CONTROL.FREE_LIST,32);assert.equal(CONTROL.PREFIX,32+CAP);
  for(const dims of [[16,8,8],[128,128,128],[48,16,32]]) {
    const g=gridLayout(...dims),base=externalMaskBase(g)+externalMaskWords(g);
    assert.equal(allocationScratchBase(g),base);
    assert.equal((controlWords(g)-base)*4,8192);
    for(const stage of ALLOCATION_STAGES) {
      const code=blastsWGSL(g,nativeDynamicsHead,stage);
      assert.equal([...code.matchAll(/var<storage,/g)].length,8);
      assert.doesNotMatch(code.slice(code.lastIndexOf('@compute')),/particles\[[^\]]+\]\s*=/);
      assert.doesNotMatch(code,/array<[^>]*,\s*1024>/,'scan uses tail storage, not a large private array');
    }
    for(const code of [blastsWGSL(g,nativeDynamicsHead,'allocate')]) {
      const body=code.slice(code.lastIndexOf('@compute'));
      assert.doesNotMatch(body,/D_CAP|particles\[/,'allocation only scans request group sums');
      assert.match(body,/group<\(D_BRICKS\+63u\)\/64u/);
      assert.doesNotMatch(body,/PREFIX/,'allocator never overwrites local brick prefixes');
    }
  }
});

test('generated exact hasWork predicate gates all three prep dimensions, including wrapped/raw neutron obligations',async()=>{
  const {d,calls,copies}=recorder();await d.ready;
  const control=new Uint32Array(d.control.bytes);
  for(const [source,neutrons,children,mode,work] of [
    [NONE,0,0,0,false],[0,0,0,0,true],[NONE,1,0,0,true],
    [NONE,0,1,0,true],[NONE,1,0,14,false],[NONE,0,1,14,false],
    [0,0,0,14,true],[NONE,0,NONE,0,true],
  ]) {
    control[3]=source;control[17]=neutrons;control[18]=children;
    calls.length=0;copies.length=0;
    d._record('lists','workArgs',1,3,{mode}); // writes args 32 and 48 itself
    const priorCopies=copies.length;
    d._record('blasts','allocate',{indirect:d.dispatchArgs,offset:32},3,{mode});
    assertPrepared(calls,1);
    assert.deepEqual(calls.filter(c=>ALLOCATION_STAGES.some(s=>c.name===`v2blasts_${s}`)).map(c=>c.args),
      [[work?1:0,1024,1],[work?1:0,1,1],[work?1:0,1024,1]]);
    assert.equal(copies.length,priorCopies,'pool preparation reuses existing args without another copy');
  }
  control[3]=NONE;control[17]=0;control[18]=0;d.blastBatch=8;calls.length=0;
  d.consumeMaterialEvents(4);assertPrepared(calls,1); // one batch a tick, whatever blastBatch is
  const emptyPrep=calls.filter(c=>ALLOCATION_STAGES.some(s=>c.name===`v2blasts_${s}`));
  assert.equal(emptyPrep.length,3);
  for(const c of emptyPrep) assert.deepEqual(c.args,c.name==='v2blasts_freeScan'?[0,1,1]:[0,1024,1]);
  // A modular raw-neutron sum of zero was never an absence predicate. A
  // selected source or pending grid neutron must still run preparation.
  const code=listsStageWGSL(d.g,'workArgs');
  assert.match(code,/let hasWork=control\[3\]!=D_NONE \|\| \(P.mode!=14u && \(control\[17\]>0u \|\| control\[18\]>0u\)\)/);
  for(const count of [0,1,[0,1,1],[1,1,1]]) {
    calls.length=0;copies.length=0;
    d._record('blasts','allocate',count,3);assertPrepared(calls,1);
    assert.equal(copies.length,0,'direct descriptors do not consume workArgs scratch');
  }
  for(const count of [{indirect:d.control,offset:32},{indirect:d.dispatchArgs,offset:0}])
    assert.throws(()=>d._prepareAllocation(3,{},count),/Unsupported native allocation dispatch/);
  assert.equal(d.dispatchArgs.size,DISPATCH_ARGS_BYTES);
  // Both direct [1024,1,1] and reused [1,1024,1] cover each slot exactly once.
  for(const [nx,ny] of [[1024,1],[1,1024]]) {
    const seen=new Uint8Array(CAP);
    for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) for(let lane=0;lane<64;lane++) seen[(y*nx+x)*64+lane]++;
    assert.ok(seen.every(n=>n===1));
  }
  d.dispose();
});

// Independent full serial brick bases vs a model of the production 64-lane
// workgroup-local prefix and in-place group-sum scan. Requests are immutable.
function serialRequests(masks) {
  const prefix=new Uint32Array(masks.length/64);let total=0;
  for(let slot=0;slot<masks.length;slot++) {
    if(slot%64===0) prefix[slot/64]=total;
    total+=bits(masks[slot]);
  }
  return {prefix,total};
}
function hierarchicalRequests(masks) {
  const bricks=masks.length/64,local=new Uint32Array(bricks),groups=new Uint32Array(Math.ceil(bricks/64));
  for(let group=groups.length-1;group>=0;group--) {
    const demand=new Uint32Array(64);
    for(let lane=0;lane<64;lane++) {
      const brick=group*64+lane;
      if(brick<bricks) for(let slot=brick*64;slot<(brick+1)*64;slot++) demand[lane]+=bits(masks[slot]);
    }
    for(let lane=63;lane>=0;lane--) {
      let previous=0;for(let prior=0;prior<lane;prior++) previous+=demand[prior];
      if(group*64+lane<bricks) local[group*64+lane]=previous;
      if(lane===63) groups[group]=previous+demand[lane];
    }
  }
  let total=0;
  for(let group=0;group<groups.length;group++) {const count=groups[group];groups[group]=total;total+=count;}
  const prefix=local.map((value,brick)=>value+groups[brick>>>6]);
  return {prefix,total};
}
const registeredDims=[[64,64,64],[96,96,96],[128,128,128],[160,96,160],[256,96,128],[128,384,128]];
for(const bricks of [...new Set([1,16,63,64,65,127,129,...registeredDims.map(dims=>gridLayout(...dims).nbricks)])]) {
  test(`${bricks} bricks: full serial prefixes, slot/face ranks, backpressure and grid-before-child offsets`,()=>{
    for(const pattern of ['empty','dense','sparse','random','sixFaces','bodyBoxReject']) {
      const masks=new Uint8Array(bricks*64);let seed=bricks;
      for(let slot=0;slot<masks.length;slot++) {
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        masks[slot]=pattern==='empty'?0:pattern==='dense'?1:pattern==='sparse'?(slot%997===0?1:0):
          pattern==='sixFaces'?63:pattern==='bodyBoxReject'?(slot>=63*64+17 && slot<65*64-3?1:0):seed>>>26;
      }
      const serial=serialRequests(masks),hier=hierarchicalRequests(masks);
      assert.deepEqual(hier,serial,pattern);
      let rank=0,mismatch=false,within=0;
      const frees=[0,1,31,64,CAP];
      const serialAccepted=frees.map(()=>0),hierAccepted=frees.map(()=>0);
      for(let slot=0;slot<masks.length;slot++) {
        if(slot%64===0) within=0;
        // dRank and jet spawn add the same immutable within-brick/face order.
        let faceRank=hier.prefix[slot>>>6]+within;
        for(let face=0;face<6;face++) if(masks[slot]&(1<<face)) {
          if(faceRank!==rank) mismatch=true;
          for(let i=0;i<frees.length;i++) {serialAccepted[i]+=+(rank<frees[i]);hierAccepted[i]+=+(faceRank<frees[i]);}
          rank++;faceRank++;within++;
        }
      }
      assert.equal(mismatch,false,`${pattern}: every requested slot/face rank is exact`);
      assert.deepEqual(hierAccepted,serialAccepted,`${pattern}: identical pressure/accepted faces`);
      for(const childPrefix of [0,1,63,64,NONE]) {
        assert.equal((hier.total+childPrefix)>>>0,(serial.total+childPrefix)>>>0,'children start after all grid requests');
      }
      for(const free of frees) assert.equal(hier.total>free,serial.total>free,'external whole-request gate and retry identical');
    }
  });
}

test('minimum-world partial request group count and allocation modules validate with CPU Naga',()=>{
  const g=gridLayout(16,8,8);assert.equal(g.nbricks,16);
  for(const stage of ['count','allocate']) for(const [family,source] of [
    ['blasts',blastsWGSL(g,nativeDynamicsHead,stage)],
  ]) assertNaga(source,`${family}-${stage}`);
});

test('request counts retain all lanes at barriers and only group sums occupy the old count region',()=>{
  for(const g of [gridLayout(16,8,8),gridLayout(48,16,32),gridLayout(128,128,128)]) {
    assert.match(blastsWGSL(g,nativeDynamicsHead,'apply'),/atomicLoad\(&control\[D_SPAWN_PREFIX\+b\]\)\+atomicLoad\(&control\[D_SPAWN_COUNTS\+b\/64u\]\)/);
    for(const source of [blastsWGSL(g,nativeDynamicsHead,'count')]) {
      const body=source.slice(source.lastIndexOf('@compute'));
      // only a whole group skips (uniformly, before the barrier: tools/v2/group-skip-check.mjs)
      assert.equal([...body.matchAll(/return;/g)].length,1,'out-of-range and rejected box lanes cannot skip workgroupBarrier');
      assert.match(body,/if\(workgroupUniformLoad\(&wgCounted\)==0u\) \{ return; \}/);
      assert.ok(body.indexOf('return;')<body.indexOf('workgroupBarrier()'));
      assert.match(body,/brickDemand\[li\]=\w+; workgroupBarrier\(\)/);
      assert.match(body,/COUNTS\+t\/64u/);
      assert.match(body,/PREFIX\+t\],prefix/);
      assert.doesNotMatch(source,/array<[^>]*,\s*1024>/);
      assert.ok([...source.matchAll(/var<storage,/g)].length<=8);
    }
  }
});
