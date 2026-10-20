// CPU-only: execute complete emitted bodies through finite syntax/vector/atomic adapters.
import { test } from 'node:test';
import { gridLayout } from '../../src/sim.js';
import { impactFoam } from '../../src/v2/foam.js';
import { PHYS } from '../../src/physics.js';
import { PHASE_ROWS, PHASE_NORMAL_MAX } from '../../src/v2/phase.js';
import assert from 'node:assert/strict';
import {particlesWGSL,heldBase} from '../../src/shaders/v2/particles.js';
import {nativeDynamicsHead} from '../../src/shaders/v2.js';
import {E,ELEMENTS} from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import {dynamicsRows,claimKey,CELL_M,DT,GRAVITY} from '../../src/v2/dynamics-reference.js';
import { importMinified } from './wgsl-grouping.mjs';
const floatBits=v=>{const b=new ArrayBuffer(4);new Float32Array(b)[0]=v;return new Uint32Array(b)[0];};
const g={nx:32,ny:32,nz:32,nbx:8,nby:8,nbz:8,nbricks:512,slots:32768,windowed:false},NONE=0xffffffff,S=Object.fromEntries(['clear','integrate','elect','impact','deposit'].map(s=>[s,particlesWGSL(g,nativeDynamicsHead,s)]));
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
['all(down==vec3i(0))','down.every(v=>v===0)'],
['cell+down','add(cell,down)'],
['p.velocity *= sqrt(max(0.0,1.0-cost/max(f.effect.x,0.000001)))','p.velocity=mul(p.velocity,sqrt(max(0,1-cost/max(f.effect.x,0.000001))))']])s=s.replaceAll(a,b);
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
  const control=new Uint32Array(heldBase(g)+65536), flight=[];
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

test('an empty pool reads no packet record and writes no flight record',()=>{
  const f=fixture();f.particles[0].id=0;f.ctx.control[0]=0;let reads=0;
  const pool=f.particles;f.ctx.particles=new Proxy(pool,{get:(a,k)=>{if(/^\d+$/.test(k))reads++;return a[k];}});
  const flight=copy(f.flight);runTicks(f,[0],2);
  assert.equal(reads,0);assert.equal(f.flight[65536].destination[0],0);
  f.flight[65536]=flight[65536];assert.deepEqual(f.flight,flight);
});
