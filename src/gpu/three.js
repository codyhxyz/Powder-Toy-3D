// Every use of three.js internals (docs/webgpu.md B10, W20). three r186's
// WebGPURenderer draws the mesh scene only, on our device, into render
// targets; the canvas is ours (present.js). This file is the whole interop
// surface, and tools/gpu-foundation-check.mjs exercises each piece, so a
// three upgrade that moves an internal fails there loudly.
//
// The rest of src/gpu imports nothing from three, and index.js doesn't
// re-export this file: sim and derived code reach src/gpu without pulling
// three into their module graph.

import {
  WebGPURenderer, ExternalTexture, WebGPUCoordinateSystem,
  RGBAFormat, RedFormat, RGFormat, RGBAIntegerFormat, RedIntegerFormat,
  HalfFloatType, FloatType, UnsignedByteType, UnsignedIntType, IntType,
  LinearFilter, NearestFilter, ClampToEdgeWrapping, NoColorSpace,
} from 'three/webgpu';
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
    return render(scene, camera);
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
 * @param {{ dimension?: '2d' | '3d', format?: GPUTextureFormat, type?: number, width?: number, height?: number, depth?: number }} [opts]
 * @returns {ExternalTexture}
 */
export function externalTexture(gpuTexture, { dimension = gpuTexture.dimension, format = gpuTexture.format, type, width, height, depth } = {}) {
  const tex = new ExternalTexture(gpuTexture);
  const [fmt, t] = FORMATS[format] ?? [RGBAFormat, HalfFloatType];
  tex.format = fmt;
  tex.type = type ?? t;
  tex.image = { width: width ?? gpuTexture.width, height: height ?? gpuTexture.height, depth: depth ?? gpuTexture.depthOrArrayLayers };
  if (dimension === '3d') tex.is3DTexture = true;
  const filterable = tex.type === HalfFloatType || tex.type === UnsignedByteType;
  tex.minFilter = tex.magFilter = filterable ? LinearFilter : NearestFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = NoColorSpace;
  return tex;
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
