import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BODY_HEIGHT, EYE_HEIGHT } from './constants.js';
import { BODY_MODEL_URLS } from './bodyModel.js';
import { buildGarb, GARB_COLORS } from './garb.js';
import { buildSpartan } from './figureSpartan.js';
import {
  createFigure, createContactShadow, buildJetpack, updateJetFlames, figureMaterial, figureUniforms, FIGURE_ALBEDO, FIGURE_HEAT_GLOW,
  CROUCH_POSE, HEAD_LOOK, HEAD_LOOK_MAX, ELBOW_POLE, KNEE_POLE, SPRINT_LEAN,
} from './figure.js';
import { prepareMesh, getMeshGpu } from '../gfx/meshLight.js';
import { limb, solveLimb, handFrame, handTurn, setWorldQuaternion } from './limbs.js';
import { strikePose, sampleKickPose, kickBlend } from './strikePose.js';

// The realistic body: Quaternius's Superhero Male (Universal Base Characters,
// CC0), sculpted muscles in his mesh and normal map, playing clips from
// Quaternius's Universal Animation Library retargeted onto his skeleton
// (tools/character-pack.mjs) through an AnimationMixer. A wizard: his pointed
// hat (garb.js) and purple boxers. It is the default body; the stickman
// (figure.js) is the other setting, and stands in while the model loads or if
// it fails to.
//
// createBody({ choice }) returns the stickman's interface (root, bind,
// compile, update, setVisible, dispose), so the shell swaps them freely.
// choice() is read every frame: 'stick', 'real', 'woman', or the Halo-only 'spartan'.
//
// Lighting: his meshes use figure.js's figureMaterial, the world's own lighting
// (sun and its shadow map, GI probes, glow from hot matter; gfx/meshLight.js),
// skinned by three's node pipeline, his albedo and normal maps read through it.
// He glows when hot like the stickman.

// Tints over each glTF material's albedo map (linear). The eyebrows' map is a
// greyscale hair mask, tinted in the pack's engines by Quaternius's hair shader:
// a dark brown here.
const TINT_BY_MATERIAL = {
  MI_Superhero_Male: [1, 1, 1], MI_Superhero_Female: [1, 1, 1], MI_Eyes: [1, 1, 1],
  MI_Hair_1: [0.06, 0.035, 0.02], MI_Hair_2: [0.06, 0.035, 0.02],
};
const MODEL_YAW = Math.PI;               // rad: the glTF faces +z, the body's forward is -z at yaw 0

// Locomotion. Clip speeds come from the file (extras.speed, metres/s of the
// root in the root-motion twin), so the feet stay planted: the gait clips'
// phase advances with the distance walked, not the clock.
const GAIT = ['idle', 'walk', 'jog', 'sprint'];   // blended by ground speed, slowest first
const BLEND_RATE = 8;                    // 1/s: ground / air / swim / tread blend in and out (crossfade)
const DEATH_BLEND_RATE = 20;             // 1/s: collapsing starts at once
const TREAD_SPEED = 1;                   // cells/s: in deep liquid, slower than this treads water...
const SWIM_FULL_SPEED = 2.5;             // ...faster than this swims (horizontal); blended between
const SWIM_RATE_MIN = 0.6;               // the swim clip plays at least this fast (arms keep stroking at a crawl)
const SWIM_RATE_MAX = 1.5;               // and at most this fast
// Crouching: the file has no crouch clip, so the legs fold on top of whatever
// plays (figure.js CROUCH_POSE), each bone turned about the body's right axis
// in world space (its own axes don't matter), and the pelvis comes down by what
// the bend takes off the legs, so the feet stay on the ground.
const CROUCH_BONES = ['pelvis', 'spine_01', 'neck_01', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r'];
const CROUCH_RATE = 14;                  // 1/s: the bend follows the body's crouch (figure.js POSE_RATE)
// Looking and holding, on top of the clips and the crouch (figure.js's look, reach()):
// the torso's share of an aim's pitch spread over the spine, the head's over the neck,
// and hands closed round a held tool's grips.
const SPINE_BONES = ['spine_01', 'spine_02', 'spine_03'];
const HEAD_BONES = ['neck_01', 'Head'];
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const FINGER_CURL = [1.1, 1.2, 0.8];    // rad at the first, second and third knuckles: a fist round a handle
const GRIP_ALONG = 0.5;                  // share of the way from the wrist to the knuckles a grip's centre sits...
const GRIP_PALM = 0.035;                 // ...and model units (m) off the palm
const SIDES = { r: 'right', l: 'left' };

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

const gltfPromises = new Map();   // one download per model for the page
export function loadModel(choice) {
  // the file is meshopt-compressed (tools/character-compress.mjs). Keyed by URL so the
  // paper-bag guy shares the male download.
  const url = BODY_MODEL_URLS[choice];
  if (!gltfPromises.has(url)) {
    gltfPromises.set(url, new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url));
  }
  return gltfPromises.get(url);
}
const garbByModel = new WeakMap();   // hat or bag geometry, built once per download
function garbFor(gltf, meshes, bag = false) {
  let entry = garbByModel.get(gltf);
  if (!entry) garbByModel.set(gltf, entry = {});
  const kind = bag ? 'bag' : 'wizard';
  if (!entry[kind]) entry[kind] = buildGarb(meshes, { bag });
  return entry[kind];
}

