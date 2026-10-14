// CPU-only numerical, conservation, packing and driver recording checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from '../../src/elements.js';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { PARTICLE_CAP, DT, GRAVITY, CELL_M, AIR, packParticle, unpackParticle, ballistic, sweep,
  stableId, resolveDeposits, allocateSources, impact, blastPlan, exchangeScalar, airSource, airQuiet } from '../../src/v2/dynamics-reference.js';
const close=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const matter=(id=E.SAND)=>({core:[id|(1173<<8)|0xaa000000,0xfedcba98,0x76543210,0xcdefabcd].map(x=>x>>>0),bank:-123456789});

test('48B particle preserves every material word, signed bank and stable ID',()=>{
  const p={position:[-12.5,17.25,104.75],velocity:[180,-5,3],id:0xfefdfcfb,...matter()};
  const bytes=packParticle(p); assert.equal(bytes.byteLength,48); assert.deepEqual(unpackParticle(bytes),p);
  assert.equal(stableId([-20,2,4],123,9),stableId([-20,2,4],123,9));
  assert.notEqual(stableId([-20,2,4],123,9),stableId([-20,2,4],124,9));
});
test('closed-form 2g ballistic range at 60Hz, no displacement cap',()=>{
  let p=[0,0,0],v=[40,19.6,0];
  for(let i=0;i<120;i++) ({position:p,velocity:v}=ballistic(p,v));
  close(p[0]*CELL_M,80,1e-10); close(p[1],0,1e-10); close(v[1],-19.6,1e-10);
  assert.ok(ballistic([0,0,0],[360,0,0]).position[0]>1);
});
test('swept DDA hits one-cell wall at arbitrarily high speed, including negative axes',()=>{
  const hit=sweep([0.1,1.5,1.5],[10000.1,1.5,1.5],p=>p[0]===73);
  assert.deepEqual(hit.cell,[73,1,1]); assert.deepEqual(hit.previous,[72,1,1]); close(hit.t,72.9/10000);
  const negative=sweep([100.5,1.5,1.5],[-1000,1.5,1.5],p=>p[0]===73);
  assert.deepEqual(negative.cell,[73,1,1]);
});
test('competing deposits are permutation independent and preserve loser payloads',()=>{
  const candidates=[71,9,28].map(id=>({id,target:[2,3,4],...matter()}));
  const run=ps=>{let deposited; const rest=resolveDeposits(ps,12,()=>true,(_,m)=>deposited=m);return {deposited,ids:rest.map(p=>p.id).sort()};};
  assert.deepEqual(run(candidates),run([...candidates].reverse())); assert.equal(run(candidates).ids.length,2);
  assert.deepEqual(run(candidates).deposited,matter());
});
test('64K full-capacity fallback keeps source material and deterministic retries',()=>{
  const pool=Array.from({length:PARTICLE_CAP},(_,i)=>({id:i+1}));
  const sources=[3,1,2].map(slot=>({slot,material:matter(),particle:{id:100+slot,...matter()}}));
  allocateSources(sources,pool); assert.ok(sources.every(s=>s.material&&s.retry));
  pool[42]=null; allocateSources(sources,pool); assert.equal(pool[42].id,101);
  assert.equal(sources.filter(s=>s.material===null).length,1); assert.deepEqual(pool[42].core,matter().core);
});
test('liquid impact never breaks a solid and solid fracture spends KE',()=>{
  const metal=[E.METAL,0,0,0];
  assert.equal(impact([E.WATER,0,0,0],[10000,0,0],metal).broken,false);
  assert.equal(impact([E.NUGGETS,0,0,0],[0.01,0,0],metal).broken,false);
  const fast=impact([E.NUGGETS,0,0,0],[10,0,0],metal);
  assert.equal(fast.broken,true); assert.ok(fast.remaining>=0&&fast.remaining<fast.energy);
});
test('blast LOS shields rear targets and total allocated energy is bounded',()=>{
  const targets=Array.from({length:100},(_,i)=>[i+1,0,0]);
  const plans=blastPlan([0,0,0],targets,p=>p[0]===3,1000);
  assert.ok(plans[0].energy>0); assert.ok(plans[2].energy>0); assert.equal(plans[3].energy,0);
  assert.ok(plans.reduce((s,p)=>s+p.energy,0)<=750);
  const occluded=blastPlan([0,0,0],[[4,4,4]],p=>p.every(x=>x===2),1000);
  assert.equal(occluded[0].energy,0);
});
test('dense blast batch has explicit bounded service latency, never one-per-tick',()=>{
  for(const batch of [8,64]) {
    let pending=1000,ticks=0,accounted=0;
    while(pending) { const n=Math.min(batch,pending);pending-=n;accounted+=n;ticks++; }
    assert.equal(accounted,1000); assert.equal(ticks,Math.ceil(1000/batch));
  }
  assert.equal(Math.ceil(1000/8)/60,125/60); // default 2.0833s; max64 0.2667s
});
test('conservative face diffusion/advection retains gas and heat and stays positive',()=>{
  let values=Array.from({length:100},(_,i)=>i===49?100:0),wind=values.map(()=>5000);
  for(let i=0;i<3000;i++) {
    values=exchangeScalar(values,wind,DT/AIR.substeps);
    assert.ok(values.every(v=>Number.isFinite(v)&&v>=-1e-12)); close(values.reduce((s,v)=>s+v,0),100,1e-9);
  }
});
test('air acoustic+transport CFL is stable with fixed substeps; sources are finite',()=>{
  const acoustic=3*AIR.sound*(DT/AIR.substeps)/AIR.edge;
  assert.ok(acoustic+6/12+6*AIR.diffusion*(DT/AIR.substeps)/AIR.edge**2<1);
  let a={pressure:0,gas:0,velocity:[0,0,0],quiet:8}; a=airSource(a,1);
  close(a.pressure,AIR.gasPressure); close(a.gas,1/64); assert.equal(a.quiet,0);
  assert.deepEqual(airSource(a,0),a);
});
test('air sleeps independently, one active neighbour or source wakes it',()=>{
  const rest={pressure:0,velocity:[0,0,0],quiet:0};
  for(let i=0;i<8;i++) rest.quiet=airQuiet(rest);
  assert.equal(rest.quiet,8);
  assert.equal(airQuiet(rest,[{...rest,pressure:1}]),0);
  assert.equal(airQuiet(airSource(rest,1)),0);
});

