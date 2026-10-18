// Native opaque HDR/depth hand-off. No tone mapping or proxy coverage.
export const worldOpaqueWGSL = /* wgsl */ `
struct CaptureParams { drew: u32, padding: vec3u }
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var packed: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(3) var<uniform> params: CaptureParams;
fn packOpaque(c: vec4f, d: f32) -> vec4u {
  return vec4u(pack2x16float(c.rg), pack2x16float(c.ba),
    bitcast<u32>(d), select(0u, 1u, d < 1.0));
}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(packed))) { return; }
  var value = vec4u(0u,0u,bitcast<u32>(1.0),0u);
  if (params.drew != 0u) {
    value = packOpaque(textureLoad(color, vec2i(id.xy), 0),
      textureLoad(depth, vec2i(id.xy), 0));
  }
  textureStore(packed, vec2i(id.xy), value);
}
`;
export const worldOpaqueLayout = [
  {binding:0,visibility:4,texture:{sampleType:'unfilterable-float',viewDimension:'2d'}},
  {binding:1,visibility:4,texture:{sampleType:'depth',viewDimension:'2d'}},
  {binding:2,visibility:4,storageTexture:{access:'write-only',format:'rgba32uint',viewDimension:'2d'}},
  {binding:3,visibility:4,buffer:{type:'uniform',minBindingSize:32}},
];