// Pull the barrels onto the back. buildJetpack's cell offset clears a stick torso;
// on these meshes it leaves a gap, so the pack reads as floating.
const PACK_RADIUS = 0.32, PACK_EMBED = 0.04;
function seatPack(pack, model) {
  pack.updateWorldMatrix(true, true);
  const origin = pack.getWorldPosition(new THREE.Vector3());
  const into = new THREE.Vector3(0, 0, -1).applyQuaternion(pack.getWorldQuaternion(new THREE.Quaternion()));
  let gap = Infinity;
  const v = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isSkinnedMesh || o.name === 'hat' || o.name === 'sleeves' || o.name === 'bung') return;
    // She wears a barrel: the pack straps to that, not to the body inside it.
    if (model.getObjectByName('robe') && o.name !== 'robe' && o.name !== 'hoops') return;
    if (!model.getObjectByName('robe') && (o.name === 'robe' || o.name === 'hoops')) return;
    const n = o.geometry.attributes.position.count;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 2000))) {
      o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
      if (Math.abs(v.y - origin.y) > 0.4) continue;   // the back at the barrels, not the hem below
      const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
      const along = dx * into.x + dy * into.y + dz * into.z;
      if (dx * dx + dy * dy + dz * dz - along * along < 0.2 && along > 0 && along < gap) gap = along;
    }
  });
  const move = gap - PACK_RADIUS + PACK_EMBED;
  if (!Number.isFinite(gap) || Math.abs(move) <= 0.005) return;
  pack.parent.worldToLocal(origin.addScaledVector(into, move));
  pack.position.copy(origin);
}

