import { LEAF_FINE } from '../../foliage.js';

// One immutable template, shared with the cached far meshes. Near leaves use
// the existing cell traversal (like the crystal geometry), not a second scene
// or per-frame GPU readback. The current voxel decides whether it still exists.
// Folding the ray into template space needs one transform per occupied cell.
const vectors = (a) => Array.from({ length: a.length / 3 }, (_, i) =>
  `vec3f(${Array.from(a.subarray(i * 3, i * 3 + 3), n => Number(n).toExponential(8)).join(', ')})`).join(',\n');

export const foliageGLSL = /* wgsl */ `
const FOLIAGE_POINTS = array<vec3f, ${LEAF_FINE.positions.length / 3}>(
${vectors(LEAF_FINE.positions)});
const FOLIAGE_NORMALS = array<vec3f, ${LEAF_FINE.normals.length / 3}>(
${vectors(LEAF_FINE.normals)});

fn foliageFrame(cell: vec3i) -> mat3x3f {
  let w = vec3u(cell + H.origin);
  let h = pcg(w.x ^ pcg(w.y ^ pcg(w.z)));
  let yaw = f32(h & 65535u) / 65536.0 * 6.283185307179586;
  let tilt = (f32(h >> 16u) / 65536.0 - 0.5) * 1.4;
  let cy = cos(yaw); let sy = sin(yaw);
  let ct = cos(tilt); let st = sin(tilt);
  return mat3x3f(vec3f(cy, 0.0, -sy), vec3f(sy * st, ct, cy * st), vec3f(sy * ct, -st, cy * ct));
}

// Double-sided Möller–Trumbore; all triangles stay inside their owning cell.
// tMin/tMax keep media, refraction and neighbouring smooth matter in order.
fn foliageHit(cell: vec3i, ro: vec3f, rd: vec3f, tMin: f32, tMax: f32,
              th: ptr<function, f32>, nh: ptr<function, vec3f>) -> bool {
  let frame = foliageFrame(cell);
  let inv = transpose(frame);
  let r = inv * (ro - (vec3f(cell) + 0.5));
  let d = inv * rd;
  var best = tMax;
  var normal = vec3f(0.0);
  var hit = false;
  for (var i = 0u; i < ${LEAF_FINE.indices.length}u; i += 3u) {
    let a = FOLIAGE_POINTS[i];
    let e1 = FOLIAGE_POINTS[i + 1u] - a;
    let e2 = FOLIAGE_POINTS[i + 2u] - a;
    let p = cross(d, e2);
    let det = dot(e1, p);
    if (abs(det) < 1e-7) { continue; }
    let v = r - a;
    let u = dot(v, p) / det;
    if (u < 0.0 || u > 1.0) { continue; }
    let q = cross(v, e1);
    let b = dot(d, q) / det;
    if (b < 0.0 || u + b > 1.0) { continue; }
    let t = dot(e2, q) / det;
    if (t < max(tMin, 0.0) || t > best) { continue; }
    best = t;
    normal = frame * FOLIAGE_NORMALS[i];
    hit = true;
  }
  if (hit) {
    *th = best;
    *nh = select(normal, -normal, dot(normal, rd) > 0.0);
  }
  return hit;
}
`;
