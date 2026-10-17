// CPU-only R14 witness. Execute emitted WGSL bodies, not a second jet model.
// The local syntax adapters below replace explicit vector operations, WGSL
// scalar spelling/integer division and atomics with JS equivalents. Foundation
// decoding/energy primitives are production CPU helpers; awake/storage/accepted
// amounts are declared fixtures. Actual mode helper bodies are executed too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { E, ELEMENTS, K } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { PHASE_ROWS, PHASE_NORMAL_MAX } from '../../src/v2/phase.js';
import { gridLayout } from '../../src/sim.js';
import { CELL_M, GRAVITY, dynamicsRows, packParticle } from '../../src/v2/dynamics-reference.js';
import { jetsWGSL, JET_STAGES } from '../../src/shaders/v2/jets.js';
import { particlesWGSL } from '../../src/shaders/v2/particles.js';
import { nativeDynamicsHead, liquidTransportWGSL, v2GatherWGSL, SUB, TICK_HZ } from '../../src/shaders/v2.js';
import { wgslGroupingErrors } from './wgsl-grouping.mjs';
const { FULL, MAX_FILL, makeMaterial, cFill, cid, ctypeOf, cTq, payloadOf, energyOf, share, packetOwnedEnergy, withPacketEnergy, withPayload, energyPacketFits, isLiquid, isConductor }=L;
// Odd CPU fixture bounds expose an exact cell-center radial singularity; emitted
// modules still use real production square/rectangular grid layouts below.
const g=gridLayout(32,32,32), source=jetsWGSL(g,'candidate'), collision=particlesWGSL(g,nativeDynamicsHead,'integrate');
function body(code,name) {
  const at=code.indexOf(`fn ${name}(`);assert.ok(at>=0,name);const start=code.indexOf('{',at);
  let depth=1,end=start+1; for(;depth;end++) { if(code[end]==='{')depth++;if(code[end]==='}')depth--; }
  return code.slice(start+1,end-1);
}
const main=code=>code.slice(code.lastIndexOf('@compute')).slice(code.slice(code.lastIndexOf('@compute')).indexOf('{')+1,-2);
const add=(a,b)=>a.map((v,i)=>v+(Array.isArray(b)?b[i]:b));
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,b)=>a.map(v=>v*b);
const zero=v=>v.every(x=>x===0);
const vec=(...v)=>v.length===1?(Array.isArray(v[0])?[...v[0]]:[v[0],v[0],v[0]]):v;
const key=p=>p.join(',');
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
// Deliberately finite, source-specific substitutions, not a WGSL interpreter.
function syntax(s) {
  return s.replace(/\/\/[^\n]*/g,'')
    .replaceAll('bitcast<i32>(energySub(packet.heat, dParticleEnergy(m)).x)','signedBank(energySub(packet.heat, dParticleEnergy(m)))')
    .replace(/vec3f\((p|q|cell)\)\+0\.5/g,'center($1)')
    .replaceAll('p+face6(i32(face))','add(p,face6(face))')
    .replaceAll('p + face6(i32(face))','add(p,face6(face))')
    .replaceAll('q+targetDown','add(q,targetDown)').replaceAll('cell+down','add(cell,down)')
    .replace(/(sourceDown|targetDown|down)==vec3i\(0\)/g,'zero($1)')
    .replaceAll('0.5*vec3f(f32(NX),f32(NY),f32(NZ))-p','sub(mul(vec3f(NX,NY,NZ),0.5),p)')
    .replaceAll('p-0.5*vec3f(f32(NX),f32(NY),f32(NZ))','sub(p,mul(vec3f(NX,NY,NZ),0.5))')
    .replaceAll('normalize(d)*P.gravity','mul(normalize(d),P.gravity)')
    .replaceAll('mEdge(p+vec3i(d))','mEdge(add(p,vec3i(d)))')
    .replaceAll('vec3f(mEdge(add(p,vec3i(d))))+0.5','center(mEdge(add(p,vec3i(d))))')
    .replaceAll('((p%n)+n)%n','p.map((v,a)=>(v%n[a]+n[a])%n[a])')
    .replaceAll('room / 6u','Math.floor(room / 6u)')
    .replaceAll('(65535u - payloadOf(dst.core)) / 6u','Math.floor((65535u - payloadOf(dst.core)) / 6u)')
    .replace(/\bvar\b/g,'let').replace(/\b(0x[0-9a-f]+|\d+)u\b/g,'$1')
    .replace(/\b(let|const) (\w+): (u32|i32|f32)/g,'$1 $2')
    .replace(/\.(x|y|z|w)\b/g,(_,x)=>`[${'xyzw'.indexOf(x)}]`);
}
function compile(ctx,code,name,args) { return new Function('ctx',...args,`with(ctx) { ${syntax(body(code,name))} }`).bind(null,ctx); }
function fixture({p=[5,5,5],src=makeMaterial(E.WATER,20,FULL),mode=0,gravity=GRAVITY,edge=0,windowed=false}={}) {
  const frozen=new Map([[key(p),src]]), live=new Map([[key(p),src]]), sleeping=new Set(), reads=[];
  const empty=makeMaterial(0,20,0), amounts=Array(6).fill(100), flux=Array(6).fill(2000);
  const ctx={NX:17,NY:17,NZ:17,D_G:GRAVITY,D_CELL:CELL_M,D_WINDOWED:windowed,FULLF:FULL,FULLU:FULL,MAX_FILL,
    COMP:Number(source.match(/const COMP: f32 = ([^;]+)/)[1]),P:{gravMode:mode,gravity,edge},
    add,sub,mul,zero,center:p=>add(p,0.5),vec3f:vec,vec3i:vec,vec3u:vec,vec4u:(...v)=>new Uint32Array(v),vec2u:()=>0n,
    all:x=>x,any:x=>x,abs:x=>Array.isArray(x)?x.map(Math.abs):Math.abs(x),sqrt:Math.sqrt,max:Math.max,min:Math.min,
    length:v=>Math.hypot(...v),normalize:v=>mul(v,1/Math.hypot(...v)),dot:(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),sign:Math.sign,f32:Number,i32:Math.trunc,
    cid,cFill,ctypeOf,cTq,payloadOf,isLiq:c=>isLiquid(cid(c)),conductsNative:isConductor,
    cls:id=>({[K.SOLID]:1,[K.POWDER]:2,[K.LIQUID]:3,[K.GAS]:4}[ELEMENTS[id]?.kind]??0),
    face6:f=>{const v=[0,0,0];v[f>>1]=(f&1)?-1:1;return v;},
    inGrid:p=>p.every(x=>x>=0&&x<17),awakeCell:p=>!sleeping.has(key(p)),slotOf:key,
    snapshot:s=>frozen.get(s)??empty,loadCore:s=>{reads.push(s);return (live.get(s)??empty).core;},
    faceQ:(_,f)=>flux[f],rawSendOf:(_,f)=>amounts[f],energyOf,energyMul:(a,b)=>BigInt(a)*BigInt(b),energySub:(a,b)=>a-b,
    energyShare:share,energyPacketFits,markBusy:()=>{},TransportPacket:(amount,heat,fuel)=>({amount,heat,fuel}),
    shareUnsigned:(t,p,n,f)=>Number(share(t,p,n,f)),Material:(core,bank)=>({core,bank}),
    select:(a,b,c)=>c?b:a,dParticleEnergy:packetOwnedEnergy,signedBank:e=>Number(BigInt.asIntN(32,e)),
  };
  for(const [name,args] of [['mEdge',['p']],['mGravity',['p']],['mPotential',['p']],['mFaceDrive',['p','axis']],['mDown',['p']],['dSameLiquid',['a','b']],['jetDischargeSpeed',['p','face']],['jetHeadOf',['c']],['jetStaticHead',['p']],['jetLaunchSpeed',['p']],['jetMaterial',['p','face']],['jetCandidate',['p','face']]]) ctx[name]=compile(ctx,source,name,args);
  for(const [name,args] of [['prefixOf',['p','face']],['transportedEnergy',['src','prefix','n']],['sendOf',['p','face']]])ctx[name]=compile(ctx,liquidTransportWGSL,name,args);
  ctx.dLiquidStreamPasses=compile(ctx,collision,'dLiquidStreamPasses',['cell','incoming','resident']);
  return {ctx,p,src,frozen,live,sleeping,reads,amounts,flux,set(q,m,{snapshot=true}={}){live.set(key(q),m);if(snapshot)frozen.set(key(q),m);},candidate:f=>ctx.jetCandidate(p,f),speed:()=>ctx.jetLaunchSpeed(p),head:()=>ctx.jetStaticHead(p)};
}

