import * as THREE from 'three';

// The wizard's beard for the realistic male body (figureReal.js, garb.js): long,
// grey-white, chest length, forked into two clumped prongs at the tip, with a
// drooping moustache. It is seated on his jaw from the head mesh's own bind-pose
// vertices, the way garb.js's hat measures the head, and stops above his abs.
//
// It swings. Source's $jigglebone (TF2's and Garry's Mod's secondary motion,
// Valve Developer Wiki, "$jigglebone"): a chain of extra bones under Head, each
// springing toward where the animation alone would put it, with a stiffness, a
// damping, a fixed length and an angle limit per bone, and Source's tip_mass as a
// pull toward true down. Here the chain's joints are particles in world space,
// stepped in fixed-size substeps (so 30 and 144 fps swing alike), kept out of
// his neck and chest by spheres riding those bones, and the bones are turned to
// match them every frame. The beard is skinned to the chain, blended to Head at
// the chin; the moustache and the jaw rest wholly on Head.
//
// Bind space: model units (metres), the body faces +z, y up.
//   buildBeard(verts, bindPos, boneIndex)  → geometry (garb.js's buildGarb calls it)
//   createBeardRig(geometry, body)         → { skeleton, update(dt, state), reset() }
// The geometry's skin indices are its own skeleton's: 0 is Head, 1.. the chain.

export const BEARD_ALBEDO = [0.58, 0.57, 0.54];   // linear: grey-white, a touch warm (sRGB ≈ 0.79)

const HEAD_BONE = 'Head';

// ---- shape (head-height shares are of the head mesh's height, as garb.js's hat)
const LIP = 0.135;               // share of head height above its lowest point: the beard's top at the chin, under the lower lip
const SIDEBURN = 0.42;           // share: how high the sides climb, in front of the ears
const CHEEK_FROM = 0.22, CHEEK_TO = 0.85;   // |across| where the top edge leaves the lip and reaches the sideburn
const CHIN = 0.04;               // share: the face part ends here, just above the jaw's underside; below it hangs
const WRAP = Math.PI / 2;        // rad round the jaw from the front: to the sideburns, short of the ears
const AXIS_Z = 0.5;              // the jaw's polar axis sits this share of the way from the head's back to its front
const FACE_THICK = 0.014;        // m: the beard's depth on the cheeks and chin
const FACE_EDGE_FADE = 0.018;    // m: it thins to nothing over this much at the top edge
const FACE_INSET = 0.008;        // m: the hidden inner sheet sits this far inside the skin
const FACE_SAMPLE_ANGLE = 0.16;  // rad: head vertices this close in bearing...
const FACE_SAMPLE_HEIGHT = 0.011;   // ...and height (m) set the skin's radius there
const LENGTH = 0.28;             // m: chin to the longest prong, a vertical drop (mid-chest: the abs stay bare)
const HALF_WIDTH_TOP = 0.098;    // m: half its width under the jaw (bushier than the face)
const HALF_WIDTH_TIP = 0.062;    // m: half its width at the prongs
const HALF_THICK_TOP = 0.032;    // m: half its front-to-back depth under the chin
const HALF_THICK_TIP = 0.013;    // m: and at the prongs
const BACK_FLAT = 0.6;           // the back bulges this share of the front: it lies against the chest
const CHEST_GAP = 0.006;         // m: the back rests this far off the chest at rest
const CHEST_SAMPLE_X = 0.05, CHEST_SAMPLE_Y = 0.012;   // m: torso vertices this close to the midline and height set the chest's front
const BLEND = 0.3;               // share of its length over which the jaw's wrap becomes the hanging lock
const FORK_AT = 0.4;             // |across| of the two prongs
const FORK_NOTCH = 0.1, NOTCH_WIDTH = 0.2;   // the middle is this share of the length shorter, over this |across|
const SIDE_LENGTH = 0.62;        // share of the length the outermost locks reach
const PINCH = 0.4, PINCH_FROM = 0.45;   // near its end each lock gathers this share toward its prong, from this share of its length
const CLUMPS = 5, CLUMP_DEPTH = 0.16;    // ridges across the front, and their depth as a share of the thickness
const TIP_ROUND = 2.5;            // how squarely each lock ends (higher: blunter)
const COLS = 29, FACE_ROWS = 7, HANG_ROWS = 22;

