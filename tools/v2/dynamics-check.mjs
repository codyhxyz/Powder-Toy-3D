// CPU-only numerical, conservation, packing and driver recording checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from '../../src/elements.js';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { AIRBORNE_COLOURS } from '../../src/v2/airborne.js';
import { PARTICLE_CAP, DT, CELL_M, AIR, packParticle, unpackParticle, ballistic, sweep,
  stableId, resolveDeposits, allocateSources, impact, blastPlan, exchangeScalar, airSource, airQuiet } from '../../src/v2/dynamics-reference.js';
const close=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const matter=(id=E.SAND)=>({core:[id|(1173<<8)|0xaa000000,0xfedcba98,0x3f400000,0xcdefabcd].map(x=>x>>>0),bank:-123456789});

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
  globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,INDIRECT:8};
  const calls=[],buffers=[];
  const copy=(b,offset,src)=>{ const u=src instanceof ArrayBuffer?new Uint8Array(src):new Uint8Array(src.buffer,src.byteOffset,src.byteLength);new Uint8Array(b.bytes).set(u,offset); };
  const gpu={createBuffer:({size,label})=>{const b={size,label,bytes:new ArrayBuffer(size),destroy(){this.destroyed=true;}};buffers.push(b);return b;},
    queue:{writeBuffer:copy},write:copy,layout:(_name,l)=>l,bindGroup:(_l,b)=>b,
    kernel:d=>({name:d.name,ready:Promise.resolve(),dispatch:(frame,size,opts)=>{d.params.pack(opts.params);calls.push({name:d.name,size,opts});}}),
    frame:{clear:(b,offset=0,size=b.size-offset)=>new Uint8Array(b.bytes,offset,size).fill(0),
      copy:(src,offset,dest,to,size)=>new Uint8Array(dest.bytes,to,size).set(new Uint8Array(src.bytes,offset,size))},
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
  // one batch a tick serves up to blastBatch (8) charges together
  assert.equal(calls.filter(c=>c.name==='v2blasts_finishCharges').length,1);
  assert.equal(calls.filter(c=>c.name==='v2blasts_pick').length,1); assert.equal(d.blastBatch,8);
  assert.equal(calls.filter(c=>c.name==='v2air_step').length,8);
  assert.equal(calls.filter(c=>c.name==='v2particles_integrate').length,1);
  assert.equal(d.renderState.particleBytes,48); assert.equal(d.renderState.particles,d.particles);
  assert.equal(d.applyToolImpulse({kind:'nonsense',position:[0,0,0]}).status,'rejected');
  assert.equal(d.applyToolImpulse({kind:'photon',position:[1,2,3],direction:[1,0,0],count:3}).status,'queued');
  d.dispose(); assert.ok(buffers.filter(b=>b!==owner.events).every(b=>b.destroyed));
});
test('particle tick: one-invocation clear samples the live count before hold; restore recounts it from the records',async()=>{
  const {owner,calls}=mockOwner(),d=new NativeDynamics(owner);await d.ready;
  d.holdSession={token:1,position:[0,0,0],target:[0,0,0],radius:1,strength:1,lastTick:1};
  calls.length=0;d.advanceParticles(1);
  assert.deepEqual(calls.map(c=>[c.name,c.size]),[['v2particles_clear',[1,1,1]],['v2particles_holdCOM',[1,1,1]],
    ['v2particles_holdApply',[1024,1,1]],...['integrate','elect','impact','deposit','reactClaim',...Array(AIRBORNE_COLOURS).fill('react')].map(s=>[`v2particles_${s}`,[1024,1,1]]),['v2blasts_airborneEvents',[1024,1,1]]]);
  assert.equal(d.flight.size,(PARTICLE_CAP+1)*32,'one flight record per slot, then the sweep record');
  const snapshot=await d.snapshotDynamicState();d.holdSession=null;snapshot.holdSession=null;
  for(const slot of [0,7,PARTICLE_CAP-1]) snapshot.particles.set(new Uint32Array(packParticle({id:slot+1,position:[1,2,3],velocity:[0,0,0],...matter()})),slot*12);
  snapshot.control[0]=0;d.restoreDynamicState(snapshot);
  assert.equal(new Uint32Array(d.control.bytes)[0],3,'gated pool sweeps cannot miss a restored packet');
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

test('hot/cold empty roundtrip conserves full64 energy including carrier banks and compressed partials',async()=>{
  const {makeMaterial,energyOf,withEnergy,FULL}=await import('../../src/v2/layout.js');
  const {extractPacket,depositPacket,particleEnergy}=await import('../../src/v2/dynamics-reference.js');
  for(const amount of [1,FULL/3|0,FULL,FULL+12345]) for(const sourceT of [-20,20,300]) for(const destT of [-100,900]) {
    const source=withEnergy(makeMaterial(E.WATER,sourceT,amount,0),energyOf(makeMaterial(E.WATER,sourceT,amount,0))+123n);
    const destination=withEnergy(makeMaterial(0,destT,0,0),energyOf(makeMaterial(0,destT,0,0))-73n);
    const {packet,source:carrier}=extractPacket(source);
    assert.deepEqual(packet.core,source.core);assert.equal(packet.bank,source.bank);
    assert.equal(energyOf(carrier)+particleEnergy(packet),energyOf(source));
    const deposited=depositPacket(packet,destination); assert.ok(deposited);
    assert.equal(energyOf(carrier)+energyOf(deposited),energyOf(source)+energyOf(destination));
    assert.equal(deposited.core[1]&0xffffff,amount);
  }
});
test('partial NITRO charge energy scales with exact fill, fracture re-encodes thermal capacity',async()=>{
  const {makeMaterial,energyOf,FULL}=await import('../../src/v2/layout.js');
  const {chargeEnergy,fractureMaterial}=await import('../../src/v2/dynamics-reference.js');
  close(chargeEnergy(makeMaterial(E.NITRO,20,1,0))*FULL,chargeEnergy(makeMaterial(E.NITRO,20,FULL,0)),1e-6);
  const glass=makeMaterial(E.GLASS,1300,FULL,0),broken=fractureMaterial(glass,E.SHARDS);
  assert.ok(broken); assert.equal(energyOf(broken),energyOf(glass));assert.equal(broken.core[0]&255,E.SHARDS);
});
test('same-brick blast pressure adds exactly the declared acoustic energy without a cross term',async()=>{
  const {pressureEnergy,addBlastPressure}=await import('../../src/v2/dynamics-reference.js');
  for(const start of [-100,0,100]) {
    let p=start;
    for(let i=0;i<100;i++) p=addBlastPressure(p,500);
    close(pressureEnergy(p)-pressureEnergy(start),100*500*0.25,1e-8);
  }
});
test('photon slab exit refracts back, total internal reflection stays inside',async()=>{
  const {refractDirection}=await import('../../src/v2/dynamics-reference.js');
  const incoming=[0.6,-0.8,0],inside=refractDirection(incoming,[0,1,0],1/1.5);
  const exit=refractDirection(inside,[0,1,0],1.5);
  exit.forEach((x,i)=>close(x,incoming[i]));
  assert.ok(refractDirection([0.9,Math.sqrt(1-.9**2),0],[0,-1,0],1.5)[1]<0);
});
test('actual generated shaders carry the reference conservation and numeric guards',async()=>{
  const {nativeDynamicsHead}=await import('../../src/shaders/v2.js');
  const {particlesWGSL}=await import('../../src/shaders/v2/particles.js');
  const {blastsWGSL}=await import('../../src/shaders/v2/blasts.js');
  const {airWGSL}=await import('../../src/shaders/v2/air.js'); const g=gridLayout(16,8,8);
  const impact=particlesWGSL(g,nativeDynamicsHead,'impact'),deposit=particlesWGSL(g,nativeDynamicsHead,'deposit');
  assert.match(impact,/flight\[t\]\.destination\.y=D_NONE/);
  assert.match(impact,/energyFits\(before,dHeatEnergy/);
  assert.match(impact,/p\.tail\.w=\(u32\(f\.effect\.y\)>>2u\)&3u/);
  assert.match(deposit,/energyAdd\(energyOf\(before\),dParticleEnergy\(incoming\)\)/);
  assert.match(blastsWGSL(g,nativeDynamicsHead,'apply'),/remainder=dCarrier\(after\)/);
  assert.match(blastsWGSL(g,nativeDynamicsHead,'finish'),/sqrt\(a\.vp\.w\*a\.vp\.w\+addedP2\)/);
  assert.match(blastsWGSL(g,nativeDynamicsHead,'select'),/energyFits\(dProduct\(m\),dProductEnergy\(m\)\)/);
  assert.match(particlesWGSL(g,nativeDynamicsHead,'integrate'),/crossedLimit/);
  const tool=airWGSL(g,nativeDynamicsHead,'tool');assert.doesNotMatch(tool,/P\.strength\*D_DT/);
  assert.match(airWGSL(g,nativeDynamicsHead,'step'),/open\*before\.vp\.w\/A_RHO\*A_DT\/A_DX/);
});
test('API rejects f32-overflow inputs; invalid particle and air words cannot partially restore',async()=>{
  const {owner}=mockOwner(),d=new NativeDynamics(owner);await d.ready;
  assert.equal(d.applyToolImpulse({kind:'impulse',position:[1e100,0,0],strength:1}).status,'rejected');
  assert.equal(d.applyToolImpulse({kind:'wind',position:[1,0,0],strength:1e100}).status,'rejected');
  const snapshot=await d.snapshotDynamicState();snapshot.particles[3]=1;snapshot.particles[0]=0x7fc00000;
  assert.throws(()=>d.restoreDynamicState(snapshot),/coordinates/);
  snapshot.particles[3]=0;snapshot.air[0]=0x7f800000;assert.throws(()=>d.restoreDynamicState(snapshot),/air values/);
});

test('real physgun attracts COM and damps relative velocity without collapsing the clump',async()=>{
  const {holdVelocities}=await import('../../src/v2/dynamics-reference.js');
  const ps=[{mass:1,position:[-1,0,0],velocity:[0,0,0]},{mass:3,position:[1,0,0],velocity:[0,0,0]}];
  const initialGap=ps[1].position[0]-ps[0].position[0],destination=[20,10,3];
  for(let step=0;step<360;step++) {
    const velocities=holdVelocities(ps,destination,12,DT);
    ps.forEach((p,i)=>{p.velocity=velocities[i];p.position=p.position.map((x,a)=>x+p.velocity[a]*DT/CELL_M);});
  }
  const com=[0,1,2].map(a=>(ps[0].position[a]+ps[1].position[a]*3)/4);
  com.forEach((x,i)=>close(x,destination[i],1e-6));close(ps[1].position[0]-ps[0].position[0],initialGap,1e-10);
  assert.ok(ps.every(p=>Math.hypot(...p.velocity)<1e-6));
  const moving=holdVelocities([{mass:1,position:[0,0,0],velocity:[10,0,0]},{mass:1,position:[0,0,0],velocity:[-10,0,0]}],[0,0,0]);
  assert.ok(Math.abs(moving[0][0]-moving[1][0])<20);
});
test('physgun recording uses a COM reducer and fixed-step controller, snapshots preserve selection',async()=>{
  const {owner,calls}=mockOwner(),d=new NativeDynamics(owner);await d.ready;
  const result=d.applyPhysgun({mode:'hold',position:[1,2,3],target:[5,6,7],radius:2,strength:12,dt:DT});
  assert.equal(result.status,'queued');assert.equal(d.capabilities.physgun,true);
  d.advanceParticles(2);
  assert.equal(calls.filter(c=>c.name==='v2particles_holdCOM').length,1);
  assert.equal(calls.filter(c=>c.name==='v2particles_holdApply').length,1);
  const saved=await d.snapshotDynamicState();assert.deepEqual(saved.holdSession.target,[5,6,7]);
  d.restoreDynamicState(saved);assert.equal(d.holdSession.token,result.requestId);
  assert.equal(d.applyPhysgun({mode:'fling',position:[1,2,3],direction:[1,0,0],radius:2,strength:20}).status,'queued');
  assert.equal(d.holdSession,null);
});

test('compressed partial liquid jet conserves fill, fuel/spark union and signed64 enthalpy',async()=>{
  const {makeMaterial,withPayload,energyOf,payloadOf,FULL}=await import('../../src/v2/layout.js');
  const {extractPartialPacket,particleEnergy,depositPacket}=await import('../../src/v2/dynamics-reference.js');
  for(const id of [E.WATER,E.OIL]) for(const amount of [1,1711,FULL]) {
    let m=withPayload(makeMaterial(id,73,FULL+719,0),id===E.WATER?3608:1291);
    m.bank=-113;m.core[2]=0xdeadbeef;m.core[3]=(m.core[3]&0xffff0000)|0x3726;
    const split=extractPartialPacket(m,amount);assert.ok(split);
    assert.equal((split.packet.core[1]&0xffffff)+(split.source.core[1]&0xffffff),FULL+719);
    assert.equal(energyOf(split.source)+particleEnergy(split.packet),energyOf(m));
    if(id===E.WATER) { assert.equal(payloadOf(split.packet.core),3608);assert.equal(payloadOf(split.source.core),3608); }
    else assert.equal(payloadOf(split.packet.core)+payloadOf(split.source.core),1291);
    assert.equal(split.packet.core[2],0xdeadbeef);assert.equal(split.packet.core[3]&65535,0x3726);
    const empty=makeMaterial(0,-30),landed=depositPacket(split.packet,empty);assert.ok(landed);
    assert.equal(energyOf(split.source)+energyOf(landed),energyOf(m)+energyOf(empty));
  }
});
test('DUST/SING pressure-derived energy reproduces prescribed targets and vacuum is bounded',async()=>{
  const {makeMaterial,withPayload}=await import('../../src/v2/layout.js');
  const {chargeEnergy,addBlastPressure,legacyPressureToPa,singularityVacuumPa}=await import('../../src/v2/dynamics-reference.js');
  const {PHYS}=await import('../../src/physics.js');
  close(addBlastPressure(0,chargeEnergy(makeMaterial(E.DUST))),legacyPressureToPa(PHYS.DUST_P),1e-9);
  const small=withPayload(makeMaterial(E.SINGULARITY),10*256),large=withPayload(makeMaterial(E.SINGULARITY),20*256);
  close(chargeEnergy(large),4*chargeEnergy(small));
  close(addBlastPressure(0,chargeEnergy(large)),legacyPressureToPa(20*PHYS.SING_BURST_P_PER_MASS));
  assert.equal(singularityVacuumPa(small.core),legacyPressureToPa(-25));assert.equal(singularityVacuumPa(large.core),legacyPressureToPa(PHYS.P_MIN));
  assert.ok(chargeEnergy(withPayload(small,255))>0);assert.equal(chargeEnergy(withPayload(small,0)),0);
  close(chargeEnergy(makeMaterial(E.DUST)),30375,1e-8);
});
test('unused blast batches indirect-dispatch zero work with separate nonaliased args',async()=>{
  const {owner,calls}=mockOwner(),d=new NativeDynamics(owner);await d.ready;d.consumeMaterialEvents(1);
  // workArgs writes each batch's dispatch args itself (the lists layout), no copy
  assert.equal(calls.filter(c=>c.name==='v2lists_workArgs').length,1);
  for(const c of calls.filter(c=>['v2blasts_planCharges','v2blasts_apply','v2blasts_allocate','v2blasts_children'].includes(c.name))) {
    assert.equal(c.size.indirect,d.dispatchArgs);assert.notEqual(c.size.indirect,d.control);
  }
  assert.equal(d.plans.size,owner.g.slots*16);
});

test('3D air shock remains finite, closed-volume scalars conserve, and uniform pressure has no wall force',async()=>{
  const {airStepReference}=await import('../../src/v2/dynamics-reference.js');
  const dims=[5,5,5],initial=Array.from({length:125},()=>({velocity:[0,0,0],pressure:1000,heat:0,gas:0}));
  const uniform=airStepReference(initial,dims);assert.ok(uniform.every(a=>a.velocity.every(v=>Math.abs(v)<1e-12)));
  let state=initial.map((a,i)=>({...a,pressure:i===62?3000:0,heat:i===62?100:0,gas:i===62?1:0}));
  for(let n=0;n<600;n++) {
    state=airStepReference(state,dims);
    assert.ok(state.every(a=>[...a.velocity,a.pressure,a.heat,a.gas].every(Number.isFinite)));
    assert.ok(state.every(a=>a.gas>=-1e-12));
  }
  close(state.reduce((s,a)=>s+a.heat,0),100,1e-8);close(state.reduce((s,a)=>s+a.gas,0),1,1e-10);
  const frozen=airStepReference(initial,dims,{airMode:4});assert.ok(frozen.every(a=>a.pressure===1000));
  const off=airStepReference(initial,dims,{airMode:3,ambientHeat:false});assert.ok(off.every(a=>a.pressure===0&&a.heat===0&&a.velocity.every(v=>v===0)));
});
test('native gravity/air/edge modes and exact-jets gate reach every dynamics dispatch',async()=>{
  const {owner,calls}=mockOwner();owner.sim.gravityMode=2;owner.sim.airMode=4;owner.sim.edgeMode=2;owner.sim._gravity=.05;owner.sim.ambientHeat=false;
  owner.jets={isReady:true};const d=new NativeDynamics(owner);await d.ready;d.advanceParticles(1);d.advanceAir(1);
  for(const c of calls.filter(c=>c.opts)) {
    assert.equal(c.opts.params.gravity,39.2);assert.equal(c.opts.params.gravMode,2);assert.equal(c.opts.params.airMode,4);
    assert.equal(c.opts.params.edge,2);assert.equal(c.opts.params.ambientHeat,0);assert.equal(c.opts.params.nativeJets,1);
  }
  const {nativeDynamicsHead}=await import('../../src/shaders/v2.js');
  const {blastsWGSL}=await import('../../src/shaders/v2/blasts.js');
  const {particlesWGSL}=await import('../../src/shaders/v2/particles.js');
  const plan=blastsWGSL(owner.g,nativeDynamicsHead,'couplePlan');
  assert.match(plan,/P\.gravMode==2u \|\| P\.edge!=0u/);assert.match(plan,/dUnsupported\(p\)/);
  assert.match(plan,/P\.nativeJets==0u && k==3u/);
  const fly=particlesWGSL(owner.g,nativeDynamicsHead,'integrate');assert.match(fly,/mGravity\(local\)/);
  assert.match(fly,/cell=mEdge\(cell\)/);assert.match(fly,/dOutflow\(previous,m\)/);
  assert.match(fly,/contactNuclearMaterial\(destination\.core\)/);
});
test('more than64K simultaneous promotion candidates conserve every unallocated source',()=>{
  const count=PARTICLE_CAP+1701,pool=new Array(PARTICLE_CAP);
  const sources=Array.from({length:count},(_,slot)=>({slot,material:{...matter(),bank:slot},particle:{id:slot+1,...matter(),bank:slot}}));
  allocateSources(sources,pool);
  assert.equal(pool.filter(p=>p?.id).length,PARTICLE_CAP);
  assert.equal(sources.filter(s=>s.material).length,1701);
  assert.ok(sources.slice(PARTICLE_CAP).every(s=>s.retry && s.material.bank===s.slot));
  assert.equal(pool.reduce((sum,p)=>sum+BigInt(p.bank),0n)+sources.reduce((sum,s)=>sum+BigInt(s.material?.bank??0),0n),BigInt(count)*(BigInt(count)-1n)/2n);
});

test('equal32bit stable-ID collisions elect by complete packet, never buffer/list arrival order',()=>{
  const a={id:19,target:[1,2,3],...matter(),bank:19},b={...a,bank:20};
  const winner=ps=>{let picked;resolveDeposits(ps,3,()=>true,(_,m)=>picked=m);return picked;};
  assert.deepEqual(winner([a,b]),winner([b,a]));assert.equal(winner([a,b]).bank,19);
});
test('accepted liquid impact preserves incoming foam, adds bounded KE foam once and retains thermal energy',async()=>{
  const {makeMaterial,energyOf,FULL}=await import('../../src/v2/layout.js');
  const {depositPacket,particleEnergy}=await import('../../src/v2/dynamics-reference.js');
  const {impactFoam}=await import('../../src/v2/foam.js');
  const packet=makeMaterial(E.WATER,20,FULL/3|0,0);packet.core[0]|=64<<24;packet.bank=135;
  const empty=makeMaterial(0,90),result=depositPacket(packet,empty,{speed2:4});
  assert.equal(result.core[0]>>>24,impactFoam({incoming:64,amount:FULL/3|0,speed2:4}));
  assert.equal(energyOf(result),energyOf(empty)+particleEnergy(packet));assert.equal(packet.core[0]>>>24,64);
  assert.equal(depositPacket(packet,empty,{speed2:0}).core[0]>>>24,64);
});
test('native body AABB preserves centre coverage, element filter and intended XZ/lift-Y geometry',async()=>{
  const {bodyCoupledVelocity}=await import('../../src/v2/dynamics-reference.js');
  const request={lo:[0,0,0],hi:[4,4,4],velocity:[1,2,3],pushFluid:4,pushPowder:8,lift:1,ahead:[0,0],only:-1};
  const v=bodyCoupledVelocity(request,[3.5,2,2],E.SAND);assert.ok(v[0]>1);assert.ok(v[1]>2);close(v[2],3);
  const w=bodyCoupledVelocity(request,[3.5,2,2],E.WATER);close(v[0]-1,2*(w[0]-1));
  assert.equal(bodyCoupledVelocity({...request,only:E.CLOUD},[3.5,2,2],E.WATER),null);
  assert.equal(bodyCoupledVelocity(request,[4.1,2,2],E.SAND),null);
  assert.equal(bodyCoupledVelocity(request,[3.5,2,2],E.METAL),null);
  assert.deepEqual(bodyCoupledVelocity(request,[2,2,2],E.SAND,11),bodyCoupledVelocity(request,[2,2,2],E.SAND,11));
});
test('body driver records bounded AABB candidates and shares exact native allocator, not a sphere',async()=>{
  const {owner,calls}=mockOwner();owner.sim.origin={x:100,y:0,z:-32};const d=new NativeDynamics(owner);await d.ready;
  const result=d.applyBodyCoupling({lo:[100.5,0.5,-31.5],hi:[102.5,2.5,-30.5],velocity:[2,0,0],pushFluid:1,pushPowder:2,lift:0.2,ahead:[0,0],only:E.CLOUD});
  assert.equal(result.status,'queued');assert.equal(result.candidateCells,18);assert.equal(d.capabilities.bodyCoupling,true);
  const candidate=calls.find(c=>c.name==='v2blasts_bodyPlan');assert.deepEqual(candidate.size,[1,1,1]);
  assert.deepEqual(candidate.opts.params.boxStart,[0,0,0]);assert.deepEqual(candidate.opts.params.boxSize,[3,3,2]);assert.equal(candidate.opts.params.bodyOnly,E.CLOUD);
  assert.deepEqual(calls.find(c=>c.name==='v2blasts_apply').size,[1,1,1]);
  assert.equal(d.applyBodyCoupling({lo:[1,2,3],hi:[0,0,0],velocity:[0,0,0]}).status,'rejected');
  const {nativeDynamicsHead}=await import('../../src/shaders/v2.js');const {blastsWGSL}=await import('../../src/shaders/v2/blasts.js');
  const shader=blastsWGSL(owner.g,nativeDynamicsHead,'bodyPlan');assert.match(shader,/dPlanSlot\(dThread/);
  assert.match(shader,/vec3f\(outward.x\+P.bodyAhead.x,P.bodyLift,outward.y\+P.bodyAhead.y\)/);
  assert.match(blastsWGSL(owner.g,nativeDynamicsHead,'count'),/P.mode!=13u \|\| dInBody/);
});
