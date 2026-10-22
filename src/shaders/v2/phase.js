import { PHASE_ROWS, PHASE_HOT_BASE, PHASE_COLD_BASE, PHASE_STEPS, phaseOffsetUnits, PHASE_AIR_CAPACITY, phaseCapacityUnits, PHASE_UNIT_FILL, PHASE_EDGE_SLACK } from '../../v2/phase.js';
import { ELEMENTS } from '../../elements.js';
const field = (name, get) => {
  // Small scalar tables avoid switch-return fanout without adding GPU bindings.
  const values = PHASE_ROWS.map((r, i) => get(r, i));
  return `const ${name}Table = array<i32, ${values.length}>(${values.join(',')});
fn ${name}(id:u32)->i32 { if(id>=${values.length}u){return 0;} return ${name}Table[id]; }`;
};
// Requires foundation energyAdd/Sub/Signed/Mul; no bindings. vec2u is low,high.
export const phaseWGSL = /* wgsl */ `
const PHASE_HOT_BASE:u32=${PHASE_HOT_BASE}u;
const PHASE_COLD_BASE:u32=${PHASE_COLD_BASE}u;
const PHASE_STEPS:u32=${PHASE_STEPS}u;
const PHASE_EDGE_SLACK:u32=${PHASE_EDGE_SLACK}u;
${field('phaseHotQ', r => r.hotQ)}
${field('phaseColdQ', r => r.coldQ)}
${field('phaseHotLatent', r => r.hotLatent)}
${field('phaseColdLatent', r => r.coldLatent)}
${field('phaseOffsetUnits', r => r.offsetUnits)}
${field('phaseCapacityUnits', (_, i) => phaseCapacityUnits(i))}
// v2/phase.js phaseCapacity: the air carrier and ceil(amount·units / PHASE_UNIT_FILL) of the element's cap over it
const PHASE_AIR_CAPACITY:u32=${PHASE_AIR_CAPACITY}u;
const PHASE_UNIT_SHIFT:u32=${Math.log2(PHASE_UNIT_FILL)}u;
fn phaseCapacity(id:u32,amount:u32)->u32 {
 return PHASE_AIR_CAPACITY+((amount*u32(phaseCapacityUnits(id))+${PHASE_UNIT_FILL - 1}u)>>PHASE_UNIT_SHIFT);
}
fn phaseTq(id:u32,raw:u32)->u32 {
 if(raw<=41093u){return raw;}
 if(raw<PHASE_COLD_BASE){return u32(phaseHotQ(id));}
 return u32(phaseColdQ(id));
}
fn phaseLess(a:vec2u,b:vec2u)->bool {
 return bitcast<i32>(a.y)<bitcast<i32>(b.y) || (a.y==b.y && a.x<b.x);
}
fn phaseMulSmall(a:vec2u,n:u32)->vec2u {
 let low=energyMul(a.x,n); return vec2u(low.x,low.y+a.y*n);
}
// Exact unsigned long division is the fallback, never an approximate result.
fn phaseDivExact(a:vec2u,b:vec2u)->vec2u {
 var quotient=vec2u(0u); var remainder=vec2u(0u);
 if(all(b==vec2u(0u))){return quotient;}
 var top=31-i32(countLeadingZeros(a.x));
 if(a.y!=0u){top=63-i32(countLeadingZeros(a.y));}
 for(var bit=top;bit>=0;bit--){
  remainder=vec2u(remainder.x<<1u,(remainder.y<<1u)|(remainder.x>>31u));
  var incoming=0u;
  if(bit>=32){incoming=(a.y>>u32(bit-32))&1u;}else{incoming=(a.x>>u32(bit))&1u;}
  remainder.x|=incoming;
  if(!energyLess(remainder,b)){
   remainder=energySub(remainder,b);
   if(bit>=32){quotient.y|=1u<<u32(bit-32);}else{quotient.x|=1u<<u32(bit);}
  }
 }
 return quotient;
}
fn phaseDiv(a:vec2u,b:vec2u)->vec2u {
 if(all(b==vec2u(0u))){return vec2u(0u);}
 if(energyLess(a,b)){return vec2u(0u);}
 if(b.y==0u && (b.x & (b.x-1u))==0u){
  if(b.x==1u){return a;}
  let shift=firstTrailingBit(b.x);
  return vec2u((a.x>>shift)|(a.y<<(32u-shift)),a.y>>shift);
 }
 if(b.y==0u && b.x<=0x80000000u){
  // Long division retains the HIGH quotient too. For PHASE_STEPS (<=65536),
  // radix-65536 digits keep BOTH intermediate numerators <=2^32-1: each is
  // remainder*65536+digit, remainder<d<=65536. Only exact builtin / and %.
  let high=a.y/b.x; let rem=a.y%b.x;
  if(b.x<=65536u){
   let middle=(rem<<16u)|(a.x>>16u);
   let low=((middle%b.x)<<16u)|(a.x&65535u);
   return vec2u(((middle/b.x)<<16u)|(low/b.x),high);
  }
  return vec2u(energyDiv(vec2u(a.x,rem),b.x).x,high);
 }
 if(b.x==0u && (b.y & (b.y-1u))==0u){return vec2u(a.y>>firstTrailingBit(b.y),0u);}
 // phaseEncode's quotient <= PHASE_STEPS (12220). Restrict both factors:
 // b<2^48, q<=65535 => b*q<2^64, so phaseMulSmall CANNOT overflow.
 // Other domains, and any inaccurate estimate, retain exact long division.
 if(b.y<=65535u){
  let estimate=(f32(a.y)*4294967296.0+f32(a.x))/(f32(b.y)*4294967296.0+f32(b.x));
  if(estimate<65536.0){
   var q=u32(max(estimate,0.0)); var product=phaseMulSmall(b,q);
   for(var attempt=0u;attempt<4u;attempt++){
    if(energyLess(a,product)){
     if(q==0u){break;}
     q--; product=energySub(product,b);
    }else{
     if(energyLess(energySub(a,product),b)){return vec2u(q,0u);}
     if(q==65535u){break;}
     q++; product=energyAdd(product,b);
    }
   }
  }
 }
 return phaseDivExact(a,b);
}
// v2/phase.js phaseOffsetEnergy: floor(amount·offset / FULL), the whole energy a quantum and the rest a FULL
// v2/phase.js phaseOffsetEnergy: floor(amount·units / PHASE_UNIT_FILL), signed
fn phaseOffsetOf(units:i32,amount:u32)->vec2u {
 var m=energyMul(u32(abs(units)),amount);
 if(units<0){m=energyAdd(m,vec2u(${PHASE_UNIT_FILL - 1}u,0u));}
 m=vec2u((m.x>>PHASE_UNIT_SHIFT)|(m.y<<(32u-PHASE_UNIT_SHIFT)),m.y>>PHASE_UNIT_SHIFT);
 if(units<0){return energySub(vec2u(0u),m);}return m;
}
fn phaseOffsetEnergy(id:u32,amount:u32)->vec2u {
 return phaseOffsetOf(phaseOffsetUnits(id),amount);
}
${field('phaseLavaOffsetUnits', (_, i) => phaseOffsetUnits(10, i))}
fn phaseMaterialOffsetEnergy(id:u32,amount:u32,ctype:u32)->vec2u {
 if(id!=10u){return phaseOffsetEnergy(id,amount);}
 var source=ctype;if(source>=${ELEMENTS.length}u){source=3u;}
 return phaseOffsetOf(phaseLavaOffsetUnits(source),amount);
}
fn phaseLatentEnergy(id:u32,raw:u32,amount:u32)->vec2u {
 if(raw<=41093u){return vec2u(0u);}
 let hot=raw<PHASE_COLD_BASE;
 let base=select(PHASE_COLD_BASE,PHASE_HOT_BASE,hot);
 let per=select(phaseColdLatent(id),phaseHotLatent(id),hot);
 let total=energyMul(u32(per),amount);
 let magnitude=phaseDiv(phaseMulSmall(total,raw-base),vec2u(PHASE_STEPS,0u));
 if(hot){return magnitude;}return energySub(vec2u(0u),magnitude);
}
// raw=0xffffffff is not in a latent interval. y is bitcast<i32>(residual).
fn phaseEncode(id:u32,amount:u32,energy:vec2u)->vec2u {
 return phaseEncodeCapacity(id,amount,energy,phaseCapacity(id,amount),0u);
}
fn phaseEncodeCapacity(id:u32,amount:u32,energy:vec2u,capacity:u32,ctype:u32)->vec2u {
 let sensible=energySub(energy,phaseMaterialOffsetEnergy(id,amount,ctype));
 for(var side=0u;side<2u;side++){
  let hot=side==0u;
  let per=select(phaseColdLatent(id),phaseHotLatent(id),hot);
  if(per<=0){continue;}
  let latent=energyMul(u32(per),amount);
  if(all(latent==vec2u(0u))){continue;}
  let threshold=energyMul(capacity,u32(select(phaseColdQ(id),phaseHotQ(id),hot)));
  var progress=energySub(threshold,sensible);
  if(hot){progress=energySub(sensible,threshold);}
  if(phaseLess(progress,vec2u(0u)) || phaseLess(energyAdd(latent,vec2u(PHASE_EDGE_SLACK,0u)),progress)){continue;}
  // (past the end by the fills' rounding: v2/phase.js PHASE_EDGE_SLACK, on the last code)
  var onPlateau=progress;if(phaseLess(latent,progress)){onPlateau=latent;}
  let index=phaseDiv(phaseMulSmall(onPlateau,PHASE_STEPS),latent).x;
  let encoded=phaseDiv(phaseMulSmall(latent,index),vec2u(PHASE_STEPS,0u));
  var residual=energySub(encoded,progress);
  if(hot){residual=energySub(progress,encoded);}
  return vec2u(select(PHASE_COLD_BASE,PHASE_HOT_BASE,hot)+index,residual.x);
 }
 return vec2u(0xffffffffu,0u);
}
`;
