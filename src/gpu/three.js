// Every use of three.js internals (docs/webgpu.md B10, W20). three r186's
// WebGPURenderer draws the mesh scene only, on our device, into render
// targets; the canvas is ours (present.js). This file is the whole interop
// surface, and tools/gpu-foundation-check.mjs exercises each piece (the
// temporal upscaler, three's TAAUNode on our frame: tools/taau-check.mjs, in
// the app, and tools/post-check.mjs), so a three upgrade that moves an
// internal fails there loudly.
//
// The rest of src/gpu imports nothing from three, and index.js doesn't
// re-export this file: sim and derived code reach src/gpu without pulling
// three into their module graph.

import {
  WebGPURenderer, ExternalTexture, WebGPUCoordinateSystem, RenderTarget, DepthTexture, QuadMesh, NodeMaterial,
  RGBAFormat, RedFormat, RGFormat, RGBAIntegerFormat, RedIntegerFormat,
  HalfFloatType, FloatType, UnsignedByteType, UnsignedIntType, IntType,
  LinearFilter, NearestFilter, ClampToEdgeWrapping, NoColorSpace, RendererUtils, Vector2,
} from 'three/webgpu';
import {
  texture as textureNode, float, Fn, max, min, uv, vec2, vec4, luminance, ivec2, mix, property, outputStruct, context, uniform,
} from 'three/tsl';
import TAAUNode from 'three/addons/tsl/display/TAAUNode.js';
import { clipAABB, flickerReduction, sampleCurrentDepth, samplePreviousDepth } from 'three/addons/tsl/utils/TAAUtils.js';
import { GraphicsFailure, deviceLostMessage, gpuErrorMessage } from './errors.js';

/**
 * three's WebGPURenderer on our device and the page's canvas: no MSAA, opaque
 * (alpha: false, matching the presenter), autoClear off (our scene pass clears;
 * three loads). Also:
 * - a failed init throws instead of falling back to three's WebGL2 backend;
 * - three's own requestAnimationFrame loop is stopped (deep idle, F7 wants no
 *   rAF callbacks from a settled page) and its per-frame node update runs
 *   instead on the first render of each gpu frame;
 * - render() throws GraphicsFailure after a failure, flushes our open encoder
 *   first (queue order: three sees what we recorded), and in dev and test
 *   builds asserts a render target is set (three never draws the canvas);
 * - three's onError and onDeviceLost forward to gpu.fail.
 * Sets gpu.three = { renderer, prepare }.
 * @param {object} gpu
 * @param {HTMLCanvasElement} canvas
 * @param {{ assertTarget?: boolean, hdr?: boolean }} [opts] hdr: the presenter's (`presenter.hdr`), so a
 *   lazy configure of the canvas by three asks for the same HDR canvas (rgba16float, 'extended')
 * @returns {Promise<WebGPURenderer>}
 */
export async function createThreeRenderer(gpu, canvas, { assertTarget, hdr = false } = {}) {
  shimViewSwizzle(gpu.device);
  const renderer = new WebGPURenderer({ device: gpu.device, canvas, antialias: false, alpha: false, ...(hdr && { outputType: HalfFloatType }) });
  renderer._getFallback = null;
  await renderer.init();
  trackNativeRenderPipelines(renderer);
  renderer.autoClear = false;
  renderer._animation.stop();
  renderer.onError = (info) => gpu.fail(new GraphicsFailure(gpuErrorMessage(info?.originalEvent?.error ?? info), { cause: info }));
  renderer.onDeviceLost = (info) => gpu.fail(new GraphicsFailure(deviceLostMessage(info?.originalEvent ?? info), { cause: info }));

  assertTarget ??= Boolean(import.meta.env?.DEV || gpu.testMode);
  const render = renderer.render.bind(renderer);
  let frameSeen = -1;
  renderer.render = (scene, camera) => {
    gpu._frameOrThrow();
    if (assertTarget && renderer.getRenderTarget() === null) {
      throw new Error('three rendered to the canvas: the canvas is ours (docs/webgpu.md W7); set a render target');
    }
    if (gpu.frameNo !== frameSeen) {
      frameSeen = gpu.frameNo;
      renderer._nodes.nodeFrame.update();
      if (renderer.info.autoReset) renderer.info.reset();
    }
    if (gpu._frame.open) gpu.flush('before three');
    const previousScope = gpu.timing.scope;
    gpu.timing.scope = `three:${scene.name || scene.material?.name || 'meshes'}`;
    try { return render(scene, camera); }
    finally { gpu.timing.scope = previousScope; }
  };

  gpu.three = {
    renderer,
    /** what prepare() uses when a call leaves it out: the app sets its camera, scene and scene target once */
    defaults: { camera: null, scene: null, target: null },
    /**
     * Compiles a new kind of mesh before it joins the scene (B5, F8), for the
     * formats of `target` (the scene target): three otherwise creates its
     * pipeline synchronously at the first draw. `gpu.three.prepare(object)`
     * uses gpu.three.defaults.
     * @param {object} object the mesh or group
     * @param {{ camera?: object, scene?: object, target?: object }} [opts]
     * @returns {Promise<unknown>}
     */
    prepare(object, opts = {}) {
      const { camera, scene = null, target = null } = { ...gpu.three.defaults, ...opts };
      if (!camera) return Promise.reject(new Error('gpu.three.prepare: no camera (set gpu.three.defaults.camera)'));
      const prev = renderer.getRenderTarget();
      if (target) renderer.setRenderTarget(target);
      try {
        // compileAsync reads the render target synchronously, before its first await
        return renderer.compileAsync(object, camera, scene);
      } finally {
        if (target) renderer.setRenderTarget(prev);
      }
    },
  };
  return renderer;
}

