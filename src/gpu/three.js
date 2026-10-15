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
  WebGPURenderer, ExternalTexture, StorageBufferAttribute, WebGPUCoordinateSystem, RenderTarget, DepthTexture, QuadMesh, NodeMaterial,
  RGBAFormat, RedFormat, RGFormat, RGBAIntegerFormat, RedIntegerFormat,
  HalfFloatType, FloatType, UnsignedByteType, UnsignedIntType, IntType,
  LinearFilter, NearestFilter, ClampToEdgeWrapping, NoColorSpace,
} from 'three/webgpu';
import { texture as textureNode } from 'three/tsl';
import TAAUNode from 'three/addons/tsl/display/TAAUNode.js';
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

/** Adopt an immutable native storage binding without upload or ownership transfer.
 * r186 AttributeUtils skips creation for an adopted backend buffer, and
 * NodeStorageBuffer reads its current attribute on every bindings update.
 * The one-word array is a uint type witness, NEVER an upload/readback mirror.
 * Keep the native owner pinned until final submission AND completion. Do not
 * attach this attribute to geometry or ask Three to delete/destroy it.
 */
export function externalStorageAttribute(renderer, buffer, count) {
  if (!renderer?.backend?.get || !buffer || !Number.isSafeInteger(count) || count < 1 || buffer.size < count * 4) throw new TypeError('external uint storage extent/renderer required');
  const attribute = new StorageBufferAttribute(new Uint32Array(1), 1);
  attribute.count = count;
  renderer.backend.get(attribute).buffer = buffer;
  return attribute;
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
 * - resolve(camera, depth, [w, h]): the node's frame (resolve, history copy,
 *   previous-depth copy: its own submits, after a flush of ours) at output size
 *   [w, h]; returns the resolved GPUTexture.
 * Outside a RenderPipeline three never calls the view-offset hooks, and its
 * per-frame node update is once per gpu frame (createThreeRenderer), so the
 * node is built once by rendering a 1×1 quad that samples it (that render runs
 * its first frame) and later frames call its updateBefore directly: one
 * resolve per resolve() call. While it runs, the renderer's drawing-buffer
 * size, which TAAUNode takes as the output size, is [w, h].
 * @param {object} gpu with gpu.three (createThreeRenderer)
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

export function createTemporalUpscaler(gpu) {
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
  const node = new TAAUNode(beauty, textureNode(new DepthTexture(1, 1, FloatType)), textureNode(velocity.texture), null);
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
