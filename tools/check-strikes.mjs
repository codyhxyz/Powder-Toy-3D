// CPU-only: actual toy/stick/skeletal rigs and first-person geometry, no GPU.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { strikePose, sampleKickPose } from '../src/pov/strikePose.js';
import { createFigure, buildStick } from '../src/pov/figure.js';
import { buildSpartan } from '../src/pov/figureSpartan.js';
import { buildCrasher } from '../src/pov/figureCrasher.js';
import { createKickLeg, KICK_REFIRE } from '../src/pov/kick.js';
import { character, dispose } from '../src/pov/village/models.js';
import { PUNCH_DURATION } from '../src/pov/village/actions.js';
import { viewmodelRig } from '../src/pov/viewmodel.js';
import { flapPose, sampleFlap, FLAP_ANIM_S } from '../src/pov/flapPose.js';

const nearQ = (a, b, label) => assert.ok(1 - Math.abs(a.dot(b)) / (a.length() * b.length()) < 1e-7, label);
const identity = new THREE.Quaternion(), pose = strikePose();
for (const p of [-1, 0, 1, 2]) {
  sampleKickPose(p, pose);
  for (const q of Object.values(pose)) nearQ(q, identity, 'kick endpoints are neutral');
}
for (let p = 0; p <= 1; p += 0.001) {
  sampleKickPose(p, pose);
  for (const q of Object.values(pose)) assert.ok(Math.abs(q.length() - 1) < 1e-8, 'unit quaternion throughout slerp');
}
const atContact = sampleKickPose(0.3, strikePose());
sampleKickPose(0.5, pose);
for (const key of Object.keys(pose)) nearQ(pose[key], atContact[key], 'extension is held, not a one-frame flash');
assert.ok(new THREE.Euler().setFromQuaternion(atContact.hip).x > 1.8, 'kick goes above horizontal');
assert.ok(new THREE.Euler().setFromQuaternion(atContact.knee).x > -0.2, 'shin snaps straight');
assert.ok(new THREE.Euler().setFromQuaternion(sampleKickPose(0.16, pose).knee).x < -2, 'knee chambers before striking');
const wingPose = flapPose();
for (const remaining of [0, 1]) {
  sampleFlap(remaining, wingPose);
  for (const key of ['left', 'right', 'elbow']) nearQ(wingPose[key], identity, 'flap starts/ends without a snap');
  assert.equal(wingPose.weight, 0, 'endpoints preserve baseline pose');
}
for (let remaining = 0; remaining <= 1; remaining += 0.001) {
  sampleFlap(remaining, wingPose);
  for (const key of ['left', 'right', 'elbow']) assert.ok(Math.abs(wingPose[key].length() - 1) < 1e-8, 'flap quaternion remains normalized');
}
assert.equal(FLAP_ANIM_S, 0.2, 'a full stroke fits the refire interval');