/**
 * r186-only, renderer-instance interop: compileAsync's pipeline-cache hits do
 * not await the first creation, and WebGPUBackend catches native rejection.
 * Enroll the ORIGINAL native completion on every async getForRender, including
 * sync-created pipelines' existing validation scopes, then require the actual
 * backend GPURenderPipeline handle before certifying it. No native device
 * mutations/new error scopes; synchronous draw behavior is unchanged.
 * Exported so CPU tests can exercise the actual Three Pipelines cache path.
 */
const nativePipelineTrackers = new WeakSet();
export function trackNativeRenderPipelines(renderer) {
  if (nativePipelineTrackers.has(renderer)) return;
  const { backend, _pipelines: pipelines } = renderer;
  const nativeWork = new WeakMap();
  const create = backend.createRenderPipeline;
  const get = pipelines.getForRender;
  backend.createRenderPipeline = function (renderObject, promises) {
    const pipeline = renderObject.pipeline;
    const pending = [];
    let result;
    if (!promises) {
      const device = this.device;
      // r186 PipelineUtils reads device once, then pops its existing scope
      // synchronously. Forward native receivers for WebIDL brand checks; never
      // change the shared device or leave this renderer-local facade installed.
      this.device = new Proxy(device, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === 'popErrorScope') return (...args) => {
            const completion = value.apply(target, args);
            pending.push(completion); // no handlers before Three registers its own
            return completion;
          };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try { result = create.call(this, renderObject, promises); }
      finally { this.device = device; }
    } else {
      // Keep Three's original async native creation + diagnostics completion.
      result = create.call(this, renderObject, pending);
    }
    // For sync creation, Three's validation .then is already registered, so it
    // sets pipelineData.error before this fence checks the handle/error pair.
    const work = Promise.allSettled(pending).then(results => {
      if (!pending.length) throw new Error(`Three native mesh pipeline has no tracked completion (${pipeline.cacheKey})`);
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      if (!backend.get(pipeline).pipeline || backend.get(pipeline).error === true) {
        // Three has discarded the native error: do not invent its cause.
        throw new Error(`Three native mesh pipeline unavailable after compilation (${pipeline.cacheKey}); WebGPUBackend may have swallowed the native creation error. Check Three/WebGPU diagnostics.`);
      }
    });
    nativeWork.set(pipeline, work);
    work.catch(() => {}); // cache retains failures for later strict subscribers
    if (promises) promises.push(work);
    return result;
  };
  pipelines.getForRender = function (renderObject, promises) {
    const pipeline = get.call(this, renderObject, promises);
    if (promises) {
      const work = nativeWork.get(pipeline);
      if (work) {
        if (!promises.includes(work)) promises.push(work);
      } else {
        // A handle alone says nothing about outstanding native validation.
        const failed = Promise.reject(new Error(`Three native mesh pipeline has no tracked completion (${pipeline.cacheKey})`));
        failed.catch(() => {});
        promises.push(failed);
      }
    }
    return pipeline;
  };
  nativePipelineTrackers.add(renderer);
}

