// Real hook and body over CPU cell probes. No browser, GPU or model downloads.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import hookDef from '../src/pov/tools/hook.tool.js';
import { createPlayer } from '../src/pov/player.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

async function fixture(fps = 60) {
  const sim = { g: { nx: 512, ny: 256, nz: 512 }, frame: 0, gravity: 0.025, touchCentres: () => [], paint() {} };
  let anchorId = E.ROCK;
  setPovGpu(sim, {
    ready: true, edit: () => true, transfer: () => null,
    probe(name, { boxLo: lo }) {
      if (name === 'povCells') return Promise.resolve(new Float32Array([anchorId, 20, 0, 0]).buffer);
      const buf = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        buf[i] = lo[1] + y < 1 ? E.WALL : E.EMPTY;
        buf[i + 1] = 20;
      }
      return Promise.resolve(buf.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
  const scene = new THREE.Scene(), viewmodel = new THREE.Group(), volume = new THREE.Group();
  scene.add(viewmodel, volume);
  const events = [];
  const hook = hookDef.create({
    scene, viewmodel, getSim: () => sim, getVolume: () => volume, getScale: () => 1,
    isActive: () => true, feedback: { act: action => events.push(action) },
  });
  const ctx = {
    dt: 1 / fps, sim, player: { body }, eye: new THREE.Vector3(), dir: new THREE.Vector3(),
    aim: { valid: true, cell: new THREE.Vector3(), id: E.ROCK, face: 1, dist: 0 },
    primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, grappleJump: false,
  };
  const frame = async (input = {}) => {
    sim.frame += 4;
    body.update(ctx.dt, input);
    ctx.eye.copy(body.pos).setY(body.pos.y + body.eyeHeight);
    ctx.grappleJump = !!input.jump;
    hook.tick(ctx);
    await flush();
  };
  const frames = async (n, input = {}, each = () => {}) => {
    for (let i = 0; i < n; i++) { await frame(input); each(); }
  };
  body.spawn(new THREE.Vector3(200, 1, 200));
  await frames(5);
  const fire = cell => {
    ctx.aim.cell.copy(cell);
    const hit = cell.clone().addScalar(0.5).add(new THREE.Vector3(-0.5, 0, 0));
    ctx.dir.subVectors(hit, ctx.eye).normalize();
    ctx.aim.dist = hit.distanceTo(ctx.eye);
    hook.grapple(ctx);
  };
  const attached = async () => {
    for (let i = 0; i < fps && hook.state === 'out'; i++) await frame();
    assert.equal(hook.state, 'anchor');
  };
  return { body, hook, ctx, events, frame, frames, fire, attached, anchorId: id => { anchorId = id; },
    dispose() { hook.dispose(); body.dispose(); } };
}

for (const fps of [30, 60, 120]) {
  const f = await fixture(fps), { body, hook, ctx, fire, attached, frame, frames } = f;
  try {
    fire(new THREE.Vector3(215, 65, 200));
    await attached();
    const length = hook.rope.length;
    assert.ok(hook.grappling && hook.rope.swing);
    hook.deselect();
    assert.equal(body.rope, hook.rope, 'changing weapons keeps the shortcut tether');
    ctx.primary = ctx.primaryPressed = ctx.secondaryPressed = true;
    hook.update(ctx);
    assert.equal(hook.rope.reel, 0, 'held weapon buttons do not operate the shortcut');
    ctx.primary = ctx.primaryPressed = ctx.secondaryPressed = false;
    body.vel.set(-25, 40, 0);
    let minX = body.pos.x, maxX = minX, stretch = 0, inward = false, outward = false;
    await frames(fps * 3, { move: { x: 1, z: 0 } }, () => {
      assert.equal(hook.state, 'anchor');
      near(hook.rope.length, length);
      assert.equal(hook.rope.reel, 0, 'overhead rope never auto-reels');
      minX = Math.min(minX, body.pos.x); maxX = Math.max(maxX, body.pos.x);
      stretch = Math.max(stretch, body.ropeHand().distanceTo(hook.rope.anchor) - length);
      inward ||= body.vel.x > 5; outward ||= body.vel.x < -5;
    });
    assert.ok(maxX - minX > 10 && inward && outward, 'a full pendulum arc with controllable momentum');
    assert.ok(stretch < 1.5, `bounded rope stretch at ${fps} fps: ${stretch}`);
    await frame({ jump: true });
    assert.equal(hook.rope.reel, 0, 'jump does not shorten an overhead swing');
    const velocity = body.vel.clone();
    hook.grapple(ctx);
    assert.equal(body.rope, null, 'second E releases');
    assert.equal(hook.grappling, false);
    assert.deepEqual(body.vel.toArray(), velocity.toArray(), 'release does not eat momentum');
    await frame({ move: { x: Math.sign(velocity.x), z: 0 } });
    assert.ok(Math.abs(body.vel.x) >= Math.abs(velocity.x) - 0.1, 'air steering preserves launch velocity');
    console.log(`ok ${fps} fps overhead swing, input pumping, fixed length, release momentum`);
  } finally { f.dispose(); }
}

{
  const f = await fixture(), { body, hook, ctx, fire, attached, frames } = f;
  try {
    fire(new THREE.Vector3(260, 6, 200));
    await attached();
    await frames(12);
    assert.equal(hook.rope.reel, 0, 'front anchor waits for a jump');
    const start = body.pos.x, length = hook.rope.length;
    await frames(6, { jump: true });
    assert.ok(hook.rope.reel > 0 && body.pos.x > start + 1, 'jump engages forward pull');
    await frames(12);
    assert.ok(hook.rope.reel > 0, 'a tap keeps pulling without holding E or Space');
    assert.ok(hook.rope.length < length && body.vel.x > 15, 'winch takes up slack and builds forward speed');
    body.vel.z = 30;
    await frames(1);
    assert.ok(body.vel.z > 25, 'reeling preserves lateral swing instead of damping it');
    const anchor = hook.rope.anchor.clone(), claw = hook.claw;
    hook.windowShifted(32, -16);
    near(hook.rope.anchor.x, anchor.x - 32);
    near(hook.rope.anchor.z, anchor.z + 16);
    near(hook.claw.x, claw.x - 32);
    hook.worldReplaced();
    assert.equal(hook.state, 'idle');
    assert.equal(hook.grappling, false);
    assert.equal(body.rope, null);
    console.log('ok front jump pull, persistent winch, lateral momentum, window shift, world replacement');
  } finally { f.dispose(); }
}

for (const reason of ['tear', 'cancel', 'teleport', 'death']) {
  const f = await fixture(), { body, hook, fire, attached, frame } = f;
  try {
    fire(new THREE.Vector3(220, 55, 200)); await attached();
    if (reason === 'tear') { f.anchorId(E.EMPTY); await frame(); await frame(); }
    if (reason === 'cancel') hook.cancelGrapple();
    if (reason === 'teleport') { body.teleport(new THREE.Vector3(180, 1, 180)); await frame(); }
    if (reason === 'death') { body.hurt(2, 'test', { shielded: false }); await frame(); }
    assert.equal(hook.grappling, false, reason);
    assert.equal(body.rope, null, reason);
    if (reason === 'tear') assert.ok(f.events.includes('tear'));
  } finally { f.dispose(); }
}

{
  const f = await fixture(), { body, hook, fire, frames } = f;
  try {
    fire(new THREE.Vector3(280, 6, 200));
    await frames(1, { jump: true });
    assert.equal(hook.state, 'out', 'jump happened before the claw arrived');
    await frames(20);
    assert.ok(hook.rope.reel > 0 && body.vel.x > 10, 'a jump during flight engages the forward pull');
    await frames(180);
    assert.equal(body.rope, null, 'arrival ends the winch');
    assert.equal(hook.grappling, false, 'arrival allows refiring');
  } finally { f.dispose(); }
}

for (const target of ['sky', 'loose', 'range']) {
  const f = await fixture(), { hook, ctx, fire, frames } = f;
  try {
    ctx.aim.valid = target !== 'sky';
    ctx.aim.id = target === 'loose' ? E.SAND : E.ROCK;
    fire(new THREE.Vector3(target === 'range' ? 350 : 240, 6, 200));
    await frames(65);
    assert.equal(hook.rope, null, `${target} cannot anchor a traversal grapple`);
    assert.equal(hook.grappling, false, 'miss allows another E shot');
    assert.ok(f.events.includes('miss'));
  } finally { f.dispose(); }
}
console.log('ok broken anchor, input cancellation, teleport, death, sky/loose/out-of-range misses');

{
  const f = await fixture(), { body, hook, ctx, attached, frames } = f;
  try {
    ctx.aim.cell.set(250, 6, 200);
    ctx.dir.set(1, 0, 0); ctx.aim.dist = 50;
    ctx.primary = ctx.primaryPressed = true;
    hook.update(ctx); ctx.primaryPressed = false;
    await attached();
    assert.equal(hook.grappling, false, 'ordinary held hook is not the E shortcut');
    hook.update(ctx);
    assert.ok(hook.rope.reel > 0, 'left-click still reels the ordinary hook');
    ctx.primary = false; hook.update(ctx);
    assert.equal(hook.rope.reel, 0, 'letting go of left-click still hangs');
    ctx.secondaryPressed = true; hook.update(ctx);
    assert.equal(body.rope, null, 'right-click still releases the ordinary hook');
    await frames(25);
  } finally { f.dispose(); }
}
console.log('ok existing held-hook mouse controls unchanged');
