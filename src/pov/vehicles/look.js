import * as THREE from 'three/webgpu';
import { figureMaterial, figureUniforms } from '../figure.js';
import { unlitMaterial } from '../../gfx/meshLight.js';

// The vehicles' look: low-poly primitives lit the way the Castle Crashers
// wizard is (figure.js's figureMaterial, toon: the volume's own sun, shadow
// map, GI and lights, then cel shading), with black inverted-hull outlines.
// Models are built in metres (+z forward, +y up, the chassis collider's centre
// at the origin); the vehicle scales them into the scene.
//
//   const look = createLook();             // one per vehicle
//   look.part(parent, geometry, '#6b7a3a') // a lit, outlined mesh
//   look.glow(parent, geometry, [r, g, b]) // unlit, HDR colour
//   look.bind(volume, g)                   // (the light is the volume's for any grid: nothing to do)
//   look.update(worldToGrid)               // every frame
//   look.char(k)                           // burnt: albedo × (1 − k)
//   look.ember(r, g, b)                    // a glow over it all (a burning wreck)

const OUTLINE_M = 0.045;                 // m, the outline's thickness (figure.js draws the wizard's at ~0.05 m)
const CHAR_ALBEDO = 0.12;                // share of its colour a burnt-out wreck keeps
const DRIVER_COLOR = { robe: '#5a3d8a', face: '#121014', eyes: [4, 7, 8] };   // the seated wizard's (linear HDR eyes)
const DRIVER_SEGMENTS = 10;              // around his robe, hat and face (his head two more)
const EYE_SEGMENTS = 6;                  // around each eye

const OUTLINE_MAT = unlitMaterial({ color: 0x000000, side: THREE.BackSide });
const linear = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };   // THREE.Color is linear

export function createLook() {
  const u = figureUniforms();
  const byColor = new Map();   // albedo → its material (lit, one per colour)
  let charred = 0;

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
  function material(albedo) {
    const key = albedo.join();
    let m = byColor.get(key);
    if (!m) {
      byColor.set(key, m = figureMaterial({ albedo, u, toon: true, side: THREE.FrontSide }));
      m.userData.albedo = albedo;
      if (charred) m.uniforms.uAlbedo.value.set(...albedo).multiplyScalar(1 - charred * (1 - CHAR_ALBEDO));
    }
    return m;
  }

  return {
    part(parent, geo, hex, { edge = true } = {}) {
      const albedo = linear(hex);
      const m = new THREE.Mesh(geo, material(albedo));
      m.userData.albedo = albedo;
      parent.add(m);
      if (edge) outline(m);
      return m;
    },
    glow(parent, geo, rgb) {
      const m = new THREE.Mesh(geo, unlitMaterial({ color: new THREE.Color(...rgb) }));
      parent.add(m);
      return m;
    },
    bind() {},
    update(worldToGrid) { u.worldToGrid.value.copy(worldToGrid); },
    char(k) {
      charred = k;
      const keep = 1 - k * (1 - CHAR_ALBEDO);
      for (const m of byColor.values()) m.uniforms.uAlbedo.value.set(...m.userData.albedo).multiplyScalar(keep);
    },
    // a glow over every lit part (linear HDR rgb): a burning wreck's embers
    ember(r, g, b) { u.emit.value.set(r, g, b); },
    dispose() { for (const m of byColor.values()) m.dispose(); },
  };
}

// The driver: a seated wizard (the player's look) at seat ([x, y, z], m, his
// hips) on parent, built with look's part and glow, hidden until someone
// drives. fig sizes him for the seat (m): { robe: [top r, bottom r, height],
// head: r, hat: [r, height], face: r, eye: r, and each part's centre at robeAt,
// headAt, hatAt, faceAt, eyeAt (the right eye's; the left mirrors it) }.
export function seatedDriver(look, parent, seat, fig) {
  const driver = new THREE.Group();
  driver.position.set(...seat);
  look.part(driver, new THREE.CylinderGeometry(...fig.robe, DRIVER_SEGMENTS), DRIVER_COLOR.robe).position.set(...fig.robeAt);
  look.part(driver, new THREE.SphereGeometry(fig.head, DRIVER_SEGMENTS + 2, DRIVER_SEGMENTS), DRIVER_COLOR.robe).position.set(...fig.headAt);
  look.part(driver, new THREE.ConeGeometry(...fig.hat, DRIVER_SEGMENTS), DRIVER_COLOR.robe).position.set(...fig.hatAt);
  look.part(driver, new THREE.SphereGeometry(fig.face, DRIVER_SEGMENTS, DRIVER_SEGMENTS - 2), DRIVER_COLOR.face, { edge: false }).position.set(...fig.faceAt);
  const [ex, ey, ez] = fig.eyeAt;
  for (const x of [-ex, ex]) look.glow(driver, new THREE.SphereGeometry(fig.eye, EYE_SEGMENTS, EYE_SEGMENTS - 2), DRIVER_COLOR.eyes).position.set(x, ey, ez);
  driver.visible = false;
  parent.add(driver);
  return driver;
}
