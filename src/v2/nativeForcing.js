import { fold } from '../gpu/kernels.js';
import { nativeDynamicsHead } from '../shaders/v2.js';
import { nativeModes } from './modes.js';
import { nativeWeatherParams, nativeWeatherEvaluateWGSL, nativeWeatherCommitWGSL, NATIVE_WEATHER_COMMIT_LAYOUT, scratchWGSL, boxWGSL, weatherMain, WEATHER_SPEED_SI } from './nativeWeather.js';
import { STAGE } from '../gpu/kernels.js';
const binding=(n,read=false)=>({binding:n,visibility:STAGE.COMPUTE,buffer:{type:read?'read-only-storage':'storage'}});
export const FORCE_COMMIT_LAYOUT=[...NATIVE_WEATHER_COMMIT_LAYOUT,binding(3)];
export function nativeForceCommitWGSL(g,params,stage) {
  const head=`${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${nativeDynamicsHead(g)}
${scratchWGSL}
${boxWGSL}
@group(1) @binding(0) var<storage, read> results: array<WeatherResult>;
struct ForceAir { vp: vec4f, thermal: vec4f }
@group(1) @binding(1) var<storage, read_write> air: array<ForceAir>;
struct ForcePlan { velocity: vec3f, flags: u32 }
@group(1) @binding(2) var<storage, read_write> plans: array<ForcePlan>;
struct ForceParticle { position: vec3f, id: u32, velocity: vec3f, c0: u32, tail: vec4u }
@group(1) @binding(3) var<storage, read_write> particles: array<ForceParticle>;
fn forceHeat(m: Material, r: WeatherResult) -> Material {
 if(r.after.y==r.before.y) { return m; }
 let dt=i32(round((r.after.y-r.before.y)*4.0));let heat=energyMul(capacityQ(m.core),u32(abs(dt)));
 let e=energyAdd(energyOf(m),select(heat,energyNeg(heat),dt<0));
 if(!energyFits(m,e)) { return m; }return withEnergy(m,e);
}
fn forcePacketHeat(m: Material, r: WeatherResult) -> Material {
 if(r.after.y==r.before.y) { return m; }
 let dt=i32(round((r.after.y-r.before.y)*4.0));let heat=energyMul(packetCapacityQ(m.core),u32(abs(dt)));
 let e=energyAdd(packetOwnedEnergy(m),select(heat,energyNeg(heat),dt<0));
 if(!packetEnergyFits(m,e)) { return m; }return withPacketEnergy(m,e);
}
`;
  if(stage==='plan') return head+weatherMain(`if(i>=weatherCount()) { return; }
let p=weatherCell(i);let s=slotOf(p);let r=results[i];let before=loadMaterial(s);
let id=cid(before.core);let k=cls(id);var flags=0u;
if(r.before.x!=r.after.x) { flags=2u|(u32(r.after.x)<<8u); }
if((k==2u || k==3u || flags!=0u) && r.motion.w!=0.0) { flags|=1u; }
plans[s]=ForcePlan(r.motion.xyz*${WEATHER_SPEED_SI},flags);
let after=forceHeat(before,r);
if(any(after.core!=before.core) || after.bank!=before.bank) {
 noteEnergySource(p,energySub(energyOf(after),energyOf(before)));storeMaterial(s,before,after);markBusy(p);
}`);
  if(stage==='particles') return head+weatherMain(`if(i>=65536u) { return; }
var particle=particles[i];let r=results[i];
if(particle.id==0u || (particle.c0&255u)>=254u || r.before.x==0.0) { return; }
let before=Material(vec4u(particle.c0,particle.tail.xyz),bitcast<i32>(particle.tail.w));var after=forcePacketHeat(before,r);
if(r.before.x!=r.after.x) {
 let enthalpy=packetOwnedEnergy(after);after.core.x=(after.core.x&0xffffff00u)|u32(r.after.x);
 if(!packetEnergyFits(after,enthalpy)) { return; }after=withPacketEnergy(after,enthalpy);
}
if(r.motion.w!=0.0) { particle.velocity=r.motion.xyz*${WEATHER_SPEED_SI}; }
particle.c0=after.core.x;particle.tail=vec4u(after.core.yzw,bitcast<u32>(after.bank));particles[i]=particle;
let p=vec3i(floor(particle.position))-P.origin;
noteEnergySource(p,energySub(packetOwnedEnergy(after),packetOwnedEnergy(before)));markBusy(p);
`);
  throw new Error(`Unknown native force stage ${stage}`);
}
export function createNativeForceKernel(sim,name,spec) {
  const o=sim.compactOwner,d=o.dynamics,gpu=sim.gpu;
  const params=nativeWeatherParams(name,{...spec,params:{...Object.fromEntries(spec.params.fields.map(f=>[f.name,f.type])),origin:'vec3i'}});
  const evalLayout=gpu.layout(`${name}ForceEval`,[...(spec.layout??[]),binding(1)]);
  const particleLayout=gpu.layout(`${name}ForceParticles`,[...(spec.layout??[]),binding(1),binding(2,true)]);
  const commitLayout=gpu.layout('NATIVE_FORCE_COMMIT',FORCE_COMMIT_LAYOUT);
  const make=(suffix,code,layouts)=>gpu.kernel({name:name+suffix,params,code,layouts});
  const evalSpec={...spec,nativeForcing:true};
  const evaluate=make('ForceEvaluate',nativeWeatherEvaluateWGSL(sim.g,evalSpec,params),[sim.L.TABLES,sim.L.STATE_RO,evalLayout]);
  const particles=make('ForceParticleEvaluate',nativeWeatherEvaluateWGSL(sim.g,{...evalSpec,nativeParticles:true},params),[sim.L.TABLES,sim.L.STATE_RO,particleLayout]);
  const plan=make('ForcePlan',nativeForceCommitWGSL(sim.g,params,'plan'),[o.nativeDynamics.layout,commitLayout]);
  const commit=make('ForceParticleCommit',nativeForceCommitWGSL(sim.g,params,'particles'),[o.nativeDynamics.layout,commitLayout]);
  const air=make('ForceAir',nativeWeatherCommitWGSL(sim.g,params,'air'),[o.nativeDynamics.layout,commitLayout]);
  const kernels=[evaluate,particles,plan,commit,air],ready=Promise.all(kernels.map(k=>k.ready));ready.catch(()=>{});
  return {ready,get isReady(){return kernels.every(k=>k.state==='ready') && d.isReady;},run(box,values,source) {
    if(kernels.some(k=>k.state!=='ready') || !d.isReady || sim.disposed || sim.compactOwner!==o || !box) return false;
    const dims=[sim.g.nx,sim.g.ny,sim.g.nz];box={lo:box.lo.map(v=>Math.max(0,Math.ceil(v))),hi:box.hi.map((v,a)=>Math.min(dims[a]-1,Math.floor(v)))};
    if(box.lo.some((v,a)=>v>box.hi[a])) return false;
    const limit=Math.min(gpu.limits?.maxStorageBufferBindingSize??128*1024*1024,gpu.limits?.maxBufferSize??Infinity);
    const chunks=[];
    function split(b) {
      const count=b.hi.reduce((n,v,a)=>n*(v-b.lo[a]+1),1);
      if(count*64<=limit) {chunks.push({box:b,count});return;}
      const a=b.hi.map((v,a)=>v-b.lo[a]).indexOf(Math.max(...b.hi.map((v,a)=>v-b.lo[a])));
      const cut=Math.floor((b.lo[a]+b.hi[a]+1)/8)*4;
      if(cut<=b.lo[a] || cut>b.hi[a]) throw Error('Native force scratch cannot fit binding limit');
      const left={lo:[...b.lo],hi:[...b.hi]},right={lo:[...b.lo],hi:[...b.hi]};left.hi[a]=cut-1;right.lo[a]=cut;split(left);split(right);
    }
    split(box);if(65536*64>limit) return false;
    o.sync();
    const buffer=n=>gpu.createBuffer({label:name+' force results',size:n*64,usage:0x80});
    const entries=(buffers,start=0)=>buffers.map((buffer,i)=>({binding:start+i,resource:{buffer}}));
    const group=(layout,scratch,particle=false)=>gpu.bindGroup(layout,[...(source?[{binding:0,resource:{buffer:source}}]:[]),...entries([scratch,...(particle?[d.particles]:[])],1)],name);
    const commitGroup=scratch=>gpu.bindGroup(commitLayout,entries([scratch,d.air[d.airIndex],d.plans,d.particles]),name);
    const p=b=>({...nativeModes(sim),...values,editLo:b.lo,editHi:b.hi,tick:o.tick+1,origin:[sim.origin.x,sim.origin.y,sim.origin.z]});
    const dispatch=(k,n,bind,b,physical=false)=>k.dispatch(gpu.frame,fold(Math.ceil(n/64)),{bind,header:physical?sim.readHeader({physical:true}):sim.header(),params:p(b)});
    // Every predicate, including strike's neighbour walk, sees the SAME frozen grid.
    for(const c of chunks) { c.scratch=buffer(c.count);dispatch(evaluate,c.count,[sim.tables,sim.bindPhysicalRO,group(evalLayout,c.scratch)],c.box,true); }
    const particleScratch=buffer(65536);dispatch(particles,65536,[sim.tables,sim.bindPhysicalRO,group(particleLayout,particleScratch,true)],box,true);
    gpu.frame.clear(d.plans);
    for(const c of chunks) {
      const bind=[o.nativeDynamics.group,commitGroup(c.scratch)];dispatch(plan,c.count,bind,c.box);
      const bricks=c.box.hi.reduce((n,v,a)=>n*(Math.floor(v/4)-Math.floor(c.box.lo[a]/4)+1),1);dispatch(air,bricks,bind,c.box);
    }
    d._allocate(o.tick+1,{mode:15});
    dispatch(commit,65536,[o.nativeDynamics.group,commitGroup(particleScratch)],box);
    for(const c of chunks) sim._retire(c.scratch);sim._retire(particleScratch);
    o.legacyPending=o.writtenSinceTick=true;sim.version++;o.seenVersion=sim.version;sim.changedAll=true;d._externalWork();sim.wake();
    return true;
  }};
}
