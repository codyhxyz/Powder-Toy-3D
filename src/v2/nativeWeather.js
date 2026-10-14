import { fold } from '../gpu/kernels.js';
import { uniformStruct } from '../gpu/params.js';
import { prelude, STATE_OPTS, EDIT_FIELDS, STAGE, SEED_MAX } from '../shaders/common.js';
import { nativeDynamicsHead, SUB, TICK_HZ, FULL } from '../shaders/v2.js';
import { MODE_FIELDS, nativeModes } from './modes.js';
import { modeWGSL } from '../shaders/v2/modes.js';
import { fallWGSL } from '../shaders/v2/fall.js';
import { E } from '../elements.js';
import { CELL_M } from '../scale.js';
import { LEGACY_PRESSURE_PA } from './pressure.js';

// TPT source speeds are authored in cells/240 Hz step. Native face flux is
// fill quanta/180 Hz substep; air is m/s and Pa, never legacy B storage.
export const WEATHER_SPEED_SI = 240 * CELL_M;
export const WEATHER_SPEED_FLUX = 240 * FULL / (SUB * TICK_HZ);
const binding = (n, read = false) => ({ binding: n, visibility: STAGE.COMPUTE, buffer: { type: read ? 'read-only-storage' : 'storage' } });
export const NATIVE_WEATHER_COMMIT_LAYOUT = [binding(0, true), binding(1), binding(2)];
export const scratchWGSL = 'struct WeatherResult { before: vec4f, after: vec4f, motion: vec4f, airDelta: vec4f }';
export const boxWGSL = `
fn weatherSize() -> vec3u { return vec3u(P.editHi - P.editLo + 1); }
fn weatherIndex(p: vec3i) -> u32 { let q=vec3u(p-P.editLo); let n=weatherSize(); return q.x+n.x*(q.y+n.y*q.z); }
fn weatherCell(i: u32) -> vec3i { let n=weatherSize(); return P.editLo+vec3i(vec3u(i%n.x,(i/n.x)%n.y,i/(n.x*n.y))); }
fn weatherCount() -> u32 { let n=weatherSize(); return n.x*n.y*n.z; }
`;
export const weatherMain = body => `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
let i=(wg.x+wg.y*nwg.x)*64u+li;
${body}
}`;
export function nativeWeatherParams(name, spec) {
  const fields = spec.params?.fields ? Object.fromEntries(spec.params.fields.map(f => [f.name, f.type])) : spec.params;
  return uniformStruct(`${name}NativeParams`, { ...EDIT_FIELDS, ...fields, tick: 'u32', ...MODE_FIELDS });
}
export function nativeWeatherEvaluateWGSL(g, spec, params) {
  return `${prelude(g, STATE_OPTS.STATE_RO)}
${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${modeWGSL}
${fallWGSL}
${spec.decls ?? ''}
${spec.nativeForcing ? 'fn ownLegacy(s: u32) {} // force evaluators never claim legacy replacement ownership' : ''}
${scratchWGSL}
${spec.nativeParticles ? `struct ForceParticle { position: vec3f, id: u32, velocity: vec3f, c0: u32, tail: vec4u }
@group(2) @binding(2) var<storage, read> forceParticles: array<ForceParticle>;` : ''}
@group(2) @binding(1) var<storage, read_write> results: array<WeatherResult>;
${boxWGSL}
${spec.update}
${weatherMain(`${spec.nativeParticles ? `if(i>=65536u) { return; }
let particle=forceParticles[i];if(particle.id==0u || (particle.c0&255u)>=254u) { return; }
let p=vec3i(floor(particle.position))-H.origin;
if(!inGrid(p) || any(p<P.editLo) || any(p>P.editHi)) { return; }
let a=compactProbeA(p,vec4u(particle.c0,particle.tail.xyz));
var b=vec4f(particle.velocity/${WEATHER_SPEED_SI},fetchB(p).w);` : `if(i>=weatherCount()) { return; }
let p=weatherCell(i); let a=fetchA(p); var b=fetchB(p);`}
${spec.nativeForcing && !spec.nativeParticles ? `if(KIND(eid(a))==K_POWDER) {
 b=vec4f(vec3f(0,-fallVelocity(fetchNativeCore(p)),0)/${WEATHER_SPEED_SI},b.w);
}` : ''}
// Read canonical liquid faces even when the renderer would dither this cell out.
if(KIND(eid(a))==K_LIQUID${spec.nativeParticles ? ' && false' : ''}) {
 let c=fetchNativeCore(p); b=vec4f(vec3f(unpack2x16float(c.z),unpack2x16float(c.w & 65535u).x)/${WEATHER_SPEED_FLUX},b.w);
}
var outA=a; var outB=b; update(p,a,b,&outA,&outB);
${spec.nativePrecipitation ? `if(eid(a)==E_EMPTY && (eid(outA)==E_WATER || eid(outA)==E_SNOW)) {
 let gravity=mGravity(vec3f(p)+0.5); let speed=length(gravity);
 var down=vec3f(0); if(speed>0.0) { down=gravity/speed; }
 outB=vec4f(vec3f(outB.x,0,outB.z)+down*abs(outB.y),outB.w);
}` : ''}
var delta=vec4f((outB.xyz-b.xyz)*${WEATHER_SPEED_SI},(outB.w-b.w)*${LEGACY_PRESSURE_PA});
if(KIND(eid(outA))==K_LIQUID${spec.nativePrecipitation ? ' || eid(outA)==E_SNOW' : ''}${spec.nativeForcing ? ' || KIND(eid(outA))==K_POWDER || KIND(eid(outA))==K_SOLID' : ''}) { delta=vec4f(0,0,0,delta.w); }
${spec.nativeParticles ? 'delta=vec4f(0);' : ''}
results[i]=WeatherResult(a,outA,vec4f(outB.xyz,select(0.0,1.0,any(outB.xyz!=b.xyz))),delta);`)}
`;
}
export function nativeWeatherCommitWGSL(g, params, stage) {
  const head = `${params.wgsl}
@group(3) @binding(1) var<uniform> P: ${params.name};
${nativeDynamicsHead(g)}
${scratchWGSL}
@group(1) @binding(0) var<storage, read> results: array<WeatherResult>;
struct WeatherPlan { velocity: vec3f, flags: u32 }
@group(1) @binding(2) var<storage, read_write> plans: array<WeatherPlan>;
struct WeatherAir { vp: vec4f, thermal: vec4f }
@group(1) @binding(1) var<storage, read_write> air: array<WeatherAir>;
${boxWGSL}
`;
  if (stage === 'sourcePlan') return head + weatherMain(`if(i>=weatherCount()) { return; }
let r=results[i]; let p=weatherCell(i);
// Only snow emitted by THIS pulse; no existing powder, fog, or neighbours.
if(r.before.x==0.0 && u32(r.after.x)==${E.SNOW}u) {
 plans[slotOf(p)]=WeatherPlan(r.motion.xyz*${WEATHER_SPEED_SI},1u);
}
`);
  if (stage === 'air') return head + weatherMain(`
let b0=P.editLo/4; let nb=vec3u(P.editHi/4-b0+1);
if(i>=nb.x*nb.y*nb.z) { return; }
let b=b0+vec3i(vec3u(i%nb.x,(i/nb.x)%nb.y,i/(nb.x*nb.y)));
var delta=vec4f(0);
for(var z=0;z<4;z++) { for(var y=0;y<4;y++) { for(var x=0;x<4;x++) {
 let p=b*4+vec3i(x,y,z);
 if(all(p>=P.editLo) && all(p<=P.editHi)) { delta+=results[weatherIndex(p)].airDelta/64.0; }
} } }
if(!mAirVelocity()) { delta=vec4f(0,0,0,delta.w); }
if(!mAirPressure()) { delta.w=0.0; }
if(any(delta!=vec4f(0))) { let k=brickId(b); air[k].vp+=delta; air[k].thermal.z=0.0; markBusy(b*4); }
`);
  return head + weatherMain(`if(i>=weatherCount()) { return; }
let p=weatherCell(i); let s=slotOf(p); let r=results[i];
let before=loadMaterial(s); var m=before;
let id=u32(r.after.x);
if(r.before.x!=r.after.x) {
 // Only a genuinely new source cell gets fresh fill/bank/seed.
 m=makeMaterial(id,r.after.y,FULLU,u32(floor(r.after.w)));
 m.core=withLife(m.core,r.after.z);
 if(!isLiq(m.core)) { m.core.w=u32(fract(r.after.w)/${SEED_MAX / 65536})<<16u; }
} else {
 if(r.after.y!=r.before.y) {
  let dt=i32(round((r.after.y-r.before.y)*4.0));
  let heat=energyMul(capacityQ(m.core),u32(abs(dt)));
  m=withEnergy(m,energyAdd(energyOf(m),select(heat,energyNeg(heat),dt<0)));
 }
 if(r.after.z!=r.before.z) { m.core=withLife(m.core,r.after.z); }
 if(floor(r.after.w)!=floor(r.before.w)) {
  if(conductsNative(id)) { m.core=withSpark(m.core,u32(floor(r.after.w))); }
  else { m.core=withCtype(m.core,u32(floor(r.after.w))); }
 }
}
if(isLiq(m.core) && r.motion.w!=0.0) {
 let q=clamp(r.motion.xyz*${WEATHER_SPEED_FLUX},vec3f(-Q_MAX),vec3f(Q_MAX));
 m.core.z=pack2x16float(q.xy); m.core.w=(m.core.w&0xffff0000u)|(pack2x16float(vec2f(q.z,0))&65535u);
}
if(any(m.core!=before.core) || m.bank!=before.bank) {
 noteEnergySource(p,energySub(energyOf(m),energyOf(before)));
 storeMaterial(s,before,m);
 for(var z=-1;z<=1;z++) { for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) { markBusy(p+4*vec3i(x,y,z)); } } }
}
`);
}

