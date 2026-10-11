import * as THREE from 'three';

// A jacked build for the realistic body (figureReal.js): the mannequin's
// muscles inflated in its bind pose, once per download, before the robe is fit
// (garb.js) so the cloth wraps the new torso. Cruelty Squad's and Team Fortress
// 2's Heavy's comic proportions: arms and shoulders blown up, joints left slim
// so each muscle reads as a bulge.
//
// Each vertex moves away from the axis of every bone it is skinned to (bone
// to its child, in the bind pose), by its skin weight times the muscle's gain
// times a bump along the bone. Elbows, knees and wrists sit where neighbouring
// bumps fall off, so the blend across a joint stays seamless.

// bone → { to: the child the axis runs to, gain: extra radius at the peak (share
// of the vertex's distance from the axis), peak: where along the bone (0 at the
// bone, 1 at the child), width: the bump's half-width along the bone }
const MUSCLES = {
  clavicle: { to: 'upperarm', gain: 0.7, peak: 1.0, width: 0.6 },     // deltoids and traps
  upperarm: { to: 'lowerarm', gain: 0.85, peak: 0.45, width: 0.65 },  // biceps and triceps
  lowerarm: { to: 'hand', gain: 0.5, peak: 0.3, width: 0.7 },         // forearms, thickest by the elbow
  thigh: { to: 'calf', gain: 0.35, peak: 0.35, width: 0.7 },
  calf: { to: 'foot', gain: 0.4, peak: 0.25, width: 0.5 },
};
const TRUNK = {   // bones without a side
  spine_02: { to: 'spine_03', gain: 0.2, peak: 0.5, width: 0.8 },    // lats
  spine_03: { to: 'neck_01', gain: 0.35, peak: 0.4, width: 0.7 },    // chest and upper back
  neck_01: { to: 'Head', gain: 0.45, peak: 0.2, width: 0.8 },        // a bull neck
};

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };

// Inflate every skinned mesh under `scene` in place. Their geometry is shared
// by every clone of the download, so call this once per load.
export function bulkUp(scene) {
  scene.traverse((m) => {
    if (!m.isSkinnedMesh) return;
    const bones = m.skeleton.bones;
    const byName = new Map(bones.map((b, i) => [b.name, i]));
    // bind-pose bone positions, in the space bindMatrix takes vertices to
    const bindPos = m.skeleton.boneInverses.map((inv) => new THREE.Vector3().setFromMatrixPosition(inv.clone().invert()));
    const muscle = bones.map((b) => {
      const side = b.name.match(/_([lr])$/)?.[1];
      const spec = side ? MUSCLES[b.name.slice(0, -2)] : TRUNK[b.name];
      const child = spec && byName.get(side ? `${spec.to}_${side}` : spec.to);
      if (child === undefined) return null;
      const a = bindPos[byName.get(b.name)], axis = bindPos[child].clone().sub(a);
      return { ...spec, a, axis, len2: axis.lengthSq() };
    });

    // quantized (meshopt) positions would clamp at their old bounds: floats from here on
    const src = m.geometry.attributes.position;
    const pos = new THREE.Float32BufferAttribute(src.count * 3, 3);
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    const toModel = m.bindMatrixInverse;
    const p = new THREE.Vector3(), out = new THREE.Vector3(), r = new THREE.Vector3();
    for (let i = 0; i < src.count; i++) {
      p.fromBufferAttribute(src, i).applyMatrix4(m.bindMatrix);
      out.copy(p);
      for (let j = 0; j < 4; j++) {
        const mu = muscle[si.getComponent(i, j)], w = sw.getComponent(i, j);
        if (!mu || w <= 0) continue;
        const t = r.copy(p).sub(mu.a).dot(mu.axis) / mu.len2;
        r.sub(mu.axis.clone().multiplyScalar(t));   // from the axis out to the vertex
        out.addScaledVector(r, w * mu.gain * (1 - smooth01(Math.abs(t - mu.peak) / mu.width)));
      }
      out.applyMatrix4(toModel);
      pos.setXYZ(i, out.x, out.y, out.z);
    }
    m.geometry.setAttribute('position', pos);
    m.geometry.computeBoundingBox();
    m.geometry.computeBoundingSphere();
  });
}
