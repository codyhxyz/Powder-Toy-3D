import { PHASE_ROWS, PHASE_HOT_BASE, PHASE_COLD_BASE, PHASE_STEPS, phaseOffsetPerQuantum } from '../../v2/phase.js';
import { ELEMENTS } from '../../elements.js';
const field = (name, get) => {
  // Small scalar tables avoid switch-return fanout without adding GPU bindings. One exit, no branch:
  // these inline at every energy read, and early returns there are what make Metal's cold compile slow
  // (docs/webgpu.md B5); past the table it is 0, as before.
  const values = PHASE_ROWS.map((r, i) => get(r, i));
  return `const ${name}Table = array<i32, ${values.length}>(${values.join(',')});
fn ${name}(id:u32)->i32 { return select(0,${name}Table[min(id,${values.length - 1}u)],id<${values.length}u); }`;
};
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
// (the helpers below have one exit each, and pick with select where both sides are cheap: they inline
// at every energy read, and their early returns made the big kernels slow to compile cold, B5)
fn phaseTq(id:u32,raw:u32)->u32 {
 return select(u32(select(phaseColdQ(id),phaseHotQ(id),raw<PHASE_COLD_BASE)),raw,raw<=41093u);
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
 var top=31-i32(countLeadingZeros(a.x));
 if(a.y!=0u){top=63-i32(countLeadingZeros(a.y));}
 if(all(b==vec2u(0u))){top=-1;} // (a zero divisor: no bits, quotient 0)
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
 var out=vec2u(0u); var done=true;
 if(all(b==vec2u(0u)) || energyLess(a,b)){
 }else if(b.y==0u && (b.x & (b.x-1u))==0u){
  // (b.x==1: a itself; the shift's 32-bit term is then unused)
  let shift=firstTrailingBit(b.x);
  out=select(vec2u((a.x>>shift)|(a.y<<(32u-shift)),a.y>>shift),a,b.x==1u);
 }else if(b.y==0u && b.x<=0x80000000u){
  // Long division retains the HIGH quotient too. For PHASE_STEPS (<=65536),
  // radix-65536 digits keep BOTH intermediate numerators <=2^32-1: each is
  // remainder*65536+digit, remainder<d<=65536. Only exact builtin / and %.
  let high=a.y/b.x; let rem=a.y%b.x;
  if(b.x<=65536u){
   let middle=(rem<<16u)|(a.x>>16u);
   let low=((middle%b.x)<<16u)|(a.x&65535u);
   out=vec2u(((middle/b.x)<<16u)|(low/b.x),high);
  }else{ out=vec2u(energyDiv(vec2u(a.x,rem),b.x).x,high); }
 }else if(b.x==0u && (b.y & (b.y-1u))==0u){ out=vec2u(a.y>>firstTrailingBit(b.y),0u);
 }else{
  done=false;
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
      if(energyLess(energySub(a,product),b)){out=vec2u(q,0u); done=true; break;}
      if(q==65535u){break;}
      q++; product=energyAdd(product,b);
     }
    }
   }
  }
 }
 if(!done){out=phaseDivExact(a,b);}
 return out;
}
fn phaseOffsetEnergy(id:u32,amount:u32)->vec2u {
 let offset=phaseOffsetPerQuantum(id); let magnitude=energyMul(u32(abs(offset)),amount);
 return select(magnitude,energySub(vec2u(0u),magnitude),offset<0);
}
${field('phaseLavaOffsetPerQuantum', (_, i) => phaseOffsetPerQuantum(10, i))}
// (lava's by the element it melted from, every other element's its own: phaseOffsetEnergy's rule)
fn phaseMaterialOffsetEnergy(id:u32,amount:u32,ctype:u32)->vec2u {
 var source=ctype;if(source>=${ELEMENTS.length}u){source=3u;}
 let offset=select(phaseOffsetPerQuantum(id),phaseLavaOffsetPerQuantum(source),id==10u);
 let magnitude=energyMul(u32(abs(offset)),amount);
 return select(magnitude,energySub(vec2u(0u),magnitude),offset<0);
}
// (none outside a latent interval: raw-base wraps there, and the select drops what it made)
fn phaseLatentEnergy(id:u32,raw:u32,amount:u32)->vec2u {
 let hot=raw<PHASE_COLD_BASE;
 let base=select(PHASE_COLD_BASE,PHASE_HOT_BASE,hot);
 let per=select(phaseColdLatent(id),phaseHotLatent(id),hot);
 let total=energyMul(u32(per),amount);
 let magnitude=phaseDiv(phaseMulSmall(total,raw-base),vec2u(PHASE_STEPS,0u));
 return select(select(energySub(vec2u(0u),magnitude),magnitude,hot),vec2u(0u),raw<=41093u);
}
// raw=0xffffffff is not in a latent interval. y is bitcast<i32>(residual).
fn phaseEncode(id:u32,amount:u32,energy:vec2u)->vec2u {
 return phaseEncodeCapacity(id,amount,energy,65536u+amount*u32(phaseCapacityPerQuantum(id)),0u);
}
// The first side (hot, then cold) whose latent interval holds the energy, then its encoding: the
// divisions once, after the side is found, not once a side (cold compile, B5).
fn phaseEncodeCapacity(id:u32,amount:u32,energy:vec2u,capacity:u32,ctype:u32)->vec2u {
 let sensible=energySub(energy,phaseMaterialOffsetEnergy(id,amount,ctype));
 var found=false; var hot=false; var latent=vec2u(0u); var progress=vec2u(0u);
 for(var side=0u;side<2u;side++){
  let h=side==0u;
  let per=select(phaseColdLatent(id),phaseHotLatent(id),h);
  let l=energyMul(u32(max(per,0)),amount);
  let threshold=energyMul(capacity,u32(select(phaseColdQ(id),phaseHotQ(id),h)));
  let p=select(energySub(threshold,sensible),energySub(sensible,threshold),h);
  if(!found && per>0 && !all(l==vec2u(0u)) && !phaseLess(p,vec2u(0u)) && !phaseLess(l,p)){found=true; hot=h; latent=l; progress=p;}
 }
 var out=vec2u(0xffffffffu,0u);
 if(found){
  let index=phaseDiv(phaseMulSmall(progress,PHASE_STEPS),latent).x;
  let encoded=phaseDiv(phaseMulSmall(latent,index),vec2u(PHASE_STEPS,0u));
  let residual=select(energySub(encoded,progress),energySub(progress,encoded),hot);
  out=vec2u(select(PHASE_COLD_BASE,PHASE_HOT_BASE,hot)+index,residual.x);
 }
 return out;
}
`;
