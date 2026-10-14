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

import { createPresenter, uniformStruct, fullscreenVert, halfsToFloats, STAGE } from '/src/gpu/index.js';
import { useWebGPUCamera, createThreeRenderer, threeHasVisible } from '/src/gpu/three.js';
import { PerspectiveCamera, Matrix4, Vector3, Scene, Mesh, BoxGeometry, MeshBasicNodeMaterial } from 'three/webgpu';
import { createPost, POST_DEFAULTS, WGSL_CHECK, compositeWGSL } from '/src/gfx/post.js';
import { createProfiler } from '/src/gfx/profiler.js';
import { createProfilerPanel } from '/src/ui/profiler.js';
import { boot, ready, test, log, measure } from './harness.js';

const h = await boot({ label: 'post' });
const gpu = h.gpu;
const canvas = document.getElementById('view');
const W = canvas.width, H = canvas.height;
const presenter = createPresenter(gpu, canvas);
// three's renderer exists before post, as in the app: post's scene target is three's
// RenderTarget (F3) and post's TAA is three's TAAU (gpu/three.js createTemporalUpscaler);
// ?three=1: three also draws meshes into it between our scene pass and post
const three = await createThreeRenderer(gpu, canvas);
three.setPixelRatio(1); three.setSize(W, H, false);
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
        // (three's view offset: texel m samples m + ½ + jitter, so NDC moves by −2·jx/w and +2·jy/h)
        const e = jp.elements, [jx, jy] = p.jitter.map((j) => j * jitterSign), [iw, ih] = p.inSize;
        for (let c = 0; c < 4; c++) { e[c * 4] += (-2 * jx / iw) * e[c * 4 + 3]; e[c * 4 + 1] += (2 * jy / ih) * e[c * 4 + 3]; }
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
    if (k % every === 0) reads.push({ k, image: readHalf(post.targets.resolved) });
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
  const settledImg = readHalf(post.targets.resolved);
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
  const movedImg = readHalf(post.targets.resolved);
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

// A settled frame keeps its real TAA resolve and bloom while exposure changes.
// Same 400×250 fixture as the other post tests; no app or physics fixture.
test('reuse', async () => {
  home(camera);
  setPost({ taa: true, bloom: 0.12, adapt: true, meter: false });
  post.reset();
  gpu.write(post.adaptationBuffer, 0, new Float32Array(4));
  const hooks = sceneHooks({ mode: 'fill', fill: [0.004, 0.004, 0.004, 1] });
  for (let i = 0; i < 9; i++) frame(hooks);
  await gpu.fence();
  await gpu.readback.idle();
  const readState = async () => Array.from(new Float32Array(await gpu.readback.buffer(post.adaptationBuffer)));
  const before = await readState();
  const color = post.targets.resolved, bloom = post.targets.bloom;
  const oldColor = await gpu.readback.texture(color), oldBloom = await gpu.readback.texture(bloom);
  const projection = [...camera.projectionMatrix.elements], jitter = [...post.jitter];
  const reusable = post.canReuse(camera);
  const beforeStats = { ...gpu.stats };
  const frozen = post.render(null, camera, null, 0, { postOnly: true });
  gpu.endFrame();
  const stats = Object.fromEntries(Object.entries(gpu.stats).map(([k, v]) => [k, v - beforeStats[k]]));
  const sameState = await readState();
  const newColor = await gpu.readback.texture(color), newBloom = await gpu.readback.texture(bloom);
  const changedBytes = (a, b) => {
    const aa = new Uint8Array(a), bb = new Uint8Array(b);
    let n = Math.abs(aa.length - bb.length);
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) n++;
    return n;
  };
  const advanced = post.render(null, camera, null, 1 / 60, { postOnly: true });
  gpu.endFrame();
  const after = await readState();
  const cameraUnchanged = JSON.stringify(projection) === JSON.stringify(camera.projectionMatrix.elements)
    && JSON.stringify(jitter) === JSON.stringify(post.jitter);
  camera.position.x += 0.02;
  const invalidated = !post.canReuse(camera)
    && !post.render(null, camera, null, 1 / 60, { postOnly: true });
  frame(sceneHooks()); // Real TAA continues after the retained frame.
  const resumed = post.canReuse(camera);
  post.reset();
  const resetInvalidated = !post.canReuse(camera);
  await gpu.fence();
  await gpu.readback.idle();
  home(camera);
  return { reusable, frozen, advanced, before, sameState, after, stats,
    colorChangedBytes: changedBytes(oldColor, newColor), bloomChangedBytes: changedBytes(oldBloom, newBloom),
    cameraUnchanged, invalidated, resumed, resetInvalidated, failures: [...h.failures] };
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

// bytes as base64 (the tool decodes; JSON arrays of this size are slow)
function b64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

// The plane over the sky through the whole chain (TAA, bloom, sharpening; the
// adaptation gain held at 1 unless settings say otherwise), after `frames`
// frames: post's own textures of the last frame (the resolved frame TAA wrote,
// every bloom level, as half bits) and the canvas it composited, for the tool to
// recompute each step in JS from the step before.
test('chain', async ({ settings = {}, frames = 8 } = {}) => {
  setPost({ adapt: false, ...settings });
  home(camera);
  for (let k = 1; k < frames; k++) frame(sceneHooks());
  post.render(sceneHooks(), camera);
  const cap = post.capture();
  const t = post.targets;
  const level = async (x) => ({ w: x.width, h: x.height, bits: b64(bytesOf(await gpu.readback.texture(x))) });
  const reads = { history: level(t.resolved), down: t.down.map(level), up: t.up.map(level) };
  gpu.endFrame();
  const { width, height, data } = await cap;
  return {
    history: await reads.history, down: await Promise.all(reads.down), up: await Promise.all(reads.up),
    canvas: { w: width, h: height, rgba: b64(data) }, settings: { ...POST_DEFAULTS, ...post.settings },
  };
});

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
  const before = await readHalf(post.targets.resolved);
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
  const after = await readHalf(post.targets.resolved);
  target.destroy();
  let covered = 0, clear = 0, partial = 0, colourInClear = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 255) covered++;
    else if (px[i + 3] === 0) { clear++; if (px[i] || px[i + 1] || px[i + 2]) colourInClear++; }
    else partial++;
  }
  return { covered, clear, partial, colourInClear, historyKept: difference(before, after).rgb === 0, stats };
});