test('actual head decode: partial/full/compressed, frozen self + only six compatible live neighbours',()=>{
  const f=fixture({mode:1}); const {ctx,p}=f;
  for(const fill of [0,1,FULL/4,FULL,MAX_FILL])close(ctx.jetHeadOf(makeMaterial(E.WATER,20,fill).core),fill<=FULL?fill/FULL:1+(fill-FULL)/(ctx.COMP*FULL));
  f.set(p,makeMaterial(E.WATER,20,MAX_FILL),{snapshot:false});close(f.head(),1,'self must remain frozen');
  for(let face=0;face<6;face++) {
    const q=add(p,ctx.face6(face));const m=makeMaterial(E.WATER,20,FULL+300);
    f.set(q,m,{snapshot:false}); f.sleeping.add(key(q));
    close(f.head(),ctx.jetHeadOf(m.core)); assert.equal(f.frozen.has(key(q)),false);
    f.live.delete(key(q));
  }
  f.set(add(p,[1,0,0]),makeMaterial(E.WATER,20,FULL+100));f.set(add(p,[0,0,-1]),makeMaterial(E.WATER,20,FULL+300));
  close(f.head(),ctx.jetHeadOf(makeMaterial(E.WATER,20,FULL+300).core));
  f.live.delete(key(add(p,[1,0,0])));f.live.delete(key(add(p,[0,0,-1])));
  f.set(add(p,[2,0,0]),makeMaterial(E.WATER,20,MAX_FILL));f.reads.length=0;close(f.head(),1);
  assert.equal(f.reads.length,6);assert(!f.reads.includes(key(add(p,[2,0,0]))),'no seventh-neighbour read');
  f.set(add(p,[1,0,0]),makeMaterial(E.OIL,20,MAX_FILL));close(f.head(),1);
  const lava=fixture({mode:1,src:makeMaterial(E.LAVA,1700,FULL,E.STONE)});
  lava.set(add(p,[1,0,0]),makeMaterial(E.LAVA,1700,MAX_FILL,E.GLASS));close(lava.head(),1);
  lava.set(add(p,[-1,0,0]),makeMaterial(E.LAVA,1700,FULL+10,E.STONE));close(lava.head(),lava.ctx.jetHeadOf(lava.live.get(key(add(p,[-1,0,0]))).core));
  assert.equal(ctx.dSameLiquid(makeMaterial(E.STONE).core,makeMaterial(E.STONE).core),false);
  const dry=fixture({src:makeMaterial(E.WATER,20,0)});dry.amounts.fill(0);close(dry.head(),0);close(dry.speed(),0);assert.equal(dry.candidate(0),false);
  const zeroHead=fixture({src:makeMaterial(E.WATER,20,FULL/4)});close(zeroHead.speed(),0);assert(zeroHead.candidate(0),'nonempty packet at zero head has no new head gate');
});

