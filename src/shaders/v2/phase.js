import { PHASE_ROWS, PHASE_HOT_BASE, PHASE_COLD_BASE, PHASE_STEPS } from '../../v2/phase.js';
import { ELEMENTS } from '../../elements.js';
const field = (name, get) => `fn ${name}(id:u32)->i32 { switch id { ${PHASE_ROWS.map((r, i) => `case ${i}u: { return ${get(r, i)}; }`).join('\n')} default: { return 0; } } }`;
// Requires foundation energyAdd/Sub/Signed/Mul; no bindings. vec2u is low,high.
export const phaseWGSL = /* wgsl */ `
const PHASE_HOT_BASE:u32=${PHASE_HOT_BASE}u;
const PHASE_COLD_BASE:u32=${PHASE_COLD_BASE}u;
const PHASE_STEPS:u32=${PHASE_STEPS}u;
${field('phaseHotQ', r => r.hotQ)}
${field('phaseColdQ', r => r.coldQ)}
${field('phaseHotLatent', r => r.hotLatent)}
${field('phaseColdLatent', r => r.coldLatent)}
${field('phaseOffsetPerQuantum', r => r.offset)}
${field('phaseCapacityPerQuantum', (_, i) => Math.max(1, Math.round(ELEMENTS[i].cap * 64)))}
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
// Exact unsigned division, only used while banking a latent transition. No
// f32 intermediate: compressed liquids have more than 2^32 latent units.
fn phaseDiv(a:vec2u,b:vec2u)->vec2u {
 var quotient=vec2u(0u); var remainder=vec2u(0u);
 if(all(b==vec2u(0u))){return quotient;}
 for(var bit=63;bit>=0;bit--){
  remainder=vec2u(remainder.x<<1u,(remainder.y<<1u)|(remainder.x>>31u));
  var incoming=0u;
  if(bit>=32){incoming=(a.y>>u32(bit-32))&1u;}else{incoming=(a.x>>u32(bit))&1u;}
  remainder.x|=incoming;
  if(!phaseLess(remainder,b)){
   remainder=energySub(remainder,b);
   if(bit>=32){quotient.y|=1u<<u32(bit-32);}else{quotient.x|=1u<<u32(bit);}
  }
 }
 return quotient;
}
fn phaseOffsetEnergy(id:u32,amount:u32)->vec2u {
 let offset=phaseOffsetPerQuantum(id); let magnitude=energyMul(u32(abs(offset)),amount);
 if(offset<0){return energySub(vec2u(0u),magnitude);}return magnitude;
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
 let capacity=65536u+amount*u32(phaseCapacityPerQuantum(id));
 let sensible=energySub(energy,phaseOffsetEnergy(id,amount));
 for(var side=0u;side<2u;side++){
  let hot=side==0u;
  let per=select(phaseColdLatent(id),phaseHotLatent(id),hot);
  if(per<=0){continue;}
  let latent=energyMul(u32(per),amount);
  if(all(latent==vec2u(0u))){continue;}
  let threshold=energyMul(capacity,u32(select(phaseColdQ(id),phaseHotQ(id),hot)));
  var progress=energySub(threshold,sensible);
  if(hot){progress=energySub(sensible,threshold);}
  if(phaseLess(progress,vec2u(0u)) || phaseLess(latent,progress)){continue;}
  let index=phaseDiv(phaseMulSmall(progress,PHASE_STEPS),latent).x;
  let encoded=phaseDiv(phaseMulSmall(latent,index),vec2u(PHASE_STEPS,0u));
  var residual=energySub(encoded,progress);
  if(hot){residual=energySub(progress,encoded);}
  return vec2u(select(PHASE_COLD_BASE,PHASE_HOT_BASE,hot)+index,residual.x);
 }
 return vec2u(0xffffffffu,0u);
}
`;
