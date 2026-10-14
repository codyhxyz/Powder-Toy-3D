import { Quaternion, Euler } from 'three';

export const FLAP_SIGNAL_S = 0.2; // physics tap signal; lift/refire stay unchanged
export const FLAP_ANIM_S = 0.42;
const q = (pitch, roll = 0) => new Quaternion().setFromEuler(new Euler(pitch, 0, roll));
// Minecraft-inspired wingbeats: spread, lift, press forward/down, recover.
// A closed cycle keeps rapidly repeated taps from snapping the arms to rest.
const KEYS = [
  [0, q(0.1, -1.15), q(0.1, 1.15), q(0.35)],
  [0.28, q(-0.25, -2.05), q(-0.25, 2.05), q(0.45)],
  [0.62, q(0.75, -1), q(0.75, 1), q(0.12)],
  [1, q(0.1, -1.15), q(0.1, 1.15), q(0.35)],
];
// View arms emerge from shoulders behind the near plane, not floating pivots
// in front of the eye. Same stroke timing, retargeted to camera space.
const VIEW_KEYS = [
  [q(1.48, -0.28), q(1.48, 0.28), q(0.22)],
  [q(2.05, -0.3), q(2.05, 0.3), q(0.45)],
  [q(1.42, -0.3), q(1.42, 0.3), q(-0.08)],
  [q(1.48, -0.28), q(1.48, 0.28), q(0.22)],
];
const smooth = t => { const p = Math.max(0, Math.min(1, t)); return p * p * (3 - 2 * p); };
export function flapPose() {
  return { left: new Quaternion(), right: new Quaternion(), elbow: new Quaternion(),
    viewLeft: new Quaternion(), viewRight: new Quaternion(), viewElbow: new Quaternion(), weight: 0 };
}
// Sample a visual stroke; the short physics signal only starts/queues it.
export function sampleFlap(remaining, out) {
  const p = 1 - Math.max(0, Math.min(1, remaining));
  let i = 1;
  while (i < KEYS.length - 1 && p > KEYS[i][0]) i++;
  const a = KEYS[i - 1], b = KEYS[i];
  const t = (p - a[0]) / (b[0] - a[0]), ease = t * t * (3 - 2 * t);
  out.left.copy(a[1]).slerp(b[1], ease);
  out.right.copy(a[2]).slerp(b[2], ease);
  out.elbow.copy(a[3]).slerp(b[3], ease);
  out.viewLeft.copy(VIEW_KEYS[i - 1][0]).slerp(VIEW_KEYS[i][0], ease);
  out.viewRight.copy(VIEW_KEYS[i - 1][1]).slerp(VIEW_KEYS[i][1], ease);
  out.viewElbow.copy(VIEW_KEYS[i - 1][2]).slerp(VIEW_KEYS[i][2], ease);
  out.weight = smooth(p * FLAP_ANIM_S / 0.06) * (1 - smooth((p * FLAP_ANIM_S - 0.30) / 0.12));
  return out;
}
export function createFlapAnimation() {
  const pose = flapPose();
  let elapsed = Infinity, previous = 0, queued = false;
  let rejoin = Infinity, rejoinWeight = 1;
  return {
    update(dt, signal = 0) {
      if (signal > 0 && (previous <= 0 || signal > previous + 1e-6)) {
        if (Number.isFinite(elapsed)) {
          queued = true;
          if (elapsed > 0.30 && pose.weight < 1) { rejoin = 0; rejoinWeight = pose.weight; }
        }
        else elapsed = -0.12; // spread from idle before starting the first stroke
      }
      previous = signal;
      elapsed += Math.max(0, dt);
      rejoin += Math.max(0, dt);
      if (elapsed >= FLAP_ANIM_S) {
        if (queued) { elapsed %= FLAP_ANIM_S; queued = false; }
        else elapsed = Infinity;
      }
      sampleFlap(Number.isFinite(elapsed) ? 1 - elapsed / FLAP_ANIM_S : 0, pose);
      pose.weight = Number.isFinite(elapsed)
        ? smooth((elapsed + 0.12) / 0.12) * (queued ? 1 : 1 - smooth((elapsed - 0.30) / 0.12)) : 0;
      // A tap during the fade must not instantly restore full-strength arms.
      if (rejoin < 0.12) pose.weight = Math.min(pose.weight, rejoinWeight + (1 - rejoinWeight) * smooth(rejoin / 0.12));
      return pose;
    },
    reset() { elapsed = Infinity; previous = 0; queued = false; rejoin = Infinity; pose.weight = 0; },
    get active() { return Number.isFinite(elapsed); },
  };
}
