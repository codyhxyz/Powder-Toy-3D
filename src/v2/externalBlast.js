import { atlasDims } from '../shaders/common.js';
import { ELEMENTS } from '../elements.js';
// External sources are not voxel charges. Their immutable world-space requests
// and GPU completion words survive saves/windows; acknowledgement is not execution.
import { AIR } from './pressure.js';
import { CELL_M } from '../scale.js';
export const EXTERNAL_BLAST_CAP = 64;
const finite = n => Number.isFinite(n) && Math.abs(n) <= 1e12 && Number.isFinite(Math.fround(n));
const vector=v=>Array.isArray(v) && v.length===3 && v.every(finite);
function validBlastSelection(s,g) {
 if(s===undefined) return true;
 if(!s || ![0,1].includes(s.shape) || !vector(s.end) || !vector(s.grow) || s.grow.some(v=>v<0) ||
  !Number.isInteger(s.filter) || s.filter< -1 || s.filter>=ELEMENTS.length || typeof s.fade!=='boolean') return false;
 if(Object.hasOwn(s,'lo')!==Object.hasOwn(s,'hi')) return false;
 if(Object.hasOwn(s,'lo') && (!vector(s.lo) || !vector(s.hi) || !s.lo.every(Number.isInteger) || !s.hi.every(Number.isInteger) || s.lo.some((v,a)=>v>s.hi[a]))) return false;
 if(Object.hasOwn(s,'maskWords')!==Object.hasOwn(s,'maskOrigin')) return false;
 if(Object.hasOwn(s,'maskWords')) {
  if(!(s.maskWords instanceof Uint32Array) || !vector(s.maskOrigin) || !s.maskOrigin.every(Number.isInteger)) return false;
  if(g) {const a=atlasDims(g);if(s.maskWords.length!==Math.ceil(a.width*a.height/4)) return false;}
 }
 return true;
}
export const cloneExternalBlast=r=>({...r,position:[...r.position],...(r.selection?{selection:{...r.selection,end:[...r.selection.end],grow:[...r.selection.grow],...(r.selection.lo?{lo:[...r.selection.lo],hi:[...r.selection.hi]}:{}),...(r.selection.maskWords?{maskWords:new Uint32Array(r.selection.maskWords),maskOrigin:[...r.selection.maskOrigin]}:{})}}:{})});
export function validExternalBlast(r,g) {
  return r && Array.isArray(r.position) && r.position.length === 3 && r.position.every(finite) &&
    finite(r.energy) && r.energy > 0 && finite(r.radius) && r.radius >= 0 && validBlastSelection(r.selection,g);
}
export function validateExternalBlasts(s,g) {
  g??=Array.isArray(s.dims)?{nx:s.dims[0],ny:s.dims[1],nz:s.dims[2]}:null;
  if (Object.hasOwn(s, 'externalBlasts') !== Object.hasOwn(s, 'externalBlastDone')) throw new Error('Incomplete external blast queue');
  const requests = Object.hasOwn(s, 'externalBlasts') ? s.externalBlasts : [], done = Object.hasOwn(s, 'externalBlastDone') ? s.externalBlastDone : new Uint32Array(EXTERNAL_BLAST_CAP);
  if (!Array.isArray(requests) || !(done instanceof Uint32Array) || done.length !== EXTERNAL_BLAST_CAP) throw new Error('Invalid external blast queue');
  const slots = new Set(), ids = new Set();
  for (const r of requests) {
    if (!validExternalBlast(r,g) || !Number.isInteger(r.slot) || r.slot < 0 || r.slot >= EXTERNAL_BLAST_CAP || slots.has(r.slot) ||
      !Number.isInteger(r.requestId) || r.requestId < 1 || r.requestId > s.sequence || ids.has(r.requestId)) throw new Error('Invalid external blast request');
    slots.add(r.slot); ids.add(r.requestId);
  }
  for (let i = 0; i < done.length; i++) if (done[i] > 1 || (done[i] && !slots.has(i))) throw new Error('Unowned external blast completion');
  return { requests: new Map(requests.map(r => [r.slot, cloneExternalBlast(r)])), done };
}
// External sources have no chemical product: half J to bounded damage/KE and
// half J to acoustic compression. Unlike voxel charges there is no fabricated FIRE/TNT.
export const externalBlastPressure = (pressure, energy) => Math.sqrt(pressure ** 2 + AIR.rho * AIR.sound ** 2 * energy / AIR.edge ** 3);
export function externalBlastBudget(energy, received) {
  const sum = received.reduce((a, b) => a + b, 0), scale = Math.min(1, energy * 0.5 / Math.max(sum, 1e-6));
  return received.map(e => e * scale);
}

