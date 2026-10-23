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

// Hats, one style each (sizes as multiples of the head's half-width, the rest
// in metres). A wizard's hat is soft felt, not a traffic cone: the brim flops
// and waves, the crown is creased where it folds and kinks back on itself
// twice before the tip flops over (the Sorting Hat, Merlin and Mickey's
// Sorcerer's Apprentice hat), a band holds the crown's base tight, and stars
// and a moon are sewn on. Hers is a witch's: a wider, flatter brim, a
// straighter crown with one crooked bend, a ribbon and a buckle.
const HAT_STYLES = {
  wizard: {
    brim: 2.7,               // brim radius
    brimWave: [0.07, 5],     // the brim's edge wanders in and out this share of its radius, with this many lobes
    brimDroop: 0.38,         // its edge hangs this far below the crown's base...
    brimDroopVary: 0.55,     // ...this share more or less round the sides (floppy at the ears)
    brimUp: 0.4,            // the front edge turns up this far, to see from under it
    base: 1.1,               // crown base radius, at least (it grows to fit the skull)
    height: 4.0,             // crown length along its spine
    taper: 1.15,             // radius ∝ (1 − t)^taper
    // kinks along the spine: [t, rad back, rad to his left, pinch]
    bends: [[0.4, 0.35, 0.05, 0.1], [0.66, 1.5, 0.45, 0.16]],
    folds: [0.05, 6],        // crown wrinkles: share of the radius, folds round
    tilt: 0.1,               // rad: the whole hat sits back on the head
    band: [0.13, 0.006],     // share of the crown's length, and its thickness (m)
    // sewn on: [t, rad round from the front toward his left, size]
    stars: [[0.3, 0.45, 0.2], [0.52, -0.7, 0.15], [0.25, 2.3, 0.17], [0.42, -2.2, 0.14], [0.6, 1.6, 0.11]],
    moon: [0.33, -0.15, 0.24],
    colors: { hat: [0.16, 0.06, 0.35], hatBand: [0.07, 0.04, 0.03], hatTrim: [0.8, 0.55, 0.1] },   // purple felt (his boxers' dye), leather band, gold
  },
  witch: {
    brim: 3.1,
    brimWave: [0.02, 3],
    brimDroop: 0.18,
    brimDroopVary: 0.35,
    brimUp: 0.3,
    base: 1.05,
    height: 3.4,
    taper: 1.35,
    bends: [[0.5, 0.2, -0.06, 0.06], [0.78, 1.05, -0.25, 0.12]],
    folds: [0.03, 5],
    tilt: 0.14,
    band: [0.17, 0.005],
    stars: [[0.36, 0.55, 0.13], [0.48, -0.5, 0.1], [0.3, -2.0, 0.12]],
    moon: null,
    colors: { hat: [0.18, 0.025, 0.12], hatBand: [0.025, 0.12, 0.11], hatTrim: [0.62, 0.64, 0.68] },   // plum felt, teal ribbon, silver
  },
};
const HAT_BRIM_THICK = 0.01;             // m of felt at the crown...
const HAT_BRIM_ROLL = 0.006;             // ...thinning to this at the rolled edge
const HAT_SEAT = 0.33;                   // brim sits this share of the head's height down from its top
const HAT_HEAD_ROOM = 0.06;              // share of the crown's radius kept clear round the skull
const HAT_BRIM_TUCK = 0.92;              // the brim's inner edge, as a share of the crown's base: hidden inside it
const HAT_BEND_WIDTH = 0.07;             // share of the crown's length each kink is spread over
const HAT_FOLD_CLEAR = 1.6;              // folds rise in over this many band heights above the band (it holds the base tight)
const HAT_TRIM_PROUD = [0.0015, 0.0045]; // m: a sewn-on star's underside and top over the felt
const HAT_BUCKLE = [1.5, 0.28];          // the buckle's size over the band's height, and its frame's share of that
const HAT_RINGS = 48, HAT_SEGMENTS = 40, BRIM_RINGS = 8, BRIM_SEGMENTS = 72;