// Not an edit adapter: no writes to legacy A/B, no legacy projection/import.
// The existing rules run against a native physical snapshot, then only explicit
// property changes are committed. Scratch is bounded to the producer's box.
export function createNativeWeatherKernel(sim, name, spec) {
  const o=sim.compactOwner, d=o?.dynamics, gpu=sim.gpu;
  if(!d) throw new Error(`${name}: native dynamics unavailable`);
  const params=nativeWeatherParams(name,spec);
  const evalLayout=gpu.layout(`${name}NativeEvaluate`,[...(spec.layout ?? []),binding(1)]);
  const commitLayout=gpu.layout('NATIVE_WEATHER_COMMIT',NATIVE_WEATHER_COMMIT_LAYOUT);
  const evaluate=gpu.kernel({name:`${name}NativeEvaluate`,code:nativeWeatherEvaluateWGSL(sim.g,spec,params),params,
    layouts:[sim.L.TABLES,sim.L.STATE_RO,evalLayout]});
  const commits=Object.fromEntries(['material','air',...(spec.nativePrecipitation?['sourcePlan']:[])].map(stage=>[stage,gpu.kernel({name:`${name}Native${stage}`,params,
    code:nativeWeatherCommitWGSL(sim.g,params,stage),layouts:[o.nativeDynamics.layout,commitLayout]})]));
  const ready=Promise.all([evaluate.ready,...Object.values(commits).map(k=>k.ready),d.ready]);
  ready.catch(()=>{});
  const built = () => evaluate.state==='ready' && Object.values(commits).every(k=>k.state==='ready') && d.isReady;
  const status = { get state() { return built() ? 'ready' : 'pending'; } };
  const kernel = { ready, main:status, apply:status,
    run(box, values, source) {
      if(!built() || sim.disposed || o.disposed || sim.compactOwner!==o) return false;
      if(!box || box.lo.some((v,a)=>v>box.hi[a])) return false;
      const count=box.hi.reduce((n,v,a)=>n*(v-box.lo[a]+1),1);
      const limit=Math.min(gpu.limits?.maxStorageBufferBindingSize ?? 128*1024*1024, gpu.limits?.maxBufferSize ?? Infinity);
      if(count*64>limit) {
        // Split only X/Z, at brick boundaries: weather's above-neighbour reads
        // retain their snapshot and no coarse air brick receives two targets.
        const axis=box.hi[0]-box.lo[0]>=box.hi[2]-box.lo[2]?0:2;
        const cut=Math.floor((box.lo[axis]+box.hi[axis]+1)/8)*4;
        if(cut<=box.lo[axis] || cut>box.hi[axis]) throw new RangeError('Native weather scratch exceeds device binding limit');
        const left={lo:[...box.lo],hi:[...box.hi]},right={lo:[...box.lo],hi:[...box.hi]};
        left.hi[axis]=cut-1;right.lo[axis]=cut;
        return kernel.run(left,values,source) && kernel.run(right,values,source);
      }
      o.sync();
      const scratch=gpu.createBuffer({label:`${name} native results`,size:count*64,usage:0x80});
      const entries=(buffers,start=0)=>buffers.map((buffer,i)=>({binding:start+i,resource:{buffer}}));
      const evalGroup=gpu.bindGroup(evalLayout,[...(source?[{binding:0,resource:{buffer:source}}]:[]),...entries([scratch],1)],name);
      const commitGroup=gpu.bindGroup(commitLayout,entries([scratch,d.air[d.airIndex],d.plans]),name);
      const p={...nativeModes(sim),...values,editLo:box.lo,editHi:box.hi,tick:o.tick+1};
      const dispatch=(k,n,bind,header)=>{ k.dispatch(gpu.frame,fold(Math.ceil(n/64)),{bind,header,params:p}); sim.onPass?.(k.name,{kind:'compute',gpuMs:null}); };
      dispatch(evaluate,count,[sim.tables,sim.bindPhysicalRO,evalGroup],sim.readHeader({physical:true}));
      dispatch(commits.material,count,[o.nativeDynamics.group,commitGroup],sim.header());
      const bricks=box.hi.reduce((n,v,a)=>n*(Math.floor(v/4)-Math.floor(box.lo[a]/4)+1),1);
      dispatch(commits.air,bricks,[o.nativeDynamics.group,commitGroup],sim.header());
      if (spec.nativePrecipitation) {
        // Reuse native count/prefix/free-list allocation and its exact carrier /
        // capacity fallback. No second particle engine or unbounded CPU readback.
        gpu.frame.clear(d.plans);
        dispatch(commits.sourcePlan,count,[o.nativeDynamics.group,commitGroup],sim.header());
        d._allocate(o.tick+1);
      }
      sim._retire(scratch);
      o.legacyPending=o.writtenSinceTick=true;
      sim.version++; o.seenVersion=sim.version; sim.changedAll=true;
      d._externalWork(); sim.wake();
      return true;
    },
  };
  return kernel;
}
