// CPU-only fixed-point proof. The predicate below is translated from production
// WGSL; transport and re-encoding use the pre-existing independent references.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { FULL, MAX_FILL, AIR_CAPACITY_Q, makeMaterial, withPayload, cid, cFill, cRawTq, isLiquid, energyOf, withEnergy, energyPacketFits, advectReference } from '../../src/v2/layout.js';
import { PHASE_ROWS } from '../../src/v2/phase.js';
import { gridLayout } from '../../src/sim.js';
import { v2GatherWGSL } from '../../src/shaders/v2.js';
import { energyShare, limbs, signed } from './integer-transport-reference.mjs';
import { wgslGroupingErrors } from './wgsl-grouping.mjs';

const shader=v2GatherWGSL(gridLayout(16,16,16));
assert.deepEqual(wgslGroupingErrors(shader),[]);
const start=shader.indexOf('fn gatherIdentity('), end=shader.indexOf('\n@compute',start);
assert(start>0 && end>start);
const source=shader.slice(start,end);
assert(!/loadCore\(other\)|banks\[other\]|cells\[other\]/.test(source),'no racy neighbor material reads');
const main=shader.slice(end);
assert(main.indexOf('gatherIdentity(')<main.indexOf('energyOf(src)'));
assert(main.includes('if (identity == 2u) { markBusy(p); }'));
assert(main.indexOf('return;\n  }\n  var fill')>main.indexOf('gatherIdentity('));
let body=source.slice(source.indexOf('{')+1,source.lastIndexOf('}'))
  .replace(/\/\/[^\n]*/g,'')
  .replace('any(before.xy != src.core.xy)','before[0] !== src.core[0] || before[1] !== src.core[1]')
  .replace('any(liquidScratch[other] != frozen)','liquidScratch[other].some((v,i)=>v!==frozen[i])')
  .replaceAll('mEdge(p + face6(i32(face)))','neighbor(p, face)')
  .replaceAll('src.core.w','src.core[3]').replaceAll('src.core.y','src.core[1]')
  .replaceAll('before.w','before[3]').replaceAll('frozen.x','frozen[0]')
  .replace(/\b(var|let)\b/g,'let').replace(/\b(0x[\da-f]+|\d+)u\b/gi,'$1')
  .replaceAll('i32(raw)','raw').replaceAll('>>','>>>');