test('discharge strict >1 stays independent of launch head and accepted amount',()=>{
  const f=fixture(), gate=FULL/(CELL_M*SUB*TICK_HZ);
  for(const q of [-2000,0,gate-1,gate,gate+1]) {f.flux.fill(q);assert.equal(f.candidate(0),q>gate);close(f.ctx.jetDischargeSpeed(f.p,0),Math.max(0,q)*CELL_M*SUB*TICK_HZ/FULL);}
  const speed=f.speed();for(const q of [gate+1,2000,65000])for(const n of [1,100,500]){f.flux.fill(q);f.amounts.fill(n);assert(f.candidate(0));close(f.speed(),speed);}
  f.amounts.fill(0);assert.equal(f.candidate(0),false);
  f.amounts.fill(MAX_FILL);assert.equal(f.candidate(0),false,'canonical receiver headroom refusal');
  const deep=fixture({src:makeMaterial(E.WATER,20,FULL+100)});assert(deep.speed()>speed);close(deep.ctx.jetDischargeSpeed(deep.p,0),fixture().ctx.jetDischargeSpeed(f.p,0));
  const partial=fixture({src:makeMaterial(E.WATER,20,FULL/4),mode:1});close(partial.speed(),Math.sqrt(2*GRAVITY*CELL_M/4));
  f.sleeping.add(key(f.p));assert.equal(f.candidate(0),false);f.sleeping.clear();f.sleeping.add(key(add(f.p,[1,0,0])));assert.equal(f.candidate(0),false);
  assert.equal(f.ctx.jetCandidate([-1,1,1],0),false);
});

