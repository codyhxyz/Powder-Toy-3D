import * as THREE from 'three';

// Bodies weapons can hit that aren't cells: the player, the NPCs (npc.js) and
// each segment of a worm (worm.js; those carry creature: 'worm').
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

// The target with this id, or null (an NPC finding the player's).
export function targetById(id) {
  for (const t of targets) if (t.id === id) return t;
  return null;
}

export const hasTargets = () => targets.size > 0;

// Every live target whose box overlaps [min, max] (grid cells), but the one
// whose id is `exclude` (a vehicle running bodies over: vehicles/index.js).
export function targetsInBox(min, max, exclude = null, out = []) {
  out.length = 0;
  for (const t of targets) {
    if (!t.alive || t.id === exclude) continue;
    t.box(lo, hi);
    if (hi.x < min.x || lo.x > max.x || hi.y < min.y || lo.y > max.y || hi.z < min.z || lo.z > max.z) continue;
    out.push(t);
  }
  return out;
}

// Every target, live or not (a worm choosing what to hunt and what its jaws close on).
export const allTargets = () => targets;
