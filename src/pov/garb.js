import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildBarrel } from './barrel.js';
import { buildBeard } from './beard.js';

// The wizard's hat for the realistic body (figureReal.js): a lathe (brim and
// cone, the tip bent back), built once per loaded model, seated on the head and
// skinned wholly to the head bone, so every clip (walk, swim, death...) carries
// it. Below it he wears only his boxers, dyed the hat's purple when the model is
// packed (tools/character-pack.mjs): wizard boxers. She stands in a barrel
// (barrel.js: oak staves, iron hoops), skinned to the spine so it walks with her.
//
// Lengths are in model units (metres); the body's own scale takes them to cells.

const HEAD_BONE = 'Head';

// hat (sizes as multiples of the head's half-width)
const HAT_BRIM = 2.0;                    // brim radius
const HAT_BRIM_DROOP = 0.015;            // m: the brim's edge hangs this much lower
const HAT_BRIM_THICK = 0.012;            // m
const HAT_BASE = 1.08;                   // cone base radius
const HAT_HEIGHT = 2.6;                  // cone height
const HAT_BEND = 0.45;                   // the tip leans back this share of the height
const HAT_SEAT = 0.4;                    // brim sits this share of the head's height down from its top
const HAT_TILT = 0.12;                   // rad back
const HAT_RINGS = 14, HAT_SEGMENTS = 28;

export const GARB_COLORS = {
  hat: [0.16, 0.06, 0.35],
  robe: [0.40, 0.20, 0.07],   // oak staves
  hoops: [0.16, 0.15, 0.14],  // iron
  bung: [0.33, 0.18, 0.08],   // cork
  bag: [0.62, 0.50, 0.32],    // grocery-bag paper
  marker: [0.04, 0.05, 0.16], // blue Sharpie
};   // albedo, linear

// Every body vertex in the bind pose, with its skin influences and its main bone.
function bodyVertices(meshes) {
  const out = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    const bones = m.skeleton.bones;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.bindMatrix);
      const idx = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)];
      const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
      const main = idx[w.indexOf(Math.max(...w))];
      out.push({ x: v.x, y: v.y, z: v.z, idx, w, bone: bones[main].name });
    }
  }
  return out;
}

function buildHat(verts, boneIndex) {
  const head = verts.filter((p) => p.bone === HEAD_BONE);
  let x1 = 0, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of head) {
    x1 = Math.max(x1, Math.abs(p.x)); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  const hr = x1, H = HAT_HEIGHT * hr;
  // the profile from the brim's underside out, over the top and up the cone to the tip
  const profile = [
    [HAT_BASE * hr * 0.95, 0], [HAT_BRIM * hr, -HAT_BRIM_DROOP], [HAT_BRIM * hr, HAT_BRIM_THICK - HAT_BRIM_DROOP],
    [HAT_BASE * hr, HAT_BRIM_THICK * 2],
  ];
  for (let i = 1; i <= HAT_RINGS; i++) {
    const t = i / HAT_RINGS;
    profile.push([HAT_BASE * hr * (1 - t) ** 1.15, HAT_BRIM_THICK * 2 + t * H]);
  }
  const geo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), HAT_SEGMENTS);
  // bend the tip back (the body faces +z), seat it on the head
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(p.getY(i), 0) / H;
    p.setZ(i, p.getZ(i) - HAT_BEND * H * t ** 2.5);
  }
  geo.rotateX(-HAT_TILT);
  geo.translate(0, y1 - HAT_SEAT * (y1 - y0), (z0 + z1) / 2);

  const headBone = boneIndex(HEAD_BONE);
  const n = p.count;
  const skinIdx = new Array(n * 4).fill(0), skinW = new Array(n * 4).fill(0);
  for (let i = 0; i < n; i++) { skinIdx[i * 4] = headBone; skinW[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));
  geo.deleteAttribute('uv');
  return geo;
}

function skinTo(geo, index) {
  const n = geo.attributes.position.count;
  const skinIdx = new Array(n * 4).fill(0), skinW = new Array(n * 4).fill(0);
  const one = typeof index === 'function' ? null : index;
  for (let i = 0; i < n; i++) {
    skinIdx[i * 4] = one ?? index(i);
    skinW[i * 4] = 1;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));
  geo.deleteAttribute('uv');
  return geo;
}

