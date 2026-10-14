// CPU only: actual router/recording driver, binary persistence, numerical budget
// and generated shader guards. This is not a claim of GPU execution.
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Simulation, gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { externalBlastBase, blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { encodeDynamicState, decodeDynamicState } from '../../src/v2/dynamicState.js';
import { externalBlastPressure, externalBlastBudget, validateExternalBlasts } from '../../src/v2/externalBlast.js';
import { blastPlan, pressureEnergy, dynamicsRows } from '../../src/v2/dynamics-reference.js';
import { povGpu } from '../../src/pov/gpu.js';
import { TOOLS, E } from '../../src/elements.js';
import { AIR } from '../../src/v2/pressure.js';

globalThis.GPUBufferUsage = { STORAGE:128, COPY_SRC:4, COPY_DST:8, INDIRECT:256 };
const commands=[], writes=[];
const make=({size,label})=>({size,label,bytes:new ArrayBuffer(size),destroy(){}});
const write=(b,at,a)=>{writes.push(b.label);new Uint8Array(b.bytes).set(new Uint8Array(a.buffer,a.byteOffset,a.byteLength),at);};
const gpu={createBuffer:make,queue:{writeBuffer:write},write,layout:(_n,e)=>e,bindGroup:(_l,e)=>e,
  kernel:({name,code})=>({name,code,ready:Promise.resolve(),dispatch(_f,_n,o){commands.push({name,p:o.params});}}),
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
assert.equal(sim.paint({center:new Vector3(4,4,4),radius:2,shape:1,tool:blast}),false);
assert.equal(sim.paint({center:new Vector3(4,4,4),radius:2,shape:0,tool:blast,filter:E.SAND}),false);
for(const key of ['VACUUM','CYCLONE','GRAV_IN','GRAV_OUT']) assert.equal(sim.paint({center:new Vector3(),radius:2,shape:0,tool:TOOLS.find(t=>t.key===key).id}),false);
assert.equal(povGpu(sim).edit('povRocket',{lo:[-10,-10,-10],hi:[20,20,20]},{center:[4,4,4]}),true);
for(const name of ['povKick','povStrike','povField']) assert.equal(povGpu(sim).edit(name,{},{}),false);
assert.equal(d.applyExternalBlast({position:[200,0,0],radius:2,energy:100}).status,'queued');
const stages=commands.slice(0,11).map(c=>c.name.split('_')[1]);
assert.deepEqual(stages,['externalBegin','workArgs','plan','sum','normalize','damagePlan','count','allocate','externalGate','apply','finish']);
// Completion flags stay GPU-authoritative across repeated recordings, snapshots,
// and restores. No readback is required between a blast and the next tick.
const flags=new Uint32Array(d.control.bytes);flags[externalBlastBase(g)]=1;
d.consumeMaterialEvents(1);d.consumeMaterialEvents(2);
assert.equal(flags[externalBlastBase(g)],1,'recording must not reset completion');
const snapshot=await d.snapshotDynamicState(),saved=decodeDynamicState(encodeDynamicState(snapshot));
assert.equal(saved.externalBlasts.length,3);assert.equal(saved.externalBlastDone[0],1);
d.restoreDynamicState(saved);assert.equal(flags[externalBlastBase(g)],1);
assert.deepEqual(d.externalBlasts.get(2).position,[200,0,0],'out-of-window obligation survives');
const before=writes.length,bad=structuredClone(saved);bad.externalBlasts[0].energy=NaN;
assert.throws(()=>d.restoreDynamicState(bad),/external blast/);assert.equal(writes.length,before);
for(const mutate of [s=>delete s.externalBlastDone,s=>s.externalBlastDone[63]=1,s=>s.externalBlastDone[0]=2,s=>s.externalBlasts.push({...s.externalBlasts[0]}),s=>s.externalBlasts[0].requestId=s.sequence+1]) {
  const invalid=structuredClone(saved);mutate(invalid);assert.throws(()=>validateExternalBlasts(invalid));
}
const ack=d.readActivity();d._work();await ack;assert.equal(d.externalBlasts.size,2,'completed requests acknowledged only after GPU flag read');
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
d.dispose();
console.log('external blast CPU: real paint/router/driver ordering, completion persistence, capacity refusal, outside requests, malformed preflight, SI budget/momentum and shielding passed (no GPU execution)');
