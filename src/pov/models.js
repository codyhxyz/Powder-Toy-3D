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
  flask: { fit: 'y', size: 0.75, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: 0, tilt: 0.3, roll: -Q / 2 } },             // Noita's potion: a round glass bulb, held by the neck, corked
  trowel: { fit: 'z', size: 1.3, anchor: [0.5, 1, 1], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 1.0, roll: Q } },             // blade flat and forward, held at the end of the handle
  scanner: { fit: 'z', size: 0.6, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.7, roll: 0.25 } },    // a handheld box, screen up toward the eye
  flamer: { fit: 'z', size: 1.6, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.35 } },     // a flamethrower: wand, fuel tank under it, pilot light at the nozzle
  torch: { fit: 'y', size: 1.45, anchor: [0.5, 0.115, 0.5], arm: ARM_DOWN, icon: { yaw: 0, tilt: 0.2, roll: -Q } },                 // a burning torch, held by its grip
  lantern: { fit: 'y', size: 0.85, anchor: [0.5, 1, 0.5], arm: ARM_UP, icon: { yaw: 0, tilt: 0.3, roll: 0 } },                    // a lantern hanging from its bail
  bomb: { fit: 'z', size: 0.8, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.35, roll: Q } },         // a capped pipe with a lit fuse
  knife: { fit: 'z', size: 0.95, anchor: [0.5, 0.5, 0.79], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: Q } },       // blade forward, edge down, held by the handle
  laser: { fit: 'z', size: 2.1, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.45 } },      // a Spartan-laser-style cannon, its charge strip glowing, centred
  burrower: { fit: 'z', size: 1.5, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.45 } },   // a stubby launcher with a drill bit in its mouth, centred
  drill: { fit: 'x', size: 1, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: Q } },           // the burrower's drill in flight, a cell across (the tool scales it to its bore)
  pogo: { fit: 'y', size: 3.5, anchor: [0.5, 0.98, 0.5], arm: ARM_DOWN, icon: { yaw: 0, tilt: 0.3, roll: Q / 2 } },              // upright, held by the handlebar, the stick down out of view
  hook: { fit: 'z', size: 1.15, anchor: [0.5, 0.5, 0.5], arm: ARM_DOWN, icon: { yaw: POINT_RIGHT, tilt: 0.3, roll: 0.35 } },      // a grapple launcher, the claw in its mouth
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
  fire: '#ff8a2a', lamp: '#f4f8ff', cloth: '#5b4630', pitch: '#2a211b', leather: '#4e3322', leatherDark: '#2f1f15',
  glass: '#cdeef6', cork: '#a87b4f', laser: '#ff3a30',
};
const UNLIT = new Set(['glow', 'screen', 'flame', 'spark', 'fire', 'lamp', 'laser']);
// unlit parts that are light sources, drawn this many times brighter than white so they glow (HDR, before the tone curve)
const GLOW_GAIN = { fire: 1.4, lamp: 5 };
// see-through parts: their opacity (the flask's glass shows what it holds)
const SEE_THROUGH = { glass: 0.3 };

