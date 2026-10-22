// CPU-only: execute complete emitted bodies through finite syntax/vector/atomic adapters.
import { test } from 'node:test';
import { gridLayout } from '../../src/sim.js';
import { impactFoam } from '../../src/v2/foam.js';
import { PHYS } from '../../src/physics.js';
import { PHASE_ROWS, PHASE_NORMAL_MAX } from '../../src/v2/phase.js';
import assert from 'node:assert/strict';
import {particlesWGSL,heldBase,shockPostBase,setOffBase,airborneBase} from '../../src/shaders/v2/particles.js';
import {AIRBORNE} from '../../src/v2/airborne.js';
import {nativeDynamicsHead} from '../../src/shaders/v2.js';
import {E,ELEMENTS,R} from '../../src/elements.js';
import {RAYS} from '../../src/rays.js';
import {V1_STEP_MS,STEP_S} from '../../src/v2/gravity.js';
import * as L from '../../src/v2/layout.js';
import {dynamicsRows,claimKey,CELL_M,DT,GRAVITY,SHOCK_THROW_MS,PACKET_SHOCK_LANDINGS,particleLandingSpeed,packetShock,v1ShockFall,SHOCK_FALL_CELLS,impact,PACKET_KEEP,packetStep,impactHeat,packetGrainOdds,PACKET_GRAIN_ODDS,v1GrainOdds,packetKnock} from '../../src/v2/dynamics-reference.js';
import { importMinified } from './wgsl-grouping.mjs';
const floatBits=v=>{const b=new ArrayBuffer(4);new Float32Array(b)[0]=v;return new Uint32Array(b)[0];};
const close=(a,b,e,what)=>assert.ok(Math.abs(a-b)<=e,`${what??""}: ${a} vs ${b}`);
const bitsFloat=w=>{const b=new ArrayBuffer(4);new Uint32Array(b)[0]=w;return new Float32Array(b)[0];};
const g={nx:32,ny:32,nz:32,nbx:8,nby:8,nbz:8,nbricks:512,slots:32768,windowed:false},NONE=0xffffffff,S=Object.fromEntries(['clear','integrate','elect','impact','deposit','reactClaim','reactDust'].map(s=>[s,particlesWGSL(g,nativeDynamicsHead,s)]));
const add=(a,b)=>a.map((v,i)=>v+(Array.isArray(b)?b[i]:b)),sub=(a,b)=>a.map((v,i)=>v-b[i]),mul=(a,b)=>a.map(v=>v*b),vec=(...v)=>v.flat().length===1?Array(3).fill(v[0]):v.flat(),copy=structuredClone;
function body(s,name) {
  const at=s.indexOf(`fn ${name}(`);assert.ok(at>=0,name);
  const b=s.indexOf('{',at);let n=1,e=b+1;
  for(;n;e++){if(s[e]==='{')n++;if(s[e]==='}')n--;}
  return s.slice(b+1,e-1);
}
function syntax(s){for(const [a,b] of [
['var after=incoming','var after=copy(incoming)'],['var rests = withEnergy(mover, combined);','var rests = copy(withEnergy(mover, combined));'], ['after=before;','after=copy(before);'],
['var cell=start;','var cell=[...start];'],
['-mDown(vec3f(cell)+0.5)','mul(mDown(add(cell,0.5)),-1)'],
['all(direction==vec3i(0))','direction.every(v=>v===0)'],
['all(cell==start)','cell.every((v,i)=>v===start[i])'],
['cell+direction','add(cell,direction)'],
['face>>1','Math.floor(face/2)'],
['0.5*vec3f(f32(NX),f32(NY),f32(NZ))-p','sub(mul(vec3f(NX,NY,NZ),0.5),p)'],
['normalize(d)*P.gravity','mul(normalize(d),P.gravity)'],
['((p%n)+n)%n','p.map((v,a)=>(v%n[a]+n[a])%n[a])'],
['array<u32,12>','Array.of'],
['bitcast<vec3u>','floatBits3'],
['bitcast<u32>(-velocity)','floatBits(-velocity)'],
['let t = dThread(wg,nwg,li);',''],
['var particle = particles[t]','var particle = copy(particles[t])'],
['var p = particles[t]','var p = copy(particles[t])'],
['particle.position - vec3f(P.origin)','sub(particle.position,vec3f(P.origin))'],
['any(local<vec3f(0))','local.some(v=>v<0)'],
['any(local>=vec3f(32.0,32.0,32.0))','local.some(v=>v>=32)'],
['v + acceleration * D_DT - wind','sub(add(v,mul(acceleration,D_DT)),wind)'],
['(after - v) / D_DT','mul(sub(after,v),1/D_DT)'],
['v - wind','sub(v,wind)'],
['wind + relative / (1.0 + drag * length(relative) * D_DT)','add(wind,mul(relative,1/(1+drag*length(relative)*D_DT)))'],
['v * D_RAY_DT / D_CELL','mul(v, D_RAY_DT / D_CELL)'],['local + travel','add(local, travel)'],['(flown.velocity - v) / D_DT','mul(sub(flown.velocity, v), 1/D_DT)'],
['v + acceleration * D_DT','add(v,mul(acceleration,D_DT))'],
['end - local','sub(end,local)'],
['var cell = startCell; var previous = startCell','var cell = [...startCell]; var previous = [...startCell]'],
['v+acceleration*(D_DT*entry)','add(v,mul(acceleration,D_DT*entry))'],
['vec3f(previous+P.origin)+0.5','add(add(previous,P.origin),0.5)'],
['previous = cell;','previous = [...cell];'],
['end + vec3f(P.origin)','add(end,vec3f(P.origin))'],
['any(cell != startCell)','cell.some((v,i)=>v!==startCell[i])'],
['local + delta * max(0.0,hitT - 0.00001 / max(length(delta),0.00001)) + vec3f(P.origin)','add(add(local,mul(delta,max(0,hitT-0.00001/max(length(delta),0.00001)))),P.origin)'],
['dWrap(particle.position-vec3f(P.origin))+vec3f(P.origin)','add(dWrap(sub(particle.position,vec3f(P.origin))),P.origin)'],
['vec3f(cell)+0.5','add(cell,0.5)'],
['mDown(vec3f(c)+0.5)','mDown(add(c,0.5))'],
['all(down==vec3i(0))','down.every(v=>v===0)'],
['cell+down','add(cell,down)'],
['p.velocity *= sqrt(max(0.0,1.0-cost/max(f.effect.x,0.000001)))','p.velocity=mul(p.velocity,sqrt(max(0,1-cost/max(f.effect.x,0.000001))))'],
['mEdge(p + face6(f))','mEdge(add(p,face6(f)))'],
// the photon step (particles.js dPhotonStep, dPhotonMoved, dPhotonIntegrate) and its impact
['out.light *= r','out.light = mul(out.light, r)'],['dot(out.light - left,','dot(sub(out.light, left),'],
['out.light * exp(-optics.xyz * dAmount(m) * max(0.0, exit - entry) * len)','out.light.map((e,i)=>e*Math.exp(-optics[i]*dAmount(m)*max(0, exit-entry)*len))'],
['any(optics.xyz > vec3f(0))','optics.slice(0,3).some(v=>v>0)'],
['var q = p;','var q = copy(p);'],['var particle = particle0;','var particle = copy(particle0);'],
['p.velocity * D_RAY_DT / D_CELL','mul(p.velocity, D_RAY_DT / D_CELL)'],['particle.velocity * D_RAY_DT / D_CELL','mul(particle.velocity, D_RAY_DT / D_CELL)'],
['p.position + delta * max(0.0, travelled - 0.00001 / max(length(delta), 0.00001))','add(p.position, mul(delta, max(0, travelled - 0.00001 / max(length(delta), 0.00001))))'],
['p.position + delta;','add(p.position, delta);'],['f.destination.z >> 16u','f.destination.z >>> 16'],['bitcast<f32>(','bitsFloat('],['vec3f(cellOf(s) + P.origin) + 0.5','add(add(cellOf(s),P.origin),0.5)'],
['min(abs(velocity) * D_SHOCK_THROW, vec3f(D_V_MAX))','abs(velocity).map(x=>Math.min(x*D_SHOCK_THROW,D_V_MAX))'],
['vec4u(warm.core.yzw, bitcast<u32>(warm.bank))','[...warm.core.slice(1,4), warm.bank>>>0]']])s=s.replaceAll(a,b);
return s.replace(/\/\/[^\n]*/g,'')
  .replace(/\bvar\b/g,'let')
  .replace(/\bloop\s*\{/g,'while(true){')
  .replace(/\b(0x[\da-f]+|\d+)u\b/gi,'$1')
  .replace(/\b(let|const) (\w+): (u32|i32|f32|bool)/g,'$1 $2')
  .replace(/&(control|claims)\[([^\]]+)\]/g,'[$1,$2]')
  .replace(/\.xyz\b/g,'.slice(0,3)')
  .replace(/\.(x|y|z|w)\b/g,(_,v)=>`[${'xyzw'.indexOf(v)}]`)
  .replace(/~(\w+(?:\.\w+|\[[^\]]+\])*)/g,'(~$1>>>0)');}
