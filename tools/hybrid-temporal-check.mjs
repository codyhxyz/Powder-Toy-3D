// CPU-only: numerical selection reference, WGSL reflection, real post command
// recorder with mocked GPU/three TAAU. Not shader execution or native GPU proof.
import assert from 'node:assert/strict';
import { PerspectiveCamera, WebGPUCoordinateSystem, Matrix4 } from 'three';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createPost, WGSL_CHECK, motionWGSL } from '../src/gfx/post.js';
import { temporalInputs, temporalReactiveAt, temporalMotionDecision as decide, createHybridTemporal } from '../src/gfx/hybrid/temporal.js';

assert.equal(decide(), 'camera', 'legacy/static fallback');
assert.equal(decide({ motion: [0, 0, 0] }), 'camera');
assert.equal(decide({ motion: [0.25, -0.5, 1] }), 'explicit');
assert.equal(decide({ motion: [-2, 2, 1] }), 'explicit', 'finite NDC limits');
for (const motion of [[0, 0, -1], [NaN, 0, 1], [0, Infinity, 1], [0, 0, NaN], [65536, 0, 1], [0, -2.01, 1]]) {
  assert.equal(decide({ motion }), 'reject', `invalid motion ${motion}`);
}
for (const reactive of [1 / 255, 1, Infinity, NaN, -Infinity]) {
  assert.equal(decide({ motion: [0.25, 0, 1], reactive }), 'reject', 'reactive wins over correspondence');
}
assert.equal(decide({ rejectUntracked: true }), 'reject');
assert.equal(decide({ motion: [0, 0, 0], rejectUntracked: true }), 'reject');
assert.equal(decide({ motion: [0.1, 0, 1], rejectUntracked: true }), 'explicit');
assert.equal(decide({ historyValid: false, motion: [0, 0, 1] }), 'reject', 'cut/reset wins over explicit motion');

let nextId = 0;
const texture = ({ label = '', size = [64, 32], format = 'rgba16float', ...extra } = {}) => ({
  id: ++nextId, label, width: size[0], height: size[1], format, usage: 20,
  createView() { return { texture: this }; }, destroy() { this.destroyed = true; }, ...extra,
});
const motion = texture(), reactive = texture({ format: 'r8unorm' });
assert.deepEqual(temporalInputs(null, [64, 32]), { motion: null, reactive: null, rejectUntracked: false });
assert.equal(temporalInputs({ motion, reactive }, [64, 32]).motion, motion);
for (const t of [texture({ size: [32, 32] }), texture({ format: 'rg16float' }), texture({ sampleCount: 4 }),
  texture({ dimension: '3d' }), texture({ depthOrArrayLayers: 2 }), texture({ usage: 16 })]) {
  assert.throws(() => temporalInputs({ motion: t }, [64, 32]), /temporal motion:/);
}
assert.throws(() => temporalInputs({ reactive: texture({ format: 'r32float' }) }, [64, 32]), /unsupported format/);
assert.throws(() => temporalInputs({ reactive }, [128, 64]), /scene-sized/);
assert.throws(() => temporalInputs({ motion, reactive: motion }, [64, 32]), /alias/);
assert.throws(() => temporalInputs({ motion }, [64, 32], [motion]), /attachment alias/);

// Exact 2px square dilation, no accidental 3px spread; nonfinite and edge handling.
for (const value of [1 / 255, NaN, Infinity, -Infinity]) {
  const load = (x, y) => x === 4 && y === 4 ? value : 0;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    assert.equal(temporalReactiveAt(load, x, y, 9, 9), Math.abs(x - 4) <= 2 && Math.abs(y - 4) <= 2);
  }
}
assert.equal(temporalReactiveAt((x, y) => x === 0 && y === 0 ? 1 : 0, 2, 2, 5, 5), true);
assert.equal(temporalReactiveAt(() => -1, 0, 0, 1, 1), false);

