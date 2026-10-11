// "This is you." live: the loading screen's player (ui/menu.js), the realistic
// body (figureReal.js's model, public/models/character/body.glb) in his wizard
// hat (garb.js) and purple boxers, breathing in his idle clip on a small
// renderer of its own. Skyrim's loading screen: the model turns slowly by
// itself, and a click and drag turns it left or right. tools/you-portrait.mjs
// renders one frame of the same scene into public/you.webp, the still shown
// until this one is up.
//
// It lights him like a character-select portrait (TF2's class select, Halo 3's
// player model in the lobby): a warm key from the front, a cool rim from behind
// to cut him out of a dark screen, and a soft room for the skin's sheen.
//   createYou({ width, height, pixelRatio, yaw, time }) → { canvas, yaw, frame(dt), dispose() }
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BODY_MODEL_URL } from '../pov/bodyModel.js';
import { buildGarb, GARB_COLORS } from '../pov/garb.js';

const FOV = 20;                       // degrees: a long lens, little distortion (pov/classPortraits.js uses 24)
const FRAME_MARGIN = 1.03;            // room round his box
const LOW_ANGLE = 0.06;               // rad the camera looks up at him: a little heroic
const EYEBROWS = [0.06, 0.035, 0.02]; // figureReal.js TINT_BY_MATERIAL.MI_Hair_1: dark brown over the greyscale mask
const ROOM = 0.4;                     // the room's light on him
const KEY = 2.6;                      // key light, warm, from up front left
const KEY_COLOR = 0xffe2c4;
const KEY_DIR = [-2, 3, 3.2];
const RIM = 6;                        // rim light, cool, from behind right: the menu's blue (menu.css --mm-blue-hi)
const RIM_COLOR = 0x5aa4ee;
const RIM_DIR = [2.4, 1.8, -3];
const FILL = 1.6;                     // a purple fill from behind left: the hat's colour
const FILL_COLOR = 0x9a63db;
const FILL_DIR = [-2.6, 0.6, -2];
const EXPOSURE = 1.05;
const MAX_DT = 0.1;                   // s: a frame after the page froze (the map build, the shaders) steps no further

export async function createYou({ width, height, pixelRatio = 1, yaw = 0, time = 0, preserveDrawingBuffer = false }) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(BODY_MODEL_URL);
  const model = gltf.scene;
  const meshes = [];
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.frustumCulled = false;
    if (o.material.name === 'MI_Hair_1') o.material.color.setRGB(...EYEBROWS);
    meshes.push(o);
  });
  // the hat, skinned to his head bone as in the game
  const body = meshes.reduce((a, b) => (b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a));
  const { hat } = buildGarb(meshes);
  const hatMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...GARB_COLORS.hat), roughness: 0.85, side: THREE.DoubleSide });
  const hatMesh = new THREE.SkinnedMesh(hat, hatMat);
  hatMesh.frustumCulled = false;
  hatMesh.bind(body.skeleton, body.bindMatrix);
  body.parent.add(hatMesh);
  meshes.push(hatMesh);

  // his idle clip: the breathing
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(gltf.animations.find((c) => c.name === 'idle')).play();
  mixer.setTime(time);
  const holder = new THREE.Group();   // turned about his feet; the glTF faces +z, the camera
  holder.add(model);
  const scene = new THREE.Scene();
  scene.add(holder);
  scene.updateMatrixWorld(true);

  // his posed box, from the skinned vertices, made round about the turning axis: framed once, he
  // fits the frame at every yaw
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    m.skeleton.update();
    const n = m.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) box.expandByPoint(m.localToWorld(m.getVertexPosition(i, v)));
  }
  const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
  const centre = new THREE.Vector3(0, (box.min.y + box.max.y) / 2, 0);
  const tall = box.max.y - box.min.y;

  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 100);
  const half = THREE.MathUtils.degToRad(FOV / 2);
  const fitH = (tall / 2) / Math.tan(half);
  const fitW = reach / (Math.tan(half) * camera.aspect);
  const dist = Math.max(fitH, fitW) * FRAME_MARGIN + reach;
  camera.position.set(0, centre.y - Math.sin(LOW_ANGLE) * dist, Math.cos(LOW_ANGLE) * dist);
  camera.lookAt(centre);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer });
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
    scene.add(light, light.target);
  }

  const you = {
    canvas: renderer.domElement,
    yaw,
    // advance his breathing dt seconds and draw him at you.yaw
    frame(dt = 0) {
      mixer.update(Math.min(dt, MAX_DT));
      holder.rotation.y = you.yaw;
      renderer.render(scene, camera);
    },
    dispose() {
      mixer.stopAllAction();
      pmrem.dispose();
      scene.environment?.dispose();
      hatMat.dispose();
      hat.dispose();
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
