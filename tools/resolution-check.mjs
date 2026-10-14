// Deterministic, no browser/GPU: node tools/resolution-check.mjs
//
// post.js's sizing (the scene at the render scale, output-sized TAA output,
// bloom at half), its pass order and its jitter, recorded through a gpu that
// only records (no WebGPU in Node), with three's TAAUNode jittering the camera
// and a stand-in for its GPU work; then auto resolution and the pacer, as before.
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { computeHaltonOffsets } from 'three/addons/tsl/utils/TAAUtils.js';
import { createAutoResolution, createPost, UPSCALE, UPSCALE_FLOOR, AUTO_RES } from '../src/gfx/post.js';
import { createTemporalUpscaler } from '../src/gpu/three.js';
import { createPacer, settleFrames } from '../src/gfx/pacing.js';

// A gpu that records what post asks of it: textures (sizes), passes and
// commands (names, in order), bind groups. Everything reads as ready.
function recordingGpu() {
  const log = [];
  const pipe = (desc) => ({ name: desc.name, state: 'ready', ready: Promise.resolve(), desc,
    draw(rp, opts) { log.push({ kind: 'draw', name: desc.name, pass: rp.name, params: opts.params }); },
    dispatch(f, size, opts) { log.push({ kind: 'dispatch', name: desc.name, size, params: opts.params }); } });
  const texture = (desc) => ({ ...desc, width: desc.size[0], height: desc.size[1], destroyed: false,
    createView() { return { texture: this }; }, destroy() { this.destroyed = true; log.push({ kind: 'destroy', name: desc.label }); } });
  const gpu = {
    log,
    textures: [],
    device: { createSampler: () => ({}) },
    stats: { renderPasses: 0, computePasses: 0 },
    timing: { split: false, enabled: false },
    layout: (name) => ({ label: name }),
    renderPipeline: pipe,
    kernel: pipe,
    bindGroup: (layout, entries, label) => ({ layout, entries, label }),
    createBuffer: (desc) => ({ ...desc, destroy() {} }),
    createTexture(desc) { const t = texture(desc); gpu.textures.push(t); return t; },
    readback: { ring: () => ({ buffer: {}, next: () => 0, read: () => new Promise(() => {}) }) },
    flush(reason) { log.push({ kind: 'flush', name: reason }); return false; },
    frame: {
      render(desc, name) { log.push({ kind: 'pass', name }); gpu.stats.renderPasses++; return { name, end() {} }; },
      compute(name) { log.push({ kind: 'pass', name }); gpu.stats.computePasses++; },
    },
  };
  return gpu;
}

