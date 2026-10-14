import { Quaternion, Euler } from 'three';

export const FLAP_ANIM_S = 0.2;   // one complete stroke before the next allowed tap
const q = (pitch, roll = 0) => new Quaternion().setFromEuler(new Euler(pitch, 0, roll));
// Minecraft-chicken wingbeats, with an actual upstroke/downstroke rather than
// snapping overhead and slowly lowering. Canonical arms hang along -Y.
const KEYS = [
  [0, q(0), q(0), q(0), 0],
  [0.22, q(0.25, -2), q(0.25, 2), q(0.65), 1],
  [0.52, q(0.45, -0.55), q(0.45, 0.55), q(0.1), 1],
  [1, q(0), q(0), q(0), 0],
];
export function flapPose() {
  return { left: new Quaternion(), right: new Quaternion(), elbow: new Quaternion(), weight: 0 };
}
// remaining: 1 on the tap, 0 when the beat is over (player.flap).
export function sampleFlap(remaining, out) {
  const p = 1 - Math.max(0, Math.min(1, remaining));
  let i = 1;
  while (i < KEYS.length - 1 && p > KEYS[i][0]) i++;
  const a = KEYS[i - 1], b = KEYS[i];
  const t = (p - a[0]) / (b[0] - a[0]), ease = t * t * (3 - 2 * t);
  out.left.copy(a[1]).slerp(b[1], ease);
  out.right.copy(a[2]).slerp(b[2], ease);
  out.elbow.copy(a[3]).slerp(b[3], ease);
  out.weight = a[4] + (b[4] - a[4]) * ease;
  return out;
}
