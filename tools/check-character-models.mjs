// CPU-only: decode both shipped bodies with the game's loader, pose their rigs,
// fit the shared hat, and exercise lazy body switching without compiling GPU pipelines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildGarb } from '../src/pov/garb.js';

const ARM_BONES = new Set(['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r']);
// Idle and a walking swing: no arm vertex sits in the stave wood.
function armsClearBarrel(gltf, body, geos) {
  const worn = geos.map((geo) => {
    const mesh = new THREE.SkinnedMesh(geo, body.material);
    mesh.bind(body.skeleton, body.bindMatrix);
    body.parent.add(mesh);
    return mesh;
  });
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const si = body.geometry.attributes.skinIndex, sw = body.geometry.attributes.skinWeight;
  const bones = body.skeleton.bones;
  const v = new THREE.Vector3();
  const points = (mesh, pred) => {
    mesh.skeleton.update();
    const out = [], n = mesh.geometry.attributes.position.count;
    for (let i = 0; i < n; i += pred ? 2 : 1) {
      if (pred && !pred(i)) continue;
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      out.push(v.clone());
    }
    return out;
  };
  const armAt = (i) => {
    const idx = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)];
    const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
    return ARM_BONES.has(bones[idx[w.indexOf(Math.max(...w))]].name);
  };
  let clear = true;
  for (const [name, times] of [['idle', [0.6]], ['walk', [0.15, 0.4, 0.7]]]) {
    const action = mixer.clipAction(gltf.animations.find((c) => c.name === name));
    action.play();
    for (const t of times) {
      mixer.setTime(t);
      gltf.scene.updateMatrixWorld(true);
      const arms = points(body, armAt);
      const wood = worn.flatMap((mesh) => points(mesh));
      for (const a of arms) {
        for (const w of wood) {
          if (Math.abs(a.y - w.y) > 0.03) continue;
          if (a.distanceTo(w) < 0.01) { clear = false; break; }
        }
        if (!clear) break;
      }
    }
    mixer.stopAllAction();
  }
  for (const mesh of worn) mesh.removeFromParent();
  return clear;
}

