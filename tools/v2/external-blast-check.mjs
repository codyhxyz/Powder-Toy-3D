// CPU only: actual router/recording driver, binary persistence, numerical budget
// and generated shader guards. This is not a claim of GPU execution.
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Simulation, gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { externalBlastBase, blastsWGSL, rayRequestBase, PLAN } from '../../src/shaders/v2/blasts.js';
import { FULL } from '../../src/v2/layout.js';
import { encodeDynamicState, decodeDynamicState } from '../../src/v2/dynamicState.js';
import { externalBlastPressure, externalBlastBudget, validateExternalBlasts, externalBlastVelocity } from '../../src/v2/externalBlast.js';
import { blastPlan, pressureEnergy, dynamicsRows } from '../../src/v2/dynamics-reference.js';
import { povGpu } from '../../src/pov/gpu.js';
import { TOOLS, E } from '../../src/elements.js';
import { AIR } from '../../src/v2/pressure.js';

globalThis.GPUBufferUsage = { STORAGE:128, COPY_SRC:4, COPY_DST:8, INDIRECT:256 };
const commands=[], writes=[];
const make=({size,label})=>({size,label,bytes:new ArrayBuffer(size),destroy(){}});
const write=(b,at,a)=>{writes.push(b.label);new Uint8Array(b.bytes).set(new Uint8Array(a.buffer,a.byteOffset,a.byteLength),at);};
const gpu={createBuffer:make,queue:{writeBuffer:write},write,layout:(_n,e)=>e,bindGroup:(_l,e)=>e,
  kernel:({name,code,params})=>({name,code,ready:Promise.resolve(),dispatch(_f,_n,o){params.pack(o.params);commands.push({name,p:o.params});}}),
  frame:{clear(b,at=0,n=b.size-at){new Uint8Array(b.bytes,at,n).fill(0);},copy(){}},
  readback:{buffer:(b,at,n)=>Promise.resolve(b.bytes.slice(at,at+n))}};
