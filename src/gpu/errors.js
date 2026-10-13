// What a stopped GPU says, in the formats tools assert (docs/webgpu.md B9).
//
// Every failure (device loss, an uncaptured error of ours or three's, a
// pipeline that didn't build) ends in one GraphicsFailure, handed to the
// app's stopGraphics through gpu.onFailure. After it, gpu.frame throws that
// same object, so every state-mutating entry point throws as it does today
// (tools/gpu-failure-check.mjs checks `error.name === 'GraphicsFailure'`).

/** The error every entry point throws once graphics have stopped. */
export class GraphicsFailure extends Error {
  /**
   * @param {string} message what stopped, as the error page and tools show it
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'GraphicsFailure';
  }

  /**
   * The GraphicsFailure for any thrown value: itself, or a new one with the
   * value's message and the value as its cause.
   * @param {unknown} error
   * @returns {GraphicsFailure}
   */
  static from(error) {
    if (error instanceof GraphicsFailure) return error;
    const failure = new GraphicsFailure(error?.message ?? String(error), { cause: error });
    if (error?.stack) failure.stack = error.stack;
    return failure;
  }
}

/**
 * The message for a lost device: `The browser lost the WebGPU device (<reason>): <message>`.
 * @param {{ reason?: string, message?: string }} info a GPUDeviceLostInfo
 */
export function deviceLostMessage(info) {
  return `The browser lost the WebGPU device (${info?.reason ?? 'unknown'}): ${info?.message || 'no message'}`;
}

/**
 * The message for an uncaptured GPUError: `GPU <kind> error: <message>`, kind
 * from its class (validation, out-of-memory, internal).
 * @param {{ message?: string, constructor?: { name?: string } }} gpuError
 */
export function gpuErrorMessage(gpuError) {
  const type = gpuError?.constructor?.name ?? 'GPUError';
  const kind = { GPUValidationError: 'validation', GPUOutOfMemoryError: 'out-of-memory', GPUInternalError: 'internal' }[type] ?? type;
  return `GPU ${kind} error: ${gpuError?.message || 'no message'}`;
}

// One getCompilationInfo() per module, shared: in Chromium 141 a second call on
// an invalid module, after an async pipeline built from it was rejected,
// crashed the renderer ("Target crashed" in the foundation check).
const infos = new WeakMap();
/**
 * The module's compilation messages, asked for once per module.
 * @param {GPUShaderModule} module
 * @returns {Promise<GPUCompilationInfo>}
 */
export function compilationInfo(module) {
  let p = infos.get(module);
  if (!p) infos.set(module, p = module.getCompilationInfo());
  return p;
}

/**
 * The failure for a pipeline that didn't build:
 * `GPU shader failed: <name>.\n<line>:<col> <message>…`, from the module's
 * compilation messages (errors first, then warnings), else the pipeline
 * error's own text (a layout mismatch has no compilation message).
 * @param {string} name the kernel or pipeline name
 * @param {GPUShaderModule} module
 * @param {unknown} [error] the rejection of create*PipelineAsync
 * @returns {Promise<GraphicsFailure>}
 */
export async function shaderFailure(name, module, error) {
  let lines = [];
  try {
    const info = await compilationInfo(module);
    const rank = { error: 0, warning: 1, info: 2 };
    lines = [...info.messages].sort((a, b) => rank[a.type] - rank[b.type])
      .filter((m) => m.type !== 'info')
      .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  } catch { /* a lost device answers nothing */ }
  if (!lines.length && error) lines = [error.message ?? String(error)];
  return new GraphicsFailure(`GPU shader failed: ${name}.\n${lines.join('\n') || 'The browser returned no diagnostic text.'}`, { cause: error });
}
