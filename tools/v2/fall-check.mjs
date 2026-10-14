// CPU only: real helpers and the emitted production R1 branch, no GPU/launcher.
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { CELL_M } from '../../src/scale.js';
import { FALL_Q, FALL_HZ, FALL_GRAVITY, FALL_QUANTIZATION_BOUND, fallTerminal, fallVelocity, fallFraction, setFall, stepFall } from '../../src/v2/fall.js';
import { fallWGSL } from '../../src/shaders/v2/fall.js';
import { v2ColumnWGSL, v2BlockWGSL, nativeDynamicsHead } from '../../src/shaders/v2.js';
import { blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { particlesWGSL } from '../../src/shaders/v2/particles.js';
import { gridDims } from '../../src/shaders/common.js';
import { makeMaterial, withPayload, withEnergy, energyOf } from '../../src/v2/layout.js';
import { unpackContact, packContact, ctHeat, ctPhase } from '../../src/v2/contact.js';
import { validateMaterialCore } from '../../src/v2/materialValidation.js';
import { stateLengths, encodeV2State, decodeV2State } from '../../src/v2/state.js';
import { encodeNativeBrick, decodeNativeBrick } from '../../src/world/nativeStore.js';
const close = (a,b,e=2e-6) => assert.ok(Math.abs(a-b)<=e,`${a} != ${b} (bound ${e})`);
const word = value => new Uint32Array(new Float32Array([value]).buffer)[0];
const vec = (...v) => { const a=Uint32Array.from(v); for(const [i,k] of ['x','y','z','w'].entries()) Object.defineProperty(a,k,{get:()=>a[i]}); return a; };
// Restricted syntax adapter, not an independently rewritten physics model.
function scalar(source) {
  return source.replace(/const FALL_(?:TERMINAL|POWDER) = array<[^;]+;/g,'')
    .replace(/fn (\w+)\(([^)]*)\) -> \w+\s*\{/g,(_,n,args)=>`function ${n}(${args.replace(/: \w+/g,'')}) {`)
    .replace(/bitcast<f32>/g,'fromBits').replace(/bitcast<u32>/g,'toBits')
    .replace(/\b(0x[\da-f]+|\d+)u\b/gi,'$1').replace(/>>/g,'>>>').replace(/&act2/g,'act2');
}
const helpers=scalar(fallWGSL);
const g=gridDims({nx:16,ny:128,nz:8});
const emitted=v2ColumnWGSL(g);
const main=emitted.slice(emitted.lastIndexOf('  if (P.gravMode == 2u'),emitted.lastIndexOf('}'));
function column(core, gravity, gravMode=0, obstacle=null) {
  const cells=Array.from({length:128},()=>vec(...makeMaterial(E.EMPTY).core)); cells[100]=vec(...core);
  if (obstacle) cells[99]=vec(...obstacle);
  const env={ P:{gravity,gravMode,edge:0}, wg:0,nwg:0,li:0, BS:4,BX:1,NY:128,
    V2_COUNT:0,CNT_USE_COLS:0,V2_COLS:1,act2:[1,0], C_AIR:0,C_GAS:4,C_POWDER:2,
    atomicLoad:x=>x,foldThread:()=>0,u32:x=>x>>>0,i32:Math.trunc,f32:Math.fround,
    min:Math.min,floor:Math.floor,select:(a,b,c)=>c?b:a,
    FALL_TERMINAL:ELEMENTS.map(e=>fallTerminal(e.id)),FALL_POWDER:ELEMENTS.map(e=>e.kind===K.POWDER),
    fromBits:x=>new Float32Array(new Uint32Array([x]).buffer)[0],toBits:word,
    vec4u:vec,vec3i:(x,y,z)=>({x,y,z}),loadCell:p=>cells[p.y],
    clsOf:c=>ELEMENTS[c.x&255].kind,markBusy:()=>{},storeCell:(p,c)=>{cells[p.y]=vec(...c);},
    zeroQ:c=>c,slotOf:p=>p.y,events:new Uint32Array(128),
    loadMaterial:s=>({core:cells[s],bank:0}),Material:(core,bank)=>({core,bank}),
    storeMaterial:(s,b,a)=>{cells[s]=vec(...a.core);},
  };
  Function(...Object.keys(env),helpers+scalar(main))(...Object.values(env));
  const y=cells.findIndex(c=>(c[0]&255)===E.SAND);
  return {core:cells[y],cells:100-y};
}
let legacy=makeMaterial(E.SAND).core; legacy[0]|=10<<24;legacy[2]=word(0.125);
close(fallVelocity(legacy),10*19.6/60,1e-14);
let seed=setFall(legacy,10*19.6/60,0.125);
for (const [gravity,mode,expected] of [[39.2,0,3.92],[9.8,0,3.43],[19.6,1,10*19.6/60],[0,0,10*19.6/60]]) {
  const result=column(seed,gravity,mode);close(fallVelocity(result.core),expected);
  assert.notEqual(fallVelocity(result.core),7.1866666667);
  const cpu=stepFall(seed,mode===1?0:gravity);close(fallVelocity(cpu.core),fallVelocity(result.core));
  close(fallFraction(cpu.core),fallFraction(result.core),FALL_QUANTIZATION_BOUND);assert.equal(cpu.cells,result.cells);
  for(let n=0;n<20;n++) { const next=column(result.core,gravity,mode); assert.ok(fallVelocity(next.core)>=fallVelocity(result.core)-1e-6); }
}
// Off-gravity stationary powders are barriers, not transparent column holes.
const stopped=column(setFall(seed,12,0.8),0,1,makeMaterial(E.SNOW).core);
assert.equal(stopped.cells,0);assert.equal(fallVelocity(stopped.core),0);assert.equal(fallFraction(stopped.core),0);
// Execute legacy decode through the actual branch, then change gravity.
const migrated=column(legacy,19.6).core;assert.ok(migrated[2]&0x80000000);
close(fallVelocity(column(migrated,39.2).core),12*19.6/60+19.6/60);
// Whole fall distance is bounded by explicit Q15 truncation plus f32 error.
let core=makeMaterial(E.SAND).core, distance=0,exact=0,v=0;
for(let n=1;n<=600;n++) {
  const next=stepFall(core,19.6);core=next.core;distance+=next.cells;
  v=Math.min(v+19.6/60,12);exact+=v/(CELL_M*60);
  const bound=n*FALL_QUANTIZATION_BOUND+0.0001;
  close(distance+fallFraction(core),exact,bound);
}
assert.equal(FALL_QUANTIZATION_BOUND,1/FALL_Q);
// Every packed fraction bit, plus burning/ctype/fuel/seed/device/spark lanes.
for(const id of [E.SAND,E.SAWDUST,E.SCRAP]) for(const q of [0,1,255,256,8191,16384,32767]) {
  const base=makeMaterial(id).core;base[1]=0x01a51234;base[3]=0xace5fe18;
  const c=setFall(base,3.14159,q/FALL_Q);
  assert.equal(c[1]&0x1ffffff,base[1]&0x1ffffff);assert.equal(c[3],base[3]);assert.equal(fallFraction(c),q/FALL_Q);
  const packed=packContact(unpackContact(c),c).core;assert.deepEqual(packed,c);
  const heated=withEnergy({core:c,bank:0},energyOf({core:c,bank:0})+123456n).core;
  assert.equal(heated[2],c[2]);assert.equal(fallFraction(heated),fallFraction(c));
  const payload=withPayload({core:c,bank:0},23).core;assert.equal(payload[2],c[2]);assert.equal(fallFraction(payload),fallFraction(c));
  const phased=packContact(ctPhase(unpackContact(c),0,0.5),c).core;
  if ((phased[0]&255)===id) { assert.equal(phased[2],c[2]);assert.equal(fallFraction(phased),fallFraction(c)); }
  const contact=unpackContact(c);const heat=packContact(ctHeat(contact,17),c).core;
  assert.equal(heat[2],c[2]);assert.equal(fallFraction(heat),fallFraction(c));
}
const rest=setFall(seed,0,0);assert.equal(rest[2],0x80000000);assert.equal(fallVelocity(rest),0);
// Save and streaming transports retain both generations byte-exact, even custom g.
const custom=stepFall(seed,7.123).core;
const dims=[16,8,8],lengths=stateLengths(dims,true);
const state={version:2,dims,tick:12,frame:12,paints:0,acc:0,certified:false,writtenSinceTick:true,mode:'v2',energyLedger:true,
  cells:new Uint32Array(lengths.cells),activity:new Uint32Array(lengths.activity),args:new Uint32Array(lengths.args),aux:new Uint32Array(lengths.aux)};
state.cells.set(legacy,0);state.cells.set(custom,4);state.cells.set(rest,8);
const saved=decodeV2State(encodeV2State(state),dims);assert.deepEqual(saved.cells,state.cells);
const brick=decodeNativeBrick(encodeNativeBrick(state.cells,new Int32Array(64)));assert.deepEqual(brick.core,state.cells.subarray(0,256));
close(fallVelocity(saved.cells.subarray(4,8)),fallVelocity(custom),0);
const encoded=encodeV2State(state), streamed=encodeNativeBrick(state.cells,new Int32Array(64));
const cellsOffset=12+new DataView(encoded.buffer).getUint32(8,true);
for(const z of [0x7f800000,0xff800000,0x7fc00000,0xffc00001,word(1),word(1.5)]) {
  const bad=new Uint32Array(seed);bad[2]=z;assert.throws(()=>validateMaterialCore(bad),/fall state/);
  new DataView(encoded.buffer).setUint32(cellsOffset+8,z,true);assert.throws(()=>decodeV2State(encoded,dims),/fall state/);
  new DataView(streamed.buffer).setUint32(8,z,true);assert.throws(()=>decodeNativeBrick(streamed),/fall state/);
  state.cells.set(bad);assert.throws(()=>encodeV2State(state),/fall state/);assert.throws(()=>encodeNativeBrick(state.cells,new Int32Array(64)),/fall state/);
}
for(const velocity of [NaN,Infinity,-1,1e50]) assert.throws(()=>setFall(seed,velocity,0),/velocity/);
// Production R2, promotion and deposit callsites must use the new API.
assert.match(v2BlockWGSL(g),/setFall\(gr, 0\.0, 0\.0\)/);
assert.match(blastsWGSL(g,nativeDynamicsHead,'apply'),/plan.velocity \+ vec3f\(0,-fallVelocity\(before.core\),0\)/);
assert.match(blastsWGSL(g,nativeDynamicsHead,'couplePlan'),/fallVelocity\(m.core\)>0.0/);
assert.match(particlesWGSL(g,nativeDynamicsHead,'deposit'),/setFall\(after.core,0.0,0.0\)/);
assert.doesNotMatch(main,/cAge|G_TICK/);
console.log('Native fall: generated R1 double/half/off/zero inertia, legacy migration, 600-tick Q15 bound, contact metadata, save/stream and malformed state passed; CPU only');
