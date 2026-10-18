import assert from 'node:assert/strict';
import { setFall } from '../../src/v2/fall.js';
import { gridLayout } from '../../src/sim.js';
import { v2BlockWGSL, V2_CONTACT_LAYOUT } from '../../src/shaders/v2.js';
import { CONTACT_KERNEL } from '../../src/v2/contact.js';
import { contactKernelWGSL } from '../../src/shaders/v2/contact-kernel.js';
import { emitContactKernel } from '../../src/shaders/v2/contact.js';
import { E, ELEMENTS, K, REACTIONS } from '../../src/elements.js';
import { PHYS } from '../../src/physics.js';
import { CONDUCTS, SPARK_COST, conductsInto, packSpark } from '../../src/electricity.js';
import * as C from '../../src/v2/contact.js';
import * as F from '../../src/v2/phase.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { contactPrelude, contactEntry } from './contact-prelude.mjs';
import { assertNaga } from './wgsl-grouping.mjs';
const q = T => Math.round((T + 273.25) * 4);
const cell = (id, T = ELEMENTS[id].temp, fill = 65536) => C.ctNew(id, q(T), fill);
const energy = c => C.ctEnergy(c);
const energySum = cells => cells.reduce((n, c) => n + energy(c), 0n);
const ns = (...cells) => [...cells, ...Array.from({length:3},()=>cell(E.EMPTY))].slice(0,3);
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

