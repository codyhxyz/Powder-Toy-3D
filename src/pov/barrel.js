import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { limb, solveLimb, setWorldQuaternion, handFrame, handTurn } from './limbs.js';

// Her barrel: a cooper's cask, closed all the way round. Oak staves bulge to
// a bilge at the waist and narrow to the heads. Iron hoops are driven on near
// each end and at the quarters (a wine barrel's six, less the two bilge
// hoops a short cask does without), and there is a cork in the bung. It runs
// from mid-thigh to just under her arms, so she stands in it with her arms
// hung over the rim. That is the old cartoon of a man wearing a barrel, and
// Minecraft's barrel is oak staves and iron bands too.
//
// It is rigid on spine_01, so wood and iron move together. createBarrelFit()
// keeps her body out of the wood:
//   - free arms lie over the rim, with the forearms down the outside;
//   - a held tool's grip comes up over the rim;
//   - an elbow that would go through the staves swings out round its shoulder;
//   - a leg that would push through them eases back toward standing straight,
//     and crouched, she kneels upright (BARREL_CROUCH).
//
// Lengths are in model units (metres), in the bind pose's frame. That is
// spine_01's rest frame, so the barrel stays put in it.

const STAVES = 20;
const STAVE_THICK = 0.022;
const STAVE_BEVEL = 0.005;       // m: each plank's outer edges are eased this deep (a seam, with no gap)
const STAVE_BEVEL_WIDTH = 0.12;  // share of a stave's width the bevel takes, each side
const STAVE_ROWS = 10;           // rows from hem to rim, along the bilge's curve
const HEAD_SHARE = 0.88;         // head over bilge diameter: straighter than a Bordeaux barrique's 56 / 69 cm, for her thighs' room at the hem
const BODY_ROOM = 0.022;         // m between her and the inside of the staves
const RIM_BELOW_SHOULDER = 0.12; // m: the rim sits this far under the shoulder joints (her armpits)
const HEM_SHARE = 0.5;           // the hem: this share of the way from the hip joints to the knees (mid-thigh)
const HOOPS = [0.05, 0.27, 0.73, 0.95];   // hoop centres up the barrel: chime and quarter hoops
const HOOP_WIDTH = 0.034;        // m: flat iron strap
const HOOP_THICK = 0.005;        // m
const HOOP_SEGMENTS = 48;
const BUNG_AT = 0.5;             // share of the height: the bung is in the bilge
const BUNG = { r: 0.022, r2: 0.018, h: 0.03, proud: 0.012 };   // m: a tapered cork standing proud of the stave

// The fit. Radii are capsules round the bones.
const UPPER_ARM_R = 0.05;
const FOREARM_R = 0.04;
const HAND_R = 0.035;
const FINGER_R = 0.012;
const HAND_CURL = 0.03;          // m a relaxed hand's fingers curl in past its palm...
const FINGER_RELAX = 0.25;       // ...at this many rad at each knuckle, whatever the clip's hand does
const THIGH_R = 0.1;
const SHIN_R = 0.075;
const ARM_CLEAR = 0.01;          // m kept between an arm and the wood
const DRAPE_FORWARD = 0.35;      // rad: the arms lie over the rim this far forward of straight out to the side
const DRAPE_DROP = [-0.5, 1.1];  // rad below level the upper arm may take, laid over the rim (−: up over it, shoulders hunched below it)
const DRAPE_IN = 0.45;           // at most this share of the forearm's length it slants in toward the barrel
const GRIP_CLEAR = 0.07;         // m: a grip comes up this far over the rim (a fist's half-height and a gap)...
const GRIP_BAND = 0.08;          // ...easing off over this much beyond the staves, so a tool held out ahead isn't lifted
const ELBOW_STEP = Math.PI / 12; // rad: an elbow in the wood swings round its shoulder-to-wrist line in these steps...
const ELBOW_STEPS = 12;          // ...up to half a turn either way
const SAMPLES = 5;               // points checked along each bone...
const LEG_SAMPLES = 10;          // ...and along a thigh or a shin, which can cross the hem's edge
const LEG_ITER = 8;              // bisection steps for a leg's ease back in
export const BARREL_CROUCH = {   // kneeling upright in it: there's no room for a squat's knees, and a
  hip: 0.1,                      // lean would swing its hem back into her thighs. rad, thighs forward
  knee: -1.7,                    // rad, the shins back along the floor
  foot: -2.6,                    // rad more than level: the toes back and down, the insteps on the floor
  lean: 0,                       // rad, torso forward
  head: 0,                       // rad, the head tipped back up
};