const burns=ELEMENTS.map(e=>(e.burnRate??0)>0);
// atomicLoad(&jetMask[index]) is the only remaining WGSL address expression.
body=body.replace(/atomicLoad\(&jetMask\[([^\]]+)\]\)/g,'jetMask[$1]');
const predicate=new Function('p','s','before','src','banks','liquidScratch','jetMask','neighbor','inGrid','awakeCell','slotOf','snapshot','faceQ','isLiq','cRawTq','cid','cAge','cFill','phaseHotLatent','phaseHotQ','phaseColdLatent','phaseColdQ','MATERIAL_BURNS','select',body);
const copy=m=>({core:new Uint32Array(m.core),bank:m.bank});
function frozen(m) {
  const c=m.core, payload=c[3]>>>16;
  return new Uint32Array([(65535|(c[1]&0xff000000))>>>0,((c[0]&0xffffff)|((payload&255)<<24))>>>0,((cFill(c)&0xffffff)|((payload>>>8)<<24))>>>0,m.bank>>>0]);
}
function fixture(m,flows=[0,0,0]) {
  const snap=copy(m);snap.core[2]=0;snap.core[3]=0;
  return {src:snap,before:new Uint32Array(m.core),banks:Array(7).fill(m.bank),scratch:Array.from({length:7},()=>frozen(m)),masks:Array(7).fill(0),materials:Array.from({length:7},()=>copy(snap)),valid:Array(7).fill(true),awake:Array(7).fill(true),q:flows.flatMap(x=>[x,-x])};
}
function eligible(c) {
  return predicate(0,0,c.before,c.src,c.banks,c.scratch,c.masks,(_,f)=>f+1,q=>c.valid[q],q=>c.awake[q],q=>q,q=>c.materials[q],(_,f)=>c.q[f],core=>isLiquid(cid(core)),cRawTq,cid,core=>core[0]>>>24,cFill,id=>PHASE_ROWS[id].hotLatent,id=>PHASE_ROWS[id].hotQ,id=>PHASE_ROWS[id].coldLatent,id=>PHASE_ROWS[id].coldQ,burns,(no,yes,b)=>b?yes:no);
}
function material(id,q,fill=FULL,ct=0) {
  const m=withPayload(makeMaterial(id,20,fill,ct),0);
  m.core[0]=(id|(q<<8))>>>0; return m;
}
let airCases=0, liquidCases=0, packets=0, periodicCases=0;
// AIR has no latent intervals. The old no-transfer path clears no additional
// bits and re-encodes every supported normal code identically.
for(let q=0;q<=41093;q++) {
  const m=material(E.EMPTY,q), c=fixture(m);
  assert.equal(eligible(c),1);
  assert.deepEqual(withEnergy(m,energyOf(m)),m);
  const out=advectReference([m],[],true);assert.deepEqual(out,[m]);airCases++;
}
// Immutable flux lanes survive both paths when solid neighbors close every
// port. No opaque high payload is discarded.
{
  const m=material(E.EMPTY,1173);m.core[2]=0x1234abcd;m.core[3]=0x5678;
  const c=fixture(m);
  for(let slot=1;slot<7;slot++) {c.materials[slot]=material(E.WALL,1173);c.scratch[slot]=frozen(c.materials[slot]);}
  assert.equal(eligible(c),1);
  assert.deepEqual(advectReference([m],[],true),[m]);
}
function half(x) { const table=new Map([[0,0],[1,0x3c00],[-1,0xbc00],[2,0x4000],[-2,0xc000],[3,0x4200],[-3,0xc200],[0.5,0x3800],[-0.5,0xb800]]);assert(table.has(x));return table.get(x); }
function fluxCore(m,flow) {const out=copy(m);out.core[2]=(half(flow[0])|(half(flow[1])<<16))>>>0;out.core[3]=half(flow[2]);return out;}
const at=(x,y,z)=>((x+3)%3)+3*(((y+3)%3)+3*((z+3)%3));
function periodic(m,flow) {
  const before=Array.from({length:27},()=>fluxCore(m,flow)), transfers=[];
  for(let z=0;z<3;z++)for(let y=0;y<3;y++)for(let x=0;x<3;x++) {
    for(let axis=0;axis<3;axis++) {
      const q=flow[axis], amount=Math.trunc(Math.abs(q));if(!amount)continue;
      const dst=[x,y,z];dst[axis]+=Math.sign(q);
      transfers.push({from:at(x,y,z),to:at(...dst),amount});
    }
  }
  for(const list of [transfers,[...transfers].reverse()]) {
    assert.deepEqual(advectReference(before,list,true),before,'old gated periodic gather is byte-identical');
    const fast=before.map(m=>copy(m));
    for(const i of [...Array(27).keys()].reverse()) {
      const c=fixture(before[i],flow);
      assert.equal(eligible(c),flow.some(q=>q!==0)?2:1);
    }
    assert.deepEqual(fast,before);
  }
  periodicCases++;
}
let negativePacket=false;
for(const e of ELEMENTS.filter(e=>e.kind===K.LIQUID)) {
  const r=PHASE_ROWS[e.id];
  const qs=[...new Set([0,1,1173,41093,r.hotQ-1,r.hotQ,r.hotQ+1,r.coldQ-1,r.coldQ,r.coldQ+1])].filter(q=>q>=0&&q<=41093);
  const ctypes=e.id===E.LAVA?[...ELEMENTS.map(e=>e.id),255]:[0,17];
  for(const ct of ctypes)for(const q of qs)for(const fill of [1,7,FULL-1,FULL,FULL+1,MAX_FILL]) {
    const m=material(e.id,q,fill,ct), flow=fill<7?[0,0,0]:[1,-2,3], c=fixture(fluxCore(m,flow),flow);
    const normal=!(r.hotLatent>0&&q>=r.hotQ || r.coldLatent>0&&q<=r.coldQ);
    assert.equal(eligible(c),normal?(flow.some(q=>q!==0)?2:1):0,`${e.key} q${q} fill${fill} ct${ct}`);
    if(!normal)continue;
    assert.deepEqual(withEnergy(m,energyOf(m)),m,'normal fixed point must survive the old encoder');
    const carried=energyOf(m)-BigInt(AIR_CAPACITY_Q)*BigInt(q), per=carried/BigInt(fill);
    assert.equal(carried,per*BigInt(fill));assert(per>=-0xffffffffn&&per<=0xffffffffn);
    let prefix=0;
    for(const signedQ of c.q) {
      const n=Math.trunc(Math.max(signedQ,0));
      const packet=energyShare(limbs(carried),prefix,n,fill);
      assert.equal(signed(packet),BigInt(n)*per);
      assert(energyPacketFits(m,m,signed(packet),n),'no skipped rejection/busy side effects');
      negativePacket ||= signed(packet)<0n;prefix+=n;packets++;
    }
    assert(prefix<=fill);liquidCases++;
    if(ct===0 && fill===FULL)periodic(m,flow);
  }
}
assert(negativePacket,'signed formation energy is covered');
// The exact latent endpoint changes raw storage even without heat transport.
const boiling=material(E.WATER,1493);
assert.equal(cRawTq(withEnergy(boiling,energyOf(boiling)).core),41094);
assert.equal(eligible(fixture(boiling)),0);
// Every negative changes one guard. Test neighbor data only in frozen storage:
// neighbor live material changes cannot create a data race in the fast path.
const good=()=>fixture(material(E.WATER,1173),[1,-2,3]);
const reject=change=>{const c=good();change(c);assert.equal(eligible(c),0);};
for(const n of [-2147483648,-1,1,2147483647]) {reject(c=>c.src.bank=n);reject(c=>c.banks[0]=n);}
reject(c=>c.src.core[3]=65536);reject(c=>c.before[3]=65536);
reject(c=>c.src.core[0]|=1<<24);reject(c=>c.before[0]^=1<<8);reject(c=>c.before[1]++);
reject(c=>c.src.core[1]=0);reject(c=>c.src.core[0]=(E.WATER|(41094<<8))>>>0);
for(let slot=0;slot<7;slot++)for(const bit of [0,1,5,8,16,24,31])reject(c=>c.masks[slot]=2**bit);
for(let slot=1;slot<7;slot++) {
  for(let word=0;word<4;word++)reject(c=>c.scratch[slot][word]^=1);
  reject(c=>c.valid[slot]=false);reject(c=>c.awake[slot]=false);
}
for(const value of [65534,65535|(8<<16),0])reject(c=>{for(const a of c.scratch)a[0]=value;});
for(let face=0;face<6;face++)reject(c=>c.q[face]+=0.5);
reject(c=>c.q[0]=NaN);reject(c=>c.q[0]=Infinity);
{
  const m=material(E.OIL,1173);m.core[1]|=0x80000000;
  assert.equal(eligible(fixture(m)),0,'burning liquid always uses the full path');
}
{
  const c=fixture(material(E.EMPTY,1173));c.materials[1]=material(E.WATER,1173);
  c.awake[1]=false;assert.equal(eligible(c),1,'sleeping AIR face is closed');
  c.awake[1]=true;c.valid[1]=false;assert.equal(eligible(c),1,'exterior AIR face is closed');
  c.valid[1]=true;assert.equal(eligible(c),0,'usable liquid neighbor requires full gather');
}
for(const change of [c=>c.src.bank=1,c=>c.before[3]=65536,c=>c.src.core[0]|=1<<24,c=>c.q[0]=0.5,c=>c.materials[1]=material(E.WATER,1173)]) {
  const c=fixture(material(E.EMPTY,1173));change(c);assert.equal(eligible(c),0);
}
// Pending requests are not read or changed by either gather path. Jet flags,
// unlike requests, must force fallback for a homogeneous liquid.
assert(!source.includes('events['));
for(const pending of [0,1,2,0xffffffff]) {const c=good();c.pending=pending;assert.equal(eligible(c),2);assert.equal(c.pending,pending);}
console.log(`Gather identities: ${airCases} AIR codes, ${liquidCases} liquid states, ${packets} exact limb packets, ${periodicCases} periodic forward/reverse cases; guards/opaque words/busy passed`);

const dir=mkdtempSync(join(tmpdir(),'gather-identity-'));
try {
  const bundle=await build({configFile:false,logLevel:'warn',build:{write:false,minify:true,lib:{entry:'src/shaders/v2.js',formats:['es']}}});
  const chunk=(Array.isArray(bundle)?bundle[0]:bundle).output.find(x=>x.type==='chunk'&&x.isEntry);
  const module=join(dir,'v2.mjs');writeFileSync(module,chunk.code);
  const minified=await import(pathToFileURL(module));
  assert.equal(minified.v2GatherWGSL(gridLayout(16,16,16)),shader,'minification preserves the full gather shader');
  const file=join(dir,'gather.wgsl');writeFileSync(file,shader);
  const naga=spawnSync('naga',[file],{encoding:'utf8'});
  if(naga.error)throw naga.error;
  assert.equal(naga.status,0,naga.stderr);
} finally {rmSync(dir,{recursive:true,force:true});}
console.log('Full minified gather byte-identical; CPU Naga and expression grouping valid; no GPU');