let width = 1200, height = 800, sceneFootprint, projected = null;
const gpu = recordingGpu();
const canvas = { width, height };
const presenter = {
  canvas, format: 'bgra8unorm',
  texture: () => ({ width: canvas.width, height: canvas.height }),
  attachment: () => ({ view: 'canvas' }),
};
const camera = new THREE.PerspectiveCamera(40, 1.5, 0.05, 200);
camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
camera.updateProjectionMatrix();
camera.position.set(1, 2, 3);
const pixScale = { value: 1 };
const scene = {
  prepare(p) { projected = camera.projectionMatrix.clone(); },
  draw(rp, p) { sceneFootprint = pixScale.value / p.sceneTarget.width; },
};
// three's TAAU (gpu/three.js): its node's own jitter on the camera; its GPU work
// (inputs, resolve) recorded instead, the resolve an output-sized texture
const temporal = Object.assign(createTemporalUpscaler({ three: { renderer: null } }), {
  inputs: (w, h) => ({ velocity: gpu.createTexture({ label: 'taau velocity', size: [w, h] }), color: gpu.createTexture({ label: 'taau colour', size: [w, h] }) }),
  resolve(cam, depth, [w, h]) {
    gpu.log.push({ kind: 'pass', name: 'taau' });
    return gpu.createTexture({ label: 'taau resolve', size: [w, h] });
  },
});
const post = createPost(gpu, { presenter, pixScale, temporal });
await post.ready;
post.settings.adapt = false; // exposure readback is unrelated to resolution
const render = () => { canvas.width = width; canvas.height = height; post.render(scene, camera); };
for (const ceiling of Object.values(UPSCALE)) {
  post.settings.upscale = ceiling;
  for (const multiplier of [1, 0.85, 0.6, 0.4, 1.2]) {
    post.settings.resolutionScale = multiplier;
    render();
    // native stays native; an upscaling preset × automatic resolution, not below FSR 2's Ultra Performance
    const scale = ceiling >= 1 ? 1 : Math.max(UPSCALE_FLOOR, ceiling * Math.min(1, Math.max(AUTO_RES.MIN, multiplier)));
    assert.equal(post.renderScale, scale);
    assert.ok(post.renderScale >= UPSCALE_FLOOR);
    assert.deepEqual(post.size, [width, height]);
    assert.equal(post.targets.scene.width, Math.round(width * scale));
    assert.equal(post.targets.scene.height, Math.round(height * scale));
    assert.deepEqual(post.inSize, [post.targets.scene.width, post.targets.scene.height]);
    assert.equal(post.targets.resolved.width, width);
    assert.equal(post.targets.resolved.height, height);
    assert.equal(post.targets.bloom.width, width / 2);
    assert.ok(Math.abs(sceneFootprint - 1 / width) < 1e-12, 'material LOD footprint stays output-based');
  }
}
post.settings.upscale = UPSCALE.native;
post.settings.resolutionScale = AUTO_RES.MIN;
render();
assert.equal(post.targets.scene.width, width, 'Upscaling Off renders every output pixel, whatever automatic resolution asks');
post.settings.taa = false;
render();
assert.equal(post.renderScale, 1);
assert.equal(post.targets.scene.width, width, 'no TAA means no internal downsampling');
post.settings.taa = true;
post.settings.resolutionScale = 0.6;
width = 901; height = 603;
render();
assert.deepEqual(post.size, [901, 603]);
assert.equal(post.targets.scene.width, Math.round(901 * post.renderScale));
assert.equal(post.targets.resolved.width, 901);
assert.equal(post.targets.bloom.width, 450);
assert.ok(Math.abs(sceneFootprint - 1 / 901) < 1e-12);
const live = gpu.textures.filter((t) => !t.destroyed);
assert.ok(live.every((t) => t.width >= 1 && t.height >= 1), 'no empty texture');
console.log('PASS: internal sizes (FSR 2 presets of the output, native never lowered, Ultra Performance floor), output-sized TAA output and bloom, LOD footprint, TAA off, resize');

// The frame's passes in order (W16, F7): scene, the motion pass, three's TAAU, its expand (post.js taaExpand),
// prefilter, one compute pass (bloom down 1-5, up 4-1, the reduction), bloom's up[0], the canvas.
post.settings.upscale = 1; post.settings.resolutionScale = 1; post.settings.adapt = true;
gpu.log.length = 0;
render();
const order = gpu.log.filter((e) => e.kind !== 'flush' && e.kind !== 'destroy').map((e) => (e.kind === 'pass' ? `[${e.name}]` : e.name));
assert.deepEqual(order, ['[scene]', '[motion]', 'motion', '[taau]', '[taa expand]', 'taaExpand', '[prefilter]', 'prefilter', '[post]', 'bloomDown', 'bloomDown', 'bloomDown', 'bloomDown', 'bloomDown',
  'bloomUp', 'bloomUp', 'bloomUp', 'bloomUp', 'postReduce', '[bloomUp0]', 'bloomUp0', '[canvas]', 'composite bgra8unorm'], order.join(' '));
const ups = gpu.log.filter((e) => e.kind !== 'pass' && (e.name === 'bloomUp' || e.name === 'bloomUp0')).map((e) => e.params.dst.join('×'));
assert.deepEqual(ups, ['28×18', '56×37', '112×75', '225×150', '450×301'], 'bloom up from 1/32 to 1/2 of 901×603');
post.settings.raw = true;
gpu.log.length = 0;
render();
assert.deepEqual(gpu.log.filter((e) => e.kind === 'pass').map((e) => e.name), ['scene', 'motion', 'taau', 'taa expand', 'canvas'], 'a data view: no bloom, no adaptation');
post.settings.raw = false;
console.log('PASS: pass order (scene, motion, TAAU, expand, prefilter, one compute pass, up[0], canvas), bloom sizes, raw view');