test('actual oriented elevation, scaled gravity, periodic seams and radial modes',()=>{
  for(const scale of [0,0.5,1,2])for(const mode of [0,1,2])for(const p of [[5,5,5],[8,8,8],[12,4,11]]) {
    const f=fixture({p,mode,gravity:scale*GRAVITY});const {ctx}=f;
    assert(Number.isFinite(f.speed()));
    const r=mode===1||scale===0||mode===2&&key(p)==='8,8,8'?0:scale;
    close(f.head(),Math.max(1-0.5*r,0));
    if(r===0)for(let face=0;face<6;face++)assert(f.candidate(face),'all-six pressure convention');
    for(let face=0;face<6;face++) {
      const q=ctx.mEdge(add(p,ctx.face6(face))),m=makeMaterial(E.WATER,20,FULL+100);
      f.set(q,m,{snapshot:false}); const elevation=(face&1)?ctx.mFaceDrive(q,face>>1):-ctx.mFaceDrive(p,face>>1);
      close(f.head(),Math.max(1,ctx.jetHeadOf(m.core)+elevation)-0.5*r);
      f.live.delete(key(q));
    }
  }
  for(const [p,face] of [[[5,16,5],2],[[5,0,5],3]]) {
    const f=fixture({p,edge:2});const {ctx}=f,q=ctx.mEdge(add(p,ctx.face6(face)));
    f.set(q,makeMaterial(E.WATER,20,FULL));close(f.head(),face===2?1.5:0.5);
    close(ctx.mFaceDrive(p,1),-1);assert(Math.abs(f.head())<2,'no NY-cell seam jump');
  }
  // Reference pressure head is not multiplied by mode gravity a second time.
  const f=fixture({mode:1,gravity:2*GRAVITY});close(f.speed()**2,2*GRAVITY*CELL_M);
});

test('birth target/drop matrix, actual LIQUID identity, LAVA subtype, strict 1/16 boundary',()=>{
  for(const id of [E.WATER,E.OIL,E.LAVA]) {
    const src=makeMaterial(id,id===E.LAVA?1700:20,FULL,id===E.LAVA?E.STONE:0),f=fixture({src}),q=add(f.p,[1,0,0]),below=add(q,[0,-1,0]);
    for(const target of [makeMaterial(0),makeMaterial(id,20,FULL,ctypeOf(src.core))])for(const fill of [0,1,FULL/16-1,FULL/16,FULL/4,FULL]) {
      f.set(q,target);f.set(below,fill?makeMaterial(id,20,fill,ctypeOf(src.core)):makeMaterial(0));assert.equal(f.candidate(0),fill<FULL/16);
    }
    f.set(below,makeMaterial(0));
    for(const bad of [makeMaterial(E.STONE),makeMaterial(E.SAND),makeMaterial(E.STEAM),makeMaterial(id===E.WATER?E.OIL:E.WATER),...(id===E.LAVA?[makeMaterial(E.LAVA,1700,FULL,E.GLASS)]:[])]) {f.set(q,bad);assert.equal(f.candidate(0),false);f.set(q,makeMaterial(0));f.set(below,bad);assert.equal(f.candidate(0),false);f.set(below,makeMaterial(0));}
    assert.equal(f.candidate(2),false);assert.equal(f.candidate(3),false);
    // Captured original-hole mouth states still reject restoration's birth rule.
    for(const fill of [.276,.282]){f.set(below,makeMaterial(id,20,Math.round(fill*FULL),ctypeOf(src.core)));assert.equal(f.candidate(0),false);}
  }
  const edge=fixture({p:[5,0,5]});assert.equal(edge.candidate(0),false,'drop must be in-grid');
});

