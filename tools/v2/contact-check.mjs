import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E, ELEMENTS, K, REACTIONS } from '../../src/elements.js';
import { CONDUCTS, ELEC, SPARK_COST, conductsInto, packSpark } from '../../src/electricity.js';
import * as C from '../../src/v2/contact.js';
import * as F from '../../src/v2/phase.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { contactPrelude, contactEntry } from './contact-prelude.mjs';
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
      const parcel=(BigInt(C.ctRow(id).capacity)*BigInt(a.tq)+BigInt(C.ctRow(id).offset))*BigInt(amount);
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
    const c=cell(e.id); if(e.id===E.SWITCH)c.life=10;
    const out=C.ctElectric(c,ns(cell(E.BATTERY)),0.999);
    assert.equal(out.spark,e.id===E.LAMP?81:packSpark(8,400-Math.trunc(SPARK_COST[e.id])),e.key);
    if(e.id!==E.LAMP)assert.equal(C.ctElectric(out,ns(),0).spark%9,7);
  }
});
test('switch off wins, powered clone controls, TSNS ignores wires, steady DC lamp sleeps',()=>{
  const p=cell(E.PSCN),n=cell(E.NSCN);p.spark=n.spark=3608;
  for(const id of [E.SWITCH,E.PCLN]) {
    const c=cell(id);assert.equal(C.ctElectric(c,ns(p),0).life,10);
    c.life=10;assert.equal(C.ctElectric(c,ns(p,n),0).life,9);
  }
  const sensor=cell(E.TSNS,100);assert.equal(C.ctElectric(sensor,ns(cell(E.METAL,500)),0).life,0);
  assert.equal(C.ctElectric(sensor,ns(cell(E.WOOD,500)),0).life,1);
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
  for(const e of ELEMENTS.filter(e=>e.blast)) {
    const c=cell(e.id,Math.min(10000,e.ignite+50));const out=C.ctStep(c,ns(),0);
    assert.equal(out.id,c.id,e.key);assert.ok(out.request&1,e.key);
  }
  const fuse=cell(E.FUSE),lit=cell(E.FUSE);lit.life=100;assert.ok(C.ctStep(fuse,ns(lit),0).life<2048);
  const dust=cell(E.DUST,500);dust.age=10;assert.ok(C.ctStep(dust,ns(cell(E.DUST)),0).request&1);
  let emitted=false;
  for(let seed=0;seed<100000;seed++)if(C.ctStep(cell(E.PLUTONIUM),ns(),seed).request&4){emitted=true;break;}
  assert.ok(emitted);assert.equal(C.ctStep(cell(E.URANIUM),ns(),0).request&4,0);
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
test('generated WGSL validates on CPU Naga with explicit shared prelude; no added storage bindings',()=>{
  assert.equal((contactWGSL.match(/var<storage/g)||[]).length,0);
  const dir=mkdtempSync(join(tmpdir(),'native-contact-'));
  try{
    const file=join(dir,'contact.wgsl');writeFileSync(file,contactPrelude+contactWGSL+contactEntry);
    const result=spawnSync('naga',[file],{encoding:'utf8'});
    if(result.error)throw result.error;
    assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
  }finally{rmSync(dir,{recursive:true,force:true});}
});
console.log(`${checks} native contact CPU groups passed; no GPU launched`);
