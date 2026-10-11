// The browser half of tools/you-portrait.mjs: the realistic body (figureReal.js's
// model, public/models/character/body.glb) in his wizard hat (garb.js) and purple
// boxers, standing in his idle clip, drawn once on a transparent background by a
// small renderer of its own. The start menu's loading screen shows him: "This is you."
//
// It lights him like a character-select portrait (TF2's class select, Halo 3's
// player model in the lobby): a warm key from the front, a cool rim from behind
// to cut him out of a dark screen, and a soft room for the skin's sheen.
//   render({ width, height, yaw, time }) → a PNG data URL
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BODY_MODEL_URL } from '../src/pov/bodyModel.js';
import { buildGarb, GARB_COLORS } from '../src/pov/garb.js';

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

export async function render({ width, height, yaw = 0.42, time = 0.6 }) {
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

  // his idle clip, a moment in
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(gltf.animations.find((c) => c.name === 'idle')).play();
  mixer.setTime(time);
  const holder = new THREE.Group();
  holder.rotation.y = yaw;   // the glTF faces +z, the camera: turned a little to screen left
  holder.add(model);
  const scene = new THREE.Scene();
  scene.add(holder);
  scene.updateMatrixWorld(true);

  // his posed box, from the skinned vertices
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    m.skeleton.update();
    const n = m.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) box.expandByPoint(m.localToWorld(m.getVertexPosition(i, v)));
  }
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());

  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 100);
  const half = THREE.MathUtils.degToRad(FOV / 2);
  const fitH = (size.y / 2) / Math.tan(half);
  const fitW = (Math.max(size.x, size.z) / 2) / (Math.tan(half) * camera.aspect);
  const dist = Math.max(fitH, fitW) * FRAME_MARGIN + size.z / 2;
  camera.position.set(centre.x, centre.y - Math.sin(LOW_ANGLE) * dist, centre.z + Math.cos(LOW_ANGLE) * dist);
  camera.lookAt(centre);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
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
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  pmrem.dispose();
  return url;
}
