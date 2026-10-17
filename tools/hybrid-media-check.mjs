import assert from 'node:assert/strict';
import { createFieldBounds, fieldBoundsReference, fieldRayBoundsReference, retireMediaResources } from '../src/gfx/hybrid/fieldBounds.js';
import { fieldBoundsWGSL } from '../src/shaders/hybrid/fieldBounds.js';
import { MEDIA_FLOOR } from '../src/gfx/materials.js';
import { Matrix4 } from 'three/webgpu';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createHybridMedia, mediaExtent, mediaTransmission, HybridMediaParams } from '../src/gfx/hybrid/media.js';
import { hybridMediaIntegrateWGSL, hybridMediaCompositeWGSL, hybridMediaSegmentWGSL, MEDIA_FIELD_LAYOUT, MEDIA_COMPOSITE_LAYOUT } from '../src/shaders/hybrid/media.js';

assert.deepEqual(mediaExtent(7, 5), [4, 3]);
assert.deepEqual(mediaExtent(1, 1, .1), [1, 1]);
for (const scale of [0, -1, NaN, Infinity, 1.01]) assert.throws(() => mediaExtent(2, 2, scale));
assert.equal(mediaTransmission(0, 100), 1);
assert.ok(Math.abs(mediaTransmission(.3, 5) - mediaTransmission(.3, 2) * mediaTransmission(.3, 3)) < 1e-14);
assert.throws(() => mediaTransmission(-1, 2));
for (const code of [hybridMediaIntegrateWGSL(), hybridMediaCompositeWGSL(), hybridMediaSegmentWGSL()]) {
  const r = new WgslReflect(code);
  assert.ok(r.storage.length <= 8);
  const p = r.uniforms.find((u) => u.name === 'hmP');
  assert.equal(p.size, HybridMediaParams.size);
  assert.equal(p.group, 3); assert.equal(p.binding, 1);
  const field = [...r.textures, ...r.samplers, ...r.storage].filter((v) => v.group === 1).map((v) => v.binding).sort();
  assert.deepEqual(field, MEDIA_FIELD_LAYOUT.map((e) => e.binding));
}
const reflected = new WgslReflect(hybridMediaCompositeWGSL());
assert.deepEqual(reflected.textures.filter((v) => v.group === 2).map((v) => v.binding).sort(), MEDIA_COMPOSITE_LAYOUT.map((e) => e.binding).sort());
const relocated = new WgslReflect(hybridMediaSegmentWGSL({ fieldGroup: 2, fieldBinding: 10, paramsGroup: 1, paramsBinding: 8, headerBinding: 7 }));
assert.equal(relocated.uniforms.find((v) => v.name === 'hmP').binding, 8);
assert.deepEqual([...relocated.textures, ...relocated.samplers].map((v) => v.binding).sort((a,b) => a-b), [10,11,12,13,14,15]);
assert.equal(relocated.storage.find((v) => v.name === 'hmmediaBounds').binding, 16);
assert.equal(relocated.storage.find((v) => v.name === 'hmmediaBounds').group, 2);
const sun = { wgsl: 'fn testSun(p: vec3f) -> f32 { return 0.25; }', visibility: 'testSun' };
new WgslReflect(hybridMediaIntegrateWGSL({ sunWGSL: sun.wgsl, sunVisibility: sun.visibility }));
assert.match(hybridMediaIntegrateWGSL({ sunWGSL: sun.wgsl, sunVisibility: sun.visibility }), /clamp\(testSun\(p\), 0.0, 1.0\)/);