const compile=(ctx,s,name,args=[])=>new Function('ctx',...args,`with(ctx){${syntax(body(s,name))}}`).bind(null,ctx);
// Foundation material/energy codecs are production CPU helpers. Only storage,
// vectors, bitcasts, atomics and syntax are adapted; no landing/election model.
function fixture({mode=0, edge=0, windowed=false,
  position=[18.796724319458008,.5098053216934204,15.5], velocity=[0,0,0],
  material=L.makeMaterial(E.SAND), held=0, gravity=GRAVITY}={}) {
  const world=new Map(), claims=new Uint32Array(g.slots*4);
  const control=new Uint32Array(setOffBase(g)+65536), flight=[];
  const particles=[{position:[...position],velocity:[...velocity],id:2487686783,
    c0:material.core[0],tail:[...material.core.slice(1),material.bank>>>0]}];
  control[heldBase(g)]=held;control[0]=particles.length;
  // As if clear saw the live packet; tick() runs the real clear stage.
  flight[65536]={destination:[particles.length,0,0,0],effect:[0,0,0,0]};
  const slotOf=p=>p[0]+32*p[1]+1024*p[2];
  const cellOf=s=>[s%32,Math.floor(s/32)%32,Math.floor(s/1024)];
  const ctx={...L,add,sub,mul,copy,vec3f:vec,vec3i:(...v)=>vec(...v).map(Math.trunc),
    vec4f:vec,vec4u:(...v)=>Uint32Array.from(v.flat()),vec2u:vec,f32:Number,
    u32:v=>Math.trunc(v)>>>0,i32:Math.trunc,select:(a,b,c)=>c?b:a,any:Boolean,all:Boolean,
    max:Math.max,min:Math.min,ceil:Math.ceil,sqrt:Math.sqrt,
    abs:v=>Array.isArray(v)?v.map(Math.abs):Math.abs(v),
    length:v=>Math.hypot(...v),dot:(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),
    floor:v=>Array.isArray(v)?v.map(Math.floor):Math.floor(v),
    sign:v=>Array.isArray(v)?v.map(Math.sign):Math.sign(v),
    fract:v=>v.map(x=>x-Math.floor(x)),normalize:v=>mul(v,1/Math.hypot(...v)),
    floatBits,floatBits3:v=>v.map(floatBits),
    P:{origin:[0,0,0],edge,tick:108,gravMode:mode,gravity,substep:0},
    D_CAP:65536,D_SWEEP:65536,D_HELD:heldBase(g),D_NONE:NONE,D_PHOTON:254,D_NEUTRON:255,
    D_SHOCK_COUNT:shockPostBase(g),D_SET_OFF:setOffBase(g),D_AIRBORNE_POSTS:airborneBase(g)+1,D_REQUEST_SHIFT:28,D_DUST:E.DUST,
    D_REACT_KIND:AIRBORNE.KIND,D_REACT_SALT:AIRBORNE.SALT,
    C_AIR:0,C_SOLID:1,C_POWDER:2,C_LIQUID:3,C_GAS:4,
    D_G:GRAVITY,D_DT:DT,D_RAY_DT:Math.fround(DT/4),D_RAYS:31,D_PHOTON_HEAT:RAYS.PHOTON_HEAT/3,D_PHOTON_E_MIN:RAYS.PHOTON_E_MIN,D_PHOTON_CELLS:7,
    dCap:id=>ELEMENTS[id]?.cap??1,draw:0.5,dRandom:()=>ctx.draw,dShockOdds:packetGrainOdds,D_GRAIN_SALT:0x6772616e,D_LAND_KEEP:PHYS.LAND_POWDER_KEEP,D_LAND_SCATTER:PHYS.LAND_POWDER_SCATTER,vec2f:vec,
    energyMul:(a,b)=>BigInt(a)*BigInt(b),
    DKnock:(done,packet,cell)=>({done,packet,cell}),dCarrier:m=>L.makeMaterial(0,L.cTq(m.core)*0.25-273.25),
    dParticle:(position,velocity,id,m)=>({position:[...position],velocity:[...velocity],id,c0:m.core[0],tail:[...m.core.slice(1),m.bank>>>0]}),
    DPacketFlight:(cells,velocity)=>({cells:[...cells],velocity:[...velocity]}),dKeep:id=>PACKET_KEEP[id],
    D_V1_STEP:Math.fround(1/V1_STEP_MS),D_PULL_STEP:Math.fround(STEP_S*STEP_S/CELL_M),D_STEPS:4,
    DPhotonStep:(light,heat,cell,travelled,flip,gone)=>({light:[...light],heat,cell,travelled,flip,gone}),round:Math.round,clamp:(x,a,b)=>Math.min(Math.max(x,a),b),
    exp:Math.exp,log:Math.log,mix:(a,b,t)=>a+(b-a)*t,bitsFloat,dPhotonEnergy:p=>Array.from(p.tail).slice(0,3).map(bitsFloat),
    // particles.js dOptical, the renderer's sigma and an opaque element's reflectance
    dOptical:id=>[...(ELEMENTS[id]?.sigma??[0,0,0]),ELEMENTS[id]?.render===R.OPAQUE?-(1+(ELEMENTS[id].reflect??0)):0],D_CELL:CELL_M,D_SWEEP_MAX:99,NX:32,NY:32,NZ:32,
    D_WINDOWED:windowed,FULLU:L.FULL,particles,flight,control,claims,air:[{vp:[0,0,0,0]}],
    DFlight:(destination,effect)=>({destination,effect}),
    DDeposit:(material,accepted)=>({material:copy(material),accepted}),
    slotOf,cellOf,inGrid:p=>p.every(v=>v>=0&&v<32),
    mAirVelocity:()=>false,brickOfCell:()=>0,
    dWrap:v=>edge===2?v.map(x=>(x%32+32)%32):v,dWake:()=>{},slotLive:()=>true,noteDead:()=>{},noteLive:()=>{},dKey:id=>claimKey(id,108),
    dMaterial:p=>({core:Uint32Array.from([p.c0,...p.tail.slice(0,3)]),bank:p.tail[3]|0}),
    cls:id=>id?ELEMENTS[id].kind:0,isLiq:c=>L.isLiquid(L.cid(c)),
    dTerminal:id=>dynamicsRows[id].terminal,dMass:id=>dynamicsRows[id].mass,dDens:id=>ELEMENTS[id]?.dens??0,
    dAmount:m=>L.isLiquid(L.cid(m.core))?L.cFill(m.core)/L.FULL:1,
    dParticleEnergy:L.packetOwnedEnergy,energyAdd:(a,b)=>a+b,energySub:(a,b)=>a-b,noteEnergySource:()=>{},
    // particles.js dHeatEnergy: one legacy cap·°C is 256·FULL native energy units
    dHeatEnergy:(m,heat)=>L.energyOf(m)+BigInt(Math.round(Math.abs(heat)*256))*65536n*(heat<0?-1n:1n),
    dToughness:id=>dynamicsRows[id].toughness,dBreak:id=>dynamicsRows[id].breakInto,
    dShockKE:id=>dynamicsRows[id].shockKE,dShockFall:id=>dynamicsRows[id].shockFall,
    D_V_MAX:PHYS.V_MAX,D_SHOCK_THROW:Math.fround(1/SHOCK_THROW_MS),D_RESTITUTION:PHYS.RESTITUTION,D_COLLIDE_V:PHYS.COLLIDE_V,
    MATERIAL_BURNS:ELEMENTS.map(e=>e.burnRate>0),conductsNative:L.isConductor,
    withPayload:(c,v)=>L.withPayload({core:c,bank:0},v).core,
    face6:f=>{const d=[0,0,0];d[f>>1]=1-2*(f&1);return d;},
    storeMaterial:(s,b,a)=>world.set(s,copy(a)),
    // shaders/v2/state.js decoStorageWGSL's twins: the grid's and the pool's decoration words
    decoPlane:new Map(),particleDecoPlane:new Map(),
    decoOf:s=>ctx.decoPlane.get(s)??0,setDeco:(s,d)=>ctx.decoPlane.set(s,d>>>0),
    particleDecoOf:i=>ctx.particleDecoPlane.get(i)??0,setParticleDeco:(i,d)=>ctx.particleDecoPlane.set(i,d>>>0),
    loadMaterial:s=>copy(world.get(s)??L.makeMaterial(0)),loadCore:s=>ctx.loadMaterial(s).core,
    atomicLoad:([a,i])=>a[i],atomicAdd:([a,i],n)=>a[i]+=n,atomicSub:([a,i],n)=>a[i]-=n,
    atomicMax:([a,i],n)=>a[i]=Math.max(a[i],n>>>0),atomicStore:([a,i],n)=>a[i]=n,
    atomicExchange:([a,i],n)=>{const old=a[i];a[i]=n;return old;},
    // (the react order's content hash, airborne.js dReactHash: no order is modelled here)
    dReactHash:()=>0,
    atomicCompareExchangeWeak:([a,i],old,n)=>{
      if(a[i]!==old)return {exchanged:false};a[i]=n;return {exchanged:true};
    },
  };
  for(const [name,args] of [
    ['mEdge',['p']],
['mGravity',['p']],
['mDown',['p']],
    ['impactFoam',['incoming','resident','amount','fill','speed2']],
    ['setFall',['c','velocity','fraction']],
['dDeposit',['before','incoming','kinetic']],
    ['dRecover',['start','local','incoming','kinetic']],
['dBefore',['a','b']],
    ['dSameLiquid',['a','b']],
['dLiquidStreamPasses',['cell','incoming','resident']],
    ['dClaim',['s','kind','key']],
['dFree',['s','kind']],
['dPoolEmpty',[]],
['dWon',['s','kind','index']],
['dElect',['s','kind','index']],
['dHitKE',['mi','mj','jSolid','u2']],
['dShockLand',['mover','charge']],
['dShockActs',['me','j','v']],
['dLanding',['c','axis','velocity']],
['dShockHit',['t','s','p','hit','axis']],
['dDustFaces',['s']],
['dShockWall',['t','pid','u','landing','particleId']],
['dPhotonStep',['local','delta','light0']],['dKnock',['t','s','p','before','axis','landing']],['dImpactHeat',['pid','tid','velocity','axis','c']],['dPacketFlight',['v0','wind','pull','keep','paced']],['dPhotonMoved',['p','light','travelled','flip']],['dPhotonIntegrate',['t','particle0','local']],['dAddHeat',['m','heat']],
  ])ctx[name]=compile(ctx,S.integrate,name,args);
  const stages=Object.fromEntries(Object.entries(S).map(([s,c])=>[s,compile(ctx,c,'main',['t'])]));
  return {ctx,world,particles,claims,flight,stages,set:(p,m)=>world.set(slotOf(p),copy(m)),
    tick:()=>{
      stages.clear(0);
      for(const s of ['integrate','elect','impact','deposit'])
        for(let t=0;t<particles.length;t++)stages[s](t);
    }};
}

