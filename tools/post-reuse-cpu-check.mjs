// CPU only: real post recorder, fake GPU/temporal; no shader execution or browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerspectiveCamera, WebGPUCoordinateSystem } from 'three';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createPost, WGSL_CHECK, reduceWGSL, ADAPT } from '../src/gfx/post.js';
import { createPacer } from '../src/gfx/pacing.js';
import { canPostFrame } from '../src/gfx/postFrames.js';

for (const entry of WGSL_CHECK) new WgslReflect(entry.code());
const shader = reduceWGSL();
assert.match(shader, /P.adapt != 0u && P.reuseTarget == 0u/);
assert.match(shader, /var aim = state.aim;[\s\S]*var view = state.view;[\s\S]*if \(P.reuseTarget == 0u\)/);
assert.match(shader, /g \+= \(aim - g\) \* \(1.0 - exp\(-P.dt \/ tau\)\)/);

const calls = [];
const texture = ({ label = '', size = [64, 32], format = 'rgba16float' } = {}) => ({
  label, width: size[0], height: size[1], format, createView() { return { texture: this }; }, destroy() {},
});
let gain = 1, aim = 16, target = 16, histograms = 0;
const pipe = (desc) => ({ state: 'ready', ready: Promise.resolve(),
  draw(_pass, args) { calls.push({ name: desc.name, params: args?.params }); },
  dispatch(_frame, _size, args) {
    calls.push({ name: desc.name, params: args.params });
    if (desc.name !== 'postReduce') return;
    if (!args.params.reuseTarget) { aim = target; histograms++; }
    const tau = aim > gain ? ADAPT.TAU_DARK : ADAPT.TAU_LIGHT;
    gain += (aim - gain) * (1 - Math.exp(-args.params.dt / tau));
    if (Math.abs(gain - aim) <= ADAPT.SETTLED * aim) gain = aim;
  },
});
const gpu = {
  device: { createSampler: () => ({}) }, layout: (label) => ({ label }),
  renderPipeline: pipe, kernel: pipe, createTexture: texture,
  createBuffer: () => ({ destroy() {} }), bindGroup: () => ({}), flush() {},
  readback: { ring: () => ({ buffer: {}, next: () => 0, read: async () => {
    const bytes = new ArrayBuffer(32);
    new Float32Array(bytes).set([gain, aim, -9]);
    new Uint32Array(bytes)[5] = 1;
    return bytes;
  } }) },
  frame: { render(_desc, name) { calls.push({ name: `pass:${name}` }); return { end() {} }; },
    compute(name) { calls.push({ name: `pass:${name}` }); } },
};
const presenter = { canvas: { width: 64, height: 32 }, format: 'rgba8unorm', hdrActive: false,
  texture: () => texture({ size: [presenter.canvas.width, presenter.canvas.height] }), attachment: () => ({}) };
const temporal = {
  currentWeight: 0.025, jitter: () => [0, 0], unjitter() {},
  inputs: () => ({ velocity: texture(), color: texture() }),
  resolve() { calls.push({ name: 'temporal.resolve' }); return texture(); }, dispose() {},
};
const presentation = { key: 'flat', active: false, worldToScene: new PerspectiveCamera().matrixWorld, dispose() {} };
const camera = new PerspectiveCamera(); camera.coordinateSystem = WebGPUCoordinateSystem;
const post = createPost(gpu, { presenter, temporal, presentation });
await post.ready;
const hooks = Object.fromEntries(['prepare', 'compute', 'opaque', 'draw', 'meshes', 'overlay'].map((k) => [k, () => { calls.push({ name: `hook:${k}` }); }]));
const names = () => calls.map((c) => c.name);
async function full(extra = {}) {
  calls.length = 0;
  assert.equal(post.render(hooks, camera, null, 1 / 60, extra), true);
  assert(names().includes('hook:draw'));
  assert(names().includes('temporal.resolve'));
  assert(names().includes('pass:prefilter'));
  await new Promise((resolve) => setImmediate(resolve));
}
await full();
assert(post.adapting);
assert(post.canReuse(camera));
const color = post.targets.resolved, bloom = post.targets.bloom;
const initialHistograms = histograms;
for (let i = 0; i < 4; i++) {
  calls.length = 0;
  assert.equal(post.render(hooks, camera, null, 1 / 60, { postOnly: true }), true);
  assert.deepEqual(names(), ['pass:post', 'postReduce', 'pass:canvas', 'composite rgba8unorm']);
  assert.equal(calls.find((c) => c.name === 'postReduce').params.reuseTarget, true);
  assert.equal(post.targets.resolved, color); assert.equal(post.targets.bloom, bloom);
  await new Promise((resolve) => setImmediate(resolve));
}
assert.equal(histograms, initialHistograms);
assert(gain > 1 && gain < aim);
// CPU dispatch emulation follows the unchanged exponential rule in WGSL.
let guard = 0;
while (post.adapting && guard++ < 1000) {
  assert(post.render(null, camera, null, 1 / 60, { postOnly: true }));
  await new Promise((resolve) => setImmediate(resolve));
}
assert.equal(gain, aim); assert.equal(post.adapting, false);
assert(guard < 1000);