const textures = [], draws = [], passes = [], pipes = [], dispatches = [], buffers = [];
let failAllocation = false;
function texture({ size = [8, 6], format = 'rgba16float', usage = 4, ...rest } = {}) {
  const t = { width: size[0], height: size[1], depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, dimension: '2d', format, usage, destroyed: 0, ...rest,
    createView() { assert.equal(this.destroyed, 0); return { texture: this }; }, destroy() { this.destroyed++; } };
  textures.push(t); return t;
}
const gpu = {
  limits: { maxTextureDimension2D: 64 },
  device: { createSampler: (d) => ({ sampler: d }) },
  _mediaNoise: { view: { sharedNoise: true }, ready: Promise.resolve() },
  _frameUniforms: { layout: {}, group: {}, last: { written: true, model: new Matrix4(), viewProj: new Matrix4() } },
  layout: (name, entries) => ({ name, entries }),
  bindGroup(layout, entries) { assert.deepEqual(entries.map((e) => e.binding).sort(), layout.entries.map((e) => e.binding).sort()); return { layout, entries }; },
  createTexture(d) { if (failAllocation) { failAllocation = false; throw new Error('allocation failure'); } return texture(d); },
  createBuffer(d) { const b = { ...d, destroyed: 0, destroy() { this.destroyed++; } }; buffers.push(b); return b; },
  kernel(d) { new WgslReflect(d.code); return { state: 'ready', ready: Promise.resolve(), dispatch(f, size, args) {
    dispatches.push({ d, size, args });
  } }; },
  renderPipeline(d) { const p = { state: 'ready', ready: Promise.resolve(), draw(pass, args) {
    assert.equal(pass.ended, false);
    const samples = args.bind.slice(1).flatMap((g) => g.entries.map((e) => e.resource.texture).filter(Boolean));
    assert.ok(pass.descriptor.colorAttachments.every((a) => !samples.includes(a.view.texture)));
    const view = new DataView(new ArrayBuffer(HybridMediaParams.size));
    HybridMediaParams.pack(args.params, view, 0);
    draws.push({ d, args });
  } }; pipes.push(p); return p; },
  frame: { render(descriptor) { const p = { descriptor, ended: false, end() { this.ended = true; } }; passes.push(p); return p; } },
};
const sim = { g: { nx: 32, ny: 32, nz: 32 }, derived: { frameNo: 0, views: { fieldMedia: {}, light: {}, gi: [{}] } }, header: () => ({ origin: [0,0,0] }) };
for (const options of [{ step: 0 }, { step: NaN }, { maxSteps: 0 }, { maxSteps: 1025 }, { scale: 0 }, { sun: { layout: [{ binding: 3 }] } }, { sun: { layout: [{ binding: 6 }] } }]) assert.throws(() => createHybridMedia(gpu, sim, options));
assert.throws(() => createHybridMedia({ ...gpu, limits: { maxBindGroups: 3 } }, sim));
const media = createHybridMedia(gpu, sim, { sun });
const frame = { color: texture(), depth: texture({ format: 'depth32float' }) };
assert.equal(media.record(frame), false);
await media.ready;
assert.equal(media.isReady, true);
media.update(frame);
const segment = media.segment({ binding: 10 });
assert.deepEqual(segment.entries.map((e) => e.binding), [10,11,12,13,14,15,16]);
assert.deepEqual(segment.params.grid, [32,32,32]);
assert.equal(segment.params.maxSteps, 128);
assert.equal(segment.entries[3].resource, gpu._mediaNoise.view);
assert.equal(media.boundsStats.scans, 1); // segment must scan before screen record
assert.equal(dispatches.length, 2);
const out = media.record();
assert.equal(media.boundsStats.scans, 1);
assert.equal(media.resources.media.format, 'rgba16float');
assert.equal(media.resources.guide.format, 'r32float');
assert.throws(() => { media.resources.media = null; }, TypeError);
media.update(frame); media.segment();
assert.equal(media.boundsStats.scans, 1); // camera-only reuse
sim.derived.frameNo++; media.segment();
assert.equal(media.boundsStats.scans, 2); // final-field EMA/edit/load/shift revision

