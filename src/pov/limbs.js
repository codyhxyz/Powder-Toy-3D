import * as THREE from 'three';

// Limbs put where a hand or a foot has to be, on top of whatever the clips
// posed: the analytic two-bone IK every engine's hand IK is (Unreal's
// TwoBoneIK node, Source's IK chains), for a body holding a tool in third
// person (held.js) and riding a pogo stick.
//
// A limb is an upper bone, a lower bone with a hinge (the elbow, the knee) and
// the end's point in the lower bone's frame. The hinge turns about the lower
// bone's local x; `flex` is the sign that bends it the way the joint goes
// (+1 for every joint of the realistic body; the stickman's knees are −1). The
// solve is exact: the hinge's angle from the law of cosines, then the upper
// bone turned so the end lands on the target with the hinge's bend toward the
// pole. Nothing is left over from the clip's twist, so the skin bends where the
// joint does.
//
//   const arm = limb(upperarm, lowerarm, hand.position, +1);
//   solveLimb(arm, target, pole);                   // world points
//   setWorldQuaternion(hand, q);                    // then the hand's own turn

const X = new THREE.Vector3(1, 0, 0);
const MIN_BEND = 0.02;                   // rad: a limb never locks fully straight (the solve stays smooth at full reach)
const vA = new THREE.Vector3(), vD = new THREE.Vector3(), vP = new THREE.Vector3(), vW = new THREE.Vector3(), vE = new THREE.Vector3();
const vS = new THREE.Vector3();
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
const mA = new THREE.Matrix4(), mB = new THREE.Matrix4();
const a3 = new THREE.Vector3(), b3 = new THREE.Vector3(), c3 = new THREE.Vector3(), a4 = new THREE.Vector3(), b4 = new THREE.Vector3(), c4 = new THREE.Vector3();

export const limb = (upper, lower, end, flex = 1) => ({ upper, lower, end: end.clone(), flex });

// the rotation taking orthonormal basis (a1, b1, a1×b1) to (a2, b2, a2×b2)
function align(a1, b1, a2, b2, out) {
  mA.makeBasis(a1, b1, c3.crossVectors(a1, b1));
  mB.makeBasis(a2, b2, c4.crossVectors(a2, b2));
  return out.setFromRotationMatrix(mB.multiply(mA.transpose()));
}
// u's part across unit a, normalised; `fallback` when u runs along a
function across(u, a, fallback, out) {
  out.copy(u).addScaledVector(a, -u.dot(a));
  if (out.lengthSq() < 1e-10) out.copy(fallback).addScaledVector(a, -fallback.dot(a));
  if (out.lengthSq() < 1e-10) out.set(Math.abs(a.x) < 0.9 ? 1 : 0, Math.abs(a.x) < 0.9 ? 0 : 1, 0).addScaledVector(a, -a.x);
  return out.normalize();
}

export function setWorldQuaternion(obj, q) {
  obj.parent.updateWorldMatrix(true, false);
  obj.parent.getWorldQuaternion(qA);
  obj.quaternion.copy(qA.invert().multiply(q));
}

// Bend the limb so its end reaches `target` (world), the hinge toward `pole` (world).
export function solveLimb(L, target, pole) {
  const { upper, lower, end, flex } = L;
  upper.updateWorldMatrix(true, false);
  const a = upper.getWorldPosition(vA);
  const ws = upper.getWorldScale(vS).x;      // world units per unit of the upper bone's frame
  const e = lower.position, h = end;
  const l1 = e.length(), l2 = h.length();
  const d = THREE.MathUtils.clamp(vD.subVectors(target, a).length() / ws, Math.abs(l1 - l2) + 1e-6, l1 + l2 - 1e-6);
  // |e + Rx(θ)·h| = d  →  A cos θ + B sin θ = K
  const C = e.x * h.x, A = e.y * h.y + e.z * h.z, B = e.z * h.y - e.y * h.z;
  const K = (d * d - l1 * l1 - l2 * l2) / 2 - C;
  const R0 = Math.hypot(A, B) || 1;
  const phi = Math.atan2(B, A);
  let theta = phi + flex * Math.acos(THREE.MathUtils.clamp(K / R0, -1, 1));
  if (flex * (theta - phi) < MIN_BEND) theta = phi + flex * MIN_BEND;
  lower.quaternion.setFromAxisAngle(X, theta);
  // the end in the upper bone's frame, now
  vW.copy(h).applyQuaternion(lower.quaternion).add(e);
  // turn the upper bone: its (end, hinge) frame onto the world's (target, pole) frame
  a3.copy(vW).normalize();
  across(e, a3, X, b3);
  a4.copy(vD).normalize();
  across(vP.subVectors(pole, a), a4, X, b4);
  align(a3, b3, a4, b4, qB);
  upper.parent.getWorldQuaternion(qA);
  upper.quaternion.copy(qA.invert().multiply(qB));
  upper.updateWorldMatrix(false, true);
}

// A hand's frame: how its bone's axes sit against a grip. `fingers` runs from the
// wrist to the knuckles, `palm` is the way the palm faces (unit vectors, the
// bone's own frame). handFrame(hand, thumb, side) reads them off the bind pose:
// the fingers toward the middle finger's knuckle, the thumb's side across them,
// and the palm the side the thumb folds over (a right hand's palm is thumb ×
// fingers, a left hand's fingers × thumb).
export function handFrame(hand, knuckle, thumb, side) {
  hand.updateWorldMatrix(true, true);
  const q = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
  const at = hand.getWorldPosition(new THREE.Vector3());
  const f = knuckle.getWorldPosition(new THREE.Vector3()).sub(at);
  const reach = f.length() / hand.getWorldScale(new THREE.Vector3()).x;   // wrist to knuckles, the bone's units
  f.normalize();
  const t = across(thumb.getWorldPosition(new THREE.Vector3()).sub(at), f, X, new THREE.Vector3());
  const palm = side === 'right' ? new THREE.Vector3().crossVectors(t, f) : new THREE.Vector3().crossVectors(f, t);
  return { fingers: f.applyQuaternion(q), palm: palm.applyQuaternion(q).normalize(), reach };
}

// The world turn that puts a hand (frame from handFrame) with its fingers along
// `fingers` and its palm facing `palm` (world, need not be exactly square).
export function handTurn(frame, fingers, palm, out) {
  a4.copy(fingers).normalize();
  across(palm, a4, X, b4);
  return align(a3.copy(frame.fingers), b3.copy(frame.palm), a4, b4, out);
}
