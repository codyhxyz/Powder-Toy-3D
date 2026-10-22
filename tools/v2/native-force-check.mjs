import { povGpu } from '../../src/pov/gpu.js';
import { TOOLS, PROP_TOOL, E } from '../../src/elements.js';
import { PROP } from '../../src/editing.js';
import { WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from '../../src/v2/nativeWeather.js';
import { LANE_HZ } from '../../src/shaders/v2.js';
import { makeMaterial, cFill, withPayload, payloadOf, energyOf, capacityQ, withEnergy } from '../../src/v2/layout.js';
import { packParticle, unpackParticle, allocateSources } from '../../src/v2/dynamics-reference.js';
// Actual native force driver and shader compilation; CPU ONLY.
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { createNativeForceKernel } from '../../src/v2/nativeForcing.js';
import { nativeDynamicsHead,V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { paintUpdateWGSL,PaintParams,paintDeclsWGSL,PAINT_LAYOUT } from '../../src/shaders/passes.js';
import { kickWGSL,KickParams } from '../../src/shaders/povKick.js';
import { strikeWGSL,StrikeParams } from '../../src/shaders/povTrace.js';
import { povFieldWGSL,FieldParams } from '../../src/shaders/povBody.js';
import { assertNaga } from './wgsl-grouping.mjs';
const modules=[],calls=[],retired=[];
const gpu={limits:{},createBuffer:o=>o,layout:(_n,x)=>x,bindGroup:(_l,x)=>x,frame:{clear:b=>calls.push('clearPlans')},
 kernel:o=>{modules.push(o);return {...o,state:'ready',ready:Promise.resolve(),dispatch(_f,size,args){calls.push({name:o.name,size,args});}};}};
const g=gridLayout(32,32,32),sim={g,gpu,L:{TABLES:[],STATE_RO:[]},tables:{},bindPhysicalRO:{},origin:{x:0,y:0,z:0},version:0,
 readHeader:()=>({format:3}),header:()=>({}),_retire:b=>retired.push(b),wake(){}};
const d={isReady:true,air:[{}],airIndex:0,plans:{},particles:{},_allocate(t,p){calls.push({allocate:p});},_externalWork(){}};
const owner={dynamics:d,nativeDynamics:{head:nativeDynamicsHead,layout:V2_DYNAMICS_LAYOUT,group:{}},tick:1,sync(){calls.push('sync');}};sim.compactOwner=owner;
const specs={paint:{update:paintUpdateWGSL,params:PaintParams,decls:paintDeclsWGSL(g),layout:PAINT_LAYOUT},kick:{update:kickWGSL,params:KickParams},strike:{update:strikeWGSL,params:StrikeParams},field:{update:povFieldWGSL,params:FieldParams}};
for(const [name,spec] of Object.entries(specs)) {
 const kernel=createNativeForceKernel(sim,name,spec);await kernel.ready;calls.length=0;
 assert.equal(kernel.run({lo:[-2,1,2],hi:[20,15,16]},{},name==='paint'?{}:undefined),true);
 const dispatches=calls.filter(x=>x.name);
 assert.equal(dispatches[0].name,name+'ForceEvaluate');assert.equal(dispatches[1].name,name+'ForceParticleEvaluate');
 assert.equal(dispatches.at(-1).name,name+'ForceParticleCommit');assert.deepEqual(dispatches[0].args.params.editLo,[0,1,2]);
 assert.deepEqual(calls.find(x=>x.allocate).allocate,{mode:15});
}
for(const [i,m] of modules.entries()) {
 assert([...m.code.matchAll(/var<storage,/g)].length<=8,m.name+' storage count');
 assertNaga(m.code,m.name);
}
assert(retired.length===8,'both grid and particle scratch retired per tool');
globalThis.GPUBufferUsage={STORAGE:128,COPY_SRC:4};
sim.compact=owner;sim.paints=0;sim.noMask={dummy:true};sim._paintMask=data=>({mask:data});
sim.touchCentres=(lo,hi)=>({lo:lo.map(Math.floor),hi:hi.map(Math.ceil)});
sim.edit=()=>{throw Error('legacy edit forbidden');};
const center={x:8,y:8,z:8},end={x:13,y:9,z:10};
// V1's air tools (passes.js update) on the native grid: Pressure (BLAST) and Wind too, with V1's line, box,
// shape and filter (and Wind's drag), never an external blast or a uniform impulse (v2/interactions.js).
d.applyExternalBlast=()=>{throw Error('the Pressure tool is V1 paint, not an external blast');};
sim.applyNativeTool=()=>{throw Error('the Wind tool is V1 paint, not an impulse');};
for(const key of ['VACUUM','CYCLONE','GRAV_IN','GRAV_OUT','WIND','BLAST']) {
 calls.length=0;assert(Simulation.prototype.paint.call(sim,{center,end,radius:2,shape:1,grow:[3,1,0],filter:E.SAND,wind:[1,0,2],tool:TOOLS.find(t=>t.key===key).id}),key);
 const evalCall=calls.find(c=>c.name==='nativePaintForceForceEvaluate');assert.deepEqual(evalCall.args.params.end,[13,9,10]);
 assert.deepEqual(evalCall.args.params.grow,[3,1,0]);assert.equal(evalCall.args.params.filter_,E.SAND);assert.equal(evalCall.args.params.shape,1);
 assert.equal(evalCall.args.params.tool,TOOLS.find(t=>t.key===key).id);assert.deepEqual(evalCall.args.params.wind,[1,0,2]);
 assert(calls.some(c=>c.name==='nativePaintForceForceAir'),key+': its pressure and draft reach the native air');
}
// No drag: V1 pushes by a zero wind, so nothing runs (and nothing is refused).
calls.length=0;assert(Simulation.prototype.paint.call(sim,{center,radius:2,shape:0,wind:[0,0,0],tool:TOOLS.find(t=>t.key==='WIND').id}));
assert(!calls.some(c=>c.name),'a still Wind brush dispatches nothing');
for(const field of [PROP.VX,PROP.VY,PROP.VZ,PROP.PRESSURE]) {
 calls.length=0;assert(Simulation.prototype.paint.call(sim,{center,radius:1,shape:0,tool:PROP_TOOL,prop:{field,value:0.2},mask:{lo:[4,4,4],hi:[5,5,5],data:new Uint8Array(4)}}));
 assert.equal(calls.find(c=>c.name==='nativePaintForceForceEvaluate').args.params.masked,1);
}
for(const name of ['povKick','povStrike','povField']) assert(povGpu(sim).edit(name,{lo:[1,1,1],hi:[4,4,4]},{}));
// T5: the rocket and the frag grenade run V1's own blast (shaders/povTools.js rocketWGSL) as native forcing,
// not an energy-split external blast: its solid breaks are fractures (apply renames them energy-exactly and
// launches the debris at the rule's speed), only air or a gas becomes a new cell (the fire), loose matter is
// shoved, and the air takes the rule's pressure (the air stage).
{
 calls.length=0;const before=modules.length;
 assert.equal(povGpu(sim).edit('povRocket',{lo:[0,0,0],hi:[17,17,17]},{center:{x:8.5,y:8.5,z:8.5},frame:7}),true,'the rocket runs natively');
 const names=calls.filter(x=>x.name).map(x=>x.name);
 assert.deepEqual(names.slice(0,2),['povRocketForceEvaluate','povRocketForceParticleEvaluate']);
 assert.ok(names.includes('povRocketForcePlan') && names.includes('povRocketForceAir') && names.at(-1)==='povRocketForceParticleCommit',names.join(' '));
 assert.deepEqual(calls.find(x=>x.name==='povRocketForceEvaluate').args.params.center,{x:8.5,y:8.5,z:8.5});
 assert.deepEqual(calls.find(x=>x.allocate).allocate,{mode:15},'its launches are bounded forcing (absolute speeds)');
 const made=modules.slice(before),code=n=>made.find(m=>m.name===n).code;
 for(const m of made) assertNaga(m.code,m.name);
 // V1's rule, as V1 runs it: break by ENERGY against HARD, FIRE_SPAWN of the air within FIRE_RADIUS, the shove, P = max(p, PULSE_P·fade)
 for(const rule of ['let E = ROCKET_ENERGY * (1.0 - x * x);','rnd(&rs) < ROCKET_FIRE_SPAWN','*oA = vec4f(f32(E_FIRE), ROCKET_FIRE_T, SPAWNLIFE(E_FIRE), seed);','ROCKET_IMPULSE / DENS(id)','(*oB).w = max((*oB).w, ROCKET_PULSE_P * rocketFade(r / ROCKET_PULSE_RADIUS));'])
  assert.ok(code('povRocketForceEvaluate').includes(rule),rule);
 // a new cell only from air or a gas; a solid's change is a fracture with its debris launched
 assert.match(code('povRocketForcePlan'),/if\(r\.before\.x!=r\.after\.x && \(k==0u \|\| k==4u\)\) \{/);
 assert.match(code('povRocketForcePlan'),/if\(r\.before\.x!=r\.after\.x\) \{ flags=2u\|\(u32\(r\.after\.x\)<<8u\); \}/);
}
// Independent packed-state/SI oracle: velocity properties replace only one
// component; force dV keeps incoming flight; packet conversion preserves banks.
const material=withPayload(makeMaterial(E.OIL,20,17003,27),54321);material.bank=-173;
const input=[8,-12,3],output=[0.2*WEATHER_SPEED_SI,input[1],input[2]];
const packet=unpackParticle(packParticle({position:[1.5,2.5,3.5],velocity:output,id:123,...material}));
assert.deepEqual(packet.core,[...material.core]);assert.equal(packet.bank,-173);assert.equal(cFill(packet.core),17003);assert.equal(payloadOf(packet.core),54321);
assert(Math.abs(packet.velocity[0]-14.4)<1e-5);assert.equal(packet.velocity[1],-12);
const cooled=withEnergy(material,energyOf(material)-BigInt(capacityQ(material.core))*80n);
assert.equal(cFill(cooled.core),17003);assert.equal(payloadOf(cooled.core),54321);
assert.equal(energyOf(material)-energyOf(cooled),BigInt(capacityQ(material.core))*80n);
assert.equal(WEATHER_SPEED_FLUX/65536*LANE_HZ*0.3,WEATHER_SPEED_SI);
const source={slot:0,material,particle:packet};allocateSources([source],[{id:1}],1);assert(source.retry);assert.deepEqual(source.material,material);

console.log(`20 native force modules validated; actual bounded driver ordering, canonical predicates, particle lanes, <=8 bindings; no GPU execution`);