assert.notEqual(out, frame.color); assert.equal(out.format, 'rgba16float');
assert.equal(draws.length, 2); assert.ok(passes.every((p) => p.ended));
assert.deepEqual(draws[0].args.params.lowSize, [4,3]);
assert.equal(draws[0].args.params.hasOptics, 0);
media.record(frame); assert.equal(media.stats.allocations, 1);
const old = media.output;
for (const patch of [ { color: old }, { depth: frame.color }, { color: texture({ size: [65,6] }) }, { depth: texture({ format: 'depth32float', size: [4,6] }) },
  { color: texture({ usage: 16 }) }, { color: texture({ sampleCount: 4 }) }, { color: texture({ dimension: '3d' }) }, { opticalDepth: texture({ format: 'rgba16float' }) }, { scale: NaN } ]) {
  assert.throws(() => media.record({ ...frame, ...patch })); assert.equal(media.output, old); assert.equal(old.destroyed, 0);
}
gpu._frameUniforms.last.written = false;
assert.throws(() => media.record(frame)); gpu._frameUniforms.last.written = true;
failAllocation = true;
assert.throws(() => media.record({ ...frame, scale: 1 }), /allocation failure/);
assert.equal(media.output, old); assert.equal(old.destroyed, 0);
media.record({ ...frame, opticalDepth: texture({ format: 'rgba32float' }) });
const optics = texture({ format: 'r32float' });
media.record({ ...frame, opticalDepth: optics, scale: 1 });
assert.equal(old.destroyed, 1); assert.equal(media.stats.allocations, 2);
assert.equal(draws.at(-1).args.params.hasOptics, 1);
assert.equal(frame.color.destroyed, 0); assert.equal(frame.depth.destroyed, 0); assert.equal(optics.destroyed, 0);
const last = media.output;
media.dispose(); media.dispose();
assert.equal(last.destroyed, 1); assert.equal(media.output, null); assert.equal(media.isReady, false);
assert.throws(() => media.record(frame)); assert.throws(() => media.update(frame)); assert.throws(() => media.segment());
// Resizing/disposal must not destroy resources referenced by an unsubmitted encoder.
const deferred = createHybridMedia(gpu, sim);
await deferred.ready;
gpu.frame.encoder = {};
const pending = deferred.record(frame);
deferred.record({ ...frame, scale: 1 });
assert.equal(pending.destroyed, 0);
const pendingLast = deferred.output;
deferred.dispose();
assert.equal(pendingLast.destroyed, 0);
gpu.frame.encoder = null; // model owner submission, not module submission
await new Promise((resolve) => queueMicrotask(resolve));
assert.equal(pending.destroyed, 1); assert.equal(pendingLast.destroyed, 1);
assert.equal(typeof gpu.queue, 'undefined'); // hooks could not submit or flush
console.log('hybrid-media-check: CPU math, WGSL reflection/layouts, segment/sun seam, fake-GPU two-pass recording, immutable inputs, validation, resize rollback and disposal passed (no native GPU validation)');