// The body from a loaded glTF. Same per-frame state as the stickman.
export function createRealFigure(gltf, { bag = false } = {}) {
  const u = figureUniforms();
  const tint = [0, 0, 0, 0];
  const model = cloneSkinned(gltf.scene);   // the download is shared; each body poses its own rig
  const meshes = [];
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.frustumCulled = false;             // bounds are the bind pose; a fall or a swim leaves them
    // the maps GLTFLoader made (shared by every clone; the download owns them)
    const { map, normalMap, normalScale } = o.material;
    o.userData.look = { albedo: TINT_BY_MATERIAL[o.material.name] ?? FIGURE_ALBEDO, map, normalMap, normalScale, side: THREE.FrontSide };
    meshes.push(o);
  });
  if (!meshes.length) throw new Error('the character model has no skinned mesh');
  const body = meshes.reduce((a, b) => (b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a));

  // model units (metres) → body cells, from the bind pose's height (without the hat)
  const box = new THREE.Box3();
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }

  // the wizard's hat, on this body's own skeleton
  for (const [name, geo] of Object.entries(garbFor(gltf, meshes, bag))) {
    const garment = new THREE.SkinnedMesh(geo, body.material);
    garment.name = name;
    garment.frustumCulled = false;
    garment.bind(body.skeleton, body.bindMatrix);
    garment.userData.look = { albedo: GARB_COLORS[name], side: THREE.DoubleSide };   // the brim is one sheet
    body.parent.add(garment);
    meshes.push(garment);
  }
  // his lit materials (figure.js), one per mesh: its albedo and maps
  const mats = meshes.map((mesh) => {
    const { albedo, map, normalMap, normalScale, side } = mesh.userData.look;
    return (mesh.material = figureMaterial({ albedo, u, map, normalMap, normalScale, side }));
  });
  const cellsPerUnit = BODY_HEIGHT / (box.max.y - box.min.y);
  const modelHolder = new THREE.Group();
  modelHolder.scale.setScalar(cellsPerUnit);
  modelHolder.rotation.y = MODEL_YAW;
  modelHolder.position.y = -box.min.y * cellsPerUnit;   // feet on the ground
  modelHolder.add(model);

  const root = new THREE.Group();        // at the feet, turned to face the look direction
  root.visible = false;
  root.add(modelHolder);
  const contact = createContactShadow();
  root.add(contact);

  // every clip plays all the time; the blend sets the weights (summing to 1,
  // so the bind pose never shows through)
  const mixer = new THREE.AnimationMixer(model);
  const actions = {}, clipSpeed = {};
  for (const clip of gltf.animations) {
    const a = mixer.clipAction(clip);
    a.setEffectiveWeight(0);
    a.play();
    actions[clip.name] = a;
    // cells/s at the body's size
    clipSpeed[clip.name] = (gltf.parser.json.animations.find((x) => x.name === clip.name)?.extras?.speed ?? 0) * cellsPerUnit;
  }
  for (const k of [...GAIT, 'fall', 'swim', 'tread', 'death']) {
    if (!actions[k]) throw new Error(`the character model has no ${k} clip`);
  }
  for (const k of GAIT) actions[k].timeScale = 0;   // driven by distance below
  const death = actions.death;
  death.setLoop(THREE.LoopOnce, 1);
  death.clampWhenFinished = true;
  // gait cycle lengths (cells of travel per loop)
  const cycle = Object.fromEntries(GAIT.map((k) => [k, clipSpeed[k] * actions[k].getClip().duration]));

  // ---- looking and holding: bones read off the bind pose (the clone is still in it)
  root.updateMatrixWorld(true);
  const bone = (n) => model.getObjectByName(n);
  const kickPose = strikePose(), kickFoot = new THREE.Quaternion(), kickTurn = new THREE.Quaternion();
  // Body-axis turns must be conjugated into each bone's resting parent frame.
  const kickJoints = [['thigh_r', 'hip'], ['calf_r', 'knee'], ['foot_r', 'foot'], ['spine_01', 'torso']].map(([name, key]) => {
    const b = bone(name);
    const basis = b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(root.getWorldQuaternion(new THREE.Quaternion()));
    return { b, key, basis, inverse: basis.clone().invert(), bind: b.quaternion.clone() };
  });
  const spine = SPINE_BONES.map(bone), head = HEAD_BONES.map(bone);
  const jetpack = buildJetpack(root, { up: 3.65, back: 0.75 });
  jetpack.root.traverse((mesh) => {
    if (mesh.userData.albedo) {
      mesh.material = figureMaterial({ albedo: mesh.userData.albedo, u });
      mats.push(mesh.material);
    }
  });
  // Preserve its cell-space fit while parenting to the animated chest bone, then
  // sit the barrels on the back. The shared cell offset floats clear of her.
  spine[2].attach(jetpack.root);
  seatPack(jetpack.root, model);
  const chestToEye = EYE_HEIGHT - spine[2].getWorldPosition(new THREE.Vector3()).y;   // cells at the plain size
  const qRoot = new THREE.Quaternion(), qBind = new THREE.Quaternion();
  const arms = {}, legs = {};
  for (const [k, side] of Object.entries(SIDES)) {
    const hand = bone(`hand_${k}`);
    const frame = handFrame(hand, bone(`middle_01_${k}`), bone(`thumb_01_${k}`), side);
    // a fist: each finger joint turned toward the palm, about the knuckles' axis (fingers × palm) in its own frame
    hand.getWorldQuaternion(qBind);
    const curlAxis = frame.fingers.clone().cross(frame.palm).applyQuaternion(qBind);
    const fingers = FINGERS.flatMap((f) => [1, 2, 3].map((j) => {
      const b = bone(`${f}_0${j}_${k}`);
      return { b, bind: b.quaternion.clone(), axis: curlAxis.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert()), curl: FINGER_CURL[j - 1] };
    }));
    arms[k] = { L: limb(bone(`upperarm_${k}`), bone(`lowerarm_${k}`), hand.position, 1), hand, frame, fingers, side: k === 'r' ? 1 : -1 };
    // a foot on a peg: the ankle above and behind the middle of the sole, the sole level
    const foot = bone(`foot_${k}`), ankle = foot.getWorldPosition(new THREE.Vector3()), ball = bone(`ball_${k}`).getWorldPosition(new THREE.Vector3());
    legs[k] = {
      L: limb(bone(`thigh_${k}`), bone(`calf_${k}`), foot.position, 1), foot, side: k === 'r' ? 1 : -1,
      ankle: ankle.clone().sub(new THREE.Vector3(ankle.x, 0, (ankle.z + ball.z) / 2)),   // cells, body frame, from the sole's middle
      level: foot.getWorldQuaternion(new THREE.Quaternion()),   // the sole flat, body frame
    };
  }
  // the bones looking and holding turn: put back to the clips' pose before the clips run again
  const held = [...spine, ...head, ...Object.values(arms).flatMap((a) => [a.L.upper, a.L.lower, a.hand, ...a.fingers.map((f) => f.b)]),
    ...Object.values(legs).flatMap((l) => [l.L.upper, l.L.lower, l.foot])];
  const heldPose = held.map(() => new THREE.Quaternion());
  let holding = false;
  const keepPose = () => held.forEach((b, i) => heldPose[i].copy(b.quaternion));
  const putBack = () => { if (holding) held.forEach((b, i) => b.quaternion.copy(heldPose[i])); holding = false; };
  const vPole = new THREE.Vector3(), vAt = new THREE.Vector3(), qHand = new THREE.Quaternion(), qFoot = new THREE.Quaternion();
  const vScale = new THREE.Vector3();

  const w = { ground: 1, air: 0, swim: 0, tread: 0, death: 0 };
  const tw = { ...w };
  const gaitW = Object.fromEntries(GAIT.map((k) => [k, 0]));
  let compiled = null;
  let facing = 0, gaitPhase = 0, wasDead = false;

  // the crouch's bend, on top of the clips
  const bones = Object.fromEntries(CROUCH_BONES.map((n) => [n, model.getObjectByName(n)]));
  const canCrouch = CROUCH_BONES.every((n) => bones[n]);
  const clipPose = CROUCH_BONES.map(() => ({ q: new THREE.Quaternion(), p: new THREE.Vector3() }));
  let bent = false, bend = 0;
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), right = new THREE.Vector3();
  const va = new THREE.Vector3(), vb = new THREE.Vector3();
  // turn a bone by `angle` about the body's right axis, in world space
  function turn(bone, angle) {
    bone.parent.getWorldQuaternion(qa);
    qb.setFromAxisAngle(right, angle);
    bone.quaternion.premultiply(qa.clone().invert().multiply(qb).multiply(qa));
  }
  let wing = 0;
  function flapArms(amount) {
    if (!(amount > 0)) return;
    root.updateWorldMatrix(true, true);
    right.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(qa));
    for (const a of Object.values(arms)) {
      turn(a.L.upper, -2.4 * amount);
      turn(a.L.lower, 1.2 * amount);
    }
  }
  const length = (a, b) => a.getWorldPosition(va).distanceTo(b.getWorldPosition(vb));
  function crouchBend(c) {
    // the clip pose back first: a bone without a track would keep last frame's bend
    if (bent) CROUCH_BONES.forEach((n, i) => { bones[n].quaternion.copy(clipPose[i].q); bones[n].position.copy(clipPose[i].p); });
    bent = false;
    if (!canCrouch || c < 1e-3) return;
    CROUCH_BONES.forEach((n, i) => { clipPose[i].q.copy(bones[n].quaternion); clipPose[i].p.copy(bones[n].position); });
    bent = true;
    root.updateWorldMatrix(true, true);
    right.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(qa));   // the body faces −z
    const hip = CROUCH_POSE.hip * c, knee = CROUCH_POSE.knee * c;
    // the pelvis down by what the bend takes off a straight leg
    const thigh = length(bones.thigh_l, bones.calf_l), shin = length(bones.calf_l, bones.foot_l);
    const drop = thigh * (1 - Math.cos(hip)) + shin * (1 - Math.cos(hip + knee));
    const pelvis = bones.pelvis;
    pelvis.getWorldPosition(va).y -= drop;
    pelvis.parent.updateWorldMatrix(true, false);
    pelvis.position.copy(pelvis.parent.worldToLocal(va));
    turn(bones.spine_01, -CROUCH_POSE.lean * c);   // forward is a negative turn for a bone pointing up
    turn(bones.neck_01, CROUCH_POSE.head * c);
    for (const side of ['l', 'r']) {
      turn(bones[`thigh_${side}`], hip);           // and a positive one for a bone pointing down
      turn(bones[`calf_${side}`], knee);
      turn(bones[`foot_${side}`], -(hip + knee));  // the sole stays flat
    }
  }

  // weights over the gait clips for a ground speed: linear between neighbours
  function gaitWeights(speed) {
    for (const k of GAIT) gaitW[k] = 0;
    for (let i = 0; i < GAIT.length - 1; i++) {
      const a = clipSpeed[GAIT[i]], b = clipSpeed[GAIT[i + 1]];
      if (speed <= b || i === GAIT.length - 2) {
        const t = Math.min(Math.max((speed - a) / (b - a), 0), 1);
        gaitW[GAIT[i]] = 1 - t;
        gaitW[GAIT[i + 1]] = t;
        return;
      }
    }
  }

  return {
    root,
    nozzles: jetpack.nozzles,
    // the light is the volume's whatever the grid (gfx/meshLight.js): nothing to rebuild
    bind() {},
    // compile his materials for the scene target before he is first drawn (B5, F8)
    compile() {
      if (!compiled && getMeshGpu()) compiled = prepareMesh(root);
      return compiled ?? Promise.resolve();
    },
    // s: the stickman's state, plus headInLiquid
    update(dt, s) {
      // riding (a pogo stick: s.ride): standing still on its pegs, whatever the body is doing under it
      const riding = !!s.ride && !s.dead;
      if (riding) s = { ...s, onGround: true, inLiquid: false, speedH: 0 };
      root.position.copy(s.feet);
      root.position.y += (s.lift ?? 0) * s.scale;
      root.scale.setScalar(s.scale);
      u.worldToGrid.value.copy(s.worldToGrid);
      u.emit.value.set(...FIGURE_HEAT_GLOW).multiplyScalar(s.heat ?? 0);
      u.tint.value.set(...(s.status ? s.status.tint(tint) : tint.fill(0)));
      if (!s.dead) facing = s.yaw;
      root.rotation.set(0, facing, 0);

      // which state: standing in shallow liquid (head out, feet down) walks
      const wading = s.inLiquid && s.onGround && !s.headInLiquid;
      const swimming = s.inLiquid && !wading;
      const swimShare = smooth01((s.speedH - TREAD_SPEED) / (SWIM_FULL_SPEED - TREAD_SPEED));
      tw.death = s.dead ? 1 : 0;
      tw.ground = !s.dead && (s.onGround && !swimming) ? 1 : 0;
      tw.air = !s.dead && !s.onGround && !s.inLiquid ? 1 : 0;
      tw.swim = !s.dead && swimming ? swimShare : 0;
      tw.tread = !s.dead && swimming ? 1 - swimShare : 0;
      if (s.dead && !wasDead) death.reset().play();
      if (!s.dead && wasDead) Object.assign(w, tw);    // respawned: stand up at once, no slow rise from the floor
      wasDead = s.dead;
      const k = approach(s.dead ? DEATH_BLEND_RATE : BLEND_RATE, dt);
      for (const key in w) w[key] += (tw[key] - w[key]) * k;

      // gait: blend by speed, advance the shared phase by the distance walked
      gaitWeights(s.speedH);
      let len = 0;
      for (const g of GAIT) len += gaitW[g] * cycle[g];
      if (s.onGround && len > 0) gaitPhase = (gaitPhase + (s.speedH * dt) / len) % 1;
      for (const g of GAIT) {
        actions[g].time = gaitPhase * actions[g].getClip().duration;
        actions[g].setEffectiveWeight(w.ground * gaitW[g]);
      }
      actions.fall.setEffectiveWeight(w.air);
      actions.swim.setEffectiveWeight(w.swim);
      actions.swim.timeScale = THREE.MathUtils.clamp(s.speedH / clipSpeed.swim, SWIM_RATE_MIN, SWIM_RATE_MAX);
      actions.tread.setEffectiveWeight(w.tread);
      death.setEffectiveWeight(w.death);
      putBack();
      crouchBend(0);   // the clips' pose, for the mixer to write over
      mixer.update(dt);
      bend += ((s.dead ? 0 : (s.crouch ?? 0) * w.ground) - bend) * approach(CROUCH_RATE, dt);
      crouchBend(bend);
      keepPose();
      // The cheat-speed lean rides on the clips, not the camera; feet stay on the ground.
      const rushLean = SPRINT_LEAN * (s.sprintRush ?? 0) * w.ground * (1 - bend) * !riding;
      // the look: the torso leans into a held tool's aim, the head follows the rest
      if ((s.look || rushLean) && !s.dead) {
        holding = true;
        root.updateWorldMatrix(true, true);
        right.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(qa));
        const lean = (s.look?.pitch ?? 0) * (s.look?.spine ?? 0);
        const nod = THREE.MathUtils.clamp(((s.look?.pitch ?? 0) - lean) * HEAD_LOOK, -HEAD_LOOK_MAX, HEAD_LOOK_MAX);
        for (const b of spine) { turn(b, (lean - rushLean) / spine.length); b.updateWorldMatrix(false, false); }
        for (const b of head) { turn(b, nod / head.length); b.updateWorldMatrix(false, false); }
      }
      wing = s.dead ? 0 : s.flap ?? 0;
      flapArms(wing);   // empty hands; a held tool's reach() poses the arms again, higher
      if (s.kick != null && !s.dead) {
        sampleKickPose(s.kick, kickPose);
        const weight = kickBlend(s.kick);
        kickFoot.copy(kickPose.knee).invert().multiply(kickTurn.copy(kickPose.hip).invert());
        for (const { b, key, basis, inverse, bind } of kickJoints) {
          kickTurn.copy(basis).multiply(key === 'foot' ? kickFoot : kickPose[key]).multiply(inverse);
          if (key === 'torso') b.quaternion.premultiply(kickTurn);
          else b.quaternion.slerp(kickTurn.multiply(bind), weight);
        }
        holding = true;   // restore even untracked bones before the next mixer update
      }
      contact.visible = s.onGround && !s.dead && !riding;
      updateJetFlames(jetpack.flames, s);
    },
    setVisible(v) { root.visible = v; },
    // the eye (world), riding the chest: a held tool's aim frame hangs from it (held.js)
    anchor(out) {
      spine[2].updateWorldMatrix(true, false);
      return spine[2].getWorldPosition(out).add(vAt.set(0, chestToEye * root.scale.x, 0));
    },
    // Hands and feet to a held tool (held.js), after update(): right / left grips
    // { pos, fingers, palm } (world: the grip's centre, and the way the knuckles and
    // the palm face), the fist closed round it; feet [right, left]: where the soles
    // stand (world); weight 0..1 of the reach over the clips' pose.
    reach({ right: r = null, left: l = null, feet = null, weight = 1 }) {
      if (!(weight > 0)) return;
      holding = true;
      root.updateWorldMatrix(true, true);
      root.getWorldQuaternion(qRoot);
      const s = root.scale.x;
      const blend = (bones, from) => { if (weight < 1) bones.forEach((b, i) => b.quaternion.copy(from[i].slerp(b.quaternion, weight))); };
      const pole = (L, side, P) => L.upper.getWorldPosition(vPole).add(vAt.set(side * P[0], P[1], P[2]).applyQuaternion(qRoot).multiplyScalar(s));
      for (const [k, g] of [['r', r], ['l', l]]) {
        if (!g) continue;
        const a = arms[k], bones = [a.L.upper, a.L.lower, a.hand, ...a.fingers.map((f) => f.b)];
        const from = bones.map((b) => b.quaternion.clone());
        handTurn(a.frame, g.fingers, g.palm, qHand);
        // the wrist: back from the grip's centre along the fingers and off the palm
        const ws = a.hand.getWorldScale(vScale).x;
        const wrist = vAt.copy(a.frame.fingers).multiplyScalar(GRIP_ALONG * a.frame.reach).addScaledVector(a.frame.palm, GRIP_PALM)
          .applyQuaternion(qHand).multiplyScalar(-ws).add(g.pos);
        if (wing > 0) {
          wrist.y += 0.9 * wing * s;
          wrist.addScaledVector(vAt.set(a.side, 0, 0).applyQuaternion(qRoot), 0.35 * wing * s);
        }
        const target = wrist.clone();
        solveLimb(a.L, target, pole(a.L, a.side, ELBOW_POLE));
        setWorldQuaternion(a.hand, qHand);
        for (const f of a.fingers) f.b.quaternion.setFromAxisAngle(f.axis, f.curl).premultiply(f.bind);
        blend(bones, from);
      }
      if (feet) {
        for (const [k, at] of [['r', feet[0]], ['l', feet[1]]]) {
          const g = legs[k], bones = [g.L.upper, g.L.lower, g.foot];
          const from = bones.map((b) => b.quaternion.clone());
          const ankle = vAt.copy(g.ankle).applyQuaternion(qRoot).multiplyScalar(s).add(at).clone();
          solveLimb(g.L, ankle, pole(g.L, g.side, KNEE_POLE));
          setWorldQuaternion(g.foot, qFoot.copy(qRoot).multiply(g.level));
          blend(bones, from);
        }
      }
      flapArms(wing);   // after the grip, or the tool pose erases the wingbeat
    },
    get material() { return mats[0]; },
    // tests: the posed rig and each clip's blend weight
    model,
    get weights() { return Object.fromEntries(Object.entries(actions).map(([k, a]) => [k, a.getEffectiveWeight()])); },
    dispose() {
      mixer.stopAllAction();
      for (const m of mats) m.dispose();
      jetpack.flames[0].material.dispose();
      contact.material.dispose();
      root.traverse((o) => o.geometry?.dispose());
    },
  };
}

