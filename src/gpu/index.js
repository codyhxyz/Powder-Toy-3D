// The GPU foundation (docs/webgpu.md B). Everything but src/gpu/three.js,
// which the mesh layer imports on its own so sim and derived code never pull
// three into their module graph.
export { probeWebGPU, createGpu, wantedLimits, testModeOf, isWebKit, Gpu, DEFAULT_LIMITS, OPTIONAL_FEATURES, MAX_FRAMES_IN_FLIGHT } from './device.js';
export { GpuFrame, RING_RESERVE } from './frame.js';
export { uniformStruct, Header, headerWGSL, ParamRing, SharedUniforms, PARAM_SLOT, FLUSH_DISPATCHES, RING_BYTES } from './params.js';
export { fold, STAGE, withVisibility, Kernel, RenderPipe, PipelineCache, idleCallback, PIPELINE_BUDGET_MS, PIPELINE_CONCURRENCY, PIPELINE_CONCURRENCY_MIN, PIPELINE_CONCURRENCY_MAX, pipelineConcurrency, MAX_WORKGROUPS } from './kernels.js';
export { Readback, ResultRing, halfToFloat, halfsToFloats, TEXEL, READBACK_POOL_BYTES } from './readback.js';
export { GpuTiming, MAX_TIMED_PASSES } from './timing.js';
export { createPresenter, createBlit, blitWGSL, BLIT_LAYOUT } from './present.js';
export { GraphicsFailure, shaderFailure, compilationInfo, deviceLostMessage, gpuErrorMessage } from './errors.js';
export { glslMod, saturate, luma, fullscreenVert } from './wgsl.js';
export { shaderFeatures, setShaderFeatures, featuresOf, wantedShaderFeatures, hoistDirectives, halfWGSL, subgroupsWGSL, appendWGSL, CORE_FEATURES, SHADER_FEATURE_NAMES } from './features.js';
