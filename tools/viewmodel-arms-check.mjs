// CPU-only: real GLBs, muscular arm geometry, live character changes and cleanup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { attachModel, MODELS } from '../src/pov/models.js';
import { viewmodelRig } from '../src/pov/viewmodel.js';
import { bakeViewArm } from '../src/pov/viewmodelArms.js';
import { createCombat } from '../src/pov/combat.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
loader.register(parser => ({
  name: 'cpu-textures',
  beforeRoot() { parser.loadTextureImage = async () => new THREE.Texture(); },
}));
const assets = {};
for (const [choice, file] of [['real', 'body'], ['woman', 'woman']]) {
  const bytes = await readFile(new URL(`../public/models/character/${file}.glb`, import.meta.url));
  const gltf = assets[choice] = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const sourcePose = [];
  gltf.scene.traverse(o => { if (o.isBone) sourcePose.push(...o.quaternion); });
  const baked = bakeViewArm(gltf);
  const geo = baked.geometry, size = geo.boundingBox.getSize(new THREE.Vector3());
  assert.ok(geo.attributes.position.count > 500, `${choice}: sculpted mesh, not a box`);
  assert.ok(size.x > (choice === 'real' ? 0.4 : 0.3) && size.x < 1, `${choice}: body-sized muscles`);
  assert.ok(size.z > 1.5 && size.z < 3, `${choice}: hand, forearm and upper arm, not the whole body`);
  assert.ok(geo.boundingBox.min.z > -0.7 && geo.boundingBox.max.z > 1.3, 'grip at the hand, arm extends back');
  assert.ok(baked.material.map && baked.material.normalMap, 'same skin and muscle normal map as the body');
  assert.ok([...geo.attributes.position.array, ...geo.attributes.normal.array].every(Number.isFinite));
  const after = [];
  gltf.scene.traverse(o => { if (o.isBone) after.push(...o.quaternion); });
  assert.deepEqual(after, sourcePose, 'baking must not curl the shared world body');
  console.log(`${choice}: ${geo.attributes.position.count} arm vertices; size ${size.toArray().map(n => n.toFixed(2))}`);
  geo.dispose();
}

