import * as THREE from 'three';

// Bodies weapons can hit that aren't cells: the player and the NPCs (npc.js).
// Each is a box in grid cells; the axe tests its reach ray against them and
// the gun each round's flight segment (ballistics.js), before the cells. A
// weapon never hits its own wielder: `owner` is the target's id ('player', or
// the NPC's), and every test skips the target whose id is `exclude`.
//
//   const remove = addTarget({ id, box(min, max), alive, hurt(amount, cause, dir) });
//
// Optional: shove(dv) gives it a velocity (cells/s) by momentum (the kick; hurt's
// dir is then null, so it adds no knockback of its own), body is its player.js
// body (the hook hangs it on a rope), mass its kg (pov/tug.js BODY_MASS_KG if not given).

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

// The target with this id, or null (an NPC finding the player's).
export function targetById(id) {
  for (const t of targets) if (t.id === id) return t;
  return null;
}

export const hasTargets = () => targets.size > 0;
