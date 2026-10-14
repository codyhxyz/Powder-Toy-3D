// Mesh-only frames (docs/webgpu.md K3): while only three's meshes move (the
// default World scene's birds) with the camera, the simulation, the view's
// settings and its lighting still, a view frame draws the scene the volume,
// the far field and our other scene-pass draws made once (kept here), then
// only three's meshes over it and post, instead of marching every ray again.
//
// A frame of app.js is one of three kinds (plan()):
//   full     today's frame: the meshes first, the volume cut at their depth
//            (Sync log S1)
//   capture  the scene pass without the meshes first (the volume uncut), its
//            colour accumulated here (capture()), then the opaque meshes over
//            it, depth-tested against what it drew, then the transparent ones
//   meshes   restore() writes the kept scene (colour and depth) into the
//            scene target, then three draws the opaque meshes over it,
//            depth-tested against the kept depth, our scene pass draws
//            nothing, the transparent meshes and post as ever
// A capture runs for the view's settle count (the frames TAA takes to
// converge: pacer.viewSettle) with nothing but meshes changing; the kept
// scene is then complete and the frames after are mesh-only. Anything else
// changing (plan's key: the view key without the meshes, a wake, the derived
// passes running, the detail variant, the grid) makes that frame a full one
// and starts the capture again after it (a moving camera's frames are all
// full ones), and frames without mesh motion are full ones, so a settled view
// is always drawn the full way (the meshes' cut exact) and a still scene
// sleeps as before.
//
// The kept scene is the converged one, not one frame: TAA (and TAAU, the
// default) needs a differently jittered scene each frame, and one jittered
// frame shown again would freeze its noise and, upscaled, lose the detail
// TAAU gathers. So each capture frame is accumulated at the output size the
// way TAAU reconstructs a frame (Karis 2014): each output pixel takes the
// 3×3 input samples around it, each at its jittered position, weighted by a
// Gaussian of its distance (a narrower one than TAA's: there are many
// frames), in TAA's reversibly tone-mapped YCoCg, summed over the frames
// (rgba16float Σw·c and r16float Σw, additive blending). restore() then point
// samples that at this frame's jittered sample positions, so TAA reconstructs
// it as it would a scene drawn there, and the depth is the first capture
// frame's (the meshes' depth test, TAA's reprojection: the camera is still).
//
// The meshes go over the kept scene (Sync log S1's question for these frames):
// what the volume hit first occludes them. Where that is translucent (water,
// glass, gas in front of a mesh) the mesh is hidden behind its surface instead
// of tinted through it, as before S1; only during mesh motion with everything
// else still, and the birds fly in the open air. The simulation clock's
// animation (clouds drifting, water rippling, gas rising) holds still in the
// kept scene, as it does in a view that has gone to sleep (deep idle, F7):
// app.js's viewClock holds the clock the view draws with meanwhile, so it
// goes on from there afterwards instead of jumping ahead.
//
//   const frames = createMeshFrames(gpu, { onReady: () => pacer.wakeMeshes() });
//   const mode = frames.plan(token, { moved, settle: pacer.viewSettle });   // 'full' | 'capture' | 'meshes'
//   post.render({
//     prepare(p) { if (mode === 'meshes' && !frames.fits(p)) …full…; },
//     opaque(p) { mode 'meshes': frames.restore(p), three's opaque meshes (no clear), true; mode 'capture': false },
//     draw(rp) { mode 'meshes': nothing },
//     meshes(p) { mode 'capture': frames.capture(p), three's opaque meshes (no clear); then the transparent ones },
//   }, camera);
//
// Memory, while there are meshes to keep a scene for: 10 bytes an output
// pixel (Σw·c, Σw) and 4 an input pixel (the depth), made at the first
// capture and freed when no meshes are shown (release).

import { uniformStruct, fullscreenVert, luma as lumaWGSL, STAGE } from '../gpu/index.js';

const SCENE = { color: 'rgba16float', depth: 'depth32float' };   // post's scene target (gfx/post.js)
const SUM_FORMAT = 'rgba16float';
const WEIGHT_FORMAT = 'r16float';
const TEX = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };   // (GPUTextureUsage's bits, importable in Node)
// The accumulation's Gaussian, exp(-K·d²), d in output pixels: twice TAA's
// Blackman-Harris fit (2.29, gfx/post.js), σ ≈ 0.33 px. TAA's own
// reconstruction blurs the restored scene once more; a narrower kernel here
// keeps the sum of the two near TAA's alone, and the capture's 77+ frames
// still land several samples within it on every output pixel.
const ACCUM_K = 4.58;
// Below this Σw an output texel takes its 3×3 neighbours' sums too (a texel
// the capture's samples barely reached: none, after a full capture)
const WEIGHT_MIN = 1e-3;

