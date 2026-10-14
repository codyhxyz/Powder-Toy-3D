// CPU-only: sample the actual toy rig, including rapid repeats and jump/tool overrides.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { character, dispose } from '../src/pov/village/models.js';
import { PUNCH_COOLDOWN, PUNCH_DURATION, stepResident } from '../src/pov/village/actions.js';

assert.equal(PUNCH_COOLDOWN, 0.5, 'two readable, heavy punches per second');
assert.ok(PUNCH_DURATION <= PUNCH_COOLDOWN, 'the pose recovers before the next punch');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
for (const reduced of [false, true]) {
  globalThis.matchMedia = () => ({ matches: reduced });
  const avatar = character(), body = avatar.root.children[0], limbs = body.children.slice(0, 4);
  const fist = avatar.root.getObjectByName('village-right-fist'), fistAt = () => fist.getWorldPosition(new THREE.Vector3());
  let time = 0;
  const pose = (progress, carrying = false, tool = false) =>
    avatar.animate(time += 1 / 60, 0, false, carrying, 0, 1 - progress, tool);
  try {
    pose(0.2);
    const guard = fistAt();
    assert.ok(guard.y > 3.4 && guard.z < 0 && guard.x > 1.4, 'bent elbow raises fist beside cheek, visible past the head from behind');
    near(body.rotation.x, 0);
    assert.ok(body.rotation.y < 0 && Math.abs(body.rotation.y) < 0.3, 'torso coils away before the strike');
    near(body.position.z, 0);
    pose(0.4);
    near(avatar.hand.rotation.x, 1.78);
    assert.ok(fistAt().z < guard.z - (reduced ? 0.9 : 1.5) && fistAt().y > 3.4, 'jaw-height strike extends visibly; reduced motion suppresses torso travel');
    assert.ok(body.rotation.y > 0 && body.position.z < 0, 'torso and stance drive through contact');
    assert.ok(Math.abs(avatar.hand.position.z) < 0.8, 'shoulder stays attached to chest, not teleported two cells ahead');
    pose(0.55);
    assert.ok(body.rotation.y > 0 && limbs[0].rotation.x > 0 && limbs[2].rotation.x < 0, 'shoulders and stance follow AFTER the fist arrives');
    assert.ok(Math.abs(body.rotation.x) < 0.11, 'small forward weight transfer, not a bow');
    assert.ok(limbs[1].rotation.x > 2, 'off hand stays raised in guard');
    near(body.rotation.y, reduced ? 0.04 : 0.16);
    pose(0.75);
    assert.ok(fistAt().y > 3.4, 'retract to raised guard, not a dangling arm');
    for (let t = 0.15; t <= 0.88; t += 0.02) {
      pose(t); assert.ok(fistAt().y > 3.3, 'fist remains high for most of the punch');
    }
    pose(1);
    near(avatar.hand.rotation.x, 0);
    near(body.rotation.x, 0); near(body.rotation.y, 0); near(body.rotation.z, 0);
    near(body.position.z, 0); near(avatar.hand.position.z, 0);
    near(avatar.hand.position.y, 2.7); near(fist.parent.rotation.x, 0);
    for (const limb of limbs) { near(limb.rotation.y, 0); near(limb.rotation.z, 0); }
    pose(0.4); pose(0.4, true);
    near(avatar.hand.rotation.x, 1.3); near(body.rotation.y, 0);
    near(avatar.hand.position.z, 0);
    pose(1, false, true); near(avatar.hand.rotation.x, 0.9);
    // A short mining tap still plays a complete overhead stroke.
    avatar.animate(time += 0.1, 0, false, false, 0, 0, true, true);
    avatar.animate(time += 0.05, 0, false, false, 0, 0, true, false);
    const high = avatar.hand.rotation.x;
    avatar.animate(time += 0.075, 0, false, false, 0, 0, true, false);
    assert.ok(high - avatar.hand.rotation.x > (reduced ? 0.6 : 2.4), 'mining chops down through a large arc, even after releasing');
    avatar.animate(time += 0.1, 0, false, false, 0, 0, true, false);
    avatar.animate(time += 0.1, 0, false, false, 0, 0, true, false);
    near(avatar.hand.rotation.x, 0.9); near(body.rotation.y, 0);
    // Repeated clicks must not accumulate shoulder offsets or leave a twisted idle pose.
    for (const fps of [30, 60, 144]) {
      for (let repeat = 0; repeat < 20; repeat++) {
        for (let frame = 0; frame < Math.ceil(PUNCH_DURATION * fps); frame++) {
          avatar.animate(time += 1 / fps, 0, false, false, 0, 1 - frame / (PUNCH_DURATION * fps));
        }
        pose(1);
        near(body.rotation.y, 0); near(body.position.z, 0); near(avatar.hand.position.z, 0);
      }
    }
  } finally { dispose(avatar.root); }
}
delete globalThis.matchMedia;
for (const fps of [30, 60, 144]) {
  const r = { spec: { home: 1 }, x: 0, z: 6, y: 0, vx: 0, vz: -44, vy: 8, bonk: 0.9 };
  let last = r.z, peak = 0;
  for (let frame = 1; frame <= fps * 3; frame++) {
    stepResident(r, 1 / fps, frame / fps, true);
    assert.ok(Math.abs(r.z - last) < 44 / fps, 'no position jump during knockback or recovery');
    if (frame > fps) assert.ok(Math.abs(r.z - last) < 3.5 / fps, 'recoil slows smoothly instead of snapping toward the old walking path');
    if (frame === fps) assert.ok(6 - r.z > 12, 'strong knockback travels over twelve cells');
    assert.ok(Math.abs(r.x) <= 1 && Math.abs(r.z) <= 8 && r.y >= 0, 'walls and floor contain the knockback');
    peak = Math.max(peak, r.y); last = r.z;
  }
  assert.ok(peak > 1, 'impact produces a physical hop');
  near(r.y, 0); near(r.vy, 0);
}
console.log('PASS village punch and mining poses, reduced motion, carry/tools, rapid repeats, strong knockback and no snap-back at 30/60/144 fps');
