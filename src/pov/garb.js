import * as THREE from 'three';

// The wizard's clothes for the realistic body (figureReal.js): a pointed hat
// and a plain robe, built once per loaded model and skinned to its skeleton,
// so every clip (walk, swim, death...) moves them with the body.
//
// - The robe is a ring of ellipses fitted around the mannequin's bind pose
//   (arms left out), hanging straight from the hips and flaring to the hem.
//   Its skin weights are transferred from the nearest body vertices (inverse
//   distance over the K nearest, as Blender's Data Transfer does), and below
//   the hips they are blended toward the pelvis, so the skirt follows the legs
//   only part of the way instead of splitting into trousers.
// - The hat is a lathe (brim and cone, the tip bent back), seated on the head
//   and weighted wholly to the head bone.
//
// Lengths are in model units (metres); the body's own scale takes them to cells.

const ARM_BONE = /upperarm|lowerarm|hand|index|middle|pinky|ring|thumb/;  // left out of the robe's fit
const HEAD_BONE = 'Head', PELVIS_BONE = 'pelvis', HIP_BONE = 'thigh_l';

// robe
const ROBE_TOP = 1.47;                   // collar height
const ROBE_SHOULDER = 1.40;              // the ring that covers the shoulders
const ROBE_HEM = 0.3;                    // hem height: mid-shin
const ROBE_RINGS = 24, ROBE_SEGMENTS = 28;
const ROBE_BAND = 0.03;                  // ± height of body vertices fitted to each ring
const ROBE_MARGIN = 0.035;               // cloth stands this far off the body
const ROBE_COLLAR_R = 0.085;             // radius of the neck opening
const ROBE_FLARE = 0.16;                 // extra radius at the hem, ramped in from the hips
const ROBE_FRONT_SHIFT = 0.01;           // hem centre this far forward, so a stride clears the cloth
const SKIN_K = 6;                        // body vertices averaged per robe vertex
const SKIRT_PELVIS = 0.2;                // share of the hem's weight moved to the pelvis (0: follows the legs)
const MAX_INFLUENCES = 4;                // per vertex, as three's skinning takes

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

export const GARB_COLORS = { robe: [0.2, 0.08, 0.42], hat: [0.16, 0.06, 0.35] };   // albedo, linear

const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };

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

// The top MAX_INFLUENCES of a bone → weight map, normalized, as attribute rows.
function topInfluences(acc) {
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_INFLUENCES);
  const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  while (top.length < MAX_INFLUENCES) top.push([0, 0]);
  return { idx: top.map(([b]) => b), w: top.map(([, w]) => w / sum) };
}

function buildRobe(verts, boneIndex) {
  const body = verts.filter((p) => !ARM_BONE.test(p.bone));
  const hipY = verts.find((p) => p.bone === HIP_BONE)?.y ?? 0.9;
  const pelvis = boneIndex(PELVIS_BONE);
  const hip = body.reduce((h, p) => (p.y > hipY - ROBE_BAND && p.y < hipY + ROBE_BAND ? Math.max(h, p.y) : h), hipY);

  // ring heights, hem to shoulder, then the collar
  const heights = [];
  for (let i = 0; i < ROBE_RINGS; i++) heights.push(ROBE_HEM + (ROBE_SHOULDER - ROBE_HEM) * (i / (ROBE_RINGS - 1)));
  const rings = heights.map((y) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of body) {
      if (Math.abs(p.y - y) > ROBE_BAND) continue;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    return { y, rx: Math.max(-x0, x1) + ROBE_MARGIN, rz: (z1 - z0) / 2 + ROBE_MARGIN, cz: (z0 + z1) / 2 };
  });
  // below the hips the cloth hangs: never narrower than the ring above, plus the flare
  const hipRing = rings.findLastIndex((r) => r.y <= hip);
  for (let i = hipRing - 1; i >= 0; i--) {
    const up = rings[i + 1], r = rings[i];
    const f = ROBE_FLARE * (1 - (r.y - ROBE_HEM) / (hip - ROBE_HEM)) / ROBE_RINGS * 2;
    r.rx = Math.max(r.rx, up.rx) + f;
    r.rz = Math.max(r.rz, up.rz) + f;
    r.cz = up.cz + ROBE_FRONT_SHIFT / ROBE_RINGS;
  }
  const top = rings[rings.length - 1];
  rings.push({ y: ROBE_TOP, rx: ROBE_COLLAR_R, rz: ROBE_COLLAR_R, cz: top.cz });

  const n = ROBE_SEGMENTS;
  const pos = [], skinIdx = [], skinW = [], index = [];
  for (const r of rings) {
    for (let s = 0; s <= n; s++) {
      const a = (s / n + 0.5) * 2 * Math.PI;   // the seam (s = 0 and n) down the back
      pos.push(Math.sin(a) * r.rx, r.y, r.cz + Math.cos(a) * r.rz);
    }
  }
  for (let j = 0; j < rings.length - 1; j++) {
    for (let s = 0; s < n; s++) {
      const a = j * (n + 1) + s, b = a + n + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // skin weights: inverse distance over the K nearest body vertices, the skirt eased toward the pelvis
  const near = [];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    near.length = 0;
    for (const p of verts) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
      if (near.length < SKIN_K || d < near[near.length - 1].d) {
        near.push({ d, p });
        near.sort((a, b) => a.d - b.d);
        if (near.length > SKIN_K) near.pop();
      }
    }
    const acc = new Map();
    for (const { d, p } of near) {
      const k = 1 / (Math.sqrt(d) + 1e-4);
      p.idx.forEach((b, j) => { if (p.w[j] > 0) acc.set(b, (acc.get(b) ?? 0) + p.w[j] * k); });
    }
    const total = [...acc.values()].reduce((s, w) => s + w, 0);
    const toPelvis = SKIRT_PELVIS * smooth01((hip - y) / (hip - ROBE_HEM));
    for (const [b, w] of acc) acc.set(b, (w / total) * (1 - toPelvis));
    acc.set(pelvis, (acc.get(pelvis) ?? 0) + toPelvis);
    const { idx, w } = topInfluences(acc);
    skinIdx.push(...idx);
    skinW.push(...w);
  }
  return skinnedGeometry(pos, index, skinIdx, skinW);
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

function skinnedGeometry(pos, index, skinIdx, skinW) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// Geometries for the robe and hat, from the model's skinned meshes (bind pose).
// Skin indices refer to meshes[0].skeleton's bones.
export function buildGarb(meshes) {
  const bones = meshes[0].skeleton.bones;
  const boneIndex = (name) => {
    const i = bones.findIndex((b) => b.name === name);
    if (i < 0) throw new Error(`the character model has no ${name} bone`);
    return i;
  };
  const verts = bodyVertices(meshes);
  return { robe: buildRobe(verts, boneIndex), hat: buildHat(verts, boneIndex) };
}
