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
import {E,ELEMENTS} from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import {dynamicsRows,claimKey,CELL_M,DT,GRAVITY,SHOCK_THROW_MS,PACKET_SHOCK_LANDINGS,particleLandingSpeed,packetShock,v1ShockFall,SHOCK_FALL_CELLS} from '../../src/v2/dynamics-reference.js';
import { importMinified } from './wgsl-grouping.mjs';
const floatBits=v=>{const b=new ArrayBuffer(4);new Float32Array(b)[0]=v;return new Uint32Array(b)[0];};
const g={nx:32,ny:32,nz:32,nbx:8,nby:8,nbz:8,nbricks:512,slots:32768,windowed:false},NONE=0xffffffff,S=Object.fromEntries(['clear','integrate','elect','impact','deposit','reactClaim','reactDust'].map(s=>[s,particlesWGSL(g,nativeDynamicsHead,s)]));
const add=(a,b)=>a.map((v,i)=>v+(Array.isArray(b)?b[i]:b)),sub=(a,b)=>a.map((v,i)=>v-b[i]),mul=(a,b)=>a.map(v=>v*b),vec=(...v)=>v.flat().length===1?Array(3).fill(v[0]):v.flat(),copy=structuredClone;
function body(s,name) {
  const at=s.indexOf(`fn ${name}(`);assert.ok(at>=0,name);
  const b=s.indexOf('{',at);let n=1,e=b+1;
  for(;n;e++){if(s[e]==='{')n++;if(s[e]==='}')n--;}
  return s.slice(b+1,e-1);
}
function syntax(s){for(const [a,b] of [
['var after=incoming','var after=copy(incoming)'], ['after=before;','after=copy(before);'],
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
['local + (v * D_DT + 0.5 * acceleration * D_DT * D_DT) / D_CELL','add(local,mul(add(mul(v,D_DT),mul(acceleration,0.5*D_DT*D_DT)),1/D_CELL))'],
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
['mEdge(p + face6(f))','mEdge(add(p,face6(f)))']])s=s.replaceAll(a,b);
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
    P:{origin:[0,0,0],edge,tick:108,gravMode:mode,gravity},
    D_CAP:65536,D_SWEEP:65536,D_HELD:heldBase(g),D_NONE:NONE,D_PHOTON:254,D_NEUTRON:255,
    D_SHOCK_COUNT:shockPostBase(g),D_SET_OFF:setOffBase(g),D_AIRBORNE_POSTS:airborneBase(g)+1,D_REQUEST_SHIFT:28,D_DUST:E.DUST,
    D_REACT_KIND:AIRBORNE.KIND,D_REACT_SALT:AIRBORNE.SALT,
    C_AIR:0,C_SOLID:1,C_POWDER:2,C_LIQUID:3,C_GAS:4,
    D_G:GRAVITY,D_DT:DT,D_CELL:CELL_M,D_SWEEP_MAX:99,NX:32,NY:32,NZ:32,
    D_WINDOWED:windowed,FULLU:L.FULL,particles,flight,control,claims,air:[{vp:[0,0,0,0]}],
    DFlight:(destination,effect)=>({destination,effect}),
    DDeposit:(material,accepted)=>({material:copy(material),accepted}),
    slotOf,cellOf,inGrid:p=>p.every(v=>v>=0&&v<32),
    mAirVelocity:()=>false,brickOfCell:()=>0,
    dWrap:v=>edge===2?v.map(x=>(x%32+32)%32):v,dWake:()=>{},slotLive:()=>true,noteDead:()=>{},noteLive:()=>{},dKey:id=>claimKey(id,108),
    dMaterial:p=>({core:Uint32Array.from([p.c0,...p.tail.slice(0,3)]),bank:p.tail[3]|0}),
    cls:id=>id?ELEMENTS[id].kind:0,isLiq:c=>L.isLiquid(L.cid(c)),
    dTerminal:id=>dynamicsRows[id].terminal,dMass:id=>dynamicsRows[id].mass,
    dAmount:m=>L.isLiquid(L.cid(m.core))?L.cFill(m.core)/L.FULL:1,
    dParticleEnergy:L.packetOwnedEnergy,energyAdd:(a,b)=>a+b,energySub:(a,b)=>a-b,noteEnergySource:()=>{},
    // particles.js dHeatEnergy: one legacy cap·°C is 256·FULL native energy units
    dHeatEnergy:(m,heat)=>L.energyOf(m)+BigInt(Math.round(Math.abs(heat)*256))*65536n*(heat<0?-1n:1n),
    dToughness:id=>dynamicsRows[id].toughness,dBreak:id=>dynamicsRows[id].breakInto,
    dShockKE:id=>dynamicsRows[id].shockKE,dShockFall:id=>dynamicsRows[id].shockFall,
    D_V_MAX:PHYS.V_MAX,D_SHOCK_THROW:Math.fround(1/SHOCK_THROW_MS),
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
  const glass=fixture({position:[6.5,2.5,6.5],velocity:[0,-20,0]});
  glass.set([6,1,6],L.makeMaterial(E.GLASS));glass.set([6,0,6],L.makeMaterial(E.STONE));
  runTicks(glass,[0],1);assert.equal(L.cid(at(glass,[6,1,6]).core),E.SHARDS);assert.notEqual(glass.particles[0].id,0);
  // V1 react.js: the debris takes the fracture work as heat, hard·KE_TO_HEAT / cap (glass → shards: ~+48 °C;
  // a native cell holds V1's cap, its air carrier included: format 3, TH-06).
  const warmed=L.cTq(at(glass,[6,1,6]).core)/4-273.25, rise=ELEMENTS[E.GLASS].hard*PHYS.KE_TO_HEAT/ELEMENTS[E.SHARDS].cap;
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
    const f=fixture({material,position:[17.2,0.5,15.5],velocity:[speed,0,0]});
    f.set(beside,target);f.tick();return f;
  };
  const posted=f=>f.ctx.control[S0+1]===(f.ctx.slotOf(start)|DET)>>>0&&f.ctx.control[S0]===1;
  const quiet=f=>f.ctx.control[S0+1]===0&&f.ctx.control[S0]===0&&f.ctx.control[SET]===0;
  // sand never sets C-4 off (V1: ½·16·V_MAX² = 8, under its 20), landing or thrown, however fast
  for(const v of [-6,-25,-60])assert.ok(quiet(hit(L.makeMaterial(E.SAND),v,L.makeMaterial(E.C4))),`sand landing at ${-v} m/s`);
  for(const v of [6,40,100])assert.ok(quiet(thrown(L.makeMaterial(E.SAND),v,L.makeMaterial(E.C4))),`sand thrown at ${v} m/s`);
  // ...though the same landing still smashes wood (fracture is V2's toughness, unchanged)
  let f=hit(L.makeMaterial(E.SAND),-6,L.makeMaterial(E.WOOD));assert.notEqual(L.cid(at(f,start).core),E.WOOD);
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
      const f=landing?fixture({material,position:[18.8,1.1,15.5],velocity:[0,-u,0]}):fixture({material,position:[17.2,0.5,15.5],velocity:[u,0,0]});
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
    // a law from any fall (V1 measured mercury on nitroglycerin from 0 cells: dynamics-reference.js V1_SINKING_FALLS)
    if(r.fall===0){assert.ok(drop(0.05),`${ELEMENTS[r.faller].key} on ${ELEMENTS[r.charge].key} from any fall`);continue;}
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
