// CPU only: execute the production WGSL edit branch bodies with scalar/vector
// adapters, then use the real driver with protocol spies. Not a GPU emulator.
import assert from 'node:assert/strict';
import { paintUpdateWGSL } from '../../src/shaders/passes.js';
import { stampEdit } from '../../src/shaders/stamp.js';
import { prelude, STATE_OPTS } from '../../src/shaders/common.js';
import { v2ImportWGSL, v2BridgeWGSL } from '../../src/shaders/v2.js';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { E, K, ELEMENTS, TOOLS } from '../../src/elements.js';
import { PROP, runFill } from '../../src/editing.js';
import { compactDecodeWGSL } from '../../src/shaders/compact.js';
import { PHYS } from '../../src/physics.js';
import * as L from '../../src/v2/layout.js';
const g = gridLayout(32,32,32);
function body(code, name) {
  const start = code.indexOf('{', code.indexOf(`fn ${name}(`));
  assert(start >= 0); let depth = 1, end = start + 1;
  for (; depth; end++) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  return code.slice(start + 1, end - 1);
}
function scalar(s) {
  return s.replace(/\b(0x[\da-f]+|\d+)u\b/g,'$1').replace(/\bvar\b/g,'let')
    .replace(/\(\*o([AB])\)/g,'o$1').replace(/\*o([AB])/g,'o$1').replace(/&rs/g,'rs');
}
const vec = (x=0,y=x,z=x,w=x) => ({x,y,z,w});
const base = { ...PHYS, ...Object.fromEntries(Object.entries(E).map(([k,v])=>[`E_${k}`,v])),
  ...Object.fromEntries(TOOLS.map(t=>[`T_${t.key}`,t.id])), ...Object.fromEntries(Object.entries(PROP).map(([k,v])=>[`PROP_${k}`,v])),
  f32:Number, i32:Math.trunc, u32:Math.trunc, max:Math.max,min:Math.min,abs:Math.abs,round:Math.round,floor:Math.floor,
  fract:x=>x-Math.floor(x),clamp:(x,a,b)=>Math.max(a,Math.min(b,x)),select:(a,b,c)=>c?b:a,
  vec4f:vec, eid:a=>a.x, seed3:()=>0,rnd:()=>0,slotOf:()=>0,airT:()=>20, SALT_PAINT:0,SEED_MAX:0.999,
  SPAWNDENS:()=>1,SPAWNT:()=>20,SPAWNLIFE:()=>0,isLoose:()=>false,BRUSH_EDGE_EPS:0.001,
  smoothstep:()=>0,
};
const paintBody = scalar(body(paintUpdateWGSL,'update'))
  .replace('vec3f(p) + 0.5 - P.center','vec4f(0)')
  .replaceAll('return;', 'return {oA,oB};');
const paint = new Function('ctx','p','a','b',`with(ctx) { let oA={...a},oB={...b}; ${paintBody}; return {oA,oB}; }`);
const tools = Object.fromEntries(TOOLS.map(t=>[t.key,t.id]));
function dab(params={}, distance=0, a=vec(E.WATER,20,0,0)) {
  let owned=0;
  const ctx={...base, P:{tool:tools.ERASE,radius:1,center:vec(),frame:0,filter_:-1,del:0,replace:0,rate:1,...params},
    strokeDist:()=>distance,ownLegacy:()=>owned++};
  const output=paint(ctx,vec(),a,vec()); return {...output,owned};
}
assert.equal(dab({},Math.sqrt(3)).owned,0,'sphere bounding-box corner rejected');
assert.equal(dab({filter_:E.SAND}).owned,0,'filter rejects WATER');
assert.equal(dab({tool:E.SAND,rate:-1},0,vec()).owned,0,'density rejected');
assert.equal(dab({tool:E.WATER}).owned,0,'same-id non-replace rejected');
assert.equal(dab({tool:E.WATER,replace:1}).owned,1,'explicit same-id replacement owns');
assert.equal(dab({},0,vec()).owned,1,'explicit AIR erase owns even unchanged projected value');
assert.equal(dab({filter_:E.WATER}).owned,1,'physical hidden WATER passes selected filter');
for(const prop of [PROP.TEMP,PROP.LIFE,PROP.CTYPE,PROP.VX,PROP.PRESSURE])
  assert.equal(dab({tool:tools.PROP,prop,propValue:20}).owned,0,'property is not whole-material ownership');
