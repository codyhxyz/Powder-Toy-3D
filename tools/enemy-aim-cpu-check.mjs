// Actual infantry/gunner goals and objective firing, without a browser or GPU.
// Run: node tools/enemy-aim-cpu-check.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { Agent, REACTION_S, takeAimAndShoot } from '../src/pov/ai/brain.js';
import { GunnerAgent } from '../src/pov/ai/gunner.js';
import { trigger } from '../src/pov/tools/action.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../src/pov/constants.js';
import { povEvents } from '../src/pov/events.js';
registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { default: smg } = await import('../src/pov/tools/smg.tool.js');

function rig(kind = 'infantry', weapon = 'SMG', distance = 40) {
  const target = { id: 'player', pos: { x: 0, y: 0, z: distance }, vel: { x: 0, y: 0, z: 0 }, alive: true, holding: 'GUN' };
  const world = { visible: true, sees() { return this.visible; }, nearest: () => null, raycast: () => ({ valid: false }) };
  const npc = {
    body: { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, health: 1, onGround: true, jetFuel: 1 },
    world, target: () => target, packCells: () => 0,
    nav: { path: () => null },
  };
  const a = new (kind === 'gunner' ? GunnerAgent : Agent)(npc);
  a.weapons = new Set([weapon]);
  a.weapon = weapon; a.weaponAt = Infinity; // isolate each weapon from fuzzy selection
  a.regulator.ready = () => true;          // avoid Yuka's wall clock in a CPU fixture
  if (kind === 'objective') a.brain = {
    arbitrate() {},
    execute() { a.steerTo({ x: 10, z: 10 }, 0.9); takeAimAndShoot(a); },
    currentSubgoal() { return null; },
  };
  const button = trigger(weapon === 'SMG' ? 0.075 : weapon === 'SNIPER' ? 1.2 : 0.1, { hold: weapon === 'SMG' });
  const shots = [];
  function step(dt = 1 / 60) {
    a.think(dt);
    const i = a.intent;
    if (i.tool && button.ready({ ...i, dt })) {
      button.fire();
      shots.push({ time: a.now, aim: { ...i.look }, target: { ...target.pos } });
    } else if (!i.tool) button.reset();
    return i;
  }
  function run(seconds, dt = 1 / 60) { for (let i = 0; i < Math.round(seconds / dt); i++) step(dt); }
  return { a, npc, target, world, shots, step, run };
}

