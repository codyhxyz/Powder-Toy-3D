// Real body + camera over a still CPU probe, no browser/GPU. Run: node tools/check-sprint.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayer, PX } from '../src/pov/player.js';
import { createPovCamera } from '../src/pov/camera.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';
import { character, dispose } from '../src/pov/village/models.js';
import { viewmodelRig } from '../src/pov/viewmodel.js';

const walk = 19 * PX, launch = 38 * PX, ceiling = 114 * PX;
const sprint = { move: { x: 1, z: 0 }, sprint: true };
const near = (a, b, tolerance = 0.01) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const speedH = (body) => Math.hypot(body.vel.x, body.vel.z);
const rushOf = (speed) => Math.max(0, Math.min(1, (speed - walk) / (ceiling - walk)));

async function fixture(fps = 60, id = null) {
  const sim = { g: { nx: 2048, ny: 128, nz: 2048 }, frame: 0, gravity: 0.025, touchCentres() { return []; }, paint() {} };
  let wall = false, liquid = false;
  setPovGpu(sim, {
    ready: true, edit: () => true, transfer: () => null,
    probe(name, { boxLo: lo }) {
      const buf = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        buf[i] = lo[1] + y <= 0 || (wall && lo[0] + x >= 520) ? E.WALL : liquid && lo[1] + y < 20 ? E.WATER : E.EMPTY;
        buf[i + 1] = 20;
      }
      return Promise.resolve(buf.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true, id });
  const run = async (seconds, input = {}, each = () => {}) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      sim.frame += 4;
      body.update(1 / fps, input);
      await new Promise(resolve => setImmediate(resolve));
      each(body, (i + 1) / fps);
    }
  };
  body.spawn(new THREE.Vector3(512, 1, 512));
  await run(0.2);
  return { body, run, wall(v) { wall = v; }, liquid(v) { liquid = v; } };
}

const profiles = [];
for (const fps of [20, 60, 144]) {
  const { body, run } = await fixture(fps);
  try {
    const samples = [];
    let previous = 0, peakPush = 0, peakTime = 0;
    await run(8, sprint, (p, t) => {
      assert.ok(p.vel.x >= previous - 1e-9, 'no speed dip or overshoot during build');
      assert.ok(p.vel.x <= ceiling + 1e-9);
      const push = (p.vel.x - previous) * fps;
      if (t > 1 && push > peakPush) { peakPush = push; peakTime = t; }
      if (t > 7.5) assert.ok(push < 0.1, 'rounded ceiling, no final shove');
      previous = p.vel.x;
      if ([0.3, 1, 2, 3.5, 5.25, 7.5].some(at => Math.abs(t - at) < 0.5 / fps)) samples.push([t, p.vel.x]);
    });
    const at = time => samples.find(([t]) => Math.abs(t - time) < 0.5 / fps)[1];
    assert.ok(at(0.3) > walk * 1.8 && at(0.3) < launch, 'immediate launch, no input dead zone');
    assert.ok(at(2) < launch + (ceiling - launch) * 0.05, 'restrained early build');
    assert.ok(at(3.5) < launch + (ceiling - launch) * 0.22, 'save most acceleration for second half');
    assert.ok(at(5.25) > launch + (ceiling - launch) * 0.55, 'late surge is substantial');
    near(at(7.5), ceiling);
    near(body.sprintRush, 1);
    assert.ok(peakTime > 5 && peakTime < 6, 'the strongest build comes in the last third');
    profiles.push(samples);
    console.log(`${fps} fps speed (cells/s):`, samples.map(([t, v]) => `${t.toFixed(2)}s=${v.toFixed(2)}`).join(' '));

    await run(0.3, { move: sprint.move });
    assert.ok(body.vel.x < walk * 1.3, 'release promptly returns to walk');
    assert.equal(body.sprintBuild, 0);
    near(body.sprintRush, rushOf(body.vel.x), 0.02);
    await run(0.5, { move: sprint.move });
    near(body.vel.x, walk, 0.03);
  } finally { body.dispose(); }
}
for (let i = 0; i < profiles[0].length; i++) {
  near(profiles[0][i][1], profiles[1][i][1], 0.5);
  near(profiles[1][i][1], profiles[2][i][1], 0.15);
}

