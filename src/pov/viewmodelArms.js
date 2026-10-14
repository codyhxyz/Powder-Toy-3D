import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BODY_HEIGHT } from './constants.js';
import { loadModel as loadBodyModel } from './figureReal.js';
import { handFrame, handTurn, setWorldQuaternion } from './limbs.js';
import { MODELS } from './models.js';
import { HELD } from './holds.js';

// TF2-style separate view arms, but cut from the same muscular character as the
// world body. Bake the closed grip once: tools already animate their whole grip.
export function bakeViewArm(gltf, key = 'jackhammer') {
  const model = cloneSkinned(gltf.scene);
  model.updateMatrixWorld(true);
  const meshes = [];
  model.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  const body = meshes.reduce((a, b) => a.geometry.attributes.position.count > b.geometry.attributes.position.count ? a : b);
  const box = new THREE.Box3().setFromObject(model);
  const scale = BODY_HEIGHT / (box.max.y - box.min.y);
  const bone = name => model.getObjectByName(name);
  const hand = bone('hand_r');
  const frame = handFrame(hand, bone('middle_01_r'), bone('thumb_01_r'), 'right');
  const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
  const curlAxis = frame.fingers.clone().cross(frame.palm).applyQuaternion(handQ);
  for (const finger of ['index', 'middle', 'ring', 'pinky']) {
    for (const [i, curl] of [1.1, 1.2, 0.8].entries()) {
      const joint = bone(`${finger}_0${i + 1}_r`);
      const axis = curlAxis.clone().applyQuaternion(joint.getWorldQuaternion(new THREE.Quaternion()).invert());
      const bind = joint.quaternion.clone();
      joint.quaternion.setFromAxisAngle(axis, curl).premultiply(bind);
    }
  }
  model.updateMatrixWorld(true);
  // Grip centre and frame in the bind model: +z back to the elbow, +y thumb.
  const wrist = hand.getWorldPosition(new THREE.Vector3());
  const back = bone('lowerarm_r').getWorldPosition(new THREE.Vector3()).sub(wrist).normalize();
  const up = bone('thumb_01_r').getWorldPosition(new THREE.Vector3()).sub(wrist);
  up.addScaledVector(back, -up.dot(back)).normalize();
  const right = new THREE.Vector3().crossVectors(up, back).normalize();
  up.crossVectors(back, right);
  const basis = new THREE.Matrix4().makeBasis(right, up, back);
  const armQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...MODELS[key].arm).normalize());
  const inverseArm = armQ.clone().invert();
  // The wrist bends independently of the forearm: fingers wrap the handle in
  // the same frame the world body's hand IK uses, rather than pointing up it.
  const grip = HELD[key]?.right ?? HELD.jackhammer.right;
  handTurn(frame, new THREE.Vector3(...grip.fingers).applyQuaternion(inverseArm),
    new THREE.Vector3(...grip.palm).applyQuaternion(inverseArm), handQ);
  handQ.premultiply(new THREE.Quaternion().setFromRotationMatrix(basis));
  setWorldQuaternion(hand, handQ);
  model.updateMatrixWorld(true);
  body.skeleton.update();
  const origin = frame.fingers.clone().multiplyScalar(frame.reach * 0.5).addScaledVector(frame.palm, 0.035)
    .applyQuaternion(handQ).add(wrist);
  const toGrip = basis.setPosition(origin).invert();
  const armBones = new Set();
  bone('upperarm_r').traverse(o => { if (o.isBone) armBones.add(o); });
  const geo = body.geometry, indices = [], positions = [], uvs = [];
  const weights = geo.attributes.skinWeight, joints = geo.attributes.skinIndex;
  const armVertex = i => {
    let weight = 0;
    for (let j = 0; j < 4; j++) if (armBones.has(body.skeleton.bones[joints.getComponent(i, j)])) weight += weights.getComponent(i, j);
    return weight >= 0.5;
  };
  const remap = new Map(), p = new THREE.Vector3();
  for (let i = 0; i < geo.index.count; i += 3) {
    const tri = [0, 1, 2].map(j => geo.index.getX(i + j));
    if (!tri.every(armVertex)) continue;
    for (const v of tri) {
      if (!remap.has(v)) {
        remap.set(v, remap.size);
        body.getVertexPosition(v, p).applyMatrix4(body.matrixWorld).applyMatrix4(toGrip).multiplyScalar(scale);
        positions.push(...p);
        uvs.push(geo.attributes.uv.getX(v), geo.attributes.uv.getY(v));
      }
      indices.push(remap.get(v));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return { geometry, material: body.material };
}

const baked = new Map();
const states = new WeakMap();
function armFor(choice, key) {
  const id = `${choice}:${key}`;
  if (!baked.has(id)) baked.set(id, loadBodyModel(choice).then(gltf => bakeViewArm(gltf, key)));
  return baked.get(id);
}

// Leave tool geometry, grip position, recoil and third-person models untouched.
// Every added mesh owns its geometry; attachModel's existing dispose frees it.
export function updateViewmodelArms(root, character) {
  const choice = character === 'real' || character === 'woman' ? character : 'stick';
  for (const hand of root.children) {
    if (!hand.visible) continue;
    hand.traverse(obj => {
      const key = obj.name.startsWith('viewmodel-') ? obj.name.slice('viewmodel-'.length) : null;
      if (!MODELS[key]) return;
      const arm = obj.children.find(o => o.userData.arm);
      if (!arm) return;
      let state = states.get(arm);
      if (!state) {
        state = { choice: null, original: [...arm.children], variants: new Map(), pending: new Set() };
        states.set(arm, state);
      }
      if (state.choice === choice) return;
      state.choice = choice;
      const show = () => {
        const real = state.variants.get(choice);
        for (const o of state.original) o.visible = !real;
        for (const [key, o] of state.variants) o.visible = key === choice;
      };
      show();
      if (choice === 'stick' || state.variants.has(choice) || state.pending.has(choice)) return;
      state.pending.add(choice);
      armFor(choice, key).then(({ geometry, material }) => {
        if (!obj.parent || state.choice !== choice) return;
        const mesh = new THREE.Mesh(geometry.clone(), material);
        mesh.name = `view-arm-${choice}`;
        mesh.userData.arm = true;   // held.js must never copy this onto the world body
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...MODELS[key].arm).normalize());
        arm.add(mesh);
        state.variants.set(choice, mesh);
        show();
        globalThis.__app?.requestRender?.();
      }).catch(err => console.error('First-person arm failed to load; using the simple arm', err))
        .finally(() => state.pending.delete(choice));
    });
  }
}
