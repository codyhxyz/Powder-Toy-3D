// CPU only: Naga validation, WGSL viewport math, and real post recording into a fake GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PerspectiveCamera, WebGPUCoordinateSystem } from 'three/webgpu';
import { computeHaltonOffsets } from 'three/addons/tsl/utils/TAAUtils.js';
import { WgslExec, WgslParser, WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { nativeTaauWGSL, taauJitter, WGSL_CHECK as TAA_SHADERS } from '../src/gfx/nativeTaau.js';
import { createPost, postSizes, UPSCALE, WGSL_CHECK as POST_SHADERS } from '../src/gfx/post.js';
import { AUTO_RES, levelScale } from '../src/gfx/autoResolution.js';

const naga = (name, code) => {
  const r = spawnSync(process.env.NAGA ?? 'naga', ['--stdin-file-path', `${name}.wgsl`], { input: code, encoding: 'utf8' });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${name}: ${r.stdout}\n${r.stderr}`);
};
const sources = new Set();
for (const e of [...TAA_SHADERS, ...POST_SHADERS]) {
  const code = e.code();
  if (sources.has(code)) continue;
  sources.add(code);
  naga(e.name, code);
  const reflection = new WgslReflect(code);
  for (const [group, layout] of e.layouts().entries()) {
    const actual = reflection.getBindGroups()[group] ?? [];
    if (layout) for (const resource of actual.filter(Boolean)) assert(layout.some(binding => binding.binding === resource.binding));
  }
}

const offsets = computeHaltonOffsets(32).map(pair => pair.map(n => n - 0.5));
assert.equal(new Set(offsets.map(String)).size, 32);
for (let i = 0; i < 64; i++) assert.deepEqual(taauJitter(i), offsets[i % 32]);
for (const axis of [0, 1]) {
  const samples = offsets.map(pair => pair[axis]);
  assert(samples.every(n => n >= -0.5 && n < 0.5));
  assert(Math.abs(samples.reduce((sum, n) => sum + n, 0) / samples.length) < 0.04);
  for (let i = 0; i < 4; i++) assert(samples.filter(n => n >= i / 4 - 0.5 && n < (i + 1) / 4 - 0.5).length >= 6);
}

function recordingGpu() {
  const counts = { allocations: 0, destructions: 0, flushes: 0, copies: 0, groups: 0 };
  const log = [];
  let active = null;
  const pipe = ({ name, params }) => ({ state: 'ready', ready: Promise.resolve(),
    draw(rp, opts) {
      assert.equal(rp, active);
      params?.pack(opts.params); // same uniform serializer as a real draw
      log.push({ name, pass: rp, ...opts });
    },
    dispatch(_frame, _size, opts) { params.pack(opts.params); log.push({ name, ...opts }); },
  });
  return {
    counts, log, device: { createSampler: () => ({}) }, queue: { onSubmittedWorkDone: async () => {} },
    layout: (label) => ({ label }), bindGroup: (_, entries) => { counts.groups++; return entries; },
    renderPipeline: pipe, kernel: pipe, createBuffer: () => ({ destroy() {} }),
    readback: { ring: () => ({ buffer: {}, next: () => 0, read: () => new Promise(() => {}) }) },
    createTexture({ label, size: [width, height], format, usage }) {
      counts.allocations++;
      return { label, width, height, format, usage, createView() { return { texture: this }; },
        destroy() { assert(!this.destroyed); this.destroyed = true; counts.destructions++; } };
    },
    frame: {
      render(desc, name) {
        assert.equal(active, null);
        active = { name, desc, setViewport(...v) { this.viewport = v; }, setScissorRect(...r) { this.scissor = r; },
          end() { assert.equal(active, this); active = null; } };
        log.push(active);
        return active;
      },
      compute() { assert.equal(active, null); },
      direct() { counts.copies++; throw new Error('unexpected direct/copy command'); },
    },
    flush() { counts.flushes++; },
  };
}

const gpu = recordingGpu();
const alloc = [941, 607];
const [width, height] = alloc;
const presenter = { canvas: { width, height }, format: 'rgba8unorm',
  texture: () => ({ width, height }), attachment: () => ({ view: {} }) };
const post = createPost(gpu, { presenter });
await post.ready;
Object.assign(post.settings, { upscale: UPSCALE.quality, adapt: true, bloom: 0.3 });
const camera = new PerspectiveCamera(45, 1.51, 0.1, 100);
camera.coordinateSystem = WebGPUCoordinateSystem;
camera.updateProjectionMatrix();
const original = camera.projectionMatrix.clone(), inverse = camera.projectionMatrixInverse.clone();
const resetCamera = () => {
  assert.equal(camera.view, null);
  assert(camera.projectionMatrix.equals(original));
  assert(camera.projectionMatrixInverse.equals(inverse));
  assert.equal(camera.aspect, 1.51);
};
const assertViewport = (pass, dims) => {
  assert.deepEqual(pass.viewport, [0, 0, ...dims, 0, 1]);
  assert.deepEqual(pass.scissor, [0, 0, ...dims]);
};
const hooks = {
  draw(rp, p) {
    if (p.inSize.some((n, i) => n !== p.allocSize[i])) assertViewport(rp, p.inSize);
    assert.equal(p.sceneTarget.width, p.inSize[0]);
    assert.equal(p.sceneTarget.color.width, p.allocSize[0]);
    post.withoutJitter(() => assert(camera.projectionMatrix.equals(original)));
  },
  overlay(rp, p) { if (p.inSize.some((n, i) => n !== p.allocSize[i])) assertViewport(rp, p.inSize); },
};
const render = () => {
  gpu.log.length = 0;
  assert(post.render(hooks, camera));
  resetCamera();
  const resolve = gpu.log.find(e => e.name === 'nativeTaau');
  assert(resolve);
  return resolve;
};

const taaParams = TAA_SHADERS[0].params;
const shaderProbe = `${taaParams.wgsl}
@group(3) @binding(1) var<uniform> P: TaauParams;
${nativeTaauWGSL().match(/fn inputUV\([^]*?\n\}/)[0]}
@group(0) @binding(0) var<storage, read_write> result: array<vec2f>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id: vec3u) {
  result[id.x] = inputUV(vec2f(f32(id.x) * 0.5 - 0.5));
}`;
naga('taau-viewport-probe', shaderProbe);
const exec = new WgslExec(new WgslParser().parse(shaderProbe));
const approx = (a, b, tol = 1e-4) => assert(Math.abs(a - b) <= tol, `${a} != ${b}`);
function checkClamp(p) {
  const result = new Float32Array(10);
  exec.dispatchWorkgroups('probe', [5], { 0: { 0: result }, 3: { 1: taaParams.pack(p) } });
  for (const i of [0, 1]) for (let j = 0; j < 5; j++) {
    const uv = j * 0.5 - 0.5;
    const texel = result[j * 2 + i] * p.allocSize[i] - 0.5;
    const hi = p.inSize[i] - 1;
    approx(texel, Math.min(hi, Math.max(0, uv * p.inSize[i] - p.jitter[i] - 0.5)));
    assert(texel >= -1e-4 && texel <= hi + 1e-4);
  }
}

let resolve = render();
assert.equal(resolve.params.reset, true);
assert.deepEqual(post.jitter, offsets[0]);
const baseline = { ...gpu.counts };
const { scene, depth } = post.targets;
const historyRevision = post.historyRevision;
const motion = gpu.log.find(e => e.name === 'motion' && e.desc).desc.colorAttachments.map(e => e.view.texture);
assert.deepEqual(motion.map(t => [t.width, t.height]), [alloc, alloc]);
const clear = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'groups'));
for (let k = 1; k <= AUTO_RES.LEVELS; k++) {
  const previous = post.temporal.view;
  post.settings.resolutionScale = levelScale(k);
  resolve = render();
  const { inSize } = postSizes(width, height, post.renderScale);
  assert.deepEqual(post.inSize, inSize);
  assert.deepEqual(post.allocSize, alloc);
  assert.deepEqual(post.uvScale, inSize.map((n, i) => n / alloc[i]));
  assert.deepEqual(resolve.params.inSize, inSize);
  assert.deepEqual(resolve.params.uvScale, post.uvScale);
  assert.equal(resolve.params.reset, false, 'DRS must preserve history');
  assert.equal(post.historyRevision, historyRevision);
  assert.equal(post.targets.scene, scene); assert.equal(post.targets.depth, depth);
  assert.equal(resolve.bind[2][3].resource, previous, 'read previous ping-pong texture');
  assert.notEqual(previous, post.temporal.view);
  assert.equal(resolve.pass.desc.colorAttachments[0].view, post.temporal.view);
  assert.equal(post.temporal.texture, post.targets.resolved);
  const mp = gpu.log.find(e => e.name === 'motion' && e.desc);
  assertViewport(mp, inSize);
  assert.deepEqual(mp.desc.colorAttachments.map(e => e.view.texture), motion);
  assert.deepEqual(post.jitter, offsets[k]);
  checkClamp(resolve.params);
  assert.deepEqual(clear(gpu.counts), clear(baseline));
  assert(gpu.counts.groups <= baseline.groups + 4, 'only the alternate resolve/prefilter/reduce/composite groups');
}
checkClamp({ inSize: [1, 1], allocSize: alloc, uvScale: alloc.map(n => 1 / n), jitter: offsets[4] });
assert.equal(gpu.counts.flushes, 0);
assert(post.canReuse(camera));
gpu.log.length = 0;
assert(post.render(hooks, camera, null, 0, { postOnly: true }));
assert(!gpu.log.some(e => ['scene', 'motion', 'nativeTaau', 'prefilter'].includes(e.name)));
assert.deepEqual(clear(gpu.counts), clear(baseline));

post.reset();
resolve = render();
assert.equal(resolve.params.reset, true);
post.settings.taa = false;
gpu.log.length = 0;
assert(post.render(hooks, camera));
assert.deepEqual(post.inSize, alloc);
const prefilter = gpu.log.find(e => e.name === 'prefilter' && e.params);
assert.deepEqual(prefilter.params.srcSize, alloc);
assert.equal(prefilter.params.packed, false);
assert.deepEqual(clear(gpu.counts), clear(baseline));

// Resize only the viewport in a reused staged slot, and check its recorded
// dimensions survive the deferred admission (no scale round-trip through x).
Object.assign(post.settings, { taa: true, adapt: false, resolutionScale: 0.71 });
const target = gpu.createTexture({ label: 'output', size: alloc, format: 'rgba8unorm' });
const identity = { epoch: 1, sceneToken: {}, configVersion: 1 };
const feedbackIdentity = {};
const submission = { submitted: Promise.resolve() };
let released = 0;
const record = () => post.recordScene(hooks, camera, { target, identity, feedbackIdentity, submission, publication: { release() { released++; } } });
const admit = async (ticket) => {
  await submission.submitted;
  assert(post.commitScene(ticket, { target, feedbackIdentity, submission, feedback: { incomplete: false } }));
  assert(await ticket.confirmation);
  await ticket.completion;
};
let ticket = record(); resetCamera(); await admit(ticket);
const stageBaseline = clear(gpu.counts);
post.settings.resolutionScale = 0.66;
gpu.log.length = 0;
ticket = record(); resetCamera(); await admit(ticket);
assert.equal(released, 2);
assert.deepEqual(clear(gpu.counts), stageBaseline);
resolve = gpu.log.find(e => e.name === 'nativeTaau');
assert.deepEqual(resolve.params.inSize, postSizes(...alloc, post.renderScale).inSize);
assert.equal(resolve.params.reset, false);

const current = post.temporal.texture;
const still = gpu.createTexture({ label: 'thumbnail', size: [117, 59], format: 'rgba8unorm' });
assert(post.renderStill({ draw(_rp, p) {
  assert.deepEqual(p.inSize, [117, 59]);
  assert.deepEqual(p.allocSize, p.inSize);
  assert.deepEqual(p.jitter, [0, 0]);
} }, camera, still));
assert.equal(post.temporal.texture, current);
assert.deepEqual(post.allocSize, alloc);

// Use a real Three RenderTarget with mock GPU textures behind it. Its public
// viewport/scissor must update without reinitializing the target on DRS steps.
const bridge = recordingGpu(), nativeTextures = new WeakMap();
let initialized = 0;
bridge.three = { renderer: {
  _textures: { get: () => ({}) }, backend: { get: texture => ({ texture: nativeTextures.get(texture) }) },
  initRenderTarget(rt) {
    initialized++;
    for (const t of [rt.texture, rt.depthTexture]) nativeTextures.set(t,
      bridge.createTexture({ label: t.name, size: [rt.width, rt.height], format: t.isDepthTexture ? 'depth32float' : 'rgba16float' }));
  },
} };
const interop = createPost(bridge, { presenter });
interop.setSize(...alloc, 0.81);
const { rt } = interop.sceneTarget;
interop.setSize(...alloc, 0.54);
assert.equal(initialized, 1);
assert.deepEqual(rt.viewport.toArray(), [0, 0, ...interop.inSize]);
assert.deepEqual(rt.scissor.toArray(), [0, 0, ...interop.inSize]);
assert.deepEqual([rt.width, rt.height], alloc);
assert.equal(bridge.counts.flushes, 0);

const oldHistory = post.temporal.historyTextures;
post.setSize(width + 2, height + 2, post.renderScale);
assert.deepEqual(post.allocSize, [width + 2, height + 2]);
assert.equal(post.temporal.texture, null);
assert(oldHistory.every(t => t.destroyed));
assert(gpu.counts.allocations > stageBaseline.allocations);

console.log(`PASS: ${sources.size} WGSL modules validated by Naga and reflected; 32 Halton offsets; ${AUTO_RES.LEVELS} DRS steps with no texture churn, copies or flushes; viewport math, Three target, staged admission, stills and post-only reuse.`);