{
  const f = await fixture(), { body, run } = f;
  try {
    await run(8, { sprint: true });
    assert.equal(body.sprintBuild, 0, 'holding Shift at rest cannot charge');
    f.wall(true);
    await run(8, sprint);
    assert.equal(body.sprintBuild, 0, 'a wall cannot charge');
    assert.equal(body.sprintRush, 0, 'no speed effects at a wall');
    f.wall(false);
    await run(0.3, sprint);
    assert.ok(body.vel.x < launch + 0.1, 'no banked wall launch');
    await run(8, sprint);
    const savedVelocity = body.vel.clone();
    body.vel.set(0, 0, 0);
    assert.equal(body.sprintRush, 0, 'external furniture/vehicle collision immediately removes speed effects');
    body.vel.copy(savedVelocity);
    const reverse = { ...sprint, move: { x: -1, z: 0 } };
    await run(1 / 60, reverse);
    assert.equal(body.sprintBuild, 0, 'reversal resets the run-up');
    await run(0.5, reverse);
    assert.ok(body.vel.x < -launch * 0.9 && body.vel.x > -launch * 1.05);
    await run(8, reverse);
    await run(0.4);
    assert.ok(body.vel.length() < 1.3, 'no skating after releasing movement');

    await run(4, sprint);
    await run(1 / 60, { ...sprint, jump: true });
    const charge = body.sprintBuild;
    assert.ok(!body.onGround && !body.jetting);
    await run(0.2, sprint);
    near(body.sprintBuild, charge, 1e-8);
    assert.ok(body.sprintRush > 0.2, 'a hop keeps the music');
    await run(0.25, { ...sprint, jump: true });
    assert.equal(body.sprintBuild, 0, 'jet flight is not a sprint');
    assert.ok(body.jetting);
    near(body.sprintRush, rushOf(speedH(body)), 0.02);
    assert.ok(body.sprintRush > 0.2, 'a sprint-jump keeps the music while you are still fast');
    await run(1.5);
    assert.ok(speedH(body) <= walk);
    assert.equal(body.sprintRush, 0, 'the music stops once you are back to a walk');

    body.teleport(new THREE.Vector3(512, 1, 512));
    assert.equal(body.sprintBuild, 0);
    assert.equal(body.sprintRush, 0);
    await run(8, sprint);
    await run(0.1, { ...sprint, crouch: true });
    assert.equal(body.sprintBuild, 0);
    assert.equal(body.sprintRush, 0);

    body.spawn(new THREE.Vector3(512, 1, 512));
    await run(8, sprint);
    f.liquid(true);
    await run(0.2, sprint);
    assert.equal(body.sprintBuild, 0, 'swimming cancels the run-up');
    assert.equal(body.sprintRush, 0);
    f.liquid(false);
    body.spawn(new THREE.Vector3(512, 1, 512));
    await run(8, sprint);
    body.hurt(2, 'test', { shielded: false });
    await run(0.1, sprint);
    assert.ok(body.dead);
    assert.equal(body.sprintRush, 0);
    body.spawn(new THREE.Vector3(512, 1, 512));
    assert.equal(body.sprintBuild, 0);
    assert.equal(body.sprintRush, 0);
  } finally { body.dispose(); }
}

for (const [id, move, expected, perk] of [
  ['npc:test', sprint.move, 57 * PX],
  [null, { x: 1, z: 1 }, ceiling],
  [null, sprint.move, 60, 'FLEET_FOOT'],
]) {
  const { body, run } = await fixture(60, id);
  try {
    if (perk) body.perks.add(perk);
    await run(8, { ...sprint, move });
    near(Math.hypot(body.vel.x, body.vel.z), expected);
  } finally { body.dispose(); }
}

