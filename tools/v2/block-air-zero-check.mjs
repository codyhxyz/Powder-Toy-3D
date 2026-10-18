// CPU-only proof of the production R5 zero-work domain, never an all-AIR oracle.
import assert from 'node:assert/strict';
import { E, K, ELEMENTS } from '../../src/elements.js';
import * as C from '../../src/v2/contact.js';
import { makeMaterial, withEnergy, energyOf } from '../../src/v2/layout.js';
import { GRAV, AIR, EDGE } from '../../src/simModes.js';
import { edgeCell, gravityAt } from '../../src/v2/modes.js';
import { offsetOf } from '../../src/v2/physics.js';
import { gridLayout } from '../../src/sim.js';
import { v2BlockWGSL, WGSL_CHECK, v2SupportWGSL } from '../../src/shaders/v2.js';
import { materialStorageWGSL } from '../../src/shaders/v2/state.js';
import { modeWGSL } from '../../src/shaders/v2/modes.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { wgslGroupingErrors, assertNaga, importMinified } from './wgsl-grouping.mjs';

const g=gridLayout(16,16,16), dims=[16,16,16], shader=v2BlockWGSL(g,contactWGSL);
const start=shader.indexOf('  let rawTq ='), end=shader.indexOf('  // R2 topple',start);
assert(start>shader.indexOf('oldBanks[i] = bs[i];'));
assert(end>start);
const branch=shader.slice(start,end), ambientExpression='u32(clamp(round((P.ambient+273.25)*4.0),0.0,65535.0))';
assert.equal(shader.split(ambientExpression).length-1,2,'predicate and boundary use identical WGSL ambient encoding');
assert(branch.includes('blockCount == 8u'));
assert(branch.includes('k < blockCount'),'runtime bound checks exactly eight cells on any eligible block');
for(const work of ['// R2 topple','// R3 sink','// R4 gas','contactBlock(&cs','contactBoundary(Material(cs','storeMaterial(slot, Material(orig']) {
  assert(shader.indexOf(work,end)>shader.indexOf('if (zeroWork) { return; }',start),work);
}
// Compile the actual production predicate, changing syntax only. No second predicate.
let js=branch.replace(/\/\/[^\n]*/g,'').replaceAll(ambientExpression,'ambientQ(P.ambient, tie)')
  .replace('cs[0].x','cs[0][0]').replace('vec4u(rawTq << 8u, 0u, 0u, 0u)','[rawTq << 8u, 0u, 0u, 0u]')
  .replace('any(cs[k] != canonicalAir)','cs[k].some((v,j)=>v!==canonicalAir[j])')
  .replaceAll('mAirHeat()','airHeat(P)').replaceAll('inGrid(positions[k])','valid(positions[k])')
  .replaceAll('var ','let ').replace(/\b(\d+)u\b/g,'$1').replace('if (zeroWork) { return; }','return zeroWork;');
// WGSL round permits either result at a half-integer: prove BOTH, not Math.round.
const f=Math.fround;
function ambientQ(ambient,tie=0) {
  const x=f(f(f(ambient)+f(273.25))*f(4)), lo=Math.floor(x), frac=x-lo;
  const rounded=frac<0.5?lo:frac>0.5?lo+1:lo+tie;
  return Math.min(65535,Math.max(0,rounded));
}
const heatSource=modeWGSL.match(/fn mAirHeat\(\) -> bool \{ return ([^;]+); \}/)?.[1]
  ?? modeWGSL.match(/fn mAirHeat\(\)->bool\{return ([^;]+);\}/)?.[1];
assert(heatSource,'use actual production air-heat mode gate');
const airHeat=new Function('P',`return ${heatSource.replace(/\b(\d+)u\b/g,'$1')};`);
const valid=p=>p.every((x,a)=>x>=0&&x<dims[a]);
const predicate=new Function('cs','bs','positions','pending','P','blockCount','tie','ambientQ','airHeat','valid',js);
const positions=Array.from({length:8},(_,i)=>[6+(i&1),6+(i>>2),6+((i>>1)&1)]);
const air=q=>Array.from({length:8},()=>new Uint32Array([q<<8,0,0,0]));
const modes={edge:EDGE.SOLID,airMode:AIR.ON,ambientHeat:1,ambient:20};
const zero=new Uint32Array(8), banks=new Int32Array(8);
const eligible=(cores=air(1173),bs=banks,ps=positions,pending=zero,P=modes,count=8,tie=0)=>predicate(cores,bs,ps,pending,P,count,tie,ambientQ,airHeat,valid);
assert(eligible()); assert(!eligible(air(1173),banks,positions,zero,modes,7));
assert.equal(E.EMPTY,0); assert.equal(ELEMENTS[E.EMPTY].kind,K.EMPTY);

