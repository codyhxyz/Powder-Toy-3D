// Pure rigid door poses. Source: Scripts/Door.gd:26-40,55-64,
// Elevator_Door.gd:27-37,44-71,79-89; down_door.gd:26-36,43-78.
// Deterministic adaptation: clamp nominal endpoints (no one-tick overshoot),
// ordinary reversal rather than the source's stop/toggle mid-motion quirk.
export const DOOR_MOTION_VERSION = 1;
export const DOOR_DEFAULTS = Object.freeze({ rotation_speed: 2, speed: 2, clearance: 0.1, autoCloseSeconds: 5 });
export const IDENTITY_TRANSFORM = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const dot = (a, b) => a.reduce((n, v, k) => n + v * b[k], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const add = (a, b) => a.map((v, k) => v + b[k]);
const sub = (a, b) => a.map((v, k) => v - b[k]);
export const transformDoorVector = (matrix, p) => [0, 1, 2].map(k => matrix[k]*p[0] + matrix[k+3]*p[1] + matrix[k+6]*p[2]);
export const transformDoorPoint = (matrix, p) => add(transformDoorVector(matrix, p), matrix.slice(9));
export function isRigidTransform(t, epsilon = 2e-5) {
  if (!t || t.length !== 12 || !t.every(Number.isFinite)) return false;
  const a = t.slice(0, 3), b = t.slice(3, 6), c = t.slice(6, 9);
  return [a, b, c].every(v => Math.abs(dot(v, v) - 1) < epsilon) &&
    Math.abs(dot(a, b)) < epsilon && Math.abs(dot(a, c)) < epsilon && Math.abs(dot(b, c)) < epsilon && dot(cross(a, b), c) > 1 - epsilon;
}
export function doorPose(motion, progress) {
  const f = Math.max(0, Math.min(1, progress));
  if (!Number.isFinite(f)) throw new Error('Invalid door progress');
  if (motion.kind !== 'swing') return [...IDENTITY_TRANSFORM.slice(0, 9), ...motion.translation.map(v => v * f)];
  const axis = motion.axis, angle = motion.angleRadians * f, c = Math.cos(angle), s = Math.sin(angle);
  const rotate = p => add(add(p.map(v => v * c), cross(axis, p).map(v => v * s)), axis.map(v => v * dot(axis, p) * (1 - c)));
  const basis = [[1,0,0], [0,1,0], [0,0,1]].flatMap(rotate);
  return [...basis, ...sub(motion.pivot, rotate(motion.pivot))];
}
/** Complete analytic envelope of the actual points, including interior angles. */
export function doorSweptBounds(motion, points, fromProgress = 0, toProgress = 1) {
  const from = Math.max(0, Math.min(1, fromProgress)), to = Math.max(0, Math.min(1, toProgress));
  const startPose = doorPose(motion, from), endPose = doorPose(motion, to);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const include = p => p.forEach((v, k) => { min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); });
  for (const p of points) {
    include(transformDoorPoint(startPose, p)); include(transformDoorPoint(endPose, p));
    if (motion.kind !== 'swing') continue;
    const r = sub(p, motion.pivot), parallel = motion.axis.map(v => v * dot(motion.axis, r));
    const a = sub(r, parallel), b = cross(motion.axis, r), base = add(motion.pivot, parallel);
    const lo = Math.min(from * motion.angleRadians, to * motion.angleRadians), hi = Math.max(from * motion.angleRadians, to * motion.angleRadians);
    for (let k = 0; k < 3; k++) {
      const start = Math.atan2(b[k], a[k]);
      for (let n = Math.ceil((lo - start) / Math.PI); n <= Math.floor((hi - start) / Math.PI); n++) {
        const t = start + n * Math.PI;
        include(base.map((v, j) => v + a[j] * Math.cos(t) + b[j] * Math.sin(t)));
      }
    }
  }
  return { min, max };
}
/** Sweep a closed AABB over any progress interval (also accepts closing ranges). */
export function sweptDoorBounds(motion, closedBounds, fromProgress = 0, toProgress = 1) {
  const corners = Array.from({ length: 8 }, (_, i) => [0, 1, 2].map(k => (i & (1 << k) ? closedBounds.max : closedBounds.min)[k]));
  return doorSweptBounds(motion, corners, fromProgress, toProgress);
}
/** Bounds for voxel leaf poses: include the unit-cell footprint, not only vertices. */
export function padDoorBounds(bounds, padding = Math.sqrt(3)) {
  return { min: bounds.min.map(v => v - padding), max: bounds.max.map(v => v + padding) };
}
/** Continuous progress for the normal use timer; down_door switch_use has no timer. */
export function doorProgressAtTime(motion, seconds, { switchUse = false } = {}) {
  const t = Math.max(0, seconds), duration = motion.durationSeconds;
  const closeAt = switchUse && motion.kind === 'vertical' ? null : motion.autoCloseSeconds;
  const opened = Math.min(1, t / duration);
  return closeAt == null || t <= closeAt ? opened : Math.max(0, Math.min(1, closeAt / duration) - (t - closeAt) / duration);
}
/** Inclusive brick envelope; epsilon protects SAT boundary/float roundoff. */
export function doorBrickKeys(bounds, brickDims) {
  const lo = bounds.min.map(v => Math.floor((v - 1e-7) / 8));
  const hi = bounds.max.map(v => Math.floor((v + 1e-7) / 8));
  const keys = [];
  for (let z = Math.max(0, lo[2]); z <= Math.min(brickDims[2] - 1, hi[2]); z++)
    for (let y = Math.max(0, lo[1]); y <= Math.min(brickDims[1] - 1, hi[1]); y++)
      for (let x = Math.max(0, lo[0]); x <= Math.min(brickDims[0] - 1, hi[0]); x++) keys.push(x + brickDims[0] * (y + brickDims[1] * z));
  return keys;
}