assert.equal(dab({tool:tools.PROP,prop:PROP.TYPE,propValue:E.WATER}).owned,1);
assert.equal(dab({tool:tools.HEAT}).owned,0);
// Execute sparse stamp production predicates (no separately reimplemented eligibility).
const stampBody=scalar(body(stampEdit().update,'update'))
 .replace('p - P.at','sub(p,P.at)').replace('p.xz / BS','p')
 .replace(/bitcast<vec4f>\((stampData\[[^;]+)\);/,'$1;');
const stamp=new Function('ctx','p',`with(ctx) { let a=vec4f(),b=vec4f(),oA=a,oB=b; ${stampBody} }`);
function stampClaim(voxel, params={}, point=vec()) {
 let owned=0;const ctx={...base,P:{masked:0,at:vec(),size:vec(1,1,1),foot:1,base:0,...params},
 stampData:[voxel],sub:(a,b)=>vec(a.x-b.x,a.y-b.y,a.z-b.z),stampColumn:()=>false,footing:()=>false,
 stampPut:()=>owned++}; stamp(ctx,point);return owned;
}
assert.equal(stampClaim(vec()),0,'sparse stamp holes untouched');
assert.equal(stampClaim(vec(1)),1,'explicit air voxel selected');
assert.equal(stampClaim(vec(1),{masked:1}),0,'masked-out column untouched');
assert.equal(stampClaim(vec(1,0,0,1),{},vec(0,-1,0)),0,'unsupported footing untouched');
assert.match(body(stampEdit().decls,'stampPut'),/ownLegacy\(slotOf\(p\)\)/);
const access=prelude(g,STATE_OPTS.STATE_RW);
assert.doesNotMatch(body(access,'writeCell'),/ownLegacy/);
assert.match(body(access,'noteLegacy'),/H.capture == 1u.*any\(a != fetchAs/s);
assert.match(body(access,'noteLegacy'),/H.capture == 2u && eid\(a\) != eid\(fetchAs\(s\)\)/);
// Execute the sticky capture discriminator, including a value returning to its start.
const noteBody=scalar(body(access,'noteLegacy')).replaceAll('any(a != fetchAs(s))','different(a, fetchAs(s))').replaceAll('any(b != fetchBs(s))','different(b, fetchBs(s))');
const note=new Function('ctx','s','a','b',`with(ctx) { ${noteBody} }`);
let sticky=0,previous=vec(E.WATER,20),velocity=vec();
const noteCtx={...base,H:{capture:1},different:(a,b)=>Object.keys(a).some(k=>a[k]!==b[k]),fetchAs:()=>previous,fetchBs:()=>velocity,ownLegacy:()=>sticky++};
note(noteCtx,0,vec(E.SAND,20),velocity);previous=vec(E.SAND,20);note(noteCtx,0,vec(E.WATER,20),velocity);assert.equal(sticky,2,'v1 away-and-back retained');
sticky=0;noteCtx.H.capture=2;previous=vec(E.WATER,20);note(noteCtx,0,vec(E.WATER,30),velocity);note(noteCtx,0,previous,vec(1));assert.equal(sticky,0,'native thermal/momentum updates are not replacements');
// Execute actual partial-import branch, scalar energy adapters use exact CPU ABI.
const project=c=>vec(L.cid(c),L.cTq(c)*0.25-273.25,L.isConductor(L.cid(c))&&L.isLiquid(L.cid(c))?0:L.payloadOf(c)/L.lifeScale(L.cid(c)),L.ctypeOf(c));
const partial=new Function('ctx','p','m','a',`with(ctx) { ${scalar(body(v2ImportWGSL(g),'importProperties')).replace('let out = m','let out = {core:new Uint32Array(m.core),bank:m.bank}')} }`);
const mergeCtx={...base,...L,T_OFFSET:273.25,compactProbeA:(_p,c)=>project(c),isLiq:c=>L.isLiquid(L.cid(c)),conductsNative:L.isConductor,
 withLife:(c,v)=>L.withPayload({core:c,bank:0},Math.round(v*L.lifeScale(L.cid(c)))).core,
 withCtype:(c,v)=>{const n=new Uint32Array(c),mask=ELEMENTS[L.cid(c)].burnRate>0?127:255; n[1]=L.isLiquid(L.cid(c))?(n[1]&~(mask<<24))|((v&mask)<<24):(n[1]&0xff00ffff)|((v&255)<<16);return n;},
 withSpark:(c,v)=>{const n=new Uint32Array(c);if(L.isLiquid(L.cid(c)))n[3]=(n[3]&0xf000ffff)|((v&4095)<<16);else n[3]=(n[3]&0xfffff000)|(v&4095);return n;},
 energyMul:(a,b)=>BigInt(a)*BigInt(b),energyAdd:(a,b)=>a+b,energyNeg:a=>-a,
};
for(const amount of [1,12345,L.FULL*3]) for(const bank of [-73,177]) {
 const m=L.makeMaterial(E.WATER,22,amount);m.bank=bank;const a=project(m.core);
 assert.deepEqual(partial(mergeCtx,vec(),m,a),m,'untouched partial/compressed material and signed bank exact');
 const hot=partial(mergeCtx,vec(),m,{...a,y:a.y+1});
 assert.equal(L.cFill(hot.core),amount);assert.equal(L.energyOf(hot)-L.energyOf(m),BigInt(L.capacityQ(m.core))*4n);
 const ct=partial(mergeCtx,vec(),m,{...a,w:7});assert.equal(ct.bank,bank);assert.equal(L.cFill(ct.core),amount);assert.equal(L.isConductor(E.WATER) ? (ct.core[3] >>> 16) & 4095 : L.ctypeOf(ct.core),7);
}
// Real export cache/protocol spies: transitions refresh all, never claim/import.
const calls=[];const sim={compact:null,gpu:{frame:{},testMode:true},g,tables:{},header:()=>({capture:2}),onPass(){}};
const engine=Object.assign(Object.create(PhysicsV2.prototype),{sim,gpu:sim.gpu,g,isReady:true,groups:{state:{},v2:{}},
 sync(){calls.push(['sync']);},_params:()=>({}),kernels:{v2bridge:{dispatch(_f,_n,o){calls.push(['bridge',o]);}}}});
sim.compact=engine;
engine.exportLegacy();engine.exportLegacy();engine.exportLegacy(false);engine.exportLegacy(false);engine.exportLegacy(true);
const bridges=calls.filter(c=>c[0]==='bridge').map(c=>c[1]);assert.equal(bridges.length,3);
assert.deepEqual(bridges.map(o=>o.header.format),[3,0,3]);assert(bridges.every(o=>o.header.capture===0&&o.params.full===1));
const projection=body(v2BridgeWGSL(g),'main');
assert.match(projection,/select\(compactA\(p, cells\[s\]\), compactProbeA\(p, cells\[s\]\), H.format == 3u\)/,'visual compatibility uses exactly renderer compactA, including partial-fill dither');
const simSpy=Object.assign(Object.create(Simulation.prototype),{compact:{isReady:true,forceCompatibility:true,groups:{read:{}},sync(){},exportLegacy(native){calls.push(['mode',native]);}},gpu:{testMode:true},_bindRW:{},_bindRO:{}});
void simSpy.bindRW;void simSpy.bindRO;simSpy.legacyState();assert.deepEqual(calls.filter(c=>c[0]==='mode').map(c=>c[1]),[true,false,false]);
// Real importer dispatch protocol: only the actual dense editing cache enables
// partial-property merging; legacy A still uses format0 (never decode as core).
const imports=[];engine.kernels.v2externalEvents={dispatch(_f,_n,o){imports.push(['events',o]);}};
engine.kernels.v2import={dispatch(_f,_n,o){imports.push(['import',o]);}};
engine.groups.import={};engine.groups.material={};engine.groups.invalidate={};engine.groups.contact={};
sim.header=()=>({capture:2,format:0});engine.importMarked=true;engine.legacyNative=true;
engine._import({full:0});engine.importMarked=true;engine.legacyNative=false;engine._import({full:0});
assert.deepEqual(imports.map(([name,o])=>[name,o.header.capture,o.header.format]),[['events',0,0],['import',2,0],['events',0,0],['import',0,0]]);
// Execute both real compact projection branches with a deterministic high
// threshold: one-quantum WATER is invisible visually, but still physical WATER.
const decodeCtx={...base,KIND:id=>ELEMENTS[id].kind,K_LIQUID:K.LIQUID,K_EMPTY:K.EMPTY,
 compactTq:L.cTq,seed3:()=>0xffff0000,vec4u:(...v)=>new Uint32Array(v),
 COMPACT_CONDUCTS:ELEMENTS.map(e=>e.elec>0),COMPACT_LIFE_SCALE:ELEMENTS.map(e=>L.lifeScale(e.id)),
 COMPACT_CTYPE_MASK:ELEMENTS.map(e=>e.burnRate>0?127:255)};
const decodeBody=name=>scalar(body(compactDecodeWGSL,name)).replace(/c\.([xyzw])/g,(_s,c)=>`c[${'xyzw'.indexOf(c)}]`).replace(/ >> /g,' >>> ');
const decode=new Function('ctx','p','c',`with(ctx) { ${decodeBody('compactA')} }`);
decodeCtx.compactA=(p,c)=>decode(decodeCtx,p,c);
const probe=new Function('ctx','p','c',`with(ctx) { ${decodeBody('compactProbeA')} }`);
const hidden=L.makeMaterial(E.WATER,100,1);hidden.bank=-73;const hiddenBefore=structuredClone(hidden);
assert.equal(decode(decodeCtx,vec(),hidden.core).x,E.EMPTY);
assert.equal(probe(decodeCtx,vec(),hidden.core).x,E.WATER);
assert.deepEqual(hidden,hiddenBefore,'projection mode switches do not mutate material/bank');
// Tagged phase heat stays exact, including the latent residual, not rawTq overwrite.
const plateau=L.withEnergy(L.makeMaterial(E.WATER,100,12345),L.energyOf(L.makeMaterial(E.WATER,100,12345))+100000000n);
assert(L.cRawTq(plateau.core)>41093);
const warmed=partial(mergeCtx,vec(),plateau,{...project(plateau.core),y:101});
assert.equal(L.energyOf(warmed)-L.energyOf(plateau),BigInt(L.capacityQ(plateau.core))*4n);
assert.equal(L.cFill(warmed.core),12345);
// Real flood-fill orchestrator requests the physical atlas and keeps the
// hidden seed plus its hidden connected neighbour, not the surrounding AIR.
const atlas=new Float32Array(g.width*g.height*4), texel=Simulation.prototype.cellTexel;
const fillSim={g,origin:{x:0,z:0,clone(){return {...this};}},cellTexel:texel,
 async readStateAAsync(options){assert.deepEqual(options,{physical:true});return atlas;},paint(stroke){this.stroke=stroke;}};
for(const x of [5,6]) atlas[fillSim.cellTexel(x,5,5)*4]=probe(decodeCtx,vec(x,5,5),hidden.core).x;
assert.deepEqual(await runFill(fillSim,{cell:[5,5,5],id:E.WATER,stroke:{tool:tools.ERASE}}),{count:2});
assert.equal(fillSim.stroke.filter,E.WATER);assert.equal(fillSim.stroke.mask.data[fillSim.cellTexel(6,5,5)],255);
// The renderer-only comparison switch cannot select visual geometry or zero
// legacy velocity/pressure for a physical reader.
let exports=0;const core={},air=[{},{}];
const physicalSim=Object.assign(Object.create(Simulation.prototype),{origin:{x:0,y:0,z:0},cur:0,
 compact:{isReady:true,forceCompatibility:true,cells:core,dynamics:{isReady:true,air,airIndex:1},sync(){},exportLegacy(){exports++;}},
 gpu:{testMode:true,bindGroup:(_l,entries)=>entries},L:{STATE_RO:{}},_bindRO:{}});
physicalSim.compactOwner=physicalSim.compact;
const physicalGroup=physicalSim.bindPhysicalRO;
assert.equal(physicalGroup[0].resource.buffer,core);assert.equal(physicalGroup[1].resource.buffer,air[1]);
assert.equal(physicalSim.readHeader({physical:true}).format,3);assert.equal(physicalSim.readHeader().format,0);assert.equal(exports,0);
physicalSim.compact.dynamics.airIndex=0;assert.equal(physicalSim.bindPhysicalRO[1].resource.buffer,air[0]);
// Readback opt-in does not alter the default visual save/read ABI.
const modes=[];const atlasSim=Object.assign(Object.create(Simulation.prototype),{g,cur:0,tables:{},_bindFlagsRO:{},_convertGroup:{},
 legacyState:physical=>modes.push(physical),_atlasScratch(){},passOf(){return {};},header(){return {};},_dispatch(){}});
atlasSim._toAtlas(0,false);atlasSim._toAtlas(0,false,true);assert.deepEqual(modes,[false,true]);
console.log('native edit intent: real brush/stamp/import branches, partial/compressed signed banks, sensible heat, physical filters and visual/edit cache protocol passed');
