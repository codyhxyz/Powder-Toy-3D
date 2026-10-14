// CPU only: source math, WGSL reflection/contracts, real recorder with a fake GPU.
import assert from 'node:assert/strict';
import { PerspectiveCamera, WebGPUCoordinateSystem } from 'three';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { POST_DEFAULTS, createPost, compositeWGSL, WGSL_CHECK } from '../src/gfx/post.js';
import { crueltyDisplayRGB, crueltyFrameSettings } from '../src/gfx/crueltyDisplay.js';

assert.equal(POST_DEFAULTS.cruelty, false);
const saved = Object.freeze({ ...POST_DEFAULTS, cruelty: true, exposure: 2, raw: true, bloom: 0.6, sharpen: 0.8 });
const effective = crueltyFrameSettings(saved);
assert.deepEqual([effective.bloom, effective.sharpen, effective.adapt, effective.exposure, effective.raw], [0, 0, false, 0, false]);
assert.equal(saved.exposure, 2);
assert.equal(crueltyFrameSettings({ ...saved, cruelty: false }).raw, true);
// floor rather than round; equal scalar noise on every channel, after quantization.
for (const time of [0, 0.125, 1, 12]) {
  for (const uv of [[0, 0], [0.1, 0.7], [0.999, 1]]) {
    const noise = crueltyDisplayRGB([0, 0, 0], uv, time)[0];
    assert(noise >= -0.002 && noise < 0.002);
    assert.equal(crueltyDisplayRGB([0, 0, 0], [uv[0], 99], time)[0], noise, 'source noise is independent of UV.y');
    const rgb = [15.999 / 255, 16 / 255, 1];
    const expected = [0, 16 / 255, 240 / 255];
    crueltyDisplayRGB(rgb, uv, time).forEach((c, i) => assert(Math.abs(c - noise - expected[i]) < 1e-14));
  }
}
for (const entry of WGSL_CHECK) new WgslReflect(entry.code());
const shader = compositeWGSL();
assert.match(shader, /floor\(rgb \* 255\.0 \/ 16\.0\) \* 16\.0 \/ 255\.0/);
assert.match(shader, /fract\(sin\(dot\(uv \+ vec2f\(time \* 5\.0, 0\.0\), vec2f\(5\.0, 0\.0\)\)\) \* 43758\.5453\)/);
assert.match(shader, /palette \+ vec3f\(\(2\.0 \* noise - 1\.0\) \* 0\.002\)/);
assert.match(shader, /if \(P.cruelty != 0u\) \{ return clamp\(c, vec3f\(0\.0\), vec3f\(1\.0\)\); \}/);
assert.match(shader, /if \(P.cruelty == 0u\) \{ o \+= \(ign - 0\.5\)/, 'no extra output dither');
const treatment = shader.indexOf('o = clamp(crueltyDisplay(o, uv, P.crueltyTime)');
for (const part of ['o += (1.0 - a) * sky(uv)', 'o = e2 * va', 'o += textureSampleLevel(tGlow']) {
  assert(shader.indexOf(part) < treatment, `${part} precedes fullscreen treatment`);
}
assert(treatment < shader.indexOf('return vec4f(o, a)'), 'alpha untouched, source applied before return');

const calls = [];
const texture = ({ label = '', size = [64, 32], format = 'rgba16float' } = {}) => ({
  label, width: size[0], height: size[1], format, createView() { return {}; }, destroy() {},
});
const pipe = (desc) => ({ state: 'ready', ready: Promise.resolve(),
  draw(_pass, args) { calls.push({ name: desc.name, params: args?.params }); },
  dispatch(_frame, _size, args) { calls.push({ name: desc.name, params: args.params }); },
});
const gpu = {
  device: { createSampler: () => ({}) }, layout: (label) => ({ label }),
  renderPipeline: pipe, kernel: pipe, createTexture: texture,
  createBuffer: () => ({ destroy() {} }), bindGroup: () => ({}), flush() {},
  readback: { ring: () => ({ buffer: {}, next: () => 0, read: async () => new ArrayBuffer(32) }) },
  frame: { render(_desc, name) { calls.push({ name: `pass:${name}` }); return { end() {} }; }, compute() {} },
};
const presenter = { canvas: { width: 64, height: 32 }, format: 'rgba16float', hdrActive: true,
  texture: () => texture(), attachment: () => ({}) };
const temporal = { currentWeight: 0.025, jitter: () => [0, 0], unjitter() {},
  inputs: () => ({ velocity: texture(), color: texture() }), resolve: () => texture(), dispose() {} };
const camera = new PerspectiveCamera(); camera.coordinateSystem = WebGPUCoordinateSystem;
const post = createPost(gpu, { presenter, temporal });
await post.ready;
const params = () => calls.findLast((c) => c.name === 'composite rgba16float').params;
const render = (dt = 0) => { calls.length = 0; assert(post.render(null, camera, null, dt)); return params(); };
render();
assert(post.canReuse(camera), 'baseline images reusable');
post.settings = saved;
assert(!post.canReuse(camera), 'mode flip must reject old frame');
let p = render(0.125);
assert.deepEqual([p.cruelty, p.exposure, p.bloom, p.sharpen, p.adapt, p.raw, p.peak], [true, 1, 0, 0, false, false, 1]);
assert(Math.abs(p.white - 1) < 1e-15);
assert.equal(p.crueltyTime, 0.125);
assert(!calls.some((c) => /bloom|prefilter|postReduce/.test(c.name)), 'no cinematic passes');
assert.deepEqual(calls.filter((c) => c.name.startsWith('pass:')).map((c) => c.name), ['pass:scene', 'pass:motion', 'pass:canvas'], 'no new fullscreen pass');
assert(!post.canReuse(camera), 'no adaptation image reuse in original mode');
const noiseTime = p.crueltyTime;
p = render(0);
assert.equal(p.crueltyTime, noiseTime, 'paused dt keeps noise stable');
const beforeStill = post.settings;
calls.length = 0;
assert(post.renderStill(null, camera, texture({ format: 'rgba8unorm' })));
const still = calls.findLast((c) => c.name === 'composite rgba8unorm').params;
assert.deepEqual([still.cruelty, still.exposure, still.adapt, still.raw, still.crueltyTime], [true, 1, false, false, noiseTime]);
assert.equal(post.settings, beforeStill, 'stills and frames never mutate saved settings');
post.settings = { ...saved, cruelty: false };
p = render();
assert.deepEqual([p.cruelty, p.exposure, p.raw], [false, 4, true], 'raw and saved EV restored');
post.settings.raw = false;
p = render();
assert.deepEqual([p.bloom, p.sharpen, p.adapt, p.peak], [0.6, 0.8, true, 3.2], 'cinematic controls/HDR restored');
post.dispose();
console.log('PASS cruelty source palette/noise, WGSL reflection/order, effective settings/restoration, image invalidation, paused dt and stills (CPU only).');
