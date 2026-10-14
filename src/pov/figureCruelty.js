import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { part } from './figure.js';

// Cruelty Squad's deliberately repellent corporate/body-horror palette, not
// replicas of its copyrighted models. Same feet/5.5-cell hitbox and weapon rig.
const PALETTES = {
  uniform: [[0.55, 0.015, 0.24], [0.08, 0.2, 0.015], [0.62, 0.7, 0.11]],
  armor: [[0.09, 0.02, 0.27], [0.56, 0.025, 0.38], [0.29, 0.64, 0.12]],
  security: [[0.68, 0.55, 0.015], [0.055, 0.015, 0.12], [0.72, 0.18, 0.4]],
  police: [[0.035, 0.1, 0.48], [0.43, 0.02, 0.14], [0.63, 0.65, 0.16]],
  riot: [[0.055, 0.07, 0.21], [0.68, 0.08, 0.015], [0.24, 0.65, 0.32]],
  mask: [[0.16, 0.015, 0.14], [0.46, 0.54, 0.035], [0.75, 0.055, 0.32]],
  mutant: [[0.5, 0.12, 0.015], [0.31, 0.018, 0.19], [0.28, 0.62, 0.035]],
  civilian: [[0.54, 0.025, 0.6], [0.19, 0.49, 0.025], [0.76, 0.45, 0.17]],
  executive: [[0.27, 0.012, 0.42], [0.52, 0.58, 0.015], [0.71, 0.17, 0.34]],
};
const BLACK = [0.008, 0.004, 0.014], TEETH = [0.75, 0.8, 0.28], EYES = [0.9, 0.7, 0.65];
export function buildCruelty({ outfit = 'uniform', variant = 0 } = {}) {
  const [suit, accent, skin] = PALETTES[outfit] ?? PALETTES.uniform;
  const body = new THREE.Group(), torso = new THREE.Group(), neck = new THREE.Group();
  body.add(torso);
  const box = (parent, name, size, at, color) => {
    const mesh = part(parent, new THREE.BoxGeometry(...size).translate(...at), color);
    mesh.name = name; return mesh;
  };
  box(torso, 'corporate-jacket', [1.12, 1.75, 0.66], [0, 0.83, 0], suit);
  box(torso, 'shirt-panel', [0.45, 1.3, 0.05], [0, 0.95, -0.355], accent);
  box(torso, 'tie', [0.12, 0.95, 0.06], [0.04, 1.05, -0.4], BLACK);
  box(torso, 'employee-badge', [0.21, 0.16, 0.06], [-0.35, 1.35, -0.4], TEETH);
  box(torso, 'belt', [1.16, 0.14, 0.7], [0, 0.12, 0], BLACK);
  if (['armor', 'riot', 'security'].includes(outfit)) {
    box(torso, 'ballistic-vest', [1.18, 0.75, 0.12], [0, 0.9, -0.43], accent);
    for (const x of [-0.37, 0, 0.37]) box(torso, 'vest-pouch', [0.24, 0.3, 0.12], [x, 0.55, -0.46], BLACK);
  }
  if (outfit === 'civilian') for (const y of [0.5, 0.85, 1.2]) box(torso, 'toxic-shirt-stripe', [1.12, 0.12, 0.06], [0, y, -0.37], accent);
  neck.position.y = 2;
  torso.add(neck);
  box(neck, 'angular-skull', [0.96, 1.05, 0.84], [0, 0.625, 0], skin);
  // Misaligned bulging eyes, a crooked nose and exposed rectangular teeth.
  for (const side of [-1, 1]) {
    const y = 0.76 + side * (0.025 + (variant % 3) * 0.02);
    box(neck, 'eye-socket', [0.38, 0.33, 0.09], [side * 0.25, y, -0.455], accent);
    box(neck, 'eye-white', [0.29, 0.23, 0.07], [side * 0.25, y, -0.52], EYES);
    box(neck, 'pinpoint-pupil', [0.075, 0.14, 0.045], [side * 0.23, y, -0.575], BLACK);
  }
  box(neck, 'crooked-nose', [0.19, 0.33, 0.21], [0.045, 0.56, -0.48], skin);
  box(neck, 'grin-cavity', [0.7, 0.24, 0.07], [0, 0.28, -0.465], BLACK);
  for (let i = 0; i < 6; i++) box(neck, 'uneven-tooth', [0.085, i % 2 ? 0.12 : 0.16, 0.045], [-0.26 + i * 0.105, 0.3, -0.525], TEETH);
  if (['mask', 'riot'].includes(outfit)) {
    box(neck, 'respirator', [0.72, 0.4, 0.17], [0, 0.32, -0.52], accent);
    for (const side of [-1, 1]) box(neck, 'filter', [0.21, 0.24, 0.17], [side * 0.36, 0.3, -0.53], BLACK);
  }
  if (['police', 'riot', 'security'].includes(outfit)) {
    box(neck, 'flat-cap', [1.1, 0.18, 1.01], [0, 1.06, -0.03], suit);
    box(neck, 'cap-badge', [0.18, 0.14, 0.04], [0, 1.06, -0.555], TEETH);
  }
  if (outfit === 'mutant') {
    box(neck, 'temple-growth', [0.25, 0.48, 0.4], [0.52, 0.62, 0], accent);
    box(torso, 'exposed-ribs', [0.58, 0.6, 0.08], [0.1, 0.9, -0.39], skin);
  }
  const joint = (parent, name, x, y, len, width, color) => {
    const g = new THREE.Group(); g.position.set(x, y, 0); parent.add(g);
    box(g, name, [width, len, width], [0, -len / 2, 0], color); return g;
  };
  const shL = joint(torso, 'sleeve', -0.6, 1.65, 0.9, 0.34, suit);
  const shR = joint(torso, 'sleeve', 0.6, 1.65, 0.9, 0.34, suit);
  const elL = joint(shL, 'forearm', 0, -0.9, 0.9, 0.3, suit);
  const elR = joint(shR, 'forearm', 0, -0.9, 0.9, 0.3, suit);
  for (const el of [elL, elR]) box(el, 'hand', [0.32, 0.26, 0.34], [0, -0.9, 0], skin);
  const hipL = joint(body, 'trousers', -0.3, 0, 1.15, 0.44, suit);
  const hipR = joint(body, 'trousers', 0.3, 0, 1.15, 0.44, suit);
  const knL = joint(hipL, 'shin', 0, -1.15, 1.05, 0.38, accent);
  const knR = joint(hipR, 'shin', 0, -1.15, 1.05, 0.38, accent);
  for (const kn of [knL, knR]) box(kn, 'square-shoe', [0.48, 0.28, 0.7], [0, -1.06, -0.12], BLACK);
  // A face's teeth/eyes move together: batch by joint/color, not a draw per tooth.
  for (const parent of [body, torso, neck, shL, shR, elL, elR, hipL, hipR, knL, knR]) {
    const batches = new Map();
    for (const mesh of parent.children) {
      if (!mesh.isMesh || ['ballistic-vest', 'respirator'].includes(mesh.name)) continue;
      const key = mesh.userData.albedo.join(',');
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(mesh);
    }
    for (const meshes of batches.values()) {
      if (meshes.length < 2) continue;
      const merged = mergeGeometries(meshes.map(m => m.geometry));
      for (const mesh of meshes) mesh.geometry.dispose();
      meshes[0].geometry = merged;
      for (const mesh of meshes.slice(1)) parent.remove(mesh);
    }
  }
  return { body, torso, neck, shL, shR, elL, elR, hipL, hipR, knL, knR,
    hipY: 2.35, lieLift: 0.45, thigh: 1.15, shin: 1.05, upperArm: 0.9, forearm: 0.9, handY: -0.9 };
}