const g=gridLayout(16,8,8),sim=Object.assign(Object.create(Simulation.prototype),{
  g,gpu,origin:new Vector3(),version:0,compact:true,wake(){},header(){return {};},edit(){throw Error('legacy edit forbidden');}
});
const owner={g,gpu,sim,tick:0,epoch:0,wake(){},sync(){},nativeDynamics:{head:nativeDynamicsHead,layout:V2_DYNAMICS_LAYOUT,group:{}},events:make({size:g.slots*4,label:'events'})};
const d=new NativeDynamics(owner,{blastBatch:1});owner.dynamics=d;sim.compactOwner=owner;await d.ready;
const blast=TOOLS.find(t=>t.key==='BLAST').id;
assert.equal(sim.paint({center:new Vector3(4,4,4),radius:2,shape:0,tool:blast}),true);
assert.equal(d.externalBlasts.size,1);
assert.equal(sim.paint({center:new Vector3(4,4,4),radius:2,shape:1,tool:blast}),true);
assert.equal(sim.paint({center:new Vector3(4,4,4),radius:2,shape:0,tool:blast,filter:E.SAND}),true);
assert.equal(povGpu(sim).edit('povRocket',{lo:[-10,-10,-10],hi:[20,20,20]},{center:[4,4,4]}),true);
assert.equal(d.applyExternalBlast({position:[200,0,0],radius:2,energy:100}).status,'queued');
const mask=new Uint8Array(g.width*g.height);mask[12]=255;
assert.equal(sim.paint({center:new Vector3(4,4,4),end:new Vector3(9,4,4),grow:[2,1,0],radius:2,shape:1,tool:blast,filter:E.SAND,mask:{lo:[1,1,1],hi:[6,6,6],data:mask}}),true);
mask[12]=0;const selection=d.externalBlasts.get(5).selection;
assert.equal(new Uint8Array(selection.maskWords.buffer)[12],255,'queued masks own immutable bytes');
assert.deepEqual(selection.end,[9,4,4]);assert.deepEqual(selection.grow,[2,1,0]);assert.equal(selection.filter,E.SAND);
assert.deepEqual(selection.lo,[1,1,1]);assert.deepEqual(selection.hi,[6,6,6]);
const stages=commands.slice(0,16).map(c=>c.name.split('_')[1]);
assert.deepEqual(stages,['externalBegin','workArgs','plan','externalParticlePlan','sum','normalize','damagePlan','count','freeCount','freeScan','freeScatter','allocate','externalGate','externalParticleApply','apply','finish']);
// One batch a tick: the external blast keeps its single-charge stages (mode 14), then the grid's
// charges run once through the charge stages, never the external ones.
commands.length=0;d.consumeMaterialEvents(1);
const tickStages=commands.map(c=>c.name.split('_')[1]),firstBatch=tickStages.indexOf('reset');
assert.ok(firstBatch>0 && tickStages.slice(0,firstBatch).includes('plan') && tickStages.slice(0,firstBatch).includes('finish'));
assert.deepEqual(tickStages.slice(firstBatch).filter(s=>['plan','sum','normalize','damagePlan','finish'].includes(s)),[],'the batch never runs the external stages');
assert.deepEqual(tickStages.slice(firstBatch).filter(s=>s.endsWith('Charges')||s==='pick'),['pick','planCharges','normalizeCharges','damageCharges','finishCharges']);
assert.ok(commands.slice(0,firstBatch).filter(c=>['plan','normalize','finish'].includes(c.name.split('_')[1])).every(c=>c.p.mode===14),'the external stages run in mode 14 only');
// Completion flags stay GPU-authoritative across repeated recordings, snapshots,
// and restores. No readback is required between a blast and the next tick.
const flags=new Uint32Array(d.control.bytes);flags[externalBlastBase(g)]=1;
d.consumeMaterialEvents(1);d.consumeMaterialEvents(2);
assert.equal(flags[externalBlastBase(g)],1,'recording must not reset completion');
const snapshot=await d.snapshotDynamicState(),saved=decodeDynamicState(encodeDynamicState(snapshot));
assert.equal(saved.externalBlasts.length,6);assert.equal(saved.externalBlastDone[0],1);assert.deepEqual(saved.externalBlasts[5].selection,selection);
d.restoreDynamicState(saved);assert.equal(flags[externalBlastBase(g)],1);
await d.shiftWindow([4,0,0]);assert.deepEqual(d.externalBlasts.get(5).selection.maskOrigin,[0,0,0]);
assert.deepEqual(d.externalBlasts.get(5).selection.lo,[1,1,1]);assert.equal(d.externalBlasts.get(5).selection.maskWords[3],255);
d.restoreDynamicState(saved);
assert.deepEqual(d.externalBlasts.get(4).position,[200,0,0],'out-of-window obligation survives');
const before=writes.length,bad=structuredClone(saved);bad.externalBlasts[0].energy=NaN;
assert.throws(()=>d.restoreDynamicState(bad),/external blast/);assert.equal(writes.length,before);
for(const mutate of [s=>s.externalBlasts[5].selection.maskWords=null,s=>s.externalBlasts[5].selection.maskOrigin=null,s=>s.externalBlasts[5].selection.lo=[9,9,9],s=>s.externalBlastDone=null,s=>s.externalBlasts=null,s=>delete s.externalBlastDone,s=>s.externalBlastDone[63]=1,s=>s.externalBlastDone[0]=2,s=>s.externalBlasts.push({...s.externalBlasts[0]}),s=>s.externalBlasts[0].requestId=s.sequence+1]) {
  const invalid=structuredClone(saved);mutate(invalid);assert.throws(()=>validateExternalBlasts(invalid));
  assert.throws(()=>encodeDynamicState(invalid));const prior=writes.length;assert.throws(()=>d.restoreDynamicState(invalid));assert.equal(writes.length,prior);
}
const ack=d.readActivity();d._work();await ack;assert.equal(d.externalBlasts.size,5,'completed requests acknowledged only after GPU flag read');
const acknowledged=await d.snapshotDynamicState();assert.equal(acknowledged.externalBlastDone[0],0,'retired slots cannot create orphan save flags');
for(let i=d.externalBlasts.size;i<64;i++) assert.equal(d.applyExternalBlast({position:[200,0,0],radius:1,energy:1}).status,'queued');
assert.equal(d.applyExternalBlast({position:[1,1,1],radius:1,energy:1}).status,'rejected');
// Normative numerical budget: equal received shares cannot overdraw damage/KE,
// and the actual SI acoustic pressure equation adds exactly half the source J.
for(const energy of [1,100,10000]) {
  const budgets=externalBlastBudget(energy,[100,200,300]);
  assert(budgets.reduce((a,b)=>a+b,0)<=energy/2+1e-9);
  const p=externalBlastPressure(70,energy);
  assert(Math.abs(pressureEnergy(p)-pressureEnergy(70)-energy/2)<1e-9);
  const mass=dynamicsRows[E.SAND].mass,velocity=Math.sqrt(2*budgets[0]/mass);
  assert(Math.abs(0.5*mass*velocity**2-budgets[0])<1e-9);
  assert(Number.isFinite(mass*velocity),'real SI momentum');
}
// Grid and flying material share ONE half-energy normalization. Particle heat
// is paid from its share, with the remainder funding incremental—not absolute—KE.
const shares=externalBlastBudget(100,[100,200,300,400]);assert(Math.abs(shares.reduce((a,b)=>a+b,0)-50)<1e-9);
for(const v of [[10,-3,2],[-10,4,0],[0,0,0]]) for(const mass of [0.001,0.7,27]) {
 const share=shares[2],heat=share/4,newV=externalBlastVelocity(v,[1,0,0],share-heat,mass);
 const ke=x=>0.5*mass*x.reduce((a,b)=>a+b*b,0);
 assert(Math.abs(ke(newV)-ke(v)+heat-share)<1e-9);assert.equal(newV[1],v[1]);assert.equal(newV[2],v[2]);
 assert(newV[0]>=v[0]);
}
assert(AIR.edge>0);
const shielded=blastPlan([0,0,0],[[2,0,0]],p=>p[0]===1,100);
assert.equal(shielded[0].energy,0);
// Validate guards against real generated stages, including no capacity-side
// writes before the gate. Naga is run separately on every generated module.
const shader=stage=>blastsWGSL(g,nativeDynamicsHead,stage);
assert.match(shader('externalBegin'),/external|pending/);
assert.match(shader('externalBegin'),/==0u/);
assert.match(shader('externalGate'),/control\[5\].*>atomicLoad\(&control\[4\]/);
assert.match(shader('apply'),/P.mode==14u && atomicLoad\(&control\[3\]\)==D_NONE/);
assert.match(shader('finish'),/atomicStore\(&control\[.*P.substep\],1u\)/);
assert.match(shader('plan'),/dExternalShielded\(p\)/);
assert.match(shader('externalParticlePlan'),/id>=254u/);
assert.match(shader('externalParticlePlan'),/dExternalShieldedPosition\(particle.position-vec3f\(P.origin\)\)/);
assert.match(shader('normalize'),/D_EXTERNAL_PARTICLES/);
assert.match(shader('externalParticleApply'),/atomicLoad\(&control\[3\]\)==D_NONE/);
assert.match(shader('finish'),/weight\/total/);
// V1 react.js setOff: an explosive under more than its crushP goes off rather than fly. The external blast
// adds its pressure once it is sure (finish, past externalGate), so damagePlan reads the field it will
// leave, brick by brick with finish's own expression (a brick it doesn't reach keeps its pressure, a
// vacuum its sign), and apply sets the explosive off in place past the gate.
{
  const damage=shader('damagePlan'),finish=shader('finish'),apply=shader('apply');
  const added=/let addedP2=([\d.e+]+)\*P\.strength\*weight\/total;/.exec(finish)[1];
  assert.ok(damage.includes(`return ${added}*P.strength*weight/total;`),'the pressure finish adds');
  assert.ok(damage.includes('if (P.mode!=14u || !mAirPressure() || total<=0.0 || weight<=0.0) { return 0.0; }'),'where finish adds it');
  assert.ok(damage.includes('let b=brickOfCell(p); let w=air[b].vp.w; let added=dExternalAddedP2(b); return select(w,sqrt(w*w+added),added>0.0);'));
  assert.ok(damage.includes('fn dPressureOnAfterExternal(p: vec3i, k: u32) -> f32 {'),'V1\'s pOn on that field');
  const setOff=damage.indexOf('if (P.mode==14u && energy>0.0 && dCrush(id)>0.0 && mAirPressure() && dPressureOnAfterExternal(cellOf(t),k)>dCrush(id)) {');
  assert.ok(setOff>0 && setOff<damage.indexOf('var kinetic=energy;'),'set off before the break and the throw');
  assert.ok(damage.includes(`plans[t]=DPlan(vec3f(0),${PLAN.SET_OFF}u); return;`));
  const gate=apply.indexOf('if(P.mode==14u && atomicLoad(&control[3])==D_NONE) { return; }'),mark=apply.indexOf(`if ((plan.flags&${PLAN.SET_OFF}u)!=0u) { events[t]|=1u; noteEvents(t,events[t]); }`);
  assert.ok(gate>0 && mark>gate,'apply sets it off, only once the gate has passed');
  // its own bit: above the products (8..15) and a partial launch's amount (a full cell's at most, from bit 8)
  assert.ok(PLAN.SET_OFF>FULL*256*2 && PLAN.SET_OFF<2**32 && Object.values(PLAN).filter(v=>v&PLAN.SET_OFF).length===1);
  assert.ok(!/fn dPressureOnAfterExternal/.test(apply),'only damagePlan carries the field read');
}
// Codec corruption must not interpret explicit null as a backwards-compatible omission.
const encoded=encodeDynamicState(saved),view=new DataView(encoded.buffer),oldLength=view.getUint32(8,true),oldAt=Math.ceil((16+oldLength)/4)*4;
const metadata=JSON.parse(new TextDecoder().decode(encoded.subarray(16,16+oldLength)));
metadata.state.externalBlastDone=null;
const json=new TextEncoder().encode(JSON.stringify(metadata)),at=Math.ceil((16+json.length)/4)*4;
const corrupted=new Uint8Array(at+encoded.length-oldAt);corrupted.set(encoded.subarray(0,16));new DataView(corrupted.buffer).setUint32(8,json.length,true);
corrupted.set(json,16);corrupted.set(encoded.subarray(oldAt),at);assert.throws(()=>decodeDynamicState(corrupted),/external blast/);
// Ray acknowledgement is by immutable request identity, not simulation serial.
const ray=()=>d.applyToolImpulse({kind:'photon',position:[2,2,2],direction:[1,0,0],radius:0,count:1});
assert.equal(ray().status,'queued');flags[rayRequestBase(g)]=0;
const rayAck=d.readActivity();d._work();await rayAck;assert.equal(d.rayRequests.size,0);
ray();flags[rayRequestBase(g)]=0;const reuseAck=d.readActivity();
const replacement={...d.rayRequests.get(0)};d.rayRequests.set(0,replacement);await reuseAck;assert.equal(d.rayRequests.get(0),replacement);
const rayState=await d.snapshotDynamicState();const restoreAck=d.readActivity();d.restoreDynamicState(rayState);
const restored=d.rayRequests.get(0);await restoreAck;assert.equal(d.rayRequests.get(0),restored);
const destroyAck=d.readActivity();d.dispose();await destroyAck;assert.equal(d.rayRequests.get(0),restored);
console.log('external blast CPU: real paint/router/driver ordering, completion persistence, capacity refusal, outside requests, malformed preflight, SI budget/momentum and shielding passed (no GPU execution)');
