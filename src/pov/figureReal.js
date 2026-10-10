import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BODY_HEIGHT } from './constants.js';
import { buildGarb, GARB_COLORS } from './garb.js';
import {
  createFigure, createContactShadow, JET_NOZZLES, figureFrag, figureSkinnedVert, FIGURE_ALBEDO, FIGURE_HEAT_GLOW,
  CROUCH_POSE,
} from './figure.js';

// The realistic body: Quaternius's mannequin (Universal Animation Library,
// CC0), skinned and played by an AnimationMixer, dressed as a wizard (a
// pointed hat and a robe, garb.js). It is the default body; the stickman
// (figure.js) is the other setting, and stands in while the model loads or if
// it fails to.
//
// createBody({ choice }) returns the stickman's interface (root, bind,
// compile, update, setVisible, dispose), so the shell swaps them freely.
// choice() is read every frame: 'stick' or 'real'.
//
// Lighting: the mannequin's meshes use figure.js's figureFrag, the world's own
// lighting (sun and its shadow map, GI probes, glow from hot matter), with a
// skinned version of its vertex shader. It glows when hot like the stickman.

const MODEL_URL = `${import.meta.env.BASE_URL}models/character/mannequin.glb`;

// Materials, by the glTF material name (albedo, linear): the body matches the
// stickman, the joint bands are a darker grey.
const ALBEDO_BY_MATERIAL = { M_Main: FIGURE_ALBEDO, M_Joints: [0.22, 0.22, 0.24] };
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

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

let gltfPromise = null;   // one download for the page
function loadModel() {
  gltfPromise ??= new GLTFLoader().loadAsync(MODEL_URL);
  return gltfPromise;
}
const garbByModel = new WeakMap();   // the clothes' geometry, built once per download and shared by every body
function garbFor(gltf, meshes) {
  if (!garbByModel.has(gltf)) garbByModel.set(gltf, buildGarb(meshes));
  return garbByModel.get(gltf);
}

// The mannequin from a loaded glTF. Same per-frame state as the stickman.
function createRealFigure(gltf) {
  const uniforms = {
    uEmit: { value: new THREE.Vector3() },
    uTint: { value: new THREE.Vector4() },
    uWorldToGrid: { value: new THREE.Matrix4() },
  };
  const tint = [0, 0, 0, 0];
  const model = cloneSkinned(gltf.scene);   // the download is shared; each body poses its own rig
  const meshes = [];
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.frustumCulled = false;             // bounds are the bind pose; a fall or a swim leaves them
    o.userData.albedo = ALBEDO_BY_MATERIAL[o.material.name] ?? FIGURE_ALBEDO;
    meshes.push(o);
  });
  if (!meshes.length) throw new Error('the character model has no skinned mesh');

  // model units (metres) → body cells, from the bind pose's height (without the hat)
  const box = new THREE.Box3();
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }

  // the wizard's clothes, on this body's own skeleton
  for (const [name, geo] of Object.entries(garbFor(gltf, meshes))) {
    const garment = new THREE.SkinnedMesh(geo, meshes[0].material);
    garment.name = name;
    garment.frustumCulled = false;
    garment.bind(meshes[0].skeleton, meshes[0].bindMatrix);
    garment.userData.albedo = GARB_COLORS[name];
    meshes[0].parent.add(garment);
    meshes.push(garment);
  }
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

  const w = { ground: 1, air: 0, swim: 0, tread: 0, death: 0 };
  const tw = { ...w };
  const gaitW = Object.fromEntries(GAIT.map((k) => [k, 0]));
  let mats = [], boundTo = null, compiled = null;
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
    bind(volume, g) {
      if (boundTo === volume) return;
      boundTo = volume;
      for (const m of mats) m.dispose();
      mats = meshes.map((mesh) => {
        const mat = new THREE.ShaderMaterial({
          vertexShader: figureSkinnedVert,
          fragmentShader: figureFrag(g),
          side: THREE.DoubleSide,          // the robe is open at the hem
          uniforms: { ...volume.material.uniforms, ...uniforms, uAlbedo: { value: new THREE.Vector3(...mesh.userData.albedo) } },
        });
        mesh.material = mat;
        return mat;
      });
    },
    compile(renderer, camera, scene) {
      if (compiled === mats[0]) return Promise.resolve();
      compiled = mats[0];
      return renderer.compileAsync(root, camera, scene).catch(() => {});
    },
    // s: the stickman's state, plus headInLiquid
    update(dt, s) {
      root.position.copy(s.feet);
      root.scale.setScalar(s.scale);
      uniforms.uWorldToGrid.value.copy(s.worldToGrid);
      uniforms.uEmit.value.set(...FIGURE_HEAT_GLOW).multiplyScalar(s.heat ?? 0);
      uniforms.uTint.value.set(...(s.status ? s.status.tint(tint) : tint.fill(0)));
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
      crouchBend(0);   // the clips' pose, for the mixer to write over
      mixer.update(dt);
      bend += ((s.dead ? 0 : (s.crouch ?? 0) * w.ground) - bend) * approach(CROUCH_RATE, dt);
      crouchBend(bend);
      contact.visible = s.onGround && !s.dead;
    },
    setVisible(v) { root.visible = v; },
    get material() { return mats[0]; },
    // tests: the posed rig and each clip's blend weight
    model,
    get weights() { return Object.fromEntries(Object.entries(actions).map(([k, a]) => [k, a.getEffectiveWeight()])); },
    dispose() {
      mixer.stopAllAction();
      for (const m of mats) m.dispose();
      contact.material.dispose();
      root.traverse((o) => o.geometry?.dispose());
    },
  };
}

