// Full physical world optical writer. No presentation bending or GI readers.
import { lib } from './gfx/lib.js';
import { shadowOpticsWGSL } from './gfx/shadowOptics.js';
import { WorldSunParams } from '../world/worldSun.js';
import { Header, tableLayout } from './common.js';
import { FrameUniforms } from './bindings.js';

export const WORLD_SUN_WORKGROUP = 8;
export function worldSunWriterLayouts() {
  const uniform = (binding, minBindingSize) => ({binding,visibility:4,buffer:{type:'uniform',minBindingSize}});
  const storage = (binding,type='read-only-storage',minBindingSize=4) => ({binding,visibility:4,buffer:{type,minBindingSize}});
  const texture = (binding,sampleType) => ({binding,visibility:4,texture:{sampleType,viewDimension:'2d-array'}});
  return [
    [storage(0,'read-only-storage',tableLayout().Tables.size),uniform(1,Header.size),uniform(2,FrameUniforms.size),uniform(3,112),storage(4)],
    [texture(0,'uint'),texture(1,'uint'),texture(2,'unfilterable-float'),texture(3,'unfilterable-float'),texture(4,'unfilterable-float'),texture(5,'uint')],
    [uniform(0,32),uniform(1,128),...[['rgba32float',2],['r32float',3]].map(([format,binding])=>({binding,visibility:4,storageTexture:{access:'write-only',format,viewDimension:'2d-array'}}))],
    [storage(1,'storage')],
  ];
}
export function worldSunWriter(g) { return /* wgsl */ `
${lib(g,{backend:'world',variant:'LIGHTING_SHADOW',far:false,aeration:false})}
${shadowOpticsWGSL({backend:'world'})}
${WorldSunParams.wgsl}
struct WorldSunJob { tile: vec4i, control: vec4u }
@group(2) @binding(0) var<uniform> WJ: WorldSunJob;
@group(2) @binding(1) var<uniform> WS: WorldSunParams;
@group(2) @binding(2) var sun0Out: texture_storage_2d_array<rgba32float,write>;
@group(2) @binding(3) var sun1Out: texture_storage_2d_array<r32float,write>;
// control: physicalSlot, explicit per-tile feedback word, epoch, reserved.
// Feedback tile status: bit0 at least one ray finished; bit1 ANY incomplete.
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= vec2u(256u))) { return; }
  worldBeginQuery();
  let u = vec3f(WS.worldToLight[0].x,WS.worldToLight[1].x,WS.worldToLight[2].x)*WS.depth.z;
  let v = vec3f(WS.worldToLight[0].y,WS.worldToLight[1].y,WS.worldToLight[2].y)*WS.depth.z;
  let sun = -vec3f(WS.worldToLight[0].z,WS.worldToLight[1].z,WS.worldToLight[2].z);
  let pixel = WJ.tile.xy*256 + vec2i(gid.xy);
  // ro lies on the EXACT depth-zero plane. shadowTexel's t is reader depth.
  let xy = (vec2f(pixel)+0.5)*WS.depth.z;
  let ro = u*xy.x + v*xy.y + sun*WS.depth.x;
  let sm = shadowTexel(ro,-sun);
  if (WJ.control.z != WA.world.w || WS.version.x != WA.world.w) { worldIncomplete = true; }
  atomicOr(&worldRequests[WJ.control.y],select(1u,3u,worldQueryIncomplete()));
  // Incomplete staging is not sampled/published, including partial tile output.
  if (worldQueryIncomplete()) { return; }
  let slot = WJ.control.x;
  let dst = vec2i(i32(slot%8u)*256,i32((slot/8u)%8u)*256)+vec2i(gid.xy);
  textureStore(sun0Out,dst,i32(slot/64u),sm);
  textureStore(sun1Out,dst,i32(slot/64u),vec4f(sm.x,0.0,0.0,0.0));
}`; }
export const WGSL_CHECK = () => [128,384].flatMap(ny=>[false,true].map(sourceAppearance=>({
  name:`worldSun.optical.${ny}.${sourceAppearance?'source':'native'}`,kind:'compute',grids:false,warm:false,
  code:()=>worldSunWriter({nx:3072,ny,nz:1024,sourceAppearance,sourceGrid:[384,16,128]}),
  layouts:worldSunWriterLayouts,workgroupSize:[8,8,1],dispatch:()=>[32,32,1],
})));