// Bounds reduction ABI and CPU references: final EMA ghosts survive raw-cell removal.
const br = new WgslReflect(fieldBoundsWGSL);
assert.equal(br.storage.length, 2);
assert.equal(br.storage.find((v) => v.name === 'bounds').size, 32);
assert.doesNotMatch(fieldBoundsWGSL, /atomic(?:Add|Min|Max|Store|Load|<)/);
const grid = [12, 8, 8];
const empty = fieldBoundsReference(grid, () => [0, 0, 0, 500]);
assert.deepEqual([...empty], [0,0,0,0,0,0,0,0]);
assert.deepEqual(fieldRayBoundsReference(empty, [-1,4,4], [1,0,0], 100), [0,0]);
const ghost = fieldBoundsReference(grid, (x,y,z) => [x === 5 && y === 4 && z === 4 ? MEDIA_FLOOR + .001 : 0,0,0,0]);
assert.deepEqual([...ghost], [3,2,2,1,8,7,7,0]);
assert.deepEqual(fieldRayBoundsReference(ghost, [-1,4,4], [1,0,0], 100), [4,9]);
assert.deepEqual(fieldRayBoundsReference(ghost, [-1,0,4], [1,0,0], 100), [0,0]);
assert.deepEqual(fieldRayBoundsReference(ghost, [10,4,4], [-1,0,0], 100), [2,7]);
assert.deepEqual([...fieldBoundsReference(grid, () => [MEDIA_FLOOR,0,0,0])], [...empty]);
const shifted = fieldBoundsReference(grid, (x,y,z) => [0, x === 0 && y === 0 && z === 0 ? 1 : 0,0,0]);
assert.deepEqual([...shifted], [0,0,0,1,3,3,3,0]);
// Resize, view replacement and header freshness; no scan on frame camera updates.
const boundOwner = createFieldBounds(gpu, sim); await boundOwner.ready;
const firstBounds = boundOwner.ensure().buffer;
assert.equal(boundOwner.ensure().buffer, firstBounds); assert.equal(boundOwner.stats.scans, 1);
sim.derived.views.fieldMedia = {}; boundOwner.ensure(); assert.equal(boundOwner.stats.scans, 2);
let origin = [10,0,0]; sim.header = () => ({ origin });
sim.derived.frameNo++; boundOwner.ensure();
assert.deepEqual(dispatches.at(-1).args.header.origin, origin);
// Keep an encoder open beyond the one retirement microtask, then owner flushes.
let flushes = 0;
gpu.frame.flush = function () { flushes++; this.encoder = null; return true; };
const originalFlush = gpu.frame.flush;
gpu.frame.encoder = {};
sim.g.nx = 16;
const resizedBounds = boundOwner.ensure().buffer;
assert.notEqual(resizedBounds, firstBounds); assert.equal(firstBounds.destroyed, 0);
boundOwner.dispose();
await new Promise((resolve) => queueMicrotask(resolve));
assert.equal(firstBounds.destroyed, 0); assert.equal(resizedBounds.destroyed, 0);
assert.equal(flushes, 0); // no automatic submissions
assert.equal(gpu.frame.flush(), true);
assert.equal(firstBounds.destroyed, 1); assert.equal(resizedBounds.destroyed, 1);
assert.equal(gpu.frame.flush, originalFlush);
// A producer may submit before another module samples its output. Preserve
// that output through the current consumer, not merely its original encoder.
const producerEncoder={},consumerEncoder={};
const retirementGpu={frame:{encoder:consumerEncoder,flush(){this.encoder=null;}}};
const external={destroyed:0,destroy(){this.destroyed++;}};
retireMediaResources(retirementGpu,{external},producerEncoder);
await new Promise(resolve=>queueMicrotask(resolve));
assert.equal(external.destroyed,0,'later external consumer still holds the resource');
retirementGpu.frame.flush();
assert.equal(external.destroyed,1,'release only after the last open consumer submits');
console.log('hybrid-media-check: final-field bounds empty/miss/EMA ghost/resize/shift/reuse, rgba32float metadata and passive encoder retirement passed (CPU only)');

const sunSeam = createHybridMedia(gpu, sim, { sun: {
  wgsl: '@group(1) @binding(7) var shadowTex: texture_2d<f32>; fn sharedSun(p: vec3f) -> f32 { return 1.0; }',
  visibility: 'sharedSun', layout: [{ binding: 7, texture: { sampleType: 'float' } }],
  entries: () => [{ binding: 7, resource: {} }], textures: () => [],
} });
await sunSeam.ready;
sunSeam.update(frame);
const seam = sunSeam.segment({ binding: 16 });
assert.deepEqual(seam.layout.map((e) => e.binding), [16,17,18,19,20,21,22,23]);
assert.deepEqual(seam.entries.map((e) => e.binding), [16,17,18,19,20,21,22,23]);
const seamWGSL = new WgslReflect(seam.wgsl({ fieldGroup: 2 }));
assert.equal(seamWGSL.textures.find((v) => v.name === 'shadowTex').binding, 23);
const shared = seam.wgsl({ fieldGroup: 2, sunWGSL: '', sunVisibility: 'parentSun' });
assert.doesNotMatch(shared, /var shadowTex/);
assert.match(shared, /parentSun\(p\)/);
assert.equal(new WgslReflect(shared).storage.length, 1);
assert.equal(new WgslReflect(shared).textures.length, 4);
assert.equal(seam.header.origin, origin);
assert.equal(seam.entries[6].resource.buffer.size, 32);
sunSeam.dispose();
