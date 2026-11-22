// A slice is on a cell boundary in world cells. `sign` points out of the
// retained half-space, toward the hidden cells and along the cut-face normal.
export const newCutaway = () => ({ enabled: false, axis: 0, sign: 1, coord: 0 });
export const cutawayNormal = ({ axis, sign }) => [0, 1, 2].map(i => i === axis ? sign : 0);
export const cutawayParams = (cutaway, origin = [0, 0, 0]) => cutaway?.enabled
  ? [cutaway.coord - origin[cutaway.axis], cutaway.sign, cutaway.axis, 1] : [0, 0, 0, 0];

export function cutawayPlaneHit(origin, dir, cutaway) {
  const { enabled, axis, coord } = cutaway;
  if (!enabled || dir[axis] === 0) return null;
  const t = (coord - origin[axis]) / dir[axis];
  return { t, point: origin.map((x, i) => i === axis ? coord : x + dir[i] * t), normal: cutawayNormal(cutaway) };
}

export function clipRayToCutaway(origin, dir, cutaway, tNear = 0, tFar = Infinity) {
  let normal = null;
  if (cutaway.enabled) {
    const { axis, sign, coord } = cutaway;
    const hit = cutawayPlaneHit(origin, dir, cutaway);
    if (!hit) {
      if ((origin[axis] - coord) * sign > 0) return null;
    } else if (dir[axis] * sign < 0) {
      if (hit.t >= tNear) { tNear = hit.t; normal = hit.normal; }
    } else tFar = Math.min(tFar, hit.t);
  }
  return tFar > tNear ? { tNear, tFar, normal } : null;
}

// WGSL mirror of the half-space intersection, shared by both marchers and
// both pickers. Span xyz is (entry, exit, entry axis). A rejected span is empty.
export const cutawayWGSL = /* wgsl */ `
fn cutawaySpan(ro: vec3f, rd: vec3f, span: vec3f, slice: vec4f) -> vec3f {
  if (slice.w == 0.0) { return span; }
  let a = u32(slice.z);
  let side = (ro[a] - slice.x) * slice.y;
  let slope = rd[a] * slice.y;
  if (slope == 0.0) { return select(span, vec3f(0.0), side > 0.0); }
  let t = -side / slope;
  if (slope > 0.0) { return vec3f(span.x, min(span.y, t), span.z); }
  return select(span, vec3f(t, span.y, slice.z), t >= span.x);
}
fn cutawayKeepsCell(cell: vec3i, slice: vec4f) -> bool {
  return slice.w == 0.0 || (f32(cell[u32(slice.z)]) + 0.5 - slice.x) * slice.y < 0.0;
}
fn cutawayKeepsPoint(p: vec3f, slice: vec4f) -> bool {
  return slice.w == 0.0 || (p[u32(slice.z)] - slice.x) * slice.y <= 0.0;
}
fn cutawayEnters(p: vec3f, rd: vec3f, slice: vec4f) -> bool {
  let a = u32(slice.z);
  return slice.w != 0.0 && abs(p[a] - slice.x) <= 0.001 && rd[a] * slice.y < 0.0;
}
fn cutawayCell(cell: vec3i, slice: vec4f) -> vec3i {
  var c = cell;
  let a = u32(slice.z);
  c[a] = i32(slice.x) - select(0, 1, slice.y > 0.0);
  return c;
}
`;
