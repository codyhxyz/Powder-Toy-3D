// Same-frame acceptance: cached producers never silently truncate a scene.
export const hybridGateWGSL = /* wgsl */ `
@group(2) @binding(0) var<storage,read> geometryStatus:array<u32>;
@group(2) @binding(1) var<storage,read> surfaceStatus:array<u32>;
@group(2) @binding(2) var<storage,read_write> sceneGate:array<u32>;
@compute @workgroup_size(1) fn gate() {
  let bad=geometryStatus[2]|geometryStatus[3]|surfaceStatus[0];
  sceneGate[0]=bad;
  sceneGate[4]=3u; sceneGate[5]=1u;
  sceneGate[6]=0u; sceneGate[7]=0u;
  sceneGate[8]=36u; sceneGate[9]=select(0u,1u,bad!=0u);
  sceneGate[10]=0u; sceneGate[11]=0u;
}`;
export const hybridCompositeWGSL = /* wgsl */ `
@group(2) @binding(0) var sceneColor:texture_2d<f32>;
@group(2) @binding(1) var opaqueDepth:texture_depth_2d;
@group(2) @binding(2) var opticalDepth:texture_2d<f32>;
@group(2) @binding(3) var<storage,read> sceneGate:array<u32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(f32((i<<1u)&2u)*2.0-1.0,f32(i&2u)*2.0-1.0,0,1);
}
struct Composite { @location(0) color:vec4f,@builtin(frag_depth) depth:f32 }
@fragment fn fs(@builtin(position) pos:vec4f)->Composite {
  let p=vec2i(pos.xy);
  let first=textureLoad(opticalDepth,p,0).x;
  // Legacy owns the exceptional background, but the complete dedicated
  // optical layer must retain matter seen through glass/water too.
  if(sceneGate[0]!=0u&&first>=1.0){discard;}
  return Composite(textureLoad(sceneColor,p,0),
    min(textureLoad(opaqueDepth,p,0),first));
}`;
