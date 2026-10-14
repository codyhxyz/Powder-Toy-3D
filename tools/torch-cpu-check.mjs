// Real lamp/motion code with only GPU cell reads stood in; no browser or GPU.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as THREE from 'three';
import torch from '../src/pov/tools/torch.tool.js';
import lantern from '../src/pov/tools/lantern.tool.js';
import { liveFlame, fanFlame } from '../src/pov/tools/lamp.js';
import { torchWater } from '../src/pov/tools/torchWater.js';
import { attachModel } from '../src/pov/models.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { E } from '../src/elements.js';
import { lamps } from '../src/pov/lamps.js';
import { povEvents } from '../src/pov/events.js';

let now = 0;
mock.method(performance, 'now', () => now);
const flush = () => new Promise(resolve => setImmediate(resolve));
const bytes = id => new Float32Array([id, 20, 0, 0]).buffer;
let id = E.EMPTY, reads = 0, sampled;
const sim = { g: { nx: 128, ny: 128, nz: 128 }, gravity: 0.025 };
setPovGpu(sim, {
  probe(name, { cells }) {
    assert.equal(name, 'povCells');
    reads++;
    sampled = cells[0];
    return Promise.resolve(bytes(id));
  },
});

const water = torchWater(() => sim), item = {}, at = new THREE.Vector3(4.9, 5.6, -0.1);
water.wet(item, at);
water.wet(item, at);
assert.equal(reads, 1, 'only one read in flight per torch');
assert.deepEqual(sampled, [4, 5, -1, 0], 'probe uses containing cell, not nearest centre');
await flush();
for (const [element, wet] of [[E.WATER, true], [E.SALTWATER, true], [E.EMPTY, false], [E.LAVA, false]]) {
  id = element; now += 101;
  water.wet(item, at); await flush();
  assert.equal(water.wet(item, at), wet);
}
let resolveOld;
setPovGpu(sim, { probe: () => new Promise(resolve => { resolveOld = resolve; }) });
now += 101; water.wet(item, at);
water.reset();
resolveOld(bytes(E.WATER)); await flush();
assert.equal(water.wet(item, at), false, 'old-world result cannot quench new-world torch');
resolveOld(bytes(E.EMPTY)); await flush();
setPovGpu(sim, { probe: () => Promise.reject(new Error('device lost')) });
now += 101; water.wet(item, at); await flush();
setPovGpu(sim, { probe: () => Promise.resolve(bytes(E.WATER)) });
now += 101; water.wet(item, at); await flush();
assert.equal(water.wet(item, at), true, 'failed reads can retry');
setPovGpu(sim, { probe: () => Promise.resolve(bytes(id)) });
console.log('ok water, saltwater, relight, read bounds, world reset and retry');

