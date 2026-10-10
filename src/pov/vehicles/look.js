import * as THREE from 'three';
import { figureFrag } from '../figure.js';

// The vehicles' look: low-poly primitives lit the way the Castle Crashers
// wizard is (figure.js's figureFrag with FIG_TOON: the volume's own sun,
// shadow map, GI and lights, then cel shading), with black inverted-hull
// outlines. Models are built in metres (+z forward, +y up, the chassis
// collider's centre at the origin); the vehicle scales them into the scene.
//
//   const look = createLook();             // one per vehicle
//   look.part(parent, geometry, '#6b7a3a') // a lit, outlined mesh
//   look.glow(parent, geometry, [r, g, b]) // unlit, HDR colour
//   look.bind(volume, g)                   // build the materials for this grid
//   look.update(worldToGrid)               // every frame
//   look.char(k)                           // burnt: albedo × (1 − k)
//   look.ember(r, g, b)                    // a glow over it all (a burning wreck)

const OUTLINE_M = 0.045;                 // m, the outline's thickness (figure.js draws the wizard's at ~0.05 m)
const CHAR_ALBEDO = 0.12;                // share of its colour a burnt-out wreck keeps

const vert = /* glsl */ `
uniform mat4 uWorldToGrid;
out vec3 vGrid;
out vec3 vN;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vGrid = (uWorldToGrid * w).xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
const UNBOUND = new THREE.MeshBasicMaterial({ color: 0x808080 });
const linear = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };   // THREE.Color is linear

export function createLook() {
  const parts = [];
  const shared = { uEmit: { value: new THREE.Vector3() }, uWorldToGrid: { value: new THREE.Matrix4() } };
  let mats = [], boundTo = null, charred = 0;

  // An outline for a convex part centred on its bounding box: the part again,
  // grown by OUTLINE_M on every side, back faces only (no cracks at box corners,
  // which a push along split normals leaves).
  function outline(mesh) {
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    const bb = geo.boundingBox, size = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
    const hull = new THREE.Mesh(geo, OUTLINE_MAT);
    hull.scale.set(...['x', 'y', 'z'].map((a) => (size[a] + 2 * OUTLINE_M) / Math.max(size[a], 1e-3)));
    hull.position.copy(c).multiply(new THREE.Vector3(1, 1, 1).sub(hull.scale));
    mesh.add(hull);
  }

  return {
    part(parent, geo, hex, { edge = true } = {}) {
      const m = new THREE.Mesh(geo, UNBOUND);
      m.userData.albedo = linear(hex);
      parent.add(m);
      parts.push(m);
      if (edge) outline(m);
      return m;
    },
    glow(parent, geo, rgb) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(...rgb) }));
      parent.add(m);
      return m;
    },
    // materials for this volume (they bake the grid size in): one per colour, sharing the volume's uniforms
    bind(volume, g) {
      if (boundTo === volume) return;
      boundTo = volume;
      for (const m of mats) m.dispose();
      const frag = figureFrag(g), byColor = new Map();
      for (const p of parts) {
        const key = p.userData.albedo.join();
        if (!byColor.has(key)) {
          byColor.set(key, new THREE.ShaderMaterial({
            vertexShader: vert, fragmentShader: frag, defines: { FIG_TOON: '' },
            uniforms: { ...volume.material.uniforms, ...shared, uAlbedo: { value: new THREE.Vector3(...p.userData.albedo) } },
          }));
          byColor.get(key).userData.albedo = p.userData.albedo;
        }
        p.material = byColor.get(key);
      }
      mats = [...byColor.values()];
      if (charred) this.char(charred);
    },
    update(worldToGrid) { shared.uWorldToGrid.value.copy(worldToGrid); },
    char(k) {
      charred = k;
      const keep = 1 - k * (1 - CHAR_ALBEDO);
      for (const m of mats) m.uniforms.uAlbedo.value.set(...m.userData.albedo).multiplyScalar(keep);
    },
    // a glow over every lit part (linear HDR rgb): a burning wreck's embers
    ember(r, g, b) { shared.uEmit.value.set(r, g, b); },
    dispose() { for (const m of mats) m.dispose(); },
  };
}
