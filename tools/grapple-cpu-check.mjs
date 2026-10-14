// Original flat-screen Grappendix formulas + real body/controller over CPU probes; no GPU.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CELL_M } from '../src/scale.js';
import { createPlayer } from '../src/pov/player.js';
import { createGrappendix } from '../src/pov/grappendix.js';
import { CRUELTY_GRAVITY, CRUELTY_JUMP, GRAPPENDIX_RANGE, grappendixFactor, pullGrappendix, crueltyMove } from '../src/pov/grappendixPhysics.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';
import { addTarget } from '../src/pov/targets.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

for (const [meters, factor] of [[0, 0], [3, 0], [3.01, 1], [9.99, 1], [10, 0], [10.01, 0.7], [19.99, 0.7], [20, 0], [20.01, 2], [80, 2]]) {
  near(grappendixFactor(meters / CELL_M), factor);
}
for (const fps of [30, 60, 120]) {
  const velocity = new THREE.Vector3(0, 0, 30);
  for (let i = 0; i < fps; i++) pullGrappendix(velocity, new THREE.Vector3(), new THREE.Vector3(15 / CELL_M, 0, 0), CRUELTY_GRAVITY, 1 / fps);
  near(velocity.x * CELL_M, 22 * 2.3 * 0.7);
  near(velocity.z, 30, 1e-8);
}
const velocity = new THREE.Vector3(60, 0, 0);
crueltyMove(velocity, new THREE.Vector2(), { grounded: false }, 1 / 60);
near(velocity.x, 60);
crueltyMove(velocity, new THREE.Vector2(), { grounded: true, jumpPressed: true }, 1 / 60);
near(velocity.x, 54);
near(velocity.y, CRUELTY_JUMP);
console.log('ok source distance bands/seams, gravity-scaled acceleration, tangent momentum, ground friction, jump, FPS');