export const GARB_COLORS = {   // (each hat's own colours ride on its geometry: userData.albedo)
  ...HAT_STYLES.wizard.colors,
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

// The crown's spine, base to tip: a centre and a frame (ex his left, ey along
// the spine, ez his front) at each ring. Each kink turns the frame back (about
// ex) and to his left (about ez), spread over HAT_BEND_WIDTH of the length.
function hatSpine(st, H) {
  const weights = st.bends.map(([at]) => {
    const g = Array.from({ length: HAT_RINGS + 1 }, (_, i) => Math.exp(-((((i / HAT_RINGS) - at) / HAT_BEND_WIDTH) ** 2)));
    const sum = g.reduce((a, b) => a + b, 0);
    return g.map((x) => x / sum);
  });
  const c = new THREE.Vector3(), ex = new THREE.Vector3(1, 0, 0), ey = new THREE.Vector3(0, 1, 0), ez = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  const spine = [];
  for (let i = 0; i <= HAT_RINGS; i++) {
    spine.push({ c: c.clone(), ex: ex.clone(), ez: ez.clone() });
    let back = 0, left = 0;
    st.bends.forEach(([, b, l], k) => { back += b * weights[k][i]; left += l * weights[k][i]; });
    q.setFromAxisAngle(ex, -back).multiply(q2.setFromAxisAngle(ez, -left));
    ex.applyQuaternion(q); ey.applyQuaternion(q); ez.applyQuaternion(q);
    c.addScaledVector(ey, H / HAT_RINGS);
  }
  return spine;
}

// Lay a flat 2D shape (metres: u to the right seen from outside, v up the
// crown) on a surface(t, θ, out) at (t0, θ0), wrapped round it like a patch
// sewn on, `lift` = [underside, top] over it. Flat-shaded triangles.
function wrapShape(contour, holes, surface, t0, θ0, length, radius, [lo, hi]) {
  const pts2 = [contour, ...holes].flat();
  const at = (p, out) => surface(t0 + p.y / length, θ0 + p.x / radius, out);
  const top = pts2.map((p) => at(p, hi)), bottom = pts2.map((p) => at(p, lo));
  const centre = surface(t0, θ0, lo), outward = surface(t0, θ0, hi).sub(centre);
  const tris = [];
  const push = (a, b, c, facing) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    tris.push(...(n.dot(facing) >= 0 ? [a, b, c] : [a, c, b]));
  };
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    push(top[a], top[b], top[c], outward);
    push(bottom[a], bottom[b], bottom[c], outward.clone().negate());
  }
  let offset = 0;
  for (const ring of [contour, ...holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = offset + i, b = offset + (i + 1) % ring.length;
      // a side faces away from the shape's middle across that edge
      const facing = new THREE.Vector3().addVectors(top[a], top[b]).multiplyScalar(0.5).sub(centre);
      facing.addScaledVector(outward, -facing.dot(outward) / outward.lengthSq());
      if (ring !== contour) facing.negate();
      push(top[a], bottom[a], bottom[b], facing);
      push(top[a], bottom[b], top[b], facing);
    }
    offset += ring.length;
  }
  const geo = new THREE.BufferGeometry().setFromPoints(tris);
  geo.computeVertexNormals();
  return geo;
}