// three r186 gives every texture view `swizzle: 'rgba'` (GPUTextureViewDescriptor.js:84),
// the string form of the texture-component-swizzle proposal. Chromium builds that
// shipped the earlier dictionary form (the container's Chromium 141) reject the
// string with a TypeError on every createView, so three can't render at all.
// There, and only there, drop the identity swizzle before the call: 'rgba' maps
// every component to itself, so nothing else changes. Browsers that take the
// string, or don't know the member, are left alone.
let swizzleChecked = false;
function shimViewSwizzle(device) {
  if (swizzleChecked) return;
  swizzleChecked = true;
  const probe = device.createTexture({ label: 'swizzle probe', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  try {
    probe.createView({ swizzle: 'rgba' });
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    const createView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function createViewWithoutStringSwizzle(desc) {
      if (desc && desc.swizzle === 'rgba') {
        const { swizzle, ...rest } = desc;
        return createView.call(this, rest);
      }
      return createView.call(this, desc);
    };
  } finally {
    probe.destroy();
  }
}

/**
 * Makes three create a render target's GPU textures now, so gpuTextureOf can
 * return them, and (ownDepth) marks its depth as initialised: three clears a
 * new target's depth on its first render when autoClear is off
 * (Renderer.js:1715), which would wipe the depth our scene pass wrote before
 * three's meshes. Call it again after rt.setSize, then re-fetch the textures.
 * @param {WebGPURenderer} three
 * @param {object} rt a RenderTarget
 * @param {{ ownDepth?: boolean }} [opts]
 */
export function initRenderTarget(three, rt, { ownDepth = true } = {}) {
  three.initRenderTarget(rt);
  if (ownDepth && rt.depthBuffer) three._textures.get(rt).depthInitialized = true;
}

/**
 * three's GPUTexture for a texture (a render target's `texture` or
 * `depthTexture`), after initRenderTarget or three.initTexture. three
 * recreates it on resize, on a `samples` change and after dispose: compare
 * the returned identity on every use and rebuild bind groups holding it when
 * it changed.
 * @param {WebGPURenderer} three
 * @param {object} texture
 * @returns {GPUTexture}
 */
export function gpuTextureOf(three, texture) {
  const t = three.backend.get(texture)?.texture;
  if (!t) throw new Error(`three has no GPUTexture for ${texture?.name || 'this texture'} yet: initRenderTarget or initTexture first`);
  return t;
}

// three's format and type for a GPU format (what decides the binding's sample type)
const FORMATS = {
  rgba8unorm: [RGBAFormat, UnsignedByteType], rgba16float: [RGBAFormat, HalfFloatType], rgba32float: [RGBAFormat, FloatType],
  r16float: [RedFormat, HalfFloatType], r32float: [RedFormat, FloatType], rg16float: [RGFormat, HalfFloatType], rg32float: [RGFormat, FloatType],
  r32uint: [RedIntegerFormat, UnsignedIntType], rgba16uint: [RGBAIntegerFormat, UnsignedIntType], rgba32uint: [RGBAIntegerFormat, UnsignedIntType],
  r32sint: [RedIntegerFormat, IntType], rgba32sint: [RGBAIntegerFormat, IntType],
};

/**
 * Wraps a GPUTexture of ours for TSL materials (figures read the light, GI
 * and shadow volumes this way). three adopts it without copying and never
 * destroys it. A 3D texture gets is3DTexture, so TSL emits texture_3d<f32>.
 * An ExternalTexture can't be repointed: when our texture is recreated (a new
 * grid), make a new one, set the TSL texture node's `.value` to it and
 * dispose the old one. Float32 textures bind as unfilterable (the device has
 * no float32-filterable, W3): read them in TSL with textureLoad only.
 * @param {GPUTexture} gpuTexture
 * @param {{ dimension?: '2d' | '3d' | '2d-array', format?: GPUTextureFormat, type?: number, width?: number, height?: number, depth?: number }} [opts]
 * @returns {ExternalTexture}
 */
export function externalTexture(gpuTexture, { dimension = gpuTexture.dimension, format = gpuTexture.format, type, width, height, depth } = {}) {
  const tex = new ExternalTexture(gpuTexture);
  const [fmt, t] = FORMATS[format] ?? [RGBAFormat, HalfFloatType];
  tex.format = fmt;
  tex.type = type ?? t;
  tex.image = { width: width ?? gpuTexture.width, height: height ?? gpuTexture.height, depth: depth ?? gpuTexture.depthOrArrayLayers };
  if (dimension === '3d') tex.is3DTexture = true;
  if (dimension === '2d-array') tex.isArrayTexture = true;
  const filterable = tex.type === HalfFloatType || tex.type === UnsignedByteType;
  tex.minFilter = tex.magFilter = filterable ? LinearFilter : NearestFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = NoColorSpace;
  return tex;
}

/**
 * three's temporal anti-aliasing upscaler (r186's TAAUNode: Karis 2014's
 * jittered reconstruction with FSR 2's single-pass history, three's own
 * jitter sequence, velocity reprojection, variance clipping, thin-feature
 * locks) run on our frame, for every Upscaling preset, native included: at a
 * ratio of 1 its resolve is Karis's TAA with the current frame's jitter
 * filtered out (Blackman-Harris over the jittered samples), which TRAANode,
 * sampling the jittered frame bilinearly, doesn't do. post.js drives it:
 * - jitter(camera, w, h) at the scene's start: the node's own Halton offset
 *   as a view offset on the camera (TAAUNode.setViewOffset), the camera's own
 *   aspect kept (setViewOffset sets it to the input's, w / h, and
 *   clearViewOffset doesn't put it back); returns the offset in input pixels,
 *   y down: input texel m sampled the scene at m + ½ + jitter;
 * - unjitter(camera) at the scene's end (TAAUNode.clearViewOffset: the next offset);
 * - inputs(w, h): the two textures the scene's motion pass (post.js) writes at
 *   the scene's size, the node's inputs: its velocity (rg16float, this
 *   frame's unjittered NDC minus last frame's, the convention of three's
 *   VelocityNode, which TAAUNode reads) and the scene's colour (rgba16float);
 * - resolve(camera, depth, [w, h]): the node's frame (resolve, previous-depth
 *   copy: its own submits, after a flush of ours) at output size [w, h];
 *   returns the resolved GPUTexture, which holds until the resolve after next
 *   (PingPongTAAUNode below: its history targets take turns).
 * Outside a RenderPipeline three never calls the view-offset hooks, and its
 * per-frame node update is once per gpu frame (createThreeRenderer), so the
 * node is built once by rendering a 1×1 quad that samples it (that render runs
 * its first frame) and later frames call its updateBefore directly: one
 * resolve per resolve() call. While it runs, the renderer's drawing-buffer
 * size, which TAAUNode takes as the output size, is [w, h].
 * @param {object} gpu with gpu.three (createThreeRenderer)
 * @param {{ stock?: boolean }} [opts] stock: three's TAAUNode as it ships, not
 *   PingPongTAAUNode (a test resolves both on the same inputs and compares)
 */
// Reserve a sample without touching the committed jitter index/history. This
// uses the real TAAU view-offset hooks (including their velocity override),
// then restores them synchronously after scene recording. Already queued
// scenes can share a sample; each accepted scene advances the index once.
export function reserveTemporalJitter(node, camera, w, h) {
  const saved = { camera: node.camera, index: node._jitterIndex,
    original: node._originalProjectionMatrix.clone(), offset: node._jitterOffset.value.clone(),
    projection: camera.projectionMatrix.clone(), inverse: camera.projectionMatrixInverse.clone(),
    view: camera.view ? { ...camera.view } : null, aspect: camera.aspect };
  let restored = false, committed = false;
  const restoreCamera = () => {
    camera.view = saved.view ? { ...saved.view } : null;
    if (saved.aspect !== undefined) camera.aspect = saved.aspect;
    camera.projectionMatrix.copy(saved.projection);camera.projectionMatrixInverse.copy(saved.inverse);
  };
  const restore = () => {
    if (restored) return;
    node.camera = camera;node.clearViewOffset();node._jitterIndex = saved.index;
    node._originalProjectionMatrix.copy(saved.original);node._jitterOffset.value.copy(saved.offset);node.camera = saved.camera;
    restoreCamera();restored = true;
  };
  try {
    node.camera = camera;node.setViewOffset(w, h);
    if (saved.aspect !== undefined && camera.aspect !== saved.aspect) {camera.aspect = saved.aspect;camera.updateProjectionMatrix();}
    const original = node._originalProjectionMatrix.clone();
    const jitter = Object.freeze([node._jitterOffset.value.x, node._jitterOffset.value.y]);
    return Object.freeze({jitter, restore, commit(frozenCamera) {
      if (committed) throw new Error('temporal sample already committed');
      restore();
      node.camera = frozenCamera;node._originalProjectionMatrix.copy(original);node._jitterOffset.value.set(...jitter);
      const projection = frozenCamera.projectionMatrix.clone(), inverse = frozenCamera.projectionMatrixInverse.clone();
      const view = frozenCamera.view ? { ...frozenCamera.view } : null;
      node.clearViewOffset();
      frozenCamera.view = view;frozenCamera.projectionMatrix.copy(projection);frozenCamera.projectionMatrixInverse.copy(inverse);
      committed = true;
    }});
  } catch (e) {restore();throw e;}
}

/**
 * three r186's TAAUNode with its history in two targets that take turns, so
 * the frame's output-size work is the resolve alone. The same picture, bit
 * for bit: resolving the same inputs as the stock node (createTemporalUpscaler
 * { stock: true }) every frame, each with its own history, 0 of 4.1 M texels
 * differed over 16 frames on Lab and Island (M5, 2026-10-25). Its two changes:
 * - the node resolves into one target and then copies it into its history
 *   (copyTextureToTexture, rgba16float at output size: at 2560×1600 33 MB
 *   read and 33 MB written a frame, for plumbing). Here the resolve writes
 *   one of two targets while it samples the other as history, and the target
 *   written is the frame's output. The resolved image lives until the
 *   resolve after next (the node's own until the next one);
 * - its resolve samples a lock texture (its history target's second
 *   attachment, rgba16float at output size) that only the resize seed ever
 *   writes, with 0: the resolve's own lock output goes to a target with one
 *   attachment, and the history copy takes attachment 0 alone. So the lock
 *   it reads is always 0, `max(thin, 0 × decay)` is `max(thin, 0)`, and the
 *   read (a bilinear tap a pixel, at output size) and the texture go.
 * And it reconstructs at the output's resolution, where the node's resolve
 * blurs (2026-10-26: at the 2× preset a converged still was ~1.2 output
 * pixels soft, and slow motion smeared further):
 * - the current frame's 3×3 taps are weighted by FSR 2's Lanczos-2
 *   approximation (FidelityFX FSR 2, ffx_fsr2_upsample.h: Lanczos2ApproxSq,
 *   ComputeMaxKernelWeight, the kernel bias), not the node's Gaussian
 *   (exp(-2.29 d²), d in input pixels: σ ≈ 0.47 input pixels). Its offsets
 *   are scaled by the upsample ratio (capped at TAAU_KERNEL.MAX), so a
 *   stable pixel's kernel is an output pixel wide; a pixel with no history
 *   (FSR 2's new sample) gets its widest, of input pixels. The result is
 *   clamped to the 2×2 samples around the pixel (FSR 2's deringing), and,
 *   as FSR 2 accumulates every sample by its kernel weight, the frame's
 *   weight in the blend is the node's × the taps' weight over its mean
 *   (lanczosMeanWeight): an output pixel takes the frames whose jitter puts
 *   a sample on it, and the average frame still weighs currentFrameWeight
 *   (the settle count, pacing.js settleFrames, is unchanged);
 * - the history is read with a 5-tap Catmull-Rom (Jimenez 2016, "Filmic
 *   SMAA", SIGGRAPH; UE4's and FSR 2's history filter), not one bilinear tap,
 *   which re-blurred it every frame the camera moved by a fraction of a
 *   pixel (view bob). Its overshoot is clamped to the taps' range (as UE4
 *   clamps its history: the thin-feature lock skips the variance clip), and
 *   while the view moves it holds FSR 2's shorter history (TAAU_MOTION).
 * Only outside a RenderPipeline (the jitter's view-offset hooks are
 * createTemporalUpscaler's). updateBefore and setup are the node's own
 * (TAAUNode.js:377-489, :491-702) but for those changes.
 */
// FSR 2's kernel (ffx_fsr2_upsample.h). The offsets, in input pixels, are scaled by the
// upsample ratio before the Lanczos-2 window (zero at 1, support 2): FSR 2's
// ComputeMaxKernelWeight, 1 + (ratio - 1) × its kernel-size bias of 1, capped at 1.99
// (MAX) so a 3×3 neighbourhood still holds the kernel. A sample without history takes
// FSR 2's minimum, max(1, (1 + MAX's) × 0.3) (MIN_SHARE): input pixels.
export const TAAU_KERNEL = {
  MAX: 1.99,
  MIN_SHARE: 0.3,
  WINDOW_SQ: 4,      // Lanczos2ApproxSq's clamp of the squared offset: the window's support, 2²
  EPS: 1e-5,         // the taps' weight below which the pixel has no sample (FSR 2's FSR2_EPSILON): history only
  MEAN_GRID: 32,     // sub-pixel positions per axis lanczosMeanWeight averages over
};
// FSR 2's history length in motion (ffx_fsr2_accumulate.h ComputeBaseAccumulationWeight): once the
// view moves (its in-motion ramp: full at 0.1 output pixels a frame, × MOVE_RAMP) the history holds
// about 10 frames' samples (its "upsample weight × 10"), not the still view's 1 / currentFrameWeight:
// every frame of history re-reads it at a fraction of a pixel, and 40 such reads smear it
// (2026-10-26, a CPU model of this resolve at 2× and a 0.15 px/frame pan: the image's detail
// 70% → 89% of the truth's, its error 0.057 → 0.031).
export const TAAU_MOTION = { WEIGHT: 0.1, RAMP: 10 };
// FSR 2's Lanczos2ApproxSq of the squared offset x²: (25/16 (2/5 x² - 1)² - (25/16 - 1)) (1/4 x² - 1)²
const LANCZOS_A = 2 / 5, LANCZOS_B = 1 / 4, LANCZOS_C = 25 / 16;
export function lanczos2ApproxSq(x2) {
  x2 = Math.min(x2, TAAU_KERNEL.WINDOW_SQ);
  const a = LANCZOS_A * x2 - 1, b = LANCZOS_B * x2 - 1;
  return (LANCZOS_C * a * a - (LANCZOS_C - 1)) * b * b;
}
const lanczos2Node = /*@__PURE__*/ Fn(([x2]) => {
  const t = x2.min(TAAU_KERNEL.WINDOW_SQ);
  const a = t.mul(LANCZOS_A).sub(1), b = t.mul(LANCZOS_B).sub(1);
  return a.mul(a).mul(LANCZOS_C).sub(LANCZOS_C - 1).mul(b.mul(b));
}).setLayout({ name: 'lanczos2ApproxSq', type: 'float', inputs: [{ name: 'x2', type: 'float' }] });
/** The stable kernel's scale at an upsample ratio (output ÷ input pixels per axis): FSR 2's max kernel weight. */
export const taauKernelScale = (ratio) => Math.min(TAAU_KERNEL.MAX, Math.max(1, ratio));
/**
 * The mean, over where the pixel falls among the samples (the jitter is uniform over a
 * pixel: Halton), of the 3×3 taps' summed Lanczos weight (negative sums count as 0, as
 * the resolve takes them) at kernel scale k. ≈ 0.63 / k² once the 3×3 holds the window.
 */
export function lanczosMeanWeight(k) {
  const G = TAAU_KERNEL.MEAN_GRID;
  let sum = 0;
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
    const px = (i + 0.5) / G - 0.5, py = (j + 0.5) / G - 0.5;
    let w = 0;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) {
      const dx = (px - x) * k, dy = (py - y) * k;
      w += lanczos2ApproxSq(dx * dx + dy * dy);
    }
    sum += Math.max(w, 0);
  }
  return sum / (G * G);
}
const _taauQuad = /*@__PURE__*/ new QuadMesh();
const _taauSize = /*@__PURE__*/ new Vector2();
let _taauState;
class PingPongTAAUNode extends TAAUNode {
  constructor(beautyNode, depthNode, velocityNode, camera) {
    super(beautyNode, depthNode, velocityNode, camera);
    // the node's own targets go unused (never initialized: no GPU memory)
    this._historyRenderTarget.dispose();
    this._resolveRenderTarget.dispose();
    this._pair = [0, 1].map((i) => {
      const rt = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
      rt.texture.name = `TAAU history ${i}`;
      return rt;
    });
    this._written = 0;   // the target the next resolve writes
    this._historyNode = textureNode(this._pair[1].texture);
    this._textureNode.value = this._pair[0].texture;
    // the Lanczos kernel's scales (stable, new sample) and 1 / its mean weight, for the ratio (updateBefore)
    this._kernelScale = uniform(1);
    this._kernelScaleNew = uniform(1);
    this._kernelNorm = uniform(1 / lanczosMeanWeight(1));
    this._kernelRatio = 1;
  }

