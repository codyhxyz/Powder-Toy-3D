// Deterministic, no browser/GPU: node tools/resolution-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createAutoResolution, createPost, UPSCALE } from '../src/gfx/post.js';
import { createPacer, settleFrames } from '../src/gfx/pacing.js';

// Exercise the real post target sizing and scene uniform, without issuing GL calls.
let target = null, width = 1200, height = 800, sceneFootprint;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const pixScale = { value: 1 };
const renderer = {
  getDrawingBufferSize: (v) => v.set(width, height),
  getRenderTarget: () => target,
  setRenderTarget: (v) => { target = v; },
  getClearColor: (v) => v.set(0),
  getClearAlpha: () => 0,
  setClearColor() {}, clear() {},
  render(s) { if (s === scene) sceneFootprint = pixScale.value / target.width; },
};
const post = createPost(renderer, { pixScale });
post.settings.adapt = false; // exposure readback is unrelated to resolution
for (const ceiling of Object.values(UPSCALE)) {
  post.settings.upscale = ceiling;
  for (const multiplier of [1, 0.85, 0.6, 1.2]) {
    post.settings.resolutionScale = multiplier;
    post.render(scene, camera);
    const scale = ceiling * Math.min(1, multiplier);
    assert.equal(post.renderScale, scale);
    assert.deepEqual(post.size.toArray(), [width, height]);
    assert.equal(post.targets.scene.width, Math.round(width * scale));
    assert.equal(post.targets.scene.height, Math.round(height * scale));
    assert.equal(post.targets.history.width, width);
    assert.equal(post.targets.history.height, height);
    assert.equal(post.targets.bloom.width, width / 2);
    assert.ok(Math.abs(sceneFootprint - 1 / width) < 1e-12, 'material LOD footprint stays output-based');
  }
}
post.settings.taa = false;
post.render(scene, camera);
assert.equal(post.renderScale, 1);
assert.equal(post.targets.scene.width, width, 'no TAA means no internal downsampling');
post.settings.taa = true;
post.settings.resolutionScale = 0.6;
width = 901; height = 603;
post.render(scene, camera);
assert.deepEqual(post.size.toArray(), [901, 603]);
assert.equal(post.targets.scene.width, Math.round(901 * post.renderScale));
assert.equal(post.targets.history.width, 901);
assert.ok(Math.abs(sceneFootprint - 1 / 901) < 1e-12);
post.dispose();
console.log('PASS: internal sizes, native output/history/bloom, quality ceiling, LOD footprint, TAA off, resize');

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
