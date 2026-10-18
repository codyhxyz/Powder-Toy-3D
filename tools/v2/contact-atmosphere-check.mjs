// CPU-only exposed-face regression. No browser, GPU, or alternative stage pack.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { E, ELEMENTS, K } from '../../src/elements.js';
import * as C from '../../src/v2/contact.js';
import { makeMaterial } from '../../src/v2/layout.js';
import { offsetOf } from '../../src/v2/physics.js';
import { edgeCell } from '../../src/v2/modes.js';
import { EDGE } from '../../src/simModes.js';
import { gridLayout } from '../../src/sim.js';
import { V2_KERNELS, V2_CONTACT_LAYOUT, V2Params, v2SupportWGSL, v2ActLayout } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { LAYOUT } from '../../src/shaders/common.js';
import { modeWGSL } from '../../src/shaders/v2/modes.js';
const cell = (id, T = ELEMENTS[id].temp) => C.ctNew(id, Math.round((T + 273.25) * 4), 65536);
const owned = (...ids) => ids.map(id => cell(id));
const wood = cell(E.WOOD, 450); wood.burning = 1;
const closed = owned(E.WOOD, E.WOOD, E.WOOD);
const step = (ns, out, input = wood) => C.ctStepAtmosphere(input, ns, 1, ...out, 0, C.contactAmbientQ(20));
const extinguished=C.ctStep(wood, closed, 1);
assert.equal(extinguished.burning, 0, 'closed six faces extinguish');
assert.equal(extinguished.life,wood.life,'closed fuel is not spent');
assert.equal(extinguished.request&2,0,'closed fuel emits no plume request');
assert.deepEqual(C.ctStep(wood, closed, 1), step(closed, [0,0,0,0]), 'three-arg compatibility');
const ventilated = step(closed, [3,0,0,3]);
assert.equal(ventilated.burning, 1); assert(ventilated.life < wood.life);
assert.equal(step(owned(E.EMPTY,E.WOOD,E.WOOD), [0,0,1,3]).burning, 1, '1/4 actual gas fraction below 30%');
assert.equal(step(owned(E.EMPTY,E.WOOD,E.WOOD), [0,0,1,2]).burning, 0, '1/3 actual gas fraction above 30%');
assert.equal(step(owned(E.EMPTY,E.WOOD,E.WOOD), [0,0,0,3]).burning, 1);
const pureOxygen = step(closed, [0,3,0,3]);
assert(pureOxygen.life < ventilated.life, 'outside O2 increases spend');
assert(pureOxygen.tq > ventilated.tq, 'outside O2 increases ceiling/heat');
for (const id of [E.OXYGEN, E.FIRE]) {
  const n = cell(id); if (id === E.FIRE) n.ctype = E.OXYGEN;
  assert.deepEqual(step([n,n,n],[0,0,0,0]), pureOxygen, 'outside O2 and owned O2/FIRE-O2 have identical combustion');
}
const flame = cell(E.FIRE, 1000);
// V1 react.js: a flame is burning gas and needs no air face (a fireball's core).
assert.equal(step(closed,[0,0,0,0],flame).id,E.FIRE);
assert.equal(step(closed,[1,0,0,1],flame).id,E.FIRE);
// Outside air/gas must not alter cloud/growth/phase or sampled-contact formulae.
for (const id of [E.CLOUD,E.PLANT,E.FUNGUS,E.MOSS,E.ICE,E.WATER,E.DUST]) {
  const c = cell(id);
  assert.deepEqual(step(closed,[3,0,0,3],c), C.ctStep(c,closed,1), ELEMENTS[id].key);
}
console.log('Atmosphere: six-face extinction, true CO2 fraction, O2/FIRE-O2, unchanged sampled rules');

const off8 = i => [i&1,i>>2,(i>>1)&1];
const plus = (a,b) => a.map((x,i)=>x+b[i]);
const key = p => p?.join(',');
const directions = [[0,0,0],[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
// Evaluate the real shader corner permutation, not a separately drifting port.
const permutation=modeWGSL.slice(modeWGSL.indexOf('  var p=o;'),modeWGSL.indexOf('\nfn mAirVelocity'))
  .replace(/}\s*$/, '').replace('var p=o;', 'let p=[...o];')
  .replace(/vec3i\(([^)]+)\)/g,'[$1]')
  .replace(/\b(o|p|down)\.([xyz])/g,(_,v,a)=>`${v}[${'xyz'.indexOf(a)}]`);
