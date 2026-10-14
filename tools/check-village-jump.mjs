// Real player + Three.js mixer, CPU only. No browser or GPU.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayer, PX } from '../src/pov/player.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';
import { modeByKey, resolveMode, mapByKey } from '../src/maps.js';
import { character, dispose } from '../src/pov/village/models.js';

const village = { chargeJump: true, jumpYaw: 0 };
const near = (a, b, tolerance = 0.01) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
assert.equal(resolveMode(mapByKey('willowCove'), 'animalCrossing').gravityScale, 0.5);
assert.equal(modeByKey('sandbox').gravityScale ?? 1, 1);
assert.equal(resolveMode(mapByKey('lab'), 'animalCrossing').gravityScale ?? 1, 1);

async function fixture(fps = 60) {
  const sim = { g: { nx: 2048, ny: 128, nz: 2048 }, gravity: 0.025 * modeByKey('animalCrossing').gravityScale,
    frame: 0, touchCentres() { return []; }, paint() {} };
  let water = false;
  setPovGpu(sim, {
    ready: true, edit: () => true, transfer: () => null,
    probe(name, { boxLo: lo }) {
      const buf = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        buf[i] = lo[1] + y <= 0 ? E.WALL : water && lo[1] + y < 20 ? E.WATER : E.EMPTY;
        buf[i + 1] = 20;
      }
      return Promise.resolve(buf.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
  const run = async (seconds, input = village, each = () => {}) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      sim.frame += 4; body.update(1 / fps, input);
      await new Promise(resolve => setImmediate(resolve));
      each();
    }
  };
  const reset = async () => { body.spawn(new THREE.Vector3(512, 1, 512)); await run(0.2); };
  await reset();
  return { body, run, reset, sim, water(v) { water = v; } };
}

const apexes = [];
for (const fps of [20, 60, 144]) {
  const { body, run, reset } = await fixture(fps);
  try {
    await run(1.2, { ...village, jump: true });
    assert.ok(body.onGround, 'hold does not jump');
    assert.equal(body.jumpCharge, 1, 'charge saturates');
    assert.equal(body.jetting, false);
    await run(1 / fps);
    assert.ok(body.leaping && !body.onGround, 'release launches');
    assert.equal(body.jumpCharge, null, 'meter disappears on takeoff');
    assert.ok(body.vel.z < -40, 'a stationary leap travels in the facing direction');
    const start = body.pos.clone();
    let apex = body.pos.y;
    await run(0.2, { ...village, jump: true }, () => {
      assert.equal(body.jetting, false, 'no airborne jet in village');
      assert.equal(body.jumpCharge, null, 'no midair charge');
      apex = Math.max(apex, body.pos.y);
    });
    await run(1.8, village, () => { apex = Math.max(apex, body.pos.y); });
    assert.ok(body.onGround && !body.leaping, 'lands and resets');
    assert.ok(start.z - body.pos.z > 45, 'forward momentum survives release');
    apexes.push(apex);

    await reset();
    await run(1 / fps, { ...village, jump: true });
    await run(1 / fps);
    let tapApex = body.pos.y;
    await run(1.4, village, () => { tapApex = Math.max(tapApex, body.pos.y); });
    assert.ok(apex > tapApex * 3, 'full charge is much bigger than a tap');
    console.log(`${fps} fps: tap apex ${tapApex.toFixed(2)}, full apex ${apex.toFixed(2)} cells`);
  } finally { body.dispose(); }
}
near(apexes[0], apexes[1], 0.15);
near(apexes[1], apexes[2], 0.05);

{
  const f = await fixture(), { body, run, reset, sim } = f;
  try {
    for (const cancel of [() => body.cancelJump(), () => body.teleport(body.pos.clone()), () => body.spawn(body.pos.clone())]) {
      await reset();
      await run(0.4, { ...village, jump: true });
      cancel(); await run(0.2);
      assert.ok(body.onGround && !body.leaping);
      assert.equal(body.jumpCharge, null);
    }
    await run(0.4, { ...village, jump: true });
    await run(0.1, { ...village, cancelJump: true });
    assert.ok(body.onGround, 'opening a menu is cancellation, not key release');
    await run(0.4, { ...village, jump: true });
    await run(0.1, {});
    assert.ok(body.onGround, 'mode switch cancels a held charge');
    assert.equal(body.jumpCharge, null);

    await run(0.4, { ...village, jump: true });
    body.hurt(2, 'test', { shielded: false });
    await run(0.1);
    assert.equal(body.jumpCharge, null);
    assert.equal(body.leaping, false);
    await reset();
    await run(0.4, { ...village, jump: true });
    f.water(true);
    await run(0.2, { ...village, jump: true });
    assert.equal(body.jumpCharge, null);
    assert.ok(body.vel.y > 0, 'Space still swims upward');
    assert.equal(body.jetting, false);
    f.water(false);

    await reset();
    await run(0.8, { ...village, jump: true, move: { x: 1, z: 0 } });
    await run(1 / 60, { ...village, move: { x: 1, z: 0 } });
    assert.ok(body.vel.x > 40 && Math.abs(body.vel.z) < 0.01, 'movement direction wins over facing');
    await reset();
    await run(0.8, { ...village, jump: true, jumpYaw: Math.PI / 2 });
    await run(1 / 60, { ...village, jumpYaw: Math.PI / 2 });
    assert.ok(body.vel.x < -40, 'stationary leap follows camera yaw');

    // Unmodified Sandbox jump, jetpack and pogo.
    sim.gravity = 0.025;
    await reset();
    await run(1 / 60, { jump: true });
    assert.ok(body.vel.y > 80 * PX && !body.onGround);
    await run(0.2, { jump: true });
    assert.ok(body.jetting);
    await reset();
    body.holdPogo();
    await run(1 / 60, {});
    assert.ok(body.pogoing && body.vel.y > 0);
  } finally { body.dispose(); }
}

// Pose playback, held charge, landing, cancellation, and reduced motion use the actual mixer.
for (const reduced of [false, true]) {
  globalThis.matchMedia = () => ({ matches: reduced });
  const avatar = character(), body = avatar.root.children[0];
  let time = 0;
  const pose = { jumpCharge: 1, onGround: true, leaping: false, vel: { y: 0 } };
  const animate = n => { for (let i = 0; i < n; i++) avatar.animate(time += 1 / 60, 20, false, false, 0, 0, false, false, pose); };
  try {
    animate(60);
    near(body.position.y, reduced ? -0.15 : -0.6);
    const heldY = body.position.y;
    animate(60); near(body.position.y, heldY, 1e-8);
    Object.assign(pose, { jumpCharge: null, onGround: false, leaping: true, vel: { y: 30 } });
    animate(20);
    assert.ok(body.rotation.x < (reduced ? -0.1 : -0.4), 'forward leap, not walking in air');
    const lean = body.rotation.x;
    animate(30); near(body.rotation.x, lean, 1e-8);
    const arm = avatar.hand.rotation.x;
    avatar.animate(time += 1 / 60, 20, false, false, 0, 0.5, false, false, pose);
    near(avatar.hand.rotation.x, 1.8, 1e-8);
    animate(1); near(avatar.hand.rotation.x, arm, 1e-8);
    avatar.animate(time += 1 / 60, 20, false, false, 0, 0, true, false, pose);
    near(avatar.hand.rotation.x, 0.9, 1e-8);
    animate(1); near(avatar.hand.rotation.x, arm, 1e-8);
    pose.vel.y = -10; animate(20);
    assert.ok(body.rotation.x > lean, 'prepare feet for landing');
    Object.assign(pose, { onGround: true, leaping: false });
    animate(5); assert.ok(body.position.y < -0.02, 'landing compression');
    animate(40); near(body.rotation.x, 0);
    pose.jumpCharge = 1; animate(20);
    avatar.reset(); pose.jumpCharge = null; animate(1);
    near(body.rotation.x, 0, 1e-8);
  } finally { dispose(avatar.root); }
}
delete globalThis.matchMedia;
console.log('PASS village charged jump, mode isolation, cancellations, swimming, frame rates and Three.js leap/landing playback');
