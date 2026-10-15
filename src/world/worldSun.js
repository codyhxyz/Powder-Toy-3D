// Shared phase-4 writer / reader ABI. No scheduler or lighting producer here.
import { hostStruct } from '../shaders/hostStruct.js';
export const WORLD_SUN_PITCH = 0.416531224;
export const WORLD_SUN_TILE = 256;
export const WORLD_SUN_SIDE = 2048;
export const WORLD_SUN_BOOK_WORDS = 8;
export const WorldSunParams = hostStruct('WorldSunParams', {
  worldToLight: 'mat4x4f', depth: 'vec4f', tiles: 'vec4i', physical: 'vec4u', version: 'vec4u',
}, { space: 'uniform' });
const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm = a => { const l=Math.hypot(...a); if (!Number.isFinite(l)||l===0) throw new RangeError('sun direction'); return a.map(v=>v/l); };
// Pole-safe, camera/origin-independent orthonormal basis. +depth is away from sun.
export function worldSunBasis(direction) {
  const sun=norm(direction), u=norm(cross(Math.abs(sun[1])<.999 ? [0,1,0] : [0,0,1],sun));
  return { sun, u, v: cross(sun,u) };
}
export function worldSunProjection(worldSize, direction) {
  const {sun,u,v}=worldSunBasis(direction), inv=1/WORLD_SUN_PITCH;
  const corners=Array.from({length:8},(_,k)=>worldSize.map((n,i)=>(k>>i)&1 ? n : 0));
  const ds=corners.map(p=>dot(p,sun)), depthHi=Math.max(...ds)+1, depthLo=Math.min(...ds)-1;
  const xy=corners.map(p=>[dot(p,u)*inv,dot(p,v)*inv]);
  const min=[0,1].map(i=>Math.floor(Math.min(...xy.map(p=>p[i]))/256));
  const max=[0,1].map(i=>Math.floor(Math.max(...xy.map(p=>p[i]))/256));
  return { basis:{sun,u,v}, worldToLight:[u[0]*inv,v[0]*inv,-sun[0],0,u[1]*inv,v[1]*inv,-sun[1],0,u[2]*inv,v[2]*inv,-sun[2],0,0,0,depthHi,1],
    depth:[depthHi,depthLo,WORLD_SUN_PITCH,inv], tiles:[...min,max[0]-min[0]+1,max[1]-min[1]+1] };
}
export function worldSunTile(pixel, virtual, physicalLayers) {
  const tile=pixel.map(n=>Math.floor(n/256)), local=pixel.map((n,i)=>n-tile[i]*256);
  const b=tile.map((v,i)=>v-virtual[i]);
  const index=b[0]<0||b[1]<0||b[0]>=virtual[2]||b[1]>=virtual[3] ? -1 : b[0]+virtual[2]*b[1];
  return { tile,local,index,capacity:64*physicalLayers };
}
export function worldSunSlot(slot, local) { return [(slot%8)*256+local[0],(Math.floor(slot/8)%8)*256+local[1],Math.floor(slot/64)]; }
export const worldSunFeedbackWords = virtual => Math.ceil(virtual[2]*virtual[3]/32);
// CPU address/validity mirror for producer tests and feedback diagnostics.
// dependencySetID/version are immutable publication provenance, not page IDs.
export function worldSunResolve(pixel, params, book, epoch) {
  const a=worldSunTile(pixel,params.tiles,params.physical[3]);
  const invalid=params.version[0]!==epoch || params.version[2]===0 || params.tiles[2]<=0 || params.tiles[3]<=0 ||
    params.physical.slice(0,3).some((n,i)=>n!==[256,8,64][i]) || params.physical[3]===0 || Math.abs(params.depth[2]-WORLD_SUN_PITCH)>1e-7;
  if(a.index<0)return {outside:true,incomplete:invalid};
  const at=a.index*8, slot=book[at];
  const incomplete=invalid || book[at+1]!==params.version[0] || book[at+2]!==params.version[1] ||
    book[at+3]!==params.version[2] || !(book[at+6]&1) || slot>=a.capacity;
  return {outside:false,incomplete,index:a.index,address:incomplete?null:worldSunSlot(slot,a.local)};
}