function proveContact(q,tick,ps=positions,vs=Array(8).fill(true),outside=Array.from({length:8},()=>[3,0,0,3])) {
  const input=air(q), before=input.map(c=>new Uint32Array(c));
  const out=C.contactReference(input,new Int32Array(8),tick,ps,zero,vs,outside);
  assert.deepEqual(out.cores,before,`raw Tq ${q}: byte-exact all eight cores`);
  assert.deepEqual(out.banks,new Int32Array(8)); assert.deepEqual(out.requests,zero);
  assert.deepEqual(out.busy,[]); assert.deepEqual(out.sources,Array(8).fill(0n)); assert.deepEqual(out.sinks,Array(8).fill(0n));
  return out;
}
for(let q=0;q<=41093;q++) {
  assert(eligible(air(q)),`normal code ${q}`);
  proveContact(q,[0,1,7,0xffffffff][q%4]);
  const c=C.unpackContact(air(q)[0]);
  for(const open of [1,3,5]) {
    const boundary=C.ctBoundary(c,open,q);
    assert.deepEqual(C.packContact(boundary,air(q)[0]),{core:air(q)[0],bank:0});
    assert.equal(boundary.busy,0); assert.equal(boundary.request,0);
    assert.equal(boundary.source,0n); assert.equal(boundary.sink,0n);
  }
}
for(const q of [0,1,1173,41093]) for(const tick of [0,1,8,12345,0xffffffff]) {
  for(const ps of [positions,positions.map(p=>p.map((_,a)=>15-p[a])),positions.map((p,i)=>[i&1,14+(i>>2),(i>>1)&1])]) {
    proveContact(q,tick,ps);
    for(let i=0;i<8;i++) { const vs=Array(8).fill(true);vs[i]=false;proveContact(q,tick,ps,vs); }
  }
  for(const outside of [[0,0,0,0],[0,3,0,3],[0,0,3,3],[1,1,1,3]]) proveContact(q,tick,positions,Array(8).fill(true),Array(8).fill(outside));
}
console.log('All 41094 normal codes: full production contactReference and ambient boundary byte-exact; zero banks, requests, busy and energy ledgers');

// Reject every slot, every native core bit (including opaque history), every
// request bit and signed nonzero bank. This is deliberately stricter than AIR id.
for(let i=0;i<8;i++) {
  for(const bank of [-2147483648,-1,1,2147483647]) { const bs=new Int32Array(8);bs[i]=bank;assert(!eligible(air(1173),bs)); }
  for(let word=0;word<4;word++) for(let bit=0;bit<32;bit++) {
    const cs=air(1173);cs[i][word]=(cs[i][word]^(2**bit))>>>0;assert(!eligible(cs),`slot ${i} word ${word} bit ${bit}`);
  }
  for(let bit=0;bit<32;bit++) { const pending=new Uint32Array(8);pending[i]=2**bit;assert(!eligible(air(1173),banks,positions,pending)); }
  for(let axis=0;axis<3;axis++) for(const value of [-1,16]) {
    const ps=positions.map(p=>[...p]);ps[i][axis]=value;assert(!eligible(air(1173),banks,ps));
  }
  for(const id of [E.WATER,E.SAND,E.SMOKE,E.FIRE,E.WALL]) { const cs=air(1173);cs[i]=makeMaterial(id).core;assert(!eligible(cs)); }
}
for(const q of [41094,53314,53315,65535]) assert(!eligible(air(q)),'uniform latent code is not normal AIR');
for(const gravMode of Object.values(GRAV)) for(const edge of Object.values(EDGE)) for(const airMode of Object.values(AIR)) for(const ambientHeat of [0,1]) {
  const P={...modes,gravMode,edge,airMode,ambientHeat};
  for(const ambient of [-1000,-273.25,-273.125,-272.875,20,20.125,20.375,10000,20000]) for(const tie of [0,1]) {
    P.ambient=ambient;const encoded=ambientQ(ambient,tie);
    for(const q of [0,1,1173,1174,41093]) assert.equal(eligible(air(q),banks,positions,zero,P,8,tie),edge!==EDGE.VOID||!airHeat(P)||q===encoded);
    if(encoded<=41093) assert(eligible(air(encoded),banks,positions,zero,P,8,tie));
  }
}
assert.equal(ambientQ(20.125,0),1173);assert.equal(ambientQ(20.125,1),1174,'exercise both allowed half-code rounding directions');
console.log('Negative domain: each slot/bank/core bit/request bit/invalid position, latent and materials; exact ambient expression in all mode gates');

