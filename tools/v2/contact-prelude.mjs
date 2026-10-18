// Explicit shared-foundation ABI fixture for CPU Naga validation. This is NOT
// a GPU launcher or replacement for integration tests with the real driver.
import { fallWGSL } from '../../src/shaders/v2/fall.js';
import { phaseWGSL } from '../../src/shaders/v2/phase.js';
import { nativeStateWGSL } from '../../src/shaders/v2/state.js';
import { ELEMENTS, K } from '../../src/elements.js';
// Use the actual arithmetic ABI, including fast division dependencies.
const arithmetic = nativeStateWGSL.slice(nativeStateWGSL.indexOf('fn energyAdd('), nativeStateWGSL.indexOf('fn energyOf('));
export const contactPrelude = /* wgsl */ `
struct Material {core:vec4u,bank:i32}
struct Params {tick:u32,ambient:f32,ambientHeat:u32,edge:u32}
@group(0) @binding(0) var<uniform> P:Params;
@group(0) @binding(1) var<storage,read_write> result:array<vec4u>;
@group(2) @binding(2) var<storage,read> EV:array<vec4u>;
@group(2) @binding(6) var<storage,read_write> events:array<u32>;
@group(2) @binding(5) var<storage,read_write> liquidScratch:array<vec4u>;
fn slotOf(p:vec3i)->u32{return u32(p.x+32*p.y+1024*p.z);}
fn inGrid(p:vec3i)->bool{return all(p>=vec3i(0))&&all(p<vec3i(32));}
fn markBusy(p:vec3i){}
fn noteEnergySource(p:vec3i,energy:vec2u){}
fn noteEnergySink(p:vec3i,energy:vec2u){}
${fallWGSL}
${arithmetic}
${phaseWGSL}
fn fixtureLiquid(id:u32)->bool{return ${ELEMENTS.filter(e=>e.kind===K.LIQUID).map(e=>`id==${e.id}u`).join(' || ')};}
fn fixtureAmount(c:vec4u)->u32{let id=c.x&255u;if(id==0u){return 0u;}if(fixtureLiquid(id)){return c.y&0xffffffu;}return 65536u;}
fn payloadOf(c:vec4u)->u32{if(fixtureLiquid(c.x&255u)){return c.w>>16u;}return c.y&65535u;}
fn lifeOf(c:vec4u)->f32{return f32(payloadOf(c))/select(2048.0,256.0,(c.x&255u)==63u);}
fn withLife(c:vec4u,value:f32)->vec4u{var out=c;let payload=u32(round(value*select(2048.0,256.0,(c.x&255u)==63u)));if(fixtureLiquid(c.x&255u)){out.w=(c.w&65535u)|(payload<<16u);}else{out.y=(c.y&0xffff0000u)|payload;}return out;}
fn fixtureCtype(c:vec4u)->u32{if(fixtureLiquid(c.x&255u)){return c.y>>24u;}return (c.y>>16u)&255u;}
fn capacityQ(c:vec4u)->u32{return 65536u+fixtureAmount(c)*u32(phaseCapacityPerQuantum(c.x&255u));}
fn energyOf(m:Material)->vec2u {
 let id=m.core.x&255u;let raw=(m.core.x>>8u)&65535u;let amount=fixtureAmount(m.core);
 return energyAdd(energyAdd(energyMul(capacityQ(m.core),phaseTq(id,raw)),phaseMaterialOffsetEnergy(id,amount,fixtureCtype(m.core))),energyAdd(phaseLatentEnergy(id,raw,amount),energySigned(m.bank)));
}
fn energyFits(input:Material,energy:vec2u)->bool {
 let id=input.core.x&255u;let amount=fixtureAmount(input.core);
 let phase=phaseEncode(id,amount,energy);if(phase.x!=0xffffffffu){return true;}
 let sensible=energySub(energy,phaseMaterialOffsetEnergy(id,amount,fixtureCtype(input.core)));
 var tq=0u;if(!phaseLess(sensible,vec2u(0u))){tq=min(41093u,phaseDiv(sensible,vec2u(capacityQ(input.core),0u)).x);}
 let bank=energySub(sensible,energyMul(capacityQ(input.core),tq));
 return (bank.y==0u && bank.x<=0x7fffffffu) || (bank.y==0xffffffffu && bank.x>=0x80000000u);
}
fn withEnergy(input:Material,energy:vec2u)->Material {
 var m=input;let id=m.core.x&255u;let amount=fixtureAmount(m.core);
 let phase=phaseEncode(id,amount,energy);
 if(phase.x!=0xffffffffu){m.core.x=(m.core.x&0xff0000ffu)|(phase.x<<8u);m.bank=bitcast<i32>(phase.y);return m;}
 let sensible=energySub(energy,phaseMaterialOffsetEnergy(id,amount,fixtureCtype(input.core)));
 var tq=0u;if(!phaseLess(sensible,vec2u(0u))){tq=min(41093u,phaseDiv(sensible,vec2u(capacityQ(m.core),0u)).x);}
 m.core.x=(m.core.x&0xff0000ffu)|(tq<<8u);m.bank=bitcast<i32>(energySub(sensible,energyMul(capacityQ(m.core),tq)).x);return m;
}
`;
export const contactEntry = /* wgsl */ `
@compute @workgroup_size(1) fn main(){
 var cores:array<vec4u,8>;var banks:array<i32,8>;var requests:array<u32,8>;var positions:array<vec3i,8>;
 for(var i=0u;i<8u;i++){cores[i]=result[i];banks[i]=0;positions[i]=vec3i(i32(i&1u),i32((i>>1u)&1u),i32((i>>2u)&1u));}
 contactBlock(&cores,&banks,positions,&requests);
 for(var i=0u;i<8u;i++){result[i]=cores[i];}
}
`;