// Reflection verifies source structure/binding ABI, not WGSL validation on Metal.
for (const entry of WGSL_CHECK) new WgslReflect(entry.code());
const wgsl = motionWGSL();
assert.match(wgsl, /P.historyValid == 0u/);
assert.match(wgsl, /bitcast<vec3u>\(m\)/);
assert.match(wgsl, /P.rejectUntracked != 0u/);
assert.match(wgsl, /presentationReproject\(vec4f\(ndc/);
assert.match(wgsl, /var y = -2; y <= 2; y\+\+/);
assert.match(wgsl, /var x = -2; x <= 2; x\+\+/);

const calls = [], groups = [];
const pipe = (desc) => ({ state: 'ready', ready: Promise.resolve(),
  draw(_rp, args) { calls.push({ name: desc.name, ...args }); },
  dispatch() {},
});
const gpu = {
  device: { createSampler: () => ({}) }, layout: (label, entries) => ({ label, entries }),
  renderPipeline: pipe, kernel: pipe, createTexture: texture,
  createBuffer: () => ({ destroy() {} }), flush() {},
  bindGroup(layout, entries) { const g = { layout, entries }; groups.push(g); return g; },
  readback: { ring: () => ({ buffer: {}, next: () => 0, read: () => new Promise(() => {}) }) },
  frame: { render() { return { end() {} }; }, compute() {} },
};
let temporalDisposed = 0;
const temporal = { currentWeight: 0.025, jitter: () => [0.125, -0.25], unjitter() {},
  inputs: (w, h) => ({ velocity: texture({ size: [w, h], format: 'rg16float' }), color: texture({ size: [w, h] }) }),
  resolve: () => texture(), dispose() { temporalDisposed++; },
};
const presenter = { canvas: { width: 64, height: 32 }, format: 'rgba8unorm', hdrActive: false,
  texture: () => texture({ size: [presenter.canvas.width, presenter.canvas.height] }), attachment: () => ({}) };
const presentation = { key: 'flat', active: false, worldToScene: new Matrix4(), sceneToWorld: new Matrix4(), dispose() {} };
const camera = new PerspectiveCamera(); camera.coordinateSystem = WebGPUCoordinateSystem;
const post = createPost(gpu, { temporal, presenter, presentation });
await post.ready;
// Park the mocked readback promise; retain the production post-only reuse path.
post.settings.bloom = 0;
const run = (inputs, cam = camera) => {
  calls.length = 0;
  post.render({ prepare: inputs === undefined ? undefined : (p) => p.setTemporalInputs(inputs) }, cam);
  return calls.find((c) => c.params?.reproj);
};
assert.throws(() => post.setTemporalInputs({ motion }), /inside a scene/);
let c = run();
assert.equal(c.params.historyValid, false);
assert.equal(c.params.explicitMotion, false);
assert.equal(c.params.reactive, false);
c = run();
assert.equal(c.params.historyValid, true);
assert.equal(c.params.rejectUntracked, false);
const cameraBind = c.bind[2];
assert.equal(run().bind[2], cameraBind, 'static bind group reused');
c = run({ motion, reactive });
assert.equal(c.params.explicitMotion, true); assert.equal(c.params.reactive, true);
assert.equal(c.bind[2].entries[2].resource.texture, motion);
assert.equal(c.bind[2].entries[3].resource.texture, reactive);
assert.equal(post.canReuse(camera), false, 'frame-local fields never seed stale post-only reuse');
assert.equal(post.render(null, camera, null, 0, { postOnly: true }), false);
const explicitBind = c.bind[2];
assert.equal(run({ motion, reactive }).bind[2], explicitBind, 'unchanged resources reused');
const replacement = texture();
c = run({ motion: replacement, reactive });
assert.notEqual(c.bind[2], explicitBind);
assert.equal(c.bind[2].entries[2].resource.texture, replacement, 'replacement resource bound');
assert.notEqual(run({ motion, reactive }).bind[2], explicitBind, 'retired group evicted, not resurrected');
c = run();
assert.equal(c.params.explicitMotion, false, 'frame-local input cannot leak into cached/mesh-only next frame');
assert.equal(c.params.reactive, false);
assert.equal(post.canReuse(camera), true, 'post-only adaptation remains possible without perpetual work');
post.reset();
assert.equal(post.canReuse(camera), false);
assert.equal(run({ motion }).params.historyValid, false, 'explicit input cannot defeat reset');
assert.equal(run({ motion }).params.historyValid, true);
camera.position.x = 100;
assert.equal(run({ motion }).params.historyValid, false, 'automatic camera cut');
assert.equal(run({ motion }).params.historyValid, true);
const otherCamera = camera.clone();
assert.equal(run({ motion }, otherCamera).params.historyValid, false, 'camera identity cut');

// Rolling presentation keeps its original reprojection when motion validity is static.
presentation.active = true;
presentation.parameters = { k: 0.01, anchor: [1, 2], dir: [1, 0] };
c = run({ motion });
assert.equal(c.params.warpK, 0.01);
assert.equal(run().params.prevK, 0.01);
presentation.active = false;
assert.equal(run().params.prevK, 0.01, 'transition back to flat still reprojects previous bend');
assert.equal(run().params.prevK, 0);

presenter.canvas.width = 128;
assert.throws(() => run({ motion }), /scene-sized/, 'dynamic scene resize requires fresh inputs');
assert.equal(run().params.explicitMotion, false, 'fallback after resize stays usable');
assert.throws(() => run({ motion: post.targets.scene }), /attachment alias/);
assert.throws(() => run({ motion, reactive: motion }), /alias/);
const previousInputs = temporal.inputs;
const aliasedOutput = texture({ size: post.inSize });
temporal.inputs = (w, h) => ({ velocity: texture({ size: [w, h], format: 'rg16float' }), color: aliasedOutput });
assert.throws(() => run({ motion: aliasedOutput }), /attachment alias/);
temporal.inputs = previousInputs;
const resizedMotion = texture({ size: post.inSize });
assert.equal(run({ motion: resizedMotion }).params.explicitMotion, true);
assert.throws(() => post.render({ prepare(p) { p.setTemporalInputs({ motion: resizedMotion }); resizedMotion.width++; } }, camera), /scene-sized/,
  'consumption revalidates caller resource mutation');
resizedMotion.width--;
// One-off captures ignore motion hooks and leave normal temporal history untouched.
const out = texture({ size: [12, 8], format: 'rgba8unorm' });
assert(post.renderStill({ prepare(p) { p.setTemporalInputs({ motion }); } }, camera, out));
assert.equal(run().params.historyValid, true);

let invalidations = 0;
const helper = createHybridTemporal(post, { invalidateCaches() { invalidations++; } });
const update = (frame) => {
  calls.length = 0;
  post.render({ prepare() { helper.update(frame); } }, camera);
  return calls.find((v) => v.params?.reproj).params;
};
assert.equal(update({ revision: 1 }).rejectUntracked, true, 'initial unknown matter is conservative');
assert.equal(update({ revision: 1 }).rejectUntracked, false, 'static scene settles normally');
assert.equal(post.canReuse(camera), false, 'even static hybrid frames cannot reuse incomplete external caches');
assert.equal(invalidations, 1);
assert.equal(update({ revision: 2 }).rejectUntracked, true, 'simulation change without correspondence');
assert.equal(update({ revision: 2 }).rejectUntracked, false);
const resizedReactive = texture({ size: post.inSize, format: 'r16float' });
assert.equal(update({ revision: 3, reactive: resizedReactive }).rejectUntracked, false, 'complete reactive mask localizes rejection');
assert.equal(update({ revision: 3, changed: true }).rejectUntracked, true, 'external untracked changes');
assert.equal(update({ revision: 3, cameraCut: true, motion: resizedMotion }).historyValid, false);
helper.reset();
assert.equal(post.canReuse(camera), false, 'external cache/reset invalidates post-only images');
assert.equal(update({ revision: 3 }).historyValid, false);
assert.equal(update({}).rejectUntracked, true, 'missing revision has unknown correspondence');
assert.equal(update({}).rejectUntracked, true, 'missing revision never becomes static evidence');
helper.dispose();
assert.throws(() => update({ revision: 4 }), /disposed/);
post.dispose();
assert.equal(temporalDisposed, 1);
assert.equal(motion.destroyed, undefined, 'post must not destroy caller-owned motion');
assert.equal(reactive.destroyed, undefined);
console.log('PASS hybrid temporal: CPU selection/validation, real post mock lifecycle/cache/cuts/resize/rolling/stills, WGSL reflection. No GPU execution or performance claims.');