async function fixture(fps = 60) {
  const sim = { g: { nx: 512, ny: 256, nz: 512 }, frame: 0, gravity: 0.025, touchCentres: () => [], paint() {} };
  let anchorId = E.ROCK, resolveRead;
  let holdRead = false;
  setPovGpu(sim, {
    ready: true, edit: () => true, transfer: () => null,
    probe(name, { boxLo: lo }) {
      if (name === 'povCells') return holdRead ? new Promise(resolve => { resolveRead = resolve; })
        : Promise.resolve(new Float32Array([anchorId, 20, 0, 0]).buffer);
      const buf = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        buf[i] = lo[1] + y < 1 ? E.WALL : E.EMPTY; buf[i + 1] = 20;
      }
      return Promise.resolve(buf.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
  const scene = new THREE.Scene(), volume = new THREE.Group(); scene.add(volume);
  const grapple = createGrappendix({ scene, getSim: () => sim, getVolume: () => volume, getScale: () => 1 });
  const ctx = {
    dt: 1 / fps, sim, player: { body }, eye: new THREE.Vector3(), dir: new THREE.Vector3(),
    aim: { valid: true, cell: new THREE.Vector3(), id: E.ROCK, face: 1, dist: 0 },
  };
  const frame = async (input = {}) => {
    sim.frame += 4; body.update(ctx.dt, input);
    ctx.eye.copy(body.pos).setY(body.pos.y + body.eyeHeight);
    grapple.update(ctx); await flush();
  };
  const frames = async (n, input = {}) => { for (let i = 0; i < n; i++) await frame(input); };
  body.spawn(new THREE.Vector3(200, 1, 200)); await frames(5);
  const attach = cell => {
    ctx.aim.cell.copy(cell);
    const point = cell.clone().addScalar(0.5).add(new THREE.Vector3(-0.5, 0, 0));
    ctx.dir.subVectors(point, ctx.eye).normalize(); ctx.aim.dist = point.distanceTo(ctx.eye);
    grapple.toggle(ctx);
  };
  return { sim, scene, body, grapple, ctx, frame, frames, attach,
    anchorId(id) { anchorId = id; },
    holdRead(v) { holdRead = v; },
    completeRead(id) { resolveRead(new Float32Array([id, 20, 0, 0]).buffer); },
    dispose() { grapple.dispose(); body.dispose(); } };
}

for (const fps of [30, 60, 120]) {
  const f = await fixture(fps), { body, grapple, attach, frames, ctx } = f;
  try {
    attach(new THREE.Vector3(250, 6, 200));
    assert.ok(grapple.active && body.rope.grappendix, 'instant attachment without projectile flight');
    assert.equal(body.rope.hard, false, 'no fixed-length rope constraint');
    await frames(Math.round(fps / 5));
    const groundedSpeed = body.vel.x;
    assert.ok(body.onGround && groundedSpeed < 2, 'source ground friction holds you back until jumping');
    await frames(Math.round(fps / 3), { jump: true });
    assert.ok(!body.onGround && body.vel.x > groundedSpeed + 10, 'jump escapes ground friction and launches forward');
    assert.equal(body.jetting, false, 'holding jump does not substitute Noita jet thrust for source physics');
    const velocity = body.vel.clone();
    grapple.toggle(ctx);
    assert.equal(body.rope, null);
    assert.deepEqual(body.vel.toArray(), velocity.toArray(), 'release keeps full momentum');
    await frames(1);
    near(body.vel.x, velocity.x);
    console.log(`ok ${fps} fps instantaneous attach, ground pull, jump launch, no jet, release momentum`);
  } finally { f.dispose(); }
}

{
  const f = await fixture(), { body, grapple, attach, frame, frames, ctx, scene } = f;
  try {
    attach(new THREE.Vector3(210, 50, 200));
    const length = body.pos.distanceTo(grapple.rope.anchor);
    await frame({ jump: true }); await frames(24);
    assert.ok(body.pos.distanceTo(grapple.rope.anchor) < length - 5, 'overhead continuously draws you inward, never fixed length');
    const mesh = scene.children.find(o => o.isInstancedMesh);
    assert.ok(mesh.visible && mesh.count > 0, 'original pulsating flesh-orb line is drawn');
    const anchor = grapple.rope.anchor.clone();
    body.windowShifted(16, -8); grapple.windowShifted(16, -8);
    near(grapple.rope.anchor.x, anchor.x - 16); near(grapple.rope.anchor.z, anchor.z + 8);
    // Near the anchor original acceleration turns off but attachment remains.
    body.teleport(new THREE.Vector3(180, 30, 180)); await frame();
    assert.equal(grapple.active, false, 'teleport severed the tether');
    attach(new THREE.Vector3(182, 32, 180));
    await frames(2);
    assert.equal(grapple.active, true, 'no auto-release within the original 3 m dead zone');
    const held = body.rope;
    grapple.release(); attach(new THREE.Vector3(184, 32, 180));
    assert.ok(grapple.active && body.rope !== held, 'immediate refire, no added cooldown/retraction');
    ctx.aim.valid = false; grapple.toggle(ctx);
    assert.equal(grapple.active, false, 'E releases even while aimed at sky');
  } finally { f.dispose(); }
}

for (const why of ['sky', 'powder', 'range']) {
  const f = await fixture(), { grapple, attach, ctx } = f;
  try {
    ctx.aim.valid = why !== 'sky'; ctx.aim.id = why === 'powder' ? E.SAND : E.ROCK;
    attach(new THREE.Vector3(why === 'range' ? 268 : 230, 6, 200));
    assert.equal(grapple.active, false, why);
  } finally { f.dispose(); }
}
for (const why of ['tear', 'release', 'death', 'replacement']) {
  const f = await fixture(), { body, grapple, attach, frame } = f;
  try {
    attach(new THREE.Vector3(230, 10, 200));
    if (why === 'tear') { f.anchorId(E.EMPTY); await frame(); }
    if (why === 'release') grapple.release();
    if (why === 'death') { body.hurt(2, 'test', { shielded: false }); await frame(); }
    if (why === 'replacement') { body.tether({ anchor: new THREE.Vector3(), hard: true }); await frame(); }
    assert.equal(grapple.active, false, why);
    if (why === 'replacement') assert.ok(body.rope, 'cannot sever another tool/vehicle tether');
    else assert.equal(body.rope, null);
  } finally { f.dispose(); }
}
{
  const f = await fixture(), { grapple, attach, frame } = f;
  try {
    attach(new THREE.Vector3(230, 10, 200)); f.holdRead(true); await frame();
    grapple.release(); attach(new THREE.Vector3(232, 10, 200));
    f.completeRead(E.EMPTY); await flush();
    assert.equal(grapple.active, true, 'stale anchor reads cannot tear out a new grapple');
  } finally { f.dispose(); }
}
{
  const f = await fixture(), { body, grapple, ctx, frame } = f;
  const target = { pos: new THREE.Vector3(220, 1, 200), vel: new THREE.Vector3(), dead: false };
  const off = addTarget({ id: 'grappendix-test', get alive() { return !target.dead; }, body: target, hurt() {},
    box(lo, hi) { lo.copy(target.pos).add(new THREE.Vector3(-1, 0, -1)); hi.copy(target.pos).add(new THREE.Vector3(1, 6, 1)); } });
  try {
    ctx.aim.valid = false; ctx.dir.set(1, 0, 0); grapple.toggle(ctx);
    assert.ok(grapple.active, 'original can attach to an NPC');
    const anchor = grapple.rope.anchor.clone(); target.pos.x += 5; await frame();
    near(grapple.rope.anchor.x, anchor.x + 5);
    target.dead = true; await frame();
    assert.ok(grapple.active && target.vel.x < 0, 'original pulls corpses back, not living enemies');
    grapple.release(); grapple.toggle(ctx);
    assert.ok(grapple.active, 'a dead body remains a grapple target, not a gun target');
    off(); await frame();
    assert.equal(body.rope, null);
  } finally { off(); f.dispose(); }
}
assert.ok(GRAPPENDIX_RANGE * CELL_M === 20);
console.log('ok source overhead pull/dead zone/refire, flesh-orb rendering, range, misses, shifts, lifecycle, stale reads, moving NPC');