test('mixed radial center source/target conventions and zero hit-down old collision',()=>{
  const center=[8,8,8];
  const f=fixture({p:center,mode:2});
  for(let face=0;face<6;face++) {
    const q=add(center,f.ctx.face6(face));f.set(add(q,f.ctx.mDown(add(q,.5))),makeMaterial(E.STONE),{snapshot:false});
    // Source-center is all-six AIR-only without support test.
    assert(f.candidate(face));f.set(q,makeMaterial(E.WATER,20,FULL/8));assert.equal(f.candidate(face),false);f.set(q,makeMaterial(0));
  }
  const mixed=fixture({p:[7,8,8],mode:2});assert.equal(mixed.candidate(0),false,'source-down parallel face rejected even toward zero target');
  // A diagonal dominant-axis source can reach the center on a perpendicular face
  // only via an explicitly declared mixed-down fixture (also tests zero target).
  const special=fixture();special.ctx.mDown=p=>key(p)==='6.5,5.5,5.5'?[0,0,0]:[0,-1,0];
  special.set([6,4,5],makeMaterial(E.STONE));assert(special.candidate(0));special.set([6,5,5],makeMaterial(E.WATER));assert.equal(special.candidate(0),false);
  assert.equal(f.ctx.dLiquidStreamPasses(center,f.src.core,makeMaterial(E.WATER,20,1).core),false);
});

test('ordinary DDA exemption executes exact emitted branch and liquid support helper',()=>{
  const branch=collision.slice(collision.indexOf('} else if (targetId != 0u'),collision.indexOf('\n      if (next[axis] > 1.0)'));
  // Execute the entire ordinary collision branch, retaining impact/deposition
  // statements. The enclosing DDA loop's break is a return in this single-cell
  // harness; no photon/neutron branches are adapted or replaced.
  const ordinary=syntax(branch.replace('} else if','if').replace('break;','return true;')
    .replaceAll('v+acceleration*(D_DT*entry)','add(v,mul(acceleration,D_DT*entry))')
    .replaceAll('atomicLoad(&control[D_HELD+t])','atomicLoad([control,D_HELD+t])'));
  const f=fixture(),{ctx,p}=f, below=add(p,[0,-1,0]);
  ctx.D_NONE=0xffffffff; // This predicate-only fixture always has previous AIR; recovery is entry-zero only.
  Object.assign(ctx,{D_DT:1/60,dMass:()=>1,dAmount:m=>cFill(m.core)/FULL,loadMaterial:s=>f.live.get(s)??makeMaterial(0)});
  const collides=new Function('ctx','cell','m','destination',`with(ctx) {
    let targetId=cid(destination.core),slot=slotOf(cell),previous=[3,3,3],particle={},id=cid(m.core);
    let hit,hitT,kind,deposit,energy,entry=0.25,v=[3,0,0],acceleration=[0,-D_G,0];
    ${ordinary} return false;
  }`).bind(null,ctx);
  const wet=fill=>makeMaterial(E.WATER,20,fill);
  for(const support of [makeMaterial(0),makeMaterial(E.STEAM),wet(FULL-1),makeMaterial(E.OIL,20,FULL-1),makeMaterial(E.STONE),makeMaterial(E.SAND),wet(FULL),makeMaterial(E.OIL,20,FULL),makeMaterial(E.LAVA,1700,FULL,E.STONE)]) {
    f.set(below,support);const supported=[1,2].includes(ctx.cls(cid(support.core)))||isLiquid(cid(support.core))&&cFill(support.core)>=FULL;
    for(const fill of [0,1,FULL/2-1,FULL/2,FULL,FULL+1])assert.equal(collides(p,f.src,wet(fill)),fill>=FULL/2&&supported);
    for(const bad of [makeMaterial(E.OIL,20,1),makeMaterial(E.STONE),makeMaterial(E.SAND)])assert(collides(p,f.src,bad));
    assert.equal(collides(p,f.src,makeMaterial(E.STEAM)),false);
  }
  for(const mode of [1,2]) {const z=fixture({p:mode===2?[8,8,8]:p,mode});assert.equal(z.ctx.dLiquidStreamPasses(z.p,z.src.core,wet(1).core),false);}
  const lava=fixture({src:makeMaterial(E.LAVA,1700,FULL,E.STONE)});
  assert.equal(lava.ctx.dLiquidStreamPasses(p,lava.src.core,makeMaterial(E.LAVA,1700,1,E.GLASS).core),false);
  assert.equal(ctx.dLiquidStreamPasses(p,makeMaterial(E.STONE).core,makeMaterial(E.STONE).core),false);
  for(const edge of [0,1,2])for(const windowed of [false,true]) {
    const b=fixture({p:[5,0,5],edge,windowed});
    if(edge===2)b.set([5,16,5],makeMaterial(E.OIL,20,FULL));
    assert.equal(b.ctx.dLiquidStreamPasses(b.p,b.src.core,wet(FULL).core),edge===1||windowed&&edge!==2);
    if(edge===2){b.set([5,16,5],makeMaterial(0));assert(b.ctx.dLiquidStreamPasses(b.p,b.src.core,wet(FULL).core));}
  }
});

