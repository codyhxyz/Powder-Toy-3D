// Compact native fragment leaf. Only its three storage names are injected by
// the actual Three builder; texture/uniform arguments stay parameterized.
import { LIGHT_RECORDS, READY, WORLD_ATLAS_ABI } from '../world/renderAtlas.js';
import { WORLD_SUN_PITCH } from '../world/worldSun.js';
export function worldMeshLightWGSL(shared, buffers={book:'wmlBook',sunBook:'wmlSunBook',requests:'wmlRequests'}) { return /* wgsl */ `
${shared}
fn wmlIndex(b: vec3u, dims: vec3u) -> u32 { return b.x+dims.x*(b.y+dims.y*b.z); }
fn wmlAddress(i: u32, dims: vec2u) -> vec3i { return vec3i(vec3u(i%dims.x,(i/dims.x)%dims.y,i/(dims.x*dims.y))); }
fn wmlMiss(feedback: vec4u, index: u32, ready: u32) {
  atomicOr(&${buffers.requests}[feedback.y],1u);
  for(var plane=0u;plane<6u;plane++) { if((ready&(1u<<plane))!=0u) { atomicOr(&${buffers.requests}[plane*feedback.x+(index>>5u)],1u<<(index&31u)); } }
}
fn wmlMeta(aux: texture_2d_array<u32>, light: vec4u, geometry: vec4u, id: u32, record: u32) -> vec4u {
  let a=wmlAddress(light.x+id*${LIGHT_RECORDS}u+record,geometry.xy);return textureLoad(aux,a.xy,a.z,0);
}
fn wmlProbeLoad(t: texture_2d_array<f32>, brick: vec3i, ready: u32,aux: texture_2d_array<u32>,
  world: vec4u, light: vec4u, geometry: vec4u, feedback: vec4u) -> vec4f {
  let b=vec3u(clamp(brick,vec3i(0),vec3i(world.xyz)-1));let i=wmlIndex(b,world.xyz);let e=${buffers.book}[i];
  if(e==0u||e>light.y||feedback.w!=${WORLD_ATLAS_ABI}u) { wmlMiss(feedback,i,ready);return vec4f(0); }
  let id=e-1u;let m=wmlMeta(aux,light,geometry,id,0u);let publication=wmlMeta(aux,light,geometry,id,3u);
  if(m.y!=world.w||publication.z!=${WORLD_ATLAS_ABI}u||publication.w==0u||publication.w>light.w) { wmlMiss(feedback,i,ready);return vec4f(0); }
  if((m.x&ready)!=ready) { wmlMiss(feedback,i,ready&~m.x);return vec4f(0); }
  let refs=wmlMeta(aux,light,geometry,id,1u);let probe=select(refs.x,refs.y,ready==${READY.GLOW}u);
  if(probe==0u||probe>light.z) { wmlMiss(feedback,i,ready);return vec4f(0); }
  let a=wmlAddress(probe-1u,geometry.zw);return textureLoad(t,a.xy,a.z,0);
}
fn wmlProbe(t: texture_2d_array<f32>, p: vec3f, ready: u32,aux: texture_2d_array<u32>,
  world: vec4u, light: vec4u, geometry: vec4u, feedback: vec4u) -> vec4f {
  let q=clamp(p/4.0-0.5,vec3f(0),vec3f(world.xyz)-1.0);let base=vec3i(floor(q));let f=fract(q);var value=vec4f(0);
  for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    let w=select(1.0-f,f,vec3i(x,y,z)==vec3i(1));
    value+=wmlProbeLoad(t,base+vec3i(x,y,z),ready,aux,world,light,geometry,feedback)*w.x*w.y*w.z;
  }}}return value;
}
fn wmlSunTap(pixel: vec2i, sm: texture_2d_array<f32>,world: vec4u, feedback: vec4u, depth: vec4f, tiles: vec4i, physical: vec4u, version: vec4u) -> vec4f {
  if(version.x!=world.w||version.z==0u||any(tiles.zw<=vec2i(0))||any(physical.xyz!=vec3u(256u,8u,64u))||physical.w==0u||
    abs(depth.z-${WORLD_SUN_PITCH})>1e-7||any(textureDimensions(sm,0)!=vec2u(2048u))||textureNumLayers(sm)!=physical.w) {
    atomicOr(&${buffers.requests}[feedback.y],1u);return vec4f(1e5,1e5,1e5,0);
  }
  let tile=vec2i(floor(vec2f(pixel)/256.0));let b=tile-tiles.xy;
  if(any(b<vec2i(0))||any(b>=tiles.zw)){return vec4f(1e5,1e5,1e5,0);}
  let i=u32(b.x+tiles.z*b.y);let at=i*8u;let slot=${buffers.sunBook}[at];
  if(${buffers.sunBook}[at+1u]!=version.x||${buffers.sunBook}[at+2u]!=version.y||${buffers.sunBook}[at+3u]!=version.z||(${buffers.sunBook}[at+6u]&1u)==0u||slot>=64u*physical.w){
    atomicOr(&${buffers.requests}[feedback.y],1u);atomicOr(&${buffers.requests}[version.w+(i>>5u)],1u<<(i&31u));return vec4f(1e5,1e5,1e5,0);
  }
  let local=pixel-tile*256;let a=vec3i(i32(slot%8u)*256+local.x,i32((slot/8u)%8u)*256+local.y,i32(slot/64u));return textureLoad(sm,a.xy,a.z,0);
}
`; }
export const worldMeshAmbientWGSL = /* wgsl */ `
fn wmlAmbient(p: vec3f,q: vec3f,n: vec3f,gi0: texture_2d_array<f32>,gi1: texture_2d_array<f32>,gi2: texture_2d_array<f32>,gi3: texture_2d_array<f32>,glow: texture_2d_array<f32>,
  aux: texture_2d_array<u32>,world: vec4u,light: vec4u,geometry: vec4u,feedback: vec4u,
  wand: texture_2d<f32>,wandCount: f32,sunCol: vec4f,cave: vec4f) -> vec3f {
  let c0=wmlProbe(gi0,q,16u,aux,world,light,geometry,feedback);
  let cx=wmlProbe(gi1,q,16u,aux,world,light,geometry,feedback);
  let cy=wmlProbe(gi2,q,16u,aux,world,light,geometry,feedback);
  let cz=wmlProbe(gi3,q,16u,aux,world,light,geometry,feedback);
  let irr=max(FIG_SH_Y0*c0.rgb+FIG_SH_COS1*FIG_SH_Y1*(cx.rgb*n.x+cy.rgb*n.y+cz.rgb*n.z),vec3f(0))+cave.rgb;
  let local=wmlProbe(glow,p,32u,aux,world,light,geometry,feedback).rgb+figWandLight(p,wand,i32(wandCount));
  return irr+local*sunCol.w;
}`;
export const worldMeshSunWGSL = /* wgsl */ `
fn wmlSun(p: vec3f,sm: texture_2d_array<f32>,sig: texture_2d<f32>,noise: texture_3d<f32>,rep: sampler,
  world: vec4u,feedback: vec4u,projection: mat4x4f,depth: vec4f,tiles: vec4i,physical: vec4u,version: vec4u,
  sun: vec4f,sunCol: vec4f,origin: vec4f,cave: vec4f,cloud: vec4f) -> vec3f {
  if(sun.w<0.5){return sunCol.rgb;}
  let c=figCloudShadow(p,sun.xyz,noise,rep,cloud);if(c<=FIG_CLOUD_SHADOW_SKIP){return vec3f(0);}
  let q=(projection*vec4f(p,1)).xyz;let i0=vec2i(floor(q.xy-0.5));let w=fract(q.xy-0.5);var acc=vec3f(0);var cD=0.0;var cW=0.0;
  for(var k=0;k<4;k++){
    let o=vec2i(k&1,k>>1u);let m=wmlSunTap(i0+o,sm,world,feedback,depth,tiles,physical,version);
    var lit=select(vec3f(0),vec3f(1),q.z<m.x+FIG_VOLUME_SHADOW_BIAS);let tid=i32(m.w/FIG_TINT_ID_SCALE);
    let wk=select(1.0-w.x,w.x,o.x==1)*select(1.0-w.y,w.y,o.y==1);
    if(tid>0&&q.z>m.y){let s=figSigma(sig,tid);let tau=m.w-f32(tid)*FIG_TINT_ID_SCALE;let frac=clamp((q.z-m.y)/max(m.z-m.y,1e-3),0.0,1.0);
      lit*=exp(-s.rgb/max(dot(s.rgb,vec3f(1.0/3.0)),1e-4)*tau*frac);
      if(figUnderPool(m,q.z,s,tid)){cD+=(q.z-m.y)*wk;cW+=wk;}
    }acc+=lit*wk;
  }
  if(cave.w>0.5&&cW>0.0){acc*=mix(1.0,figCausticGain(p,cD/cW,sun.xyz,origin),cW);}
  return sunCol.rgb*c*acc;
}`;
