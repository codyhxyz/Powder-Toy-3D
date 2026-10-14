import * as THREE from 'three';
import { ITEMS } from './catalog.js';

// Baked directional vertex shading matches the village's unlit voxel scene.
// Each mesh owns its resources: the existing models.dispose traversal is safe.
function mesh(p, geometry, color, at, scale = [1, 1, 1]) {
  const c = new THREE.Color(color), n = geometry.attributes.normal, colors = [];
  const light = new THREE.Vector3(-0.4, 0.8, -0.5).normalize();
  for (let i = 0; i < n.count; i++) {
    const k = 0.72 + 0.28 * Math.max(0, n.getX(i) * light.x + n.getY(i) * light.y + n.getZ(i) * light.z);
    colors.push(c.r * k, c.g * k, c.b * k);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
  m.position.set(...at); m.scale.set(...scale); m.renderOrder = 1; p.add(m);
  return m;
}
const box = (p, c, at, size) => mesh(p, new THREE.BoxGeometry(1, 1, 1), c, at, size);
const ball = (p, c, at, size) => mesh(p, new THREE.SphereGeometry(1, 12, 8), c, at, size);
const cyl = (p, c, at, top, bottom, h) => mesh(p, new THREE.CylinderGeometry(top, bottom, h, 12), c, at);
const cream = '#f5e6bf', dark = '#4d5447', metal = '#bac4bd';
function rod(p, c, a, b, r = 0.09) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.sub(start);
  const m = cyl(p, c, start.addScaledVector(delta, 0.5).toArray(), r, r, delta.length());
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return m;
}
function post(p, t, c, x, z, h, bottom = 0) {
  if (t === 'cottage') {
    cyl(p, c, [x, bottom + h / 2, z], 0.09, 0.13, h);
    for (const f of [0.2, 0.7]) ball(p, c, [x, bottom + h * f, z], [0.17, 0.15, 0.17]);
  } else if (t === 'botanical') {
    cyl(p, c, [x, bottom + 0.04, z], 0.12, 0.14, 0.08);
    rod(p, c, [x, bottom + 0.06, z], [x * 0.85, bottom + h, z * 0.85], 0.12);
    rod(p, c, [x * 0.85, bottom + h * 0.6, z * 0.85], [x * 0.6, bottom + h, z * 0.6], 0.07);
  } else {
    box(p, c, [x, bottom + h / 2, z], [0.2, h, 0.2]);
    if (t === 'workshop') {
      box(p, dark, [x, bottom + 0.08, z], [0.34, 0.16, 0.34]);
      ball(p, metal, [x, bottom + h - 0.18, z - 0.11], [0.065, 0.065, 0.045]);
    }
  }
}
function legs(p, i, h, w = i.w, d = i.d) {
  for (const x of [-w / 2 + 0.25, w / 2 - 0.25])
    for (const z of [-d / 2 + 0.25, d / 2 - 0.25]) post(p, i.theme, i.color, x, z, h);
}
// Shared themed panels are structural: spindle rails, woven leaves, or metal braces.
function panel(p, i, w, h, y, z) {
  const c = i.color;
  if (i.theme === 'botanical') {
    for (let j = -2; j <= 2; j++) {
      const leaf = ball(p, c, [j * w * 0.15, y, z], [w * 0.13, h * 0.43, 0.12]);
      leaf.rotation.z = -j * 0.06;
    }
    for (const dy of [-0.22, 0, 0.22]) rod(p, cream, [-w * 0.43, y + dy, z - 0.13], [w * 0.43, y + dy, z - 0.13], 0.035);
  } else if (i.theme === 'cottage') {
    for (const dy of [-h / 2 + 0.1, h / 2 - 0.1]) box(p, c, [0, y + dy, z], [w, 0.2, 0.22]);
    for (let j = -2; j <= 2; j++) post(p, 'cottage', c, j * w * 0.19, z, h - 0.2, y - h / 2 + 0.1);
  } else if (i.theme === 'workshop') {
    for (const x of [-w / 2 + 0.12, w / 2 - 0.12]) box(p, c, [x, y, z], [0.24, h, 0.22]);
    rod(p, metal, [-w / 2 + 0.12, y - h / 2 + 0.1, z], [w / 2 - 0.12, y + h / 2 - 0.1, z], 0.1);
    rod(p, metal, [w / 2 - 0.12, y - h / 2 + 0.1, z], [-w / 2 + 0.12, y + h / 2 - 0.1, z], 0.1);
  } else box(p, c, [0, y, z], [w, h, 0.25]);
}
function seat(p, i) {
  legs(p, i, 1.45);
  box(p, i.color, [0, 1.45, 0], [i.w - 0.12, 0.3, i.d - 0.12]);
  if (i.theme === 'botanical') ball(p, cream, [0, 1.6, -0.05], [i.w * 0.44, 0.15, i.d * 0.43]);
  else box(p, cream, [0, 1.65, -0.05], [i.w - 0.35, 0.2, i.d - 0.4]);
  panel(p, i, i.w - 0.35, i.h - 1.85, (i.h + 1.75) / 2 - 0.05, i.d / 2 - 0.25);
  if (i.family === 'sofa') for (const x of [-i.w / 2 + 0.25, i.w / 2 - 0.25]) {
    if (i.theme === 'classic') ball(p, i.color, [x, 1.8, 0], [0.25, 0.65, i.d / 2]);
    else rod(p, i.color, [x, 2.1, -i.d / 2 + 0.2], [x, 2.1, i.d / 2 - 0.2], 0.18);
  }
}
function bed(p, i, y = 0) {
  if (!y) legs(p, i, 1.2);
  box(p, i.color, [0, y + 1.2, 0], [3.9, 0.4, 5.9]);
  box(p, cream, [0, y + 1.55, 0], [3.7, 0.3, 5.7]);
  box(p, i.color, [0, y + 1.725, -0.8], [3.72, 0.05, 4]);
  for (const x of [-0.95, 0.95]) ball(p, cream, [x, y + 1.84, 1.95], [0.8, 0.2, 0.6]);
  if (!y) panel(p, i, 3.8, i.family === 'bunk' ? 1.6 : i.h - 1.4,
    i.family === 'bunk' ? 2.1 : (i.h + 1.4) / 2, 2.8);
}
function table(p, i) {
  if (i.theme === 'classic') {
    cyl(p, i.color, [0, 2.4, 0], 2, 2, 0.3);
    cyl(p, dark, [0, 1.2, 0], 0.25, 0.4, 2.4);
    cyl(p, i.color, [0, 0.15, 0], 1.2, 1.2, 0.3);
  } else if (i.theme === 'botanical') {
    cyl(p, dark, [0, 1.2, 0], 0.3, 0.65, 2.4);
    for (let j = 0; j < 6; j++) {
      const a = j * Math.PI / 3;
      ball(p, i.color, [Math.cos(a) * 0.95, 2.4, Math.sin(a) * 0.95], [0.95, 0.18, 0.95]);
    }
  } else {
    legs(p, i, 2.4);
    box(p, i.color, [0, 2.5, 0], [3.95, 0.25, 3.95]);
    if (i.theme === 'workshop') {
      box(p, dark, [0, 0.7, 0], [3.5, 0.15, 3.5]);
      for (const x of [-1.7, 1.7]) for (const z of [-1.7, 1.7]) cyl(p, metal, [x, 2.65, z], 0.08, 0.08, 0.04);
    }
  }
}
function lamp(p, i) {
  cyl(p, dark, [0, 0.12, 0], 0.7, 0.8, 0.24);
  post(p, i.theme, i.color, 0, 0, 3.4);
  if (i.theme === 'botanical') {
    for (let j = 0; j < 6; j++) {
      const a = j * Math.PI / 3;
      ball(p, i.color, [Math.cos(a) * 0.5, 3.65, Math.sin(a) * 0.5], [0.4, 0.5, 0.4]);
    }
  } else if (i.theme === 'workshop') {
    cyl(p, i.color, [0, 3.8, 0], 0.35, 0.85, 0.65);
    for (const x of [-0.5, 0.5]) rod(p, metal, [x, 3.15, 0], [x, 3.65, 0], 0.05);
    box(p, metal, [0, 3.15, 0], [1.15, 0.1, 0.5]);
  } else cyl(p, i.color, [0, 3.6, 0], 0.55, 1, 1.2);
  ball(p, cream, [0, 3.4, 0], [0.28, 0.28, 0.28]);
}
function plant(p, i) {
  if (i.theme === 'workshop') {
    box(p, i.color, [0, 0.6, 0], [1.6, 1.2, 1.6]);
    for (const x of [-0.65, 0.65]) ball(p, metal, [x, 0.9, -0.82], [0.06, 0.06, 0.04]);
  } else cyl(p, i.theme === 'botanical' ? cream : '#c98763', [0, 0.6, 0], 0.8, 0.55, 1.2);
  if (i.theme === 'cottage') for (const y of [0.3, 0.9]) cyl(p, i.color, [0, y, 0], 0.74, 0.69, 0.1);
  cyl(p, dark, [0, 1.2, 0], 0.68, 0.68, 0.05);
  rod(p, dark, [0, 1.2, 0], [0, 2.9, 0]);
  const count = i.theme === 'botanical' ? 8 : i.theme === 'workshop' ? 3 : 5;
  for (let j = 0; j < count; j++) {
    const a = j * Math.PI * 2 / count, y = 1.9 + j * 0.1;
    ball(p, '#568c61', [Math.cos(a) * 0.4, y, Math.sin(a) * 0.4], [0.4, 0.55, 0.25]);
    if (i.theme === 'botanical') ball(p, '#e9b5b1', [Math.cos(a) * 0.45, y + 0.45, Math.sin(a) * 0.45], [0.2, 0.2, 0.2]);
  }
}
function shelf(p, i) {
  legs(p, i, 4.8);
  for (const y of [0.3, 1.8, 3.3, 4.8]) box(p, i.color, [0, y, 0], [3.95, 0.2, 1.95]);
  panel(p, i, 3.5, 4.2, 2.5, 0.78);
  for (let j = 0; j < 4; j++) box(p, j % 2 ? cream : dark, [-1.2 + j * 0.42, 2.3, 0], [0.3, 0.8, 0.6]);
}
function desk(p, i) {
  legs(p, i, 2.4);
  box(p, i.color, [0, 2.5, 0], [3.95, 0.2, 1.95]);
  panel(p, i, 3.5, 0.7, 2.95, 0.8);
  if (i.theme === 'workshop') {
    box(p, dark, [-1.2, 2.8, -0.3], [0.6, 0.4, 0.5]);
    rod(p, metal, [-1.6, 3, -0.3], [-0.75, 3, -0.3], 0.08);
  } else if (i.theme === 'botanical') ball(p, cream, [1.2, 2.8, 0.1], [0.4, 0.2, 0.35]);
  else box(p, cream, [0, 2.64, -0.25], [1.3, 0.08, 0.8]);
}
function dresser(p, i) {
  legs(p, i, 0.5);
  // Open carcass, not a solid block: the animated drawer reveals a real cavity.
  for (const x of [-1.85, 1.85]) box(p, i.color, [x, 1.95, 0], [0.3, 3.1, 2.9]);
  box(p, i.color, [0, 1.95, 1.35], [3.6, 3.1, 0.2]);
  box(p, i.color, [0, 3.5, 0], [4, 0.3, 3]);
  for (const y of [0.55, 1.5, 2.45]) box(p, dark, [0, y, 0], [3.6, 0.1, 2.8]);
  for (const y of [0.95, 1.9, 2.85]) {
    const drawer = new THREE.Group(); p.add(drawer); drawer.position.y = y;
    box(drawer, '#d7ab76', [0, 0, -1.32], [3.4, 0.8, 0.16]);
    box(drawer, dark, [0, -0.35, 0], [3.3, 0.1, 2.6]);
    for (const x of [-1.6, 1.6]) box(drawer, i.color, [x, 0, 0], [0.1, 0.7, 2.6]);
    for (const x of [-0.9, 0.9]) ball(drawer, dark, [x, 0, -1.43], [0.09, 0.09, 0.06]);
    if (y === 2.85) { p.userData.drawer = drawer; drawer.name = 'sliding-drawer'; }
  }
}
const builders = {
  chair: seat, sofa: seat, bed, table, lamp, plant, shelf, desk, dresser,
  rocker(p, i) {
    seat(p, { ...i, w: 2.3, d: 2.5, h: 3.5 });
    for (const x of [-1.15, 1.15]) {
      const points = [];
      for (let j = 0; j <= 12; j++) { const z = -1.8 + j * 0.3; points.push(new THREE.Vector3(x, 0.11 + z * z * 0.1, z)); }
      mesh(p, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.1, 6, false), i.color, [0, 0, 0]);
      rod(p, i.color, [x, 2.2, -0.9], [x, 2.2, 0.9], 0.12);
    }
  },
  bunk(p, i) {
    bed(p, i); bed(p, i, 3);
    legs(p, i, 5.8);
    panel(p, i, 3.5, 0.8, 5.4, 2.75);
    for (const x of [-1.5, -0.6]) rod(p, metal, [x, 0.1, -2.85], [x, 5.6, -2.85], 0.08);
    for (let y = 0.5; y < 5.6; y += 0.7) rod(p, metal, [-1.5, y, -2.85], [-0.6, y, -2.85], 0.08);
  },
  stool(p, i) {
    cyl(p, cream, [0, 0.7, 0], 0.3, 0.55, 1.4);
    ball(p, i.color, [0, 1.45, 0], [0.95, 0.3, 0.95]);
    for (const x of [-0.4, 0.4]) ball(p, cream, [x, 1.68, -0.1], [0.16, 0.04, 0.16]);
  },
  clock(p, i) {
    box(p, i.color, [0, 2.8, 0.15], [1.65, 5.6, 1.5]);
    box(p, dark, [0, 2.3, -0.62], [1.2, 3.2, 0.1]);
    rod(p, '#d9b65f', [0, 3.6, -0.73], [0, 1.2, -0.73], 0.05);
    ball(p, '#d9b65f', [0, 1.2, -0.75], [0.35, 0.35, 0.08]);
    const face = cyl(p, cream, [0, 4.65, -0.7], 0.65, 0.65, 0.12); face.rotation.x = Math.PI / 2;
    rod(p, dark, [0, 4.65, -0.8], [0, 5.1, -0.8], 0.035);
    rod(p, dark, [0, 4.65, -0.8], [0.3, 4.5, -0.8], 0.035);
    ball(p, i.color, [0, 5.55, 0.1], [0.85, 0.45, 0.75]);
  },
  aquarium(p, i) {
    legs(p, i, 2);
    box(p, dark, [0, 1.9, 0], [3.9, 0.2, 1.9]);
    // Opaque rear water panel keeps the unlit renderer's transparency ordering safe.
    box(p, '#78b8bc', [0, 3.15, 0.85], [3.6, 2.3, 0.1]);
    for (const y of [2.1, 4.35]) box(p, i.color, [0, y, 0], [3.95, 0.2, 1.95]);
    for (const x of [-1.85, 1.85]) for (const z of [-0.85, 0.85]) rod(p, metal, [x, 2.2, z], [x, 4.3, z], 0.07);
    for (const x of [-0.9, 0.7]) {
      ball(p, '#edba65', [x, 3.2, 0], [0.4, 0.2, 0.15]);
      const tail = mesh(p, new THREE.ConeGeometry(0.23, 0.35, 3), '#dd8861', [x + 0.4, 3.2, 0]); tail.rotation.z = Math.PI / 2;
    }
    for (const x of [-1.4, 1.4]) rod(p, '#568c61', [x, 2.2, 0.4], [x - 0.2, 3.1, 0.4], 0.08);
  },
  bureau(p, i) {
    legs(p, i, 2.4);
    box(p, i.color, [0, 2.5, 0], [3.95, 0.25, 2.95]);
    for (const x of [-1.8, 1.8]) box(p, i.color, [x, 3.2, 0.5], [0.25, 1.4, 1.75]);
    box(p, dark, [0, 3.3, 1.3], [3.4, 1.5, 0.15]);
    for (let j = 0; j < 9; j++) {
      const a = j * Math.PI / 16;
      const slat = box(p, i.color, [0, 3.4 + Math.sin(a) * 0.95, 0.3 + Math.cos(a) * 0.95], [3.5, 0.12, 0.2]);
      slat.rotation.x = -a;
    }
    box(p, cream, [0, 2.67, -0.65], [1.3, 0.08, 0.7]);
  },
};
export function furniture(kind) {
  const item = ITEMS[kind];
  if (!item) throw new RangeError(`Unknown village furniture: ${kind}`);
  const root = new THREE.Group();
  root.name = `village-${kind}`;
  root.userData.family = item.family;
  root.userData.theme = item.theme;
  if (item.seatHeight !== undefined) root.userData.seatHeight = item.seatHeight;
  if (item.lyingHeight !== undefined) root.userData.lyingHeight = item.lyingHeight;
  builders[item.family](root, item);
  return root;
}