// Image decoding needs a browser; texture references and bytes are checked below.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register(parser => {
  parser.loadTextureImage = () => Promise.resolve(new THREE.Texture());
  return { name: 'cpu-textures' };
});
const models = new Map();
for (const file of ['body', 'woman']) {
  const bytes = readFileSync(new URL(`../public/models/character/${file}.glb`, import.meta.url));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const json = gltf.parser.json;
  assert.ok(json.extensionsRequired.includes('EXT_meshopt_compression'));
  assert.ok(json.extensionsRequired.includes('EXT_texture_webp'));
  for (const image of json.images) {
    const view = json.bufferViews[image.bufferView];
    assert.equal(image.mimeType, 'image/webp');
    assert.equal(bytes.toString('ascii', 28 + bytes.readUInt32LE(12) + (view.byteOffset ?? 0),
      32 + bytes.readUInt32LE(12) + (view.byteOffset ?? 0)), 'RIFF');
  }
  const meshes = [];
  gltf.scene.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  assert.equal(meshes.length, 3);
  const body = meshes.find(m => m.material.name === `MI_Superhero_${file === 'woman' ? 'Female' : 'Male'}`);
  assert.ok(body?.material.map && body.material.normalMap);
  for (const name of ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head',
    ...['l', 'r'].flatMap(side => ['upperarm', 'lowerarm', 'hand', 'middle_01', 'thumb_01', 'thigh', 'calf', 'foot', 'ball',
      ...['index', 'middle', 'ring', 'pinky'].flatMap(f => [1, 2, 3].map(j => `${f}_0${j}`))].map(b => `${b}_${side}`))]) {
    assert.ok(gltf.scene.getObjectByName(name)?.isBone, `${file}: ${name}`);
  }
  const garb = buildGarb(meshes);
  const { hat } = garb;
  if (file === 'body') {
    const bagged = buildGarb(meshes, { bag: true });
    assert.ok(bagged.bag && bagged.marker && !bagged.hat, 'paper bag replaces the wizard hat');
    bagged.bag.dispose();
    bagged.marker.dispose();
  }
  if (file === 'woman') {
    assert.ok(garb.robe && garb.hoops && garb.bung, 'woman stands in a barrel');
    garb.robe.computeBoundingBox();
    assert.ok(garb.robe.boundingBox.max.y - garb.robe.boundingBox.min.y > 0.4, 'barrel covers the torso');
    assert.ok(armsClearBarrel(gltf, body, [garb.robe, garb.hoops]), 'hanging arms stay outside the staves');
  } else assert.equal(garb.robe, undefined);
  hat.computeBoundingBox();
  assert.ok(hat.boundingBox.min.toArray().every(Number.isFinite));
  assert.ok(hat.boundingBox.max.toArray().every(Number.isFinite));
  const head = body.skeleton.bones.findIndex(b => b.name === 'Head');
  for (let i = 0; i < hat.attributes.position.count; i++) {
    assert.equal(hat.attributes.skinIndex.getX(i), head);
    assert.equal(hat.attributes.skinWeight.getX(i), 1);
  }
  const mixer = new THREE.AnimationMixer(gltf.scene);
  for (const name of ['idle', 'walk', 'jog', 'sprint', 'fall', 'swim', 'tread', 'death']) {
    const clip = gltf.animations.find(c => c.name === name);
    assert.ok(clip?.duration > 0, `${file}: ${name}`);
    if (['walk', 'jog', 'sprint'].includes(name)) {
      assert.ok(json.animations.find(c => c.name === name).extras.speed > 0);
    }
    mixer.stopAllAction();
    mixer.clipAction(clip).play();
    for (const phase of [0, 0.25, 0.5, 0.9]) {
      mixer.setTime(clip.duration * phase);
      gltf.scene.updateMatrixWorld(true);
      body.skeleton.update();
      assert.ok([...body.skeleton.boneMatrices].every(Number.isFinite), `${file}: ${name} pose`);
    }
  }
  mixer.stopAllAction();
  models.set(file === 'body' ? 'real' : 'woman', gltf);
  hat.dispose();
  console.log(`PASS ${file}: textures, rig, eight animations and head-skinned hat`);
}

// Real figure materials, animation blending, crouch/look overlays and hand IK.
// Only the asset download and Vite URL constant are replaced; no GPU is created.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/figureReal.js') && specifier === './bodyModel.js') {
    return { shortCircuit: true, url: 'data:text/javascript,export const BODY_MODEL_URLS = {real:"real",woman:"woman"};' };
  }
  return next(specifier, context);
} });
const loadAsync = GLTFLoader.prototype.loadAsync;
GLTFLoader.prototype.loadAsync = async key => models.get(key);
try {
  const { createBody } = await import('../src/pov/figureReal.js');
  let choice = 'woman';
  const body = createBody({ choice: () => choice });
  const state = { feet: new THREE.Vector3(), scale: 1, worldToGrid: new THREE.Matrix4(),
    yaw: 0.4, onGround: true, speedH: 0, look: { pitch: 0.2, spine: 0.4 } };
  try {
    body.bind({}, {});
    await new Promise(resolve => setImmediate(resolve));
    for (const key of ['woman', 'real', 'woman']) {
      choice = key;
      body.update(1 / 60, state);
      await new Promise(resolve => setImmediate(resolve));
      for (const pose of [{}, { speedH: 5 }, { speedH: 15, sprintRush: 1 }, { crouch: 1 },
        { onGround: false }, { inLiquid: true, headInLiquid: true, speedH: 3 }, { dead: true }, {}]) {
        for (let i = 0; i < 60; i++) body.update(1 / 60, { ...state, ...pose });
        assert.equal(body.showing, key);
        body.model.updateMatrixWorld(true);
        body.model.traverse(o => assert.ok(o.matrixWorld.elements.every(Number.isFinite), `${key}: ${o.name}`));
        const weights = body.real.weights;
        assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
        assert.ok(body.anchor(new THREE.Vector3()).toArray().every(Number.isFinite));
      }
      const hand = body.model.getObjectByName('hand_r');
      body.reach({ right: { pos: hand.getWorldPosition(new THREE.Vector3()),
        fingers: new THREE.Vector3(0, 0, -1), palm: new THREE.Vector3(0, -1, 0) } });
      body.model.updateMatrixWorld(true);
      assert.ok(hand.matrixWorld.elements.every(Number.isFinite));
    }
  } finally { body.dispose(); }
} finally {
  GLTFLoader.prototype.loadAsync = loadAsync;
  hooks.deregister();
}
console.log('PASS real figures: live model switching, gait/crouch/swim/death/respawn, look and hand IK');