test('actual packet material: phase tags/banks/foam/fuel/conduction and launch work',()=>{
  const materials=[];
  for(const id of [E.WATER,E.OIL,E.MERCURY,E.LAVA])for(const fill of [1,17003,FULL,MAX_FILL])for(const bank of [-2147483648,-173,0,2147483647]) {
    let m=withPayload(makeMaterial(id,id===E.LAVA?1700:20,fill,id===E.LAVA?E.METAL:0),isConductor(id)?3608:1234);
    m.core[0]|=0x37000000;m.core[1]|=id===E.OIL?0x80000000:0;m.core[2]=0x12345678;m.core[3]|=0x5a;m.bank=bank;materials.push(m);
  }
  for(const hot of [false,true]) {
    const row=PHASE_ROWS[E.WATER],latent=hot?row.hotLatent:row.coldLatent;if(!latent)continue;
    const m=makeMaterial(E.WATER,(hot?row.hotQ:row.coldQ)*.25-273.25,17003);
    const tagged=withPacketEnergy(m,packetOwnedEnergy(m)+(hot?1n:-1n)*BigInt(latent)*17003n/2n);
    assert(L.cRawTq(tagged.core)>PHASE_NORMAL_MAX,'fixture must carry an actual phase code');materials.push(tagged);
  }
  const acceptedFills=new Set();let acceptedTags=0,refused=0;
  for(const src of materials) {
    const f=fixture({src,mode:1}),{ctx,p}=f,fill=cFill(src.core);f.amounts.fill(0);f.amounts[0]=fill;
    f.amounts[0]=Math.min(fill,17003);
    const packet=ctx.sendOf(p,0);
    if(!packet.amount){assert.equal(f.candidate(0),false);refused++;continue;} // Canonical guard stays authoritative.
    acceptedFills.add(`${cid(src.core)}/${fill}`);if(L.cRawTq(src.core)>PHASE_NORMAL_MAX)acceptedTags++;
    const m=ctx.jetMaterial(p,0);assert.equal(packetOwnedEnergy(m),packet.heat);
    assert.equal(m.core[0],src.core[0]);assert.equal(ctypeOf(m.core),ctypeOf(src.core));assert.equal(m.core[1]>>>31,src.core[1]>>>31);
    assert.equal(m.core[2],0);assert.equal(m.core[3]&65535,0,'flux/fall bits are not opaque packet data');
    assert.equal(payloadOf(m.core),isConductor(cid(src.core))?payloadOf(src.core):packet.fuel);
    const mass=dynamicsRows.find(r=>r.id===cid(src.core)).mass*packet.amount/FULL;
    close(.5*mass*f.speed()**2,mass*GRAVITY*CELL_M*f.head());
    const cold=fixture({mode:1,src:makeMaterial(cid(src.core),20,fill,ctypeOf(src.core))});close(f.speed(),cold.speed(),'temperature/phase/opaque independence');
    const bytes=packParticle({position:[1,2,3],velocity:[f.speed(),0,0],id:1,...m});assert.equal(bytes.byteLength,48);
  }
  assert.equal(acceptedFills.size,16,'all four material IDs and partial/full/compressed fills exercised');assert.equal(acceptedTags,2);assert(refused>0,'receiver refusal exercised without bypass');
  const f=fixture();f.ctx.dParticleEnergy=()=>123n;assert.equal(f.candidate(0),false,'unrepresentable exact packet energy rejected');
});

