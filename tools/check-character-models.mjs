// CPU-only: decode both shipped bodies with the game's loader, pose their rigs,
// fit the shared hat and her barrel, and exercise lazy body switching without compiling GPU pipelines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildGarb } from '../src/pov/garb.js';
import { createBarrelFit, innerRadius, outerRadius } from '../src/pov/barrel.js';

// His beard (beard.js) under a fast turn: every joint of its chain stays out of his torso (the
// skin's bind-pose vertices, carried by spine_03), the tip lags (it swings), settles back to its rest
// drape, and the swing is the same at 30 and 144 fps. Returns the tip's offset in Head's frame after the turn.
const BEARD_TURN = 2.4, BEARD_TURN_TIME = 0.25, BEARD_SAMPLE = 0.4;   // rad, s, s
function beardTurn(body, state, dt, { census = null } = {}) {
  const rig = body.real.beard;
  const yaw0 = state.yaw;
  const sm = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
  for (let i = 0; i < Math.round(1.5 / dt); i++) body.update(dt, state);   // settle at rest
  let lag = 0;
  const steps = Math.round(BEARD_SAMPLE / dt);
  for (let i = 1; i <= steps; i++) {
    body.update(dt, { ...state, yaw: yaw0 + BEARD_TURN * sm((i * dt) / BEARD_TURN_TIME) });
    lag = Math.max(lag, rig.joints.at(-1).distanceTo(rig.rest.at(-1)));
    census?.(rig);
  }
  const head = body.model.getObjectByName('Head');
  head.updateWorldMatrix(true, false);
  const metre = rig.unit;   // world units per model metre
  const offset = rig.joints.at(-1).clone().sub(rig.rest.at(-1)).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()).invert()).divideScalar(metre);
  return { lag: lag / metre, offset };
}
function checkBeard(body, state, torso) {
  const rig = body.real.beard;
  assert.ok(rig, 'the wizard has a beard rig');
  const s03 = body.model.getObjectByName('spine_03');
  const { bones, boneInverses } = body.model.getObjectByName('SuperHero_Male').skeleton;
  const inv03 = boneInverses[bones.indexOf(s03)];
  const toBind = new THREE.Matrix4(), p = new THREE.Vector3();
  let worst = -Infinity;
  const census = (r) => {
    toBind.multiplyMatrices(s03.matrixWorld, inv03).invert();
    for (const j of r.joints.slice(1)) {
      p.copy(j).applyMatrix4(toBind);
      // the skin in front of and behind this point, at its height and across
      let front = -Infinity, back = Infinity;
      for (const v of torso) {
        if (Math.abs(v.y - p.y) > 0.02 || Math.abs(v.x - p.x) > 0.025) continue;
        front = Math.max(front, v.z); back = Math.min(back, v.z);
      }
      if (p.z > back && p.z < front) worst = Math.max(worst, front - p.z);
    }
  };
  const start = beardTurn(body, state, 1 / 60, { census });
  assert.ok(worst <= 0.005, `the beard stays out of his chest through a turn (${(worst * 100).toFixed(1)} cm in)`);
  assert.ok(start.lag > 0.04, `the beard swings behind a turn (${(start.lag * 100).toFixed(1)} cm)`);
  for (let i = 0; i < 150; i++) body.update(1 / 60, { ...state, yaw: state.yaw + BEARD_TURN });
  const settled = rig.joints.at(-1).distanceTo(rig.rest.at(-1)) / rig.unit;
  assert.ok(settled < 0.015, `the beard settles back after a turn (${(settled * 100).toFixed(1)} cm off its rest)`);
  const slow = beardTurn(body, state, 1 / 30).offset, fast = beardTurn(body, state, 1 / 144).offset;
  assert.ok(slow.distanceTo(fast) < 0.01, `the swing is the same at 30 and 144 fps (${(slow.distanceTo(fast) * 100).toFixed(1)} cm apart)`);
  for (const j of rig.joints) assert.ok(j.toArray().every(Number.isFinite));
  console.log(`PASS beard: swings ${(start.lag * 100).toFixed(1)} cm behind a ${BEARD_TURN} rad turn, deepest chest contact ${(Math.max(worst, 0) * 100).toFixed(1)} cm, `
    + `settles to ${(settled * 100).toFixed(1)} cm, 30 vs 144 fps ${(slow.distanceTo(fast) * 100).toFixed(1)} cm apart`);
}

// Her barrel: which wood each skinned body vertex is in after the fit (barrel.js), in the
// barrel's own frame (spine_01's rest). Arms must be out of the wood and out of the barrel, legs and
// torso out of the wood. Returns { arm, armInside, leg, legDeep, torso } (counts, legDeep in m).
const KIND = (name) => /^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)_/.test(name) ? 'arm'
  : /^(thigh|calf|foot|ball)/.test(name) ? 'leg' : /^(Head|neck)/.test(name) ? 'head' : 'torso';