// Resizes inside one task: two stills of different sizes, a frame into a
// 200×120 target and one into the canvas, then one flush. Each resize destroys
// textures the open encoder's commands use; post flushes before it does, so
// the submits stay valid. Returns the GPU failure (null) and the second still's
// coverage.
test('resize', async () => {
  setPost({});
  home(camera);
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
  const mk = (w, h) => gpu.createTexture({ label: `resize ${w}×${h}`, size: [w, h], format: 'rgba8unorm', usage });
  const a = mk(320, 200), b = mk(160, 100), c = mk(200, 120);
  const before = { ...gpu.stats };
  post.renderStill(sceneHooks(), camera, a);
  post.renderStill(sceneHooks(), camera, b);
  post.render(sceneHooks(), camera, c);
  post.render(sceneHooks(), camera);
  const px = gpu.readback.texture(b);
  gpu.endFrame();
  await gpu.fence();
  const bytes = await px;
  let covered = 0;
  for (let i = 3; i < bytes.length; i += 4) if (bytes[i] === 255) covered++;
  await tick();
  [a, b, c].forEach((t) => t.destroy());
  return { failure: gpu.failure ? String(gpu.failure.message ?? gpu.failure) : null, submits: gpu.stats.flushes - before.flushes, covered, pixels: bytes.length / 4, size: post.size };
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
// The meter with adaptation off, so the reduction is dispatched only for it:
// over 8 frames (each awaited, so its reading lands) it runs every
// METER_INTERVAL (4) frames, in the same compute pass; returns a metered
// frame's stats, how many of the 8 metered, an unmetered frame's dispatches
// and post.sceneLuma after.
test('budget:meter', async () => {
  setPost({ meter: true, adapt: false });
  home(camera);
  post.sceneLuma = null;
  for (let k = 0; k < 2; k++) frame(sceneHooks());
  await gpu.fence(); await gpu.readback.idle(); await tick();
  const all = [];
  for (let k = 0; k < 8; k++) {
    all.push(await measure(gpu, async () => { frame(sceneHooks()); await tick(); }));
    await gpu.fence(); await gpu.readback.idle(); await tick();
  }
  const metered = all.filter((st) => st.dispatches === 10), plain = all.filter((st) => st.dispatches !== 10);
  const out = { stats: metered[0] ?? all[0], metered: metered.length, unmeteredDispatches: plain[0]?.dispatches ?? null, sceneLuma: post.sceneLuma };
  setPost({ meter: false });
  return out;
});

// ---------------------------------------------------------------- FrameUniforms and E1 (B3)

// A FrameUniforms stand-in (a SharedUniforms: its writes flush when the open
// encoder already reads it) and an E1 kernel that reads it, as shadow and GI
// read FrameUniforms: it stores the jitter, pixScale and the jittered
// projection's [2][0] (−2·jx/w) it saw.
const FrameTest = uniformStruct('FrameTest', { proj: 'mat4x4f', jitter: 'vec2f', pixScale: 'f32' });
const frameU = gpu.uniforms(FrameTest, 'FrameTest');
const seenBuf = gpu.createBuffer({ label: 'frame seen', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
const frameLayout = gpu.layout('TEST_FRAME_READ', [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
]);
const frameKernel = gpu.kernel({
  name: 'testFrameRead', layouts: [, , frameLayout], workgroupSize: [1, 1, 1], code: /* wgsl */ `
${FrameTest.wgsl}
@group(2) @binding(0) var<uniform> FT: FrameTest;
@group(2) @binding(1) var<storage, read_write> seen: array<f32, 4>;
@compute @workgroup_size(1) fn main() {
  seen[0] = FT.jitter.x; seen[1] = FT.jitter.y; seen[2] = FT.pixScale; seen[3] = FT.proj[2][0];
}
`,
});
const frameGroup = gpu.bindGroup(frameLayout, [{ binding: 0, resource: { buffer: frameU.buffer } }, { binding: 1, resource: { buffer: seenBuf } }]);
await frameKernel.ready;
const e1 = () => frameKernel.dispatch(gpu.frame, [1, 1, 1], { bind: [, , frameGroup] });
const writeFrame = (p) => frameU.write({ proj: camera.projectionMatrix, jitter: p.jitter, pixScale: p.inSize[0] / p.size[0] });

// One presented frame with an E1 FrameUniforms reader. route 'hooks': the
// write in prepare(), the reader in compute() (the documented route). route
// 'before' (the control): the reader recorded before render(), the write in
// prepare(): the write must flush, and the reader sees the frame before's values.
test('frameUniforms', async ({ route = 'hooks', upscale = 1 } = {}) => {
  setPost({ upscale });
  home(camera);
  const base = sceneHooks();
  const hooks = { ...base, prepare(p) { base.prepare(p); writeFrame(p); } };
  for (let k = 0; k < 2; k++) frame({ ...hooks, compute: e1 });
  await gpu.fence();
  const stats = await measure(gpu, async () => {
    if (route === 'before') e1();
    frame(route === 'hooks' ? { ...hooks, compute: e1 } : hooks);
    await tick();
  });
  const seen = Array.from(new Float32Array(await gpu.readback.buffer(seenBuf)));
  return { stats, seen, jitter: post.jitter, inSize: post.inSize, size: post.size };
});

// The start menu's warm-up (B5) from WGSL_CHECK alone, written here without
// post.js's helpers: every entry built with its layouts made under
// layoutNames. On this page createPost has built its pipelines already, so a
// warm-up that describes them exactly creates none (the pipeline cache keys on
// module, layout objects and descriptor). control: the layouts under other
// names, which must miss the cache.
test('warm', async ({ control = false } = {}) => {
  const before = { ...gpu.stats };
  const pipes = WGSL_CHECK.map((e) => {
    const groups = e.layouts(null);
    const layouts = e.layoutNames.map((name, i) => (name ? gpu.layout(control ? `WARM_${name}` : name, groups[i]) : undefined));
    const desc = { name: `warm ${e.name}`, code: e.code(null), layouts, params: e.params, constants: e.constants };
    return e.kind === 'render'
      ? gpu.renderPipeline({ ...desc, vertex: e.vertex, fragment: e.fragment, primitive: e.primitive, depthStencil: e.depthStencil })
      : gpu.kernel({ ...desc, entry: e.entry, workgroupSize: e.workgroupSize });
  });
  await Promise.all(pipes.map((p) => p.ready));
  return { entries: WGSL_CHECK.length, created: gpu.stats.pipelinesCreated - before.pipelinesCreated, ready: pipes.every((p) => p.state === 'ready') };
});
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

// ---------------------------------------------------------------- three's meshes in the scene target (?three=1)

// A red box in front of the plane and a green one behind it, drawn by three into
// post's scene target after our scene pass (loadOp load, our depth): the red one
// shows, the green one doesn't (F1). TAA off for the pixel test, then a few TAA
// frames (the meshes jitter with the scene: three reads the projection post set).
test('meshes', async () => {
  if (!three) return { error: 'open the page with ?three=1' };
  setPost({ taa: false, bloom: 0, adapt: false });
  home(camera);
  const meshScene = new Scene();
  const box = (color, x, y, z) => { const m = new Mesh(new BoxGeometry(0.8, 0.8, 0.8), new MeshBasicNodeMaterial({ color })); m.position.set(x, y, z); meshScene.add(m); return m; };
  const red = box(0xff0000, -1.2, 0.5, 0.6), green = box(0x00ff00, 1.2, -0.5, -0.8);
  meshScene.updateMatrixWorld();
  await three.compileAsync(meshScene, camera);
  const at = (o) => { const v = o.position.clone().project(camera); return [Math.round((v.x * 0.5 + 0.5) * W), Math.round((0.5 - v.y * 0.5) * H)]; };
  const points = [at(red), at(green)];
  const pixels = async (meshes) => {
    const hooks = { ...sceneHooks(), meshes: meshes ? (p) => { three.setRenderTarget(p.sceneTarget.rt); three.render(meshScene, camera); three.setRenderTarget(null); } : undefined };
    const stats = await measure(gpu, async () => {
      post.render(hooks, camera);
      h.cap = post.capture();
      gpu.endFrame();
      await gpu.fence();
    });
    const { width, data } = await h.cap;
    return { stats, values: points.map(([x, y]) => Array.from(data.subarray(4 * (y * width + x), 4 * (y * width + x) + 4))) };
  };
  const without = await pixels(false);
  const withMeshes = await pixels(true);
  setPost({ taa: true, bloom: 0.3, adapt: true });
  for (let k = 0; k < 8; k++) await pixels(true);
  const taa = await pixels(true);
  meshScene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  return {
    points, visible: threeHasVisible(meshScene, camera), rtIsThree: Boolean(post.sceneTarget.rt),
    without: without.values, with: withMeshes.values, taa: taa.values, stats: withMeshes.stats, taaStats: taa.stats,
  };
});

// Three frames on the existing pattern: disabled, launch, full speed. No world simulation.
test('sprintBlurPacked', async () => {
  const d = gpu.device, shader = compositeWGSL();
  // Exercise the production radiance helper, not a second implementation.
  const common = shader.slice(shader.indexOf('const MAX_RADIANCE:'), shader.indexOf('// Soft-knee bright pass'));
  const module = d.createShaderModule({ code: `${common}
    @group(0) @binding(0) var src: texture_2d<f32>;
    @group(0) @binding(1) var smp: sampler;
    @group(0) @binding(2) var<storage, read_write> result: vec4f;
    @compute @workgroup_size(1) fn main() { result = tapRadiance(src, smp, vec2f(0.5), 1u); }` });
  const pipe = await d.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const tex = d.createTexture({ size: [2, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const out = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    d.queue.writeTexture({ texture: tex }, new Uint16Array([100 / 101, 0, 0, 1, 0, 0, 0, 1].map(toHalf)), { bytesPerRow: 16 }, [2, 1]);
    const group = d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: tex.createView() }, { binding: 1, resource: d.createSampler({ minFilter: 'linear', magFilter: 'linear' }) },
      { binding: 2, resource: { buffer: out } },
    ] });
    const enc = d.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    enc.copyBufferToBuffer(out, 0, read, 0, 16); d.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const value = Array.from(new Float32Array(read.getMappedRange()));
    read.unmap();
    return value; // half-way between radiance 100 and 0 is ~50, not ~1
  } finally { tex.destroy(); out.destroy(); read.destroy(); }
});

test('sprintBlur', async () => {
  home(camera);
  setPost({ taa: false, bloom: 0, adapt: false, sharpen: 0 });
  const capture = async (amount, viewmodel = null, mode = 'plane') => {
    post.settings.sprintBlur = amount;
    post.render(sceneHooks({ mode, fill: [0.3, 0.2, 0.1, 1] }), camera, null, 1 / 60, { viewmodel });
    const cap = post.capture();
    gpu.endFrame();
    return (await cap).data;
  };
  const off = await capture(0), low = await capture(0.04), full = await capture(1);
  const compare = (a, b) => {
    let center = 0, edge = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const radius = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) / Math.min(W, H);
      const i = (y * W + x) * 4;
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (radius < 0.15) center = Math.max(center, delta);
      if (radius > 0.3) { edge += delta; n++; }
    }
    return { center, edge: edge / n };
  };
  const flat = compare(await capture(0, null, 'fill'), await capture(1, null, 'fill'));
  const vm = solid([0.2, 0.1, 0.05, 1]);
  let hands;
  try { hands = compare(await capture(0, vm), await capture(1, vm)); }
  finally { vm.destroy(); }
  await capture(1);   // leave the streaked pattern on screen for the visual checkpoint
  return { low: compare(off, low), full: compare(off, full), flat, hands };
});

ready();
log('ready');