// Run the real spawn body against fixture arrays/atomics. Allocation, accepted
// mask and held-slot reset are not reimplemented by a parallel JS allocator.
function spawnFixture(f,free,candidates=63) {
  const {ctx,p}=f,control=new Uint32Array(300000),jetMask=new Uint32Array(64),particles=[];
  const constants=jetsWGSL(g,'spawn');
  ctx.D_FREE=Number(constants.match(/const D_FREE: u32 = (\d+)u/)[1]);ctx.D_HELD=Number(constants.match(/const D_HELD: u32 = (\d+)u/)[1]);
  ctx.J_PREFIX=Number(constants.match(/const J_PREFIX: u32 = (\d+)u/)[1]);ctx.D_BRICKS=g.nbricks;ctx.J_COUNTS=ctx.J_PREFIX+g.nbricks;ctx.D_SLOTS=g.slots;
  ctx.control=control;ctx.jetMask=jetMask;ctx.particles=particles;ctx.cellOf=()=>p;
  const slotOf=ctx.slotOf;ctx.slotOf=q=>key(q)===key(p)?0:slotOf(q);f.frozen.set(0,f.src);
  ctx.P.origin=[12,-3,7];ctx.P.substep=2;ctx.dId=(_,rule)=>rule;ctx.dWake=()=>{};
  ctx.dParticle=(position,velocity,id,m)=>({position,velocity,id,m});
  ctx.atomicLoad=([a,i])=>a[i];ctx.atomicStore=([a,i],v)=>{a[i]=v;};ctx.atomicAdd=([a,i],v)=>{a[i]+=v;};
  control[4]=free;for(let i=0;i<free;i++){control[ctx.D_FREE+i]=i;control[ctx.D_HELD+i]=123;}
  jetMask[0]=(0x37000000|(candidates<<8))>>>0;
  control[ctx.J_COUNTS]=Array.from({length:6},(_,f)=>(candidates>>f)&1).reduce((a,b)=>a+b,0);
  const allocate=syntax(main(jetsWGSL(g,'allocate'))).replace(/&([A-Za-z]+)\[([^\]]+)\]/g,'[$1,$2]');
  new Function('ctx',`with(ctx) { ${allocate} }`)(ctx);
  let s=main(constants).replace(/let t = \w+\(wg,nwg,li\);/,'')
    .replaceAll('vec3f(p+P.origin)+0.5+direction*0.501','add(add(add(p,P.origin),0.5),mul(direction,0.501))')
    .replaceAll('direction*jetLaunchSpeed(p)','mul(direction,jetLaunchSpeed(p))')
    .replaceAll('t/64u','Math.floor(t/64u)').replaceAll('t/4096u','Math.floor(t/4096u)');
  s=syntax(s).replace(/&([A-Za-z]+)\[([^\]]+)\]/g,'[$1,$2]');
  new Function('ctx','t',`with(ctx) { ${s} }`)(ctx,0);
  return {control,jetMask,particles,accepted:jetMask[0]&63};
}

