// CPU only. Production driver recording + independent packed-state/force oracle.
import assert from 'node:assert/strict';
import { createElementWeather } from '../../src/elementWeather.js';
import { createOceanEvents } from '../../src/oceanEvents.js';
import { createLightning } from '../../src/lightning.js';
import { seedWaveDemo } from '../../src/world/waveDemo.js';
import { STORM } from '../../src/bolt.js';
import { createNativeWeatherKernel, WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from '../../src/v2/nativeWeather.js';
import { LANE_HZ } from '../../src/shaders/v2.js';
import { oceanEventsEdit, OCEAN_EVENT } from '../../src/shaders/oceanEvents.js';
import { gridLayout } from '../../src/sim.js';
import { makeMaterial, cFill, energyOf, capacityQ, withEnergy, withPayload, payloadOf, ctypeOf } from '../../src/v2/layout.js';
import { legacyPressureToPa } from '../../src/v2/pressure.js';
import { gravityAt, nativeModes, ballisticModes } from '../../src/v2/modes.js';
import { allocateSources, packParticle, unpackParticle } from '../../src/v2/dynamics-reference.js';
import { E } from '../../src/elements.js';
import { GRAV, AIR } from '../../src/simModes.js';
import { CELL_M } from '../../src/scale.js';
const close=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
globalThis.GPUBufferUsage={STORAGE:128};
const calls=[], retired=[];
const gpu={ frame:{clear(buffer){ calls.push({name:'clearPlans',buffer}); }},
 layout:(name,entries)=>({name,entries}), createBuffer:d=>({...d}), bindGroup:(layout,entries)=>({layout,entries}),
 write(){}, kernel(desc){ return {...desc,state:'ready',ready:Promise.resolve(),dispatch(frame,size,options){calls.push({name:desc.name,size,...options});}} },
 readback:{ring(){return {buffer:{},next:()=>0,offset:()=>0,slotBytes:16,read:()=>Promise.resolve(new ArrayBuffer(16))};}},
};
let simId=1;
function fixture() {
 const sim={id:simId++,gpu,g:gridLayout(32,64,32),origin:{x:100,y:0,z:-50,toArray(){return [this.x,this.y,this.z];}},frame:0,version:0,wholeWrites:0,
  L:{TABLES:{},STATE_RO:{}},tables:{},bindPhysicalRO:{physical:true},bindRO:{legacy:true},
  header(){return {origin:this.origin.toArray()};},readHeader({physical}={}){return {...this.header(),format:physical?3:2};},
  edit(){throw Error('native forcing called legacy edit');},editKernel(){throw Error('native forcing built legacy edit');},
  wake(){},_retire(b){retired.push(b);},touchCentres(lo,hi){return {lo:lo.map((v,a)=>Math.max(0,Math.ceil(v-0.5))),hi:hi.map((v,a)=>Math.min([32,64,32][a]-1,Math.floor(v-0.5)))};},
 };
 const d={isReady:true,ready:Promise.resolve(),air:[{name:'air0'},{name:'air1'}],airIndex:1,plans:{name:'plans'},_externalWork(){},_allocate(tick){calls.push({name:'nativeAllocate',tick});}};
 const o={dynamics:d,tick:3,sync(){calls.push({name:'sync'});},nativeDynamics:{layout:{},group:{}},wake(){}};
 sim.compact=sim.compactOwner=o; return sim;
}
const sim=fixture(), weather=createElementWeather();
const state={preset:'storm',cloud:1,rain:1,storm:1,fog:1,wind:[3,4],time:4};
const context={sim,enabled:true,advancing:true,host:true,seaLevel:18,stepHz:60};
weather.step(state,context); await weather.ready;
calls.length=0; sim.frame=15;
assert(weather.step(state,context));
assert.equal(calls.filter(c=>c.name==='elementWeatherNativeEvaluate').length,2);
assert.equal(calls.filter(c=>c.name==='nativeAllocate').length,2);
for(const c of calls.filter(c=>c.name==='elementWeatherNativeEvaluate')) {
 assert.equal(c.header.format,3); assert.equal(c.bind[1],sim.bindPhysicalRO);
 assert.deepEqual(c.params.wind,[0.6,0.8]); assert.equal(c.params.pulse,1);
 assert.ok(c.params.editHi[1]-c.params.editLo[1]<=12);
}
const count=calls.length;
assert.equal(weather.step(state,context),false);
assert.equal(weather.step(state,{...context,host:false}),false);
assert.equal(weather.step(state,{...context,advancing:false}),false);
assert.equal(calls.length,count);
weather.dispose();
const ocean=createOceanEvents(), oceanSim=fixture(), oceanContext={sim:oceanSim,seaLevel:18,groundHeight:()=>0,stepHz:60};
ocean.step({ocean:1},oceanContext); await new Promise(resolve=>setImmediate(resolve)); oceanSim.frame=oceanSim.nativeTicks=1; // (one native host tick: v2/host.js)
calls.length=0; assert(ocean.step({ocean:1},oceanContext));
const oce=calls.find(c=>c.name==='oceanForceNativeEvaluate'); assert(oce);
assert.deepEqual(oce.params.editLo,[0,12,0]); assert.deepEqual(oce.params.editHi,[31,22,31]);
assert.equal(oce.params.time,1/60); assert.equal(calls[0].name,'oceanColumns');
assert.equal(calls[0].header.format,3); ocean.dispose();
const bolt=createLightning(), boltSim=fixture(); calls.length=0;
bolt.strike(boltSim,[10,50,10],[10,10,10],{strikeR:2});
assert(calls.some(c=>c.name==='boltNativeEvaluate')); assert(!calls.some(c=>c.name==='nativeAllocate')); bolt.dispose();
// Direct producer uses the ACTUAL dynamics owner, never the 3-buffer adapter.
calls.length=0;
const force=createNativeWeatherKernel(sim,'testOcean',oceanEventsEdit); await force.ready;
assert(force.run({lo:[1,2,3],hi:[2,3,4]},{sea:18,time:1,chop:1,surge:0,wind:[1,0],source:[0,0],direction:[1,0]},{}));
assert.deepEqual(calls.filter(c=>c.name.startsWith('testOcean')).map(c=>c.name),['testOceanNativeEvaluate','testOceanNativematerial','testOceanNativeair']);
assert.equal(calls.at(-1).bind[1].entries[1].resource.buffer,sim.compactOwner.dynamics.air[1]);
assert.equal(retired.at(-1).size,8*64);
// Independent numerical oracle: calibrated SI pulse, not a 60Hz reinterpretation.
close(WEATHER_SPEED_SI,72); close(WEATHER_SPEED_FLUX,65536*4); // 240 Hz source cells into lanes of quanta a 60 Hz tick
const surge=0.5, old=[0.01,-0.02,0.03], direction=[0.6,0.8];
const target=[direction[0]*OCEAN_EVENT.speed,OCEAN_EVENT.lift,direction[1]*OCEAN_EVENT.speed];
const q=old.map((v,a)=>(v+(target[a]-v)*surge)*WEATHER_SPEED_FLUX);
q.forEach((v,a)=>close(v/65536*LANE_HZ*CELL_M,(old[a]+(target[a]-old[a])*surge)*240*CELL_M));
close(legacyPressureToPa(OCEAN_EVENT.pressure*surge)/64*64,legacyPressureToPa(0.25));
// Coarse-air volume integral preserves a bounded pulse; untouched cells add zero.
const wind=[0.6*0.025*72,0,0.8*0.025*72], emitted=7;
wind.forEach(v=>close(v*emitted/64*(4*CELL_M)**3,v*emitted*CELL_M**3));
// Canonical property delta oracle: no importA/full-cell reconstruction is allowed.
let material=withPayload(makeMaterial(E.OIL,20,17003,27),54321); material.bank=-173;
const before=structuredClone(material), heat=BigInt(capacityQ(material.core))*80n;
const hot=withEnergy(material,energyOf(material)+heat);
assert.equal(cFill(hot.core),17003); assert.equal(ctypeOf(hot.core),27); assert.equal(payloadOf(hot.core),54321);
assert.equal(energyOf(hot)-energyOf(material),heat); assert.deepEqual(material,before);
// Newly emitted snow receives even gentle initial wind through native particles,
// not the powder lift threshold. Existing allocator preserves full carrier/bank.
const snow=makeMaterial(E.SNOW,0); snow.bank=123;
const velocity=[0.6*0.025*72,-0.12*72,0.8*0.025*72];
const packet={position:[1.5,50.5,1.5],velocity,id:123,...snow};
const unpacked=unpackParticle(packParticle(packet));
velocity.forEach((v,a)=>close(unpacked.velocity[a],v,1e-6)); assert.equal(unpacked.bank,123);
const modes=nativeModes(sim), advanced=ballisticModes(packet.position,velocity,1/60,[32,64,32],modes);
close(advanced.position[0]-packet.position[0],velocity[0]/60/CELL_M);
close(advanced.velocity[1]-velocity[1],gravityAt(packet.position,[32,64,32],modes)[1]/60);
const source={slot:2,material:snow,particle:packet}, fullPool=[{id:1}];
allocateSources([source],fullPool,1); assert.equal(source.retry,true); assert.deepEqual(source.material,snow);
allocateSources([source],[],1); assert.equal(source.retry,false); assert.equal(source.material,null);
// Frozen/disabled air selectors and radial/off gravity are packed into actual dispatches.
for(const gravityMode of [GRAV.OFF,GRAV.RADIAL]) for(const airMode of Object.values(AIR)) {
 sim.gravityMode=gravityMode;sim.airMode=airMode;
 force.run({lo:[1,2,3],hi:[2,3,4]},{sea:18,time:1,chop:1,surge:0,wind:[1,0],source:[0,0],direction:[1,0]},{});
 assert.equal(calls.at(-1).params.gravMode,gravityMode);assert.equal(calls.at(-1).params.airMode,airMode);
}
// Small mock device proves brick-safe tiling honors binding byte limits.
gpu.limits={maxStorageBufferBindingSize:4096,maxBufferSize:4096};
const start=retired.length;
force.run({lo:[0,0,0],hi:[7,3,7]},{sea:18,time:1,chop:1,surge:0,wind:[1,0],source:[0,0],direction:[1,0]},{});
assert.equal(retired.length-start,4);assert(retired.slice(start).every(b=>b.size<=4096));
delete gpu.limits;
// Composite readiness must not drop strikes while a later commit stage compiles.
const pendingSim=fixture(); let release;
pendingSim.compactOwner.dynamics.isReady=false;
pendingSim.compactOwner.dynamics.ready=new Promise(resolve=>{release=resolve;});
const pending=createNativeWeatherKernel(pendingSim,'pendingOcean',oceanEventsEdit);
assert.equal(pending.main.state,'pending');
assert.equal(pending.run({lo:[0,0,0],hi:[0,0,0]},{}),false);
pendingSim.compactOwner.dynamics.isReady=true;release();await pending.ready;
assert.equal(pending.main.state,'ready');
// A physics switch on the same grid (a V1 session loading a V2 save) swaps
// the writer: each system built V1's edit kernel first, which has no run, so
// its next pulse, wave or bolt threw once V2 owned the cells.
{
  const switched=fixture(), owner=switched.compactOwner, edits=[];
  switched.compact=switched.compactOwner=null;
  switched.editKernel=(name)=>({name,state:'ready',ready:Promise.resolve(),main:{state:'ready'},apply:{state:'ready'}});
  switched.edit=(k)=>edits.push(k.name);
  const w=createElementWeather(), wctx={sim:switched,enabled:true,advancing:true,host:true,seaLevel:18,stepHz:60};
  w.step(state,wctx); await w.ready; switched.frame=15; calls.length=0;
  assert(w.step(state,wctx)); assert(edits.includes('elementWeather'),'V1 weather is an edit');
  switched.compact=switched.compactOwner=owner; w.step(state,wctx); await w.ready; switched.frame=30; calls.length=0;
  assert(w.step(state,wctx),'V2 weather after the switch');
  assert(calls.some(c=>c.name==='elementWeatherNativeEvaluate'),'the native writer runs, not the V1 edit');
  w.dispose();
  switched.compact=switched.compactOwner=null; edits.length=0;
  const oc=createOceanEvents(), octx={sim:switched,seaLevel:18,groundHeight:()=>0,stepHz:60};
  oc.step({ocean:1},octx); await new Promise(resolve=>setImmediate(resolve)); switched.frame=31; oc.step({ocean:1},octx);
  assert(edits.includes('oceanForce'),'V1 ocean force is an edit');
  switched.compact=switched.compactOwner=owner; calls.length=0;
  switched.frame=100; oc.step({ocean:1},octx); await new Promise(resolve=>setImmediate(resolve)); switched.frame=200;
  assert(oc.step({ocean:1},octx),'V2 ocean chop after the switch');
  assert(calls.some(c=>c.name==='oceanForceNativeEvaluate'),'native ocean force after the switch');
  oc.dispose();
  switched.compact=switched.compactOwner=null; edits.length=0;
  const lb=createLightning();
  lb.strike(switched,[10,50,10],[10,10,10],{strikeR:2}); await lb.ready;
  switched.compact=switched.compactOwner=owner; calls.length=0;
  lb.strike(switched,[10,50,10],[10,10,10],{strikeR:2});
  assert(calls.some(c=>c.name==='boltNativeEvaluate'),'native bolt after the switch');
  lb.dispose();
}
// A runtime switch to V1 SUSPENDS the V2 owner: sim.compact goes, sim.compactOwner stays (its cells
// are kept for a switch back). Weather, waves and bolts must then write V1's cells with V1's edit;
// writing the suspended owner's cells left V1 dry (it never reads them).
{
  const suspended=fixture(), owner=suspended.compactOwner, edits=[];
  suspended.editKernel=(name)=>({name,state:'ready',ready:Promise.resolve(),main:{state:'ready'},apply:{state:'ready'}});
  suspended.edit=(k)=>edits.push(k.name);
  const w=createElementWeather(), wctx={sim:suspended,enabled:true,advancing:true,host:true,seaLevel:18,stepHz:60};
  w.step(state,wctx); await w.ready; suspended.frame=15; calls.length=0;
  assert(w.step(state,wctx)); assert(calls.some(c=>c.name==='elementWeatherNativeEvaluate'),'V2 active: the native writer');
  suspended.compact=null; edits.length=0; calls.length=0;   // (PhysicsV2.suspend: the owner is kept)
  w.step(state,wctx); await w.ready; suspended.frame=30;
  assert(w.step(state,wctx),'weather goes on under V1');
  assert(edits.includes('elementWeather'),'V1 weather is a V1 edit while V2 is suspended');
  assert(!calls.some(c=>c.name==='elementWeatherNativeEvaluate'),'nothing writes the suspended owner\'s cells');
  w.dispose();
  const oc=createOceanEvents(), octx={sim:suspended,seaLevel:18,groundHeight:()=>0,stepHz:240};
  oc.step({ocean:1},octx); await new Promise(resolve=>setImmediate(resolve)); suspended.frame=31; edits.length=0; calls.length=0;
  oc.step({ocean:1},octx);
  assert(edits.includes('oceanForce'),'V1 ocean force while V2 is suspended');
  assert(!calls.some(c=>c.name==='oceanForceNativeEvaluate'));
  oc.dispose();
  edits.length=0; calls.length=0;
  const lb=createLightning();
  lb.strike(suspended,[10,50,10],[10,10,10],{strikeR:2}); await lb.ready;
  lb.strike(suspended,[10,50,10],[10,10,10],{strikeR:2});
  assert(edits.includes('bolt'),'V1 bolt edit while V2 is suspended');
  assert(!calls.some(c=>c.name==='boltNativeEvaluate'));
  lb.dispose();
  // the native writer itself refuses a suspended owner's cells (built while V2 ran, run after the switch)
  suspended.compact=owner;
  const k=createNativeWeatherKernel(suspended,'suspendedTest',oceanEventsEdit); await k.ready;
  suspended.compact=null;
  assert.equal(k.run({lo:[1,2,3],hi:[2,3,4]},{sea:18,time:1,chop:1,surge:0,wind:[1,0],source:[0,0],direction:[1,0]},{}),false);
}
// V1 scrubs the paint of what a surge or a wave floods or empties (src/oceanEvents.js step:
// sim.edit { scrub: !!surge }; src/world/waveDemo.js: { scrub: true }; src/shaders/deco.js
// decoScrubFrag); the native writer is asked for the same scrub (nativeWeather.js NATIVE_WEATHER_SCRUB),
// and a chop pulse, as V1's, for none.
{
  const ss=fixture(), oc=createOceanEvents(), material=()=>calls.filter(c=>c.name==='oceanForceNativematerial');
  gpu.readback.buffer=async b=>{ const d=new Float32Array(b.size/4); for(let i=0;i<d.length;i+=2) d.set([1,18],i); return d.buffer; };
  const octx={sim:ss,seaLevel:18,groundHeight:x=>x<116?8:23,stepHz:60};
  assert(await oc.trigger(octx),'a surge arms offshore of the fixture\'s beach');
  calls.length=0; ss.frame+=OCEAN_EVENT.stepsPerSecond; assert(oc.step({ocean:0},octx));
  assert(material().length>0 && material().every(c=>c.params.surge>0 && c.params.scrub===1),'a V2 surge scrubs, as V1\'s sim.edit { scrub: true }');
  oc.cancel(); calls.length=0; ss.frame++; assert(oc.step({ocean:1},octx));
  assert(material().length>0 && material().every(c=>c.params.surge===0 && c.params.scrub===0),'chop alone does not, as V1\'s');
  oc.dispose(); delete gpu.readback.buffer;
  const ws=fixture(); ws.snapshot=()=>{}; Object.assign(ws.origin,{clone(){return {...this};},equals(o){return o.x===this.x&&o.y===this.y&&o.z===this.z;}});
  calls.length=0;
  assert(await seedWaveDemo({sim:ws,loaded:true,pending:null,epoch:1,P:{sea:18}},'shore'));
  const wave=calls.filter(c=>c.name==='waveDemoNativematerial');
  assert(wave.length>0 && wave.every(c=>c.params.scrub===1),'the World\'s wave demo scrubs under V2 as under V1');
  // and the plain writers (rain, snow, bolts) never do, under either engine
  calls.length=0; force.run({lo:[1,2,3],hi:[2,3,4]},{sea:18,time:1,chop:1,surge:0,wind:[1,0],source:[0,0],direction:[1,0]},{});
  assert.equal(calls.find(c=>c.name==='testOceanNativematerial').params.scrub,0);
}
// Storms keep their seconds on V2's 60 Hz ticks: STORM's step counts are
// authored at 240 steps a second, so a native grid polls every quarter as many.
{
  const st=createLightning(), ss=fixture(), poll=STORM.POLL_STEPS*60/240;
  st.update(ss,{stepHz:60}); await st.ready;
  calls.length=0; ss.frame=poll-1; st.update(ss,{stepHz:60});
  assert(!calls.some(c=>c.name==='stormSearch'),'not before its quarter');
  ss.frame=poll; st.update(ss,{stepHz:60});
  assert(calls.some(c=>c.name==='stormSearch'),'a V2 storm polls after POLL_STEPS/4 ticks, as often in seconds as V1');
  st.dispose();
}
console.log('native producers: actual weather/ocean/bolt dispatch, physical reads, exact bounds/cadence, owner bindings; independent SI/property/particle oracles passed (no GPU execution)');
