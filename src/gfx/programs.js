// Shader programs: claiming them ahead of the first draw, and compiling them in
// the background. Gone with WebGL2 (docs/webgpu.md W18, B5): every pipeline is
// created with create*PipelineAsync and cached by source and descriptor
// (src/gpu/kernels.js), so a rebuilt grid reuses them without a claim, and
// three's mesh pipelines are compiled with gpu.three.prepare(object).
//
// app.js (U8) and world/window.js (U10) still import these names until their
// units port them; calling one is a bug in the caller's port.

// WEBGPU-STUB (docs/webgpu.md J3)
export function claimPrograms() {
  throw new Error('claimPrograms removed in the WebGPU port: docs/webgpu.md W18');
}

// WEBGPU-STUB (docs/webgpu.md J3)
export function compileInBackground() {
  throw new Error('compileInBackground removed in the WebGPU port: docs/webgpu.md W18');
}