test('captured embedded SAND settles; ordinary AIR priority; held never deposits',()=>{
  const f=fixture(); const start=[18,0,15],target=[18,1,15];
  const incoming=f.ctx.dMaterial(f.particles[0]); incoming.core[2]=0xdeadbeef;
  f.particles[0].tail[1]=incoming.core[2];
  f.set(start,L.makeMaterial(E.SAND)); const original=copy(f.world);
  f.stages.integrate(0);
  assert.equal(f.flight[0].destination[1],f.ctx.slotOf(target));
  assert.deepEqual(f.world,original,'selection is read-only');
  assert.deepEqual(f.ctx.dMaterial(f.particles[0]),incoming,'no debit during selection');
  for(const stage of ['elect','impact'])f.stages[stage](0);
  f.ctx.control[0]=1; f.stages.deposit(0);
  assert.equal(f.particles[0].id,0); assert.equal(f.ctx.control[0],0);
  const after=f.ctx.loadMaterial(f.ctx.slotOf(target));
  assert.equal(L.energyOf(after),L.energyOf(L.makeMaterial(0))+L.packetOwnedEnergy(incoming));
  assert.equal(after.core[2],0x80000000,'actual resting-fall reset');
  f.stages.deposit(0); assert.equal(f.ctx.control[0],0,'one retirement only');
  const land=fixture({position:[18.8,1.1,15.5],velocity:[0,-6,0]});
  land.set(start,L.makeMaterial(E.SAND)); land.tick();
  assert.equal(land.flight[0].destination[1],land.ctx.slotOf(target)); assert.equal(land.particles[0].id,0);
  for(const position of [[18.8,1.1,15.5],[18.8,.5,15.5]]) {
    const hold=fixture({position,velocity:[0,-6,0],held:7});hold.set(start,L.makeMaterial(E.SAND));
    for(let i=0;i<3;i++){hold.tick();assert.equal(hold.flight[0].destination[1],NONE);assert.notEqual(hold.particles[0].id,0);}
  }
});

const wet=(fill=L.FULL,id=E.WATER,t=20,ct=0)=>L.makeMaterial(id,t,fill,ct);
const at=(f,p)=>f.ctx.loadMaterial(f.ctx.slotOf(p));
function preelect(f,p,kinetic=0) {
  const s=f.ctx.slotOf(p);f.flight[0]={destination:[NONE,s,1,0],effect:[kinetic,0,0,0]};
  f.claims[s*4+3]=1; f.ctx.control[0]=1;return s;
}
function unchangedRefusal(f,p) {
  const packet=copy(f.particles[0]),world=copy(f.world),live=f.ctx.control[0];
  f.stages.deposit(0); assert.deepEqual(f.particles[0],packet);assert.deepEqual(f.world,world);assert.equal(f.ctx.control[0],live);
}

test('R14 film/pool witness merges current first, then previous if current full; previous AIR still wins',()=>{
  for(const pool of [L.FULL,L.MAX_FILL]) {
    const f=fixture({position:[6.5,2.25,6.5],velocity:[0,-12,0],material:wet(4096)});
    f.set([6,2,6],wet(16384));f.set([6,1,6],wet(pool));f.set([6,0,6],L.makeMaterial(E.STONE));
    const target=[6,pool===L.FULL?1:2,6],before=at(f,target),incoming=f.ctx.dMaterial(f.particles[0]);
    f.tick();assert.equal(f.flight[0].destination[0],f.ctx.slotOf([6,1,6]));
    assert.equal(f.flight[0].destination[1],f.ctx.slotOf(target));assert.equal(f.particles[0].id,0);
    assert.equal(L.cFill(at(f,target).core),L.cFill(before.core)+4096);
    assert.equal(L.energyOf(at(f,target)),L.energyOf(before)+L.packetOwnedEnergy(incoming));
    assert.equal(L.cFill(at(f,[6,target[1]===1?2:1,6]).core),target[1]===1?16384:pool);
  }
  const f=fixture({position:[6.5,2.1,6.5],velocity:[0,-6,0],material:wet(4096)});
  f.set([6,1,6],wet());f.set([6,0,6],L.makeMaterial(E.STONE));f.tick();
  assert.equal(f.flight[0].destination[1],f.ctx.slotOf([6,2,6]));assert.equal(L.cFill(at(f,[6,1,6]).core),L.FULL);
  const elected=fixture({material:wet(4096)});elected.set([6,1,6],wet());preelect(elected,[6,1,6]);elected.stages.deposit(0);
  assert.equal(elected.particles[0].id,0);assert.equal(L.cFill(at(elected,[6,1,6]).core),L.FULL+4096);
});

test('four native-cell steps exactly; deeper stacks and OTHER barriers retain payload without relocation',()=>{
  for(const depth of [1,2,3,4,5]) {
    const f=fixture({position:[10.5,.5,10.5]});for(let y=0;y<depth;y++)f.set([10,y,10],L.makeMaterial(E.SAND));
    const before=copy(f.particles[0]),world=copy(f.world);f.tick();
    if(depth<=4){assert.equal(f.particles[0].id,0);assert.equal(f.flight[0].destination[1],f.ctx.slotOf([10,depth,10]));}
    else {assert.equal(f.flight[0].destination[1],NONE);assert.deepEqual(f.particles[0],before);assert.deepEqual(f.world,world);}
  }
  for(const id of [E.STONE,E.OIL,E.DUST]) {
    const f=fixture({position:[10.5,.5,10.5]});f.set([10,0,10],L.makeMaterial(E.SAND));f.set([10,1,10],L.makeMaterial(id));
    const before=copy(f.particles[0]),world=copy(f.world);f.tick();
    assert.equal(f.flight[0].destination[1],NONE);assert.deepEqual(f.particles[0],before);assert.deepEqual(f.world,world);
  }
  // Refused liquid followed by AIR must not become a traversal exemption.
  const f=fixture({material:wet(4096),position:[10.5,.5,10.5]});f.set([10,0,10],wet(L.MAX_FILL));
  const before=copy(f.particles[0]),world=copy(f.world);f.tick();
  assert.equal(f.flight[0].destination[1],NONE);assert.deepEqual(f.particles[0],before);assert.deepEqual(f.world,world);
  for(const [incoming,resident] of [[L.makeMaterial(E.SAND),L.makeMaterial(E.STONE)],[wet(4096),wet(1,E.OIL)],
    [wet(4096,E.LAVA,1700,E.STONE),wet(1,E.LAVA,1700,E.GLASS)]]) {
    const f=fixture({material:incoming,position:[10.5,.5,10.5]});f.set([10,0,10],resident);
    const before=copy(f.particles[0]);f.tick();assert.equal(f.flight[0].destination[1],NONE);assert.deepEqual(f.particles[0],before);
  }
});

test('recovery uses local mode down, zero-down nearest face/ties, edges and periodic return guard',()=>{
  for(const [mode,position,target] of [[0,[10.5,2.5,10.5],[10,3,10]],[2,[25.5,16.5,16.5],[26,16,16]]]) {
    const f=fixture({mode,position}),start=position.map(Math.floor);f.set(start,L.makeMaterial(E.SAND));f.tick();
    assert.equal(f.flight[0].destination[1],f.ctx.slotOf(target));assert.equal(f.particles[0].id,0);
  }
  for(const mode of [1,0])for(let face=0;face<6;face++) {
    const frac=[.5,.5,.5];frac[face>>1]=(face&1)?.1:.9;
    const position=add([10,10,10],frac),f=fixture({mode,gravity:mode===0?0:GRAVITY,position});
    f.set([10,10,10],L.makeMaterial(E.SAND));f.tick();
    assert.equal(f.flight[0].destination[1],f.ctx.slotOf(add([10,10,10],f.ctx.face6(face))));
  }
  const tie=fixture({mode:1,position:[10.5,10.5,10.5]});tie.set([10,10,10],L.makeMaterial(E.SAND));tie.tick();
  assert.equal(tie.flight[0].destination[1],tie.ctx.slotOf([11,10,10]),'equal distances use +x first');
  const radial=fixture({mode:2,position:[24.5,16.5,16.5]}),calls=[];
  for(let x=24;x<28;x++)radial.set([x,16,16],L.makeMaterial(E.SAND));
  const down=radial.ctx.mDown;radial.ctx.mDown=p=>{calls.push([...p]);return down(p);};radial.tick();
  assert.deepEqual(calls,[[24.5,16.5,16.5],[25.5,16.5,16.5],[26.5,16.5,16.5],[27.5,16.5,16.5]],'down recomputed at every step');
  for(const edge of [0,1,2])for(const windowed of [false,true]) {
    const f=fixture({position:[10.5,31.5,10.5],edge,windowed});f.set([10,31,10],L.makeMaterial(E.SAND));f.tick();
    assert.equal(f.flight[0].destination[1],edge===2?f.ctx.slotOf([10,0,10]):NONE);
    assert.equal(f.particles[0].id===0,edge===2,'no out-of-grid receiver even at open/window edge');
  }
  // Two-cell periodic fixture forces the start-return guard within four steps.
  const cycle=fixture({edge:2,position:[.5,.5,.5]});Object.assign(cycle.ctx,{NX:2,NY:2,NZ:2,inGrid:p=>p.every(v=>v>=0&&v<2)});
  cycle.set([0,0,0],L.makeMaterial(E.SAND));cycle.set([0,1,0],L.makeMaterial(E.SAND));
  assert.equal(cycle.ctx.dRecover([0,0,0],[.5,.5,.5],cycle.ctx.dMaterial(cycle.particles[0]),0),NONE);
});

