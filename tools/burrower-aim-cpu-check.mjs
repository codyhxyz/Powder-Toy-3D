// Actual Burrower flight and contact damage, with GPU edits stubbed (no browser).
// Run: node tools/burrower-aim-cpu-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import burrower from '../src/pov/tools/burrower.tool.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { addTarget } from '../src/pov/targets.js';

const sim = { id: 1, g: { nx: 128, ny: 128, nz: 128 }, touchCentres() { return []; } };
let edits = 0;
setPovGpu(sim, { ready: true, edit() { edits++; }, probe() { return null; } });
const env = {
  scene: new THREE.Scene(),
  // Presentation is not under test.
  viewmodel: { userData: { rig: { hand: () => new THREE.Group(), update() {}, hit() {} } } },
  getScale: () => 1,
  getVolume: () => ({ position: new THREE.Vector3() }),
  getSim: () => sim,
};
const target = {
  id: 'burrower-test', alive: true, health: 1, cause: null,
  pos: new THREE.Vector3(30, 20, 44),
  box(lo, hi) { lo.copy(this.pos).subScalar(0.8); hi.copy(this.pos).addScalar(0.8); },
  hurt(amount, cause) { this.health -= amount; this.cause = cause; this.alive = this.health > 0; },
};
const off = addTarget(target);
const tool = burrower.create(env);
const ctx = {
  sim, dt: 1 / 60, stepsPerFrame: 4,
  eye: new THREE.Vector3(10, 20, 32),
  dir: new THREE.Vector3(1, 0.1, 0).normalize(),
  primaryPressed: true,
};
try {
  tool.update(ctx);
  assert.equal(tool.drills.length, 1);
  const d = tool.drills[0], launch = tool.lastLaunch;
  assert.ok(d.dir.distanceTo(ctx.dir) < 1e-12, 'launch follows the crosshair, including pitch');
  ctx.primaryPressed = false;
  ctx.dir.set(0, 0, -1);
  for (let frame = 0; frame < 60; frame++) {
    if (frame === 20) target.pos.set(30, 20, 20);
    if (frame === 40) target.pos.set(5, 20, 32); // behind: no pursuit turn either
    tool.tick(ctx);
    assert.ok(d.dir.distanceTo(launch.dir) < 1e-12, 'nearby/moving targets cannot steer the drill');
  }
  const travel = d.pos.clone().sub(launch.origin);
  assert.ok(travel.cross(launch.dir).length() < 1e-10, 'flight stays on the launch line');
  assert.ok(d.pos.distanceTo(launch.origin) > 30, 'the drill actually advances');
  assert.equal(target.health, 1, 'off-axis shots miss');
  assert.equal(tool.lastHit, null);
  assert.ok(edits > 0, 'flight still runs the bore pass');

  tool.worldReplaced();
  tool.deselect();
  target.pos.set(30, 20, 32);
  ctx.dir.set(1, 0, 0);
  ctx.primaryPressed = true;
  tool.update(ctx);
  for (let frame = 0; frame < 60 && !tool.lastHit; frame++) tool.tick(ctx);
  assert.equal(tool.lastHit?.target, target.id, 'a directly aimed shot hits');
  assert.equal(target.alive, false);
  assert.equal(target.cause, 'Bored', 'contact damage is unchanged');
  console.log('PASS: crosshair aim, fixed flight, moving/behind targets missed, direct hit kills');
} finally {
  tool.dispose();
  off();
}
