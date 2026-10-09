import * as THREE from 'three';

// Bodies the player's weapons can hit that aren't cells: the NPCs (npc.js).
// Each is a box in grid cells; the axe tests its reach ray against them and
// the gun each round's flight segment (ballistics.js), before the cells.
//
//   const remove = addTarget({ box(min, max), alive, hurt(amount, cause, dir) });

const targets = new Set();
const lo = new THREE.Vector3(), hi = new THREE.Vector3();

export function addTarget(t) {
  targets.add(t);
  return () => targets.delete(t);
}

// The nearest live target a ray from `origin` along unit `dir` enters within
// maxDist: { target, dist, point }, or null. Slab test against each box.
export function rayTarget(origin, dir, maxDist) {
  let best = null;
  for (const t of targets) {
    if (!t.alive) continue;
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
export function segmentTarget(a, b) {
  const d = b.clone().sub(a);
  const len = d.length();
  return len > 0 ? rayTarget(a, d.divideScalar(len), len) : null;
}

export const hasTargets = () => targets.size > 0;