function hits(shot) {
  const t = shot.target.z / shot.aim.z;
  const y = 5 + (shot.aim.y - 5) * t;
  return t > 0 && Math.abs(shot.aim.x * t - shot.target.x) <= BODY_WIDTH / 2
    && y >= shot.target.y && y <= shot.target.y + BODY_HEIGHT;
}
const firing = (a) => a.intent.primary || a.intent.primaryPressed;
const random = Math.random;
let seed = 123456;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) + 0.5) / 2 ** 32;
try {
  for (const kind of ['infantry', 'gunner', 'objective']) {
    const r = rig(kind);
    r.run(REACTION_S - 0.05);
    assert.equal(r.shots.length, 0, `${kind}: reaction delay blocks firing`);
    while (!r.shots.length) r.step();
    const start = r.a.now;
    assert.ok(Math.abs(r.a.intent.look.x) > BODY_WIDTH / 2, `${kind}: burst starts beside target`);
    let lastError = Math.abs(r.a.intent.look.x);
    r.step();
    while (r.a.gunBurst) {
      const error = Math.abs(r.a.intent.look.x);
      assert.ok(error < lastError, `${kind}: aim corrects inward, never re-rolls`);
      lastError = error;
      r.step();
    }
    const count = r.shots.length;
    assert.ok(count >= 6 && count <= 9, `${kind}: bounded burst (${count} shots)`);
    assert.ok(r.shots.slice(1).every(hits), `${kind}: later aim rays hit stationary target`);
    assert.ok(r.a.now - start <= 0.65, `${kind}: trigger released after short burst`);
    r.run(0.5);
    assert.equal(r.shots.length, count, `${kind}: genuine pause between bursts`);
    assert.equal(r.a.intent.secondary, true, `${kind}: uses existing ironsights, not wide hip-fire spread`);
    if (kind === 'objective') {
      assert.equal(r.a.intent.share, 0.9);
      assert.equal(r.a.seek.active, true, 'shooting preserves objective steering');
    }
    r.run(2);
    assert.ok(r.shots.length > count, `${kind}: firing resumes after rest`);
    console.log(`${kind}: ${count}-shot burst, inward correction, pause, stationary aim hits`);
  }

  for (const weapon of ['GUN', 'SNIPER']) {
    const r = rig('infantry', weapon, 70);
    r.run(5);
    assert.ok(r.shots.length >= 2);
    assert.ok(r.shots.every(hits), `${weapon}: single shots are not forced warning misses`);
    assert.ok(!r.a.intent.primary, `${weapon}: no automatic trigger hold`);
  }
  for (const weapon of ['ROCKET', 'LASER']) {
    const p = rig('objective', weapon);
    p.run(0.85);
    assert.equal(p.a.intent.look.y, weapon === 'ROCKET' ? 0.5 : 3, `${weapon}: preserves its aim height`);
    p.target.pos.x = 5;
    p.step();
    assert.ok(p.a.intent.look.x > 0 && p.a.intent.look.x < 5, `${weapon}: shares tracking lag`);
    p.world.visible = false;
    p.step();
    assert.ok(!firing(p.a), `${weapon}: cover interrupts fire/charge`);
    assert.equal(p.a.aimState, null);
    if (weapon === 'LASER') assert.equal(p.a.useState, null, 'cover discards laser wind-up');
  }

  // Tracking follows positions, not supplied velocity, and catches up after a stop.
  const r = rig('objective', 'GUN');
  r.run(1);
  for (let frame = 0; frame < 60; frame++) { r.target.pos.x += 24 / 60; r.step(); }
  const lag = r.target.pos.x - r.a.aimState.point.x;
  assert.ok(lag > BODY_WIDTH && lag < 5, `moving target buys tracking time (${lag} cells lag)`);
  const before = r.a.aimState.point.x;
  r.run(0.5);
  assert.ok(r.a.aimState.point.x > before);
  assert.ok(Math.abs(r.target.pos.x - r.a.aimState.point.x) < 0.2, 'standing still lets aim catch up');
  r.run(1);
  assert.ok(hits(r.shots.at(-1)), 'stationary follow-up is on target again');

  // Loss of sight cancels current burst and does not sample hidden target movement.
  for (const kind of ['infantry', 'gunner', 'objective']) {
    const c = rig(kind, 'SMG');
    c.run(0.85);
    assert.ok(c.a.gunBurst);
    c.world.visible = false;
    c.target.pos.x = 20;
    c.step();
    assert.equal(c.a.aimState, null, `${kind}: loses aim lock behind cover`);
    assert.equal(c.a.gunBurst, null);
    assert.ok(!firing(c.a), `${kind}: no firing through cover`);
    c.run(0.5);
    c.world.visible = true;
    c.step();
    assert.equal(c.a.inSight, 0, `${kind}: reacquisition restarts reaction window`);
    c.run(0.5);
    assert.ok(!firing(c.a));
    c.run(1);
    assert.ok(c.shots.at(-1).time > 2, `${kind}: resumes after reacquisition`);
    c.a.stagger();
    c.step();
    assert.ok(!firing(c.a));
    assert.equal(c.a.gunBurst, null, `${kind}: stagger cancels burst`);
    c.a.landed();
    c.run(0.5);
    assert.ok(!firing(c.a), `${kind}: landed-hit breather preserved`);
  }

  // Touch/radar can reveal a location, never grant a firing sightline.
  for (const multiple of [false, true]) {
    const c = rig('objective', 'GUN', 2);
    if (multiple) c.npc.opponents = () => [c.target];
    c.world.visible = false;
    c.run(2);
    assert.equal(c.a.knows, true);
    assert.equal(c.a.sees, false);
    assert.equal(c.shots.length, 0, 'even point-blank cover blocks fire');
  }

  // A second opponent visible all along still requires target acquisition.
  const t = rig('objective', 'SMG');
  const other = { ...t.target, id: 'other', pos: { x: 10, y: 0, z: 40 }, priority: -100 };
  t.npc.opponents = () => [t.target, other];
  t.run(0.85);
  assert.ok(t.a.gunBurst);
  other.priority = 100;
  t.step();
  assert.equal(t.a.foeId, 'other');
  assert.equal(t.a.inSight, 0);
  assert.equal(t.a.gunBurst, null);
  assert.ok(!firing(t.a), 'cannot transfer active burst/lock to another target');

  // Changing weapons cannot inherit a held SMG burst.
  const w = rig('objective');
  w.run(0.85);
  w.a.weapons = new Set(['SNIPER']);
  w.a.weapon = 'SNIPER';
  w.step();
  assert.equal(w.a.gunBurst, null);
  assert.ok(!w.a.intent.primary);

  // Exact exponential convergence for a fixed target is frame-rate independent.
  const positions = [];
  for (const fps of [30, 60, 120]) {
    const f = rig('objective', 'GUN');
    f.step(1 / fps);
    f.target.pos.x = 10;
    f.run(0.5, 1 / fps);
    positions.push(f.a.aimState.point.x);
  }
  assert.ok(Math.max(...positions) - Math.min(...positions) < 1e-10);

  // Actual SMG trigger, ADS and bloom: no duplicate spread formula in the test.
  const hitRates = [];
  for (const moving of [false, true]) {
    const f = rig('objective');
    const eye = new THREE.Vector3(0, 5, 0), dir = new THREE.Vector3();
    let shots = 0, hitCount = 0, maxCone = 0;
    const tool = smg.create({
      viewmodel: new THREE.Group(), getVolume: () => new THREE.Object3D(), getScale: () => 1,
      ballistics: { count: 0, fire(origin, direction) {
        shots++;
        const p = origin.clone().addScaledVector(direction, f.target.pos.z / direction.z);
        if (hits({ aim: p, target: f.target.pos })) hitCount++;
        return shots;
      } },
    });
    try {
      // Three.js mesh UUIDs consume randomness; seed firing after cosmetic setup.
      seed = 123456;
      for (let frame = 0; frame < 900; frame++) {
        // Strafe at 24 cells/s, reversing at +/-12 cells; stay in weapon range.
        if (moving) f.target.pos.x = 12 - Math.abs((frame * 24 / 60 + 12) % 48 - 24);
        f.step();
        const look = f.a.intent.look ?? f.target.pos;
        dir.set(look.x, look.y, look.z).sub(eye).normalize();
        povEvents.as({ id: 'enemy-aim-test', at: eye }, () => tool.update({
          ...f.a.intent, dt: 1 / 60, eye, dir, sim: { gravity: 0.025 },
          player: { onGround: true, applyImpulse() {} },
        }));
        if (tool.lastShot) maxCone = Math.max(maxCone, tool.lastShot.cone);
      }
      assert.ok(shots >= 60, 'samples multiple real SMG bursts');
      assert.ok(maxCone < 5 * Math.PI / 180, 'ADS and burst pauses keep real spread modest');
      hitRates.push(hitCount / shots);
      console.log(`Real SMG at 40 cells, ${moving ? 'strafing' : 'stationary'}: ${hitCount}/${shots} shot rays hit`);
    } finally { tool.dispose(); }
  }
  assert.ok(hitRates[0] > 0.75, 'standing still is dangerous with actual weapon spread');
  assert.ok(hitRates[0] - hitRates[1] > 0.4, 'movement buys time against the actual firing path');
  console.log('PASS: movement lag, convergence, cover, reacquisition, target/weapon switches, interruptions, 30/60/120 Hz');
} finally {
  Math.random = random;
}
