import { fullscreenVert, STAGE, uniformStruct } from '../gpu/index.js';

const FORMAT = 'rgba16float';
const HISTORY_USAGE = 0x15; // GPUTextureUsage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC.

const PHASES = 32;
const CURRENT_WEIGHT = 0.025; // Three r187 TAAUNode's still-frame convergence rate.

function halton(index, base) {
  let value = 0, fraction = 1;
  for (; index > 0; index = Math.floor(index / base)) {
    fraction /= base;
    value += fraction * (index % base);
  }
  return value - 0.5;
}
const OFFSETS = Array.from({ length: PHASES }, (_, i) => [halton(i + 1, 2), halton(i + 1, 3)]);
// Like Three r187 TAAUNode, the phase is expressed in input pixels, top-left origin.
export const taauJitter = (phase) => [...OFFSETS[phase % PHASES]];
export const taauUvScale = (inSize, allocSize) => [inSize[0] / allocSize[0], inSize[1] / allocSize[1]];

const Params = uniformStruct('TaauParams', {
  inSize: 'vec2f', allocSize: 'vec2f', outSize: 'vec2f', uvScale: 'vec2f', jitter: 'vec2f', reset: 'bool', reactive: 'f32',
});
const LAYOUT = [
  ...['float', 'unfilterable-float', 'depth', 'float'].map((sampleType, binding) => ({ binding, visibility: STAGE.FRAGMENT, texture: { sampleType } })),
  { binding: 4, visibility: STAGE.FRAGMENT, sampler: { type: 'filtering' } },
];

export const nativeTaauWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${Params.wgsl}
@group(2) @binding(0) var tColor: texture_2d<f32>;
@group(2) @binding(1) var tVelocity: texture_2d<f32>;
@group(2) @binding(2) var tDepth: texture_depth_2d;
@group(2) @binding(3) var tHistory: texture_2d<f32>;
@group(2) @binding(4) var smp: sampler;
@group(3) @binding(1) var<uniform> P: TaauParams;

