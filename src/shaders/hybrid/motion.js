import { prelude, STATE_OPTS, STAGE } from '../common.js';
import { frameBindings } from '../bindings.js';
import { uniformStruct } from '../../gpu/params.js';
import { fullscreenVert } from '../../gpu/wgsl.js';
import { particleOwnershipWGSL } from './particles.js';
import { materialsGLSL } from '../../gfx/materials.js';

export const HybridMotionParams = uniformStruct('HybridMotionParams', {
  clipToGrid: 'mat4x4f', current: 'mat4x4f', previous: 'mat4x4f', previousJittered: 'mat4x4f',
  size: 'vec2f', valid: 'u32', changed: 'u32', external: 'u32', world: 'u32',
});
export const MOTION_LAYOUT = [
  { binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth' } },
  { binding: 1, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth' } },
  ...[2, 3].map(binding => ({ binding, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float' } })),
  { binding: 4, visibility: STAGE.FRAGMENT, buffer: { type: 'read-only-storage' } },
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
${particleOwnershipWGSL}
${fullscreenVert()}
struct MotionOutput { @location(0) motion: vec4f, @location(1) reactive: f32 }
@fragment fn fs(in: FullScreen) -> MotionOutput {
  var out = MotionOutput(vec4f(0.0), 0.0);
  let pixel = vec2i(in.position.xy);
  let z = textureLoad(currentDepth, pixel, 0);
  let depthTolerance = max(0.000002, abs(dpdx(z))+abs(dpdy(z)));
  let mediaPixel = min(vec2i(in.uv * vec2f(textureDimensions(media))), vec2i(textureDimensions(media))-1);
  if (P.valid == 0u || P.external != 0u || textureLoad(opticalDepth,pixel,0).x < 0.999999
      || textureLoad(media,mediaPixel,0).a > 0.001) {
    return MotionOutput(vec4f(0.0,0.0,-1.0,0.0),1.0);
  }
  if (z >= 0.999999) {
    // Post owns sky/camera reprojection. A changed scene may expose an old footprint.
    out.reactive = select(0.0,1.0,P.changed != 0u);
    return out;
  }
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
      if (matches != 1u) { return MotionOutput(vec4f(0.0,0.0,-1.0,0.0),1.0); }
    }
  } else if (P.changed != 0u) {
    return MotionOutput(vec4f(0.0,0.0,-1.0,0.0),1.0);
  }
  let oldClip = P.previousJittered * vec4f(oldP,1.0);
  if (oldClip.w <= 0.0) { return MotionOutput(vec4f(0.0,0.0,-1.0,0.0),1.0); }
  let oldNdc = oldClip.xyz / oldClip.w;
  let oldUv = vec2f(oldNdc.x*.5+.5, .5-oldNdc.y*.5);
  if (any(oldUv < vec2f(0.0)) || any(oldUv >= vec2f(1.0))) {
    return MotionOutput(vec4f(0.0,0.0,-1.0,0.0),1.0);
  }
  let oldZ = textureLoad(previousDepth, vec2i(oldUv*P.size), 0);
  // Depth-neighbour dilation in post additionally rejects thin disocclusions.
  if (abs(oldZ-oldNdc.z) > depthTolerance) {
    return MotionOutput(vec4f(0.0,0.0,-1.0,0.0),1.0);
  }
  let now = P.current * vec4f(p,1.0);
  let prev = P.previous * vec4f(oldP,1.0);
  if (now.w <= 0.0 || prev.w <= 0.0) { return MotionOutput(vec4f(0.0,0.0,-1.0,0.0),1.0); }
  out.motion = vec4f(now.xy/now.w-prev.xy/prev.w,1.0,0.0);
  return out;
}`;