const scene = new THREE.Scene(), viewmodel = new THREE.Group(), volume = new THREE.Group();
scene.add(viewmodel, volume);
viewmodel.position.set(20, 20, 20);
let strike;
const env = {
  scene, viewmodel, getSim: () => sim, getScale: () => 1, getVolume: () => volume,
  ballistics: { fire(_at, _dir, _gravity, opts) { strike = opts.onStrike; return 1; } },
};
const ctx = {
  dt: 1 / 60, sim, eye: new THREE.Vector3(20, 20, 20), dir: new THREE.Vector3(0, 0, -1),
  player: { vel: new THREE.Vector3() }, primary: false, secondary: false,
};
let embers = 0;
const off = povEvents.on('torch:burn', () => { embers++; });
const tool = torch.create(env);
try {
  const frame = async () => { now += 101; tool.update(ctx); await flush(); tool.update(ctx); };
  id = E.EMPTY; await frame();
  const flame = viewmodel.getObjectsByProperty('name', 'flame').find(o => o.isGroup);
  const handLight = flame.children.find(o => o.children.some(c => c.isPointLight)).children.find(o => o.isPointLight);
  assert.equal(flame.visible, true);
  assert.equal(lamps.count, 1);
  id = E.WATER; await frame();
  assert.equal(flame.visible, false);
  assert.equal(handLight.visible, false);
  assert.equal(lamps.count, 0);
  const before = embers;
  await frame();
  assert.equal(embers, before, 'no new underwater embers');
  id = E.EMPTY; await frame();
  assert.equal(flame.visible, true);
  assert.equal(handLight.visible, true);
  assert.equal(lamps.count, 1);

  ctx.secondaryPressed = true; tool.update(ctx); ctx.secondaryPressed = false;
  povEvents.emit('round:move', { kind: 'torch', id: 1, to: new THREE.Vector3(20, 18, 18) });
  await flush();
  id = E.WATER; now += 101;
  povEvents.emit('round:move', { kind: 'torch', id: 1, to: new THREE.Vector3(20, 18, 18) });
  await flush();
  povEvents.emit('round:move', { kind: 'torch', id: 1, to: new THREE.Vector3(20, 18, 18) });
  assert.equal(lamps.count, 0, 'flying torch quenches');
  povEvents.emit('round:end', { kind: 'torch', id: 1 });
  strike({ hit: { point: new THREE.Vector3(20, 18, 18) }, normal: new THREE.Vector3(0, 1, 0) });
  await flush(); tool.tick(ctx);
  assert.equal(tool.props[0].lit, false);
  assert.equal(tool.props[0].flame.obj.visible, false);
  assert.equal(lamps.count, 0);
  id = E.EMPTY; now += 101; tool.tick(ctx); await flush(); tool.tick(ctx);
  assert.equal(tool.props[0].lit, true);
  assert.equal(tool.props[0].flame.obj.visible, true);
  assert.equal(lamps.count, 1, 'landed torch relights when water leaves');
} finally { tool.dispose(); off(); }
assert.equal(lamps.count, 0);
const lamp = lantern.create(env);
try {
  id = E.WATER; lamp.update(ctx);
  assert.equal(lamps.count, 1, 'lantern unaffected');
  ctx.primaryPressed = true; lamp.update(ctx); ctx.primaryPressed = false;
  assert.equal(lamps.count, 0, 'lantern toggle unaffected');
} finally { lamp.dispose(); }
console.log('ok held/flying/landed flame, light, embers, relight and lantern');

function motion(hz) {
  const model = attachModel(scene, 'torch', null, { arm: false });
  const f = liveFlame(model.obj, 'world'), dt = 1 / hz;
  const step = speed => { model.obj.position.x += speed * dt; fanFlame(f, dt, 1); };
  fanFlame(f, dt, 1);
  step(2);
  assert(f.wind.x > 0 && f.wind.x < f.vel.x * 0.2, 'plume starts later than torch velocity');
  for (let i = 1; i < hz / 2; i++) step(2);
  const settled = f.wind.x;
  step(-2);
  assert(f.wind.x > 0, 'reversal does not immediately flip plume');
  for (let i = 1; i < hz / 2; i++) step(-2);
  assert(f.wind.x < 0, 'plume eventually follows reversal');
  for (let i = 0; i < hz; i++) step(0);
  assert(Math.abs(f.wind.x) < 0.01, 'stopped torch settles upright');
  f.fresh = true; step(0);
  assert.equal(f.wind.length(), 0, 'reequip resets stale wind');
  model.obj.position.x += 100; step(0);
  assert.equal(f.wind.length(), 0, 'teleport is not a swing');
  fanFlame(f, 1, 1);
  assert.equal(f.wind.length(), 0, 'long frame resets motion');
  f.dispose(); model.dispose();
  return settled;
}
const lean = [30, 60, 120].map(motion);
assert(Math.max(...lean) - Math.min(...lean) < 1e-10, 'same response across frame rates');
mock.restoreAll();
console.log('ok delayed motion, reversal, settling, reset, teleport and 30/60/120 Hz');