const state = {
  feet: new THREE.Vector3(), scale: 1, yaw: 0, worldToGrid: new THREE.Matrix4(),
  speedH: 0, velY: 0, onGround: true, inLiquid: false, dead: false,
};
for (const build of [buildStick, buildSpartan, buildCrasher]) {
  let rig;
  const fig = createFigure(() => (rig = build()));
  try {
    fig.update(0, state);
    const idle = [rig.hipR, rig.knR, rig.torso].map(b => b.quaternion.clone());
    for (let repeat = 0; repeat < 20; repeat++) {
      fig.update(0, { ...state, kick: 0.4 });
      const foot = rig.knR.localToWorld(new THREE.Vector3(0, -(rig.hipY + rig.knR.position.y), 0));
      assert.ok(foot.z < -rig.hipY * 0.7 && foot.y > rig.hipY, `${build.name}: foot extends forward and up`);
      fig.update(0, state);
      [rig.hipR, rig.knR, rig.torso].forEach((b, i) => nearQ(b.quaternion, idle[i], 'no idle twist after repeated kicks'));
    }
    const wingIdle = [rig.shL, rig.shR, rig.elL, rig.elR].map(b => b.quaternion.clone());
    for (let repeat = 0; repeat < 20; repeat++) {
      fig.update(0, { ...state, flap: 0.78 });
      sampleFlap(0.78, wingPose);
      nearQ(rig.shL.quaternion, wingPose.left, 'left upstroke follows the shared pose');
      nearQ(rig.shR.quaternion, wingPose.right, 'right upstroke follows the shared pose');
      nearQ(rig.elR.quaternion, wingPose.elbow, 'elbows fold on the upstroke');
      fig.update(0, { ...state, flap: 0.48 });
      sampleFlap(0.48, wingPose);
      nearQ(rig.shR.quaternion, wingPose.right, 'distinct downward power stroke');
      fig.update(0, state);
      [rig.shL, rig.shR, rig.elL, rig.elR].forEach((b, i) => nearQ(b.quaternion, wingIdle[i], 'no arm drift after repeated flaps'));
    }
    for (let i = 0; i < 60; i++) fig.update(1 / 60, { ...state, crouch: 1 });
    fig.update(0, { ...state, crouch: 1, kick: 0.16 });
    nearQ(rig.knR.quaternion, sampleKickPose(0.16, pose).knee, 'chamber replaces crouch, not a hyperfolded sum');
    fig.update(0, { ...state, crouch: 1, kick: 0.4 });
    nearQ(rig.hipR.quaternion, atContact.hip, 'crouched thigh fully extends');
    nearQ(rig.knR.quaternion, atContact.knee, 'crouched shin fully extends');
    fig.update(0, { ...state, dead: true, kick: 0.4 });
    assert.ok(rig.hipR.quaternion.angleTo(atContact.hip) > 0.5, 'dead bodies do not strike');
  } finally { fig.dispose(); }
}

// Same skeleton-loader shim as jetpack-figure-check: textures do not affect bone math.
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('/pov/bodyModel.js'))
    return { format: 'module', source: 'export const BODY_MODEL_URLS = {};', shortCircuit: true };
  return next(url, context);
} });
const { createRealFigure } = await import('../src/pov/figureReal.js');
hooks.deregister();
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
loader.register(parser => ({
  name: 'cpu-textures',
  beforeRoot() { parser.loadTextureImage = async () => new THREE.Texture(); },
}));
for (const file of ['body', 'woman']) {
  const bytes = await readFile(new URL(`../public/models/character/${file}.glb`, import.meta.url));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const fig = createRealFigure(gltf);
  try {
    const foot = fig.root.getObjectByName('foot_r');
    const joints = ['thigh_r', 'calf_r', 'foot_r', 'spine_01'].map(n => fig.root.getObjectByName(n));
    for (const scale of [0.5, 1, 2]) for (const yaw of [0, 1.2]) {
      const s = { ...state, scale, yaw };
      fig.update(0, s);
      const idle = joints.map(b => b.quaternion.clone()), rest = foot.getWorldPosition(new THREE.Vector3());
      const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      for (let repeat = 0; repeat < 10; repeat++) {
        fig.update(0, { ...s, kick: 0.4 });
        const delta = foot.getWorldPosition(new THREE.Vector3()).sub(rest).divideScalar(scale);
        assert.ok(delta.dot(forward) > 1.5 && delta.y > 2, `${file}: correctly framed, yaw/scale independent kick ${delta.toArray()}`);
        fig.update(0, s);
        joints.forEach((b, i) => nearQ(b.quaternion, idle[i], `${file}: mixer restores kick bones`));
      }
    }
    for (const extra of [{ crouch: 1 }, { look: { pitch: 0.5, spine: 0.5 } }, { onGround: false, flap: 0.5 }]) {
      fig.update(0, { ...state, ...extra, kick: 0.4 });
      fig.update(0, { ...state, ...extra });
      assert.ok(joints.every(b => b.quaternion.toArray().every(Number.isFinite)), 'kick interruption leaves valid skeleton');
    }
    fig.update(0, { ...state, kick: 0.4 });
    const straight = joints.slice(0, 2).map(b => b.quaternion.clone());
    for (let i = 0; i < 60; i++) fig.update(1 / 60, { ...state, crouch: 1 });
    fig.update(0, { ...state, crouch: 1, kick: 0.4 });
    joints.slice(0, 2).forEach((b, i) => nearQ(b.quaternion, straight[i], `${file}: crouch cannot prevent kick extension`));
    const control = createRealFigure(gltf), kicking = createRealFigure(gltf);
    try {
      // Advance both mixers equally: the strike must not leak into later gait/crouch.
      for (const fps of [30, 60, 144]) {
        const dt = 1 / fps, moving = { ...state, speedH: 3, crouch: 1, look: { pitch: 0.4, spine: 0.5 } };
        for (let i = 0; i < Math.ceil(KICK_REFIRE * fps); i++) {
          control.update(dt, moving);
          kicking.update(dt, { ...moving, kick: Math.min(1, i * dt / KICK_REFIRE) });
        }
        control.update(dt, moving); kicking.update(dt, moving);
        for (const name of ['thigh_r', 'calf_r', 'foot_r', 'spine_01'])
          nearQ(kicking.root.getObjectByName(name).quaternion, control.root.getObjectByName(name).quaternion, `${file}: ${fps} FPS ${name} crouch/gait restored`);
      }
    } finally { control.dispose(); kicking.dispose(); }
    fig.update(0, state);
    const armBones = ['upperarm_l', 'lowerarm_l', 'upperarm_r', 'lowerarm_r'].map(n => fig.root.getObjectByName(n));
    const wingIdle = armBones.map(b => b.quaternion.clone());
    const hand = fig.root.getObjectByName('hand_r'), shoulder = fig.root.getObjectByName('upperarm_r');
    for (let repeat = 0; repeat < 30; repeat++) {
      fig.update(0, { ...state, flap: 0.78 });
      const up = hand.getWorldPosition(new THREE.Vector3());
      assert.ok(up.y > shoulder.getWorldPosition(new THREE.Vector3()).y, `${file}: wing raises above the shoulder`);
      fig.update(0, { ...state, flap: 0.48 });
      const down = hand.getWorldPosition(new THREE.Vector3());
      assert.ok(up.y - down.y > 1, `${file}: substantial downstroke, not a head-height flicker`);
      fig.update(0, state);
      armBones.forEach((b, i) => nearQ(b.quaternion, wingIdle[i], `${file}: no untracked bone drift after flapping`));
    }
    const grip = { pos: hand.getWorldPosition(new THREE.Vector3()), fingers: new THREE.Vector3(0, 0, -1), palm: new THREE.Vector3(0, -1, 0) };
    fig.reach({ right: grip });
    const aimed = armBones.slice(2).map(b => b.quaternion.clone());
    fig.update(0, { ...state, flap: 0.78 }); fig.reach({ right: grip });
    armBones.slice(2).forEach((b, i) => nearQ(b.quaternion, aimed[i], 'flap does not break the held grip'));
  } finally { fig.dispose(); }
}