// The jitter (F4): three's TAAUNode's, the only one: Halton(2, 3) − ½ scene pixels
// with y down over its 32 offsets, a view offset on the camera only between
// beginScene and endScene: projection column 2 moved by 2·jx/w and −2·jy/h, the
// rest (the camera's own aspect included) unchanged.
const offsets = computeHaltonOffsets(32);
const before = camera.projectionMatrix.clone();
const near12 = (a, b) => Math.abs(a - b) < 1e-12;
const seen = [];
for (let k = 0; k < 40; k++) {
  render();
  const [jx, jy] = post.jitter;
  seen.push([jx, jy]);
  const e = projected.elements, b = before.elements, [w, h] = post.inSize;
  assert.ok(near12(e[8], b[8] + 2 * jx / w), 'column 2, x: + 2·jx/w');
  assert.ok(near12(e[9], b[9] - 2 * jy / h), 'column 2, y: − 2·jy/h (y down)');
  e.forEach((x, i) => { if (i !== 8 && i !== 9) assert.ok(near12(x, b[i]), `projection element ${i} unchanged`); });
  assert.deepEqual(camera.projectionMatrix.elements, before.elements, 'the projection comes back unjittered');
  assert.equal(camera.aspect, 1.5, 'the camera keeps its own aspect');
}
const start = offsets.findIndex(([x, y]) => near12(x - 0.5, seen[0][0]) && near12(y - 0.5, seen[0][1]));
assert.ok(start >= 0, 'the jitter is one of TAAUNode\'s offsets');
seen.forEach(([x, y], k) => {
  const [hx, hy] = offsets[(start + k) % offsets.length];
  assert.ok(near12(x, hx - 0.5) && near12(y, hy - 0.5), `frame ${k}: TAAUNode's next offset`);
});
assert.ok(seen.every(([x, y]) => Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5));
post.settings.taa = false;
render();
assert.deepEqual(post.jitter, [0, 0], 'no jitter without TAA');
assert.deepEqual(projected.elements, before.elements);
post.settings.taa = true;
assert.equal(post.settleWeight, temporal.node.currentFrameWeight, 'the pacer settles with TAAUNode\'s current-frame weight');
console.log('PASS: jitter: TAAUNode\'s Halton(2, 3) over its 32 offsets, y down, only inside the scene, none without TAA; settleWeight is its weight');

// The frame's parts in B3's order: prepare (the tick's one FrameUniforms write)
// and compute (E1's FrameUniforms readers) with the camera already jittered,
// then the scene pass, meshes and overlay; onPass('scene') once, after them and
// before post's own passes, from endScene (so the split path emits it too).
// post.unjittered and withoutJitter give JS the projection without the jitter.
{
  const near = (a, b) => a.elements.every((x, i) => Math.abs(x - b.elements[i]) < 1e-12);
  const note = (kind, name) => gpu.log.push({ kind, name });
  const events = () => gpu.log.filter((e) => ['pass', 'hook', 'onPass'].includes(e.kind))
    .map((e) => (e.kind === 'pass' ? `[${e.name}]` : e.kind === 'onPass' ? `onPass ${e.name}` : e.name));
  let inside = null, after = null, rayProj = null, inPrepare = null;
  const parts = {
    prepare() { note('hook', 'prepare'); inPrepare = camera.projectionMatrix.clone(); inside = near(inPrepare, before) ? 'unjittered' : 'jittered'; },
    compute(p) {
      note('hook', 'compute');
      rayProj = p.withoutJitter(() => camera.projectionMatrix.clone());
      after = camera.projectionMatrix.clone();
      assert.ok(near(p.unjittered.projectionMatrix, before) && near(p.unjittered.projectionMatrixInverse, before.clone().invert()), 'post.unjittered: the camera\'s own projection');
    },
    draw() { note('hook', 'draw'); },
    meshes() { note('hook', 'meshes'); },
    overlay() { note('hook', 'overlay'); },
  };
  render();   // (a frame of the scene before, so this one's jitter isn't 0)
  post.onPass = (name) => note('onPass', name);
  gpu.log.length = 0;
  post.render(parts, camera);
  assert.deepEqual(events().slice(0, 12), ['prepare', 'compute', '[scene]', 'draw', 'meshes', '[overlay]', 'overlay', 'onPass scene', '[motion]', '[taau]', '[taa expand]', 'onPass taa'], events().join(' '));
  assert.equal(inside, 'jittered', 'prepare sees the jittered camera (FrameUniforms.viewProj, F6)');
  assert.ok(near(rayProj, before), 'withoutJitter runs fn with the camera\'s own projection');
  assert.ok(near(after, inPrepare), '…and jitters it again after');
  assert.equal(post.unjittered, null, 'no jittered camera after the frame');
  assert.ok(near(camera.projectionMatrix, before));
  // the split path: endScene emits onPass('scene')
  gpu.log.length = 0;
  post.beginScene(camera);
  post.endScene();
  post.finish();
  assert.equal(events().filter((e) => e === 'onPass scene').length, 1, `split path: ${events().join(' ')}`);
  assert.ok(near(camera.projectionMatrix, before));
  // a scene left unended isn't jittered twice
  post.beginScene(camera);
  post.beginScene(camera);
  post.endScene();
  assert.ok(near(camera.projectionMatrix, before), 'beginScene twice, endScene once: the camera\'s own projection');
  post.finish();
  post.onPass = null;
}
console.log('PASS: frame parts: prepare and compute with the camera jittered, then scene, meshes, overlay, onPass(\'scene\') from endScene; withoutJitter');