const blockOffset=new Function('o','down',permutation);
const dims=[16,16,16], bricks=Array.from({length:64},(_,b)=>[b&3,(b>>2)&3,b>>4]);
const blocks = offset => bricks.flatMap(b=>Array.from({length:8},(_,j)=>b.map((v,a)=>4*v+offset[a]+2*off8(j)[[0,2,1][a]]-1)));
function counts(cores,p,local,edge) {
  const out=[0,0,0,0];
  for(let a=0;a<3;a++) {
    const q=edgeCell(p.map((x,k)=>x+(k===a?(local[a]===0?-1:1):0)),dims,edge);
    const c=q?cores[index(q)]:wall, id=c[0]&255, kind=ELEMENTS[id].kind;
    // V1 react.js: a flame is burning air to a fuel (oxygen when it burns in it).
    if(id===E.EMPTY || (id===E.FIRE && ((c[1]>>>16)&255)!==E.OXYGEN))out[0]++;
    if(id===E.OXYGEN || (id===E.FIRE && ((c[1]>>>16)&255)===E.OXYGEN))out[1]++;
    if(id===E.CO2)out[2]++;
    if(kind===K.EMPTY || kind===K.GAS)out[3]++;
  }
  return out;
}
const index = p => p[0]+16*p[1]+256*p[2];
const wall=makeMaterial(E.WALL).core;
const airGrid=Array.from({length:4096},()=>makeMaterial(E.EMPTY).core);
// Model EXACT Support li -> j/i geometry and compare with R5's rotated cube.
// Check uniqueness globally and with an isolated awake brick (including halo).
let geometry=0;
for(let o=0;o<8;o++) for(const edge of [EDGE.SOLID,EDGE.VOID,EDGE.LOOP]) for(const down of directions) {
  const offset=[o&1,(o>>1)&1,(o>>2)&1], all=new Set();
  for(const b of bricks) {
    const support=new Set(), r5=new Set();
    for(let li=0;li<64;li++) {
      const j=li>>3, i=li&7;
      const c0=b.map((v,a)=>v*4+offset[a]+2*off8(j)[[0,2,1][a]]-1);
      const p=edgeCell(plus(c0,off8(i)),dims,edge);
      const target=edgeCell(plus(c0,blockOffset(off8(i),down)),dims,edge);
      if(p) { assert(!all.has(key(p)),'snapshot writes are disjoint'); all.add(key(p)); support.add(key(p)); }
      if(target)r5.add(key(target));
    }
    assert.deepEqual([...support].sort(),[...r5].sort());
    if(offset.every(x=>x===0) && b.every(x=>x===1))assert(support.has('3,3,3'),'isolated awake brick covers negative halo');
  }
  if(edge===EDGE.LOOP)assert.equal(all.size,4096,'periodic partition covers every cell exactly once');
  geometry++;
}
for(const edge of [EDGE.SOLID,EDGE.VOID,EDGE.LOOP]) {
  assert.deepEqual(counts(airGrid,[0,0,0],[0,0,0],edge),edge===EDGE.LOOP?[3,0,0,3]:[0,0,0,0], 'world sentinels match cellAt even at open outflow edge');
  const mixed=airGrid.slice();
  mixed[index([15,0,0])]=makeMaterial(E.OXYGEN).core;
  mixed[index([0,15,0])]=C.packContact({...cell(E.FIRE),ctype:E.OXYGEN}).core;
  mixed[index([0,0,15])]=makeMaterial(E.CO2).core;
  if(edge===EDGE.LOOP)assert.deepEqual(counts(mixed,[0,0,0],[0,0,0],edge),[0,2,1,3]);
}
// Low-byte packing does not touch old limiter tags/payload, even for sleeping halo.
for(let hi=0;hi<256;hi++)for(let a=0;a<4;a++)for(let o=0;o<4;o++)for(let c=0;c<4;c++)for(let g=0;g<4;g++) {
  const old=(0xa5b60000|(hi<<8)|0xab)>>>0, packed=((old&0xffffff00)|a|(o<<2)|(c<<4)|(g<<6))>>>0;
  assert.equal(packed>>>8,old>>>8); assert.deepEqual([packed&3,(packed>>2)&3,(packed>>4)&3,(packed>>6)&3],[a,o,c,g]);
}
console.log(`Geometry: ${geometry} offset/edge/gravity cases; unique writes, exact R5 set, halo, periodic seams`);