  // the kernel for this frame's ratio of output to input pixels (per axis, x)
  _setKernel(width) {
    const inW = this.beautyNode.value?.image?.width ?? 0;
    const ratio = inW > 0 ? width / inW : 1;
    if (ratio === this._kernelRatio) return;
    this._kernelRatio = ratio;
    const k = taauKernelScale(ratio);
    this._kernelScale.value = k;
    this._kernelScaleNew.value = Math.max(1, (1 + k) * TAAU_KERNEL.MIN_SHARE);
    this._kernelNorm.value = 1 / lanczosMeanWeight(k);
  }

  setSize(w, h) {
    for (const rt of this._pair) rt.setSize(w, h);
  }

  updateBefore(frame) {
    const { renderer } = frame;
    this._previousCameraWorldMatrix.value.copy(this._cameraWorldMatrix.value);
    this._previousCameraProjectionMatrixInverse.value.copy(this._cameraProjectionMatrixInverse.value);
    this._cameraNearFar.value.set(this.camera.near, this.camera.far);
    this._cameraWorldMatrix.value.copy(this.camera.matrixWorld);
    this._cameraWorldMatrixInverse.value.copy(this.camera.matrixWorldInverse);
    this._cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
    const { width, height } = renderer.getDrawingBufferSize(_taauSize);
    _taauState = RendererUtils.resetRendererState(renderer, _taauState);
    const write = this._pair[this._written], read = this._pair[1 - this._written];
    const restart = read.width !== width || read.height !== height;
    this.setSize(width, height);
    this._setKernel(width);
    if (restart) {
      for (const rt of this._pair) renderer.initRenderTarget(rt);
      // the history seeded with the beauty, bilinearly upscaled (the node's seed)
      renderer.setRenderTarget(read);
      _taauQuad.material = this._seedMaterial;
      _taauQuad.name = 'TAAU.seed';
      _taauQuad.render(renderer);
      renderer.setRenderTarget(null);
    }
    this._historyNode.value = read.texture;
    renderer.setRenderTarget(write);
    _taauQuad.material = this._resolveMaterial;
    _taauQuad.name = 'TAAU';
    _taauQuad.render(renderer);
    renderer.setRenderTarget(null);
    this._textureNode.value = write.texture;
    this._written = 1 - this._written;
    // the scene's depth into the previous-depth texture (the node's, as is)
    const currentDepth = this.depthNode.value;
    const srcW = currentDepth.image?.width ?? 0, srcH = currentDepth.image?.height ?? 0;
    if (srcW > 0 && srcH > 0) {
      if (this._previousDepthRenderTarget.width !== srcW || this._previousDepthRenderTarget.height !== srcH) {
        this._previousDepthRenderTarget.setSize(srcW, srcH);
        renderer.initRenderTarget(this._previousDepthRenderTarget);
      }
      const dstDepth = this._previousDepthRenderTarget.depthTexture;
      renderer.copyTextureToTexture(currentDepth, dstDepth);
      this._previousDepthNode.value = dstDepth;
    }
    RendererUtils.restoreRendererState(renderer, _taauState);
  }

