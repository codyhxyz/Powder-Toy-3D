// The world's light at the eye (docs/seamless-world.md: one lighting system): L's probe and sun
// at one world point, read back for the hands (pov/viewmodel.js eyeLight), on frames the world
// march draws. The window's equivalents (derived.readProbe and a texel of the volume's shadow map)
// stop updating then. One tiny dispatch of shaders/world/lightLookup.js's lmProbeAt and lmSunMap,
// then a readback of 17 floats.
//
//   readWorldEye(gpu, light, eye, sky) → Promise<{ probe: Float32Array(16), sun: number }>
//     probe: the four L1 bands (c0, cx, cy, cz, rgba each: derived.readProbe's order)
//     sun:   the sun's share at the eye (0 behind opaque matter, dimmed through liquid and glass)
import { lightLookupWGSL } from '../shaders/world/lightLookup.js';
import { uniformStruct } from '../gpu/params.js';
import { STAGE } from '../shaders/common.js';

const EyeParams = uniformStruct('WorldEyeParams', { eye: 'vec4f', skyUp: 'vec4f', ground: 'vec4f' });
const OUT_BYTES = 5 * 16;   // the four bands, then the sun (x)
const tex3 = (binding) => ({ binding, visibility: STAGE.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } });
const LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  tex3(2), tex3(3), tex3(4), tex3(5),
  { binding: 6, visibility: STAGE.COMPUTE, sampler: { type: 'filtering' } },
  { binding: 7, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
export const worldEyeWGSL = () => /* wgsl */ `
${EyeParams.wgsl}
@group(3) @binding(1) var<uniform> P: WorldEyeParams;
${lightLookupWGSL({ caustics: false })}
@group(0) @binding(0) var<uniform> LC: LightUniforms;
@group(0) @binding(1) var<storage, read> lcBuf: array<vec4u>;
@group(0) @binding(2) var tGI0: texture_3d<f32>;
@group(0) @binding(3) var tGI1: texture_3d<f32>;
@group(0) @binding(4) var tGI2: texture_3d<f32>;
@group(0) @binding(5) var tGI3: texture_3d<f32>;
@group(0) @binding(6) var linearClamp: sampler;
@group(0) @binding(7) var<storage, read_write> eyeOut: array<vec4f, 5>;
fn lmLoad(i: u32) -> vec4u { return lcBuf[i]; }
@compute @workgroup_size(1) fn main() {
  LM = LC;
  let g = lmProbeAt(P.eye.xyz, tGI0, tGI1, tGI2, tGI3, linearClamp, P.skyUp.xyz, P.ground.xyz);
  eyeOut[0] = g.c0;
  eyeOut[1] = g.cx;
  eyeOut[2] = g.cy;
  eyeOut[3] = g.cz;
  eyeOut[4] = vec4f(dot(lmSunMap(P.eye.xyz, vec3f(0.0), false, 0.0), vec3f(1.0 / 3.0)), 0.0, 0.0, 0.0);
}`;

/**
 * Reads L's probe and sun at world point eye (cells). Resolves null while the kernel builds.
 * @param {object} gpu
 * @param {object} light gfx/worldLight.js's WorldLight
 * @param {number[]} eye world cells
 * @param {{ skyUp: number[], ground: number[] }} sky the open sky's colours (FU.skyUp, FU.ground)
 * @returns {Promise<{ probe: Float32Array, sun: number } | null>}
 */
export function readWorldEye(gpu, light, eye, { skyUp, ground }) {
  const k = (gpu._worldEye ??= {
    layout: gpu.layout('WORLD_EYE', LAYOUT),
    out: gpu.createBuffer({ label: 'world eye light', size: OUT_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    groups: new WeakMap(),
  });
  k.kernel ??= gpu.kernel({ name: 'worldEyeLight', code: worldEyeWGSL(), layouts: [k.layout], params: EyeParams, workgroupSize: [1, 1, 1], build: 'idle' });
  if (k.kernel.state !== 'ready') { k.kernel.build(); return Promise.resolve(null); }
  let group = k.groups.get(light);
  if (!group) {
    group = gpu.bindGroup(k.layout, [
      { binding: 0, resource: { buffer: light.lc.buffer } }, { binding: 1, resource: { buffer: light.buf.lc } },
      ...light.bandViews.map((v, i) => ({ binding: 2 + i, resource: v })),
      { binding: 6, resource: light.clamp }, { binding: 7, resource: { buffer: k.out } },
    ], 'world eye light');
    k.groups.set(light, group);
  }
  k.kernel.dispatch(gpu.frame, [1, 1, 1], { bind: [group], params: { eye: [...eye, 0], skyUp: [...skyUp, 0], ground: [...ground, 0] } });
  return gpu.readback.buffer(k.out, 0, OUT_BYTES).then((bytes) => {
    const f = new Float32Array(bytes);
    return { probe: f.slice(0, 16), sun: f[16] };
  });
}