test('full single-winner fill/fuel headroom, no clipping, conductor max, burning OR, retained wet lanes',()=>{
  for(const extra of [-1,0,1]) {
    const f=fixture({material:wet(4096)}),p=[6,1,6];f.set(p,wet(L.MAX_FILL-4096+extra));preelect(f,p);
    if(extra>0)unchangedRefusal(f,p);else {f.stages.deposit(0);assert.equal(f.particles[0].id,0);assert.equal(L.cFill(at(f,p).core),L.MAX_FILL+extra);}
  }
  for(const fuel of [65535-4000,65535-4000+1]) {
    const f=fixture({material:L.withPayload(wet(4096,E.OIL),4000)}),p=[6,1,6];f.set(p,L.withPayload(wet(16384,E.OIL),fuel));preelect(f,p);
    if(fuel+4000>65535)unchangedRefusal(f,p);else {f.stages.deposit(0);assert.equal(L.payloadOf(at(f,p).core),65535);}
  }
  for(const [id,ctype] of [[E.OIL,73],[E.MERCURY,197],[E.LAVA,E.STONE]])for(const burning of [0,1,2,3]) {
    let incoming=L.withPayload(wet(4096,id,id===E.LAVA?1700:90,ctype),1234);
    let before=L.withPayload(wet(16384,id,id===E.LAVA?1600:20,ctype),9876);
    incoming.core[0]|=37<<24;before.core[0]|=81<<24;before.core[2]=0x12345678;before.core[3]|=0x9abc;
    if(ELEMENTS[id].burnRate>0){incoming.core[1]|=(burning&1)?0x80000000:0;before.core[1]|=(burning&2)?0x80000000:0;}
    const f=fixture({material:incoming}),p=[6,1,6];f.set(p,before);preelect(f,p,.01);f.stages.deposit(0);const after=at(f,p);
    assert.equal(f.particles[0].id,0);assert.equal(L.ctypeOf(after.core),ctype);
    assert.equal(after.core[2],before.core[2]);assert.equal(after.core[3]&65535,before.core[3]&65535);
    assert.equal(L.payloadOf(after.core),L.isConductor(id)?9876:11110);
    if(ELEMENTS[id].burnRate>0)assert.equal(after.core[1]>>>31,+(burning!==0));
    assert.equal(L.energyOf(after),L.energyOf(before)+L.packetOwnedEnergy(incoming));
    const speed2=.02/Math.max(dynamicsRows[id].mass*4096/L.FULL,.000001);
    assert.equal(after.core[0]>>>24,impactFoam({incoming:37,resident:81,amount:4096,fill:16384,speed2}));
    const stable=copy(after);f.stages.deposit(0);assert.deepEqual(at(f,p),stable,'no second foam decoration');
  }
});

test('exact unequal-temperature, signed-bank and latent packet energies; AIR metadata and refusals',()=>{
  const materials=[];
  for(const id of [E.WATER,E.OIL,E.MERCURY,E.LAVA])for(const bank of [-2147483648,-173,0,2147483647]) {
    const m=wet(4096,id,id===E.LAVA?1700:90,id===E.LAVA?E.STONE:0);m.bank=bank;materials.push(m);
  }
  for(const hot of [false,true]) {
    const r=PHASE_ROWS[E.WATER],latent=hot?r.hotLatent:r.coldLatent;
    const m=wet(4096,E.WATER,(hot?r.hotQ:r.coldQ)*.25-273.25);
    const phase=L.withPacketEnergy(m,L.packetOwnedEnergy(m)+(hot?1n:-1n)*BigInt(latent)*4096n/2n);
    assert(L.cRawTq(phase.core)>PHASE_NORMAL_MAX);materials.push(phase);
  }
  for(const incoming of materials)for(const air of [false,true]) {
    const before=air?L.makeMaterial(0,-10):wet(16384,L.cid(incoming.core),10,L.ctypeOf(incoming.core));before.bank=-97;
    incoming.core[2]=0x2468ace0;incoming.core[3]|=0x1234;
    const f=fixture({material:incoming}),p=[6,1,6];f.set(p,before);preelect(f,p);
    const total=L.energyOf(before)+L.packetOwnedEnergy(incoming),packet=copy(f.particles[0]);f.stages.deposit(0);
    assert.equal(f.particles[0].id,0);assert.equal(L.energyOf(at(f,p)),total);
    if(air){assert.equal(at(f,p).core[2],incoming.core[2]);assert.equal(at(f,p).core[3],incoming.core[3]);assert.equal(L.ctypeOf(at(f,p).core),L.ctypeOf(incoming.core));}
    assert.notDeepEqual(f.particles[0],packet);
  }
  const hot=wet(4096,E.WATER,PHASE_NORMAL_MAX*.25-273.25);hot.bank=2147483647;
  const f=fixture({material:hot}),p=[6,1,6],before=L.makeMaterial(0,PHASE_NORMAL_MAX*.25-273.25);before.bank=2147483647;
  f.set(p,before);preelect(f,p);unchangedRefusal(f,p);
});

test('fresh receiver/held recheck: incompatibility, LAVA subtype, fill/fuel/energy refusal preserves every byte',()=>{
  for(const [incoming,replacement] of [[wet(4096),wet(1,E.OIL)],[wet(4096),wet(L.MAX_FILL)],
    [wet(4096,E.LAVA,1700,E.STONE),wet(1,E.LAVA,1700,E.GLASS)],
    [L.withPayload(wet(4096,E.OIL),65535),L.withPayload(wet(4096,E.OIL),1)],
    [L.makeMaterial(E.SAND),L.makeMaterial(E.STONE)]]) {
    const f=fixture({material:incoming}),p=[6,1,6];f.set(p,L.makeMaterial(0));preelect(f,p);f.set(p,replacement);unchangedRefusal(f,p);
  }
  const f=fixture(),p=[6,1,6];preelect(f,p);f.ctx.control[f.ctx.D_HELD]=7;unchangedRefusal(f,p);
  const high=PHASE_NORMAL_MAX*.25-273.25,incoming=wet(4096,E.WATER,high);
  incoming.bank=2147483647;
  const energy=fixture({material:incoming});preelect(energy,p);
  const changed=wet(L.FULL,E.WATER,high);changed.bank=2147483647;energy.set(p,changed);
  unchangedRefusal(energy,p);
});

test('actual claim/election/impact/deposit: reversed invocation, key tie, loser retention and one retirement',()=>{
  for(const order of [[0,1],[1,0]])for(const tie of [false,true]) {
    const f=fixture({material:wet(4096),position:[6.4,1.5,6.5]});f.set([6,1,6],wet());f.set([6,0,6],L.makeMaterial(E.STONE));
    f.particles.push({...copy(f.particles[0]),id:171,position:[6.6,1.5,6.5]});
    if(tie)f.ctx.dKey=()=>7;
    f.ctx.control[0]=0;
    for(const stage of ['integrate','elect','impact'])for(const t of order)f.stages[stage](t);
    const s=f.ctx.slotOf([6,1,6]),winner=f.claims[s*4+3]-1,loser=1-winner;
    const expected=tie?0:(f.ctx.dKey(f.particles[0].id)<f.ctx.dKey(f.particles[1].id)?0:1);
    assert.equal(winner,expected);const retained=copy(f.particles[loser]);
    for(const t of order)f.stages.deposit(t);
    assert.equal(f.particles[winner].id,0);assert.deepEqual(f.particles[loser],retained);
    assert.equal(f.ctx.control[0],1);assert.equal(L.cFill(at(f,[6,1,6]).core),L.FULL+4096);
    for(const t of order)f.stages.deposit(t);assert.equal(f.ctx.control[0],1);
  }
});

