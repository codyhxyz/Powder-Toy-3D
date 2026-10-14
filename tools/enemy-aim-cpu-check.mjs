// Shared infantry/jetpack gunner aim, without a browser or GPU.
// Run: node tools/enemy-aim-cpu-check.mjs
import assert from 'node:assert/strict';
import { aimError, aimWith, REACTION_S, takeAimAndShoot } from '../src/pov/ai/brain.js';
import { BODY_WIDTH, BODY_HEIGHT, EYE_HEIGHT } from '../src/pov/constants.js';

const a = {
  target: { vel: { x: 0, z: 0 } },
  inSight: 0, now: 0, knows: true, sees: true,
  record: { timeBecameVisible: 0 },
  intent: {}, cool: {}, dist3: 40,
  pursuit: { active: false }, seek: { active: false }, wander: { active: false },
  eye: () => ({ x: 0, y: EYE_HEIGHT, z: 0 }),
  chest() { return { x: 0, y: 3, z: this.dist3 }; },
  lookAt(p) { this.aim = p; },
  hold() {}, chase() {},
  ready(key) { return this.now >= (this.cool[key] ?? 0); },
  cooldown(key, seconds) { this.cool[key] = this.now + seconds; },
};

// Deterministic Gaussian samples through the production aiming function.
const random = Math.random;
let seed = 123456;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) + 0.5) / 2 ** 32;
try {
  takeAimAndShoot(a);
  assert.ok(!a.intent.primaryPressed, 'reaction delay still blocks fire');
  a.inSight = a.now = REACTION_S;
  takeAimAndShoot(a);
  assert.ok(a.intent.primaryPressed, 'first shot remains a warning');
  assert.ok(Math.abs(a.aim.x) > BODY_WIDTH / 2, 'warning misses to the side');
  a.intent = {};
  a.inSight = a.now = 2;
  takeAimAndShoot(a);
  assert.ok(a.intent.primaryPressed, 'follow-up shot fires after the warning cooldown');

  // Aim-only hit rates: weapon-specific spread and projectile flight are separate.
  for (const [seconds, distance, minimum] of [[REACTION_S, 40, 0.75], [1.5, 40, 0.99], [1.5, 79, 0.90]]) {
    a.inSight = seconds;
    a.dist3 = distance;
    let hits = 0;
    const samples = 10000;
    for (let i = 0; i < samples; i++) {
      aimWith(a, a.chest(), aimError(a));
      const t = distance / a.aim.z;
      const x = a.aim.x * t, y = EYE_HEIGHT + (a.aim.y - EYE_HEIGHT) * t;
      if (t > 0 && Math.abs(x) <= BODY_WIDTH / 2 && y >= 0 && y <= BODY_HEIGHT) hits++;
    }
    assert.ok(hits / samples >= minimum, `${seconds}s / ${distance} cells: ${hits / samples} < ${minimum}`);
    console.log(`Stationary target, ${seconds}s / ${distance} cells: ${(100 * hits / samples).toFixed(1)}% aim rays hit`);
  }
  const settled = aimError(a);
  a.inSight = 10;
  assert.equal(aimError(a), settled, 'settled aim stays stable');
  a.target.vel.x = 24;
  assert.ok(aimError(a) > settled, 'moving targets remain harder to hit');
  assert.ok(aimError(a) <= 0.025, 'movement does not restore the oversized spread');
  console.log('PASS: tighter shared aim, short settling time, reaction delay and warning preserved');
} finally {
  Math.random = random;
}