const starShape = (r) => Array.from({ length: 10 }, (_, i) => {
  const a = Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.42 : r;
  return new THREE.Vector2(Math.cos(a) * rr, Math.sin(a) * rr);
});
// a crescent opening to the right: the outer circle's left side, then back
// along an inner circle through both horns
const MOON_HORN = 0.9;                   // rad: the horns' angle on the outer circle
const MOON_INNER_CENTRE = 0.5;           // the inner circle's centre, right of the outer's, as a share of its radius
function moonShape(r, n = 14) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = MOON_HORN + (i / n) * (2 * Math.PI - 2 * MOON_HORN);
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  const cx = MOON_INNER_CENTRE * r, hx = Math.cos(MOON_HORN) * r, hy = Math.sin(MOON_HORN) * r;
  const ri = Math.hypot(hx - cx, hy), a0 = Math.atan2(-hy, hx - cx), a1 = Math.atan2(hy, hx - cx) - 2 * Math.PI;
  for (let i = 1; i < n; i++) {
    const a = a0 + (i / n) * (a1 - a0);
    pts.push(new THREE.Vector2(cx + Math.cos(a) * ri, Math.sin(a) * ri));
  }
  return pts;
}
const square = (s) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector2(x * s, y * s));

// Indexed grid of rows × cols points, wrapped round (the last column joins the first).
function wrapGrid(rows) {
  const cols = rows[0].length, pos = [], idx = [];
  for (const row of rows) for (const p of row) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * cols + j, b = i * cols + (j + 1) % cols, c = a + cols, d = b + cols;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

// A hat in one of HAT_STYLES, seated on the head from the head's bind-pose
// vertices, rigid on the head bone: { hat: crown and brim, hatBand, hatTrim }.
function buildHat(verts, headBone, st) {
  const head = verts.filter((p) => p.bone === HEAD_BONE);
  let x1 = 0, y0 = Infinity, y1 = -Infinity;
  for (const p of head) { x1 = Math.max(x1, Math.abs(p.x)); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const hr = x1, H = st.height * hr;
  // Fit the crown's base round the skull: an ellipse (a head is deeper than it is wide), centred
  // on the cranium above the seat, grown until every head vertex under the crown is inside it.
  const seatY = y1 - HAT_SEAT * (y1 - y0);
  const cranium = head.filter((p) => p.y > seatY);
  const zc = (Math.min(...cranium.map((p) => p.z)) + Math.max(...cranium.map((p) => p.z))) / 2;
  const toHat = new THREE.Matrix4().makeRotationX(st.tilt).multiply(new THREE.Matrix4().makeTranslation(0, -seatY, -zc));
  const local = cranium.map((p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(toHat)).filter((v) => v.y > 0);
  const aspect = Math.max(...local.map((v) => Math.abs(v.z))) / Math.max(...local.map((v) => Math.abs(v.x)));
  let rx = st.base * hr;
  for (const v of local) rx = Math.max(rx, Math.hypot(v.x, v.z / aspect) * (1 + HAT_HEAD_ROOM) / (1 - Math.min(v.y / H, 0.5)) ** st.taper);
  const rz = rx * aspect;
  const ellipse = (θ) => (rx * rz) / Math.hypot(rz * Math.sin(θ), rx * Math.cos(θ));
  const spine = hatSpine(st, H);
  const [bandT, bandThick] = st.band;
  const smooth01 = (x) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };
  const radius = (t, θ) => {
    let r = ellipse(θ) * (1 - t) ** st.taper;
    for (const [at, , , pinch] of st.bends) r *= 1 - pinch * Math.exp(-(((t - at) / HAT_BEND_WIDTH) ** 2));
    const [fold, n] = st.folds;
    const fade = smooth01((t - bandT) / (bandT * HAT_FOLD_CLEAR));
    return r * (1 + fade * fold * (Math.sin(n * θ + 7 * t) + 0.5 * Math.sin((n + 3) * θ - 11 * t + 1)));
  };
  // a point on the felt (out = metres over it); θ from his front toward his left
  const surface = (t, θ, out = 0) => {
    const f = Math.min(Math.max(t, 0), 1) * HAT_RINGS, i = Math.min(Math.floor(f), HAT_RINGS - 1), k = f - i;
    const a = spine[i], b = spine[i + 1];
    const ex = a.ex.clone().lerp(b.ex, k), ez = a.ez.clone().lerp(b.ez, k);
    return a.c.clone().lerp(b.c, k).addScaledVector(ex, Math.sin(θ) * (radius(t, θ) + out)).addScaledVector(ez, Math.cos(θ) * (radius(t, θ) + out));
  };
  const around = (n, f) => Array.from({ length: n }, (_, j) => f((j / n) * Math.PI * 2));

  // crown: rings up the spine, closed at the tip
  const crown = wrapGrid([
    ...Array.from({ length: HAT_RINGS }, (_, i) => around(HAT_SEGMENTS, (θ) => surface(i / HAT_RINGS, θ))),
    around(HAT_SEGMENTS, () => spine[HAT_RINGS].c.clone()),
  ]);
  crown.computeVertexNormals();

  // brim: top and underside, rolled together at the edge; its inner edge hides inside the crown
  const [wave, lobes] = st.brimWave;
  const rIn = (θ) => ellipse(θ) * HAT_BRIM_TUCK;
  const edge = (θ) => st.brim * hr * (1 + wave * (Math.sin(lobes * θ + 0.6) + 0.5 * Math.sin((lobes + 3) * θ + 2.1)));
  const brimAt = (s, θ, under) => {
    const r = rIn(θ) + (edge(θ) - rIn(θ)) * s;
    const droop = st.brimDroop * hr * s * s * (1 - st.brimDroopVary * Math.cos(2 * θ) + 0.3 * st.brimDroopVary * Math.sin(3 * θ + 1));
    const up = st.brimUp * hr * s * s * Math.max(Math.cos(θ), 0) ** 2;
    const thick = HAT_BRIM_THICK + (HAT_BRIM_ROLL - HAT_BRIM_THICK) * s;
    return new THREE.Vector3(Math.sin(θ) * r, up - droop - (under ? thick : 0), Math.cos(θ) * r);
  };
  const brimTop = Array.from({ length: BRIM_RINGS + 1 }, (_, k) => around(BRIM_SEGMENTS, (θ) => brimAt(k / BRIM_RINGS, θ, false)));
  const brimUnder = Array.from({ length: BRIM_RINGS + 1 }, (_, k) => around(BRIM_SEGMENTS, (θ) => brimAt(1 - k / BRIM_RINGS, θ, true)));
  const brim = wrapGrid([...brimTop, ...brimUnder]);   // top out to the edge, then the underside back in
  brim.computeVertexNormals();

  // band: round the crown's base, a lip at its top
  const bandRows = Array.from({ length: 5 }, (_, i) => around(HAT_SEGMENTS, (θ) => surface((i / 4) * bandT, θ, bandThick)));
  const band = wrapGrid([...bandRows, around(HAT_SEGMENTS, (θ) => surface(bandT, θ))]);
  band.computeVertexNormals();

  // trim: stars and a moon sewn on the crown, a buckle on the band's front
  const trim = [];
  const sewn = (shape, holes, t, θ, surf = surface, lift = HAT_TRIM_PROUD) => trim.push(wrapShape(shape, holes, surf, t, θ, H, radius(t, θ), lift));
  for (const [t, θ, size] of st.stars) sewn(starShape(size * hr), [], t, θ);
  if (st.moon) sewn(moonShape(st.moon[2] * hr), [], st.moon[0], st.moon[1]);
  const bandH = bandT * H, [buckle, frame] = HAT_BUCKLE;
  const onBand = (t, θ, out) => surface(t, θ, bandThick + out);
  sewn(square((buckle * bandH) / 2), [square(((buckle * bandH) / 2) * (1 - 2 * frame)).reverse()], bandT / 2, 0, onBand);

  const parts = { hat: mergeGeometries([crown, brim]), hatBand: band, hatTrim: mergeGeometries(trim) };
  for (const [name, geo] of Object.entries(parts)) {
    geo.rotateX(-st.tilt);
    geo.translate(0, seatY, zc);
    geo.userData.albedo = st.colors[name];
    skinTo(geo, headBone);
  }
  return parts;
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
  else Object.assign(garb, buildHat(verts, boneIndex(HEAD_BONE), HAT_STYLES[female ? 'witch' : 'wizard']));
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