test('actual admission drives current-to-previous fallback on exact fuel/energy refusal',()=>{
  for(const reason of ['fuel','energy']) {
    const high=PHASE_NORMAL_MAX*.25-273.25;
    let incoming=wet(4096,reason==='fuel'?E.OIL:E.WATER,reason==='energy'?high:20);
    let pool=wet(L.FULL,L.cid(incoming.core),reason==='energy'?high:20);
    if(reason==='fuel'){incoming=L.withPayload(incoming,65535);pool=L.withPayload(pool,1);}
    else {incoming.bank=2147483647;pool.bank=2147483647;}
    const f=fixture({material:incoming,position:[6.5,2.25,6.5],velocity:[0,-12,0]});
    f.set([6,2,6],L.withPayload(wet(16384,L.cid(incoming.core)),0));f.set([6,1,6],pool);f.set([6,0,6],L.makeMaterial(E.STONE));
    f.tick();assert.equal(f.flight[0].destination[1],f.ctx.slotOf([6,2,6]));assert.equal(f.particles[0].id,0);
    assert.deepEqual(at(f,[6,1,6]),pool,'refused hit receiver remains unchanged');
  }
});

test('minified emitted integrate/elect/impact/deposit parity on square and rectangular layouts',async()=>{
  const minified=await importMinified('src/shaders/v2/particles.js');
  for(const dims of [[32,32,32],[48,16,32]])for(const stage of Object.keys(S)) {
    const args=[gridLayout(...dims),nativeDynamicsHead,stage];
    assert.equal(minified.particlesWGSL(...args),particlesWGSL(...args),`${stage}/${dims}`);
  }
});

test('minimum/full/compressed packets and exact MAX_FILL energy-bearing receivers',()=>{
  for(const amount of [1,L.FULL,L.MAX_FILL])for(const air of [false,true]) {
    const incoming=wet(amount),f=fixture({material:incoming}),p=[6,1,6];
    const before=air?L.makeMaterial(0):wet(L.MAX_FILL-amount);
    f.set(p,before);preelect(f,p);f.stages.deposit(0);
    assert.equal(f.particles[0].id,0);assert.equal(L.cFill(at(f,p).core),air?amount:L.MAX_FILL);
    assert.equal(L.energyOf(at(f,p)),L.energyOf(before)+L.packetOwnedEnergy(incoming));
  }
});

const packet=(m,id,position,velocity)=>({position,velocity,id,c0:m.core[0],tail:[...m.core.slice(1),m.bank>>>0]});
const runTicks=(f,order,ticks,after=()=>{})=>{
  for(let tick=0;tick<ticks;tick++) {
    f.stages.clear(0);
    for(const s of ['integrate','elect','impact','deposit']) for(const t of order) f.stages[s](t);
    assert.ok(f.claims.every(v=>v===0),`tick ${tick}: every winner freed its claim words`);after(tick);
  }
};
test('winners free every claim: fracture, contention and ties leave an empty table in any thread order',()=>{
  // A fracture is not a landing, so impact itself frees the deposit claim it won.
  const glass=fixture({position:[6.5,2.5,6.5],velocity:[0,-80,0]});
  glass.set([6,1,6],L.makeMaterial(E.GLASS));glass.set([6,0,6],L.makeMaterial(E.STONE));
  runTicks(glass,[0],1);assert.equal(L.cid(at(glass,[6,1,6]).core),E.SHARDS);assert.notEqual(glass.particles[0].id,0);
  // V1 react.js: the debris takes the fracture work as heat, hard·KE_TO_HEAT / cap (glass → shards: ~+48 °C;
  // a native cell's capacity also holds its 1/64 air carrier).
  const warmed=L.cTq(at(glass,[6,1,6]).core)/4-273.25, rise=ELEMENTS[E.GLASS].hard*PHYS.KE_TO_HEAT*64/(Math.round(ELEMENTS[E.SHARDS].cap*64)+1);
  assert.ok(Math.abs(warmed-(20+rise))<=0.5,`shards at ${warmed} °C, V1 ${20+rise} °C`);
  for(const tie of [false,true]) {
    const run=reverse=>{
      const f=fixture({material:wet(4096),position:[6.5,2.5,6.5],velocity:[0,-6,0]});if(tie)f.ctx.dKey=()=>7;
      f.set([6,0,6],L.makeMaterial(E.STONE));f.set([7,0,6],L.makeMaterial(E.STONE));f.set([6,1,6],wet(L.FULL/2));
      for(let i=1;i<16;i++) f.particles.push(packet(i%3?wet(1024*i):L.makeMaterial(E.SAND),1000+7919*i,
        [6.2+(i%3)*.3,1.6+(i%5)*.4,6.2+(i%4)*.2],[(i%3)-1,-4-(i%4),0]));
      f.ctx.control[0]=f.particles.length;let contested=0;
      const order=[...f.particles.keys()];if(reverse) order.reverse();
      runTicks(f,order,8,()=>{const s=order.map(t=>f.flight[t]?.destination[1]).filter(s=>s!==undefined&&s!==NONE);contested+=s.length-new Set(s).size;});
      assert.ok(contested>0,'several packets claimed one receiver');
      return {world:[...f.world].sort((a,b)=>a[0]-b[0]),particles:f.particles,live:f.ctx.control[0]};
    };
    assert.deepEqual(run(true),run(false));
  }
});

// V1 react.js breaking in V1's units (dynamics-reference.js impact, the twin): ½·dens·vn² across the face, vn
// cells/step to V_MAX, against hard. V2 compared ½·kg·(m/s)² with hard, so a grain broke glass at walking pace.
test('the emitted impact breaks what V1\'s flying cell breaks, at V1\'s speeds, as its twin (BL-3)',()=>{
  const cases=[['SAND','GLASS',-20],['SAND','GLASS',-80],['SAND','METAL',-200],['SAND','WOOD',-5],['STONE','GLASS',-70],
    ['NUGGETS','METAL',-60],['NUGGETS','METAL',-50],['WATER','LAMP',-80],['WATER','GLASS',-80],['SCRAP','BRICK',-60]];
  for(const [mover,solid,vy] of cases) {
    const f=fixture({material:mover==='WATER'?wet():L.makeMaterial(E[mover]),position:[6.5,1.05,6.5],velocity:[0,vy,0]});
    f.set([6,0,6],L.makeMaterial(E[solid]));runTicks(f,[0],1);
    const want=impact(L.makeMaterial(E[mover]).core,[0,f.particles[0].velocity[1]===0?vy:vy,0],L.makeMaterial(E[solid]).core);
    const broke=L.cid(at(f,[6,0,6]).core)!==E[solid];
    assert.equal(broke,want.broken,`${mover} at ${vy} m/s on ${solid}`);
    if(broke) assert.ok(Math.abs(f.particles[0].velocity[1]-want.speed)<=Math.abs(want.speed)*0.02+0.05,`${mover}: ${f.particles[0].velocity[1]} vs ${want.speed}`);
  }
  // sand at walking pace and at its terminal speed lands on glass, wood and metal without a scratch
  for(const solid of ['GLASS','WOOD','METAL']) {
    const f=fixture({position:[6.5,1.05,6.5],velocity:[0,-43,0]});f.set([6,0,6],L.makeMaterial(E[solid]));runTicks(f,[0],1);
    assert.equal(L.cid(at(f,[6,0,6]).core),E[solid],`sand at its terminal speed on ${solid}`);
  }
});

// V1's rays (src/rays.js, shaders/rays.js raysAdvanceFrag) on V1's clock: the ray stages run once a V1 step,
// RAY_STEPS_PER_TICK a tick (dynamics.js advanceParticles), each a photon's 2 cells (PHOTON_V) and one interaction.
const photon=(life=RAYS.PHOTON_LIFE)=>({core:Uint32Array.from([254|(life<<8),floatBits(1),floatBits(1),floatBits(1)]),bank:0});
const raySteps=(f,steps)=>{for(let k=0;k<steps;k++){f.ctx.P.substep=k%4;if(k%4===0)f.stages.clear(0);
  for(const s of ['integrate','elect','impact','deposit'])for(let t=0;t<f.particles.length;t++)f.stages[s](t);}};