function barrelCensus(body, s) {
  const { bones, boneInverses } = body.skeleton;
  const spine = bones.find(b => b.name === 'spine_01');
  body.parent.updateMatrixWorld(true);
  body.skeleton.update();
  const toBarrel = new THREE.Matrix4().multiplyMatrices(spine.matrixWorld, boneInverses[bones.indexOf(spine)])
    .multiply(body.bindMatrix).invert();
  const si = body.geometry.attributes.skinIndex, sw = body.geometry.attributes.skinWeight;
  const v = new THREE.Vector3();
  const out = { arm: 0, armInside: 0, leg: 0, legDeep: 0, torso: 0 };
  for (let i = 0; i < si.count; i++) {
    const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
    const kind = KIND(bones[[si.getX(i), si.getY(i), si.getZ(i), si.getW(i)][w.indexOf(Math.max(...w))]].name);
    if (kind === 'head') continue;
    body.getVertexPosition(i, v).applyMatrix4(body.matrixWorld).applyMatrix4(toBarrel);
    if (v.y < s.hem || v.y > s.top) continue;
    const r = Math.hypot(v.x, v.z - s.zc), rIn = innerRadius(s, v.y), rOut = outerRadius(s, v.y);
    const wood = r >= rIn && r <= rOut;
    if (kind === 'arm') { if (wood) out.arm++; else if (r < rIn) out.armInside++; }
    else if (kind === 'leg' && wood) { out.leg++; out.legDeep = Math.max(out.legDeep, Math.min(r - rIn, rOut - r)); }
    else if (kind === 'torso' && wood) out.torso++;
  }
  return out;
}

// Her figure in its barrel (figureReal.js + barrel.js): she kneels in it, a grip inside it is
// refused (that arm stays over the rim), one over the rim is reached clear of the wood, and a held
// tool's grip at her hip is lifted over the rim while one held out ahead is not.
function checkBarrelFigure(body, state) {
  const fit = body.real.barrel;
  assert.ok(fit, 'her figure wears the barrel fit');
  const at = (n) => body.model.getObjectByName(n).getWorldPosition(new THREE.Vector3());
  for (let i = 0; i < 90; i++) body.update(1 / 60, { ...state, crouch: 1 });
  body.model.updateMatrixWorld(true);
  assert.ok(Math.max(at('calf_l').y, at('calf_r').y) < 0.25, 'crouched, she kneels: knees on the floor');
  assert.ok(Math.min(...['foot_l', 'foot_r', 'ball_l', 'ball_r'].map((n) => at(n).y)) > -0.1, 'her feet stay on the floor');
  assert.ok(fit.legRoom(0) >= 0 && fit.legRoom(1) >= 0, 'kneeling fits inside the barrel');
  assert.ok(fit.armGap('l') >= 0 && fit.armGap('r') >= 0, 'kneeling, her arms lie over the rim');
  for (let i = 0; i < 60; i++) body.update(1 / 60, state);
  const q = body.real.root.getWorldQuaternion(new THREE.Quaternion());
  const grip = (pos) => ({ pos, fingers: new THREE.Vector3(0, -0.35, -1).applyQuaternion(q), palm: new THREE.Vector3(-1, 0, 0).applyQuaternion(q) });
  body.reach({ right: grip(at('spine_02')) });
  assert.ok(fit.armGap('r') >= 0, 'a grip inside the barrel is refused: the arm stays over the rim');
  body.update(1 / 60, state);
  const ahead = body.anchor(new THREE.Vector3()).add(new THREE.Vector3(0.4, -0.5, -1.45).applyQuaternion(q));   // holds.js pistol
  body.reach({ right: grip(ahead) });
  body.model.updateMatrixWorld(true);
  assert.ok(at('hand_r').distanceTo(ahead) < 0.6, 'a grip over the rim is reached');
  assert.ok(fit.armGap('r') >= -1e-3, 'reaching it, the arm stays out of the wood');
  body.update(1 / 60, state);
  const hip = new THREE.Matrix4().makeTranslation(at('pelvis').add(new THREE.Vector3(0.3, 0, -0.7).applyQuaternion(q)));
  assert.ok(body.liftGrips(hip, [new THREE.Vector3()]) > 0, 'a grip at her hip comes up over the rim');
  const out = new THREE.Matrix4().makeTranslation(at('pelvis').add(new THREE.Vector3(0.3, 0, -3).applyQuaternion(q)));
  assert.equal(body.liftGrips(out, [new THREE.Vector3()]), 0, 'a grip held well out ahead stays put');
}

