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
// `icon`: the model's pose in its hotbar icon (modelIcon below), turned in this order:
// yaw about +y, then tilt about +x (toward the eye; for a model that points along z
// after the yaw, a turn about its own length), then roll about the view axis.
const Q = Math.PI / 4;
const POINT_RIGHT = -Math.PI / 2;   // yaw that turns −z (forward) to +x (right)
export const MODELS = {
  gun: { fit: 'z', size: 1.25, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.35 } },        // an SMG, centred
  pistol: { fit: 'z', size: 0.8, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.35 } },     // a service pistol, centred
  sniper: { fit: 'z', size: 2.4, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.45 } },     // a scoped bolt-action rifle, centred
  rpg: { fit: 'z', size: 1.7, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.45 } },        // a launcher tube with a rocket in its mouth, centred
  rocket: { fit: 'z', size: 0.9, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: Q } },         // a rocket in flight (drawn without the arm)
  physgun: { fit: 'z', size: 1.3, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.35 } },     // finned, glowing core, centred
  axe: { fit: 'y', size: 1.25, anchor: [0.5, 0, 0.5], arm: ARM_DOWN, icon: { yaw: -POINT_RIGHT, tilt: 0.2, roll: -Q } },           // handle up from the hand, blade forward
  pickaxe: { fit: 'y', size: 1.3, anchor: [0.5, 0, 0.5], arm: ARM_DOWN, icon: { yaw: -POINT_RIGHT, tilt: 0.2, roll: -Q } },      // handle up from the hand, point forward
  shovel: { fit: 'z', size: 2.2, anchor: [0.5, 0.5, 1], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 1.0, roll: Q } },           // laid flat, blade forward, held at the end of the handle
  bucket: { fit: 'y', size: 0.9, anchor: [0.5, 0.5, 0.5], arm: ARM_UP, icon: { yaw: 0, tilt: 0.4, roll: 0 } },                    // upright, held by the bail
  trowel: { fit: 'z', size: 1.3, anchor: [0.5, 1, 1], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 1.0, roll: Q } },             // blade flat and forward, held at the end of the handle
  scanner: { fit: 'z', size: 0.6, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.7, roll: 0.25 } },    // a handheld box, screen up toward the eye
  torch: { fit: 'z', size: 1.1, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.25, roll: 0.2 } },      // held by the tank, nozzle and flame forward
  bomb: { fit: 'z', size: 0.8, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.35, roll: Q } },         // a capped pipe with a lit fuse
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
  screen: '#7dff9a', red: '#b8322a', flame: '#6fa8ff', spark: '#ffb347', olive: '#5a6b2e', oliveDark: '#3d4a1f',
};
const UNLIT = new Set(['glow', 'screen', 'flame', 'spark']);

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
// p: position, rot: Euler XYZ, m: COLORS key, name: for a tool to find the part (the torch's flame).
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
  torch: [
    { geo: 'cyl', r: 0.13, h: 0.5, p: [0, 0, 0], m: 'red' },
    { geo: 'cyl', rt: 0.06, rb: 0.13, h: 0.08, p: [0, 0.29, 0], m: 'red' },
    { geo: 'box', s: [0.1, 0.1, 0.12], p: [0, 0.36, -0.02], m: 'iron' },
    { geo: 'cyl', r: 0.05, h: 0.1, p: [0.09, 0.36, -0.02], rot: [0, 0, H], m: 'orange' },
    { geo: 'cyl', r: 0.03, h: 0.45, p: [0, 0.38, -0.3], rot: [H, 0, 0], m: 'iron' },
    { geo: 'cyl', r: 0.05, h: 0.14, p: [0, 0.38, -0.58], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', rt: 0, rb: 0.05, h: 0.35, p: [0, 0.38, -0.82], rot: [-H, 0, 0], m: 'flame', name: 'flame' },
  ],
  bomb: [
    { geo: 'cyl', r: 0.09, h: 0.45, p: [0, 0, 0], rot: [H, 0, 0], m: 'metal' },
    { geo: 'cyl', r: 0.11, h: 0.06, p: [0, 0, 0.24], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.11, h: 0.06, p: [0, 0, -0.24], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.012, h: 0.12, p: [0, 0.1, -0.24], rot: [0.4, 0, 0], m: 'grip' },
    { geo: 'sphere', r: 0.035, p: [0, 0.16, -0.27], m: 'spark', name: 'spark' },
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
  pickaxe: [
    { geo: 'cyl', r: 0.045, h: 1.3, p: [0, 0.5, 0], m: 'wood' },
    { geo: 'cyl', r: 0.062, h: 0.07, p: [0, -0.16, 0], m: 'wood' },
    { geo: 'box', s: [0.11, 0.15, 0.17], p: [0, 1.08, 0], m: 'ironDark' },
    // the crescent head: a long point forward and a shorter one back, both curving down
    { geo: 'cyl', rt: 0, rb: 0.06, h: 0.55, p: [0, 1.0, -0.32], rot: [-H - 0.28, 0, 0], m: 'iron' },
    { geo: 'cyl', rt: 0, rb: 0.055, h: 0.4, p: [0, 1.02, 0.25], rot: [H + 0.28, 0, 0], m: 'iron' },
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
  pistol: [
    { geo: 'box', s: [0.14, 0.13, 0.62], p: [0, 0.2, -0.2], m: 'metalDark' },
    { geo: 'box', s: [0.13, 0.08, 0.5], p: [0, 0.11, -0.16], m: 'metal' },
    { geo: 'cyl', r: 0.035, h: 0.06, p: [0, 0.2, -0.53], rot: [H, 0, 0], m: 'metal' },
    { geo: 'box', s: [0.03, 0.04, 0.03], p: [0, 0.285, -0.47], m: 'metalDark' },
    { geo: 'box', s: [0.06, 0.04, 0.03], p: [0, 0.285, 0.06], m: 'metalDark' },
    { geo: 'box', s: [0.02, 0.06, 0.12], p: [0, 0.03, -0.13], m: 'metalDark' },
    { geo: 'box', s: [0.12, 0.3, 0.15], p: [0, -0.04, 0.04], rot: [-0.25, 0, 0], m: 'grip' },
  ],
  sniper: [
    { geo: 'box', s: [0.12, 0.2, 0.5], p: [0, 0.12, 0.45], m: 'wood' },
    { geo: 'box', s: [0.14, 0.15, 0.6], p: [0, 0.2, -0.15], m: 'metal' },
    { geo: 'box', s: [0.13, 0.12, 0.5], p: [0, 0.13, -0.6], m: 'wood' },
    { geo: 'cyl', r: 0.035, h: 1.2, p: [0, 0.22, -1.05], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.055, h: 0.1, p: [0, 0.22, -1.68], rot: [H, 0, 0], m: 'metal' },
    { geo: 'cyl', r: 0.06, h: 0.55, p: [0, 0.36, -0.15], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.075, h: 0.06, p: [0, 0.36, -0.45], rot: [H, 0, 0], m: 'glow' },
    { geo: 'cyl', r: 0.07, h: 0.05, p: [0, 0.36, 0.13], rot: [H, 0, 0], m: 'metal' },
    { geo: 'box', s: [0.04, 0.08, 0.04], p: [0, 0.29, -0.02], m: 'metalDark' },
    { geo: 'box', s: [0.04, 0.08, 0.04], p: [0, 0.29, -0.3], m: 'metalDark' },
    { geo: 'cyl', r: 0.02, h: 0.12, p: [0.1, 0.22, 0.05], rot: [0, 0, H], m: 'metal' },
    { geo: 'sphere', r: 0.035, p: [0.16, 0.22, 0.05], m: 'metalDark' },
    STOCK_GRIP,
  ],
  rpg: [
    { geo: 'cyl', r: 0.11, h: 1.5, p: [0, 0.3, -0.3], rot: [H, 0, 0], m: 'olive' },
    { geo: 'cyl', r: 0.14, h: 0.1, p: [0, 0.3, -1.02], rot: [H, 0, 0], m: 'oliveDark' },
    { geo: 'cyl', r: 0.14, h: 0.1, p: [0, 0.3, 0.42], rot: [H, 0, 0], m: 'oliveDark' },
    { geo: 'cyl', rt: 0, rb: 0.09, h: 0.24, p: [0, 0.3, -1.18], rot: [-H, 0, 0], m: 'red' },
    { geo: 'box', s: [0.05, 0.12, 0.08], p: [0.13, 0.42, -0.2], m: 'metalDark' },
    { geo: 'box', s: [0.1, 0.22, 0.12], p: [0, 0.1, -0.55], rot: [0.15, 0, 0], m: 'grip' },
    STOCK_GRIP,
  ],
  rocket: [
    { geo: 'cyl', r: 0.08, h: 0.7, p: [0, 0, 0], rot: [H, 0, 0], m: 'olive' },
    { geo: 'cyl', rt: 0, rb: 0.08, h: 0.22, p: [0, 0, -0.46], rot: [-H, 0, 0], m: 'red' },
    ...FINS.map((a) => ({ geo: 'box', s: [0.02, 0.12, 0.16], p: [Math.sin(a) * 0.1, Math.cos(a) * 0.1, 0.28], rot: [0, 0, -a], m: 'oliveDark' })),
    { geo: 'sphere', r: 0.07, p: [0, 0, 0.4], m: 'spark' },
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
    if (p.name) m.name = p.name;
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
// anchor, with the arm on its grip (unless withArm is false: a thrown bomb).
function normalised(key, withArm = true) {
  const def = MODELS[key];
  const inner = build(key);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const k = def.size / (size.getComponent(AXIS[def.fit]) || 1);
  inner.scale.setScalar(k);
  inner.position.copy(new THREE.Vector3(...def.anchor).multiply(size).add(box.min).multiplyScalar(-k));
  const outer = new THREE.Group();
  outer.add(inner);
  if (withArm) {
    const hand = arm(def.arm);
    hand.position.copy(inner.position);   // the parts' origin is the grip
    outer.add(hand);
  }
  return { obj: outer, size: size.multiplyScalar(k) };
}

// Add model `key` to `parent`; onLoad(obj, info) runs before this returns.
// opts.arm: false leaves the forearm off. Returns { dispose(), get obj() }.
export function attachModel(parent, key, onLoad, { arm: withArm = true } = {}) {
  const { obj, size } = normalised(key, withArm);
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

// ---- hotbar icons: an Old School RuneScape inventory sprite of the model. A
// freeze frame of the same parts, posed by MODELS[key].icon, lit from up
// front left and drawn by an orthographic camera at ICON_PX pixels with no
// antialiasing, then given OSRS's 1 px black outline and its dark shadow one
// pixel down and right. Drawn once per key by a small renderer of its own,
// which is let go as soon as the icons in hand are done.
export const ICON_PX = 36;           // the sprite's size, in pixels (OSRS items are 36×32)
const ICON_PAD = 2;                  // px kept clear at each edge for the outline and shadow
const ICON_OUTLINE = [0, 0, 0];      // OSRS's item outline
const ICON_SHADOW = [0x30, 0x20, 0x20];   // and its drop shadow
const ICON_SHADOW_OFFSET = 1;        // px, down and right
const ICON_AMBIENT = 1.6;            // light on the icon: a flat fill plus a key light from up front left
const ICON_KEY = 2.2;
const ICON_KEY_DIR = [-1, 2, 3];
const ICON_CAMERA_Z = 10;            // model units in front of the model; any distance clear of it
const icons = new Map();             // key → data URL
let iconKit = null;                  // { renderer, scene, camera } while icons are being drawn

function getIconKit() {
  if (iconKit) return iconKit;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(ICON_PX, ICON_PX, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, ICON_AMBIENT));
  const key = new THREE.DirectionalLight(0xffffff, ICON_KEY);
  key.position.set(...ICON_KEY_DIR);
  scene.add(key);
  const camera = new THREE.OrthographicCamera();
  iconKit = { renderer, scene, camera };
  setTimeout(() => {   // after this batch of icons
    renderer.dispose();
    renderer.forceContextLoss();
    iconKit = null;
  });
  return iconKit;
}

// OSRS's outline and shadow round the sprite's opaque pixels (antialias is off,
// so a pixel is all there or not at all).
function outlineSprite(img) {
  const { data, width: w, height: hgt } = img;
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < hgt && data[(y * w + x) * 4 + 3] > 0;
  const set = (x, y, rgb) => { const i = (y * w + x) * 4; data.set([...rgb, 255], i); };
  const item = [];
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) item.push(solid(x, y));
  const was = (x, y) => x >= 0 && y >= 0 && x < w && y < hgt && item[y * w + x];
  const edge = [];
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    if (!item[y * w + x] && (was(x - 1, y) || was(x + 1, y) || was(x, y - 1) || was(x, y + 1))) edge.push([x, y]);
  }
  edge.forEach(([x, y]) => set(x, y, ICON_OUTLINE));
  const d = ICON_SHADOW_OFFSET;
  for (let y = hgt - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    if (!solid(x, y) && solid(x - d, y - d)) set(x, y, ICON_SHADOW);
  }
  return img;
}

// The hotbar icon of model `key`, as a data URL of an ICON_PX square sprite.
export function modelIcon(key) {
  if (icons.has(key)) return icons.get(key);
  const pose = MODELS[key].icon;
  const { renderer, scene, camera } = getIconKit();
  const { obj } = normalised(key, false);
  const q = new THREE.Quaternion();
  const turn = (axis, angle) => q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  turn(new THREE.Vector3(0, 1, 0), pose.yaw);
  turn(new THREE.Vector3(1, 0, 0), pose.tilt);
  turn(new THREE.Vector3(0, 0, 1), pose.roll);
  obj.quaternion.copy(q);
  scene.add(obj);
  obj.updateMatrixWorld(true);
  // fit the posed model's box in the square, less the padding
  const box = new THREE.Box3().setFromObject(obj, true);
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const half = (Math.max(s.x, s.y) / 2) * (ICON_PX / (ICON_PX - 2 * ICON_PAD));
  Object.assign(camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: ICON_CAMERA_Z * 2 });
  camera.position.set(c.x, c.y, c.z + ICON_CAMERA_Z);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  scene.remove(obj);
  obj.traverse((o) => o.geometry?.dispose());

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_PX;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(renderer.domElement, 0, 0);
  ctx.putImageData(outlineSprite(ctx.getImageData(0, 0, ICON_PX, ICON_PX)), 0, 0);
  const url = canvas.toDataURL();
  icons.set(key, url);
  return url;
}
