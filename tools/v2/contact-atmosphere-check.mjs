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
import { V2_KERNELS, V2_CONTACT_LAYOUT, V2Params, v2SupportWGSL, v2ActLayout, v2BlockWGSL } from '../../src/shaders/v2.js';
import { contactWGSL, outsideFacesWGSL } from '../../src/shaders/v2/contact.js';
import { PHYS } from '../../src/physics.js';
import { legacyPressureToPa } from '../../src/v2/pressure.js';
import { LAYOUT } from '../../src/shaders/common.js';
import { modeWGSL } from '../../src/shaders/v2/modes.js';
const cell = (id, T = ELEMENTS[id].temp) => C.ctNew(id, Math.round((T + 273.25) * 4), 65536);
const owned = (...ids) => ids.map(id => cell(id));
const wood = cell(E.WOOD, 450); wood.burning = 1;
const closed = owned(E.WOOD, E.WOOD, E.WOOD);
// V1 react.js re-tests combustion every step: below its ignition point a lit fuel goes out, air or no air,
// and without a flame face past its flash point it never lights (no flame-touch or hot-front ignition)
{
  const cooled = cell(E.WOOD, 280); cooled.burning = 1;
  const out = C.ctStepAtmosphere(cooled, owned(E.EMPTY, E.EMPTY, E.EMPTY), 1, 3, 0, 0, 3, 0, C.contactAmbientQ(20));
  assert.equal(out.burning, 0, 'cooled under ignition: out'); assert.equal(out.life, cooled.life, 'cooled: no fuel spent');
  for (const source of [cell(E.FIRE, 1000), Object.assign(cell(E.WOOD, 1000), { burning: 1 }), Object.assign(cell(E.OIL, 1000), { burning: 1 })])
    for (let seed = 0; seed < 2000; seed++) assert.equal(C.ctStepAtmosphere(cell(E.WOOD, 20), [source, cell(E.EMPTY), cell(E.WALL)], seed, 3, 0, 0, 3, 0, C.contactAmbientQ(20)).burning, 0, 'cold wood beside a flame or burning fuel');
}
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