// moustache: two drooping horns from under the nose, out past the mouth's corners
const MOUSTACHE_Y = 0.235;       // share of head height: its middle, between nose and upper lip
const MOUSTACHE_OUT = 0.006;     // m in front of the skin
const MOUSTACHE_SPAN = 0.052;    // m: half its span
const MOUSTACHE_DROOP = 0.11;    // share of head height its ends fall
const MOUSTACHE_RADIUS = 0.0095, MOUSTACHE_END = 0.0025;   // m: thickest and at the tips
const MOUSTACHE_FLAT = 0.65;     // it is flatter front to back than tall
const MOUSTACHE_STEPS = 12, MOUSTACHE_SIDES = 10;

// ---- the chain (Source $jigglebone, one per bone; rates are per second)
const JOINTS = 5;                // particles chin → tip: four bones
const STIFFNESS = 140;           // 1/s²: spring toward the animated pose (yaw/pitch_stiffness)
const TIP_SOFTEN = 0.45;         // the tip's spring is this share weaker than the root's
const DAMPING = 7;               // 1/s: on motion relative to the animated pose (yaw/pitch_damping)
const AIR_DRAG = 0.6;            // 1/s: on world motion: a run trails it a little
const WATER_DRAG = 6;            // 1/s: in liquid
const WATER_GRAVITY = 0.15;      // share of gravity in liquid: hair floats nearly free
const GRAVITY = 9.81;            // m/s² toward true down, beyond the drape the rest pose already hangs (tip_mass)
const ANGLE_LIMIT = 0.95;        // rad a bone may swing off its animated direction (angle_constraint)
const STEP = 1 / 120;            // s: the largest substep
const MAX_DT = 0.1;              // s: a frame after a stall steps no further
const RESET_JUMP = 1;            // m (body units): the head moved further than this in a frame (respawn, teleport): start at rest
const COLLIDE_ITERATIONS = 2;
const COLLIDE_THICK = 0.8;       // share of the lock's back depth kept off the body
// collision spheres riding the body: [bone, across (m, + his left), rise above it (m), sit back from it (m)];
// the midline's for the neck and breastbone, a pair for the pecs a swing crosses
const SPHERES = [['neck_01', 0, 0, 0.02], ['spine_03', 0, 0.1, 0.08], ['spine_03', 0, 0, 0.09], ['spine_02', 0, 0, 0.1],
  ['spine_03', -0.1, 0.04, 0.06], ['spine_03', 0.1, 0.04, 0.06]];
const SPHERE_BAND = 0.06;        // m: skin within this height of a sphere's centre (and CHEST_SAMPLE_X across) sizes it

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// The skin's radius about the jaw's axis at a bearing (rad from the front, + to his left) and height.
function faceRadius(face, axisZ, theta, y) {
  let best = 0, near = Infinity, nearR = 0;
  for (const p of face) {
    const dy = Math.abs(p.y - y);
    const a = Math.atan2(p.x, p.z - axisZ);
    const da = Math.abs(a - theta);
    const r = Math.hypot(p.x, p.z - axisZ);
    if (dy < FACE_SAMPLE_HEIGHT && da < FACE_SAMPLE_ANGLE) best = Math.max(best, r);
    const d = da * 0.1 + dy;   // the nearest vertex stands in where none is close
    if (d < near) { near = d; nearR = r; }
  }
  return best || nearR;
}