for (const fps of [30, 60, 144]) {
  const vm = new THREE.Group(), env = { viewmodel: vm, getScale: () => 1, getCharacter: () => 'stick' };
  const rig = viewmodelRig(env), leg = createKickLeg(env);
  const hip = vm.getObjectByName('kick-hip'), knee = vm.getObjectByName('kick-knee'), boot = vm.getObjectByName('kick-boot');
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 12);
  try {
    for (const hit of [true, false]) for (let repeat = 0; repeat < 10; repeat++) {
      leg.start(hit);
      nearQ(hip.quaternion, identity, 'refire starts from neutral');
      let visibleFrames = 0;
      for (let i = 0; i < Math.ceil(KICK_REFIRE * fps) + 1; i++) {
        leg.update(1 / fps);
        const p = (i + 1) / fps / KICK_REFIRE;
        if (p >= 0.3 && p <= 0.5) {
          const at = boot.getWorldPosition(new THREE.Vector3()).project(camera);
          assert.ok(at.z > -1 && at.z < 1 && Math.abs(at.x) < 1 && Math.abs(at.y) < 1, 'extended boot is actually visible');
          visibleFrames++;
        }
      }
      assert.ok(visibleFrames >= 2, 'boot held visibly at contact');
      assert.equal(hip.parent.visible, false, 'view leg hides after recovery');
      nearQ(hip.quaternion, identity, 'hip recovered'); nearQ(knee.quaternion, identity, 'knee recovered');
    }
  } finally { leg.dispose(); rig.dispose(); }
  assert.equal(vm.getObjectByName('kick-hip'), undefined, 'disposed leg detaches');
}