async function invalidation(name, change, undo = () => {}) {
  await full(); change(); calls.length = 0;
  assert.equal(post.render(hooks, camera, null, 1 / 60, { postOnly: true }), false, name);
  assert.deepEqual(calls, [], `${name}: rejected reuse records no commands`);
  // The app performs this full fallback in the same tick.
  assert(post.render(hooks, camera, null, 1 / 60));
  assert(names().includes('hook:draw'), `${name}: geometry restored`);
  undo();
}
await invalidation('camera position', () => camera.position.x++, () => camera.position.x--);
await invalidation('camera projection', () => { camera.fov++; camera.updateProjectionMatrix(); }, () => { camera.fov--; camera.updateProjectionMatrix(); });
await invalidation('canvas', () => presenter.canvas.width++, () => presenter.canvas.width--);
await invalidation('presentation', () => presentation.key = 'curved', () => presentation.key = 'flat');
await invalidation('HDR output', () => presenter.hdrActive = true, () => presenter.hdrActive = false);
await invalidation('temporal reset', () => post.reset());
for (const [key, value] of Object.entries({ bloom: 0, bloomThreshold: 3, bloomKnee: 0.7, bloomScatter: 0.1,
  upscale: 0.5, resolutionScale: 0.8, adaptive: true, raw: true, night: 1, meter: true, adapt: false })) {
  const was = post.settings[key];
  await invalidation(`setting ${key}`, () => post.settings[key] = value, () => post.settings[key] = was);
}
await full();
for (const extra of [{ viewmodel: texture() }, { glow: texture() }]) {
  calls.length = 0;
  assert.equal(post.render(null, camera, null, 1 / 60, { ...extra, postOnly: true }), false);
  assert.deepEqual(calls, []);
  await full(extra);
  assert.equal(post.canReuse(camera), false, 'animated composite targets never retained');
  await full();
}
const was = post.settings.exposure;
post.settings.exposure = was + 1;
assert(post.canReuse(camera), 'composite-only exposure does not invalidate the images');
calls.length = 0;
assert(post.render(null, camera, null, 1 / 60, { postOnly: true }));
assert.equal(calls.find((c) => c.name === 'composite rgba8unorm').params.exposure, 2 ** (was + 1));
post.settings.exposure = was;
// A new histogram target (light, from dark) resumes full reduction, then adapts
// against that new target without re-metering the saved image.
target = 1; await full();
const oldGain = gain;
assert(post.render(null, camera, null, 1 / 60, { postOnly: true }));
assert(gain < oldGain && aim === 1);
await full();
calls.length = 0;
assert.equal(post.render(null, camera.clone(), null, 1 / 60, { postOnly: true }), false, 'camera identity');
assert.equal(post.render(null, camera, texture(), 1 / 60, { postOnly: true }), false, 'offscreen target');
assert.deepEqual(calls, []);
post.settings.taa = false;
post.settings.bloom = 0;
calls.length = 0;
assert(post.render(hooks, camera));
assert(!names().includes('temporal.resolve'));
assert(!names().includes('pass:prefilter'));
calls.length = 0;
assert(post.render(null, camera, null, 1 / 60, { postOnly: true }), 'non-TAA fallback still reusable');
assert.deepEqual(names(), ['pass:post', 'postReduce', 'pass:canvas', 'composite rgba8unorm']);

const stable = { renderOnly: false, runView: false, runDerived: false, settled: true,
  viewChanged: false, worldChanged: false, meshesMoved: false, pointerDirty: false,
  painting: false, povActive: false, busy: false };
assert(canPostFrame(stable));
for (const k of Object.keys(stable)) {
  assert.equal(canPostFrame({ ...stable, [k]: !stable[k] }), false, `app invalidation ${k}`);
}
const pacer = createPacer({ derivedSettle: 2, viewSettle: 8 });
let fullFrames = 0;
for (let i = 0; i < 32; i++) {
  const runDerived = pacer.derived('state');
  const runView = pacer.view('view', runDerived); // NOT forced by adaptation
  if (runView) fullFrames++;
  if (i >= 9) assert(canPostFrame({ ...stable, runDerived, runView, settled: pacer.settled }));
}
assert.equal(fullFrames, 9, 'derived and TAA retain full convergence frames');
pacer.wake(); assert(pacer.view('view', false), 'wake restores full draws');
assert(pacer.view('new camera/world/settings key', false), 'key changes restore full draws');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(app, /pacer.view\(viewV, runDerived \|\| wantFrame\(\) \|\| betweenTicks\)/);
assert.match(app, /if \(runView && !postOnly\)/);
assert.match(app, /pointerPickDirty \|\| \(!postOnly && \(runView \|\| pov\?\.active \|\| testMode === 'preview'\)\)/);
assert.match(app, /wantFrame\(\) \|\| post.adapting/); // deep idle cannot stop moving exposure
post.dispose();
console.log('PASS: post-only records adaptation+composite only; image/pacing/pick invalidations restore full draws; WGSL static reflection passed. CPU emulation only, no GPU timings.');
