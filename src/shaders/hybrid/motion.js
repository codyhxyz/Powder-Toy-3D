import { prelude, STATE_OPTS, STAGE } from '../common.js';
import { frameBindings } from '../bindings.js';
import { uniformStruct } from '../../gpu/params.js';
import { fullscreenVert } from '../../gpu/wgsl.js';
import { particleOwnershipWGSL } from './particles.js';
import { materialsGLSL } from '../../gfx/materials.js';

export const HybridMotionParams = uniformStruct('HybridMotionParams', {
  clipToGrid: 'mat4x4f', current: 'mat4x4f', previous: 'mat4x4f', previousJittered: 'mat4x4f',
  size: 'vec2f', valid: 'u32', changed: 'u32', untracked: 'u32', world: 'u32',
});
export const MOTION_LAYOUT = [
  { binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth' } },
  { binding: 1, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth' } },
  ...[2, 3].map(binding => ({ binding, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float' } })),
  { binding: 4, visibility: STAGE.FRAGMENT, buffer: { type: 'read-only-storage' } },
  { binding: 5, visibility: STAGE.FRAGMENT, buffer: { type: 'read-only-storage' } },
  { binding: 6, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
];
export const MOTION_CAPTURE_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];

export const motionCaptureWGSL = g => `${prelude(g, STATE_OPTS.STATE_RO)}
@group(2) @binding(0) var<storage, read_write> previousKeys: array<vec2u>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u,
  @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s < SLOTS) {
    let a = fetchAs(s);
    previousKeys[s] = vec2u(bitcast<u32>(a.x), bitcast<u32>(a.w));
  }
}`;

export const motionWGSL = g => `${prelude(g, STATE_OPTS.STATE_RO)}
${frameBindings()}
${materialsGLSL()}
${HybridMotionParams.wgsl}
@group(3) @binding(1) var<uniform> P: HybridMotionParams;
@group(2) @binding(0) var currentDepth: texture_depth_2d;
@group(2) @binding(1) var previousDepth: texture_depth_2d;
@group(2) @binding(2) var opticalDepth: texture_2d<f32>;
@group(2) @binding(3) var media: texture_2d<f32>;
@group(2) @binding(4) var<storage, read> previousKeys: array<vec2u>;
@group(2) @binding(5) var<storage, read> sceneGate: array<u32>;
@group(2) @binding(6) var previousCoverage:texture_2d<f32>;
${particleOwnershipWGSL}
${fullscreenVert()}
struct MotionOutput { @location(0) motion: vec4f, @location(1) reactive: f32, @location(2) coverage:f32 }
fn rejectMotion(coverage:f32)->MotionOutput { return MotionOutput(vec4f(0,0,-1,0),1,coverage); }
@fragment fn fs(in: FullScreen) -> MotionOutput {
  let pixel = vec2i(in.position.xy);
  let z = textureLoad(currentDepth, pixel, 0);
  let depthTolerance = max(0.000002, abs(dpdx(z))+abs(dpdy(z)));
  let mediaPixel = min(vec2i(in.uv * vec2f(textureDimensions(media))), vec2i(textureDimensions(media))-1);
  let coverage=select(0.0,1.0,P.untracked!=0u||sceneGate[0]!=0u
    ||textureLoad(opticalDepth,pixel,0).x<0.999999||textureLoad(media,mediaPixel,0).a>0.001);
  var out = MotionOutput(vec4f(0.0),0.0,coverage);
  if (P.valid==0u||coverage>0.0) { return rejectMotion(coverage); }
  let sky=z>=0.999999;
  if(sky&&P.changed!=0u){return rejectMotion(coverage);}
  let h = P.clipToGrid * vec4f(in.uv.x*2.0-1.0, 1.0-in.uv.y*2.0, z, 1.0);
  let p = h.xyz / h.w;
  let cell = vec3i(floor(p));
  var oldP = p;
  if (inGrid(cell)) {
    let a = fetchA(cell);
    let key = vec2u(bitcast<u32>(a.x), bitcast<u32>(a.w));
    if (any(previousKeys[slotOf(cell)] != key)) {
      // Exact cell-centred particle identity, never velocity-as-position.
      // Multi-cell jumps or ambiguous identities reject history.
      var matches = 0u;
      if (hybridParticleOwns(cell, P.world != 0u)) {
        for (var dz=-1; dz<=1; dz++) { for (var dy=-1; dy<=1; dy++) { for (var dx=-1; dx<=1; dx++) {
          let q = cell + vec3i(dx,dy,dz);
          if (inGrid(q)) {
            if (all(previousKeys[slotOf(q)] == key)) { oldP = p + vec3f(q-cell); matches++; }
          }
        } } }
      }
      if (matches != 1u) { return rejectMotion(coverage); }
    }
  } else if (P.changed != 0u) {
    return rejectMotion(coverage);
  }
  let oldClip = P.previousJittered * vec4f(oldP,1.0);
  if (oldClip.w <= 0.0) { return rejectMotion(coverage); }
  let oldNdc = oldClip.xyz / oldClip.w;
  let oldUv = vec2f(oldNdc.x*.5+.5, .5-oldNdc.y*.5);
  if (any(oldUv < vec2f(0.0)) || any(oldUv >= vec2f(1.0))) {
    return rejectMotion(coverage);
  }
  // Reject the OLD translucent footprint too; never feed yesterday's
  // reactive rejection back into this coverage texture (which would latch).
  let base=vec2i(floor(oldUv*P.size-vec2f(0.5)));
  for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    let q=clamp(base+vec2i(x,y),vec2i(0),vec2i(P.size)-1);
    if(textureLoad(previousCoverage,q,0).r>0.0){return rejectMotion(coverage);}
  }}
  if(sky){return out;} // Post owns the exact infinite-sky camera reprojection.
  let oldZ = textureLoad(previousDepth, vec2i(oldUv*P.size), 0);
  // Depth-neighbour dilation in post additionally rejects thin disocclusions.
  if (abs(oldZ-oldNdc.z) > depthTolerance) {
    return rejectMotion(coverage);
  }
  let now = P.current * vec4f(p,1.0);
  let prev = P.previous * vec4f(oldP,1.0);
  if (now.w <= 0.0 || prev.w <= 0.0) { return rejectMotion(coverage); }
  out.motion = vec4f(now.xy/now.w-prev.xy/prev.w,1.0,0.0);
  return out;
}`;
