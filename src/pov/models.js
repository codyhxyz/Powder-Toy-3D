import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The POV tools' held models: CC0 Kenney glTF files in public/models/tools/
// (see LICENSE.md there). Each file loads once and is cached; every user gets
// its own clone (sharing the geometry, materials and textures), normalised by
// MODELS below so a tool can place it in cells without knowing the file:
//
//   1. turned by `rotate` (radians, XYZ Euler) so the model points along −z
//      (forward, away from the eye) with +y up, the way the tools hold it;
//   2. scaled so its bounding box spans `size` cells along `fit`;
//   3. moved so the point at `anchor` (a share of the bounding box per axis,
//      0 = min, 1 = max) sits at the origin: where the hand holds it.
//
//   const m = attachModel(parent, 'gun', (obj, info) => { ... });   // async; shows nothing until loaded
//   m.dispose();                                                     // detach, and free the file when nobody uses it
//
// info.size is the normalised bounding box size (cells), for tools that put
// their own meshes on the model (the shovel's heap, the bucket's liquid).

const BASE = `${import.meta.env.BASE_URL}models/tools/`;

export const MODELS = {
  gun: {      // a stubby SMG with a real bore: reads as firing slugs, not beams
    url: 'blaster-kit/blaster-j.glb', rotate: [0, 0, 0], fit: 'z', size: 1.25, anchor: [0.5, 0.5, 0.5],
  },
  physgun: {  // the finned sci-fi one
    url: 'blaster-kit/blaster-q.glb', rotate: [0, 0, 0], fit: 'z', size: 1.3, anchor: [0.5, 0.5, 0.5],
  },
  axe: {      // handle up from the hand, blade forward
    url: 'survival-kit/tool-axe.glb', rotate: [0, Math.PI / 2, 0], fit: 'y', size: 1.25, anchor: [0.5, 0, 0.5],
  },
  shovel: {   // laid flat, blade forward, held at the end of the handle
    url: 'survival-kit/tool-shovel.glb', rotate: [-Math.PI / 2, 0, 0], fit: 'z', size: 2.2, anchor: [0.5, 0.5, 1],
  },
  bucket: {   // upright, held by the bail
    url: 'survival-kit/bucket.glb', rotate: [0, 0, 0], fit: 'y', size: 0.9, anchor: [0.5, 0.5, 0.5],
  },
};

const AXIS = { x: 0, y: 1, z: 2 };
const loader = new GLTFLoader();
const cache = new Map();   // url → { promise, users, scene }

function loadShared(url) {
  let entry = cache.get(url);
  if (!entry) {
    entry = { users: 0, scene: null, promise: null };
    entry.promise = loader.loadAsync(BASE + url).then((gltf) => { entry.scene = gltf.scene; return gltf.scene; });
    cache.set(url, entry);
  }
  return entry;
}

function freeShared(url) {
  const entry = cache.get(url);
  if (!entry || --entry.users > 0) return;
  cache.delete(url);
  entry.promise.then((scene) => {
    scene.traverse((o) => {
      o.geometry?.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      ms.forEach((m) => { Object.values(m).forEach((v) => v?.isTexture && v.dispose()); m.dispose(); });
    });
  }, () => {});
}

// A normalised clone of the model `key` (see MODELS), wrapped in a group whose
// origin is the anchor.
function normalised(source, def) {
  const inner = source.clone(true);
  inner.rotation.set(...def.rotate);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const k = def.size / (size.getComponent(AXIS[def.fit]) || 1);
  inner.scale.setScalar(k);
  const anchor = new THREE.Vector3(...def.anchor).multiply(size).add(box.min).multiplyScalar(k);
  inner.position.copy(anchor).negate();
  const outer = new THREE.Group();
  outer.add(inner);
  return { obj: outer, size: size.multiplyScalar(k) };
}

// Load model `key` and add it to `parent` when it arrives; onLoad(obj, info)
// runs then. Returns { dispose(), get obj() }.
export function attachModel(parent, key, onLoad) {
  const def = MODELS[key];
  const entry = loadShared(def.url);
  entry.users++;
  let obj = null, disposed = false;
  entry.promise.then((scene) => {
    if (disposed) return;
    const n = normalised(scene, def);
    obj = n.obj;
    obj.name = `viewmodel-${key}`;
    parent.add(obj);
    onLoad?.(obj, { size: n.size });
    globalThis.__app?.requestRender?.();   // the model arrived after the last frame drew
  }).catch((err) => { if (!disposed) console.error(`viewmodel '${key}' failed to load`, err); });
  return {
    get obj() { return obj; },
    dispose() {
      if (disposed) return;
      disposed = true;
      obj?.removeFromParent();
      freeShared(def.url);
    },
  };
}