test('actual spawn: signed faces, position, accepted masks, partial source, free/held capacity and exact ownership',()=>{
  for(const free of [0,1,3,6]) {
    const src=withPayload(makeMaterial(E.OIL,50,17003),12345);src.bank=-173;
    const f=fixture({src,mode:1}),{ctx,p}=f;f.amounts.splice(0,6,2800,2800,2800,2800,2800,3003);
    const packets=Array.from({length:6},(_,face)=>ctx.sendOf(p,face));
    const before=energyOf(src),out=spawnFixture(f,free);
    assert.equal(out.accepted,(1<<free)-1);assert.equal(out.control[0],free);assert.equal(out.particles.length,free);
    assert.equal(out.control[5],6);assert.equal(out.control[7],6-free,'actual allocator reports capacity refusal');
    assert.equal(out.jetMask[0]>>>24,0x37);assert.equal((out.jetMask[0]>>>8)&63,63);
    let gridEnergy=before,flightEnergy=0n,gridFuel=payloadOf(src.core),flightFuel=0,gridFill=cFill(src.core),flightFill=0;
    for(let face=0;face<6;face++) {
      const packet=packets[face];gridEnergy-=packet.heat;gridFuel-=packet.fuel;gridFill-=packet.amount;
      if(out.accepted&(1<<face)) {
        const particle=out.particles[face],direction=ctx.face6(face);
        assert.deepEqual(particle.position,add(add(add(p,ctx.P.origin),.5),mul(direction,.501)));
        assert.deepEqual(particle.velocity,mul(direction,f.speed()));assert.equal(out.control[ctx.D_HELD+face],0);
        assert.equal(particle.id,0x4a000+2*8+face);flightEnergy+=packetOwnedEnergy(particle.m);flightFuel+=payloadOf(particle.m.core);flightFill+=cFill(particle.m.core);
      } else {gridEnergy+=packet.heat;gridFuel+=packet.fuel;gridFill+=packet.amount;}
    }
    assert.equal(gridEnergy+flightEnergy,before);assert.equal(gridFuel+flightFuel,payloadOf(src.core));assert.equal(gridFill+flightFill,cFill(src.core));
    const gather=v2GatherWGSL(g),start=gather.indexOf('var incoming = TransportPacket'),end=gather.indexOf('\n    if (out.amount',start);
    const intake=syntax(gather.slice(start,end)).replace(/&jetMask\[([^\]]+)\]/g,'[jetMask,$1]');
    const receive=new Function('ctx','q','face',`with(ctx) { ${intake};return incoming; }`).bind(null,ctx);
    const send=ctx.sendOf;
    for(let face=0;face<6;face++) {
      let calls=0;ctx.sendOf=(_,f)=>{calls++;assert.equal(f,face);return packets[f];};
      const actual=receive(p,face^1),accepted=!!(out.accepted&(1<<face));
      assert.equal(calls,accepted?0:1,'only an allocated face suppresses actual gather intake');
      assert.deepEqual(actual,accepted?ctx.TransportPacket(0,0n,0):packets[face]);
    }
    ctx.sendOf=send;
    const acceptedMass=dynamicsRows.find(r=>r.id===E.OIL).mass*flightFill/FULL;
    close(out.particles.reduce((sum,p)=>sum+.5*dynamicsRows.find(r=>r.id===E.OIL).mass*cFill(p.m.core)/FULL*ctx.dot(p.velocity,p.velocity),0),acceptedMass*GRAVITY*CELL_M*f.head());
  }
  const f=fixture({mode:1}),out=spawnFixture(f,1,1<<5);assert.equal(out.accepted,1<<5);assert(out.particles[0].velocity[2]<0);
  const gather=readFileSync('src/shaders/v2.js','utf8');assert.match(gather,/jetMask\[slotOf\(q\)\]\) & \(1u << \(face \^ 1u\)\)/);
  const physics=readFileSync('src/v2/physics.js','utf8');assert.ok(physics.indexOf('this.dynamics?.advanceParticles')<physics.indexOf('this.jets?.advance'),'new births integrate next tick');
});

test('minification parity; square/rectangular CPU Naga, eight storage max and 48-byte ABI',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jet-restoration-'));
  try {
    for(const [entry,generate] of [['jets',jetsWGSL],['particles',particlesWGSL]]) {
      const bundle=await build({configFile:false,logLevel:'warn',build:{write:false,minify:true,lib:{entry:`src/shaders/v2/${entry}.js`,formats:['es']}}});
      const chunk=(Array.isArray(bundle)?bundle[0]:bundle).output.find(c=>c.type==='chunk'&&c.isEntry);
      const file=join(dir,`${entry}.mjs`);writeFileSync(file,chunk.code);const minified=await import(pathToFileURL(file));
      for(const dims of [[32,32,32],[48,16,32]])for(const stage of entry==='jets'?JET_STAGES:['integrate']) {
        const args=entry==='jets'?[gridLayout(...dims),stage]:[gridLayout(...dims),nativeDynamicsHead,stage];
        assert.equal(minified[`${entry}WGSL`](...args),generate(...args),`${entry}/${stage} minification parity`);
      }
    }
    for(const dims of [[32,32,32],[48,16,32]])for(const [name,code] of [...JET_STAGES.map(s=>[s,jetsWGSL(gridLayout(...dims),s)]),['integrate',particlesWGSL(gridLayout(...dims),nativeDynamicsHead,'integrate')]]) {
    assert.deepEqual(wgslGroupingErrors(code),[]);assert.ok([...code.matchAll(/var<storage,/g)].length<=8);
    assert.match(code,/struct DParticle \{ position: vec3f, id: u32, velocity: vec3f, c0: u32, tail: vec4u \}/);
    const file=join(dir,`${name}-${dims.join('x')}.wgsl`);writeFileSync(file,code);const result=spawnSync('naga',[file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }} finally {rmSync(dir,{recursive:true,force:true});}
});