const light=f=>Array.from(f.particles[0].tail).slice(0,3).map(bitsFloat);
test('a photon flies 2 cells a V1 step, 480 cells/s, for V1\'s 512 steps (EL-2)',()=>{
  const f=fixture({material:photon(),position:[2.5,10.5,10.5],velocity:[144,0,0]});
  raySteps(f,4);close(f.particles[0].position[0],10.5,1e-4,'a tick: 8 cells');
  assert.equal((f.particles[0].c0>>>8)&65535,RAYS.PHOTON_LIFE-4,'aged a V1 step a stage');
  // its life is V1's steps: 3 steps of life fly 2 of them, then it fades with no heat
  const fade=fixture({material:photon(3),position:[2.5,10.5,10.5],velocity:[144,0,0]});
  raySteps(fade,1);raySteps(fade,1);assert.notEqual(fade.particles[0].id,0);close(fade.particles[0].position[0],6.5,1e-4);
  raySteps(fade,1);assert.equal(fade.particles[0].id,0,'faded');assert.equal(fade.world.size,0,'its light heats nothing');
});
test('a photon goes straight through glass and water, dimming by Beer-Lambert, by a film\'s fill (EL-3, EL-4, EL-9)',()=>{
  for(const [id,fill] of [[E.GLASS,L.FULL],[E.WATER,L.FULL],[E.WATER,L.FULL/8]]) {
    const f=fixture({material:photon(),position:[2.5,10.25,10.75],velocity:[120,36,-48]});
    for(let x=4;x<14;x++)for(let y=8;y<16;y++)for(let z=4;z<14;z++)f.set([x,y,z],id===E.GLASS?L.makeMaterial(E.GLASS):wet(fill));
    const v0=[...f.particles[0].velocity];raySteps(f,4);
    assert.deepEqual(f.particles[0].velocity,v0,`${ELEMENTS[id].key}: no refraction, no slowing`);
    const travelled=Math.hypot(...sub(f.particles[0].position,[2.5,10.25,10.75]));
    close(travelled,Math.hypot(...v0)*DT/CELL_M,1e-3,`${ELEMENTS[id].key}: a tick's 8+ cells in the medium too`);
    const inside=travelled-(4-2.5)/(120/Math.hypot(...v0)),share=fill/L.FULL;
    light(f).forEach((e,i)=>close(e,Math.exp(-ELEMENTS[id].sigma[i]*share*inside),2e-3,`${ELEMENTS[id].key} channel ${i}`));
    let heat=0;for(const [,m] of f.world) heat+=L.cTq(m.core);assert.ok(f.world.size>0,'the light lost heats the medium');
  }
});
test('a metal reflects a photon off the face it hits, keeping its reflectance; wood takes it all as heat',()=>{
  const metal=fixture({material:photon(),position:[5.5,10.5,10.5],velocity:[144,0,0]});
  metal.set([7,10,10],L.makeMaterial(E.METAL));raySteps(metal,1);
  assert.equal(metal.particles[0].velocity[0],-144,'reflected across x');assert.ok(metal.particles[0].position[0]<7);
  const r=ELEMENTS[E.METAL].reflect;light(metal).forEach(e=>close(e,r,1e-6));
  const t0=L.cTq(L.makeMaterial(E.METAL).core),t1=L.cTq(at(metal,[7,10,10]).core);assert.ok(t1>t0,'the rest heats the metal');
  const wood=fixture({material:photon(),position:[5.5,10.5,10.5],velocity:[144,0,0]});
  wood.set([7,10,10],L.makeMaterial(E.WOOD));raySteps(wood,1);
  assert.equal(wood.particles[0].id,0,'absorbed');
  const warm=L.energyOf(at(wood,[7,10,10]))-L.energyOf(L.makeMaterial(E.WOOD));
  assert.equal(warm,BigInt(Math.round(RAYS.PHOTON_HEAT*256))*65536n,'all its light as PHOTON_HEAT');
});
test('a ray leaving the box is gone, past a loop edge too (EL-5)',()=>{
  for(const edge of [0,2]) {
    const f=fixture({edge,material:photon(),position:[30.5,10.5,10.5],velocity:[144,0,0]});raySteps(f,1);
    assert.equal(f.particles[0].id,0,`edge ${edge}`);
  }
  const neutron=fixture({edge:2,material:{core:Uint32Array.from([255,RAYS.NEUT_LIFE,floatBits(RAYS.NEUT_E_FAST),0]),bank:0},position:[30.5,10.5,10.5],velocity:[144,0,0]});
  neutron.ctx.dNuclear=()=>({fast:[0,0,0],thermal:[0,0,0],h:0,A:1,nuF:0,nuT:0});neutron.ctx.contactNuclearMaterial=()=>0;
  raySteps(neutron,1);assert.equal(neutron.particles[0].id,0,'a neutron too');
});

// V1's fall (react.js forces: a fixed drag a step; move.js: a grain's Margolus lag, a liquid's R3 draws), a V1 step at a
// time (dPacketFlight): the emitted stage lands a packet at the tick its twin does (dynamics-reference.js packetStep,
// which gravity-check holds to V1's arrival)
test('the emitted flight drops a packet on V1\'s law: it lands at its twin\'s tick (gravity leftover)',()=>{
  for(const [material,id] of [[L.makeMaterial(E.SAND),E.SAND],[L.makeMaterial(E.ASH),E.ASH],[wet(),E.WATER]]) {
    const f=fixture({material,position:[6.5,24.5,6.5],velocity:[0,0,0]});f.set([6,0,6],L.makeMaterial(E.ROCK));
    let tick=0;while(f.particles[0].id!==0&&tick<200){runTicks(f,[0],1);tick++;}
    let v=0,y=0,want=0;while(y<23.5*CELL_M){const st=packetStep(id,v);y+=st.fell;v=st.v;want++;}
    assert.ok(Math.abs(tick-want)<=1,`${ELEMENTS[id].key}: landed at tick ${tick}, its twin ${want}`);
  }
});

// V1 move.js impactHeat (TH-10): a grain stopped by a solid turns its lost KE into heat, KE_TO_HEAT per unit, shared by
// capacity so both warm alike (dynamics-reference.js impactHeat, the twin)
test('a grain landing hard on rock warms the rock and itself alike, as V1\'s impactHeat; nothing for a gentle one (TH-10)',()=>{
  const drop=(vy,solid=E.ROCK)=>{const f=fixture({position:[6.5,1.02,6.5],velocity:[3,vy,0]});f.set([6,0,6],L.makeMaterial(E[solid]??solid));runTicks(f,[0],1);return f;};
  const f=drop(-43),hit=f.flight[0],want=impactHeat(E.SAND,E.ROCK,[3,-43,0],1,true);
  const rise=L.energyOf(at(f,[6,0,6]))-L.energyOf(L.makeMaterial(E.ROCK));
  assert.ok(want.hit>0&&want.packet>0); close(Number(rise)/(256*65536),want.hit,0.01,'the rock takes its share');
  const sand=at(f,[6,1,6]);assert.equal(L.cid(sand.core),E.SAND,'landed above');
  const t=L.cTq(sand.core)/4-273.25,rock=L.cTq(at(f,[6,0,6]).core)/4-273.25;
  assert.ok(t>20.5&&rock>20.5&&Math.abs(t-rock)<1.5,`both warm alike: sand ${t} °C, rock ${rock} °C`);
  // under V1's COLLIDE_V (0.15 cells/step) it rests without heat; onto a powder (V1: a pile, not a solid) none either
  const gentle=drop(-6);assert.equal(L.energyOf(at(gentle,[6,0,6])),L.energyOf(L.makeMaterial(E.ROCK)));
  // (the blow passes into the pile and back off the box's floor: MV-12's knock; the grain comes back to its cell)
  const pile=drop(-43,E.STONE);for(let i=0;i<20&&pile.particles[0].id;i++) runTicks(pile,[0],1);
  assert.equal(L.cid(at(pile,[6,0,6]).core),E.STONE);assert.equal(L.energyOf(at(pile,[6,0,6])),L.energyOf(L.makeMaterial(E.STONE)));
});

// V1's grains land on their blocks' random draws: each grain on a charge rolls its own odds at its fall (v1GrainOdds),
// so a 4×4 uranium slab dropped a cell onto C-4 goes off 70 % of the time (BL-7); V2's packets had one fixed speed
test('a grain packet landing on a charge rolls V1\'s odds for its fall (BL-7)',()=>{
  const j=ELEMENTS[E.URANIUM],k=ELEMENTS[E.C4],at1=particleLandingSpeed(E.URANIUM,1*CELL_M);
  const p1=packetGrainOdds(E.URANIUM,E.C4,at1);close(p1,v1GrainOdds(j,j.dens,k.blast.shock,1),1e-6,'from a cell: V1\'s 7 %');
  const slab=1-(1-p1)**16;assert.ok(slab>0.65&&slab<0.75,`a 16-grain slab from a cell goes off ${(slab*100).toFixed(0)} % (V1 70 %)`);
  assert.ok(packetGrainOdds(E.SCRAP,E.C4,particleLandingSpeed(E.SCRAP,5*CELL_M))>0.05,'scrap from 5 cells: V1 10 %');
  assert.equal(packetGrainOdds(E.SAND,E.C4,72),0,'sand never (V1: ½·16·V_MAX² < 20)');
  // the emitted shock rolls the packet's draw against them
  const SP=shockPostBase(g),landed=draw=>{const f=fixture({material:L.makeMaterial(E.URANIUM),position:[18.8,1.05,15.5],velocity:[0,-at1,0]});
    f.ctx.draw=draw;f.set([18,0,15],L.makeMaterial(E.C4));f.tick();return f.ctx.control[SP]===1;};
  assert.equal(landed(p1*0.5),true,'a draw under its odds sets it off');assert.equal(landed(Math.min(0.99,p1*1.5+0.01)),false,'one over rests');
  // the WGSL's table is the twin's
  const wgsl=particlesWGSL(g,nativeDynamicsHead,'impact');
  for(const r of PACKET_GRAIN_ODDS) for(const b of r.bins) assert.ok(wgsl.includes(`vec2f(${b.speed},${b.odds})`),`${ELEMENTS[r.faller].key} on ${ELEMENTS[r.charge].key}`);
});

