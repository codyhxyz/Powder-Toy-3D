import * as THREE from 'three/webgpu';
import { Fn, uniform, vec4, dot, select, modelViewProjection } from 'three/tsl';
import { IDENTITY, ROLLING_LOG, effectParameters } from './presentationMath.js';
import { MESH_EDGE_CELLS, subdividePresentation } from './presentationGeometry.js';

// The presentation layer (main's rolling log; docs/webgpu.md Sync log, Sync 4):
// a gamemode picks an effect by name (maps.js GAMEMODES.effect) and the
// displayed world bends; physics stays flat. Our passes bend themselves from
// `parameters` (the volume's chord march, the far view, the pick, TAA's
// reprojection: shaders/gfx/presentation.js, presentationMath.js
// presentationWGSL); three.js's meshes bend here, through their node
// materials' vertex stage (TSL), which replaces the GLSL's onBeforeCompile.

export const EFFECTS = Object.freeze({ rollingLog: ROLLING_LOG });
const installed = new WeakMap();

// A clip position, bent: back through the uniforms' clip → world cells, the
// warp, and on to clip again (the GLSL's warpPoint between uWarpClipToWorld
// and uWarpWorldToClip). Unchanged while k is 0 (neutral).
const bendClip = Fn(([clip, k, anchor, dir, clipToWorld, worldToClip]) => {
  const c = vec4(clip).toVar();
  const p = clipToWorld.mul(c);
  const w = p.xyz.div(p.w).toVar();
  const s = dot(w.xz.sub(anchor), dir);
  const bent = worldToClip.mul(vec4(w.x, w.y.sub(k.mul(s).mul(s)), w.z, 1));
  return select(k.notEqual(0), bent, c);
});

// Chain, do not replace, the material's own skinning/instancing/motion program:
// the vertex stage's FINAL clip position (its own vertexNode if it has one, a
// billboard's or a bird's, else three's modelViewProjection after skinning,
// instancing and positionNode) is what bends. Normals and lighting
// deliberately remain flat. A node material's vertexNode change rebuilds its
// pipeline (once, when an effect is selected or dropped).
export function installPresentation(material, uniforms) {
  if (installed.has(material)) return installed.get(material).restore;
  const vertexNode = material.vertexNode ?? null, cache = material.customProgramCacheKey;
  const node = bendClip(vertexNode ?? modelViewProjection, uniforms.uWarpK, uniforms.uWarpAnchor, uniforms.uWarpDir,
    uniforms.uWarpClipToWorld, uniforms.uWarpWorldToClip);
  const restore = () => {
    if (material.vertexNode === node) {
      material.vertexNode = vertexNode; material.customProgramCacheKey = cache; material.needsUpdate = true;
    }
    installed.delete(material);
  };
  material.vertexNode = node;
  material.customProgramCacheKey = () => `${cache.call(material)}|presentation-v1`;
  material.needsUpdate = true;
  installed.set(material, { restore });
  return restore;
}

