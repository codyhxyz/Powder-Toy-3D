// The WGSL_CHECK convention (docs/webgpu.md I1), on a sample kernel. Nothing
// in the game imports this module; tools/check-wgsl.mjs finds every module
// under src/ that exports WGSL_CHECK and checks what it lists.
//
// A module that builds pipelines exports
//
//   export const WGSL_CHECK = [{
//     name: 'blur',                       // the kernel's name, as gpu.kernel gets it
//     kind: 'compute',                    // or 'render' (then vertex, fragment, primitive, depthStencil
//                                         //   as gpu.renderPipeline takes them)
//     code: (g) => blurFrag(g),           // the WGSL for grid g (a gridLayout with slots, nbricks, …)
//     grids: true,                        // every check grid (the default); false: one text, g is null;
//                                         //   or a list of grid names ('32', '64', '128', 'wide', 'valley', 'giant')
//     layouts: (g) => [LAYOUT.TABLES, 'EMPTY', BLUR_LAYOUT],   // entries per group, or 'EMPTY'; group 3 is PARAMS
//     dispatch: (g) => fold(Math.ceil(g.nbricks / 64)),        // optional: [x, y, z] or a list of them
//     entry: 'main', constants: {},       // optional
//   }];
//   export const WGSL_MAC_ONLY = { blurHuge: 'misses the budget on SwiftShader; container uses plain' };
//
// Entries are plain data with functions of g, so they import in Node: use
// STAGE (kernels.js) for visibilities, never GPUShaderStage.

import { uniformStruct, headerWGSL } from './params.js';
import { fold } from './kernels.js';
import { glslMod, luma } from './wgsl.js';

const SampleParams = uniformStruct('SampleParams', { scale: 'f32', frame: 'u32' });

/**
 * A grid-dependent kernel: one thread per brick over a fold()ed dispatch.
 * @param {{ nbricks: number }} g
 */
export const sampleKernelWGSL = (g) => /* wgsl */ `
const NBRICKS: u32 = ${g.nbricks}u;
${SampleParams.wgsl}${headerWGSL()}${glslMod}${luma}
@group(3) @binding(1) var<uniform> P: SampleParams;
@group(2) @binding(0) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
                                     @builtin(local_invocation_index) li: u32) {
  let i = (wg.x + wg.y * nwg.x) * 64u + li;
  if (i >= NBRICKS) { return; }
  let c = vec3f(f32(i & 255u), f32(P.frame & 255u), f32(H.src)) / 255.0;
  out[i] = glslMod(luma(c) * P.scale - f32(H.origin.x), 1.0);
}
`;

/** tools/check-wgsl.mjs */
export const WGSL_CHECK = [
  {
    name: 'gpuSample',
    kind: 'compute',
    code: (g) => sampleKernelWGSL(g),
    layouts: () => ['EMPTY', 'EMPTY', [{ binding: 0, buffer: { type: 'storage' } }]],
    dispatch: (g) => fold(Math.ceil(g.nbricks / 64)),
  },
];