// V1 move.js collide (MV-12): a fast grain hitting a resting grain passes its momentum on with RESTITUTION, so a blow
// travels through a pile like a Newton's cradle (dynamics-reference.js packetKnock, the twin); V2's struck cells stayed
test('a grain thrown into a row of grains knocks the far ones on, as V1\'s cradle, cells and energy exact (MV-12)',()=>{
  const f=fixture({position:[8.9,0.5,6.5],velocity:[50,0,0]});
  // (three grains: RESTITUTION 0.3 and the grains' drag spend the blow in three, V1's as V2's)
  for(let x=10;x<13;x++) f.set([x,0,6],L.makeMaterial(E.SAND));
  for(let x=0;x<32;x++) for(let y=0;y<3;y++) if(!f.world.has(f.ctx.slotOf([x,y,6]))) f.set([x,y,6],L.makeMaterial(0)); // (the air it moves through, counted)
  const total=()=>{let n=0,e=0n;for(const [,m] of f.world){if(L.cid(m.core)===E.SAND)n++;e+=L.energyOf(m);}
    for(const q of f.particles) if(q.id){n++;e+=L.packetOwnedEnergy(f.ctx.dMaterial(q));}return {n,e};};
  const t0=total();runTicks(f,[0],1);
  assert.equal(L.cid(at(f,[9,0,6]).core),E.SAND,'the thrown grain rests before the row');
  assert.equal(L.cid(at(f,[10,0,6]).core),E.EMPTY,'the struck grain flew on');
  // (V1's split of its speed at the hit: the tick's drag takes up to its four steps' share before it)
  const hi=packetKnock(E.SAND,E.SAND,50).flies,lo=packetKnock(E.SAND,E.SAND,50*PACKET_KEEP[E.SAND]**4).flies,vx=f.particles[0].velocity[0];
  assert.ok(f.particles[0].id!==0&&vx>=lo*0.999&&vx<=hi*1.001,`${vx} m/s vs V1's ${lo}..${hi}`);
  assert.deepEqual(total(),t0,'every grain and every unit of energy kept');
  for(let i=0;i<20&&f.particles[0].id;i++) runTicks(f,[0],1);
  let far=-1;for(const [slot,m] of f.world) if(L.cid(m.core)===E.SAND) far=Math.max(far,f.ctx.cellOf(slot)[0]);
  assert.ok(far>=13,`the blow reached the row's end and moved it on (V1's cradle): farthest grain at x ${far}`);
  assert.equal(total().n,t0.n);
  // a gentle push under COLLIDE_V moves only what it hits (V1: support, no exchange)
  assert.equal(packetKnock(E.SAND,E.SAND,0.15*SHOCK_THROW_MS*0.9),null);
});

test('an empty pool reads no packet record and writes no flight record',()=>{
  const f=fixture();f.particles[0].id=0;f.ctx.control[0]=0;let reads=0;
  const pool=f.particles;f.ctx.particles=new Proxy(pool,{get:(a,k)=>{if(/^\d+$/.test(k))reads++;return a[k];}});
  const flight=copy(f.flight);runTicks(f,[0],2);
  assert.equal(reads,0);assert.equal(f.flight[65536].destination[0],0);
  f.flight[65536]=flight[65536];assert.deepEqual(f.flight,flight);
});

// V1 react.js shock (elements.js blast.shock; common.js hitKE, shockActs) on a packet's hit, in V1's units
// (dynamics-reference.js packetShock): the charge hit (in the grid: its detonation posted at its cell) or
// the charge hitting (in flight: set off, it lands with its detonation where it is).
test('a hit sets off C-4 and nitroglycerin as V1\'s shock: the charge hit and the charge hitting',()=>{
  const S0=shockPostBase(g),SET=setOffBase(g),A=airborneBase(g)+1,DET=1<<28,start=[18,0,15],above=[18,1,15],beside=[18,0,15];
  // a landing: down onto start's upper face; a throw: along +x into the cell beside
  const hit=(material,velocity,target)=>{
    const f=fixture({material,position:[18.8,1.1,15.5],velocity:[0,velocity,0]});
    f.set(start,target);f.tick();return f;
  };
  const thrown=(material,speed,target)=>{
    const f=fixture({material,position:[17.9,0.5,15.5],velocity:[speed,0,0]});
    f.set(beside,target);f.tick();return f;
  };
  const posted=f=>f.ctx.control[S0+1]===(f.ctx.slotOf(start)|DET)>>>0&&f.ctx.control[S0]===1;
  const quiet=f=>f.ctx.control[S0+1]===0&&f.ctx.control[S0]===0&&f.ctx.control[SET]===0;
  // sand never sets C-4 off (V1: ½·16·V_MAX² = 8, under its 20), landing or thrown, however fast
  for(const v of [-6,-25,-60])assert.ok(quiet(hit(L.makeMaterial(E.SAND),v,L.makeMaterial(E.C4))),`sand landing at ${-v} m/s`);
  for(const v of [6,40,100])assert.ok(quiet(thrown(L.makeMaterial(E.SAND),v,L.makeMaterial(E.C4))),`sand thrown at ${v} m/s`);
  // ...nor breaks wood (V1 react.js breaking: ½·16·vn² never reaches wood's hard 20; BL-3)
  let f=hit(L.makeMaterial(E.SAND),-6,L.makeMaterial(E.WOOD));assert.equal(L.cid(at(f,start).core),E.WOOD);
  // uranium does: landing past the speed a packet has after V1's fall (V1: 1.46 m), thrown past V1's speed
  // for it at V2's throw map (V1: √(2·20/191) cells/step, at SHOCK_THROW_MS m/s each)
  const uOn=PACKET_SHOCK_LANDINGS.find(r=>r.faller===E.URANIUM&&r.charge===E.C4).speed;
  assert.ok(Math.abs(uOn-particleLandingSpeed(E.URANIUM,v1ShockFall(E.URANIUM,E.C4)*CELL_M))<1e-3);
  // (the fixture's speed is before the tick's drag, which takes a few % of it at V1's terminal speeds)
  assert.ok(posted(hit(L.makeMaterial(E.URANIUM),-uOn*1.1,L.makeMaterial(E.C4))),'uranium landing past its fall');
  assert.ok(quiet(hit(L.makeMaterial(E.URANIUM),-uOn*0.9,L.makeMaterial(E.C4))),'uranium landing short of it');
  const uThrow=Math.sqrt(2*20/ELEMENTS[E.URANIUM].dens)*SHOCK_THROW_MS;
  assert.ok(posted(thrown(L.makeMaterial(E.URANIUM),uThrow*1.03,L.makeMaterial(E.C4))),'uranium thrown past V1\'s speed');
  assert.ok(quiet(thrown(L.makeMaterial(E.URANIUM),uThrow*0.97,L.makeMaterial(E.C4))),'uranium thrown under it');
  assert.ok(quiet(thrown(L.makeMaterial(E.URANIUM),uOn+0.3,L.makeMaterial(E.C4))),'a throw is no fall');
  // a liquid: mercury landing on C-4 past its fall sets it off (V1 does, as the column pass), water never
  const hgOn=PACKET_SHOCK_LANDINGS.find(r=>r.faller===E.MERCURY&&r.charge===E.C4).speed;
  assert.ok(posted(hit(wet(L.FULL,E.MERCURY),-hgOn*1.1,L.makeMaterial(E.C4))),'mercury landing past its fall');
  assert.ok(quiet(hit(wet(L.FULL,E.MERCURY),-hgOn*0.9,L.makeMaterial(E.C4))),'mercury short of it');
  assert.ok(quiet(hit(wet(),-60,L.makeMaterial(E.C4))),'water never');
  // nor does C-4 hit C-4 (its own element)
  assert.ok(quiet(hit(L.makeMaterial(E.C4),-60,L.makeMaterial(E.C4))));
  // nitroglycerin hit by sand: never by a fall (V1's sand tops out at 0.6 cells/step), only by a throw at
  // V1's cap (½·μ·V_MAX² = 3.99 against 3.9)
  assert.ok(quiet(hit(L.makeMaterial(E.SAND),-60,wet(L.FULL,E.NITRO))),'sand landing on nitroglycerin');
  const n=wet(L.FULL,E.NITRO);
  // (thrown past it: sand's drag, V1's terminal speed of 43 m/s, takes a fifth of a 72 m/s throw in a tick)
  f=thrown(L.makeMaterial(E.SAND),SHOCK_THROW_MS*1.3,n);assert.equal(f.ctx.control[S0+1],(f.ctx.slotOf(beside)|DET)>>>0,'sand thrown at V1\'s cap');
  assert.ok(quiet(thrown(L.makeMaterial(E.SAND),SHOCK_THROW_MS*0.97,n)),'sand thrown under it');
  // the charge hitting: a C-4 lump (V1 never moves a solid) thrown at metal past ½·dens·v² = 20 goes off,
  // lands and its detonation is posted there; dropped onto stone it never can (½·26·V_MAX² < 20)
  f=thrown(L.makeMaterial(E.C4),Math.sqrt(2*20/1000)*SHOCK_THROW_MS*1.05,L.makeMaterial(E.WALL));
  assert.equal(f.particles[0].id,0,'landed');assert.equal(f.ctx.control[A],(f.ctx.slotOf([17,0,15])|DET)>>>0,'its detonation posted where it landed');
  assert.ok(quiet(thrown(L.makeMaterial(E.C4),Math.sqrt(2*20/1000)*SHOCK_THROW_MS*0.95,L.makeMaterial(E.WALL))));
  f=hit(L.makeMaterial(E.C4),-60,L.makeMaterial(E.STONE));assert.equal(f.ctx.control[A],0);assert.equal(f.ctx.control[S0],0);
  // nitroglycerin landing on metal from a fall's speed goes off (V1's own fall, dynamics-reference.js
  // SHOCK_FALL_CELLS: 9 cells, nOn the packet's speed after it); from a gentler one it rests
  const nOn=particleLandingSpeed(E.NITRO,SHOCK_FALL_CELLS[E.NITRO]*CELL_M);
  f=hit(wet(L.FULL,E.NITRO),-nOn*1.15,L.makeMaterial(E.METAL));
  assert.equal(L.cid(at(f,above).core),E.NITRO);assert.equal(f.ctx.control[A],(f.ctx.slotOf(above)|DET)>>>0);
  f=hit(wet(L.FULL,E.NITRO),-nOn*0.85,L.makeMaterial(E.METAL));
  assert.equal(L.cid(at(f,above).core),E.NITRO);assert.equal(f.ctx.control[A],0);assert.equal(f.ctx.control[S0],0);
  // stone is a powder in V1 (loose matter): the reduced mass, so the same landing on it does not; one past the
  // speed whose V1 speed carries the shock for the reduced mass (common.js hitKE) does
  const mu=ELEMENTS[E.NITRO].dens*ELEMENTS[E.STONE].dens/(ELEMENTS[E.NITRO].dens+ELEMENTS[E.STONE].dens);
  const stoneOn=Math.sqrt(2*ELEMENTS[E.NITRO].blast.shock/mu)/dynamicsRows[E.NITRO].shockFall;
  f=hit(wet(L.FULL,E.NITRO),-nOn*1.15,L.makeMaterial(E.STONE));assert.equal(f.ctx.control[A],0);
  f=hit(wet(L.FULL,E.NITRO),-stoneOn*1.15,L.makeMaterial(E.STONE));assert.equal(f.ctx.control[A],(f.ctx.slotOf(above)|DET)>>>0);
  // onto water no landing ever carries it (V1: ½·6.1·V_MAX² = 3.07, under 3.9)
  f=hit(wet(L.FULL,E.NITRO),-80,wet());assert.equal(f.ctx.control[SET],0);
  // into its own pool it never does
  f=hit(wet(L.FULL/4,E.NITRO),-nOn*1.3,wet(L.FULL,E.NITRO));assert.equal(f.ctx.control[A],0);assert.equal(f.ctx.control[SET],0);
  // onto the box's floor (its solid edge, a wall): the same landing goes off there too, and a gentle one rests
  for(const [v,fired] of [[-nOn*1.15,true],[-nOn*0.85,false]]) {
    const w=fixture({material:wet(L.FULL,E.NITRO),position:[18.8,0.5,15.5],velocity:[0,v,0]});w.tick();
    assert.equal(w.particles[0].id,0,'landed on the floor');assert.equal(L.cid(at(w,start).core),E.NITRO);
    assert.equal(w.ctx.control[A],fired?(w.ctx.slotOf(start)|DET)>>>0:0,`${-v} m/s onto the floor`);
  }
  // a set-off charge that cannot land yet stays set off: the mark is its id, a later packet in the slot is not
  f=fixture({material:wet(L.FULL,E.NITRO),position:[18.8,1.1,15.5],velocity:[0,-nOn*1.3,0],held:3});
  f.set(start,L.makeMaterial(E.METAL));f.tick();
  assert.notEqual(f.particles[0].id,0,'held: no deposit');assert.equal(f.ctx.control[SET],f.particles[0].id);
});

