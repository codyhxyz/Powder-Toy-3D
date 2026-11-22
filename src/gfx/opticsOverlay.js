import { RENDER_LAYOUT } from '../shaders/bindings.js';
import { MEDIA_HALF_LAYOUT, OPTICS_OVERLAY_LAYOUT, OpticsParams, WGSL_CHECK } from '../shaders/world/opticsOverlay.js';

export const mediaHalfSize = (w, h) => [Math.ceil(w / 2), Math.ceil(h / 2)];
const HDR = 'rgba16float';
// GPUTextureUsage.TEXTURE_BINDING | RENDER_ATTACHMENT; importable in Node.
const MEDIA_USAGE = 0x04 | 0x10;
const attachment = (view, alpha = 0) => ({ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, alpha] });

// Remove the world translation in double precision before the uniform packer
// rounds to f32: otherwise near/far unprojection cancels large world positions.
export function opticsCameraParams({ eye, maxDist, viewProj, invViewProj }) {
  const origin = eye.x === undefined ? eye : [eye.x, eye.y, eye.z];
  const inv = invViewProj.elements ?? invViewProj;
  const vp = viewProj.elements ?? viewProj;
  const clipToEye = Float32Array.from(inv);
  const eyeToClip = Float32Array.from(vp);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 3; r++) clipToEye[4 * c + r] = inv[4 * c + r] - origin[r] * inv[4 * c + 3];
    eyeToClip[12 + c] = vp[12 + c] + vp[c] * origin[0] + vp[c + 4] * origin[1] + vp[c + 8] * origin[2];
  }
  return { clipToEye, eyeToClip, eye, maxDist };
}

/** Two passes after opaque raster. Inputs need TEXTURE_BINDING; the distinct
 * output views need RENDER_ATTACHMENT. Frame group 0 uses the shared FRAME layout. */
export function createOpticsOverlay(gpu, sim, worldCopy, worldLight) {
  const frameLayout = gpu.layout('FRAME', RENDER_LAYOUT.FRAME);
  const layouts = [
    gpu.layout('MEDIA_HALF', MEDIA_HALF_LAYOUT),
    gpu.layout('OPTICS_OVERLAY', OPTICS_OVERLAY_LAYOUT),
  ];
  const [mediaPipe, opticsPipe] = WGSL_CHECK.map(({ name, code, fragment, depthStencil }, i) => gpu.renderPipeline({
    name: `world ${name}`, code: code(sim.g), layouts: [frameLayout, worldCopy.layout, layouts[i]],
    params: OpticsParams, fragment, ...(depthStencil ? { depthStencil } : {}), build: 'later', optional: true,
  }));
  const ready = Promise.all([mediaPipe.ready, opticsPipe.ready]);
  ready.catch(() => {}); // reported by the pipelines; still rejects for callers awaiting it
  const sampler = gpu.device.createSampler({ label: 'optics DDGI linear clamp', minFilter: 'linear', magFilter: 'linear' });
  const light = worldLight.bindEntries().filter(({ binding }) => MEDIA_HALF_LAYOUT.some((e) => e.binding === binding));
  light.push({ binding: 17, resource: sampler });

  let half = null, groups = new WeakMap(), disposed = false;
  function dropHalf() {
    if (!half) return;
    // A resize/dispose can follow a draw in the same tick. Submit before destroying its attachment.
    gpu.flush('retire optics media');
    half.tex.destroy();
    half = null;
    groups = new WeakMap();
  }
  function ensureHalf(w, h) {
    const [hw, hh] = mediaHalfSize(w, h);
    if (half?.w === hw && half.h === hh) return;
    dropHalf();
    const tex = gpu.createTexture({ label: 'world media half', size: [hw, hh], format: HDR, usage: MEDIA_USAGE });
    half = { w: hw, h: hh, tex, view: tex.createView() };
  }
  function bindGroups(depth, color) {
    let entry = groups.get(depth);
    if (!entry) {
      const shared = [{ binding: 1, resource: depth }, ...light];
      entry = { shared, media: gpu.bindGroup(layouts[0], shared), optics: new WeakMap() };
      groups.set(depth, entry);
    }
    let optics = entry.optics.get(color);
    if (!optics) {
      optics = gpu.bindGroup(layouts[1], [
        { binding: 0, resource: color }, { binding: 2, resource: half.view }, ...entry.shared,
      ]);
      entry.optics.set(color, optics);
    }
    return [entry.media, optics];
  }

  return {
    get ready() { return ready; },
    /** Returns false without writing either target if unavailable. `viewProj`
     * maps world cells to jittered WebGPU clip; `invViewProj` is its inverse.
     * `eye` and `maxDist` are in world cells; no camera object is needed.
     * Color is rgba16float and both depth views are depth32float, all single-sampled. */
    render(frame, { frameGroup0, opaqueColorView, opaqueDepthView, outColorView, outDepthView,
      w, h, allocSize = [w, h], invViewProj, viewProj, eye, maxDist }) {
      if (disposed || mediaPipe.state !== 'ready' || opticsPipe.state !== 'ready') return false;
      const copy = worldCopy.bindGroup;
      if (!copy || !frameGroup0 || w <= 0 || h <= 0) return false;
      if (opaqueColorView === outColorView || opaqueDepthView === outDepthView) throw new Error('optics overlay requires distinct input and output views');
      ensureHalf(...allocSize);
      const [hw, hh] = mediaHalfSize(w, h);
      const [media, optics] = bindGroups(opaqueDepthView, opaqueColorView);
      const params = { ...opticsCameraParams({ invViewProj, viewProj, eye, maxDist }), inSize: [w, h] };
      const mp = frame.render({ colorAttachments: [attachment(half.view, 1)] }, 'world media half');
      try {
        if (hw !== half.w || hh !== half.h) {
          mp.setViewport(0, 0, hw, hh, 0, 1);
          mp.setScissorRect(0, 0, hw, hh);
        }
        mediaPipe.draw(mp, { bind: [frameGroup0, copy, media], params });
      } finally { mp.end(); }
      const op = frame.render({ colorAttachments: [attachment(outColorView)], depthStencilAttachment: {
        view: outDepthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1,
      } }, 'world optics overlay');
      try {
        if (w !== allocSize[0] || h !== allocSize[1]) {
          op.setViewport(0, 0, w, h, 0, 1);
          op.setScissorRect(0, 0, w, h);
        }
        opticsPipe.draw(op, { bind: [frameGroup0, copy, optics], params });
      } finally { op.end(); }
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dropHalf();
    },
  };
}
