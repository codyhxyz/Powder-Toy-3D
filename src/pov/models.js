import * as THREE from 'three';

// The POV tools' held models, in a RuneScape (RS2 / Old School) style: low-poly
// primitives, no textures, one flat colour per face from Jagex's 16-bit HSL
// palette, chunky parts, and a fist and forearm on the grip. Each model is
// built from PARTS (in model units: the grip at the origin, −z forward, +y up),
// then normalised by MODELS below so a tool can place it in cells without
// knowing its parts:
//
//   1. scaled so its bounding box spans `size` cells along `fit`;
//   2. moved so the point at `anchor` (a share of the bounding box per axis,
//      0 = min, 1 = max) sits at the origin.
//
// The arm goes on after, in cells, so it doesn't count toward the box.
//
//   const m = attachModel(parent, 'gun', (obj, info) => { ... });   // builds now; onLoad runs before it returns
//   m.dispose();                                                     // detach and free the geometry
//
// info.size is the normalised bounding box size (cells), for tools that put
// their own meshes on the model (the shovel's heap, the bucket's liquid).

// `arm`: the forearm's direction from the grip (model space), toward the shoulder.
const ARM_DOWN = [0.35, -0.78, 0.52];   // right, down, back toward the eye: a hand held out in front
const ARM_UP = [0.1, 0.45, 1];          // up and back (the bucket tips toward the eye): a hand holding something that hangs below it
export const MODELS = {
  gun: { fit: 'z', size: 1.25, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN },        // an SMG, centred
  physgun: { fit: 'z', size: 1.3, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN },     // finned, glowing core, centred
  axe: { fit: 'y', size: 1.25, anchor: [0.5, 0, 0.5], arm: ARM_DOWN },          // handle up from the hand, blade forward
  shovel: { fit: 'z', size: 2.2, anchor: [0.5, 0.5, 1], arm: ARM_DOWN },        // laid flat, blade forward, held at the end of the handle
  bucket: { fit: 'y', size: 0.9, anchor: [0.5, 0.5, 0.5], arm: ARM_UP },        // upright, held by the bail
  trowel: { fit: 'z', size: 1.3, anchor: [0.5, 1, 1], arm: ARM_DOWN },          // blade flat and forward, held at the end of the handle
  scanner: { fit: 'z', size: 0.6, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN },     // a handheld box, screen up toward the eye
};

// RS2 stores a colour as 16-bit HSL: 6 bits of hue, 3 of saturation, 7 of lightness.
const HUE_STEPS = 63, SAT_STEPS = 7, LIGHT_STEPS = 127;
export function jagexColor(color) {
  const hsl = {};
  new THREE.Color(color).getHSL(hsl);
  return new THREE.Color().setHSL(
    Math.round(hsl.h * HUE_STEPS) / HUE_STEPS,
    Math.round(hsl.s * SAT_STEPS) / SAT_STEPS,
    Math.round(hsl.l * LIGHT_STEPS) / LIGHT_STEPS,
  );
}

const COLORS = {
  wood: '#7a5230', iron: '#9aa0a6', ironDark: '#585d62', metal: '#4a4f55', metalDark: '#2c2f33',
  grip: '#3a3530', orange: '#d87a22', white: '#d6dbe0', glow: '#5ff0ff', skin: '#c48a5c', sleeve: '#8a3a2a',
  screen: '#7dff9a',
};
const UNLIT = new Set(['glow', 'screen']);

// shapes
const CHUNK = 1.35;          // thin parts (under CHUNK_BELOW units) are thickened this much: RS2's stubby proportions
const CHUNK_BELOW = 0.12;    // model units
const ROUND_SEGMENTS = 6;    // sides on a cylinder or sphere
const SPHERE_RINGS = 4;
const TORUS_SIDES = 3;       // around the tube
const TORUS_SEGMENTS = 8;    // around the ring
export const BUCKET_SIDES = 8;   // the pail's sides; the bucket's liquid disc matches them so it never pokes through

// the arm, in cells, from the grip toward the bottom right of the screen
const FIST = [0.22, 0.2, 0.24];
const FOREARM_WIDTH = 0.18;
const FOREARM_LENGTH = 2.6;
const ARM_START = 0.08;      // cells from the grip to the forearm's near end (inside the fist)

const H = Math.PI / 2;
const FINS = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
const STOCK_GRIP = { geo: 'box', s: [0.13, 0.32, 0.15], p: [0, -0.03, 0.06], rot: [-0.28, 0, 0], m: 'grip' };

