import { povGpu } from '../../src/pov/gpu.js';
import { TOOLS, PROP_TOOL, E } from '../../src/elements.js';
import { PROP } from '../../src/editing.js';
import { WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from '../../src/v2/nativeWeather.js';
import { makeMaterial, cFill, withPayload, payloadOf, energyOf, capacityQ, withEnergy } from '../../src/v2/layout.js';
import { packParticle, unpackParticle, allocateSources } from '../../src/v2/dynamics-reference.js';
// Actual native force driver and shader compilation; CPU ONLY.
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Simulation, gridLayout } from '../../src/sim.js';
import { createNativeForceKernel } from '../../src/v2/nativeForcing.js';
import { nativeDynamicsHead,V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { paintUpdateWGSL,PaintParams,paintDeclsWGSL,PAINT_LAYOUT } from '../../src/shaders/passes.js';
import { kickWGSL,KickParams } from '../../src/shaders/povKick.js';
import { strikeWGSL,StrikeParams } from '../../src/shaders/povTrace.js';
import { povFieldWGSL,FieldParams } from '../../src/shaders/povBody.js';
const dir=mkdtempSync(join(tmpdir(),'native-force-')),modules=[],calls=[],retired=[];
const gpu={limits:{},createBuffer:o=>o,layout:(_n,x)=>x,bindGroup:(_l,x)=>x,frame:{clear:b=>calls.push('clearPlans')},
 kernel:o=>{modules.push(o);return {...o,state:'ready',ready:Promise.resolve(),dispatch(_f,size,args){calls.push({name:o.name,size,args});}};}};
const g=gridLayout(32,32,32),sim={g,gpu,L:{TABLES:[],STATE_RO:[]},tables:{},bindPhysicalRO:{},origin:{x:0,y:0,z:0},version:0,
 readHeader:()=>({format:3}),header:()=>({}),_retire:b=>retired.push(b),wake(){}};
const d={isReady:true,air:[{}],airIndex:0,plans:{},particles:{},_allocate(t,p){calls.push({allocate:p});},_externalWork(){}};
const owner={dynamics:d,nativeDynamics:{head:nativeDynamicsHead,layout:V2_DYNAMICS_LAYOUT,group:{}},tick:1,sync(){calls.push('sync');}};sim.compactOwner=owner;
const specs={paint:{update:paintUpdateWGSL,params:PaintParams,decls:paintDeclsWGSL(g),layout:PAINT_LAYOUT},kick:{update:kickWGSL,params:KickParams},strike:{update:strikeWGSL,params:StrikeParams},field:{update:povFieldWGSL,params:FieldParams}};
try {
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
  const file=join(dir,i+'.wgsl');writeFileSync(file,m.code);const result=spawnSync('naga',[file],{encoding:'utf8'});
  assert.equal(result.status,0,m.name+': '+result.stderr);
 }
 assert(retired.length===8,'both grid and particle scratch retired per tool');
 globalThis.GPUBufferUsage={STORAGE:128,COPY_SRC:4};
 sim.compact=owner;sim.paints=0;sim.noMask={dummy:true};sim._paintMask=data=>({mask:data});
 sim.touchCentres=(lo,hi)=>({lo:lo.map(Math.floor),hi:hi.map(Math.ceil)});
 sim.edit=()=>{throw Error('legacy edit forbidden');};
 const center={x:8,y:8,z:8},end={x:13,y:9,z:10};
 for(const key of ['VACUUM','CYCLONE','GRAV_IN','GRAV_OUT']) {
  calls.length=0;assert(Simulation.prototype.paint.call(sim,{center,end,radius:2,shape:1,grow:[3,1,0],filter:E.SAND,tool:TOOLS.find(t=>t.key===key).id}));
  const evalCall=calls.find(c=>c.name==='nativePaintForceForceEvaluate');assert.deepEqual(evalCall.args.params.end,[13,9,10]);
  assert.deepEqual(evalCall.args.params.grow,[3,1,0]);assert.equal(evalCall.args.params.filter_,E.SAND);assert.equal(evalCall.args.params.shape,1);
 }
 for(const field of [PROP.VX,PROP.VY,PROP.VZ,PROP.PRESSURE]) {
  calls.length=0;assert(Simulation.prototype.paint.call(sim,{center,radius:1,shape:0,tool:PROP_TOOL,prop:{field,value:0.2},mask:{lo:[4,4,4],hi:[5,5,5],data:new Uint8Array(4)}}));
  assert.equal(calls.find(c=>c.name==='nativePaintForceForceEvaluate').args.params.masked,1);
 }
 for(const name of ['povKick','povStrike','povField']) assert(povGpu(sim).edit(name,{lo:[1,1,1],hi:[4,4,4]},{}));
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
 assert.equal(WEATHER_SPEED_FLUX/65536*180*0.3,WEATHER_SPEED_SI);
 const source={slot:0,material,particle:packet};allocateSources([source],[{id:1}],1);assert(source.retry);assert.deepEqual(source.material,material);

 console.log(`20 native force modules validated; actual bounded driver ordering, canonical predicates, particle lanes, <=8 bindings; no GPU execution`);
} finally {rmSync(dir,{recursive:true,force:true});}