  setup(builder) {
    if (builder.renderer.reversedDepthBuffer === true) this._previousDepthRenderTarget.depthTexture.type = FloatType;
    const historyNode = this._historyNode;
    // (one output: the node's second, the lock, goes to a target with one attachment and is dropped)
    const colorOutput = property('vec4');
    const outputNode = outputStruct(colorOutput);
    const resolve = Fn(() => {
      const uvNode = uv();
      const inputSize = this.beautyNode.size();
      const inputSizeF = vec2(inputSize);
      const pIn = uvNode.mul(inputSizeF);
      const closestTapF = pIn.sub(vec2(0.5).add(this._jitterOffset)).round();
      const closestTap = ivec2(closestTapF);
      const currentDepth = sampleCurrentDepth(this.depthNode, closestTapF, this._cameraNearFar);
      const closestDepth = currentDepth.get('closestDepth');
      const closestPositionTexel = currentDepth.get('closestPositionTexel');
      const farthestDepth = currentDepth.get('farthestDepth');
      const offsetUV = this.velocityNode.load(closestPositionTexel).xy.mul(vec2(0.5, -0.5));
      const historyUV = uvNode.sub(offsetUV);
      const previousDepth = samplePreviousDepth(this._previousDepthNode, historyUV, this._previousCameraProjectionMatrixInverse,
        this._previousCameraWorldMatrix, this._cameraWorldMatrixInverse, this._cameraNearFar, this.camera);
      const isValidUV = historyUV.greaterThanEqual(0).all().and(historyUV.lessThanEqual(1).all());
      const isEdge = farthestDepth.sub(closestDepth).greaterThan(this.edgeDepthDiff);
      const isDisocclusion = closestDepth.sub(previousDepth).greaterThan(this.depthThreshold);
      const hasValidHistory = isValidUV.and(isEdge.or(isDisocclusion.not()));
      // FSR 2's kernel: output-pixel wide on a pixel with history, input-pixel wide on a new one
      const kernelScale = hasValidHistory.select(this._kernelScale, this._kernelScaleNew);
      const sumColor = vec4(0).toVar();
      const sumWeight = float(0).toVar();
      const moment1 = vec4(0).toVar();
      const moment2 = vec4(0).toVar();
      // FSR 2's deringing range: the 2×2 samples around the pixel (|offset| < 1 input pixel per axis),
      // from the nearest tap (always one of them: the loop takes it first)
      let nearest = null, ringMin = null, ringMax = null;
      const offsets = [[0, 0], [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
      for (const [x, y] of offsets) {
        const tap = closestTap.add(ivec2(x, y));
        const tapCenter = vec2(tap).add(vec2(0.5).add(this._jitterOffset));
        const delta = pIn.sub(tapCenter);
        const scaled = delta.mul(kernelScale);
        const w = lanczos2Node(scaled.dot(scaled));
        const c = this.beautyNode.load(tap).max(0).toConst();
        sumColor.addAssign(c.mul(w));
        sumWeight.addAssign(w);
        moment1.addAssign(c);
        moment2.addAssign(c.pow2());
        if (!nearest) { nearest = c; ringMin = c.toVar(); ringMax = c.toVar(); continue; }
        const inRing = delta.abs().lessThan(vec2(1)).all();
        ringMin.assign(inRing.select(min(ringMin, c), ringMin));
        ringMax.assign(inRing.select(max(ringMax, c), ringMax));
      }
      const hasSample = sumWeight.greaterThan(TAAU_KERNEL.EPS);
      const currentColor = hasSample.select(sumColor.div(sumWeight.max(TAAU_KERNEL.EPS)), nearest).clamp(ringMin, ringMax).toConst();
      // the frame's share of the blend: its taps' weight over their mean (FSR 2 accumulates by kernel weight)
      const sampleShare = sumWeight.max(0).mul(this._kernelNorm);
      const N = float(offsets.length);
      const mean = moment1.div(N);
      const motionFactor = uvNode.sub(historyUV).mul(inputSizeF).length().div(this.maxVelocityLength).saturate();
      const varianceGamma = mix(0.5, 1, motionFactor.oneMinus().pow2());
      const variance = moment2.div(N).sub(mean.pow2()).max(0).sqrt().mul(varianceGamma);
      const minColor = mean.sub(variance);
      const maxColor = mean.add(variance);
      // the history: 5-tap Catmull-Rom (Jimenez 2016's bilinear-tap form, the corner taps dropped), clamped to its taps
      const historySize = vec2(historyNode.size());
      const samplePos = historyUV.mul(historySize);
      const texPos1 = samplePos.sub(0.5).floor().add(0.5);
      const f = samplePos.sub(texPos1);
      const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
      const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
      const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
      const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
      const w12 = w1.add(w2);
      const uv0 = texPos1.sub(1).div(historySize);
      const uv3 = texPos1.add(2).div(historySize);
      const uv12 = texPos1.add(w2.div(w12)).div(historySize);
      const crTaps = [
        [vec2(uv12.x, uv0.y), w12.x.mul(w0.y)], [vec2(uv0.x, uv12.y), w0.x.mul(w12.y)], [uv12, w12.x.mul(w12.y)],
        [vec2(uv3.x, uv12.y), w3.x.mul(w12.y)], [vec2(uv12.x, uv3.y), w12.x.mul(w3.y)],
      ].map(([p, w]) => [historyNode.sample(p).toConst(), w.toConst()]);
      let crSum = null, crWeight = null, crMin = null, crMax = null;
      for (const [c, w] of crTaps) {
        crSum = crSum ? crSum.add(c.mul(w)) : c.mul(w);
        crWeight = crWeight ? crWeight.add(w) : w;
        crMin = crMin ? min(crMin, c) : c;
        crMax = crMax ? max(crMax, c) : c;
      }
      const historyColor = crSum.div(crWeight).clamp(crMin, crMax).toConst();
      const clippedHistoryColor = clipAABB(mean.clamp(minColor, maxColor), historyColor, minColor, maxColor);
      const currentLuma = luminance(currentColor.rgb);
      const meanLuma = luminance(mean.rgb).toConst();
      const thinFeature = currentLuma.sub(meanLuma).abs().div(meanLuma).smoothstep(0, 0.2);
      const isDepthChanged = closestDepth.sub(previousDepth).abs().greaterThan(this.depthThreshold);
      const canLock = isValidUV.and(isDepthChanged.not());
      const gatedThinFeature = canLock.select(thinFeature, float(0));
      // (the node's max(thin, lock.r × decay): its lock texture is always 0, see above)
      const lock = max(gatedThinFeature, float(0)).saturate();
      const lockedHistoryColor = mix(clippedHistoryColor, historyColor, lock);
      const currentWeight = float(this.currentFrameWeight).toVar();
      // (FSR 2's in-motion history: the still weight rises to TAAU_MOTION.WEIGHT with the output pixels moved)
      const movedPx = uvNode.sub(historyUV).mul(historySize).length();
      currentWeight.assign(mix(currentWeight, float(TAAU_MOTION.WEIGHT), movedPx.mul(TAAU_MOTION.RAMP).saturate()));
      currentWeight.assign(hasValidHistory.select(currentWeight.add(motionFactor).mul(sampleShare).saturate(), 1));
      const output = flickerReduction(currentColor, lockedHistoryColor, currentWeight);
      colorOutput.assign(output);
      return vec4(0);
    });
    const sharedContext = context(builder.getSharedContext());
    this._resolveMaterial.contextNode = sharedContext;
    this._resolveMaterial.colorNode = resolve();
    this._resolveMaterial.outputNode = outputNode;
    this._seedMaterial.colorNode = Fn(() => {
      colorOutput.assign(this.beautyNode.sample(uv()));
      return vec4(0);
    })();
    this._seedMaterial.contextNode = sharedContext;
    this._seedMaterial.outputNode = outputNode;
    return this._textureNode;
  }

  dispose() {
    super.dispose();
    for (const rt of this._pair) rt.dispose();
  }
}

export function createTemporalUpscaler(gpu, { stock = false } = {}) {
  const renderer = gpu.three.renderer;
  const target = (name, format, filter) => {
    const rt = new RenderTarget(1, 1, {
      type: HalfFloatType, format, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: filter, magFilter: filter,
    });
    rt.texture.name = name;
    return rt;
  };
  // (the colour bilinear: the node's history seed after a resize samples it at output uv)
  const velocity = target('taau velocity', RGFormat, NearestFilter);
  const color = target('taau colour', RGBAFormat, LinearFilter);
  // TAAUNode reads its input size from the beauty node's render target (TAAUNode.js:399, :513)
  const beauty = Object.assign(textureNode(color.texture), { isRTTNode: true, renderTarget: color });
  // (its depth: the scene's, set at the first resolve, before the node is built)
  const node = new (stock ? TAAUNode : PingPongTAAUNode)(beauty, textureNode(new DepthTexture(1, 1, FloatType)), textureNode(velocity.texture), null);
  // our scene depth is depth32float; the copy into the previous-depth texture needs the same format
  // (TAAUNode switches it to FloatType only for a reversed depth buffer: TAAUNode.js:530)
  node._previousDepthRenderTarget.depthTexture.type = FloatType;
  const material = new NodeMaterial();
  material.name = 'TAAU build';
  material.colorNode = node;
  const quad = new QuadMesh(material);
  const one = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
  one.texture.name = 'TAAU build';
  let built = false;

  const ofThree = (rt) => gpuTextureOf(renderer, rt.texture);
  return {
    /** The node (tools read and tune it: currentFrameWeight, depthThreshold, …). */
    node,
    /** Baseline current-frame weight (TAAUNode.currentFrameWeight): how fast a still view settles. */
    get currentWeight() { return node.currentFrameWeight; },
    /** The motion pass's targets at the scene's size: { velocity, color } GPUTextures. */
    inputs(w, h) {
      for (const rt of [velocity, color]) {
        if (rt.width !== w || rt.height !== h || !renderer.backend.get(rt.texture)?.texture) {
          rt.setSize(w, h);
          initRenderTarget(renderer, rt, { ownDepth: false });
        }
      }
      return { velocity: ofThree(velocity), color: ofThree(color) };
    },
    jitter(camera, w, h) {
      node.camera = camera;
      const aspect = camera.aspect;
      node.setViewOffset(w, h);
      if (aspect !== undefined && camera.aspect !== aspect) { camera.aspect = aspect; camera.updateProjectionMatrix(); }
      const j = node._jitterOffset.value;
      return [j.x, j.y];
    },
    unjitter(camera) {
      node.camera = camera;
      node.clearViewOffset();
    },
    reserveJitter(camera, w, h) { return reserveTemporalJitter(node, camera, w, h); },
    resolve(camera, depth, [w, h]) {
      node.camera = camera;
      if (node.depthNode.value !== depth) node.depthNode.value = depth;
      const was = renderer.getRenderTarget();
      renderer.getDrawingBufferSize = (v) => v.set(w, h);
      try {
        if (!built) {
          // the first frame: three builds the node for this quad and runs its updateBefore (NodeUpdateType.FRAME)
          renderer.setRenderTarget(one);
          quad.render(renderer);
          built = true;
        } else {
          node.updateBefore({ renderer });
        }
      } finally {
        delete renderer.getDrawingBufferSize;
        renderer.setRenderTarget(was);
      }
      return gpuTextureOf(renderer, node.getTextureNode().value);
    },
    dispose() {
      node.dispose();
      material.dispose();
      one.dispose();
      velocity.dispose();
      color.dispose();
    },
  };
}

/**
 * Whether three has anything to draw: any visible renderable (mesh, line,
 * points, sprite) in a layer the camera sees, without a frustum test. When
 * false, the frame skips three's render and the flush before it (F1).
 * @param {object} scene
 * @param {object} camera
 */
export function threeHasVisible(scene, camera) {
  const stack = [scene];
  while (stack.length) {
    const o = stack.pop();
    if (!o.visible) continue;
    if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.layers.test(camera.layers)
      && !(o.isInstancedMesh && o.count === 0)) return true;
    for (const c of o.children) stack.push(c);
  }
  return false;
}

/**
 * Puts a camera we draw with in WebGPU's clip space (depth 0..1) from its
 * first frame, so our passes and three agree (B10, F4).
 * @param {object} camera
 * @returns {object} the camera
 */
export function useWebGPUCamera(camera) {
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  return camera;
}
