import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BODY_HEIGHT } from './constants.js';
import {
  createFigure, createContactShadow, figureFrag, figureSkinnedVert, FIGURE_ALBEDO, FIGURE_HEAT_GLOW,
} from './figure.js';

// The realistic body: Quaternius's mannequin (Universal Animation Library,
// CC0), skinned and played by an AnimationMixer, behind the "Body" setting.
// The stickman (figure.js) is the low setting, and it stands in while the
// model loads or if it fails to.
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

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

let gltfPromise = null;   // one download for the page
function loadModel() {
  gltfPromise ??= new GLTFLoader().loadAsync(MODEL_URL);
  return gltfPromise;
}

// The mannequin from a loaded glTF. Same per-frame state as the stickman.
function createRealFigure(gltf) {
  const uniforms = {
    uEmit: { value: new THREE.Vector3() },
    uWorldToGrid: { value: new THREE.Matrix4() },
  };
  const model = cloneSkinned(gltf.scene);   // the download is shared; each body poses its own rig
  const meshes = [];
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.frustumCulled = false;             // bounds are the bind pose; a fall or a swim leaves them
    o.userData.albedo = ALBEDO_BY_MATERIAL[o.material.name] ?? FIGURE_ALBEDO;
    meshes.push(o);
  });
  if (!meshes.length) throw new Error('the character model has no skinned mesh');

  // model units (metres) → body cells, from the bind pose's height
  const box = new THREE.Box3();
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
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
      mixer.update(dt);
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

// The body the shell shows: the stickman or the mannequin, by choice(), with
// the stickman standing in until the mannequin is loaded and compiled.
export function createBody({ choice }) {
  const stick = createFigure();
  let real = null, failed = false, loading = false;
  let bound = null, compileArgs = null;
  const root = new THREE.Group();
  root.visible = false;
  root.add(stick.root);
  stick.setVisible(true);   // the parts show or hide by choice; root is the body's visibility

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
  const active = () => (wantsReal() && real ? real : stick);

  return {
    root,
    bind(volume, g) {
      bound = [volume, g];
      stick.bind(volume, g);
      real?.bind(volume, g);
      if (wantsReal()) load();
    },
    get material() { return active().material; },
    compile(renderer, camera, scene) {
      compileArgs = [renderer, camera, scene];
      return Promise.all([stick.compile(renderer, camera, scene), real?.compile(renderer, camera, scene)]);
    },
    update(dt, s) {
      if (wantsReal()) load();
      const fig = active();
      stick.setVisible(fig === stick);
      real?.setVisible(fig === real);
      fig.update(dt, s);
    },
    setVisible(v) { root.visible = v; },
    // which body is showing: 'stick' or 'real' (tests)
    get showing() { return active() === real ? 'real' : 'stick'; },
    get loaded() { return !!real; },
    get real() { return real; },
    dispose() {
      stick.dispose();
      real?.dispose();
    },
  };
}
