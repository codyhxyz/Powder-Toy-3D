// CPU only. Actual production material/particle ABI, not a toy cap-only model.
import assert from 'node:assert/strict';
import { E } from '../../src/elements.js';
import { makeMaterial, withPayload, cTq, cFill, ctypeOf, energyOf, packetCapacityQ, packetOwnedEnergy, withPacketEnergy, packetEnergyFits, FULL, MAX_FILL, share } from '../../src/v2/layout.js';
import { PHASE_ROWS } from '../../src/v2/phase.js';
import { extractPacket, extractPartialPacket, depositPacket, packParticle, unpackParticle } from '../../src/v2/dynamics-reference.js';
import { quantizedBlastHeat, blastKineticRemainder, boundedBlastVelocity, BLAST_NATIVE_J_DENOMINATOR as DEN, BLAST_NATIVE_J_NUMERATOR as NUM } from '../../src/v2/externalBlast.js';
import { nativeForceCommitWGSL } from '../../src/v2/nativeForcing.js';
import { nativeWeatherParams } from '../../src/v2/nativeWeather.js';
import { KickParams } from '../../src/shaders/povKick.js';
import { nativeDynamicsHead } from '../../src/shaders/v2.js';
import { blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { gridLayout } from '../../src/sim.js';
let checks=0;
const heat=(m,dt)=>{
 const e=packetOwnedEnergy(m)+BigInt(packetCapacityQ(m.core))*BigInt(dt);
 return packetEnergyFits(m,e)?withPacketEnergy(m,e):m;
};
const lanes=(a,b)=>{
 assert.equal(a.core[0]&0xff0000ff,b.core[0]&0xff0000ff);
 assert.deepEqual([...a.core.slice(1)],[...b.core.slice(1)]);
};
for(const id of [E.OIL,E.WATER,E.MERCURY,E.LAVA,E.PLANT]) for(const fill of [1,17003,FULL,MAX_FILL]) for(const dt of [-80,80,400]) {
 let m=withPayload(makeMaterial(id,100,fill,id===E.LAVA?E.METAL:0),127);
 m.core[0]|=0x37000000;m.core[2]=0x12345678;m.core[3]|=0x5a;
 m.bank=-173;
 const after=heat(m,dt);lanes(after,m);
 assert.equal(packetOwnedEnergy(after)-packetOwnedEnergy(m),BigInt(packetCapacityQ(m.core))*BigInt(dt));
 const packed=unpackParticle(packParticle({position:[1,2,3],velocity:[4,5,6],id:7,...after}));
 assert.equal(packetOwnedEnergy(packed),packetOwnedEnergy(after));
 const {source}=extractPacket(m),dst=makeMaterial(0,-10,0);
 const deposited=depositPacket(after,dst);assert(deposited);
 assert.equal(energyOf(source)+energyOf(deposited)-energyOf(m)-energyOf(dst),packetOwnedEnergy(after)-packetOwnedEnergy(m));checks++;
}
// Three independently proved production regressions.
const oil=makeMaterial(E.OIL,100,1),cooled=heat(oil,-80);
assert.equal(cTq(oil.core),1493);assert.equal(cTq(cooled.core),1413);
assert.equal(packetOwnedEnergy(cooled)-packetOwnedEnergy(oil),-2320n);
const plant=makeMaterial(E.PLANT,20),converted={core:new Uint32Array(plant.core),bank:plant.bank};converted.core[0]=(converted.core[0]&0xffffff00)|E.SAWDUST;
assert(packetEnergyFits(converted,packetOwnedEnergy(plant)));
const sawdust=withPacketEnergy(converted,packetOwnedEnergy(plant));assert.equal(packetOwnedEnergy(sawdust),packetOwnedEnergy(plant));
assert.equal(energyOf(depositPacket(sawdust,makeMaterial(0,20,0))),energyOf(plant));
const warmPlant=heat(plant,80),warmConverted={core:new Uint32Array(converted.core),bank:converted.bank};
const warmSawdust=withPacketEnergy(warmConverted,packetOwnedEnergy(warmPlant));
assert.equal(packetOwnedEnergy(warmSawdust)-packetOwnedEnergy(plant),BigInt(packetCapacityQ(plant.core))*80n);
const invalidConversion={core:new Uint32Array(plant.core),bank:plant.bank};invalidConversion.core[0]&=0xffffff00;
assert(!packetEnergyFits(invalidConversion,packetOwnedEnergy(plant)));
for(const bank of [-2147483648,0,2147483647]) {const dry=makeMaterial(E.OIL,20,0);dry.bank=bank;assert(packetEnergyFits(dry,BigInt(bank)));assert.equal(packetOwnedEnergy(withPacketEnergy(dry,BigInt(bank))),BigInt(bank));}
// Hot/cold latent tags at partial/full/compressed fill; exact signed residuals.
for(const id of [E.WATER,E.ICE,E.STEAM,E.MERCURY]) for(const fill of [1,17003,FULL,MAX_FILL]) for(const hot of [true,false]) {
 const row=PHASE_ROWS[id],per=hot?row.hotLatent:row.coldLatent;if(!per) continue;
 const m=makeMaterial(id,0,fill),amount=id===E.WATER||id===E.MERCURY?fill:FULL;
 const threshold=makeMaterial(id,(hot?row.hotQ:row.coldQ)*0.25-273.25,fill);
 const target=packetOwnedEnergy(threshold)+(hot?1n:-1n)*BigInt(per)*BigInt(amount)/2n;
 assert(packetEnergyFits(m,target));const tagged=withPacketEnergy(m,target);
 assert(cTq(tagged.core)===(hot?row.hotQ:row.coldQ));assert.equal(packetOwnedEnergy(tagged),target);
 for(const dt of [-1,1]) assert.equal(packetOwnedEnergy(heat(tagged,dt))-target,BigInt(packetCapacityQ(tagged.core))*BigInt(dt));checks++;
}
for(const source of [E.STONE,E.METAL,E.GLASS]) {
 const m=makeMaterial(E.LAVA,1700,17003,source),after=heat(m,80);
 assert.equal(ctypeOf(after.core),source);assert.equal(packetOwnedEnergy(after)-packetOwnedEnergy(m),BigInt(packetCapacityQ(m.core))*80n);
}
for(const bank of [-2147483648,2147483647]) {
 const m=makeMaterial(E.OIL,20,1);m.bank=bank;
 assert(packetEnergyFits(m,packetOwnedEnergy(m)));assert.equal(packetOwnedEnergy(withPacketEnergy(m,packetOwnedEnergy(m))),packetOwnedEnergy(m));
}
const extreme=makeMaterial(E.OIL,10000,1);extreme.bank=2147483647;
assert(!packetEnergyFits(extreme,packetOwnedEnergy(extreme)+10000000000n));assert.equal(heat(extreme,1000000000),extreme);
// Partial extraction must conserve exactly even if packet temperature changes.
for(const id of [E.OIL,E.WATER,E.LAVA]) for(const bank of [-2147483648,-173,2147483647]) {
 const m=makeMaterial(id,100,17003,id===E.LAVA?E.METAL:0);m.bank=bank;
 const frozen={core:[...m.core],bank:m.bank},split=extractPartialPacket(m,1);
 if(split){assert.equal(energyOf(split.source)+packetOwnedEnergy(split.packet),energyOf(m));assert.equal(packetOwnedEnergy(split.packet),share(packetOwnedEnergy(m),0,1,17003));assert.equal(cFill(split.packet.core),1);}
 assert.deepEqual({core:[...m.core],bank:m.bank},frozen);
}
// Exact integer heat plus conservative f32 stored velocity, double work oracle.
const boundaries=[0,0.000001,0.01,1,4000,16777217,120000000,5e11];
for(const quantum of [1,127,65536,148512,16777215,4294967040]) for(const epsilon of [-1e-7,0,1e-7]) boundaries.push(4*quantum*DEN/NUM*(1+epsilon));
for(const received of boundaries) {
 const r=Math.fround(received),q=quantizedBlastHeat(r),heatJ=Number(q)*DEN/NUM;
 assert(heatJ<=r/4);const kinetic=blastKineticRemainder(r,q);assert(heatJ+kinetic<=r);
 const m=makeMaterial(E.OIL,20,1),target=packetOwnedEnergy(m)+q;
 const after=packetEnergyFits(m,target)?withPacketEnergy(m,target):m;
 const actual=Number(packetOwnedEnergy(after)-packetOwnedEnergy(m))*DEN/NUM;
 const budget=after===m?r:kinetic;
 for(const v of [[0,0,0],[10,-3,2],[-10,4,0],[1e8,2,-3],[-1e8,2,3]]) for(const d of [[1,0,0],[-1,0,0],[0.6,0.8,0]]) for(const mass of [0.001,0.7,27]) {
  const incoming=v.map(Math.fround),out=boundedBlastVelocity(incoming,d,budget,mass),delta=out.map((x,i)=>x-incoming[i]);
  const work=Math.fround(mass)*delta.reduce((s,x,i)=>s+incoming[i]*x+0.5*x*x,0);
  assert(work+actual<=r+Math.max(1e-10,r*1e-12),JSON.stringify({r,v,d,mass,work,actual}));checks++;
 }
}
const q=quantizedBlastHeat(4000),heated=withPacketEnergy(makeMaterial(E.OIL,20,1),packetOwnedEnergy(makeMaterial(E.OIL,20,1))+q);
assert.equal(q,148512n);assert.equal(packetOwnedEnergy(heated)-packetOwnedEnergy(makeMaterial(E.OIL,20,1)),q);
// Generated production callsites must use owned energy (grid defaults unchanged).
const g=gridLayout(16,16,16),params=nativeWeatherParams('packetTest',{params:{fields:KickParams.fields}});
const force=nativeForceCommitWGSL(g,params,'particles');
assert.match(force,/var after=forcePacketHeat/);assert.match(force,/packetEnergyFits\(after,enthalpy\)/);assert.match(force,/energySub\(packetOwnedEnergy\(after\),packetOwnedEnergy\(before\)\)/);
const blast=blastsWGSL(g,nativeDynamicsHead,'externalParticleApply');assert.match(blast,/dQuantizedBlastHeat\(received\)/);assert.match(blast,/packetEnergyFits\(before,energy\)/);assert.match(blast,/dBlastBudgetVelocity\(particle.velocity/);
assert.match(blastsWGSL(g,nativeDynamicsHead,'apply'),/withPacketEnergy\(packet,share\)/);
console.log(`${checks} packet-energy CPU checks: force heat/conversion, exact phase/ctype/bank, deposit/census, partial extraction, quantized blast heat + stored-f32 incremental KE closure passed; no GPU`);