// The body the shell shows, by choice(): 'real' (the wizard mannequin) or
// 'stick', with the stickman standing in until the mannequin is loaded and
// compiled. (The Castle Crashers wizard, figureCrasher.js, now only draws NPCs.)
export function createBody({ choice }) {
  const stick = createFigure();
  const light = [stick];   // the procedural body: cheap, always built
  let real = null, failed = false, loading = false;
  let bound = null, compileArgs = null;
  const root = new THREE.Group();
  root.visible = false;
  for (const f of light) { root.add(f.root); f.setVisible(true); }   // the parts show or hide by choice; root is the body's visibility

  const wantsReal = () => choice() === 'real' && !failed;
  function load() {
    if (loading || real || failed) return;
    loading = true;
    loadModel()
      .then(async (gltf) => {
        const fig = createRealFigure(gltf);
        if (bound) fig.bind(...bound);
        if (compileArgs) await fig.compile(...compileArgs);   // off the main thread, so switching doesn't hitch
        root.add(fig.root);
        real = fig;
      })
      .catch((err) => { failed = true; console.error('Realistic body failed to load; using the stickman', err); })
      .finally(() => { loading = false; });
  }
  const active = () => (wantsReal() ? real ?? stick : stick);

  return {
    root,
    bind(volume, g) {
      bound = [volume, g];
      for (const f of light) f.bind(volume, g);
      real?.bind(volume, g);
      if (wantsReal()) load();
    },
    get material() { return active().material; },
    compile(renderer, camera, scene) {
      compileArgs = [renderer, camera, scene];
      return Promise.all([...light.map((f) => f.compile(renderer, camera, scene)), real?.compile(renderer, camera, scene)]);
    },
    update(dt, s) {
      if (wantsReal()) load();
      const fig = active();
      for (const f of light) f.setVisible(fig === f);
      real?.setVisible(fig === real);
      fig.update(dt, s);
    },
    setVisible(v) { root.visible = v; },
    // which body is showing: 'stick' or 'real' (tests)
    get showing() { return active() === real ? 'real' : 'stick'; },
    // where the showing body's jetpack exhaust leaves (vfx.js)
    get nozzles() { return active().nozzles ?? JET_NOZZLES; },
    get loaded() { return !!real; },
    get real() { return real; },
    dispose() {
      for (const f of light) f.dispose();
      real?.dispose();
    },
  };
}
