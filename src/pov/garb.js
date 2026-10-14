import * as THREE from 'three';

// The wizard's hat for the realistic body (figureReal.js): a lathe (brim and
// cone, the tip bent back), built once per loaded model, seated on the head and
// skinned wholly to the head bone, so every clip (walk, swim, death...) carries
// it. Below it he wears only his boxers, dyed the hat's purple when the model is
// packed (tools/character-pack.mjs): wizard boxers. She stands in a barrel
// (Minecraft's: oak staves, iron hoops), skinned to the spine so it walks with her.
//
// Lengths are in model units (metres); the body's own scale takes them to cells.

const HEAD_BONE = 'Head';
const ROBE_BONES = ['pelvis', 'spine_01', 'spine_02', 'spine_03'];

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

// A barrel she stands in: narrower at the ends, fat in the middle, twelve staves.
// The hat and arms come out the top; the legs come out the bottom.
function buildBarrel(verts, boneIndex) {
  const hips = verts.filter((p) => p.bone === 'pelvis' || p.bone.startsWith('thigh'));
  const boneY = Object.fromEntries(ROBE_BONES.map((name) => {
    const pts = verts.filter((p) => p.bone === name);
    return [name, pts.reduce((s, p) => s + p.y, 0) / pts.length];
  }));
  const nearest = (y) => ROBE_BONES.reduce((a, b) => Math.abs(boneY[b] - y) < Math.abs(boneY[a] - y) ? b : a);
  let hipR = 0.16;
  for (const p of hips) if (Math.abs(p.y - boneY.pelvis) < 0.1) hipR = Math.max(hipR, Math.hypot(p.x, p.z));
  const radius = hipR + 0.07;
  const hem = Math.min(...hips.map((p) => p.y)) + 0.06;
  const top = boneY.spine_03 + 0.04;
  const profile = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const bulge = Math.sin(t * Math.PI);
    profile.push([radius * (0.88 + 0.2 * bulge), hem + (top - hem) * t]);
  }
  const robe = skinTo(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 12), 0);
  const pos = robe.attributes.position, idx = robe.attributes.skinIndex;
  for (let i = 0; i < pos.count; i++) idx.setX(i, boneIndex(nearest(pos.getY(i))));
  return { robe, hoops: buildHoops(profile, boneIndex, nearest) };
}

function buildHoops(profile, boneIndex, nearest) {
  const parts = [0.06, 0.5, 0.94].map((t) => {
    const [r, y] = profile[Math.round(t * (profile.length - 1))];
    const hoop = new THREE.TorusGeometry(r + 0.01, 0.014, 6, 18);
    hoop.rotateX(Math.PI / 2);
    hoop.translate(0, y, 0);
    return skinTo(hoop, boneIndex(nearest(y)));
  });
  const n = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const p = new Float32Array(n * 3), normal = new Float32Array(n * 3);
  const skinI = new Uint16Array(n * 4), skinW = new Float32Array(n * 4);
  let at = 0;
  for (const g of parts) {
    const count = g.attributes.position.count;
    p.set(g.attributes.position.array, at * 3);
    normal.set(g.attributes.normal.array, at * 3);
    skinI.set(g.attributes.skinIndex.array, at * 4);
    skinW.set(g.attributes.skinWeight.array, at * 4);
    at += count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(p, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('skinIndex', new THREE.BufferAttribute(skinI, 4));
  merged.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
  return merged;
}

// The hat's geometry, from the model's skinned meshes (bind pose). Skin indices
// refer to meshes[0].skeleton's bones.
export function buildGarb(meshes) {
  const bones = meshes[0].skeleton.bones;
  const boneIndex = (name) => {
    const i = bones.findIndex((b) => b.name === name);
    if (i < 0) throw new Error(`the character model has no ${name} bone`);
    return i;
  };
  const verts = bodyVertices(meshes);
  const garb = { hat: buildHat(verts, boneIndex) };
  if (meshes.some((m) => m.material?.name === 'MI_Superhero_Female')) Object.assign(garb, buildBarrel(verts, boneIndex));
  return garb;
}