// Source-checked mechanical equivalence: no powder, no density difference, no
// GAS. Hence no motion, pending swaps, gas age, RNG or activity on this domain.
assert(shader.includes('if (clsOf(gr) != C_POWDER) { continue; }'));
assert(shader.includes('if (dU <= dL) { continue; }'));
assert(shader.includes('if (!young) { continue; }'));
assert(shader.includes('if (clsOf(cs[i]) == C_GAS && cAge(cs[i]) < DIFFUSE_AGE)'));
for(const q of [0,1,1173,41093]) assert.equal(C.ctDensity(C.unpackContact(air(q)[0])),C.ctDensity(C.unpackContact(air(q)[7])));
assert(materialStorageWGSL.includes('noteVisible(cellOf(slot), before.core, after.core);'));
assert(materialStorageWGSL.includes('if (any(before.core != after.core) || before.bank != after.bank) { noteState(slot); }'));
assert(materialStorageWGSL.includes('storeCore(slot, after.core); banks[slot] = after.bank;'));
assert(shader.includes('if (all(compactA(p, before) == compactA(p, after)) && (!isLiq(after) || cAge(before) == cAge(after))) { return; }'));
assert(shader.includes('events[slot] = ctMergeRequest(pending[i], requests[i]);'));   // flags OR, the larger puff
assert(v2SupportWGSL(g).includes('liquidScratch[s].x=(liquidScratch[s].x&0xffffff00u)|air|(oxygen<<2u)|(co2<<4u)|(gas<<6u);'));
// Execute the real store helper with observable storage/mark hooks. Equal AIR
// has equal deterministic compactA projections and is not liquid, so the exact
// noteVisible guard above returns before its atomics. No mark is cleared.
const storeBody=materialStorageWGSL.match(/fn storeMaterial\([^]*?\) \{([^]*)\}/)[1]
  .replace('any(before.core != after.core)','before.core.some((v,i)=>v!==after.core[i])');
const store=new Function('slot','before','after','noteVisible','cellOf','noteState','storeCore','banks',storeBody);
for(const preserveLegacyMarks of [0,1]) for(const q of [0,1173,41093]) {
  const marks=new Uint32Array([0xa5a5,1,0,0xffffffff]), beforeMarks=new Uint32Array(marks), storage=air(q), bs=new Int32Array(8);
  const before={core:new Uint32Array(storage[0]),bank:0}, after={core:new Uint32Array(storage[0]),bank:0};
  store(0,before,after,(_p,a,b)=>{if(a.every((v,i)=>v===b[i]))return;marks[0]=marks[1]=1;},s=>s,()=>{marks[2]=1;},(s,c)=>{storage[s]=c;},bs);
  assert.deepEqual(marks,beforeMarks);assert.deepEqual(storage,air(q));assert.deepEqual(bs,new Int32Array(8));
  assert(!storeBody.includes('preserveLegacyMarks'),'equal store does not depend on legacy preservation setting');
}
const gradient=air(1173);gradient[0][0]=2000<<8;
assert(!eligible(gradient),'heat gradient must take full path');
assert(C.contactReference(gradient,new Int32Array(8)).busy.length>0,'production heat gradient remains active');

// Exact-production specialization must NOT swallow side-effectful injections.
for(const code of ['',contactWGSL+'\n', 'fn contactBlock() {}']) assert(!v2BlockWGSL(g,code).includes('var zeroWork'));
const probe=WGSL_CHECK.find(k=>k.name==='v2contactABI').code(g);
assert(!probe.includes('var zeroWork')); assert(probe.includes('energySigned(-1)'));assert(probe.includes('(*requests)[0] |= 1u;'));
const original={core:air(1173)[0],bank:0}, changed=withEnergy(original,energyOf(original)-1n);
assert.notDeepEqual(changed,original,'ABI probe would not be a no-op for canonical AIR');

