// Post's harness page (tools/post-check.mjs, tools/budgets/post.mjs and
// tools/profile-check.mjs; docs/webgpu.md U7): src/gfx/post.js at 400×250 on a
// synthetic scene target, without the app. The scene is a pipeline of this page:
// a plane with a rotated checker and thin bright lines (diagonal edges that
// alias), seen at an angle (so depth varies across it), with sky around it;
// or a uniform fill. It is drawn with the camera post jitters, exactly as the
// volume and three's meshes are. A reference pass renders the same plane with
// 8×8 samples per pixel and no jitter: what an antialiased frame converges to.
//
// Each test returns plain data; the tool asserts on it.

import { createPresenter, uniformStruct, fullscreenVert, halfsToFloats } from '/src/gpu/index.js';
import { useWebGPUCamera } from '/src/gpu/three.js';
import { PerspectiveCamera, Matrix4, Vector3 } from 'three/webgpu';
import { createPost, POST_DEFAULTS } from '/src/gfx/post.js';
import { createProfiler } from '/src/gfx/profiler.js';
import { createProfilerPanel } from '/src/ui/profiler.js';
import { boot, ready, test, log, measure } from './harness.js';

const h = await boot({ label: 'post' });
const gpu = h.gpu;
const canvas = document.getElementById('view');
const W = canvas.width, H = canvas.height;
const presenter = createPresenter(gpu, canvas);
const post = createPost(gpu, { presenter, readable: true });
h.post = post;
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- the synthetic scene and its reference