{
  const vm = new THREE.Group(), rig = viewmodelRig({ viewmodel: vm, getScale: () => 1 });
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 12);
  try {
    rig.poseFlap(0);
    assert.equal(vm.getObjectByName('flap-wing'), undefined, 'idle never allocates wing meshes');
    rig.poseFlap(0.78);
    const wings = []; vm.traverse(o => { if (o.name === 'flap-wing') wings.push(o); });
    assert.equal(wings.length, 2, 'two articulated wings');
    for (const wing of wings) {
      assert.ok(wing.getObjectByName('flap-elbow'), 'wing has a separate elbow, not one rotating bar');
      const at = wing.getObjectByName('flap-fist').getWorldPosition(new THREE.Vector3()).project(camera);
      assert.ok(Math.abs(at.x) < 1 && Math.abs(at.y) < 1 && at.z > -1 && at.z < 1, 'wingbeat visible near the edge of the view');
    }
    const hand = rig.hand([0.5, -0.4, -1.5]); hand.visible = true;
    const ctx = { dt: 0, dir: new THREE.Vector3(0, 0, -1), player: { body: { flap: 0.78 } } };
    rig.update(ctx);
    nearQ(hand.quaternion, identity, 'flapping does not throw a held weapon across the view');
    assert.ok(hand.position.distanceTo(hand.userData.rest) < 1e-8, 'weapon grip stays put');
    assert.equal(wings[1].visible, false, 'no duplicate wing on a gripping hand');
    assert.equal(wings[0].visible, true, 'free hand keeps flapping');
    rig.poseFlap(0);
    assert.ok(wings.every(w => !w.visible), 'wings hide after recovery');
  } finally { rig.dispose(); }
}

for (const reduced of [false, true]) {
  globalThis.matchMedia = () => ({ matches: reduced });
  const avatar = character(), body = avatar.root.children[0];
  const leg = avatar.root.getObjectByName('leg-right'), knee = avatar.root.getObjectByName('knee-right');
  let t = 0;
  const animate = (punch, kick, tool = false, carrying = false, motion = null, pose = null) =>
    avatar.animate(t += 1 / 60, 0, false, carrying, 0, punch, tool, false, motion, kick, pose);
  try {
    for (let repeat = 0; repeat < 20; repeat++) {
      animate(0, 0.6);
      assert.ok(leg.rotation.x > 1.8 && knee.rotation.x > -0.2, 'village kick extends thigh AND shin');
      animate(0, 0);
      nearQ(leg.quaternion, identity, 'toy hip recovers'); nearQ(knee.quaternion, identity, 'toy knee recovers');
      nearQ(body.quaternion, identity, 'toy torso recovers');
    }
    animate(0.6, 0);
    const jab = avatar.hand.quaternion.clone();
    assert.ok(avatar.hand.position.z < -2, 'punch has a deeper forward reach');
    animate(0.6, 0, false, false, { flap: 1 });
    nearQ(avatar.hand.quaternion, jab, 'punch wins over chicken flap');
    animate(0, 0.6, true);
    assert.ok(leg.rotation.x > 1.8, 'kick works while holding a tool');
    animate(0, 0.6, false, true);
    nearQ(leg.quaternion, identity, 'carrying blocks kick');
    animate(0, 0.6, false, false, null, { kind: 'sit' });
    assert.equal(leg.rotation.x, Math.PI / 2, 'seated pose wins over kick');
    animate(0, 0, false, false, { flap: 0.78 });
    const wingArm = avatar.hand.quaternion.clone();
    assert.ok(wingArm.angleTo(identity) > 0.2, 'toy has a visible wing upstroke in both motion modes');
    animate(0, 0, true, false, { flap: 0.78 });
    assert.ok(Math.abs(avatar.hand.rotation.x - 0.9) < 1e-8, 'tool grip overrides toy wing');
    animate(0, 0, false, true, { flap: 0.78 });
    assert.ok(Math.abs(avatar.hand.rotation.x - 1.3) < 1e-8, 'carrying overrides toy wing');
  } finally { dispose(avatar.root); }
}
delete globalThis.matchMedia;
assert.equal(PUNCH_DURATION, 0.2, 'do not change five-punches-per-second gameplay');
console.log('PASS quaternion strikes and wingbeats: all rigs, bone frames, full stroke/recovery, POV visibility, grips, overrides and repeats');