const F = STAGE.FRAGMENT;
export const MESH_FRAME_LAYOUTS = {
  // the scene target's colour (textureLoad)
  ACCUM: [{ binding: 0, visibility: F, texture: { sampleType: 'float' } }],
  // the sums (Σw·c, Σw) and the kept depth (textureLoad)
  RESTORE: [
    { binding: 0, visibility: F, texture: { sampleType: 'float' } },
    { binding: 1, visibility: F, texture: { sampleType: 'float' } },
    { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
  ],
};

const AccumParams = uniformStruct('AccumParams', { jitter: 'vec2f', inSize: 'vec2f', size: 'vec2f', k: 'f32' });
const RestoreParams = uniformStruct('RestoreParams', { jitter: 'vec2f', inSize: 'vec2f', size: 'vec2f' });

// TAA's working space (gfx/post.js taaWGSL): YCoCg of c / (1 + luma), alpha
// (coverage) as is, and back.
const SPACE = /* wgsl */ `
${lumaWGSL}
fn rgb2ycocg(c: vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25)));
}
fn ycocg2rgb(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
fn toSpace(c: vec4f) -> vec4f { return vec4f(rgb2ycocg(c.rgb / (1.0 + luma(c.rgb))), c.a); }
fn fromSpace(t: vec4f) -> vec4f {
  let c = max(ycocg2rgb(t.xyz), vec3f(0.0));
  return vec4f(c / max(1.0 - luma(c), 1e-3), t.w);
}
`;

/** Capture: the scene target's frame, accumulated at the output size. */
export const accumulateWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${SPACE}
${AccumParams.wgsl}
@group(2) @binding(0) var tScene: texture_2d<f32>;   // the scene: linear premultiplied radiance, alpha = coverage (P.inSize)
@group(3) @binding(1) var<uniform> P: AccumParams;
const F32_INF: u32 = 0x7f800000u;
const F32_ABS: u32 = 0x7fffffffu;
const MAX_RADIANCE: f32 = 4096.0;
// NaN and ±Inf → 0, negatives → 0, a hue-preserving cap (post's sanitize, as TAA reads the scene)
fn clean(c0: vec4f) -> vec4f {
  var c = select(c0, vec4f(0.0), (bitcast<vec4u>(c0) & vec4u(F32_ABS)) >= vec4u(F32_INF));
  c = max(c, vec4f(0.0));
  let m = max(c.r, max(c.g, c.b));
  if (m > MAX_RADIANCE) { c = vec4f(c.rgb * (MAX_RADIANCE / m), c.a); }
  return vec4f(c.rgb, min(c.a, 1.0));
}
struct Sums {
  @location(0) sum: vec4f,   // Σ w · toSpace(colour)
  @location(1) weight: f32,  // Σ w
}
@fragment fn fs(in: FullScreen) -> Sums {
  let scale = P.inSize / P.size;          // input pixels per output pixel
  let pIn = in.position.xy * scale;       // this output pixel's centre, in input pixels
  let hi = vec2i(P.inSize) - 1;
  // input texel m sampled the scene at m + 0.5 - jitter (gfx/post.js TAAU): the nearest one is
  let c = vec2i(floor(pIn + P.jitter));
  var s = vec4f(0.0);
  var w = 0.0;
  for (var i = 0; i < 9; i++) {
    let m = c + vec2i(i % 3 - 1, i / 3 - 1);
    let d = (vec2f(m) + 0.5 - P.jitter - pIn) / scale;   // sample → pixel centre, output pixels
    let wi = exp(-P.k * dot(d, d));
    s += toSpace(clean(textureLoad(tScene, clamp(m, vec2i(0), hi), 0))) * wi;
    w += wi;
  }
  return Sums(s, w);
}
`;

/** A mesh-only frame's scene: the sums at this frame's jittered sample positions, and the kept depth. */
export const restoreWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${SPACE}
${RestoreParams.wgsl}
@group(2) @binding(0) var tSum: texture_2d<f32>;      // Σ w · toSpace(colour) (P.size)
@group(2) @binding(1) var tWeight: texture_2d<f32>;   // Σ w (P.size)
@group(2) @binding(2) var tDepth: texture_depth_2d;   // the first capture frame's depth (P.inSize)
@group(3) @binding(1) var<uniform> P: RestoreParams;
const WEIGHT_MIN: f32 = ${WEIGHT_MIN};
struct Restored {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs(in: FullScreen) -> Restored {
  // this input pixel samples the scene at its centre - jitter (gfx/post.js TAAU), in output pixels:
  let q = (in.position.xy - P.jitter) * (P.size / P.inSize);
  let hi = vec2i(P.size) - 1;
  let qi = clamp(vec2i(floor(q)), vec2i(0), hi);
  var s = textureLoad(tSum, qi, 0);
  var w = textureLoad(tWeight, qi, 0).r;
  if (w < WEIGHT_MIN) {
    for (var i = 0; i < 9; i++) {
      if (i == 4) { continue; }
      let n = clamp(qi + vec2i(i % 3 - 1, i / 3 - 1), vec2i(0), hi);
      s += textureLoad(tSum, n, 0);
      w += textureLoad(tWeight, n, 0).r;
    }
  }
  var o: Restored;
  o.color = select(vec4f(0.0), fromSpace(s / max(w, 1e-12)), w > 0.0);
  let dHi = vec2i(textureDimensions(tDepth)) - 1;
  o.depth = textureLoad(tDepth, clamp(vec2i(in.position.xy), vec2i(0), dHi), 0);
  return o;
}
`;

// ---------------------------------------------------------------- pipelines (tools/check-wgsl.mjs)
const ADD = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
const entry = (name, code, layout, params, fragment, extra = {}) => ({
  name, kind: 'render', grids: false, code, params, fragment,
  layouts: () => [undefined, undefined, MESH_FRAME_LAYOUTS[layout]],
  layoutNames: [undefined, undefined, `MESH_FRAMES_${layout}`],
  ...extra,
});
/** The pipelines mesh-only frames build, on first use (docs/webgpu.md I1). */
export const WGSL_CHECK = [
  entry('meshFramesAccumulate', accumulateWGSL, 'ACCUM', AccumParams,
    { entry: 'fs', targets: [{ format: SUM_FORMAT, blend: ADD }, { format: WEIGHT_FORMAT, blend: ADD }] }),
  entry('meshFramesRestore', restoreWGSL, 'RESTORE', RestoreParams, { entry: 'fs', targets: [{ format: SCENE.color }] },
    { depthStencil: { format: SCENE.depth, depthWriteEnabled: true, depthCompare: 'always' } }),
];
const PIPES = Object.fromEntries(WGSL_CHECK.map((e) => [e.name, e]));

/**
 * @param {object} gpu
 * @param {{ onReady?: () => void }} [opts] onReady: the pipelines finished building (they build at the
 *   first plan() that would use them; the frames meanwhile are full ones)
 */
export function createMeshFrames(gpu, { onReady = null } = {}) {
  const L = Object.fromEntries(Object.keys(MESH_FRAME_LAYOUTS).map((k) => [k, gpu.layout(`MESH_FRAMES_${k}`, MESH_FRAME_LAYOUTS[k])]));
  let pipes = null;   // { accum, restore }, made on first use (not at boot: B5's warm-up doesn't list them)

  let token = null;        // what the kept scene was drawn with (plan's key)
  let frames = 0;          // capture frames accumulated under it
  let settle = Infinity;   // capture frames a complete scene takes
  let sum = null, weight = null, depth = null;   // the sums (output size), the depth (input size)
  let size = [0, 0], inSize = [0, 0];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];

  // views and bind groups, made once per texture (post's way: B6)
  const views = new WeakMap();
  const viewOf = (t) => { let v = views.get(t); if (!v) views.set(t, v = t.createView({ label: t.label })); return v; };
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { let id = ids.get(o); if (!id) ids.set(o, id = nextId++); return id; };
  let groups = new Map();
  const group = (layout, textures) => {
    const key = `${layout.label}|${textures.map(idOf).join(',')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = gpu.bindGroup(layout, textures.map((t, binding) => ({ binding, resource: viewOf(t) })), key));
    return g;
  };

  function build() {
    if (pipes) return;
    pipes = {};
    for (const [key, name] of [['accum', 'meshFramesAccumulate'], ['restore', 'meshFramesRestore']]) {
      const e = PIPES[name];
      pipes[key] = gpu.renderPipeline({
        name, code: e.code(), layouts: [undefined, undefined, gpu.layout(e.layoutNames[2], e.layouts()[2])], params: e.params,
        fragment: e.fragment, ...(e.depthStencil && { depthStencil: e.depthStencil }),
      });
    }
    Promise.all([pipes.accum.ready, pipes.restore.ready]).then(() => onReady?.(), () => {});
  }
  const ready = () => !!pipes && pipes.accum.state === 'ready' && pipes.restore.state === 'ready';
  const fits = (p) => frames >= settle && !!sum && same(p.size, size) && same(p.inSize, inSize);

  // the sums and the depth at post's sizes now (made again, empty, on a change)
  function sizeFor(p) {
    const s = p.size, i = p.inSize;
    if (sum && same(s, size) && same(i, inSize)) return;
    if (sum) gpu.flush('mesh frames resize');   // (commands recorded with the old textures go first)
    free();
    const attach = TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING;
    sum = gpu.createTexture({ label: 'mesh frames sum', size: s, format: SUM_FORMAT, usage: attach });
    weight = gpu.createTexture({ label: 'mesh frames weight', size: s, format: WEIGHT_FORMAT, usage: attach });
    depth = gpu.createTexture({ label: 'mesh frames depth', size: i, format: SCENE.depth, usage: TEX.COPY_DST | TEX.TEXTURE_BINDING });
    size = [...s]; inSize = [...i];
    frames = 0;
  }
  function free() {
    sum?.destroy(); weight?.destroy(); depth?.destroy();
    sum = weight = depth = null;
    size = [0, 0]; inSize = [0, 0];
    groups = new Map();
  }

  return {
    /**
     * This frame's kind: 'full', 'capture' or 'meshes'.
     * @param {string} key everything but three's meshes that the scene pass
     *   draws with (a change starts the capture again)
     * @param {{ moved: boolean, settle: number }} opts moved: three's meshes
     *   moved since the last view frame (else the frame is a full one);
     *   settle: capture frames a complete scene takes
     * @returns {'full' | 'capture' | 'meshes'}
     */
    plan(key, { moved, settle: n }) {
      settle = Math.max(1, n);
      // (a change is drawn the full way: a capture starts only on a frame with
      // the key as the last one had it, so a moving camera's frames stay full ones)
      if (key !== token) { token = key; frames = 0; return 'full'; }
      if (!moved) return 'full';
      if (!ready()) { build(); return 'full'; }
      return frames >= settle ? 'meshes' : 'capture';
    },
    /** Forget the kept scene (something but the meshes changed, or a frame couldn't use it). */
    drop() { token = null; frames = 0; },
    /** Forget it and free its textures (no meshes to keep a scene for). */
    release() {
      token = null; frames = 0;
      if (!sum) return;
      gpu.flush('mesh frames release');   // (commands recorded with them go first)
      free();
    },
    /** The kept scene is complete and fits post's targets this frame (post: between beginScene and endScene). */
    fits,

    /**
     * A capture frame, in post's meshes hook (after the scene pass, before
     * three's meshes): accumulates the scene target's colour; the first frame
     * also keeps its depth.
     * @param {object} p post
     */
    capture(p) {
      if (!ready()) return;
      sizeFor(p);
      const t = p.sceneTarget, first = frames === 0;
      if (first) gpu.frame.direct().copyTextureToTexture({ texture: t.depth }, { texture: depth }, [inSize[0], inSize[1]]);
      const load = first ? 'clear' : 'load';
      const rp = gpu.frame.render({
        colorAttachments: [
          { view: viewOf(sum), loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          { view: viewOf(weight), loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      }, 'mesh frames capture');
      try {
        pipes.accum.draw(rp, { bind: [, , group(L.ACCUM, [t.color])], params: { jitter: p.jitter, inSize, size, k: ACCUM_K } });
      } finally { rp.end(); }
      frames++;
    },

    /**
     * A mesh-only frame, in post's opaque hook: the kept scene into the scene
     * target (colour and depth, every pixel). False (nothing recorded) when it
     * isn't complete or doesn't fit post's targets.
     * @param {object} p post
     * @returns {boolean}
     */
    restore(p) {
      if (!ready() || !fits(p)) return false;
      const rp = gpu.frame.render(p.sceneDescriptor({ load: false }), 'mesh frames restore');
      try {
        pipes.restore.draw(rp, { bind: [, , group(L.RESTORE, [sum, weight, depth])], params: { jitter: p.jitter, inSize, size } });
      } finally { rp.end(); }
      return true;
    },

    /** For tools: capture frames kept, how many a complete scene takes, and whether it is. */
    get state() { return { frames, settle, complete: frames >= settle && !!sum }; },

    dispose() {
      if (sum) gpu.flush('mesh frames dispose');
      free();
      token = null; frames = 0;
    },
  };
}