fn inputUV(uv: vec2f) -> vec2f {
  let texelHalf = vec2f(0.5) / P.allocSize;
  // Clamp to the outer texel centres, not the viewport boundary: linear taps
  // must never see the unused right/bottom portion of the allocation.
  return clamp(uv * P.uvScale - P.jitter / P.allocSize, texelHalf, max(texelHalf, P.uvScale - texelHalf));
}
fn toYCoCg(c: vec4f) -> vec4f {
  return vec4f(dot(c.rgb, vec3f(0.25, 0.5, 0.25)), (c.r - c.b) * 0.5, (2.0 * c.g - c.r - c.b) * 0.25, c.a);
}
fn fromYCoCg(c: vec4f) -> vec4f {
  let t = c.x - c.z;
  return vec4f(t + c.y, c.x + c.z, t - c.y, c.a);
}
fn historySample(p: vec2f) -> vec4f {
  return textureSampleLevel(tHistory, smp, p / P.outSize, 0.0);
}
// Jimenez 2016 / Three r187: collapse the central Catmull-Rom pair on each
// axis with bilinear filtering, omit the four outer corners, renormalize.
fn history5(uv: vec2f) -> vec4f {
  let p = uv * P.outSize;
  let b = floor(p - 0.5) + 0.5;
  let f = p - b;
  let w0 = f * (f * (1.0 - 0.5 * f) - 0.5);
  let w1 = f * f * (1.5 * f - 2.5) + 1.0;
  let w2 = f * (f * (2.0 - 1.5 * f) + 0.5);
  let w3 = f * f * (0.5 * f - 0.5);
  let w12 = w1 + w2;
  let m = b + w2 / w12;
  let w = vec4f(w12.x * w0.y, w0.x * w12.y, w3.x * w12.y, w12.x * w3.y);
  let center = w12.x * w12.y;
  let c = historySample(m);
  let n = historySample(vec2f(m.x, b.y - 1.0));
  let s = historySample(vec2f(m.x, b.y + 2.0));
  let l = historySample(vec2f(b.x - 1.0, m.y));
  let r = historySample(vec2f(b.x + 2.0, m.y));
  let rangeMin = min(c, min(min(n, s), min(l, r)));
  let rangeMax = max(c, max(max(n, s), max(l, r)));
  return clamp((c * center + n * w.x + l * w.y + r * w.z + s * w.w) / (center + dot(w, vec4f(1.0))), rangeMin, rangeMax);
}
fn cubic(x: vec2f) -> vec2f {
  let a = abs(x);
  return select(((2.5 - 1.5 * a) * -a) * a + 1.0,
    ((2.5 - 0.5 * a) * a - 4.0) * a + 2.0, a > vec2f(1.0));
}
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let uv = in.position.xy / P.outSize;
  let uvIn = inputUV(uv);
  if (P.reset != 0u) { return textureSampleLevel(tColor, smp, uvIn, 0.0); }

  let p = uvIn * P.allocSize - 0.5;
  let hi = vec2i(P.inSize) - 1;
  let center = clamp(vec2i(round(p)), vec2i(0), hi);
  var closest = center;
  var closestDepth = textureLoad(tDepth, center, 0);
  var mean = vec4f(0.0);
  var moment = vec4f(0.0);
  var sum = vec4f(0.0);
  var weightSum = 0.0;
  var tapMin = vec4f(1.0);
  var tapMax = vec4f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = center + vec2i(x, y);
      let tap = clamp(q, vec2i(0), hi);
      let d = textureLoad(tDepth, tap, 0);
      if (d < closestDepth) { closestDepth = d; closest = tap; }
      let c = textureLoad(tColor, tap, 0);
      let delta = p - vec2f(q);
      let w = cubic(delta);
      sum += c * (w.x * w.y);
      weightSum += w.x * w.y;
      if (all(abs(delta) < vec2f(1.0))) { tapMin = min(tapMin, c); tapMax = max(tapMax, c); }
      let v = toYCoCg(c);
      mean += v;
      moment += v * v;
    }
  }
  let current = clamp(sum / max(weightSum, 1e-5), tapMin, tapMax);
  let motion = textureLoad(tVelocity, closest, 0).xy * vec2f(0.5, -0.5);
  let prev = uv - motion;
  if (!all(prev >= vec2f(0.0)) || !all(prev <= vec2f(1.0))) { return current; }

  let speed = clamp(length(motion * P.outSize) / 16.0, 0.0, 1.0);
  mean /= 9.0;
  let sigma = sqrt(max(moment / 9.0 - mean * mean, vec4f(0.0))) * mix(1.25, 1.0, speed);
  let old = toYCoCg(history5(prev));
  // Clip toward the mean (Playdead's TAA) instead of clipping RGB channels independently.
  let delta = old.rgb - mean.rgb;
  let unit = abs(delta) / max(sigma.rgb, vec3f(1e-5));
  let rgb = mean.rgb + delta / max(1.0, max(unit.x, max(unit.y, unit.z)));
  let history = clamp(fromYCoCg(vec4f(rgb, clamp(old.a, mean.a - sigma.a, mean.a + sigma.a))), vec4f(0.0), vec4f(1.0));
  return mix(history, current, max(P.reactive, mix(${CURRENT_WEIGHT}, 0.35, speed)));
}
`;

const PIPE = {
  name: 'nativeTaau', kind: 'render', grids: false, code: nativeTaauWGSL, params: Params,
  layouts: () => [undefined, undefined, LAYOUT], layoutNames: [undefined, undefined, 'NATIVE_TAAU'],
  fragment: { entry: 'fs', targets: [{ format: FORMAT }] },
};
export const WGSL_CHECK = [PIPE];

/** Native resolve of post's compressed HDR and unjittered NDC velocity. The
 * output stays compressed; `reactive` is a frame-wide minimum current weight. */
export function createNativeTaau(gpu) {
  const layout = gpu.layout(PIPE.layoutNames[2], LAYOUT);
  const pipe = gpu.renderPipeline({ name: PIPE.name, code: PIPE.code(), layouts: [,, layout], params: Params, fragment: PIPE.fragment });
  const sampler = gpu.device.createSampler({ label: 'TAAU linear', magFilter: 'linear', minFilter: 'linear' });
  let pair = [], width = 0, height = 0, written = -1, valid = false;
  let phase = 0, jitter = [0, 0], cameraState = null, recordedFrame = null;
  let groups = new WeakMap();

  // Frame schedules its own submission. When resized/disposed in that task,
  // leave textures alive until its encoder submits. Call outside render passes.
  function retire(targets) {
    if (!targets.length) return;
    const destroy = () => targets.forEach(({ texture }) => texture.destroy());
    if (recordedFrame?.open) queueMicrotask(destroy); else destroy();
  }
  function resize(w, h) {
    if (w === width && h === height && pair.length) return;
    retire(pair);
    width = w; height = h; written = -1; valid = false; groups = new WeakMap();
    pair = [0, 1].map(i => {
      const texture = gpu.createTexture({ label: `native TAAU history ${i}`, size: [w, h], format: FORMAT,
        usage: HISTORY_USAGE });
      return { texture, view: texture.createView() };
    });
  }
  function apply(camera, w, h, offset) {
    const aspect = camera.aspect, view = camera.view ? { ...camera.view } : null;
    const projection = camera.projectionMatrix.clone(), inverse = camera.projectionMatrixInverse.clone();
    if (view?.enabled) {
      // Compose jitter with a pre-existing tiled view instead of replacing it.
      camera.setViewOffset(view.fullWidth, view.fullHeight,
        view.offsetX + offset[0] * view.width / w, view.offsetY + offset[1] * view.height / h, view.width, view.height);
    } else camera.setViewOffset(w, h, ...offset, w, h);
    if (aspect !== undefined && camera.aspect !== aspect) { camera.aspect = aspect; camera.updateProjectionMatrix(); }
    return () => {
      camera.view = view;
      if (aspect !== undefined) camera.aspect = aspect;
      camera.projectionMatrix.copy(projection);
      camera.projectionMatrixInverse.copy(inverse);
    };
  }
  const api = {
    ready: pipe.ready,
    get isReady() { return pipe.state === 'ready'; },
    get compilationSettled() { return pipe.compilationSettled; },
    currentWeight: CURRENT_WEIGHT,
    get texture() { return pair[written]?.texture ?? null; },
    get view() { return pair[written]?.view ?? null; },
    get historyTextures() { return pair.map(({ texture }) => texture); },
    setViewOffset(camera, inW, inH, _outW, _outH) {
      if (cameraState) api.clearViewOffset(cameraState.camera);
      jitter = taauJitter(phase);
      cameraState = { camera, restore: apply(camera, inW, inH, jitter) };
      return [...jitter];
    },
    clearViewOffset(camera) {
      if (camera !== cameraState?.camera) return;
      cameraState.restore(); cameraState = null;
      phase = (phase + 1) % PHASES;
    },
    reserveJitter(camera, inW, inH) {
      const offset = taauJitter(phase);
      const restore = apply(camera, inW, inH, offset);
      let restored = false, committed = false;
      return {
        jitter: [...offset],
        restore() { if (!restored) { restored = true; restore(); } },
        commit() {
          if (committed) return;
          this.restore(); committed = true;
          jitter = offset;
          phase = (phase + 1) % PHASES;
        },
      };
    },
    resolve(frame, { colorView, velocityView, depthView, inSize, allocSize, outSize, reset = false, reactive = 0 }) {
      resize(...outSize);
      const write = written < 0 ? 0 : 1 - written;
      const dst = pair[write], prev = pair[1 - write];
      let byVelocity = groups.get(colorView);
      if (!byVelocity) groups.set(colorView, byVelocity = new WeakMap());
      let byDepth = byVelocity.get(velocityView);
      if (!byDepth) byVelocity.set(velocityView, byDepth = new WeakMap());
      let sides = byDepth.get(depthView);
      if (!sides) byDepth.set(depthView, sides = []);
      const bind = sides[write] ??= gpu.bindGroup(layout,
        [colorView, velocityView, depthView, prev.view, sampler].map((resource, binding) => ({ binding, resource })));
      const rp = frame.render({ colorAttachments: [{ view: dst.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }, 'taa');
      recordedFrame = frame;
      try {
        pipe.draw(rp, { bind: [,, bind], params: { inSize, allocSize, outSize, uvScale: taauUvScale(inSize, allocSize),
          jitter, reset: reset || !valid, reactive: Math.min(1, Math.max(0, reactive)) } });
      } finally { rp.end(); }
      written = write; valid = true;
      return dst.texture;
    },
    resize,
    reset() { valid = false; },
    dispose() {
      if (cameraState) api.clearViewOffset(cameraState.camera);
      retire(pair); pair = []; groups = new WeakMap(); written = -1; valid = false; recordedFrame = null;
    },
  };
  return api;
}
