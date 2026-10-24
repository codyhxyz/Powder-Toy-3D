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
//
// HDR (EDR on a Mac): on a display that reports a high dynamic range the canvas
// is rgba16float with 'extended' tone mapping, the browser's HDR canvas (Chrome
// 129+, Safari 26), so values above 1 (SDR white) show brighter, up to the
// display's headroom. three.js's own switch for it (outputType HalfFloatType,
// WebGPUBackend.js's context getter) asks for the same configuration, so the
// rule above still holds; three is told through `presenter.hdr`. The composite
// spends the headroom (gfx/post.js, HDR_PEAK).

import { fullscreenVert } from './wgsl.js';
import { STAGE } from './kernels.js';
import { halfToFloat } from './readback.js';

const HDR_FORMAT = 'rgba16float';
const HDR_QUERY = '(dynamic-range: high)';

/** True on a display that can show HDR (the CSS media query the browser answers per screen). */
export function hdrDisplay() {
  return typeof matchMedia === 'function' && matchMedia(HDR_QUERY).matches;
}

/**
 * Configures `canvas` for WebGPU and returns the presenter.
 * @param {object} gpu
 * @param {HTMLCanvasElement} canvas
 * @param {{ alpha?: boolean }} [opts] alpha: three's `alpha` parameter (false: an opaque canvas, F7)
 */
export function createPresenter(gpu, canvas, { alpha = false, hdr = hdrDisplay() } = {}) {
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('The canvas has no WebGPU context (another kind of context already owns it)');
  const sdr = {
    device: gpu.device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    alphaMode: alpha ? 'premultiplied' : 'opaque',
    toneMapping: { mode: 'standard' },
  };
  let config = sdr;
  if (hdr) {
    config = { ...sdr, format: HDR_FORMAT, toneMapping: { mode: 'extended' } };
    context.configure(config);
    // a browser without HDR canvases ignores toneMapping (and reports 'standard', or no getConfiguration)
    if (context.getConfiguration?.()?.toneMapping?.mode !== 'extended') config = sdr;
  }
  context.configure(config);
  const format = config.format;
  // the picture may move to an SDR screen (or the display's HDR be switched off): the composite then stops spending headroom
  let hdrNow = config !== sdr && hdrDisplay();
  if (config !== sdr) matchMedia(HDR_QUERY).addEventListener('change', (e) => { hdrNow = e.matches; });
  let current = null, view = null;
  let frames = 0;   // canvas textures taken: the browser hands out a new one each frame that presents
  return {
    canvas,
    context,
    /** the canvas texture format (bgra8unorm or rgba8unorm; rgba16float when HDR) */
    format,
    /** true when the canvas is an HDR canvas (rgba16float, extended tone mapping) */
    hdr: config !== sdr,
    /** true while the canvas is HDR and its screen shows HDR: values above 1 are brighter than white */
    get hdrActive() { return hdrNow; },
    alphaMode: config.alphaMode,
    /** Configures the context again (after a device change; never needed for a resize). */
    configure() { context.configure(config); },
    /**
     * This frame's canvas texture. Call it only on frames that present.
     * @returns {GPUTexture}
     */
    texture() {
      const t = context.getCurrentTexture();
      if (t !== current) { current = t; view = t.createView({ label: 'canvas' }); frames++; }
      return t;
    },
    /** Frames presented so far, whichever renderer drew them (the HUD's fps: app.js countHudRates). */
    get frames() { return frames; },
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
      const raw = await gpu.readback.texture(t, { format });
      if (format === HDR_FORMAT) {
        // sRGB-encoded halfs, SDR white at 1: clip to the SDR range for an 8-bit still
        const data = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) data[i] = Math.round(Math.min(Math.max(halfToFloat(raw[i]), 0), 1) * 255);
        return { width: t.width, height: t.height, data };
      }
      const data = raw;
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