export function createPresentation(onChange = () => {}) {
  let selected = null, revision = 0, neutral = false;
  let params = IDENTITY;
  // TSL uniform nodes, under the GLSL uniforms' names (.value as theirs)
  const uniforms = {
    uWarpK: uniform(0), uWarpAnchor: uniform(new THREE.Vector2()), uWarpDir: uniform(new THREE.Vector2(0, 1)),
    uWarpClipToWorld: uniform(new THREE.Matrix4()), uWarpWorldToClip: uniform(new THREE.Matrix4()),
  };
  const sceneToWorld = new THREE.Matrix4(), worldToScene = new THREE.Matrix4();
  const materials = new Map(), objects = new Map(), geometries = new Map();
  const changed = new Set();   // meshes whose program the bend changed (takeChanged)
  const objectToWorld = new THREE.Matrix4();
  let drawSerial = 0, updates = 0, installedAt = -1;
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
    if (materials.size) for (const o of objects.keys()) changed.add(o);
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
      restore(); selected = effect; revision++; installedAt = -1;   // (the next install is a full one)
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
      updates++;   // (a frame: the next install is a full one)
    },
    // The bend into the meshes `camera` draws (their records, geometry and
    // node materials), not yet the frame's clip matrices: src/wire/mesh.js
    // calls it before the frame's guard (gfx/meshLight.js guardMeshes), so a
    // mesh whose program it changes compiles before it draws (takeChanged).
    // A mesh the guard has parked (on its layer, which no camera draws) is
    // left until it is back: its next install compiles the bent program.
    // In full once a frame (the first call after update(): the scene's
    // matrices, each mesh's geometry and subdivision); a later call in the
    // same frame (prepare's, before three draws) only meets what that one
    // didn't (a mesh added since), which draws now whatever it is compiled
    // with, so it isn't reported.
    install(scene, camera) {
      if (!api.active) return;
      const full = installedAt !== updates;
      if (full) { installedAt = updates; scene.updateMatrixWorld(); }
      const serial = ++drawSerial, seen = [];
      scene.traverse(o => {
        if (!o.material) return;
        let record = objects.get(o);
        if (record) record.serial = serial;   // (still in the scene: kept while the guard parks it, its program with it)
        if (o.userData.presentation === false || !o.layers.test(camera.layers)) return;
        for (let parent=o.parent; parent; parent=parent.parent) if (parent.userData.presentationOverlay) return;
        if (!record) {
          record = { culled: o.frustumCulled, removed: () => removeObject(o), frame: -1, program: null };
          objects.set(o,record); o.addEventListener('removed',record.removed);
        }
        record.scene = scene; record.serial = serial;
        if (record.frame === updates && !full) return;   // (met this frame)
        record.frame = updates;
        if (!full) o.updateWorldMatrix(true, false);
        o.frustumCulled = false;
        if (o.geometry) {
          objectToWorld.multiplyMatrices(sceneToWorld,o.matrixWorld);
          const maxLength = MESH_EDGE_CELLS / Math.max(objectToWorld.getMaxScaleOnAxis(),1e-8);
          let geo = geometries.get(o);
          if (!geo || maxLength < geo.maxLength || geometryVersion(geo.original) !== geo.version || (o.geometry !== geo.owned && o.geometry !== geo.original)) {
            if (geo) restoreGeometry(o);
            const original = o.geometry, owned = subdividePresentation(o,maxLength);
            geo = { original, owned, maxLength, version:geometryVersion(original), lineSegments:o.isLineSegments, disposed:() => removeObject(o) };
            original.addEventListener('dispose',geo.disposed); geometries.set(o,geo);
            if (owned) { o.geometry=owned; if (o.isLine && !o.isLineSegments) o.isLineSegments=true; }   // (a strip drawn as a list)
          }
        }
        const list = Array.isArray(o.material) ? o.material : [o.material];
        seen.push([o, list, record, full]);
        for (const m of list) {
          if (m.userData.presentation === false || materials.has(m)) continue;
          const undo = installPresentation(m, uniforms);
          const disposed = () => { undo(); materials.delete(m); m.removeEventListener('dispose',disposed); };
          m.addEventListener('dispose',disposed);
          materials.set(m,() => { undo(); m.removeEventListener('dispose',disposed); });
        }
      });
      // A mesh draws another program than install last saw it draw (or one it
      // hasn't seen) when its geometry (subdivided: another vertex layout; a
      // strip as a list) or a material's vertex stage changed: one bent just
      // now changes every mesh sharing it, whichever came first.
      for (const [o, list, record, report] of seen) {
        const program = [o.geometry, o.isLineSegments, ...list.map((m) => m.vertexNode)];
        const was = record.program;
        if (report && (!was || was.length !== program.length || program.some((x, i) => x !== was[i]))) changed.add(o);
        record.program = program;
      }
      // Removing a group does not emit 'removed' on its descendants.
      for (const [o,record] of objects) if (record.scene === scene && record.serial !== serial) removeObject(o);
    },
    // Called after post's jitter (the camera's projection is this frame's), right
    // before three renders `scene` with `camera` (app.js threeMeshes). Installs
    // what the frame's install() hasn't met yet (a mesh added since).
    prepare(scene, camera) {
      camera.updateMatrixWorld();
      uniforms.uWarpWorldToClip.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(worldToScene);
      uniforms.uWarpClipToWorld.value.copy(uniforms.uWarpWorldToClip.value).invert();
      api.install(scene, camera);
    },
    // The meshes whose pipeline the bend changed (installed, or restored by
    // select/dispose) since the last call, for src/wire/mesh.js to compile
    // before they draw (F8); emptied by the call.
    takeChanged() {
      const out = [...changed];
      changed.clear();
      return out;
    },
    // fn with the effect off (k 0: the bent meshes draw flat, and `active` is
    // false for our passes): stills, thumbnails, the viewmodels' overlay pass.
    neutral(fn) {
      const was = neutral, k = uniforms.uWarpK.value;
      neutral = true; uniforms.uWarpK.value = 0;
      try { return fn(); } finally {
        neutral = was; uniforms.uWarpK.value = k;
      }
    },
    dispose() { restore(); selected = null; uniforms.uWarpK.value = 0; },
  };
  return api;
}