const clamp = THREE.MathUtils.clamp;
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const ARM_BONE = /^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)_/;

// The staves' inside radius at height y: widest at the bilge, HEAD_SHARE of that at the ends.
export function innerRadius(s, y) {
  const u = clamp((y - s.mid) / s.half, -1, 1);
  return s.bilge * (HEAD_SHARE + (1 - HEAD_SHARE) * (1 - u * u));
}
// The outside, with the hoops on it.
export const outerRadius = (s, y) => innerRadius(s, y) + STAVE_THICK + HOOP_THICK;

// The barrel's shape, fitted to her bind pose: the rim under her arms, the hem
// at mid-thigh, the bilge as narrow as fits her with BODY_ROOM to spare.
// bindPos(name): a bone's bind position (model units).
function fitShape(verts, bindPos) {
  const top = (bindPos('upperarm_l').y + bindPos('upperarm_r').y) / 2 - RIM_BELOW_SHOULDER;
  const hip = (bindPos('thigh_l').y + bindPos('thigh_r').y) / 2, knee = (bindPos('calf_l').y + bindPos('calf_r').y) / 2;
  const hem = hip + (knee - hip) * HEM_SHARE;
  const inside = verts.filter((p) => p.y >= hem && p.y <= top && !ARM_BONE.test(p.bone));
  let z0 = Infinity, z1 = -Infinity;
  for (const p of inside) { z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const s = { hem, top, mid: (hem + top) / 2, half: (top - hem) / 2, zc: (z0 + z1) / 2, bilge: 1 };
  let bilge = 0;
  for (const p of inside) bilge = Math.max(bilge, (Math.hypot(p.x, p.z - s.zc) + BODY_ROOM) / innerRadius(s, p.y));
  s.bilge = bilge;
  return s;
}

function addQuad(idx, a, b, c, d) { idx.push(a, b, c, a, c, d); }

// The staves. Each is a plank with an inside face, an outside face eased at both edges, and end grain
// top and bottom. Neighbours meet along their full thickness, so nothing shows between them but the seam.
function buildStaves(s) {
  const pos = [], idx = [];
  const width = (Math.PI * 2) / STAVES;
  // across a stave: [angle share, depth under the outside], the outside's points, then the inside's
  const outside = [[0, STAVE_BEVEL], [STAVE_BEVEL_WIDTH, 0], [0.5, 0], [1 - STAVE_BEVEL_WIDTH, 0], [1, STAVE_BEVEL]];
  const across = outside.length + 2;   // and the inside's two edges
  for (let k = 0; k < STAVES; k++) {
    const a0 = (k - 0.5) * width;   // stave 0 centred on the front, where the bung goes
    const base = pos.length / 3;
    for (let i = 0; i <= STAVE_ROWS; i++) {
      const y = s.hem + (s.top - s.hem) * (i / STAVE_ROWS);
      const r = innerRadius(s, y), ro = r + STAVE_THICK;
      for (const [f, dip] of outside) {
        const a = a0 + f * width;
        pos.push((ro - dip) * Math.sin(a), y, s.zc + (ro - dip) * Math.cos(a));
      }
      for (const f of [0, 1]) {
        const a = a0 + f * width;
        pos.push(r * Math.sin(a), y, s.zc + r * Math.cos(a));
      }
    }
    const o = outside.length;
    for (let i = 0; i < STAVE_ROWS; i++) {
      const lo = base + i * across, hi = lo + across;
      for (let j = 0; j < o - 1; j++) addQuad(idx, lo + j, lo + j + 1, hi + j + 1, hi + j);   // outside, facing out
      addQuad(idx, lo + o + 1, lo + o, hi + o, hi + o + 1);                                    // inside, facing in
    }
    // end grain: the outside's points against the inside's two edges
    const caps = [[base, -1], [base + STAVE_ROWS * across, 1]];
    for (const [row, up] of caps) {
      const fan = (a, b, c) => (up > 0 ? idx.push(a, b, c) : idx.push(a, c, b));
      fan(row + o, row + 0, row + 1);
      fan(row + o, row + 1, row + 2);
      fan(row + o, row + 2, row + o + 1);
      fan(row + o + 1, row + 2, row + 3);
      fan(row + o + 1, row + 3, row + 4);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // Facet the planks so the seams and end grain catch the light as edges.
  const faceted = geo.toNonIndexed();
  faceted.computeVertexNormals();
  geo.dispose();
  return faceted;
}

// One iron hoop: a flat strap on the staves' slope, with its two edges.
function buildHoop(s, t) {
  const yc = s.hem + (s.top - s.hem) * t;
  const y0 = yc - HOOP_WIDTH / 2, y1 = yc + HOOP_WIDTH / 2;
  const r0 = innerRadius(s, y0) + STAVE_THICK, r1 = innerRadius(s, y1) + STAVE_THICK;
  // the profile, outside the staves: up the bottom edge, up the strap, in along the top edge
  const ring = [[r0, y0], [r0 + HOOP_THICK, y0], [r1 + HOOP_THICK, y1], [r1, y1]];
  const pos = [], nrm = [], idx = [];
  for (let e = 0; e < ring.length - 1; e++) {
    const [ra, ya] = ring[e], [rb, yb] = ring[e + 1];
    const len = Math.hypot(rb - ra, yb - ya);
    const nr = (yb - ya) / len, ny = -(rb - ra) / len;   // the profile's right-hand normal: outward
    const base = pos.length / 3;
    for (let i = 0; i <= HOOP_SEGMENTS; i++) {
      const a = (i / HOOP_SEGMENTS) * Math.PI * 2, sa = Math.sin(a), ca = Math.cos(a);
      pos.push(ra * sa, ya, s.zc + ra * ca, rb * sa, yb, s.zc + rb * ca);
      nrm.push(nr * sa, ny, nr * ca, nr * sa, ny, nr * ca);
      if (i < HOOP_SEGMENTS) addQuad(idx, base + i * 2, base + i * 2 + 2, base + i * 2 + 3, base + i * 2 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

// The barrel's meshes from her bind pose: { robe, hoops, bung }, skinned
// wholly to spine_01 by skinTo(geo, bone). The robe (the staves) carries the
// fitted shape as userData.barrel, for createBarrelFit.
export function buildBarrel(verts, bindPos, boneIndex, skinTo) {
  const s = fitShape(verts, bindPos);
  const bone = boneIndex('spine_01');
  const robe = skinTo(buildStaves(s), bone);
  robe.userData.barrel = s;
  const parts = HOOPS.map((t) => buildHoop(s, t));
  const hoops = skinTo(mergeGeometries(parts), bone);
  for (const g of parts) g.dispose();
  const by = s.hem + (s.top - s.hem) * BUNG_AT;
  const bung = new THREE.CylinderGeometry(BUNG.r, BUNG.r2, BUNG.h, 10);   // wide end out, tapered into the hole
  bung.rotateX(Math.PI / 2);
  bung.translate(0, by, s.zc + innerRadius(s, by) + STAVE_THICK + BUNG.proud - BUNG.h / 2);
  return { robe, hoops, bung: skinTo(bung, bone) };
}

// How she wears it: her rig (model: her bones by name) against the barrel's
// shape `s`; body is the skinned mesh whose skeleton the barrel is bound to.
//
//   const fit = createBarrelFit(s, model, body);
//   fit.restore();                   // before the clips run: what the fit moved last frame, put back
//   fit.drape();                     // after the clips: free arms over the rim
//   fit.keepLegs();                  // after every leg pose: legs inside, standing on them
//   fit.liftGrips(m, points);        // a held tool's frame, up over the rim
//   fit.reachable(p) && fit.solve(k, target, pole);   // an arm to a grip, elbow out of the wood
//   fit.settle(k);                   // after a blend or a wingbeat: out of the wood again
export function createBarrelFit(s, model, body) {
  const bone = (n) => model.getObjectByName(n);
  const spine = bone('spine_01'), pelvis = bone('pelvis');
  const spineIndex = body.skeleton.bones.indexOf(spine);
  const toWorld = new THREE.Matrix4(), toBarrel = new THREE.Matrix4(), lift = new THREE.Matrix4();
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  const S = new THREE.Vector3(), E = new THREE.Vector3(), W = new THREE.Vector3(), H = new THREE.Vector3(), K = new THREE.Vector3(), A = new THREE.Vector3();
  const h = new THREE.Vector3(), rad = new THREE.Vector3(), axis = new THREE.Vector3(), off = new THREE.Vector3();
  const pole = new THREE.Vector3(), target = new THREE.Vector3();
  const pE = new THREE.Vector3(), pW = new THREE.Vector3(), pK = new THREE.Vector3(), pT = new THREE.Vector3(), pF = new THREE.Vector3();
  const q = new THREE.Quaternion(), qa = new THREE.Quaternion(), qh = new THREE.Quaternion();
  const rimOuter = outerRadius(s, s.top);
  // Every bone the fit moves, as the clips left it: put back before the clips run again. The mixer
  // only writes a value that has changed since it last wrote it (a held idle), so a move left in
  // place would build up frame on frame.
  const slots = new Map(), moved = [];
  function keep(b) {
    let k = slots.get(b);
    if (!k) slots.set(b, k = { b, q: new THREE.Quaternion(), p: new THREE.Vector3(), on: false });
    if (k.on) return;
    k.q.copy(b.quaternion); k.p.copy(b.position); k.on = true;
    moved.push(k);
  }

  // the barrel's frame this frame: spine_01's pose times its rest
  function frame() {
    spine.updateWorldMatrix(true, false);
    toWorld.multiplyMatrices(spine.matrixWorld, body.skeleton.boneInverses[spineIndex]).multiply(body.bindMatrix);
    toBarrel.copy(toWorld).invert();
  }
  // How far a ball of radius rho at barrel point p is clear of the wood (m; < 0: in it): its
  // distance from the wall's section, r inside to outside by y hem to rim, as a box's distance field
  // is (Quilez's sdBox), so it is round at the rim's edges. Inside the barrel counts as in it.
  function gap(p, rho) {
    const r = Math.hypot(p.x, p.z - s.zc), y = clamp(p.y, s.hem, s.top);
    const rIn = innerRadius(s, y), rOut = outerRadius(s, y);
    if (p.y > s.hem && p.y < s.top && r < rIn) return -Math.min(s.top - p.y, rIn - r);
    const dr = Math.abs(r - (rIn + rOut) / 2) - (rOut - rIn) / 2, dy = Math.abs(p.y - s.mid) - s.half;
    return Math.hypot(Math.max(dr, 0), Math.max(dy, 0)) + Math.min(Math.max(dr, dy), 0) - rho;
  }
  // the least gap along a bone, world points a to b
  function boneGap(a, b, rho) {
    let least = Infinity;
    for (let i = 0; i <= SAMPLES; i++) least = Math.min(least, gap(v.lerpVectors(a, b, i / SAMPLES).applyMatrix4(toBarrel), rho));
    return least;
  }
  // how far a leg's bone, world a to b, keeps out of the wood: inside the staves, or clear of them
  // outside (a heel kicked up behind the barrel) (m; < 0: through them)
  function room(a, b, rho) {
    let least = Infinity;
    for (let i = 0; i <= LEG_SAMPLES; i++) {
      v.lerpVectors(a, b, i / LEG_SAMPLES).applyMatrix4(toBarrel);
      if (v.y < s.hem || v.y > s.top) continue;
      const inside = innerRadius(s, v.y) - Math.hypot(v.x, v.z - s.zc) - rho;
      least = Math.min(least, Math.max(inside, gap(v, rho)));
    }
    return least;
  }
  // a leg's room: thigh and shin
  function legRoom(g) {
    g.thigh.getWorldPosition(H);
    g.foot.updateWorldMatrix(true, false);
    g.knee.getWorldPosition(K);
    return Math.min(room(H, K, THIGH_R), room(K, g.foot.getWorldPosition(A), SHIN_R));
  }

  model.updateMatrixWorld(true);
  const arms = Object.fromEntries(['l', 'r'].map((k) => {
    const upper = bone(`upperarm_${k}`), lower = bone(`lowerarm_${k}`), hand = bone(`hand_${k}`);
    const unit = upper.getWorldScale(v).x;   // bind lengths, model units
    const knuckle = bone(`middle_01_${k}`);
    const tips = [bone(`middle_04_leaf_${k}`) ?? bone(`middle_03_${k}`), bone(`thumb_04_leaf_${k}`) ?? bone(`thumb_03_${k}`)];
    const frame = handFrame(hand, knuckle, bone(`thumb_01_${k}`), k === 'l' ? 'left' : 'right');
    // a hanging hand's fingers: each knuckle turned a little toward the palm (figureReal.js's fist, loosened)
    const curl = frame.fingers.clone().cross(frame.palm).applyQuaternion(hand.getWorldQuaternion(q));
    const fingers = FINGERS.flatMap((f) => [1, 2, 3].map((j) => bone(`${f}_0${j}_${k}`)).filter(Boolean)).map((b) => ({
      b, q: new THREE.Quaternion().setFromAxisAngle(curl.clone().applyQuaternion(b.getWorldQuaternion(qa).invert()), FINGER_RELAX).premultiply(b.quaternion),
    }));
    return [k, {
      L: limb(upper, lower, hand.position, 1), hand, knuckle, tips, thumb: bone(`thumb_01_${k}`), side: k === 'l' ? 1 : -1,
      frame, fingers,
      l1: upper.getWorldPosition(v).distanceTo(lower.getWorldPosition(w)) / unit,
      l2: lower.getWorldPosition(v).distanceTo(hand.getWorldPosition(w)) / unit,
      l3: hand.getWorldPosition(v).distanceTo(tips[0].getWorldPosition(w)) / unit,
    }];
  }));
  const legs = ['l', 'r'].map((k) => {
    const g = { thigh: bone(`thigh_${k}`), knee: bone(`calf_${k}`), foot: bone(`foot_${k}`) };
    g.bones = [g.thigh, g.knee, g.foot];
    g.rest = g.bones.map((b) => b.quaternion.clone());   // the bind pose: built before any clip has run
    g.clip = g.bones.map(() => new THREE.Quaternion());
    return g;
  });

  // the arm's least gap as posed: upper arm, forearm, hand, fingers and thumb
  function armGap(a) {
    a.L.upper.getWorldPosition(S);
    a.hand.updateWorldMatrix(true, true);
    a.L.lower.getWorldPosition(pE); a.hand.getWorldPosition(pW); a.knuckle.getWorldPosition(pK);
    const g = Math.min(boneGap(S, pE, UPPER_ARM_R), boneGap(pE, pW, FOREARM_R), boneGap(pW, pK, HAND_R),
      boneGap(pK, a.tips[0].getWorldPosition(pT), FINGER_R));
    return Math.min(g, boneGap(a.thumb.getWorldPosition(pF), a.tips[1].getWorldPosition(pT), FINGER_R));
  }
  // Solve an arm to world `tgt` with its elbow toward world `pl` (and its hand to world turn `qh`, if
  // given). If it then lies in the wood, the elbow swings round the shoulder-to-wrist line, the
  // nearest way that clears (or the clearest).
  function solveTo(a, tgt, pl, qh) {
    keep(a.L.upper); keep(a.L.lower); keep(a.hand);
    solveLimb(a.L, tgt, pl);
    if (qh) setWorldQuaternion(a.hand, qh);
    return armGap(a);
  }
  function solveClear(a, tgt, pl, qh = null) {
    let g = solveTo(a, tgt, pl, qh);
    if (g >= 0) return g;
    axis.subVectors(tgt, S).normalize();
    off.subVectors(pl, S);
    let bestGap = g, bestStep = 0;
    for (let i = 1; i <= ELBOW_STEPS && bestGap < 0; i++) {
      for (const sign of [1, -1]) {
        g = solveTo(a, tgt, pole.copy(off).applyAxisAngle(axis, sign * i * ELBOW_STEP).add(S), qh);
        if (g > bestGap) { bestGap = g; bestStep = sign * i; }
        if (g >= 0) break;
      }
    }
    if (g < bestGap || g < 0) solveTo(a, tgt, pole.copy(off).applyAxisAngle(axis, bestStep * ELBOW_STEP).add(S), qh);
    return bestGap;
  }

  // A free arm over the rim: the upper arm laid on it, the forearm down the outside of the staves.
  function drape(a) {
    a.L.upper.getWorldPosition(S).applyMatrix4(toBarrel);
    // out from the shoulder, a little ahead of the side, to the rim's outside edge
    h.set(a.side * Math.cos(DRAPE_FORWARD), 0, Math.sin(DRAPE_FORWARD));
    const sx = S.x, sz = S.z - s.zc;
    const b = sx * h.x + sz * h.z, c = sx * sx + sz * sz - rimOuter * rimOuter;
    const t = -b + Math.sqrt(Math.max(0, b * b - c));
    // along the tangent over that edge, the arm's thickness and a gap above it
    const dy = S.y - s.top, d = Math.hypot(t, dy);
    const drop = clamp(Math.atan2(dy, t) - Math.asin(Math.min(1, (UPPER_ARM_R + ARM_CLEAR) / d)), DRAPE_DROP[0], DRAPE_DROP[1]);
    E.copy(S).addScaledVector(h, a.l1 * Math.cos(drop));
    E.y -= a.l1 * Math.sin(drop);
    // the forearm down against the staves: the wrist as near the barrel as the bulge it and the
    // hand pass allows, with room for the fingers' curl
    let need = 0;
    for (let i = 0; i <= SAMPLES; i++) need = Math.max(need, outerRadius(s, E.y - ((a.l2 + a.l3) * i) / SAMPLES));
    need += FOREARM_R + ARM_CLEAR + HAND_CURL;
    rad.set(E.x, 0, E.z - s.zc);
    const rE = rad.length();
    rad.divideScalar(rE);
    const shift = clamp(need - rE, -DRAPE_IN * a.l2, DRAPE_IN * a.l2);   // the wrist in (−) or out (+) from under the elbow
    W.copy(E).addScaledVector(rad, shift);
    W.y -= Math.sqrt(a.l2 * a.l2 - shift * shift);
    // the hand hangs on: fingers down the forearm's line, never in toward the wood, the palm to the staves
    h.subVectors(W, E);
    h.addScaledVector(rad, -Math.min(0, h.dot(rad))).transformDirection(toWorld);
    off.copy(rad).negate().transformDirection(toWorld);
    handTurn(a.frame, h, off, qh);
    for (const f of a.fingers) { keep(f.b); f.b.quaternion.copy(f.q); }
    solveClear(a, target.copy(W).applyMatrix4(toWorld), pole.copy(E).applyMatrix4(toWorld), qh);
  }

  // A leg in the wood eases back toward its rest (bind) pose, straight down inside the barrel, the
  // thigh, shin and foot together and as little as clears: a stance narrows, a stride shortens, a kick
  // stays low. Bisection on the share.
  function keepLeg(g) {
    if (legRoom(g) >= 0) return;
    g.bones.forEach((b, i) => { keep(b); g.clip[i].copy(b.quaternion); });
    const ease = (t) => {
      g.bones.forEach((b, i) => b.quaternion.slerpQuaternions(g.clip[i], g.rest[i], t));
      return legRoom(g);
    };
    let lo = 0, hi = 1;
    for (let i = 0; i < LEG_ITER; i++) {
      const mid = (lo + hi) / 2;
      if (ease(mid) >= 0) hi = mid; else lo = mid;
    }
    ease(hi);
  }

  // the arm's elbow and wrist where they are now, re-solved out of the wood if they are in it
  function settle(a) {
    if (armGap(a) >= 0) return;
    solveClear(a, target.copy(pW), pole.copy(pE));
  }

  return {
    shape: s,
    // every bone moved since the last restore, back as the clips left it (before the mixer runs)
    restore() {
      for (const k of moved) { k.b.quaternion.copy(k.q); k.b.position.copy(k.p); k.on = false; }
      moved.length = 0;
    },
    drape(free = { l: true, r: true }) {
      frame();
      for (const k of ['l', 'r']) if (free[k]) drape(arms[k]);
    },
    // stand: if both legs had to straighten, she stands up by what that took off her feet (the clips
    // rewrite the pelvis every frame); off when the feet are held somewhere (a pogo's pegs)
    keepLegs(stand = true) {
      frame();
      let sink = Infinity;
      for (const g of legs) {
        const y = g.foot.getWorldPosition(A).y;
        keepLeg(g);
        sink = Math.min(sink, y - g.foot.getWorldPosition(A).y);
      }
      if (!stand || !(sink > 0)) return;
      keep(pelvis);
      pelvis.getWorldPosition(A).y += sink;
      pelvis.position.copy(pelvis.parent.worldToLocal(A));
      pelvis.updateWorldMatrix(false, true);
    },
    // a hand can hold world point p without being in the wood (a grip inside the barrel can't)
    reachable(p) {
      frame();
      return gap(v.copy(p).applyMatrix4(toBarrel), HAND_R) >= 0;
    },
    // arm k to world `tgt`, its elbow toward world `pl` or as near as clears the wood (its hand to world turn qh)
    solve(k, tgt, pl, qh = null) {
      frame();
      return solveClear(arms[k], tgt, pl, qh);
    },
    settle(k) { frame(); settle(arms[k]); },
    // A held tool's frame (world matrix m; points: its grips in m's own space) moved up the barrel
    // far enough that every grip clears the rim. A grip well clear of the staves (a tool held out
    // ahead) isn't moved. Returns the lift (m).
    liftGrips(m, points) {
      frame();
      let by = 0;
      for (const p of points) {
        if (!p) continue;
        v.copy(p).applyMatrix4(m).applyMatrix4(toBarrel);
        if (v.y <= s.hem) continue;
        const out = Math.hypot(v.x, v.z - s.zc) - outerRadius(s, v.y) - GRIP_CLEAR;
        by = Math.max(by, (s.top + GRIP_CLEAR - v.y) * (1 - THREE.MathUtils.smoothstep(out, 0, GRIP_BAND)));
      }
      if (!(by > 0)) return 0;
      v.set(0, 0, 0).applyMatrix4(toWorld);
      w.set(0, by, 0).applyMatrix4(toWorld).sub(v);
      m.premultiply(lift.makeTranslation(w.x, w.y, w.z));
      return by;
    },
    // checks: how far an arm is from the wood, and a leg inside it (m; < 0: in or through it)
    armGap(k) { frame(); return armGap(arms[k]); },
    legRoom(i) { frame(); return legRoom(legs[i]); },
  };
}