// The shell chooses 'spartan' in Halo, otherwise the saved body.
// The stickman stands in while the realistic wizard loads and compiles.
// The Castle Crashers wizard (figureCrasher.js) only draws NPCs.
export function createBody({ choice }) {
  const stick = createFigure();
  const spartan = createFigure(buildSpartan);
  const light = [stick, spartan];   // procedural bodies, no model download
  const figures = new Map(), failed = new Set(), loading = new Set();
  let disposed = false;
  let bound = null;
  const root = new THREE.Group();
  root.visible = false;
  for (const f of light) { root.add(f.root); f.setVisible(true); }   // the parts show or hide by choice; root is the body's visibility

  const wantsReal = () => Object.hasOwn(BODY_MODEL_URLS, choice()) && !failed.has(choice());
  function load(key = choice()) {
    if (disposed || loading.has(key) || figures.has(key) || failed.has(key)) return;
    loading.add(key);
    loadModel(key)
      .then(async (gltf) => {
        if (disposed) return;
        const fig = createRealFigure(gltf, { bag: key === 'stick' });
        try {
          if (bound) fig.bind(...bound);
          await fig.compile();   // pipelines built before it joins the scene, so switching doesn't hitch (B5)
          if (disposed) { fig.dispose(); return; }
          root.add(fig.root);
          figures.set(key, fig);
        } catch (err) { fig.dispose(); throw err; }
      })
      .catch((err) => { failed.add(key); console.error(`${key} body failed to load; using the stickman`, err); })
      .finally(() => { loading.delete(key); });
  }
  const active = () => choice() === 'spartan' ? spartan : (wantsReal() ? figures.get(choice()) ?? stick : stick);

  return {
    root,
    bind(volume, g) {
      bound = [volume, g];
      for (const f of light) f.bind(volume, g);
      for (const f of figures.values()) f.bind(volume, g);
      if (wantsReal()) load();
    },
    get material() { return active().material; },
    compile() {
      return Promise.all([...light, ...figures.values()].map((f) => f.compile()));
    },
    update(dt, s) {
      if (wantsReal()) load();
      const fig = active();
      for (const f of light) f.setVisible(fig === f);
      for (const f of figures.values()) f.setVisible(fig === f);
      fig.update(dt, s);
    },
    setVisible(v) { root.visible = v; },
    // the showing body's eye and reach (held.js), after update()
    anchor(out) { return active().anchor(out); },
    reach(r) { active().reach(r); },
    // which body is showing (tests)
    get showing() { return active() === spartan ? 'spartan' : active() === stick ? 'stick' : choice(); },
    // where the showing body's jetpack exhaust leaves (vfx.js)
    get nozzles() { return active().nozzles; },
    get loaded() { return figures.has(choice()); },
    get real() { return figures.get(choice()) ?? null; },
    get model() { return active().model ?? active().root; },
    dispose() {
      disposed = true;
      for (const f of light) f.dispose();
      for (const f of figures.values()) f.dispose();
    },
  };
}
