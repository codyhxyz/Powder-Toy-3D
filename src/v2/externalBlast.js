import { atlasDims } from '../shaders/common.js';
import { ELEMENTS } from '../elements.js';
// External sources are not voxel charges. Their immutable world-space requests
// and GPU completion words survive saves/windows; acknowledgement is not execution.
import { AIR } from './pressure.js';
export const EXTERNAL_BLAST_CAP = 64;
const finite = n => Number.isFinite(n) && Math.abs(n) <= 1e12 && Number.isFinite(Math.fround(n));
const vector=v=>Array.isArray(v) && v.length===3 && v.every(finite);
export function validBlastSelection(s,g) {
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

// CPU numerical specification of the shader's energy-funded radial impulse.
export function externalBlastVelocity(velocity,direction,energy,mass) {
  if(energy<=0) return [...velocity];
  const along=velocity.reduce((n,v,a)=>n+v*direction[a],0);
  const delta=Math.sqrt(along*along+2*energy/Math.max(mass,1e-6))-along;
  return velocity.map((v,a)=>v+direction[a]*delta);
}