test('the emitted shock decides every pair as its CPU twin and as V1\'s rule at the mapped speed',()=>{
  // V1 (react.js shock, common.js hitKE/shockActs) at a V1 speed v (cells/step), from the charge's side
  const kind=id=>ELEMENTS[id].kind,gasLike=id=>kind(id)===4||kind(id)===0,solid=id=>kind(id)===1;
  const v1=(me,j,v)=>{const m=ELEMENTS[me].dens,mj=ELEMENTS[j].dens;
    const ke=solid(me)?0.5*mj*v*v:0.5*(solid(j)?m:m*mj/(m+mj))*v*v;return ke>=ELEMENTS[me].blast.shock;};
  const charges=ELEMENTS.filter(e=>e.blast?.shock).map(e=>e.id);
  const matter=ELEMENTS.filter(e=>!gasLike(e.id)&&e.dens>0).map(e=>e.id);
  let fired=0;
  for(const c of charges) for(const j of matter) for(const u of [3,8,13,20,35,60,90]) {
    if(j===c) continue;
    // a throw: V1's speed at V2's throw map, capped
    const v=Math.min(PHYS.V_MAX,u/SHOCK_THROW_MS);
    assert.equal(packetShock(j,c,u,false).target,v1(c,j,v),`${ELEMENTS[j].key} thrown at ${ELEMENTS[c].key} ${u}`);
    assert.equal(packetShock(c,j,u,false).mover,v1(c,j,v),`${ELEMENTS[c].key} thrown at ${ELEMENTS[j].key} ${u}`);
    fired+=+packetShock(j,c,u,true).target;
  }
  assert.ok(fired>0);
  // the emitted WGSL (run on its CPU adapters) agrees with the twin, landing and thrown
  for(const c of charges) for(const j of [E.SAND,E.URANIUM,E.MERCURY,E.WATER,E.METAL,E.STONE,E.SCRAP,E.LAVA,E.MUD,E.SINGULARITY]) for(const u of [4,9,14,25,60]) {
    if(j===c) continue;
    for(const [mover,target] of [[j,c],[c,j]]) for(const landing of [true,false]) {
      const material=kind(mover)===3?wet(L.FULL,mover):L.makeMaterial(mover),tm=kind(target)===3?wet(L.FULL,target):L.makeMaterial(target);
      const f=landing?fixture({material,position:[18.8,1.1,15.5],velocity:[0,-u,0]}):fixture({material,position:[17.9,0.5,15.5],velocity:[u,0,0]});
      f.set(landing?[18,0,15]:[18,0,15],tm);f.tick();
      const want=packetShock(mover,target,u,landing);
      const got={target:f.ctx.control[shockPostBase(g)+1]!==0,mover:f.ctx.control[setOffBase(g)]!==0||f.ctx.control[airborneBase(g)+1]!==0};
      // (the velocity at the hit is the tick's start speed, its drag's and the pull's shares: within several percent)
      const near=packetShock(mover,target,u*1.05+0.5,landing),far=packetShock(mover,target,Math.max(0,u*0.9-0.5),landing);
      for(const k of ['target','mover']) if(near[k]===far[k]) assert.equal(got[k],want[k],`${ELEMENTS[mover].key} on ${ELEMENTS[target].key} at ${u} ${landing?'landing':'thrown'}: ${k}`);
    }
  }
});

test('a packet dropped onto C-4 or nitroglycerin goes off from V1\'s fall, not short of it (void edges, radial gravity)',()=>{
  // packets fall where the column pass doesn't (void and looped edges, radial gravity): dropped from rest
  for(const r of PACKET_SHOCK_LANDINGS.filter(r=>[E.URANIUM,E.MERCURY,E.SCRAP].includes(r.faller))) {
    const drop=h=>{
      const material=kind(r.faller)===3?wet(L.FULL,r.faller):L.makeMaterial(r.faller);
      const f=fixture({material,position:[18.5,1+h/CELL_M,15.5],velocity:[0,0,0]});
      f.set([18,0,15],kind(r.charge)===3?wet(L.FULL,r.charge):L.makeMaterial(r.charge));
      for(let t=0;t<200&&f.particles[0].id!==0&&!f.ctx.control[shockPostBase(g)];t++)runTicks(f,[0],1);
      return f.ctx.control[shockPostBase(g)]===1;
    };
    const m=r.cells*CELL_M;
    assert.ok(drop(m*1.08+0.05),`${ELEMENTS[r.faller].key} on ${ELEMENTS[r.charge].key} from past ${m.toFixed(2)} m`);
    assert.ok(!drop(m*0.92-0.05),`${ELEMENTS[r.faller].key} on ${ELEMENTS[r.charge].key} from short of ${m.toFixed(2)} m`);
  }
  function kind(id){return ELEMENTS[id].kind;}
});

// V1 react.js dust clouds count a dust cell's dust faces (nFuel). A wind-blown cloud flies as packets: each
// notes itself in its cell (reactClaim: the kind-1 key word deposit freed), reactDust counts a dust packet's
// faces, settled or flying, once all have, and each cell's react walker clears its notes.
test('a flying dust packet counts the dust beside it, settled or flying; the notes leave no claim behind',()=>{
  const f=fixture({material:L.makeMaterial(E.DUST),position:[10.5,10.5,10.5],velocity:[0,0,0]});
  const dust=L.makeMaterial(E.DUST),still=[0,0,0];
  // a pair in one cell, a neighbour face away, a lone mote, and one beside settled dust
  f.particles.push(packet(dust,11,[10.2,10.7,10.4],still),packet(dust,12,[11.5,10.5,10.5],still),
    packet(dust,13,[20.5,20.5,20.5],still),packet(dust,14,[5.5,5.5,5.5],still),packet(L.makeMaterial(E.SAND),15,[25.5,5.5,5.5],still));
  f.set([5,4,5],L.makeMaterial(E.DUST));f.ctx.control[0]=f.particles.length;
  const all=[...f.particles.keys()];
  for(const t of all) f.stages.reactClaim(t);
  for(const t of all) f.stages.reactDust(t);
  const faces=all.map(t=>f.flight[t].effect[1]);
  assert.deepEqual(faces,[2,2,1,0,1,0],'its cell-mate and its face neighbour; the lone mote none; settled dust counts; sand counts nothing');
  // the only kind-1 words set are dust hosts, each with a react list (its count in the kind-0 election
  // word), whose walker clears it
  for(let s=0;s<g.slots;s++) if(f.claims[s*4+2]) assert.notEqual(f.claims[s*4+1],0,`cell ${s} has a react list`);
  assert.match(particlesWGSL(g,nativeDynamicsHead,'react'),/atomicStore\(&claims\[s\*4u\],0u\); atomicStore\(&claims\[s\*4u\+1u\],0u\); atomicStore\(&claims\[s\*4u\+2u\],0u\);/);
});