// Exercise the actual shell with CPU figures and controlled asynchronous loads.
const source = readFileSync(new URL('../src/pov/figureReal.js', import.meta.url), 'utf8');
const fixture = ({ fail = null, gate = Promise.resolve() } = {}) => {
  let selected = 'woman';
  const loads = [], made = [], errors = [];
  const fig = key => {
    const f = { key, root: new THREE.Group(), disposed: false, visible: false,
      bind() {}, compile: () => gate, update() {}, setVisible(v) { f.visible = v; },
      dispose() { f.disposed = true; } };
    made.push(f);
    return f;
  };
  const context = { THREE, BODY_MODEL_URLS: { real: '/body.glb', woman: '/woman.glb' }, buildSpartan() {},
    createFigure: build => fig(build ? 'spartan' : 'stick'), createRealFigure: fig,
    loadModel: async key => { loads.push(key); if (key === fail) throw Error('test'); return key; },
    console: { error: (...e) => errors.push(e) }, JET_NOZZLES: [] };
  const createBody = runInNewContext(`(${source.slice(source.indexOf('export function createBody')).replace('export ', '')})`, context);
  const body = createBody({ choice: () => selected });
  body.bind({}, {});
  const update = () => body.update(1 / 60, {});
  return { body, loads, made, errors, update, select(key) { selected = key; update(); } };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
{
  const f = fixture();
  assert.equal(f.body.showing, 'stick', 'fallback during initial load');
  await flush(); f.update();
  assert.equal(f.body.showing, 'woman');
  f.select('real');
  assert.equal(f.body.showing, 'stick', 'fallback while another model loads');
  f.select('stick');
  await flush(); f.update();
  assert.equal(f.body.showing, 'stick', 'late load does not replace the selected body');
  f.select('woman');
  assert.equal(f.body.showing, 'woman');
  f.select('real');
  assert.equal(f.body.showing, 'real');
  f.select('spartan');
  assert.equal(f.body.showing, 'spartan');
  f.select('woman');
  assert.deepEqual(f.loads, ['woman', 'real'], 'each model loads once');
  assert.equal(f.made.filter(x => x.visible).length, 1);
  f.body.dispose();
  assert.ok(f.made.every(x => x.disposed));
}
{
  const f = fixture({ fail: 'woman' });
  await flush(); f.update();
  assert.equal(f.body.showing, 'stick');
  assert.equal(f.errors.length, 1);
  f.select('real'); await flush(); f.update();
  assert.equal(f.body.showing, 'real', 'failure is isolated to one model');
  f.select('woman');
  assert.equal(f.body.showing, 'stick');
  assert.deepEqual(f.loads, ['woman', 'real'], 'failed loads do not retry every frame');
  f.body.dispose();
}
{
  let release;
  const f = fixture({ gate: new Promise(resolve => { release = resolve; }) });
  await flush();
  f.body.dispose();
  release(); await flush();
  assert.ok(f.made.every(x => x.disposed), 'a body finishing compile after disposal is released');
  assert.equal(f.body.root.children.length, 2, 'disposed shell does not attach a late model');
}
console.log('PASS lazy switching, isolated failure, visibility, reuse and disposal during compile');