// The outside word (contact.js CT_OUT_*, the support pass's): what V1 react.js reads on the three faces a
// cell's block partners don't show it, so its six-face rules see six faces every tick.
const outWord = (...ids) => C.contactOutsideWord(ids.map(id => (id === null ? null : C.packContact(typeof id === 'number' ? cell(id) : id).core)));
const atmo = (input, partners, word, seed = 1, outside = [0, 0, 0, 0]) => C.ctStepAtmosphere(input, partners, seed, ...outside, 0, C.contactAmbientQ(20), 0, 0, word);
{
  // RX-2: V1 dampOf over six faces, every step. A grower's damp is DAMP_REACH beside water and one less than its
  // dampest grower neighbour, wherever they are: for every split of its six faces into partners and outside
  // (every block offset), the damp is V1's. Before: partners only, so it flickered (damp.mjs: wet 0.62 at 1 cell).
  const reach = C.CONTACT_DAMP_REACH, mossAt = d => { const m = cell(E.MOSS, 20); m.ctype = d; return m; };
  const v1Damp = faces => Math.max(0, ...faces.map(f => (f.id === E.WATER ? reach : f.id === E.MOSS || f.id === E.FUNGUS ? C.ctGrowerDamp(f.id, f.ctype) - 1 : 0)));
  const sets = [[cell(E.WATER), cell(E.STONE), cell(E.EMPTY), cell(E.EMPTY), cell(E.STONE), cell(E.STONE)],
    [mossAt(3), cell(E.STONE), cell(E.EMPTY), mossAt(1), cell(E.STONE), cell(E.STONE)],
    [mossAt(2), mossAt(4), cell(E.EMPTY), cell(E.EMPTY), cell(E.STONE), cell(E.SALTWATER)]];
  for (const six of sets) for (let o = 0; o < 8; o++) {
    // axis a: its partner the face 2a + bit a of the pattern, the other one outside
    const partners = [0, 1, 2].map(a => six[2 * a + ((o >> a) & 1)]), outside = [0, 1, 2].map(a => six[2 * a + 1 - ((o >> a) & 1)]);
    const word = C.contactOutsideWord(outside.map(c => C.packContact(c).core));
    assert.equal(atmo(mossAt(0), partners, word).ctype, v1Damp(six), `moss damp, pattern ${o}`);
    const f = cell(E.FUNGUS, 20);
    assert.equal(atmo(f, partners, word).ctype, v1Damp(six), `fungus damp, pattern ${o}`);
  }
  // dry above DAMP_DRY_T, whatever the outside holds
  assert.equal(atmo(mossAt(4), [cell(E.STONE), cell(E.STONE), cell(E.STONE)], outWord(E.WATER, null, null), 1).ctype, 4, 'cool moss beside water');
  assert.equal(atmo({ ...mossAt(4), tq: C.CONTACT_DAMP_DRY_Q, raw: C.CONTACT_DAMP_DRY_Q }, [cell(E.STONE), cell(E.STONE), cell(E.STONE)], outWord(E.WATER, null, null)).ctype, 0, 'hot moss dries');
  // cedar-leaf moss keeps its look outside too (appearance.js: CEDAR_BASE + damp)
  const cedar = mossAt(C.CONTACT_CEDAR_BASE + 3);
  assert.equal(atmo(mossAt(0), [cell(E.STONE), cell(E.STONE), cell(E.STONE)], outWord(cedar, null, null)).ctype, 2);
}
{
  // BL-14: a dust cloud's dust and air faces are six (V1 react.js nFuel >= DUST_MEC_NB, nAir >= DUST_RICH_AIR)
  const dust = cell(E.DUST, 500); dust.fallSpeed = C.DUST_MIN_FALL_SPEED * 2;
  const goes = (partners, word) => (atmo(dust, partners, word).request & 1) !== 0;
  assert.ok(goes([cell(E.EMPTY), cell(E.EMPTY), cell(E.STONE)], outWord(E.DUST, null, null)), 'its dust face outside its block');
  assert.ok(!goes([cell(E.EMPTY), cell(E.EMPTY), cell(E.STONE)], 0), 'no dust face: no cloud');
  assert.ok(goes([cell(E.DUST), cell(E.EMPTY), cell(E.STONE)], outWord(E.EMPTY, null, null)) && !goes([cell(E.DUST), cell(E.STONE), cell(E.STONE)], outWord(E.STONE, null, null)), 'two air faces of six');
  assert.ok(goes([cell(E.DUST), cell(E.STONE), cell(E.STONE)], outWord(E.EMPTY, E.EMPTY, null)), 'both air faces outside');
  // a flame face is no air to it (V1 nAir counts air cells), though it lights it
  const cool = cell(E.DUST, 20); cool.fallSpeed = dust.fallSpeed;
  assert.ok(!(atmo(cool, [cell(E.DUST), cell(E.FIRE, 900), cell(E.STONE)], outWord(E.EMPTY, null, null)).request & 1), 'one air face and a flame: not rich enough');
  assert.ok(atmo(cool, [cell(E.DUST), cell(E.FIRE, 900), cell(E.EMPTY)], outWord(E.EMPTY, null, null)).request & 1, 'two air faces and a flame: it goes');
}
{
  // RX-10: V1 react.js adds pressure only where its rule sets gas free. Acid eating limestone: puffP(FIZZ) on the
  // eaten cell (CONTACT_ROWS fizz, Pa), as its GAS request's puff; eating stone, none; matter becoming gas
  // with no puff of its own (acid's smoke, a reaction's smoke), none (before: a plain GAS request, 47.85 Pa).
  const eat = victim => {
    for (let seed = 0; seed < 4000; seed++) { const r = C.ctAcidFizz(cell(E.ACID), cell(victim), seed); if (r.changed && r.b.id !== victim) return r.b; }
    throw Error('never ate');
  };
  const lime = eat(E.LIMESTONE);
  assert.equal(lime.request & 2, 2); assert.equal(Math.floor(lime.request / C.CONTACT_PUFF_UNIT), C.ctRow(E.LIMESTONE).fizz);
  assert.equal(C.ctRow(E.LIMESTONE).fizz, Math.max(1, Math.round(legacyPressureToPa(PHYS.STEAM_BOIL_PUFF * ELEMENTS[E.LIMESTONE].fizz / PHYS.STEAM_EXPANSION))));
  for (let k = 0; k < 20; k++) assert.equal(eat(E.STONE).request, 0, 'stone eaten: no pressure');
  const smoke = C.ctInherit(C.ctNew(E.SMOKE, cell(E.WOOD).tq, 65536), cell(E.WOOD));
  assert.equal(smoke.request, 0, 'matter turned gas: no request of its own');
}
{
  // TH-13: with a void edge every face past the grid is still air at ambient (V1 react.js VOID_AIR_A), the
  // floor's too: the block pass's open-face count, run as JS, and ctBoundary taking up to six.
  const block = v2BlockWGSL(gridLayout(16, 16, 16), contactWGSL);
  const expr = block.match(/let open=([^;]+);/)[1].replace(/u32\(([^()]+)\)/g, 'Number($1)').replace(/==/g, '===');
  const open = new Function('p', 'NX', 'NY', 'NZ', `return ${expr};`);
  const N = 16, P = (x, y, z) => ({ x, y, z });
  assert.equal(open(P(5, 0, 5), N, N, N), 1, 'the floor is open past a void edge');
  assert.equal(open(P(0, 0, 0), N, N, N), 3); assert.equal(open(P(5, N - 1, 5), N, N, N), 1); assert.equal(open(P(5, 5, 5), N, N, N), 0);
  assert.ok(block.includes('if (P.edge==1u && mAirHeat()) {'), 'void edges only');
  const hot = cell(E.STONE, 500), one = C.ctBoundary(hot, 1, C.contactAmbientQ(20));
  const six = C.ctBoundary(hot, 6, C.contactAmbientQ(20));
  assert.equal(C.ctEnergy(hot) - C.ctEnergy(six), 6n * (C.ctEnergy(hot) - C.ctEnergy(one)), 'six open faces: six faces of exchange');
}
console.log('Outside word: six-face damp (every offset), dust faces, puffs only where V1 sets gas free, void floor open');

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
    if(tick===1)tick3=burning;
    burningTicks+=burning.reduce((n,v)=>n+v,0);
  }
  // V1 react.js re-tests burning every step: a hot edge cell burns from its first tick, and one its cold
  // neighbours cool under the ignition point goes out until its burning neighbours heat it back
  assert.deepEqual(tick3,[1,1,1,1],'all four hot edge cells burn on tick 1');
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
assert(support.includes('liquidScratch[s].x=(liquidScratch[s].x&0xfffffc00u)'));
// its clone faces outside the block, for the clone rule's share (contact.js CT_CLONE_MISS_LOG), and the block reads them
assert(support.includes(`if((id==${E.CLONE}u || (id==${E.PCLN}u && payloadOf(n)==${10 * 2048}u)) && ctypeOf(n)>0u){clone++;}`));
assert(support.includes('|(gas<<6u)|(clone<<8u);'));
assert(contactWGSL.includes('let outside=liquidScratch[slotOf(positions[i])].x&1023u;') && contactWGSL.includes(',touch,i32(outside>>8u),faces);'));
// the outside word (contact.js CT_OUT_*): support writes .y whole from its three outside faces, the block reads it
assert(support.includes('faces=ctOutsideFace(faces,n,inGrid(q),u32(axis));') && support.includes('liquidScratch[s].y=faces;'));
assert(contactWGSL.includes('let faces=i32(liquidScratch[slotOf(positions[i])].y)+up*CT_OUT_UP;'));
// The emitted ctOutsideFace, run as JS over every element and ctype, is the CPU twin's contactOutsideWord.
{
  const text = outsideFacesWGSL.slice(outsideFacesWGSL.indexOf('fn ctOutsideFace('));
  const js = text.replace(/^fn ctOutsideFace\(word:u32,n:vec4u,present:bool,axis:u32\)->u32 \{/, 'return (word,n,present,axis)=>{')
    .replace(/\/\/[^\n]*/g, '').replace(/\b(let|var) /g, 'let ').replace(/(\d+)u\b/g, '$1')
    .replace(/\(w\/(\d+)\)%(\d+)/g, '(Math.floor(w/$1)%$2)').replace(/w\|=(\d+)<<axis/g, 'w=(w|($1<<axis))>>>0');
  const face = new Function('cid', 'clsOf', 'ctypeOf', 'C_AIR', 'C_GAS', js)(n => n[0] & 255, n => ELEMENTS[n[0] & 255].kind, n => C.unpackContact(n).ctype, K.EMPTY, K.GAS);
  let compared = 0;
  for (const e of ELEMENTS) for (const ctype of [0, 1, 2, 3, 4, 5, C.CONTACT_CEDAR_BASE, C.CONTACT_CEDAR_BASE + 2, C.CONTACT_CEDAR_BASE + 4]) for (let axis = 0; axis < 3; axis++) {
    if (ctype && e.kind === K.EMPTY) continue;
    const core = C.packContact({ ...cell(e.id), ctype }).core, faces = [null, null, null]; faces[axis] = core;
    const prior = C.contactOutsideWord([null, null, null].map((_, a) => (a === (axis + 1) % 3 ? makeMaterial(E.WATER).core : null)));
    assert.equal(face(prior, core, true, axis), C.contactOutsideWord(faces.map((f, a) => f ?? (a === (axis + 1) % 3 ? makeMaterial(E.WATER).core : null))), `${e.key} ctype ${ctype} axis ${axis}`);
    assert.equal(face(prior, core, false, axis), prior, 'beyond the grid: nothing');
    compared++;
  }
  assert(compared > 1000);
}
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
