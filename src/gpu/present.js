// The visible canvas (docs/webgpu.md W7, F7). three.js gets the page's canvas
// and sizes it (setSize, setPixelRatio keep working at their call sites), but
// renders only into render targets; we present to the canvas. The presenter
// configures the canvas's context with exactly the parameters three's own lazy
// `context` getter would use (WebGPUBackend.js:331-367: the preferred format,
// RENDER_ATTACHMENT | COPY_SRC, alphaMode from three's `alpha` — false, so
// opaque — and tone mapping 'standard'), so an accidental render to the
// default target reconfigures nothing.
//
// getCurrentTexture() is called only on presented frames; otherwise the
// canvas keeps its last image (render on demand).

import { fullscreenVert } from './wgsl.js';
import { STAGE } from './kernels.js';

/**
 * Configures `canvas` for WebGPU and returns the presenter.
 * @param {object} gpu
 * @param {HTMLCanvasElement} canvas
 * @param {{ alpha?: boolean }} [opts] alpha: three's `alpha` parameter (false: an opaque canvas, F7)
 */
export function createPresenter(gpu, canvas, { alpha = false } = {}) {
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('The canvas has no WebGPU context (another kind of context already owns it)');
  const format = navigator.gpu.getPreferredCanvasFormat();
  const config = {
    device: gpu.device,
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    alphaMode: alpha ? 'premultiplied' : 'opaque',
    toneMapping: { mode: 'standard' },
  };
  context.configure(config);
  let current = null, view = null;
  return {
    canvas,
    context,
    /** the canvas texture format (bgra8unorm or rgba8unorm) */
    format,
    alphaMode: config.alphaMode,
    /** Configures the context again (after a device change; never needed for a resize). */
    configure() { context.configure(config); },
    /**
     * This frame's canvas texture. Call it only on frames that present.
     * @returns {GPUTexture}
     */
    texture() {
      const t = context.getCurrentTexture();
      if (t !== current) { current = t; view = t.createView({ label: 'canvas' }); }
      return t;
    },
    /** A view of this frame's canvas texture. @returns {GPUTextureView} */
    view() { this.texture(); return view; },
    /**
     * A colour attachment for the canvas pass: cleared (it overwrites every pixel) and stored.
     * @param {GPUColor} [clearValue]
     * @returns {GPURenderPassColorAttachment}
     */
    attachment(clearValue = [0, 0, 0, 1]) {
      return { view: this.view(), loadOp: 'clear', storeOp: 'store', clearValue };
    },
    /**
     * The canvas as presented this frame, read back (F5's fallback for
     * screenshots), in R, G, B, A order whatever the canvas format. Call it in
     * the task that drew the frame, after the canvas pass.
     * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
     */
    async capture() {
      const t = this.texture();
      const data = await gpu.readback.texture(t, { format });
      if (format.startsWith('bgra')) {
        for (let i = 0; i < data.length; i += 4) { const b = data[i]; data[i] = data[i + 2]; data[i + 2] = b; }
      }
      return { width: t.width, height: t.height, data };
    },
  };
}

/** The blit's group 0: a filterable texture and a sampler. */
export const BLIT_LAYOUT = [
  { binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 1, visibility: STAGE.FRAGMENT, sampler: { type: 'filtering' } },
];

/** WGSL of the blit: the full-screen triangle sampling one texture. */
export const blitWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  return textureSampleLevel(src, smp, in.uv, 0.0);
}
`;

/**
 * A pipeline that draws a texture over a whole target of `format` (harness
 * pages, the walking skeleton). The game's canvas pass is post's (F7).
 * @param {object} gpu
 * @param {GPUTextureFormat} format the target's format
 * @returns {{ pipe: object, ready: Promise<unknown>, draw: (rp: GPURenderPassEncoder, src: GPUTextureView) => void }}
 */
export function createBlit(gpu, format) {
  const layout = gpu.layout('BLIT', BLIT_LAYOUT);
  const pipe = gpu.renderPipeline({ name: `blit ${format}`, code: blitWGSL(), layouts: [layout], fragment: { targets: [{ format }] } });
  const sampler = gpu.device.createSampler({ label: 'blit', magFilter: 'linear', minFilter: 'linear' });
  const groups = new WeakMap();
  return {
    pipe,
    ready: pipe.ready,
    draw(rp, src) {
      let g = groups.get(src);
      if (!g) groups.set(src, g = gpu.bindGroup(layout, [{ binding: 0, resource: src }, { binding: 1, resource: sampler }], 'blit'));
      pipe.draw(rp, { bind: [g] });
    },
  };
}

/** tools/check-wgsl.mjs: the modules this file builds (docs/webgpu.md I1). */
export const WGSL_CHECK = [
  {
    name: 'blit',
    kind: 'render',
    grids: false,
    code: () => blitWGSL(),
    layouts: () => [BLIT_LAYOUT],
    fragment: { targets: [{ format: 'bgra8unorm' }] },
  },
];