// shapes
const CHUNK = 1.35;          // thin parts (under CHUNK_BELOW units) are thickened this much: RS2's stubby proportions
const CHUNK_BELOW = 0.12;    // model units
const ROUND_SEGMENTS = 6;    // sides on a cylinder or sphere
const SPHERE_RINGS = 4;
const TORUS_SIDES = 3;       // around the tube
const TORUS_SEGMENTS = 8;    // around the ring
export const BUCKET_SIDES = 8;   // the pail's sides; the bucket's liquid disc matches them so it never pokes through
// the flask's bulb (model units; the part named 'bulb'): its contents are drawn inside it in its own frame
export const FLASK_BULB = { r: 0.22, sides: ROUND_SEGMENTS, rings: SPHERE_RINGS };

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
  flask: [
    { geo: 'sphere', r: FLASK_BULB.r, p: [0, -0.26, 0], m: 'glass', name: 'bulb' },
    { geo: 'cyl', rt: 0.06, rb: 0.08, h: 0.2, p: [0, -0.02, 0], m: 'glass' },
    { geo: 'torus', R: 0.065, tube: 0.02, p: [0, 0.08, 0], rot: [H, 0, 0], m: 'glass' },
    { geo: 'cyl', rt: 0.07, rb: 0.055, h: 0.09, p: [0, 0.12, 0], m: 'cork' },
  ],
  trowel: [
    { geo: 'cyl', r: 0.05, h: 0.4, p: [0, 0, 0.05], rot: [H, 0, 0], m: 'wood' },
    { geo: 'cyl', r: 0.06, h: 0.05, p: [0, 0, -0.17], rot: [H, 0, 0], m: 'ironDark' },
    { geo: 'box', s: [0.03, 0.03, 0.12], p: [0, -0.04, -0.23], rot: [0.6, 0, 0], m: 'ironDark' },
    { geo: 'plate', pts: [[0, 0], [0.18, 0.22], [0, 0.66], [-0.18, 0.22]], depth: 0.02, p: [0, -0.09, -0.27], rot: [-H, 0, 0], m: 'iron' },
  ],
  flamer: [
    { geo: 'cyl', r: 0.07, h: 0.9, p: [0, 0.22, -0.35], rot: [H, 0, 0], m: 'metal' },
    { geo: 'cyl', r: 0.1, h: 0.3, p: [0, 0.22, -0.7], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.05, h: 0.25, p: [0, 0.22, -0.95], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.07, h: 0.05, p: [0, 0.22, -1.08], rot: [H, 0, 0], m: 'metal' },
    { geo: 'sphere', r: 0.04, p: [0, 0.14, -1.06], m: 'fire', name: 'pilot' },
    { geo: 'cyl', r: 0.13, h: 0.55, p: [0, 0.0, -0.35], rot: [H, 0, 0], m: 'red' },
    { geo: 'cyl', r: 0.03, h: 0.2, p: [0, 0.12, -0.62], m: 'metalDark' },
    { geo: 'box', s: [0.08, 0.2, 0.1], p: [0, 0.07, -0.85], rot: [0.15, 0, 0], m: 'grip' },
    { geo: 'cyl', rt: 0, rb: 0.07, h: 0.4, p: [0, 0.22, -1.32], rot: [-H, 0, 0], m: 'fire', name: 'flame' },
    STOCK_GRIP,
  ],
  // a pitch torch: a tapered stave with a leather grip and an iron pommel, an iron cup at
  // its head holding a tarred rag bound with cord, burning down into glowing coals on top.
  // (The cone is the flame in the icon; in the world, lamp.js puts flame.js's live one at its foot.)
  torch: [
    { geo: 'cyl', rt: 0.05, rb: 0.038, h: 1.02, p: [0, 0.45, 0], m: 'wood' },
    { geo: 'cyl', r: 0.05, h: 0.05, p: [0, -0.08, 0], m: 'ironDark' },
    { geo: 'cyl', r: 0.047, h: 0.3, p: [0, 0.1, 0], m: 'leather' },
    { geo: 'torus', R: 0.048, tube: 0.012, p: [0, 0.26, 0], rot: [H, 0, 0], m: 'leatherDark' },
    { geo: 'torus', R: 0.048, tube: 0.012, p: [0, -0.04, 0], rot: [H, 0, 0], m: 'leatherDark' },
    { geo: 'cyl', r: 0.058, h: 0.05, p: [0, 0.82, 0], m: 'metalDark' },
    { geo: 'cyl', rt: 0.112, rb: 0.06, h: 0.15, p: [0, 0.93, 0], sides: 8, m: 'metalDark' },
    { geo: 'torus', R: 0.11, tube: 0.014, ring: 8, p: [0, 1.005, 0], rot: [H, 0, 0], m: 'iron' },
    { geo: 'cyl', rt: 0.09, rb: 0.1, h: 0.2, p: [0, 1.1, 0], sides: 8, m: 'pitch' },
    { geo: 'torus', R: 0.1, tube: 0.016, ring: 8, p: [0, 1.06, 0], rot: [H + 0.12, 0, 0.08], m: 'cloth' },
    { geo: 'torus', R: 0.096, tube: 0.016, ring: 8, p: [0, 1.15, 0], rot: [H - 0.1, 0, -0.06], m: 'cloth' },
    { geo: 'cyl', rt: 0.06, rb: 0.091, h: 0.07, p: [0, 1.235, 0], sides: 8, m: 'ember', name: 'coals' },
    { geo: 'cyl', rt: 0, rb: 0.1, h: 0.4, p: [0, 1.47, 0], m: 'fire', name: 'flame' },
  ],
  lantern: [
    { geo: 'torus', R: 0.1, tube: 0.02, p: [0, -0.06, 0], m: 'metalDark' },
    { geo: 'cyl', rt: 0.07, rb: 0.2, h: 0.1, p: [0, -0.2, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.15, h: 0.36, p: [0, -0.43, 0], m: 'lamp', name: 'glow' },
    { geo: 'box', s: [0.03, 0.38, 0.03], p: [0.17, -0.43, 0], m: 'metalDark' },
    { geo: 'box', s: [0.03, 0.38, 0.03], p: [-0.17, -0.43, 0], m: 'metalDark' },
    { geo: 'box', s: [0.03, 0.38, 0.03], p: [0, -0.43, 0.17], m: 'metalDark' },
    { geo: 'box', s: [0.03, 0.38, 0.03], p: [0, -0.43, -0.17], m: 'metalDark' },
    { geo: 'cyl', r: 0.2, h: 0.08, p: [0, -0.65, 0], m: 'metalDark' },
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
  knife: [
    { geo: 'cyl', r: 0.05, h: 0.36, p: [0, 0, 0.08], rot: [H, 0, 0], m: 'grip' },
    { geo: 'cyl', r: 0.055, h: 0.03, p: [0, 0, 0.27], rot: [H, 0, 0], m: 'ironDark' },
    { geo: 'box', s: [0.16, 0.05, 0.04], p: [0, 0.01, -0.11], m: 'ironDark' },
    // the blade: spine on top, edge curving up to the point
    { geo: 'plate', pts: [[0, -0.045], [0, 0.05], [0.42, 0.045], [0.55, 0], [0.45, -0.045]], depth: 0.02, p: [0, 0.01, -0.13], rot: [0, H, 0], m: 'iron' },
  ],
  pogo: [
    { geo: 'cyl', r: 0.035, h: 0.7, p: [0, 0, 0], rot: [0, 0, H], m: 'grip' },
    { geo: 'cyl', r: 0.05, h: 1.5, p: [0, -0.75, 0], m: 'red' },
    { geo: 'box', s: [0.5, 0.04, 0.12], p: [0, -1.3, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.07, h: 0.4, p: [0, -1.55, 0], m: 'ironDark' },
    { geo: 'cyl', r: 0.03, h: 0.35, p: [0, -1.9, 0], m: 'iron' },
    { geo: 'cyl', r: 0.06, h: 0.06, p: [0, -2.08, 0], m: 'grip' },
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
  laser: [
    { geo: 'box', s: [0.22, 0.26, 1.3], p: [0, 0.22, -0.35], m: 'metalDark' },
    { geo: 'box', s: [0.14, 0.1, 0.5], p: [0, 0.4, -0.15], m: 'metal' },
    { geo: 'cyl', r: 0.06, h: 0.06, p: [0, 0.4, -0.42], rot: [H, 0, 0], m: 'laser' },
    { geo: 'cyl', r: 0.08, h: 0.45, p: [0, 0.22, -1.2], rot: [H, 0, 0], m: 'metal' },
    { geo: 'cyl', r: 0.12, h: 0.1, p: [0, 0.22, -1.45], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'box', s: [0.235, 0.05, 0.9], p: [0, 0.22, -0.4], m: 'laser', name: 'charge' },
    { geo: 'box', s: [0.1, 0.22, 0.12], p: [0, 0.0, -0.6], rot: [0.15, 0, 0], m: 'grip' },
    STOCK_GRIP,
  ],
  burrower: [
    { geo: 'cyl', r: 0.15, h: 1.0, p: [0, 0.3, -0.25], rot: [H, 0, 0], m: 'orange' },
    { geo: 'cyl', r: 0.18, h: 0.12, p: [0, 0.3, -0.76], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.18, h: 0.12, p: [0, 0.3, 0.25], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', rt: 0, rb: 0.14, h: 0.4, p: [0, 0.3, -1.02], rot: [-H, 0, 0], m: 'iron', name: 'bit' },
    { geo: 'box', s: [0.1, 0.22, 0.12], p: [0, 0.1, -0.45], rot: [0.15, 0, 0], m: 'grip' },
    STOCK_GRIP,
  ],
  drill: [
    { geo: 'cyl', rt: 0, rb: 0.5, h: 0.7, p: [0, 0, -0.55], rot: [-H, 0, 0], m: 'iron', name: 'bit' },
    ...FINS.map((a) => ({ geo: 'box', s: [0.05, 0.36, 0.45], p: [Math.sin(a) * 0.22, Math.cos(a) * 0.22, -0.48], rot: [0.5, 0, -a], m: 'ironDark' })),
    { geo: 'cyl', r: 0.44, h: 0.4, p: [0, 0, 0], rot: [H, 0, 0], m: 'orange' },
    { geo: 'cyl', r: 0.36, h: 0.12, p: [0, 0, 0.26], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'sphere', r: 0.15, p: [0, 0, 0.36], m: 'spark' },
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
  // the hook (hook.tool.js): a stubby launcher with a spool of rope under it and a three-pronged
  // claw in its mouth; the claw's parts are named, so the tool hides them while the claw is out
  hook: [
    { geo: 'cyl', r: 0.09, h: 0.62, p: [0, 0.16, -0.25], rot: [H, 0, 0], m: 'metal' },
    { geo: 'cyl', r: 0.12, h: 0.14, p: [0, 0.16, 0.08], rot: [H, 0, 0], m: 'metalDark' },
    { geo: 'cyl', r: 0.11, h: 0.18, p: [0, -0.02, -0.28], rot: [0, 0, H], m: 'cloth' },
    { geo: 'cyl', r: 0.13, h: 0.04, p: [0.1, -0.02, -0.28], rot: [0, 0, H], m: 'metalDark' },
    { geo: 'cyl', r: 0.13, h: 0.04, p: [-0.1, -0.02, -0.28], rot: [0, 0, H], m: 'metalDark' },
    { geo: 'cyl', r: 0.03, h: 0.3, p: [0, 0.16, -0.66], rot: [H, 0, 0], m: 'iron', name: 'claw' },
    ...FINS.map((a) => ({ geo: 'box', s: [0.03, 0.03, 0.2], p: [Math.sin(a) * 0.07, 0.16 + Math.cos(a) * 0.07, -0.76], rot: [Math.cos(a) * 0.7, -Math.sin(a) * 0.7, 0], m: 'iron', name: 'claw' })),
    STOCK_GRIP,
  ],
};

// Glowing coals (the torch's head): charred black, its cracks glowing orange and slowly
// shifting, in linear HDR like the other light sources. Unlit; one material, one clock.
const EMBER_SCALE = 34;               // noise cells per model unit
const EMBER_DRIFT = [0.25, 0.4];      // the cracks' drift, noise cells/s (up, through)
const EMBER_HOT = [4.2, 1.1, 0.16];   // linear HDR, the hottest crack
const EMBER_CHAR = [0.035, 0.022, 0.016];
const emberTime = { value: 0 };
function emberMaterial() {
  const v3 = (c) => `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`;
  return new THREE.ShaderMaterial({
    uniforms: { uTime: emberTime },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vPos;
      float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n3(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
      void main() {
        vec3 q = vPos * ${EMBER_SCALE.toFixed(1)} + vec3(0.0, -uTime * ${EMBER_DRIFT[0].toFixed(2)}, uTime * ${EMBER_DRIFT[1].toFixed(2)});
        float n = 0.65 * n3(q) + 0.35 * n3(q * 2.3 + 5.0);
        float crack = smoothstep(0.5, 0.78, n);
        float pulse = 0.75 + 0.25 * n3(vec3(uTime * 2.0, 3.0, 1.0));
        gl_FragColor = vec4(mix(${v3(EMBER_CHAR)}, ${v3(EMBER_HOT)} * pulse, crack * crack), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

const materials = new Map();   // COLORS key → material, shared by every model
function material(key) {
  if (key === 'ember') {
    if (!materials.has(key)) materials.set(key, emberMaterial());
    return materials.get(key);
  }
  if (!materials.has(key)) {
    const color = jagexColor(COLORS[key]).multiplyScalar(GLOW_GAIN[key] ?? 1);
    const see = SEE_THROUGH[key] ? { transparent: true, opacity: SEE_THROUGH[key], depthWrite: false } : {};
    materials.set(key, UNLIT.has(key)
      ? new THREE.MeshBasicMaterial({ color })
      : new THREE.MeshLambertMaterial({ color, flatShading: true, ...see }));
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
    if (p.m === 'ember') m.onBeforeRender = () => { emberTime.value = performance.now() / 1000; };
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
