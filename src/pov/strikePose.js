import { Quaternion, Euler } from 'three';

const q = (x = 0, y = 0, z = 0) => new Quaternion().setFromEuler(new Euler(x, y, z));
// Cruelty Squad's high front kick: folded chamber, fast extension, a readable
// contact hold, then fold before lowering. Turns are in the standing body's axes.
const KEYS = [
  [0, q(), q(), q()],
  [0.16, q(1.45, 0, -0.18), q(-2.1), q(0.12, -0.08)],
  [0.30, q(1.95, 0.08, -0.08), q(-0.12), q(0.25, 0.12)],
  [0.50, q(1.95, 0.08, -0.08), q(-0.12), q(0.25, 0.12)],
  [0.72, q(1.45, 0, -0.18), q(-2.1), q(0.12, -0.08)],
  [1, q(), q(), q()],
];
const JOINTS = ['hip', 'knee', 'torso'];
export function strikePose() {
  return Object.fromEntries(JOINTS.map(name => [name, new Quaternion()]));
}
export function kickBlend(progress) {
  const t = Math.max(0, Math.min(1, progress / 0.16, (1 - progress) / 0.28));
  return t * t * (3 - 2 * t);
}
export function sampleKickPose(progress, out) {
  const p = Math.max(0, Math.min(1, progress));
  let i = 1;
  while (i < KEYS.length - 1 && p > KEYS[i][0]) i++;
  const a = KEYS[i - 1], b = KEYS[i];
  const t = (p - a[0]) / (b[0] - a[0]), ease = t * t * (3 - 2 * t);
  for (let j = 0; j < JOINTS.length; j++) out[JOINTS[j]].copy(a[j + 1]).slerp(b[j + 1], ease);
  return out;
}