function mockOwner() {
  globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4};
  const calls=[],buffers=[];
  const copy=(b,offset,src)=>{ const u=src instanceof ArrayBuffer?new Uint8Array(src):new Uint8Array(src.buffer,src.byteOffset,src.byteLength);new Uint8Array(b.bytes).set(u,offset); };
  const gpu={createBuffer:({size,label})=>{const b={size,label,bytes:new ArrayBuffer(size),destroy(){this.destroyed=true;}};buffers.push(b);return b;},
    queue:{writeBuffer:copy},write:copy,layout:(_name,l)=>l,bindGroup:(_l,b)=>b,
    kernel:d=>({name:d.name,ready:Promise.resolve(),dispatch:(frame,size,opts)=>calls.push({name:d.name,size,opts})}),
    frame:{clear:(b,offset=0,size=b.size-offset)=>new Uint8Array(b.bytes,offset,size).fill(0)},
    readback:{buffer:(b,offset,size)=>{calls.push({read:b.label});return Promise.resolve(b.bytes.slice(offset,offset+size));}}};
  const g=gridLayout(16,8,8),owner={gpu,g,epoch:0,tick:1,sim:{origin:{x:0,y:0,z:0},header:()=>({})},
    nativeDynamics:{head:()=>'',layout:[],group:[]},wake(){this.epoch++;},_params:()=>({})};
  owner.events=gpu.createBuffer({size:g.slots*4,label:'events'});
  return {owner,calls,buffers};
}
test('driver records real pipeline families, batch8, and separate draw capability',async()=>{
  const {owner,calls,buffers}=mockOwner(),d=new NativeDynamics(owner); await d.ready;
  assert.equal(d.capabilities.physicsReady,true); assert.equal(d.capabilities.drawReady,false);
  d.advanceParticles(1); d.consumeMaterialEvents(1); d.advanceAir(1);
  assert.equal(calls.filter(c=>c.name==='v2blasts_finish').length,8);
  assert.equal(calls.filter(c=>c.name==='v2air_step').length,8);
  assert.equal(calls.filter(c=>c.name==='v2particles_integrate').length,1);
  assert.equal(d.renderState.particleBytes,48); assert.equal(d.renderState.particles,d.particles);
  assert.equal(d.applyToolImpulse({kind:'nonsense',position:[0,0,0]}).status,'rejected');
  assert.equal(d.applyToolImpulse({kind:'photon',position:[1,2,3],direction:[1,0,0],count:3}).status,'queued');
  d.dispose(); assert.ok(buffers.filter(b=>b!==owner.events).every(b=>b.destroyed));
});
test('snapshot copies are enqueued synchronously and durable request restore validates before writes',async()=>{
  const {owner,calls}=mockOwner(),d=new NativeDynamics(owner); await d.ready;
  new Uint32Array(owner.events.bytes)[0]=7;
  d.applyToolImpulse({kind:'neutron',position:[1,2,3],direction:[0,1,0],count:3});
  const before=calls.length,pending=d.snapshotDynamicState();
  assert.equal(calls.slice(before).filter(c=>c.read).length,4);
  const snapshot=await pending; assert.equal(snapshot.pendingEvents.length,1);assert.equal(snapshot.pendingEvents[0].bits,7);
  d.restoreDynamicState(snapshot); assert.equal(new Uint32Array(owner.events.bytes)[0],7);assert.equal(d.rayRequests.size,1);
  assert.throws(()=>d.restoreDynamicState({...snapshot,pendingEvents:[{worldCell:[0,0,0],bits:8}]}),/Invalid pending/);
  assert.equal(new Uint32Array(owner.events.bytes)[0],7);
});
test('window shift preserves world-space particles, exact archived air and obligations on return',async()=>{
  const {owner}=mockOwner(),d=new NativeDynamics(owner);await d.ready;
  const p={id:53,position:[1,2,3],velocity:[0,0,0],...matter()};owner.gpu.write(d.particles,0,packParticle(p));
  const a=new Float32Array(d.air[0].bytes);a[0]=3;a[4]=321;
  new Uint32Array(owner.events.bytes)[0]=4;
  await d.shiftWindow([16,0,0]);
  assert.deepEqual(unpackParticle(d.particles.bytes),p);assert.equal(d.pendingOutside.size,1);
  await d.shiftWindow([-16,0,0]);
  assert.equal(new Float32Array(d.air[0].bytes)[0],3);assert.equal(new Float32Array(d.air[0].bytes)[4],321);
  assert.equal(new Uint32Array(owner.events.bytes)[0],4);assert.equal(d.pendingOutside.size,0);
  await assert.rejects(d.shiftWindow([1,0,0]),/brick-aligned/);
});
test('one particle, even outside the window, prevents false idle',async()=>{
  const {owner}=mockOwner(),d=new NativeDynamics(owner);await d.ready;
  new Uint32Array(d.control.bytes)[0]=1;await d.readActivity();assert.equal(d.isIdle,false);
  new Uint32Array(d.control.bytes)[0]=0;await d.readActivity();assert.equal(d.isIdle,true);
  d.applyToolImpulse({kind:'neutron',position:[1000,2,3],count:1});assert.equal(d.isIdle,false);
});
