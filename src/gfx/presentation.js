import * as THREE from 'three';
import { IDENTITY, ROLLING_LOG, effectParameters, presentationGLSL } from './presentationMath.js';
import { MESH_EDGE_CELLS, subdividePresentation } from './presentationGeometry.js';

export const EFFECTS = Object.freeze({ rollingLog: ROLLING_LOG });
const installed = new WeakMap();
// Chain, do not replace, the material's own skinning/instancing/motion program.
// Reconstruct its FINAL clip position; normals and lighting deliberately remain flat.
export function installPresentation(material, uniforms) {
  if (installed.has(material)) return installed.get(material).restore;
  const compile = material.onBeforeCompile, cache = material.customProgramCacheKey;
  const baseKey = () => cache === THREE.Material.prototype.customProgramCacheKey ? compile.toString() : cache.call(material);
  const wrapped = function(shader, renderer) {
    compile.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace(/void\s+main\s*\(\s*(?:void)?\s*\)/, 'void presentationOriginalMain()') + /* glsl */ `
${presentationGLSL}
uniform mat4 uWarpClipToWorld, uWarpWorldToClip;
void main() {
  presentationOriginalMain();
  if (uWarpK != 0.0) {
    vec4 p = uWarpClipToWorld * gl_Position;
    gl_Position = uWarpWorldToClip * vec4(warpPoint(p.xyz / p.w), 1.0);
  }
}`;
  };
  const restore = () => {
    if (material.onBeforeCompile === wrapped) {
      material.onBeforeCompile = compile; material.customProgramCacheKey = cache; material.needsUpdate = true;
    }
    installed.delete(material);
  };
  material.onBeforeCompile = wrapped;
  material.customProgramCacheKey = () => `${baseKey()}|presentation-v1`;
  material.needsUpdate = true;
  installed.set(material, { restore });
  return restore;
}