// Resizes destroy textures the open encoder may still hold: post flushes first,
// so no command is recorded between the last flush and a texture's destruction.
{
  gpu.log.length = 0;
  width = 640; height = 400;
  render();
  const thumb = (w, h) => gpu.createTexture({ label: `thumb ${w}`, size: [w, h], format: 'rgba8unorm' });
  post.renderStill(scene, camera, thumb(320, 200));
  post.renderStill(scene, camera, thumb(160, 100));
  const log = gpu.log.map((e) => `${e.kind}:${e.name}`);
  const destroyed = log.filter((x) => x.startsWith('destroy:'));
  for (const name of ['scene colour', 'scene depth', 'post down 5', 'post up 4', 'still colour', 'still depth']) {
    assert.ok(destroyed.includes(`destroy:${name}`), `a resize destroys ${name}: ${destroyed.join(' ')}`);
  }
  log.forEach((x, i) => {
    if (!x.startsWith('destroy:')) return;
    const since = log.slice(0, i).reverse();
    const lastFlush = since.findIndex((y) => y.startsWith('flush:'));
    const lastCommand = since.findIndex((y) => /^(pass|draw|dispatch):/.test(y));
    assert.ok(lastFlush >= 0 && (lastCommand < 0 || lastFlush < lastCommand), `flushed before ${x}: ${log.join(' ')}`);
  });
}
console.log('PASS: resizes (output, scene target, still) flush before destroying');
post.dispose();

function run(auto) {
  let now = 0;
  const changes = [];
  return {
    changes,
    advance(seconds, cost) {
      const end = now + seconds;
      while (now < end) {
        const before = auto.scale;
        const dt = cost(before);
        now += dt;
        auto.update(dt, now);
        assert.ok(auto.scale >= 0.6 && auto.scale <= 1);
        if (auto.scale !== before) changes.push({ now, before, scale: auto.scale });
      }
    },
  };
}
const auto = createAutoResolution(), sim = run(auto);
sim.advance(12, (scale) => 0.08 * scale ** 2);
assert.ok(auto.scale <= 0.65, 'GPU-limited frames degrade near the floor');
assert.ok(sim.changes.some((c) => c.scale === 0.6), 'degradation tries the floor without undershooting');
// Work gets lighter but the browser never exceeds 30 fps: recovery must still happen.
sim.advance(65, () => 1 / 30);
assert.equal(auto.scale, 1, 'recover full selected quality under a 30 Hz cap');
assert.ok(sim.changes.some((c) => c.scale > c.before));
auto.enabled = false;
const frozen = auto.scale, count = sim.changes.length;
sim.advance(180, () => 0.08);
assert.equal(auto.scale, frozen);
assert.equal(sim.changes.length, count, 'tool disable freezes adaptation');
console.log('PASS: GPU degradation, 30 Hz recovery, bounds, autoRes.enabled compatibility');