// Keep real geometry/skeletons; control downloads to exercise asynchronous races.
const originalLoad = GLTFLoader.prototype.loadAsync;
let release, downloads = 0;
const download = new Promise(resolve => { release = resolve; });
GLTFLoader.prototype.loadAsync = async function(url) {
  downloads++;
  await download;
  return url.includes('woman') ? assets.woman : assets.real;
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let character = 'stick';
const vm = new THREE.Group(), env = { viewmodel: vm, getScale: () => 1, getCharacter: () => character };
const rig = viewmodelRig(env), hand = rig.hand([1, -0.15, -3.2]);
const model = attachModel(hand, 'jackhammer');
hand.visible = true;
const arm = model.obj.children.find(o => o.userData.arm);
const original = [...arm.children], tool = model.obj.children[0];
const toolTransform = tool.matrix.clone(), grip = model.info.grip.clone();
const ctx = { dt: 0, dir: new THREE.Vector3(0, 0, -1), player: {} };
const update = () => rig.update(ctx);
try {
  update();
  assert.ok(original.every(o => o.visible), 'simple arm stays until the male mesh arrives');
  character = 'real'; update();
  assert.ok(original.every(o => o.visible), 'simple arm remains while the asset loads');
  // Rapid switching must not attach duplicate meshes when a shared request resolves.
  character = 'stick'; update(); character = 'real'; update();
  const abandonedHand = rig.hand([0, 0, -2]), abandoned = attachModel(abandonedHand, 'gun');
  abandonedHand.visible = true; update(); abandoned.dispose(); rig.releaseHand(abandonedHand);
  release(); await flush();
  const real = arm.getObjectByName('view-arm-real');
  assert.ok(real?.visible, 'realistic character gets its actual muscular arm');
  assert.ok(original.every(o => !o.visible), 'no stick pokes through the realistic arm');
  assert.equal(arm.children.filter(o => o.name === 'view-arm-real').length, 1, 'one mesh despite the load race');
  assert.equal(abandoned.obj.children.find(o => o.userData.arm).children.length, 2, 'disposed tools receive no late arm');
  assert.equal(downloads, 1, 'all tools share the body download and bake');
  assert.ok(real.userData.arm, 'world-held extras exclude this arm');
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(real.quaternion);
  assert.ok(back.distanceTo(new THREE.Vector3(...MODELS.jackhammer.arm).normalize()) < 1e-6, 'forearm follows the existing grip direction');
  character = 'stick'; update();
  assert.ok(real.visible && original.every(o => !o.visible), 'paper bag uses the male arm');
  character = 'real'; update();
  assert.ok(real.visible && original.every(o => !o.visible), 'cached arm reappears live');
  character = 'woman'; update(); await flush();
  assert.ok(arm.getObjectByName('view-arm-woman')?.visible && !real.visible, 'female character uses her own mesh');
  assert.deepEqual(tool.matrix.elements, toolTransform.elements, 'tool geometry is not moved');
  assert.deepEqual(model.info.grip.toArray(), grip.toArray(), 'grip metadata stays unchanged');

  // Every first-person tool gets the same policy; world and icon models have no arms.
  character = 'real';
  for (const key of Object.keys(MODELS)) {
    const h = rig.hand([0, 0, -3]), m = attachModel(h, key);
    h.visible = true; update(); await flush();
    const skin = m.obj.getObjectByName('view-arm-real');
    assert.ok(skin, `${key}: realistic arm`);
    assert.notEqual(skin.geometry, real.geometry, 'tool owns its geometry for disposal');
    m.dispose(); rig.releaseHand(h);
    const world = attachModel(new THREE.Group(), key, null, { arm: false });
    assert.ok(!world.obj.children.some(o => o.userData.arm), `${key}: no arm on world model`);
    world.dispose();
  }
  let count = 0, freed = 0;
  model.obj.traverse(o => { if (o.geometry) { count++; o.geometry.addEventListener('dispose', () => freed++); } });
  model.dispose(); model.dispose();
  assert.equal(freed, count, 'original and realistic geometry disposed exactly once');
  // Grenade combat can create the shared rig before a toolbelt exists.
  const previousListener = globalThis.addEventListener;
  globalThis.addEventListener = () => {};
  let combat;
  const combatVm = new THREE.Group();
  try {
    combat = createCombat({
      scene: new THREE.Scene(), viewmodel: combatVm, getScale: () => 1, getCharacter: () => 'real',
      getSim: () => null, getVolume: () => new THREE.Object3D(), ballistics: () => null,
    });
    combat.frags.throw = () => true;   // exercise the throw arm, not GPU projectiles
    assert.equal(combat.throw({ grenades: 1 }, new THREE.Vector3(), new THREE.Vector3(0, 0, -1)), true);
    const earlyRig = viewmodelRig({ viewmodel: combatVm, getScale: () => 1, getCharacter: () => 'real' });
    const h = earlyRig.hand([0, 0, -3]), m = attachModel(h, 'jackhammer');
    h.visible = true; earlyRig.update(ctx); await flush();
    assert.ok(m.obj.getObjectByName('view-arm-real')?.visible, 'combat-first rig preserves character selection');
    m.dispose(); earlyRig.releaseHand(h);
  } finally {
    combat?.dispose(); combatVm.userData.rig?.dispose();
    if (previousListener) globalThis.addEventListener = previousListener;
    else delete globalThis.addEventListener;
  }
  console.log('PASS: all tool grips, live body selection, shared loading, late-load safety and disposal');
} finally {
  model.dispose(); rig.dispose();
  GLTFLoader.prototype.loadAsync = originalLoad;
}