// Forward/reverse disjoint block replay on a periodic seam and open/closed
// boundaries, actual offsets; slow path always runs full production contacts.
const off8=i=>[i&1,i>>2,(i>>1)&1], index=p=>p[0]+16*p[1]+256*p[2];
// Evaluate the actual corner permutation, including all radial dominant axes.
const permutation=modeWGSL.slice(modeWGSL.indexOf('  var p=o;'),modeWGSL.indexOf('\nfn mAirVelocity'))
  .replace(/}\s*$/,'').replace('var p=o;','let p=[...o];').replace(/vec3i\(([^)]+)\)/g,'[$1]')
  .replace(/\b(o|p|down)\.([xyz])/g,(_,v,a)=>`${v}[${'xyz'.indexOf(a)}]`);
const blockOffset=new Function('o','down',permutation);
function replay(P,fast,reverse) {
  const cores=Array.from({length:4096},()=>new Uint32Array([1173<<8,0,0,0])), bs=new Int32Array(4096), pending=new Uint32Array(4096);
  for(const tick of [1,2,7,8]) {
    const work=Array.from({length:512},(_,n)=>{const b=n>>3,j=n&7,bp=[b&3,(b>>2)&3,b>>4];return bp.map((v,a)=>4*v+offsetOf(tick)[a]+2*off8(j)[[0,2,1][a]]-1);});
    if(reverse)work.reverse();
    for(const c0 of work) {
      const force=gravityAt(c0.map(x=>x+1),dims,{...P,gravity:19.6});
      // Match mDown's dominant-axis tie rules (vertical wins x/y ties).
      const a=force.map(Math.abs);let axis=1;
      if(a[0]>a[1]&&a[0]>=a[2])axis=0;
      if(a[2]>a[1]&&a[2]>a[0])axis=2;
      const down=force.map((v,a)=>a===axis?Math.sign(v):0);
      const ps=Array.from({length:8},(_,i)=>c0.map((v,a)=>v+blockOffset(off8(i),down)[a])).map(p=>edgeCell(p,dims,P.edge)??p), vs=ps.map(valid);
      const cs=ps.map((p,i)=>vs[i]?cores[index(p)]:makeMaterial(E.WALL).core), localBanks=ps.map((p,i)=>vs[i]?bs[index(p)]:0), events=ps.map((p,i)=>vs[i]?pending[index(p)]:0);
      if(fast&&eligible(cs,localBanks,ps,events,P))continue;
      const out=C.contactReference(cs,localBanks,tick,ps,events,vs);
      assert.deepEqual(out.busy,[]);assert(out.sources.every(v=>v===0n)&&out.sinks.every(v=>v===0n));
      for(let i=0;i<8;i++)if(vs[i]) {
        let core=out.cores[i],bank=out.banks[i];
        if(P.edge===EDGE.VOID&&airHeat(P)) {
          const p=ps[i],open=+(p[0]===0)+ +(p[0]===15)+ +(p[2]===0)+ +(p[2]===15)+ +(p[1]===15);
          const c=C.ctBoundary(C.unpackContact(core,bank),open,ambientQ(P.ambient));
          const packed=C.packContact(c,core);core=packed.core;bank=packed.bank;
          assert.equal(c.busy,0);assert.equal(c.source,0n);assert.equal(c.sink,0n);
        }
        const s=index(ps[i]);cores[s]=core;bs[s]=bank;pending[s]=events[i]|out.requests[i];
      }
    }
  }
  return {cores,bs,pending};
}
for(const gravMode of Object.values(GRAV)) for(const edge of Object.values(EDGE)) for(const airMode of Object.values(AIR)) for(const ambientHeat of [0,1]) {
  const P={...modes,gravMode,edge,airMode,ambientHeat}, expected=replay(P,false,false);
  assert.deepEqual(replay(P,true,false),expected);assert.deepEqual(replay(P,true,true),expected);
}
console.log('Mechanical/store guards audited; custom/ABI side effects retained; canonical AIR forward/reverse replay matches full contact in every mode');

// Minify the FULL production shader emitter (including identity specialization).
const minified=await importMinified('src/shaders/v2.js');
assert.equal(minified.v2BlockWGSL(g,contactWGSL),shader,'production minification preserves complete shader and exact identity specialization');
assert(!minified.v2BlockWGSL(g,contactWGSL+'\n').includes('var zeroWork'));
assert.deepEqual(wgslGroupingErrors(shader),[]);
assertNaga(shader,'block');
console.log('Full minified production block byte-identical; CPU Naga and Chromium expression grouping valid; no GPU');