// Parts: box (s: size), cyl (r, or rt/rb top/bottom radii, h: height, along y), torus (R, tube, arc;
// in the xy plane), sphere (r), plate (pts: an outline in xy, extruded `depth` along z).
// p: position, rot: Euler XYZ, m: COLORS key.
const PARTS = {
  shovel: [
    { geo: 'cyl', r: 0.045, h: 1.5, p: [0, 0, -0.65], rot: [H, 0, 0], m: 'wood' },
    { geo: 'torus', R: 0.11, tube: 0.028, p: [0, 0, 0.2], rot: [H, 0, 0], m: 'ironDark' },
    { geo: 'cyl', rt: 0.075, rb: 0.045, h: 0.2, p: [0, 0, -1.45], rot: [-H, 0, 0], m: 'ironDark' },
    { geo: 'plate', pts: [[-0.24, 0], [0.24, 0], [0.24, 0.42], [0, 0.6], [-0.24, 0.42]], depth: 0.035, p: [0, 0, -1.52], rot: [-H, 0, 0], m: 'iron' },
  ],
  bucket: [
    { geo: 'cyl', rt: 0.3, rb: 0.23, h: 0.5, sides: BUCKET_SIDES, p: [0, -0.55, 0], m: 'iron' },
    { geo: 'torus', R: 0.3, tube: 0.03, ring: BUCKET_SIDES, p: [0, -0.3, 0], rot: [H, 0, 0], m: 'ironDark' },
    { geo: 'torus', R: 0.255, tube: 0.022, ring: BUCKET_SIDES, p: [0, -0.72, 0], rot: [H, 0, 0], m: 'ironDark' },
    { geo: 'torus', R: 0.3, tube: 0.016, arc: Math.PI, ring: 6, p: [0, -0.3, 0], m: 'ironDark' },
    { geo: 'box', s: [0.05, 0.08, 0.05], p: [0.3, -0.34, 0], m: 'ironDark' },
    { geo: 'box', s: [0.05, 0.08, 0.05], p: [-0.3, -0.34, 0], m: 'ironDark' },
  ],
  trowel: [
    { geo: 'cyl', r: 0.05, h: 0.4, p: [0, 0, 0.05], rot: [H, 0, 0], m: 'wood' },
    { geo: 'cyl', r: 0.06, h: 0.05, p: [0, 0, -0.17], rot: [H, 0, 0], m: 'ironDark' },
    { geo: 'box', s: [0.03, 0.03, 0.12], p: [0, -0.04, -0.23], rot: [0.6, 0, 0], m: 'ironDark' },
    { geo: 'plate', pts: [[0, 0], [0.18, 0.22], [0, 0.66], [-0.18, 0.22]], depth: 0.02, p: [0, -0.09, -0.27], rot: [-H, 0, 0], m: 'iron' },
  ],
  scanner: [
    { geo: 'box', s: [0.3, 0.16, 0.48], p: [0, 0.2, -0.12], m: 'metal' },
    { geo: 'box', s: [0.22, 0.02, 0.26], p: [0, 0.285, -0.04], m: 'screen' },
    { geo: 'box', s: [0.31, 0.05, 0.08], p: [0, 0.2, -0.38], m: 'orange' },
    { geo: 'cyl', r: 0.015, h: 0.3, p: [0.1, 0.38, -0.3], rot: [-0.4, 0, 0], m: 'metalDark' },
    { geo: 'sphere', r: 0.035, p: [0.1, 0.52, -0.36], m: 'glow' },
    STOCK_GRIP,
  ],
  axe: [
    { geo: 'cyl', r: 0.045, h: 1.25, p: [0, 0.5, 0], m: 'wood' },
    { geo: 'cyl', r: 0.062, h: 0.07, p: [0, -0.14, 0], m: 'wood' },
    { geo: 'box', s: [0.1, 0.24, 0.2], p: [0, 1.0, 0], m: 'ironDark' },
    { geo: 'plate', pts: [[0.08, -0.11], [0.08, 0.11], [0.34, 0.23], [0.42, 0.02], [0.34, -0.25]], depth: 0.055, p: [0, 1.0, 0], rot: [0, H, 0], m: 'iron' },
    { geo: 'box', s: [0.1, 0.13, 0.1], p: [0, 1.0, 0.14], m: 'ironDark' },
  ],
  gun: [
    { geo: 'box', s: [0.18, 0.2, 0.75], p: [0, 0.2, -0.2], m: 'metal' },
    { geo: 'box', s: [0.09, 0.05, 0.5], p: [0, 0.325, -0.25], m: 'metalDark' },
    { geo: 'box', s: [0.05, 0.07, 0.06], p: [0, 0.37, 0.06], m: 'metalDark' },
    { geo: 'box', s: [0.04, 0.06, 0.05], p: [0, 0.37, -0.46], m: 'metalDark' },
    { geo: 'cyl', r: 0.045, h: 0.32, p: [0, 0.21, -0.73], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.065, h: 0.09, p: [0, 0.21, -0.9], rot: [H, 0, 0], m: 'metal' },
    STOCK_GRIP,
    { geo: 'box', s: [0.1, 0.3, 0.13], p: [0, -0.02, -0.32], rot: [0.12, 0, 0], m: 'metalDark' },
    { geo: 'box', s: [0.11, 0.13, 0.28], p: [0, 0.2, 0.3], m: 'grip' },
    { geo: 'box', s: [0.186, 0.04, 0.42], p: [0, 0.21, -0.24], m: 'orange' },
  ],
  physgun: [
    { geo: 'cyl', r: 0.13, h: 0.62, p: [0, 0.22, -0.2], rot: [H, 0, 0], m: 'white' },
    { geo: 'cyl', rt: 0.13, rb: 0.1, h: 0.1, p: [0, 0.22, 0.16], rot: [-H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.137, h: 0.12, p: [0, 0.22, -0.28], rot: [H, 0, 0], m: 'glow' },
    ...FINS.map((a) => ({ geo: 'box', s: [0.025, 0.15, 0.38], p: [Math.sin(a) * 0.19, 0.22 + Math.cos(a) * 0.19, -0.12], rot: [0, 0, -a], m: 'orange' })),
    { geo: 'cyl', rt: 0.09, rb: 0.13, h: 0.1, p: [0, 0.22, -0.56], rot: [-H, 0, 0], m: 'metalDark' },
    ...FINS.map((a) => ({ geo: 'cyl', rt: 0.012, rb: 0.03, h: 0.24, p: [Math.sin(a) * 0.08, 0.22 + Math.cos(a) * 0.08, -0.72], rot: [-H, 0, 0], m: 'metalDark' })),
    { geo: 'sphere', r: 0.05, p: [0, 0.22, -0.7], m: 'glow' },
    STOCK_GRIP,
  ],
};

const materials = new Map();   // COLORS key → material, shared by every model
function material(key) {
  if (!materials.has(key)) {
    const color = jagexColor(COLORS[key]);
    materials.set(key, UNLIT.has(key)
      ? new THREE.MeshBasicMaterial({ color })
      : new THREE.MeshLambertMaterial({ color, flatShading: true }));
  }
  return materials.get(key);
}

function partGeometry(p) {
  const thick = (v) => (v < CHUNK_BELOW ? v * CHUNK : v);
  switch (p.geo) {
    case 'box': return new THREE.BoxGeometry(...p.s.map(thick));
    case 'cyl': return new THREE.CylinderGeometry(thick(p.rt ?? p.r), thick(p.rb ?? p.r), p.h, p.sides ?? ROUND_SEGMENTS);
    case 'torus': return new THREE.TorusGeometry(p.R, thick(p.tube), TORUS_SIDES, p.ring ?? TORUS_SEGMENTS, p.arc ?? Math.PI * 2);
    case 'sphere': return new THREE.SphereGeometry(p.r, ROUND_SEGMENTS, SPHERE_RINGS);
    case 'plate': {
      const depth = thick(p.depth);
      return new THREE.ExtrudeGeometry(new THREE.Shape(p.pts.map(([x, y]) => new THREE.Vector2(x, y))), { depth, bevelEnabled: false })
        .translate(0, 0, -depth / 2);
    }
    default: throw new Error(`unknown part '${p.geo}'`);
  }
}

function build(key) {
  const g = new THREE.Group();
  for (const p of PARTS[key]) {
    const m = new THREE.Mesh(partGeometry(p), material(p.m));
    m.position.set(...p.p);
    if (p.rot) m.rotation.set(...p.rot);
    g.add(m);
  }
  return g;
}

function arm(dir) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(...FIST), material('skin')));
  const forearm = new THREE.Mesh(
    new THREE.BoxGeometry(FOREARM_WIDTH, FOREARM_WIDTH, FOREARM_LENGTH).translate(0, 0, FOREARM_LENGTH / 2 + ARM_START),
    material('sleeve'));
  forearm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...dir).normalize());
  g.add(forearm);
  return g;
}