// Exact f32 share -> native heat quanta. Integer division cannot round heat
// above its quarter-share. Keep the existing bounded one-word heat grant.
export const BLAST_NATIVE_J_DENOMINATOR = Math.round(1000 * CELL_M ** 3 * 4184);
export const BLAST_NATIVE_J_NUMERATOR = 16777216;
const floatBits = new DataView(new ArrayBuffer(4));
const bitsOf = x => { floatBits.setFloat32(0,x,true); return floatBits.getUint32(0,true); };
const fromBits = x => { floatBits.setUint32(0,x,true); return floatBits.getFloat32(0,true); };
export function quantizedBlastHeat(received) {
  received=Math.fround(received);if(!(received>0)) return 0n;
  const bits=bitsOf(received),exponent=(bits>>>23)&255;
  let numerator=BigInt((bits&0x7fffff)|(exponent?0x800000:0))*BigInt(BLAST_NATIVE_J_NUMERATOR);
  const shift=exponent?exponent-150:-149;
  numerator=shift>=0?numerator<<BigInt(shift):numerator>>BigInt(-shift);
  const heat=numerator/BigInt(4*BLAST_NATIVE_J_DENOMINATOR);
  return heat>4294967040n?4294967040n:heat;
}
export function blastKineticRemainder(received,heat) {
  if(heat===0n) return Math.fround(received);
  const f=Math.fround;
  const paid=fromBits(bitsOf(f(f(f(Number(heat))*BLAST_NATIVE_J_DENOMINATOR)/BLAST_NATIVE_J_NUMERATOR))+2);
  const remainder=Math.fround(Math.fround(received)-paid);
  return remainder>0?fromBits(bitsOf(remainder)-1):0;
}
// Stored-f32 twin, with a higher precision incremental-work oracle in tests.
export function boundedBlastVelocity(velocity,direction,budget,mass) {
  const f=Math.fround,v=velocity.map(f),d=direction.map(f);mass=f(mass);budget=f(budget);
  const sum=x=>f(f(x[0]+x[1])+x[2]);
  const along=sum(v.map((x,i)=>f(x*d[i])));
  const kick=f(f(Math.sqrt(f(f(along*along)+f(f(2*budget)/Math.max(mass,1e-6)))))-along);
  let after=v.map((x,i)=>f(x+f(d[i]*kick)));
  const fits=a=>{
    const delta=a.map((x,i)=>f(x-v[i])),work=delta.map((x,i)=>f(x*v[i])),square=delta.map(x=>f(f(x*x)*0.5));
    const magnitude=sum(work.map((x,i)=>f(Math.abs(x)+square[i])));
    return f(mass*f(sum(work.map((x,i)=>f(x+square[i])))+f(magnitude*0.000002)))<=budget;
  };
  if(budget<=0) return v;
  if(fits(after)) return after;
  after=after.map((x,i)=>f(v[i]+f(f(x-v[i])*0.99999)));
  return fits(after)?after:v;
}
export const blastHeatBudgetWGSL = `
fn dQuantizedBlastHeat(received:f32)->vec2u {
 if(received<=0.0){return vec2u(0u);}
 // Above this conservative threshold the bounded heat grant always fits.
 if(received>=120000000.0){return vec2u(4294967040u,0u);}
 let bits=bitcast<u32>(received);let exponent=(bits>>23u)&255u;
 let mantissa=(bits&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
 var numerator=energyMul(mantissa,${BLAST_NATIVE_J_NUMERATOR}u);
 let shift=select(-149,i32(exponent)-150,exponent!=0u);
 if(shift>0){let n=u32(shift);numerator=vec2u(numerator.x<<n,(numerator.y<<n)|(numerator.x>>(32u-n)));}
 else if(shift<0) {let n=u32(-shift);if(n>=64u){numerator=vec2u(0u);}else if(n>=32u){numerator=vec2u(numerator.y>>(n-32u),0u);}else{numerator=vec2u((numerator.x>>n)|(numerator.y<<(32u-n)),numerator.y>>n);}}
 let heat=phaseDiv(numerator,vec2u(${4*BLAST_NATIVE_J_DENOMINATOR}u,0u));
 if(heat.y!=0u){return vec2u(4294967040u,0u);}return vec2u(min(heat.x,4294967040u),0u);
}
fn dBlastKineticRemainder(received:f32,heat:vec2u)->f32 {
 if(heat.x==0u){return received;}
 // u32->f32 and the product each round once; the power-of-two division
 // is exact. Two upward ulps cover both errors, then round KE downward.
 let paid=bitcast<f32>(bitcast<u32>(f32(heat.x)*${BLAST_NATIVE_J_DENOMINATOR}.0/${BLAST_NATIVE_J_NUMERATOR}.0)+2u);
 let remainder=received-paid;if(remainder<=0.0){return 0.0;}
 return bitcast<f32>(bitcast<u32>(remainder)-1u);
}
fn dBlastVelocityFits(before:vec3f,after:vec3f,budget:f32,mass:f32)->bool {
 let delta=after-before;let work=before*delta;let square=delta*delta*0.5;
 // Incremental work avoids cancellation of two huge absolute kinetic energies.
 // Bound f32 rounding in the subtractions/products/sums conservatively.
 let magnitude=dot(abs(work)+square,vec3f(1.0));
 let upper=mass*(dot(work+square,vec3f(1.0))+magnitude*0.000002);
 return upper<=budget;
}
fn dBlastBudgetVelocity(before:vec3f,direction:vec3f,budget:f32,mass:f32)->vec3f {
 var after=dBudgetVelocity(before,direction,budget,mass);
 if(dBlastVelocityFits(before,after,budget,mass)){return after;}
 after=before+(after-before)*0.99999;
 if(dBlastVelocityFits(before,after,budget,mass)){return after;}return before;
}
`;

// CPU numerical specification of the shader's energy-funded radial impulse.
export function externalBlastVelocity(velocity,direction,energy,mass) {
  if(energy<=0) return [...velocity];
  const along=velocity.reduce((n,v,a)=>n+v*direction[a],0);
  const delta=Math.sqrt(along*along+2*energy/Math.max(mass,1e-6))-along;
  return velocity.map((v,a)=>v+direction[a]*delta);
}