test('12 disjoint internal faces, three partners each', () => {
  assert.equal(C.CONTACT_PAIRS.length, 12);
  assert.equal(new Set(C.CONTACT_PAIRS.map(([a,b])=>`${a}:${b}`)).size,12);
  for(const partners of C.CONTACT_FACES) assert.equal(partners.length,3);
});
test('all existing material payloads round trip, including spark 3608 and full life', () => {
  for(const e of ELEMENTS) {
    const c=cell(e.id); c.bank=-191; c.ctype=23; c.life=65535;
    if(CONDUCTS[e.id]) { c.spark=3608; if(e.kind===K.LIQUID)c.life=0; }
    const packed=C.packContact(c), out=C.unpackContact(packed.core,packed.bank);
    for(const key of ['id','tq','raw','life','ctype','spark','bank','fill']) assert.equal(out[key],c[key],`${e.key}.${key}`);
  }
  const oil=cell(E.OIL);oil.burning=1; const out=C.packContact(oil);assert.equal(C.unpackContact(out.core).burning,1);
});
test('exact conduction conservation over every content pair, including compressed liquids',()=>{
  for(const ea of ELEMENTS) for(const eb of ELEMENTS) {
    let a=cell(ea.id,20,1048576),b=cell(eb.id,120,1048576);
    const before=energy(a)+energy(b),flux=C.ctFlux(a,b);
    a=C.ctHeat(a,flux);b=C.ctHeat(b,-flux);
    assert.equal(energy(a)+energy(b),before,`${ea.key}/${eb.key}`);
  }
});
test('sub-quantum heat rests and no global ambient pull',()=>{
  let a=cell(E.WOOD,30),b=cell(E.WOOD,30);a.bank=1;
  assert.equal(C.ctFlux(a,b),0);
  const out=C.ctStep(a,ns(b,b,b),1);assert.equal(energy(out),energy(a));assert.equal(out.busy,0);
  const metal=cell(E.METAL,80);assert.equal(C.ctStep(metal,ns(metal,metal,metal),0).busy,0);
});
test('phase tags encode exact signed enthalpy at full and maximum compressed fill',()=>{
  for(const e of ELEMENTS) for(const fill of [1,17,65536,1048576]) {
    const c=cell(e.id,20,fill),row=F.PHASE_ROWS[e.id],amount=C.ctAmount(c);
    for(const hot of [true,false]) {
      const latent=BigInt(hot?row.hotLatent:row.coldLatent)*BigInt(amount);
      if(!latent)continue;
      const base=BigInt(C.ctCapacity(c))*BigInt(hot?row.hotQ:row.coldQ)+F.phaseOffsetEnergy(e.id,amount);
      for(const fraction of [0n,1n,17n,999n,1000n]) {
        const target=base+(hot?1n:-1n)*latent*fraction/1000n;
        const out=C.ctSetEnergy(c,target);
        assert.equal(energy(out),target,`${e.key}/${fill}/${hot}/${fraction}`);
        assert.ok(out.bank>=-2147483648&&out.bank<=2147483647);
        assert.equal(out.tq,hot?row.hotQ:row.coldQ);
      }
    }
  }
  assert.throws(()=>F.phaseTemperatureQ(E.METAL,F.PHASE_HOT_BASE),/invalid phase tag/);
  assert.throws(()=>F.phaseTemperatureQ(E.WATER,65536),/invalid native/);
});
test('latent water/ice/steam/mercury cycles conserve and hold phase temperature',()=>{
  for(const [id,hot] of [[E.WATER,false],[E.WATER,true],[E.MERCURY,false],[E.MERCURY,true]]) {
    const row=F.PHASE_ROWS[id],c=cell(id),amount=C.ctAmount(c);
    const tq=hot?row.hotQ:row.coldQ;
    const baseline=BigInt(C.ctCapacity(c))*BigInt(tq)+F.phaseOffsetEnergy(id,amount);
    const latent=BigInt(hot?row.hotLatent:row.coldLatent)*BigInt(amount);
    const halfway=C.ctSetEnergy(c,baseline+(hot?latent:-latent)/2n);
    assert.equal(halfway.tq,tq);assert.equal(C.ctPhase(halfway,1,0).id,id);
    const target=baseline+(hot?latent:-latent);
    const product=C.ctPhase(C.ctSetEnergy(c,target),1,0);
    assert.notEqual(product.id,id);assert.equal(energy(product),target);assert.equal(product.tq,tq);
    const reverse=C.ctPhase(C.ctSetEnergy(product,baseline),1,0);
    assert.equal(reverse.id,id);assert.equal(energy(reverse),baseline);assert.equal(reverse.tq,tq);
  }
});
test('uniform-temperature liquid advection leaves persistent carrier energy',()=>{
  for(const id of ELEMENTS.filter(e=>e.kind===K.LIQUID).map(e=>e.id)) {
    for(const amount of [1,17,32768,65536]) {
      const a=cell(id,20),b=cell(E.EMPTY,20),before=energy(a)+energy(b);
      const parcel=(BigInt(C.ctRow(id).capacity)*BigInt(a.tq)+BigInt(F.phaseOffsetPerQuantum(id,a.ctype)))*BigInt(amount);
      const na=amount===65536?cell(E.EMPTY,20):cell(id,20,65536-amount);
      const nb=cell(id,20,amount);
      const ea=energy(a)-parcel,eb=energy(b)+parcel;
      assert.equal(energy(na),ea);assert.equal(energy(nb),eb);assert.equal(ea+eb,before);
      assert.equal(C.ctSetEnergy(na,ea).tq,a.tq);assert.equal(C.ctSetEnergy(nb,eb).tq,b.tq);
    }
  }
});
test('all 14 reaction rows dispatch real products, obey gates, and balance heat',()=>{
  assert.equal(C.CONTACT_REACTIONS.length,REACTIONS.length);
  for(let i=0;i<REACTIONS.length;i++) {
    const row=C.CONTACT_REACTIONS[i],idb=row.b<0?E.METAL:row.b;
    const T=Math.max(20,(row.minQ/4-273.25)+1);
    const a=cell(row.a,T),b=cell(idb,T);let pair;
    for(let seed=0;seed<2000;seed++){pair=C.ctReaction(a,b,seed);if(pair.changed)break;}
    assert.equal(pair.changed,1,`row ${i}`);
    assert.ok(pair.a.id!==a.id||pair.b.id!==b.id,`row ${i} products`);
    const limit=BigInt(row.ceiling)*BigInt(C.ctCapacity(pair.a)+C.ctCapacity(pair.b))+C.ctOffset(pair.a)+C.ctOffset(pair.b);
    const expected=energy(a)+energy(b)+BigInt(row.heat)*65536n;
    assert.equal(energy(pair.a)+energy(pair.b),row.heat>0&&expected>limit?(energy(a)+energy(b)>limit?energy(a)+energy(b):limit):expected,`row ${i} energy`);
    assert.ok(pair.a.tq<=row.ceiling&&pair.b.tq<=row.ceiling,`row ${i} temperature cap`);
    if(row.minQ>0)assert.equal(C.ctReaction(cell(row.a,-273.25),cell(idb,-273.25),0).changed,0);
  }
  assert.equal(C.ctRxAt(E.ANTIMATTER,E.WALL),0);
  assert.equal(C.ctRxAt(E.ANTIMATTER,E.EMPTY),0);
});
test('all electric pairs obey TPT diode/switch direction, 3608 retained',()=>{
  for(const a of ELEMENTS)for(const b of ELEMENTS) assert.equal(C.ctConductsInto(a.id,b.id),conductsInto(a.id,b.id));
  for(const e of ELEMENTS.filter(e=>CONDUCTS[e.id])) {
    const c=cell(e.id); if(e.id===E.SWITCH)c.life=20480;
    const out=C.ctElectric(c,ns(cell(E.BATTERY)),0.999);
    assert.equal(out.spark,e.id===E.LAMP?81:packSpark(8,400-Math.trunc(SPARK_COST[e.id])),e.key);
    if(e.id!==E.LAMP)assert.equal(C.ctElectric(out,ns(),0).spark%9,7);
  }
});
test('switch off wins, powered clone controls, TSNS ignores wires, steady DC lamp sleeps',()=>{
  const p=cell(E.PSCN),n=cell(E.NSCN);p.spark=n.spark=3608;
  for(const id of [E.SWITCH,E.PCLN]) {
    const c=cell(id);assert.equal(C.ctElectric(c,ns(p),0).life,20480);
    c.life=20480;assert.equal(C.ctElectric(c,ns(p,n),0).life,18432);
  }
  const sensor=cell(E.TSNS,100);assert.equal(C.ctElectric(sensor,ns(cell(E.METAL,500)),0).life,0);
  assert.equal(C.ctElectric(sensor,ns(cell(E.WOOD,500)),0).life,2048);
  const lamp=C.ctElectric(cell(E.LAMP),ns(cell(E.BATTERY)),0);assert.equal(lamp.spark,81);assert.equal(lamp.busy,0);
  assert.ok(C.ctElectric(lamp,ns(),0).spark>0);
  const ready=cell(E.METAL),front=cell(E.METAL);front.spark=3608;
  assert.equal(C.ctElectric(ready,ns(front),0.99).spark,3608);
});
test('ignition certainty, flame ignition at room temperature, fuel consumption and smothering',()=>{
  const hot=cell(E.WOOD,400),burn=C.ctStep(hot,ns(),0);
  assert.ok(burn.life<hot.life);assert.ok(burn.burning===1);assert.ok(burn.request&2);
  for(const neighbors of [ns(cell(E.CO2),cell(E.CO2)),ns(cell(E.WALL),cell(E.WALL),cell(E.WALL))]) {
    const out=C.ctStep(burn,neighbors,0);assert.equal(out.life,burn.life);assert.equal(out.burning,0);
  }
  let lit=false;
  for(let seed=0;seed<1000;seed++)if(C.ctStep(cell(E.WOOD),ns(cell(E.FIRE,1000)),seed).burning===1){lit=true;break;}
  assert.ok(lit,'room-temperature fuel can ignite probabilistically');
  const falling=cell(E.SAWDUST);falling.age=30;assert.equal(C.ctStep(falling,ns(),0).life,falling.life);
});
test('fire/smoke/plasma life ends, steam/caustic gas do not fade as prototype',()=>{
  for(const id of [E.FIRE,E.SMOKE,E.PLASMA]) {const c=cell(id);c.life=1;assert.notEqual(C.ctStep(c,ns(),0).id,id);}
  const steam=cell(E.STEAM,110);assert.equal(C.ctStep(steam,ns(steam,steam,steam),0).id,E.STEAM);
  const acid=cell(E.CAUSTIC_GAS);assert.equal(C.ctStep(acid,ns(),0).life,acid.life);
});
test('blasts request source without consuming, fuse handoff, suspended dust and neutron source',()=>{
  // A blast into matter (thermite) converts in place: tools/v2/elements-boom-check.mjs.
  for(const e of ELEMENTS.filter(e=>e.blast && !e.blast.into)) {
    const c=cell(e.id,Math.min(10000,e.ignite+50));const out=C.ctStep(c,ns(),0);
    assert.equal(out.id,c.id,e.key);assert.ok(out.request&1,e.key);
  }
  const fuse=cell(E.FUSE),lit=cell(E.FUSE);lit.life=100;assert.ok(C.ctStep(fuse,ns(lit),0).life<2048);
  const dust=cell(E.DUST,500);dust.fallSpeed=C.DUST_MIN_FALL_SPEED;assert.ok(C.ctStep(dust,ns(cell(E.DUST)),0).request&1);
  let emitted=false;
  for(let seed=0;seed<100000;seed++)if(C.ctStep(cell(E.PLUTONIUM),ns(),seed).request&4){emitted=true;break;}
  assert.ok(emitted);assert.equal(C.ctStep(cell(E.URANIUM),ns(),0).request&4,0);
  const molten=cell(E.LAVA,700);molten.ctype=E.PLUTONIUM;emitted=false;
  assert.equal(C.contactNuclearMaterial(C.packContact(molten).core),E.PLUTONIUM);
  for(let seed=0;seed<100000;seed++)if(C.ctStep(molten,ns(),seed).request&4){emitted=true;break;}
  assert.ok(emitted,'molten plutonium still emits neutrons');
});
test('growth/damp propagation, acid consumption, clone memory, void, singularity merge',()=>{
  assert.equal(C.ctStep(cell(E.MOSS),ns(cell(E.WATER)),0).ctype,4);
  const wet=cell(E.MOSS);wet.ctype=4;assert.equal(C.ctStep(cell(E.FUNGUS),ns(wet),0).ctype,3);
  assert.equal(C.ctStep(cell(E.CLONE),ns(cell(E.SAND)),0).ctype,E.SAND);
  assert.equal(C.ctStep(cell(E.SAND),ns(cell(E.VOID)),0).id,E.EMPTY);
  let eaten;
  for(let seed=0;seed<100;seed++){eaten=C.ctAcid(cell(E.ACID),cell(E.LIMESTONE),seed);if(eaten.changed)break;}
  assert.equal(eaten.changed,1);assert.ok(eaten.a.life<2048);assert.ok(eaten.b.request&2);
  assert.equal(C.ctAcid(cell(E.ACID),cell(E.GLASS),0).changed,0);
  const a=cell(E.SINGULARITY),b=cell(E.SINGULARITY),before=energy(a)+energy(b);
  const merged=C.ctSwallow(a,b,0);assert.equal(merged.a.life,6144);assert.equal(merged.b.id,E.EMPTY);assert.equal(energy(merged.a)+energy(merged.b),before);
});
test('block keeps banks/core paired and stationary contact can sleep',()=>{
  const materials=Array.from({length:8},()=>C.packContact(cell(E.METAL,20)));
  const result=C.contactReference(materials.map(m=>m.core),materials.map(m=>m.bank),1);
  assert.deepEqual(result.busy,[]);assert.deepEqual([...result.requests],Array(8).fill(0));
});
test('source-specific iron/glass/gold lava cycles preserve enthalpy and source thresholds',()=>{
  for(const id of [E.METAL,E.GLASS,E.GOLD]) {
    const threshold=q(ELEMENTS[id].melt), initial=C.ctNew(id,threshold+1,65536);
    const lava=C.ctPhase(initial,1,0);
    assert.equal(lava.id,E.LAVA);assert.equal(lava.ctype,id);assert.equal(energy(lava),energy(initial));
    assert.ok(Math.abs(lava.tq-initial.tq)<=1,`${ELEMENTS[id].key} no spurious melt-temperature jump`);
    const justWarm=C.ctSetEnergy(lava,BigInt(C.ctCapacity(lava))*BigInt(threshold-600)+C.ctOffset(lava));
    assert.equal(C.ctPhase(justWarm,1,0).id,E.LAVA,'exact freeze threshold has hysteresis');
    const cool=C.ctSetEnergy(lava,BigInt(C.ctCapacity(lava))*BigInt(threshold-601)+C.ctOffset(lava));
    const frozen=C.ctPhase(cool,1,0);assert.equal(frozen.id,id);assert.equal(energy(frozen),energy(cool));
    assert.ok(frozen.tq<threshold,'freeze does not immediately remelt');
    const remelt=C.ctPhase(C.ctSetEnergy(frozen,energy(initial)),1,0);
    assert.equal(remelt.id,E.LAVA);assert.equal(remelt.ctype,id);assert.equal(energy(remelt),energy(initial));
  }
});
test('every content hot/cold product executes, with conservative overflow redistribution',()=>{
  let paths=0, redistributed=0;
  for(const e of ELEMENTS) for(const hot of [true,false]) {
    const c=cell(e.id),row=C.ctRow(e.id),at=hot?row.hotOut:row.coldOut;
    if(at<0)continue;
    let previous=0;
    for(let index=at;index<C.CONTACT_PRODUCTS.length;index++) {
      const product=C.CONTACT_PRODUCTS[index],draw=(previous+product.limit)/2;
      const baseline=BigInt(C.ctCapacity(c))*BigInt(hot?row.hotQ:row.coldQ)+C.ctOffset(c);
      const latent=BigInt(hot?row.hotL:row.coldL)*BigInt(C.ctAmount(c));
      const ready=C.ctSetEnergy(c,baseline+(hot?latent:-latent));
      let after=C.ctPhase(ready,1,draw);
      if(after.pending>=0) {
        const reservoir=cell(E.WALL),pair=C.ctResolvePhase(after,reservoir);
        assert.equal(pair.changed,1,`${e.key} ${hot?'hot':'cold'} ${ELEMENTS[product.id].key} can execute`);
        assert.equal(energy(pair.a)+energy(pair.b),energy(ready)+energy(reservoir));
        after=pair.a;redistributed++;
      }else assert.equal(energy(after),energy(ready));
      assert.equal(after.id,product.id,`${e.key} ${hot?'hot':'cold'} product`);
      paths++;previous=product.limit;if(product.limit===1)break;
    }
  }
  assert.ok(paths>=40);assert.equal(redistributed,1,'acid caustic branch needs a heat reservoir');
  const nitrogen=cell(E.LIQUID_NITROGEN),row=C.ctRow(E.LIQUID_NITROGEN);
  const ready=C.ctSetEnergy(nitrogen,BigInt(C.ctCapacity(nitrogen))*BigInt(row.hotQ)+C.ctOffset(nitrogen)+BigInt(row.hotL)*65536n);
  assert.equal(C.ctPhase(ready,1,0).tq,row.hotQ,'nitrogen does not turn boiling latent heat into hot air');
  console.log(`${paths} actual hot/cold product paths executed`);
});
test('every melt/burn content row executes, combustible liquid fuel is extensive',()=>{
  let melts=0,burns=0;
  for(const e of ELEMENTS) {
    if(e.melt) {const source=cell(e.id,e.melt+1),out=C.ctPhase(source,1,0);assert.equal(out.id,E.LAVA,e.key);assert.equal(out.ctype,E[e.meltInto]??e.id);assert.equal(energy(out),energy(source));melts++;}
    if(e.burnRate>0&&e.id!==E.FUSE) {
      const vapour=e.hot&&e.hot.T<e.ignite;
      const source=cell(e.id,vapour?Math.max(20,e.flash+1):e.ignite+1),out=C.ctStep(source,vapour?ns(cell(E.FIRE)):ns(),1);
      // Fuels with a lower boiling point (whiskey) change phase first.
      if(out.id===source.id){assert.ok(out.life<source.life,e.key);assert.equal(out.burning,1,e.key);}
      else assert.ok(C.ctRow(e.id).hotOut>=0,e.key);
      assert.equal(energy(out),energy(source)+out.source-out.sink,e.key);burns++;
    }
  }
  assert.ok(melts>=20);assert.ok(burns>=10);
  const half=cell(E.OIL,20,32768),compressed=cell(E.OIL,20,1048576);
  assert.equal(half.life,1024);assert.equal(compressed.life,32768);
  assert.throws(()=>cell(E.OIL,20,16777215),/fuel payload/);
});
test('V1 flames into air on every face, flash-point vapour, oxygen, smoke share and burnt-out residue, exact ledgers',()=>{
  const ledger=out=>out.source-out.sink;
  const catches=(input,neighbors,tries=200)=>{for(let seed=0;seed<tries;seed++){const out=C.ctStep(input,neighbors,seed);if(out.id===E.FIRE)return out;}return null;};
  // V1 react.js: air beside a fuel at its ignition point catches (FLAME_SPREAD a step per burning face).
  const wood=cell(E.WOOD,400),air=cell(E.EMPTY);
  const flame=catches(air,ns(wood));assert.ok(flame,'air beside burning wood catches');
  const flameT=ELEMENTS[E.WOOD].flameT;
  assert.ok(flame.tq>=q(flameT*PHYS.FLAME_T_MIN)-1&&flame.tq<=q(flameT)+1,'flameT·(FLAME_T_MIN + FLAME_T_SPREAD·rnd)');
  assert.equal(energy(flame)-ledger(flame),energy(air),'the flame is a declared source');
  assert.equal(flame.request&2,0,'air catching is no gas puff');
  assert.ok(flame.life>=PHYS.FIRE_LIFE_MIN*2048-1&&flame.life<=2048,'FIRE_LIFE_MIN + FIRE_LIFE_SPREAD·rnd');
  // every face: the burning partner's position does not matter (no up-only plume)
  for(let k=0;k<3;k++){const n=[cell(E.WALL),cell(E.WALL),cell(E.WALL)];n[k]=wood;assert.ok(catches(air,n),`face ${k}`);}
  // per-tick rate: 1 - (1 - FLAME_SPREAD)^8 per burning partner
  let lit=0;for(let seed=0;seed<4000;seed++)if(C.ctStep(air,ns(wood),seed).id===E.FIRE)lit++;
  const expected=1-(1-PHYS.FLAME_SPREAD)**8;assert.ok(Math.abs(lit/4000-expected)<0.03,`rate ${lit/4000} vs ${expected}`);
  assert.equal(catches(air,ns(cell(E.WOOD,20))),null,'cold fuel lights no air');
  assert.equal(catches(air,ns(wood,cell(E.CO2),cell(E.CO2))),null,'smothered air does not catch');
  // past its flash point a fuel's vapour carries a flame: only with a flame touching the air too
  const whiskey=cell(E.WHISKEY,ELEMENTS[E.WHISKEY].flash+5);assert.ok(ELEMENTS[E.WHISKEY].flash<ELEMENTS[E.WHISKEY].ignite);
  assert.equal(catches(air,ns(whiskey)),null,'flash-point vapour alone does not catch');
  assert.ok(catches(air,ns(whiskey,cell(E.FIRE,1000))),'flash-point vapour beside a flame catches');
  // oxygen catches O2_PER_AIR times as often (certain here) and hotter, burning in oxygen
  const oxygen=cell(E.OXYGEN),ox=C.ctStep(oxygen,ns(wood),0);assert.equal(ox.id,E.FIRE);assert.equal(ox.ctype,E.OXYGEN);
  assert.ok(ox.tq>q(flameT*PHYS.FLAME_T_MIN));assert.equal(energy(ox)-ledger(ox),energy(oxygen));
  // a flame needs no air face, goes out under FIRE_MIN_T, and leaves smoke FIRE_TO_SMOKE of the time
  const closedFlame=cell(E.FIRE,1000);assert.equal(C.ctStep(closedFlame,ns(cell(E.WALL),cell(E.WALL),cell(E.WALL)),0).id,E.FIRE);
  assert.notEqual(C.ctStep(cell(E.FIRE,300),ns(),0).id,E.FIRE);
  let smoke=0;for(let seed=0;seed<4000;seed++){const f=cell(E.FIRE,1000);f.life=1;if(C.ctStep(f,ns(),seed).id===E.SMOKE)smoke++;}
  assert.ok(Math.abs(smoke/4000-PHYS.FIRE_TO_SMOKE)<0.03,`smoke share ${smoke/4000}`);
  const fire=cell(E.FIRE,1000);fire.bank=317;fire.life=1;
  let dead;for(let seed=0;seed<100;seed++){dead=C.ctStep(fire,ns(),seed);if(dead.id===E.SMOKE)break;}
  assert.equal(dead.id,E.SMOKE);assert.equal(dead.tq,fire.tq);assert.equal(dead.bank,317);
  assert.equal(energy(dead)+dead.sink-dead.source,energy(fire));
  dead.life=1;dead.source=0n;dead.sink=0n;
  const gone=C.ctStep(dead,ns(),0);assert.equal(gone.id,E.EMPTY);assert.equal(gone.tq,dead.tq);assert.equal(gone.bank,317);assert.equal(energy(gone)+gone.sink-gone.source,energy(dead));
  // lives per tick: V1 FIRE_BURN(+SPREAD) and SMOKE_FADE a step, four steps a tick
  const smokeCell=cell(E.SMOKE);let fade=0;for(let seed=0;seed<1000;seed++)fade+=smokeCell.life-C.ctStep(smokeCell,ns(),seed).life;
  assert.ok(Math.abs(fade/1000-PHYS.SMOKE_FADE*4*2048)<0.1,`smoke fade ${fade/1000}`);
  let burn=0;for(let seed=0;seed<1000;seed++)burn+=closedFlame.life-C.ctStep(closedFlame,ns(cell(E.EMPTY)),seed).life;
  assert.ok(Math.abs(burn/1000-(PHYS.FIRE_BURN+PHYS.FIRE_BURN_SPREAD/2)*4*2048)<4,`flame burn ${burn/1000}`);
  // burnt out: ash (ASH_SHARE) or a flame, at least BURNT_MIN_T hot, as a declared source
  const products=new Set();
  for(let seed=0;seed<64;seed++){
    const dying=cell(E.WOOD,320);dying.life=1;dying.burning=1;
    const out=C.ctStep(dying,ns(),seed);products.add(out.id);
    assert.ok(out.id===E.FIRE||out.id===E.ASH);assert.ok(out.tq>=q(PHYS.BURNT_MIN_T));
    assert.equal(energy(out)+out.sink-out.source,energy(dying));
  }
  assert.deepEqual([...products].sort(),[E.ASH,E.FIRE].sort(),'V1 leaves ash or fire, no CO2');
});
test('growth/rot witness each biological rule at actual temperature with explicit ledger',()=>{
  const wet=cell(E.MOSS);wet.ctype=4;const fungus=cell(E.FUNGUS);fungus.ctype=4;
  const fixtures=[
    [cell(E.WATER),ns(cell(E.PLANT)),E.PLANT],
    [cell(E.EMPTY),ns(wet,cell(E.ROCK)),E.MOSS],
    ...ELEMENTS.filter(e=>e.rots).map(e=>[cell(e.id),ns(fungus),E.FUNGUS]),
  ];
  for(const [before,neighbors,id] of fixtures) {
    let out;
    for(let seed=0;seed<100000;seed++){out=C.ctStep(before,neighbors,seed);if(out.id===id)break;}
    assert.equal(out.id,id,ELEMENTS[before.id].key);assert.equal(out.tq,before.tq);
    assert.equal(energy(out)+out.sink-out.source,energy(before));
  }
  assert.equal(C.ctStep(cell(E.MOSS,110),ns(cell(E.WATER)),0).ctype,0,'hot mats dry');
  const dry=cell(E.MOSS);assert.equal(C.ctStep(cell(E.EMPTY),ns(dry,cell(E.ROCK)),0).busy,0,'dry moss does not keep air awake');
});
test('cloud rain/evaporation/storm charge, clone emit/control and singularity lifecycle execute',()=>{
  const cloud=cell(E.CLOUD,20);let rain,evap;
  for(let seed=0;seed<100000;seed++){
    if(!rain){const out=C.ctStep(cloud,ns(cloud,cloud,cloud),seed);if(out.id===E.WATER)rain=out;}
    if(!evap){const out=C.ctStep(cloud,ns(),seed);if(out.id===E.EMPTY)evap=out;}
    if(rain&&evap)break;
  }
  assert.ok(rain);assert.equal(energy(rain),energy(cloud));assert.ok(evap);assert.equal(energy(evap)+evap.sink-evap.source,energy(cloud));
  const cold=cell(E.CLOUD,0),snow=cell(E.SNOW);snow.fallSpeed=40*C.CONTACT_G_TICK;let charged=false;
  for(let seed=0;seed<100;seed++)if(C.ctStep(cold,ns(snow),seed).ctype>0){charged=true;break;}
  assert.ok(charged);snow.fallSpeed=0;assert.equal(C.ctStep(cold,ns(snow),0).ctype,0,'stationary snow cannot charge cloud');
  for(const id of [E.CLONE,E.PCLN]) {
    const clone=cell(id);clone.ctype=E.WATER;clone.life=id===E.PCLN?20480:0;
    let out;for(let seed=0;seed<100;seed++){out=C.ctStep(cell(E.EMPTY),ns(clone),seed);if(out.id===E.WATER)break;}
    assert.equal(out.id,E.WATER);assert.equal(energy(out)+out.sink-out.source,energy(cell(E.EMPTY)));
    if(id===E.PCLN){clone.life=0;assert.equal(C.ctStep(cell(E.EMPTY),ns(clone),0).id,E.EMPTY);}
  }
  const full=cell(E.SINGULARITY);full.life=51200;assert.ok(C.ctStep(full,ns(),0).request&1);
  const starved=cell(E.SINGULARITY);starved.life=256;assert.ok(C.ctStep(starved,ns(),0).request&1);
  const ordinary=cell(E.SINGULARITY),evaporated=C.ctStep(ordinary,ns(),0);assert.ok(evaporated.life<ordinary.life);assert.equal(evaporated.id,E.SINGULARITY);
  assert.equal(C.contactVacuum(C.packContact(full).core),-50);
  const victim=cell(E.SAND);const swallowed=C.ctSwallow(ordinary,victim,0);assert.equal(swallowed.b.id,E.EMPTY);assert.ok(swallowed.a.life>ordinary.life);assert.equal(energy(swallowed.a)+energy(swallowed.b),energy(ordinary)+energy(victim));
});
test('pending source obligations survive chemistry/phase and OR with existing gas requests',()=>{
  const materials=Array.from({length:8},()=>C.packContact(cell(E.ACID,500)));
  materials[0]=C.packContact(cell(E.GUNPOWDER,500));
  const pending=Uint32Array.of(1|2,4,0,0,0,0,0,0);
  const before=materials.map(m=>m.core[0]&255);
  const out=C.contactReference(materials.map(m=>m.core),materials.map(m=>m.bank),13,C.CONTACT_POSITIONS,pending);
  assert.equal(out.cores[0][0]&255,before[0]);assert.equal(out.cores[1][0]&255,before[1]);
  assert.equal(out.requests[0]&3,3);assert.equal(out.requests[1]&4,4);
  assert.ok(out.busy.includes(0)&&out.busy.includes(1));
});
test('reserved spark flags, independent fall velocity and burn flags survive native contact packing',()=>{
  for(const id of [E.WATER,E.MERCURY,E.METAL]) {
    const c=cell(id);c.spark=3608;
    const m=C.packContact(c);m.core[3]|=ELEMENTS[id].kind===K.LIQUID?0xf0000000:0x0000f000;
    const decoded=C.unpackContact(m.core,m.bank),out=C.packContact(decoded,m.core);
    assert.equal(decoded.spark,3608);assert.deepEqual(out.core,m.core);
  }
  const grain=cell(E.SAWDUST);grain.burning=1;
  const m=C.packContact(grain);m.core=setFall(m.core,2.5,0.625);const decoded=C.unpackContact(m.core,m.bank);assert.equal(decoded.fallSpeed,2.5/18);assert.equal(decoded.burning,1);assert.deepEqual(C.packContact(decoded,m.core).core,m.core);
  const slow=cell(E.DUST,500);slow.fallSpeed=C.DUST_MIN_FALL_SPEED-0.001;assert.equal(C.ctStep(slow,ns(cell(E.DUST)),0).request&1,0);
});
test('temperature-aware gas density and boundary-only ambient exchange preserve rest',()=>{
  for(const e of ELEMENTS.filter(e=>e.kind===K.GAS||e.kind===K.EMPTY)) {
    assert.ok(C.contactDensity(e.id,q(500))<C.contactDensity(e.id,q(20)),e.key);
    assert.equal(C.ctDensity(cell(e.id,20)),C.contactDensity(e.id,q(20)),e.key);
  }
  const hot=cell(E.METAL,200),closed=C.ctBoundary(hot,0,q(20));assert.equal(energy(closed),energy(hot));assert.equal(closed.busy,0);
  const cooled=C.ctBoundary(hot,1,q(20));assert.ok(energy(cooled)<energy(hot));assert.equal(energy(cooled)+cooled.sink-cooled.source,energy(hot));
  const ambient=cell(E.METAL,20);assert.equal(C.ctBoundary(ambient,5,q(20)).busy,0);
});
test('mixed block property test balances every explicit source/sink without bank overflow',()=>{
  let seed=91823;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let trial=0;trial<250;trial++) {
    const cells=Array.from({length:8},()=>cell(random(ELEMENTS.length),20+random(2500)));
    const before=energySum(cells),packed=cells.map(c=>C.packContact(c));
    const out=C.contactReference(packed.map(m=>m.core),packed.map(m=>m.bank),trial);
    const after=out.cores.map((c,i)=>C.unpackContact(c,out.banks[i]));
    const source=out.sources.reduce((a,b)=>a+b,0n),sink=out.sinks.reduce((a,b)=>a+b,0n);
    assert.equal(energySum(after)+sink-source,before,`block ${trial}`);
  }
});
test('integer heat keeps scheduling real flux then reaches a finite rest certificate',()=>{
  const initial=Array.from({length:8},(_,i)=>C.ctNew(E.METAL,1173+i*400,65536));
  const total=energySum(initial),packed=initial.map(c=>C.packContact(c));
  let cores=packed.map(m=>m.core),banks=packed.map(m=>m.bank),quiet=-1;
  for(let tick=0;tick<1000;tick++) {
    const out=C.contactReference(cores,banks,tick);cores=out.cores;banks=out.banks;
    assert.equal(energySum(cores.map((core,i)=>C.unpackContact(core,banks[i]))),total);
    if(tick===0)assert.ok(out.busy.length>0,'nonzero conduction cannot falsely certify idle');
    if(!out.busy.length){quiet=tick;break;}
  }
  assert.ok(quiet>=0&&quiet<1000,'quantized sensible remainders cannot create a permanent two-tick heat cycle');
  for(let tick=0;tick<8;tick++) assert.deepEqual(C.contactReference(cores,banks,quiet+tick+1).busy,[]);
  console.log(`Closed metal block thermal rest after ${quiet} ticks`);
});
test('out-of-grid sentinel walls are excluded without disabling real wall conduction',()=>{
  const valid=[true,true,false,false,false,false,false,false];
  const cells=Array.from({length:8},(_,i)=>i===0?cell(E.METAL,800):i===1?cell(E.WALL,20):C.ctNew(E.WALL,0,65536));
  const initial=energy(cells[0])+energy(cells[1]),packed=cells.map(c=>C.packContact(c));
  const before=packed.map(m=>new Uint32Array(m.core));
  const positions=C.CONTACT_POSITIONS.map((p,i)=>valid[i]?p:[-1,-1,-1]);
  const out=C.contactReference(packed.map(m=>m.core),packed.map(m=>m.bank),0,positions,new Uint32Array(8),valid);
  const a=C.unpackContact(out.cores[0],out.banks[0]),b=C.unpackContact(out.cores[1],out.banks[1]);
  assert.equal(energy(a)+energy(b),initial);assert.ok(energy(b)>energy(cells[1]),'real WALL retains its conductivity');
  for(let i=2;i<8;i++){assert.deepEqual(out.cores[i],before[i]);assert.equal(out.banks[i],0);assert.equal(out.sources[i],0n);assert.equal(out.sinks[i],0n);assert.ok(!out.busy.includes(i));}
  const lone=C.contactReference(before.map(c=>new Uint32Array(c)),Array(8).fill(0),0,positions,new Uint32Array(8),[true,false,false,false,false,false,false,false]);
  assert.equal(C.materialEnergy(lone.cores[0],lone.banks[0]),energy(cells[0]));assert.deepEqual(lone.busy,[]);
});
test('DUST/SING requests have calibrated finite dynamics descriptors including zero-mass retirement',()=>{
  const gp=ELEMENTS[E.GUNPOWDER].dens*100*0.3**3*3e6*1e-3;
  assert.ok(Math.abs(gp-121500)<1e-8);
  const dust=C.specialExplosion(C.packContact(cell(E.DUST,1900)).core,gp);
  assert.ok(Math.abs(dust.energyJ-30375)<1e-8);assert.equal(dust.product,E.FIRE);assert.equal(dust.productT,1900);
  const sing=cell(E.SINGULARITY);sing.life=51200;
  const full=C.specialExplosion(C.packContact(sing).core,gp);assert.ok(Math.abs(full.energyJ-1350000)<1e-7);assert.equal(full.productT,3000);
  sing.life=128;const starved=C.specialExplosion(C.packContact(sing).core,gp);assert.ok(starved.energyJ>0&&starved.energyJ<33.75);
  sing.life=0;const gone=C.specialExplosion(C.packContact(sing).core,gp);assert.equal(gone.energyJ,0);assert.equal(gone.product,E.EMPTY);
  assert.equal(C.specialExplosion(C.packContact(cell(E.METAL)).core,gp),null);
});
test('zero-fill/zero-fuel edges and invalid phase sources do not manufacture heat',()=>{
  const dry=cell(E.WATER,0,0);const empty=C.ctPhase(dry,1,0);assert.equal(empty.id,E.EMPTY);assert.equal(energy(empty),energy(dry));
  const trace=cell(E.OIL,500,1);assert.equal(trace.life,0);
  const out=C.ctStep(trace,ns(),0);assert.equal(out.id,E.EMPTY);assert.equal(out.source,0n);assert.equal(energy(out)+out.sink,energy(trace));
  const pending=cell(E.ACID),row=C.ctRow(E.ACID);
  const ready=C.ctSetEnergy(pending,BigInt(C.ctCapacity(pending))*BigInt(row.hotQ)+C.ctOffset(pending)+BigInt(row.hotL)*65536n);
  const wait=C.ctPhase(ready,1,0.999);assert.equal(wait.pending,E.CAUSTIC_GAS);assert.equal(wait.request&2,0);
  const air=cell(E.EMPTY),blocked=C.ctResolvePhase(wait,air);assert.equal(blocked.changed,0);assert.equal(blocked.a.id,E.ACID);assert.equal(energy(blocked.a)+energy(blocked.b),energy(ready)+energy(air));
  const lava=C.packContact(cell(E.LAVA));lava.core[1]=(lava.core[1]&0xffffff)|(E.WOOD<<24);assert.throws(()=>F.validatePhaseCore(lava.core),/invalid native lava source/);
  C.validateContactMaterials();assert.throws(()=>C.validateContactMaterials([{kind:K.LIQUID,key:'BAD',elec:1,burnRate:1,life:1}]),/payload conflict/);
});
test('checked generated scalar WGSL remains identical to canonical CPU kernels',()=>{
  assert.equal(contactKernelWGSL,CONTACT_KERNEL.map(([fn,args,result])=>emitContactKernel(fn,args,result)).join('\n'));
});
test('generated WGSL validates on CPU Naga with explicit shared prelude and bounded shared bindings',()=>{
  assert.equal((contactWGSL.match(/var<storage/g)||[]).length,0);
  assertNaga(contactPrelude+contactWGSL+contactEntry,'contact');
  assertNaga(v2BlockWGSL(gridLayout(32,32,32),contactWGSL),'real contact');
  assert.ok(V2_CONTACT_LAYOUT.filter(e=>e.buffer&&e.buffer.type.includes('storage')).length<=8);
  console.log('Standalone and real foundation contact block Naga validation successful');
});
console.log(`${checks} native contact CPU groups passed; no GPU launched`);
