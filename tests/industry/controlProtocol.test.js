import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from '../../src/elements.js';
import { CONTROL_VERSION as v, controlIntentRay, createControlIntentGuard, validControlPose } from '../../src/net/controlActivation.js';
function fixture(source = 'use') {
  const context = { v, id: 'host-session:map:1', origin: [0, 0, 0], size: [32, 32, 32] }, peer = { id: 'g', role: 'guest' };
  const pose = { v, context: context.id, source, seq: 3, active: true, p: [2, 0, 8],
    eyeHeight: 2.1875, crouch: 1, yaw: 0, pitch: 0, dir: [0, 0, -1], warp: 0, at: 1000 };
  return { m: { v, source, context: context.id, seq: 1, poseSeq: 3, cell: [2, 2, 3], material: E.BUTTON },
    args: { context, peer, pose, now: 1000 } };
}
test('control-only legacy contexts reconstruct actual crouched and shrunken eyes', () => {
  const { m, args } = fixture(), ray = controlIntentRay(m, args);
  assert.deepEqual(ray.eye, [2, 2.1875, 8]); assert.deepEqual(ray.dir, [-0, 0, -1]); assert.equal(ray.expected.material, E.BUTTON);
  assert(validControlPose({ ...args.pose, eyeHeight: 1.09375 }, args.context));
});
test('god actions remain window bounded but do not inherit hand reach', () => {
  const { m, args } = fixture('god'); args.pose.p = [2, 30, 8];
  assert.deepEqual(controlIntentRay(m, args).eye, [2, 30, 8]);
  assert.equal(controlIntentRay({ ...m, source: 'use' }, { ...args, pose: { ...args.pose, source: 'use' } }), null);
  assert.equal(controlIntentRay({ ...m, cell: [33, 2, 3] }, args), null);
});
test('version, session, pose, role, age, replay and rate guards fail closed', () => {
  const { m, args } = fixture(), guard = createControlIntentGuard();
  assert(guard.take(m, args)); assert.equal(guard.take(m, args), null);
  for (const bad of [{ ...m, v: 2 }, { ...m, context: 'old' }, { ...m, poseSeq: 2 }, { ...m, source: 'ballistic' },
    { ...m, cell: [2.1, 2, 3] }, { ...m, material: E.CONTACTOR }]) assert.equal(controlIntentRay(bad, args), null);
  for (const pose of [{ ...args.pose, eyeHeight: Infinity }, { ...args.pose, crouch: 2 }, { ...args.pose, active: false }]) {
    assert.equal(controlIntentRay(m, { ...args, pose }), null);
  }
  assert.equal(controlIntentRay(m, { ...args, now: 1501 }), null);
  assert.equal(controlIntentRay(m, { ...args, peer: { ...args.peer, role: 'host' } }), null);
  assert.equal(guard.take({ ...m, seq: 2 }, args), null); assert(guard.take({ ...m, seq: 2 }, { ...args, now: 1150 }));
});
test('god poses require the captured finite unit direction', () => {
  const { m, args } = fixture('god'); args.pose.dir = [Math.SQRT1_2, 0, -Math.SQRT1_2];
  assert.deepEqual(controlIntentRay(m, args).dir, args.pose.dir);
  for (const dir of [undefined, [0, 0, 0], [NaN, 0, -1], [0, 0, -2], [1, 0]]) {
    assert.equal(controlIntentRay(m, { ...args, pose: { ...args.pose, dir } }), null);
  }
});