// The hat's geometry, from the model's skinned meshes (bind pose). Skin indices
// refer to meshes[0].skeleton's bones.
export function buildGarb(meshes, { bag = false } = {}) {
  const { bones, boneInverses } = meshes[0].skeleton;
  const boneIndex = (name) => {
    const i = bones.findIndex((b) => b.name === name);
    if (i < 0) throw new Error(`the character model has no ${name} bone`);
    return i;
  };
  const bindPos = (name) => new THREE.Vector3().setFromMatrixPosition(boneInverses[boneIndex(name)].clone().invert());
  const verts = bodyVertices(meshes);
  const female = meshes.some((m) => m.material?.name === 'MI_Superhero_Female');
  const garb = {};
  if (bag) Object.assign(garb, buildPaperBag(verts, boneIndex));
  else garb.hat = buildHat(verts, boneIndex);
  if (female && !bag) Object.assign(garb, buildBarrel(verts, bindPos, boneIndex, skinTo));
  if (!female && !bag) garb.beard = buildBeard(verts, bindPos, boneIndex);   // the wizard's beard (beard.js): its own skeleton, rigged per body
  return garb;
}

// A grocery bag over the head, with a Sharpie face. Rigid on the head bone.
function buildPaperBag(verts, boneIndex) {
  const head = verts.filter((p) => p.bone === HEAD_BONE);
  let x1 = 0.08, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of head) {
    x1 = Math.max(x1, Math.abs(p.x));
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  const width = x1 * 2 + 0.05, depth = (z1 - z0) + 0.07, height = (y1 - y0) + 0.06;
  const bottom = y0 - 0.03, cz = (z0 + z1) / 2 + 0.012;
  const bag = new THREE.BoxGeometry(width, height, depth);
  bag.translate(0, bottom + height / 2, cz);
  const p = bag.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > bottom + height * 0.72) {
      p.setX(i, p.getX(i) * 0.9);
      p.setZ(i, p.getZ(i) * 0.9);
    }
  }
  bag.computeVertexNormals();
  const cuff = new THREE.BoxGeometry(width * 1.06, 0.018, depth * 1.06);
  cuff.translate(0, bottom + 0.01, cz);
  const paper = mergeGeometries([bag, cuff]);
  const front = cz + depth / 2 + 0.006;
  const eyeY = bottom + height * 0.58;
  const marker = mergeGeometries([
    ...stroke(ring(-width * 0.22, eyeY, front, width * 0.16, 8, 0.16), 0.011),
    ...stroke(ring(width * 0.24, eyeY + 0.008, front, width * 0.13, 7, 0.24), 0.01),
    ...stroke(smile(0, bottom + height * 0.32, front, width * 0.7), 0.01),
    ...stroke([[-width * 0.34, eyeY + width * 0.2, front], [-width * 0.08, eyeY + width * 0.26, front]], 0.008),
    ...stroke(star(width * 0.34, bottom + height * 0.38, front, width * 0.1), 0.007),
  ]);
  const headBone = boneIndex(HEAD_BONE);
  return { bag: skinTo(paper, headBone), marker: skinTo(marker, headBone) };
}

function ring(cx, cy, z, r, n, wobble) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = r * (1 + wobble * Math.sin(i * 2.1));
    pts.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr * 0.82, z]);
  }
  return pts;
}
function smile(cx, cy, z, w) {
  return [-1, -0.4, 0.15, 0.7, 1.15].map((t, i) => [
    cx + t * w * 0.45,
    cy - Math.abs(t) * w * 0.12 + (i % 2 ? 0.008 : -0.006),
    z,
  ]);
}
function star(cx, cy, z, r) {
  const pts = [[cx, cy + r, z]];
  for (let i = 1; i <= 5; i++) {
    const t = -Math.PI / 2 + i * (Math.PI * 4 / 5);
    pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r, z]);
  }
  return pts;
}
function stroke(points, width) {
  const geos = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = new THREE.Vector3(...points[i]), b = new THREE.Vector3(...points[i + 1]);
    const len = Math.max(0.004, a.distanceTo(b));
    const geo = new THREE.BoxGeometry(width, width * 0.55, len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
    geo.applyMatrix4(new THREE.Matrix4().compose(a.clone().lerp(b, 0.5), q, new THREE.Vector3(1, 1, 1)));
    geos.push(geo);
  }
  return geos;
}