{
  const { body, run } = await fixture();
  try {
    const drop = async (flap) => {
      body.spawn(new THREE.Vector3(512, 40, 512));
      let t = 0, since = 1, top = body.pos.y;
      while (body.pos.y > 1.2 && t < 3) {
        const jump = flap && since >= 0.2 && !body.onGround;
        await run(1 / 60, jump ? { jump: true } : {});
        since = jump ? 0 : since + 1 / 60;
        t += 1 / 60;
        top = Math.max(top, body.pos.y);
      }
      return { t, top };
    };
    const plain = await drop(false);
    const flapped = await drop(true);
    console.log(`chicken flap: ${plain.t.toFixed(3)}s fall -> ${flapped.t.toFixed(3)}s mashed`);
    assert.ok(flapped.t > plain.t + 0.4, `double-strength flapping substantially extends airtime (${plain.t.toFixed(3)} -> ${flapped.t.toFixed(3)})`);
    assert.ok(flapped.t < 3, 'bounded wingbeats still descend without the jet');
    assert.ok(flapped.top < 41, 'wingbeats cannot bank unlimited upward speed');

    body.spawn(new THREE.Vector3(512, 8, 512));
    await run(0.12);
    const before = body.vel.y;
    await run(1 / 60, { jump: true });
    assert.ok(!body.jetting, 'a tap is not the jet');
    assert.ok(body.flap > 0.8, 'a new animation beat starts on the tap');
    assert.ok(body.vel.y <= 8.01);
    assert.ok(body.vel.y > before, 'a flap shaves the fall');
    const after = body.vel.y;
    await run(1 / 60);
    await run(1 / 60, { jump: true });
    assert.ok(body.vel.y < after, 'the next tap inside the wingbeat adds no lift');
    let jetted = false;
    await run(0.25, { jump: true }, (b) => { if (b.jetting) jetted = true; });
    assert.ok(jetted, 'holding the air press still jets');
    body.spawn(new THREE.Vector3(512, 1, 512));
    await run(0.15);
    assert.ok(body.onGround);
    await run(3 / 60, { jump: true });
    assert.ok(body.jetting, 'a jump you keep holding still jets');
  } finally { body.dispose(); }
}

for (const fps of [20, 60, 144]) {
  const { body, run } = await fixture(fps);
  try {
    const tap = async (jump, vy) => {
      body.spawn(new THREE.Vector3(512, 100, 512));
      await run(0.1);
      body.vel.y = vy;
      await run(1 / fps, jump ? { jump: true } : {});
      return body.vel.y;
    };
    const falling = await tap(false, -80), lifted = await tap(true, -80);
    near(lifted - falling, 44, 1e-6);   // exactly 2 × the old 22 cells/s impulse
    assert.ok(!body.jetting, 'the doubled impulse does not activate the jet');
    await run(0.25);
    assert.equal(body.flap, 0, 'a stroke recovers before the next allowed beat');
    const gravityOnly = await tap(false, 0), capped = await tap(true, 0);
    near(capped - gravityOnly, 8, 1e-6);
    assert.ok(capped <= 8, 'doubled upward cap, accounting for this frame gravity');
  } finally { body.dispose(); }
}

// The camera reads attained speed, not the key or a threshold; scopes stay unchanged.
const camera = createPovCamera({ fov: () => 75, bobbing: () => false });
const state = {
  dt: 1 / 60, eye: new THREE.Vector3(0, 5, 0), feet: new THREE.Vector3(), scale: 1,
  speedH: ceiling, onGround: true, inLiquid: false, dead: false,
  box: { min: new THREE.Vector3(-100, -100, -100), max: new THREE.Vector3(100, 100, 100), margin: 0.5 },
};
for (const rush of [0, 0.2, 1, 0]) {
  let pose;
  for (let i = 0; i < 180; i++) pose = camera.update({ ...state, sprintRush: rush });
  near(pose.fov, 75 + 7 * rush);
}
camera.zoom = 2;
let pose;
for (let i = 0; i < 180; i++) pose = camera.update({ ...state, sprintRush: 1 });
near(pose.fov, 37.5);
const avatar = character();
try {
  for (let i = 1; i <= 120; i++) avatar.animate(i / 60, ceiling, false, false, 1);
  near(avatar.root.children[0].rotation.x, -0.55);
  for (let i = 121; i <= 240; i++) avatar.animate(i / 60, 0);
  near(avatar.root.children[0].rotation.x, 0);
} finally { dispose(avatar.root); }
// Tool contexts wrap the body; they do not copy sprintRush onto ctx.player.
const rig = viewmodelRig({ viewmodel: new THREE.Group(), getScale: () => 1 });
try {
  const ctx = { dt: 1 / 60, dir: new THREE.Vector3(0, 0, -1), player: {
    vel: new THREE.Vector3(ceiling, 0, 0), onGround: true, inLiquid: false, body: { sprintRush: 1 },
  } };
  for (let i = 1; i <= 120; i++) {
    rig.update(ctx);
    const t = i / 60, amplitude = 0.35 * (1 - Math.exp(-8 * t));
    near(rig.state.pos.x, 0.04 * amplitude * Math.sin(ceiling / 2 / 9 * 2 * Math.PI * t), 1e-8);
  }
} finally { rig.dispose(); }
console.log('sprint: curve, frame rates, controls, walls, hops, jet, crouch, water, death, respawn, NPC, diagonal, perks and FOV OK');