export function buildBeard(verts, bindPos, boneIndex) {
  const head = verts.filter((p) => p.bone === HEAD_BONE);
  let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of head) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const H = y1 - y0, axisZ = lerp(z0, z1, AXIS_Z);
  const face = head.filter((p) => p.z > axisZ - 0.04);
  const lipY = y0 + LIP * H, burnY = y0 + SIDEBURN * H, chinY = y0 + CHIN * H;
  // the chest's front at a height (m, bind z), from the torso's midline vertices
  const torso = verts.filter((p) => /^(spine_0[23]|neck_01|clavicle_[lr])$/.test(p.bone) && Math.abs(p.x) < CHEST_SAMPLE_X);
  const chestFront = (y) => {
    let z = -Infinity;
    for (const p of torso) if (Math.abs(p.y - y) < CHEST_SAMPLE_Y) z = Math.max(z, p.z);
    return z;
  };

  // the hanging lock's centre line: straight down from the chin until the chest pushes it out
  const halfThick = (t) => lerp(HALF_THICK_TOP, HALF_THICK_TIP, t);
  const chinOuter = axisZ + faceRadius(face, axisZ, 0, chinY) + FACE_THICK;
  const z0Line = chinOuter - halfThick(0);
  const lineZ = (t) => {
    const y = chinY - t * LENGTH;
    return Math.max(z0Line, chestFront(y) + halfThick(t) * BACK_FLAT + CHEST_GAP);
  };
  // smooth the centre line over the chest's low-poly steps (a running max, then a window)
  const LINE_SAMPLES = 64;
  let raw = Array.from({ length: LINE_SAMPLES + 1 }, (_, i) => lineZ(i / LINE_SAMPLES));
  for (let i = 1; i < raw.length; i++) raw[i] = Math.max(raw[i], raw[i - 1] - 0.0035);   // it can't tuck back in fast
  const SMOOTH = 4;
  raw = raw.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) { const j = Math.min(Math.max(i + k, 0), LINE_SAMPLES); s += raw[j]; n++; }
    return Math.max(s / n, raw[i]);   // never back into the chest
  });
  const centre = (t, out = new THREE.Vector3()) => {
    const f = Math.min(Math.max(t, 0), 1) * LINE_SAMPLES, i = Math.min(Math.floor(f), LINE_SAMPLES - 1);
    return out.set(0, chinY - t * LENGTH, lerp(raw[i], raw[i + 1], f - i));
  };

  // ---- the beard: a thick sheet, COLS locks across (s −1..1, his right to left), each from its
  // top edge on the face down to its own end; outer and inner surfaces, closed round the edges
  const ends = [];   // each lock's length share
  const outer = [], inner = [], tAt = [], onFace = [];
  for (let c = 0; c < COLS; c++) {
    const s = (c / (COLS - 1)) * 2 - 1, a = Math.abs(s);
    const theta = s * WRAP;
    const len = 1 - FORK_NOTCH * Math.exp(-((s / NOTCH_WIDTH) ** 2)) - (1 - SIDE_LENGTH) * smooth(FORK_AT, 1, a) ** 0.8;
    ends.push(len);
    const topY = lerp(lipY, burnY, smooth(CHEEK_FROM, CHEEK_TO, a));
    const prong = Math.sign(s) * FORK_AT;
    const edge = Math.sqrt(Math.max(0, 1 - s * s));   // depth across: none at the sheet's side edges
    const ridge = 1 + CLUMP_DEPTH * Math.cos(Math.PI * CLUMPS * s);
    const colO = [], colI = [], colT = [], colF = [];
    // on the face: down the jaw from the top edge to the chin line
    const faceEnd = { o: null, i: null };
    for (let r = 0; r < FACE_ROWS; r++) {
      const y = lerp(topY, chinY, r / (FACE_ROWS - 1));
      const R = faceRadius(face, axisZ, theta, y);
      const fade = smooth(0, FACE_EDGE_FADE, topY - y) * Math.min(1, edge * 2.5);
      const ro = R + FACE_THICK * fade * ridge, ri = R - FACE_INSET;
      const o = new THREE.Vector3(Math.sin(theta) * ro, y, axisZ + Math.cos(theta) * ro);
      const i = new THREE.Vector3(Math.sin(theta) * ri, y, axisZ + Math.cos(theta) * ri);
      colO.push(o); colI.push(i); colT.push(0); colF.push(1);
      faceEnd.o = o; faceEnd.i = i;
    }
    // hanging: from the chin line to the lock's end, the jaw's wrap blending into the lock
    const p = new THREE.Vector3();
    for (let r = 1; r <= HANG_ROWS; r++) {
      const u = r / HANG_ROWS, t = u * len;
      centre(t, p);
      const along = u;   // share of this lock's own length
      const pinch = PINCH * smooth(PINCH_FROM, 1, along);
      const hw = lerp(HALF_WIDTH_TOP, HALF_WIDTH_TIP, smooth(0, 1, t));
      const x = hw * lerp(s, prong, pinch);
      const close = Math.max(0, 1 - along ** TIP_ROUND) ** 0.5;   // each lock rounds shut at its end
      const ht = halfThick(t) * close * lerp(edge, 1, pinch);
      const o = new THREE.Vector3(x, p.y, p.z + ht * ridge);
      const i = new THREE.Vector3(x, p.y, p.z - ht * BACK_FLAT);
      const b = smooth(0, BLEND, t);
      o.lerpVectors(new THREE.Vector3(faceEnd.o.x, p.y, faceEnd.o.z), o, b);
      i.lerpVectors(new THREE.Vector3(faceEnd.i.x, p.y, faceEnd.i.z), i, b);
      colO.push(o); colI.push(i); colT.push(t); colF.push(0);
    }
    outer.push(colO); inner.push(colI); tAt.push(colT); onFace.push(colF);
  }

  const pos = [], skin = [], weight = [], uvs = [], index = [];
  const rows = FACE_ROWS + HANG_ROWS;
  // skin: Head for the jaw, then tents over the chain's bones (each strongest at its middle,
  // shared half and half at a joint), Head fading out down the first bone
  const bones = JOINTS - 1;
  const skinFor = (t, face) => {
    if (face) return [[0, 1]];
    const head = 1 - smooth(0, 1 / bones, t);
    const f = t * bones - 0.5, k = Math.floor(f), frac = f - k;
    const w = [];
    if (k < 0) w.push([1, 1]);
    else if (k >= bones - 1) w.push([bones, 1]);
    else w.push([k + 1, 1 - frac], [k + 2, frac]);
    return [[0, head], ...w.map(([b, x]) => [b, x * (1 - head)])];
  };
  const push = (v, t, face, uvx, uvy) => {
    pos.push(v.x, v.y, v.z);
    const w = skinFor(t, face).filter(([, x]) => x > 1e-4).slice(0, 4);
    const sum = w.reduce((a, [, x]) => a + x, 0);
    for (let k = 0; k < 4; k++) { skin.push(w[k]?.[0] ?? 0); weight.push((w[k]?.[1] ?? 0) / sum); }
    uvs.push(uvx, uvy);
    return pos.length / 3 - 1;
  };
  const O = outer.map((col, c) => col.map((v, r) => push(v, tAt[c][r], onFace[c][r], c / (COLS - 1), r / (rows - 1))));
  const I = inner.map((col, c) => col.map((v, r) => push(v, tAt[c][r], onFace[c][r], c / (COLS - 1), r / (rows - 1))));
  const quad = (a, b, c, d) => index.push(a, b, d, b, c, d);
  for (let c = 0; c < COLS - 1; c++) {
    for (let r = 0; r < rows - 1; r++) {
      quad(O[c][r], O[c][r + 1], O[c + 1][r + 1], O[c + 1][r]);   // outer faces out (+z at the front)
      quad(I[c + 1][r], I[c + 1][r + 1], I[c][r + 1], I[c][r]);
    }
    quad(I[c][0], O[c][0], O[c + 1][0], I[c + 1][0]);                       // the top edge
    quad(O[c][rows - 1], I[c][rows - 1], I[c + 1][rows - 1], O[c + 1][rows - 1]);   // each lock's end
  }
  for (let r = 0; r < rows - 1; r++) {
    quad(I[0][r], I[0][r + 1], O[0][r + 1], O[0][r]);                       // the side edges
    const e = COLS - 1;
    quad(O[e][r], O[e][r + 1], I[e][r + 1], I[e][r]);
  }

  // ---- the moustache: two tapered, flattened tubes from the middle out, wholly on Head
  const midY = y0 + MOUSTACHE_Y * H;
  const curve = (side, u) => {
    const x = side * MOUSTACHE_SPAN * u;
    const y = midY - MOUSTACHE_DROOP * H * u ** 2.2;
    const theta = Math.atan2(x, 0.09);
    const R = faceRadius(face, axisZ, theta, y) + MOUSTACHE_OUT;
    return new THREE.Vector3(x, y, axisZ + Math.sqrt(Math.max(R * R - x * x, 0)));
  };
  for (const side of [-1, 1]) {
    const base = pos.length / 3;
    for (let k = 0; k <= MOUSTACHE_STEPS; k++) {
      const u = k / MOUSTACHE_STEPS;
      const c = curve(side, u);
      const tangent = curve(side, Math.min(u + 0.02, 1)).sub(curve(side, Math.max(u - 0.02, 0))).normalize();
      const fwd = new THREE.Vector3(0, 0, 1).addScaledVector(tangent, -tangent.z).normalize();
      const up = new THREE.Vector3().crossVectors(fwd, tangent).normalize();
      const rad = lerp(MOUSTACHE_RADIUS, MOUSTACHE_END, u ** 1.6) * (u < 0.08 ? 0.75 + u * 3 : 1);
      for (let j = 0; j < MOUSTACHE_SIDES; j++) {
        const a = (j / MOUSTACHE_SIDES) * Math.PI * 2;
        const v = c.clone().addScaledVector(up, Math.cos(a) * rad).addScaledVector(fwd, Math.sin(a) * rad * MOUSTACHE_FLAT);
        push(v, 0, true, 0.5 + side * u * 0.5, 0);
      }
    }
    for (let k = 0; k < MOUSTACHE_STEPS; k++) {
      for (let j = 0; j < MOUSTACHE_SIDES; j++) {
        const a = base + k * MOUSTACHE_SIDES + j, b = base + k * MOUSTACHE_SIDES + ((j + 1) % MOUSTACHE_SIDES);
        if (side > 0) quad(a, a + MOUSTACHE_SIDES, b + MOUSTACHE_SIDES, b);
        else quad(b, b + MOUSTACHE_SIDES, a + MOUSTACHE_SIDES, a);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();

  // the chain's joints at rest, the lock's depth there, and the body's collision spheres
  const joints = [], depth = [];
  for (let k = 0; k < JOINTS; k++) {
    const t = k / (JOINTS - 1);
    joints.push(centre(t).toArray());
    depth.push(halfThick(t) * BACK_FLAT * COLLIDE_THICK);
  }
  const spheres = SPHERES.map(([bone, across, rise, back]) => {
    boneIndex(bone);   // throws if the rig lacks it
    const c = bindPos(bone).add(new THREE.Vector3(across, rise, -back));
    let r = 0;
    for (const p of verts) {
      if (!/^(spine_0[123]|neck_01|clavicle_[lr]|Head)$/.test(p.bone) || Math.abs(p.x - c.x) > CHEST_SAMPLE_X) continue;
      if (Math.abs(p.y - c.y) < SPHERE_BAND && p.z > c.z) r = Math.max(r, Math.hypot(p.y - c.y, p.z - c.z));
    }
    // and never so big that the beard's own rest drape is inside it
    for (let i = 0; i <= LINE_SAMPLES; i++) {
      const t = i / LINE_SAMPLES;
      r = Math.min(r, centre(t).distanceTo(c) - halfThick(t) * BACK_FLAT * COLLIDE_THICK);
    }
    return { bone, centre: c.toArray(), radius: Math.max(r, 0) };
  });
  geo.userData.beard = { parent: HEAD_BONE, joints, depth, spheres };
  geo.userData.albedo = BEARD_ALBEDO;
  return geo;
}

// ---- the rig: the chain's bones on one body's own skeleton, and their swing
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qPrev = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

export function createBeardRig(geometry, body) {
  const { joints, depth, spheres } = geometry.userData.beard;
  const skel = body.skeleton;
  const hi = skel.bones.findIndex((b) => b.name === HEAD_BONE);
  const head = skel.bones[hi], headInverse = skel.boneInverses[hi];
  const bind = joints.map((j) => new THREE.Vector3(...j));
  const local = bind.map((p) => p.clone().applyMatrix4(headInverse));   // in Head's frame
  const bones = [], inverses = [headInverse.clone()];
  let parent = head;
  for (let k = 0; k < JOINTS - 1; k++) {
    const b = new THREE.Bone();
    b.name = `beard_${k}`;
    b.position.copy(local[k]).sub(k ? local[k - 1] : _a.set(0, 0, 0));
    parent.add(b);
    bones.push(b);
    inverses.push(new THREE.Matrix4().makeTranslation(-local[k].x, -local[k].y, -local[k].z).multiply(headInverse));
    parent = b;
  }
  const skeleton = new THREE.Skeleton([head, ...bones], inverses);
  const colliders = spheres.map(({ bone, centre, radius }) => {
    const i = skel.bones.findIndex((b) => b.name === bone);
    return { bone: skel.bones[i], inverse: skel.boneInverses[i], centre: new THREE.Vector3(...centre), radius, at: new THREE.Vector3(), was: new THREE.Vector3(), now: new THREE.Vector3() };
  });
  const segment = bind.slice(1).map((p, k) => p.distanceTo(bind[k]));
  const x = bind.map(() => new THREE.Vector3()), v = bind.map(() => new THREE.Vector3()), prev = bind.map(() => new THREE.Vector3());
  const goal = bind.map(() => new THREE.Vector3()), goalWas = bind.map(() => new THREE.Vector3()), goalNow = bind.map(() => new THREE.Vector3());
  const goalVel = bind.map(() => new THREE.Vector3());
  const restDown = new THREE.Vector3(), headRot = new THREE.Quaternion();
  // the head's move from bind space to world, now and at the last step; a step's in-between
  // is interpolated as a turn (slerp), not a chord, so a coarse frame swings like a fine one
  const M = new THREE.Matrix4(), Mwas = new THREE.Matrix4(), Mi = new THREE.Matrix4();
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pI = new THREE.Vector3();
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qI = new THREE.Quaternion();
  const sA = new THREE.Vector3(), sB = new THREE.Vector3(), sI = new THREE.Vector3();
  let fresh = true, unit = 1;

  // where the animation alone puts the joints (world), under a head move
  function goals(out, m) {
    for (let k = 0; k < JOINTS; k++) out[k].copy(bind[k]).applyMatrix4(m);
  }
  function collide(k0, k1) {
    // the segment's nearest point to each sphere: pushed out, with the free end(s)
    for (const s of colliders) {
      const r = (s.radius + depth[k1]) * unit;
      const ab = _b.subVectors(x[k1], x[k0]), len2 = ab.lengthSq();
      const f = len2 > 0 ? Math.min(Math.max(_c.subVectors(s.at, x[k0]).dot(ab) / len2, 0), 1) : 0;
      const near = _c.copy(x[k0]).addScaledVector(ab, f);
      const out = _d.subVectors(near, s.at), dist = out.length();
      if (dist >= r || dist === 0) continue;
      out.multiplyScalar((r - dist) / dist);
      if (k0 === 0) x[k1].addScaledVector(out, 1 / Math.max(f, 0.25));   // the root is pinned: move the far end more
      else { x[k0].add(out); x[k1].add(out); }
    }
  }
  function constrain() {
    x[0].copy(goal[0]);
    for (let pass = 0; pass < COLLIDE_ITERATIONS; pass++) {
      for (let k = 1; k < JOINTS; k++) {
        // length: inextensible
        const dir = _a.subVectors(x[k], x[k - 1]);
        const rest = _b.subVectors(goal[k], goal[k - 1]).normalize();
        if (dir.lengthSq() < 1e-12) dir.copy(rest);
        dir.normalize();
        // angle: no further than ANGLE_LIMIT off the animated direction
        const ang = dir.angleTo(rest);
        if (ang > ANGLE_LIMIT) {
          _q.setFromUnitVectors(rest, dir);
          _q2.identity().slerp(_q, ANGLE_LIMIT / ang);
          dir.copy(rest).applyQuaternion(_q2);
        }
        x[k].copy(x[k - 1]).addScaledVector(dir, segment[k - 1] * unit);
      }
      for (let k = 1; k < JOINTS; k++) collide(k - 1, k);
    }
  }
  function reset() { fresh = true; }

  // dt: s since the last call; state: the figure's (dead, inLiquid), any of it optional
  function update(dt, state = {}) {
    head.updateWorldMatrix(true, false);
    for (const s of colliders) {
      s.bone.updateWorldMatrix(false, false);
      s.at.copy(s.now.copy(s.centre).applyMatrix4(_m.multiplyMatrices(s.bone.matrixWorld, s.inverse)));
    }
    M.multiplyMatrices(head.matrixWorld, headInverse);
    unit = _a.setFromMatrixColumn(M, 0).length();   // world units in a metre
    goals(goalNow, M);
    dt = Math.min(Math.max(dt, 0), MAX_DT);
    if (!(dt > 0) && !fresh) return;   // paused: the bones keep their turn off the head
    if (fresh || goalNow[0].distanceTo(_a.copy(bind[0]).applyMatrix4(Mwas)) > RESET_JUMP * unit) {
      for (let k = 0; k < JOINTS; k++) { x[k].copy(goalNow[k]); v[k].set(0, 0, 0); }
      for (const s of colliders) s.was.copy(s.now);
      fresh = false;
    } else {
      const wet = !!state.inLiquid;
      const drag = wet ? WATER_DRAG : AIR_DRAG;
      // true down, less the down the rest drape already hangs along
      restDown.copy(DOWN).transformDirection(M);
      const sag = _d.copy(DOWN).sub(restDown).multiplyScalar(GRAVITY * (wet ? WATER_GRAVITY : 1) * unit).clone();
      Mwas.decompose(pA, qA, sA);
      M.decompose(pB, qB, sB);
      goals(goalWas, Mwas);
      const n = Math.ceil(dt / STEP), h = dt / n;
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        goals(goal, Mi.compose(pI.lerpVectors(pA, pB, f), qI.slerpQuaternions(qA, qB, f), sI.lerpVectors(sA, sB, f)));
        for (let k = 0; k < JOINTS; k++) { goalVel[k].subVectors(goal[k], goalWas[k]).divideScalar(h); goalWas[k].copy(goal[k]); }
        for (const s of colliders) s.at.lerpVectors(s.was, s.now, f);   // the body moves through the frame too
        for (let k = 1; k < JOINTS; k++) {
          const K = STIFFNESS * (1 - TIP_SOFTEN * (k - 1) / (JOINTS - 2));
          // a = K (goal − x) − D (v − v_goal) − drag v + sag
          _a.subVectors(goal[k], x[k]).multiplyScalar(K)
            .addScaledVector(_b.subVectors(v[k], goalVel[k]), -DAMPING)
            .addScaledVector(v[k], -drag)
            .add(sag);
          v[k].addScaledVector(_a, h);
          prev[k].copy(x[k]);
          x[k].addScaledVector(v[k], h);
        }
        constrain();
        for (let k = 1; k < JOINTS; k++) v[k].subVectors(x[k], prev[k]).divideScalar(h);
      }
    }
    Mwas.copy(M);
    for (const s of colliders) s.was.copy(s.now);
    // turn each bone from its animated direction onto its simulated one
    head.getWorldQuaternion(headRot);
    _qPrev.copy(headRot);
    for (let k = 0; k < JOINTS - 1; k++) {
      const rest = _b.subVectors(goalNow[k + 1], goalNow[k]).normalize();
      const now = _c.subVectors(x[k + 1], x[k]).normalize();
      _q.setFromUnitVectors(rest, now).multiply(headRot);          // the bone's world turn
      bones[k].quaternion.copy(_q2.copy(_qPrev).invert().multiply(_q));
      _qPrev.copy(_q);
    }
    bones[0].updateWorldMatrix(false, true);
  }

  return {
    skeleton, bones, update, reset,
    // tests: the simulated joints (world) and where the animation alone would put them
    get joints() { return x; },
    get rest() { return goalNow; },
    get unit() { return unit; },   // world units per model metre
    get spheres() { return colliders.map((s) => ({ centre: s.at.clone(), radius: s.radius * unit })); },
  };
}
