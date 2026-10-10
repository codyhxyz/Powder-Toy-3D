import * as THREE from 'three';

// Bodies weapons can hit that aren't cells: the player and the NPCs (npc.js).
// Each is a box in grid cells; the axe tests its reach ray against them and
// the gun each round's flight segment (ballistics.js), before the cells. A
// weapon never hits its own wielder: `owner` is the target's id ('player', or
// the NPC's), and every test skips the target whose id is `exclude`.
//
//   const remove = addTarget({ id, box(min, max), alive, hurt(amount, cause, dir, opts?), facing?(out) });
//
// hurt's opts: { lethal } (a backstab: all the health it has, through any shield).
// facing(out): the unit direction the target looks along (its eyes), for the
// knife's backstab test; a target without it can't be backstabbed.

export const PLAYER = 'player';   // the player's target id (and the shooter of rounds no actor fired)

const targets = new Set();
const lo = new THREE.Vector3(), hi = new THREE.Vector3();

export function addTarget(t) {
  targets.add(t);
  return () => targets.delete(t);
}

// The nearest live target a ray from `origin` along unit `dir` enters within
// maxDist: { target, dist, point }, or null. Slab test against each box.
export function rayTarget(origin, dir, maxDist, exclude = null) {
  let best = null;
  for (const t of targets) {
    if (!t.alive || t.id === exclude) continue;
    t.box(lo, hi);
    let t0 = 0, t1 = maxDist;
    for (const a of ['x', 'y', 'z']) {
      const o = origin[a], d = dir[a];
      if (Math.abs(d) < 1e-9) { if (o < lo[a] || o > hi[a]) { t0 = Infinity; break; } continue; }
      let n = (lo[a] - o) / d, f = (hi[a] - o) / d;
      if (n > f) [n, f] = [f, n];
      t0 = Math.max(t0, n); t1 = Math.min(t1, f);
      if (t0 > t1) break;
    }
    if (t0 <= t1 && t0 < (best?.dist ?? Infinity)) best = { target: t, dist: t0 };
  }
  if (best) best.point = origin.clone().addScaledVector(dir, best.dist);
  return best;
}

// The nearest live target the segment a → b enters: as rayTarget, dist along it.
export function segmentTarget(a, b, exclude = null) {
  const d = b.clone().sub(a);
  const len = d.length();
  return len > 0 ? rayTarget(a, d.divideScalar(len), len, exclude) : null;
}

// The nearest live target to `point` within maxDist of its box: { target, dist
// (to the box, 0 inside it), center (the box's middle) }, or null. The
// burrower's drill homes on it.
export function nearestTarget(point, maxDist = Infinity, exclude = null) {
  let best = null;
  for (const t of targets) {
    if (!t.alive || t.id === exclude) continue;
    t.box(lo, hi);
    const dx = Math.max(lo.x - point.x, 0, point.x - hi.x);
    const dy = Math.max(lo.y - point.y, 0, point.y - hi.y);
    const dz = Math.max(lo.z - point.z, 0, point.z - hi.z);
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= maxDist && dist < (best?.dist ?? Infinity)) {
      best = { target: t, dist, center: lo.clone().add(hi).multiplyScalar(0.5) };
    }
  }
  return best;
}

// Every live target a beam from `origin` along unit `dir`, `len` long and
// `radius` thick, passes through: [{ target, dist (along it), point }], nearest
// first. Each box, grown by the radius, against the beam's axis (the laser).
export function beamTargets(origin, dir, len, radius, exclude = null) {
  const hits = [];
  for (const t of targets) {
    if (!t.alive || t.id === exclude) continue;
    t.box(lo, hi);
    lo.subScalar(radius); hi.addScalar(radius);
    let t0 = 0, t1 = len;
    for (const a of ['x', 'y', 'z']) {
      const o = origin[a], d = dir[a];
      if (Math.abs(d) < 1e-9) { if (o < lo[a] || o > hi[a]) { t0 = Infinity; break; } continue; }
      let n = (lo[a] - o) / d, f = (hi[a] - o) / d;
      if (n > f) [n, f] = [f, n];
      t0 = Math.max(t0, n); t1 = Math.min(t1, f);
      if (t0 > t1) break;
    }
    if (t0 <= t1) hits.push({ target: t, dist: t0, point: origin.clone().addScaledVector(dir, t0) });
  }
  return hits.sort((a, b) => a.dist - b.dist);
}

// The target with this id, or null (an NPC finding the player's).
export function targetById(id) {
  for (const t of targets) if (t.id === id) return t;
  return null;
}

export const hasTargets = () => targets.size > 0;