const AXIS = { x: 0, y: 1, z: 2 };

// A normalised model `key` (see MODELS), wrapped in a group whose origin is the
// anchor, with the arm on its grip.
function normalised(key) {
  const def = MODELS[key];
  const inner = build(key);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const k = def.size / (size.getComponent(AXIS[def.fit]) || 1);
  inner.scale.setScalar(k);
  inner.position.copy(new THREE.Vector3(...def.anchor).multiply(size).add(box.min).multiplyScalar(-k));
  const outer = new THREE.Group();
  const hand = arm(def.arm);
  hand.position.copy(inner.position);   // the parts' origin is the grip
  outer.add(inner, hand);
  return { obj: outer, size: size.multiplyScalar(k) };
}

// Add model `key` to `parent`; onLoad(obj, info) runs before this returns.
// Returns { dispose(), get obj() }.
export function attachModel(parent, key, onLoad) {
  const { obj, size } = normalised(key);
  obj.name = `viewmodel-${key}`;
  parent.add(obj);
  onLoad?.(obj, { size });
  globalThis.__app?.requestRender?.();
  let disposed = false;
  return {
    get obj() { return obj; },
    dispose() {
      if (disposed) return;
      disposed = true;
      obj.removeFromParent();
      obj.traverse((o) => o.geometry?.dispose());   // the materials are shared
    },
  };
}