export function createPresentation(onChange = () => {}) {
  let selected = null, revision = 0, neutral = false;
  let params = IDENTITY;
  const uniforms = {
    uWarpK: { value: 0 }, uWarpAnchor: { value: new THREE.Vector2() }, uWarpDir: { value: new THREE.Vector2(0, 1) },
    uWarpClipToWorld: { value: new THREE.Matrix4() }, uWarpWorldToClip: { value: new THREE.Matrix4() },
  };
  const sceneToWorld = new THREE.Matrix4(), worldToScene = new THREE.Matrix4();
  const materials = new Map(), objects = new Map(), geometries = new Map();
  const objectToWorld = new THREE.Matrix4();
  let drawSerial = 0;
  const geometryVersion = g => Object.values(g.attributes).map(a=>a.version).join(',');
  function restoreGeometry(o) {
    const record = geometries.get(o);
    if (!record) return;
    if (o.geometry === record.owned) o.geometry = record.original;
    o.isLineSegments = record.lineSegments;
    record.original.removeEventListener('dispose',record.disposed);
    record.owned?.dispose(); geometries.delete(o);
  }
  function removeObject(o) {
    restoreGeometry(o);
    const record = objects.get(o);
    if (record) { o.frustumCulled = record.culled; o.removeEventListener('removed',record.removed); objects.delete(o); }
  }
  const eye = new THREE.Vector3(), look = new THREE.Vector3();
  function restore() {
    for (const undo of materials.values()) undo();
    materials.clear();
    for (const o of objects.keys()) removeObject(o);
  }
  const api = {
    uniforms, sceneToWorld, worldToScene,
    get active() { return !!selected && !neutral; },
    get effect() { return selected; },
    get revision() { return revision; },
    get parameters() { return params; },
    get key() { return `${revision}:${uniforms.uWarpK.value}:${uniforms.uWarpAnchor.value.toArray()}:${uniforms.uWarpDir.value.toArray()}`; },
    select(effect = null) {
      if (effect != null && !EFFECTS[effect]) throw new Error(`Unknown presentation effect: ${effect}`);
      if (effect === selected) return;
      restore(); selected = effect; revision++;
      uniforms.uWarpK.value = effect ? EFFECTS[effect].k : 0;
      params = effectParameters(uniforms.uWarpK.value, uniforms.uWarpAnchor.value.toArray(), uniforms.uWarpDir.value.toArray());
      onChange();
    },
    // Run once after camera movement and before interaction/pacing. Ground anchor
    // is directly beneath the camera: it remains undeformed. Vertical views retain
    // the last horizontal direction instead of introducing a discontinuous roll.
    update(camera, transform) {
      sceneToWorld.copy(transform); worldToScene.copy(transform).invert();
      camera.updateMatrixWorld();
      eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(sceneToWorld);
      camera.getWorldDirection(look).transformDirection(sceneToWorld);
      if (Math.hypot(look.x, look.z) > 1e-5) uniforms.uWarpDir.value.set(look.x, look.z).normalize();
      uniforms.uWarpAnchor.value.set(eye.x, eye.z);
      uniforms.uWarpK.value = api.active ? EFFECTS[selected].k : 0;
      params = effectParameters(uniforms.uWarpK.value, [eye.x, eye.z], uniforms.uWarpDir.value.toArray());
    },
    // Called after post's jitter, including for the detail depth scene.
    prepare(scene, camera) {
      camera.updateMatrixWorld();
      uniforms.uWarpWorldToClip.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(worldToScene);
      uniforms.uWarpClipToWorld.value.copy(uniforms.uWarpWorldToClip.value).invert();
      if (!api.active) return;
      scene.updateMatrixWorld();
      const serial = ++drawSerial;
      scene.traverse(o => {
        if (!o.material || o.userData.presentation === false || !o.layers.test(camera.layers)) return;
        for (let parent=o.parent; parent; parent=parent.parent) if (parent.userData.presentationOverlay) return;
        if (!objects.has(o)) {
          const record = { culled: o.frustumCulled, removed: () => removeObject(o) };
          objects.set(o,record); o.addEventListener('removed',record.removed);
        }
        Object.assign(objects.get(o), { scene, serial });
        o.frustumCulled = false;
        if (o.geometry) {
          objectToWorld.multiplyMatrices(sceneToWorld,o.matrixWorld);
          const maxLength = MESH_EDGE_CELLS / Math.max(objectToWorld.getMaxScaleOnAxis(),1e-8);
          let record = geometries.get(o);
          if (!record || maxLength < record.maxLength || geometryVersion(record.original) !== record.version || (o.geometry !== record.owned && o.geometry !== record.original)) {
            if (record) restoreGeometry(o);
            const original = o.geometry, owned = subdividePresentation(o,maxLength);
            record = { original, owned, maxLength, version:geometryVersion(original), lineSegments:o.isLineSegments, disposed:() => removeObject(o) };
            original.addEventListener('dispose',record.disposed); geometries.set(o,record);
            if (owned) { o.geometry=owned; if (o.isLine) o.isLineSegments=true; }
          }
        }
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m.userData.presentation === false || materials.has(m)) continue;
          const undo = installPresentation(m, uniforms);
          const disposed = () => { undo(); materials.delete(m); m.removeEventListener('dispose',disposed); };
          m.addEventListener('dispose',disposed);
          materials.set(m,() => { undo(); m.removeEventListener('dispose',disposed); });
        }
      });
      // Removing a group does not emit 'removed' on its descendants.
      for (const [o,record] of objects) if (record.scene === scene && record.serial !== serial) removeObject(o);
    },
    neutral(fn, scene) {
      const was = neutral, k = uniforms.uWarpK.value, proxies = [];
      neutral = true; uniforms.uWarpK.value = 0;
      scene?.traverse(o => {
        if (o.userData.boxGeometry && o.geometry !== o.userData.boxGeometry) {
          proxies.push([o,o.geometry]); o.geometry = o.userData.boxGeometry;
        }
      });
      try { return fn(); } finally {
        neutral = was; uniforms.uWarpK.value = k;
        for (const [o,g] of proxies) o.geometry = g;
      }
    },
    dispose() { restore(); selected = null; uniforms.uWarpK.value = 0; },
  };
  return api;
}
