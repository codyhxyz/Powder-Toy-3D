// Real boat target, kick, and physgun; manual mode, only explicit physics steps.
// Run: node tools/physgun-punt-check.mjs
import assert from 'node:assert/strict';
import { openPovApp } from './pov-app.mjs';

const app = await openPovApp();
try {
  await app.enter([20, 0, 32]);
  await app.page.evaluate(() => {
    __app.pov.vehicles.spawnLayout({ vehicles: [{ kind: 'boat', at: [32, 0, 32], yaw: 0 }] });
  });
  // Rapier loads asynchronously; parked gameplay needs an explicit update to spawn.
  await app.page.waitForFunction(() => {
    __app.pov.vehicles.update(0, { worldToGrid: new __app.THREE.Matrix4() });
    __app.sim.gpu.flush('boat fixture');
    return __app.pov.vehicles.list.length === 1;
  });
  const result = await app.page.evaluate(async () => {
    const { CELL_M } = await import('/src/scale.js');
    const { targetById, addTarget } = await import('/src/pov/targets.js');
    const { BLAST } = await import('/src/shaders/povTools.js');
    const { BODY_MASS_KG } = await import('/src/pov/tug.js');
    const a = __app, V = a.THREE.Vector3, pl = a.pov.player;
    const boat = a.pov.vehicles.list[0], rb = boat.impl.body;
    const target = targetById(boat.id);
    const center = new V(32, 3, 32), dir = new V(1, 0, 0);
    const reset = () => {
      rb.setTranslation(center.clone().multiplyScalar(CELL_M), true);
      rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      pl.spawn(new V(27, 0.4, 32)); // hip at hull centre; boot within reach
      pl.onGround = true;
    };
    reset();
    const kick = pl.kick(dir);
    const kicked = rb.linvel().x;
    const expectedKick = 14 * BODY_MASS_KG / (BODY_MASS_KG + rb.mass());
    const x0 = rb.translation().x;
    a.pov.vehicles.physics.step(1 / 30, () => {});
    const moved = rb.translation().x - x0;

    a.pov.toolbelt.select('PHYSGUN');
    const tool = a.pov.toolbelt.tool('PHYSGUN');
    const fire = (over = {}) => tool.update({
      sim: a.sim, dt: BLAST.COOLDOWN + 0.01, stepsPerFrame: 4,
      eye: center.clone().addScaledVector(dir, -5), dir,
      player: pl, aim: { valid: false }, primary: false, primaryPressed: false,
      secondary: true, secondaryPressed: true, wheel: 0, ...over,
    });
    reset();
    const hp = boat.health;
    fire();
    const punted = rb.linvel().x, playerVelocity = pl.vel.toArray();
    fire({ dt: 0 }); // no repeat during cooldown
    const cooldown = rb.linvel().x;
    reset();
    fire({ aim: { valid: true, dist: 1 } }); // wall before the hull
    const behindWall = rb.linvel().x;
    reset();
    fire({ eye: center.clone().addScaledVector(dir, -(BLAST.RANGE + 5)) });
    const outOfRange = rb.linvel().x;
    reset();
    fire({ dir: dir.clone().negate() });
    const behind = rb.linvel().x;

    // A nearer body intercepts the shot, and the wielder is never a target.
    reset();
    let dummySpeed = 0;
    const off = addTarget({
      id: 'punt-dummy', alive: true,
      box(lo, hi) { lo.set(27.5, 2, 31); hi.set(28, 4, 33); },
      hurt() { throw new Error('punt must not deal damage'); },
      shove(dv) { dummySpeed += dv.x * CELL_M; },
    });
    try { fire(); } finally { off(); }
    const intercepted = rb.linvel().x;

    // The loose-matter branch still runs its GPU edit, without radial pressure.
    const { E } = await import('/src/elements.js');
    a.sim.load(...a.sim.blankState());
    a.sim.paint({ center: new V(12, 3, 12), radius: 1, shape: 1, tool: E.SAND, rate: 1, replace: true });
    fire({ eye: new V(9, 3, 12), aim: { valid: true, dist: 2 } });
    const [A, B] = await a.sim.readState();
    let pressure = 0, sandSpeed = 0;
    for (let i = 0; i < A.length; i += 4) {
      pressure = Math.max(pressure, Math.abs(B[i + 3]));
      if (Math.round(A[i]) === E.SAND) sandSpeed = Math.max(sandSpeed, B[i]);
    }
    tool.deselect();
    return { mass: target.mass, expectedMass: rb.mass(), kick: kick?.hit,
      kicked, expectedKick, moved, punted, playerVelocity, cooldown, behindWall,
      outOfRange, behind, dummySpeed, intercepted, health: boat.health, hp, pressure, sandSpeed };
  });
  assert.equal(result.mass, result.expectedMass);
  assert.equal(result.kick, 'body');
  assert(Math.abs(result.kicked - result.expectedKick) < 0.01, JSON.stringify(result));
  assert(result.moved > 0.01, 'kick must actually move the boat');
  assert(Math.abs(result.punted - 8) < 0.01, JSON.stringify(result));
  assert.deepEqual(result.playerVelocity, [0, 0, 0], 'punt must not recoil');
  assert.equal(result.cooldown, result.punted);
  for (const key of ['behindWall', 'outOfRange', 'behind', 'intercepted', 'pressure']) assert.equal(result[key], 0, key);
  assert.equal(result.dummySpeed, 8);
  assert.equal(result.health, result.hp, 'punt must not damage the hull');
  assert(result.sandSpeed > 0, 'loose matter still moves forward');
  assert.deepEqual(app.errors, []);
  console.log('PASS kick moves boat; punt moves targets, not player; cooldown, wall/range/nearest checks; sand moves without pressure', result);
} finally {
  await app.close();
}