const SceneParams = uniformStruct('SceneParams', { viewProj: 'mat4x4f', bright: 'vec4f', dark: 'vec4f', fill: 'vec4f', mode: 'u32', cell: 'f32' });
const RefParams = uniformStruct('RefParams', { invViewProj: 'mat4x4f', bright: 'vec4f', dark: 'vec4f', size: 'vec2f', cell: 'f32' });
const REF_SAMPLES = 8;   // per axis, per pixel
const PATTERN = /* wgsl */ `
const PLANE: vec2f = vec2f(3.0, 2.0);   // the plane's half extents: world units, at z = 0
const LINE: vec3f = vec3f(2.0, 1.6, 1.0);
// premultiplied radiance on the plane at w: a rotated checker (diagonal edges on
// screen) with thin bright lines across it, over the bloom threshold
fn pattern(w: vec2f) -> vec4f {
  let a = 0.35;
  let r = vec2f(cos(a) * w.x - sin(a) * w.y, sin(a) * w.x + cos(a) * w.y) / P.cell;
  var c = P.dark.rgb;
  if (((i32(floor(r.x)) + i32(floor(r.y))) & 1) == 1) { c = P.bright.rgb; }
  if (fract(r.x * 3.0) < 0.12) { c = LINE; }
  return vec4f(c, 1.0);
}
`;
const sceneWGSL = /* wgsl */ `
${SceneParams.wgsl}
@group(3) @binding(1) var<uniform> P: SceneParams;
${PATTERN}
struct VOut { @builtin(position) clip: vec4f, @location(0) w: vec2f, }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var out: VOut;
  if (P.mode == 1u) {   // a uniform fill at depth 0.5: the full-screen triangle
    out.clip = vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0.5, 1.0);
    out.w = vec2f(0.0);
    return out;
  }
  var corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let w = corner[i] * PLANE;
  out.clip = P.viewProj * vec4f(w, 0.0, 1.0);
  out.w = w;
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (P.mode == 1u) { return P.fill; }
  return pattern(in.w);
}
`;
const refWGSL = /* wgsl */ `
${fullscreenVert('vs')}
${RefParams.wgsl}
@group(3) @binding(1) var<uniform> P: RefParams;
${PATTERN}
const S: i32 = ${REF_SAMPLES};
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  var acc = vec4f(0.0);
  for (var j = 0; j < S; j++) {
    for (var i = 0; i < S; i++) {
      let px = in.position.xy - 0.5 + (vec2f(f32(i), f32(j)) + 0.5) / f32(S);   // y down
      let ndc = vec2f(px.x / P.size.x * 2.0 - 1.0, 1.0 - px.y / P.size.y * 2.0);
      let a = P.invViewProj * vec4f(ndc, 0.0, 1.0);
      let b = P.invViewProj * vec4f(ndc, 1.0, 1.0);
      let o = a.xyz / a.w;
      let d = b.xyz / b.w - o;
      let t = -o.z / d.z;
      let hit = o + t * d;
      if (t > 0.0 && all(abs(hit.xy) <= PLANE)) { acc += pattern(hit.xy); }
    }
  }
  return acc / f32(S * S);
}
`;
const scenePipe = gpu.renderPipeline({
  name: 'testScene', code: sceneWGSL, params: SceneParams, fragment: { targets: [{ format: 'rgba16float' }] },
  depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
});
const refPipe = gpu.renderPipeline({ name: 'testReference', code: refWGSL, params: RefParams, fragment: { targets: [{ format: 'rgba16float' }] } });
const refTex = gpu.createTexture({ label: 'reference', size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
await Promise.all([post.ready, scenePipe.ready, refPipe.ready]);

const LOOK = { bright: [1.2, 1.1, 1.0, 1], dark: [0.05, 0.06, 0.08, 1], cell: 0.37 };
const makeCamera = () => useWebGPUCamera(new PerspectiveCamera(40, W / H, 0.05, 200));
const camera = makeCamera();
const HOME = new Vector3(1.2, 0.8, 6.5);
function home(cam) { cam.position.copy(HOME); cam.quaternion.identity(); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); }
home(camera);

const vp = new Matrix4(), jp = new Matrix4();
/**
 * The frame's parts for post.render. mode: 'plane', 'fill' (uniform premultiplied
 * `fill`) or 'none'. drawCamera: draw the scene from another camera than the one
 * post was given, jittered by hand as post does (× jitterSign): the negative
 * controls, a reprojection that doesn't know the camera moved (another camera)
 * and a jitter TAA's reconstruction doesn't match (jitterSign 0 or -1).
 */
function sceneHooks({ mode = 'plane', fill = [0, 0, 0, 0], drawCamera = null, jitterSign = 1 } = {}) {
  return {
    prepare(p) {
      if (drawCamera) {
        drawCamera.updateMatrixWorld();
        jp.copy(drawCamera.projectionMatrix);
        const e = jp.elements, [jx, jy] = p.jitter.map((j) => j * jitterSign), [iw, ih] = p.inSize;
        for (let c = 0; c < 4; c++) { e[c * 4] += (2 * jx / iw) * e[c * 4 + 3]; e[c * 4 + 1] += (-2 * jy / ih) * e[c * 4 + 3]; }
        vp.multiplyMatrices(jp, drawCamera.matrixWorldInverse);
      } else vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    },
    draw(rp) {
      if (mode === 'none') return;
      scenePipe.draw(rp, { params: { viewProj: vp, ...LOOK, fill, mode: mode === 'fill' ? 1 : 0 }, count: mode === 'fill' ? 3 : 6 });
    },
  };
}

const setPost = (s = {}) => Object.assign(post.settings, POST_DEFAULTS, s);
const readHalf = async (tex) => halfsToFloats(await gpu.readback.texture(tex));

// the reference image for `cam` (unjittered), read back
async function reference(cam) {
  cam.updateMatrixWorld();
  const inv = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
  const rp = gpu.frame.render({ colorAttachments: [{ view: refTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }, 'reference');
  refPipe.draw(rp, { params: { invViewProj: inv, ...LOOK, size: [W, H] } });
  rp.end();
  const out = readHalf(refTex);
  gpu.flush('reference');
  return out;
}

// mean |t(a) − t(b)| over the colour channels, t = c / (1 + luma(c)) (the space TAA
// resolves in: bright outliers can't dominate), and mean |Δ alpha|; for images of one size
function difference(a, b) {
  let e = 0, ea = 0;
  for (let i = 0; i < a.length; i += 4) {
    const la = 1 + 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
    const lb = 1 + 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
    e += Math.abs(a[i] / la - b[i] / lb) + Math.abs(a[i + 1] / la - b[i + 1] / lb) + Math.abs(a[i + 2] / la - b[i + 2] / lb);
    ea += Math.abs(a[i + 3] - b[i + 3]);
  }
  const n = a.length / 4;
  return { rgb: e / (3 * n), alpha: ea / n };
}

// one presented frame: post.render, then the end of the tick
function frame(hooks, cam = camera, dt = 1 / 60, extra) {
  const drew = post.render(hooks, cam, null, dt, extra);
  if (!drew) throw new Error('post.render drew nothing: pipelines not ready');
  gpu.endFrame();
}

// ---------------------------------------------------------------- TAA

// A static camera: the aliased frame (TAA off, no jitter) against the reference,
// then TAA (or TAAU) frame by frame: its error against the reference, and the
// change since the read `every` frames before (a whole jitter cycle: the same phase).
test('taa', async ({ upscale = 1, frames = 128, every = 16, jitterSign = 1 } = {}) => {
  home(camera);
  const shadow = makeCamera();   // (the jitter controls draw from a twin that post doesn't jitter)
  home(shadow);
  const hooks = jitterSign === 1 ? sceneHooks() : sceneHooks({ drawCamera: shadow, jitterSign });
  const ref = await reference(camera);
  setPost({ taa: false, bloom: 0, adapt: false });
  post.render(sceneHooks(), camera);
  const aliasP = readHalf(post.targets.scene);
  gpu.endFrame();
  const alias = difference(await aliasP, ref);
  setPost({ taa: true, upscale, bloom: 0, adapt: false });
  const reads = [];
  for (let k = 1; k <= frames; k++) {
    post.render(hooks, camera);
    if (k % every === 0) reads.push({ k, image: readHalf(post.targets.history) });
    gpu.endFrame();
    if (k % 8 === 0) { await gpu.fence(); await tick(); }
  }
  const curve = [];
  let prev = null;
  for (const r of reads) {
    const img = await r.image;
    curve.push({ k: r.k, ...difference(img, ref), delta: prev ? difference(img, prev).rgb : null });
    prev = img;
  }
  return { alias, curve, inSize: post.inSize, size: post.size, settleWeight: post.settleWeight };
});

// Camera motion after a static start: 'pan' moves sideways and up ~0.3 px a
// frame, 'dolly' moves forward (depth-dependent reprojection). The error at the
// end, against the reference at the final camera, next to the static error.
// control: post is given a camera that doesn't move while the scene's does,
// so reprojection can't follow (the test must see that).
test('motion', async ({ kind = 'pan', control = false, settle = 64, moving = 64, step = 0.006, axes = [1, 1] } = {}) => {
  setPost({ taa: true, upscale: 1, bloom: 0, adapt: false });
  const mover = control ? makeCamera() : camera;
  home(camera); home(mover);
  const hooks = sceneHooks({ drawCamera: control ? mover : null });
  for (let k = 0; k < settle; k++) { frame(hooks); if (k % 8 === 7) { await gpu.fence(); await tick(); } }
  const settledImg = readHalf(post.targets.history);
  gpu.flush('read');
  const right = new Vector3(), up = new Vector3(), fwd = new Vector3();
  for (let k = 0; k < moving; k++) {
    mover.matrixWorld.extractBasis(right, up, fwd);
    if (kind === 'pan') mover.position.addScaledVector(right, step * axes[0]).addScaledVector(up, step * axes[1]);
    else mover.position.addScaledVector(fwd, -step * 1.6);
    mover.updateMatrixWorld();
    frame(hooks);
    if (k % 8 === 7) { await gpu.fence(); await tick(); }
  }
  const movedImg = readHalf(post.targets.history);
  gpu.flush('read');
  const movedRef = await reference(mover);
  const still = makeCamera();
  home(still);
  const staticRef = await reference(still);
  const out = { static: difference(await settledImg, staticRef), moved: difference(await movedImg, movedRef) };
  home(camera);
  return out;
});

// ---------------------------------------------------------------- adaptation and the meter

// A uniform scene of radiance L for `frames` frames from daylight (gain 1): the
// adaptation state read back from its buffer, and what post.adaptation says.
test('adapt', async ({ L, frames = 30, dt = 1 / 60, taa = false } = {}) => {
  setPost({ taa, bloom: 0, adapt: true, meter: false });
  await gpu.fence();
  gpu.write(post.adaptationBuffer, 0, new Float32Array(4));
  const hooks = sceneHooks({ mode: 'fill', fill: [L, L, L, 1] });
  for (let k = 0; k < frames; k++) { frame(hooks, camera, dt); if (k % 8 === 7) await tick(); }
  const state = Array.from(new Float32Array(await gpu.readback.buffer(post.adaptationBuffer)));
  await gpu.fence();
  await gpu.readback.idle();
  await tick();
  return { state, seen: post.adaptation, adapting: post.adapting };
});

// The meter over a uniform scene of radiance L (alpha `a`): post.sceneLuma once a reading lands.
test('meter', async ({ L, a = 1, frames = 12 } = {}) => {
  setPost({ taa: false, bloom: 0, adapt: false, meter: true });
  post.sceneLuma = null;
  const hooks = sceneHooks({ mode: 'fill', fill: [L * a, L * a, L * a, a] });
  for (let k = 0; k < frames; k++) { frame(hooks); await gpu.fence(); await gpu.readback.idle(); await tick(); }
  const luma = post.sceneLuma;
  setPost({ meter: false });
  return { luma };
});

// ---------------------------------------------------------------- the canvas

// half-float bits of x (round to nearest even; normal range)
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(x) {
  f32[0] = x;
  const b = u32[0], s = (b >>> 16) & 0x8000, e = ((b >>> 23) & 255) - 127 + 15, m = b & 0x7fffff;
  if (x === 0) return s;
  if (e <= 0) return s;   // (no subnormals needed here)
  let hm = m >>> 13;
  const rest = m & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (hm & 1))) hm++;
  return s | ((e << 10) + hm);
}
// a size-filling rgba16float texture of one premultiplied colour (a viewmodel or glow layer)
function solid(rgba) {
  const t = gpu.createTexture({ label: 'solid', size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const px = new Uint16Array(W * H * 4);
  const hv = rgba.map(toHalf);
  for (let i = 0; i < px.length; i += 4) px.set(hv, i);
  gpu.queue.writeTexture({ texture: t }, px, { bytesPerRow: W * 8, rowsPerImage: H }, [W, H]);
  return t;
}

// One frame of a uniform scene into the canvas, captured through the presenter
// (F5's screenshot path): the RGBA bytes at `points`.
test('pixel', async ({ fill = [0, 0, 0, 1], settings = {}, viewmodel = null, glow = null, points = [[200, 125]] } = {}) => {
  setPost({ taa: false, bloom: 0, adapt: false, ...settings });
  const vm = viewmodel ? solid(viewmodel) : null, gl = glow ? solid(glow) : null;
  const drew = post.render(sceneHooks({ mode: 'fill', fill }), camera, null, 1 / 60, { viewmodel: vm, glow: gl });
  const cap = post.capture();
  gpu.endFrame();
  const { width, data } = await cap;
  vm?.destroy(); gl?.destroy();
  return { drew, values: points.map(([x, y]) => Array.from(data.subarray(4 * (y * width + x), 4 * (y * width + x) + 4))) };
});

// The canvas over an empty scene (or the plane): the whole capture as base64
// RGBA, for the tool to compare with the sky gradient and with Chrome's own
// rendering of the page's background.
test('canvas', async ({ mode = 'none', settings = {} } = {}) => {
  setPost({ ...settings });
  home(camera);
  post.render(sceneHooks({ mode }), camera);
  const cap = post.capture();
  gpu.endFrame();
  const { width, height, data } = await cap;
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return { width, height, format: presenter.format, alphaMode: presenter.alphaMode, rgba: btoa(bin) };
});
test('canvasVisible', (on) => { canvas.classList.toggle('hidden', !on); return true; });

// RGBA bytes of a PNG (a Playwright screenshot, base64)
async function pngPixels(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
}
// A screenshot (PNG, base64) against a capture (RGBA, base64) of the same size:
// the largest and mean difference of the colour channels, and where the largest is.
test('compare', async ({ png, rgba }) => {
  const a = await pngPixels(png);
  const b = Uint8Array.from(atob(rgba), (c) => c.charCodeAt(0));
  if (a.data.length !== b.length) return { error: `sizes differ: ${a.width}×${a.height} vs ${b.length / 4} pixels` };
  let max = 0, sum = 0, at = null;
  for (let i = 0; i < b.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.data[i + k] - b[i + k]);
      sum += d;
      if (d > max) { max = d; at = [(i / 4) % a.width, Math.floor(i / 4 / a.width), k, a.data[i + k], b[i + k]]; }
    }
  }
  return { max, mean: sum / (b.length * 0.75), at };
});

// A thumbnail: renderStill into a 320×200 rgba8unorm target keeps the scene's
// alpha (no sky); TAA's history isn't touched.
test('still', async () => {
  setPost({});
  home(camera);
  for (let k = 0; k < 4; k++) frame(sceneHooks());
  const before = await readHalf(post.targets.history);
  const target = gpu.createTexture({ label: 'thumb', size: [320, 200], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const thumbCam = makeCamera();
  thumbCam.aspect = 320 / 200;
  thumbCam.updateProjectionMatrix();
  home(thumbCam);
  const stats = await measure(gpu, async () => {
    const drew = post.renderStill(sceneHooks({ drawCamera: null }), thumbCam, target);
    if (!drew) throw new Error('renderStill drew nothing');
    gpu.flush('still');
  });
  const px = await gpu.readback.texture(target);
  const after = await readHalf(post.targets.history);
  target.destroy();
  let covered = 0, clear = 0, partial = 0, colourInClear = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 255) covered++;
    else if (px[i + 3] === 0) { clear++; if (px[i] || px[i + 1] || px[i + 2]) colourInClear++; }
    else partial++;
  }
  return { covered, clear, partial, colourInClear, historyKept: difference(before, after).rgb === 0, stats };
});

// ---------------------------------------------------------------- budgets (tools/budgets/post.mjs)

// one presented frame after a warm-up frame (sizes allocated, bind groups made)
async function budgetFrame(settings, { mode = 'plane', warm = 2 } = {}) {
  setPost(settings);
  home(camera);
  for (let k = 0; k < warm; k++) frame(sceneHooks({ mode }));
  await gpu.fence();
  return { stats: await measure(gpu, async () => { frame(sceneHooks({ mode })); await tick(); }) };
}
test('budget:frame', () => budgetFrame({}));
test('budget:raw', () => budgetFrame({ raw: true }));
test('budget:noTaa', () => budgetFrame({ taa: false }));
test('budget:taau', () => budgetFrame({ upscale: 1 / 1.5 }));
test('budget:meter', () => budgetFrame({ meter: true }));
test('budget:still', async () => {
  const target = gpu.createTexture({ label: 'thumb', size: [320, 200], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  setPost({});
  post.renderStill(sceneHooks(), camera, target);   // (allocates the still's targets)
  gpu.flush('warm');
  await gpu.fence();
  const stats = await measure(gpu, async () => { post.renderStill(sceneHooks(), camera, target); gpu.flush('still'); await tick(); });
  target.destroy();
  return { stats };
});
// the bytes of the textures and buffers post made (labels: post …, scene …), at this page's size
test('budget:memory', async () => {
  setPost({});
  frame(sceneHooks());
  await gpu.fence();
  const { byLabel } = gpu.memory();
  const mine = Object.entries(byLabel).filter(([label]) => /^(post |scene |ring post)/.test(label));
  return { bytes: mine.reduce((s, [, b]) => s + b, 0), byLabel: Object.fromEntries(mine) };
});

// ---------------------------------------------------------------- the profiler (tools/profile-check.mjs --harness)

// The in-app profiler over this page's frames: frames run in a loop the profiler
// marks like app.js's tick (phases 'view' for the scene, 'post' after it), for
// `ms` with the profiler on. Returns its last sample and the frames it saw.
test('profiler', async ({ ms = 2500, on = true } = {}) => {
  setPost({ meter: false });
  home(camera);
  const samples = [];
  const prof = createProfiler(gpu, {
    describe: () => ({ sim: null, renderScale: post.renderScale, canvas: [W, H], pixelRatio: 1, bytes: post.threeBytes }),
    onSample: (s) => samples.push(s),
  });
  prof.enable(on);
  post.onPass = (name) => { if (name === 'scene') prof.phase('post'); };
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < ms) {
    const now = performance.now();
    prof.beginFrame(now);
    prof.phase('view');
    frame(sceneHooks());
    prof.phase('other');
    prof.endFrame(0);
    frames++;
    await gpu.fence();
    await new Promise((r) => setTimeout(r, 16));
  }
  const fps = frames / ((performance.now() - t0) / 1000);
  post.onPass = null;
  const last = prof.last;
  prof.enable(false);
  // the overlay (ui/profiler.js) shows the sample: its text, then it goes
  let panel = null;
  if (last) {
    const p = createProfilerPanel();
    p.show(true);
    p.update(last);
    const el = document.querySelector('.prof');
    panel = el.innerText;
    el.remove();
  }
  return { frames, fps, samples: samples.length, last: last && JSON.parse(JSON.stringify(last)), panel, timing: { ...gpu.timing.last }, supported: gpu.timing.supported };
});

// gpu.timing alone (no profiler) over `frames` frames, split or not: the last
// frame's { pass name: ms }, to compare split mode's sum with one compute pass
test('timing', async ({ split = false, frames = 12 } = {}) => {
  setPost({ meter: false });
  home(camera);
  gpu.timing.enabled = true;
  gpu.timing.split = split;
  for (let k = 0; k < frames; k++) { frame(sceneHooks()); await gpu.fence(); await gpu.readback.idle(); await tick(); }
  const last = { ...gpu.timing.last };
  gpu.timing.enabled = false;
  gpu.timing.split = false;
  return { last, supported: gpu.timing.supported };
});

ready();
log('ready');
