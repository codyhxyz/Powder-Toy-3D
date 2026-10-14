import * as THREE from 'three';
import { ELEMENTS, K } from '../elements.js';

// Grid helpers the first-person code shares: the voxel walk, a pick face's
// normal, and the kinds of cell a body or a tool treats alike.

const WALK_MAX = 4096;   // safety: most cells a walk crosses unless its caller says fewer

// Amanatides & Woo's voxel walk ("A Fast Voxel Traversal Algorithm for Ray
// Tracing", 1987): the cells along origin + t·dir from the origin's, in order,
// while t ≤ maxT and at most maxSteps of them. visit(x, y, z, t, axis, step)
// sees each cell: t the ray distance at which the walk entered it, axis the
// axis (0 x, 1 y, 2 z) it stepped along to get there and step that step's sign
// (axis −1 and step 0 for the origin's cell). Any value visit returns but
// undefined ends the walk, and voxelWalk returns it; undefined when the walk
// ran out. (Ties step z before y before x, as all its callers always did.)
export function voxelWalk(origin, dir, maxT, visit, maxSteps = WALK_MAX) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z);
  const tdx = sx ? Math.abs(1 / dir.x) : Infinity, tdy = sy ? Math.abs(1 / dir.y) : Infinity, tdz = sz ? Math.abs(1 / dir.z) : Infinity;
  let tx = sx ? ((sx > 0 ? x + 1 : x) - origin.x) / dir.x : Infinity;
  let ty = sy ? ((sy > 0 ? y + 1 : y) - origin.y) / dir.y : Infinity;
  let tz = sz ? ((sz > 0 ? z + 1 : z) - origin.z) / dir.z : Infinity;
  let t = 0, axis = -1, step = 0;
  for (let i = 0; i < maxSteps && t <= maxT; i++) {
    const r = visit(x, y, z, t, axis, step);
    if (r !== undefined) return r;
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; axis = 0; step = sx; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; axis = 1; step = sy; }
    else { z += sz; t = tz; tz += tdz; axis = 2; step = sz; }
  }
  return undefined;
}

// The outward normal of a pick face (shaders/render.js pickFrag: axis * 2, +1
// when the ray stepped +axis, so even faces face +axis).
export function faceNormal(face, out = new THREE.Vector3()) {
  out.set(0, 0, 0);
  out.setComponent(Math.floor(face / 2), face % 2 === 0 ? 1 : -1);
  return out;
}

// Loose matter: powder or liquid, what a boot or a hook moves cell by cell
export const isLoose = (id) => id >= 0 && (ELEMENTS[id].kind === K.POWDER || ELEMENTS[id].kind === K.LIQUID);
