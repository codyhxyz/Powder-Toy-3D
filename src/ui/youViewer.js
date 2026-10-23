// "This is you." live: the loading screen's actual player (ui/menu.js): the
// body you are about to spawn as (pov/character.js previewCharacter): the
// realistic wizard, stickman, Spartan, or Animal Crossing boy or girl, using
// the game's models on a small renderer of its own. Skyrim's loading screen:
// the model turns slowly by itself, a drag turns it left or right, and the
// wheel moves the camera in and out. The menu runs it in a worker on an
// OffscreenCanvas (ui/youWorker.js), so he keeps breathing and turning while
// the boot holds the page (the map build, the shaders).
// tools/you-portrait.mjs renders one frame of it into public/you.webp, the
// still shown until this one is up.
//
// It lights him like a character-select portrait (TF2's class select, Halo 3's
// player model in the lobby): a warm key from the front, a cool rim from behind
// to cut him out of a dark screen, and a soft room for the skin's sheen.
//   createYou({ canvas, width, height, character, zoom, pixelRatio, yaw, time }) → { canvas, yaw, zoom, setZoom, frame(dt), dispose() }
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BODY_MODEL_URLS } from '../pov/bodyModel.js';
import { YOU_ZOOM_MIN, YOU_ZOOM_MAX } from '../pov/character.js';
import { buildGarb, GARB_COLORS } from '../pov/garb.js';
import { createBarrelFit } from '../pov/barrel.js';

const FOV = 20;                       // degrees: a long lens, little distortion (pov/classPortraits.js uses 24)
const FRAME_MARGIN = 1.03;            // room round his box
const LOW_ANGLE = 0.06;               // rad the camera looks up at him: a little heroic
const EYEBROWS = [0.06, 0.035, 0.02]; // figureReal.js TINT_BY_MATERIAL.MI_Hair_1: dark brown over the greyscale mask
const ROOM = 0.6;                     // soft room light, without flattening the key's shadows
const KEY = 2.0;                      // key light, warm, from up front left
const KEY_COLOR = 0xfff1df;
const KEY_DIR = [-2, 3, 3.2];
const RIM = 1.8;                      // a restrained cool edge, not a blue plastic sheen
const RIM_COLOR = 0xb8d2ed;
const RIM_DIR = [2.4, 1.8, -3];
const FILL = 0.5;                     // a subtle purple fill from behind left
const FILL_COLOR = 0xc9bddc;
const FILL_DIR = [-2.6, 0.6, -2];
const EXPOSURE = 1.0;
const MAX_DT = 0.1;                   // s: a frame after a stall steps no further
// Skyrim's loading screen: the model turns by itself, slowly, and the mouse turns it
export const YOU_SPIN = (2 * Math.PI) / 40;    // rad/s it turns by itself: once round in 40 s
export const YOU_DRAG = (2 * Math.PI) / 360;   // rad per CSS px of drag: once round in 360 px
export const YOU_YAW = 0.42;                   // rad: the still's turn, a little to screen left (where the live one starts)
export const YOU_TIME = 0.6;                   // s into the idle clip: the still's moment

function clampZoom(zoom) {
  return Math.min(YOU_ZOOM_MAX, Math.max(YOU_ZOOM_MIN, zoom || 1));
}

async function loadBody(character, time) {
  if (['boy', 'girl', 'maple', 'clover', 'pippin', 'crook'].includes(character)) {
    // The village avatar you drop in as (village/models.js), not the hidden physics body.
    const { character: buildVillage } = await import('../pov/village/models.js');
    const { RESIDENTS } = await import('../pov/village/residents.js');
    const { TIM_CROOK } = await import('../pov/village/crook.js');
    const spec = character === 'crook' ? TIM_CROOK : RESIDENTS.find(r => r.name.toLowerCase() === character);
    const avatar = buildVillage(spec ?? { persona: character });
    avatar.root.rotation.y = Math.PI; // faces -z; the portrait camera faces +z
    let clock = time;
    return { model: avatar.root, step(dt) { clock += dt; avatar.animate(clock, 0); } };
  }
  if (!Object.hasOwn(BODY_MODEL_URLS, character)) {
    const build = character === 'spartan'
      ? (await import('../pov/figureSpartan.js')).buildSpartan
      : (await import('../pov/figure.js')).buildStick;
    const rig = build();
    const model = rig.body;
    model.position.y = rig.hipY;
    model.rotation.y = Math.PI; // procedural bodies face -z; the portrait camera faces +z
    model.traverse((o) => {
      if (!o.isMesh || !o.userData.albedo) return;   // jet flames have their own material
      o.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(...o.userData.albedo), roughness: 0.85,
      });
    });
    return { model };
  }
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(BODY_MODEL_URLS[character]);
  const model = gltf.scene;
  const meshes = [];
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.frustumCulled = false;
    if (['MI_Hair_1', 'MI_Hair_2'].includes(o.material.name)) o.material.color.setRGB(...EYEBROWS);
    meshes.push(o);
  });
  // the hat, skinned to his head bone as in the game
  const body = meshes.reduce((a, b) => (b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a));
  const garb = buildGarb(meshes, { bag: character === 'stick' });
  // her barrel: the arms hung over its rim and the legs inside it, as in the game (figureReal.js)
  const fit = garb.robe ? createBarrelFit(garb.robe.userData.barrel, model, body) : null;
  for (const [name, geo] of Object.entries(garb)) {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...(geo.userData.albedo ?? GARB_COLORS[name] ?? GARB_COLORS.hat)),
      roughness: name === 'hoops' ? 0.55 : 0.95,
      metalness: name === 'hoops' ? 0.8 : 0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.bind(body.skeleton, body.bindMatrix);
    body.parent.add(mesh);
    meshes.push(mesh);
  }

  // his idle clip: the breathing
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(gltf.animations.find((c) => c.name === 'idle')).play();
  const pose = () => { if (fit) { model.updateMatrixWorld(true); fit.drape(); fit.keepLegs(); } };
  mixer.setTime(time);
  pose();
  return { model, step(dt) { fit?.restore(); mixer?.update(dt); pose(); }, stop() { mixer?.stopAllAction(); } };
}