const cpu = createAutoResolution(), capped = run(cpu);
capped.advance(240, () => 1 / 30);
const drops = capped.changes.filter((c) => c.scale < c.before);
assert.ok(drops.length >= 3 && drops.length <= 6, 'failed drops back off rather than cycling every window');
assert.equal(cpu.scale, 1, 'CPU/refresh-limited drops are reverted');
assert.ok(drops[2].now - drops[1].now > drops[1].now - drops[0].now, 'rejection cooldown grows');

const limited = createAutoResolution();
limited.scale = 0.6;
const probes = run(limited);
probes.advance(120, (scale) => scale === 0.6 ? 1 / 30 : 1 / 20);
const rises = probes.changes.filter((c) => c.scale > c.before);
assert.ok(rises.length >= 2 && rises.length <= 4, 'rejected upward probes also back off');
assert.equal(limited.scale, 0.6, 'expensive upward probe is reverted');
assert.ok(rises[1].now - rises[0].now >= 15);
assert.ok(rises[2].now - rises[1].now >= 30);
probes.advance(90, () => 1 / 30);
assert.equal(limited.scale, 1, 'rejected probes do not prevent later recovery');
console.log('PASS: rejected down/up trials roll back, cooldowns grow, later recovery remains possible');

// Match app ordering: only drawn frames feed timing; post scale is part of the
// view key, but must not unlock adaptation while the final still settles.
const idleAuto = createAutoResolution();
idleAuto.scale = 0.6;
const pacer = createPacer({ derivedSettle: 2, viewSettle: settleFrames(0.05) });
let now = 0, renderedLast = false, draws = 0, restores = 0, restoredAt = 0;
let version = 0, postKey = 0;
function tick(worldChanged = false) {
  const dt = 1 / 30;
  now += dt;
  assert.ok(pacer.due(now * 1000));
  if (renderedLast) idleAuto.update(dt, now);
  if (worldChanged) { idleAuto.wake(); version++; }
  const derived = pacer.derived(version);
  let render = pacer.view(`${version}|${postKey}|${idleAuto.scale}`, derived);
  if (!render && idleAuto.recover(now)) {
    pacer.wake();
    render = true;
    restores++; restoredAt = now;
  }
  renderedLast = render;
  if (render) draws++;
}
for (let i = 0; i < 1200; i++) tick();
assert.equal(idleAuto.scale, 1, 'still recovers before render-idle');
assert.equal(restores, 1, 'one restoration, no degrade/restore loop');
assert.ok(restoredAt < 15, 'recovery does not wait for an upward probe');
assert.equal(renderedLast, false, 'full-quality TAA finishes settling');
const settledDraws = draws;
for (let i = 0; i < 1200; i++) tick();
assert.equal(draws, settledDraws, 'idle really stops rendering');
postKey++; // its own post/settings change must not unlock adaptation
for (let i = 0; i < 240; i++) { tick(); assert.equal(idleAuto.scale, 1); }
assert.equal(renderedLast, false);
idleAuto.wake(); pacer.wake(); // existing input handler
for (let i = 0; i < 40; i++) tick();
assert.ok(idleAuto.scale < 1, 'input resumes adaptation');
for (let i = 0; i < 1200; i++) tick();
assert.equal(renderedLast, false);
assert.equal(idleAuto.scale, 1);
tick(true); // worldChanged without an input event
for (let i = 0; i < 40; i++) tick();
assert.ok(idleAuto.scale < 1, 'world state changes resume adaptation');

idleAuto.enabled = false;
idleAuto.scale = 0.6;
const manualRestores = restores;
idleAuto.wake(); pacer.wake();
for (let i = 0; i < 1200; i++) tick();
assert.equal(idleAuto.scale, 0.6, 'disabled tools keep their manual scale even at idle');
assert.equal(restores, manualRestores);
assert.equal(renderedLast, false);
console.log('PASS: pacer idle restores once, settles without cycling, input/state wake resumes adaptation, disabled tools stay stable');