function replay(reverse=false) {
  let cores=airGrid.map(c=>new Uint32Array(c)),banks=Array(4096).fill(0);
  for(let z=6;z<=9;z++)for(let y=0;y<=3;y++)for(let x=6;x<=9;x++)cores[index([x,y,z])]=makeMaterial(E.WOOD,x===6&&z===6?450:20).core;
  const hot=Array.from({length:4},(_,y)=>index([6,y,6])), initialLife=hot.map(s=>cores[s][1]&65535);
  let tick3, burningTicks=0;
  const totalEnergy=() => cores.reduce((sum,c,i)=>sum+C.materialEnergy(c,banks[i]),0n);
  for(let tick=1;tick<=60;tick++) {
    // Freeze ALL outside cores before the first block. No list-order dependency.
    const before=cores.map(c=>new Uint32Array(c)), energyBefore=totalEnergy();
    let sources=0n,sinks=0n;
    const work=blocks(offsetOf(tick)); if(reverse)work.reverse();
    for(const c0 of work) {
      const positions=Array.from({length:8},(_,i)=>plus(c0,off8(i)));
      const valid=positions.map(p=>edgeCell(p,dims,EDGE.SOLID)!==null);
      const outside=positions.map((p,i)=>counts(before,p,off8(i),EDGE.SOLID));
      const out=C.contactReference(positions.map((p,i)=>valid[i]?cores[index(p)]:wall),positions.map((p,i)=>valid[i]?banks[index(p)]:0),tick,positions,new Uint32Array(8),valid,outside);
      for(let i=0;i<8;i++)if(valid[i]){cores[index(positions[i])]=out.cores[i];banks[index(positions[i])]=out.banks[i];sources+=out.sources[i];sinks+=out.sinks[i];}
    }
    assert.equal(totalEnergy()+sinks-sources,energyBefore,`tick ${tick} exact ledger`);
    const burning=hot.map(s=>(cores[s][1]>>>24)&1);
    if(tick===3)tick3=burning;
    burningTicks+=burning.reduce((n,v)=>n+v,0);
  }
  assert.deepEqual(tick3,[1,1,1,1],'all four hot edge cells remain burning on tick 3');
  for(let i=0;i<4;i++)assert((cores[hot[i]][1]&65535)<initialLife[i],'fuel spent');
  // This replay runs contact alone: no R4 gas motion lifts the flames' smoke
  // (V1 FIRE_TO_SMOKE, SMOKE_FADE ~1.4 s), so it takes a fuel cell's air faces
  // after ~10 ticks and the cell stops burning, as V1 does with smoke parked on
  // it. Each hot cell still burns well past its ignition tick.
  assert(burningTicks>2*4*10,'persistent burning beyond initial ignition');
  return {cores,banks,burningTicks,tick3,hot:hot.map(s=>({T:C.unpackContact(cores[s],banks[s]).tq/4-273.25,fuel:cores[s][1]&65535,burning:(cores[s][1]>>>24)&1}))};
}
const forward=replay(), reverse=replay(true);
assert.deepEqual(reverse,forward,'frozen outside snapshot is independent of block list order');
console.log('16^3 woodBurns, actual offsetOf ticks 1–60, forward/reverse list:',JSON.stringify({tick3:forward.tick3,burningTicks:forward.burningTicks,hot:forward.hot}));

// Opaque native bits must never pass through the known lossy canonical stage pack.
const opaque=makeMaterial(E.SMOKE).core; opaque[2]=0xaabbccdd;opaque[3]=0x12345678;
assert.deepEqual(C.packContact(C.unpackContact(opaque),opaque).core,opaque);
const gone=C.ctDecay(C.unpackContact(opaque),E.EMPTY);
const smoke=C.ctDecay(gone,E.SMOKE);
assert.deepEqual(C.packContact(smoke,opaque).core.slice(2),opaque.slice(2),'SMOKE -> EMPTY -> SMOKE retains original opaque bits');

const g=gridLayout(32,32,32),support=v2SupportWGSL(g), driver=readFileSync(new URL('../../src/v2/physics.js',import.meta.url),'utf8');
assert(support.includes('let j=li/8u; let i=li%8u;'));
assert(support.includes('let c0=brickCoord(b)*BS+P.offset+2*vec3i(i32(j&1u),i32((j>>1u)&1u),i32(j>>2u))-vec3i(1);'));
assert(support.includes('let local=vec3i(i32(i&1u),i32(i>>2u),i32((i>>1u)&1u));'));
assert(support.includes('let p=mEdge(c0+local);'));
assert(support.includes('liquidScratch[s].x=(liquidScratch[s].x&0xffffff00u)'));
assert(!contactWGSL.slice(contactWGSL.indexOf('fn contactBlock(')).includes('loadCore('));
assert(contactWGSL.includes('ctStepAtmosphere(cells[i],ns,'));
assert.equal(V2_KERNELS.find(k=>k.name==='v2support').layouts()[2],V2_CONTACT_LAYOUT);
let maxStorage=0;
for(const k of V2_KERNELS) {
  const layouts=k.layouts(g).map(l=>typeof l==='string'?LAYOUT[l]:l);
  const count=layouts.flat().filter(e=>e?.buffer?.type?.includes('storage')).length;
  assert(count<=8,`${k.name}: ${count} storage bindings`);maxStorage=Math.max(maxStorage,count);
  if(k.name==='v2externalEvents')assert.equal(count,8);
}
assert.equal(v2ActLayout(g).words,10*g.nbricks+g.bx*g.bz+14,'no ACT resize');
assert(driver.indexOf('run(k.v2support,')<driver.indexOf('run(k.v2block,'));
// the column records overwrite support's atmosphere bytes in liquidScratch only after the block pass read them
assert(driver.lastIndexOf('run(k.v2block,')<driver.indexOf('run(k.v2runs,'));
assert(driver.indexOf('run(k.v2runs,')<driver.indexOf('run(k.v2pairs,'));
assert.equal(V2Params.pack({tick:1,busyIn:0,busyOut:g.nbricks,full:0,offset:offsetOf(1),preserveLegacyMarks:0,gravMode:0,edge:0,airMode:0,ambientHeat:0,gravity:19.6,ambient:20}).byteLength,V2Params.size);
console.log(`Native opaque round trip, real params, unchanged ACT, binding budget max ${maxStorage}: pass`);