// Image decoding needs a browser; texture references and bytes are checked below.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register(parser => {
  parser.loadTextureImage = () => Promise.resolve(new THREE.Texture());
  return { name: 'cpu-textures' };
});
const models = new Map();
let torso = null;   // his torso's skin in the bind pose, for the beard's census
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
    assert.equal(bagged.beard, undefined, 'the paper-bag guy has no beard');
    const { beard } = garb;
    assert.ok(beard?.userData.beard, 'the wizard wears a beard');
    const chain = beard.userData.beard.joints.length;   // its skeleton: Head, then one bone per joint but the tip
    const { skinIndex, skinWeight, position } = beard.attributes;
    for (let i = 0; i < skinIndex.count; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        assert.ok(skinIndex.getComponent(i, k) < chain, 'beard skin indices are its own skeleton\'s');
        sum += skinWeight.getComponent(i, k);
      }
      assert.ok(Math.abs(sum - 1) < 1e-5, 'beard skin weights sum to one');
    }
    for (const i of beard.index.array) assert.ok(i < position.count);
    beard.computeBoundingBox();
    const hips = new THREE.Vector3().setFromMatrixPosition(body.skeleton.boneInverses[body.skeleton.bones.findIndex(b => b.name === 'spine_02')].clone().invert());
    assert.ok(beard.boundingBox.min.y > hips.y + 0.1, 'the beard ends on his chest, above his abs');
    beard.dispose();
    const { bones } = body.skeleton, si = body.geometry.attributes.skinIndex, sw = body.geometry.attributes.skinWeight;
    torso = [];
    for (let i = 0; i < si.count; i++) {
      const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
      const main = bones[si.getComponent(i, w.indexOf(Math.max(...w)))].name;
      if (/^(spine_0[123]|clavicle_[lr]|neck_01)$/.test(main)) torso.push(new THREE.Vector3().fromBufferAttribute(body.geometry.attributes.position, i).applyMatrix4(body.bindMatrix));
    }
    bagged.bag.dispose();
    bagged.marker.dispose();
  }
  if (file === 'woman') {
    assert.ok(garb.robe && garb.hoops && garb.bung, 'woman stands in a barrel');
    const shape = garb.robe.userData.barrel;
    assert.ok(shape && shape.top - shape.hem > 0.4, 'barrel covers her from mid-thigh to under the arms');
    assert.ok(garb.hoops.index.count > 0);
    for (const i of garb.hoops.index.array) assert.ok(i < garb.hoops.attributes.position.count);
    const barrelBone = body.skeleton.bones.findIndex(b => b.name === 'spine_01');
    for (const geo of [garb.robe, garb.hoops, garb.bung]) {
      const { skinIndex, skinWeight } = geo.attributes;
      for (let i = 0; i < skinIndex.count; i++) {
        assert.equal(skinIndex.getX(i), barrelBone, 'wood, iron and cork share one rigid attachment');
        assert.equal(skinWeight.getX(i), 1);
        assert.equal(skinWeight.getY(i) + skinWeight.getZ(i) + skinWeight.getW(i), 0);
      }
    }
    garb.robe.computeBoundingBox();
    const { position, normal } = garb.robe.attributes;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i); b.fromBufferAttribute(position, i + 1); c.fromBufferAttribute(position, i + 2);
      face.subVectors(b, a).cross(c.sub(a)).normalize();
      assert.ok(face.dot(b.fromBufferAttribute(normal, i)) > 0.999, 'plank face normals match their triangles');
      if (Math.abs(face.y) > 0.999) {
        assert.equal(Math.sign(face.y), Math.abs(a.y - garb.robe.boundingBox.min.y) < 1e-6 ? -1 : 1,
          'plank bottom faces down and top faces up');
      }
    }
    // Closed all the way round: a ray out from the axis at any height and bearing meets a stave.
    const staves = new THREE.Mesh(garb.robe, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const ray = new THREE.Raycaster();
    for (let h = 1; h < 8; h++) {
      const y = shape.hem + (shape.top - shape.hem) * (h / 8);
      for (let k = 0; k < 360; k++) {
        const ang = (k + 0.5) * Math.PI / 180;
        ray.set(new THREE.Vector3(0, y, shape.zc), new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)));
        assert.ok(ray.intersectObject(staves).length > 0, `no hole in the staves at ${k + 0.5}° and ${y.toFixed(2)} m`);
      }
    }
    // Every clip, with the fit: her arms over the rim, out of the wood, legs and torso inside it.
    const fit = createBarrelFit(shape, gltf.scene, body);
    const fitMixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) {
      fitMixer.stopAllAction();
      fitMixer.clipAction(clip).play();
      for (let k = 0; k < 16; k++) {
        fit.restore();
        fitMixer.setTime(clip.duration * k / 16);
        gltf.scene.updateMatrixWorld(true);
        fit.drape();
        fit.keepLegs();
        const n = barrelCensus(body, shape);
        const at = `${clip.name} at ${(k / 16).toFixed(2)}`;
        // the death clip folds her torso over the barrel's front for a moment; nothing else may touch the wood
        if (clip.name === 'death') assert.ok(n.arm <= 2, `${at}: ${n.arm} arm vertices in the wood`);
        else {
          assert.equal(n.arm, 0, `${at}: ${n.arm} arm vertices in the wood`);
          assert.equal(n.torso, 0, `${at}: ${n.torso} torso vertices in the wood`);
        }
        assert.ok(n.armInside <= 2, `${at}: ${n.armInside} arm vertices inside the barrel`);
        // a stride's thigh and calf may graze the inside of the hem by a skin's thickness, never through it
        assert.ok(n.leg <= 4 && n.legDeep < 0.015, `${at}: ${n.leg} leg vertices ${n.legDeep.toFixed(3)} m into the wood`);
      }
    }
    fit.restore();
    fitMixer.stopAllAction();
    assert.equal(garb.beard, undefined, 'she has no beard');
  } else assert.equal(garb.robe, undefined);
  // the hat: crown and brim, band and sewn-on trim, rigid on the head and clear of the skull
  const head = body.skeleton.bones.findIndex(b => b.name === 'Head');
  const hatParts = ['hat', 'hatBand', 'hatTrim'].map(name => garb[name]);
  assert.ok(hatParts.every(Boolean), `${file}: hat, band and trim`);
  for (const geo of hatParts) {
    geo.computeBoundingBox();
    assert.ok([...geo.boundingBox.min.toArray(), ...geo.boundingBox.max.toArray()].every(Number.isFinite));
    assert.ok(geo.userData.albedo?.length === 3, `${file}: each hat part carries its colour`);
    for (let i = 0; i < geo.attributes.position.count; i++) {
      assert.equal(geo.attributes.skinIndex.getX(i), head);
      assert.equal(geo.attributes.skinWeight.getX(i), 1);
    }
  }
  // A ray from the middle of the head out through any head vertex meets the hat beyond it, if at all.
  const headVerts = [];
  const { position: bp, skinIndex: bsi, skinWeight: bsw } = body.geometry.attributes;
  for (let i = 0; i < bp.count; i++) {
    const w = [bsw.getX(i), bsw.getY(i), bsw.getZ(i), bsw.getW(i)];
    if ([bsi.getX(i), bsi.getY(i), bsi.getZ(i), bsi.getW(i)][w.indexOf(Math.max(...w))] !== head) continue;
    headVerts.push(new THREE.Vector3().fromBufferAttribute(bp, i).applyMatrix4(body.bindMatrix));
  }
  const headMiddle = new THREE.Box3().setFromPoints(headVerts).getCenter(new THREE.Vector3());
  const felt = new THREE.Mesh(hat, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const ray = new THREE.Raycaster();
  let through = 0;
  for (const v of headVerts) {
    const d = v.clone().sub(headMiddle), len = d.length();
    ray.set(headMiddle, d.normalize());
    const hit = ray.intersectObject(felt)[0];
    if (hit && hit.distance < len) through++;
  }
  assert.equal(through, 0, `${file}: ${through} head vertices poke through the hat`);
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
  console.log(`PASS ${file}: textures, rig, eight animations and head-skinned hat${file === 'woman' ? ', a closed barrel and every clip out of its wood' : ''}`);
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
        assert.ok(body.real.beard?.joints.every(j => j.toArray().every(Number.isFinite)) ?? key === 'woman', `${key}: beard`);
      }
      const hand = body.model.getObjectByName('hand_r');
      body.reach({ right: { pos: hand.getWorldPosition(new THREE.Vector3()),
        fingers: new THREE.Vector3(0, 0, -1), palm: new THREE.Vector3(0, -1, 0) } });
      body.model.updateMatrixWorld(true);
      assert.ok(hand.matrixWorld.elements.every(Number.isFinite));
      if (key === 'woman') checkBarrelFigure(body, state);
      else checkBeard(body, state, torso);
    }
  } finally { body.dispose(); }
} finally {
  GLTFLoader.prototype.loadAsync = loadAsync;
  hooks.deregister();
}
console.log('PASS real figures: live model switching, gait/crouch/swim/death/respawn, look and hand IK, her kneel and reach over the rim');

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
