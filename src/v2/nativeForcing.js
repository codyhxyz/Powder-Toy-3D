import { fold } from '../gpu/kernels.js';
import { nativeDynamicsHead } from '../shaders/v2.js';
import { nativeModes } from './modes.js';
import { nativeWeatherParams, nativeWeatherEvaluateWGSL, nativeWeatherCommitWGSL, NATIVE_WEATHER_COMMIT_LAYOUT, scratchWGSL, boxWGSL, weatherMain, WEATHER_SPEED_SI } from './nativeWeather.js';
import { STAGE } from '../gpu/kernels.js';
import { SEED_MAX } from '../shaders/common.js';
const binding=(n,read=false)=>({binding:n,visibility:STAGE.COMPUTE,buffer:{type:read?'read-only-storage':'storage'}});
export const FORCE_COMMIT_LAYOUT=[...NATIVE_WEATHER_COMMIT_LAYOUT,binding(3)];
// blasts.js apply's bounded forcing: the plan's velocity is absolute (no fall added) and a launch
// the pool can't take leaves the cell exact on the grid.
export const NATIVE_LAUNCH_MODE=15;
// Writers that set more than motion and heat (Factory machines: src/v2/industry.js) opt in:
// opts.speedSI: m/s per authored cell/step (default WEATHER_SPEED_SI, TPT's 240 Hz step);
// opts.life: also merge the update's life and ctype/spark writes, as importProperties does;
// opts.sparse: write only cells that plan something, so boxes committed in turn share one plan clear;
// opts.sources: a change of element is a new cell, as V1's writer made it (its temperature, life,
//   ctype and seed: nativeWeather.js's new-source rule; air into fire, a wand's emit, a script's
//   create), not a fracture, and it launches when it is loose matter the update set moving;
// opts.sourcesFromGas: with sources, only a change of air or a gas is a new cell (the rocket's fire); a
//   solid's change stays a fracture (energy-exact in apply, its debris launched at the rule's speed).
// opts.renameNow: a fracture renames the cell here, energy-exact as apply does, and plans only its
//   launch, so a take recorded before the allocation (a melee tool's gather: run's defer) finds the
//   debris on the grid where V1's take found it.
// opts.motion: { decls, velocity, flags }: WGSL for the plan's velocity (m/s) from p and r, and a
// statement adding plan flags (src/v2/industry.js: a deck's carry and a machine's throw differ).
// opts.vaporise: a change of element into a gas (the laser's core: water to steam, rock to its smoke,
//   wood to fire) is V1's change in the share of a full cell the cell holds. V1's cells are all full,
//   and V1's rule makes the gas at its temperature; a V2 liquid holds its fill's share of that cell,
//   so it takes that share of the energy V1's change gives a full cell, and a thin film carries only
//   its own share into its steam (a full cell's result is V1's gas exactly). The gas is a fresh cell,
//   as V2's own boiling makes it (contact.js ctPhase -> ctConvert: ctNew, then the input's energy):
//   the update's life, no ctype, the cell's seed. A cell whose energy can't be the gas yet keeps its
//   element with it, for V2's phase to convert, as ctConvert waits (pending) when it can't fit.
export function nativeForceCommitWGSL(g,params,stage,opts={}) {
  const SI=opts.speedSI ?? WEATHER_SPEED_SI;
  const vaporise=opts.vaporise ? `
if(r.before.x!=r.after.x && cls(u32(r.after.x))==C_GAS) {
 var gas=makeMaterial(u32(r.after.x),r.after.y,FULLU,0u);
 gas.core=withLife(gas.core,r.after.z);gas.core.w=u32(fract(r.after.w)/${SEED_MAX / 65536})<<16u;
 var whole=before;var share=FULLU;
 if(isLiq(before.core)) { share=cFill(before.core);whole.core.y=(before.core.y&0xff000000u)|FULLU; }
 let e=energyAdd(energyOf(before),energyScale(energySub(energyOf(gas),energyOf(whole)),share,FULLU));
 var out=before;
 if(energyFits(gas,e)) { out=withEnergy(gas,e); } else if(energyFits(before,e)) { out=withEnergy(before,e); }
 if(any(out.core!=before.core) || out.bank!=before.bank) { noteEnergySource(p,energySub(energyOf(out),energyOf(before)));storeMaterial(s,before,out);markBusy(p); }
 return;
}` : '';
  const sources=opts.sources ? `
if(r.before.x!=r.after.x${opts.sourcesFromGas ? ' && (k==0u || k==4u)' : ''}) {
 let made=u32(r.after.x);
 var m=makeMaterial(made,r.after.y,FULLU,u32(max(floor(r.after.w),0.0)));
 m.core=withLife(m.core,r.after.z);
 if(!isLiq(m.core)) { m.core.w=u32(fract(r.after.w)/${SEED_MAX / 65536})<<16u; }
 let made_k=cls(made);
 // (a new cell the rule sets at rest stays on the grid, as V1's create_part leaves it)
 if((made_k==2u || made_k==3u) && r.motion.w!=0.0 && any(r.motion.xyz!=vec3f(0.0))) { plans[s]=ForcePlan(r.motion.xyz*${SI},1u); }
 if(any(m.core!=before.core) || m.bank!=before.bank) { noteEnergySource(p,energySub(energyOf(m),energyOf(before)));storeMaterial(s,before,m);markBusy(p); }
 return;
}` : '';
  const renameNow=opts.renameNow ? `
if(r.before.x!=r.after.x) {
 var broken=before;broken.core.x=(broken.core.x&0xffffff00u)|u32(r.after.x);
 if(cls(cid(broken.core))==2u) { broken.core=setFall(broken.core,0.0,0.0); }
 if(!energyFits(broken,energyOf(before))) { markBusy(p);return; }
 broken=withEnergy(broken,energyOf(before));storeMaterial(s,before,broken);markBusy(p);
 if(r.motion.w!=0.0) { plans[s]=ForcePlan(r.motion.xyz*${SI},1u); }
 return;
}` : '';
  // The payload layout of the material the plan leaves (a fracture renames the cell in apply).
  const life=opts.life ? `
let into=select(id,(flags>>8u)&255u,(flags&2u)!=0u);
var shaped=after.core; shaped.x=(shaped.x&0xffffff00u)|into;
if(isLiq(shaped)==isLiq(after.core)) {
 if(r.after.z!=r.before.z && !(isLiq(shaped) && conductsNative(into))) { after.core=withPayload(after.core,payloadOf(withLife(shaped,r.after.z))); }
 if(floor(r.after.w)!=floor(r.before.w)) {
  let ct=u32(max(floor(r.after.w),0.0));
  if(conductsNative(into)) { after.core.w=withSpark(shaped,ct).w; } else { after.core.y=withCtype(shaped,ct).y; }
 }
}` : '';
  const head=`${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${nativeDynamicsHead(g)}
${scratchWGSL}
${boxWGSL}${opts.motion?.decls ?? ''}
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
let id=cid(before.core);let k=cls(id);var flags=0u;${sources}${renameNow}${vaporise}
if(r.before.x!=r.after.x) { flags=2u|(u32(r.after.x)<<8u); }
if((k==2u || k==3u || flags!=0u) && r.motion.w!=0.0) { flags|=1u; }
${opts.motion?.flags ?? ''}${opts.sparse?'if(flags!=0u) { ':''}plans[s]=ForcePlan(${opts.motion?.velocity ?? `r.motion.xyz*${SI}`},flags);${opts.sparse?' }':''}
${opts.life?'var':'let'} after=forceHeat(before,r);${life}
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
if(r.motion.w!=0.0) { particle.velocity=r.motion.xyz*${SI}; }
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
  const plan=make('ForcePlan',nativeForceCommitWGSL(sim.g,params,'plan',spec.commit ?? {}),[o.nativeDynamics.layout,commitLayout]);
  const commit=make('ForceParticleCommit',nativeForceCommitWGSL(sim.g,params,'particles'),[o.nativeDynamics.layout,commitLayout]);
  const air=make('ForceAir',nativeWeatherCommitWGSL(sim.g,params,'air'),[o.nativeDynamics.layout,commitLayout]);
  const kernels=[evaluate,particles,plan,commit,air],ready=Promise.all(kernels.map(k=>k.ready));ready.catch(()=>{});
  // defer: leave the launches planned for the caller's flush (dynamics.flushLaunch) after the take
  // it records next: V1's melee took its chips before any step could move them (tools/melee.js).
  // parts: [{ box, values }], one writer's boxes in place of `box` (the laser's beam segments:
  // shaders/povBore.js LASER_SEGMENT), each evaluated with its own values over its own box, all on
  // the same frozen grid, then planned in turn into one plan clear and one allocation. Their rule
  // must leave every cell to one part (it changes nothing elsewhere) and the commit must be sparse,
  // or a later part's empty plans would clear an earlier part's. `box` is then their union, the
  // particles' (each particle is evaluated once, with `values` alone).
  // ownReady: its own kernels are built (isReady: and the dynamics', whose stages its launches record)
  return {ready,get ownReady(){return kernels.every(k=>k.state==='ready');},get isReady(){return kernels.every(k=>k.state==='ready') && d.isReady;},run(box,values,source,{defer=false,parts=null}={}) {
    if(kernels.some(k=>k.state!=='ready') || !d.isReady || sim.disposed || sim.compactOwner!==o || !box) return false;
    if(parts && !spec.commit?.sparse) throw Error(`${name}: parts need a sparse commit`);
    const dims=[sim.g.nx,sim.g.ny,sim.g.nz],clip=b=>({lo:b.lo.map(v=>Math.max(0,Math.ceil(v))),hi:b.hi.map((v,a)=>Math.min(dims[a]-1,Math.floor(v)))});
    const empty=b=>b.lo.some((v,a)=>v>b.hi[a]);
    box=clip(box);
    if(empty(box)) return false;
    const limit=Math.min(gpu.limits?.maxStorageBufferBindingSize??128*1024*1024,gpu.limits?.maxBufferSize??Infinity);
    const chunks=[];
    function split(b,own) {
      const count=b.hi.reduce((n,v,a)=>n*(v-b.lo[a]+1),1);
      if(count*64<=limit) {chunks.push({box:b,count,own});return;}
      const a=b.hi.map((v,a)=>v-b.lo[a]).indexOf(Math.max(...b.hi.map((v,a)=>v-b.lo[a])));
      const cut=Math.floor((b.lo[a]+b.hi[a]+1)/8)*4;
      if(cut<=b.lo[a] || cut>b.hi[a]) throw Error('Native force scratch cannot fit binding limit');
      const left={lo:[...b.lo],hi:[...b.hi]},right={lo:[...b.lo],hi:[...b.hi]};left.hi[a]=cut-1;right.lo[a]=cut;split(left,own);split(right,own);
    }
    if(!parts) split(box,null);
    else for(const part of parts) { const b=clip(part.box); if(!empty(b)) split(b,part.values); }
    if(!chunks.length || 65536*64>limit) return false;
    o.sync();
    const buffer=n=>gpu.createBuffer({label:name+' force results',size:n*64,usage:0x80});
    const entries=(buffers,start=0)=>buffers.map((buffer,i)=>({binding:start+i,resource:{buffer}}));
    const group=(layout,scratch,particle=false)=>gpu.bindGroup(layout,[...(source?[{binding:0,resource:{buffer:source}}]:[]),...entries([scratch,...(particle?[d.particles]:[])],1)],name);
    const commitGroup=scratch=>gpu.bindGroup(commitLayout,entries([scratch,d.air[d.airIndex],d.plans,d.particles]),name);
    const p=(b,own)=>({...nativeModes(sim),...values,...own,editLo:b.lo,editHi:b.hi,tick:o.tick+1,origin:[sim.origin.x,sim.origin.y,sim.origin.z]});
    const dispatch=(k,n,bind,b,physical=false,own=null)=>k.dispatch(gpu.frame,fold(Math.ceil(n/64)),{bind,header:physical?sim.readHeader({physical:true}):sim.header(),params:p(b,own)});
    // Every predicate, including strike's neighbour walk, sees the SAME frozen grid.
    for(const c of chunks) { c.scratch=buffer(c.count);dispatch(evaluate,c.count,[sim.tables,sim.bindPhysicalRO,group(evalLayout,c.scratch)],c.box,true,c.own); }
    const particleScratch=buffer(65536);dispatch(particles,65536,[sim.tables,sim.bindPhysicalRO,group(particleLayout,particleScratch,true)],box,true);
    d.flushLaunch?.(); // (a launch left for an earlier take: these plans are the next)
    gpu.frame.clear(d.plans);
    for(const c of chunks) {
      const bind=[o.nativeDynamics.group,commitGroup(c.scratch)];dispatch(plan,c.count,bind,c.box,false,c.own);
      const bricks=c.box.hi.reduce((n,v,a)=>n*(Math.floor(v/4)-Math.floor(c.box.lo[a]/4)+1),1);dispatch(air,bricks,bind,c.box,false,c.own);
    }
    if(defer) d.deferLaunch(o.tick+1); else d._allocate(o.tick+1,{mode:NATIVE_LAUNCH_MODE});
    dispatch(commit,65536,[o.nativeDynamics.group,commitGroup(particleScratch)],box);
    for(const c of chunks) sim._retire(c.scratch);sim._retire(particleScratch);
    o.legacyPending=o.writtenSinceTick=true;sim.version++;o.seenVersion=sim.version;sim.changedAll=true;d._externalWork();sim.wake();
    return true;
  }};
}