export async function createYou({ canvas, width, height, character = 'real', zoom = 1, pixelRatio = 1, yaw = YOU_YAW, time = YOU_TIME, preserveDrawingBuffer = false }) {
  const { model, step, stop } = await loadBody(character, time);
  const holder = new THREE.Group();   // turned about his feet; the glTF faces +z, the camera
  holder.add(model);
  const scene = new THREE.Scene();
  scene.add(holder);
  scene.updateMatrixWorld(true);

  // his posed box, from the skinned vertices, made round about the turning axis: framed once, he
  // fits the frame at every yaw
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  model.traverse((m) => {
    if (!m.isMesh) return;
    m.skeleton?.update();
    const n = m.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) box.expandByPoint(m.localToWorld(m.getVertexPosition(i, v)));
  });
  if (box.isEmpty()) box.setFromObject(model, true);
  const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
  const centre = new THREE.Vector3(0, (box.min.y + box.max.y) / 2, 0);
  const tall = box.max.y - box.min.y;

  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 100);
  const half = THREE.MathUtils.degToRad(FOV / 2);
  const fitH = (tall / 2) / Math.tan(half);
  const fitW = reach / (Math.tan(half) * camera.aspect);
  const dist = Math.max(fitH, fitW) * FRAME_MARGIN + reach;
  const offset = new THREE.Vector3(0, -Math.sin(LOW_ANGLE) * dist, Math.cos(LOW_ANGLE) * dist);
  camera.position.copy(centre).add(offset);
  camera.lookAt(centre);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // (three r186 dropped PCFSoft and drew this anyway, with a warning)
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = ROOM;
  for (const [intensity, color, dir] of [[KEY, KEY_COLOR, KEY_DIR], [RIM, RIM_COLOR, RIM_DIR], [FILL, FILL_COLOR, FILL_DIR]]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...dir).add(centre);
    light.target.position.copy(centre);
    if (intensity === KEY) {
      // The hat and barrel need contact with the body; unshadowed lights make them look pasted on.
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      Object.assign(light.shadow.camera, { left: -tall, right: tall, top: tall, bottom: -tall, near: 0.1, far: 20 });
      light.shadow.normalBias = 0.012;
      light.shadow.bias = -0.0001;
      light.shadow.camera.updateProjectionMatrix();
    }
    scene.add(light, light.target);
  }

  const you = {
    canvas: renderer.domElement,
    yaw,
    zoom: clampZoom(zoom),
    setZoom(z) { you.zoom = clampZoom(z); },
    // advance his breathing dt seconds (turning him too, unless held) and draw him at you.yaw
    frame(dt = 0, turn = false) {
      dt = Math.min(dt, MAX_DT);
      if (turn) you.yaw += YOU_SPIN * dt;
      step?.(dt);
      holder.rotation.y = you.yaw;
      camera.position.copy(centre).addScaledVector(offset, you.zoom);
      camera.lookAt(centre);
      renderer.render(scene, camera);
    },
    dispose() {
      stop?.();
      pmrem.dispose();
      scene.environment?.dispose();
      scene.traverse((o) => { if (o.isLight) o.dispose(); });
      model.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat().filter(Boolean)) {
          for (const k in m) if (m[k]?.isTexture) m[k].dispose();
          m.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
  return you;
}
